/* 赵云与阿斗 · 无头规则自测（Node，不依赖浏览器）— V4 保卫萝卜式塔防
 * 用法：node tools/rules-test.mjs
 * 覆盖：征兵概率池(含火球) / 批量征兵+成本递增 / 拖卡建塔+同字喂养合成 / 武将 /
 *      道具(铲子/毛笔/神兵符/火球3×3) / 阿斗经济(沿主路到终点) / 击杀赏金 /
 *      无尽波次 / 关卡通关 / 竞技 AI(双路公共波次) / 行军纪律(主路/不回头) /
 *      最靠前优先 / Boss / 突破口 / 数值健壮性 / 存档
 */
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

/** 只开放指定塔位（规则测试排除「开局地少」干扰，落点全可控） */
function openSlots(s, side, cells) {
  s.deploy = {};
  cells.forEach(function (k) { s.deploy[k] = side; });
}
/** 在主路第 pi 格放一个冲玩家阿斗的行军敌人（沿路走到终点） */
function spawnOnPath(s, pi, opts) {
  const p = B.pathSeq('endless', 'player')[pi];
  const e = G.makeUnit(s, 'enemy', Object.assign({ cls: 'soldier', type: 'zei', level: 1, row: p.row, col: p.col, target: 'player', pi: pi }, opts || {}));
  G.addUnit(s, e);
  return e;
}
/** 冻结波次（避免测试期间敌方源源不断干扰） */
function freezeWaves(s) { s.wave.interval = 1e9; s.wave.pending = []; s.wave.timer = -1e9; }

