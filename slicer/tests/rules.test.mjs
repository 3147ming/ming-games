/* =============================================================================
 * slicer/tests/rules.test.mjs —— 切片大师规则引擎单测
 *
 * 用法：node slicer/tests/rules.test.mjs
 *
 * 覆盖：
 *   1. 基础常量与哈希 / 伪随机
 *   2. 每日种子、房间种子（双方一致）
 *   3. 出现顺序表（确定性、难度递增、类型分布）
 *   4. 几何：轨迹加密、线段-圆相交判定
 *   5. 慢速时间尺度 effectiveFrames
 *   6. 物体位置与磁铁牵引
 *   7. 连击倍率、评价等级
 *   8. 轨迹规范化与规范顺序
 *   9. 结算：切水果、连击倍率、炸弹扣分、冰冻、磁铁、重复切割
 *   10. 动作折叠 / 重放一致性 / **结算与顺序无关**
 *   11. 摘要稳定性与敏感性（房主改 seed / 改轨迹 / 改分数都会被发现）
 *   12. 视图深拷贝（没有私密信息可漏）
 *   13. 可见物体、边界
 * ========================================================================== */

import {
  TICK_MS, ROUND_FRAMES, VW, VH,
  T_FRUIT, T_BOMB, T_ICE, T_MAGNET,
  FRUIT_KINDS, BOMB_PENALTY, MAX_BOMBS, ICE_POINTS, MAGNET_POINTS,
  FREEZE_FRAMES, MAGNET_FRAMES, FREEZE_FACTOR, MAGNET_FACTOR,
  MAGNET_RANGE, MAGNET_PULL, BLADE, MAX_COMBO_MULT,
  fnv1a, mulberry32, hashInt, randomSeed, dateKey, dailySeed, seedFromRoom,
  buildSchedule, scheduleOf, densify, segmentsOf, segCircleHit,
  effectiveFrames, objPos, visibleObjects, comboMult, gradeOf,
  normalizeStroke, canonicalStrokes, canonicalCompare, evaluate,
  initState, applyAction, fold, replay, hashState, publicView, strokeDigest,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

/* ---- 测试用的小工具 ---- */

/** 某一帧下所有「活着」的物体及其位置。 */
function aliveAt(seed, frame, ctx) {
  const sched = scheduleOf(seed);
  const c = ctx || { slow: [], magnets: [] };
  const out = [];
  for (const o of sched) {
    if (frame < o.frame) continue;
    if (frame - o.frame > 280) continue;
    const p = objPos(o, frame, c);
    if (p.y - o.r > VH) continue;
    out.push({ o: o, p: p });
  }
  return out;
}

/** 找一个「旁边没有别的物体」的目标（好写精确断言）。 */
function isolated(seed, frame, type) {
  const list = aliveAt(seed, frame);
  const cands = list.filter((x) => !type || x.o.type === type);
  for (const c of cands) {
    let good = true;
    for (const other of list) {
      if (other.o.id === c.o.id) continue;
      const d = Math.hypot(other.p.x - c.p.x, other.p.y - c.p.y);
      if (d < c.o.r + other.o.r + 6) { good = false; break; }
    }
    if (good) return c;
  }
  return null;
}

/** 在一段帧范围内找某个类型的孤立目标。 */
function findIsolated(seed, type, from, to, step) {
  for (let f = from; f <= to; f += (step || 5)) {
    const c = isolated(seed, f, type);
    if (c) return { c: c, frame: f };
  }
  return null;
}

/** 造一条从目标中心横穿过去的轨迹。 */
function strokeThrough(c, frame, id, seat) {
  return {
    act: 'stroke', id: id || 't1', frame: frame, seat: seat || 0,
    pts: [[c.p.x - 8, c.p.y], [c.p.x + 8, c.p.y]],
  };
}

/** 找一个「两个水果挨得很近」的帧（用来测连击）。 */
function findPair(seed) {
  for (let frame = 10; frame < 900; frame += 1) {
    const list = aliveAt(seed, frame).filter((x) => x.o.type === T_FRUIT);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i].p.x - list[j].p.x, list[i].p.y - list[j].p.y);
        if (d < 7) return { a: list[i], b: list[j], frame: frame, d: d };
      }
    }
  }
  return null;
}

/* =============================================================================
 * 1. 基础常量与哈希
 * ========================================================================== */
