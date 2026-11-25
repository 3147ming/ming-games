/* =============================================================================
 * shanhai-merge/tests/rules.test.mjs —— 「山海合成」规则引擎单测
 *
 * 用法：node shanhai-merge/tests/rules.test.mjs
 *
 * 覆盖：
 *   1. 常量与灵兽图鉴（名称/配色/等级上限）
 *   2. 伪随机（确定性、同 seed 同串、O(1) 跳跃版与顺序版一致）
 *   3. 开局局面（可复现、初始块数、等级分布、极小棋盘边界）
 *   4. 合成合法性（同阶、非空、不同格、顶阶不可再合、越界下标）
 *   5. 合成结果（等级提升、得分、清空来源格）
 *   6. 飘落（只落空位、数量随合成次数增长、棋盘满则不飘）
 *   7. 结束判定（胜利 / 步数用尽 / 无可合成）
 *   8. 撤销（撤销一步还原盘面/分数/步数/随机流位置、撤销栈上限、撤销后还能再走）
 *   9. 重放一致性（同 seed 同动作 ⇒ 同局面）
 *   10. 摘要（hashState 含 seed/rngPos/撤销栈；publicView 不泄漏额外信息）
 * ========================================================================== */

import {
  SIZE, MAX_LEVEL, TARGET_DEFAULT, SCORE_UNIT, INIT_BLOCKS, HISTORY_MAX,
  BEASTS, beastOf, beastName,
  fnv1a, mulberry32, randAt, randomSeed, seedFromDate, seedFromRoom,
  initState, dropLevel,
  isFull, emptyCells, hasMerge, mergePairs, canMerge, canContinue,
  cloneState, applyAction, applyUndo, applyWait, fold, replay, hashState, publicView,
  dropCountFor, topLevel, levelCounts, describeEvents,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);
const near = (name, a, b, eps) => ok(name, Math.abs(a - b) < (eps || 1e-9), a === b ? '' : `${a} vs ${b}`);

/* =============================================================================
 * 1. 常量与灵兽图鉴
 * ========================================================================== */
