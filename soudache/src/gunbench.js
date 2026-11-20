/**
 * 改枪台（P6）：纯逻辑层
 *
 * 设计约束（与 upgrades.js 同口径）：
 *  1. 不 import three / 不碰 DOM / 不读 localStorage —— Node 单测可直接 import，
 *     也能在 UI、战局创建等任意层复用，绝不把浏览器依赖带进来。
 *  2. 所有「配件改哪些数值、怎么改」的真值都在 config.js 的 WEAPON_MODS 一处，
 *     UI 与战局只消费本文件算出的结果，不在别处再写一份数值。
 *  3. computeEffectiveWeapon 必须返回**新的** def 对象，绝不原地改传入的 baseDef
 *     （config.js 的武器常量是全局单例，原地改会泄漏到下一局、污染测试）。
 *
 * 数值口径：每个被改字段按 (base * mul + add) 计算；mul 默认 1、add 默认 0。
 * 乘区与加区各自累加（多个同槽/跨槽附件会叠加），最后统一取整（magSize/rpm）或保留两位小数。
 */

import { WEAPON_MOD_SLOTS, WEAPON_MODS } from './config.js';

/** 角色键（与 save.loadout 的两把武器对应）。 */
const ROLES = ['primary', 'secondary'];

/** 字段 → [乘区key, 加区key] 映射。magSize 与 rpm 为整数，其余保留两位。 */
const FIELD_KEYS = {
  damage: ['damageMul', 'damageAdd'],
  recoil: ['recoilMul', 'recoilAdd'],
  spread: ['spreadMul', 'spreadAdd'],
  range: ['rangeMul', 'rangeAdd'],
  magSize: ['magSizeMul', 'magSizeAdd'],
  reloadTime: ['reloadMul', 'reloadAdd'],
  noiseRadius: ['noiseMul', 'noiseAdd'],
  rpm: ['rpmMul', 'rpmAdd'],
};

/** 取整字段集合（其余用 round4：散布/后坐在百分位，两位精度会抹平配件效果）。 */
const INT_FIELDS = new Set(['magSize', 'rpm']);

/** 保留四位小数，避免浮点尾数进入配置（散布/后坐在百分位，两位会把 0.014 压成 0.01）。 */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** 全新存档的改枪台配置（两把武器各自一个空槽映射）。 */
export function defaultLoadoutMods() {
  return { primary: {}, secondary: {} };
}

/**
 * 把任意来源的 mods 字段归一化为合法结构：缺失/坏值自动丢弃，并校验每个附件
 * 确实存在且槽位一致。老档缺 mods 时返回两份空映射（不报错、不崩）。
 * @param {*} raw 原始 mods 字段，形如 { primary: { muzzle: 'suppressor' }, secondary: {} }
 * @returns {{primary: object, secondary: object}} 归一化后的附件映射
 */
export function normalizeWeaponMods(raw) {
  const out = defaultLoadoutMods();
  if (!raw || typeof raw !== 'object') return out;
  for (const role of ROLES) {
    const src = raw[role];
    if (!src || typeof src !== 'object') continue;
    for (const slot of WEAPON_MOD_SLOTS) {
      const v = src[slot.id];
      if (!v) continue; // 空（未装）或假值直接跳过
      const mod = WEAPON_MODS[v];
      // 只保留「存在且槽位匹配」的附件，避免手改/坏数据把任意 key 塞进来
      if (mod && mod.slot === slot.id) out[role][slot.id] = v;
    }
  }
  return out;
}

/**
 * 某个槽位、某把武器可用的附件清单（含「空」选项）。
 * @param {string} slot 槽位 id（WEAPON_MOD_SLOTS 之一）
 * @param {string} weaponId 武器 id（用于按 compatible 过滤）
 * @returns {Array<{id: string|null, name: string, slot: string, weight: number, desc?: string}>} 选项
 */
export function attachmentOptions(slot, weaponId) {
  const list = [{ id: null, name: '空', slot, weight: 0 }];
  for (const m of Object.values(WEAPON_MODS)) {
    if (m.slot !== slot) continue;
    const compat = m.compatible || ['*'];
    if (compat.indexOf('*') === -1 && compat.indexOf(weaponId) === -1) continue;
    list.push({ id: m.id, name: m.name, slot: m.slot, weight: m.weight, desc: m.desc });
  }
  return list;
}

