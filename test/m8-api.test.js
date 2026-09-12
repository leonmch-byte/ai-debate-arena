import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';

const fresh = async (simulateFail = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-m8-'));
  const srv = await startServer({ port: 0, dbPath: join(dir, 't.db'), simulateFail });
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const call = async (path, body) => {
    const r = await fetch(base + path, body === undefined ? {} :
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { code: r.status, data: await r.json().catch(() => ({})) };
  };
  return { dir, srv, base, call };
};

// 关键改动：t.after() 注册清理——无论测试成功还是断言失败，服务器必被关闭，
// 测试进程必退出，runner 必能打印汇总与失败详情。卡死从此结构性不可能。
test('M8-1 E2E 正常单：报价→支付→执行→自动预演，balance=0', async t => {
  const x = await fresh();
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const models = await (await fetch(x.base + '/api/models')).json();
  assert.equal(models.models['kimi'], 800);
  const q = await x.call('/api/quote', { model_ids: ['kimi', 'doubao-pro'] });
  assert.equal(q.code, 200);
  assert.equal(q.data.total_cents, 1600);
  const pay = await x.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay.data.cash_paid_cents, 1600);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'SETTLEMENT_PENDING');   // §7.3 全终态自动预演
  assert.ok(v.data.items.every(i => i.state === 'COMPLETED'));
  assert.equal(v.data.settlement.balance_cents, 0);
  assert.equal(v.data.settlement.delivered_value_cents, 1600);
  assert.equal(v.data.decision, null);
});

test('M8-2 E2E 故障单：自动弹窗契约 → 用户退款 → SETTLEMENT_PENDING，balance=0', async t => {
  const x = await fresh(['kimi']);
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { model_ids: ['kimi', 'deepseek-v3'] });
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'FULFILLING');
  const d = v.data.decision;
  assert.ok(d, 'FAILED_FINAL 应自动产生决策契约');
  assert.equal(d.failed_item.model_id, 'kimi');
  assert.equal(d.failed_item.locked_price_cents, 800);
  assert.equal(d.options[0].type, 'REFUND');
  assert.equal(d.options[0].refund_cash_cents, 800);
  assert.equal(d.default_on_timeout, 'REFUND');
  const itemId = d.failed_item.item_id;
  const v2 = await x.call(`/api/orders/${q.data.order_id}/items/${itemId}/decision`, { choice: 'REFUND' });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  const states = v2.data.items.map(i => i.state);
  assert.ok(states.includes('REFUNDED') && states.includes('COMPLETED'));
  assert.equal(v2.data.settlement.refunded_cash_cents, 800);
  assert.equal(v2.data.settlement.balance_cents, 0);
});

test('M8-3 E2E 换贵模型：补差→后继完成→REPLACED+COMPLETED，balance=0', async t => {
  const x = await fresh(['kimi']);
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { model_ids: ['kimi'] });
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  const d = v.data.decision;
  assert.ok(d);
  const v2 = await x.call(`/api/orders/${q.data.order_id}/items/${d.failed_item.item_id}/decision`,
    { choice: 'REPLACE', model_id: 'gpt-4o' });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  assert.ok(v2.data.items.some(i => i.state === 'REPLACED'));
  assert.ok(v2.data.items.some(i => i.state === 'COMPLETED' && i.model_id === 'gpt-4o'));
  assert.equal(v2.data.settlement.paid_cash_cents, 1000);
  assert.equal(v2.data.settlement.balance_cents, 0);
});

test('M8-4 防御：未付先 run→PAYMENT_REQUIRED / 重复 pay→ALREADY_CONFIRMED / 404', async t => {
  const x = await fresh();
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { model_ids: ['kimi'] });
  const runEarly = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(runEarly.code, 400);
  assert.equal(runEarly.data.error, 'PAYMENT_REQUIRED');
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const pay2 = await x.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay2.code, 400);
  assert.equal(pay2.data.error, 'ALREADY_CONFIRMED');
  const nf = await x.call('/api/orders/ord_nope');
  assert.equal(nf.code, 404);
});
