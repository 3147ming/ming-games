/**
 * view3d.js — R13「3D 视图」（零依赖 Canvas 伪 3D，默认关闭）
 *
 * 为什么不用 Three.js：本项目铁律是「零 npm 依赖 / 零构建」，而 R8 的离线包
 * 是把 ESM 打成一个 IIFE（build/bundle.mjs），引入 Three.js 会直接破坏这两条。
 * 因此这里用「正交斜投影 + 面深度排序」自己算 3D：能体现元件高度、平台厚度与
 * 透视层级，且完全复用现有 model 数据（不新增字段、不改存档）。
 *
 * 边界：
 *   - 独立覆盖 canvas（#view3d-canvas），不改主画布的任何绘制路径，
 *     关闭时立即隐藏并停掉 rAF，既有 2.5D 探针的像素断言不受影响。
 *   - 只读 model / platforms，不写状态。
 *   - 尊重 prefers-reduced-motion：该设置下不自动旋转，只给静态视角。
 */

import { getPart, footprintOf } from './parts.js';
import { shouldPauseFrame } from './visibility.js';

/** 斜投影参数：yaw 绕竖直轴，pitch 俯角 */
export const CAMERA_DEFAULT = { yaw: Math.PI * 0.18, pitch: Math.PI * 0.30, scale: 14 };

/** 各元件在 3D 视图里的高度（网格单位）与配色 */
const TYPE_3D = {
  resistor: { h: 1.0, top: '#d9c9a6', side: '#a8977a' },
  capacitor: { h: 1.4, top: '#4a6b9c', side: '#33496b' },
  led: { h: 1.2, top: '#e2685f', side: '#a8423c' },
  diode: { h: 0.9, top: '#2f3540', side: '#1e232b' },
  npn: { h: 1.2, top: '#2f3540', side: '#1e232b' },
  opamp: { h: 1.4, top: '#23262e', side: '#15171c' },
  '74ls': { h: 1.6, top: '#23262e', side: '#15171c' },
  pot: { h: 1.6, top: '#3a5f8c', side: '#26415f' },
  switch: { h: 1.1, top: '#c0564d', side: '#8a3c35' },
  fgen: { h: 2.2, top: '#4a5262', side: '#2f3540' },
  vsource: { h: 2.0, top: '#4a5262', side: '#2f3540' },
  clock: { h: 1.8, top: '#3f6b5a', side: '#2a4a3e' },
  adc8: { h: 1.6, top: '#23262e', side: '#15171c' },
  dac8: { h: 1.6, top: '#23262e', side: '#15171c' },
  logic: { h: 1.2, top: '#c0564d', side: '#8a3c35' },
  default: { h: 1.0, top: '#7a8699', side: '#4f5866' },
};

function style3d(type) {
  const t = String(type || '').toLowerCase();
  if (TYPE_3D[t]) return TYPE_3D[t];
  if (/^74/.test(t)) return TYPE_3D['74ls'];
  if (/ic|chip|dip/.test(t)) return TYPE_3D['74ls'];
  return TYPE_3D.default;
}

/**
 * 正交斜投影：网格坐标 (x,y,z) → 屏幕坐标。
 * depth 用于面排序（越大越远）。
 */
export function project3d(x, y, z, cam = CAMERA_DEFAULT) {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const rx = x * cy - y * sy;
  const ry = x * sy + y * cy;
  return {
    x: rx * cam.scale,
    y: (ry * Math.sin(cam.pitch) - z * Math.cos(cam.pitch)) * cam.scale,
    depth: ry,
  };
}

/** 六面体：返回 3 个可见面（顶 / 右 / 前）的顶点数组，供填充 */
export function boxFaces(x, y, z, w, d, h, cam = CAMERA_DEFAULT) {
  const p = (px, py, pz) => project3d(px, py, pz, cam);
  const top = [p(x, y, z + h), p(x + w, y, z + h), p(x + w, y + d, z + h), p(x, y + d, z + h)];
  const front = [p(x, y + d, z + h), p(x + w, y + d, z + h), p(x + w, y + d, z), p(x, y + d, z)];
  const right = [p(x + w, y, z + h), p(x + w, y + d, z + h), p(x + w, y + d, z), p(x + w, y, z)];
  return { top, front, right };
}

