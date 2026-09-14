const $ = s => document.querySelector(s);
const yuan = c => c == null ? '—' : '¥' + (c / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[ch]));
const ITEM_ZH = { QUOTED:'待支付', LOCKED:'已确认', RUNNING:'思考中', COMPLETED:'✓ 已交方案', FAILED_FINAL:'✗ 故障·待你决定',
  REFUNDED:'已退款', TIMEOUT_REFUNDED:'超时自动退款', REPLACED:'已更换', VOUCHERED:'已转额度', VOIDED:'已作废' };
const ORDER_ZH = { QUOTED:'报价中', AWAITING_PAYMENT:'待支付', FULFILLING:'头脑风暴进行中', DELIVERED:'已交付',
  SETTLEMENT_PENDING:'结算确认期（72h）', SETTLEMENT_FINALIZED:'✓ 已完结', VOIDED:'已作废', DISPUTED:'争议处理中' };
let poll = null, ME = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error ?? 'HTTP ' + r.status) + ' ' + (j.message ?? ''));
  return j;
}
async function fetchResult(ref) {
  if (!ref) return null;
  try { const r = await fetch('/results/' + encodeURIComponent(ref)); return r.ok ? r.text() : null; } catch { return null; }
}

/* ---------- 认证 ---------- */
function renderAuthBox(user) {
  ME = user;
  $('#nav-orders').classList.toggle('hidden', !user);
  const box = $('#auth-box');
  box.innerHTML = user
    ? `<span class="dim">${esc(user.email)}</span><a id="logout-link">退出</a>`
    : `<a id="login-link">登录 / 注册</a>`;
  if (user) $('#logout-link').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }); location.hash = ''; boot();
  };
  else $('#login-link').onclick = () => authModal();
}
function authModal(note = '', after = null) {
  $('#modal-card').innerHTML = `
    <h3>登录 / 注册</h3>
    ${note ? `<p class="dim">${esc(note)}</p>` : '<p class="dim">已有账号直接登录；没有则填好信息点「注册新账号」。</p>'}
    <div class="frow"><label>邮箱</label><input id="au-email" type="email" placeholder="you@example.com"></div>
    <div class="frow"><label>密码</label><input id="au-pass" type="password" placeholder="至少 8 位"></div>
    <p class="err" id="au-err"></p>
    <div class="row"><button class="primary" id="au-login">登录</button>
    <button id="au-reg">注册新账号</button></div>`;
  $('#modal').classList.remove('hidden');
  const go = async path => {
    try {
      await api(path, { method: 'POST',
        body: { email: $('#au-email').value.trim(), password: $('#au-pass').value } });
      hideModal();
      const me = await api('/api/auth/me');
      renderAuthBox(me.user);
      if (after) after();
    } catch (e) { $('#au-err').textContent = e.message; }
  };
  $('#au-login').onclick = () => go('/api/auth/login');
  $('#au-reg').onclick = () => go('/api/auth/register');
}

