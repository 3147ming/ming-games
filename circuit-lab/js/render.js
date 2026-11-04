/**
 * render.js — Canvas 2.5D 等距渲染
 *
 * 投影公式（与指令包约定一致）：
 *   sx = (gx - gy) * TILE_W / 2 + originX
 *   sy = (gx + gy) * TILE_H / 2 + originY
 * 反变换用于鼠标拾取，二者互为逆运算，保证"点哪选哪"。
 *
 * 性能策略：
 *   - 平台层（近千个孔位 + 底板 + 部件）只在平台/尺寸变化时重建，缓存到离屏 canvas；
 *   - 每帧只做 clearRect + drawImage(平台层) + 动态层（元件/导线/高亮），
 *     所以拖拽时不会把 900 多个孔位重画一遍。
 */

import { getPart, footprintOf, terminalPos, poly, lift, prism } from './parts.js';
import { resolveRef, refFallbackPos } from './model.js';
import { drawHepPlatform, HEP_SKIN_ID } from './hep-skin.js';

/** 基准菱形贴片尺寸（缩放前的像素） */
export const BASE_TILE_W = 34;
export const BASE_TILE_H = 17;

/** 各平台配色 */
const PLATFORM_THEME = {
  breadboard: {
    board: '#e9e4d4',
    boardEdge: '#c9c2ad',
    body: '#efeade',
    groove: '#cfc6ae',
    railPos: '#f3dedb',
    railNeg: '#dde4ee',
    railPosInk: '#c0564d',
    railNegInk: '#3f5f8c',
    hole: '#4a4d59',
    holeRim: '#f6f3ea',
    wire: '#2c6b82',
    wireGlow: 'rgba(44, 107, 130, 0.18)',
  },
  'exp-box': {
    board: '#242832',
    boardEdge: '#161a21',
    body: '#2c313c',
    groove: '#1c2029',
    railPos: '#3a2e2e',
    railNeg: '#2a3546',
    railPosInk: '#e0685f',
    railNegInk: '#6f9ad0',
    hole: '#10141b',
    holeRim: '#4a5262',
    wire: '#59c6e6',
    wireGlow: 'rgba(89, 198, 230, 0.16)',
  },
};

/** 取平台配色 */
export function themeOf(platformId) {
  return PLATFORM_THEME[platformId] || PLATFORM_THEME['exp-box'];
}

/* ==========================================================================
   视图与投影
   ========================================================================== */

/** 缩放档位：1× 为基准（fit 视图），向上放大 */
export const ZOOM_LEVELS = [1, 1.5, 2, 3];
const ZOOM_MIN = ZOOM_LEVELS[0];
const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

/**
 * 创建视图对象（持有 canvas 与投影参数）。
 * zoom/panX/panY 是「渲染层」状态：缩放与平移只改变投影，不触碰 model 数据，
 * 因此 serializeCircuit 前后（以及刷新后）必然一致。
 * fit* 字段保存「适配画布」的基准投影（zoom=1 时的值），applyZoomPan 在它之上
 * 折叠 zoom/pan，得到真正用于绘制与拾取的 tileW/originX/originY。
 */
export function createView(canvas) {
  return {
    canvas,
    ctx: canvas ? canvas.getContext('2d') : null,
    dpr: 1,
    width: 0,
    height: 0,
    // 折叠后的实时投影（绘制 / 拾取都用它）
    originX: 0,
    originY: 0,
    tileW: BASE_TILE_W,
    tileH: BASE_TILE_H,
    scale: 1,
    // 渲染层视图状态（纯视觉）
    zoom: ZOOM_MIN,
    panX: 0,
    panY: 0,
    // fit（zoom=1）基准投影，缩放/平移在其上叠加
    fitTileW: BASE_TILE_W,
    fitTileH: BASE_TILE_H,
    fitOriginX: 0,
    fitOriginY: 0,
    fitScale: 1,
    platformId: null,
    // 平台外观皮肤：'classic' 通用实验箱 / 'hep' HEP-DCTS-01 实物外观
    // 纯渲染层状态，不进 model、不进存档（由 board.js 从 localStorage 恢复）
    skin: 'classic',
    // HEP 实物外观的显示偏好与运行时状态（纯渲染层，不进 model / 存档）
    // silk: 机箱丝印显隐；teach/all: 教学模式 / 模块面板总开关；
    // hoverModule: 当前悬停模块 id；runtime: 状态灯数据；runtimeKey: 平台层缓存指纹
    hep: {
      silk: true,
      teach: false,
      all: false,
      hoverModule: null,
      runtime: null,
      runtimeKey: '',
    },
  };
}

/**
 * 按平台尺寸与画布尺寸计算「适配（fit）」基准投影，让整个平台刚好落在画布内，
 * 再把当前 zoom/pan 折叠进去得到实时投影。
 * 返回 true 表示 fit 基准（与缩放无关的几何）发生了变化，需要重建平台层缓存。
 *
 * 关键设计：平台层缓存恒以 zoom=1 的 fit 投影绘制（见 ensurePlatformLayer），
 * 缩放/平移只在 renderScene 贴回时用 drawImage 的矩阵实现——这样无论怎么放大，
 * 平台孔位都不会被裁剪，pickAt 也走同一套 project/unproject 自动对齐。
 */
export function layoutView(view, platform, cssWidth, cssHeight, options) {
  if (!view) return false;
  const opts = options || {};
  const pad = opts.pad === undefined ? 24 : opts.pad;
  const cols = platform ? platform.cols : 24;
  const rows = platform ? platform.rows : 14;

  const availW = Math.max(60, cssWidth - pad * 2);
  const availH = Math.max(60, cssHeight - pad * 2);

  const baseW = (cols + rows) * BASE_TILE_W / 2;
  const baseH = (cols + rows) * BASE_TILE_H / 2;
  const scale = Math.max(0.16, Math.min(availW / baseW, availH / baseH, 2.2));

  const fitTileW = BASE_TILE_W * scale;
  const fitTileH = BASE_TILE_H * scale;
  const boardW = (cols + rows) * fitTileW / 2;
  const boardH = (cols + rows) * fitTileH / 2;

  const fitOriginX = pad + Math.max(0, (availW - boardW) / 2) + rows * fitTileW / 2;
  const fitOriginY = pad + Math.max(0, (availH - boardH) / 2);

  const changed = Math.abs(view.fitTileW - fitTileW) > 0.01
    || Math.abs(view.fitOriginX - fitOriginX) > 0.01
    || Math.abs(view.fitOriginY - fitOriginY) > 0.01
    || view.width !== cssWidth
    || view.height !== cssHeight
    || view.platformId !== (platform ? platform.id : null);

  view.width = cssWidth;
  view.height = cssHeight;
  view.fitTileW = fitTileW;
  view.fitTileH = fitTileH;
  view.fitOriginX = fitOriginX;
  view.fitOriginY = fitOriginY;
  view.fitScale = scale;
  view.scale = scale;
  view.platformId = platform ? platform.id : null;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.dpr = dpr;
  const targetW = Math.max(1, Math.round(cssWidth * dpr));
  const targetH = Math.max(1, Math.round(cssHeight * dpr));
  if (view.canvas && (view.canvas.width !== targetW || view.canvas.height !== targetH)) {
    view.canvas.width = targetW;
    view.canvas.height = targetH;
  }

  applyZoomPan(view);
  return changed;
}

