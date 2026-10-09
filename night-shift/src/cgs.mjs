/**
 * CG 系统（任务6）：7 张像素风 CG 的清单与触发判定
 *
 * ── 为什么单独成模块、且零 DOM / 零 THREE 依赖 ──────────────
 * ① CG 的触发规则（"首次 ★5"、"完成第 7 夜"、"只弹一次"）是**纯逻辑**，
 *    放在能在 Node 里 import 的模块才能写单测；塞进 hud.mjs 就只能靠浏览器探针，
 *    而探针一旦被环境（无头浏览器连不上本地服务）卡住就整条断言失效。
 * ② 展示层（hud.openCg）只吃这里吐出来的 `{ file, title, text }`，
 *    两边没有反向依赖 —— CG 表里换一张图不需要动 DOM 代码。
 *
 * ── 三批次的语义差别（决定了关闭方式与是否只弹一次）────────
 *   batch 'A'（事件/剧情卡）：插画在上、事件文字在下、带选项。必须抉择的卡
 *        不给"点背景关闭"，避免玩家空手逃掉后果。
 *   batch 'B'（序章）：开局前的全景卡，2–3 句序章文字，**可跳过**。
 *   batch 'C'（里程碑整屏）：★5 / 第 7 夜达成时整屏弹，看完继续走结算。
 *
 * ── cgSeen 的边界 ────────────────────────────────────────
 * state.cgSeen 只记录"已经弹过"的 CG id，**不携带任何进度数据**。
 * 它绝不覆盖其它存档字段：markCgSeen 只 push，不整体赋值。
 * 存档白名单里加了 'cgSeen'（src/save.mjs），读档后才不会重复弹。
 */

/** 场景类别：事件卡 / 里程碑整屏 / 序章 */
export const CG_SCENE = { EVENT: 'event', MILESTONE: 'milestone', PROLOGUE: 'prologue' };

/**
 * 7 条 CG 清单，与 assets/cg/ 下的文件一一对应（tests/cg.test.mjs 断言文件存在）。
 * @property {string} id    唯一 id，也是写进 state.cgSeen 的标记
 * @property {string} file  相对 index.html 的路径
 * @property {string} title 卡面标题
 * @property {string} scene CG_SCENE 之一
 * @property {'A'|'B'|'C'} batch 批次
 * @property {string} [text] 卡面正文（事件卡由抉择事件自己带 body，这里给默认说明）
 */
export const CG_LIST = [
  {
    id: 'a1_stranger',
    file: 'assets/cg/cg_a1_stranger.png',
    title: '深夜怪客',
    scene: CG_SCENE.EVENT,
    batch: 'A',
    text: '凌晨三点，一个戴着兜帽的男人推门进来，谁也没看清他的脸。',
  },
  {
    id: 'a2_meteor',
    file: 'assets/cg/cg_a2_meteor.png',
    title: '流星夜',
    scene: CG_SCENE.EVENT,
    batch: 'A',
    text: '气象台说今夜有流星雨。便利店的玻璃门外，是整座城市抬头的一分钟。',
  },
  {
    id: 'a3_regular',
    file: 'assets/cg/cg_a3_regular.png',
    title: '常客委托',
    scene: CG_SCENE.EVENT,
    batch: 'A',
    text: '老主顾靠在收银台边，欲言又止——他好像有件事想托你办。',
  },
  {
    id: 'a4_thief',
    file: 'assets/cg/cg_a4_thief.png',
    title: '小偷现场',
    scene: CG_SCENE.EVENT,
    batch: 'A',
    text: '监控画面里，一只手正伸向货架深处。',
  },
  {
    id: 'b1_prologue',
    file: 'assets/cg/cg_b1_prologue.png',
    title: '序章 · 接灯的人',
    scene: CG_SCENE.PROLOGUE,
    batch: 'B',
    text: '',
  },
  {
    id: 'c1_five_star',
    file: 'assets/cg/cg_c1_five_star.png',
    title: '★5 · 街角的灯',
    scene: CG_SCENE.MILESTONE,
    batch: 'C',
    text: '你把这家小店做到了五星。街角的灯，终于被更多人看见。',
  },
  {
    id: 'c2_dawn',
    file: 'assets/cg/cg_c2_dawn.png',
    title: '黎明 · 第七夜之后',
    scene: CG_SCENE.MILESTONE,
    batch: 'C',
    text: '第七个夜班结束。卷帘门升起时，天已经亮了。',
  },
];