/* ---------- 首页 ---------- */
function home(models) {
  $('#app').innerHTML = `
  <section class="hero">
    <h1>把你的难题，扔给一桌 AI</h1>
    <p>你出题，多个 AI <b>各自独立</b>给出方案——然后放大它们<b>碰撞出的火花</b>：
    谁和谁针锋相对、谁的方案被别人挑出漏洞、哪些点全员一致。<br>
    <span class="dim">一个人问 AI 得到一个答案；一桌 AI 互相碰撞，才照出你的盲区。</span></p>
    <div class="who"><span>适合</span><b>任何需要被挑战的决策</b>——立项评估 · 方案评审 · 政策分析 · 技术选型 · 投资判断</div>
    <ul class="pts">
      <li><b>独立出方案</b>：互不知情，避免互相污染，才有真分歧</li>
      <li><b>碰撞报告</b>：分歧点 / 被挑出的漏洞 / 意外共识</li>
      <li><b>故障即赔付</b>：退款 / 转额度 / 换 AI，多退少补，全自动</li>
    </ul>
  </section>
  <section class="topic-hero">
    <label>① 你的议题（越具体，碰撞越有料）</label>
    <textarea id="topic" rows="3" placeholder="例：我想在二线城市开一家社区自习室，初期预算 15 万。帮我评估该不该做、最大的坑在哪。"></textarea>
  </section>
  <section class="card">
    <h2>② 请 AI 上桌（至少 2 位，越多碰撞越烈）</h2>
    <div class="mpanel">
      <button type="button" id="mpanel-toggle" class="mp-toggle">
        <span id="mpanel-label">请选择 AI 顾问</span><span class="caret">▾</span>
      </button>
      <div class="models hidden" id="models-grid">
        ${Object.entries(models).map(([id]) => `
          <label class="model"><input type="checkbox" value="${id}">
            <span>${esc(id)}</span></label>`).join('')}
        <div class="model byok-card" id="byok-card"><span>🔑 自带密钥模式</span></div>
      </div>
    </div>
    <div class="row"><button id="quote-btn" class="primary big">③ 生成报价</button>
    <span id="quote-err" class="err"></span></div>
  </section>
  <section id="quote-box"></section>`;
  $('#quote-btn').onclick = () => createQuote();
  $('#app').addEventListener('input', updateCount);
  $('#app').addEventListener('change', e => { if (e.target.closest('.models')) updateCount(); });
  $('#mpanel-toggle').onclick = () => {
    $('#models-grid').classList.toggle('hidden');
    $('#mpanel-toggle').classList.toggle('open');
  };
  $('#byok-card').onclick = byokModal;
  $('#topic').focus();
  updateCount();
}
function byokModal() {
  $('#modal-card').innerHTML = `
    <h3>🔑 自带密钥模式（即将开放）</h3>
    <p class="dim">用自己的 AI 平台 API Key 召唤模型，模型费用直接走你自己的账号，平台只收少量撮合服务费。</p>
    <p class="dim">内测后开放，支持：阿里百炼 / 火山方舟 / DeepSeek / 任何 OpenAI 兼容接口。你的 Key 只在本机内存中使用，不落盘、不入库。</p>
    <div class="row"><button onclick="hideModal()">知道了</button></div>`;
  $('#modal').classList.remove('hidden');
}
function selected() {
  return [...document.querySelectorAll('.models input:checked')].map(i => i.value);
}
function updateCount() {
  const b = $('#quote-btn'), l = $('#mpanel-label'); if (!b) return;
  const s = selected();
  if (l) l.textContent = s.length ? `已请 ${s.length} 位 AI 上桌（点击调整）` : '请选择 AI 顾问';
  b.textContent = s.length ? `③ 生成报价（${s.length} 位 AI）` : '③ 生成报价';
}
async function createQuote() {
  const ids = selected();
  const topic = ($('#topic')?.value ?? '').trim();
  if (topic.length < 5) { $('#quote-err').textContent = '先写下你的议题（至少 5 个字）——AI 们要围绕它碰撞'; return; }
  if (!ids.length) { $('#quote-err').textContent = '至少请一位 AI 上桌'; return; }
  try {
    const q = await api('/api/quote', { method: 'POST', body: JSON.stringify({ model_ids: ids, topic }) });
    sessionStorage.setItem('topic_' + q.order_id, topic);
    $('#quote-err').textContent = '';
    $('#quote-box').innerHTML = `
      <section class="card">
        <div class="topic-show"><span class="lbl">本次议题</span>${esc(topic)}</div>
        <h2>④ 确认并支付 <small class="dim">报价锁定 15 分钟</small></h2>
        <table><tbody>${q.items.map(i => `<tr><td>${esc(i.model_id)}</td><td>${yuan(i.locked_price_cents)}</td></tr>`).join('')}
        <tr class="total"><td>合计</td><td>${yuan(q.total_cents)}</td></tr></tbody></table>
        <p class="dim">支付后 AI 们立即各自独立作业。任一故障，退款 / 转额度 / 换 AI，全程自动结算。</p>
        <div class="row"><button id="pay-btn" class="primary big">确认支付 ${yuan(q.total_cents)}</button>
        <span id="pay-err" class="err"></span></div>
      </section>`;
    $('#quote-box').scrollIntoView({ behavior: 'smooth' });
    $('#pay-btn').onclick = () => payAndRun(q.order_id, topic);
  } catch (e) {
    if (e.message.startsWith('LOGIN_REQUIRED')) authModal('登录后即可发起头脑风暴', () => createQuote());
    else $('#quote-err').textContent = e.message;
  }
}
async function payAndRun(orderId, topic) {
  try {
    await api(`/api/orders/${orderId}/pay`, { method: 'POST', body: JSON.stringify({ topic }) });
    $('#pay-err').textContent = '支付成功，AI 们开始各自作业…';
    startPolling(orderId);
  } catch (e) { $('#pay-err').textContent = e.message; }
}

