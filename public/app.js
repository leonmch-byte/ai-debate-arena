// UI v6（设计版）× 真引擎。铁律：金额只渲染后端契约。
const $ = s => document.querySelector(s);
const yuan = c => c == null ? '—' : '¥' + (c / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[ch]));
const ITEM_ZH = { QUOTED:'待支付', LOCKED:'已确认', RUNNING:'思考中', COMPLETED:'✓ 已交方案', FAILED_FINAL:'✗ 故障·待你决定',
  REFUNDED:'已退款', TIMEOUT_REFUNDED:'超时自动退款', REPLACED:'已更换', VOUCHERED:'已转额度', VOIDED:'已作废' };
const ORDER_ZH = { QUOTED:'报价中', AWAITING_PAYMENT:'待支付', FULFILLING:'头脑风暴进行中', DELIVERED:'已交付',
  SETTLEMENT_PENDING:'结算确认期（72h）', SETTLEMENT_FINALIZED:'✓ 已完结', VOIDED:'已作废', DISPUTED:'争议处理中' };
// 角色→模型映射（角色为用户可见，引擎为后端执行；每次会诊随机分配引擎，呼应"随机分配以求真实"）
const ROLES = [
  { key:'strategist', name:'战略家', desc:'顶层设计 · 方向研判', color:'#7c3aed', model:null },
  { key:'treasurer',  name:'账房先生', desc:'成本测算 · 收益模型', color:'#0891b2', model:null },
  { key:'marketer',   name:'市侩', desc:'竞品洞察 · 用户人心', color:'#db2777', model:null },
  { key:'artisan',    name:'匠人', desc:'方案落地 · 路径规划', color:'#d97706', model:null },
  { key:'critic',     name:'谏臣', desc:'风险指谬 · 直言不讳', color:'#dc2626', model:null },
  { key:'veteran',    name:'老兵', desc:'实操经验 · 增长打法', color:'#059669', model:null },
];
const ENGINE_POOL = ['doubao-pro','kimi-k3','deepseek-v41','minimax-m3']; // 真模型池
let poll = null, ME = null, MODELS = {};

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
function assignEngines(n) {
  // 随机轮询分配引擎池（无放回），不足则循环
  const pool = [...ENGINE_POOL].sort(() => Math.random() - .5);
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

/* ---------- 认证 ---------- */
function renderAuthBox(user) {
  ME = user;
  $('#nav-orders').classList.toggle('hidden', !user);
  const box = $('#auth-box');
  box.innerHTML = user
    ? `<span style="color:var(--muted)">${esc(user.email)}</span> <a style="color:var(--accent);cursor:pointer" id="logout-link">退出</a>`
    : `<a style="color:var(--accent);cursor:pointer;font-weight:600" id="login-link">登录 / 注册</a>`;
  if (user) $('#logout-link').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.hash = ''; boot(); };
  else $('#login-link').onclick = () => authModal();
}
function authModal(note = '', after = null) {
  const beta = window.__BETA_MODE === true;
  $('#modal-card').innerHTML = `
    <h3 class="serif" style="margin:0 0 6px">登录 / 注册</h3>
    ${note ? `<p class="err">${esc(note)}</p>` : `<p style="font-size:13px;color:var(--muted);margin:0 0 6px">${beta ? '内测期需邀请码（每日 10 席，先到先得）' : '开放注册 · 新用户赠 3 次免费体验'}</p>`}
    <div class="frow"><label>邮箱</label><input id="au-email" type="email" placeholder="you@example.com"></div>
    <div class="frow"><label>密码</label><input id="au-pass" type="password" placeholder="至少 8 位"></div>
    ${beta ? `<div class="frow"><label>内测邀请码</label><input id="au-invite" placeholder="ARENA-XXXX-XXXX"></div>` : ''}
    <p class="err" id="au-err"></p>
    <div style="display:flex;gap:10px;margin-top:14px">
      <button class="grad-btn" style="padding:10px 22px;border:none;border-radius:10px;font-family:inherit;font-weight:700" id="au-reg">注册</button>
      <button style="padding:10px 22px;border:1px solid var(--border);border-radius:10px;font-family:inherit;background:#fff" id="au-login">登录</button>
    </div>`;
  $('#modal').classList.remove('hidden');
  const go = async path => {
    try {
      const body = { email: $('#au-email').value.trim(), password: $('#au-pass').value };
      if (beta && $('#au-invite')) body.invite_code = $('#au-invite').value.trim();
      await api(path, { method: 'POST', body });
      hideModal();
      const me = await api('/api/auth/me');
      window.__BETA_MODE = me.beta_mode;
      renderAuthBox(me.user);
      if (after) after();
    } catch (e) { $('#au-err').textContent = e.message; }
  };
  $('#au-login').onclick = () => go('/api/auth/login');
  $('#au-reg').onclick = () => go('/api/auth/register');
}
function feedbackModal(orderId) {
  const TAGS = [['TOO_GENERIC','意见太泛'],['IRRELEVANT','内容跑题'],['TOO_SLOW','等待太久'],['TOO_EXPENSIVE','价格太贵'],['UI_BAD','界面不好用'],['OTHER','其他问题']];
  $('#modal-card').innerHTML = `
    <h3 class="serif" style="margin:0 0 4px">💡 这次哪里不满意？</h3>
    <p style="font-size:13px;color:var(--muted);margin:0 0 10px">点选即可提交（可多选前一项）；选择"其他"可补充说明</p>
    <div id="fb-tags">${TAGS.map(t => `<span class="fb-tag" data-t="${t[0]}">${t[1]}</span>`).join('')}</div>
    <div class="frow hidden" id="fb-note-wrap"><label>补充说明（可选）</label><input id="fb-note" placeholder="一句话描述"></div>
    <p class="err" id="fb-err"></p>
    <div style="display:flex;gap:10px;margin-top:12px">
      <button class="grad-btn" style="padding:9px 20px;border:none;border-radius:10px;font-family:inherit;font-weight:700" id="fb-send">提交反馈</button>
      <button style="padding:9px 20px;border:1px solid var(--border);border-radius:10px;font-family:inherit;background:#fff" onclick="hideModal()">取消</button>
    </div>`;
  $('#modal').classList.remove('hidden');
  let sel = null;
  $('#fb-tags').querySelectorAll('.fb-tag').forEach(el => el.onclick = () => {
    $('#fb-tags').querySelectorAll('.fb-tag').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel'); sel = el.dataset.t;
    $('#fb-note-wrap').classList.toggle('hidden', sel !== 'OTHER');
  });
  $('#fb-send').onclick = async () => {
    if (!sel) { $('#fb-err').textContent = '请先选择一个标签'; return; }
    await api('/api/feedback', { method: 'POST', body: { order_id: orderId, tag: sel, note: $('#fb-note')?.value ?? '' } });
    $('#modal-card').innerHTML = `<h3>已收到 🙏</h3><p style="color:var(--muted);font-size:14px">你的反馈会直接影响产品迭代方向。</p><button class="grad-btn" style="padding:9px 20px;border:none;border-radius:10px;font-family:inherit" onclick="hideModal()">好的</button>`;
  };
}

