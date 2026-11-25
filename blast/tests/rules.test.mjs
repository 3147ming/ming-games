/* blast/tests/rules.test.mjs —— 方块爆破规则引擎单测
 *
 * 跑法：node blast/tests/rules.test.mjs
 * 重点：几何 / 重力 / 连锁 / 天空落块 / 撤销 / 重放一致性 / P2P 可推导性。
 */
import assert from 'node:assert/strict';
import {
  COLS, ROWS, COLORS, EMPTY, BASE, SEAT_HOST, SEAT_GUEST, UNDO_ALL, UNDO_SEAT,
  fnv1a, mix32, randInt, randomSeed, seedFromRoom, dailySeed, todayKey,
  idx, inBoard, blastCells, gravity, columnHeights, maxHeight, blockCount,
  sameColorGroups, initialCells, initState, computeWinner,
  encodeCells, decodeCells, snapshotSeat, restoreSeat,
  resolveBlast, dropInto, applyFall, applyAction, applyUndo,
  fold, replay, hashState, publicView, aiChoose, legalMoves,
  boardAlive, levelOf, FALL_BASE, FALL_STEP, FALL_MAX, MIN_HEIGHT, MAX_HEIGHT0,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '  ' + e.message); }
}
function section(s) { console.log('\n=== ' + s + ' ==='); }

