import { EventStore } from './src/store.js';
import { ScenarioEngine } from './src/scenario.js';
import { RealAdapter } from './src/adapters-real.js';
const eng = new ScenarioEngine(new EventStore('db/arena.db'), new RealAdapter({ log: console.log }), console.log);
const orderId = process.argv[2];
const r = await eng.turn(orderId, 'boss', '说白了，方案从头到尾都是我做的，汇报里一个字没提。');
if (r.ok) console.log('【老板回应】' + r.text);
else console.log('【失败】' + r.reason_code + ' ' + JSON.stringify(r.error?.raw ?? {}));
process.exit(r.ok ? 0 : 1);