console.log('\n=== 1. 基础常量与哈希 ===');
{
  eq('逻辑帧长 50ms', TICK_MS, 50);
  eq('一局 1200 帧（60 秒）', ROUND_FRAMES, 1200);
  eq('虚拟坐标 100×100', VW + 'x' + VH, '100x100');
  eq('5 种水果', FRUIT_KINDS.length, 5);
  eq('炸弹扣 25 分', BOMB_PENALTY, 25);
  eq('3 颗炸弹判负', MAX_BOMBS, 3);
  eq('冰冻蛋 30 分', ICE_POINTS, 30);
  eq('磁铁星 20 分', MAGNET_POINTS, 20);
  eq('冰冻 100 帧', FREEZE_FRAMES, 100);
  eq('磁铁 80 帧', MAGNET_FRAMES, 80);
  eq('连击倍率上限 4', MAX_COMBO_MULT, 4);

  ok('FNV-1a 是 32 位无符号整数',
    fnv1a('abc') >= 0 && fnv1a('abc') <= 0xffffffff && Number.isInteger(fnv1a('abc')));
  eq('FNV-1a 稳定', fnv1a('切片大师'), fnv1a('切片大师'));
  ok('FNV-1a 不同输入不同输出', fnv1a('a') !== fnv1a('b'));
  eq('FNV-1a 空串是标准初值', fnv1a(''), 0x811c9dc5);

  const r = mulberry32(12345);
  ok('mulberry32 输出在 [0,1)', r() >= 0 && r() < 1);
  const a1 = mulberry32(7), a2 = mulberry32(7);
  eq('同种子的随机流一致', a1(), a2());
  const rs = randomSeed();
  ok('随机种子是 32 位整数', rs >= 0 && rs <= 0xffffffff && Number.isInteger(rs));

  eq('hashInt 稳定', hashInt(100, 5), hashInt(100, 5));
  ok('hashInt 不同序号不同', hashInt(100, 5) !== hashInt(100, 6));
  ok('hashInt 不同种子不同', hashInt(100, 5) !== hashInt(101, 5));
}

/* =============================================================================
 * 2. 种子派生
 * ========================================================================== */
console.log('\n=== 2. 种子派生（双方一致 / 每日一致） ===');
{
  eq('同房间号 → 同种子', seedFromRoom('12345', 'slicer'), seedFromRoom('12345', 'slicer'));
  ok('不同房间号 → 不同种子', seedFromRoom('12345', 'slicer') !== seedFromRoom('54321', 'slicer'));
  ok('不同游戏 id → 不同种子', seedFromRoom('12345', 'slicer') !== seedFromRoom('12345', 'other'));

  eq('同日期 → 同每日种子', dailySeed('2026-11-25'), dailySeed('2026-11-25'));
  ok('不同日期 → 不同每日种子', dailySeed('2026-11-25') !== dailySeed('2026-11-26'));
  ok('每日种子是 32 位整数', dailySeed('2026-11-25') >= 0 && dailySeed('2026-11-25') <= 0xffffffff);

  const dk = dateKey(new Date(2026, 0, 5));
  eq('dateKey 补零', dk, '2026-01-05');
  eq('dateKey 稳定', dateKey(new Date(2026, 0, 5)), '2026-01-05');
  ok('dateKey 默认是今天', /^\d{4}-\d{2}-\d{2}$/.test(dateKey()));
}

/* =============================================================================
 * 3. 出现顺序表
 * ========================================================================== */
