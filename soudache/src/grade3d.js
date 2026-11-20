/**
 * P3 场景观感：调色与光照分区的**纯函数层**（零 DOM / 零 THREE / 零联网）。
 *
 * 为什么单独成模块：暂停面板的调色滑条、存档迁移、灯具布点、区域混合都是
 * 容易被"顺手写进渲染循环"的逻辑。放到这里后 Node 可以直接单测，
 * 渲染层只负责把算好的数值灌进 uniform / light，不出现第二份真值。
 */

import {
  GRADE3D, LIGHT_ZONES, VIEW3D, WORLD_W, WORLD_H,
} from './config.js';

/** 默认调色：只从 config 读，避免这里再抄一遍数字 */
export function defaultGrade() {
  return {
    exposure: GRADE3D.exposure,
    contrast: GRADE3D.contrast,
    saturation: GRADE3D.saturation,
  };
}

/** 把任意输入钳到 GRADE3D.ranges 内；缺字段 / NaN / 字符串坏值都回落默认 */
export function clampGrade(input) {
  const base = defaultGrade();
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of ['exposure', 'contrast', 'saturation']) {
    const range = GRADE3D.ranges[key];
    const n = Number(src[key]);
    const v = Number.isFinite(n) ? Math.min(range.max, Math.max(range.min, n)) : base[key];
    out[key] = Math.round(v * 1000) / 1000;
  }
  return out;
}

/**
 * 旧存档兼容：save.settings.grade 缺字段、为 null、被手改成字符串时都不抛异常，
 * 逐项回落到默认。storage.js 的 settings 浅合并已保证对象存在，这里再兜一层。
 */
export function resolveGrade(save) {
  const raw = save && save.settings && save.settings.grade;
  const merged = { ...defaultGrade(), ...(raw && typeof raw === 'object' ? raw : {}) };
  // 迁移：ACES 上线前的曝光刻度是 1.10~2.20（那条链路根本没有色调映射，只能靠曝光硬提亮）。
  // 旧档里存着 1.7 很常见，直接钳到新上限 1.6 会让老玩家一进游戏就是过曝的白天。
  // 判定用"超出当前上限"而不是"等于旧默认值"：只有真的越界才说明刻度不同。
  const e = Number(merged.exposure);
  if (Number.isFinite(e) && e > GRADE3D.ranges.exposure.max) {
    merged.exposure = GRADE3D.exposure;
  }
  return clampGrade(merged);
}

/** '#RRGGBB' → [r,g,b]（0..1）。坏值 / 非字符串回落中性白，保证纯函数可测、不抛异常 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return [1, 1, 1];
  const m = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return [1, 1, 1];
  return [
    parseInt(m.slice(0, 2), 16) / 255,
    parseInt(m.slice(2, 4), 16) / 255,
    parseInt(m.slice(4, 6), 16) / 255,
  ];
}

/**
 * 后处理 split-tone 分级参数：阴影/高光双色 + 强度。
 * 真值全部来自 config.GRADE3D，渲染层只负责灌进 uniform，避免第二份调色真值。
 * @returns {{shadow:number[], highlight:number[], amount:number}}
 */
export function gradeTints() {
  const amount = Number(GRADE3D.splitTone);
  return {
    shadow: hexToRgb(GRADE3D.shadowTint),
    highlight: hexToRgb(GRADE3D.highlightTint),
    amount: Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0,
  };
}

/** 帧率无关的指数平滑（禁止 x += (t-x)*0.1 这类与帧率绑定的写法） */
export function smoothZoneMix(current, target, dt, rate = LIGHT_ZONES.interior.zoneLerp) {
  const t = Math.max(0, Math.min(1, Number(target) || 0));
  const c = Math.max(0, Math.min(1, Number(current) || 0));
  const k = 1 - Math.exp(-Math.max(0, Number(rate) || 0) * Math.max(0, Number(dt) || 0));
  return c + (t - c) * k;
}

/** 点是否落在空地：灯具与道具都不能压在墙 / 掩体箱里 */
export function isOpenPoint(map, x, y, pad = 14) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < pad || y < pad || x > WORLD_W - pad || y > WORLD_H - pad) return false;
  const rects = [
    ...((map && map.walls) || []),
    ...((map && map.crateRects) || []),
  ];
  for (const r of rects) {
    if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) return false;
  }
  return true;
}

/**
 * 确定性挑室内灯位：候选来自地图真实 POI（终端 / 撤离点 / 容器），
 * 用调用方给的随机源洗牌，彼此至少间隔 minGap 个单位，且必须落在空地。
 * rand 是 () => [0,1)，与战局 RNG 解耦 —— 纯函数可在 Node 里直接复现。
 *
 * @returns {Array<{x:number,y:number,source:string}>} 灯位（最多 cap 个）
 */
export function lampSites(map, rand = Math.random, cap = LIGHT_ZONES.interior.counts.high) {
  const limit = Math.max(0, Math.min(12, Math.floor(Number(cap) || 0)));
  if (!map || !limit) return [];
  const candidates = [];
  for (const t of map.terminals || []) candidates.push({ x: t.x, y: t.y, source: 'terminal' });
  for (const e of map.extracts || []) candidates.push({ x: e.x, y: e.y, source: 'extract' });
  for (const c of map.containers || []) candidates.push({ x: c.x, y: c.y, source: 'container' });
  // Fisher-Yates，只用传入的 rand，确保同 seed 每次结果一致。
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.max(0, Math.min(0.999999, rand())) * (i + 1));
    const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
  }
  const minGap = 260;
  const out = [];
  for (const p of candidates) {
    if (out.length >= limit) break;
    if (!isOpenPoint(map, p.x, p.y)) continue;
    if (out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < minGap)) continue;
    out.push({ x: Math.round(p.x), y: Math.round(p.y), source: p.source });
  }
  return out;
}

/**
 * 玩家当前位置的「室内灯区」混合系数 0~1。
 * 半径内取最近的灯位做平滑衰减，避免走过边界时灯光硬切。
 */
export function zoneMixAt(x, y, sites, radius = LIGHT_ZONES.interior.zoneRadius * VIEW3D.metersToUnits) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !sites || !sites.length) return 0;
  const R = Math.max(1, Number(radius) || 1);
  let best = 0;
  for (const s of sites) {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d >= R) continue;
    best = Math.max(best, 1 - d / R);
  }
  return Math.max(0, Math.min(1, best));
}
