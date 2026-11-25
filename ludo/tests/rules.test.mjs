/* =============================================================================
 * ludo/tests/rules.test.mjs —— 飞行棋规则引擎单测
 *
 * 用法：node ludo/tests/rules.test.mjs
 *
 * 覆盖：
 *   1. 棋盘几何（外圈 52 格连续、通道不重叠、入口紧邻通道）
 *   2. 派生点数（确定性、双方一致、不可预测但可复算）
 *   3. 走子规则（起飞要 6、终点要刚好点数、通道位置换算）
 *   4. 跳跃点（经过/停留都触发）
 *   5. 撞机（同色可叠、异色被撞回待飞区）
 *   6. 动作折叠与重放一致性
 *   7. 判胜与回合推进
 *   8. 摘要稳定性
 * ========================================================================== */

import {
  RING, RING_LEN, LANES, LANE_LEN, MOUTH_IDX, START_IDX, JUMP_IDX,
  COLORS, COLOR_COUNT, PLANES_PER_COLOR,
  HOLD, LANE_START, FINISH_POS,
  fnv1a, dieFor, randomSeed, seedFromRoom,
  initState, ringIndexOf, cellOf, isFinished,
  stepOf, pathCells, hitsJump, legalPlanes, finishedCount, victimsOf,
  applyAction, fold, replay, hashState, publicView, aiChoose,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

/* =============================================================================
 * 1. 棋盘几何
 * ========================================================================== */
console.log('\n=== 1. 棋盘几何 ===');
{
  eq('外圈 52 格', RING_LEN, 52);
  eq('4 条通道', LANES.length, 4);
  eq('每条通道 6 格', LANES[0].length, LANE_LEN);

  /* 外圈必须首尾相接 —— 断一格整盘就散了 */
  let contiguous = true;
  for (let i = 0; i < RING_LEN; i++) {
    const a = RING[i], b = RING[(i + 1) % RING_LEN];
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) !== 1) contiguous = false;
  }
  ok('外圈首尾相接无断点', contiguous);

  /* 通道格不能重复，也不能压在外圈上 */
  const laneKeys = [];
  for (const L of LANES) for (const c of L) laneKeys.push(c[0] + ',' + c[1]);
  const ringKeys = new Set(RING.map((c) => c[0] + ',' + c[1]));
  eq('24 个通道格互不重复', new Set(laneKeys).size, 24);
  ok('通道不压在外圈上', laneKeys.every((k) => !ringKeys.has(k)));

  /* 每个入口必须紧挨着自己通道的第一格 */
  let mouthsOk = true;
  for (let i = 0; i < 4; i++) {
    const m = RING[MOUTH_IDX[i]], f = LANES[i][0];
    if (Math.abs(m[0] - f[0]) + Math.abs(m[1] - f[1]) !== 1) mouthsOk = false;
  }
  ok('4 个入口都紧邻自己的通道', mouthsOk);

  /* 起点 = 入口 + 1（顺时针方向） */
  let startsOk = true;
  for (let i = 0; i < 4; i++) {
    if (START_IDX[i] !== (MOUTH_IDX[i] + 1) % RING_LEN) startsOk = false;
  }
  ok('起点 = 入口 + 1', startsOk);

  /* 4 个跳跃点要互不相同 */
  eq('4 个跳跃点互不相同', new Set(JUMP_IDX).size, 4);
  ok('跳跃点都在外圈上', JUMP_IDX.every((i) => i >= 0 && i < RING_LEN));

  eq('4 个颜色', COLORS.length, COLOR_COUNT);
  eq('每色 4 颗棋子', PLANES_PER_COLOR, 4);
}

/* =============================================================================
 * 2. 派生点数
 * ========================================================================== */
