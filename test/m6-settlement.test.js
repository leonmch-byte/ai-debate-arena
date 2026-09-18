import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { projectOrder } from '../src/orders.js';
import { createQuote } from '../src/pricing.js';
import { confirmPayment } from '../src/checkout.js';
import { SandboxChannel } from '../src/payments.js';
import { fulfillItem } from '../src/fulfillment.js';
import { openDecision, executeRefundChoice, executeReplaceChoice, executeTimeout } from '../src/decisions.js';
import { E1, previewSettlement, assertI3, finalizeSettlement,
         raiseObjection, resolveObjection } from '../src/settlement.js';
import { assertI7, projectVouchers } from '../src/vouchers.js';
import { expireVouchers } from '../src/jobs.js';
import { genOperationId } from '../src/ids.js';

const paidOrder = async (modelIds, bundle = null, vouchers = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m6-'));
  const store = new EventStore(join(dir, 't.db'));
  const q = createQuote(store, { user_id: 'u_m6', model_ids: modelIds, bundle_total_cents: bundle, vouchers });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel(), vouchers });
  return { dir, store, orderId: q.order_id, items: q.items };
};
const cleanup = (s, d) => { s.close(); rmSync(d, { recursive: true, force: true }); };
const fail = async (store, orderId, itemId, modelId, reason = 'MODEL_AUTH_FAILURE') =>
  fulfillItem(store, orderId, itemId, modelId,
    { async run() { return { ok: false, reason_code: reason }; } }, { backoffMs: 0 });
const ok = async (store, orderId, itemId, modelId, ref = 'res_ok') =>
  fulfillItem(store, orderId, itemId, modelId,
    { async run() { return { ok: true, result_ref: ref }; } }, { backoffMs: 0 });
const HOUR = 3600_000;

test('M6-1 金样本：5模型 ¥39.90 → 1换1退 → 预演逐字段 + balance=0（§7.2）', async () => {
  const { store, dir, orderId, items } = await paidOrder(
    ['kimi-k3', 'kimi-k3', 'kimi-k3', 'kimi-k3', 'kimi-k3'], 3990);
  for (const i of [0, 2, 4]) await ok(store, orderId, items[i].item_id, 'kimi-k3', 'res_' + i);
  await fail(store, orderId, items[1].item_id, 'kimi-k3');
  openDecision(store, orderId, items[1].item_id);
  const rep = await executeReplaceChoice(store, orderId, items[1].item_id, 'minimax-m3', new SandboxChannel());
  assert.equal(rep.carryover.cash_delta_cents, 202);      // 1000 − 798
  await ok(store, orderId, rep.successor_item_id, 'minimax-m3', 'res_succ');
  await fail(store, orderId, items[3].item_id, 'kimi-k3');
  openDecision(store, orderId, items[3].item_id);
  await executeRefundChoice(store, orderId, items[3].item_id, new SandboxChannel());

  const h = store.getOrder(orderId);
  assert.equal(E1(h).diff, 0);
  const pv = previewSettlement(store, orderId);
  assert.equal(pv.order_total_locked_cents, 3990);
  assert.equal(pv.paid_cash_cents, 4192);                 // 3990 + 202
  assert.equal(pv.refunded_cash_cents, 798);
  assert.equal(pv.delivered_value_cents, 3394);           // 798×3 + 1000
  assert.equal(pv.final_due_cents, 3394);
  assert.equal(pv.balance_cents, 0);
  assert.equal(pv.adjustments.length, 6);
  assert.ok(pv.adjustments.some(a => a.kind === 'REPLACED'));
  assert.ok(pv.adjustments.some(a => a.kind === 'REFUND' && a.delta_cents === -798));
  assert.equal(projectOrder(store.getOrder(orderId)), 'SETTLEMENT_PENDING');
  cleanup(store, dir);
});

test('M6-2 I3：义务未执行被拦；执行后通过（§7.1 E3）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['doubao-pro']);
  const it = items[0].item_id;
  await fail(store, orderId, it, 'doubao-pro');
  openDecision(store, orderId, it);
  await assert.rejects(() => executeRefundChoice(store, orderId, it, new SandboxChannel(['FAILED'])),
    e => e.code === 'REFUND_STUCK');
  assert.throws(() => assertI3(store, orderId), e => e.code === 'I3_UNSETTLED_DUES');
  const { applyFullRefund } = await import('../src/refunds.js');
  await applyFullRefund(store, orderId, it, { channel: new SandboxChannel(), decision_source: 'USER_DECISION' });
  assert.equal(assertI3(store, orderId), true);
  assert.equal(E1(store.getOrder(orderId)).diff, 0);
  cleanup(store, dir);
});

test('M6-3 finalize 三关：无预演被拒 / 72h 未满被拒 / 期满落账带hash（§7.3/§7.4）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3', 'doubao-pro']);
  await ok(store, orderId, items[0].item_id, 'kimi-k3');
  await ok(store, orderId, items[1].item_id, 'doubao-pro');
  assert.throws(() => finalizeSettlement(store, orderId, { now: new Date(Date.now() + 80 * HOUR) }),
    e => e.code === 'NO_PREVIEW');
  previewSettlement(store, orderId);
  assert.throws(() => finalizeSettlement(store, orderId, { now: new Date(Date.now() + 1 * HOUR) }),
    e => e.code === 'PREVIEW_PERIOD_ACTIVE');
  const { hash, snapshot } = finalizeSettlement(store, orderId, { now: new Date(Date.now() + 73 * HOUR) });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.balance_cents, 0);
  assert.equal(projectOrder(store.getOrder(orderId)), 'SETTLEMENT_FINALIZED');
  cleanup(store, dir);
});

