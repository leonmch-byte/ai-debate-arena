// M9-B v3：真实模型适配器。
// 契约（M4）：run(model_id, input) → { ok:true, result_ref } | { ok:false, reason_code, raw? }
// Key：ARENA_ENV_FILE（默认 ~/.arena_env）→ process.env；测试可用 opts.env 显式注入隔离环境。
// 就绪按提供商：ark=ARK_API_KEY+ARK_ENDPOINT；dashscope=DASHSCOPE_API_KEY。互相独立。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_MAP = {
  'qwen-max':   { provider: 'dashscope', model: 'qwen-max' },
  'glm-4-plus': { provider: 'zhipu',     model: 'glm-4-plus' },
  'doubao-pro': { provider: 'ark',       model: () => this_endpoint() },
};
function this_endpoint() {
  const src = globalThis.__ARENA_ENV_SRC ?? process.env;
  return src.ARK_ENDPOINT;
}
function loadEnv() {
  const p = process.env.ARENA_ENV_FILE || join(process.env.HOME ?? '/home/ubuntu', '.arena_env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

export class RealAdapter {
  constructor(opts = {}) {
    this.envOverride = opts.env ?? null;        // 测试隔离：显式环境（undefined = 视为缺失）
    if (!this.envOverride) loadEnv();
    this.resultsDir = opts.resultsDir ?? 'results';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.log = opts.log ?? (() => {});
  }
  #get(name) {
    if (this.envOverride) {
      const v = this.envOverride[name];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    }
    return process.env[name];
  }
  #ready(provider) {
    if (provider === 'ark') return !!(this.#get('ARK_API_KEY') && this.#get('ARK_ENDPOINT'));
    if (provider === 'dashscope') return !!this.#get('DASHSCOPE_API_KEY');
    return false;
  }
  #fail(reason_code, raw) { return { ok: false, reason_code, raw }; }

  async run(model_id, input = {}) {
    const conf = MODEL_MAP[model_id];
    if (!conf) return this.#fail('MODEL_RESPONSE_INVALID', { error: `未映射的模型 ${model_id}` });
    if (!this.#ready(conf.provider))
      return this.#fail('MODEL_AUTH_FAILURE', { error: `${conf.provider} 凭证未配置（~/.arena_env）` });

    const isArk = conf.provider === 'ark';
    const url = isArk
      ? 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const key = isArk ? this.#get('ARK_API_KEY') : this.#get('DASHSCOPE_API_KEY');
    const model = typeof conf.model === 'function' ? conf.model() : conf.model;
    if (!model) return this.#fail('MODEL_AUTH_FAILURE', { error: '接入点 ID 缺失' });

    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: input.system ?? '你是多模型头脑风暴团队的成员之一，请就用户议题给出你的独立专业意见。' },
        { role: 'user', content: input.prompt ?? '请就当前议题给出你的专业意见。' },
      ],
      temperature: 0.7,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res; const t0 = Date.now();
    try {
      res = await fetch(url, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') return this.#fail('MODEL_TIMEOUT', { elapsed_ms: Date.now() - t0 });
      return this.#fail('MODEL_UNAVAILABLE', { error: String(e?.message ?? e) });
    }
    clearTimeout(timer);

    if (res.status === 429) return this.#fail('MODEL_RATE_LIMITED', { status: 429 });
    if (res.status === 401 || res.status === 403) return this.#fail('MODEL_AUTH_FAILURE', { status: res.status });
    if (!res.ok) return this.#fail('MODEL_UNAVAILABLE', { status: res.status, body: (await res.text().catch(() => '')).slice(0, 300) });

    let data;
    try { data = await res.json(); } catch { return this.#fail('MODEL_RESPONSE_INVALID', { error: '响应非 JSON' }); }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length < 10)
      return this.#fail('MODEL_RESPONSE_INVALID', { error: '响应缺少内容', body: JSON.stringify(data).slice(0, 300) });

    mkdirSync(this.resultsDir, { recursive: true });
    const ref = `real-${model_id}-${Date.now()}.md`;
    writeFileSync(join(this.resultsDir, ref), `# ${model_id} 的意见\n\n${text}\n`);
    this.log(JSON.stringify({ at: new Date().toISOString(), msg: 'real model ok', model_id, ms: Date.now() - t0 }));
    return { ok: true, result_ref: ref };
  }
}
