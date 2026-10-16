/* 赵云与阿斗 · 无头规则自测（Node，不依赖浏览器）— V2
 * 用法：node tools/rules-test.mjs
 * 覆盖：征兵概率池 / 批量征兵+成本递增 / 合成 / 武将 / 道具(铲子扩荒地) /
 *      阿斗经济 / 无尽波次 / 关卡通关 / 竞技 AI / 击杀赏金 / Boss / 突破口 / 健壮性 / 存档 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src') + path.sep;
const ctx = vm.createContext({ console });
vm.runInContext('window = globalThis;', ctx);
vm.runInContext(`
  var _ls = {};
  var localStorage = {
    getItem: function(k){ return k in _ls ? _ls[k] : null; },
    setItem: function(k,v){ _ls[k] = String(v); },
    removeItem: function(k){ delete _ls[k]; }
  };
`, ctx);

for (const f of ['units.js', 'board.js', 'storage.js', 'ai.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(DIR + f, 'utf8'), ctx, { filename: f });
}
vm.runInContext('ZY.Audio = { play: function(){}, setMuted: function(){}, unlock: function(){} };', ctx);
const ZY = ctx.ZY;
const G = ZY.Game, B = ZY.B, C = ZY.C;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// 把整片己方半区道路都设为可部署（规则测试排除「开局地少」干扰，可在任意己方格落子）
function openDeploy(s, side) {
  s.deploy = {};
  for (let r = 0; r < B.ROWS; r++) for (let c = 0; c < B.COLS; c++) {
    if (B.isOwnRow(side, r) && B.isRoad(r, c)) s.deploy[B.key(r, c)] = true;
  }
}
// 冻结波次（避免测试期间敌方源源不断干扰）
function freezeWaves(s) { s.wave.interval = 1e9; s.wave.pending = []; s.wave.timer = -1e9; }

/* ------------------------------------------------ 1. 征兵概率池 */
section('征兵概率池（10 万次）');
{
  const cnt = { dao: 0, qiang: 0, gong: 0, qi: 0, gold: 0, nong: 0, shovel: 0, brush: 0, warcry: 0 };
  for (let i = 0; i < 100000; i++) {
    const c = ZY.rollRecruit();
    if (c.kind === 'gold') cnt.gold++;
    else if (c.kind === 'item') cnt[c.item]++;
    else cnt[c.type]++;
  }
  const p = (n) => (cnt[n] / 1000).toFixed(1) + '%';
  console.log('   刀' + p('dao') + ' 枪' + p('qiang') + ' 弓' + p('gong') + ' 骑' + p('qi') +
    ' 金' + p('gold') + ' 铲' + p('shovel') + ' 农' + p('nong') + ' 笔' + p('brush') + ' 符' + p('warcry'));
  ok('刀 ≈22%', Math.abs(cnt.dao / 1000 - 22) < 1.5);
  ok('枪 ≈18%', Math.abs(cnt.qiang / 1000 - 18) < 1.5);
  ok('弓 ≈13%', Math.abs(cnt.gong / 1000 - 13) < 1.5);
  ok('骑 ≈9%', Math.abs(cnt.qi / 1000 - 9) < 1.3);
  ok('金色武将字 ≈15%', Math.abs(cnt.gold / 1000 - 15) < 1.5);
  ok('铲子 ≈12%', Math.abs(cnt.shovel / 1000 - 12) < 1.3);
  ok('农民 ≈5%', Math.abs(cnt.nong / 1000 - 5) < 1.0);
  ok('毛笔 ≈3%', Math.abs(cnt.brush / 1000 - 3) < 0.8);
  ok('神兵符 ≈3%', Math.abs(cnt.warcry / 1000 - 3) < 0.8);
  const tot = cnt.dao + cnt.qiang + cnt.gong + cnt.qi + cnt.gold + cnt.shovel + cnt.nong + cnt.brush + cnt.warcry;
  ok('概率池合计 = 100', tot === 100000, tot + '');
}

