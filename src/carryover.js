// §2.5 换模型结转代数（规范性）。四方向由测试金样本锁定：
// 现金8→10 补2 / 现金8→6 退2 / 券8→10 补2 / 券8→6 退券2
export function computeCarryover({ prior_cash_cents, prior_credit_cents, new_price_cents }) {
  const credit_carried_cents = Math.min(prior_credit_cents, new_price_cents);
  const cash_due_cents = new_price_cents - credit_carried_cents;
  const cash_delta_cents = cash_due_cents - prior_cash_cents;      // >0 补收 / <0 退还 / 0 不动
  const credit_surplus_cents = Math.max(0, prior_credit_cents - new_price_cents); // 发等额新券
  return { credit_carried_cents, cash_due_cents, cash_delta_cents, credit_surplus_cents };
}
