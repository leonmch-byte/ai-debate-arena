// M-B.5：场景状态层——背锅场景。每个角色是"活的"：目标/态度/已知/怀疑随剧情演化。
// 状态变化由模型在回应中输出（JSON delta），引擎解析入库（SCENE_TURN 的 state_delta）。
// 原则（还原律）：状态描述是事实记录，不评判、不教育。

export const BLAME_SCENARIO = {
  id: 'blame',
  name: '背锅边缘',
  situation_template: '项目出了问题：{problem}。复盘会还剩 {days} 天。你是项目成员之一。',
  actors: [
    { key: 'boss', name: '直属领导', model: 'doubao-pro',
      card: '你是「部门领导」，向更上层交差。利益：部门业绩、上层信任、团队稳定（按此优先级）。性格：语言简洁，习惯用反问施压，反感情绪化表达，欣赏直接给方案的人。红线：你的反应只基于你听到的内容和你的利益——你不解读人心，不扮演全知，不为剧情编造事实。',
      initial: { goal: '向上交差，尽量不伤部门', attitude_to_user: '观望', knows: ['项目出了问题', '复盘会时间'], suspects: [], last_action: '在群里要求全员复盘' } },
    { key: 'colleague', name: '甩锅同事', model: 'kimi-k3',
      card: '你是「同事」，与用户同级。利益：把责任引向别处，保住自己；避免被认定抢功或甩锅。性格：表面客气实则精明，被质问时不正面冲突，习惯用「都是团队一起做的」打太极。红线：可以圆滑太极，但不凭空认输——除非被逼到墙角。你的反应只基于你听到的内容和你的利益。',
      initial: { goal: '把责任引向别处，保住自己', attitude_to_user: '表面客气，暗中试探', knows: ['项目的锅需要一个出口'], suspects: ['你负责的部分最像突破口'], last_action: '在群里"客观说明"了情况' } },
    { key: 'veteran', name: '旁观老员工', model: 'minimax-m3',
      card: '你是「老员工」，司龄长，经历过几轮权力更替。利益：不卷入任何冲突，只求安稳。性格：话少，说话绕，喜欢用「以前也发生过类似的事」来暗示，不直接给建议。红线：你的暗示基于部门历史，可以有偏见（老员工的偏见是真实的一部分），但不做全知视角的剧透。',
      initial: { goal: '不卷入，看风向', attitude_to_user: '中立同情', knows: ['这个部门的历史甩锅模式'], suspects: [], last_action: '沉默观望' } },
  ],
  openingHint: '复盘会前的第一天，各方开始动作。从「领导」的视角开始：',
};

// 解析模型回应中的状态变化（模型按约定输出 JSON delta）
export function parseStateDelta(text) {
  const m = text.match(/【状态变化】([\s\S]*?)(?:$|(?=\n[^{]))/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1].trim().replace(/^```json\n?/, '').replace(/\n?```$/, ''));
    // 合法性：只允许指定字段
    const clean = {};
    if (d.attitude_to_user) clean.attitude_to_user = String(d.attitude_to_user).slice(0, 60);
    if (d.knows && Array.isArray(d.knows)) clean.knows = d.knows.slice(0, 5).map(String);
    if (d.suspects && Array.isArray(d.suspects)) clean.suspects = d.suspects.slice(0, 5).map(String);
    if (d.last_action) clean.last_action = String(d.last_action).slice(0, 80);
    if (d.goal) clean.goal = String(d.goal).slice(0, 80);
    return Object.keys(clean).length ? clean : null;
  } catch { return null; }
}

// 从回应正文剥离状态变化段（正文不含它）
export function stripDelta(text) {
  return text.replace(/【状态变化】[\s\S]*?(?:$|(?=\n[^{]))/, '').trim();
}
