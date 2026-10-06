/**
 * 昼夜轮换系统（需求G 第⑥条）
 *
 * 规则：
 *   · 夜晚：客流大、收入高、霓虹全开、环境光暗
 *   · 白天：客流稀少、收入低、灯光变亮变冷、霓虹几乎不显
 *   · 两相之间**平滑插值**（不是瞬间跳变）—— 硬切会让画面像坏了
 *
 * 设计要点：
 *   1) 本模块只产出「当前光照状态」，不直接改 scene 对象。
 *      调用方（scene.mjs / main.mjs）拿状态去 apply。
 *      好处：这个模块可以纯函数式测试，不需要 WebGL。
 *   2) 状态是**纯数据**，全部数值来源 art.mjs 的 DAYNIGHT —— 改规范只改那一处。
 *   3) 与便利店开夜班的设定不冲突：NIGHT_WALL_SECONDS 是"一夜"的经营时长，
 *      本模块是"一天之内白天黑夜的视觉循环"，两者独立计时。
 */

import { DAYNIGHT } from './art.mjs';

/** 缓动：smoothstep，让切换在两端都柔和（避免匀速插值的机械感） */
function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 在两个 0xRRGGBB 之间插值，返回 0xRRGGBB 整数（给 THREE.Color） */
function lerpHex(a, b, t) {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const bl = Math.round(lerp(ab, bb, t));
  return (r << 16) | (g << 8) | bl;
}

/**
 * 创建昼夜轮换器。
 * @param opts.cycleSec  一个完整循环（夜→昼）的墙钟秒数，默认取 art.DAYNIGHT.cycleSec
 * @param opts.startPhase 'night' | 'day'，起始相位（默认夜 —— 游戏是"夜班"）
 * @param opts.paused    暂停（暂停时冻结当前状态，不推进）
 */
export function createDayNight(opts = {}) {
  const def = DAYNIGHT.phases;
  const cycleSec = opts.cycleSec ?? DAYNIGHT.cycleSec;
  /** 内部相位 t：0 = 完全夜晚，1 = 完全白天；在 0..2 之间循环（1→2 是白天回到夜晚） */
  let phase = opts.startPhase === 'day' ? 1 : 0;
  let paused = opts.paused === true;
  /** 累计经过的游戏内秒数（供 UI 显示 / 测试断言） */
  let elapsed = 0;

  /** 把 0..2 的相位映射为"夜晚占比 w"：w=1 全夜，w=0 全昼 */
  function nightWeight() {
    // phase ∈ [0,1]：夜 → 昼；phase ∈ [1,2]：昼 → 夜
    const p = phase % 2;
    return p <= 1 ? 1 - p : p - 1;
  }

  return {
    /** 推进时间；dt 为墙钟秒 */
    update(dt) {
      if (paused) return;
      if (!(dt > 0)) return;
      elapsed += dt;
      phase = (phase + dt / cycleSec * 2) % 2;
    },

    /** 当前是"白天"还是"夜晚"（按占比过半判定） */
    get isNight() { return nightWeight() >= 0.5; },

    /** 阶段标签与图标（给 HUD 用） */
    get label() {
      const w = nightWeight();
      if (w > 0.85) return def.night;
      if (w < 0.15) return def.day;
      // 过渡区间：用"黄昏/黎明"的语义，避免 UI 显示成"白天"却还是暗的
      return w >= 0.5 ? def.night : def.day;
    },

    /** 0..1，1 = 纯夜晚，0 = 纯白天 */
    get nightWeight() { return nightWeight(); },

    /** 原始相位（0..2），调试用 */
    get phase() { return phase; },

    /** 累计游戏秒 */
    get elapsed() { return elapsed; },

    /**
     * 取出当前插值后的光照状态（纯数据）。
     * scene.mjs 拿它去设置 ambient / hemi / 各 PointLight / fog / background。
     */
    state() {
      const w = nightWeight();
      const t = smoothstep(1 - w); // 0 = 夜, 1 = 昼，加缓动
      const n = def.night;
      const d = def.day;
      return {
        /** 光影 */
        ambientIntensity: lerp(n.ambientIntensity, d.ambientIntensity, t),
        hemiIntensity: lerp(n.hemiIntensity, d.hemiIntensity, t),
        neonIntensity: lerp(n.neonIntensity, d.neonIntensity, t),
        downlightIntensity: lerp(n.downlightIntensity, d.downlightIntensity, t),
        background: lerpHex(n.background, d.background, t),
        fogNear: lerp(n.fogNear, d.fogNear, t),
        fogFar: lerp(n.fogFar, d.fogFar, t),
        /** Bloom 强度：白天泛光减弱（否则大白天一片光晕很奇怪） */
        bloomStrength: lerp(1.0, 0.35, t),
        /** 玩法：客流权重与收入倍率 */
        traffic: lerp(n.traffic, d.traffic, t),
        income: lerp(n.income, d.income, t),
        /** 0..1 夜晚程度，UI 可以直接用 */
        nightAmount: w,
      };
    },

    /** 直接设定相位（调试 / 测试 / 跳时间用） */
    setPhase(sec) {
      phase = ((sec % (cycleSec * 2)) + cycleSec * 2) % (cycleSec * 2) / cycleSec;
    },

    /** 立即切到夜晚 / 白天（用于"跳到白天"这类调试操作） */
    jumpTo(which) {
      phase = which === 'day' ? 1 : 0;
    },

    /* ---------- 存档（需求：昼夜阶段必须可还原） ---------- */

    /** 导出可持久化状态：相位 + 累计秒 */
    serialize() {
      return { phase, elapsed };
    },

    /**
     * 从存档还原昼夜进度。
     * phase 是 0..2 的循环量，读档时必须取模归一化，
     * 否则一个越界的旧值会让 phase 一路漂移到很大、光照插值失真。
     */
    hydrate(data) {
      if (!data || typeof data !== 'object') return;
      if (Number.isFinite(data.phase)) {
        phase = ((data.phase % 2) + 2) % 2;
      }
      if (Number.isFinite(data.elapsed) && data.elapsed >= 0) elapsed = data.elapsed;
    },

    pause(v = true) { paused = v; },
    get paused() { return paused; },

    /** 循环周期（秒） */
    get cycleSec() { return cycleSec; },
  };
}