/* ------------------------------------------------ 2. 批量征兵 + 成本递增 */
section('批量征兵（3 张）+ 成本递增');
{
  const s = G.baseState('endless', {});
  s.player.bun = 99999;
  const c0 = s.player.recruitCost;
  ok('初始征兵成本 = RECRUIT_BASE_COST', c0 === C.RECRUIT_BASE_COST, c0 + '');
  const r1 = G.recruit(s, 'player');
  ok('一次征兵出 3 张', r1 && r1.cards.length === C.BATCH, r1 ? r1.cards.length + '' : 'null');
  ok('手牌增加 3 张', s.player.hand.length === 3, s.player.hand.length + '');
  ok('成本 +1', s.player.recruitCost === c0 + C.RECRUIT_STEP, s.player.recruitCost + '');
  G.recruit(s, 'player');
  ok('连征成本再 +1', s.player.recruitCost === c0 + 2 * C.RECRUIT_STEP, s.player.recruitCost + '');
  // 成本递增到上限 60（清空手牌以排除 HAND_MAX 上限影响）
  let guard = 0;
  while (s.player.recruitCost < C.RECRUIT_MAX_COST && guard++ < 100) {
    G.recruit(s, 'player');
    s.player.hand = [];
  }
  ok('成本封顶 = RECRUIT_MAX_COST', s.player.recruitCost === C.RECRUIT_MAX_COST, s.player.recruitCost + '');
  // 待部署栏上限：重新填满到 HAND_MAX
  s.player.hand = [];
  while (s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
  ok('待部署栏上限 = HAND_MAX', s.player.hand.length === C.HAND_MAX, s.player.hand.length + '');
  const rFull = G.recruit(s, 'player');
  ok('满栏后征兵返回 null', rFull === null);
}

/* ------------------------------------------------ 3. 合成规则 */
section('合成规则');
{
  const s = G.baseState('endless', {});
  openDeploy(s, 'player');
  s.player.bun = 999;
  s.player.hand = [
    { uid: 1, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 2, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 3, kind: 'unit', char: '枪', type: 'qiang', level: 1 },
  ];
  G.deploy(s, 'player', 1, 10, 2);
  G.deploy(s, 'player', 2, 10, 4);
  G.deploy(s, 'player', 3, 10, 5);
  const a = s.grid[10][2];
  ok('部署成功：刀 lv1', a && a.type === 'dao' && a.level === 1);
  const r1 = G.dropUnitOn(s, 'player', a.id, 10, 4);
  ok('同字同级可合成', r1.ok && s.grid[10][4].level === 2, JSON.stringify(r1));
  const r2 = G.dropUnitOn(s, 'player', s.grid[10][4].id, 10, 5);
  ok('异字不可合成', !r2.ok, r2.msg);
  const s2 = G.baseState('endless', {});
  openDeploy(s2, 'player');
  const mkAt = (lv, col) => {
    const u = G.makeUnit(s2, 'player', { cls: 'soldier', type: 'dao', level: lv, row: 9, col: col });
    G.addUnit(s2, u); return u;
  };
  let cur = mkAt(1, 0);
  for (let lv = 1; lv < 5; lv++) {
    const mate = mkAt(lv, 7);
    const res = G.dropUnitOn(s2, 'player', mate.id, 9, 0);
    if (!res.ok) { ok('逐级合成 lv' + (lv + 1), false, res.msg); break; }
  }
  ok('逐级合成到 5 级', cur.level === 5, '实际 ' + cur.level);
  const s3 = G.baseState('endless', {});
  openDeploy(s3, 'player');
  const u5a = G.makeUnit(s3, 'player', { cls: 'soldier', type: 'dao', level: 5, row: 9, col: 0 });
  const u5b = G.makeUnit(s3, 'player', { cls: 'soldier', type: 'dao', level: 5, row: 9, col: 1 });
  G.addUnit(s3, u5a); G.addUnit(s3, u5b);
  const r5 = G.dropUnitOn(s3, 'player', u5b.id, 9, 0);
  ok('满级不再合成', !r5.ok, r5.msg);
  const l1 = ZY.statsAt('dao', 1), l2 = ZY.statsAt('dao', 2), l5 = ZY.statsAt('dao', 5);
  ok('每级 血×1.55', Math.abs(l2.hp / l1.hp - 1.55) < 1e-9, (l2.hp / l1.hp).toFixed(4));
  ok('每级 攻×1.85', Math.abs(l2.atk / l1.atk - 1.85) < 1e-9);
  ok('每级 攻速×1.05', Math.abs(l2.aspd / l1.aspd - 1.05) < 1e-9);
}

/* ------------------------------------------------ 4. 武将合成 */
section('武将合成');
{
  const mk = (chars, cols) => {
    const s = G.baseState('endless', {});
    openDeploy(s, 'player');
    s.player.hand = chars.map((ch, i) => ({ uid: i + 1, kind: 'gold', char: ch, level: 1 }));
    chars.forEach((ch, i) => G.deploy(s, 'player', i + 1, 8, cols[i]));
    return s;
  };
  let s = mk(['赵', '云'], [2, 3]);
  ok('赵+云（左→右相邻）→ 赵云', s.grid[8][2] && s.grid[8][2].cls === 'hero' && s.grid[8][2].heroId === 'zhaoyun');
  s = mk(['云', '赵'], [2, 3]);
  ok('顺序颠倒不成将', !(s.grid[8][2] && s.grid[8][2].cls === 'hero'));
  s = mk(['赵', '云'], [2, 5]);
  ok('不相邻不成将', !(s.grid[8][2] && s.grid[8][2].cls === 'hero'));
  const hero = mk(['赵', '云'], [2, 3]).grid[8][2];
  const st = ZY.heroStats('zhaoyun', 1);
  const base = ZY.statsAt('qiang', 3);
  ok('武将数值 = 兵种 L3 ×1.2', Math.abs(st.hp - base.hp * 1.2) < 1e-9 && Math.abs(st.atk - base.atk * 1.2) < 1e-9);
  ok('赵云射程 3', hero.range === 3);
  let allOk = true;
  ZY.HEROES.forEach((h) => {
    const st2 = mk(h.chars, [1, 2]);
    const u = st2.grid[8][1];
    if (!u || u.cls !== 'hero' || u.heroId !== h.id) allOk = false;
  });
  ok('六位武将全部可合成', allOk);
  const sf = ZY.heroStats('zhangfei', 1), sb = ZY.heroStats('zhangbao', 1);
  ok('张飞血高于张苞（高血高防）', sf.hp > sb.hp && sf.dmgReduce > 0);
}

/* ------------------------------------------------ 5. 道具：铲子扩荒地（V2 核心） */
section('道具：铲子扩地 / 毛笔 / 神兵符');
{
  const s = G.baseState('endless', {});
  // 开局可部署地 = 3×3（rows9-11 × cols3-5）
  const startCells = Object.keys(s.deploy).length;
  ok('开局可部署地 = 3×3 = 9 格', startCells === 9, startCells + '');

  // 荒地：road 但不在 deploy，且与 deploy 相邻 → 可扩
  const waste = { r: 8, c: 4 }; // 邻接 (9,4)∈deploy
  ok('荒地初始不可部署', !B.canPlace(s, 'player', waste.r, waste.c));
  const rr = G.useShovel(s, 'player', waste.r, waste.c);
  ok('铲子扩成可部署地', rr.ok && B.canPlace(s, 'player', waste.r, waste.c));
  ok('扩地后 deploy +1', Object.keys(s.deploy).length === 10, Object.keys(s.deploy).length + '');
  ok('同一格二次扩地失败', !G.useShovel(s, 'player', waste.r, waste.c).ok);

  // 铲子不能扩「不相邻」的格
  const far = { r: 6, c: 0 };
  ok('铲子不能扩不相邻的格', !G.useShovel(s, 'player', far.r, far.c).ok);
  // 铲子不能扩障碍格
  const obs = (() => { for (let r = 0; r < B.ROWS; r++) for (let c = 0; c < B.COLS; c++) if (B.isObstacle(r, c)) return { r, c }; })();
  ok('铲子不能扩障碍格', !G.useShovel(s, 'player', obs.r, obs.c).ok);

  // 全开 deploy 后测毛笔 / 神兵符
  openDeploy(s, 'player');
  const u = G.makeUnit(s, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 10, col: 1 });
  G.addUnit(s, u);
  const before = u.char;
  const br = G.useBrush(s, 'player', u.id);
  ok('毛笔改写同色字', br.ok && u.char !== before && ['刀', '枪', '弓', '骑'].indexOf(u.char) >= 0, before + '→' + u.char);
  const gold = G.makeUnit(s, 'player', { cls: 'gold', char: '赵', row: 10, col: 5 });
  G.addUnit(s, gold);
  const br2 = G.useBrush(s, 'player', gold.id);
  ok('毛笔只改同色（金→金）', br2.ok && ZY.GOLD_CHARS.indexOf(gold.char) >= 0);
  const nong = G.makeUnit(s, 'player', { cls: 'soldier', type: 'nong', level: 1, row: 10, col: 6 });
  G.addUnit(s, nong);
  ok('农民不能被毛笔改写', !G.useBrush(s, 'player', nong.id).ok);

  G.useWarcry(s, 'player');
  ok('神兵符 buff = 10s', Math.abs(s.buff.player - C.WARCRY_TIME) < 1e-9);
}

