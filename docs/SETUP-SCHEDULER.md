# Scheduler setup — getting auto-wake working

The agent has TWO wake sources:

1. **In-process scheduler** (src/lib/scheduler.ts) — fires every 2 min from inside the Railway container. **Fragile.** Dies when Railway recycles the container. Treat this as a backup only.

2. **GitHub Actions cron** (.github/workflows/agent-tick.yml) — fires every 15 min from GitHub's infrastructure, hits `/api/cron/tick`. **Authoritative.** Survives any container restart.

This doc gets #2 working. Five minutes, three places to paste a string.

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
