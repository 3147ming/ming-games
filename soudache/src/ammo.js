/**
 * 弹药口径与配装（P7，纯逻辑 · 零 DOM · 零随机）
 *
 * 这一层只回答四个问题，UI / 存档 / 战局都从这里取同一个答案：
 *  1. 这把枪能用哪些弹种？（按口径分组，不跨口径通用）
 *  2. 这一局主/副武器装的是哪一型？（存档里选，缺省回落标准弹）
 *  3. 带了几盒？多重？值多少钱？（弹药 value/weight 是「盒」口径，不能裸乘发数）
 *  4. 旧存档的 ammo556Boxes / ammo9mmBoxes 怎么迁进 loadout.ammo？
 *
 * 为什么抽出来：main.deploy / player.buildLoadoutItems / ui 的负重和校验
 * 各自算一遍弹药，必然出现「UI 显示 2 盒、实际只带进去 1 盒」这类漂移。
 */

import { WEAPONS, ITEMS, CALIBERS, AMMO_IDS } from './config.js';

const int = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 某把武器可用的弹种 id 列表；未知武器返回空数组。 */
export function ammoIdsForWeapon(weaponId, weapons = WEAPONS) {
  const w = weapons && weapons[weaponId];
  if (!w) return [];
  const c = CALIBERS[w.caliber];
  return c ? c.ammo.slice() : [];
}

/** 某把武器的默认弹种（标准弹）；未知武器回落 null。 */
export function defaultAmmoForWeapon(weaponId, weapons = WEAPONS) {
  const list = ammoIdsForWeapon(weaponId, weapons);
  return list.length ? list[0] : null;
}

/** 弹种定义；未知 id 返回 null。 */
export function ammoDef(id, items = ITEMS) {
  return (id && items && items[id]) || null;
}

/**
 * 某一型弹药「一盒多少发」。
 *
 * ⚠ 各口径并不统一：5.56 / 9mm / 7.62 都是 60，**12ga 是 24**。
 * 早期代码直接拿全局 `AMMO_STACK` 换算，导致「1 盒霰弹 = 60 发」的假设
 * 与仓库里的 24 发对不上 —— 表现就是新档带 1 盒 12ga 会被校验判成超库存，
 * 永远部署不了。凡是「盒 ↔ 发」的换算都必须走这里。
 *
 * @param {string} id 弹种 id
 * @param {object} items 物品表（可注入，便于测试）
 * @returns {number} 每盒发数
 */