/**
 * 把 zoom/pan 折叠进实时投影 tileW/originX/originY。
 * 缩放以画布中心为锚点：pan=0 时，画布中心对应的那个网格点在缩放前后屏幕坐标不变；
 * pan 在其上叠加一个屏幕像素平移。project/unproject 只认这三者，故拾取与绘制天然统一。
 */
export function applyZoomPan(view) {
  const z = view.zoom;
  view.tileW = view.fitTileW * z;
  view.tileH = view.fitTileH * z;
  const cx = view.width / 2;
  const cy = view.height / 2;
  // 以中心为锚：O_z = fitOrigin + (z-1)*(fitOrigin - C)
  const anchorX = (z - 1) * (view.fitOriginX - cx);
  const anchorY = (z - 1) * (view.fitOriginY - cy);
  view.originX = view.fitOriginX + anchorX + view.panX;
  view.originY = view.fitOriginY + anchorY + view.panY;
  // LOD：缩放/平移后 160ms 内降档绘制（关引脚标签与接触阴影），松手再补全
  view.lodUntil = performance.now() + 160;
}

/** 当前是否处于降档绘制（拖拽中由 scene.lod 置位，缩放/平移由 lodUntil 兜底） */
function isLodActive(view, scene) {
  if (scene && scene.lod) return true;
  return (view.lodUntil || 0) > performance.now();
}

/** 设定绝对缩放值（夹在档位区间内） */
export function setZoom(view, z) {
  view.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  applyZoomPan(view);
}

/** 设定平移偏移（屏幕像素） */
export function setPan(view, x, y) {
  view.panX = x;
  view.panY = y;
  applyZoomPan(view);
}

/** 当前缩放倍数 */
export function getZoom(view) {
  return view.zoom;
}

/** 复位到 fit（zoom=1、无平移） */
export function resetView(view) {
  view.zoom = ZOOM_MIN;
  view.panX = 0;
  view.panY = 0;
  applyZoomPan(view);
}

/** 升一档（优先取大于当前的最近档，否则停在最大档） */
export function zoomIn(view) {
  const idx = ZOOM_LEVELS.findIndex((level) => level > view.zoom + 1e-6);
  setZoom(view, idx < 0 ? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] : ZOOM_LEVELS[idx]);
}

/** 降一档（优先取小于当前的最近档，否则停在最底档） */
export function zoomOut(view) {
  let idx = -1;
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_LEVELS[i] < view.zoom - 1e-6) { idx = i; break; }
  }
  setZoom(view, idx < 0 ? ZOOM_LEVELS[0] : ZOOM_LEVELS[idx]);
}

/**
 * 以某个网格坐标点为锚做聚焦缩放：设定 zoom 后，把 (gx,gy) 投影到画布中心。
 * 用于放大镜开启时的「点击聚焦」。
 */
export function focusOnGrid(view, gx, gy, zoom) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  view.zoom = z;
  applyZoomPan(view);
  const cx = view.width / 2;
  const cy = view.height / 2;
  const before = project(view, gx, gy);
  setPan(view, cx - before.x, cy - before.y);
}

/** 网格 → 屏幕 */
export function project(view, gx, gy) {
  return {
    x: view.originX + (gx - gy) * view.tileW / 2,
    y: view.originY + (gx + gy) * view.tileH / 2,
  };
}

/** 屏幕 → 网格（浮点） */
export function unproject(view, sx, sy) {
  const a = (sx - view.originX) / (view.tileW / 2); // gx - gy
  const b = (sy - view.originY) / (view.tileH / 2); // gx + gy
  return { gx: (a + b) / 2, gy: (b - a) / 2 };
}

/** 元件端子的屏幕坐标 */
export function terminalScreenPos(view, comp, terminalName) {
  const pos = terminalPos(comp, terminalName);
  if (!pos) return null;
  return project(view, pos.x, pos.y);
}

/** 元件占位四角的屏幕坐标 */
export function componentCorners(view, comp) {
  const def = getPart(comp.type);
  const footprint = footprintOf(def, comp.rotation);
  const x1 = comp.x + footprint.w;
  const y1 = comp.y + footprint.h;
  return [
    project(view, comp.x, comp.y),
    project(view, x1, comp.y),
    project(view, x1, y1),
    project(view, comp.x, y1),
  ];
}

/** 给 parts.js 的 draw() 用的坐标系包装（局部相对坐标，旋转由外层 canvas 变换完成） */
function componentFrame(view, comp) {
  const def = getPart(comp.type);
  const footprint = footprintOf(def, 0); // 始终按未旋转尺寸绘制，旋转交给 canvas 变换
  return {
    w: footprint.w,
    h: footprint.h,
    tileW: view.tileW,
    tileH: view.tileH,
    project: (dx, dy) => ({ x: dx * view.tileW, y: dy * view.tileH }),
  };
}

/**
 * 面包板元件旋转：绕整数网格矩形 [0..w-1]×[0..h-1] 的左上角旋转，
 * 与 parts.js 的 terminalPos 四向公式严格一致（已验证端子屏幕坐标重合）。
 * 仅当 rotation 非 0 生效；0° 时不做任何变换。
 */
function applyComponentRotation(ctx, rotation, w, h, cell) {
  if (rotation === 90) {
    ctx.translate((h - 1) * cell, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate((w - 1) * cell, (h - 1) * cell);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, (w - 1) * cell);
    ctx.rotate(-Math.PI / 2);
  }
}

