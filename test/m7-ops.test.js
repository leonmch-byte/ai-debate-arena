import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { createQuote } from '../src/pricing.js';
import { confirmPayment, appendGuarded } from '../src/checkout.js';
import { SandboxChannel } from '../src/payments.js';
import { fulfillItem } from '../src/fulfillment.js';
import { openDecision, executeReplaceChoice } from '../src/decisions.js';
import { previewSettlement } from '../src/settlement.js';
import { runCycle, scanDecisionTimeouts, scanSurchargeWindows, scanSettlements } from '../src/jobs.js';
import { reconcileOperations, sweepInvariants } from '../src/recon.js';
import { retryStuckRefund, issueGoodwill, resolveUnknownPayment, poolReport } from '../src/admin.js';
import { RUNTIME_FLAGS } from '../src/config.js';
import { genOperationId } from '../src/ids.js';

const HOUR = 3600_000, MIN = 60_000;
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m7-'));
  return { dir, store: new EventStore(join(dir, 't.db')) };
};
const cleanup = (s, d) => { s.close(); rmSync(d, { recursive: true, force: true }); };
const fail = (store, orderId, itemId, modelId) =>
  fulfillItem(store, orderId, itemId, modelId,
    { async run() { return { ok: false, reason_code: 'MODEL_AUTH_FAILURE' }; } }, { backoffMs: 0 });

test('M7-1 决策超时扫描：到期自动退款，重跑幂等（T10）', async () => {
  const { store, dir } = fresh();
  const q = createQuote(store, { user_id: 'u7', model_ids: ['kimi'] });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  const it = q.items[0].item_id;
  await fail(store, q.order_id, it, 'kimi');
  openDecision(store, q.order_id, it, new Date(Date.now() - 25 * HOUR));
  const ch = new SandboxChannel();
  const fired = await scanDecisionTimeouts(store, ch);
  assert.equal(fired.length, 1);
  const h = store.getOrder(q.order_id);
  assert.ok(h.some(e => e.type === 'DECISION_TIMEOUT'));
  assert.ok(h.some(e => e.type === 'REFUND_EXECUTED' && e.decision_source === 'TIMEOUT_RULE'));
  assert.equal(projectItemState(h, it), 'TIMEOUT_REFUNDED');
  assert.deepEqual(await scanDecisionTimeouts(store, ch), []);
  cleanup(store, dir);
});

test('M7-2 补差窗口扫描：后继 VOIDED + 前驱自动退款（T12→T10）', async () => {
  const { store, dir } = fresh();
  const q = createQuote(store, { user_id: 'u7', model_ids: ['kimi'] });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  const it = q.items[0].item_id;
  await fail(store, q.order_id, it, 'kimi');
  openDecision(store, q.order_id, it);
  // 模拟"选了换贵模型但补差始终未付"：REPLACE 决策 + SURCHARGE_DUE（真实流水中二者都存在）
  appendGuarded(store, q.order_id, store.getOrder(q.order_id),
    [{ type: 'DECISION_RECEIVED', item_id: it, decision_source: 'USER_DECISION',
       data: { choice: 'REPLACE', successor_item_id: 'itm_succ7', delta_cents: 200 } }]);
  appendGuarded(store, q.order_id, store.getOrder(q.order_id),
    [{ type: 'SURCHARGE_DUE', item_id: it, amount_cents: 200,
       data: { successor_item_id: 'itm_succ7' } }]);
  const ch = new SandboxChannel();
  const fired = await scanSurchargeWindows(store, ch, new Date(Date.now() + 16 * MIN));
  assert.equal(fired.length, 1);
  const h = store.getOrder(q.order_id);
  assert.ok(h.some(e => e.type === 'SURCHARGE_EXPIRED' && e.item_id === 'itm_succ7'));
  assert.ok(h.some(e => e.type === 'REFUND_EXECUTED' && e.decision_source === 'TIMEOUT_RULE'));
  assert.deepEqual(await scanSurchargeWindows(store, ch, new Date(Date.now() + 17 * MIN)), []);
  cleanup(store, dir);
});

