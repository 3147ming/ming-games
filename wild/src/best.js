// 阶段 4-3 · 目标感①：本地最高分 + 结算评级
//
// 与 meta.js 同一套纪律：**只管存读 + 纯函数**，不碰 DOM、不碰 ArenaCore。
// 顶层不访问 localStorage，所以 Node 测试里给 globalThis.localStorage 一个最小 shim
// 就能无头验证整套纪录/评级逻辑（见 tests/best.test.mjs）。
//
// 玩家反馈的原话是「死了就死了不想再来」。这一层给了两件东西：
//   ① 标题页三条**看得见的纪录**（最长存活 / 最高击杀 / 最高等级）——“再破一次”的目标；
//   ② 结算页一个 **S/A/B/C 评级** —— 把"我这局到底打得怎么样"从感觉变成可读的结论。
//
// ⚠ 这是**本地存档**（localStorage）：换设备 / 清缓存会丢。真云同步本轮不做（spec 明文）。
//   界面上必须标注"本地存档"，不能让玩家以为它跟着账号走。

const KEY = 'wild.best.v1';

/**
 * 评级切线。分数 = 存活秒数 + 击杀数（spec 二-2：「按存活时间 + 击杀数算总分」）。
 * ★ 定法：满局（600s + ~3300 杀）≈ 3900。
 *   · S 2800 —— 基本要活到 8 分钟以上且清得动场子，不是"活着就行"；
 *   · A 1700 —— 活到 5~6 分钟的中等局；
 *   · B  800 —— 打到中局就倒下；
 *   · C  其余 —— 开局阶段就结束了（新手第一局多半在这里，正好留出"再来一把"的空间）。
 */
export const GRADE_CUTS = [
  { g: 'S', at: 2800 },
  { g: 'A', at: 1700 },
  { g: 'B', at: 800 },
];

/** 总分（spec 二-2）。只由结算读数算出，纯函数 ⟹ 可无头断言。 */
export function scoreOf(res) {
  const sec = Number(res && res.survivalSec) || 0;
  const kills = Number(res && res.kills) || 0;
  return sec + kills;
}

/** 评级：S / A / B / C。纯函数，不读存档。 */
export function gradeOf(res) {
  const s = scoreOf(res);
  for (const c of GRADE_CUTS) if (s >= c.at) return c.g;
  return 'C';
}

/** 距下一档还差多少分（已是 S 则返回 0）。结算页用来给"再来一把"一个具体数字。 */
export function toNextGrade(res) {
  const s = scoreOf(res);
  const g = gradeOf(res);
  if (g === 'S') return 0;                                        // 已到顶
  if (g === 'C') return GRADE_CUTS[GRADE_CUTS.length - 1].at - s; // C 的下一档 = 最后一档切线（B）
  return GRADE_CUTS[GRADE_CUTS.findIndex((c) => c.g === g) - 1].at - s;
}

const EMPTY = { bestSec: 0, bestKills: 0, bestLevel: 0, runs: 0 };

/** 读纪录；任何异常（隐私模式 / 损坏 JSON）都回退到空纪录，绝不抛。 */
export function loadBest() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        bestSec: Number(o.bestSec) || 0,
        bestKills: Number(o.bestKills) || 0,
        bestLevel: Number(o.bestLevel) || 0,
        runs: Number(o.runs) || 0,
      };
    }
  } catch { /* 忽略，走默认 */ }
  return { ...EMPTY };
}

export function saveBest(b) {
  try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* 忽略 */ }
  return b;
}

/**
 * 提交一局的结算：返回评级 + **本局破了哪几条纪录**。
 * ★ 必须在写档**之前**比对旧纪录 —— 否则"破纪录"永远判不出来（自己跟自己比）。
 * @returns {{grade:string, score:number, records:{sec:boolean,kills:boolean,level:boolean}, best:object}}
 */
export function submitRun(res) {
  const prev = loadBest();
  const sec = Number(res && res.survivalSec) || 0;
  const kills = Number(res && res.kills) || 0;
  const level = Number(res && res.level) || 0;
  const records = {
    sec: sec > prev.bestSec,
    kills: kills > prev.bestKills,
    level: level > prev.bestLevel,
  };
  const best = saveBest({
    bestSec: Math.max(prev.bestSec, sec),
    bestKills: Math.max(prev.bestKills, kills),
    bestLevel: Math.max(prev.bestLevel, level),
    runs: prev.runs + 1,
  });
  return { grade: gradeOf(res), score: scoreOf(res), records, best };
}

/** 标题页用的"三条纪录"渲染数据（秒数顺手格式化，UI 层不再自己算）。 */
export function bestLines(b = loadBest()) {
  const mm = Math.floor(b.bestSec / 60), ss = b.bestSec % 60;
  return [
    { k: '最长存活', v: b.bestSec > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : '—' },
    { k: '最高击杀', v: b.bestKills > 0 ? String(b.bestKills) : '—' },
    { k: '最高等级', v: b.bestLevel > 0 ? `Lv.${b.bestLevel}` : '—' },
  ];
}
