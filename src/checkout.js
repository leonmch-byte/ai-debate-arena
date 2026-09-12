// M3：结账引擎——报价确认 / 沙箱收款 / funding_split 落账（§5.2、§2.4）
// 所有 append 前过 M2 守卫：引擎也只能走合法轨道。
import { StoreError } from './store.js';
import { genOperationId } from './ids.js';
import { assertEventAllowed, projectOrder } from './orders.js';
import { allocateFunding } from './funding.js';

export function appendGuarded(store, orderId, history, events) {
  let h = history;
  for (const ev of events) { assertEventAllowed(h, ev); h = [...h, ev]; }
  return store.append(orderId, events);
}

export async function confirmPayment(store, orderId, { channel, vouchers = [], now = new Date() }) {
  const history = store.getOrder(orderId);
  if (history.length === 0) throw new StoreError('ORDER_NOT_FOUND', orderId);
  if (history.some(e => e.type === 'ORDER_CONFIRMED'))
    throw new StoreError('ALREADY_CONFIRMED', orderId + ' 已确认，勿重复支付');
  const q = history.find(e => e.type === 'QUOTE_CREATED');
  if (!q) throw new StoreError('ORDER_NOT_FOUND', '缺少 QUOTE_CREATED');

  // 锁价窗口（§5.2）：过期 → 订单作废 + 额度释放（§6.2 VOUCHER_RELEASED）
  if (now.toISOString() > q.data.expires_at) {
    const evs = [{ type: 'QUOTE_EXPIRED', data: { expired_at: now.toISOString() } }];
    for (const r of history.filter(e => e.type === 'VOUCHER_RESERVED'))
      evs.push({ type: 'VOUCHER_RELEASED', data: { voucher_id: r.data.voucher_id, released_cents: r.data.reserved_cents } });
    appendGuarded(store, orderId, history, evs);
    throw new StoreError('QUOTE_EXPIRED', '报价已过锁价窗口（§5.2），订单作废、额度已释放');
  }

  const items = q.data.items.map(it => ({ item_id: it.item_id, locked_price_cents: it.locked_price_cents }));
  const { funding } = allocateFunding(items, vouchers);
  const totalCash = funding.reduce((a, f) => a + f.cash_cents, 0);
  const operation_id = genOperationId('payment', orderId);
  // 合成义务号：复用"每义务至多一次 EXECUTED"的唯一索引 → 每订单至多一次成功收款（§5.1）
  store.recordOperation({ operation_id, order_id: orderId, obligation_id: 'obl_pay:' + orderId, type: 'payment' });

  appendGuarded(store, orderId, history,
    [{ type: 'PAYMENT_INITIATED', amount_cents: totalCash, data: { operation_id } }]);

  let res = await channel.charge({ operation_id, amount_cents: totalCash });
  if (res.state === 'UNKNOWN') {
    store.markOperation(operation_id, 'UNKNOWN');
    res = await channel.resolve(operation_id);
  }
  if (res.state !== 'SUCCEEDED' && res.state !== 'FAILED')
    throw new StoreError('PAYMENT_UNKNOWN', '渠道状态未决（§5.2，超 30 分钟入 MANUAL_POOL）');

  const h2 = store.getOrder(orderId);
  if (res.state === 'FAILED') {
    store.markOperation(operation_id, 'FAILED');
    appendGuarded(store, orderId, h2,
      [{ type: 'PAYMENT_FAILED', data: { operation_id, reason: 'CHANNEL_DECLINED' } }]);
    throw new StoreError('PAYMENT_DECLINED', '渠道拒绝，可重试（将生成新 operation）');
  }
  store.markOperation(operation_id, 'EXECUTED', res.channel_ref);

  const confirmedItems = q.data.items.map(it => ({
    ...it,
    funding_split: (({ item_id: _fid, ...rest }) => rest)(funding.find(f => f.item_id === it.item_id)),
  }));
  const perVoucher = new Map();
  for (const f of funding)
    for (const a of f.allocations) {
      const cur = perVoucher.get(a.voucher_id) ?? { applied_cents: 0, allocations: [] };
      cur.applied_cents += a.applied_cents;
      cur.allocations.push({ item_id: f.item_id, applied_cents: a.applied_cents });
      perVoucher.set(a.voucher_id, cur);
    }
  appendGuarded(store, orderId, h2, [
    { type: 'PAYMENT_SUCCEEDED', amount_cents: totalCash, data: { operation_id, channel_ref: res.channel_ref } },
    { type: 'ORDER_CONFIRMED', data: { items: confirmedItems, total_cents: q.data.total_cents, cash_paid_cents: totalCash } },
    ...[...perVoucher].map(([voucher_id, info]) => ({ type: 'VOUCHER_REDEEMED', data: { voucher_id, ...info } })),
  ]);
  return { order_id: orderId, operation_id, cash_paid_cents: totalCash, status: projectOrder(store.getOrder(orderId)) };
}
