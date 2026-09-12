// §6：券余额从事件流推导。
// I7：face = remaining + redeemed + reserved + expired；核销是预占→已核销的转移（§6.2）。
export function projectVouchers(events) {
  const v = new Map();
  const ensure = id => {
    if (!v.has(id)) v.set(id, {
      voucher_id: id, face_value_cents: 0, redeemed_cents: 0,
      reserved_cents: 0, expired_cents: 0, remaining_cents: 0, sources: [],
    });
    return v.get(id);
  };
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'VOUCHER_ISSUED': {
        const x = ensure(d.voucher_id);
        x.face_value_cents += d.face_value_cents ?? e.amount_cents ?? 0;
        x.remaining_cents += d.face_value_cents ?? e.amount_cents ?? 0;
        x.sources.push(d.source ?? 'UNKNOWN');
        break;
      }
      case 'VOUCHER_RESERVED':   { const x = ensure(d.voucher_id); x.reserved_cents += d.reserved_cents; x.remaining_cents -= d.reserved_cents; break; }
      case 'VOUCHER_RELEASED':   { const x = ensure(d.voucher_id); x.reserved_cents -= d.released_cents; x.remaining_cents += d.released_cents; break; }
      case 'VOUCHER_REDEEMED':   { const x = ensure(d.voucher_id); x.reserved_cents -= d.applied_cents; x.redeemed_cents += d.applied_cents; break; }
      case 'VOUCHER_EXPIRED':    { const x = ensure(d.voucher_id); x.expired_cents += x.remaining_cents; x.remaining_cents = 0; break; }
      default: break;
    }
  }
  return v;
}

export function assertI7(events) {
  for (const x of projectVouchers(events).values()) {
    const lhs = x.face_value_cents;
    const rhs = x.remaining_cents + x.redeemed_cents + x.reserved_cents + x.expired_cents;
    if (lhs !== rhs) throw Object.assign(new Error(`I7 violated: ${x.voucher_id} ${lhs}≠${rhs}`), { code: 'I7_VIOLATED' });
  }
  return true;
}