/* ---------- 首页 ---------- */
function home() {
  const models = MODELS;
  $('#app').innerHTML = `
  <div style="text-align:center;margin-bottom:36px">
    <h2 class="serif" style="font-size:clamp(26px,3.5vw,36px);font-weight:800;margin:0 0 10px;letter-spacing:.1em">兼听则明，<span class="grad-text">众智碰撞</span></h2>
    <p style="font-size:14px;color:var(--muted);margin:0 0 18px">偏听一家之言，难免管中窥豹；广纳众智之见，方能洞若观火。</p>
    <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
      <span style="font-size:13px;color:var(--muted);font-weight:500">适用</span>
      ${['立项评估','方案评审','政策分析','技术选型','投资判断'].map(t => `<span class="tag-pill">${t}</span>`).join('')}
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-bottom:36px">
    ${[['独立立论','各抒己见，互不相扰，方有真分歧。','M12 20h9 M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z','var(--accent-soft)','var(--accent)'],
       ['交锋实录','分歧之处、被指漏洞、意外共识，一览无余。','M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z','var(--accent2-soft)','var(--accent2)'],
       ['失则立偿','若有闪失，退款 / 转额 / 换 AI，全自动。','M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4','rgba(220,38,38,.1)','#dc2626']]
      .map(f => `<div class="feature-card" style="background:var(--card);border-radius:16px;padding:22px">
        <div style="width:40px;height:40px;border-radius:10px;background:${f[3]};display:flex;align-items:center;justify-content:center;color:${f[4]};margin-bottom:14px">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${f[2].split(' M').map((d,i) => `<path d="${i ? 'M' + d : d}"/>`).join('')}</svg></div>
        <h3 class="serif" style="font-size:17px;font-weight:700;margin:0 0 8px;letter-spacing:.08em">${f[0]}</h3>
        <p style="font-size:13.5px;line-height:1.7;color:var(--muted);margin:0">${f[1]}</p></div>`).join('')}
  </div>
  <div style="background:var(--card);border:1px solid var(--border);border-radius:24px;padding:34px 30px;box-shadow:0 20px 60px rgba(26,22,48,.08)">
    <div style="display:flex;align-items:center;margin-bottom:32px">
      <div class="step"><div class="step-dot serif">壹</div><span class="serif" style="font-size:14px;font-weight:600;letter-spacing:.08em">出题</span></div>
      <div class="step-line"></div>
      <div class="step"><div class="step-dot idle serif">贰</div><span class="serif" style="font-size:14px;font-weight:600;color:var(--muted);letter-spacing:.08em">入座</span></div>
      <div style="height:2px;flex:1;margin:0 10px;background:#e8e6f0"></div>
      <div class="step"><div class="step-dot idle serif">叁</div><span class="serif" style="font-size:14px;font-weight:600;color:var(--muted);letter-spacing:.08em">取果</span></div>
    </div>
    <div style="margin-bottom:26px">
      <label class="serif" style="display:block;font-size:15px;font-weight:700;margin-bottom:12px;letter-spacing:.08em">你的议题 <span style="font-weight:400;font-size:12.5px;color:var(--muted);font-family:sans-serif">（越具体，交锋越烈）</span></label>
      <div class="input-focus" style="border:2px solid var(--border);border-radius:14px;padding:14px 16px;background:#fafaff">
        <textarea id="topicInput" rows="3" placeholder="例：吾欲于二线之城开一社区自习室，初备十五万。乞诸位研判可否为之，其最大之坑何在。" style="width:100%;border:none;outline:none;resize:vertical;background:transparent;font-size:14.5px;line-height:1.8;font-family:inherit;color:var(--text)"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:6px"><span id="charCount" style="font-size:12px;color:var(--muted)">0 字</span></div>
      </div>
    </div>
    <div style="margin-bottom:26px">
      <label class="serif" style="display:block;font-size:15px;font-weight:700;margin-bottom:6px;letter-spacing:.08em">请 AI 入座 <span style="font-weight:400;font-size:12.5px;color:var(--muted);font-family:sans-serif">（至少二位，越多交锋越烈）</span></label>
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 14px">已入座 <b id="aiCount" style="color:var(--accent)">0</b> 位，尚需至少二位 · 每位顾问由平台随机指派真实引擎，同角色每次意见或有不同</p>
      <div id="aiGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
        ${ROLES.map((r, i) => `
        <div class="ai-card" data-i="${i}" style="border-radius:12px;padding:14px">
          <div class="ai-check" style="position:absolute;top:8px;right:8px"><div style="width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div></div>
          <div style="width:36px;height:36px;border-radius:10px;background:${r.color}1a;color:${r.color};display:flex;align-items:center;justify-content:center;margin-bottom:10px;font-weight:700" class="serif">${r.name[0]}</div>
          <div class="serif" style="font-size:14.5px;font-weight:700;margin-bottom:3px;letter-spacing:.05em">${r.name}</div>
          <div style="font-size:11.5px;color:var(--muted);line-height:1.4">${r.desc}</div>
        </div>`).join('')}
        <div class="ai-card" id="byok-card" style="border-style:dashed;color:var(--muted);display:flex;align-items:center;justify-content:center"><span>🔑 自带密钥模式</span></div>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px dashed var(--border)">
      <p style="font-size:12px;color:var(--muted);margin:0">提交即视为同意服务条款 · ${window.__BETA_MODE === true ? '内测沙箱，不产生真实扣款' : '内测沙箱，不产生真实扣款'}</p>
      <button id="genBtn" class="grad-btn" disabled style="padding:13px 32px;border-radius:12px;font-size:15px;font-weight:700;border:none;font-family:inherit">
        <span id="genBtnText" class="serif" style="letter-spacing:.1em">③ 生成报价</span>
      </button>
    </div>
    <div id="quote-box"></div>
  </div>`;
  $('#topicInput').addEventListener('input', updateState);
  $('#app').addEventListener('change', e => { if (e.target.closest('#aiGrid')) updateState(); });
  $('#aiGrid').querySelectorAll('.ai-card[data-i]').forEach(card => card.onclick = () => {
    card.classList.toggle('selected'); updateState();
  });
  $('#byok-card').onclick = byokModal;
  $('#genBtn').onclick = () => createQuote();
  updateState();
}
function byokModal() {
  $('#modal-card').innerHTML = `
    <h3 class="serif" style="margin:0 0 4px">🔑 自带密钥模式（即将开放）</h3>
    <p style="font-size:13.5px;color:var(--muted);line-height:1.8">用自己的 AI 平台 Key 召唤模型，模型费用走你的账号，平台只收少量撮合服务费。内测后开放，支持阿里百炼 / 火山方舟 / DeepSeek / 任意 OpenAI 兼容接口。你的 Key 只在内存中使用，不落盘、不入库。</p>
    <button class="grad-btn" style="padding:9px 20px;border:none;border-radius:10px;font-family:inherit" onclick="hideModal()">知道了</button>`;
  $('#modal').classList.remove('hidden');
}
function selected() {
  return [...document.querySelectorAll('#aiGrid .ai-card.selected[data-i]')].map(el => ROLES[Number(el.dataset.i)]);
}
function updateState() {
  const b = $('#genBtn'), l = $('#aiCount'), inp = $('#topicInput'); if (!b) return;
  const n = selected().length, chars = inp.value.trim().length;
  if (l) l.textContent = n;
  b.disabled = !(chars >= 5 && n >= 2);
  b.querySelector('#genBtnText').textContent = n ? `③ 生成报价（${n} 位顾问）` : '③ 生成报价';
}
async function createQuote() {
  const roles = selected();
  const topic = $('#topicInput').value.trim();
  if (topic.length < 5) { alert('先写下议题（至少 5 个字）'); return; }
  if (roles.length < 2) { alert('至少请两位 AI 入座'); return; }
  const engines = assignEngines(roles.length);
  const b = $('#genBtn'); b.disabled = true;
  try {
    const q = await api('/api/quote', { method: 'POST', body: JSON.stringify({ model_ids: engines }) });
    sessionStorage.setItem('topic_' + q.order_id, topic);
    sessionStorage.setItem('roles_' + q.order_id, JSON.stringify(roles.map(r => r.name)));
    const itemsHtml = q.items.map((it, i) => `<tr><td>${esc(roles[i].name)} <small class="dim" style="font-size:11px">（引擎：${esc(it.model_id)}）</small></td><td>${yuan(it.locked_price_cents)}</td></tr>`).join('');
    $('#quote-box').innerHTML = `
      <div id="resultArea" style="display:block;margin-top:22px;padding:20px;border-radius:14px;background:linear-gradient(135deg,var(--accent-soft),var(--accent2-soft));border:1px solid rgba(124,58,237,.2)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <div style="width:28px;height:28px;border-radius:8px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center" class="serif">✓</div>
          <span class="serif" style="font-weight:700;font-size:15px;letter-spacing:.08em">报价已成</span>
        </div>
        <div style="font-size:14px;line-height:1.9">
          <p style="margin:0 0 8px"><b>议题：</b>${esc(topic)}</p>
          <table><tbody>${itemsHtml}<tr class="total"><td>合计（沙箱 · 不产生真实扣款）</td><td>${yuan(q.total_cents)}</td></tr></tbody></table>
          <p class="dim" style="margin:0 0 12px;font-size:12px">报价锁定 15 分钟 · 支付后顾问们立即各自独立作业 · 任一故障自动退款/转额度/换 AI</p>
          <button id="pay-btn" class="grad-btn" style="padding:12px 28px;border-radius:12px;font-size:15px;font-weight:700;border:none;font-family:inherit">确认支付 ${yuan(q.total_cents)}</button>
          <span id="pay-err" class="err"></span>
        </div>
      </div>`;
    $('#quote-box').scrollIntoView({ behavior: 'smooth' });
    $('#pay-btn').onclick = () => payOrder(q.order_id, topic);
    b.disabled = false;
  } catch (e) {
    if (e.message.startsWith('LOGIN_REQUIRED')) authModal('登录后即可发起头脑风暴', () => createQuote());
    else if (e.message.startsWith('TRIALS_EXHAUSTED')) alert('免费体验已用完（3/3）');
    else alert(e.message);
    b.disabled = false;
  }
}
async function payOrder(orderId, topic) {
  try {
    await api(`/api/orders/${orderId}/pay`, { method: 'POST', body: JSON.stringify({ topic }) });
    $('#quote-box').innerHTML = `
      <div class="card paid-ok" style="background:var(--card);border:1px solid var(--border);border-radius:14px;margin-top:18px">
        <div class="paid-mark">✓ 已支付</div>
        <p style="font-size:16px;margin:12px 0 6px">顾问们已收到议题，正在各自独立思考——互不知情，互不干扰。</p>
        <p class="dim" style="font-size:13px">完成后本页自动更新，可导出报告。</p>
      </div>`;
    $('#quote-box').scrollIntoView({ behavior: 'smooth' });
    startPolling(orderId);
  } catch (e) { $('#pay-err').textContent = e.message; }
}
function startPolling(orderId) {
  if (poll) clearInterval(poll);
  location.hash = '#/order/' + orderId;
  const tick = async () => { try { renderOrder(await api(`/api/orders/${orderId}`), orderId); } catch {} };
  tick(); poll = setInterval(tick, 2000);
}
async function renderOrder(v, orderId) {
  const done = v.settlement && !v.decision;
  if (done && poll) { clearInterval(poll); poll = null; }
  const topic = sessionStorage.getItem('topic_' + orderId) ?? '';
  const roleNames = JSON.parse(sessionStorage.getItem('roles_' + orderId) ?? '[]');
  const withText = await Promise.all(v.items.map(async (it, i) => ({ ...it, text: await fetchResult(it.result_ref), role: roleNames[i] ?? it.model_id })));
  const c = v.collision;
  $('#app').innerHTML = `
    <section class="card" style="background:var(--card);border:1px solid var(--border);border-radius:24px;padding:30px">
      ${topic ? `<div class="topic-show"><span class="lbl">本次议题</span>${esc(topic)}</div>` : ''}
      <p class="status serif" style="font-size:18px;font-weight:700;color:var(--accent)">${ORDER_ZH[v.status] ?? esc(v.status)} <small style="color:var(--muted);font-weight:400;font-size:12px">${v.order_id}</small></p>
      ${c ? collisionCard(c) : ''}
      ${withText.map(it => `
        <div class="opinion">
          <div class="op-head"><b class="serif" style="font-size:15px">${esc(it.role)}<small style="color:var(--muted);font-weight:400;font-size:11px"> · ${esc(it.model_id)}</small></b>
            <span class="st-${it.state}" style="font-size:13px">${ITEM_ZH[it.state] ?? esc(it.state)}</span>
            <span style="color:var(--muted);font-size:13px;margin-left:auto">${yuan(it.locked_price_cents)}</span></div>
          ${it.text ? `<pre class="op-body">${esc(it.text)}</pre>` : it.state === 'RUNNING' ? `<p class="dim typing" style="color:var(--muted)">正在独立思考…</p>` : ''}
        </div>`).join('')}
      ${v.settlement ? settle(v.settlement) : ''}
      <div style="display:flex;gap:12px;margin-top:16px">
        <button class="ghost" style="padding:9px 18px;border:1px solid var(--border);border-radius:10px;background:#fff;color:var(--muted);font-family:inherit;cursor:pointer" onclick="location.hash='';boot()">← 发起新的风暴</button>
        <button class="ghost" style="padding:9px 18px;border:1px solid var(--border);border-radius:10px;background:#fff;color:var(--muted);font-family:inherit;cursor:pointer" onclick="feedbackModal('${orderId}')">💡 出问题了？</button>
      </div>
    </section>`;
  if (v.decision) showModal(v.decision, orderId); else hideModal();
}
function collisionCard(c) {
  const block = (t, cls, arr, fmt) => arr.length ? `<div class="col-block ${cls}"><h4 class="serif">${t}</h4>${arr.map(fmt).join('')}</div>` : '';
  return `<div class="collision">
    <h3 class="serif" style="margin:0 0 10px;font-size:16px">⚡ 碰撞报告 <small style="color:var(--muted);font-weight:400">AI 们互相碰撞出的东西</small></h3>
    ${block('针锋相对 — 分歧点', 'dis', c.disagreements ?? [], d => `<div class="pt"><b>${esc(d.topic)}</b>${d.stances.map(x => `<div class="snip"><i>${esc(x.model)}</i>：${esc(x.snippet)}…</div>`).join('')}</div>`)}
    ${block('被挑出的漏洞', 'hole', c.holes ?? [], h => `<div class="pt"><i>${esc(h.raised_by)}</i> 提出：${esc(h.point)}</div>`)}
    ${block('意外共识', 'con', c.consensuses ?? [], k => `<div class="pt"><b>${esc(k.topic)}</b> — ${k.stances.length} 位一致</div>`)}
    ${(!(c.disagreements ?? []).length && !(c.holes ?? []).length && !(c.consensuses ?? []).length) ? '<p class="dim">本轮意见较为一致，未捕捉到显著碰撞。</p>' : ''}
  </div>`;
}
function settle(s) {
  return `<div class="settle"><h3 class="serif" style="font-size:15px;margin:0 0 8px">账单（每一分钱可追溯，balance 恒为 0）</h3><table><tbody>
    <tr><td>订单总额</td><td>${yuan(s.order_total_locked_cents)}</td></tr>
    ${s.refunded_cash_cents ? `<tr><td>已退款</td><td>${yuan(s.refunded_cash_cents)}</td></tr>` : ''}
    <tr><td>最终应收</td><td>${yuan(s.final_due_cents)}</td></tr>
    <tr class="total"><td>balance</td><td>${s.balance_cents}</td></tr>
  </tbody></table></div>`;
}
function showModal(d, orderId) {
  const f = d.failed_item;
  $('#modal-card').innerHTML = `
    <h3 class="serif" style="margin:0 0 4px">一位顾问中途掉线</h3>
    <p style="font-size:13.5px;color:var(--muted);margin:0 0 10px">${esc(f.model_id)} · ${esc(f.reason_code ?? '')} · 已付 ${yuan(f.locked_price_cents)}。其余顾问不受影响。</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin:10px 0">
      <button class="grad-btn" data-c="REFUND" style="padding:11px;border:none;border-radius:10px;font-family:inherit;font-weight:700">${esc(d.options.find(o => o.type === 'REFUND')?.label ?? '退款')}</button>
      <button data-c="VOUCHER" style="padding:11px;border:1px solid var(--border);border-radius:10px;font-family:inherit;background:#fff">${esc(d.options.find(o => o.type === 'VOUCHER')?.label ?? '转额度')}</button>
    </div>
    <h4 class="serif" style="font-size:13.5px;margin:10px 0 6px">或换一位顾问补位：</h4>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${d.options.find(o => o.type === 'REPLACE').candidates.map(c =>
        `<button data-c="REPLACE" data-m="${esc(c.model_id)}" style="padding:10px;text-align:left;border:1px solid var(--border);border-radius:10px;font-family:inherit;background:#fff">${esc(c.model_id)}<br><small style="color:var(--muted)">${esc(c.label)}</small></button>`).join('')}
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:10px">${esc(d.notice)}</p>`;
  $('#modal').classList.remove('hidden');
  $('#modal-card').querySelectorAll('button[data-c]').forEach(b => b.onclick = async () => {
    try {
      await api(`/api/orders/${orderId}/items/${f.item_id}/decision`, { method: 'POST',
        body: JSON.stringify({ choice: b.dataset.c, model_id: b.dataset.m }) });
      hideModal(); startPolling(orderId);
    } catch (e) { alert(e.message); }
  });
}
function hideModal() { $('#modal').classList.add('hidden'); }

