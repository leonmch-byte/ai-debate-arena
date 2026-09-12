// M2：服务项状态机（§3.1）、订单状态投影（§3.2）、事件准入守卫（§3.3）
// 原则：状态永远是事件流的推导值。本模块只读事件、推导状态、拒绝违规，不存在"写状态"。
// M2-fix：REPLACED 推导改为逐事件刷新，守卫判定候选事件时可见最新推导态。
import { StoreError } from './store.js';

export const ITEM_TERMINAL = new Set([
  'COMPLETED', 'REFUNDED', 'REPLACED', 'VOUCHERED', 'TIMEOUT_REFUNDED', 'VOIDED',
]);

const newItem = (id, origin = 'ORIGINAL', replacementOf = null) => ({
  item_id: id,
  state: 'QUOTED',
  origin,                        // ORIGINAL | REPLACEMENT
  replacement_of: replacementOf,
  attempts: 0,
  pending_decision: null,
  resolved_choice: null,
  decision_timed_out: false,
  surcharge_executed: false,
  fail_reason: null,
});

export function projectItems(events) {
  const items = new Map();
  const known = new Set();       // 已被报价/订单/决策引入的 item
  const decisions = new Map();   // item_id → { requested, received }
  const ensure = (id, origin, replOf) => {
    if (!items.has(id)) items.set(id, newItem(id, origin, replOf));
    return items.get(id);
  };
  const mustKnown = (id, e) => {
    if (!known.has(id))
      throw new StoreError('UNKNOWN_ITEM', `${e.type}: item ${id} 未被 QUOTE/ORDER/决策引入`);
    return ensure(id);
  };
  const requireState = (it, allowed, e) => {
    if (ITEM_TERMINAL.has(it.state))
      throw new StoreError('ILLEGAL_FROM_TERMINAL', `${e.type}: ${it.item_id} 已终态 ${it.state}（§3.3-1）`);
    if (!allowed.includes(it.state))
      throw new StoreError('ILLEGAL_TRANSITION', `${e.type}: ${it.item_id} 处于 ${it.state}（§3.1）`);
  };
  const decOf = (id) => decisions.get(id) ?? {};

  // 派生规则（T9）：前驱 REPLACED ⟺ 存在已锁定以上的后继（§3.3-3 结构上不可能发生）。
  // 每个事件处理前刷新推导态，保证守卫看到的是最新状态。
  const promoteReplaced = () => {
    for (const it of items.values()) {
      if (it.state !== 'FAILED_FINAL') continue;
      const succ = [...items.values()].find(s => s.origin === 'REPLACEMENT' && s.replacement_of === it.item_id);
      if (succ && succ.state !== 'QUOTED' && succ.state !== 'VOIDED') it.state = 'REPLACED';
    }
  };

  for (const e of events) {
    promoteReplaced();
    const p = e.data ?? {};
    switch (e.type) {
      case 'QUOTE_CREATED':
      case 'ORDER_CONFIRMED':
        for (const it of (p.items ?? [])) { known.add(it.item_id); ensure(it.item_id); }
        break;

      case 'DECISION_REQUESTED': {
        const it = mustKnown(e.item_id, e);
        const d = decOf(e.item_id);
        if (d.requested) throw new StoreError('DECISION_ALREADY_OPEN', `${it.item_id} 已有决策流程`);
        d.requested = p.decision_id ?? true;
        decisions.set(e.item_id, d);
        it.pending_decision = p.decision_id ?? true;
        break;
      }
      case 'DECISION_RECEIVED': {
        const it = mustKnown(e.item_id, e);
        if (ITEM_TERMINAL.has(it.state))
          throw new StoreError('ILLEGAL_FROM_TERMINAL', `决策关闭后不可再接收（${it.item_id}=${it.state}）`);
        const d = decOf(e.item_id);
        if (!d.requested) throw new StoreError('DECISION_WITHOUT_REQUEST', `${it.item_id} 无未决决策`);
        if (it.decision_timed_out) throw new StoreError('DECISION_AFTER_TIMEOUT', '24h 窗口已关闭（§4.3）');
        if (!['REFUND', 'VOUCHER', 'REPLACE'].includes(p.choice))
          throw new StoreError('INVALID_CHOICE', `非法决策选项 ${p.choice}`);
        d.received = { choice: p.choice, successor_item_id: p.successor_item_id ?? null, delta_cents: p.delta_cents ?? 0 };
        decisions.set(e.item_id, d);
        it.pending_decision = null;
        it.resolved_choice = p.choice;
        if (p.choice === 'REPLACE') {
          if (!p.successor_item_id) throw new StoreError('REPLACE_WITHOUT_SUCCESSOR', '换模型决策必须指定后继 item（T9）');
          known.add(p.successor_item_id);
          ensure(p.successor_item_id, 'REPLACEMENT', e.item_id);
        }
        break;
      }
      case 'ITEM_LOCKED': {
        const it = mustKnown(e.item_id, e);
        if (it.origin === 'REPLACEMENT') {
          // 后继锁定：必须存在 REPLACE 决策；delta>0 时必须先收到补差（T11/§5.3）
          const d = decOf(it.replacement_of);
          if (d.received?.choice !== 'REPLACE')
            throw new StoreError('REPLACE_WITHOUT_DECISION', `后继 ${it.item_id} 锁定前必须有 REPLACE 决策（§3.3-5）`);
          if ((d.received.delta_cents ?? 0) > 0 && !it.surcharge_executed)
            throw new StoreError('SURCHARGE_REQUIRED', 'delta>0 的后继必须先收到补差（T11）');
          it.state = 'LOCKED';
        } else {
          requireState(it, ['QUOTED'], e);   // T1
          it.state = 'LOCKED';
        }
        break;
      }
      case 'ITEM_STARTED': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['LOCKED'], e);     // T3
        it.state = 'RUNNING';
        break;
      }
      case 'RECOVERY_ATTEMPTED': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['RUNNING'], e);    // T4：恢复环
        it.attempts += 1;
        break;
      }
      case 'RECOVERY_EXHAUSTED': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['RUNNING'], e);
        break;
      }
      case 'ITEM_COMPLETED': {
        const it = mustKnown(e.item_id, e);
        if (it.state === 'FAILED_FINAL')
          throw new StoreError('FAILED_FINAL_NOT_COMPLETABLE', `${it.item_id} 失败项永不可交付（§3.3-2）`);
        requireState(it, ['RUNNING'], e);    // T5
        it.state = 'COMPLETED';
        break;
      }
      case 'ITEM_FAILED_FINAL': {
        const it = mustKnown(e.item_id, e);
        requireState(it, ['RUNNING'], e);    // T6
        it.state = 'FAILED_FINAL';
        it.fail_reason = e.reason_code ?? null;
        break;
      }
      case 'SURCHARGE_EXECUTED': {
        const succ = mustKnown(p.successor_item_id, e);
        const d = decOf(succ.replacement_of);
        if (succ.origin !== 'REPLACEMENT' || d.received?.choice !== 'REPLACE')
          throw new StoreError('REPLACE_WITHOUT_DECISION', '补差执行必须有对应 REPLACE 决策（§3.3-5）');
        if ((d.received.delta_cents ?? 0) <= 0)
          throw new StoreError('SURCHARGE_NOT_DUE', 'delta≤0 不产生补差（§5.3）');
        requireState(succ, ['QUOTED'], e);
        succ.surcharge_executed = true;
        succ.state = 'LOCKED';               // T11
        break;
      }
      case 'SURCHARGE_EXPIRED': {
        const succ = mustKnown(e.item_id, e);
        if (succ.origin !== 'REPLACEMENT') throw new StoreError('ILLEGAL_TRANSITION', '补差超时只适用于后继项（T12）');
        requireState(succ, ['QUOTED'], e);
        succ.state = 'VOIDED';               // T12
        break;
      }
      case 'REFUND_EXECUTED': {
        const it = mustKnown(e.item_id, e);
        if (it.state !== 'FAILED_FINAL')
          throw new StoreError('REFUND_ON_NON_FAILED', `退款只作用于 FAILED_FINAL（§3.3-4），当前 ${it.state}`);
        const d = decOf(e.item_id);
        if (e.decision_source === 'TIMEOUT_RULE') {
          const succ = [...items.values()].find(s => s.origin === 'REPLACEMENT' && s.replacement_of === it.item_id);
          const viaSurchargeTimeout = d.received?.choice === 'REPLACE' && succ?.state === 'VOIDED';
          if (!it.decision_timed_out && !viaSurchargeTimeout)
            throw new StoreError('TIMEOUT_PATH_INVALID', '超时退款必须有 DECISION_TIMEOUT 或补差窗口过期（T10/T12）');
          it.state = 'TIMEOUT_REFUNDED';     // T10 / T12→T10
        } else {
          if (d.received?.choice !== 'REFUND')
            throw new StoreError('REFUND_WITHOUT_DECISION', '用户退款必须有 REFUND 决策');
          it.state = 'REFUNDED';             // T7
        }
        break;
      }
      case 'VOUCHER_ISSUED': {
        const src = p.source ?? 'FAULT_COMPENSATION';
        if (e.item_id == null || src === 'GOODWILL') break;   // 订单级/善意券不动 item 状态
        const it = mustKnown(e.item_id, e);
        if (src === 'REFUND_RESTORE') {
          if (!['REFUNDED', 'TIMEOUT_REFUNDED'].includes(it.state))
            throw new StoreError('RESTORE_ON_NON_REFUNDED', '券部分原路补偿只作用于已退款项（§2.4）');
          break;                             // 状态不变
        }
        if (it.state !== 'FAILED_FINAL')
          throw new StoreError('ILLEGAL_FROM_TERMINAL', `FAULT_COMPENSATION 发券要求 FAILED_FINAL，当前 ${it.state}`);
        const d = decOf(e.item_id);
        if (d.received?.choice !== 'VOUCHER')
          throw new StoreError('VOUCHER_WITHOUT_DECISION', '领券必须有 VOUCHER 决策');
        it.state = 'VOUCHERED';              // T8
        break;
      }
      case 'DECISION_TIMEOUT': {
        const it = mustKnown(e.item_id, e);
        if (!it.pending_decision) throw new StoreError('TIMEOUT_WITHOUT_PENDING', '无未决决策可超时（§4.3）');
        it.pending_decision = null;
        it.decision_timed_out = true;
        break;
      }
      default:
        break; // 其余为订单级事件，由 projectOrder 处理
    }
  }
  promoteReplaced();
  return items;
}