/**
 * 把一组附件（slot → modId）合并到基础武器 def，返回**新的** def（不原地改 baseDef）。
 * 多个附件按槽位/跨槽叠加：所有 mods 的乘区累乘、加区累加，最后统一应用到字段。
 * @param {object} baseDef 基础武器定义（config.WEAPONS[id]）
 * @param {object} [modsMap] 形如 { muzzle: 'suppressor', grip: 'vgrip' }（空槽不出现或值为 null）
 * @returns {object} 改装后的新 def（含 installedMods 供 UI/调试）
 */
export function computeEffectiveWeapon(baseDef, modsMap) {
  const def = { ...baseDef };
  const modsMapSafe = modsMap || {};

  // 累加所有附件的乘区与加区
  const acc = {};
  for (const [mulKey, addKey] of Object.values(FIELD_KEYS)) {
    acc[mulKey] = 1;
    acc[addKey] = 0;
  }
  const installed = [];
  for (const modId of Object.values(modsMapSafe)) {
    if (!modId) continue;
    const m = WEAPON_MODS[modId];
    if (!m) continue;
    installed.push(modId);
    const md = m.mods || {};
    for (const [mulKey, addKey] of Object.values(FIELD_KEYS)) {
      if (typeof md[mulKey] === 'number') acc[mulKey] *= md[mulKey];
      if (typeof md[addKey] === 'number') acc[addKey] += md[addKey];
    }
  }

  for (const [field, [mulKey, addKey]] of Object.entries(FIELD_KEYS)) {
    if (typeof def[field] !== 'number') continue;
    let v = def[field] * acc[mulKey] + acc[addKey];
    v = INT_FIELDS.has(field) ? Math.round(v) : round4(v);
    def[field] = v;
  }

  def.installedMods = installed;
  return def;
}

/**
 * 把存档里的改枪台配置应用到本局 cfg 的对应武器上（原地改 cfg.WEAPONS，因为 cfg 本就是
 * applyMods 产出的本局专用副本）。改装树（upgrades）已在 cfg 上生效，附件在其之上叠加。
 * @param {object} cfg applyMods 返回的本局配置（含 WEAPONS）
 * @param {object} save 存档对象（读 save.loadout.mods 与 primary/secondary）
 * @returns {object} 同一个 cfg（便于链式）
 */
export function applyWeaponMods(cfg, save) {
  const lo = (save && save.loadout) || {};
  const mods = normalizeWeaponMods(lo.mods);
  const roleWeapon = { primary: lo.primary, secondary: lo.secondary };
  for (const role of ROLES) {
    const weaponId = roleWeapon[role];
    if (!weaponId || !cfg.WEAPONS[weaponId]) continue;
    cfg.WEAPONS[weaponId] = computeEffectiveWeapon(cfg.WEAPONS[weaponId], mods[role]);
  }
  return cfg;
}

/**
 * 改枪台给整份配装增加的附件重量（kg，可负）。
 * @param {object} lo 装备配置（读 lo.mods）
 * @returns {number} 附件总重
 */
export function loadoutModWeight(lo) {
  const mods = normalizeWeaponMods(lo && lo.mods);
  let w = 0;
  for (const role of ROLES) {
    for (const modId of Object.values(mods[role])) {
      if (modId && WEAPON_MODS[modId]) w += WEAPON_MODS[modId].weight;
    }
  }
  return w;
}

/**
 * 改枪台 13 项面板（W1）：对标《三角洲行动》改枪台的字段清单。
 *
 * 与 `effectiveStatsPreview` 的关系：
 * - 那个函数返回 8 个**原始字段**的基础→改装对比，是数值真值与单测的锚点，保持不动；
 * - 本函数负责把它翻译成「玩家看得懂的 13 项」，其中 5 项是派生分（后坐控制/操控速度/
 *   腰际稳定/精准精度/护甲伤害），4 项是单位换算（射程 m、枪声 m、初速 m/s），
 *   1 项是枚举（开火模式）。
 *
 * 派生分公式（全部落在这里，UI 不再自己算，避免两套口径）：
 * - 后坐控制   = 100 - recoil*1600          （步枪 0.018 → 71）
 * - 操控速度   = 100 - reloadTime*12 - weight*4
 * - 腰际稳定性 = 100 - spread*2000          （步枪 0.012 → 76）
 * - 精准精度   = 100 - spreadPerShot*3000   （连发扩散越小越准）
 * - 护甲伤害   = damage*0.8                 （未计弹种穿透，弹种加成在局内按 pen 结算）
 * 分数统一 clamp 到 1~99，避免出现 0 或 100 这种"看起来像坏了"的极值。
 *
 * @param {object} baseDef 基础武器定义
 * @param {object} [modsMap] 当前槽位映射
 * @returns {Array<{key:string,label:string,base:number|string,after:number|string,
 *   better:boolean|null,unit:string,kind:'score'|'num'|'text'}>}
 */
