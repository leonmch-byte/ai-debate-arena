// 结算恒等式（§7.1）。E1：Σ收款(支付+补差) − Σ退款(含退差) = Σ{COMPLETED,VOUCHERED} 的 cash。
// REPLACED 前驱现金经 §2.5 结转进后继 funding，自身贡献 0。
import { projectItems } from './orders.js';

export function E1(events) {
  const items = projectItems(events);
  let paid = 0, refunded = 0;
  const fundingByItem = new Map();
  for (const e of events) {
    switch (e.type) {
      case 'PAYMENT_SUCCEEDED':
        paid += e.amount_cents ?? 0;
        break;
      case 'SURCHARGE_EXECUTED':                    // 补差既是收入，又登记后继资金
        paid += e.amount_cents ?? 0;
        if (e.data?.funding_split)
          fundingByItem.set(e.data.successor_item_id, e.data.funding_split);
        break;
      case 'REFUND_EXECUTED':
        refunded += e.amount_cents ?? 0;
        break;
      case 'ORDER_CONFIRMED':
        for (const it of (e.data.items ?? []))
          if (it.funding_split) fundingByItem.set(it.item_id, it.funding_split);
        break;
      case 'ITEM_LOCKED':
        if (e.data?.funding_split)
          fundingByItem.set(e.item_id, e.data.funding_split);
        break;
      default:
        break;
    }
  }
  let expected = 0;
  for (const it of items.values())
    if (it.state === 'COMPLETED' || it.state === 'VOUCHERED')
      expected += fundingByItem.get(it.item_id)?.cash_cents ?? 0;
  return {
    paid_cash_cents: paid, refunded_cash_cents: refunded,
    expected_cash_cents: expected, diff: paid - refunded - expected,
  };
}

// M3 兼容别名
export const verifyE1 = E1;
