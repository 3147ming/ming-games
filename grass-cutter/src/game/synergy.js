/**
 * 局内流派 / 羁绊系统 —— 纯逻辑，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 目的：给三选一升级加"Build 成型的瞬间"。玩家凑齐一组卡时，解锁一个流派，
 *   在原有 mods 之上叠一层**质变加成**，并弹一次"流派觉醒"横幅。
 *
 * 设计纪律（与 progression.js / cards.js 保持一致）：
 *   1. 加成只用 progression.js 里已有的 mods 键，绝不新造键 —— 新键 combat 不认，
 *      会变成"选了没效果"的隐形 bug。
 *   2. 本模块只计算"应该叠加什么"，不改 run.mods 本身；由 main 调 applyTo() 落地，
 *      并做幂等（同一流派只叠一次），避免每帧重复加。
 *   3. 纯函数 + 显式 rng/输入，可被 node --test 直接钉住。
 *
 * 判定口径：
 *   · 每张卡按 id 映射到一个或多个 tag（下表 CARD_TAGS）。
 *   · 流派定义 needs：{ tag: 次数 } 或 { card: id } 锚点；全部满足即激活。
 *   · "珍"级锚点卡让流派有质变感：凑到关键珍卡才算真正成型。
 */

/** 每张卡的 tag。未列出的卡不参与任何流派（保持中性，不影响既有平衡）。 */
export const CARD_TAGS = {
  // 快刀流：攻速 / 位移向
  quick_s: ['swift'], quick_m: ['swift'], wind_l: ['swift'], long_s: ['swift'],
  // 重兵流：伤害 / 破防向
  blade_s: ['heavy'], blade_m: ['heavy'], blade_l: ['heavy'], reach_m: ['heavy'], surge_m: ['heavy'],
  // 铁血流：生存 / 回复向
  iron_s: ['tough'], iron_m: ['tough'], iron_l: ['tough'], blood_s: ['tough'],
  blood_m: ['tough'], regen_l: ['tough'], sustain: ['tough'],
  // 气功流：斗气 / 无双向
  breath_s: ['qi'], focus_s: ['qi'], surge_s: ['qi'],
  musou_l: ['qi'], surge_m: ['qi'],
};

/**
 * 流派定义。
 *   id / name / desc  展示用
 *   color             横幅主色
 *   needTags          { tag: 最少层数 }
 *   needCards         必须包含的卡 id（质变锚点）
 *   bonus             叠加到 run.mods 的加成（键必须存在于 progression.mods）
 */
export const SYNERGIES = [
  {
    id: 'swift', name: '疾风剑意', desc: '身随剑走 · 出招如电',
    color: '#2e8b8b',
    needTags: { swift: 3 },
    needCards: [],
    bonus: { attackSpeed: 0.25, reach: 0.10 },
  },
  {
    id: 'heavy', name: '万钧破阵', desc: '一刀重于千钧 · 势不可挡',
    color: '#a8362c',
    needTags: { heavy: 3 },
    needCards: [],
    bonus: { damage: 0.40 },
  },
  {
    id: 'tough', name: '不动如山', desc: '血肉为城 · 杀敌回生',
    color: '#6b7a3a',
    needTags: { tough: 4 },
    needCards: [],
    bonus: { maxHpBonus: 40, lifesteal: 3 },
  },
  {
    id: 'qi', name: '气吞山河', desc: '斗气盈身 · 无双不绝',
    color: '#4a5fa8',
    needTags: { qi: 3 },
    needCards: ['musou_l'], // 珍卡「觉醒」为质变锚点
    bonus: { kiRegen: 1.0, musouGain: 0.40, kiMaxBonus: 20 },
  },
];

/** 统计已选卡的 tag 次数。 */
export function countTags(taken = [], tagMap = CARD_TAGS) {
  const counts = {};
  for (const id of taken) {
    const tags = tagMap[id];
    if (!tags) continue;
    for (const t of tags) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

/** 单个流派是否满足激活条件。 */
export function isUnlocked(syn, taken = [], tagMap = CARD_TAGS) {
  const counts = countTags(taken, tagMap);
  for (const [tag, need] of Object.entries(syn.needTags || {})) {
    if ((counts[tag] || 0) < need) return false;
  }
  for (const card of syn.needCards || []) {
    if (!taken.includes(card)) return false;
  }
  return true;
}

/**
 * 找出本次新激活的流派：在 all 中满足、且不在 prev 中的。
 * @param prev 之前已激活的流派 id 列表
 * @param all  可用的流派定义（默认 SYNERGIES）
 */
export function newlyUnlocked(taken, prev = [], all = SYNERGIES) {
  const set = new Set(prev);
  return all.filter((s) => !set.has(s.id) && isUnlocked(s, taken));
}

/**
 * 把一个流派的 bonus 叠加到 mods 上（原地改，与 combat.mods 同引用 → 下一帧生效）。
 * 只叠加 mods 中已存在的键，杜绝新键造成的"选了没效果"。
 */
export function applyTo(mods, syn) {
  if (!mods || !syn || !syn.bonus) return mods;
  for (const k in syn.bonus) {
    if (Object.prototype.hasOwnProperty.call(mods, k)) {
      mods[k] = (mods[k] || 0) + syn.bonus[k];
    }
  }
  return mods;
}

/** 快照：已激活流派（供 HUD / 结算展示）。 */
export function activeSynergies(taken, all = SYNERGIES) {
  return all.filter((s) => isUnlocked(s, taken));
}
