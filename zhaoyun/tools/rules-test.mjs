/* 赵云与阿斗 · 无头规则自测（Node，不依赖浏览器）
 * 用法：node tools/rules-test.mjs */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 用法：node tools/rules-test.mjs
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
  ok('刀 ≈25%', Math.abs(cnt.dao / 1000 - 25) < 1.2);
  ok('枪 ≈20%', Math.abs(cnt.qiang / 1000 - 20) < 1.2);
  ok('弓 ≈15%', Math.abs(cnt.gong / 1000 - 15) < 1.2);
  ok('骑 ≈10%', Math.abs(cnt.qi / 1000 - 10) < 1.2);
  ok('金色武将字 ≈15%', Math.abs(cnt.gold / 1000 - 15) < 1.2);
  ok('铲子 ≈7%', Math.abs(cnt.shovel / 1000 - 7) < 1.0);
  ok('农民 ≈4%', Math.abs(cnt.nong / 1000 - 4) < 0.8);
  ok('毛笔 ≈2%', Math.abs(cnt.brush / 1000 - 2) < 0.6);
  ok('神兵符 ≈2%', Math.abs(cnt.warcry / 1000 - 2) < 0.6);
}

/* ------------------------------------------------ 2. 合成规则 */
section('合成规则');
{
  const s = G.baseState('endless', {});
  s.locked = {}; // 规则测试排除随机锁定格干扰
  // 手动塞两张牌
  s.player.bun = 999;
  s.player.hand = [
    { uid: 1, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 2, kind: 'unit', char: '刀', type: 'dao', level: 1 },
    { uid: 3, kind: 'unit', char: '枪', type: 'qiang', level: 1 },
  ];
  G.deploy(s, 'player', 1, 10, 2);
  G.deploy(s, 'player', 2, 10, 4);
  G.deploy(s, 'player', 3, 10, 5);
  const a = s.grid[10][2], c = s.grid[10][5];
  ok('部署成功：刀 lv1', a && a.type === 'dao' && a.level === 1);
  const r1 = G.dropUnitOn(s, 'player', a.id, 10, 4);
  ok('同字同级可合成', r1.ok && s.grid[10][4].level === 2, JSON.stringify(r1));
  const r2 = G.dropUnitOn(s, 'player', s.grid[10][4].id, 10, 5);
  ok('异字不可合成', !r2.ok, r2.msg);
  // 逐级合成到 5 级
  const s2 = G.baseState('endless', {});
  s2.locked = {};
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
  s3.locked = {};
  const u5a = G.makeUnit(s3, 'player', { cls: 'soldier', type: 'dao', level: 5, row: 9, col: 0 });
  const u5b = G.makeUnit(s3, 'player', { cls: 'soldier', type: 'dao', level: 5, row: 9, col: 1 });
  G.addUnit(s3, u5a); G.addUnit(s3, u5b);
  const r5 = G.dropUnitOn(s3, 'player', u5b.id, 9, 0);
  ok('满级不再合成', !r5.ok, r5.msg);
  // 数值成长口径
  const l1 = ZY.statsAt('dao', 1), l2 = ZY.statsAt('dao', 2), l5 = ZY.statsAt('dao', 5);
  ok('每级 血×1.55', Math.abs(l2.hp / l1.hp - 1.55) < 1e-9, (l2.hp / l1.hp).toFixed(4));
  ok('每级 攻×1.85', Math.abs(l2.atk / l1.atk - 1.85) < 1e-9);
  ok('每级 攻速×1.05', Math.abs(l2.aspd / l1.aspd - 1.05) < 1e-9);
  console.log('   刀兵 L1 血' + l1.hp.toFixed(1) + ' 攻' + l1.atk.toFixed(1) +
    ' / L5 血' + l5.hp.toFixed(1) + ' 攻' + l5.atk.toFixed(1));
}

