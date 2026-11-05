// 从 brain-gym 源抽取 qa 引擎数据与逻辑（纯数据 + 纯逻辑 + 联网抓取），不含 UI 层
const fs = require('fs');
const SRC = 'D:/Projects/_github_pages/ming-games/brain-gym/index.html';
const OUT = 'D:/Projects/_github_pages/ming-games/quiz/.build/engine_core.js';

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

const startIdx = lines.findIndex(l => l.indexOf('var POOLS={') === 0);
if (startIdx < 0) { console.error('ERROR: 找不到 var POOLS={'); process.exit(1); }
const endIdx = lines.findIndex((l, i) => i > startIdx && l.indexOf('function matchCustom') === 0);
if (endIdx < 0) { console.error('ERROR: 找不到 function matchCustom'); process.exit(1); }

const core = lines.slice(startIdx, endIdx + 1).join('\n');

// 锚点校验
const must = ['var POOLS={', 'var QA_TYPES={', 'function genMath(', 'function fetchOnline', 'function matchCustom'];
for (const m of must) {
  if (core.indexOf(m) < 0) { console.error('ERROR: 引擎核心缺少锚点 ' + m); process.exit(1); }
}
// 不应包含 UI 层（这些在 4665+ 之后）
const forbidden = ['// ================= 界面 =================', 'function showQuestion', 'function openEditor', 'var wrap=h('];
for (const f of forbidden) {
  if (core.indexOf(f) >= 0) { console.error('ERROR: 引擎核心误包含 UI 锚点 ' + f); process.exit(1); }
}

fs.writeFileSync(OUT, core, 'utf8');
console.log('OK: 引擎核心已抽取，行数=' + (endIdx - startIdx + 1) + ' 字节=' + Buffer.byteLength(core, 'utf8'));