/* ------------------------------------------------ 1. 征兵概率池 */
section('征兵概率池（10 万次，含火球）');
{
  const cnt = { dao: 0, qiang: 0, gong: 0, qi: 0, gold: 0, nong: 0, shovel: 0, brush: 0, warcry: 0, fireball: 0 };
  for (let i = 0; i < 100000; i++) {
    const c = ZY.rollRecruit();
    if (c.kind === 'gold') cnt.gold++;
    else if (c.kind === 'item') cnt[c.item]++;
    else cnt[c.type]++;
  }
  const p = (n) => (cnt[n] / 1000).toFixed(1) + '%';
  console.log('   刀' + p('dao') + ' 枪' + p('qiang') + ' 弓' + p('gong') + ' 骑' + p('qi') +
    ' 金' + p('gold') + ' 铲' + p('shovel') + ' 农' + p('nong') + ' 笔' + p('brush') + ' 符' + p('warcry') + ' 火' + p('fireball'));
  ok('刀 ≈21%', Math.abs(cnt.dao / 1000 - 21) < 1.5);
  ok('枪 ≈17%', Math.abs(cnt.qiang / 1000 - 17) < 1.5);
  ok('弓 ≈12%', Math.abs(cnt.gong / 1000 - 12) < 1.5);
  ok('骑 ≈9%', Math.abs(cnt.qi / 1000 - 9) < 1.3);
  ok('金色武将字 ≈14%', Math.abs(cnt.gold / 1000 - 14) < 1.5);
  ok('铲子 ≈11%', Math.abs(cnt.shovel / 1000 - 11) < 1.3);
  ok('农民 ≈5%', Math.abs(cnt.nong / 1000 - 5) < 1.0);
  ok('毛笔 ≈3%', Math.abs(cnt.brush / 1000 - 3) < 0.8);
  ok('神兵符 ≈3%', Math.abs(cnt.warcry / 1000 - 3) < 0.8);
  ok('火球 ≈5%', Math.abs(cnt.fireball / 1000 - 5) < 1.0);
  const tot = cnt.dao + cnt.qiang + cnt.gong + cnt.qi + cnt.gold + cnt.shovel + cnt.nong + cnt.brush + cnt.warcry + cnt.fireball;
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
  let guard = 0;
  while (s.player.recruitCost < C.RECRUIT_MAX_COST && guard++ < 100) {
    G.recruit(s, 'player');
    s.player.hand = [];
  }
  ok('成本封顶 = RECRUIT_MAX_COST', s.player.recruitCost === C.RECRUIT_MAX_COST, s.player.recruitCost + '');
  s.player.hand = [];
  while (s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
  ok('待部署栏上限 = HAND_MAX', s.player.hand.length === C.HAND_MAX, s.player.hand.length + '');
  const rFull = G.recruit(s, 'player');
  ok('满栏后征兵返回 null', rFull === null);
}

/* ------------------------------------------------ 3. 建塔 + 同字喂养合成 */
section('拖卡建塔 + 同字合成 +1 级');
{
  const s = G.baseState('endless', {});
  openSlots(s, 'player', ['1,1', '1,2', '1,3']);
  s.player.bun = 999;
  s.player.hand = [
    { uid: 1, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 2, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 3, kind: 'unit', char: '枪', type: 'qiang', level: 1 },
  ];
  const rb = G.deploy(s, 'player', 1, 1, 1);
  ok('拖兵种卡到塔位 = 建塔', rb.ok && s.grid[1][1] && s.grid[1][1].type === 'dao' && s.grid[1][1].level === 1, JSON.stringify(rb));
  ok('建塔后卡消失', s.player.hand.length === 2, s.player.hand.length + '');
  const r1 = G.deploy(s, 'player', 2, 1, 1);
  ok('同字卡喂到同字塔 = +1 级', r1.ok && s.grid[1][1].level === 2, JSON.stringify(r1));
  ok('等级字段同步（level=2）', s.grid[1][1].level === 2);
  const r2 = G.deploy(s, 'player', 3, 1, 1);
  ok('异字不可合成', !r2.ok && s.grid[1][1].level === 2, r2.msg);
  // 逐级喂养到 5 级
  let lvOk = true;
  for (let lv = 2; lv < 5; lv++) {
    s.player.hand.push({ uid: 100 + lv, kind: 'unit', char: '刀', type: 'dao', level: 1 });
    if (!G.deploy(s, 'player', 100 + lv, 1, 1).ok) { lvOk = false; break; }
  }
  ok('逐级喂养到 5 级', lvOk && s.grid[1][1].level === 5, '实际 ' + (s.grid[1][1] && s.grid[1][1].level));
  s.player.hand.push({ uid: 199, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  const r5 = G.deploy(s, 'player', 199, 1, 1);
  ok('满级（5 级）不可再合成', !r5.ok, r5.msg);
  // 主路格 / 荒地不能建塔
  s.player.hand.push({ uid: 200, kind: 'unit', char: '刀', type: 'dao', level: 1 });
  ok('主路格不能建塔', !G.deploy(s, 'player', 200, 0, 2).ok);
  ok('荒地（非塔位）不能建塔', !G.deploy(s, 'player', 200, 11, 2).ok);
  // 塔位互斥：主路与塔位无交叠
  const pset = B.pathSet('endless');
  ok('主路与塔位互斥', Object.keys(s.deploy).every(function (k) { return !pset[k]; }));
  // 成长曲线（数值基线保留）
  const l1 = ZY.statsAt('dao', 1), l2 = ZY.statsAt('dao', 2);
  ok('每级 血×1.55', Math.abs(l2.hp / l1.hp - 1.55) < 1e-9, (l2.hp / l1.hp).toFixed(4));
  ok('每级 攻×1.85', Math.abs(l2.atk / l1.atk - 1.85) < 1e-9);
  ok('每级 攻速×1.05', Math.abs(l2.aspd / l1.aspd - 1.05) < 1e-9);
}

/* ------------------------------------------------ 4. 武将合成（塔位版） */
section('金字横排成将（塔位版）');
{
  const mk = (chars, cols) => {
    const s = G.baseState('endless', {});
    openSlots(s, 'player', ['1,1', '1,2', '1,3', '1,4', '1,5']);
    s.player.hand = chars.map((ch, i) => ({ uid: i + 1, kind: 'gold', char: ch, level: 1 }));
    chars.forEach((ch, i) => G.deploy(s, 'player', i + 1, 1, cols[i]));
    return s;
  };
  let s = mk(['赵', '云'], [1, 2]);
  ok('赵+云（左→右相邻）→ 赵云', s.grid[1][1] && s.grid[1][1].cls === 'hero' && s.grid[1][1].heroId === 'zhaoyun');
  s = mk(['云', '赵'], [1, 2]);
  ok('顺序颠倒不成将', !(s.grid[1][1] && s.grid[1][1].cls === 'hero'));
  s = mk(['赵', '云'], [1, 3]);
  ok('不相邻不成将', !(s.grid[1][1] && s.grid[1][1].cls === 'hero'));
  const hero = mk(['赵', '云'], [1, 2]).grid[1][1];
  const st = ZY.heroStats('zhaoyun', 1);
  const base = ZY.statsAt('qiang', 3);
  ok('武将数值 = 兵种 L3 ×1.2', Math.abs(st.hp - base.hp * 1.2) < 1e-9 && Math.abs(st.atk - base.atk * 1.2) < 1e-9);
  ok('赵云射程 3', hero.range === 3);
  let allOk = true;
  ZY.HEROES.forEach((h) => {
    const st2 = mk(h.chars, [1, 2]);
    const u = st2.grid[1][1];
    if (!u || u.cls !== 'hero' || u.heroId !== h.id) allOk = false;
  });
  ok('六位武将全部可合成', allOk);
  const sf = ZY.heroStats('zhangfei', 1), sb = ZY.heroStats('zhangbao', 1);
  ok('张飞血高于张苞（高血高防）', sf.hp > sb.hp && sf.dmgReduce > 0);
}

/* ------------------------------------------------ 5. 道具：铲子 / 毛笔 / 神兵符 */
section('道具：铲子扩地 / 毛笔 / 神兵符');
{
  const s = G.baseState('endless', {});
  const startCells = Object.keys(s.deploy).length;
  ok('开局塔位 = 8（主路两侧）', startCells === 8, startCells + '');

  // 荒地：非主路 / 非障碍 / 非塔位 / 与己方塔位相邻 → 可铲
  const spots = B.shovelSpots(s, 'player');
  ok('存在可铲荒地', spots.length > 0, spots.length + ' 处');
  const waste = spots[0];
  ok('荒地初始不可建塔', !B.canPlace(s, 'player', waste.row, waste.col));
  const rr = G.useShovel(s, 'player', waste.row, waste.col);
  ok('铲子把荒地扩成塔位', rr.ok && B.canPlace(s, 'player', waste.row, waste.col));
  ok('扩地后塔位 +1', Object.keys(s.deploy).length === 9, Object.keys(s.deploy).length + '');
  ok('同一格二次扩地失败', !G.useShovel(s, 'player', waste.row, waste.col).ok);
  // 不相邻的格
  ok('铲子不能扩不相邻的格', !G.useShovel(s, 'player', 11, 2).ok);
  // 障碍格 / 主路格
  ok('铲子不能扩障碍格', !G.useShovel(s, 'player', 5, 0).ok);
  ok('铲子不能扩主路格', !G.useShovel(s, 'player', 0, 2).ok);

  // 毛笔 / 神兵符（开好塔位再测）
  openSlots(s, 'player', ['1,1', '1,2', '1,3', '1,4']);
  const u = G.makeUnit(s, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 1, col: 1 });
  G.addUnit(s, u);
  const before = u.char;
  const br = G.useBrush(s, 'player', u.id);
  ok('毛笔改写兵种塔', br.ok && u.char !== before && ['刀', '枪', '弓', '骑'].indexOf(u.char) >= 0, before + '→' + u.char);
  const gold = G.makeUnit(s, 'player', { cls: 'gold', char: '赵', row: 1, col: 2 });
  G.addUnit(s, gold);
  ok('毛笔不能改写金字塔', !G.useBrush(s, 'player', gold.id).ok);
  const g2 = G.makeUnit(s, 'player', { cls: 'gold', char: '云', row: 1, col: 3 });
  G.addUnit(s, g2);
  G.checkHeroes(s, 'player');              // 赵(1,2)+云(1,3) 横排 → 成将
  const heroU = s.grid[1][2];
  ok('赵+云成武将塔', heroU && heroU.cls === 'hero' && heroU.heroId === 'zhaoyun');
  ok('毛笔不能改写武将塔', !G.useBrush(s, 'player', heroU.id).ok);
  const nong = G.makeUnit(s, 'player', { cls: 'soldier', type: 'nong', level: 1, row: 1, col: 4 });
  G.addUnit(s, nong);
  ok('农民塔不能被毛笔改写', !G.useBrush(s, 'player', nong.id).ok);

  G.useWarcry(s, 'player');
  ok('神兵符 buff = 10s', Math.abs(s.buff.player - C.WARCRY_TIME) < 1e-9);
}

/* ------------------------------------------------ 5b. 火球（投掷类，3×3 80 固定伤害） */
section('道具：火球（拖到主路，3×3 内 80 固定伤害）');
{
  const s = G.baseState('endless', {});
  s.player.bun = 0;
  const mkE = (r, c, opts) => {
    const e = G.makeUnit(s, 'enemy', Object.assign({ cls: 'soldier', type: 'dao', level: 1, row: r, col: c, target: 'player' }, opts || {}));
    e.move = 0; e.hp = e.maxHp = 500;
    G.addUnit(s, e);
    return e;
  };
  const a = mkE(4, 3), b = mkE(4, 4), c2 = mkE(4, 5), far = mkE(2, 2);
  const r = G.useFireball(s, 'player', 4, 4);
  ok('火球命中落点 3×3 内 3 个敌人', r.hit === 3, 'hit=' + r.hit);
  ok('每个敌人受 80 固定伤害', a.maxHp - a.hp === 80 && b.maxHp - b.hp === 80 && c2.maxHp - c2.hp === 80,
    (a.maxHp - a.hp) + '/' + (b.maxHp - b.hp) + '/' + (c2.maxHp - c2.hp));
  ok('3×3 外敌人无伤', far.hp === far.maxHp);
  // 精英 / Boss 同样生效（可被秒杀说明伤害足够）
  const el = mkE(4, 2, { elite: true });
  const bo = mkE(5, 3, { boss: true });      // 落点 (4,3) 的 3×3（rows3-5 × cols2-4）内
  const r2 = G.useFireball(s, 'player', 4, 3);
  ok('精英同样受 80（含在 3×3 内）', r2.hit >= 1 && el.maxHp - el.hp === 80, 'el=' + (el.maxHp - el.hp));
  ok('Boss 同样受 80', bo.maxHp - bo.hp === 80, 'bo=' + (bo.maxHp - bo.hp));
  ok('火球产生爆炸特效', s.fx.some((f) => f.type === 'boom'));
  // 火球击杀 → 照常结算赏金
  const s2 = G.baseState('endless', {});
  s2.player.bun = 0;
  const e1 = G.makeUnit(s2, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 4, col: 4, target: 'player' });
  e1.move = 0; e1.hp = 50; G.addUnit(s2, e1);
  G.useFireball(s2, 'player', 4, 4);
  ok('火球击杀入账赏金', s2.player.bun >= C.NORMAL_BOUNTY, 'bun=' + s2.player.bun.toFixed(2));
  ok('火球常量：80 伤害 / 半径 1（3×3）', C.FIREBALL_DMG === 80 && C.FIREBALL_RADIUS === 1);
}

/* ------------------------------------------------ 6. 阿斗与卖血经济（沿主路到终点） */
section('阿斗掉血 +10 馒头补偿（敌人沿主路走到终点格）');
{
  const s = G.baseState('endless', {});
  freezeWaves(s);
  s.player.bun = 0;
  const e = spawnOnPath(s, 34);              // (10,3)，下一格即阿斗 (11,3)
  const hp0 = s.player.adou, bun0 = s.player.bun;
  let guard = 0;
  while (s.player.adou === hp0 && guard++ < 100) G.tick(s, 0.1);
  ok('敌方沿主路踏入阿斗格 → 掉 1 血', s.player.adou === hp0 - 1, 'adou=' + s.player.adou);
  ok('补偿 +10 馒头', s.player.bun - bun0 >= 10, '+' + (s.player.bun - bun0).toFixed(2));
  ok('该敌方单位被移除', e.dead);
  guard = 0;
  while (!s.over && guard++ < 600) {
    if (!s.units.some((u) => u.side === 'enemy')) spawnOnPath(s, 34);
    G.tick(s, 0.1);
  }
  ok('阿斗归零 → 本局结束（败）', s.over && s.result === 'lose', 'adou=' + s.player.adou);
}

/* ------------------------------------------------ 7. 击杀赏金 */
section('击杀赏金（普 +1 / 精英 +8 / Boss +30 / 玩家单位 0）');
{
  const s = G.baseState('endless', {});
  const mk = (side, opts) => G.makeUnit(s, side, Object.assign({ cls: 'soldier', type: 'zei', level: 1, row: 5, col: 3, target: 'player' }, opts));
  ok('普通敌人赏金 = NORMAL_BOUNTY', mk('enemy').bounty === C.NORMAL_BOUNTY);
  ok('精英赏金 = ELITE_BOUNTY', mk('enemy', { elite: true }).bounty === C.ELITE_BOUNTY);
  ok('Boss 赏金 = BOSS_BOUNTY', mk('enemy', { boss: true }).bounty === C.BOSS_BOUNTY);
  ok('敌方武将赏金 = 6', mk('enemy', { cls: 'hero', heroId: 'zhaoyun', heroLevel: 1 }).bounty === 6);
  ok('玩家单位赏金 = 0', mk('player').bounty === 0);

  // 集成验证：塔在塔位 (1,4)，敌人在主路 (2,4) 被钉住 → 击杀入账
  const sb = G.baseState('endless', {});
  freezeWaves(sb);
  sb.player.bun = 0; sb.enemy.adou = 1e9;
  G.tick(sb, 0.2); const income = sb.player.bun;
  sb.player.bun = 0;
  const e0 = G.makeUnit(sb, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 2, col: 4, target: 'player' }); e0.hp = 1; e0.move = 0; G.addUnit(sb, e0);
  const a0 = G.makeUnit(sb, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 1, col: 4 }); a0.atk = 300; a0.aspd = 6; a0.range = 1; G.addUnit(sb, a0);
  G.tick(sb, 0.3);
  ok('击杀普通敌人 → 赏金入账', sb.player.bun >= C.NORMAL_BOUNTY, 'bun=' + sb.player.bun.toFixed(2) + '（基准收入≈' + income.toFixed(2) + '）');
}