console.log('\n=== 2. 派生点数（纯 P2P 公平性的核心） ===');
{
  ok('哈希是 32 位无符号整数', fnv1a('abc') >= 0 && fnv1a('abc') <= 0xffffffff);

  const seed = 12345;
  ok('同 seed 同序号 → 同一个点数', dieFor(seed, 7) === dieFor(seed, 7));
  ok('不同序号 → 不同点数', dieFor(seed, 7) !== dieFor(seed, 8) || dieFor(seed, 7) !== dieFor(seed, 9));

  /* 点数必须落在 1..6 */
  let inRange = true;
  for (let r = 0; r < 500; r++) {
    const d = dieFor(seed, r);
    if (d < 1 || d > 6 || !Number.isInteger(d)) inRange = false;
  }
  ok('500 次投掷点数都在 1..6', inRange);

  /* 分布要大致均匀 —— 偏差太大会让某些人吃亏 */
  const dist = [0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 6000; r++) dist[dieFor(seed, r) - 1]++;
  const expected = 1000;
  const maxDev = Math.max(...dist.map((n) => Math.abs(n - expected)));
  ok('6000 次投掷分布均匀（最大偏差 <12%）', maxDev < expected * 0.12,
    '各点数次数 ' + dist.join(','));

  /* 房间号派生种子：双方算出同一个 */
  ok('同房间号 → 同种子', seedFromRoom('12345', 'ludo') === seedFromRoom('12345', 'ludo'));
  ok('不同房间号 → 不同种子', seedFromRoom('12345', 'ludo') !== seedFromRoom('54321', 'ludo'));
  const rs = randomSeed();
  ok('随机种子是 32 位整数', rs >= 0 && rs <= 0xffffffff && Number.isInteger(rs));
}

/* =============================================================================
 * 3. 走子规则
 * ========================================================================== */
console.log('\n=== 3. 走子规则 ===');
{
  /* 待飞区：只有 6 能起飞 */
  ok('待飞区 + 6 → 起飞到 0', stepOf(0, HOLD, 6).ok && stepOf(0, HOLD, 6).to === 0);
  for (const d of [1, 2, 3, 4, 5]) {
    ok(`待飞区 + ${d} → 走不动`, !stepOf(0, HOLD, d).ok);
  }

  /* 外圈正常走 */
  eq('外圈 0 走 3 → 3', stepOf(0, 0, 3).to, 3);
  eq('外圈 10 走 6 → 16', stepOf(0, 10, 6).to, 16);

  /* 终点通道：必须刚好点数 */
  ok('通道内刚好到终点 → 可以走', stepOf(0, FINISH_POS - 1, 1).ok);
  ok('通道内点数超出 → 走不动', !stepOf(0, FINISH_POS - 1, 2).ok);
  ok('已到终点 → 走不动', !stepOf(0, FINISH_POS, 1).ok);

  /* 位置换算 */
  eq('pos 0 在外圈上', ringIndexOf(0, 0), START_IDX[0]);
  ok('通道内的棋子不在外圈上', ringIndexOf(0, LANE_START) === -1);
  ok('待飞区没有坐标', cellOf(0, HOLD) === null);
  ok('外圈棋子有坐标', Array.isArray(cellOf(0, 0)));
  ok('通道第 1 格坐标 = LANES[0][0]',
    cellOf(0, LANE_START)[0] === LANES[0][0][0] && cellOf(0, LANE_START)[1] === LANES[0][0][1]);
  ok('终点坐标 = 通道最后一格',
    cellOf(0, FINISH_POS)[0] === LANES[0][LANE_LEN - 1][0]);
  ok('isFinished 认终点', isFinished(FINISH_POS) && !isFinished(FINISH_POS - 1));
}

/* =============================================================================
 * 4. 跳跃点
 * ========================================================================== */
console.log('\n=== 4. 跳跃点 ===');
{
  /* 找一个从某色起点出发会经过的跳跃点 */
  const color = 0;
  let jumpPos = -1;
  for (let p = 0; p < RING_LEN && jumpPos < 0; p++) {
    if (JUMP_IDX.indexOf(ringIndexOf(color, p)) >= 0) jumpPos = p;
  }
  ok('存在会被经过的跳跃点', jumpPos >= 0, 'pos=' + jumpPos);

  /* 停在跳跃点上 → 触发 */
  ok('停在跳跃点 → 触发', hitsJump(color, jumpPos, jumpPos));
  /* 路过跳跃点但没停上 → 不触发（经典规则：只有停到才飞） */
  ok('经过但没停在跳跃点上 → 不触发', !hitsJump(color, jumpPos - 1, jumpPos + 1));
  /* 起点本身不是飞跃点（否则开局就飞） */
  ok('4 个起点都不是飞跃点',
    START_IDX.every((si) => JUMP_IDX.indexOf(si) < 0), JSON.stringify(START_IDX));

  /* 通道里没有跳跃点 */
  ok('通道内不触发跳跃', !hitsJump(color, LANE_START, LANE_START + 2));

  /* pathCells 长度 = 走过的格数 */
  eq('pathCells 长度正确', pathCells(color, 5, 10).length, 6);
  eq('待飞区没有路径', pathCells(color, HOLD, 3).length, 0);
}

/* =============================================================================
 * 5. 撞机
 * ========================================================================== */