console.log('\n=== 3. 出现顺序表 ===');
{
  const s1 = buildSchedule(2026);
  const s2 = buildSchedule(2026);
  eq('同 seed → 同样长度', s1.length, s2.length);
  ok('同 seed → 逐项相同', s1.every((o, i) =>
    o.id === s2[i].id && o.frame === s2[i].frame && o.type === s2[i].type
    && o.x === s2[i].x && o.r === s2[i].r && o.points === s2[i].points));
  ok('不同 seed → 不同表', buildSchedule(2026)[0].frame !== buildSchedule(2027)[0].frame
    || buildSchedule(2026)[0].x !== buildSchedule(2027)[0].x);

  ok('表是递增的', s1.every((o, i) => i === 0 || o.frame > s1[i - 1].frame));
  ok('id 连续', s1.every((o, i) => o.id === i));
  ok('都在一局之内', s1.every((o) => o.frame < ROUND_FRAMES));
  ok('横坐标都在画面里', s1.every((o) => o.x >= o.r && o.x <= VW - o.r));
  ok('半径为正', s1.every((o) => o.r > 0));
  ok('重力为正', s1.every((o) => o.g > 0));

  /* 难度：后期刷得更密、掉得更快、炸弹更多 */
  const half = ROUND_FRAMES / 2;
  const early = s1.filter((o) => o.frame < half);
  const late = s1.filter((o) => o.frame >= half);
  ok('有早期和后期两段', early.length > 0 && late.length > 0);
  const avgGap = (arr) => {
    let g = 0;
    for (let i = 1; i < arr.length; i++) g += arr[i].frame - arr[i - 1].frame;
    return arr.length > 1 ? g / (arr.length - 1) : 999;
  };
  ok('后期刷得更密', avgGap(late) < avgGap(early),
    '早 ' + avgGap(early).toFixed(1) + ' / 晚 ' + avgGap(late).toFixed(1));
  const avgVy = (arr) => arr.reduce((s, o) => s + o.vy, 0) / arr.length;
  ok('后期掉得更快', avgVy(late) > avgVy(early),
    '早 ' + avgVy(early).toFixed(3) + ' / 晚 ' + avgVy(late).toFixed(3));
  const bombRate = (arr) => arr.filter((o) => o.type === T_BOMB).length / arr.length;
  ok('后期炸弹更多', bombRate(late) > bombRate(early),
    '早 ' + bombRate(early).toFixed(3) + ' / 晚 ' + bombRate(late).toFixed(3));

  /* 四种类型都会出现 */
  const types = new Set(s1.map((o) => o.type));
  ok('有水果', types.has(T_FRUIT));
  ok('有炸弹', types.has(T_BOMB));
  ok('有冰冻蛋', types.has(T_ICE));
  ok('有磁铁星', types.has(T_MAGNET));

  /* 水果的分与品种对得上 */
  ok('水果分值取自品种表', s1.filter((o) => o.type === T_FRUIT).every((o) =>
    FRUIT_KINDS.some((k) => k.r === o.r && k.points === o.points)));
  ok('炸弹不计分', s1.filter((o) => o.type === T_BOMB).every((o) => o.points === 0));

  /* 缓存不会串味 */
  ok('scheduleOf 与 buildSchedule 一致',
    scheduleOf(4242).length === buildSchedule(4242).length
    && scheduleOf(4242)[0].frame === buildSchedule(4242)[0].frame);
  ok('不同 seed 的缓存互不影响',
    scheduleOf(1)[0].frame !== scheduleOf(2)[0].frame
    || scheduleOf(1)[0].x !== scheduleOf(2)[0].x);
}

/* =============================================================================
 * 4. 几何
 * ========================================================================== */
console.log('\n=== 4. 几何：轨迹加密与相交判定 ===');
{
  eq('加密后端点不变', JSON.stringify(densify([[0, 0], [10, 0]])[0]), '[0,0]');
  eq('加密后末点不变', JSON.stringify(densify([[0, 0], [10, 0]]).slice(-1)[0]), '[10,0]');
  ok('长线段被拆开', densify([[0, 0], [10, 0]]).length > 2);
  ok('短线段不拆', densify([[0, 0], [1, 0]]).length === 2);
  eq('空轨迹返回空', densify([]).length, 0);
  eq('单点轨迹返回 1 个点', densify([[3, 4]]).length, 1);

  const segs = segmentsOf([[0, 0], [2, 0]]);
  eq('短线段 → 一条线段', segs.length, 1);
  eq('线段端点正确', JSON.stringify(segs[0]), '[0,0,2,0]');
  const long = segmentsOf([[0, 0], [4, 0]]);
  ok('长线段被拆成多条', long.length > 1);
  eq('拆开后仍然从起点出发', JSON.stringify(long[0]), '[0,0,2,0]');
  eq('拆开后到终点结束', Math.round(long[long.length - 1][2] * 100) / 100, 4);
  const one = segmentsOf([[5, 5]]);
  eq('单点 → 一条退化线段', one.length, 1);
  ok('退化线段端点相同', one[0][0] === one[0][2] && one[0][1] === one[0][3]);

  ok('线段穿过圆心 → 命中', segCircleHit(0, 0, 10, 0, 5, 0, 2));
  ok('线段擦过圆边 → 命中', segCircleHit(0, 0, 10, 0, 5, 2, 2));
  ok('线段离圆心太远 → 不中', !segCircleHit(0, 0, 10, 0, 5, 3, 2));
  ok('线段延长线过圆但线段够不到 → 不中', !segCircleHit(0, 0, 1, 0, 5, 0, 2));
  ok('退化线段命中同点', segCircleHit(5, 5, 5, 5, 5, 5, 1));
  ok('退化线段不中远处', !segCircleHit(5, 5, 5, 5, 8, 8, 1));
  ok('负半径不命中', !segCircleHit(0, 0, 10, 0, 5, 0, -1));
}