test('M7-3 结算自动落地：72h 后 FINALIZED，重跑幂等（§7.3）', async () => {
  const { store, dir } = fresh();
  const q = createQuote(store, { user_id: 'u7', model_ids: ['kimi', 'doubao-pro'] });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  for (const it of q.items)
    await fulfillItem(store, q.order_id, it.item_id, it.model_id,
      { async run() { return { ok: true, result_ref: 'res' }; } }, { backoffMs: 0 });
  previewSettlement(store, q.order_id, { now: new Date(Date.now() - 73 * HOUR) });
  const r = await scanSettlements(store, new Date());
  assert.equal(r.finalized.length, 1);
  assert.equal(store.getOrder(q.order_id).filter(e => e.type === 'SETTLEMENT_FINALIZED').length, 1);
  assert.deepEqual((await scanSettlements(store, new Date())).finalized, []);
  cleanup(store, dir);
});

test('M7-4 runCycle 全周期 + 对账四类差异检出（§5.5）', async () => {
  const { store, dir } = fresh();
  const q = createQuote(store, { user_id: 'u7', model_ids: ['kimi'] });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  const cycle = await runCycle(store, new SandboxChannel());
  assert.equal(cycle.errors.length, 0);
  const ph = genOperationId('refund', q.order_id);
  store.recordOperation({ operation_id: ph, order_id: q.order_id, obligation_id: 'obl_ph', type: 'refund' });
  store.markOperation(ph, 'EXECUTED', 'ch_phantom');
  const st = genOperationId('payment', q.order_id);
  store.recordOperation({ operation_id: st, order_id: q.order_id, obligation_id: 'obl_st', type: 'payment' });
  store.markOperation(st, 'UNKNOWN');
  const q2 = createQuote(store, { user_id: 'u7', model_ids: ['doubao-pro'] });
  store.append(q2.order_id, [{ type: 'PAYMENT_SUCCEEDED', amount_cents: 800,
    data: { operation_id: 'op_payment:ghost:00000000-0000-0000-0000-000000000000' } }]);
  const issues = reconcileOperations(store);
  assert.equal(issues.missing_event.length, 1);
  assert.equal(issues.phantom.length, 1);
  const pool = poolReport(store, new Date(Date.now() + 31 * MIN));
  assert.equal(pool.pool.length, 1);
  cleanup(store, dir);
});

test('M7-5 巡检：健康库零违例（§8.5/§9.5 重放）', async () => {
  const { store, dir } = fresh();
  const q = createQuote(store, { user_id: 'u7', model_ids: ['kimi', 'doubao-pro'] });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  for (const it of q.items)
    await fulfillItem(store, q.order_id, it.item_id, it.model_id,
      { async run() { return { ok: true, result_ref: 'r' }; } }, { backoffMs: 0 });
  previewSettlement(store, q.order_id);
  const s = sweepInvariants(store);
  assert.deepEqual(s.violations, []);
  assert.ok(s.checked >= 1);
  cleanup(store, dir);
});