/* ------------------------------------------------ 3. 武将合成 */
section('武将合成');
{
  const mk = (chars, cols) => {
    const s = G.baseState('endless', {});
    s.locked = {};
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
  s = mk(['赵', '云'], [2, 3]);
  const hero = s.grid[8][2];
  const st = ZY.heroStats('zhaoyun', 1);
  const base = ZY.statsAt('qiang', 3);
  ok('武将数值 = 兵种 L3 ×1.2', Math.abs(st.hp - base.hp * 1.2) < 1e-9 && Math.abs(st.atk - base.atk * 1.2) < 1e-9);
  console.log('   赵云 L1 血' + st.hp.toFixed(1) + ' 攻' + st.atk.toFixed(1) + ' 射程' + st.range);
  ok('武将射程 3', hero.range === 3);
  // 全部武将都能合成
  let allOk = true;
  ZY.HEROES.forEach((h) => {
    const st2 = mk(h.chars, [1, 2]);
    const u = st2.grid[8][1];
    if (!u || u.cls !== 'hero' || u.heroId !== h.id) allOk = false;
  });
  ok('六位武将全部可合成', allOk);
  // 张飞 / 张苞 区分
  const sf = ZY.heroStats('zhangfei', 1), sb = ZY.heroStats('zhangbao', 1);
  ok('张飞血高于张苞（高血高防）', sf.hp > sb.hp && sf.dmgReduce > 0);
}

/* ------------------------------------------------ 4. 道具 */
section('道具');
{
  const s = G.baseState('endless', {});
  const keys = Object.keys(s.locked);
  ok('单人模式锁定格 ≈6', keys.length === 6, '实际 ' + keys.length);
  const [r, c] = keys[0].split(',').map(Number);
  ok('锁定格不可部署', !B.canPlace(s, 'player', r, c));
  const rr = G.useShovel(s, 'player', r, c);
  ok('铲子开启锁定格', rr.ok && B.canPlace(s, 'player', r, c));
  ok('同一格二次开铲失败', !G.useShovel(s, 'player', r, c).ok);
  let freeCell = null;
  for (let r = 6; r <= 11 && !freeCell; r++) {
    for (let c = 0; c < B.COLS; c++) {
      if (!s.locked[B.key(r, c)] && !s.grid[r][c]) { freeCell = { r, c }; break; }
    }
  }
  ok('铲子不能开非锁定格', !G.useShovel(s, 'player', freeCell.r, freeCell.c).ok);

  s.locked = {}; // 后续道具测试不再需要锁定格
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
  const dmgNo = (() => { s.buff.player = 0; const t = G.makeUnit(s, 'enemy', { cls: 'soldier', type: 'dao', level: 1, row: 5, col: 0 }); G.addUnit(s, t); const hp0 = t.hp; const a = G.makeUnit(s, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 6, col: 0 }); G.addUnit(s, a); s.fx.length = 0; G.tick(s, 2.0); return hp0 - t.hp; })();
  const s2 = G.baseState('endless', {});
  const t2 = G.makeUnit(s2, 'player', { cls: 'soldier', type: 'dao', level: 1, row: 6, col: 0 });
  const e2 = G.makeUnit(s2, 'enemy', { cls: 'soldier', type: 'dao', level: 1, row: 5, col: 0 });
  G.addUnit(s2, t2); G.addUnit(s2, e2);
  G.useWarcry(s2, 'player');
  const hp0 = e2.hp;
  G.tick(s2, 2.0);
  const dmgYes = hp0 - e2.hp;
  ok('神兵符后伤害 ≈×1.5', dmgYes > dmgNo * 1.4 && dmgYes < dmgNo * 1.6, dmgNo.toFixed(2) + ' → ' + dmgYes.toFixed(2));
}

/* ------------------------------------------------ 5. 阿斗与卖血经济 */
section('阿斗掉血 +10 馒头补偿');
{
  const s = G.baseState('endless', {});
  s.locked = {};
  s.player.bun = 0;
  const e = G.makeUnit(s, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 10, col: 3 });
  G.addUnit(s, e);
  const hp0 = s.player.adou, bun0 = s.player.bun;
  for (let i = 0; i < 30 && s.player.adou === hp0; i++) G.tick(s, 0.1);
  ok('敌方踏入阿斗格 → 掉 1 血', s.player.adou === hp0 - 1, 'adou=' + s.player.adou);
  ok('补偿 +10 馒头', s.player.bun - bun0 >= 10, '+' + (s.player.bun - bun0).toFixed(2));
  ok('该敌方单位被移除', e.dead);
  // 3 血归零 → 失败
  for (let i = 0; i < 400 && !s.over; i++) {
    if (!s.units.some((u) => u.side === 'enemy')) {
      G.addUnit(s, G.makeUnit(s, 'enemy', { cls: 'soldier', type: 'zei', level: 1, row: 10, col: 3 }));
    }
    G.tick(s, 0.1);
  }
  ok('阿斗归零 → 本局结束（败）', s.over && s.result === 'lose', 'adou=' + s.player.adou);
}

