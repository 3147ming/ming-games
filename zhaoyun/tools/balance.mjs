/* 赵云与阿斗 · 平衡基线自测（Node，不依赖浏览器）— V2
 * 用法：node tools/balance.mjs
 * 用「与玩家同规则」的 AI 策略驱动双方，量三模式基线：
 *   · 竞技：easy(0.8)/normal(1.0)/hard(1.2) 我方胜率（目标 ≥ 8/16 · 6/16 · 4/16）
 *   · 无尽：中位数波数（目标 ≥ 9，单局 110~155s）
 *   · 关卡：第 1 关通关率（目标 ≥ 30/64）· 跨关继承通关率（目标 ≥ 2/64）
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src') + path.sep;
const ctx = vm.createContext({ console, Math, Date });
vm.runInContext('window = globalThis;', ctx);
vm.runInContext(`
  var _ls = {};
  var localStorage = { getItem:function(k){return k in _ls?_ls[k]:null;}, setItem:function(k,v){_ls[k]=String(v);}, removeItem:function(k){delete _ls[k];} };
`, ctx);
for (const f of ['units.js', 'board.js', 'storage.js', 'ai.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(DIR + f, 'utf8'), ctx, { filename: f });
}
vm.runInContext('ZY.Audio = { play:function(){}, setMuted:function(){}, unlock:function(){} };', ctx);
const ZY = ctx.ZY;
const G = ZY.Game, B = ZY.B, C = ZY.C, U = ZY.UNITS;

/* ---------- 与玩家同规则的策略（侧别无关，复用 ai.js 思路） ---------- */
const LANE = B.LANES;
function roleCols(role) {
  switch (role) {
    case 'front': return LANE.left.concat(LANE.left ? LANE.right : []);
    case 'flank': return LANE.left.concat(LANE.right);
    case 'mid':   return LANE.mid.slice();
    case 'back':  return LANE.mid.concat([2, 5]);
    default:      return [2, 3, 4];
  }
}
function thinkSide(state, side) {
  if (state.over || state.paused) return;
  const s = side === 'player' ? state.player : state.enemy;
  const foe = side === 'player' ? 'enemy' : 'player';
  const TOP = side === 'player' ? B.PLAYER_TOP : B.ENEMY_TOP;
  const BOT = side === 'player' ? B.PLAYER_BOTTOM : B.ENEMY_BOTTOM;
  const can = (r, c) => B.canPlace(state, side, r, c);

  // 1) 征兵
  if (s.bun >= s.recruitCost && s.hand.length < C.HAND_MAX && Math.random() < 0.95) G.recruit(state, side);
  // 2) 铲子扩前线荒地
  const sh = s.hand.findIndex((x) => x.kind === 'item' && x.item === 'shovel');
  if (sh >= 0) {
    const cell = B.frontWasteland(state, side);
    if (cell && G.useShovel(state, side, cell.row, cell.col).ok) s.hand.splice(sh, 1);
  }
  // 3) 凑武将：手里有成对金字或接到已有金字旁
  const gi = s.hand.findIndex((x) => x.kind === 'gold');
  if (gi >= 0) {
    const g = s.hand[gi].char;
    let placed = false;
    for (let i = 0; i < ZY.HEROES.length && !placed; i++) {
      const h = ZY.HEROES[i];
      for (let r = TOP; r <= BOT && !placed; r++) for (let c = 0; c < B.COLS && !placed; c++) {
        const t = state.grid[r][c];
        if (!t || t.side !== side || t.cls !== 'gold' || t.dead) continue;
        if (h.chars[0] === g && t.char === h.chars[1] && can(r, c - 1)) { if (G.deploy(state, side, s.hand[gi].uid, r, c - 1).ok) placed = true; }
        if (h.chars[1] === g && t.char === h.chars[0] && can(r, c + 1)) { if (G.deploy(state, side, s.hand[gi].uid, r, c + 1).ok) placed = true; }
      }
    }
    if (!placed) {
      for (let a = 0; a < s.hand.length && !placed; a++) {
        if (!s.hand[a] || s.hand[a].kind !== 'gold') continue;
        for (let b = 0; b < s.hand.length && !placed; b++) {
          if (a === b || !s.hand[b] || s.hand[b].kind !== 'gold') continue;
          const hero = ZY.HERO_BY_NAME[s.hand[a].char + s.hand[b].char];
          if (!hero) continue;
          const uidA = s.hand[a].uid, charB = s.hand[b].char;
          for (let r = TOP; r <= BOT && !placed; r++) for (let c = 0; c < B.COLS - 1 && !placed; c++) {
            if (can(r, c) && can(r, c + 1)) {
              if (G.deploy(state, side, uidA, r, c).ok) {
                const rest = (side === 'player' ? state.player : state.enemy).hand;
                for (let i = 0; i < rest.length; i++) if (rest[i].kind === 'gold' && rest[i].char === charB) { G.deploy(state, side, rest[i].uid, r, c + 1); break; }
                placed = true;
              }
            }
          }
        }
      }
    }
  }
  // 4) 合成：同字同级
  const groups = {};
  state.units.forEach((u) => {
    if (u.dead || u.side !== side || u.cls !== 'soldier' || u.level >= C.MAX_LEVEL) return;
    (groups[u.type + '#' + u.level] = groups[u.type + '#' + u.level] || []).push(u);
  });
  const keys = Object.keys(groups).filter((k) => groups[k].length >= 2);
  if (keys.length) {
    const arr = groups[keys[0]].slice().sort((a, b) => (side === 'player' ? b.row - a.row : a.row - b.row));
    const dst = arr[0], src = arr[1];
    G.dropUnitOn(state, side, src.id, dst.row, dst.col);
  }
  // 5) 布阵：放一张牌（农民优先核心区，其余按兵线列）
  let idx = s.hand.findIndex((x) => x.kind === 'unit' && x.type === 'nong');
  if (idx < 0) idx = s.hand.findIndex((x) => x.kind === 'unit');
  if (idx < 0) idx = s.hand.findIndex((x) => x.kind === 'gold');
  if (idx >= 0) {
    const card = s.hand[idx];
    const role = card.kind === 'unit' ? (U[card.type] ? U[card.type].role : 'core') : 'core';
    const pref = roleCols(role);
    const rows = role === 'front' || role === 'flank' ? [BOT, BOT - 1, BOT - 2, BOT - 3]
               : role === 'mid' ? [BOT - 2, BOT - 3, BOT - 1, BOT - 4]
               : role === 'back' ? [TOP + 1, TOP + 2, TOP, TOP + 3]
               : [TOP + 1, TOP + 2, TOP];
    let best = null, bestScore = -Infinity;
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      if (r < TOP || r > BOT) continue;
      for (let c = 0; c < B.COLS; c++) {
        if (!can(r, c)) continue;
        let score = Math.random() * 1.5;
        if (pref.indexOf(c) >= 0) score += 2.6;
        let own = 0, twin = false;
        for (let rr = TOP; rr <= BOT; rr++) { const t = state.grid[rr][c]; if (t && t.side === side) { own++; if (t.cls === 'soldier' && t.type === (card.type || '') && t.level === (card.level || 1)) twin = true; } }
        score += twin ? 3.2 : 1.4;
        score -= own * 0.9;
        if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
      }
    }
    if (best) G.deploy(state, side, card.uid, best.row, best.col);
  }
}