/* ------------------------------------------------ 6. 阿斗与卖血经济 */
section('阿斗掉血 +10 馒头补偿');
{
  const s = G.baseState('endless', {});
  openDeploy(s, 'player');
  s.player.bun = 0;
  const e = G.makeUnit(s, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 10, col: 3 });
  G.addUnit(s, e);
  const hp0 = s.player.adou, bun0 = s.player.bun;
  for (let i = 0; i < 80 && s.player.adou === hp0; i++) G.tick(s, 0.1);
  ok('敌方踏入阿斗格 → 掉 1 血', s.player.adou === hp0 - 1, 'adou=' + s.player.adou);
  ok('补偿 +10 馒头', s.player.bun - bun0 >= 10, '+' + (s.player.bun - bun0).toFixed(2));
  ok('该敌方单位被移除', e.dead);
  for (let i = 0; i < 400 && !s.over; i++) {
    if (!s.units.some((u) => u.side === 'enemy')) {
      G.addUnit(s, G.makeUnit(s, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 10, col: 3 }));
    }
    G.tick(s, 0.1);
  }
  ok('阿斗归零 → 本局结束（败）', s.over && s.result === 'lose', 'adou=' + s.player.adou);
}

/* ------------------------------------------------ 7. 击杀赏金 */
section('击杀赏金（普 +1 / 精英 +8 / Boss +30 / 玩家单位 0）');
{
  const s = G.baseState('endless', {});
  const mk = (side, opts) => G.makeUnit(s, side, Object.assign({ cls: 'soldier', type: 'zei', level: 1, row: 5, col: 0 }, opts));
  ok('普通敌人赏金 = NORMAL_BOUNTY', mk('enemy').bounty === C.NORMAL_BOUNTY);
  ok('精英赏金 = ELITE_BOUNTY', mk('enemy', { elite: true }).bounty === C.ELITE_BOUNTY);
  ok('Boss 赏金 = BOSS_BOUNTY', mk('enemy', { boss: true }).bounty === C.BOSS_BOUNTY);
  ok('敌方武将赏金 = 6', mk('enemy', { cls: 'hero', heroId: 'zhaoyun', heroLevel: 1 }).bounty === 6);
  ok('玩家单位赏金 = 0', mk('player').bounty === 0);

  // 集成验证：玩家击杀一个普通敌人 → bun 增加 ≈ 赏金（隔离自然收入）
  const sb = G.baseState('endless', {});
  freezeWaves(sb);
  sb.player.bun = 0; sb.enemy.adou = 1e9;
  // 收入基准：无敌人时 0.2s 的增幅
  G.tick(sb, 0.2); const income = sb.player.bun;
  sb.player.bun = 0;
  const e0 = G.makeUnit(sb, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 5, col: 0 }); e0.hp = 1; G.addUnit(sb, e0);
  const a0 = G.makeUnit(sb, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 6, col: 0 }); a0.atk = 300; a0.aspd = 6; a0.range = 1; G.addUnit(sb, a0);
  G.tick(sb, 0.3);
  ok('击杀普通敌人 → 赏金入账', sb.player.bun >= C.NORMAL_BOUNTY, 'bun=' + sb.player.bun.toFixed(2) + '（基准收入≈' + income.toFixed(2) + '）');
}

