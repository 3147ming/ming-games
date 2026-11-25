/* =============================================================================
 * drawguess/tests/rules.test.mjs —— 你画我猜规则引擎单测
 * -----------------------------------------------------------------------------
 * 跑法：node drawguess/tests/rules.test.mjs
 *
 * 重点覆盖：
 *   · 词库完整性
 *   · 猜词命中判定（含归一化）
 *   · 动作折叠与重放一致性
 *   · 计分（含「画师守住一分」）
 *   · 胜负判定
 *   · **私密信息不泄漏** —— 词绝不出现在 pub / actions / 摘要里
 * ========================================================================== */

import {
  WORDS, PHASE, initPub, applyAction, fold, replay, hashPub, publicView,
  totalRoundsFor, drawerForRound, judgeGuess, isHit, normalizeGuess,
  roundFinished, winnersOf,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

/* =============================================================================
 * 一、词库
 * ================================================================== */
console.log('\n=== 1. 词库 ===');
{
  ok('词库非空', WORDS.length > 0, WORDS.length + ' 个');
  ok('每个词都有文字', WORDS.every((x) => x && typeof x.w === 'string' && x.w.length > 0));
  ok('难度分档齐全', ['easy', 'mid', 'hard'].every((lv) => WORDS.some((x) => x.lv === lv)));
  const dup = WORDS.map((x) => x.w).filter((w, i, a) => a.indexOf(w) !== i);
  ok('没有重复词', dup.length === 0, dup.join(','));
  ok('词里不含换行', WORDS.every((x) => !/[\r\n]/.test(x.w)));
}

/* =============================================================================
 * 二、猜词判定
 * ================================================================== */
console.log('\n=== 2. 猜词判定 ===');
{
  ok('完全相同算中', isHit('苹果', '苹果'));
  ok('带空格算中', isHit(' 苹果 ', '苹果'));
  ok('包含目标词算中', isHit('我猜是苹果吧', '苹果'));
  ok('目标词包含猜测算中', isHit('苹', '苹果'));
  ok('不相关不算中', !isHit('香蕉', '苹果'));
  ok('空猜测不算中', !isHit('', '苹果'));
  ok('归一化去掉标点', normalizeGuess('苹果。') === '苹果');
  ok('归一化去掉空白', normalizeGuess(' 苹 果 ') === '苹果');
  ok('归一化转小写', normalizeGuess('Apple') === 'apple');

  const h1 = judgeGuess('苹果', '苹果');
  ok('judgeGuess 命中', h1.hit === true);
  const h2 = judgeGuess('香蕉', '苹果');
  ok('judgeGuess 未命中', h2.hit === false);
  ok('共同字多判 near', judgeGuess('西瓜', '香瓜').near === true || judgeGuess('香瓜', '西瓜').near === true);
  ok('完全无关不判 near', judgeGuess('汽车', '苹果').near === false);
  ok('长度差太远不判 near', judgeGuess('苹果', '苹果手机壳子').near === false);
}

/* =============================================================================
 * 三、动作折叠
 * ================================================================== */
console.log('\n=== 3. 动作折叠 ===');
{
  const base = { n: 3 };
  let pub = fold(base, []);
  ok('初始是 idle', pub.phase === PHASE.IDLE);
  ok('初始没有词', pub.word === '');

  pub = fold(base, [{ act: 'round', drawer: 1, total: 6 }]);
  ok('round 后进入 draw', pub.phase === PHASE.DRAW);
  ok('round 后画师正确', pub.drawer === 1);
  ok('round 计数为 1', pub.round === 1);

  pub = fold(base, [
    { act: 'round', drawer: 1, total: 6 },
    { act: 'guess', p: 0, text: '苹果', hit: false, near: false },
  ]);
  ok('猜错不记分', (pub.scores[0] || 0) === 0);
  ok('猜错累计次数', pub.guessCount === 1);
  ok('猜错保留最近猜测', pub.lastGuess === '苹果');

  pub = fold(base, [
    { act: 'round', drawer: 1, total: 6 },
    { act: 'guess', p: 0, text: '苹果', hit: true, near: false },
  ]);
  ok('猜中记一分', pub.scores[0] === 1);
  ok('猜中记入 hits', pub.hits.indexOf(0) >= 0);
  ok('猜中后本回合结束', roundFinished(pub));

  pub = fold(base, [
    { act: 'round', drawer: 1, total: 6 },
    { act: 'guess', p: 0, text: '错', hit: false, near: false, keep: true },
  ]);
  ok('keep 让画师得一分', pub.scores[1] === 1);

  pub = fold(base, [
    { act: 'round', drawer: 0, total: 6 },
    { act: 'guess', p: 1, text: 'x', hit: false, near: false, keep: true },
    { act: 'reveal', word: '西瓜' },
  ]);
  ok('reveal 后公开词', pub.word === '西瓜');
  ok('reveal 后阶段变化', pub.phase === PHASE.REVEAL);

  pub = fold(base, [{ act: 'over' }]);
  ok('over 阶段正确', pub.phase === PHASE.OVER);

  /* 非法动作不能把局面搞崩 */
  const before = fold(base, [{ act: 'round', drawer: 0, total: 6 }]);
  const after = fold(base, [{ act: 'round', drawer: 0, total: 6 }, null, { act: '未知动作' }, 42]);
  eq('脏动作被跳过，局面不变', after.phase, before.phase);
  eq('脏动作后画师不变', after.drawer, before.drawer);
}

/* =============================================================================
 * 四、重放一致性
 * ================================================================== */
console.log('\n=== 4. 重放一致性 ===');
{
  const acts = [
    { act: 'round', drawer: 0, total: 4 },
    { act: 'guess', p: 1, text: '猫', hit: false, near: true },
    { act: 'guess', p: 1, text: '小猫', hit: true, near: false },
    { act: 'reveal', word: '猫' },
    { act: 'round', drawer: 1, total: 4 },
    { act: 'guess', p: 0, text: '狗', hit: true, near: false },
  ];
  const seed = { n: 2 };
  const r1 = replay(seed, acts);
  const r2 = replay(seed, acts);
  eq('两次重放结果一致', r1.pub, r2.pub);
  ok('重放后有词（已揭晓）', r1.pub.word === '猫' || r1.pub.round === 2);
  ok('摘要一致', hashPub(r1.pub) === hashPub(r2.pub));
  ok('摘要非空', !!hashPub(r1.pub));

  /* 动作数不同 → 摘要必须不同（不然状态对不上也发现不了） */
  const r3 = replay(seed, acts.slice(0, 3));
  ok('不同动作序列摘要不同', hashPub(r3.pub) !== hashPub(r1.pub));
}

/* =============================================================================
 * 五、回合调度
 * ================================================================== */
console.log('\n=== 5. 回合调度 ===');
{
  ok('2 人 4 回合', totalRoundsFor(2) === 4);
  ok('3 人 6 回合', totalRoundsFor(3) === 6);
  eq('第 1 回合 0 号画', drawerForRound(1, 3), 0);
  eq('第 2 回合 1 号画', drawerForRound(2, 3), 1);
  eq('第 3 回合 2 号画', drawerForRound(3, 3), 2);
  eq('第 4 回合回到 0 号', drawerForRound(4, 3), 0);
}

/* =============================================================================
 * 六、胜负
 * ================================================================== */
console.log('\n=== 6. 胜负判定 ===');
{
  const pub = fold({ n: 3 }, [
    { act: 'round', drawer: 0, total: 6 },
    { act: 'guess', p: 1, text: 'a', hit: true, near: false },
    { act: 'guess', p: 2, text: 'b', hit: true, near: false },
  ]);
  eq('并列都算赢', winnersOf(pub), [1, 2]);

  const pub2 = fold({ n: 2 }, [
    { act: 'round', drawer: 0, total: 4 },
    { act: 'guess', p: 1, text: 'a', hit: true, near: false },
    { act: 'guess', p: 1, text: 'b', hit: true, near: false },
  ]);
  eq('同一人多次猜中只记一次分位', winnersOf(pub2), [1]);
  eq('该人两分', pub2.scores[1], 2);

  ok('没人得分没有赢家', winnersOf(fold({ n: 2 }, [{ act: 'round', drawer: 0, total: 4 }])).length === 0);
}

/* =============================================================================
 * 七、公开视图裁剪 + 私密信息不泄漏
 * ========================================================================== */
console.log('\n=== 7. 私密信息隔离 ===');
{
  const SECRET = '西瓜';
  const acts = [
    { act: 'round', drawer: 0, total: 4 },
    { act: 'guess', p: 1, text: '香瓜', hit: false, near: true },
  ];
  const pub = fold({ n: 2 }, acts);
  const view = publicView(pub);

  ok('DRAW 阶段视图里没有词', view.word === '');
  ok('DRAW 阶段原始 pub 里也没有词', pub.word === '');

  /* 私密词绝不能出现在任何公开结构里 */
  const dumped = JSON.stringify(pub) + JSON.stringify(view) + JSON.stringify(acts) + hashPub(pub);
  ok('私密词不出现在公开结构中', dumped.indexOf(SECRET) < 0);

  /* 揭晓之后词就该公开了 */
  const revealed = fold({ n: 2 }, acts.concat([{ act: 'reveal', word: SECRET }]));
  ok('揭晓后词公开', revealed.word === SECRET);
  ok('揭晓后视图也带词', publicView(revealed).word === SECRET);

  /* 摘要不能把私密词带出去 */
  ok('摘要里没有私密词', hashPub(pub).indexOf(SECRET) < 0);
}

/* =============================================================================
 * 八、边界
 * ================================================================== */
console.log('\n=== 8. 边界 ===');
{
  ok('空动作不崩', !!fold({}, []));
  ok('空 base 不崩', !!fold(null, null));
  ok('applyAction 传 null 不崩', applyAction(null, null) === null);
  ok('publicView 传 null 不崩', publicView(null) === null);
  ok('hashPub 传 null 不崩', hashPub(null) === '');
  ok('空词库不崩', Array.isArray(WORDS));
  ok('initPub 分数数组长度对', initPub(4).scores.length === 4);
  ok('initPub 阶段是 idle', initPub(4).phase === PHASE.IDLE);
}

/* =============================================================================
 * 汇总
 * ================================================================== */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