export function projectOrder(events) {
  const items = projectItems(events);       // 违规事件在这里就会抛出
  let quoteExpired = false, confirmed = false, paid = false;
  let previewed = false, finalized = false, objectionOpen = false;
  for (const e of events) {
    switch (e.type) {
      case 'QUOTE_EXPIRED': quoteExpired = true; break;
      case 'ORDER_CONFIRMED': confirmed = true; break;
      case 'PAYMENT_SUCCEEDED': paid = true; break;
      case 'SETTLEMENT_PREVIEWED': previewed = true; break;
      case 'SETTLEMENT_FINALIZED': finalized = true; break;
      case 'OBJECTION_RAISED': objectionOpen = true; break;
      case 'OBJECTION_RESOLVED': objectionOpen = false; break;
      default: break;
    }
  }
  if (!confirmed) return quoteExpired ? 'VOIDED' : 'QUOTED';
  if (!paid) return quoteExpired ? 'VOIDED' : 'AWAITING_PAYMENT';

  const states = [...items.values()].map(i => i.state);
  const allTerminal = states.length > 0 && states.every(s => ITEM_TERMINAL.has(s));
  const anyCompleted = states.includes('COMPLETED');
  const openDecision = [...items.values()].some(i => i.pending_decision);

  if (finalized) {
    if (!allTerminal || openDecision)
      throw new StoreError('FINALIZED_WITH_OPEN_ITEMS',
        '存在未终态 item 或未决决策时禁止 FINALIZED（§3.3-6 结构部分；金额校验 I3 归 M6）');
    return 'SETTLEMENT_FINALIZED';
  }
  if (objectionOpen) return 'DISPUTED';
  if (allTerminal && !openDecision) {
    if (anyCompleted) return previewed ? 'SETTLEMENT_PENDING' : 'DELIVERED';
    if (previewed) return 'SETTLEMENT_PENDING';   // 无交付物结算（§3.2 边则）
  }
  return 'FULFILLING';
}

// 准入守卫：任何引擎在 append 前调用。投影逻辑即守卫逻辑，一套代码两个用途。
export function assertEventAllowed(history, candidate) {
  const next = [...history, candidate];
  projectItems(next);
  projectOrder(next);
  return true;
}