/** 把"整个视图"包装成 prism 需要的 frame 接口 */
function platePrism(ctx, view, gx0, gy0, gx1, gy1, height, top, side1, side2, edge) {
  const frame = { project: (gx, gy) => project(view, gx, gy) };
  prism(ctx, frame, gx0, gy0, gx1, gy1, height, top, side1, side2, edge);
}

/* ==========================================================================
   平台层（离屏缓存）
   ========================================================================== */

const platformLayer = { key: '', canvas: null };

/**
 * 平台层缓存键：平台 / 视口尺寸 / dpr / fit 缩放任一变化才重建。
 * 注意用 fitTileW 而非折叠后的 tileW——平台层恒以 zoom=1 绘制，缩放由
 * renderScene 的 drawImage 矩阵负责，所以 zoom 改变不该触发平台层重建。
 */
function layerKey(view) {
  // skin 参与缓存键：实物外观 / 通用实验箱是两套平台层，切换时必须重建。
  // HEP 的丝印开关、悬停高亮与状态灯都画在平台层里，任一变化都要重建离屏画布。
  const h = view.hep || {};
  const hepKey = view.skin === HEP_SKIN_ID
    ? `${h.silk ? 1 : 0}${h.teach ? 1 : 0}${h.all ? 1 : 0}|${h.hoverModule || '-'}|${h.runtimeKey || ''}`
    : '-';
  return `${view.platformId}|${view.skin || 'classic'}|${hepKey}|${view.width}x${view.height}|${view.dpr}|${view.fitTileW.toFixed(2)}`;
}

/** 取（必要时重建）平台层。平台层固定以 fit（zoom=1）投影绘制。 */
export function ensurePlatformLayer(view, platform) {
  const key = layerKey(view);
  if (platformLayer.canvas && platformLayer.key === key) return platformLayer.canvas;

  const needW = Math.max(1, Math.round(view.width * view.dpr));
  const needH = Math.max(1, Math.round(view.height * view.dpr));
  const canvas = platformLayer.canvas || document.createElement('canvas');
  canvas.width = needW;
  canvas.height = needH;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  if (platform) {
    // 临时切到 fit 投影绘制平台内容；绘制完立即还原，不影响后续的动态层（用实时折叠投影）。
    const saved = {
      tileW: view.tileW,
      tileH: view.tileH,
      originX: view.originX,
      originY: view.originY,
    };
    view.tileW = view.fitTileW;
    view.tileH = view.fitTileH;
    view.originX = view.fitOriginX;
    view.originY = view.fitOriginY;
    drawPlatform(ctx, view, platform);
    view.tileW = saved.tileW;
    view.tileH = saved.tileH;
    view.originX = saved.originX;
    view.originY = saved.originY;
  }

  platformLayer.canvas = canvas;
  platformLayer.key = key;
  return canvas;
}

/** 作废平台层缓存（平台内容变化时调用） */
export function invalidatePlatformLayer() {
  platformLayer.key = '';
}

/** 画整个平台：底板 → 部件 → 孔位 */
function drawPlatform(ctx, view, platform) {
  // HEP-DCTS-01 实物外观：只替换「实验箱」的画法，几何 / 节点 / 拾取一律不变
  if (view.skin === HEP_SKIN_ID && platform.id === 'exp-box') {
    drawHepPlatform(ctx, view, platform, { project });
    return;
  }
  const theme = themeOf(platform.id);
  if (platform.id === 'breadboard') drawBreadboard(ctx, view, platform, theme);
  else drawExpBox(ctx, view, platform, theme);
}

/** 等距矩形填充：以网格矩形描述一块面 */
function isoRect(ctx, view, x, y, w, h, fill) {
  const a = project(view, x, y);
  const b = project(view, x + w, y);
  const c = project(view, x + w, y + h);
  const d = project(view, x, y + h);
  poly(ctx, [a, b, c, d]);
  ctx.fillStyle = fill;
  ctx.fill();
  return [a, b, c, d];
}

/** 平台整体投影（落影 + 底板 + 描边 + 顶面高光） */
function drawBoardBase(ctx, view, platform, theme, highlight) {
  const corners = [
    project(view, 0, 0),
    project(view, platform.cols, 0),
    project(view, platform.cols, platform.rows),
    project(view, 0, platform.rows),
  ];

  // 落影
  ctx.save();
  ctx.shadowColor = 'rgba(18, 20, 28, 0.42)';
  ctx.shadowBlur = Math.max(12, view.tileW * 0.8);
  ctx.shadowOffsetY = Math.max(6, view.tileW * 0.36);
  poly(ctx, corners);
  ctx.fillStyle = theme.board;
  ctx.fill();
  ctx.restore();

  // 底板
  poly(ctx, corners);
  ctx.fillStyle = theme.board;
  ctx.fill();
  ctx.strokeStyle = theme.boardEdge;
  ctx.lineWidth = Math.max(1, view.tileW * 0.05);
  ctx.stroke();

  if (highlight) {
    // 顶面高光：沿上边缘一道细亮线，暗示金属面板的厚度
    ctx.save();
    poly(ctx, corners);
    ctx.clip();
    const top = project(view, 0, 0);
    const right = project(view, platform.cols, 0);
    const light = ctx.createLinearGradient(top.x, top.y, right.x, right.y);
    light.addColorStop(0, 'rgba(255,255,255,0.16)');
    light.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();
  }
}

/** 面包板 */
function drawBreadboard(ctx, view, platform, theme) {
  drawBoardBase(ctx, view, platform, theme, false);

  // 电源轨底色：上 +/−、下 −/+
  isoRect(ctx, view, 0, 0, platform.cols, 1, theme.railPos);
  isoRect(ctx, view, 0, 1, platform.cols, 1, theme.railNeg);
  isoRect(ctx, view, 0, 13, platform.cols, 1, theme.railNeg);
  isoRect(ctx, view, 0, 14, platform.cols, 1, theme.railPos);

  // 中央沟槽
  isoRect(ctx, view, 0, 7, platform.cols, 1, theme.groove);
  const grooveFrom = project(view, 0, 7.5);
  const grooveTo = project(view, platform.cols, 7.5);
  ctx.beginPath();
  ctx.moveTo(grooveFrom.x, grooveFrom.y);
  ctx.lineTo(grooveTo.x, grooveTo.y);
  ctx.strokeStyle = 'rgba(120, 112, 92, 0.5)';
  ctx.lineWidth = Math.max(1, view.tileH * 0.28);
  ctx.stroke();

  // 电源轨正负丝印
  if (view.tileW > 15) {
    const size = Math.max(8, Math.min(13, view.tileW * 0.34));
    ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const stamp = (gy, text, color, gx) => {
      const p = project(view, gx, gy + 0.5);
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y);
    };
    for (let x = 6; x < platform.cols; x += 14) {
      stamp(0, '+', theme.railPosInk, x);
      stamp(1, '−', theme.railNegInk, x);
      stamp(13, '−', theme.railNegInk, x);
      stamp(14, '+', theme.railPosInk, x);
    }
  }

  // 孔位
  const r = Math.max(1.4, Math.min(3.4, view.tileW * 0.1));
  platform.nodes.forEach((node) => {
    const p = project(view, node.x, node.y);
    const isRail = node.kind === 'rail';
    ctx.beginPath();
    ctx.arc(p.x, p.y, isRail ? r * 0.82 : r, 0, Math.PI * 2);
    ctx.fillStyle = theme.hole;
    ctx.fill();
    if (!isRail) {
      ctx.beginPath();
      ctx.arc(p.x - r * 0.25, p.y - r * 0.25, r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
    }
  });
}