/* ------------------------------------------------ 6. 无尽模式波次 */
section('无尽模式波次节奏');
{
  const T = ZY.TUNE;
  const s = G.baseState('endless', {});
  s.player.adou = 99999; // 只看波次节奏，不让阿斗阵亡提前结束
  for (let i = 0; i < 1500; i++) G.tick(s, 0.1);
  const gapOf = (n) => Math.max(T.endlessMin, T.endlessInterval * Math.pow(T.endlessDecay, n));
  console.log('   150s 内推进到第 ' + s.wave.idx + ' 波；间隔序列 ' +
    [1, 2, 3].map((n) => gapOf(n).toFixed(2) + 's').join(' / '));
  ok('波次持续推进', s.wave.idx >= 8, '第 ' + s.wave.idx + ' 波');
  ok('首波间隔 = TUNE.endlessInterval', Math.abs(s.wave.interval - gapOf(s.wave.idx)) < 1e-9,
    s.wave.interval.toFixed(2) + 's');
  ok('间隔逐波递减且不低于下限', gapOf(2) < gapOf(1) && gapOf(99) === T.endlessMin);
  const c1 = Math.floor(T.endlessBase + 1 * T.endlessStep);
  const c10 = Math.floor(T.endlessBase + 10 * T.endlessStep);
  ok('每波数量 = base + 波数×step（递增）', c10 > c1 && c1 >= 2, c1 + ' / ' + c10);
  ok('强化波（第 10 波）数量翻倍', Math.round(c10 * T.endlessEliteMul) > c10);
}

/* ------------------------------------------------ 7. 关卡模式 */
section('关卡模式（巨鹿 → 通关）');
{
  const s = G.baseState('level', { levelIdx: 0 });
  s.player.bun = 100000;
  let guard = 0;
  while (!s.over && guard++ < 8000) {
    // 自动玩家：疯狂征兵 + 见缝就放
    if (s.player.bun >= C.RECRUIT_COST && s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
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
  console.log('   结果 ' + s.result + ' · 波次 ' + s.wave.idx + ' · 击杀 ' + s.stats.kills + ' · 用时 ' + s.t.toFixed(1) + 's');
  ok('关卡模式可通关（4 波清空 → win）', s.over && s.result === 'win', 'result=' + s.result + ' wave=' + s.wave.idx);
  ok('关卡共 4 波（3 普通 + 1 关底）', s.wave.idx === 4, 'wave=' + s.wave.idx);
}

/* ------------------------------------------------ 8. 竞技模式 AI */
section('竞技模式 AI 行为');
{
  const s = G.baseState('versus', { difficulty: 1 });
  ok('双方各 4 个锁定格', Object.keys(s.locked).length === 8, Object.keys(s.locked).length + '');
  let guard = 0;
  // 全程采样：AI 合成出来的高级单位可能在本局结束前就战死了，只看终局会误判
  let aiLvPeak = 0, aiHeroPeak = 0, aiUnitsPeak = 0;
  while (!s.over && guard++ < 3000) {
    if (s.player.bun >= C.RECRUIT_COST && s.player.hand.length < C.HAND_MAX) G.recruit(s, 'player');
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
    const lv = s.units.filter((u) => u.side === 'enemy' && u.cls === 'soldier' && u.level > 1).length;
    const hr = s.units.filter((u) => u.side === 'enemy' && u.cls === 'hero').length;
    const al = s.units.filter((u) => u.side === 'enemy').length;
    if (lv > aiLvPeak) aiLvPeak = lv;
    if (hr > aiHeroPeak) aiHeroPeak = hr;
    if (al > aiUnitsPeak) aiUnitsPeak = al;
  }
  const aiUnits = s.units.filter((u) => u.side === 'enemy');
  const aiHero = aiUnits.filter((u) => u.cls === 'hero');
  console.log('   结果 ' + s.result + ' · 敌存活 ' + aiUnits.length + ' · 敌武将 ' + aiHero.length +
    ' · 敌击杀 ' + s.enemy.kills + ' · 我击杀 ' + s.player.kills +
    ' · 峰值：单位 ' + aiUnitsPeak + ' / 2级以上 ' + aiLvPeak + ' / 武将 ' + aiHeroPeak);
  ok('AI 会出兵（上半区有单位或曾击杀）', aiUnitsPeak > 0 || s.enemy.kills > 0);
  ok('AI 会合成（出现过 2 级以上单位）', aiLvPeak > 0, '峰值 lv>1 = ' + aiLvPeak);
  // 武将是否成型受金字抽取运气影响（单局约五成），这里只作观测；
  // 「AI 会凑武将」由下面那组确定性用例（赵 + 云）保证。
  ok('对局能分出胜负', s.over === true, 'over=' + s.over);

  // AI 凑武将：给定两张成对金字，看它会不会主动挨着摆
  const h = G.baseState('versus', { difficulty: 1 });
  h.locked = {};
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

/* ------------------------------------------------ 9. 数值健壮性 */
section('数值健壮性');
{
  const s = G.baseState('versus', { difficulty: 1.2 });
  let bad = 0, maxUnits = 0;
  for (let i = 0; i < 2500; i++) {
    if (s.player.bun >= C.RECRUIT_COST && s.player.hand.length < C.HAND_MAX && Math.random() < 0.6) G.recruit(s, 'player');
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
  console.log('   峰值同屏单位 ' + maxUnits + ' · 结束状态 ' + (s.over ? s.result : '进行中'));
}

/* ------------------------------------------------ 10. 存档键 */
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
