/* =============================================================================
 * liar/tests/rules.test.mjs —— 吹牛骰子规则引擎单测
 * -----------------------------------------------------------------------------
 * 跑法：node liar/tests/rules.test.mjs
 *
 * 重点覆盖：
 *   · 承诺哈希：同一份骰子算出来一样，改一颗就对不上
 *   · 叫牌合法性（必须比上一手大）
 *   · 万能点（1 点算任意点数）
 *   · 质疑结算（撒谎 / 没撒谎，掉骰的是谁）
 *   · 揭示校验（点数对不上 / 数量对不上 → 判定作弊）
 *   · 掉骰后承诺作废、重新承诺
 *   · 胜负判定
 *   · **私密信息不泄漏** —— 骰子点数绝不进公开局面与动作序列
 * ========================================================================== */

import {
  PHASE, initPub, applyAction, fold, replay, hashPub, publicView,
  bidOK, totalDice, nextSeat, allCommitted, countValue,
  commitHash, makeSalt, rollDice, verifyReveal, resolveDoubt,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

/* =============================================================================
 * 一、承诺哈希
 * ========================================================================== */
console.log('\n=== 1. 承诺哈希 ===');
{
  const salt = makeSalt();
  ok('salt 非空', !!salt);
  ok('salt 有一定长度', salt.length >= 8);
  ok('两次 salt 不同', makeSalt() !== makeSalt());

  const dice = [3, 5, 1];
  const h1 = commitHash(salt, dice);
  const h2 = commitHash(salt, dice);
  ok('同一份骰子哈希一致', h1 === h2);
  ok('哈希非空', !!h1);

  /* 改一颗骰子 → 哈希必须变（这是承诺的意义所在） */
  const changed = [3, 5, 2];
  ok('改一颗骰子哈希就变', commitHash(salt, changed) !== h1);

  /* 换 salt → 哈希也变 */
  ok('换 salt 哈希就变', commitHash(makeSalt(), dice) !== h1);

  /* 顺序不同 → 哈希不同 */
  ok('骰子顺序不同哈希不同', commitHash(salt, [1, 3, 5]) !== commitHash(salt, [3, 1, 5]));

  /* 空骰子 */
  ok('空骰子也能算哈希', typeof commitHash(salt, []) === 'string');
}

/* =============================================================================
 * 二、叫牌合法性
 * ========================================================================== */
console.log('\n=== 2. 叫牌合法性 ===');
{
  ok('首轮任何牌都合法', bidOK(null, 3, 5, 6));
  ok('数量更大合法', bidOK({ n: 2, v: 3, p: 0 }, 3, 2, 6));
  ok('数量相同点数更大合法', bidOK({ n: 2, v: 3, p: 0 }, 2, 4, 6));
  ok('数量相同点数相同不合法', !bidOK({ n: 2, v: 3, p: 0 }, 2, 3, 6));
  ok('数量更小不合法', !bidOK({ n: 3, v: 2, p: 0 }, 2, 6, 6));
  ok('数量不能小于 1', !bidOK(null, 0, 3, 6));
  ok('点数必须在 2~6', !bidOK(null, 2, 1, 6));
  ok('点数不能超过 6', !bidOK(null, 2, 7, 6));
  ok('不能超过全场骰子总数', !bidOK(null, 7, 3, 6));
}

/* =============================================================================
 * 三、点数统计（1 是万能）
 * ========================================================================== */
console.log('\n=== 3. 点数统计 ===');
{
  /* 没有万能点的情况：好数 */
  const plain = [[3, 3, 5], [6, 2, 4]];
  ok('数 3 点', countValue(plain, 3) === 2, String(countValue(plain, 3)));
  ok('数 6 点', countValue(plain, 6) === 1, String(countValue(plain, 6)));
  ok('数 5 点', countValue(plain, 5) === 1, String(countValue(plain, 5)));
  ok('数 4 点', countValue(plain, 4) === 1, String(countValue(plain, 4)));
  ok('数 1 点（就按 1 数）', countValue(plain, 1) === 0, String(countValue(plain, 1)));

  /* 1 点是万能：算任意点数时都计入 */
  const wild = [[3, 1, 5], [6, 2, 1]];
  ok('万能点计入 3 点', countValue(wild, 3) === 3, String(countValue(wild, 3)));
  ok('万能点计入 6 点', countValue(wild, 6) === 3, String(countValue(wild, 6)));
  ok('万能点计入 5 点', countValue(wild, 5) === 3, String(countValue(wild, 5)));
  ok('万能点计入 2 点', countValue(wild, 2) === 3, String(countValue(wild, 2)));
  ok('万能点计入 4 点', countValue(wild, 4) === 2, String(countValue(wild, 4)));
  ok('空数组统计为 0', countValue([], 3) === 0);
}

/* =============================================================================
 * 四、质疑结算
 * ========================================================================== */
console.log('\n=== 4. 质疑结算 ===');
{
  /* 上家叫「3 颗 4 点」，实际只有 2 颗 4 点 → 上家撒谎，上家掉骰 */
  const dice = [[4, 4, 2], [5, 6, 6]];
  const r1 = resolveDoubt(dice, { n: 3, v: 4, p: 0 }, 1);
  ok('实际统计正确', r1.actual === 2, String(r1.actual));
  ok('判定上家撒谎', r1.liar === true);
  ok('撒谎则上家掉骰', r1.loser === 0, String(r1.loser));

  /* 上家叫「2 颗 4 点」，实际有 2 颗 → 够数，质疑失败，质疑者掉骰 */
  const r2 = resolveDoubt(dice, { n: 2, v: 4, p: 0 }, 1);
  ok('实际够数', r2.actual === 2, String(r2.actual));
  ok('没撒谎', r2.liar === false);
  ok('质疑失败则质疑者掉骰', r2.loser === 1, String(r2.loser));

  /* 万能点救了上家：叫「3 颗 4 点」，实际 2 颗 4 点 + 1 颗万能 = 3 颗 → 不撒谎 */
  const r3 = resolveDoubt([[4, 4, 1], [5, 6, 6]], { n: 3, v: 4, p: 0 }, 1);
  ok('万能点算进实际点数', r3.actual === 3, String(r3.actual));
  ok('有万能点就不算撒谎', r3.liar === false);
  ok('质疑者掉骰', r3.loser === 1, String(r3.loser));
}

/* =============================================================================
 * 五、揭示校验（防作弊）
 * ========================================================================== */
console.log('\n=== 5. 揭示校验 ===');
{
  const salt = makeSalt();
  const dice = [3, 5, 1];
  const commit = commitHash(salt, dice);

  const v1 = verifyReveal(salt, dice, commit, 3);
  ok('如实揭示通过', v1.ok === true, v1.reason);

  const v2 = verifyReveal(salt, [3, 5, 2], commit, 3);
  ok('换了骰子被拦下', v2.ok === false);
  ok('拦截理由提到承诺', v2.reason.indexOf('承诺') >= 0, v2.reason);

  const v3 = verifyReveal(salt, [3, 5], commit, 3);
  ok('数量不对被拦下', v3.ok === false);

  const v4 = verifyReveal(salt, [3, 5, 9], commit, 3);
  ok('点数越界被拦下', v4.ok === false);

  const v5 = verifyReveal(salt, dice, '', 3);
  ok('没有承诺被拦下', v5.ok === false);

  const v6 = verifyReveal(salt, 'notarray', commit, 3);
  ok('格式不对被拦下', v6.ok === false);
}

/* =============================================================================
 * 六、局面折叠
 * ========================================================================== */
console.log('\n=== 6. 局面折叠 ===');
{
  const base = { n: 2, dicePerPlayer: 3 };
  let pub = fold(base, []);
  ok('初始是 commit 阶段', pub.phase === PHASE.COMMIT);
  ok('初始每人 3 颗骰', pub.counts[0] === 3 && pub.counts[1] === 3);

  /* 两边都提交承诺 → 进叫牌 */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
  ]);
  ok('承诺齐了进叫牌阶段', pub.phase === PHASE.BID);
  ok('轮次 +1', pub.round === 1);
  ok('承诺值公开', pub.commits[0] === 'aaa' && pub.commits[1] === 'bbb');

  /* 承诺数与自己的骰子数不符 → 忽略（防止塞假承诺） */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 1, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
  ]);
  ok('颗数不符的承诺被忽略', pub.commits[0] === '');

  /* 叫牌 */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'bid', p: 0, n: 2, v: 4 },
  ]);
  ok('叫牌记录了内容', pub.lastBid && pub.lastBid.n === 2 && pub.lastBid.v === 4);
  ok('叫牌后轮到下一个', pub.turn === 1);

  /* 质疑 → 进入揭示阶段 */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'bid', p: 0, n: 2, v: 4 },
    { act: 'doubt', p: 1 },
  ]);
  ok('质疑后进入揭示阶段', pub.phase === PHASE.REVEAL);
  ok('记录了质疑者', pub.doubter === 1);

  /* 首轮不能质疑（没有 lastBid） */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'doubt', p: 1 },
  ]);
  ok('没有上家时质疑无效', pub.phase === PHASE.BID);

  /* 结算：上家撒谎 → 上家掉骰 */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'bid', p: 0, n: 3, v: 4 },
    { act: 'doubt', p: 1 },
    { act: 'resolve', p: 1, actual: 1, liar: true, loser: 0, dice: [[4, 2, 3], [1, 6, 6]], counts: [3, 3] },
  ]);
  ok('结算后掉骰', pub.counts[0] === 2 && pub.counts[1] === 3);
  ok('撒谎的人掉骰', pub.loser === 0);
  ok('记录了实际点数', pub.actual === 1);
  ok('掉骰的人承诺作废', pub.commits[0] === '');
  ok('掉骰后回到承诺阶段', pub.phase === PHASE.COMMIT);

  /* 骰子掉光 → 出局 + 结束。
     注意 commits 的 count 必须跟当前 counts 一致 —— 否则承诺会被判非法。
     所以这里先用 3 颗开局，resolve 时把 counts 改成 [1,3] 表示只剩 1 颗。 */
  pub = fold(base, [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'bid', p: 0, n: 1, v: 4 },
    { act: 'doubt', p: 1 },
    { act: 'resolve', p: 1, actual: 0, liar: true, loser: 0, dice: [[2], [1, 6, 6]], counts: [1, 3] },
  ]);
  ok('骰子掉光即出局', pub.out[0] === true);
  ok('只剩一人时游戏结束', pub.phase === PHASE.OVER);
  ok('胜者是存活的那个', pub.winner === 1, String(pub.winner));

  /* 脏动作跳过 */
  const before = fold(base, [{ act: 'commit', p: 0, count: 3, commit: 'aaa' }]);
  const after = fold(base, [{ act: 'commit', p: 0, count: 3, commit: 'aaa' }, null, { act: '瞎写' }, 7]);
  eq('脏动作不改变局面', after.commits[0], before.commits[0]);
  eq('脏动作后阶段不变', after.phase, before.phase);
}