export const CG_BY_ID = Object.fromEntries(CG_LIST.map((c) => [c.id, c]));

/** 序章文字（B 批：2–3 句，逐句浮现） */
export const PROLOGUE_LINES = [
  '你把卷帘门拉到一半，留了一条缝——那是这店里唯一的进出口。',
  '荧光灯嗡的一声亮起来，货架空着，等着被填满。',
  '门外还有整座城市没有睡。今夜，你是这盏灯唯一的守夜人。',
];

/**
 * 里程碑触发条件（C 批：达成即整屏弹，且**只弹一次**）。
 * 判定只依赖传入的快照，不读全局 state —— 便于单测直接构造。
 */
export const CG_MILESTONES = [
  {
    id: 'c1_five_star',
    when: ({ starLevel = 0 }) => starLevel >= 5,
    caption: '首次达成 ★5',
  },
  {
    id: 'c2_dawn',
    when: ({ night = 0 }) => night >= 7,
    caption: '完成第 7 夜',
  },
];

/* ---------- 已弹标记 ---------- */

/** 兜底：cgSeen 可能被旧档 / 手写档搞坏，只读出数组，绝不覆盖其它字段 */
function seenList(state) {
  if (!state) return [];
  if (!Array.isArray(state.cgSeen)) state.cgSeen = [];
  return state.cgSeen;
}

export function hasSeenCg(state, id) {
  return seenList(state).includes(id);
}

/**
 * 标记"已弹"。
 * @returns {boolean} true = 这次是首次（调用方据此决定要不要弹）；false = 之前弹过
 */
export function markCgSeen(state, id) {
  const list = seenList(state);
  if (list.includes(id)) return false;
  list.push(id);
  state.cgSeen = list;   // 只回写这一个字段，绝不整体覆盖 state
  return true;
}

/* ---------- 取图 ---------- */

/** @returns {string} 可直接塞进 <img src> 的相对路径 */
export function cgUrl(idOrFile) {
  const rec = CG_BY_ID[idOrFile];
  if (rec) return rec.file;
  return typeof idOrFile === 'string' ? idOrFile : '';
}

/**
 * 里程碑：此刻**该弹但还没弹过**的全部（按 CG_MILESTONES 顺序）。
 *
 * 为什么返回数组而不是只取第一张：第 7 夜是**周终**（打完直接进 weekEnd），
 * 若那一夜恰好同时达成 ★5，只弹第一张就会把第二张永久饿死 ——
 * 之后没有下一次结算了。返回数组让调用方排队依次弹完。
 *
 * @param state
 * @param {{starLevel?:number, night?:number}} snap
 * @returns {object[]} CG 记录 + caption
 */
export function pendingMilestones(state, snap = {}) {
  const out = [];
  for (const m of CG_MILESTONES) {
    if (!m.when(snap)) continue;
    if (hasSeenCg(state, m.id)) continue;
    const rec = CG_BY_ID[m.id];
    if (!rec) continue;
    out.push({ ...rec, caption: m.caption });
  }
  return out;
}

/** 只取第一张（给"当前该弹哪张"这种单点判断用） */
export function pendingMilestone(state, snap = {}) {
  return pendingMilestones(state, snap)[0] ?? null;
}

/** 序章：只弹一次（与里程碑同一个 cgSeen 标记位） */
export function prologuePending(state) {
  return !hasSeenCg(state, 'b1_prologue');
}

/** 给展示层的一句摘要（用于图片未加载时的占位文案） */
export function cgText(id) {
  return CG_BY_ID[id]?.text ?? '';
}

export default {
  CG_LIST, CG_BY_ID, CG_MILESTONES, PROLOGUE_LINES, CG_SCENE,
  cgUrl, hasSeenCg, markCgSeen, pendingMilestones, pendingMilestone, prologuePending, cgText,
};
