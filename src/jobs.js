// 定时任务族起步：券过期（§6.6）。过期 = 剩余额度作废，事件留痕；幂等：已作废的跳过。
import { projectVouchers } from './vouchers.js';

export function expireVouchers(store, now = new Date()) {
  const vmap = projectVouchers(store.getAllEvents());
  const out = [];
  for (const v of vmap.values()) {
    if (v.remaining_cents <= 0) continue;
    if (!v.expires_at || new Date(v.expires_at) > now) continue;
    store.append('ord_system', [{
      type: 'VOUCHER_EXPIRED',
      data: { voucher_id: v.voucher_id, expired_cents: v.remaining_cents, expired_at: now.toISOString() },
    }]);
    out.push({ voucher_id: v.voucher_id, expired_cents: v.remaining_cents });
  }
  return out;
}
