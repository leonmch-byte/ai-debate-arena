// v3 worker：周期跑时间表 + 每周期对账巡检。崩溃自启由 systemd 负责。
import { EventStore } from './src/store.js';
import { SandboxChannel } from './src/payments.js';
import { runCycle, WORKER_INTERVAL_SECONDS } from './src/jobs.js';
import { reconcileOperations, sweepInvariants } from './src/recon.js';
import { poolReport } from './src/admin.js';

const store = new EventStore('db/arena.db');
const channel = new SandboxChannel();   // M8 切真实渠道时仅替换此处

async function tick() {
  const cycle = await runCycle(store, channel);
  const recon = reconcileOperations(store);
  const sweep = sweepInvariants(store);
  const dirty = recon.missing_event.length + recon.phantom.length + recon.amount_mismatch.length +
                recon.stale_pending.length + sweep.violations.length;
  console.log(JSON.stringify({ at: new Date().toISOString(), cycle,
    recon_counts: Object.fromEntries(Object.entries(recon).map(([k, v]) => [k, v.length])),
    sweep_violations: sweep.violations.length, alert: dirty > 0 }));
  if (dirty > 0) console.log(JSON.stringify({ at: new Date().toISOString(), recon, sweep, pool: poolReport(store) }));
}
console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'arena worker started', interval_s: WORKER_INTERVAL_SECONDS }));
const loop = () => tick().catch(e => console.error(JSON.stringify({ at: new Date().toISOString(), fatal: e.message })));
loop();
setInterval(loop, WORKER_INTERVAL_SECONDS * 1000);
process.on('SIGTERM', () => { console.log('worker stopping'); store.close(); process.exit(0); });