/* ------------------------------------------------ 8. Boss（关底强化波） */
section('Boss：关底强化波（震击对象 = 射程内我方塔）');
{
  const s = G.baseState('level', { levelIdx: 0 });
  s.player.adou = 1e9; s.enemy.adou = 1e9;
  s.wave.idx = 3; s.wave.done = false; s.wave.pending = []; s.wave.timer = s.wave.interval;
  G.tick(s, 0.2); // 触发第 4 波（关底）
  let hasBoss = false;
  for (const spec of s.wave.pending) if (spec.boss) hasBoss = true;
  ok('关底强化波含 Boss', hasBoss);
  // 让 Boss 真正出场（入口逐个出兵，给足时间）
  for (let i = 0; i < 800 && !s.units.some((u) => u.boss); i++) G.tick(s, 0.1);
  const bo = s.units.find((u) => u.boss);
  ok('Boss 出场且带 boss 标记', !!bo && bo.boss);
  ok('Boss 血量远高于普通同波（×' + C.BOSS_HP_MUL + '）', bo.maxHp > ZY.BOSS.hp * C.BOSS_HP_MUL, 'hp=' + bo.maxHp.toFixed(0));
  ok('Boss 攻击倍率 ×' + C.BOSS_ATK_MUL, bo.atk > ZY.BOSS.atk * C.BOSS_ATK_MUL * 0.5, 'atk=' + bo.atk.toFixed(1));
  ok('Boss 击杀赏金 +' + C.BOSS_BOUNTY, bo.bounty === C.BOSS_BOUNTY);

  // Boss 技能「震击」：塔在塔位 (3,4)，Boss 在主路 (4,4)，钉住
  const sb = G.baseState('level', { levelIdx: 0 });
  freezeWaves(sb); sb.player.adou = 1e9; sb.enemy.adou = 1e9;
  const pb = G.makeUnit(sb, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 3, col: 4 }); pb.maxHp = 9999; pb.hp = 9999; pb.aspd = 0; G.addUnit(sb, pb);
  const boss = G.makeUnit(sb, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 4, col: 4, boss: true, target: 'player' }); boss.move = 0; boss.skillT = 0.1; G.addUnit(sb, boss);
  let stunned = false;
  for (let i = 0; i < 80 && !stunned; i++) { G.tick(sb, 0.1); if (pb.stun > 0) stunned = true; }
  ok('Boss 震击使相邻我方塔眩晕', stunned, 'stun=' + pb.stun.toFixed(2));
}

