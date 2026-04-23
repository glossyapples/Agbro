// Next.js instrumentation hook. Called once per Node.js server process
// on startup. We use it to boot the in-process agent scheduler so the
// autonomous wake loop runs without any user-facing configuration.
//
// Guarded to Node runtime only — this file is also evaluated in the
// Edge runtime during build, where we don't want the scheduler or
// Prisma.

export async function register() {
  // Loud boot log so we can verify from Railway that the hook fired —
  // this is the replacement for external cron, and a silent failure
  // here looks identical to "no one set up cron" from the outside.
  console.log(
    `[instrumentation] register() called — NEXT_RUNTIME=${process.env.NEXT_RUNTIME ?? 'undefined'}`
  );
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.AGBRO_DISABLE_SCHEDULER === 'true') {
    console.log('[instrumentation] scheduler disabled via AGBRO_DISABLE_SCHEDULER');
    return;
  }
  const { startScheduler } = await import('@/lib/scheduler');
  startScheduler();
  console.log('[instrumentation] scheduler booted');
}
