/**
 * 玩家疲劳系统（新增，只加不改）
 *
 * 与既有系统完全独立：
 *   · 店员疲劳是 `state.clerk.fatigue`（§1.3，玩家视角抖动/移速惩罚已挂在它上面）
 *   · **玩家**疲劳是 `state.playerFatigue`（本模块），两者字段、阈值、恢复手段都不同，
 *     绝不共用 —— 否则"给店员提神"会顺带把玩家视角惩罚也消掉。
 *
 * 规则（需求原文）：
 *   · 疲劳随游戏时间累积，凌晨 3:00–5:00 加速
 *   · 三档表现：轻度（边缘变暗+打哈欠）/ 中度（灵敏度 −10%+准星飘）/ 重度（强制打瞌睡 5s）
 *   · 三种恢复：咖啡机喝一杯（清零大半）/ 提神喷雾（消耗品）/ 洗手台洗冷水脸（小幅）
 *   · 店员不困，玩家困 —— 决策：自己扛 vs 花钱提神
 *
 * 设计要点：
 *   1) 纯逻辑、零 DOM/THREE 依赖，可在 Node 里单测（与 themes/stars 同一条纪律）
 *   2) 只产出**派生数据**（level / effects），表现层拿去画，本模块不直接碰 scene/hud
 *   3) 疲劳度在 gameHour 维度上定义（0=22:00 开店，凌晨 3:00≈gameHour 5，5:00≈gameHour 7）
 *   4) serialize/hydrate 与存档编排层（save.mjs）对齐
 */
import { FATIGUE } from './config.mjs';
import { fatigueRateMul } from './boons.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createFatigue(opts = {}) {
  const state = opts.state;
  /** 打瞌睡剩余秒数（>0 表示正在强制瞌睡） */
  let dozing = 0;
  /** 打哈欠冷却：避免每次跨过阈值都弹一次字幕 */
  let yawnCooldown = 0;
  /** 当前档位（跨档时触发一次表现，档位内不重复） */
  let lastLevel = 0;

  /** 当前疲劳档：0 无 / 1 轻度 / 2 中度 / 3 重度 */
  function level() {
    const f = state.playerFatigue;
    if (f >= FATIGUE.heavyAt) return 3;
    if (f >= FATIGUE.mediumAt) return 2;
    if (f >= FATIGUE.lightAt) return 1;
    return 0;
  }

  /** 凌晨 3:00–5:00（gameHour 5..7）加速倍数 */
  function rateMulAt(gameHour) {
    const g = Number.isFinite(gameHour) ? gameHour : 0;
    return g >= FATIGUE.accelerateFrom && g <= FATIGUE.accelerateTo ? FATIGUE.accelerateMul : 1;
  }

  /**
   * 每帧推进（只在营业、未暂停时调用）。
   * @returns 本帧发生的表现事件数组（跨档 / 打哈欠），供 main 翻译成字幕/音效
   */
  function update(dt, gameHour) {
    const ev = [];
    if (!(dt > 0)) return ev;

    /* 打瞌睡期间：疲劳**不再累积**（人已经睡着了），只倒计时 */
    if (dozing > 0) {
      dozing = Math.max(0, dozing - dt);
      if (dozing === 0) ev.push({ type: 'wake' });
      return ev;
    }

    const before = level();
    // 永久增益「疲劳消耗 -10%」与扭蛋传说「疲劳 -2%」在这里乘进增长速度
    // （boons.fatigueRateMul 读 state.boons，纯函数、可单测；下限 0.5 防"疲劳永不上涨"）
    state.playerFatigue = clamp(
      state.playerFatigue + dt * FATIGUE.baseRate * rateMulAt(gameHour) * fatigueRateMul(state),
      0,
      FATIGUE.max,
    );
    const after = level();

    /* 跨档触发：轻/中/重各在"刚进入"时喊一声（打哈欠只在首次进入轻度时弹，之后进冷却） */
    if (after > before) {
      ev.push({ type: 'level', level: after });
      if (after >= 1 && yawnCooldown <= 0) {
        ev.push({ type: 'yawn' });
        yawnCooldown = FATIGUE.yawnCooldownSec;
      }
    }
    if (yawnCooldown > 0) yawnCooldown = Math.max(0, yawnCooldown - dt);
    lastLevel = after;
    return ev;
  }

  /** 是否正在打瞌睡（重度未处理时的强制状态） */
  function isDozing() {
    return dozing > 0;
  }

  /** 强制打瞌睡：由 main 在"重度且持续未处理"时触发 */
  function doze() {
    dozing = FATIGUE.dozeSec;
  }

  /** 打断瞌睡（例如被事件/咖啡打断） */
  function wake() {
    dozing = 0;
  }

  /* ---------- 三种恢复手段（各自扣对应的钱/消耗品，恢复量来自 config） ---------- */
  function drinkCoffee() {
    state.playerFatigue = clamp(state.playerFatigue - FATIGUE.coffeeRecover, 0, FATIGUE.max);
    wake();
  }
  function useSpray() {
    state.playerFatigue = clamp(state.playerFatigue - FATIGUE.sprayRecover, 0, FATIGUE.max);
    wake();
  }
  function washFace() {
    state.playerFatigue = clamp(state.playerFatigue - FATIGUE.washRecover, 0, FATIGUE.max);
    wake();
  }

  /** 供表现层读取的派生效果（轻度暗角 / 中度灵敏度倍率+准星飘幅 / 重度瞌睡） */
  function effects() {
    const f = state.playerFatigue;
    const lv = level();
    return {
      level: lv,
      fatigue: f,
      /** 屏幕边缘变暗强度（0..1），叠加在设置暗角之上 */
      vignette: lv >= 1 ? clamp((f - FATIGUE.lightAt) / (FATIGUE.max - FATIGUE.lightAt), 0, 1) * FATIGUE.vignetteMax : 0,
      /** 灵敏度独立倍率：中度 −10%（默认 1 = 不衰减） */
      sensMul: lv >= 2 ? 1 - FATIGUE.sensDrop : 1,
      /** 准星微飘幅度（0 = 不飘，中度起才有） */
      sway: lv >= 2 ? FATIGUE.swayAmp : 0,
      dozing: dozing > 0,
    };
  }

  /* ---------- 存档 ---------- */
  function serialize() {
    return { fatigue: state.playerFatigue, dozing, yawnCooldown, lastLevel };
  }
  function hydrate(data) {
    if (!data || typeof data !== 'object') return;
    if (Number.isFinite(data.fatigue)) state.playerFatigue = clamp(data.fatigue, 0, FATIGUE.max);
    if (Number.isFinite(data.dozing)) dozing = Math.max(0, data.dozing);
    if (Number.isFinite(data.yawnCooldown)) yawnCooldown = Math.max(0, data.yawnCooldown);
    if (Number.isFinite(data.lastLevel)) lastLevel = Math.max(0, data.lastLevel);
  }

  return {
    update,
    level,
    effects,
    isDozing,
    doze,
    wake,
    drinkCoffee,
    useSpray,
    washFace,
    rateMulAt,
    serialize,
    hydrate,
  };
}