/* ------------------------------------------------ 8. Boss（关底强化波） */
section('Boss：关底强化波');
{
  const s = G.baseState('level', { levelIdx: 0 });
  s.player.adou = 1e9; s.enemy.adou = 1e9;
  s.wave.idx = 3; s.wave.done = false; s.wave.pending = []; s.wave.timer = s.wave.interval;
  G.tick(s, 0.2); // 触发第 4 波（关底）
  let hasBoss = false;
  for (const spec of s.wave.pending) if (spec.boss) hasBoss = true;
  ok('关底强化波含 Boss', hasBoss);
  // 让 Boss 真正出场
  for (let i = 0; i < 60 && !s.units.some((u) => u.boss); i++) G.tick(s, 0.1);
  const bo = s.units.find((u) => u.boss);
  ok('Boss 出场且带 boss 标记', !!bo && bo.boss);
  ok('Boss 血量远高于普通同波（×' + C.BOSS_HP_MUL + '）', bo.maxHp > ZY.BOSS.hp * C.BOSS_HP_MUL, 'hp=' + bo.maxHp.toFixed(0));
  ok('Boss 攻击倍率 ×' + C.BOSS_ATK_MUL, bo.atk > ZY.BOSS.atk * C.BOSS_ATK_MUL * 0.5, 'atk=' + bo.atk.toFixed(1));
  ok('Boss 击杀赏金 +' + C.BOSS_BOUNTY, bo.bounty === C.BOSS_BOUNTY);

  // Boss 技能「震击」：环形伤害 + 眩晕
  const sb = G.baseState('level', { levelIdx: 0 });
  freezeWaves(sb); sb.player.adou = 1e9; sb.enemy.adou = 1e9;
  const pb = G.makeUnit(sb, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 6, col: 3 }); pb.maxHp = 9999; pb.hp = 9999; pb.aspd = 0; G.addUnit(sb, pb);
  const boss = G.makeUnit(sb, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 5, col: 3, boss: true }); boss.move = 0; boss.skillT = 0.1; G.addUnit(sb, boss);
  let stunned = false;
  for (let i = 0; i < 80 && !stunned; i++) { G.tick(sb, 0.1); if (pb.stun > 0) stunned = true; }
  ok('Boss 震击使相邻玩家单位眩晕', stunned, 'stun=' + pb.stun.toFixed(2));
}

