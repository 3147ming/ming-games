/**
 * P2 数值层：局外真实读数（纯函数、零 DOM）。
 *
 * 这里不新增任何存档字段、不引入「人机工效」这类当前引擎里并不生效的假属性：
 *   · 装备价值 / 保费 / 仓库估值 —— 全部由现有 config 与 save 推导；
 *   · 机动倍率 —— 直接复用 inventory.weightSpeedMultiplier，与局内真实移速同一口径；
 *   · 行动等级进度 —— 由真实声望经验 rep.xp 与 REP 等级表推导，旧存档缺字段自动回落 Lv.1。
 * 后续 P6/P10 若要接更复杂的人机工效、赛季任务，把真值接进这里即可，不要在 UI 里另算一份。
 */
import {
  WEAPONS, ARMORS, MELEE, BACKPACKS, RIGS, ITEMS, INSURANCE, REP, HUB,
} from './config.js';
import { totalValue, weightSpeedMultiplier } from './inventory.js';
import { loadoutAmmoValue } from './ammo.js';

/**
 * 带入装备的总价值：与 main.js deploy() 的保费计算口径逐字一致。
 *
 * W2：8 个槽位**全部**计入 —— 手枪 / 匕首 / 背包 / 胸挂和枪械护甲一样，
 * 部署时从仓库扣、撤离时带回、阵亡时丢失（见 deploy 与 endRaid 的两处 consume/gear），
 * 所以保费口径必须同步覆盖，否则会出现「掉了不赔、但也没算钱」的错位。
 */
export function gearValue(lo = {}) {
  let v = [lo.primary, lo.secondary, lo.sidearm]
    .filter((id) => id && WEAPONS[id])
    .reduce((s, id) => s + WEAPONS[id].value, 0);
  for (const [slot, table] of [['melee', MELEE], ['backpack', BACKPACKS], ['rig', RIGS]]) {
    const id = lo[slot];
    if (id && id !== 'none' && table[id]) v += table[id].value;
  }
  if (lo.armor && lo.armor !== 'none' && ARMORS[lo.armor]) v += ARMORS[lo.armor].value;
  if (lo.helmet && lo.helmet !== 'none' && ARMORS[lo.helmet]) v += ARMORS[lo.helmet].value;
  return v;
}

/** 携带物资估值：弹药 value 是「盒」口径，lo.*Boxes 也是盒数；医疗是「个」口径。 */
export function consumableValue(lo = {}) {
  let v = loadoutAmmoValue(lo);
  v += (lo.medkits || 0) * (ITEMS.medkit?.value || 0);
  v += (lo.bandages || 0) * (ITEMS.bandage?.value || 0);
  v += (lo.surgeries || 0) * (ITEMS.surgery?.value || 0);
  v += (lo.armorKits || 0) * (ITEMS.armorKit?.value || 0);
  return v;
}

export function kitValue(lo = {}) {
  return gearValue(lo) + consumableValue(lo);
}

export function insurancePremium(lo = {}) {
  return Math.round(gearValue(lo) * INSURANCE.rate);
}

/**
 * 行动等级进度。赛季标识是展示文案，进度本身是真实声望经验。
 * @param {object} save 存档（允许缺字段的旧存档）
 */
export function seasonProgress(save) {
  const tiers = (HUB.season && HUB.season.tiers) || REP.levels;
  const xp = Math.max(0, Number(save && save.rep && save.rep.xp) || 0);
  let idx = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (xp >= (tiers[i].need || 0)) idx = i;
  }
  const cur = tiers[idx] || tiers[0];
  const next = tiers[idx + 1] || null;
  const span = next ? Math.max(1, (next.need || 0) - (cur.need || 0)) : 1;
  const ratio = next ? Math.min(1, Math.max(0, (xp - (cur.need || 0)) / span)) : 1;
  return {
    level: cur.level || idx + 1,
    label: cur.label || '',
    xp,
    need: cur.need || 0,
    nextNeed: next ? next.need : null,
    ratio,
  };
}

/**
 * 顶栏与战前侧栏共用的读数。est 由 ui.estimateWeight 传入（同一份负重真值）。
 * @param {object} save 存档
 * @param {{total:number,limit:number,over:boolean}} [est] 负重估算
 */
export function gearReadout(save, est) {
  const lo = (save && save.loadout) || {};
  const stash = (save && save.stash) || { items: [] };
  return {
    gearValue: gearValue(lo),
    consumableValue: consumableValue(lo),
    kitValue: kitValue(lo),
    premium: insurancePremium(lo),
    stashValue: totalValue(stash),
    speedMul: weightSpeedMultiplier(est ? est.total : 0, est ? est.limit : 1),
    insured: Boolean(save && save.insurance && save.insurance.enabled && INSURANCE.enabled),
    season: seasonProgress(save),
  };
}
