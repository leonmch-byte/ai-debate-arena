// UI v2：说明引导 + 结果内容展示 + 历史订单 + 移动端。铁律不变：只渲染后端契约，不做金额计算。
const $ = s => document.querySelector(s);
const yuan = c => c == null ? '—' : '¥' + (c / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[ch]));
const ITEM_ZH = { QUOTED:'待支付', LOCKED:'已确认', RUNNING:'评审中', COMPLETED:'✓ 已完成', FAILED_FINAL:'✗ 故障·待你决定',
  REFUNDED:'已退款', TIMEOUT_REFUNDED:'超时自动退款', REPLACED:'已更换', VOUCHERED:'已转服务额度', VOIDED:'已作废' };
const ORDER_ZH = { QUOTED:'报价中', AWAITING_PAYMENT:'待支付', FULFILLING:'评审进行中', DELIVERED:'已交付',
  SETTLEMENT_PENDING:'结算确认期（72h）', SETTLEMENT_FINALIZED:'✓ 已完结', VOIDED:'已作废', DISPUTED:'争议处理中' };
let poll = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error ?? 'HTTP ' + r.status) + ' ' + (j.message ?? ''));
  return j;
}
async function fetchResult(ref) {
  if (!ref || ref.startsWith('sim:')) return null;
  try { const r = await fetch('/results/' + ref); return r.ok ? r.text() : null; } catch { return null; }
}

