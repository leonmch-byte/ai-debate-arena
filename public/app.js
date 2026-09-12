// M8 前端。铁律（§4.4）：只渲染后端契约，不做任何金额计算（¥() 仅是格式化）。
const $ = s => document.querySelector(s);
const ¥ = c => c == null ? '—' : '¥' + (c / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const ITEM_ZH = { QUOTED:'报价中', LOCKED:'已锁定', RUNNING:'执行中', COMPLETED:'✓ 已完成', FAILED_FINAL:'✗ 故障·待你决定',
  REFUNDED:'已退款', TIMEOUT_REFUNDED:'超时自动退款', REPLACED:'已更换', VOUCHERED:'已转服务额度', VOIDED:'已作废' };
const ORDER_ZH = { QUOTED:'报价中', AWAITING_PAYMENT:'待支付', FULFILLING:'会诊执行中', DELIVERED:'已交付·结果生成',
  SETTLEMENT_PENDING:'结算异议期（72h）', SETTLEMENT_FINALIZED:'✓ 已最终结算', VOIDED:'已作废', DISPUTED:'争议处理中' };
let poll = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error ?? 'HTTP ' + r.status) + ' ' + (j.message ?? ''));
  return j;
}

async function boot() {
  const { models } = await api('/api/models');
  $('#app').innerHTML = `
    <section class="card">
      <h2>选择会诊模型</h2>
      <div class="models">${Object.entries(models).map(([id, c]) => `
        <label class="model"><input type="checkbox" value="${id}" data-c="${c}">
          <span>${esc(id)}</span><b>${¥(c)}</b></label>`).join('')}
      </div>
      <div class="row"><button id="quote-btn" class="primary">生成报价</button>
      <span id="quote-err" class="err"></span></div>
    </section>
    <section id="quote-box"></section>`;
  $('#quote-btn').onclick = createQuote;
  $('#app').addEventListener('change', updateCount);
  updateCount();
}
function selected() {
  return [...document.querySelectorAll('.model input:checked')]
    .map(i => ({ id: i.value, c: Number(i.dataset.c) }));
}
function updateCount() {
  const s = selected();
  $('#quote-btn').textContent = s.length ? `生成报价（${s.length} 模型 · 合计 ${¥(s.reduce((a, x) => a + x.c, 0))}）` : '生成报价';
}
async function createQuote() {
  const ids = selected().map(x => x.id);
  if (!ids.length) { $('#quote-err').textContent = '至少选择一个模型'; return; }
  try {
    const q = await api('/api/quote', { method: 'POST', body: JSON.stringify({ model_ids: ids }) });
    $('#quote-err').textContent = '';
    $('#quote-box').innerHTML = `
      <section class="card">
        <h2>报价单 <small class="dim">${q.order_id}</small></h2>
        <table><tbody>${q.items.map(i => `<tr><td>${esc(i.model_id)}</td><td>${¥(i.locked_price_cents)}</td></tr>`).join('')}
        <tr class="total"><td>合计</td><td>${¥(q.total_cents)}</td></tr></tbody></table>
        <p class="dim">报价锁定 15 分钟。支付为沙箱模拟，不产生真实扣款。</p>
        <button id="pay-btn" class="primary">模拟支付 ${¥(q.total_cents)}</button>
        <span id="pay-err" class="err"></span>
      </section>`;
    $('#quote-box').scrollIntoView({ behavior: 'smooth' });
    $('#pay-btn').onclick = () => payAndRun(q.order_id);
  } catch (e) { $('#quote-err').textContent = e.message; }
}
async function payAndRun(orderId) {
  try {
    await api(`/api/orders/${orderId}/pay`, { method: 'POST' });
    $('#pay-err').textContent = '支付成功，开始会诊…';
    await api(`/api/orders/${orderId}/run`, { method: 'POST' });
    startPolling(orderId);
  } catch (e) { $('#pay-err').textContent = e.message; }
}
function startPolling(orderId) {
  if (poll) clearInterval(poll);
  const tick = async () => { try { renderOrder(await api(`/api/orders/${orderId}`)); } catch {} };
  tick();
  poll = setInterval(tick, 1500);
}
function renderOrder(v) {
  if (v.settlement && !v.decision && poll) { clearInterval(poll); poll = null; }
  $('#app').innerHTML = `
    <section class="card">
      <h2>订单 <small class="dim">${v.order_id}</small></h2>
      <p class="status">${ORDER_ZH[v.status] ?? esc(v.status)}</p>
      <table><thead><tr><th>模型</th><th>价格</th><th>状态</th></tr></thead>
      <tbody>${v.items.map(i => `<tr><td>${esc(i.model_id)}</td><td>${¥(i.locked_price_cents)}</td>
        <td class="st-${i.state}">${ITEM_ZH[i.state] ?? esc(i.state)}</td></tr>`).join('')}</tbody></table>
      ${v.settlement ? settlementCard(v.settlement) : ''}
      <button id="back" class="ghost">← 新建会诊</button>
    </section>`;
  $('#back').onclick = () => { if (poll) { clearInterval(poll); poll = null; } boot(); };
  if (v.decision) showModal(v.decision, v.order_id); else hideModal();
}
function settlementCard(s) {
  return `<div class="settle"><h3>结算预演（后端推导，balance 必为 0）</h3><table><tbody>
    <tr><td>订单总额</td><td>${¥(s.order_total_locked_cents)}</td></tr>
    <tr><td>实收现金</td><td>${¥(s.paid_cash_cents)}</td></tr>
    <tr><td>已退款</td><td>${¥(s.refunded_cash_cents)}</td></tr>
    <tr><td>最终应收</td><td>${¥(s.final_due_cents)}</td></tr>
    <tr><td>交付价值</td><td>${¥(s.delivered_value_cents)}</td></tr>
    <tr class="total"><td>balance</td><td>${s.balance_cents}</td></tr>
  </tbody></table><p class="dim">调整明细：${s.adjustments.map(a => `${esc(a.item_id.slice(-6))} ${esc(a.kind)} ${esc(a.note)}`).join('；')}</p></div>`;
}
function showModal(d, orderId) {
  const f = d.failed_item;
  $('#modal-card').innerHTML = `
    <h3>模型故障：${esc(f.model_id)}</h3>
    <p class="dim">${esc(f.reason_code)} · 已付 ${¥(f.locked_price_cents)}</p>
    <div class="opts">
      <button data-c="REFUND" class="primary">${esc(d.options.find(o => o.type === 'REFUND').label)}</button>
      <button data-c="VOUCHER">${esc(d.options.find(o => o.type === 'VOUCHER').label)}</button>
    </div>
    <h4>或更换其他模型继续会诊：</h4>
    <div class="opts reps">${d.options.find(o => o.type === 'REPLACE').candidates.map(c =>
      `<button data-c="REPLACE" data-m="${esc(c.model_id)}">${esc(c.model_id)}<br><small>${esc(c.label)}</small></button>`).join('')}
    </div>
    <p class="dim notice">${esc(d.notice)}</p>`;
  $('#modal').classList.remove('hidden');
  $('#modal-card').querySelectorAll('button').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/orders/${orderId}/items/${f.item_id}/decision`, { method: 'POST',
        body: JSON.stringify({ choice: b.dataset.c, model_id: b.dataset.m }) });
      hideModal(); startPolling(orderId);
    } catch (e) { alert(e.message); }
  });
}
function hideModal() { $('#modal').classList.add('hidden'); }
boot();
