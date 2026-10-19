/* 赵云与阿斗 · 平衡基线自测（Node，不依赖浏览器）— V5 原版对齐
 * 用法：node tools/balance.mjs
 * 双方均由游戏内 AI（ZY.AI.thinkSide）驱动，量三模式基线：
 *   · 竞技：easy(0.8)/normal(1.0)/hard(1.2) 我方胜率（目标 ≥ 8/6/4，每档 16 局地板）
 *     —— V5 竞技 = 15 波公共波次镜像进双方路；进行中谁先把对方阿斗打归零谁赢，
 *        打满则依次比阿斗剩血 → 击杀 → 资源存量；难度 = 敌方经济系数（×0.7/×1.0/×1.3）
 *   · 无尽：中位数波数（目标 ≥ 9）
 *   · 关卡：第 1 关通关率（目标 ≥ 30/64）· 第 4 关 ≥ 2/64（6 波制，关底张梁）
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
const G = ZY.Game, B = ZY.B, C = ZY.C;

/* ---------- 对局驱动：我方 = AI 策略（与游戏内 thinkSide 同规则）；敌方 = 游戏内 in-tick AI ---------- */
function runVersus(diff, n) {
  let win = 0;
  for (let g = 0; g < n; g++) {
    const s = G.baseState('versus', { difficulty: diff });
    let guard = 0;
    while (!s.over && guard++ < 6000) {
      ZY.AI.thinkSide(s, 'player');
      s.aiT = 0.5;  // 直接按 0.5s 频率驱动（tick 内敌方 AI 自动决策）
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
      ZY.AI.thinkSide(s, 'player');
      G.tick(s, 0.5);
    }
    waves.push(s.wave.idx);
  }
  waves.sort((a, b) => a - b);
  const med = waves[Math.floor(waves.length / 2)];
  const avg = waves.reduce((a, b) => a + b, 0) / n;
  return { med, avg: Math.round(avg), min: waves[0], max: waves[waves.length - 1] };
}

function runLevel(levelIdx, n) {
  let clear = 0;
  for (let g = 0; g < n; g++) {
    const s = G.baseState('level', { levelIdx: levelIdx });
    let guard = 0;
    while (!s.over && guard++ < 8000) {
      ZY.AI.thinkSide(s, 'player');
      G.tick(s, 0.5);
    }
    if (s.result === 'win') clear++;
  }
  return clear;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

console.log('\n== 竞技胜率基线（我方 = AI 策略，敌方 = 游戏内 AI，难度=敌方经济系数）==');
const N = 16;
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
const l4 = runLevel(3, 64);   // 第 4 关（开局塔位 21，6 波制）
console.log('   第 4 关汉水：' + l4 + '/64');
ok('第 4 关通关率 ≥ 2/64', l4 >= 2, l4 + '/64');
const l7 = runLevel(6, 64);   // 第 7 关街亭：左右翻转新图（V6 内容扩展）
console.log('   第 7 关街亭：' + l7 + '/64');
ok('第 7 关通关率 ≥ 2/64', l7 >= 2, l7 + '/64');
const l8 = runLevel(7, 64);   // 第 8 关麦城：上下翻转新图（V6 内容扩展）
console.log('   第 8 关麦城：' + l8 + '/64');
ok('第 8 关通关率 ≥ 2/64', l8 >= 2, l8 + '/64');

console.log('\n──────────────────────────────');
console.log('基线 ' + pass + ' / ' + (pass + fail) + (fail ? '  ❌ 未达标 ' + fail : '  ✅ 全部达标'));
process.exit(fail ? 1 : 0);