console.log('\n=== 5. 撞机 ===');
{
  const st = initState(999, 4);
  /* 注意：pos 是「离自己起点几步」，不同颜色的同一个 pos 不在同一个格子。
     所以要先把外圈下标换算成各颜色的 pos。 */
  const ring10 = 10;                       /* 外圈第 10 格 */
  const posOf = (color, ringIdx) => (ringIdx - START_IDX[color] + RING_LEN) % RING_LEN;

  st.planes[0][0] = posOf(0, ring10);      /* 红方在 ring 10 */
  st.planes[2][0] = posOf(2, ring10);      /* 蓝方也在 ring 10 */
  const v = victimsOf(st, 0, posOf(0, ring10));
  ok('异色同格 → 被撞', v.length === 1 && v[0] === 2 * PLANES_PER_COLOR + 0, JSON.stringify(v));

  /* 同色叠在一起不算撞 */
  st.planes[0][1] = posOf(0, ring10);
  const v2 = victimsOf(st, 0, posOf(0, ring10));
  ok('同色可以叠在一起', v2.length === 1, JSON.stringify(v2));

  /* 通道内的棋子不参与撞机 */
  st.planes[2][1] = LANE_START;
  const v3 = victimsOf(st, 0, posOf(0, ring10));
  ok('通道内的棋子不参与撞机', v3.length === 1, JSON.stringify(v3));

  /* 落点没人 → 不撞 */
  const v4 = victimsOf(st, 0, posOf(0, 30));
  eq('落点没人 → 不撞', v4.length, 0);
}

/* =============================================================================
 * 6. 动作折叠与重放
 * ========================================================================== */
console.log('\n=== 6. 动作折叠与重放 ===');
{
  const st = initState(4242, 4);
  eq('开局在 commit 前：turn=0', st.turn, 0);
  eq('开局所有棋子待飞', st.planes[0][0], HOLD);
  eq('开局没人到家', finishedCount(st, 0), 0);

  /* 造一串动作：每回合都走第一步能走的棋子 */
  const acts = [];
  let s = st;
  for (let i = 0; i < 30 && !s.over; i++) {
    const c = s.turn;
    const legal = legalPlanes(s, c);
    const plane = legal.length ? legal[0] : -1;
    const act = { act: 'move', c, plane, r: s.roll };
    const ns = applyAction(s, act);
    ok2(`第 ${i} 步动作被接受`, ns !== s);
    acts.push(act);
    s = ns;
  }
  function ok2(n, c) { ok(n, c); }

  /* 折叠结果必须跟逐步重放一致 */
  const folded = fold({ seed: 4242, n: 4 }, acts);
  eq('折叠结果与逐步重放一致（摘要）', hashState(folded), hashState(s));

  /* replay 接口也一样 */
  eq('replay 与 fold 一致', hashState(replay(4242, acts, 4)), hashState(folded));

  /* 非法动作必须被丢弃（整手不改状态） */
  const before = hashState(s);
  const s2 = applyAction(s, { act: 'move', c: s.turn, plane: 99, r: s.roll });
  eq('非法棋子下标 → 状态不变', hashState(s2), before);

  /* 明明有棋能走却报「过」→ 必须被拒（否则能白嫖回合） */
  const legalNow = legalPlanes(s, s.turn);
  if (legalNow.length > 0) {
    const sPass = applyAction(s, { act: 'move', c: s.turn, plane: -1, r: s.roll });
    eq('有棋可走却报「过」→ 被拒', hashState(sPass), before);
  } else {
    ok('有棋可走却报「过」→ 被拒（本回合无棋可走，跳过）', true);
  }

  const s3 = applyAction(s, { act: 'move', c: (s.turn + 1) % 4, plane: 0, r: s.roll });
  eq('不是自己回合 → 状态不变', hashState(s3), before);

  const s4 = applyAction(s, { act: 'move', c: s.turn, plane: 0, r: s.roll + 5 });
  eq('掷骰序号对不上 → 状态不变', hashState(s4), before);

  const s5 = applyAction(s, { act: 'nope' });
  eq('未知动作 → 状态不变', hashState(s5), before);
}

/* =============================================================================
 * 7. 回合推进与判胜
 * ========================================================================== */