async function myOrders() {
  let orders;
  try { ({ orders } = await api('/api/my/orders')); }
  catch (e) { if (e.message.startsWith('LOGIN_REQUIRED')) return authModal('登录后查看我的订单'); throw e; }
  $('#app').innerHTML = `
    <section class="card" style="background:var(--card);border:1px solid var(--border);border-radius:24px;padding:30px">
      <h2 class="serif" style="margin:0 0 14px">我的订单</h2>
      ${orders.length ? `<table><thead><tr><th>订单</th><th>时间</th><th>金额</th><th>状态</th></tr></thead><tbody>
        ${orders.map(o => `<tr><td><a style="color:var(--accent);cursor:pointer" href="#/order/${o.order_id}">${esc(o.order_id.slice(0, 16))}…</a></td>
          <td style="color:var(--muted);font-size:13px">${new Date(o.created_at).toLocaleString('zh-CN')}</td>
          <td>${yuan(o.total_cents)}</td><td>${ORDER_ZH[o.status] ?? esc(o.status)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="dim">还没有发起过头脑风暴。</p>'}
      <button class="ghost" style="margin-top:14px;padding:9px 18px;border:1px solid var(--border);border-radius:10px;background:#fff;color:var(--muted);font-family:inherit" onclick="location.hash='';boot()">← 发起新的风暴</button>
    </section>`;
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    window.__BETA_MODE = me.beta_mode;
    renderAuthBox(me.user);
  } catch { renderAuthBox(null); }
  const om = location.hash.match(/^#\/order\/(ord_\w+)$/);
  if (om) { startPolling(om[1]); return; }
  if (location.hash === '#/orders') return myOrders();
  if (poll) { clearInterval(poll); poll = null; }
  const m = await api('/api/models');
  MODELS = m.models;
  home();
}
window.addEventListener('hashchange', boot);
boot();