function poly(ctx, points, fill) {
  if (!points || points.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function shade(color, k) {
  // 支持 #rgb / #rrggbb：#rrggbb 按比例压暗，非法值原样返回
  const m = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
  if (!m) return color;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 建视图控制器。
 * @param {{canvas:HTMLCanvasElement, getState:Function, getPlatformId:Function,
 *          getPlatform:Function, onFrame?:Function}} opts
 */
export function createView3d(opts) {
  const canvas = opts.canvas;
  const ctx = canvas.getContext('2d');
  const cam = { ...CAMERA_DEFAULT };
  let active = false;
  let raf = 0;
  let last = 0;
  let autoRotate = true;
  let frames = 0;

  try {
    autoRotate = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) { autoRotate = true; }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(240, canvas.clientWidth || 640);
    const h = Math.max(180, canvas.clientHeight || 420);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const c2 = canvas.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function draw() {
    if (!ctx || !active) return;
    const { w, h } = resize();
    const state = opts.getState ? opts.getState() : null;
    const platform = opts.getPlatform ? opts.getPlatform(opts.getPlatformId ? opts.getPlatformId() : '') : null;
    ctx.clearRect(0, 0, w, h);
    // 背景：深空蓝渐变，与主画布的浅色绘图纸区分
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#131722');
    bg.addColorStop(1, '#0b0e15');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    if (!state || !platform) {
      ctx.fillStyle = '#7f8798';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('3D 视图：等待电路数据', w / 2, h / 2);
      return;
    }

    // 自适应缩放与居中：先算平台四角的投影包围盒
    const cols = platform.cols || 30;
    const rows = platform.rows || 20;
    const corners = [
      project3d(0, 0, 0, cam), project3d(cols, 0, 0, cam),
      project3d(cols, rows, 0, cam), project3d(0, rows, 0, cam),
    ];
    const minX = Math.min(...corners.map((p) => p.x));
    const maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));
    const maxY = Math.max(...corners.map((p) => p.y));
    const fit = Math.min((w - 48) / (maxX - minX || 1), (h - 48) / (maxY - minY || 1));
    ctx.save();
    ctx.translate(w / 2 - ((minX + maxX) / 2) * fit, h / 2 - ((minY + maxY) / 2) * fit);
    ctx.scale(fit, fit);

    // 平台底板（厚度 0.6）
    const slab = boxFaces(0, 0, -0.6, cols, rows, 0.6, cam);
    poly(ctx, slab.front, '#1a2029');
    poly(ctx, slab.right, '#151a22');
    poly(ctx, slab.top, '#232b36');
    // 网格线：每 5 格一条，给深度参照
    ctx.strokeStyle = 'rgba(120, 160, 200, 0.10)';
    ctx.lineWidth = 0.6;
    for (let gx = 0; gx <= cols; gx += 5) {
      const a = project3d(gx, 0, 0, cam);
      const b = project3d(gx, rows, 0, cam);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let gy = 0; gy <= rows; gy += 5) {
      const a = project3d(0, gy, 0, cam);
      const b = project3d(cols, gy, 0, cam);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // 元件：按深度从远到近画，保证近处遮住远处
    const comps = (state.components || []).map((comp) => {
      const def = getPart(comp.type);
      const fp = def ? footprintOf(def, comp.rotation || 0) : { w: 1, h: 1 };
      const st = style3d(comp.type);
      const c = project3d(comp.x + fp.w / 2, comp.y + fp.h / 2, 0, cam);
      return { comp, fp, st, depth: c.depth };
    }).sort((a, b) => b.depth - a.depth);

    comps.forEach(({ comp, fp, st }) => {
      const faces = boxFaces(comp.x, comp.y, 0, fp.w, fp.h, st.h, cam);
      poly(ctx, faces.right, shade(st.side, 0.9));
      poly(ctx, faces.front, st.side);
      poly(ctx, faces.top, st.top);
      // 顶面标注型号：只在元件够大时画，避免糊成一团
      if (fp.w >= 2 && fp.h >= 2) {
        const p = project3d(comp.x + fp.w / 2, comp.y + fp.h / 2, st.h, cam);
        ctx.fillStyle = 'rgba(232, 233, 242, 0.82)';
        ctx.font = '3.4px "Bahnschrift", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(comp.type).slice(0, 8), p.x, p.y + 1.2);
      }
    });

    // 导线：投影成 2D 折线，压在元件之上
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = 'rgba(120, 200, 230, 0.85)';
    (state.wires || []).forEach((wire) => {
      const a = wire.a;
      const b = wire.b;
      if (!a || !b || a.x === undefined || b.x === undefined) return;
      const p1 = project3d(a.x + 0.5, a.y + 0.5, 1.2, cam);
      const p2 = project3d(b.x + 0.5, b.y + 0.5, 1.2, cam);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    });

    ctx.restore();
    frames += 1;
    if (typeof opts.onFrame === 'function') opts.onFrame({ frames, w, h });
  }

  function loop(now) {
    if (!active) return;
    // 后台标签页：跳过推进与绘制，仅保留 rAF 链由浏览器原生节流。
    // 回前台后把 last 归零，避免一次巨大的 dt 让镜头跳变。
    if (shouldPauseFrame(typeof document !== 'undefined' ? document : null)) {
      last = 0;
      raf = requestAnimationFrame(loop);
      return;
    }
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    if (autoRotate) cam.yaw += (dt / 1000) * 0.22;
    draw();
    raf = requestAnimationFrame(loop);
  }

  return {
    get active() { return active; },
    get frames() { return frames; },
    get camera() { return { ...cam }; },
    setCamera(patch = {}) {
      ['yaw', 'pitch', 'scale'].forEach((k) => {
        if (typeof patch[k] === 'number' && Number.isFinite(patch[k])) cam[k] = patch[k];
      });
      if (active) draw();
      return { ...cam };
    },
    /** 开关；开时启动 rAF，关时立刻停帧并清屏 */
    toggle(on) {
      const next = typeof on === 'boolean' ? on : !active;
      if (next === active) return active;
      active = next;
      canvas.hidden = !active;
      if (active) {
        last = 0;
        raf = requestAnimationFrame(loop);
      } else {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return active;
    },
    /** 单帧重绘（探针 / 参数变化时用，不启动循环） */
    renderOnce() {
      draw();
      return frames;
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      active = false;
    },
  };
}
