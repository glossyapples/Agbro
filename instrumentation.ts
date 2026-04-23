// Next.js instrumentation hook. Called once per Node.js server process
// on startup. We use it to boot the in-process agent scheduler so the
// autonomous wake loop runs without any user-facing configuration.
//
// Guarded to Node runtime only — this file is also evaluated in the
// Edge runtime during build, where we don't want the scheduler or
// Prisma.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Skip during `next build` — instrumentation runs there too, but the
  // DB isn't necessarily reachable at build time and we don't want the
  // scheduler to fire during release scripts.
  if (process.env.AGBRO_DISABLE_SCHEDULER === 'true') return;
  const { startScheduler } = await import('@/lib/scheduler');
  startScheduler();
}