/* =============================================================================
 * 5. 慢速时间尺度
 * ========================================================================== */
console.log('\n=== 5. 慢速时间尺度 effectiveFrames ===');
{
  eq('没有窗口时等于帧差', effectiveFrames(0, 100, []), 100);
  eq('终点在前 → 0', effectiveFrames(100, 50, []), 0);
  const win = [{ s: 100, e: 200, factor: FREEZE_FACTOR }];
  eq('冻结窗口内按 0.5 折算', effectiveFrames(0, 300, win), 250);
  eq('冻结窗口完全在区间外 → 不折算', effectiveFrames(0, 50, win), 50);
  eq('物体在冻结之后出生也受影响', effectiveFrames(150, 300, win), 150 - 150 + 0.5 * 50 + 100);
  const mag = [{ s: 0, e: 100, factor: MAGNET_FACTOR }];
  eq('磁铁按 0.8 折算', effectiveFrames(0, 100, mag), 80);
  ok('窗口越多越慢', effectiveFrames(0, 300, [
    { s: 100, e: 200, factor: 0.5 }, { s: 200, e: 250, factor: 0.5 },
  ]) < 300);
}

/* =============================================================================
 * 6. 物体位置与磁铁牵引
 * ========================================================================== */
console.log('\n=== 6. 物体位置与磁铁牵引 ===');
{
  const sched = scheduleOf(777);
  const o = sched[0];
  const p0 = objPos(o, o.frame, { slow: [], magnets: [] });
  eq('出生帧就在出生点上方', Math.round(p0.y * 1000) / 1000, Math.round(o.y0 * 1000) / 1000);
  const p1 = objPos(o, o.frame + 20, { slow: [], magnets: [] });
  ok('越晚越靠下', p1.y > p0.y);
  ok('水平漂移很小', Math.abs(p1.x - o.x) < 5);

  /* 冻结 → 掉得慢 */
  const slowCtx = { slow: [{ s: o.frame, e: o.frame + 200, factor: 0.5 }], magnets: [] };
  const pSlow = objPos(o, o.frame + 20, slowCtx);
  ok('冻结时掉得更慢', pSlow.y < p1.y, pSlow.y.toFixed(2) + ' < ' + p1.y.toFixed(2));

  /* 磁铁 → 横向被拉过去 */
  const mctx = { slow: [], magnets: [{ s: o.frame, e: o.frame + 100, x: o.x + 10 }] };
  const pM = objPos(o, o.frame + 30, mctx);
  const pBase30 = objPos(o, o.frame + 30, { slow: [], magnets: [] });
  ok('被磁铁往右拉', pM.x > pBase30.x + 0.01, pM.x.toFixed(3) + ' vs ' + pBase30.x.toFixed(3));
  const mctx2 = { slow: [], magnets: [{ s: o.frame, e: o.frame + 100, x: o.x - 10 }] };
  const pM2 = objPos(o, o.frame + 30, mctx2);
  ok('被磁铁往左拉', pM2.x < pBase30.x - 0.01);
  const far = { slow: [], magnets: [{ s: o.frame, e: o.frame + 100, x: o.x + MAGNET_RANGE + 5 }] };
  ok('超出磁铁半径不受影响', Math.abs(objPos(o, o.frame + 30, far).x - pBase30.x) < 1e-9);
  const past = { slow: [], magnets: [{ s: o.frame - 100, e: o.frame - 10, x: o.x + 10 }] };
  ok('磁铁窗口已过不受影响', Math.abs(objPos(o, o.frame + 30, past).x - pBase30.x) < 1e-9);
  const inactive = { slow: [], magnets: [{ s: o.frame + 200, e: o.frame + 300, x: o.x + 10 }] };
  ok('磁铁窗口还没开始不受影响', Math.abs(objPos(o, o.frame + 30, inactive).x - pBase30.x) < 1e-9);
}

/* =============================================================================
 * 7. 连击倍率与评价
 * ========================================================================== */
