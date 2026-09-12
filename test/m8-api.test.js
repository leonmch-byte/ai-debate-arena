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
  // M8-fix3 根因修复：method 显式声明。默认 POST（quote/pay/run/decision 均为 POST），
  // GET 必须显式传 { method:'GET' }。旧 helper 无 body 时退化为 GET，是四轮全红的唯一根因。
  const call = async (path, { method = 'POST', body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { code: r.status, data: await r.json().catch(() => ({})) };
  };
  return { dir, srv, base, call };
};

test('M8-1 E2E 正常单：报价→支付→执行→自动预演，balance=0', async t => {
  const x = await fresh();
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const models = await (await fetch(x.base + '/api/models')).json();
  assert.equal(models.models['kimi'], 800);
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi', 'doubao-pro'] } });
  assert.equal(q.code, 200);
  assert.equal(q.data.total_cents, 1600);
  const pay = await x.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay.code, 200);
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
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi', 'deepseek-v3'] } });
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(v.data.status, 'FULFILLING');           // 有未决决策 → 履行中
  const d = v.data.decision;
  assert.ok(d, 'FAILED_FINAL 应自动产生决策契约');
  assert.equal(d.failed_item.model_id, 'kimi');
  assert.equal(d.failed_item.locked_price_cents, 800);
  assert.equal(d.options[0].type, 'REFUND');
  assert.equal(d.options[0].refund_cash_cents, 800);
  assert.equal(d.default_on_timeout, 'REFUND');
  const itemId = d.failed_item.item_id;
  const v2 = await x.call(`/api/orders/${q.data.order_id}/items/${itemId}/decision`,
    { body: { choice: 'REFUND' } });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  const states = v2.data.items.map(i => i.state);
  assert.ok(states.includes('REFUNDED') && states.includes('COMPLETED'));
  assert.equal(v2.data.settlement.refunded_cash_cents, 800);
  assert.equal(v2.data.settlement.balance_cents, 0);
});

test('M8-3 E2E 换贵模型：补差→后继完成→REPLACED+COMPLETED，balance=0', async t => {
  const x = await fresh(['kimi']);
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi'] } });
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const v = await x.call(`/api/orders/${q.data.order_id}/run`);
  const d = v.data.decision;
  assert.ok(d);
  const v2 = await x.call(`/api/orders/${q.data.order_id}/items/${d.failed_item.item_id}/decision`,
    { body: { choice: 'REPLACE', model_id: 'gpt-4o' } });
  assert.equal(v2.data.status, 'SETTLEMENT_PENDING');
  assert.ok(v2.data.items.some(i => i.state === 'REPLACED'));
  assert.ok(v2.data.items.some(i => i.state === 'COMPLETED' && i.model_id === 'gpt-4o'));
  assert.equal(v2.data.settlement.paid_cash_cents, 1000);   // 800 + 补差 200
  assert.equal(v2.data.settlement.balance_cents, 0);
});

test('M8-4 防御：GET打POST端点→404 / 未付run→400 / 重复pay→400 / 404', async t => {
  const x = await fresh();
  t.after(() => x.srv.close().then(() => rmSync(x.dir, { recursive: true, force: true })));
  const q = await x.call('/api/quote', { body: { model_ids: ['kimi'] } });
  // 本轮根因钉死为契约：POST-only 端点收到 GET → 404
  const wrongMethod = await x.call(`/api/orders/${q.data.order_id}/pay`, { method: 'GET' });
  assert.equal(wrongMethod.code, 404);
  const runEarly = await x.call(`/api/orders/${q.data.order_id}/run`);
  assert.equal(runEarly.code, 400);
  assert.equal(runEarly.data.error, 'PAYMENT_REQUIRED');
  await x.call(`/api/orders/${q.data.order_id}/pay`);
  const pay2 = await x.call(`/api/orders/${q.data.order_id}/pay`);
  assert.equal(pay2.code, 400);
  assert.equal(pay2.data.error, 'ALREADY_CONFIRMED');
  const nf = await x.call('/api/orders/ord_nope', { method: 'GET' });
  assert.equal(nf.code, 404);
});