/** 实验箱：面板 + 各部件底座 + 孔位 + 标签 */
function drawExpBox(ctx, view, platform, theme) {
  drawBoardBase(ctx, view, platform, theme, true);

  platform.boxParts.forEach((part) => {
    if (part.kind === 'holes') {
      const rect = plateRect(part);
      platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
        Math.max(2, view.tileH * 0.16), '#3b4352', '#272d38', '#22272f', 'rgba(150, 170, 200, 0.14)');

      // 每 5 列一组的分组带，提示"这一列天然连通"
      for (let col = 0; col < part.cols; col += 5) {
        isoRect(ctx, view, part.x + col - 0.35, part.y - 0.2, 0.12, part.rows + 0.4,
          'rgba(120, 200, 220, 0.16)');
      }
    } else if (part.kind === 'dip') {
      drawDipSocket(ctx, view, part);
    } else if (part.kind === 'dipswitch') {
      drawDipSwitch(ctx, view, part);
    } else if (part.kind === 'ledbank') {
      drawLedBank(ctx, view, part);
    } else if (part.kind === 'segment') {
      drawSegment(ctx, view, part);
    } else if (part.kind === 'power') {
      drawPowerSwitch(ctx, view, part);
    } else if (part.kind === 'buzzer') {
      drawBuzzer(ctx, view, part);
    }
  });

  // 孔位
  const r = Math.max(1.6, Math.min(3.6, view.tileW * 0.11));
  platform.nodes.forEach((node) => {
    const p = project(view, node.x, node.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.75, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.kind === 'pin' ? '#0d1117' : theme.hole;
    ctx.fill();
  });

  // 部件标签：加胶囊底衬，避免小字压在深色面板或孔位上糊成一片
  const size = Math.max(9, Math.min(12, view.tileW * 0.31));
  ctx.font = `${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  platform.boxParts.forEach((part) => {
    if (!part.label) return;
    const rect = plateRect(part);
    const p = project(view, rect.x + rect.w / 2 - 0.5, rect.y - 0.62);
    const textWidth = ctx.measureText(part.label).width;
    const pillW = textWidth + 12;
    const pillH = size + 6;

    ctx.beginPath();
    roundRectPath(ctx, p.x - pillW / 2, p.y - pillH / 2, pillW, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(14, 18, 26, 0.66)';
    ctx.fill();

    ctx.fillStyle = 'rgba(228, 234, 246, 0.9)';
    ctx.fillText(part.label, p.x, p.y);
  });
}

/** 圆角矩形路径（不依赖 ctx.roundRect，兼容旧内核） */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/** 部件底座矩形（网格坐标） */
function plateRect(part) {
  switch (part.kind) {
    case 'holes':
      return { x: part.x - 0.35, y: part.y - 0.35, w: part.cols + 0.7, h: part.rows + 0.7 };
    case 'dip':
      return { x: part.x - 0.6, y: part.y - 0.6, w: part.pins / 2 + 1.2, h: 3.2 };
    case 'dipswitch':
      return { x: part.x - 0.4, y: part.y - 0.4, w: part.bits + 0.8, h: 3.8 };
    case 'ledbank':
      return { x: part.x - 0.4, y: part.y - 0.4, w: part.count + 0.8, h: 3.8 };
    case 'segment':
      return { x: part.x - 0.5, y: part.y - 0.5, w: 4.6, h: 6 };
    case 'power':
      return { x: part.x - 1, y: part.y - 1, w: 5, h: 2.6 };
    case 'buzzer':
      return { x: part.x - 1, y: part.y - 1, w: 5, h: 2.6 };
    default:
      return { x: part.x, y: part.y, w: part.w || 1, h: part.h || 1 };
  }
}

/** DIP 插座：黑色本体 + 1 脚缺口 + 引脚数标注 */
function drawDipSocket(ctx, view, part) {
  const rect = plateRect(part);
  platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    Math.max(2, view.tileH * 0.16), '#343b48', '#232833', '#1e222a', 'rgba(150, 170, 200, 0.12)');

  const half = part.pins / 2;
  platePrism(ctx, view, part.x - 0.5, part.y + 0.35, part.x + half - 0.5, part.y + 1.65,
    Math.max(4, view.tileH * 0.5), '#15181e', '#0f1216', '#0c0f13', 'rgba(0,0,0,0.5)');

  // 1 脚缺口
  const notch = lift(project(view, part.x - 0.5, part.y + 1), Math.max(4, view.tileH * 0.5));
  ctx.beginPath();
  ctx.arc(notch.x, notch.y, Math.max(2, view.tileW * 0.09), 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();

  if (view.tileW > 16) {
    const size = Math.max(6, Math.min(9, view.tileW * 0.2));
    ctx.font = `${size}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(150, 160, 180, 0.75)';
    const mid = project(view, part.x + half / 2 - 0.5, part.y + 1);
    ctx.fillText(`${part.pins}P`, mid.x, mid.y);
    ctx.fillStyle = 'rgba(242, 169, 59, 0.75)';
    const first = project(view, part.x, part.y);
    ctx.fillText('1', first.x - 7, first.y - 7);
  }
}

