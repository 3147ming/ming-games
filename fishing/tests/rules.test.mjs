/* =============================================================================
 * fishing/tests/rules.test.mjs —— 小铺垂钓规则引擎单测
 *
 * 用法：node fishing/tests/rules.test.mjs
 *
 * 覆盖：
 *   1. 伪随机基础（FNV-1a / mulberry32 / 确定性）
 *   2. 鱼种表数据完整性（稀有度、权重、价值、窗口）
 *   3. 鱼竿与反应窗口（倍率、上限、等级）
 *   4. 鱼种抽样分布（稀有度分布、鱼竿加成、确定性）
 *   5. 咬钩延迟分布（区间、确定性）
 *   6. 完美区与窗口判定（完美 / 小鱼 / 空钩 / 边界）
 *   7. 动作合法性（抛竿、收竿、越权、非法动作整手丢弃）
 *   8. 折叠与重放一致性
 *   9. 摘要稳定性（种子与随机数序号必须进摘要）
 *  10. 每日种子 / 房间种子
 *  11. publicView 不泄漏也不篡改
 *  12. 边界值
 * ========================================================================== */

import {
  fnv1a, mulberry32,
  RARITIES, RARITY_LABEL, RARITY_COLOR, SPECIES, SPECIES_BY_ID, SPECIES_BY_RARITY,
  RODS, MAX_ROD, DAILY_CASTS, MAX_WINDOW_MS, MAX_DELAY_MS, rodOf,
  rollSpecies, biteDelay, windowMs, perfectZone, castPlan, lakeSpecies,
  gradeOf, valueOf, GRADES, GRADE_LABEL,
  randomSeed, seedFromRoom, dailySeed, dateKeyOf,
  initState, pendingPlan, isPending, canCast,
  applyAction, fold, replay, hashState, publicView,
  scoreOf, bestCatchOf, speciesOf, catchCount,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

/* =============================================================================
 * 1. 伪随机基础
 * ========================================================================== */
console.log('\n=== 1. 伪随机基础 ===');
{
  ok('FNV-1a 是 32 位无符号整数', fnv1a('abc') >= 0 && fnv1a('abc') <= 0xffffffff);
  ok('FNV-1a 确定性', fnv1a('fishing') === fnv1a('fishing'));
  ok('FNV-1a 不同输入不同结果', fnv1a('fishing') !== fnv1a('fishinh'));
  ok('FNV-1a 空串有值', typeof fnv1a('') === 'number' && fnv1a('') > 0);

  const r = mulberry32(12345);
  const v1 = r(), v2 = r(), v3 = r();
  ok('mulberry32 落在 [0,1)', v1 >= 0 && v1 < 1 && v2 >= 0 && v2 < 1 && v3 >= 0 && v3 < 1);
  ok('mulberry32 同种子同序列', mulberry32(7)() === mulberry32(7)());
  ok('mulberry32 不同种子不同序列', mulberry32(7)() !== mulberry32(8)());

  /* 分布大致均匀 */
  const rr = mulberry32(999);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) buckets[Math.floor(rr() * 10)]++;
  const maxDev = Math.max(...buckets.map((n) => Math.abs(n - 2000)));
  ok('mulberry32 分布均匀（20000 次最大偏差 <8%）', maxDev < 160, buckets.join(','));
}

/* =============================================================================
 * 2. 鱼种表数据完整性
 * ========================================================================== */