/* =============================================================================
 * 七、重放一致性
 * ========================================================================== */
console.log('\n=== 7. 重放一致性 ===');
{
  const acts = [
    { act: 'commit', p: 0, count: 3, commit: 'aaa' },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'bid', p: 0, n: 2, v: 4 },
    { act: 'bid', p: 1, n: 3, v: 4 },
    { act: 'doubt', p: 0 },
    { act: 'resolve', p: 0, actual: 2, liar: true, loser: 1, dice: [[4, 2, 3], [6, 6, 6]], counts: [3, 3] },
  ];
  const seed = { n: 2 };
  const r1 = replay(seed, acts);
  const r2 = replay(seed, acts);
  eq('两次重放一致', r1.pub, r2.pub);
  ok('摘要一致', hashPub(r1.pub) === hashPub(r2.pub));
  ok('不同序列摘要不同', hashPub(replay(seed, acts.slice(0, 3)).pub) !== hashPub(r1.pub));
}

/* =============================================================================
 * 八、私密信息不泄漏
 * ========================================================================== */
console.log('\n=== 8. 私密信息不泄漏 ===');
{
  /* 关键：骰子点数只存在于 reveal 消息里，绝不能出现在权威动作序列中。
     动作序列里只有承诺值（哈希），不含点数。 */
  const secretDice = [6, 6, 6];
  const salt = makeSalt();
  const commit = commitHash(salt, secretDice);
  const acts = [
    { act: 'commit', p: 0, count: 3, commit: commit },
    { act: 'commit', p: 1, count: 3, commit: 'bbb' },
    { act: 'bid', p: 0, n: 2, v: 4 },
  ];
  const dumped = JSON.stringify(acts) + JSON.stringify(fold({ n: 2 }, acts));
  ok('动作序列里没有点数', dumped.indexOf('"6"') < 0);
  ok('动作序列里只有承诺值', dumped.indexOf(commit) >= 0);

  /* 承诺值不能反推出点数 —— 不同骰子给出不同哈希 */
  const other = commitHash(salt, [1, 2, 3]);
  ok('不同骰子不同承诺', other !== commit);

  /* REVEAL 阶段之前，视图里不能有骰子 */
  const pub = fold({ n: 2 }, acts);
  ok('揭示前视图里没有骰子', publicView(pub).dice.length === 0);
  ok('摘要里没有骰子点数', hashPub(pub).indexOf('dice') < 0);
}

