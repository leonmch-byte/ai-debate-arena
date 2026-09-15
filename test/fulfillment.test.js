import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/store.js';
import { projectOrder, projectItems } from '../src/orders.js';
import { createQuote } from '../src/pricing.js';
import { confirmPayment, appendGuarded } from '../src/checkout.js';
import { SandboxChannel } from '../src/payments.js';
import { fulfillItem, classifyFailure } from '../src/fulfillment.js';

const paidOrder = async (modelIds) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m4-'));
  const store = new EventStore(join(dir, 't.db'));
  const q = createQuote(store, { user_id: 'u_m4', model_ids: modelIds });
  await confirmPayment(store, q.order_id, { channel: new SandboxChannel() });
  return { dir, store, orderId: q.order_id, items: q.items };
};
const cleanup = (store, dir) => { store.close(); rmSync(dir, { recursive: true, force: true }); };

class ScriptedAdapter {
  // { [model_id]: [ {fail:'MODEL_RATE_LIMITED'}, …, {ok:'res_1'} ] }；单元素剧本=永远重复
  constructor(scripts) { this.scripts = scripts; this.calls = []; }
  async run(model_id, input) {
    const s = this.scripts[model_id];
    this.calls.push({ model_id, input });
    const step = s.length > 1 ? s.shift() : s[0];
    if (step.ok) return { ok: true, result_ref: step.ok };
    return { ok: false, reason_code: step.fail, raw: { code: step.fail } };
  }
}

test('M4-1 正常履约：LOCKED→STARTED→COMPLETED，结果引用落账（T1/T3/T5）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['minimax-m3']);
  const r = await fulfillItem(store, orderId, items[0].item_id, 'minimax-m3',
    new ScriptedAdapter({ 'minimax-m3': [{ ok: 'res_report_1' }] }), { backoffMs: 0 });
  assert.equal(r.completed, true);
  const h = store.getOrder(orderId);
  assert.equal(h.find(e => e.type === 'ITEM_COMPLETED').data.result_ref, 'res_report_1');
  assert.equal(projectItems(h).get(items[0].item_id).state, 'COMPLETED');
  assert.equal(projectOrder(h), 'DELIVERED');
  cleanup(store, dir);
});

test('M4-2 A类耗尽：3次恢复（退避1/2/4）→EXHAUSTED→FAILED_FINAL（T4/T6）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['doubao-pro']);
  const adapter = new ScriptedAdapter({ 'doubao-pro': [{ fail: 'MODEL_RATE_LIMITED' }] });
  const r = await fulfillItem(store, orderId, items[0].item_id, 'doubao-pro', adapter, { backoffMs: 0 });
  assert.equal(r.completed, false);
  assert.equal(r.reason_code, 'MODEL_RATE_LIMITED');
  const h = store.getOrder(orderId);
  const recov = h.filter(e => e.type === 'RECOVERY_ATTEMPTED');
  assert.equal(recov.length, 3);
  assert.deepEqual(recov.map(e => Number(e.data.attempt)), [1, 2, 3]);
  assert.deepEqual(recov.map(e => Number(e.data.backoff_ms)), [1000, 2000, 4000]);
  assert.equal(h.filter(e => e.type === 'RECOVERY_EXHAUSTED').length, 1);
  assert.equal(h.find(e => e.type === 'ITEM_FAILED_FINAL').reason_code, 'MODEL_RATE_LIMITED');
  const it = projectItems(h).get(items[0].item_id);
  assert.equal(it.state, 'FAILED_FINAL');
  assert.equal(it.attempts, 3);
  cleanup(store, dir);
});

test('M4-3 A类恢复成功：1次恢复后 COMPLETED，用户无感（§4.2）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['kimi-k3']);
  const adapter = new ScriptedAdapter({ 'kimi-k3': [{ fail: 'MODEL_TIMEOUT' }, { ok: 'res_after_retry' }] });
  const r = await fulfillItem(store, orderId, items[0].item_id, 'kimi-k3', adapter, { backoffMs: 0 });
  assert.equal(r.completed, true);
  assert.equal(r.recovery_attempts, 1);
  const h = store.getOrder(orderId);
  assert.equal(h.filter(e => e.type === 'RECOVERY_ATTEMPTED').length, 1);
  assert.equal(projectItems(h).get(items[0].item_id).state, 'COMPLETED');
  assert.equal(projectOrder(h), 'DELIVERED');
  cleanup(store, dir);
});