export function benchStatRows(baseDef, modsMap) {
  const after = computeEffectiveWeapon(baseDef, modsMap);
  const clampScore = (v) => Math.max(1, Math.min(99, Math.round(v)));
  const m = (units) => Math.round(units / 20); // 1m = 20 单位（与全局 TILE/单位口径一致）

  // 口径 → 标称初速（m/s）。用于展示"枪口初速"，不是命中计算的输入。
  const VELOCITY = { '556': 880, '9mm': 380, '762': 715, '12ga': 400 };
  const vel = VELOCITY[baseDef.caliber] || 0;

  const rows = [
    { key: 'value', label: '价值', kind: 'num', unit: '¥', betterHi: true, get: (d) => Number(d.value) || 0 },
    { key: 'damage', label: '基础伤害', kind: 'num', unit: '', betterHi: true, get: (d) => Number(d.damage) || 0 },
    { key: 'rangeM', label: '优势射程', kind: 'num', unit: 'm', betterHi: true, get: (d) => m(Number(d.range) || 0) },
    { key: 'recoilCtl', label: '后坐控制', kind: 'score', unit: '', betterHi: true, get: (d) => clampScore(100 - (Number(d.recoil) || 0) * 1600) },
    { key: 'handling', label: '操控速度', kind: 'score', unit: '', betterHi: true, get: (d) => clampScore(100 - (Number(d.reloadTime) || 0) * 12 - (Number(d.weight) || 0) * 4) },
    { key: 'hipSteady', label: '腰际稳定', kind: 'score', unit: '', betterHi: true, get: (d) => clampScore(100 - (Number(d.spread) || 0) * 2000) },
    { key: 'accuracy', label: '精准精度', kind: 'score', unit: '', betterHi: true, get: (d) => clampScore(100 - (Number(d.spreadPerShot) || 0) * 3000) },
    { key: 'armorDmg', label: '护甲伤害', kind: 'num', unit: '', betterHi: true, get: (d) => Math.round((Number(d.damage) || 0) * 0.8) },
    { key: 'rpm', label: '射速', kind: 'num', unit: 'RPM', betterHi: true, get: (d) => Number(d.rpm) || 0 },
    { key: 'magSize', label: '容量', kind: 'num', unit: '发', betterHi: true, get: (d) => Number(d.magSize) || 0 },
    { key: 'fireMode', label: '开火模式', kind: 'text', unit: '', betterHi: null, get: (d) => (d.auto ? '全自动' : '半自动') },
    { key: 'velocity', label: '枪口初速', kind: 'num', unit: 'm/s', betterHi: true, get: () => vel },
    { key: 'noiseM', label: '枪声传播', kind: 'num', unit: 'm', betterHi: false, get: (d) => m(Number(d.noiseRadius) || 0) },
  ];

  return rows.map((r) => {
    const b = r.get(baseDef);
    const a = r.get(after);
    let better = null;
    if (r.kind !== 'text' && r.betterHi !== null && Number.isFinite(b) && Number.isFinite(a) && b !== a) {
      better = r.betterHi ? a > b : a < b;
    }
    return { key: r.key, label: r.label, base: b, after: a, better, unit: r.unit, kind: r.kind };
  });
}

/**
 * 生成「基础 → 改装」的数值预览，供 UI 直接渲染。
 * @param {object} baseDef 基础武器定义
 * @param {object} modsMap 当前槽位映射
 * @returns {Array<{key: string, label: string, base: number, after: number, better: boolean|null}>}
 *   better = after 相对 base 是否「更好」（true 好 / false 差 / null 不可比或持平）；
 *   对伤害/射程/弹匣/射速为越高越好，后坐/散布/换弹/噪音为越低越好。
 */
export function effectiveStatsPreview(baseDef, modsMap) {
  const after = computeEffectiveWeapon(baseDef, modsMap);
  const lowerIsBetter = new Set(['recoil', 'spread', 'reloadTime', 'noiseRadius']);
  const rows = [
    ['damage', '伤害'],
    ['recoil', '后坐'],
    ['spread', '散布'],
    ['range', '射程'],
    ['magSize', '弹匣'],
    ['reloadTime', '换弹'],
    ['noiseRadius', '噪音'],
    ['rpm', '射速'],
  ];
  return rows.map(([key, label]) => {
    const b = Number(baseDef[key]);
    const a = Number(after[key]);
    let better = null;
    if (Number.isFinite(b) && Number.isFinite(a) && b !== a) {
      better = lowerIsBetter.has(key) ? a < b : a > b;
    }
    return { key, label, base: b, after: a, better };
  });
}