console.log('\n=== 7. 回合推进与判胜 ===');
{
  const st = initState(777, 4);

  /* 掷到 6 → 同一色再掷一次 */
  let s = st;
  let found6 = false;
  for (let r = 0; r < 200; r++) {
    if (dieFor(s.seed, s.roll) === 6) { found6 = true; break; }
    s = applyAction(s, { act: 'move', c: s.turn, plane: -1, r: s.roll });
  }
  ok('能找到掷出 6 的回合', found6);
  if (found6) {
    const c = s.turn;
    const before = s.turn;
    const ns = applyAction(s, { act: 'move', c, plane: 0, r: s.roll });
    eq('掷 6 后还是自己回合', ns.turn, before);
    eq('掷骰序号递增', ns.roll, s.roll + 1);
  }

  /* 走完通道要刚好点数 —— 4 颗都差 1 格，掷到 1 就同时到家并判胜。
     要找一个开局正好掷 1 的种子，不然断言没法写死。 */
  let st2 = null;
  for (let seed = 1; seed < 500; seed++) {
    if (dieFor(seed, 0) === 1) { st2 = initState(seed, 4); break; }
  }
  ok('能找到开局掷出 1 的种子', !!st2);
  if (st2) {
    for (let i = 0; i < 4; i++) st2.planes[0][i] = FINISH_POS - 1;
    const okMove = applyAction(st2, { act: 'move', c: 0, plane: 0, r: st2.roll });
    eq('刚好 1 点 → 到终点', okMove.planes[0][0], FINISH_POS);
    ok('只有 1 颗到家 → 还没判胜', !okMove.over);

    /* 剩下 3 颗已经在终点，再走最后一颗就该判胜 */
    const st2b = initState(st2.seed, 4);
    for (let i = 0; i < 3; i++) st2b.planes[0][i] = FINISH_POS;
    st2b.planes[0][3] = FINISH_POS - 1;
    const win = applyAction(st2b, { act: 'move', c: 0, plane: 3, r: st2b.roll });
    eq('4 颗全到终点 → 判胜', win.over, true);
    eq('胜者是该颜色', win.winner, 0);
  }

  /* 4 颗全到终点 → 判胜（直接构造局面后走一个合法动作） */
  const st3 = initState(2, 4);
  for (let i = 0; i < 4; i++) st3.planes[0][i] = FINISH_POS;
  st3.planes[1][0] = 3;                    /* 对方还有棋子在走，保证轮次合法 */
  const ns3 = applyAction(st3, { act: 'move', c: 0, plane: -1, r: st3.roll });
  ok('4 颗全在终点 → 判胜', ns3.over && ns3.winner === 0,
    'over=' + ns3.over + ' winner=' + ns3.winner);

  /* 结束后不再接受动作 */
  const ns4 = applyAction(ns3, { act: 'move', c: 0, plane: -1, r: ns3.roll });
  eq('已结束 → 状态不变', hashState(ns4), hashState(ns3));

  /* 没走几步（都待飞）时，掷到 6 才能动 */
  const st5 = initState(3, 4);
  const legal5 = legalPlanes(st5, 0);
  ok('开局只有掷到 6 才有棋可走', legal5.length === (dieFor(3, 0) === 6 ? 4 : 0),
    'die=' + dieFor(3, 0));
}

/* =============================================================================
 * 8. 摘要与视图
 * ========================================================================== */
console.log('\n=== 8. 摘要与视图 ===');
{
  const st = initState(555, 4);
  eq('摘要稳定', hashState(st), hashState(initState(555, 4)));
  ok('不同种子摘要不同', hashState(st) !== hashState(initState(556, 4)));
  ok('种子进摘要（房主改种子会被发现）', hashState(st).indexOf('555') >= 0);
  ok('掷骰序号进摘要（房主改点数会被发现）', hashState(st).indexOf('|0|') >= 0);

  const v = publicView(st);
  ok('视图是深拷贝', v.planes !== st.planes);
  eq('视图内容一致', hashState(v), hashState(st));
}

/* =============================================================================
 * 9. AI
 * ========================================================================== */
console.log('\n=== 9. AI 选棋 ===');
{
  const st = initState(4321, 4);
  /* 全待飞且掷到 6 → AI 应该起飞 */
  if (dieFor(4321, 0) === 6) {
    const pick = aiChoose(st, 0);
    ok('AI 会起飞', pick >= 0, 'pick=' + pick);
  } else {
    eq('不能起飞时 AI 选择过', aiChoose(st, 0), -1);
  }

  /* 有棋能到终点 → AI 一定走它 */
  const st2 = initState(1, 4);
  for (let i = 0; i < 3; i++) st2.planes[0][i] = FINISH_POS;
  st2.planes[0][3] = FINISH_POS - 1;
  if (dieFor(1, st2.roll) === 1) {
    eq('AI 优先走到终点', aiChoose(st2, 0), 3);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