console.log('\n=== 7. 连击倍率与评价等级 ===');
{
  eq('切 0 个 → ×1', comboMult(0), 1);
  eq('切 1 个 → ×1', comboMult(1), 1);
  eq('切 2 个 → ×1.5', comboMult(2), 1.5);
  eq('切 3 个 → ×2', comboMult(3), 2);
  eq('切 5 个 → ×3', comboMult(5), 3);
  eq('切很多 → 封顶 ×4', comboMult(99), MAX_COMBO_MULT);
  ok('倍率随数量单调不减', comboMult(1) <= comboMult(2) && comboMult(2) <= comboMult(3));

  eq('0 分 → D', gradeOf(0), 'D');
  eq('199 分 → D', gradeOf(199), 'D');
  eq('200 分 → C', gradeOf(200), 'C');
  eq('400 分 → B', gradeOf(400), 'B');
  eq('650 分 → A', gradeOf(650), 'A');
  eq('900 分 → S', gradeOf(900), 'S');
  eq('负分 → D', gradeOf(-50), 'D');
}

/* =============================================================================
 * 8. 轨迹规范化与规范顺序
 * ========================================================================== */
console.log('\n=== 8. 轨迹规范化与规范顺序 ===');
{
  ok('合法轨迹通过', !!normalizeStroke({ act: 'stroke', id: 'a', frame: 1, seat: 0, pts: [[0, 0], [1, 1]] }));
  eq('非 stroke 动作被拒', normalizeStroke({ act: 'move' }), null);
  eq('缺 id 被拒', normalizeStroke({ act: 'stroke', frame: 1, seat: 0, pts: [[0, 0]] }), null);
  eq('帧号不是整数被拒', normalizeStroke({ act: 'stroke', id: 'a', frame: 1.5, seat: 0, pts: [[0, 0]] }), null);
  eq('负帧号被拒', normalizeStroke({ act: 'stroke', id: 'a', frame: -1, seat: 0, pts: [[0, 0]] }), null);
  eq('座位号非法被拒', normalizeStroke({ act: 'stroke', id: 'a', frame: 1, seat: 7, pts: [[0, 0]] }), null);
  eq('没有坐标被拒', normalizeStroke({ act: 'stroke', id: 'a', frame: 1, seat: 0, pts: [] }), null);
  eq('坐标不是数字被拒', normalizeStroke({ act: 'stroke', id: 'a', frame: 1, seat: 0, pts: [['x', 0]] }), null);
  eq('坐标是 NaN 被拒', normalizeStroke({ act: 'stroke', id: 'a', frame: 1, seat: 0, pts: [[NaN, 0]] }), null);
  eq('单点轨迹合法', !!normalizeStroke({ act: 'stroke', id: 'a', frame: 1, seat: 0, pts: [[3, 4]] }), true);
  eq('id 被转成字符串', normalizeStroke({ act: 'stroke', id: 7, frame: 1, seat: 0, pts: [[0, 0]] }).id, '7');

  const a = { act: 'stroke', id: 'b', frame: 10, seat: 1, pts: [[0, 0]] };
  const b = { act: 'stroke', id: 'a', frame: 10, seat: 0, pts: [[0, 0]] };
  const c = { act: 'stroke', id: 'c', frame: 5, seat: 0, pts: [[0, 0]] };
  const sorted = canonicalStrokes([a, b, c]);
  eq('先按帧、再按座位排', sorted.map((x) => x.id).join(','), 'c,a,b');
  ok('同帧时座位小的在前', canonicalCompare(b, a) < 0);
  ok('同帧同座位时按 id 排', canonicalCompare({ frame: 1, seat: 0, id: 'a' }, { frame: 1, seat: 0, id: 'b' }) < 0);
  eq('重复 id 只留一个', canonicalStrokes([a, a]).length, 1);
  eq('非法轨迹被丢弃', canonicalStrokes([a, { act: 'x' }]).length, 1);
}

/* =============================================================================
 * 9. 结算
 * ========================================================================== */