/** 8 位拨码开关 */
function drawDipSwitch(ctx, view, part) {
  const rect = plateRect(part);
  platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    Math.max(2, view.tileH * 0.16), '#343b48', '#232833', '#1e222a', 'rgba(150, 170, 200, 0.12)');

  for (let bit = 0; bit < part.bits; bit += 1) {
    const x = part.x + bit;
    platePrism(ctx, view, x - 0.26, part.y + 0.4, x + 0.26, part.y + 1.6,
      Math.max(3, view.tileH * 0.42), '#d8d3c6', '#a49d8c', '#8d8677', 'rgba(0,0,0,0.4)');
    const lever = lift(project(view, x, part.y + 1.15), Math.max(3, view.tileH * 0.42) + 3);
    ctx.beginPath();
    ctx.arc(lever.x, lever.y, Math.max(1.6, view.tileW * 0.075), 0, Math.PI * 2);
    ctx.fillStyle = '#c0453c';
    ctx.fill();
  }
}

/** 8 路指示灯 */
function drawLedBank(ctx, view, part) {
  const rect = plateRect(part);
  platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    Math.max(2, view.tileH * 0.16), '#343b48', '#232833', '#1e222a', 'rgba(150, 170, 200, 0.12)');

  for (let i = 0; i < part.count; i += 1) {
    const center = lift(project(view, part.x + i, part.y + 1), Math.max(3, view.tileH * 0.3));
    const radius = Math.max(3, view.tileW * 0.17);
    const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius * 2.2);
    glow.addColorStop(0, 'rgba(226, 104, 95, 0.42)');
    glow.addColorStop(1, 'rgba(226, 104, 95, 0)');
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#5b2b2b';
    ctx.fill();
    ctx.strokeStyle = 'rgba(226, 104, 95, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** 数码管：外框 + 七段 */
function drawSegment(ctx, view, part) {
  const rect = plateRect(part);
  platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    Math.max(2, view.tileH * 0.16), '#343b48', '#232833', '#1e222a', 'rgba(150, 170, 200, 0.12)');

  // 显示屏窗口
  platePrism(ctx, view, part.x - 0.35, part.y - 0.35, part.x + 2.35, part.y + 4.35,
    Math.max(3, view.tileH * 0.3), '#111721', '#0b0f15', '#090c11', 'rgba(0,0,0,0.5)');

  const segments = [
    [0.6, 0, 1.4, 0],
    [2, 0.6, 2, 1.4],
    [2, 2.6, 2, 3.4],
    [0.6, 4, 1.4, 4],
    [0, 2.6, 0, 3.4],
    [0, 0.6, 0, 1.4],
    [0.6, 2, 1.4, 2],
  ];
  const rise = Math.max(3, view.tileH * 0.3);
  segments.forEach(([x0, y0, x1, y1]) => {
    const a = lift(project(view, part.x + x0, part.y + y0), rise);
    const b = lift(project(view, part.x + x1, part.y + y1), rise);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(226, 104, 95, 0.32)';
    ctx.lineWidth = Math.max(2, view.tileW * 0.11);
    ctx.lineCap = 'round';
    ctx.stroke();
  });
}

/** 电源开关 */
function drawPowerSwitch(ctx, view, part) {
  const rect = plateRect(part);
  platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    Math.max(2, view.tileH * 0.16), '#343b48', '#232833', '#1e222a', 'rgba(150, 170, 200, 0.12)');

  const rise = Math.max(4, view.tileH * 0.55);
  platePrism(ctx, view, part.x - 0.4, part.y - 0.5, part.x + 2.4, part.y + 0.5,
    rise, '#3c4351', '#282e38', '#232830', 'rgba(0,0,0,0.5)');

  const knob = lift(project(view, part.x + 1, part.y), rise + 3);
  ctx.beginPath();
  ctx.arc(knob.x, knob.y, Math.max(3, view.tileW * 0.14), 0, Math.PI * 2);
  ctx.fillStyle = '#c0453c';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 蜂鸣器 */
function drawBuzzer(ctx, view, part) {
  const rect = plateRect(part);
  platePrism(ctx, view, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
    Math.max(2, view.tileH * 0.16), '#343b48', '#232833', '#1e222a', 'rgba(150, 170, 200, 0.12)');

  const center = lift(project(view, part.x + 1, part.y), Math.max(3, view.tileH * 0.45));
  const radius = Math.max(5, view.tileW * 0.3);
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#15181e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(190, 198, 214, 0.45)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(190, 198, 214, 0.4)';
  ctx.fill();
}

/* ==========================================================================
   场景绘制（每帧）
   ========================================================================== */

/** 导线折线：端点 → 抬起 → 横走 → 落下 */
function wirePath(view, a, b) {
  const accent = Math.max(6, Math.min(18, view.tileH * 0.62));
  return [
    a,
    { x: a.x, y: a.y - accent },
    { x: b.x, y: b.y - accent },
    b,
  ];
}

/** 解算导线两端屏幕坐标（端点失效时用缓存坐标兜底） */
export function wireScreenEnds(view, wire) {
  const resolvedA = resolveRef(wire.a);
  const resolvedB = resolveRef(wire.b);
  const posA = resolvedA ? resolvedA.pos : refFallbackPos(wire.a);
  const posB = resolvedB ? resolvedB.pos : refFallbackPos(wire.b);
  if (!posA || !posB) return null;
  return {
    a: project(view, posA.x, posA.y),
    b: project(view, posB.x, posB.y),
    valid: Boolean(resolvedA && resolvedB),
    endAValid: Boolean(resolvedA),
    endBValid: Boolean(resolvedB),
  };
}

function strokePath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

/**
 * 主绘制入口。
 * @param {object} view 视图
 * @param {object} scene 场景 { platform, circuit, selection, hover, hoverGroup, wiring, pointer, ghost, dangling }
 */
export function renderScene(view, scene) {
  const ctx = view.ctx;
  if (!ctx) return;

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  const platform = scene.platform;
  if (platform) {
    const layer = ensurePlatformLayer(view, platform);
    // 平台层以 zoom=1 绘制；这里按当前 zoom 缩放、按 pan 平移贴回视口中心。
    // dest 用 CSS 像素（ctx 已带 dpr 变换），source 用平台层自身的设备像素。
    const destX = view.width / 2 - view.width * view.zoom / 2 + view.panX;
    const destY = view.height / 2 - view.height * view.zoom / 2 + view.panY;
    ctx.drawImage(
      layer,
      0, 0, layer.width, layer.height,
      destX, destY, view.width * view.zoom, view.height * view.zoom,
    );
  }

  const theme = themeOf(platform ? platform.id : 'exp-box');

  drawHoverGroup(ctx, view, scene);
  drawWires(ctx, view, scene, theme);
  drawComponents(ctx, view, scene, theme);
  drawGhost(ctx, view, scene, theme);
  drawSelection(ctx, view, scene);
  drawPendingWire(ctx, view, scene);
  drawWireHoverEnds(ctx, view, scene);
  drawConnectableHints(ctx, view, scene);
  drawFlashWires(ctx, view, scene);
  drawMagnifier(ctx, view, scene);
}