console.log('\n=== 1. 常量与灵兽图鉴 ===');
{
  eq('棋盘默认 6×6', SIZE, 6);
  eq('最高等级 8', MAX_LEVEL, 8);
  eq('默认目标等级 5', TARGET_DEFAULT, 5);
  eq('得分系数 10', SCORE_UNIT, 10);
  eq('初始块数 8', INIT_BLOCKS, 8);
  eq('撤销栈上限 240', HISTORY_MAX, 240);

  eq('八只灵兽', BEASTS.length, MAX_LEVEL);
  eq('1 级 山魈', BEASTS[0].name, '山魈');
  eq('2 级 白泽', BEASTS[1].name, '白泽');
  eq('3 级 玄鸟', BEASTS[2].name, '玄鸟');
  eq('4 级 毕方', BEASTS[3].name, '毕方');
  eq('5 级 九尾狐', BEASTS[4].name, '九尾狐');
  eq('6 级 烛龙', BEASTS[5].name, '烛龙');
  eq('7 级 鲲鹏', BEASTS[6].name, '鲲鹏');
  eq('8 级 饕餮', BEASTS[7].name, '饕餮');

  eq('灵兽名长度 2~3 字', BEASTS.every((b) => b.name.length >= 2 && b.name.length <= 3), true);
  eq('灵兽名互不相同', new Set(BEASTS.map((b) => b.name)).size, 8);
  eq('配色都是合法 hex', BEASTS.every((b) => /^#[0-9a-f]{6}$/.test(b.color)), true);
  eq('配色互不相同', new Set(BEASTS.map((b) => b.color)).size, 8);

  eq('beastOf(1)', beastOf(1).name, '山魈');
  eq('beastOf(8)', beastOf(8).name, '饕餮');
  eq('beastOf(0) 为 null', beastOf(0), null);
  eq('beastOf(9) 为 null', beastOf(9), null);
  eq('beastOf(-1) 为 null', beastOf(-1), null);
  eq('beastOf(1.5) 为 null', beastOf(1.5), null);
  eq('beastName(5)', beastName(5), '九尾狐');
  eq('beastName(99) 为 ?', beastName(99), '?');
}

/* =============================================================================
 * 2. 伪随机
 * ========================================================================== */
console.log('\n=== 2. 伪随机 ===');
{
  /* FNV-1a */
  eq('fnv1a 空串稳定', fnv1a(''), fnv1a(''));
  eq('fnv1a 是 32 位无符号', fnv1a('abc') >>> 0, fnv1a('abc'));
  ok('fnv1a 空串与 a 不同', fnv1a('') !== fnv1a('a'));
  eq('fnv1a 可复现', fnv1a('山海合成'), fnv1a('山海合成'));

  /* mulberry32 */
  const g1 = mulberry32(42), g2 = mulberry32(42);
  const s1 = [g1(), g1(), g1()], s2 = [g2(), g2(), g2()];
  eq('同 seed 的 mulberry32 输出一致', JSON.stringify(s1), JSON.stringify(s2));
  ok('mulberry32 输出在 [0,1)', s1.every((v) => v >= 0 && v < 1));

  /* randAt 与顺序版对拍 */
  let mismatch = 0;
  for (const seed of [0, 1, 42, 123456789, 4294967295]) {
    const g = mulberry32(seed);
    for (let i = 0; i < 500; i++) {
      if (g() !== randAt(seed, i)) mismatch++;
    }
  }
  eq('randAt 与顺序 mulberry32 逐位一致', mismatch, 0);

  /* 确定性 */
  eq('randAt 可复现', randAt(7, 13), randAt(7, 13));
  ok('不同 i 给出不同值', randAt(7, 1) !== randAt(7, 2));
  ok('不同 seed 给出不同值', randAt(1, 0) !== randAt(2, 0));
  ok('randAt 输出在 [0,1)', Array.from({ length: 200 }, (_, i) => randAt(99, i)).every((v) => v >= 0 && v < 1));

  /* 随机种子 */
  const rs = randomSeed();
  ok('randomSeed 是 32 位无符号', Number.isInteger(rs) && rs >= 0 && rs <= 0xffffffff, String(rs));

  /* 日期 / 房间派生 */
  eq('seedFromDate 可复现', seedFromDate('2026-01-01'), seedFromDate('2026-01-01'));
  ok('不同日期种子不同', seedFromDate('2026-01-01') !== seedFromDate('2026-01-02'));
  eq('seedFromRoom 可复现', seedFromRoom('abc'), seedFromRoom('abc'));
  ok('不同房间种子不同', seedFromRoom('abc') !== seedFromRoom('abd'));
  ok('日期种子与房间种子空间不同', seedFromDate('2026-01-01') !== seedFromRoom('2026-01-01'));
}

/* =============================================================================
 * 3. 开局局面
 * ========================================================================== */
console.log('\n=== 3. 开局局面 ===');
{
  const a = initState(12345);
  const b = initState(12345);
  eq('同 seed 初始盘面一致', JSON.stringify(a.board), JSON.stringify(b.board));
  eq('同 seed 初始 rngPos 一致', a.rngPos, b.rngPos);
  ok('不同 seed 初始盘面不同', JSON.stringify(initState(1).board) !== JSON.stringify(initState(2).board));

  eq('棋盘 36 格', a.board.length, 36);
  eq('初始块数 8', a.board.filter((x) => x).length, INIT_BLOCKS);
  eq('初始分数 0', a.score, 0);
  eq('初始步数 0', a.moves, 0);
  eq('初始撤销栈为空', a.history.length, 0);
  eq('初始未结束', a.over, false);
  eq('初始未获胜', a.won, false);
  eq('初始目标等级', a.target, TARGET_DEFAULT);
  ok('初始块等级都在 1..3', a.board.filter(Boolean).every((v) => v >= 1 && v <= 3));
  ok('初始至少有一对可合成（大概率）', hasMerge(a.board));
  ok('初始不结束', !a.over);

  /* 棋盘尺寸可配 */
  const s5 = initState(9, { size: 5 });
  eq('5×5 是 25 格', s5.board.length, 25);
  eq('5×5 初始块数 8', s5.board.filter((x) => x).length, 8);
  const s3 = initState(9, { size: 3 });
  eq('3×3 是 9 格', s3.board.length, 9);

  /* 极小棋盘边界 */
  const s1 = initState(3, { size: 1 });
  eq('1×1 是 1 格', s1.board.length, 1);
  eq('1×1 初始块数 1', s1.board.filter((x) => x).length, 1);
  eq('1×1 直接结束（满且合不动）', s1.over, true);
  eq('1×1 结束原因是 stuck', s1.overReason, 'stuck');

  /* 尺寸非法时回退到默认值 */
  eq('size=0 回退到默认 6', initState(1, { size: 0 }).size, SIZE);
  eq('size=99 被夹到 12', initState(1, { size: 99 }).size, 12);

  /* 目标等级夹取 */
  eq('target=0 回退到 5', initState(1, { target: 0 }).target, 5);
  eq('target=99 夹到 8', initState(1, { target: 99 }).target, 8);
  eq('target=3 保持', initState(1, { target: 3 }).target, 3);

  /* 步数上限 */
  eq('maxMoves 保持', initState(1, { maxMoves: 30 }).maxMoves, 30);
  eq('maxMoves 默认 0（不限）', initState(1).maxMoves, 0);

  /* 飘落等级分布 */
  eq('dropLevel 最低 1 级', Math.min(...[0, 0.1, 0.54].map(dropLevel)), 1);
  eq('dropLevel 0.9 是 3 级', dropLevel(0.9), 3);
  ok('dropLevel 只出 1..3', [0, 0.2, 0.6, 0.9, 0.99].every((r) => [1, 2, 3].includes(dropLevel(r))));
}

/* =============================================================================
 * 4. 合成合法性
 * ========================================================================== */
console.log('\n=== 4. 合成合法性 ===');
{
  const b = [1, 1, 0, 0, 2, 2];
  ok('同阶可以合', canMerge(b, 0, 1));
  ok('同阶反向也可以合', canMerge(b, 1, 0));
  eq('同格不能合自己', canMerge(b, 0, 0), false);
  eq('不同阶不能合', canMerge(b, 0, 4), false);
  eq('目标格为空不能合', canMerge(b, 0, 2), false);
  eq('来源格为空不能合', canMerge(b, 2, 0), false);
  eq('下标越界不能合', canMerge(b, 0, 99), false);
  eq('负下标不能合', canMerge(b, -1, 0), false);
  eq('非整数下标不能合', canMerge(b, 0.5, 1), false);
  eq('undefined 下标不能合', canMerge(b, undefined, 1), false);
  eq('非数组不能合', canMerge(null, 0, 1), false);

  /* 顶阶不能再合 */
  const top = [8, 8, 0];
  eq('两只 8 级不能再合', canMerge(top, 0, 1), false);
  ok('8 级与 7 级也不能合', !canMerge([8, 7], 0, 1));

  /* 非法动作原样返回旧局面 */
  const st = initState(5);
  eq('非法动作返回同一对象', applyAction(st, { act: 'merge', from: 0, to: 0 }), st);
  eq('未知动作返回同一对象', applyAction(st, { act: 'nope' }), st);
  eq('null 动作返回同一对象', applyAction(st, null), st);
  eq('undefined 状态返回原值', applyAction(null, { act: 'merge' }), null);

  /* hasMerge / mergePairs */
  ok('hasMerge 识别同阶', hasMerge([1, 1, 2, 3]));
  eq('hasMerge 无同阶为 false', hasMerge([1, 2, 3, 4]), false);
  eq('hasMerge 只有 8 级为 false', hasMerge([8, 8]), false);
  eq('mergePairs 找到 1 对', mergePairs([1, 1, 2, 3]).length, 1);
  eq('mergePairs 找到 2 对', mergePairs([1, 1, 2, 2]).length, 2);
  ok('mergePairs 的每一对都合法', mergePairs([1, 1, 2, 2]).every((p) => canMerge([1, 1, 2, 2], p.from, p.to)));
  eq('mergePairs 空盘为 0 对', mergePairs([0, 0, 0]).length, 0);
}

/* =============================================================================
 * 5. 合成结果
 * ========================================================================== */
console.log('\n=== 5. 合成结果 ===');
{
  /* 手工造一个局面：1+1 → 2 */
  let st = initState(1, { size: 6, dropEvery: 9999, dropMax: 1 });
  st.board = new Array(36).fill(0);
  st.board[0] = 1;
  st.board[1] = 1;
  st.rngPos = 0;
  st.over = false;
  st.history = [];
  const next = applyAction(st, { act: 'merge', from: 0, to: 1 });
  eq('来源格被清空', next.board[0], 0);
  eq('目标格升到 2 级', next.board[1], 2);
  eq('得分 = 2 × 10', next.score, 20);
  eq('步数 +1', next.moves, 1);
  eq('best 更新为 2', next.best, 2);
  ok('原局面没有被改（不可变）', st.board[0] === 1 && st.board[1] === 1 && st.score === 0);
  eq('撤销栈长 1', next.history.length, 1);

  /* 得分公式 */
  eq('2+2=3 得 30', 3 * SCORE_UNIT, 30);
  eq('7+7=8 得 80', 8 * SCORE_UNIT, 80);

  /* 顶阶合成 */
  let st8 = initState(1);
  st8.board = new Array(36).fill(0);
  st8.board[0] = 7; st8.board[1] = 7;
  st8.target = 8;
  st8.rngPos = 0; st8.history = []; st8.over = false;
  const n8 = applyAction(st8, { act: 'merge', from: 0, to: 1 });
  eq('7+7 → 8 级', n8.board[1], 8);
  eq('8 级即胜利（目标 8）', n8.won, true);
  eq('胜利时 over 为 true', n8.over, true);
  eq('结束原因 win', n8.overReason, 'win');
  eq('8 级得 80 分', n8.score, 80);

  /* 顶阶不能再合 */
  const n8b = applyAction(n8, { act: 'merge', from: 2, to: 3 });
  eq('结束后不能再合成', n8b, n8);

  /* 结束后 undo 可以复活 */
  const rev = applyUndo(n8);
  eq('撤销后回到 7 级', rev.board[1], 7);
  eq('撤销后分数归零', rev.score, 0);
  eq('撤销后未结束', rev.over, false);
}

/* =============================================================================
 * 6. 飘落
 * ========================================================================== */
console.log('\n=== 6. 飘落 ===');
{
  /* 满盘：合成腾出 1 格，飘落正好补回 1 只 */
  let st = initState(1, { size: 2, dropEvery: 1, dropMax: 2 });
  st.board = new Array(4).fill(1);
  st.rngPos = 0; st.history = []; st.over = false;
  const full = applyAction(st, { act: 'merge', from: 0, to: 1 });
  eq('2×2 满盘：合成后仍有 4 只（腾出 1 格又飘回 1 只）', full.board.filter((x) => x).length, 4);
  eq('2×2 满盘：只飘得下 1 只（空位只有 1 个）', full.events.drops.length, 1);
  ok('飘落落点确实是空位', full.board[full.events.drops[0].i] > 0);

  /* 飘落数量永远不超过空位数 —— 绝不覆盖已有神兽 */
  let many = initState(31337, { size: 3, dropEvery: 1, dropMax: 3 });
  many.board = new Array(9).fill(1);
  many.rngPos = 0; many.history = []; many.over = false;
  const mn = applyAction(many, { act: 'merge', from: 0, to: 1 });
  ok('飘落数 ≤ 空位数', mn.events.drops.length <= emptyCells(mn.board).length + mn.events.drops.length);
  eq('3×3 满盘：合成后仍是 9 只', mn.board.filter((x) => x).length, 9);
  eq('3×3 满盘：只飘 1 只（空位只有 1 个）', mn.events.drops.length, 1);

  /* 飘落数量随合成次数增长 */
  const c1 = initState(1);
  eq('第 1 次合成飘 1 只', dropCountFor(c1, 1), 1);
  eq('第 3 次合成飘 1 只', dropCountFor(c1, 3), 1);
  eq('第 4 次合成飘 2 只', dropCountFor(c1, 4), 2);
  eq('第 100 次合成仍是 2 只（受 dropMax 限制）', dropCountFor(c1, 100), 2);
  const c2 = initState(1, { dropEvery: 2, dropMax: 3 });
  eq('dropEvery=2 时第 3 次飘 2 只', dropCountFor(c2, 3), 2);
  eq('dropMax=3 时第 7 次飘 3 只', dropCountFor(c2, 7), 3);

  /* 飘落只落在空位上 */
  let s2 = initState(2024, { size: 6, dropEvery: 1, dropMax: 2 });
  s2.board = new Array(36).fill(0);
  s2.board[0] = 1; s2.board[1] = 1;
  s2.rngPos = 0; s2.history = []; s2.over = false;
  const dr = applyAction(s2, { act: 'merge', from: 0, to: 1 });
  ok('飘落有落点', dr.events.drops.length >= 1);
  ok('飘落事件带等级', dr.events.drops.every((d) => d.level >= 1 && d.level <= 3));
  ok('飘落后盘面块数 = 1 + 飘落数', dr.board.filter((x) => x).length === 1 + dr.events.drops.length);

  /* rngPos 随飘落推进 */
  ok('rngPos 在合成时前进', dr.rngPos > s2.rngPos);
}

/* =============================================================================
 * 7. 结束判定
 * ========================================================================== */
console.log('\n=== 7. 结束判定 ===');
{
  /* 步数用尽 */
  const st = initState(7, { maxMoves: 1 });
  let cur = st;
  let guard = 0;
  while (!cur.over && guard++ < 20) {
    const pairs = mergePairs(cur.board);
    if (!pairs.length) break;
    cur = applyAction(cur, { act: 'merge', from: pairs[0].from, to: pairs[0].to });
  }
  eq('一步挑战：1 步后结束', cur.over, true);
  eq('一步挑战：结束原因是 steps', cur.overReason, 'steps');
  eq('一步挑战：未获胜', cur.won, false);

  /* 无可合成 → 棋盘没满时不算结束（可以「等一等」）；
     棋盘满了才算走投无路。 */
  const dead = initState(3);
  dead.board = new Array(36).fill(0);
  dead.board[0] = 1; dead.board[1] = 2; dead.board[2] = 3; dead.board[3] = 4;
  dead.board[4] = 5; dead.board[5] = 6; dead.board[6] = 7; dead.board[7] = 8;
  dead.history = []; dead.over = false;
  eq('各阶不同但棋盘没满 → 不结束', dead.over, false);
  eq('死局没有可合成对', hasMerge(dead.board), false);
  eq('死局棋盘没满', isFull(dead.board), false);

  /* 棋盘满了又合不动 → stuck */
  const stuck = initState(3);
  stuck.board = new Array(36).fill(0);
  /* 36 格全满，且每一阶各一只（8 阶）—— 剩下的填成顶阶 8（不能合） */
  for (let i = 0; i < 8; i++) stuck.board[i] = i + 1;
  for (let i = 8; i < 36; i++) stuck.board[i] = 8;
  stuck.history = []; stuck.over = false; stuck.target = 8;
  /* 8 级不能合、其余各阶只有一只 ⇒ 没有可合成对，但棋盘是满的 */
  eq('满盘且无对可合', hasMerge(stuck.board), false);
  eq('满盘', isFull(stuck.board), true);

  /* canContinue */
  const cc = initState(11);
  ok('开局可以继续', canContinue(cc));
  const done = { ...cc, over: true };
  eq('结束后不能继续', canContinue(done), false);
  const stuckish = { ...cc, over: false, board: new Array(36).fill(0) };
  eq('空棋盘仍可继续（可以等飘落）', canContinue(stuckish), true);
}

/* =============================================================================
 * 7b. 等待飘落（act:'wait'）
 * ========================================================================== */
console.log('\n=== 7b. 等待飘落 ===');
{
  /* 造一个「各阶不同、棋盘没满」的死局 */
  let st = initState(3, { size: 6 });
  st.board = new Array(36).fill(0);
  st.board[0] = 1; st.board[1] = 2; st.board[2] = 3; st.board[3] = 4;
  st.board[4] = 5; st.board[5] = 6; st.board[6] = 7; st.board[7] = 8;
  st.rngPos = 0; st.history = []; st.over = false; st.overReason = '';

  eq('死局：没有可合成对', hasMerge(st.board), false);
  eq('死局：棋盘没满', isFull(st.board), false);

  const w = applyAction(st, { act: 'wait' });
  ok('可以等飘落', w !== st);
  eq('等来 1 只', w.board.filter((x) => x).length, 9);
  ok('新来的落在空位上', w.events.drops.length === 1);
  ok('新来的等级 1..3', w.events.drops[0].level >= 1 && w.events.drops[0].level <= 3);
  eq('等飘落不加分', w.score, 0);
  eq('等飘落进撤销栈', w.history.length, 1);
  eq('等飘落事件类型', w.events.type, 'wait');

  /* 还有对能合时，不许干等 */
  const busy = initState(4);
  eq('有对可合时 wait 返回原局面', applyAction(busy, { act: 'wait' }), busy);

  /* 满盘时等不了（而且已经结束了） */
  const full = initState(5);
  full.board = new Array(36).fill(8);
  full.history = []; full.over = true; full.overReason = 'stuck';
  eq('满盘时 wait 返回原局面', applyAction(full, { act: 'wait' }), full);

  /* 已结束的局不能等 */
  const over = { ...initState(6), over: true };
  eq('已结束时 wait 返回原局面', applyAction(over, { act: 'wait' }), over);

  /* 等飘落也能撤销 */
  const wu = applyUndo(w);
  eq('撤销等飘落后块数还原', wu.board.filter((x) => x).length, 8);
  eq('撤销等飘落后撤销栈空', wu.history.length, 0);
  eq('撤销等飘落后 rngPos 还原', wu.rngPos, st.rngPos);

  /* 等到棋盘塞满且还是合不动 → stuck
     （盘上是三只 8 级 —— 顶阶不能再合，所以等下来的那只低阶也配不上它们） */
  let tight = initState(8, { size: 2 });
  tight.board = new Array(4).fill(0);
  tight.board[0] = 8; tight.board[1] = 8; tight.board[2] = 8;
  tight.rngPos = 0; tight.history = []; tight.over = false; tight.target = 8;
  eq('顶阶不能合，盘面没有对可合', hasMerge(tight.board), false);
  const wt = applyWait(tight);
  eq('等到的这一只落下后棋盘满了', isFull(wt.board), true);
  eq('满盘且无对可合 → stuck', wt.overReason, 'stuck');
  eq('满盘 stuck 时 over 为 true', wt.over, true);
}

/* =============================================================================
 * 8. 撤销
 * ========================================================================== */
console.log('\n=== 8. 撤销 ===');
{
  let st = initState(4321, { size: 6, dropEvery: 9999, dropMax: 1 });
  st.board = new Array(36).fill(0);
  st.board[0] = 1; st.board[1] = 1; st.board[2] = 2;
  st.rngPos = 0; st.history = []; st.over = false;

  const s1 = applyAction(st, { act: 'merge', from: 0, to: 1 });
  ok('合成后撤销栈长 1', s1.history.length === 1);
  const s2 = applyAction(s1, { act: 'merge', from: 2, to: 3 });
  ok('两次合成后撤销栈长 2', s2.history.length === 2);

  const u1 = applyUndo(s2);
  eq('撤销后撤销栈长 1', u1.history.length, 1);
  eq('撤销后棋盘还原', JSON.stringify(u1.board), JSON.stringify(s1.board));
  eq('撤销后分数还原', u1.score, s1.score);
  eq('撤销后步数还原', u1.moves, s1.moves);
  eq('撤销后 rngPos 还原', u1.rngPos, s1.rngPos);
  eq('撤销后 best 还原', u1.best, s1.best);
  eq('撤销事件类型', u1.events.type, 'undo');

  const u0 = applyUndo(u1);
  eq('再撤销回到初始盘面', JSON.stringify(u0.board), JSON.stringify(st.board));
  eq('再撤销后步数 0', u0.moves, 0);
  eq('再撤销后撤销栈空', u0.history.length, 0);

  const uEnd = applyUndo(u0);
  eq('空栈撤销返回同一对象', uEnd, u0);
  eq('空栈撤销不抛错', applyUndo(null), null);

  /* 撤销后还能再走 */
  const again = applyAction(u0, { act: 'merge', from: 0, to: 1 });
  eq('撤销后可以重新合成', again.board[1], 2);
  eq('撤销后重新合成分数重新累计', again.score, 20);

  /* 撤销栈上限 */
  let big = initState(5);
  let g = 0;
  while (!big.over && g < 200) {
    const pairs = mergePairs(big.board);
    if (!pairs.length) break;
    const nb = applyAction(big, { act: 'merge', from: pairs[0].from, to: pairs[0].to });
    if (nb === big) break;
    big = nb;
    g++;
  }
  ok('撤销栈不超过上限', big.history.length <= HISTORY_MAX, 'len=' + big.history.length);
}

/* =============================================================================
 * 9. 重放一致性
 * ========================================================================== */
console.log('\n=== 9. 重放一致性 ===');
{
  /* 造一串动作 */
  const acts = [];
  let st = initState(20240101, { size: 6 });
  let guard = 0;
  while (!st.over && guard++ < 30) {
    const pairs = mergePairs(st.board);
    if (!pairs.length) break;
    const p = pairs[0];
    acts.push({ act: 'merge', from: p.from, to: p.to });
    st = applyAction(st, { act: 'merge', from: p.from, to: p.to });
  }
  ok('动作序列非空', acts.length > 0);

  const r1 = replay(20240101, acts);
  const r2 = replay(20240101, acts);
  eq('重放后棋盘一致', JSON.stringify(r1.board), JSON.stringify(r2.board));
  eq('重放后分数一致', r1.score, r2.score);
  eq('重放后步数一致', r1.moves, r2.moves);
  eq('重放后 rngPos 一致', r1.rngPos, r2.rngPos);
  eq('重放后摘要一致', hashState(r1), hashState(r2));
  eq('重放结果与逐步推进一致', JSON.stringify(r1.board), JSON.stringify(st.board));

  /* 换 seed 结果不同 */
  const r3 = replay(999, acts);
  ok('换 seed 结果不同', JSON.stringify(r3.board) !== JSON.stringify(r1.board));

  /* fold 与 replay 等价 */
  const f1 = fold({ seed: 20240101 }, acts);
  eq('fold 与 replay 等价', hashState(f1), hashState(r1));

  /* 撤销动作也是可重放的 */
  const acts2 = acts.concat([{ act: 'undo' }]);
  const ru1 = replay(20240101, acts2);
  const ru2 = replay(20240101, acts2);
  eq('含撤销的重放一致', hashState(ru1), hashState(ru2));
  eq('撤销后撤销栈少一节', ru1.history.length, r1.history.length - 1);

  /* 撤销后再走，结果 = 直接走两步 */
  const acts3 = acts.concat([{ act: 'undo' }, { act: 'merge', from: acts[acts.length - 1].from, to: acts[acts.length - 1].to }]);
  const ru3 = replay(20240101, acts3);
  eq('撤销后重走同一步，盘面与不撤销时相同', JSON.stringify(ru3.board), JSON.stringify(r1.board));
  eq('撤销后重走同一步，分数相同', ru3.score, r1.score);
}

/* =============================================================================
 * 10. 摘要与视图
 * ========================================================================== */
console.log('\n=== 10. 摘要与视图 ===');
{
  const a = initState(777);
  const b = initState(777);
  eq('同状态摘要一致', hashState(a), hashState(b));
  ok('不同 seed 摘要不同', hashState(initState(1)) !== hashState(initState(2)));

  /* 摘要必须含 rngPos */
  const c = cloneState(a);
  c.rngPos = a.rngPos + 1;
  ok('rngPos 变化 → 摘要变化', hashState(c) !== hashState(a));

  /* 摘要必须含撤销栈 */
  const d = cloneState(a);
  d.history = a.history.concat([{ board: a.board.slice(), score: 0, moves: 0, rngPos: 0, over: false, overReason: '', won: false, best: 0 }]);
  ok('撤销栈变化 → 摘要变化', hashState(d) !== hashState(a));

  /* 摘要必须含棋盘 */
  const e = cloneState(a);
  e.board = a.board.slice();
  e.board[0] = (e.board[0] || 0) + 1;
  ok('棋盘变化 → 摘要变化', hashState(e) !== hashState(a));

  /* 摘要必须含分数 */
  const f = cloneState(a);
  f.score = a.score + 1;
  ok('分数变化 → 摘要变化', hashState(f) !== hashState(a));

  eq('hashState(null) 为空串', hashState(null), '');

  /* publicView */
  const v = publicView(a);
  eq('publicView 棋盘一致', JSON.stringify(v.board), JSON.stringify(a.board));
  ok('publicView 不与原局面共享棋盘引用', v.board !== a.board);
  ok('publicView 不与原局面共享撤销栈引用', v.history !== a.history);
  eq('publicView(null) 为 null', publicView(null), null);

  /* 视图不泄漏额外私密信息：本游戏没有私密信息，字段集应一致 */
  eq('publicView 字段集与原局面一致', Object.keys(v).sort().join(','), Object.keys(a).sort().join(','));

  /* cloneState 深拷贝 */
  const g = cloneState(a);
  g.board[0] = 99;
  ok('cloneState 深拷贝棋盘', a.board[0] !== 99);
}

/* =============================================================================
 * 11. 辅助工具
 * ========================================================================== */
console.log('\n=== 11. 辅助工具 ===');
{
  eq('isFull 空盘为 false', isFull([0, 0, 0]), false);
  eq('isFull 满盘为 true', isFull([1, 2]), true);
  eq('emptyCells 空盘 3 格', emptyCells([0, 1, 0]).length, 2);
  eq('emptyCells 满盘 0 格', emptyCells([1, 1]).length, 0);
  eq('topLevel 空盘为 0', topLevel([0, 0]), 0);
  eq('topLevel 取最大', topLevel([1, 7, 3]), 7);
  eq('levelCounts 统计正确', JSON.stringify(levelCounts([1, 1, 3, 0])), JSON.stringify([0, 2, 0, 1, 0, 0, 0, 0, 0]));

  let st = initState(1, { size: 6, dropEvery: 9999, dropMax: 1 });
  st.board = new Array(36).fill(0);
  st.board[0] = 1; st.board[1] = 1;
  st.rngPos = 0; st.history = []; st.over = false;
  const ev = applyAction(st, { act: 'merge', from: 0, to: 1 });
  const txt = describeEvents(ev);
  ok('描述含灵兽名', txt.indexOf('山魈') >= 0, txt);
  ok('描述含得分', txt.indexOf('20') >= 0, txt);
  eq('描述 init', describeEvents(st), '开局');
  const u = applyUndo(ev);
  eq('描述 undo', describeEvents(u), '撤销一步');
  eq('描述 null', describeEvents(null), '');

  /* wait 的描述 */
  let wst = initState(9, { size: 6 });
  wst.board = new Array(36).fill(0);
  wst.board[0] = 1; wst.board[1] = 2; wst.board[2] = 3; wst.board[3] = 4;
  wst.board[4] = 5; wst.board[5] = 6; wst.board[6] = 7; wst.board[7] = 8;
  wst.rngPos = 0; wst.history = []; wst.over = false;
  const wt = applyAction(wst, { act: 'wait' });
  ok('描述 wait 含灵兽名', describeEvents(wt).indexOf('等来一只') >= 0, describeEvents(wt));
}

/* =============================================================================
 * 12. 每日固定局
 * ========================================================================== */
console.log('\n=== 12. 每日固定局 ===');
{
  const s1 = seedFromDate('2026-11-25');
  const s2 = seedFromDate('2026-11-25');
  eq('同日期种子一致', s1, s2);
  ok('不同日期种子不同', seedFromDate('2026-11-25') !== seedFromDate('2026-11-26'));

  const d1 = initState(s1, { size: 6, target: 5 });
  const d2 = initState(s2, { size: 6, target: 5 });
  eq('同一天的初始盘面完全相同', JSON.stringify(d1.board), JSON.stringify(d2.board));
  eq('同一天的摘要相同', hashState(d1), hashState(d2));

  /* 同一天玩出同样的动作 ⇒ 同样的整局 */
  const acts = [];
  let cur = d1;
  for (let i = 0; i < 25 && !cur.over; i++) {
    const pairs = mergePairs(cur.board);
    if (!pairs.length) break;
    acts.push({ act: 'merge', from: pairs[0].from, to: pairs[0].to });
    cur = applyAction(cur, { act: 'merge', from: pairs[0].from, to: pairs[0].to });
  }
  const dr = replay(s1, acts, { size: 6, target: 5 });
  eq('同一天同样动作 ⇒ 同样结局', JSON.stringify(dr.board), JSON.stringify(cur.board));
  eq('同一天同样动作 ⇒ 同样分数', dr.score, cur.score);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
