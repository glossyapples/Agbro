// Lazy scheduler boot. Called from /api/health so the scheduler starts
// the first time Railway's health probe hits the container — which
// happens within seconds of boot on every deploy.
//
// Why not instrumentation.ts: Next 14.x bundles src/instrumentation.ts
// for both Node and Edge runtimes, and our scheduler transitively
// imports the Alpaca SDK (via runner → orchestrator → alpaca-trade-api),
// whose dotenv/urljoin deps use Node-only fs/path. Edge bundling
// couldn't resolve those, so the build failed regardless of webpack
// externals or dynamic-import tricks. Lazy boot from a node-runtime
// route sidesteps the whole problem — the scheduler only ever lives
// on the Node server, and the build graph proves that at compile time.

import { startScheduler } from './scheduler';

let booted = false;

export function bootSchedulerOnce(): void {
  if (booted) return;
  booted = true;
  if (process.env.AGBRO_DISABLE_SCHEDULER === 'true') {
    console.log('[scheduler-boot] disabled via AGBRO_DISABLE_SCHEDULER');
    return;
  }
  console.log('[scheduler-boot] booting scheduler from first /api/health hit');
  // Static import is safe here: scheduler.ts itself has no top-level
  // dependency on the Alpaca SDK — the runner (which transitively
  // imports Alpaca) is loaded via dynamic import inside tickOnce(),
  // only after the scheduler is running on the Node server. So the
  // webpack bundle graph stays clean through compile time.
  startScheduler();
}