export function ammoBoxSize(id, items = ITEMS) {
  const def = items && items[id];
  const n = Number(def && (def.ammoQty || def.stack));
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * 存档里某一型弹药带了几盒。
 * 优先读新字段 loadout.ammo；旧档只有 ammo556Boxes / ammo9mmBoxes 时回落读取。
 * 两条路径都做非负取整，手改坏值不会把负重算成 NaN。
 */
export function loadoutAmmoBoxes(lo, id) {
  if (!lo || !id) return 0;
  const map = lo.ammo;
  if (map && typeof map === 'object' && Number.isFinite(Number(map[id]))) {
    return int(map[id]);
  }
  if (id === 'ammo556') return int(lo.ammo556Boxes);
  if (id === 'ammo9mm') return int(lo.ammo9mmBoxes);
  return 0;
}

/** 存档里全部弹种的盒数映射（只列 AMMO_IDS，忽略未知键）。 */
export function loadoutAmmoMap(lo) {
  const out = {};
  for (const id of AMMO_IDS) out[id] = loadoutAmmoBoxes(lo, id);
  return out;
}

/** 随身弹药总重量（kg，按盒口径）。 */
export function loadoutAmmoWeight(lo, items = ITEMS) {
  let w = 0;
  for (const id of AMMO_IDS) {
    const def = items[id] || ITEMS[id];
    if (def) w += loadoutAmmoBoxes(lo, id) * (def.weight || 0);
  }
  return Math.round(w * 10) / 10;
}

/** 随身弹药总估值（按盒口径）。 */
export function loadoutAmmoValue(lo, items = ITEMS) {
  let v = 0;
  for (const id of AMMO_IDS) {
    const def = items[id] || ITEMS[id];
    if (def) v += loadoutAmmoBoxes(lo, id) * (def.value || 0);
  }
  return v;
}

/**
 * 武器槽当前选中的弹种。
 * 选中的弹种必须与武器口径一致，否则回落该武器的默认弹。
 *
 * W2：新增 `sidearm`（手枪槽）。它没有独立的弹种存档字段 —— 与副武器共用
 * `ammoSecondary`，因为两槽都在 9mm 家族里，拆成两套配置只会让玩家多绕一步。
 * @param {object} lo 存档 loadout
 * @param {'primary'|'secondary'|'sidearm'} role 槽位
 * @param {object} weapons 武器表（可注入改装后的 cfg.WEAPONS）
 */
export function resolveAmmoGrade(lo, role, weapons = WEAPONS) {
  const weaponId = lo && (role === 'sidearm' ? lo.sidearm
    : role === 'secondary' ? lo.secondary : lo.primary);
  const list = ammoIdsForWeapon(weaponId, weapons);
  if (!list.length) return null;
  const key = role === 'primary' ? 'ammoPrimary' : 'ammoSecondary';
  const picked = lo && lo[key];
  return list.includes(picked) ? picked : list[0];
}

/**
 * 归一化 loadout 的弹药配置（迁移旧档 / 修坏值 / 保证弹种与武器口径一致）。
 *
 * 只改传入对象，不返回新对象 —— 调用点（loadSave / set-loadout）都期望原地更新存档。
 * @param {object} lo 存档 loadout（会被就地修改）
 * @param {object} weapons 武器表
 * @returns {object} 同一个 lo
 */
export function normalizeLoadoutAmmo(lo, weapons = WEAPONS) {
  if (!lo || typeof lo !== 'object') return lo;
  const map = (lo.ammo && typeof lo.ammo === 'object') ? lo.ammo : null;
  const next = {};
  for (const id of AMMO_IDS) {
    if (map) next[id] = int(map[id]);
    else next[id] = loadoutAmmoBoxes(lo, id); // 旧档：从 ammo556Boxes / ammo9mmBoxes 迁移
  }
  lo.ammo = next;
  lo.ammoPrimary = resolveAmmoGrade(lo, 'primary', weapons);
  // W2：副武器空着时，副武器弹种跟着手枪走 —— 否则 `ammoSecondary` 会变成 null，
  // 战前「副武器弹种」那一栏就凭空消失，玩家会以为功能坏了。
  lo.ammoSecondary = resolveAmmoGrade(lo, lo.secondary ? 'secondary' : 'sidearm', weapons);
  return lo;
}

/** 设置某一型弹药的盒数（0~max），返回新值。 */
export function setAmmoBoxes(lo, id, value, max = 6) {
  if (!lo || !AMMO_IDS.includes(id)) return 0;
  if (!lo.ammo || typeof lo.ammo !== 'object') lo.ammo = {};
  const n = Math.max(0, Math.min(max, int(value)));
  lo.ammo[id] = n;
  return n;
}

/**
 * 换弹时该用哪一型弹：优先弹匣当前弹种，其次武器默认弹。
 * 战局内不自动切弹种 —— 想换弹种请在战前配置，避免"打着打着子弹类型变了"。
 */
export function ammoForReload(weaponState, weaponDef = null) {
  const preferred = weaponState && weaponState.ammoId;
  if (preferred && (!weaponDef || !weaponDef.caliber || ammoDef(preferred))) return preferred;
  return weaponDef ? weaponDef.ammoItem : null;
}

/** 弹种展示短码：`5.56 AP · PEN 5`。 */
export function ammoLabel(id, items = ITEMS) {
  const def = items[id] || ITEMS[id];
  if (!def) return '—';
  const caliber = CALIBERS[def.caliber];
  const short = caliber ? caliber.short : (def.caliber || '');
  return `${short} ${def.gradeName || ''} · PEN ${def.pen != null ? def.pen : '—'}`.trim();
}