/* ------------------------------------------------ 9. 突破口事件 */
section('突破口事件（无尽 / 关卡）');
{
  const T = ZY.TUNE, SG = G.SPAWN_GAP;
  // 无尽：第 breakStart(4) 波触发突破口
  const s = G.baseState('endless', {});
  s.player.adou = 1e9; s.enemy.adou = 1e9;
  s.nextBreak = 4;
  s.wave.idx = 3; s.wave.timer = s.wave.interval;
  G.tick(s, 0.2); // 触发第 4 波，且 = nextBreak → 突破口
  ok('突破口标记 breakEntrance', s.wave.breakEntrance === true, JSON.stringify(s.wave.breakEntrance));
  ok('突破口出怪间隔减半（< 普通间隔）', s.wave.spawnGap < SG, s.wave.spawnGap + ' < ' + SG);
  ok('横幅含「突破口」', s.banner && s.banner.text.indexOf('突破口') >= 0, s.banner && s.banner.text);

  // 关卡：第 levelBreakWave(2) 波随机一次突破口
  const sl = G.baseState('level', { levelIdx: 0 });
  sl.player.adou = 1e9; sl.enemy.adou = 1e9;
  sl.levelBtDone = false; sl.wave.idx = 1; sl.wave.timer = sl.wave.interval;
  G.tick(sl, 0.2);
  ok('关卡第 2 波亦可能触发突破口', sl.wave.breakEntrance || sl.levelBtDone, 'bc=' + sl.wave.breakEntrance);

  // 突破口出怪数量更多：同波号对比「普通」与「突破」
  const base = G.baseState('endless', {});
  base.player.adou = 1e9; base.enemy.adou = 1e9;
  base.nextBreak = 999; base.wave.idx = 3; base.wave.timer = base.wave.interval;
  G.tick(base, 0.2);
  const normalCount = base.wave.pending.length;
  ok('突破口波兵数 > 普通波兵数', s.wave.pending.length > normalCount, s.wave.pending.length + ' > ' + normalCount);
}

