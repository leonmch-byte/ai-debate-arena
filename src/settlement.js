// M3→M6 递增：结算恒等式。本里程碑先落 E1（§7.1）。
import { StoreError } from './store.js';
import { projectItems } from './orders.js';

// E1：Σ执行收款 − Σ执行退款 = Σ {COMPLETED, VOUCHERED} 的 funding_split.cash
export function verifyE1(events) {
  const items = projectItems(events);
  for (const it of items.values())
    if (it.state === 'REPLACED')
      throw new StoreError('E1_UNSUPPORTED', '含 REPLACED 的结算在 M5 结转代数落地后开放');
  let paid = 0, refunded = 0;
  const fundingByItem = new Map();
  for (const e of events) {
    if (e.type === 'PAYMENT_SUCCEEDED') paid += e.amount_cents ?? 0;
    else if (e.type === 'REFUND_EXECUTED') refunded += e.amount_cents ?? 0;
    else if (e.type === 'ORDER_CONFIRMED')
      for (const it of (e.data.items ?? []))
        fundingByItem.set(it.item_id, it.funding_split ?? { cash_cents: 0 });
  }
  let expected = 0;
  for (const it of items.values())
    if (it.state === 'COMPLETED' || it.state === 'VOUCHERED')
      expected += fundingByItem.get(it.item_id)?.cash_cents ?? 0;
  return {
    paid_cash_cents: paid,
    refunded_cash_cents: refunded,
    expected_cash_cents: expected,
    diff: paid - refunded - expected,
  };
}