/** 删除预告：把即将被删的导线以醒目色闪一下（约 150ms，由 scene.pendingFlash 控制） */
function drawFlashWires(ctx, view, scene) {
  const flash = scene.pendingFlash;
  if (!flash || !flash.wires || flash.wires.length === 0) return;
  if (performance.now() > flash.until) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  flash.wires.forEach((wire) => {
    const ends = wireScreenEnds(view, wire);
    if (!ends) return;
    const points = wirePath(view, ends.a, ends.b);
    strokePath(ctx, points);
    ctx.strokeStyle = 'rgba(242, 169, 59, 0.95)';
    ctx.lineWidth = Math.max(3, view.tileW * 0.16);
    ctx.stroke();
  });
  ctx.restore();
}

/** 悬停孔位 → 高亮整组（让"哪些孔天然连通"一眼可见） */
function drawHoverGroup(ctx, view, scene) {
  if (!scene.hoverGroup || scene.hoverGroup.length === 0) return;
  const radius = Math.max(4, view.tileW * 0.24);
  scene.hoverGroup.forEach((nodeId) => {
    const node = scene.platform ? scene.platform.nodeMap.get(nodeId) : null;
    if (!node) return;
    const p = project(view, node.x, node.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(94, 196, 216, 0.22)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(94, 196, 216, 0.75)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  });
}

/* ==========================================================================
   电平语义色（与主题色分开：绿=高、蓝灰=低、琥珀=未知、半透明灰=未驱动）
   ========================================================================== */

const LEVEL_STYLE = {
  1: { color: '#5fd39a', dash: false },
  0: { color: '#6f83a8', dash: false },
  X: { color: '#f2a93b', dash: true },
  F: { color: 'rgba(120, 140, 168, 0.5)', dash: false },
};

/** 折线路径上按比例取点（流动点用） */
function pointAlongPath(points, t) {
  if (!points || points.length < 2) return null;
  const clamped = Math.max(0, Math.min(1, t));
  let total = 0;
  const segs = [];
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segs.push(len);
    total += len;
  }
  if (total <= 0) return points[0];
  let target = clamped * total;
  for (let i = 0; i < segs.length; i += 1) {
    if (target <= segs[i] || i === segs.length - 1) {
      const k = segs[i] > 0 ? target / segs[i] : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * k,
        y: points[i].y + (points[i + 1].y - points[i].y) * k,
      };
    }
    target -= segs[i];
  }
  return points[points.length - 1];
}

