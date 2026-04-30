# Scheduler setup — getting auto-wake working

The agent has THREE concerns to wire up:

1. **Trigger source** — what makes the agent run on cadence (GitHub Actions, fully external).
2. **Outage detection** — what alerts you when the agent has stopped running silently (UptimeRobot or equivalent, free tier).
3. **In-process scheduler** (src/lib/scheduler.ts) — secondary trigger that fires every 2 min from inside the Railway container. Backup only; dies when Railway recycles the container.

The first two are 5-minute setups. The third needs no configuration. After all three are in place, a recurrence of the original 2-week silent outage is detectable within ~2 hours instead of "whenever you next happen to look at /trades."

---

## Step 1 — generate a secret

In any terminal:

```bash
openssl rand -hex 32
```

Copy the output. It looks like `7c3a9f...` (64 hex chars). This is your `AGBRO_CRON_SECRET`. Keep the same string for both Railway and GitHub.

---

## Step 2 — paste into Railway

1. Open the Railway dashboard → your AgBro service → **Variables** tab
2. Click **+ New Variable**
3. Name: `AGBRO_CRON_SECRET`, Value: the secret you generated
4. Save. Railway redeploys automatically.

To verify, hit `https://agbro-production.up.railway.app/api/scheduler/status` and look at the `env` block — `cronSecret` should now read `"ok"` instead of `"missing"`.

---

## Step 3 — paste into GitHub

1. GitHub → your repo → **Settings** → **Secrets and variables** → **Actions**
2. **Secrets** tab → **New repository secret**
   - Name: `AGBRO_CRON_SECRET`
   - Value: the same secret you used in Railway
3. **Variables** tab → **New repository variable**
   - Name: `AGBRO_URL`
   - Value: `https://agbro-production.up.railway.app`

---

## Step 4 — fire a test run

1. GitHub → **Actions** tab → **Agent tick** workflow
2. Click **Run workflow** → **Run workflow** (green button)
3. Wait ~30 seconds, then open the run

You should see the response body in the log, e.g.:

```json
{
  "total": 1,
  "ran": 1,
  "skipped": 0,
  "failed": 0,
  "outcomes": [{"userId": "...", "ran": true, "decision": "hold", "status": "completed"}],
  ...
}
```

If `total > 0` and `failed = 0`, it's working. Future cron fires happen automatically every 15 min.

---

## What if I see `"total": 0`?

That's normal in three cases:

- Weekend (Sat/Sun) — runner skips the agent loop, but crypto + regime checks still run.
- Outside trading hours (default `09:45–15:45 ET`) — bumped to next eligible window.
- Cadence not elapsed — your account ran less than `agentCadenceMinutes` (default 240) ago.

The runner's gate is sane; "no work to do" is not a bug.

---

## What if the workflow run fails?

The error message in the GitHub Actions log will tell you which secret is missing or wrong. Common causes:

- **`AGBRO_URL` or `AGBRO_CRON_SECRET` missing** — go back to Step 2/3.
- **HTTP 401 unauthorized** — the secrets in Railway and GitHub don't match. Re-paste the same value into both.
- **HTTP 5xx** — the Railway deploy is broken. Check `/api/health` first.

---

## Cost

GitHub Actions on a private repo: 2,000 free minutes/month. This workflow uses ~10s per run × 96 runs/day × 30 days = ~480 minutes. Well under the free limit.

Anthropic API: the cron just *triggers* the agent loop; the agent itself respects your `agentCadenceMinutes` (default 240). Expect ~6-7 real agent wakes per weekday at $1-6 each. Fully under your `monthlyApiBudgetUsd` if set in `/settings`.

---

## Once this is working, can I disable the in-process scheduler?

Yes. Set `AGBRO_DISABLE_SCHEDULER=true` in Railway env. The in-process timer becomes a no-op; GitHub Actions is your only wake source. Recommended once you've seen the workflow run cleanly for a few days.

---

# Part 2 — Outage detection (the alert that would have caught the 2-week bug)

The original silent outage (the one that took 8 rounds of debugging to find) was undetectable from outside the codebase: every layer above the lease-typo bug returned 200, the home page rendered, manual wakes worked, the agent just never ran on its own. Nothing watched the *correctness* of what the scheduler was doing; everything watched only its *aliveness*.

The fix is a public health endpoint that returns 503 when the system is alive but doing nothing, plus an external monitor that pages on 503.

## Step 1 — confirm the endpoint works

In any browser, hit:

```
https://agbro-production.up.railway.app/api/health/scheduler-correctness
```

During market hours (M-F, 09:30–16:00 ET), with at least one un-stopped account, you should see:

```json
{
  "ok": true,
  "marketHours": true,
  "tickCount": 47,
  "lastTickCompletedAt": "2026-04-30T14:23:11.000Z",
  "lastTickSummary": { "total": 1, "ran": 1, "skipped": 0, "failed": 0, ... },
  "reasons": []
}
```

Response code 200 means everything is healthy. Outside market hours or with no active accounts, you'll also see 200 — the endpoint only flags during the window when the agent is *expected* to be running.

If you see 503 with `reasons` populated, that's the alert payload — it tells you which signal failed.

## Step 2 — set up an external monitor

Free-tier options that work fine for this:

- **UptimeRobot** — 50 monitors free, 5-minute interval, email alerts. The most common choice.
- **BetterStack (Better Uptime)** — 10 monitors free, 3-minute interval, slicker UI.
- **cron-job.org** — free, 1-minute interval, less polish but free-er.

UptimeRobot walkthrough (any of the above works the same way):

1. Sign up at [uptimerobot.com](https://uptimerobot.com), confirm email.
2. Dashboard → **+ Add New Monitor**.
3. Configure:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** `agbro scheduler correctness`
   - **URL:** `https://agbro-production.up.railway.app/api/health/scheduler-correctness`
   - **Monitoring Interval:** 5 minutes (free tier minimum)
   - **Alert Contacts:** add your email
4. **Create Monitor**.

## Step 3 — verify the alert path

You don't want to find out the alert is broken when there's a real outage. Test it:

1. Temporarily set `isPaused: true` on your Account row (Railway dashboard → DB → run `UPDATE "Account" SET "isPaused"=true WHERE "userId"='<your-id>'`).
2. Wait 2-3 minutes for the next scheduler tick. The endpoint will now return 503 because no AgentRun fired during market hours.
3. Within ~5 min UptimeRobot should email you.
4. Flip `isPaused` back to false.
5. UptimeRobot will email again when the endpoint flips back to 200.

If you don't get either email, your alert path is broken — fix that *now* rather than after the next outage.

## What the alert catches

- `tickCount === 0` after boot delay + 5min: the in-process scheduler started but never produced a tick. Original bug shape.
- 0 schedule-triggered AgentRuns in the last 2 hours during market hours, with ≥1 active account: ticking but findMany returns 0 accounts. Exact original bug shape.

## What the alert does NOT catch

- A bad agent (running on cadence but making losing trades). That's a strategy question, not an availability question.
- Crypto DCA failures (different code path). Crypto runs 24/7 so a separate alert isn't time-pressing; daily review of `/crypto/positions` covers it.
- Single-tick errors that recover next tick. Designed-in noise filter — flagging on every transient would generate alert fatigue.