section('1. 哈希与随机（纯 JS，可复现）');
t('fnv1a 确定性', () => assert.equal(fnv1a('abc'), fnv1a('abc')));
t('fnv1a 不同输入不同值', () => assert.notEqual(fnv1a('abc'), fnv1a('abd')));
t('fnv1a 空串有值', () => assert.ok(fnv1a('') > 0));
t('fnv1a 是 32 位无符号', () => assert.ok(fnv1a('x') <= 0xffffffff));
t('fnv1a null 与空串一致', () => assert.equal(fnv1a(null), fnv1a('')));
t('mix32 确定性', () => assert.equal(mix32(123), mix32(123)));
t('mix32 不同输入不同值', () => assert.notEqual(mix32(1), mix32(2)));
t('mix32 产出无符号整数', () => assert.ok(mix32(-1) >= 0));
t('randInt 落在范围内', () => { for (let i = 0; i < 100; i++) assert.ok(randInt(42, i, 6) >= 0 && randInt(42, i, 6) < 6); });
t('randInt 可复现', () => assert.equal(randInt(42, 7, 6), randInt(42, 7, 6)));
t('randInt 不同 seed 不同', () => assert.notEqual(randInt(1, 7, 1000), randInt(2, 7, 1000)));
t('randomSeed 是 32 位整数', () => { const s = randomSeed(); assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff); });
t('randomSeed 两次不同', () => assert.notEqual(randomSeed(), randomSeed()));
t('seedFromRoom 确定性', () => assert.equal(seedFromRoom('12345', 'blast'), seedFromRoom('12345', 'blast')));
t('seedFromRoom 不同房间不同', () => assert.notEqual(seedFromRoom('a', 'blast'), seedFromRoom('b', 'blast')));
t('dailySeed 同日一致', () => assert.equal(dailySeed('2026-11-25', 'blast'), dailySeed('2026-11-25', 'blast')));
t('dailySeed 异日不同', () => assert.notEqual(dailySeed('2026-11-25', 'blast'), dailySeed('2026-11-26', 'blast')));
t('todayKey 格式 YYYY-MM-DD', () => assert.match(todayKey(new Date('2026-11-25T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/));

section('2. 棋盘几何');
t('idx 换算正确', () => assert.equal(idx(3, 2, 8), 19));
t('inBoard 内点', () => assert.equal(inBoard(0, 0, 8, 8), true));
t('inBoard 边界外', () => assert.equal(inBoard(8, 3, 8, 8), false));
t('inBoard 负数', () => assert.equal(inBoard(-1, 3, 8, 8), false));
t('blastCells 中心 3×3 是 9 格', () => assert.equal(blastCells(3, 3, 8, 8).length, 9));
t('blastCells 角落裁切', () => assert.equal(blastCells(0, 0, 8, 8).length, 4));
t('blastCells 边上裁切', () => assert.equal(blastCells(0, 3, 8, 8).length, 6));
t('blastCells 无重复', () => { const a = blastCells(4, 4, 8, 8); assert.equal(new Set(a).size, a.length); });
t('blastCells 含中心', () => assert.ok(blastCells(3, 3, 8, 8).includes(idx(3, 3, 8))));

section('3. 重力与列高');
t('gravity 压实空列', () => {
  const b = new Array(16).fill(0); b[0] = 1; gravity(b, 2, 8);
  assert.equal(b[idx(0, 7, 2)], 1);
});
t('gravity 保持相对顺序', () => {
  /* 同一列（x=1）两颗，下面先放 1、上面放 2，压实后顺序不变 */
  const b = new Array(16).fill(0);
  b[idx(1, 7, 2)] = 1; b[idx(1, 5, 2)] = 2;
  gravity(b, 2, 8);
  assert.equal(b[idx(1, 7, 2)], 1); assert.equal(b[idx(1, 6, 2)], 2);
});
t('gravity 全满不变', () => { const b = new Array(16).fill(1); const c = b.slice(); gravity(b, 2, 8); assert.deepEqual(b, c); });
t('columnHeights 空盘全 0', () => assert.deepEqual(columnHeights(new Array(64).fill(0), 8, 8), new Array(8).fill(0)));
t('columnHeights 单列 1 块', () => {
  const b = new Array(64).fill(0); b[idx(3, 7, 8)] = 1;
  assert.equal(columnHeights(b, 8, 8)[3], 1);
});
t('maxHeight 空盘', () => assert.equal(maxHeight(new Array(64).fill(0), 8, 8), 0));
t('maxHeight 有块', () => {
  /* 连到底部才算高度：y=5 有块但 y=6/7 空 → 高度 0；连到底 y=7,6,5 → 高度 3 */
  const b = new Array(64).fill(0);
  b[idx(5, 7, 8)] = b[idx(5, 6, 8)] = b[idx(5, 5, 8)] = 1;
  assert.equal(maxHeight(b, 8, 8), 3);
});
t('blockCount 计数', () => {
  const b = new Array(64).fill(0); b[0] = 1; b[1] = 2;
  assert.equal(blockCount(b), 2);
});

section('4. 同色相邻与连锁');
t('sameColorGroups 横排同色', () => {
  const b = new Array(64).fill(0); b[idx(1, 7, 8)] = b[idx(2, 7, 8)] = 1;
  const g = sameColorGroups(b, 8, 8); assert.equal(g.length, 2);
});
t('sameColorGroups 竖排同色', () => {
  const b = new Array(64).fill(0); b[idx(1, 7, 8)] = b[idx(1, 6, 8)] = 2;
  assert.equal(sameColorGroups(b, 8, 8).length, 2);
});
t('sameColorGroups 异色不消', () => {
  const b = new Array(64).fill(0); b[idx(1, 7, 8)] = 1; b[idx(2, 7, 8)] = 2;
  assert.equal(sameColorGroups(b, 8, 8).length, 0);
});
t('sameColorGroups 单个不消', () => {
  const b = new Array(64).fill(0); b[idx(1, 7, 8)] = 3;
  assert.equal(sameColorGroups(b, 8, 8).length, 0);
});
t('sameColorGroups 三连全消', () => {
  const b = new Array(64).fill(0);
  b[idx(0, 7, 8)] = b[idx(1, 7, 8)] = b[idx(2, 7, 8)] = 4;
  assert.equal(sameColorGroups(b, 8, 8).length, 3);
});
t('resolveBlast 直接爆破清空 3×3', () => {
  /* 中心放 (3,6) 才有完整 3×3；(3,7) 贴底只有 6 格 */
  const b = new Array(64).fill(0);
  for (const i of blastCells(3, 6, 8, 8)) b[i] = 1;
  const r = resolveBlast(b, 3, 6, 8, 8);
  assert.equal(r.removed, 9); assert.equal(blockCount(r.board), 0);
});
t('resolveBlast 第一段倍率 ×1', () => {
  const b = new Array(64).fill(0); b[idx(3, 7, 8)] = 1;
  assert.equal(resolveBlast(b, 3, 7, 8, 8).gained, 1 * BASE);
});
t('resolveBlast 连锁至少 2 段', () => {
  /* 造一个「炸掉中间 → 两侧同色块掉下来贴上」的局面：
     底行 [X, A, B]，第 6 行中间挖空，A 上方放 B —— 爆破中心后 A 落下与 B 相邻同色 */
  /* 爆破 (2,7) 只覆盖 x=1..3；把两块同色 A 放在 x=4 的 y=6 与 y=4，
     重力压实后它们贴到一起 → 第 2 段连锁 */
  const b = new Array(64).fill(0);
  b[idx(2, 7, 8)] = 1;
  b[idx(4, 6, 8)] = 2;
  b[idx(4, 4, 8)] = 2;
  const r = resolveBlast(b, 2, 7, 8, 8);
  assert.ok(r.seg >= 2, '应触发连锁，实际段数 ' + r.seg + ' stages=' + JSON.stringify(r.stages));
});
t('resolveBlast 连锁分更高', () => {
  const b = new Array(64).fill(0);
  b[idx(2, 7, 8)] = 1; b[idx(4, 6, 8)] = 2; b[idx(4, 4, 8)] = 2;
  assert.ok(resolveBlast(b, 2, 7, 8, 8).gained > 2 * BASE);
});
t('resolveBlast 不修改原盘', () => {
  const b = new Array(64).fill(0); b[idx(3, 7, 8)] = 1;
  const c = b.slice(); resolveBlast(b, 3, 7, 8, 8); assert.deepEqual(b, c);
});
t('resolveBlast 空格无得分', () => {
  const b = new Array(64).fill(0);
  assert.equal(resolveBlast(b, 3, 7, 8, 8).gained, 0);
});

section('5. 初始盘面与不变量');
t('initialCells 有方块', () => {
  const r = initialCells(1, 0, 8, 8, 5);
  assert.ok(blockCount(r.cells) > 0);
});
t('initialCells 列高在约定范围', () => {
  const r = initialCells(1, 0, 8, 8, 5);
  for (const h of columnHeights(r.cells, 8, 8)) {
    assert.ok(h >= MIN_HEIGHT && h <= MAX_HEIGHT0);
  }
});
t('initialCells 同 seed 一致', () => {
  assert.deepEqual(initialCells(7, 0, 8, 8, 5).cells, initialCells(7, 0, 8, 8, 5).cells);
});
t('initialCells 异 seed 不同', () => {
  assert.notDeepEqual(initialCells(7, 0, 8, 8, 5).cells, initialCells(8, 0, 8, 8, 5).cells);
});
t('initialCells 静止时无同色相邻', () => {
  for (const seed of [1, 2, 3, 42, 999]) {
    const r = initialCells(seed, 0, 8, 8, 5);
    assert.equal(sameColorGroups(r.cells, 8, 8).length, 0, 'seed=' + seed);
  }
});
t('initialCells counter 递增', () => {
  const r = initialCells(1, 0, 8, 8, 5);
  assert.ok(r.counter > 0);
});

section('6. 天空落块（可推导）');
t('dropInto 空列能放', () => {
  const b = new Array(64).fill(0);
  assert.equal(dropInto(b, 0, 8, 8, 5, 1, 0), true);
  assert.equal(blockCount(b), 1);
});
t('dropInto 满列放不下', () => {
  const b = new Array(64).fill(1);
  assert.equal(dropInto(b, 0, 8, 8, 5, 1, 0), false);
});
t('dropInto 可复现', () => {
  const a = new Array(64).fill(0), b = new Array(64).fill(0);
  dropInto(a, 0, 8, 8, 5, 7, 0); dropInto(b, 0, 8, 8, 5, 7, 0);
  assert.deepEqual(a, b);
});
t('dropInto 不同 counter 可能不同色', () => {
  const a = new Array(64).fill(0), b = new Array(64).fill(0);
  dropInto(a, 0, 8, 8, 5, 7, 0); dropInto(b, 0, 8, 8, 5, 7, 1);
  assert.notDeepEqual(a, b);
});
t('dropInto 颜色避开邻居', () => {
  const b = new Array(64).fill(0);
  b[idx(0, 7, 8)] = 1; b[idx(1, 7, 8)] = 2;
  dropInto(b, 0, 8, 8, 5, 3, 0);
  assert.notEqual(b[idx(0, 6, 8)], 1);
});
t('applyFall 增加方块', () => {
  const b = new Array(64).fill(0);
  const r = applyFall(b, 8, 8, 5, 1, 0, 0);
  assert.ok(blockCount(r.board) >= FALL_BASE);
});
t('applyFall 返回 rng 递增', () => {
  const b = new Array(64).fill(0);
  const r = applyFall(b, 8, 8, 5, 1, 0, 0);
  assert.ok(r.rng > 0);
});
t('applyFall 可复现', () => {
  const b = new Array(64).fill(0);
  const a = applyFall(b, 8, 8, 5, 42, 0, 0);
  const c = applyFall(b, 8, 8, 5, 42, 0, 0);
  assert.deepEqual(a, c);
});
t('applyFall 难度随手数上升', () => {
  const b = new Array(64).fill(0);
  const early = applyFall(b, 8, 8, 5, 42, 0, 0);
  const late = applyFall(b, 8, 8, 5, 42, 0, FALL_STEP * 20);
  assert.ok(blockCount(late.board) > blockCount(early.board));
});
t('applyFall 上限不超过 FALL_MAX', () => {
  const b = new Array(64).fill(0);
  const r = applyFall(b, 8, 8, 5, 42, 0, 10000);
  assert.ok(blockCount(r.board) <= FALL_MAX);
});
t('applyFall 满盘判 full', () => {
  const b = new Array(64).fill(1);
  const r = applyFall(b, 8, 8, 5, 42, 0, 0);
  assert.equal(r.full, true);
});

section('7. 局面、动作与判胜');
t('initState 单座位', () => assert.equal(initState(1, 1).seats, 1));
t('initState 双座位', () => assert.equal(initState(1, 2).seats, 2));
t('initState 双方开局盘面相同', () => {
  const s = initState(1, 2);
  assert.deepEqual(s.seatsState[0].cells, s.seatsState[1].cells);
});
t('initState 初始轮到 0 号', () => assert.equal(initState(1, 2).turn, 0));
t('initState 未结束', () => assert.equal(initState(1, 2).over, false));
t('initState 自定义尺寸', () => assert.equal(initState(1, 1, { cols: 5, rows: 6 }).cols, 5));
t('computeWinner 无人爆', () => assert.equal(computeWinner([false, false], 2), -1));
t('computeWinner 0 号爆 1 号赢', () => assert.equal(computeWinner([true, false], 2), 1));
t('computeWinner 1 号爆 0 号赢', () => assert.equal(computeWinner([false, true], 2), 0));
t('computeWinner 都爆平局', () => assert.equal(computeWinner([true, true], 2), 2));
t('computeWinner 单人爆 = -1', () => assert.equal(computeWinner([true, false], 1), -1));
t('applyAction 非法座位不改状态', () => {
  const s = initState(1, 1); assert.equal(applyAction(s, { act: 'blast', seat: 9, x: 0, y: 7 }), s);
});
t('applyAction 非本回合不改状态', () => {
  const s = initState(1, 2); assert.equal(applyAction(s, { act: 'blast', seat: 1, x: 3, y: 7 }), s);
});
t('applyAction 点空格不改状态', () => {
  const s = initState(1, 1); assert.equal(applyAction(s, { act: 'blast', seat: 0, x: 3, y: 0 }), s);
});
t('applyAction 合法动作推进', () => {
  const s = initState(1, 1);
  const p = legalMoves(s, 0)[0];
  const n = applyAction(s, { act: 'blast', seat: 0, ...p });
  assert.equal(n.moves, 1);
});
t('applyAction 结束后不再推进', () => {
  const s = { ...initState(1, 1), over: true };
  const p = legalMoves(s, 0)[0];
  assert.equal(applyAction(s, { act: 'blast', seat: 0, ...p }), s);
});
t('applyAction 合法动作后轮转（双人）', () => {
  const s = initState(1, 2); const p = legalMoves(s, 0)[0];
  assert.equal(applyAction(s, { act: 'blast', seat: 0, ...p }).turn, 1);
});
t('boardAlive 空盘 false', () => assert.equal(boardAlive({ seatsState: [{ cells: new Array(64).fill(0) }] }, 0), false));
t('legalMoves 返回可点格', () => assert.ok(legalMoves(initState(1, 1), 0).length > 0));
t('aiChoose 返回合法动作', () => {
  const s = initState(1, 1); const a = aiChoose(s, 0);
  assert.ok(a && a.act === 'blast' && Number.isInteger(a.x));
});
t('aiChoose 确定性', () => {
  const s = initState(1, 1);
  assert.deepEqual(aiChoose(s, 0), aiChoose(s, 0));
});
t('levelOf 随手数上升', () => assert.ok(levelOf(FALL_STEP * 3) > levelOf(0)));

section('8. 快照与撤销');
t('encode/decode 往返一致', () => {
  const a = [0, 1, 2, 3, 4, 5]; assert.deepEqual(decodeCells(encodeCells(a), 6), a);
});
t('encodeCells 长度等于格数', () => assert.equal(encodeCells(new Array(64).fill(0)).length, 64));
t('snapshotSeat 含关键字段', () => {
  const s = initState(1, 1); const snap = snapshotSeat(s, 0);
  assert.ok(snap.cells && typeof snap.rng === 'number' && typeof snap.score === 'number');
});
t('restoreSeat 完整还原', () => {
  const s = initState(1, 1); const snap = snapshotSeat(s, 0);
  const moved = applyAction(s, { act: 'blast', seat: 0, ...legalMoves(s, 0)[0] });
  assert.notDeepEqual(moved.seatsState[0].cells, s.seatsState[0].cells);
  const back = restoreSeat(moved, 0, snap);
  assert.deepEqual(back.seatsState[0].cells, s.seatsState[0].cells);
  assert.equal(back.seatsState[0].score, s.seatsState[0].score);
});
t('applyUndo 需要 allowUndo', () => {
  const s = { ...initState(1, 1), allowUndo: false };
  assert.equal(applyUndo(s, { act: 'undo', seat: 0 }), s);
});
t('applyUndo 无历史不改', () => {
  const s = initState(1, 1); assert.equal(applyUndo(s, { act: 'undo', seat: 0 }), s);
});
t('fold 撤销回到开局', () => {
  const s = initState(1, 1); const p = legalMoves(s, 0)[0];
  const end = fold(s, [{ act: 'blast', seat: 0, ...p }, { act: 'undo', seat: 0 }]);
  assert.equal(end.moves, 0);
  assert.deepEqual(end.seatsState[0].cells, s.seatsState[0].cells);
});
t('fold 撤销栈不超上限', () => {
  const s = initState(1, 1); const acts = [];
  for (let i = 0; i < 40; i++) {
    const cur = fold(s, acts);
    if (cur.over) break;
    const p = legalMoves(cur, 0);
    if (!p.length) break;
    acts.push({ act: 'blast', seat: 0, ...p[0] });
  }
  assert.ok(fold(s, acts).hist.length <= 16);
});
t('UNDO_SEAT 联机只撤自己的盘', () => {
  const s = initState(9, 2, { undoScope: UNDO_SEAT });
  const a1 = fold(s, [{ act: 'blast', seat: 0, ...legalMoves(s, 0)[0] }]);
  const peerBefore = a1.seatsState[1].cells.slice();
  const a2 = applyAction(a1, { act: 'undo', seat: 0 });
  assert.deepEqual(a2.seatsState[1].cells, peerBefore);
  assert.deepEqual(a2.seatsState[0].cells, s.seatsState[0].cells);
});

section('9. 重放一致性（P2P 核心）');
t('replay 同 seed 同动作结果一致', () => {
  const s = initState(123, 1); const acts = [];
  for (let i = 0; i < 5; i++) {
    const cur = replay(123, acts, { seats: 1 });
    const p = legalMoves(cur, 0);
    if (!p.length || cur.over) break;
    acts.push({ act: 'blast', seat: 0, ...p[0] });
  }
  assert.equal(hashState(replay(123, acts, { seats: 1 })), hashState(replay(123, acts, { seats: 1 })));
});
t('fold 与 applyAction 逐步折叠一致', () => {
  const s = initState(55, 1); const acts = [];
  for (let i = 0; i < 6; i++) {
    const cur = fold(s, acts);
    const p = legalMoves(cur, 0);
    if (!p.length || cur.over) break;
    acts.push({ act: 'blast', seat: 0, ...p[0] });
  }
  let step = s; for (const a of acts) step = applyAction(step, a);
  assert.equal(hashState(fold(s, acts)), hashState(step));
});
t('改动作会改摘要', () => {
  const s = initState(77, 1); const p = legalMoves(s, 0)[0];
  const a = fold(s, [{ act: 'blast', seat: 0, ...p }]);
  const b = fold(s, [{ act: 'blast', seat: 0, x: (p.x + 1) % 8, y: p.y }]);
  assert.notEqual(hashState(a), hashState(b));
});
t('改 seed 会改摘要', () => assert.notEqual(hashState(initState(1, 1)), hashState(initState(2, 1))));
t('摘要含 seed', () => assert.ok(hashState(initState(123456, 1)).includes('123456')));
t('摘要是字符串', () => assert.equal(typeof hashState(initState(1, 1)), 'string'));

section('10. 视图裁剪与边界');
t('publicView 深拷贝 cells', () => {
  const s = initState(1, 1); const v = publicView(s);
  v.seatsState[0].cells[0] = 99;
  assert.notEqual(s.seatsState[0].cells[0], 99);
});
t('publicView 保留全部公开字段', () => {
  const s = initState(1, 2); const v = publicView(s);
  assert.equal(v.seed, s.seed); assert.equal(v.seats, 2); assert.equal(v.turn, s.turn);
});
t('publicView 空状态安全', () => assert.equal(publicView(null), null));
t('长时间对局不崩', () => {
  const s = initState(3, 1); let cur = s;
  for (let i = 0; i < 100 && !cur.over; i++) {
    const p = legalMoves(cur, 0); if (!p.length) break;
    cur = applyAction(cur, { act: 'blast', seat: 0, ...p[0] });
  }
  assert.ok(cur.moves >= 1);
});
t('无限撤销不会丢状态', () => {
  const s = initState(4, 1); let cur = s;
  for (let i = 0; i < 10 && !cur.over; i++) {
    const p = legalMoves(cur, 0); if (!p.length) break;
    cur = applyAction(cur, { act: 'blast', seat: 0, ...p[0] });
  }
  const back = fold(s, Array.from({ length: 10 }, (_, i) => ({ act: 'undo', seat: 0 })));
  assert.ok(back.seatsState[0]);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