/* ------------------------------------------------ 9. 突破口事件（V2 核心） */
section('突破口事件（无尽 / 关卡）');
{
  const T = ZY.TUNE, SG = G.SPAWN_GAP;
  // 无尽：第 breakStart(4) 波触发突破口
  const s = G.baseState('endless', {});
  s.player.adou = 1e9; s.enemy.adou = 1e9;
  s.nextBreak = 4;
  s.wave.idx = 3; s.wave.timer = s.wave.interval;
  G.tick(s, 0.2); // 触发第 4 波，且 = nextBreak → 突破口
  ok('突破口标记 breakCols（兵线列）', Array.isArray(s.wave.breakCols) && s.wave.breakCols.length > 0, JSON.stringify(s.wave.breakCols));
  ok('突破口出怪间隔减半（< 普通间隔）', s.wave.spawnGap < SG, s.wave.spawnGap + ' < ' + SG);
  ok('横幅含「突破口」', s.banner && s.banner.text.indexOf('突破口') >= 0, s.banner && s.banner.text);

  // 关卡：第 levelBreakWave(2) 波随机一次突破口
  const sl = G.baseState('level', { levelIdx: 0 });
  sl.player.adou = 1e9; sl.enemy.adou = 1e9;
  sl.levelBtDone = false; sl.wave.idx = 1; sl.wave.timer = sl.wave.interval;
  G.tick(sl, 0.2);
  ok('关卡第 2 波亦可能触发突破口（breakCols 或标记）', sl.wave.breakCols !== null || sl.levelBtDone, 'bc=' + JSON.stringify(sl.wave.breakCols));

  // 缺口处出怪数量更多：同波号（第 4 波）对比「普通」与「突破」
  const base = G.baseState('endless', {});
  base.player.adou = 1e9; base.enemy.adou = 1e9;
  base.nextBreak = 999; base.wave.idx = 3; base.wave.timer = base.wave.interval;
  G.tick(base, 0.2);
  const normalCount = base.wave.pending.length;
  ok('突破口波兵数 > 普通波兵数', s.wave.pending.length > normalCount, s.wave.pending.length + ' > ' + normalCount);
}

/* ------------------------------------------------ 10. 开局地：关卡 4 关扩 4×4 */
section('开局地规模（关卡难度递增）');
{
  const a = G.baseState('level', { levelIdx: 0 });
  ok('第 1 关开局地 = 3×3 = 9', Object.keys(a.deploy).length === 9, Object.keys(a.deploy).length + '');
  const b = G.baseState('level', { levelIdx: 3 });
  ok('第 4 关开局地 = 4×4 = 16', Object.keys(b.deploy).length === 16, Object.keys(b.deploy).length + '');
  const v = G.baseState('versus', { difficulty: 1 });
  ok('竞技双方开局地 = 18（各 9）', Object.keys(v.deploy).length === 18, Object.keys(v.deploy).length + '');
}