test('M6-4 异议：DISPUTED 冻结 finalize → 解决 → 落账；第3次异议转人工（§7.3）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3', 'doubao-pro']);
  await ok(store, orderId, items[0].item_id, 'kimi-k3');
  await ok(store, orderId, items[1].item_id, 'doubao-pro');
  previewSettlement(store, orderId);
  raiseObjection(store, orderId, { scope: 'itm_all', reason: '对退款金额有疑问' });
  assert.equal(projectOrder(store.getOrder(orderId)), 'DISPUTED');
  assert.throws(() => finalizeSettlement(store, orderId, { now: new Date(Date.now() + 80 * HOUR) }),
    e => e.code === 'OBJECTION_OPEN');
  resolveObjection(store, orderId, { resolution: 'MAINTAIN', note: '核对无误' });
  assert.equal(projectOrder(store.getOrder(orderId)), 'SETTLEMENT_PENDING');
  const { hash } = finalizeSettlement(store, orderId, { now: new Date(Date.now() + 80 * HOUR) });
  assert.match(hash, /^[0-9a-f]{64}$/);
  raiseObjection(store, orderId, { scope: 'x', reason: 'r2' });
  assert.throws(() => raiseObjection(store, orderId, { scope: 'x', reason: 'r3' }),
    e => e.code === 'MANUAL_POOL_REQUIRED');
  cleanup(store, dir);
});

test('M6-5 无交付物结算：全退 → delivered=0 / final_due=0 / balance=0（§7.5）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3', 'doubao-pro']);
  for (const idx of [0, 1]) {
    const it = items[idx].item_id;
    await fail(store, orderId, it, ['kimi-k3', 'doubao-pro'][idx]);
    openDecision(store, orderId, it);
    await executeTimeout(store, orderId, it, new SandboxChannel());
  }
  const pv = previewSettlement(store, orderId);
  assert.equal(pv.delivered_value_cents, 0);
  assert.equal(pv.paid_cash_cents, 1600);
  assert.equal(pv.refunded_cash_cents, 1600);
  assert.equal(pv.final_due_cents, 0);
  assert.equal(pv.balance_cents, 0);
  finalizeSettlement(store, orderId, { now: new Date(Date.now() + 73 * HOUR) });
  assert.equal(projectOrder(store.getOrder(orderId)), 'SETTLEMENT_FINALIZED');
  cleanup(store, dir);
});

test('M6-6 券过期任务：未到期不动作 / 到期作废留痕 / 重跑幂等 / I7 守恒（§6.6/§6.7）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3']);
  const it = items[0].item_id;
  await fail(store, orderId, it, 'kimi-k3');
  openDecision(store, orderId, it);
  const r = executeVoucherChoiceM6(store, orderId, it);
  const vid = r.voucher_id;
  const early = expireVouchers(store, new Date(Date.now() + 89 * 24 * HOUR));
  assert.deepEqual(early, []);
  const fired = expireVouchers(store, new Date(Date.now() + 91 * 24 * HOUR));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].voucher_id, vid);
  assert.equal(fired[0].expired_cents, 800);
  const again = expireVouchers(store, new Date(Date.now() + 92 * 24 * HOUR));
  assert.deepEqual(again, []);
  const all = store.getAllEvents();
  assertI7(all);
  const v = projectVouchers(all).get(vid);
  assert.equal(v.remaining_cents, 0);
  assert.equal(v.expired_cents, 800);
  cleanup(store, dir);
});
// 独立引入，避免顶部重复
import { executeVoucherChoice as executeVoucherChoiceM6 } from '../src/decisions.js';

test('M6-7 I3 拦截未决渠道操作；操作收敛后放行（§5.1×§7.1）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3', 'doubao-pro']);
  await ok(store, orderId, items[0].item_id, 'kimi-k3');
  await ok(store, orderId, items[1].item_id, 'doubao-pro');
  previewSettlement(store, orderId);
  const op = genOperationId('payment', orderId);
  store.recordOperation({ operation_id: op, order_id: orderId, obligation_id: 'obl_test', type: 'payment' });
  store.markOperation(op, 'UNKNOWN');
  assert.throws(() => finalizeSettlement(store, orderId, { now: new Date(Date.now() + 80 * HOUR) }),
    e => e.code === 'I3_UNSETTLED_OPERATIONS');
  store.markOperation(op, 'EXECUTED', 'ch_x');
  const { hash } = finalizeSettlement(store, orderId, { now: new Date(Date.now() + 80 * HOUR) });
  assert.match(hash, /^[0-9a-f]{64}$/);
  cleanup(store, dir);
});

test('M6-8 预演前置：存在未终态 item 时拒绝预演（§7.3）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3', 'doubao-pro']);
  await ok(store, orderId, items[0].item_id, 'kimi-k3');
  assert.throws(() => previewSettlement(store, orderId), e => e.code === 'NOT_SETTLEMENT_READY');
  cleanup(store, dir);
});