function home(models) {
  $('#app').innerHTML = `
  <section class="hero">
    <h1>一次提问，获得多个 AI 的独立意见</h1>
    <p>选择几个 AI 模型，它们将<b>互不知情、各自独立</b>地对你的问题出具专业意见。
    互不干扰，才有真正的交叉参照。</p>
    <ul class="pts">
      <li><b>独立出具</b>——每个模型单独作答，不互相污染</li>
      <li><b>明码标价</b>——按模型计费，故障自动退款或换模型，差额多退少补</li>
      <li><b>账目透明</b>——订单页可查每一分钱的去向，balance 恒为 0</li>
    </ul>
  </section>
  <section class="card">
    <h2>① 选择参与评审的 AI（至少 2 个，建议 3 个以上）</h2>
    <div class="models">${Object.entries(models).map(([id, c]) => `
      <label class="model"><input type="checkbox" value="${id}" data-c="${c}">
        <span>${esc(id)}</span><b>${yuan(c)}/次</b></label>`).join('')}
    </div>
    <div class="row"><button id="quote-btn" class="primary big">② 生成报价</button>
    <span id="quote-err" class="err"></span></div>
  </section>
  <section id="quote-box"></section>`;
  $('#quote-btn').onclick = () => createQuote(models);
  $('#app').addEventListener('change', () => updateCount());
  updateCount();
}
function selected() {
  return [...document.querySelectorAll('.model input:checked')].map(i => ({ id: i.value, c: Number(i.dataset.c) }));
}
function updateCount() {
  const b = $('#quote-btn'); if (!b) return;
  const s = selected();
  b.textContent = s.length ? `② 生成报价（${s.length} 个 AI · 合计 ${yuan(s.reduce((a, x) => a + x.c, 0))}）` : '② 生成报价';
}
async function createQuote(models) {
  const ids = selected().map(x => x.id);
  if (ids.length < 1) { $('#quote-err').textContent = '至少选择一个 AI'; return; }
  try {
    const q = await api('/api/quote', { method: 'POST', body: JSON.stringify({ model_ids: ids }) });
    $('#quote-err').textContent = '';
    $('#quote-box').innerHTML = `
      <section class="card">
        <h2>③ 确认并支付 <small class="dim">报价锁定 15 分钟</small></h2>
        <table><tbody>${q.items.map(i => `<tr><td>${esc(i.model_id)}</td><td>${yuan(i.locked_price_cents)}</td></tr>`).join('')}
        <tr class="total"><td>合计</td><td>${yuan(q.total_cents)}</td></tr></tbody></table>
        <p class="dim">支付后各 AI 立即开始独立评审。任一模型故障，你可选退款 / 转服务额度 / 换其他模型，全程自动。</p>
        <div class="row"><button id="pay-btn" class="primary big">确认支付 ${yuan(q.total_cents)}</button>
        <span id="pay-err" class="err"></span></div>
      </section>`;
    $('#quote-box').scrollIntoView({ behavior: 'smooth' });
    $('#pay-btn').onclick = () => payAndRun(q.order_id);
  } catch (e) { $('#quote-err').textContent = e.message; }
}
async function payAndRun(orderId) {
  try {
    await api(`/api/orders/${orderId}/pay`, { method: 'POST' });
    $('#pay-err').textContent = '支付成功，评审开始…';
    await api(`/api/orders/${orderId}/run`, { method: 'POST' });
    startPolling(orderId);
  } catch (e) { $('#pay-err').textContent = e.message; }
}
function startPolling(orderId) {
  if (poll) clearInterval(poll);
  location.hash = '#/order/' + orderId;
  const tick = async () => { try { renderOrder(await api(`/api/orders/${orderId}`), orderId); } catch {} };
  tick(); poll = setInterval(tick, 1500);
}
async function renderOrder(v, orderId) {
  if (v.settlement && !v.decision && poll) { clearInterval(poll); poll = null; }
  const withResults = await Promise.all(v.items.map(async it => ({ ...it, text: await fetchResult(it.result_ref) })));
  $('#app').innerHTML = `
    <section class="card">
      <p class="status">${ORDER_ZH[v.status] ?? esc(v.status)} <small class="dim">${v.order_id}</small></p>
      ${withResults.map(it => `
        <div class="opinion ${it.state === 'COMPLETED' ? '' : 'dim-op'}">
          <div class="op-head"><b>${esc(it.model_id)}</b>
            <span class="st-${it.state}">${ITEM_ZH[it.state] ?? esc(it.state)}</span>
            <span class="dim">${yuan(it.locked_price_cents)}</span></div>
          ${it.text ? `<pre class="op-body">${esc(it.text)}</pre>`
                    : it.state === 'RUNNING' ? `<p class="dim typing">正在撰写意见…</p>` : ''}
        </div>`).join('')}
      ${v.settlement ? settle(v.settlement) : ''}
      <div class="row">
        <button id="back" class="ghost">← 新建评审</button>
        <button id="replay" class="ghost">查看本单</button>
      </div>
    </section>`;
  $('#back').onclick = () => { if (poll) { clearInterval(poll); poll = null; } location.hash = ''; boot(); };
  if (v.decision) showModal(v.decision, orderId); else hideModal();
}
function settle(s) {
  return `<div class="settle"><h3>账单（每一分钱可追溯，balance 恒为 0）</h3><table><tbody>
    <tr><td>订单总额</td><td>${yuan(s.order_total_locked_cents)}</td></tr>
    ${s.refunded_cash_cents ? `<tr><td>已退款</td><td>${yuan(s.refunded_cash_cents)}</td></tr>` : ''}
    <tr><td>最终应收</td><td>${yuan(s.final_due_cents)}</td></tr>
    <tr class="total"><td>balance</td><td>${s.balance_cents}</td></tr>
  </tbody></table></div>`;
}
function showModal(d, orderId) {
  const f = d.failed_item;
  $('#modal-card').innerHTML = `
    <h3>「${esc(f.model_id)}」出现故障</h3>
    <p class="dim">故障代码 ${esc(f.reason_code)}。它已支付的费用为 ${yuan(f.locked_price_cents)}，请选择如何处理（其余 AI 的评审不受影响）：</p>
    <div class="opts">
      <button data-c="REFUND" class="primary">${esc(d.options.find(o => o.type === 'REFUND').label)}</button>
      <button data-c="VOUCHER">${esc(d.options.find(o => o.type === 'VOUCHER').label)}</button>
    </div>
    <h4>或更换为其他 AI 继续评审：</h4>
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

// 路由：#/ 无参=首页；#/order/<id>=订单页
async function boot() {
  const h = location.hash;
  const om = h.match(/^#\/order\/(ord_\w+)$/);
  if (om) { startPolling(om[1]); return; }
  if (poll) { clearInterval(poll); poll = null; }
  const { models } = await api('/api/models');
  home(models);
}
window.addEventListener('hashchange', boot);
boot();