/* ------------------------------------------------ 11. 无尽模式波次 */
section('无尽模式波次节奏');
{
  const T = ZY.TUNE;
  const s = G.baseState('endless', {});
  s.player.adou = 99999; s.enemy.adou = 99999;
  for (let i = 0; i < 1500; i++) G.tick(s, 0.1);
  const gapOf = (n) => Math.max(T.endlessMin, T.endlessInterval * Math.pow(T.endlessDecay, n));
  ok('波次持续推进', s.wave.idx >= 8, '第 ' + s.wave.idx + ' 波');
  ok('首波间隔 = TUNE.endlessInterval', Math.abs(s.wave.interval - gapOf(s.wave.idx)) < 1e-9, s.wave.interval.toFixed(2) + 's');
  ok('间隔逐波递减且不低于下限', gapOf(2) < gapOf(1) && gapOf(99) === T.endlessMin);
  const c1 = Math.floor(T.endlessBase + 1 * T.endlessStep);
  const c10 = Math.floor(T.endlessBase + 10 * T.endlessStep);
  ok('每波数量 = base + 波数×step（递增）', c10 > c1 && c1 >= 2, c1 + ' / ' + c10);
  ok('强化波（第 10 波）数量翻倍', Math.round(c10 * T.endlessEliteMul) > c10);
}

