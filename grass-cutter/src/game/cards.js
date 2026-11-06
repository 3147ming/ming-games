/**
 * 局内升级卡池 —— 纯数据 + 抽卡，不 import three / 不碰 DOM。
 * ---------------------------------------------------------------------------
 * 内容批：从 8 张扩到 **20 张**，并引入稀有度权重。
 *
 * ⚠ mods 的键必须与 progression.js 的 `RunProgress.mods` 逐字一致
 *   （damage / kiRegen / musouGain / lifesteal / maxHpBonus）—— 拼错一个键就是"选了没效果"，
 *   而那种 bug 在页面上表现为"手感没变"，几乎不可能靠肉眼定位。
 *   本批**新增两个键** `attackSpeed`（出招间隔倍率）与 `reach`（攻击距离倍率），
 *   已同步写进 progression.js 的初始 mods，两边必须一起改。
 *
 * 稀有度：
 *   凡(common) 权重 60 · 良(rare) 30 · 珍(epic) 10
 *   `cap` 是一局内最多叠几次；叠满后 drawThree 不再把它放进候选。
 */
export const RARITY_WEIGHT = { 凡: 60, 良: 30, 珍: 10 };

export const CARDS = [
  // ── 凡（常见，可叠 3 次）──────────────────────────────────────────────
  { id: 'blade_s', name: '利刃', tier: '凡', text: '伤害 +10%', mods: { damage: 0.10 }, cap: 3 },
  { id: 'breath_s', name: '吐纳', tier: '凡', text: '斗气回复 +0.5/s', mods: { kiRegen: 0.5 }, cap: 3 },
  { id: 'surge_s', name: '蓄势', tier: '凡', text: '无双获取 +15%', mods: { musouGain: 0.15 }, cap: 3 },
  { id: 'iron_s', name: '铁骨', tier: '凡', text: '生命上限 +20', mods: { maxHpBonus: 20 }, cap: 3 },
  { id: 'blood_s', name: '饮血', tier: '凡', text: '击杀回血 +2', mods: { lifesteal: 2 }, cap: 3 },
  // 内容批新增：出招速度与攻击距离（量变层，给玩家"手感真的变了"的正反馈）
  { id: 'quick_s', name: '疾手', tier: '凡', text: '出招速度 +8%', mods: { attackSpeed: 0.08 }, cap: 3 },
  { id: 'long_s', name: '长兵', tier: '凡', text: '攻击距离 +6%', mods: { reach: 0.06 }, cap: 3 },
  { id: 'focus_s', name: '凝神', tier: '凡', text: '斗气上限 +15', mods: { kiMaxBonus: 15 }, cap: 2 },

  // ── 良（较稀有，可叠 2 次）────────────────────────────────────────────
  { id: 'blade_m', name: '快刀', tier: '良', text: '伤害 +20%', mods: { damage: 0.20 }, cap: 2 },
  { id: 'iron_m', name: '铜筋', tier: '良', text: '生命上限 +40', mods: { maxHpBonus: 40 }, cap: 2 },
  { id: 'sustain', name: '养气', tier: '良', text: '斗气回复 +0.6/s，击杀回血 +1', mods: { kiRegen: 0.6, lifesteal: 1 }, cap: 2 },
  { id: 'quick_m', name: '风驰', tier: '良', text: '出招速度 +15%', mods: { attackSpeed: 0.15 }, cap: 2 },
  { id: 'blood_m', name: '嗜血', tier: '良', text: '击杀回血 +4', mods: { lifesteal: 4 }, cap: 2 },
  { id: 'reach_m', name: '丈八', tier: '良', text: '攻击距离 +12%', mods: { reach: 0.12 }, cap: 2 },
  { id: 'surge_m', name: '破军', tier: '良', text: '无双获取 +30%', mods: { musouGain: 0.30 }, cap: 2 },

  // ── 珍（稀有，可叠 1 次，通常是"质变"）─────────────────────────────────
  { id: 'blade_l', name: '神兵', tier: '珍', text: '伤害 +45%', mods: { damage: 0.45 }, cap: 1 },
  { id: 'iron_l', name: '金刚', tier: '珍', text: '生命上限 +90', mods: { maxHpBonus: 90 }, cap: 1 },
  { id: 'wind_l', name: '疾风', tier: '珍', text: '出招速度 +30%，攻击距离 +10%', mods: { attackSpeed: 0.30, reach: 0.10 }, cap: 1 },
  { id: 'regen_l', name: '回春', tier: '珍', text: '斗气回复 +1.5/s，击杀回血 +6', mods: { kiRegen: 1.5, lifesteal: 6 }, cap: 1 },
  { id: 'musou_l', name: '觉醒', tier: '珍', text: '无双获取 +60%', mods: { musouGain: 0.60 }, cap: 1 },
];

/**
 * 按稀有度权重挑一张（未叠满的池子里）。
 * 权重取自 RARITY_WEIGHT，未知 tier 按"凡"处理。
 */
function pickWeighted(ok, rng) {
  let total = 0;
  const weights = ok.map((c) => {
    const w = RARITY_WEIGHT[c.tier] ?? RARITY_WEIGHT['凡'];
    total += w;
    return w;
  });
  let r = rng() * total;
  for (let i = 0; i < ok.length; i++) {
    r -= weights[i];
    if (r <= 0) return ok[i];
  }
  return ok[ok.length - 1];
}

/**
 * 抽三张（同一次不重复；已叠满 cap 的不再出现；按稀有度加权）。
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
    const pick = pickWeighted(ok, rng);
    out.push(pick);
    ok.splice(ok.indexOf(pick), 1);
  }
  return out;
}