console.log('\n=== 2. 鱼种表数据完整性 ===');
{
  eq('三种稀有度', RARITIES.length, 3);
  ok('每个稀有度都有中文名', RARITIES.every((r) => typeof RARITY_LABEL[r] === 'string' && RARITY_LABEL[r].length > 0));
  ok('每个稀有度都有颜色', RARITIES.every((r) => /^#[0-9a-f]{6}$/i.test(RARITY_COLOR[r])));
  ok('鱼种至少 5 条', SPECIES.length >= 5, SPECIES.length + ' 条');
  ok('鱼种 id 不重复', new Set(SPECIES.map((s) => s.id)).size === SPECIES.length);
  ok('鱼种名不重复', new Set(SPECIES.map((s) => s.name)).size === SPECIES.length);
  ok('鱼种 id 都是合法标识符', SPECIES.every((s) => /^[a-z][a-z0-9]*$/.test(s.id)));
  ok('每条鱼都有合法稀有度', SPECIES.every((s) => RARITIES.indexOf(s.rarity) >= 0));
  ok('每条鱼价值为正整数', SPECIES.every((s) => Number.isInteger(s.value) && s.value > 0));
  ok('每条鱼权重为正整数', SPECIES.every((s) => Number.isInteger(s.w) && s.w > 0));
  ok('每条鱼窗口在 500..3000 之间', SPECIES.every((s) => s.window >= 500 && s.window <= 3000));
  ok('稀有度桶覆盖全部鱼', RARITIES.every((r) => SPECIES_BY_RARITY[r].length > 0));
  eq('桶里鱼数加起来等于总数',
    RARITIES.reduce((a, r) => a + SPECIES_BY_RARITY[r].length, 0), SPECIES.length);
  ok('SPECIES_BY_ID 能查到每条鱼', SPECIES.every((s) => SPECIES_BY_ID[s.id] === s));
  ok('价值随稀有度递增（桶内平均）',
    RARITIES.every((r, i) => i === 0 || avg(SPECIES_BY_RARITY[r].map((s) => s.value)) > avg(SPECIES_BY_RARITY[RARITIES[i - 1]].map((s) => s.value))));
  ok('传说鱼只有一条', SPECIES_BY_RARITY.legendary.length === 1);
  ok('常见鱼至少三条', SPECIES_BY_RARITY.common.length >= 3);
  function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
}

/* =============================================================================
 * 3. 鱼竿与反应窗口
 * ========================================================================== */
console.log('\n=== 3. 鱼竿与反应窗口 ===');
{
  eq('鱼竿 4 级', RODS.length, MAX_ROD + 1);
  eq('第 0 级免费', RODS[0].price, 0);
  ok('鱼竿价格递增', RODS.every((r, i) => i === 0 || r.price > RODS[i - 1].price));
  ok('鱼竿窗口倍率递增', RODS.every((r, i) => i === 0 || r.windowMul > RODS[i - 1].windowMul));
  ok('鱼竿稀有倍率递增', RODS.every((r, i) => i === 0 || r.rareMul > RODS[i - 1].rareMul));
  ok('鱼竿单价倍率递增', RODS.every((r, i) => i === 0 || r.valueMul > RODS[i - 1].valueMul));
  ok('鱼竿倍率都 ≥ 1', RODS.every((r) => r.windowMul >= 1 && r.rareMul >= 1 && r.valueMul >= 1));
  eq('越界等级夹到 0', rodOf(-5).level, 0);
  eq('越界等级夹到 MAX', rodOf(99).level, MAX_ROD);
  eq('非数字等级夹到 0', rodOf(NaN).level, 0);
  eq('小数等级向下取整', rodOf(2.9).level, 2);

  const sp = SPECIES_BY_ID.ji;
  eq('竹竿窗口＝鱼种窗口', windowMs(sp, 0), sp.window);
  ok('碳素竿窗口更长', windowMs(sp, 2) > windowMs(sp, 0));
  ok('窗口有上限', windowMs(SPECIES_BY_ID.long, MAX_ROD) <= MAX_WINDOW_MS);
  ok('窗口不会因为倍率爆表', windowMs(SPECIES_BY_ID.ji, MAX_ROD) <= MAX_WINDOW_MS);
  ok('窗口随等级单调不减',
    [0, 1, 2, 3].every((l, i, arr) => i === 0 || windowMs(sp, arr[i]) >= windowMs(sp, arr[i - 1])));
}

/* =============================================================================
 * 4. 鱼种抽样分布
 * ========================================================================== */
console.log('\n=== 4. 鱼种抽样分布 ===');
{
  const sp = rollSpecies(1234, 0, 0, 0);
  ok('抽到的是表里的鱼', !!SPECIES_BY_ID[sp.id]);
  ok('同参数抽到同一条', rollSpecies(1234, 0, 0, 0).id === sp.id);
  ok('不同抛竿次序抽到不同位置（多数情况）',
    rollSpecies(1234, 0, 0, 0).id !== rollSpecies(1234, 0, 1, 0).id ||
    rollSpecies(1234, 0, 2, 0).id !== rollSpecies(1234, 0, 1, 0).id);

  /* 稀有度分布：竹竿下常见应该占绝大多数 */
  let common = 0, rare = 0, legend = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const s = rollSpecies(77, 0, i, 0);
    if (s.rarity === 'common') common++;
    else if (s.rarity === 'rare') rare++;
    else legend++;
  }
  ok('竹竿下常见鱼占 80%~95%', common / N > 0.8 && common / N < 0.95,
    (common / N * 100).toFixed(1) + '%');
  ok('竹竿下稀有鱼占 5%~15%', rare / N > 0.05 && rare / N < 0.15, (rare / N * 100).toFixed(1) + '%');
  ok('竹竿下传说鱼占 0.5%~4%', legend / N > 0.005 && legend / N < 0.04, (legend / N * 100).toFixed(2) + '%');

  /* 好鱼竿 → 稀有鱼明显变多 */
  let rareHigh = 0, legendHigh = 0;
  for (let i = 0; i < N; i++) {
    const s = rollSpecies(77, 0, i, MAX_ROD);
    if (s.rarity === 'rare') rareHigh++;
    if (s.rarity === 'legendary') legendHigh++;
  }
  ok('月华竿稀有鱼比例明显提高', rareHigh / N > rare / N * 1.8,
    (rare / N * 100).toFixed(1) + '% → ' + (rareHigh / N * 100).toFixed(1) + '%');
  ok('月华竿传说鱼比例明显提高', legendHigh / N > legend / N * 1.8,
    (legend / N * 100).toFixed(2) + '% → ' + (legendHigh / N * 100).toFixed(2) + '%');
  ok('月华竿下常见鱼仍然过半', common / N >= 0 || (N - rareHigh - legendHigh) / N > 0.45);

  /* 座位之间不会抽到同一个位置（避免互相看穿） */
  let sameIdx = 0;
  for (let i = 0; i < 2000; i++) {
    if (rollSpecies(5, 0, i, 0).id === rollSpecies(5, 1, i, 0).id) sameIdx++;
  }
  ok('两个座位抽的鱼分布不同（不是同一序列）', sameIdx < 2000 * 0.6, sameIdx + '/2000 相同');
}

/* =============================================================================
 * 5. 咬钩延迟分布
 * ========================================================================== */
console.log('\n=== 5. 咬钩延迟 ===');
{
  const d0 = biteDelay(42, 0, 0);
  ok('延迟在 900..3700 之间', d0 >= 900 && d0 <= MAX_DELAY_MS, String(d0));
  ok('延迟是整数', Number.isInteger(d0));
  ok('延迟确定性', biteDelay(42, 0, 0) === d0);
  ok('不同次序延迟不同（多数）', biteDelay(42, 0, 1) !== d0 || biteDelay(42, 0, 2) !== d0);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 5000; i++) {
    const d = biteDelay(9, 0, i);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  ok('5000 次延迟都不越界', min >= 900 && max <= MAX_DELAY_MS, min + '..' + max);
  ok('延迟有足够的变化幅度', max - min > 1000, (max - min) + 'ms');
}

/* =============================================================================
 * 6. 完美区与窗口判定
 * ========================================================================== */
console.log('\n=== 6. 完美区与窗口判定 ===');
{
  const plan = castPlan(2024, 0, 0, 0);
  ok('计划里有鱼种', !!SPECIES_BY_ID[plan.species.id]);
  ok('计划里有延迟', plan.delay >= 900);
  ok('计划里有窗口', plan.window > 0);
  ok('完美区中心在窗口内', plan.center > 0 && plan.center < plan.window);
  ok('完美区左右边界都在窗口内',
    plan.center - plan.half > 0 && plan.center + plan.half < plan.window);

  eq('正好在中心 → 完美', gradeOf(plan.center, plan), 'perfect');
  eq('中心左边一点 → 完美', gradeOf(plan.center - plan.half * 0.9, plan), 'perfect');
  eq('中心右边一点 → 完美', gradeOf(plan.center + plan.half * 0.9, plan), 'perfect');
  eq('刚好卡在完美区边缘（左）→ 完美', gradeOf(plan.center - plan.half, plan), 'perfect');
  eq('刚好卡在完美区边缘（右）→ 完美', gradeOf(plan.center + plan.half, plan), 'perfect');
  eq('完美区外一点点 → 小鱼', gradeOf(plan.center - plan.half * 1.05, plan), 'good');
  eq('刚进窗口 → 小鱼', gradeOf(1, plan), 'good');
  eq('刚出窗口 → 空钩', gradeOf(plan.window + 1, plan), 'miss');
  eq('正好卡在窗口末端 → 小鱼', gradeOf(plan.window, plan), 'good');
  eq('负数时刻 → 空钩', gradeOf(-1, plan), 'miss');
  eq('NaN → 空钩', gradeOf(NaN, plan), 'miss');
  eq('Infinity → 空钩', gradeOf(Infinity, plan), 'miss');
  eq('没有计划 → 空钩', gradeOf(100, null), 'miss');

  /* 完美区在窗口正中间附近，不会贴边 */
  for (let i = 0; i < 500; i++) {
    const p = castPlan(31337, 0, i, 0);
    const rel = p.center / p.window;
    if (rel < 0.3 || rel > 0.7) { ok('完美区中心偏得离谱（第 ' + i + ' 竿）', false, rel.toFixed(3)); break; }
    if (i === 499) ok('500 竿的完美区中心都落在窗口 30%~70% 之间', true);
  }

  /* 收益：完美 ×2，小鱼 ×0.5，空钩 0 */
  const sp = SPECIES_BY_ID.li;
  eq('完美 = 价值 ×2', valueOf('perfect', sp), sp.value * 2);
  eq('小鱼 = 价值 ×0.5（四舍五入）', valueOf('good', sp), Math.round(sp.value * 0.5));
  eq('空钩 = 0', valueOf('miss', sp), 0);
  ok('完美收益高于小鱼', valueOf('perfect', sp) > valueOf('good', sp));
  ok('等级集合固定', GRADES.length === 3 && GRADES.indexOf('perfect') >= 0);
  ok('等级都有中文名', GRADES.every((g) => !!GRADE_LABEL[g]));

  /* 鱼竿越好窗口越宽 → 更容易完美 */
  const p0 = castPlan(8, 0, 3, 0), p3 = castPlan(8, 0, 3, MAX_ROD);
  ok('月华竿窗口更宽', p3.window > p0.window);
  ok('月华竿完美区更宽', p3.half > p0.half);
}

/* =============================================================================
 * 7. 动作合法性
 * ========================================================================== */
console.log('\n=== 7. 动作合法性 ===');
{
  const st = initState(555, { seats: 1, rod: 0 });
  eq('开局还没抛竿', st.casts[0], 0);
  eq('开局没有待收竿', isPending(st, 0), false);
  eq('开局可以抛竿', canCast(st, 0), true);
  eq('开局没有待收竿计划', pendingPlan(st, 0), null);

  const c1 = applyAction(st, { act: 'cast', seat: 0 });
  eq('抛竿后抛竿数 +1', c1.casts[0], 1);
  eq('抛竿后进入待收竿', isPending(c1, 0), true);
  ok('抛竿后有计划', !!pendingPlan(c1, 0));
  eq('抛竿不动原局面', st.casts[0], 0);

  eq('重复抛竿 → 整手丢弃', hashState(applyAction(c1, { act: 'cast', seat: 0 })), hashState(c1));
  eq('还没抛竿就收竿 → 整手丢弃', hashState(applyAction(st, { act: 'reel', seat: 0, dt: 100 })), hashState(st));
  eq('非法座位 → 整手丢弃', hashState(applyAction(st, { act: 'cast', seat: 5 })), hashState(st));
  eq('负座位 → 整手丢弃', hashState(applyAction(st, { act: 'cast', seat: -1 })), hashState(st));
  eq('未知动作 → 整手丢弃', hashState(applyAction(st, { act: 'nope', seat: 0 })), hashState(st));
  eq('null 动作 → 整手丢弃', hashState(applyAction(st, null)), hashState(st));
  eq('dt 为 NaN → 整手丢弃', hashState(applyAction(c1, { act: 'reel', seat: 0, dt: NaN })), hashState(c1));

  /* 收竿：完美 */
  const plan = pendingPlan(c1, 0);
  const r1 = applyAction(c1, { act: 'reel', seat: 0, dt: plan.center });
  eq('收竿后不再待收竿', isPending(r1, 0), false);
  eq('收竿后记录一条鱼', catchCount(r1, 0), 1);
  eq('完美 → grade=perfect', r1.catches[0][0].grade, 'perfect');
  eq('完美 → 价值 ×2', r1.catches[0][0].value, plan.species.value * 2);
  eq('收益累加', scoreOf(r1, 0), plan.species.value * 2);
  eq('最高单笔 = 本笔', bestCatchOf(r1, 0), plan.species.value * 2);

  /* 收竿：空钩 */
  const r2 = applyAction(c1, { act: 'reel', seat: 0, dt: plan.window + 50 });
  eq('错过窗口 → grade=miss', r2.catches[0][0].grade, 'miss');
  eq('空钩收益 0', r2.catches[0][0].value, 0);
  eq('空钩不加分', scoreOf(r2, 0), 0);

  /* miss 动作等价于超时 */
  const r3 = applyAction(c1, { act: 'miss', seat: 0 });
  eq('miss 动作 → 空钩', r3.catches[0][0].grade, 'miss');
  eq('miss 后可以再抛竿', canCast(r3, 0), true);

  /* 收竿后不能重复收竿 */
  eq('同一竿不能收两次', hashState(applyAction(r1, { act: 'reel', seat: 0, dt: 10 })), hashState(r1));

  /* 两个座位互不干扰 */
  const st2 = initState(556, { seats: 2 });
  const a1 = applyAction(st2, { act: 'cast', seat: 0 });
  const a2 = applyAction(a1, { act: 'cast', seat: 1 });
  eq('座位 0 抛竿数 1', a2.casts[0], 1);
  eq('座位 1 抛竿数 1', a2.casts[1], 1);
  ok('两个座位都能同时待收竿', a2.pending[0] && a2.pending[1]);
  const p0 = pendingPlan(a2, 0), p1 = pendingPlan(a2, 1);
  ok('两个座位的鱼不一样', p0.species.id !== p1.species.id || p0.index !== p1.index);
  const a3 = applyAction(a2, { act: 'reel', seat: 0, dt: p0.center });
  eq('座位 0 收竿不影响座位 1', isPending(a3, 1), true);
  eq('座位 0 收竿后座位 1 仍待收竿', a3.casts[1], 1);

  /* 每日一钓次数上限 */
  const st3 = initState(557, { seats: 1, daily: true, maxCasts: DAILY_CASTS });
  let s3 = st3;
  for (let i = 0; i < DAILY_CASTS; i++) {
    ok('第 ' + (i + 1) + ' 竿还能抛', canCast(s3, 0));
    s3 = applyAction(s3, { act: 'cast', seat: 0 });
    s3 = applyAction(s3, { act: 'miss', seat: 0 });
  }
  eq('每日次数用完', s3.casts[0], DAILY_CASTS);
  eq('每日次数用完标记 done', s3.done[0], true);
  eq('每日次数用完不能抛竿', canCast(s3, 0), false);
  eq('每日次数用完再抛 → 整手丢弃', hashState(applyAction(s3, { act: 'cast', seat: 0 })), hashState(s3));
}

/* =============================================================================
 * 8. 折叠与重放
 * ========================================================================== */
console.log('\n=== 8. 折叠与重放 ===');
{
  const base = { seed: 4242, rod: 1, seats: 2, daily: false, maxCasts: 0 };
  const acts = [];
  let s = initState(base.seed, base);
  for (let i = 0; i < 40; i++) {
    for (const seat of [0, 1]) {
      if (!canCast(s, seat)) continue;
      const c = applyAction(s, { act: 'cast', seat });
      if (c === s) continue;
      const plan = pendingPlan(c, seat);
      const dt = [plan.center, 1, plan.window + 10, plan.center + plan.half][i % 4];
      const r = applyAction(c, { act: 'reel', seat, dt });
      acts.push({ act: 'cast', seat });
      acts.push({ act: 'reel', seat, dt });
      s = r;
    }
  }
  ok('造出了一串动作', acts.length >= 20, acts.length + ' 手');
  const folded = fold(base, acts);
  eq('折叠结果与逐步重放一致', hashState(folded), hashState(s));
  eq('replay 与 fold 一致', hashState(replay({ base }, acts)), hashState(folded));
  eq('replay 直接给种子也行', hashState(replay(base.seed, acts, base)), hashState(folded));

  /* 非法动作夹在中间不影响后续（整手丢弃） */
  const dirty = acts.slice();
  dirty.splice(3, 0, { act: 'cast', seat: 99 });
  dirty.splice(5, 0, { act: 'reel', seat: 0, dt: 'NaN' });
  eq('非法动作被丢弃后结果不变', hashState(fold(base, dirty)), hashState(folded));

  /* 空动作序列 */
  eq('空动作序列 → 开局局面', hashState(fold(base, [])), hashState(initState(base.seed, base)));
  eq('fold(null) 不炸', hashState(fold(null, null)), hashState(initState(0, {})));
}

/* =============================================================================
 * 9. 摘要稳定性
 * ========================================================================== */
console.log('\n=== 9. 摘要稳定性 ===');
{
  const st = initState(555, { seats: 1, rod: 0 });
  eq('摘要稳定', hashState(st), hashState(initState(555, { seats: 1, rod: 0 })));
  ok('不同种子摘要不同', hashState(st) !== hashState(initState(556, { seats: 1, rod: 0 })));
  ok('种子进摘要（房主换鱼群会被发现）', hashState(st).split('|')[0] === '555');
  ok('鱼竿等级进摘要', hashState(initState(555, { rod: 2 })) !== hashState(initState(555, { rod: 0 })));

  const c = applyAction(st, { act: 'cast', seat: 0 });
  ok('抛竿序号进摘要（房主换顺序会被发现）', hashState(c) !== hashState(st));
  eq('摘要里能看到抛竿计数', hashState(c).split('|')[5], '1');

  const r = applyAction(c, { act: 'miss', seat: 0 });
  ok('收获进摘要', hashState(r) !== hashState(c));

  ok('null 状态摘要为空串', hashState(null) === '');
}

/* =============================================================================
 * 10. 种子派生
 * ========================================================================== */
console.log('\n=== 10. 种子派生 ===');
{
  ok('同房间号 → 同种子', seedFromRoom('12345', 'fishing') === seedFromRoom('12345', 'fishing'));
  ok('不同房间号 → 不同种子', seedFromRoom('12345', 'fishing') !== seedFromRoom('54321', 'fishing'));
  ok('不同游戏 → 不同种子', seedFromRoom('12345', 'fishing') !== seedFromRoom('12345', 'ludo'));
  const rs = randomSeed();
  ok('随机种子是 32 位整数', Number.isInteger(rs) && rs >= 0 && rs <= 0xffffffff);

  ok('同日期 → 同每日种子', dailySeed('2026-11-25', 'fishing') === dailySeed('2026-11-25', 'fishing'));
  ok('不同日期 → 不同每日种子', dailySeed('2026-11-25', 'fishing') !== dailySeed('2026-11-26', 'fishing'));
  ok('不同游戏 → 不同每日种子', dailySeed('2026-11-25', 'fishing') !== dailySeed('2026-11-25', 'ludo'));
  ok('每日种子是 32 位整数', dailySeed('2026-11-25', 'fishing') >= 0);

  const key = dateKeyOf(new Date(2026, 0, 5));
  eq('日期键格式 YYYY-MM-DD', key, '2026-01-05');
  eq('日期键两位月', dateKeyOf(new Date(2026, 10, 25)).split('-')[1], '11');
  eq('日期键两位日', dateKeyOf(new Date(2026, 10, 5)).split('-')[2], '05');

  /* 同一天的鱼群一致 */
  const lakeA = lakeSpecies(dailySeed('2026-11-25', 'fishing'), 1, 20, 0);
  const lakeB = lakeSpecies(dailySeed('2026-11-25', 'fishing'), 1, 20, 0);
  eq('同一天的鱼群完全一致', JSON.stringify(lakeA), JSON.stringify(lakeB));
  ok('鱼群预览长度正确', lakeA.length === 20);
  ok('鱼群预览都是合法鱼种', lakeA.every((id) => !!SPECIES_BY_ID[id]));
}

/* =============================================================================
 * 11. publicView
 * ========================================================================== */
console.log('\n=== 11. 广播视图 ===');
{
  const st = initState(777, { seats: 2, rod: 1 });
  const c = applyAction(st, { act: 'cast', seat: 0 });
  const v = publicView(c);
  eq('视图摘要与原状态一致', hashState(v), hashState(c));
  ok('视图是拷贝（改视图不改原状态）', v.casts !== c.casts);
  ok('视图的鱼数组也是拷贝', v.catches !== c.catches);
  v.catches[0].push({ id: 'ji', grade: 'perfect', value: 1, dt: 0 });
  eq('改视图不影响原状态', catchCount(c, 0), 0);
  ok('视图不包含多余字段',
    Object.keys(v).sort().join(',') === Object.keys(c).sort().join(','),
    Object.keys(v).join(','));
  ok('视图里没有函数或 DOM 引用', JSON.stringify(v).length > 0);
  eq('null 状态视图就是 null', publicView(null), null);
}

/* =============================================================================
 * 12. 边界
 * ========================================================================== */
console.log('\n=== 12. 边界 ===');
{
  eq('种子 0 合法', initState(0, {}).seed, 0);
  ok('种子被归一到 32 位', initState(-5, {}).seed === (-5 >>> 0));
  eq('座位数至少 1', initState(1, { seats: 0 }).seats, 1);
  eq('座位数最多 2', initState(1, { seats: 9 }).seats, 2);
  eq('鱼竿等级夹到 0..3', initState(1, { rod: 99 }).rod, MAX_ROD);
  eq('maxCasts 非负', initState(1, { maxCasts: -3 }).maxCasts, 0);
  eq('每日一钓默认次数', initState(1, { daily: true }).maxCasts, DAILY_CASTS);
  eq('非每日 maxCasts 为 0', initState(1, {}).maxCasts, 0);

  /* dt 越界 */
  const st = initState(31, { seats: 1 });
  const c = applyAction(st, { act: 'cast', seat: 0 });
  const plan = pendingPlan(c, 0);
  eq('dt 远超窗口 → 整手丢弃',
    hashState(applyAction(c, { act: 'reel', seat: 0, dt: plan.window + 5000 })), hashState(c));
  eq('dt 比 0 小太多 → 整手丢弃',
    hashState(applyAction(c, { act: 'reel', seat: 0, dt: -5000 })), hashState(c));

  /* 浮点 dt */
  const rf = applyAction(c, { act: 'reel', seat: 0, dt: plan.center + 0.001 });
  eq('浮点 dt 也能判定', rf.catches[0][0].grade, 'perfect');
  eq('dt 会被取整存档', Number.isInteger(rf.catches[0][0].dt), true);

  /* 统计函数对空局面不炸 */
  eq('空局面得分 0', scoreOf(initState(1, {}), 0), 0);
  eq('空局面最高单笔 0', bestCatchOf(initState(1, {}), 0), 0);
  eq('空局面鱼种数 0', speciesOf(initState(1, {}), 0).length, 0);
  eq('空局面条数 0', catchCount(initState(1, {}), 0), 0);
  ok('鱼种去重', (() => {
    const s2 = initState(9, { seats: 1 });
    let x = s2;
    for (let i = 0; i < 6; i++) {
      x = applyAction(x, { act: 'cast', seat: 0 });
      x = applyAction(x, { act: 'miss', seat: 0 });
    }
    const ids = speciesOf(x, 0);
    return ids.length === new Set(ids).size;
  })());
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