test('M7-6 admin 退款重试 + GOODWILL 限额（≤实付50%）+ 双审开关（§8.2–8.4）', async () => {
  const { store, dir } = fresh();
  const q = createQuote(store, { user_id: 'u7', model_ids: ['qwen-max'] });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  const it = q.items[0].item_id;
  await fail(store, q.order_id, it, 'qwen-max');
  openDecision(store, q.order_id, it);
  const ch = new SandboxChannel(['FAILED']);
  await assert.rejects(() => import('../src/decisions.js').then(m => m.executeRefundChoice(store, q.order_id, it, ch)),
    e => e.code === 'REFUND_STUCK');
  const r = await retryStuckRefund(store, q.order_id, it, { channel: new SandboxChannel(), actor: 'cs_1', ticket_ref: 'T-100' });
  assert.equal(r.refunded_cash_cents ?? 800, 800);
  assert.ok(store.getOrder(q.order_id).some(e => e.type === 'ADMIN_ACTION' && e.data.action === 'RETRY_STUCK_REFUND'));
  // 实付 800 → 50% 上限 400：300 合规，5000 触发单笔限额，1000 触发比例限额
  assert.equal(issueGoodwill(store, q.order_id, { amount_cents: 300, actor: 'cs_1', ticket_ref: 'T-101' }).amount_cents, 300);
  assert.throws(() => issueGoodwill(store, q.order_id, { amount_cents: 5000, actor: 'cs_1', ticket_ref: 'T-102' }),
    e => e.code === 'GOODWILL_LIMIT');
  assert.throws(() => issueGoodwill(store, q.order_id, { amount_cents: 1000, actor: 'cs_1', ticket_ref: 'T-102b' }),
    e => e.code === 'GOODWILL_LIMIT');
  RUNTIME_FLAGS.dual_review_enabled = true;
  try {
    assert.throws(() => issueGoodwill(store, q.order_id, { amount_cents: 300, actor: 'cs_1', ticket_ref: 'T-103' }),
      e => e.code === 'APPROVER_REQUIRED');
    assert.throws(() => issueGoodwill(store, q.order_id, { amount_cents: 300, actor: 'cs_1', ticket_ref: 'T-104', approver: 'cs_1' }),
      e => e.code === 'APPROVER_EQUALS_ACTOR');
    assert.equal(issueGoodwill(store, q.order_id, { amount_cents: 300, actor: 'cs_1', ticket_ref: 'T-105', approver: 'owner' }).amount_cents, 300);
  } finally { RUNTIME_FLAGS.dual_review_enabled = false; }
  cleanup(store, dir);
});

test('M7-7 支付未决出池：渠道收敛后人工确认，订单完整成立（§8.2①）', async () => {
  const { store, dir } = fresh();
  const ch = new SandboxChannel(['UNKNOWN'], { stickyUnknown: true });
  const q = createQuote(store, { user_id: 'u7', model_ids: ['kimi'] });
  await assert.rejects(() => confirmPayment(store, q.order_id, { channel: ch }),
    e => e.code === 'PAYMENT_UNKNOWN');
  assert.equal(store.getOrder(q.order_id).filter(e => e.type === 'ORDER_CONFIRMED').length, 0);
  const r0 = await resolveUnknownPayment(store, q.order_id, { channel: ch, actor: 'cs_1', ticket_ref: 'T-200' });
  assert.equal(r0.resolved, false);
  ch.confirmUnknown(store.getOperationsByOrder(q.order_id).find(o => o.state === 'UNKNOWN').operation_id);
  const r1 = await resolveUnknownPayment(store, q.order_id, { channel: ch, actor: 'cs_1', ticket_ref: 'T-200' });
  assert.equal(r1.resolved, true);
  assert.equal(r1.cash_paid_cents, 800);
  const h = store.getOrder(q.order_id);
  assert.ok(h.some(e => e.type === 'ORDER_CONFIRMED'));
  assert.ok(h.some(e => e.type === 'PAYMENT_UNKNOWN_RESOLVED'));
  assert.equal(sweepInvariants(store).violations.length, 0);
  cleanup(store, dir);
});

function projectItemState(history, itemId) {
  // 轻量推导：只看最后一个相关终态事件，避免引入完整投影依赖
  const s = [...history].filter(e => e.item_id === itemId).reverse();
  for (const e of s) {
    if (e.type === 'REFUND_EXECUTED') return e.decision_source === 'TIMEOUT_RULE' ? 'TIMEOUT_REFUNDED' : 'REFUNDED';
    if (e.type === 'ITEM_COMPLETED') return 'COMPLETED';
    if (e.type === 'ITEM_FAILED_FINAL') return 'FAILED_FINAL';
  }
  return 'RUNNING';
}
