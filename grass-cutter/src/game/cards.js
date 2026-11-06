/**
 * 局内升级卡池（第 3 批 P0-5）—— 纯数据 + 抽卡，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 只有 8 张：先保证"击杀 → 升级 → 三选一 → 数值真的变"这个闭环可玩。
 * 内容批的 16 张卡 + 稀有度权重留后续批，本批**不引入** RARITY_WEIGHT。
 *
 * ⚠ mods 的键必须与 progression.js 的 `RunProgress.mods` 逐字一致
 *   （damage / kiRegen / musouGain / lifesteal / maxHpBonus）—— 拼错一个键就是"选了没效果"，
 *   而那种 bug 在页面上表现为"手感没变"，几乎不可能靠肉眼定位。
 *   `cap` 是这张卡一局内最多能叠几次；叠满后 drawThree 不再把它放进候选。
 */
export const CARDS = [
  { id: 'blade_s', name: '利刃', tier: '凡', text: '伤害 +10%', mods: { damage: 0.10 }, cap: 3 },
  { id: 'breath_s', name: '吐纳', tier: '凡', text: '斗气回复 +0.5/s', mods: { kiRegen: 0.5 }, cap: 3 },
  { id: 'surge_s', name: '蓄势', tier: '凡', text: '无双获取 +15%', mods: { musouGain: 0.15 }, cap: 3 },
  { id: 'iron_s', name: '铁骨', tier: '凡', text: '生命上限 +20', mods: { maxHpBonus: 20 }, cap: 3 },
  { id: 'blood_s', name: '饮血', tier: '凡', text: '击杀回血 +2', mods: { lifesteal: 2 }, cap: 3 },
  { id: 'blade_m', name: '快刀', tier: '良', text: '伤害 +20%', mods: { damage: 0.20 }, cap: 2 },
  { id: 'iron_m', name: '铜筋', tier: '良', text: '生命上限 +40', mods: { maxHpBonus: 40 }, cap: 2 },
  { id: 'sustain', name: '养气', tier: '良', text: '斗气回复 +0.6/s，击杀回血 +1', mods: { kiRegen: 0.6, lifesteal: 1 }, cap: 2 },
];

/**
 * 抽三张（同一次不重复；已叠满 cap 的不再出现）。
 * ⚠ 只在**升级时**调一次，绝不在每帧路径上 —— 它每次都新建数组，放主循环里就是每秒 60 次分配。
 * @param pool   卡池（默认就是 CARDS，参数化是为了单测能塞小池子）
 * @param taken  已选卡 id 列表（RunProgress.taken）
 * @param rng    0~1 的随机源（单测传确定性函数）
 */
export function drawThree(pool, taken = [], rng = Math.random) {
  const counts = {};
  for (const id of taken) counts[id] = (counts[id] || 0) + 1;
  const ok = pool.filter((c) => (counts[c.id] || 0) < c.cap);
  const out = [];
  while (out.length < 3 && ok.length) {
    const pick = ok[Math.floor(rng() * ok.length) % ok.length];
    out.push(pick);
    ok.splice(ok.indexOf(pick), 1);
  }
  return out;
}
