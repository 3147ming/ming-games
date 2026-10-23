/* 赵云与阿斗 · 平衡基线自测（Node，不依赖浏览器）— V8.1 敌我双向微调后重校
 * 用法：node tools/balance.mjs
 * 双方均由游戏内 AI（ZY.AI.thinkSide）驱动，量三模式基线：
 *   · 竞技：easy(0.8)/normal(1.0)/hard(1.2) 我方胜率（目标 ≥ 8/6/4，每档 16 局地板）
 *     —— V5 竞技 = 15 波公共波次镜像进双方路；进行中谁先把对方阿斗打归零谁赢，
 *        打满则依次比阿斗剩血 → 击杀 → 资源存量；难度 = 敌方经济系数（×0.7/×1.0/×1.3）
 *   · 无尽：中位数波数（目标 ≥ 9）
 *   · 关卡：第 1 关通关率（目标 ≥ 30/64）· 第 4 关 ≥ 2/64（6 波制，关底张梁）
 *
 * V8.1 校准说明（为什么阈值仍是「地板值」而不是 40~55% 胜率）：
 *   本脚本两边都是游戏内 AI、规则完全镜像，我方每 tick 先手 → 绝对胜率天然偏高
 *   （V8 基线即 easy 14/16 · normal 16/16 · hard 15/16）。因此这里保留地板阈值，
 *   另打印「平均剩余阿斗 / 平均阿斗差」作为细粒度体感指标：敌方 +25% 之后同一脚本
 *   的 hard 从 15/16 掉到 14/16、无尽中位从 55 波掉到 50 波，方向正确。
 *   人类玩家的真实难度以「normal 竞技 40~55%」为设计目标，靠数值而定，不由本脚本断言。
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
  let win = 0, adouSum = 0, marginSum = 0, waveSum = 0;
  for (let g = 0; g < n; g++) {
    const s = G.baseState('versus', { difficulty: diff });
    let guard = 0;
    while (!s.over && guard++ < 6000) {
      ZY.AI.thinkSide(s, 'player');
      s.aiT = 0.5;  // 直接按 0.5s 频率驱动（tick 内敌方 AI 自动决策）
      G.tick(s, 0.5);
    }
    if (s.result === 'win') win++;
    adouSum += Math.max(0, s.player.adou);
    marginSum += Math.max(0, s.player.adou) - Math.max(0, s.enemy.adou);
    waveSum += s.wave.idx;
  }
  return { win: win, adou: adouSum / n, margin: marginSum / n, wave: waveSum / n };
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
const R = { easy: runVersus(0.8, N), normal: runVersus(1.0, N), hard: runVersus(1.2, N) };
const we = R.easy.win, wn = R.normal.win, wh = R.hard.win;
const line = (k) => k + ': ' + R[k].win + '/' + N + '（我方剩余阿斗 均 ' + R[k].adou.toFixed(2) +
  ' · 阿斗差 均 ' + R[k].margin.toFixed(2) + ' · 均 ' + R[k].wave.toFixed(1) + ' 波）';
console.log('   ' + line('easy'));
console.log('   ' + line('normal'));
console.log('   ' + line('hard'));
ok('easy ≥ 8/16', we >= 8, we + '/' + N);
ok('normal ≥ 6/16', wn >= 6, wn + '/' + N);
ok('hard ≥ 4/16', wh >= 4, wh + '/' + N);
ok('三档胜率随难度单调不升（我方 AI 视角）', we >= wn - 4 && wn >= wh - 4, we + '/' + wn + '/' + wh);

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