console.log('\n=== 9. 结算：切中 / 连击 / 危险物 / 特殊物 ===');
{
  const SEED = 31337;
  /* --- 切水果 --- */
  const fr = isolated(SEED, 60, T_FRUIT);
  ok('找得到孤立的水果', !!fr);
  if (fr) {
    const r = evaluate(SEED, [strokeThrough(fr, 60, 'a')]);
    eq('切中 1 个水果', r.events[0].fruitCount, 1);
    eq('切 1 个倍率是 1', r.events[0].mult, 1);
    eq('得分 = 品种分值', r.score, fr.o.points);
    eq('水果计数 1', r.fruits, 1);
    eq('切中数 1', r.sliced.length, 1);
    ok('评价等级有值', 'DCBAS'.indexOf(r.grade) >= 0);
  }

  /* --- 同一个水果不能切两次 --- */
  if (fr) {
    const r2 = evaluate(SEED, [strokeThrough(fr, 60, 'a'), strokeThrough(fr, 60, 'b')]);
    eq('重复切割不重复计分', r2.score, fr.o.points);
    eq('水果只算一次', r2.fruits, 1);
  }

  /* --- 连击 --- */
  let pair = null;
  let pairSeed = 0;
  for (let s = 1; s <= 60 && !pair; s++) {
    const p = findPair(s);
    if (p) { pair = p; pairSeed = s; }
  }
  ok('找得到挨在一起的两个水果', !!pair);
  if (pair) {
    const dx = pair.b.p.x - pair.a.p.x, dy = pair.b.p.y - pair.a.p.y;
    const stroke = {
      act: 'stroke', id: 'p', frame: pair.frame, seat: 0,
      pts: [[pair.a.p.x - dx * 0.25, pair.a.p.y - dy * 0.25],
        [pair.b.p.x + dx * 0.25, pair.b.p.y + dy * 0.25]],
    };
    const r = evaluate(pairSeed, [stroke]);
    eq('一刀切中 2 个水果', r.events[0].fruitCount, 2);
    eq('连击倍率 ×1.5', r.events[0].mult, 1.5);
    const ids = r.events[0].hitIds;
    const sched = scheduleOf(pairSeed);
    const expect = ids.reduce((s, id) => s + Math.round(sched[id].points * 1.5), 0);
    eq('连击加分 = Σ(分值 × 倍率)', r.score, expect);
    ok('连击分比单切多', r.score > ids.length * 6);
    eq('最佳连击 = 2', r.bestCombo, 2);
  }

  /* --- 炸弹 --- */
  const boFind = findIsolated(SEED, T_BOMB, 20, 900, 3);
  ok('找得到孤立的炸弹', !!boFind);
  const bo = boFind ? boFind.c : null;
  const boFrame = boFind ? boFind.frame : 0;
  if (bo) {
    const r = evaluate(SEED, [strokeThrough(bo, boFrame, 'x')]);
    eq('切炸弹扣分', r.score, -BOMB_PENALTY);
    eq('炸弹计数 1', r.bombs, 1);
    eq('没切到水果', r.fruits, 0);
    ok('没结束', !r.over);
  }

  /* --- 三颗炸弹判负 --- */
  if (bo) {
    const strokes = [];
    const seen = new Set();
    for (let f = 20; f < 1000 && strokes.length < 3; f += 3) {
      const b = isolated(SEED, f, T_BOMB);
      if (b && !seen.has(b.o.id)) {
        seen.add(b.o.id);
        strokes.push(strokeThrough(b, f, 'b' + strokes.length));
      }
    }
    ok('找得到 3 颗可分别切到的炸弹', strokes.length === 3, '找到 ' + strokes.length);
    if (strokes.length === 3) {
      const r = evaluate(SEED, strokes);
      eq('三颗炸弹 → 判负', r.over, true);
      eq('炸弹计数 3', r.bombs, 3);
      eq('分数被扣光', r.score, -3 * BOMB_PENALTY);
    }
  }

  /* --- 冰冻蛋 --- */
  const icFind = findIsolated(SEED, T_ICE, 20, 900, 3);
  ok('找得到孤立的冰冻蛋', !!icFind);
  if (icFind) {
    const r = evaluate(SEED, [strokeThrough(icFind.c, icFind.frame, 'i')]);
    eq('切冰冻蛋加分', r.score, ICE_POINTS);
    eq('冰冻计数 1', r.ices, 1);
    eq('产生一个减速窗口', r.freezes.length, 1);
    eq('减速窗口从这一帧开始', r.freezes[0].s, icFind.frame);
    eq('减速窗口持续 100 帧', r.freezes[0].e - r.freezes[0].s, FREEZE_FRAMES);
  }

  /* --- 磁铁星 --- */
  const mgFind = findIsolated(SEED, T_MAGNET, 20, 900, 3);
  ok('找得到孤立的磁铁星', !!mgFind);
  if (mgFind) {
    const r = evaluate(SEED, [strokeThrough(mgFind.c, mgFind.frame, 'm')]);
    eq('切磁铁加分', r.score, MAGNET_POINTS);
    eq('磁铁计数 1', r.magnets, 1);
    eq('产生一个磁铁窗口', r.magnetWins.length, 1);
    eq('磁铁窗口 x = 磁铁出生位置', r.magnetWins[0].x, mgFind.c.o.x);
  }

  /* --- 空刀不算分 --- */
  const empty = evaluate(SEED, [{ act: 'stroke', id: 'e', frame: 10, seat: 0, pts: [[1, 1]] }]);
  eq('空刀不加分', empty.score, 0);
  eq('空刀不计水果', empty.fruits, 0);
  eq('空刀仍然记录事件', empty.events.length, 1);

  /* --- 没切到任何东西的轨迹不改变被切集合 --- */
  ok('被切集合只含真正命中的', evaluate(SEED, [
    { act: 'stroke', id: 'e', frame: 10, seat: 0, pts: [[1, 1]] },
  ]).sliced.length === 0);
}

