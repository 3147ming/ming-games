/* P1 定向验证（Node + vm）
   P1-1 fillEqual 十六进制口径
   P1-2 薄弱题本：去重计数 / 150 上限保留高频 / 按 type+q 移除 / 单题练入口
   P1-3 codeTrial 跨三档（源码结构 + 池子可抽）
   P1-4 codeEstimate 诚实口径（每个生成器都有 kb）
   P1-5 事实题逐条核对结果 */
const { ctx, E, store } = require('./_sandbox.cjs');

let pass = 0, fail = [];
function ck(name, cond, info) { if (cond) { pass++; } else { fail.push(name + ' :: ' + (info || '')); } }
const fe = E.fillEqual;

/* ---------- P1-1 fillEqual 十六进制 ---------- */
ck('0x10 答案，输入 10 → 错', fe('10', '0x10') === false);
ck('0x10 答案，输入 0x10 → 对', fe('0x10', '0x10') === true);
ck('0x10 答案，输入 0x0A? → 错（值不同）', fe('0xA', '0x10') === false);
ck('0x10 答案，输入 16 → 错（格式不一致）', fe('16', '0x10') === false);
ck('0xA 答案，输入 0xa → 对（大小写不敏感）', fe('0xa', '0xA') === true);
ck('十进制 16 vs 16 → 对', fe('16', '16') === true);
ck('1024 vs 1,024 → 对（norm 去分隔符）', fe('1,024', '1024') === true);
ck('0xFF vs 255 → 错（一边带 0x）', fe('255', '0xFF') === false);

/* ---------- P1-2 薄弱题本 ---------- */
const weak = () => JSON.parse(store['bt_qa_weak'] || '[]');
store['bt_qa_weak'] = '[]';
const it1 = { type: 'b:geo', diff: 0, q: 'Q1', a: 'A1', opts: ['A1', 'B', 'C', 'D'], pick: 'B' };
ctx.addWeak(it1); ctx.addWeak(it1); ctx.addWeak(it1);
ck('同一题错 3 次 → 只有 1 条', weak().length === 1, 'len=' + weak().length);
ck('同一题错 3 次 → 计数 ×3', weak()[0].n === 3, 'n=' + weak()[0].n);
ck('记录保留最后错选', weak()[0].pick === 'B');
ctx.addWeak({ type: 'b:geo', diff: 0, q: 'Q2', a: 'A2', opts: null, pick: 'x' });
ck('不同题追加新条目', weak().length === 2);
ck('新条目 n 从 1 起', weak().filter(x => x.q === 'Q2')[0].n === 1);

/* 上限 150 + 高频不被挤掉 */
store['bt_qa_weak'] = '[]';
const hot = { type: 'b:common', q: 'HOT', a: 'h', opts: null };
for (let i = 0; i < 5; i++) ctx.addWeak(hot);          // 高频错题 n=5
for (let i = 0; i < 200; i++) ctx.addWeak({ type: 'b:science', q: 'F' + i, a: 'a', opts: null });
const capped = weak();
ck('上限 150 生效', capped.length === 150, 'len=' + capped.length);
ck('高频错题未被新题挤掉', capped.some(x => x.q === 'HOT'), '未找到 HOT');
ck('裁剪后按次数降序', (capped[0].n || 1) >= (capped[capped.length - 1].n || 1), 'head=' + capped[0].n);

/* 移除口径 type+q */
store['bt_qa_weak'] = '[]';
ctx.addWeak({ type: 'b:geo', q: 'R1', a: 'A', opts: null });
ctx.addWeak({ type: 'b:geo', q: 'R1', a: 'CHANGED', opts: null });
ctx.removeWeak({ type: 'b:geo', q: 'R1' });
ck('removeWeak 按 type+q 移除（a 变了也能删）', weak().length === 0, 'len=' + weak().length);

/* 排序：次数降序 + 时间降序 */
const sorted = E.weakSort([{ q: 'a', n: 1, t: 100 }, { q: 'b', n: 3, t: 50 }, { q: 'c', n: 3, t: 90 }]);
ck('weakSort 次数优先、同次数新在前', sorted[0].q === 'c' && sorted[1].q === 'b' && sorted[2].q === 'a', JSON.stringify(sorted.map(x => x.q)));

/* 单题练入口：qlist 长度 1、total 1、reviewOne 置位 */
E.setQ({ typeKey: '', reviewMode: false, reviewOne: false, qidx: 0, total: 0, ok: 0, score: 0, quizOver: false });
E.startReviewOne({ type: 'b:geo', q: 'ONE', a: 'A', opts: ['A', 'B', 'C', 'D'] });
const st = E.getState();
ck('单题练：qlist 只 1 题', st.qlist.length === 1, 'len=' + st.qlist.length);
ck('单题练：total=1', st.total === 1);
ck('单题练：reviewOne 置位', st.reviewOne === true);
ck('单题练：进入回顾模式', st.reviewMode === true);

