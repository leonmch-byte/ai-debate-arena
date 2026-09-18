import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = f => readFileSync(f, 'utf8');
let out = `// ============================================================
// 多 AI 头脑风暴 · 单文件发布版 v3
// 自动生成：由 src/ 模块合并（勿手改，改 src/ 后 npm run build）
// 依赖：Node >= 22.13（node:sqlite 内置），零 npm 依赖
// ============================================================
`;

const modules = ['store.js','ids.js','config.js','auth.js','growth.js','registry.js',
  'orders.js','funding.js','pricing.js','carryover.js','checkout.js','payments.js',
  'refunds.js','decisions.js','fulfillment.js','settlement.js','vouchers.js',
  'collision.js','scenes.js','recon.js','admin.js','jobs.js','adapters-real.js'];

for (const m of modules) {
  let src = read('src/' + m)
    .replace(/^import .*$/gm, '')
    .replace(/^export (class|function|const)/gm, '$1');
  out += `\n// ========== src/${m} ==========\n` + src + '\n';
}

let server = read('server.js').replace(/^import .*$/gm, '');
out += '\n// ========== server.js ==========\n' + server;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/arena.js', out);
console.log('built: dist/arena.js (' + out.split('\n').length + ' lines)');