/** 导线 */
function drawWires(ctx, view, scene, theme) {
  const dangling = scene.dangling || new Set();
  // 电平着色：仿真结果按 net 上色；悬停某条导线时其余 net 压暗到 30%
  const lv = scene.levelView;
  const lvOn = Boolean(lv && lv.on && lv.byWire instanceof Map);
  const hoverWireId = scene.hover && scene.hover.type === 'wire' ? scene.hover.wireId : null;
  const hoverNet = lvOn && hoverWireId && lv.byWire.has(hoverWireId)
    ? lv.byWire.get(hoverWireId).net : null;
  // 流动点只在暂态运行中开（scene.flow.on），尊重 prefers-reduced-motion
  const flow = scene.flow && scene.flow.on ? scene.flow : null;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  scene.circuit.wires.forEach((wire) => {
    const ends = wireScreenEnds(view, wire);
    if (!ends) return;
    const points = wirePath(view, ends.a, ends.b);

    const isDangling = dangling.has(wire.id) || !ends.valid;
    const isSelected = scene.selection && scene.selection.type === 'wire' && scene.selection.id === wire.id;
    const isHover = scene.hover && scene.hover.type === 'wire' && scene.hover.wireId === wire.id;
    const info = lvOn ? lv.byWire.get(wire.id) : null;
    const dimmed = Boolean(hoverNet && info && info.net !== hoverNet);

    // 不 save/restore：逐帧每条导线都 save 一次是纯开销，直接管好 alpha 即可
    ctx.globalAlpha = dimmed ? 0.3 : 1;

    // 落地光晕，让导线看起来"浮在板子上"
    strokePath(ctx, points);
    ctx.strokeStyle = isDangling ? 'rgba(226, 104, 95, 0.18)' : theme.wireGlow;
    ctx.lineWidth = Math.max(5, view.tileW * 0.26);
    ctx.stroke();

    strokePath(ctx, points);
    ctx.lineWidth = isSelected ? Math.max(2.6, view.tileW * 0.12) : Math.max(1.8, view.tileW * 0.085);
    if (isDangling) {
      ctx.strokeStyle = '#e2685f';
      ctx.setLineDash([5, 4]);
    } else if (isSelected) {
      ctx.strokeStyle = '#f2a93b';
      ctx.setLineDash([]);
    } else if (isHover) {
      ctx.strokeStyle = '#8fd8ea';
      ctx.setLineDash([]);
    } else if (info) {
      // 电平着色优先于主题色：整块板子因此变成一张"真值表热力图"
      const style = LEVEL_STYLE[info.level] || LEVEL_STYLE.F;
      ctx.strokeStyle = style.color;
      ctx.setLineDash(style.dash ? [5, 4] : []);
    } else {
      ctx.strokeStyle = theme.wire;
      ctx.setLineDash([]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 端点焊点：只在端点有效时画，悬空端留下"断头"视觉
    const endpoints = [
      { point: ends.a, valid: ends.endAValid },
      { point: ends.b, valid: ends.endBValid },
    ];
    endpoints.forEach(({ point, valid }) => {
      if (!valid) return;
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(2, view.tileW * 0.1), 0, Math.PI * 2);
      ctx.fillStyle = isDangling
        ? '#e2685f'
        : (isSelected ? '#f2a93b' : (info ? (LEVEL_STYLE[info.level] || LEVEL_STYLE.F).color : theme.wire));
      ctx.fill();
    });

    // 数字信号流动点：被驱动的 net 上跑 2 个亮点，方向 起点→终点
    if (flow && info && (info.level === 1 || info.level === 0)) {
      drawFlowDots(ctx, view, points, LEVEL_STYLE[info.level].color, flow.phase, info.level);
    }
    ctx.globalAlpha = 1;
  });
}

/** 流动点：沿导线路径匀速跑 2 个亮点（相位由 board 的 rAF 推进） */
function drawFlowDots(ctx, view, points, color, phase, level) {
  const radius = Math.max(1.8, view.tileW * 0.1);
  for (let i = 0; i < 2; i += 1) {
    const t = ((phase || 0) + i * 0.5) % 1;
    const p = pointAlongPath(points, t);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * 2.1, 0, Math.PI * 2);
    ctx.fillStyle = level === 1 ? 'rgba(95, 211, 154, 0.22)' : 'rgba(111, 131, 168, 0.22)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** 元件 */
function drawComponents(ctx, view, scene, theme) {
  // LOD 三档：静止全画 / 拖拽中画骨架 / 缩放中关引脚标签与接触阴影
  const lod = isLodActive(view, scene);
  const pinLabels = view.tileW > 14 && !lod;
  scene.circuit.components.forEach((comp) => {
    const def = getPart(comp.type);
    if (!def) return;

    const isSelected = Boolean(
      scene.selection && scene.selection.type === 'component' && scene.selection.id === comp.id,
    );

    // 选中元件的底光，先画在元件下面
    if (isSelected) {
      poly(ctx, componentCorners(view, comp));
      ctx.fillStyle = 'rgba(242, 169, 59, 0.16)';
      ctx.fill();
    }

    ctx.save();
    const origin = project(view, comp.x, comp.y);
    ctx.translate(origin.x, origin.y);
    applyComponentRotation(ctx, comp.rotation, def.size.w, def.size.h, view.tileW);
    const frame = componentFrame(view, comp);
    // flat = 降档：各元件 draw 里的 drawContactShadow 会直接跳过
    frame.flat = lod;
    def.draw(ctx, comp, {
      frame,
      theme,
      scale: view.scale,
      pinLabels,
      selected: isSelected,
      hover: Boolean(scene.hover && scene.hover.type === 'component' && scene.hover.componentId === comp.id),
    });
    ctx.restore();

    // 端子小圆点：画在元件之上，方便点选
    comp.terminals.forEach((terminal) => {
      const p = terminalScreenPos(view, comp, terminal.name);
      if (!p) return;
      const isPending = Boolean(
        scene.wiring
        && scene.wiring.from
        && scene.wiring.from.componentId === comp.id
        && scene.wiring.from.terminal === terminal.name,
      );
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, view.tileW * 0.11), 0, Math.PI * 2);
      ctx.fillStyle = isPending ? '#f2a93b' : 'rgba(246, 248, 252, 0.92)';
      ctx.fill();
      ctx.strokeStyle = isPending ? '#f2a93b' : 'rgba(60, 66, 82, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (isPending) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(5, view.tileW * 0.22), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(242, 169, 59, 0.7)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    });
  });
}

/** 放置预览（ghost） */
function drawGhost(ctx, view, scene, theme) {
  if (!scene.ghost) return;
  const { type, x, y, valid } = scene.ghost;
  const def = getPart(type);
  if (!def) return;

  const footprint = footprintOf(def, 0);
  const corners = [
    project(view, x, y),
    project(view, x + footprint.w, y),
    project(view, x + footprint.w, y + footprint.h),
    project(view, x, y + footprint.h),
  ];

  poly(ctx, corners);
  ctx.fillStyle = valid ? 'rgba(95, 211, 154, 0.2)' : 'rgba(226, 104, 95, 0.22)';
  ctx.fill();
  ctx.strokeStyle = valid ? 'rgba(95, 211, 154, 0.9)' : 'rgba(226, 104, 95, 0.9)';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  const fakeComp = { type, x, y, rotation: 0, params: { ...def.defaultParams } };
  ctx.save();
  ctx.globalAlpha = 0.72;
  const ghostOrigin = project(view, x, y);
  ctx.translate(ghostOrigin.x, ghostOrigin.y);
  applyComponentRotation(ctx, fakeComp.rotation, def.size.w, def.size.h, view.tileW);
  def.draw(ctx, fakeComp, {
    frame: componentFrame(view, fakeComp),
    theme,
    scale: view.scale,
    pinLabels: false,
    selected: false,
    hover: false,
  });
  ctx.restore();
}

/** 选中框 */
function drawSelection(ctx, view, scene) {
  if (!scene.selection || scene.selection.type !== 'component') return;
  const comp = scene.circuit.components.find((item) => item.id === scene.selection.id);
  if (!comp) return;
  poly(ctx, componentCorners(view, comp));
  ctx.strokeStyle = '#f2a93b';
  ctx.lineWidth = 1.8;
  ctx.setLineDash([5, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** 连线中的橡皮筋 */
function drawPendingWire(ctx, view, scene) {
  if (!scene.wiring || !scene.wiring.from) return;
  const resolved = resolveRef(scene.wiring.from);
  if (!resolved) return;
  const from = project(view, resolved.pos.x, resolved.pos.y);
  const to = scene.pointer || from;

  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = Math.max(1.6, view.tileW * 0.08);
  ctx.strokeStyle = 'rgba(242, 169, 59, 0.85)';
  strokePath(ctx, wirePath(view, from, to));
  ctx.restore();
}

/* ==========================================================================
   端子标签 / 导线悬停端点 / 可连提示 / 放大镜
   ========================================================================== */

/** 在 (x,y) 上方画一个端子名小标签（胶囊底衬） */
function drawTerminalLabel(ctx, x, y, text, color) {
  const size = 10;
  ctx.font = `${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  const padX = 5;
  const pillW = w + padX * 2;
  const pillH = size + 4;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x - pillW / 2, y - pillH / 2, pillW, pillH, pillH / 2);
  } else {
    roundRectPath(ctx, x - pillW / 2, y - pillH / 2, pillW, pillH, pillH / 2);
  }
  ctx.fillStyle = 'rgba(18, 20, 26, 0.86)';
  ctx.fill();
  ctx.fillStyle = color || '#f2a93b';
  ctx.fillText(text, x, y);
}

/** 悬停导线：高亮导线 + 两端端子端点标记与端子名（应用 zoom/pan 变换） */
function drawWireHoverEnds(ctx, view, scene) {
  if (!scene.hover || scene.hover.type !== 'wire') return;
  const wire = scene.circuit.wires.find((item) => item.id === scene.hover.wireId);
  if (!wire) return;
  [wire.a, wire.b].forEach((ref) => {
    const resolved = resolveRef(ref);
    const pos = resolved ? resolved.pos : refFallbackPos(ref);
    if (!pos) return;
    const p = project(view, pos.x, pos.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(4, view.tileW * 0.2), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(143, 216, 234, 0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(20, 30, 40, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    drawTerminalLabel(ctx, p.x, p.y - view.tileH * 0.5 - 8, resolved ? resolved.label : '?', '#8fd8ea');
  });
}

/** 智能聚焦连线：起点态下，给所有「可连」端子画弱高亮 + 端子名 */
function drawConnectableHints(ctx, view, scene) {
  const wire = scene.wiring;
  if (!wire || !wire.from || !wire.connectable) return;
  wire.connectable.forEach((hint) => {
    const p = project(view, hint.x, hint.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(3, view.tileW * 0.14), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(242, 169, 59, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(242, 169, 59, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    drawTerminalLabel(ctx, p.x, p.y - view.tileH * 0.5 - 8, `${hint.componentId}.${hint.terminal}`, '#f2a93b');
  });
}

/** 放大镜：在指针处画一个 2× 的圆形放大窗口，内容取自已渲染的主画布 */
function drawMagnifier(ctx, view, scene) {
  if (!scene.lens || !scene.lens.on || !scene.pointer || !scene.pointerInside) return;
  const px = scene.pointer.x;
  const py = scene.pointer.y;
  const radius = 80;
  const mag = 2;
  const srcRadius = radius / mag;
  const dpr = view.dpr;

  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.clip();
  // 主画布自身即源：把以指针为中心 srcRadius 区域放大到 radius 正方形
  ctx.drawImage(
    view.canvas,
    (px - srcRadius) * dpr, (py - srcRadius) * dpr, srcRadius * 2 * dpr, srcRadius * 2 * dpr,
    px - radius, py - radius, radius * 2, radius * 2,
  );
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py);
  ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(40, 44, 54, 0.9)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/* ==========================================================================
   拾取
   ========================================================================== */

/** 点到线段距离 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 屏幕坐标拾取。优先级：元件端子 > 元件本体 > 导线 > 平台孔位。
 * 元件本体优先于孔位：元件压在台面上时，点它应当选中元件而不是选中被遮住的孔。
 * 导线优先于孔位：导线画在台面孔位之上、孔位命中半径又更大，若孔位先赢，
 * 实验箱上导线几乎点不中（右键删导线、悬停导线都会失效）。
 */
export function pickAt(view, scene, sx, sy) {
  const platform = scene.platform;
  const circuit = scene.circuit;

  // 先算网格坐标与"落在哪个元件本体里"：命中优先级要用它做仲裁
  const point = unproject(view, sx, sy);
  let bodyHit = null;
  for (let i = circuit.components.length - 1; i >= 0; i -= 1) {
    const comp = circuit.components[i];
    const def = getPart(comp.type);
    const footprint = footprintOf(def, comp.rotation);
    // 命中区比占位放大 1.15×：抓取手感更接近"伸手就能拿到"，不必精确压在边框里
    const padX = footprint.w * 0.075;
    const padY = footprint.h * 0.075;
    if (
      point.gx >= comp.x - padX && point.gx <= comp.x + footprint.w + padX
      && point.gy >= comp.y - padY && point.gy <= comp.y + footprint.h + padY
    ) {
      bodyHit = { type: 'component', componentId: comp.id };
      break;
    }
  }

  // 1. 元件端子
  //    触屏友好：命中半径取 max(12px, tileW*0.5)。鼠标够用的 9px 对手指偏小，
  //    而实验箱孔位密集，放大到 12px 后"点一下就能连上"的成功率明显提升。
  //    仲裁规则：指针落在元件本体内部、又不是真的压在引脚上时让本体赢——
  //    小元件（电阻 3×1）的两个引脚会把整个本体都罩进 12px，否则就拖不动了。
  let pinHit = null;
  let pinDistance = Math.max(12, view.tileW * 0.5);
  circuit.components.forEach((comp) => {
    comp.terminals.forEach((terminal) => {
      const p = terminalScreenPos(view, comp, terminal.name);
      if (!p) return;
      const distance = Math.hypot(p.x - sx, p.y - sy);
      if (distance < pinDistance) {
        pinDistance = distance;
        pinHit = {
          type: 'terminal',
          componentId: comp.id,
          terminal: terminal.name,
          x: p.x,
          y: p.y,
        };
      }
    });
  });
  if (bodyHit) {
    const pinRadius = Math.max(6, view.tileW * 0.22);
    if (pinHit && pinDistance <= pinRadius) return pinHit;
    return bodyHit;
  }
  if (pinHit) return pinHit;

  // 3. 导线（绘制在孔位之上，命中优先于孔位：实验箱孔位密集、命中半径又比导线大，
  //    若让孔位先赢，导线在实验箱上几乎点不中——右键删导线 / 悬停导线会失效）
  let wireBest = null;
  let wireDistance = Math.max(6, view.tileW * 0.2);
  circuit.wires.forEach((wire) => {
    const ends = wireScreenEnds(view, wire);
    if (!ends) return;
    const points = wirePath(view, ends.a, ends.b);
    for (let i = 0; i < points.length - 1; i += 1) {
      const distance = distanceToSegment(
        sx, sy,
        points[i].x, points[i].y,
        points[i + 1].x, points[i + 1].y,
      );
      if (distance < wireDistance) {
        wireDistance = distance;
        wireBest = { type: 'wire', wireId: wire.id };
      }
    }
  });
  if (wireBest) return wireBest;

  // 4. 平台孔位（按网格就近查 3×3 邻域，避免遍历近千节点）
  if (platform) {
    const cx = Math.round(point.gx);
    const cy = Math.round(point.gy);
    let nodeBest = null;
    let nodeDistance = Math.max(6, Math.min(9, view.tileW * 0.42));
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const ids = platform.coordMap.get(`${cx + dx},${cy + dy}`);
        if (!ids) continue;
        ids.forEach((nodeId) => {
          const node = platform.nodeMap.get(nodeId);
          if (!node) return;
          const p = project(view, node.x, node.y);
          const distance = Math.hypot(p.x - sx, p.y - sy);
          if (distance < nodeDistance) {
            nodeDistance = distance;
            nodeBest = { type: 'node', nodeId, x: p.x, y: p.y };
          }
        });
      }
    }
    if (nodeBest) return nodeBest;
  }

  return null;
}

/** 导出给交互层复用的几何工具 */
export const geometry = { distanceToSegment, wirePath };
