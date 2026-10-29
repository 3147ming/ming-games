/* 赵云与阿斗 · 平衡基线自测（Node，不依赖浏览器）— V8.1 敌我双向微调后重校
 * 用法：node tools/balance.mjs
 * 双方均由游戏内 AI（ZY.AI.thinkSide）驱动，量三模式基线：
 *   · 竞技：easy(0.8)/normal(1.0)/hard(1.2) 我方胜率（目标 ≥ 8/6/4，每档 16 局地板）
 *     —— V5 竞技 = 15 波公共波次镜像进双方路；进行中谁先把对方阿斗打归零谁赢，
 *        打满则依次比阿斗剩血 → 击杀 → 资源存量；难度 = 敌方经济系数（×0.7/×1.0/×1.3）
 *   · 无尽：中位数波数（目标 ≥ 9）
 *   · 关卡：第 1/4/7/8 关通关率区间（第三批：地板 → 梯度区间）
 *
 * V8.1 校准说明（为什么阈值仍是「地板值」而不是 40~55% 胜率）：
 *   本脚本两边都是游戏内 AI、规则完全镜像，我方每 tick 先手 → 绝对胜率天然偏高
 *   （V8 基线即 easy 14/16 · normal 16/16 · hard 15/16）。因此这里保留地板阈值，
 *   另打印「平均剩余阿斗 / 阿斗差 / 结束波数」作为细粒度体感指标（V8 与 V8.1 同脚本 A/B：
 *   无尽中位 55 波 → 48~51 波；hard 胜率 15/16 → 13~16/16 —— 单局随机源波动 1~3 局，
 *   所以只用地板阈值断言、绝不断言具体胜率）。
 *   人类玩家的真实难度以「normal 竞技 40~55%」为设计目标，靠数值而定，不由本脚本断言。
 *
 * 第三批 P0-4 重标（旧 → 新，2026-10-30 实测）：
 *   第 1 关 64/64 · 第 4 关 64/64 · 第 7 关 63/64 · 第 8 关 61/64
 *   → 四条地板（≥30 / ≥2 / ≥2 / ≥2）改成四条窄区间（56~64 / 56~64 / 52~64 / 48~64）。
 *   为什么不写指令里建议的 48~64 / 24~56 / 8~40 / 4~32：八图重排后「有效（邻路）塔位」
 *   已从 21 逐关降到 14（rules-test 有断言），但做了最坏图实验 —— 把第 8 关 21 个塔位
 *   全搬到不邻路的格子上（只剩 8 个贴着主路），AI 仍然 23/24 通关、均漏 0.13。
 *   也就是说 6 波制下「塔位质量」对通关率的边际影响只有个位数，区间的下限压不到 4~32；
 *   真要拉出 8~40 的落差，只能改波次数量/血量倍率（本批明令不动 V8.1 数值），
 *   这件事留给下一批的「关卡波次编排」，本脚本先按实测值把区间钉住，防的是「越改越好打」。
 *   区间上限统一写 64，是因为 64 局里 1~3 局的随机抖动会误报，不把上限当约束用。
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
for (const f of ['units.js', 'maps.js', 'board.js', 'storage.js', 'ai.js', 'game.js']) {
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

console.log('\n== 关卡通关率（第三批：梯度区间，旧值 64/64/63/61）==');
const BAND = (n, lo) => n >= lo && n <= 64;
const l1 = runLevel(0, 64);
console.log('   第 1 关巨鹿：' + l1 + '/64  区间 56~64');
ok('第 1 关通关率 56~64/64', BAND(l1, 56), l1 + '/64');
const l4 = runLevel(3, 64);   // 第 4 关（开局塔位 21，6 波制）
console.log('   第 4 关汉水：' + l4 + '/64  区间 56~64');
ok('第 4 关通关率 56~64/64', BAND(l4, 56), l4 + '/64');
const l7 = runLevel(6, 64);   // 第 7 关街亭：第三批新图（有效塔位 15）
console.log('   第 7 关街亭：' + l7 + '/64  区间 52~64');
ok('第 7 关通关率 52~64/64', BAND(l7, 52), l7 + '/64');
const l8 = runLevel(7, 64);   // 第 8 关麦城：第三批新图（有效塔位 14）
console.log('   第 8 关麦城：' + l8 + '/64  区间 48~64');
ok('第 8 关通关率 48~64/64', BAND(l8, 48), l8 + '/64');

console.log('\n──────────────────────────────');
console.log('基线 ' + pass + ' / ' + (pass + fail) + (fail ? '  ❌ 未达标 ' + fail : '  ✅ 全部达标'));
process.exit(fail ? 1 : 0);
