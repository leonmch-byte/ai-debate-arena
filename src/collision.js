// M-B 预埋：碰撞报告引擎 v0。
// 输入：各 COMPLETED 项的意见文本。输出：{ disagreements, holes, consensuses } 三栏。
// v0 为轻量启发式（关键词共现）；真模型接入后升级为"模型互评"二次调用（顾问 A 挑 B 的漏洞），协议无需变更。
export function buildCollisionReport(opinions) {
  const valid = opinions.filter(o => o.text && o.text.length > 20);
  if (valid.length < 2) return null;
  const TOPICS = ['成本','风险','时机','合规','技术','市场','团队','资金','定价','增长','竞争','用户'];
  const hits = t => TOPICS.filter(k => t.includes(k));
  const disagreements = [], consensuses = [];
  for (const topic of TOPICS) {
    const who = valid.filter(o => hits(o.text).includes(topic));
    if (who.length < 2) continue;
    const stances = who.map(o => ({ model: o.model_id, snippet: snippetAround(o.text, topic) }));
    // v0 启发式：立场词共现判断（反对/但是/风险 vs 优势/可以/建议）
    const neg = stances.filter(s => /风险|不足|问题|但|难以|不建议/.test(s.snippet)).length;
    const pos = stances.filter(s => /优势|可以|建议|可行|机会/.test(s.snippet)).length;
    if (neg && pos) disagreements.push({ topic, stances });
    else if (pos === stances.length) consensuses.push({ topic, stances });
  }
  const holes = valid.flatMap(o =>
    (o.text.match(/(风险|漏洞|问题|隐患|不足)[：:，,]?\s*([^\n。]{6,40})/g) ?? [])
      .slice(0, 3).map(m => ({ raised_by: o.model_id, point: m.trim() })));
  return { disagreements: disagreements.slice(0, 5), holes: holes.slice(0, 6), consensuses: consensuses.slice(0, 4) };
}
function snippetAround(text, keyword) {
  const i = text.indexOf(keyword);
  const s = Math.max(0, i - 30);
  return text.slice(s, i + 50).replace(/\s+/g, ' ');
}