/* =============================================================================
 * 九、辅助函数
 * ========================================================================== */
console.log('\n=== 9. 辅助函数 ===');
{
  const pub = fold({ n: 3, dicePerPlayer: 3 }, []);
  ok('totalDice 正确', totalDice(pub) === 9, String(totalDice(pub)));
  ok('nextSeat 跳过自己', nextSeat(pub, 0) === 1);
  eq('nextSeat 循环', nextSeat(pub, 2), 0);

  const p2 = fold({ n: 3, dicePerPlayer: 3 }, []);
  p2.out[1] = true;
  ok('totalDice 排除出局者', totalDice(p2) === 6, String(totalDice(p2)));
  ok('nextSeat 跳过出局者', nextSeat(p2, 0) === 2);

  ok('allCommitted 初始为假', allCommitted(fold({ n: 2 }, [])) === false);
  ok('rollDice 数量对', rollDice(4).length === 4);
  ok('rollDice 点数在 1~6', rollDice(20).every((d) => d >= 1 && d <= 6));
}

/* =============================================================================
 * 十、边界
 * ========================================================================== */
console.log('\n=== 10. 边界 ===');
{
  ok('fold 空 base 不崩', !!fold(null, null));
  ok('applyAction null 不崩', applyAction(null, null) === null);
  ok('publicView null 不崩', publicView(null) === null);
  ok('hashPub null 不崩', hashPub(null) === '');
  ok('initPub 分数位对', initPub(3, 3).counts.length === 3);
  ok('initPub 阶段对', initPub(3, 3).phase === PHASE.COMMIT);
  ok('总骰数不为负', totalDice({ counts: [0, 0], out: [false, false], n: 2 }) === 0);
}

/* =============================================================================
 * 汇总
 * ================================================================== */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