/* ---------- 订单 ---------- */
function startPolling(orderId) {
  if (poll) clearInterval(poll);
  location.hash = '#/order/' + orderId;
  const tick = async () => { try { renderOrder(await api(`/api/orders/${orderId}`), orderId); } catch {} };
  tick(); poll = setInterval(tick, 1500);
}
async function renderOrder(v, orderId) {
  const done = v.settlement && !v.decision;
  if (done && poll) { clearInterval(poll); poll = null; }
  const topic = sessionStorage.getItem('topic_' + orderId) ?? '';
  const withText = await Promise.all(v.items.map(async it => ({ ...it, text: await fetchResult(it.result_ref) })));
  const c = v.collision;
  $('#app').innerHTML = `
    <section class="card">
      ${topic ? `<div class="topic-show"><span class="lbl">本次议题</span>${esc(topic)}</div>` : ''}
      <p class="status">${ORDER_ZH[v.status] ?? esc(v.status)} <small class="dim">${v.order_id}</small></p>
      ${c ? collisionCard(c) : ''}
      ${withText.map(it => `
        <div class="opinion ${it.state === 'COMPLETED' ? '' : 'dim-op'}">
          <div class="op-head"><b>${esc(it.model_id)}</b>
            <span class="st-${it.state}">${ITEM_ZH[it.state] ?? esc(it.state)}</span>
            <span class="dim">${yuan(it.locked_price_cents)}</span></div>
          ${it.text ? `<pre class="op-body">${esc(it.text)}</pre>`
                    : it.state === 'RUNNING' ? `<p class="dim typing">正在独立思考…</p>` : ''}
        </div>`).join('')}
      ${v.settlement ? settle(v.settlement) : ''}
      <div class="row"><button id="back" class="ghost">← 发起新的风暴</button></div>
    </section>`;
  $('#back').onclick = () => { if (poll) { clearInterval(poll); poll = null; } location.hash = ''; boot(); };
  if (v.decision) showModal(v.decision, orderId); else hideModal();
}
function collisionCard(c) {
  const block = (title, cls, arr, fmt) => arr.length ? `<div class="col-block ${cls}"><h4>${title}</h4>${arr.map(fmt).join('')}</div>` : '';
  return `<div class="collision">
    <h3>⚡ 碰撞报告 <small class="dim">AI 们互相碰撞出的东西</small></h3>
    ${block('针锋相对 — 分歧点', 'dis', c.disagreements, d => `
      <div class="pt"><b>${esc(d.topic)}</b>${d.stances.map(s => `<div class="snip"><i>${esc(s.model)}</i>：${esc(s.snippet)}…</div>`).join('')}</div>`)}
    ${block('被挑出的漏洞', 'hole', c.holes, h => `<div class="pt"><i>${esc(h.raised_by)}</i> 提出：${esc(h.point)}</div>`)}
    ${block('意外共识', 'con', c.consensuses, k => `<div class="pt"><b>${esc(k.topic)}</b> — ${k.stances.length} 位 AI 一致认为值得注意</div>`)}
    ${(!c.disagreements.length && !c.holes.length && !c.consensuses.length) ? '<p class="dim">本轮意见较为一致，未捕捉到显著碰撞。</p>' : ''}
  </div>`;
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
    <h3>「${esc(f.model_id)}」中途掉线</h3>
    <p class="dim">它已支付的费用 ${yuan(f.locked_price_cents)} 如何处理？（其他 AI 的头脑风暴不受影响）</p>
    <div class="opts">
      <button data-c="REFUND" class="primary">${esc(d.options.find(o => o.type === 'REFUND').label)}</button>
      <button data-c="VOUCHER">${esc(d.options.find(o => o.type === 'VOUCHER').label)}</button>
    </div>
    <h4>或换一位 AI 补位：</h4>
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

/* ---------- 我的订单 ---------- */
async function myOrders() {
  let orders;
  try { ({ orders } = await api('/api/my/orders')); }
  catch (e) { if (e.message.startsWith('LOGIN_REQUIRED')) return authModal('登录后查看我的订单'); throw e; }
  $('#app').innerHTML = `
    <section class="card">
      <h2>我的订单</h2>
      ${orders.length ? `<table><thead><tr><th>订单</th><th>时间</th><th>金额</th><th>状态</th></tr></thead><tbody>
        ${orders.map(o => `<tr>
          <td><a class="olink" href="#/order/${o.order_id}">${esc(o.order_id.slice(0, 16))}…</a></td>
          <td class="dim">${new Date(o.created_at).toLocaleString('zh-CN')}</td>
          <td>${yuan(o.total_cents)}</td>
          <td>${ORDER_ZH[o.status] ?? esc(o.status)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="dim">还没有发起过头脑风暴——去发起第一场吧。</p>'}
      <div class="row"><button id="back" class="ghost">← 发起新的风暴</button></div>
    </section>`;
  $('#back').onclick = () => { location.hash = ''; boot(); };
}

/* ---------- 路由 ---------- */
async function boot() {
  try { const me = await api('/api/auth/me'); renderAuthBox(me.user); }
  catch { renderAuthBox(null); }
  const om = location.hash.match(/^#\/order\/(ord_\w+)$/);
  if (om) { startPolling(om[1]); return; }
  if (location.hash === '#/orders') return myOrders();
  if (poll) { clearInterval(poll); poll = null; }
  const { models } = await api('/api/models');
  home(models);
}
window.addEventListener('hashchange', boot);
boot();