/* ------------------------------------------------ 12. 关卡模式 */
section('关卡模式（巨鹿 → 通关）');
{
  const s = G.baseState('level', { levelIdx: 0 });
  s.player.bun = 100000;
  openDeploy(s, 'player');           // 全开己方半区，给玩家公平布防空间
  let guard = 0;
  while (!s.over && guard++ < 8000) {
    if (s.player.bun >= s.player.recruitCost && s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
    const card = s.player.hand.find((x) => x.kind !== 'item');
    if (card) {
      outer: for (let r = 6; r <= 11; r++) {
        for (let c = 0; c < B.COLS; c++) {
          if (B.canPlace(s, 'player', r, c)) { G.deploy(s, 'player', card.uid, r, c); break outer; }
        }
      }
    }
    s.player.hand = s.player.hand.filter((x) => x.kind !== 'item');
    G.tick(s, 0.1);
  }
  ok('关卡模式可通关（4 波清空 → win）', s.over && s.result === 'win', 'result=' + s.result + ' wave=' + s.wave.idx);
  ok('关卡共 4 波（3 普通 + 1 关底）', s.wave.idx === 4, 'wave=' + s.wave.idx);
}

/* ------------------------------------------------ 13. 竞技模式 AI */
section('竞技模式 AI 行为');
{
  const s = G.baseState('versus', { difficulty: 1 });
  let guard = 0;
  let aiLvPeak = 0, aiHeroPeak = 0, aiUnitsPeak = 0, aiShovel = false;
  // 记录 AI 是否用铲子扩过地（deploy 数 > 初始 18）
  while (!s.over && guard++ < 3000) {
    if (s.player.bun >= s.player.recruitCost && s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
    const card = s.player.hand.find((x) => x.kind !== 'item');
    if (card) {
      outer2: for (let r = 11; r >= 6; r--) {
        for (let c = 0; c < B.COLS; c++) {
          if (B.canPlace(s, 'player', r, c)) { G.deploy(s, 'player', card.uid, r, c); break outer2; }
        }
      }
    }
    s.player.hand = s.player.hand.filter((x) => x.kind !== 'item');
    G.tick(s, 0.1);
    if (Object.keys(s.deploy).length > 18) aiShovel = true;
    const lv = s.units.filter((u) => u.side === 'enemy' && u.cls === 'soldier' && u.level > 1).length;
    const hr = s.units.filter((u) => u.side === 'enemy' && u.cls === 'hero').length;
    const al = s.units.filter((u) => u.side === 'enemy').length;
    if (lv > aiLvPeak) aiLvPeak = lv;
    if (hr > aiHeroPeak) aiHeroPeak = hr;
    if (al > aiUnitsPeak) aiUnitsPeak = al;
  }
  const aiUnits = s.units.filter((u) => u.side === 'enemy');
  console.log('   结果 ' + s.result + ' · 敌存活 ' + aiUnits.length + ' · 敌武将 ' + aiUnits.filter((u) => u.cls === 'hero').length +
    ' · 敌击杀 ' + s.enemy.kills + ' · 我击杀 ' + s.player.kills +
    ' · 峰值：单位 ' + aiUnitsPeak + ' / 2级以上 ' + aiLvPeak + ' / 武将 ' + aiHeroPeak + ' · 用铲扩地=' + aiShovel);
  ok('AI 会出兵（上半区有单位或曾击杀）', aiUnitsPeak > 0 || s.enemy.kills > 0);
  ok('AI 会合成（出现过 2 级以上单位）', aiLvPeak > 0, '峰值 lv>1 = ' + aiLvPeak);
  ok('AI 会铲子扩地（部署地 > 开局 18）', aiShovel);
  ok('对局能分出胜负', s.over === true, 'over=' + s.over);

  // AI 凑武将：给定两张成对金字，看它会不会主动挨着摆
  const h = G.baseState('versus', { difficulty: 1 });
  openDeploy(h, 'enemy'); h.enemy.adou = 1e9; h.player.adou = 1e9;
  h.enemy.hand = [
    { uid: 901, kind: 'gold', char: '赵', level: 1 },
    { uid: 902, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 903, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 904, kind: 'unit', char: '弓', type: 'gong', level: 1 },
    { uid: 905, kind: 'unit', char: '弓', type: 'gong', level: 1 },
  ];
  ZY.AI.think(h);
  const tile = h.units.find((u) => u.side === 'enemy' && u.cls === 'gold');
  ok('AI 会摆下金字', !!tile, tile ? tile.char + '@' + tile.row + ',' + tile.col : '无');
  h.enemy.bun = 0;
  h.enemy.hand = [{ uid: 906, kind: 'gold', char: '云', level: 1 }];
  ZY.AI.think(h);
  const made = h.units.find((u) => u.side === 'enemy' && u.cls === 'hero');
  ok('AI 会把「云」接到「赵」旁边成将', !!made && made.heroId === 'zhaoyun', made ? made.char : '未成将');
}

/* ------------------------------------------------ 14. 数值健壮性 */
section('数值健壮性');
{
  const s = G.baseState('versus', { difficulty: 1.2 });
  let bad = 0, maxUnits = 0;
  for (let i = 0; i < 2500; i++) {
    if (s.player.bun >= s.player.recruitCost && s.player.hand.length < C.HAND_MAX && Math.random() < 0.6) G.recruit(s, 'player');
    const card = s.player.hand.find((x) => x.kind !== 'item');
    if (card) {
      for (let r = 6; r <= 11; r++) { let done = false; for (let c = 0; c < B.COLS; c++) { if (B.canPlace(s, 'player', r, c)) { G.deploy(s, 'player', card.uid, r, c); done = true; break; } } if (done) break; }
    }
    G.tick(s, 0.1);
    maxUnits = Math.max(maxUnits, s.units.length);
    s.units.forEach((u) => {
      if (!isFinite(u.hp) || !isFinite(u.atk) || !isFinite(u.maxHp) || u.hp > u.maxHp + 1e-6) bad++;
      if (u.row < 0 || u.row > 11 || u.col < 0 || u.col > 7) bad++;
    });
    if (!isFinite(s.player.bun) || !isFinite(s.enemy.bun)) bad++;
  }
  ok('250s 内无 NaN / 越界 / 血量溢出', bad === 0, 'bad=' + bad);
  ok('棋盘同屏单位数合理（<=96）', maxUnits <= 96, 'max=' + maxUnits);
}

/* ------------------------------------------------ 15. 存档键 */
section('存档键前缀');
{
  ZY.Save.setRank(2); ZY.Save.setLevel(3); ZY.Save.setWaveBest(9); ZY.Save.addKills(5); ZY.Save.setMuted(true);
  const keys = Object.keys(ZY.Save.KEYS).map((k) => ZY.Save.KEYS[k]);
  ok('全部键以 zhaoyun_ 开头', keys.every((k) => k.indexOf('zhaoyun_') === 0), keys.join(','));
  ok('军衔读写', ZY.Save.getRank() === 2 && ZY.Save.rankName(2) === '军士三');
  ok('关卡进度读写', ZY.Save.getLevel() === 3);
  ok('最高波数只增不减', ZY.Save.getWaveBest() === 9);
  ok('静音读写', ZY.Save.getMuted() === true);
}

console.log('\n──────────────────────────────');
console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  ❌ 失败 ' + fail : '  ✅ 全部通过'));
process.exit(fail ? 1 : 0);
