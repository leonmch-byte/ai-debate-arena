// M4：履约引擎——驱动 ServiceItem 走 LOCKED→RUNNING→COMPLETED/FAILED_FINAL（§4）
// 恢复策略（§4.2）：A 类指数退避 ≤3 次；B 类直接终判；C 类 1 次修正重试。
// 铁律：引擎只产生事件。状态推导与违例拒绝全部由 orders.js 守卫完成。
import { SLA } from './config.js';
import { StoreError } from './store.js';
import { appendGuarded } from './checkout.js';
import { projectItems } from './orders.js';

const CLASS_A = new Set(['MODEL_RATE_LIMITED', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT']);
const CLASS_B = new Set(['MODEL_AUTH_FAILURE', 'UPSTREAM_SUSPENDED']);
const CLASS_C = new Set(['MODEL_RESPONSE_INVALID']);

export function classifyFailure(reason_code) {
  if (CLASS_A.has(reason_code)) return 'A';
  if (CLASS_B.has(reason_code)) return 'B';
  if (CLASS_C.has(reason_code)) return 'C';
  throw new StoreError('UNKNOWN_REASON_CODE', reason_code);
}

// 适配器契约（M7 接真实 providers.js 时实现同一接口）：
//   run(model_id, input) → { ok: true, result_ref } | { ok: false, reason_code, raw? }
export async function fulfillItem(store, orderId, itemId, modelId, adapter, opts = {}) {
  const backoffMs = opts.backoffMs ?? 1000;   // 测试传 0 跳过真实退避
  const maxAttempts = SLA.RECOVERY_MAX_ATTEMPTS;

  // T1+T3：原始项 QUOTED→LOCKED→STARTED；后继项若已 LOCKED（T11 补差后）直接 STARTED
  const st = projectItems(store.getOrder(orderId)).get(itemId)?.state;
  const drive = [];
  if (st === 'QUOTED') drive.push({ type: 'ITEM_LOCKED', item_id: itemId });
  if (st === 'QUOTED' || st === 'LOCKED') drive.push({ type: 'ITEM_STARTED', item_id: itemId });
  if (drive.length) appendGuarded(store, orderId, store.getOrder(orderId), drive);

  let attempt = 0;        // A 类恢复已用次数
  let corrected = false;  // C 类修正重试已用
  let lastRaw = null;

  while (true) {
    const res = await adapter.run(modelId, corrected ? { corrected: true } : {});
    if (res.ok) {
      appendGuarded(store, orderId, store.getOrder(orderId),
        [{ type: 'ITEM_COMPLETED', item_id: itemId, data: { result_ref: res.result_ref } }]);  // T5
      return { completed: true, result_ref: res.result_ref, recovery_attempts: attempt };
    }
    lastRaw = res.raw ?? null;
    const cls = classifyFailure(res.reason_code);

    if (cls === 'C' && !corrected) {          // §4.2：C 类恰 1 次修正重试
      corrected = true;
      appendGuarded(store, orderId, store.getOrder(orderId),
        [{ type: 'RECOVERY_ATTEMPTED', item_id: itemId, reason_code: res.reason_code,
           data: { kind: 'C_RETRY_CORRECTED' } }]);
      continue;
    }
    if (cls === 'A' && attempt < maxAttempts) {  // §4.2：A 类恢复环
      attempt += 1;
      const wait = backoffMs * 2 ** (attempt - 1);
      appendGuarded(store, orderId, store.getOrder(orderId),
        [{ type: 'RECOVERY_ATTEMPTED', item_id: itemId, reason_code: res.reason_code,
           data: { attempt, backoff_ms: wait } }]);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      continue;
    }

    // 终判（T6）：A 类耗尽 / B 类 / C 类修正后仍失败
    appendGuarded(store, orderId, store.getOrder(orderId), [
      ...(cls === 'A' ? [{ type: 'RECOVERY_EXHAUSTED', item_id: itemId,
                           reason_code: res.reason_code, data: { attempts: attempt } }] : []),
      { type: 'ITEM_FAILED_FINAL', item_id: itemId, reason_code: res.reason_code,
        data: { evidence: { attempts: attempt, corrected, last_raw: lastRaw } } },
    ]);
    return { completed: false, reason_code: res.reason_code, recovery_attempts: attempt };
  }
}