/* =============================================================================
 * 10. 折叠 / 重放 / 顺序无关
 * ========================================================================== */
console.log('\n=== 10. 折叠 / 重放 / 顺序无关 ===');
{
  const SEED = 4242;
  const st0 = initState(SEED);
  eq('开局没有轨迹', st0.strokes.length, 0);
  eq('开局分数 0', st0.summary.score, 0);
  eq('开局没结束', st0.over, false);
  ok('开局摘要有随机数序号', st0.rngCount === scheduleOf(SEED).length);

  /* 造一串合法轨迹 */
  const acts = [];
  for (let f = 20; f < 400; f += 37) {
    const fr = isolated(SEED, f, T_FRUIT);
    if (fr) acts.push(strokeThrough(fr, f, 'a' + acts.length));
  }
  ok('造出了若干刀', acts.length >= 3, acts.length + ' 刀');

  const folded = fold({ seed: SEED }, acts);
  const rep = replay(SEED, acts);
  eq('fold 与 replay 一致', hashState(folded), hashState(rep));
  eq('折叠后分数 > 0', folded.summary.score > 0, true);

  /* 逐步应用与一次性折叠结果一致 */
  let step = initState(SEED);
  for (const a of acts) step = applyAction(step, a);
  eq('逐步应用 == 折叠', hashState(step), hashState(folded));

  /* **结算与到达顺序无关** —— 这是 P2P 两端分数一致的根据 */
  const rev = acts.slice().reverse();
  eq('倒序重放分数相同', replay(SEED, rev).summary.score, folded.summary.score);
  eq('倒序重放摘要相同', hashState(replay(SEED, rev)), hashState(folded));

  /* 乱序重放 */
  const shuf = acts.slice().sort((a, b) => (a.id < b.id ? 1 : -1));
  eq('乱序重放分数相同', replay(SEED, shuf).summary.score, folded.summary.score);

  /* 非法动作整手丢弃 */
  const before = hashState(folded);
  eq('未知动作被丢弃', hashState(applyAction(folded, { act: 'nope' })), before);
  eq('非法轨迹被丢弃', hashState(applyAction(folded, { act: 'stroke', id: 'z', frame: 1, seat: 0, pts: [] })), before);
  eq('重复 id 被丢弃', hashState(applyAction(folded, acts[0])), before);
  eq('帧号非法被丢弃', hashState(applyAction(folded, { act: 'stroke', id: 'q', frame: -5, seat: 0, pts: [[0, 0]] })), before);
  eq('坐标非法的被丢弃', hashState(applyAction(folded, { act: 'stroke', id: 'q', frame: 5, seat: 0, pts: [[NaN, 1]] })), before);
  ok('合法动作会改变状态', hashState(applyAction(folded, {
    act: 'stroke', id: 'brand-new', frame: 999, seat: 1, pts: [[1, 1], [2, 2]],
  })) !== before);
}

/* =============================================================================
 * 11. 摘要
 * ========================================================================== */