/* 分类名映射 */
ck('weakCatName 内置分类', E.weakCatName('b:geo').indexOf('地理') >= 0, E.weakCatName('b:geo'));
ck('weakCatName 自定义分类', E.weakCatName('c:三角洲') === '📝 三角洲', E.weakCatName('c:三角洲'));
ck('weakAgo 无时间戳 → —', E.weakAgo(0) === '—');
ck('weakAgo 3 天前', E.weakAgo(Date.now() - 3 * 86400000) === '3 天前', E.weakAgo(Date.now() - 3 * 86400000));

/* ---------- P1-4 题量口径 ---------- */
const noKb = [];
// 从源码里数：每个 CODE_TOPICS 条目都应带 kb
const src = require('fs').readFileSync(__dirname + '/code_engine.js', 'utf8');
const topicsBlock = src.slice(src.indexOf('var CODE_TOPICS'), src.indexOf('/* 矩阵辅助函数'));
const topicCount = (topicsBlock.match(/\{k:'/g) || []).length;
const kbCount = (topicsBlock.match(/,kb:\d+/g) || []).length;
ck('CODE_TOPICS 每个生成器都有 kb', topicCount === kbCount && topicCount > 60, 'topics=' + topicCount + ' kb=' + kbCount);

const est = E.codeEstimate();
const parts = E.codeEstimateParts();
ck('codeEstimate > 0', est > 0, 'est=' + est);
ck('codeEstimate = 人工 + 模板', parts.manual + parts.gen === est, JSON.stringify(parts));
ck('人工题数 = POOLS.code 条数', parts.manual === Object.keys(ctx.POOLS.code).reduce((a, d) => a + ctx.POOLS.code[d].length, 0), 'manual=' + parts.manual);

/* ---------- P1-5 事实题 ---------- */
function findQ(txt) {
  const hits = [];
  Object.keys(ctx.POOLS).forEach(bk => {
    const v = ctx.POOLS[bk];
    if (Array.isArray(v)) v.forEach(it => { if (String(it[0]).indexOf(txt) >= 0) hits.push({ bk, it }); });
  });
  return hits;
}
ck('南非题已限定「行政首都」', findQ('南非的行政首都是').length === 1 && findQ('南非的首都是').length === 0);
ck('南非题干扰项是本国城市', findQ('南非的行政首都是')[0].it[3] === '开普敦|布隆方丹|约翰内斯堡', findQ('南非的行政首都是')[0].it[3]);
ck('人口题加了时间限定', findQ('截至 2023 年').length === 1);
ck('马拉松答案 42.195', findQ('马拉松全程')[0].it[1] === '42.195', findQ('马拉松全程')[0].it[1]);
ck('工作日题加了地区限定', findQ('在中国大陆，一周通常有几个工作日').length === 1);
ck('牛两条腿玩笑题已下架', findQ('牛通常有两条腿').length === 0);
ck('char 题加了补码平台限定', (function(){var n=0;Object.keys(ctx.POOLS.code).forEach(function(d){(ctx.POOLS.code[d]||[]).forEach(function(it){if(String(it[0]).indexOf('常见补码平台')>=0)n++;});});return n>=1;})());

/* P1-5 顺带返修：所有干扰项必须与答案同类可辨（这里只查「不含答案 + 3 个互异」） */
let optBad = 0, optN = 0;
Object.keys(ctx.POOLS).forEach(bk => {
  const v = ctx.POOLS[bk];
  if (!Array.isArray(v)) return;
  v.forEach(it => {
    if (!it[3]) return;
    optN++;
    const ws = String(it[3]).split('|').map(x => x.trim()).filter(Boolean);
    const uniq = new Set(ws);
    if (ws.length !== 3 || uniq.size !== 3 || uniq.has(String(it[1]))) { optBad++; }
  });
});
ck('全部静态题干扰项 3 个互异且不含答案（' + optN + ' 题）', optBad === 0, 'bad=' + optBad);

/* 干扰项不许再出现「跨类」垃圾（抽查：科学题里不应出现器官类选项配化学式答案） */
const sci = findQ('水的化学分子式')[0].it;
ck('科学题干扰项不再混入器官/单位', sci[3] === 'CO₂|NaCl|O₂', sci[3]);
const amp = findQ('电流的国际单位')[0].it;
ck('电流单位题干扰项是同类单位', amp[3] === '伏特|瓦特|欧姆', amp[3]);

/* ---------- 汇总 ---------- */
console.log('P1 定向验证：通过 ' + pass + '，失败 ' + fail.length);
if (fail.length) {
  fail.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✅ 全部通过');