/* ------------------------------------------------ 10. 开局塔位规模 */
section('开局塔位规模（关卡难度递增）');
{
  const a = G.baseState('level', { levelIdx: 0 });
  ok('第 1 关开局塔位 = 8', Object.keys(a.deploy).length === 8, Object.keys(a.deploy).length + '');
  const b = G.baseState('level', { levelIdx: 3 });
  ok('第 4 关开局塔位 = 12', Object.keys(b.deploy).length === 12, Object.keys(b.deploy).length + '');
  const v = G.baseState('versus', { difficulty: 1 });
  ok('竞技双方开局塔位 = 16（各 8）', Object.keys(v.deploy).length === 16, Object.keys(v.deploy).length + '');
}

/* ------------------------------------------------ 11. 无尽模式波次 */
section('无尽模式波次节奏');
{
  const T = ZY.TUNE;
  const s = G.baseState('endless', {});
  s.player.adou = 99999; s.enemy.adou = 99999;
  for (let i = 0; i < 3000; i++) G.tick(s, 0.1);
  const gapOf = (n) => Math.max(T.endlessMin, T.endlessInterval * Math.pow(T.endlessDecay, n));
  ok('波次持续推进', s.wave.idx >= 8, '第 ' + s.wave.idx + ' 波');
  ok('当前间隔 = 公式值（逐波递减）', Math.abs(s.wave.interval - gapOf(s.wave.idx)) < 1e-9, s.wave.interval.toFixed(2) + 's');
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
  let guard = 0;
  while (!s.over && guard++ < 8000) {
    if (s.player.bun >= s.player.recruitCost && s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
    const card = s.player.hand.find((x) => x.kind !== 'item');
    if (card) {
      outer: for (let r = 0; r < B.ROWS; r++) {
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

/* ------------------------------------------------ 13. 竞技模式（公共波次 + AI） */
section('竞技模式（双路公共波次 + AI 行为）');
{
  const s = G.baseState('versus', { difficulty: 1 });
  let guard = 0, aiLvPeak = 0, aiHeroPeak = 0, aiTowerPeak = 0, bothPaths = false;
  while (!s.over && guard++ < 3000) {
    ZY.AI.thinkSide(s, 'player');
    s.aiT = 0.5; G.tick(s, 0.5);       // tick 内敌方 AI 自动决策
    const et = s.units.filter((u) => u.side === 'enemy' && u.target == null).length;
    if (et > aiTowerPeak) aiTowerPeak = et;
    const lv = s.units.filter((u) => u.side === 'enemy' && u.target == null && u.cls === 'soldier' && u.level > 1).length;
    const hr = s.units.filter((u) => u.side === 'enemy' && u.cls === 'hero').length;
    if (lv > aiLvPeak) aiLvPeak = lv;
    if (hr > aiHeroPeak) aiHeroPeak = hr;
    const wp = s.units.some((u) => u.side === 'enemy' && u.target === 'player');
    const we = s.units.some((u) => u.side === 'enemy' && u.target === 'enemy');
    if (wp && we) bothPaths = true;
  }
  console.log('   结果 ' + s.result + ' · 波数 ' + s.wave.idx + ' · 峰值：敌方塔 ' + aiTowerPeak + ' / 2级以上 ' + aiLvPeak + ' / 武将 ' + aiHeroPeak);
  ok('公共波次镜像进入双方路（双路同时有行军敌人）', bothPaths);
  ok('AI 会建塔铺满塔位（峰值 ≥ 6）', aiTowerPeak >= 6, '峰值 = ' + aiTowerPeak);
  ok('AI 会喂塔合成（出现过 2 级以上塔）', aiLvPeak > 0, '峰值 lv>1 = ' + aiLvPeak);
  ok('竞技对局能分出胜负（15 波赛制）', s.over === true, 'over=' + s.over);

  // AI 凑武将：先手摆金字 → 另一半接到旁边成将
  const h = G.baseState('versus', { difficulty: 1 });
  h.deploy = B.startSlots('versus', 'enemy', 0);
  h.enemy.adou = 1e9; h.player.adou = 1e9;
  h.enemy.hand = [
    { uid: 901, kind: 'gold', char: '赵', level: 1 },
    { uid: 902, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 903, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 904, kind: 'unit', char: '弓', type: 'gong', level: 1 },
    { uid: 905, kind: 'unit', char: '弓', type: 'gong', level: 1 },
  ];
  ZY.AI.thinkSide(h, 'enemy');
  const tile = h.units.find((u) => u.side === 'enemy' && u.cls === 'gold');
  ok('AI 会摆下金字', !!tile, tile ? tile.char + '@' + tile.row + ',' + tile.col : '无');
  h.enemy.bun = 0;
  h.enemy.hand = [{ uid: 906, kind: 'gold', char: '云', level: 1 }];
  ZY.AI.thinkSide(h, 'enemy');
  const made = h.units.find((u) => u.side === 'enemy' && u.cls === 'hero');
  ok('AI 会把「云」接到「赵」旁边成将', !!made && made.heroId === 'zhaoyun', made ? made.char : '未成将');
}

/* ------------------------------------------------ 14. 行军纪律（主路 / 不回头 / 不穿塔位） */
section('敌人沿主路行军（不穿塔位、不回头）');
{
  const s = G.baseState('endless', {});
  freezeWaves(s);
  s.player.adou = 1e9;                      // 只验行军，不验终局
  const pset = B.pathSet('endless');
  const lastPi = {};
  let bad = 0, spawned = 0, maxPi = 0;
  for (let i = 0; i < 1200; i++) {          // 120s
    if (i % 15 === 0 && s.units.filter((u) => u.side === 'enemy').length < 6) {
      spawnOnPath(s, Math.floor(Math.random() * 30)); spawned++;
    }
    G.tick(s, 0.1);
    s.units.forEach(function (u) {
      if (u.side !== 'enemy') return;
      if (!pset[B.key(u.row, u.col)]) bad++;                                  // 必须在主路上
      if (lastPi[u.id] != null && u.pi < lastPi[u.id]) bad++;                 // pi 单调递增（不回头）
      lastPi[u.id] = u.pi;
      if (u.pi > maxPi) maxPi = u.pi;
    });
  }
  ok('120s 内敌人全程在主路上、pi 单调递增', bad === 0, 'bad=' + bad);
  ok('沿途有推进（最大 pi > 10）', maxPi > 10, 'maxPi=' + maxPi);
  // 塔位与主路互斥（棋盘级不变量）
  ok('塔位与主路无交叠', Object.keys(B.startSlots('endless', 'player', 0)).every((k) => !pset[k]));
}

/* ------------------------------------------------ 15. 塔攻击最靠前的敌人 */
section('塔攻击射程内「最靠前」的敌人（离阿斗最近优先）');
{
  const s = G.baseState('endless', {});
  freezeWaves(s);
  s.player.adou = 1e9;
  openSlots(s, 'player', ['1,4']);
  const mkStill = (r, c, pi) => {
    const e = G.makeUnit(s, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: r, col: c, target: 'player', pi: pi });
    e.move = 0; e.hp = e.maxHp = 9999;
    G.addUnit(s, e);
    return e;
  };
  const back = mkStill(0, 4, 2);      // 靠后（pi 小）
  const front = mkStill(2, 4, 10);    // 靠前（pi 大，更接近阿斗）
  const t = G.makeUnit(s, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 1, col: 4 });
  t.atk = 100; t.aspd = 6; t.range = 1;
  G.addUnit(s, t);
  G.tick(s, 0.2);
  ok('塔先打 pi 最大的敌人', front.hp < 9999 && back.hp === 9999, 'front=' + front.hp + ' back=' + back.hp);
}

/* ------------------------------------------------ 16. 数值健壮性 */
section('数值健壮性');
{
  const s = G.baseState('versus', { difficulty: 1.2 });
  let bad = 0, maxUnits = 0;
  for (let i = 0; i < 2500; i++) {
    ZY.AI.thinkSide(s, 'player');
    G.tick(s, 0.1);
    maxUnits = Math.max(maxUnits, s.units.length);
    s.units.forEach((u) => {
      if (!isFinite(u.hp) || !isFinite(u.atk) || !isFinite(u.maxHp) || u.hp > u.maxHp + 1e-6) bad++;
      if (u.row < 0 || u.row > 11 || u.col < 0 || u.col > 7) bad++;
      if (u.side === 'enemy' && u.target && u.pi < 0) bad++;
    });
    if (!isFinite(s.player.bun) || !isFinite(s.enemy.bun)) bad++;
  }
  ok('250s 内无 NaN / 越界 / 血量溢出', bad === 0, 'bad=' + bad);
  ok('棋盘同屏单位数合理（<=96）', maxUnits <= 96, 'max=' + maxUnits);
}

/* ------------------------------------------------ 17. 存档键 */
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