test('M4-4 B类不进恢复环：直接 FAILED_FINAL（§4.1）', async () => {
  const { store, dir, orderId, items } = await paidOrder(['deepseek-v41']);
  const adapter = new ScriptedAdapter({ 'deepseek-v41': [{ fail: 'MODEL_AUTH_FAILURE' }] });
  const r = await fulfillItem(store, orderId, items[0].item_id, 'deepseek-v41', adapter, { backoffMs: 0 });
  assert.equal(r.completed, false);
  assert.equal(r.reason_code, 'MODEL_AUTH_FAILURE');
  const h = store.getOrder(orderId);
  assert.equal(h.filter(e => e.type === 'RECOVERY_ATTEMPTED').length, 0);
  assert.equal(h.filter(e => e.type === 'RECOVERY_EXHAUSTED').length, 0);
  assert.equal(h.find(e => e.type === 'ITEM_FAILED_FINAL').reason_code, 'MODEL_AUTH_FAILURE');
  cleanup(store, dir);
});

test('M4-5 C类：修正1次成功 / 修正后仍失败→终判（§4.2）', async () => {
  {
    const { store, dir, orderId, items } = await paidOrder(['doubao-pro']);
    const adapter = new ScriptedAdapter({ 'doubao-pro': [{ fail: 'MODEL_RESPONSE_INVALID' }, { ok: 'res_corrected' }] });
    const r = await fulfillItem(store, orderId, items[0].item_id, 'doubao-pro', adapter, { backoffMs: 0 });
    assert.equal(r.completed, true);
    const h = store.getOrder(orderId);
    const cr = h.filter(e => e.type === 'RECOVERY_ATTEMPTED');
    assert.equal(cr.length, 1);
    assert.equal(cr[0].data.kind, 'C_RETRY_CORRECTED');
    assert.deepEqual(adapter.calls[1].input, { corrected: true });
    assert.equal(projectItems(h).get(items[0].item_id).state, 'COMPLETED');
    cleanup(store, dir);
  }
  {
    const { store, dir, orderId, items } = await paidOrder(['doubao-pro']);
    const adapter = new ScriptedAdapter({ 'doubao-pro': [{ fail: 'MODEL_RESPONSE_INVALID' }] });
    const r = await fulfillItem(store, orderId, items[0].item_id, 'doubao-pro', adapter, { backoffMs: 0 });
    assert.equal(r.completed, false);
    const h = store.getOrder(orderId);
    assert.equal(h.filter(e => e.type === 'RECOVERY_ATTEMPTED').length, 1);
    assert.equal(h.find(e => e.type === 'ITEM_FAILED_FINAL').reason_code, 'MODEL_RESPONSE_INVALID');
    cleanup(store, dir);
  }
});

test('M4-6 T1前置：未支付订单直接 ITEM_LOCKED 被拒（§3.1 T1）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m4-'));
  const store = new EventStore(join(dir, 't.db'));
  const q = createQuote(store, { user_id: 'u_m4', model_ids: ['kimi-k3'] });
  assert.throws(
    () => appendGuarded(store, q.order_id, store.getOrder(q.order_id),
      [{ type: 'ITEM_LOCKED', item_id: q.items[0].item_id }]),
    e => e.code === 'PAYMENT_REQUIRED');
  cleanup(store, dir);
});

test('M4-7 reason_code 全集分类正确 + 非法code被拒 + UPSTREAM_SUSPENDED全链路（§1.5）', async () => {
  assert.equal(classifyFailure('MODEL_UNAVAILABLE'), 'A');
  assert.equal(classifyFailure('MODEL_TIMEOUT'), 'A');
  assert.equal(classifyFailure('MODEL_RATE_LIMITED'), 'A');
  assert.equal(classifyFailure('MODEL_AUTH_FAILURE'), 'B');
  assert.equal(classifyFailure('UPSTREAM_SUSPENDED'), 'B');
  assert.equal(classifyFailure('MODEL_RESPONSE_INVALID'), 'C');
  assert.throws(() => classifyFailure('SOMETHING_ELSE'), e => e.code === 'UNKNOWN_REASON_CODE');
  const { store, dir, orderId, items } = await paidOrder(['doubao-pro', 'deepseek-v41']);
  const adapter = new ScriptedAdapter({ 'doubao-pro': [{ fail: 'UPSTREAM_SUSPENDED' }] });
  await fulfillItem(store, orderId, items[0].item_id, 'doubao-pro', adapter, { backoffMs: 0 });
  const h = store.getOrder(orderId);
  const ff = h.find(e => e.type === 'ITEM_FAILED_FINAL' && e.item_id === items[0].item_id);
  assert.equal(ff.reason_code, 'UPSTREAM_SUSPENDED');
  assert.equal(ff.data.evidence.corrected, false);
  cleanup(store, dir);
});
