// M3：沙箱收款通道（§5.2）。M7 切真实渠道时替换本类，引擎不动。
// 剧本可选 'SUCCEEDED'（默认）/'FAILED'/'UNKNOWN'；同 operation_id 重放返回同结果（I2 通道层）。
export class SandboxChannel {
  constructor(script = [], opts = {}) {
    this.script = [...script];
    this.sticky = !!opts.stickyUnknown;      // 模拟真实渠道 UNKNOWN 长期不收敛（§8.2）
    this.confirmed = new Set();
    this.pending = new Map();
    this.resolved = new Map();
    this.calls = [];
  }
  #ref(operation_id) { return 'sbx_' + operation_id.slice(-8); }
  async charge({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }
  async refund({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }

  async refund({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }

  async refund({ operation_id, amount_cents }) {
    if (this.resolved.has(operation_id)) return this.resolved.get(operation_id);
    this.calls.push({ operation_id, amount_cents });
    const outcome = this.script.length ? this.script.shift() : 'SUCCEEDED';
    if (outcome === 'UNKNOWN') { this.pending.set(operation_id, { amount_cents }); return { state: 'UNKNOWN' }; }
    if (outcome === 'FAILED') {
      const r = { state: 'FAILED', channel_ref: null };
      this.resolved.set(operation_id, r); return r;
    }
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r); return r;
  }

  confirmUnknown(operation_id) { this.confirmed.add(operation_id); }
  // 主动查询通道（§5.2 双通道）：沙箱里 UNKNOWN 一查即定案
  async resolve(operation_id) {
    if (!this.pending.has(operation_id))
      return this.resolved.get(operation_id) ?? { state: 'UNKNOWN' };
    if (this.sticky && !this.confirmed.has(operation_id)) return { state: 'UNKNOWN' };
    const r = { state: 'SUCCEEDED', channel_ref: this.#ref(operation_id) };
    this.resolved.set(operation_id, r);
    this.pending.delete(operation_id);
    return r;
  }
}