function runVersus(diff, n) {
  let win = 0;
  for (let g = 0; g < n; g++) {
    const s = G.baseState('versus', { difficulty: diff });
    s.player.bun = C.START_BUN; s.enemy.bun = C.START_BUN;
    let guard = 0;
    while (!s.over && guard++ < 6000) {
      thinkSide(s, 'player'); thinkSide(s, 'enemy');
      s.aiT = 0.5;  // 直接按 0.5s 频率驱动双方
      G.tick(s, 0.5);
    }
    if (s.result === 'win') win++;
  }
  return win;
}

function runEndless(n) {
  const waves = [];
  for (let g = 0; g < n; g++) {
    const s = G.baseState('endless', {});
    let guard = 0;
    while (!s.over && guard++ < 6000) {
      thinkSide(s, 'player');
      s.aiT = 0.5; G.tick(s, 0.5);
    }
    waves.push(s.wave.idx);
  }
  waves.sort((a, b) => a - b);
  const med = waves[Math.floor(waves.length / 2)];
  const tSum = 0, avg = waves.reduce((a, b) => a + b, 0) / n;
  return { med, avg: Math.round(avg), min: waves[0], max: waves[waves.length - 1] };
}

function runLevel(levelIdx, n) {
  let clear = 0;
  for (let g = 0; g < n; g++) {
    const s = G.baseState('level', { levelIdx: levelIdx });
    let guard = 0;
    while (!s.over && guard++ < 8000) {
      thinkSide(s, 'player');
      s.aiT = 0.5; G.tick(s, 0.5);
    }
    if (s.result === 'win') clear++;
  }
  return clear;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

console.log('\n== 竞技胜率基线（我方 = player，双方同策略）==');
const N = 32;
const we = runVersus(0.8, N), wn = runVersus(1.0, N), wh = runVersus(1.2, N);
console.log('   easy(0.8): ' + we + '/' + N + '   normal(1.0): ' + wn + '/' + N + '   hard(1.2): ' + wh + '/' + N);
ok('easy ≥ 8/16', we >= 8, we + '/' + N);
ok('normal ≥ 6/16', wn >= 6, wn + '/' + N);
ok('hard ≥ 4/16', wh >= 4, wh + '/' + N);

console.log('\n== 无尽中位数波数 ==');
const en = runEndless(40);
console.log('   中位数 ' + en.med + ' 波 · 均值 ' + en.avg + ' · 区间 [' + en.min + ',' + en.max + ']');
ok('无尽中位数 ≥ 9 波', en.med >= 9, en.med + '');

console.log('\n== 关卡通关率 ==');
const l1 = runLevel(0, 64);
console.log('   第 1 关巨鹿：' + l1 + '/64');
ok('第 1 关通关率 ≥ 30/64', l1 >= 30, l1 + '/64');
const l4 = runLevel(3, 64);   // 第 4 关（开局地 4×4）跨关继承前的单关难度
console.log('   第 4 关汉水：' + l4 + '/64');
ok('第 4 关通关率 ≥ 2/64（继承基线）', l4 >= 2, l4 + '/64');

console.log('\n──────────────────────────────');
console.log('基线 ' + pass + ' / ' + (pass + fail) + (fail ? '  ❌ 未达标 ' + fail : '  ✅ 全部达标'));
process.exit(fail ? 1 : 0);
