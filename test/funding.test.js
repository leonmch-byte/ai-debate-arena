import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateFunding } from '../src/funding.js';
import { allocateOrderTotal } from '../src/pricing.js';

test('M3-1 尾差分摊：Σ locked ≡ total，价格降序/item_id 升序承担（§7.1）', () => {
  const base = ['itm_1', 'itm_2', 'itm_3', 'itm_4', 'itm_5'].map(id => ({ item_id: id, price_cents: 799 }));
  const out = allocateOrderTotal(base, 3999);
  assert.deepEqual(out.map(o => o.locked_price_cents), [800, 800, 800, 800, 799]);
  assert.equal(out.reduce((a, o) => a + o.locked_price_cents, 0), 3999);
  const b2 = ['itm_1', 'itm_2', 'itm_3', 'itm_4', 'itm_5'].map(id => ({ item_id: id, price_cents: 800 }));
  const o2 = allocateOrderTotal(b2, 3990); // 5 模型会诊 ¥39.90
  assert.deepEqual(o2.map(o => o.locked_price_cents), [798, 798, 798, 798, 798]);
});

test('M3-2 升序抵扣：单价升序逐项核销、可部分核销、Σ 守恒（§2.4）', () => {
  const items = [
    { item_id: 'itm_a', locked_price_cents: 600 },
    { item_id: 'itm_b', locked_price_cents: 800 },
    { item_id: 'itm_c', locked_price_cents: 800 },
    { item_id: 'itm_d', locked_price_cents: 1000 },
    { item_id: 'itm_e', locked_price_cents: 1000 },
  ];
  const { funding, voucher_remaining } = allocateFunding(items,
    [{ voucher_id: 'vch_1', remaining_cents: 1600, expires_at: '2026-06-30' }]);
  const f = Object.fromEntries(funding.map(x => [x.item_id, x]));
  assert.deepEqual([f.itm_a.cash_cents, f.itm_a.credit_cents], [0, 600]);
  assert.deepEqual([f.itm_b.cash_cents, f.itm_b.credit_cents], [0, 800]);
  assert.deepEqual([f.itm_c.cash_cents, f.itm_c.credit_cents], [600, 200]);
  assert.deepEqual([f.itm_d.cash_cents, f.itm_d.credit_cents], [1000, 0]);
  assert.equal(f.itm_c.allocations[0].applied_cents, 200);
  assert.equal(voucher_remaining.vch_1, 0);
  const sumCash = funding.reduce((a, x) => a + x.cash_cents, 0);
  const sumCredit = funding.reduce((a, x) => a + x.credit_cents, 0);
  assert.equal(sumCash + sumCredit, 4200);
  assert.equal(sumCash, 2600);
});

test('M3-3 多券先到期先用（§6.4）', () => {
  const { funding, voucher_remaining } = allocateFunding(
    [{ item_id: 'itm_x', locked_price_cents: 1500 }],
    [
      { voucher_id: 'vch_A', remaining_cents: 1000, expires_at: '2026-01-01' },
      { voucher_id: 'vch_B', remaining_cents: 1000, expires_at: '2025-12-01' },
    ]);
  const allocs = funding[0].allocations;
  assert.equal(allocs[0].voucher_id, 'vch_B');
  assert.equal(allocs[0].applied_cents, 1000);
  assert.equal(allocs[1].voucher_id, 'vch_A');
  assert.equal(allocs[1].applied_cents, 500);
  assert.deepEqual(voucher_remaining, { vch_A: 500, vch_B: 0 });
  assert.equal(funding[0].cash_cents, 0);
});
