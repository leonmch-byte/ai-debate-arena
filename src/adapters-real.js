// M9-B：真实模型适配器（占位就绪态）。
// 契约（M4 已定）：run(model_id) → { ok:true, result_ref } | { ok:false, reason_code }
// Key 来源：~/.arena_env（DASHSCOPE_API_KEY / ARK_API_KEY / ARK_ENDPOINT），服务器本地文件，不入库。
// 启用：ARENA_ADAPTER=real 启动。Key 未配置时本模块抛 NOT_CONFIGURED，server 自动回落沙箱并告警。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MODEL_MAP = {
  'qwen-max':   { provider: 'dashscope', model: 'qwen-max' },
  'doubao-pro': { provider: 'ark',       model: () => process.env.ARK_ENDPOINT ?? '' },
};

function loadEnv() {
  const p = join(process.env.HOME ?? '/home/ubuntu', '.arena_env');
  if (!existsSync(p)) return {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  return process.env;
}

export class RealAdapter {
  constructor(opts = {}) {
    this.env = { ...loadEnv(), ...opts.env };
    this.resultsDir = opts.resultsDir ?? 'results';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.log = opts.log ?? (() => {});
  }
  get configured() {
    return !!(this.env.DASHSCOPE_API_KEY && this.env.ARK_API_KEY && this.env.ARK_ENDPOINT);
  }
  #fail(reason_code, raw) { return { ok: false, reason_code, raw }; }

  async run(model_id, input = {}) {
    const conf = MODEL_MAP[model_id];
    if (!conf) return this.#fail('MODEL_RESPONSE_INVALID', { error: `未映射的模型 ${model_id}` });
    if (!this.configured) return this.#fail('MODEL_AUTH_FAILURE', { error: 'Key 未配置（~/.arena_env）' });

    const isDash = conf.provider === 'dashscope';
    const url = isDash
      ? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
      : `https://ark.cn-beijing.volces.com/api/v3/chat/completions`;
    const key = isDash ? this.env.DASHSCOPE_API_KEY : this.env.ARK_API_KEY;
    const model = typeof conf.model === 'function' ? conf.model() : conf.model;

    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是多模型联合评审团的成员之一，请就用户问题给出你的独立专业意见。' },
        { role: 'user', content: input.prompt ?? '请给出你对当前议题的专业意见。' },
      ],
      temperature: 0.7,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res, t0 = Date.now();
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body, signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') return this.#fail('MODEL_TIMEOUT', { elapsed_ms: Date.now() - t0 });
      return this.#fail('MODEL_UNAVAILABLE', { error: String(e?.message ?? e) });
    }
    clearTimeout(timer);

    if (res.status === 429) return this.#fail('MODEL_RATE_LIMITED', { status: 429 });
    if (res.status === 401 || res.status === 403) return this.#fail('MODEL_AUTH_FAILURE', { status: res.status });
    if (!res.ok) return this.#fail('MODEL_UNAVAILABLE', { status: res.status });

    let data;
    try { data = await res.json(); }
    catch { return this.#fail('MODEL_RESPONSE_INVALID', { error: '响应非 JSON' }); }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length < 10)
      return this.#fail('MODEL_RESPONSE_INVALID', { error: '响应缺少内容' });

    // 产出落盘 → result_ref 指向真实文件
    mkdirSync(this.resultsDir, { recursive: true });
    const ref = `${model_id}-${Date.now()}.md`;
    const file = join(this.resultsDir, ref);
    writeFileSync(file, `# ${model_id} 的评审意见\n\n${text}\n`);
    this.log(JSON.stringify({ at: new Date().toISOString(), msg: 'real model ok', model_id, ms: Date.now() - t0 }));
    return { ok: true, result_ref: file };
  }
}