console.log('\n=== 11. 摘要稳定性与敏感性 ===');
{
  const st = initState(555);
  eq('摘要稳定', hashState(st), hashState(initState(555)));
  ok('不同种子摘要不同', hashState(initState(555)) !== hashState(initState(556)));
  ok('种子进摘要', hashState(st).indexOf('555') >= 0);
  ok('随机数序号进摘要', hashState(st).indexOf(String(st.rngCount)) >= 0);

  const s2 = initState(555);
  const a = { act: 'stroke', id: 'k', frame: 10, seat: 0, pts: [[1, 1], [2, 2]] };
  const s3 = applyAction(s2, a);
  ok('加一刀后摘要变化', hashState(s3) !== hashState(s2));
  const s4 = applyAction(s2, { act: 'stroke', id: 'k', frame: 10, seat: 0, pts: [[1, 1], [2, 3]] });
  ok('改坐标摘要变化（房主改轨迹会被发现）', hashState(s4) !== hashState(s3));
  const s5 = applyAction(s2, { act: 'stroke', id: 'k', frame: 11, seat: 0, pts: [[1, 1], [2, 2]] });
  ok('改帧号摘要变化', hashState(s5) !== hashState(s3));
  const s6 = applyAction(s2, { act: 'stroke', id: 'k', frame: 10, seat: 1, pts: [[1, 1], [2, 2]] });
  ok('改座位摘要变化', hashState(s6) !== hashState(s3));

  /* 摘要含分数 */
  const fr = isolated(999, 60, T_FRUIT);
  if (fr) {
    const scored = applyAction(initState(999), strokeThrough(fr, 60, 'f'));
    ok('分数进摘要', hashState(scored).indexOf(String(scored.summary.score)) >= 0);
  }
}

/* =============================================================================
 * 12. 视图
 * ========================================================================== */
console.log('\n=== 12. 视图（没有私密信息可漏） ===');
{
  const st = initState(606);
  const fr = isolated(606, 60, T_FRUIT);
  const s = fr ? applyAction(st, strokeThrough(fr, 60, 'v')) : st;
  const v = publicView(s);
  ok('视图是新对象', v !== s);
  ok('视图的轨迹是新数组', v.strokes !== s.strokes);
  ok('视图的坐标是新数组', v.strokes.length === 0 || v.strokes[0].pts !== s.strokes[0].pts);
  ok('视图的摘要被切集合是新数组', v.summary.sliced !== s.summary.sliced);
  eq('视图内容一致', hashState(v), hashState(s));
  /* 改视图不影响原局面 */
  if (v.strokes.length) v.strokes[0].pts[0][0] = 999;
  ok('改视图不污染原局面', s.strokes[0].pts[0][0] !== 999);
  /* 视图里没有多余字段 */
  ok('视图只暴露该暴露的', Object.keys(v).sort().join(',') === 'over,rngCount,seed,strokes,summary');
}

/* =============================================================================
 * 13. 可见物体与边界
 * ========================================================================== */
console.log('\n=== 13. 可见物体与边界 ===');
{
  const SEED = 808;
  const objs = visibleObjects(SEED, 100, null);
  ok('有可见物体', objs.length > 0, objs.length + ' 个');
  ok('都在画面内', objs.every((o) => o.y - o.r <= VH && o.x >= 0 && o.x <= VW));
  ok('还没出生的不算可见', visibleObjects(SEED, 0, null).length === 0);
  const far = visibleObjects(SEED, ROUND_FRAMES + 400, null);
  ok('过了时间没有可见物体', far.length === 0);

  /* 被切掉的不再可见 */
  const fr = isolated(SEED, 60, T_FRUIT);
  if (fr) {
    const st = applyAction(initState(SEED), strokeThrough(fr, 60, 'w'));
    const after = visibleObjects(SEED, 60, st.summary);
    ok('切掉的不再可见', !after.some((o) => o.id === fr.o.id));
  }

  /* 边界：单个点、零长度线段、超大坐标 */
  const r1 = evaluate(SEED, [{ act: 'stroke', id: 'x', frame: 0, seat: 0, pts: [[0, 0]] }]);
  eq('帧 0 合法', r1.events.length, 1);
  const r2 = evaluate(SEED, [{ act: 'stroke', id: 'x', frame: 0, seat: 0, pts: [[-50, -50], [500, 500]] }]);
  eq('越界坐标不加分', r2.score, 0);
  const r3 = evaluate(SEED, [{ act: 'stroke', id: 'x', frame: ROUND_FRAMES + 1000, seat: 0, pts: [[0, 0]] }]);
  eq('超时的刀不加分', r3.score, 0);

  /* 空轨迹列表 */
  const empty = evaluate(SEED, []);
  eq('空列表分数 0', empty.score, 0);
  eq('空列表事件 0', empty.events.length, 0);
  eq('空列表没结束', empty.over, false);

  /* 大量轨迹也不崩 */
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ act: 'stroke', id: 'm' + i, frame: 10 + i, seat: i % 2, pts: [[i, i], [i + 1, i + 1]] });
  const rMany = evaluate(SEED, many);
  ok('60 刀不崩', Number.isFinite(rMany.score) && rMany.events.length === 60);
  ok('分数是整数', Number.isInteger(rMany.score));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
