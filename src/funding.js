// M3：券额度→服务项资金的确定性分配（§2.4/§6.4）
// 规则：item 按单价升序（同价 item_id 字典序）逐项抵扣；券按先到期先用（同到期 voucher_id 升序）；额度可部分核销。
import { StoreError } from './store.js';

const byItemAsc = (a, b) =>
  a.locked_price_cents - b.locked_price_cents ||
  (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0);
const byVoucherExpiry = (a, b) => {
  const ea = a.expires_at ?? '9999-12-31', eb = b.expires_at ?? '9999-12-31';
  return ea < eb ? -1 : ea > eb ? 1 : (a.voucher_id < b.voucher_id ? -1 : 1);
};

export function allocateFunding(items, vouchers = []) {
  for (const it of items)
    if (!Number.isInteger(it.locked_price_cents) || it.locked_price_cents < 0)
      throw new StoreError('INVALID_FUNDING', `item ${it.item_id} 价格非法`);
  for (const v of vouchers) {
    if (!Number.isInteger(v.remaining_cents) || v.remaining_cents < 0)
      throw new StoreError('INVALID_FUNDING', `voucher ${v.voucher_id} 余额非法`);
  }
  const pool = vouchers.map(v => ({ ...v, left: v.remaining_cents })).sort(byVoucherExpiry);
  const split = new Map();
  for (const it of [...items].sort(byItemAsc)) {
    let need = it.locked_price_cents, credit = 0;
    const allocations = [];
    for (const v of pool) {
      if (need === 0) break;
      if (v.left === 0) continue;
      const use = Math.min(need, v.left);
      v.left -= use; need -= use; credit += use;
      allocations.push({ voucher_id: v.voucher_id, applied_cents: use });
    }
    split.set(it.item_id, { cash_cents: it.locked_price_cents - credit, credit_cents: credit, allocations });
  }
  const funding = items.map(it => ({ item_id: it.item_id, ...split.get(it.item_id) }));
  const voucher_remaining = {};
  for (const v of pool) voucher_remaining[v.voucher_id] = v.left;
  return { funding, voucher_remaining };
}
