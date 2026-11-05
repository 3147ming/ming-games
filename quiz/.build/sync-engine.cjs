/* 把 code_engine.js 重新同步进 quiz-ui.js 的标记区间（改引擎内容后跑这个） */
const fs = require('fs');
const DIR = 'D:/Projects/_github_pages/ming-games/quiz/.build';
const UI = DIR + '/quiz-ui.js';
let s = fs.readFileSync(UI, 'utf8');
const block = fs.readFileSync(DIR + '/code_engine.js', 'utf8').trim();
const A = '/*=== CODE_ENGINE_START ===*/', B = '/*=== CODE_ENGINE_END ===*/';
const i0 = s.indexOf(A), i1 = s.indexOf(B);
if (i0 < 0 || i1 < 0) { console.error('✗ 区间标记缺失'); process.exit(1); }
s = s.slice(0, i0) + block + s.slice(i1 + B.length);
fs.writeFileSync(UI, s, 'utf8');
console.log('OK 引擎块已同步，quiz-ui.js 字节=' + Buffer.byteLength(s, 'utf8'));
