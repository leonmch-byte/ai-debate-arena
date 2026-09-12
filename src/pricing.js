// M3：价格表查询 + 尾差分摊（§7.1）+ 报价创建（§5.2）
import { StoreError } from './store.js';
import { genOrderId, genItemId } from './ids.js';
import { PRICE_TABLE_VERSION, PRICE_TABLES, SLA } from './config.js';
import { allocateFunding } from './funding.js';

export function lookupPrice(version, model_id) {
  const table = PRICE_TABLES[version];
  if (!table) throw new StoreError('UNKNOWN_PRICE_TABLE', version);
  if (!(model_id in table.models)) throw new StoreError('UNKNOWN_MODEL', model_id);
  return table.models[model_id];
}

// 尾差分摊：Σ locked ≡ total；价格降序、同价 item_id 升序，逐分承担（§7.1）
export function allocateOrderTotal(items, totalCents) {
  if (!Number.isInteger(totalCents) || totalCents < 0)
    throw new StoreError('INVALID_QUOTE', 'bundle_total_cents 必须是非负整数（分）');
  const sum = items.reduce((a, i) => a + i.price_cents, 0);
  const order = [...items].sort((a, b) =>
    b.price_cents - a.price_cents || (a.item_id < b.item_id ? -1 : 1));
  const adj = new Map(items.map(i => [i.item_id, 0]));
  let diff = totalCents - sum;
  const step = diff > 0 ? 1 : -1;
  let k = 0;
  while (diff !== 0) {
    const id = order[k % order.length].item_id;
    adj.set(id, adj.get(id) + step);
    diff -= step; k += 1;
    if (k > 1_000_000) throw new StoreError('ALLOCATION_OVERFLOW', '尾差分摊异常');
  }
  const out = items.map(i => ({ ...i, locked_price_cents: i.price_cents + adj.get(i.item_id) }));
  for (const o of out)
    if (o.locked_price_cents < 0) throw new StoreError('ALLOCATION_NEGATIVE', '尾差分摊导致负价格');
  return out;
}

export function createQuote(store, { user_id, model_ids, bundle_total_cents = null, vouchers = [], now = new Date() }) {
  if (!Array.isArray(model_ids) || model_ids.length === 0)
    throw new StoreError('INVALID_QUOTE', 'model_ids 不能为空');
  const base = model_ids.map(id => ({ model_id: id, price_cents: lookupPrice(PRICE_TABLE_VERSION, id) }));
  const priced = bundle_total_cents == null
    ? base.map(b => ({ ...b, locked_price_cents: b.price_cents }))
    : allocateOrderTotal(base, bundle_total_cents);
  const items = priced.map(p => ({
    item_id: genItemId(), model_id: p.model_id,
    price_cents: p.price_cents, locked_price_cents: p.locked_price_cents,
  }));
  const total = items.reduce((a, i) => a + i.locked_price_cents, 0);
  const expires_at = new Date(now.getTime() + SLA.QUOTE_TTL_MINUTES * 60_000).toISOString();
  const { funding } = allocateFunding(items, vouchers);
  const orderId = genOrderId();
  const events = [{
    type: 'QUOTE_CREATED',
    data: { user_id, price_table_version: PRICE_TABLE_VERSION, items, total_cents: total, expires_at },
  }];
  // 额度预占（§6.2）：报价即锁额度，防同一张券被两个报价同时占用
  const reserved = new Map();
  for (const f of funding) for (const a of f.allocations)
    reserved.set(a.voucher_id, (reserved.get(a.voucher_id) ?? 0) + a.applied_cents);
  for (const [voucher_id, cents] of reserved)
    events.push({ type: 'VOUCHER_RESERVED', data: { voucher_id, reserved_cents: cents } });
  store.append(orderId, events);
  return { order_id: orderId, items, total_cents: total, expires_at, funding_preview: funding };
}
