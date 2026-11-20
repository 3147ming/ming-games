/**
 * SOUDACHE — UI 通用小工具（P1 从 ui.js 拆出）。
 * 全部是模块级纯函数或仅依赖 document 的 DOM 微工具，不碰 world / 存档 / createUI 闭包状态。
 * ui.js 门面 re-export，外部 import 零改动。
 */
import { HUD, DF, dfAlpha } from './config.js';
import { liveObjectives } from './objectives.js';
import { drawGlyph } from './glyphs.js';
import { iconUrl } from './icons.js';

/**
 * P20：局内目标的 HUD 视图。world.objectives 为空时回落到旧版「终端 / 空投」概览，
 * 保证旧存档、旧探针手搓的 world 不会因为缺字段而画不出东西。
 * @param {object} world 战局
 * @returns {Array<object>} 带 state 的目标列表
 */
function liveObjectiveRows(world) {
  if (!world || !Array.isArray(world.objectives) || !world.objectives.length) return [];
  const carried = world.player ? (world.player.carriedValue || 0) : 0;
  return liveObjectives(world.objectives, world, carried);
}

/**
 * 把一行文字裁到指定像素宽（超宽补省略号）。
 * HUD 里所有"可能变长"的文案都要过它 —— 否则长地图名 / 长目标名会画到面板外。
 * @param {CanvasRenderingContext2D} ctx 画布
 * @param {string} text 原文
 * @param {number} maxW 最大像素宽
 * @returns {string} 裁剪后的文本
 */
function clipText(ctx, text, maxW) {
  const s = String(text == null ? '' : text);
  if (maxW <= 0) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}
/** 等宽 / 无衬线字体（与旧 2D 渲染器保持一致） */
const MONO = '"Consolas", "SFMono-Regular", "JetBrains Mono", "Courier New", monospace';
const SANS = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** 圆角矩形路径（不填充，需调用方自行 fill / stroke） */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
/* ------------------------------------------------------------------ *
 * P1 战术 HUD 绘制原语
 *
 * 全部是模块级纯函数（只吃 ctx 与坐标），不碰 world、不碰存档，
 * 这样单测能用假 ctx 直接验路径与颜色，真浏览器里也不会有隐藏状态。
 * 颜色一律来自 DF / dfAlpha —— P0 已经把 CSS 与 JS 两套令牌锁在一起，
 * 这里再写死 #xxx 就等于把换肤成果拆掉。
 * ------------------------------------------------------------------ */

/** 切角矩形路径：左上 + 右下各削一刀，替代 P0 之前的 8px 大圆角。 */
function cutPath(ctx, x, y, w, h, cut = HUD.cut) {
  const c = Math.max(0, Math.min(cut, w / 3, h / 3));
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

/** 四角括号：战术取景框语言，比整圈描边更轻、也更像瞄准镜。 */
function drawBrackets(ctx, x, y, w, h, color, len = HUD.bracket, lw = HUD.bracketW) {
  const l = Math.min(len, w / 3, h / 3);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x, y + l); ctx.lineTo(x, y); ctx.lineTo(x + l, y);
  ctx.moveTo(x + w - l, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + l);
  ctx.moveTo(x + w, y + h - l); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - l, y + h);
  ctx.moveTo(x + l, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - l);
  ctx.stroke();
}

/** 统一面板：切角底 + 1px 细边 + 四角括号。所有 HUD 卡片都走它。 */
function tacticalPanel(ctx, x, y, w, h, o = {}) {
  cutPath(ctx, x, y, w, h, o.cut);
  ctx.fillStyle = o.fill || dfAlpha(DF.bg, 0.86);
  ctx.fill();
  ctx.strokeStyle = o.line || dfAlpha(DF.dim, 0.30);
  ctx.lineWidth = 1;
  ctx.stroke();
  if (o.bracket !== false) {
    drawBrackets(ctx, x + 0.5, y + 0.5, w - 1, h - 1,
      o.bracketColor || dfAlpha(DF.accent, 0.72));
  }
}

/** 分段读数条：三角洲式"格"而不是连续进度条，低血量时掉的格一眼可数。 */
function segBar(ctx, x, y, w, h, ratio, color, segs = HUD.segCount, gap = HUD.segGap) {
  const n = Math.max(1, segs | 0);
  const sw = Math.max(1, (w - gap * (n - 1)) / n);
  const lit = Math.max(0, Math.min(1, ratio)) * n;
  for (let i = 0; i < n; i += 1) {
    const bx = x + i * (sw + gap);
    ctx.fillStyle = dfAlpha(DF.dim, 0.18);
    ctx.fillRect(bx, y, sw, h);
    if (i >= lit) continue;
    ctx.fillStyle = color;
    ctx.fillRect(bx, y, sw * Math.min(1, lit - i), h);
  }
}

/** 环形进度：技能冷却 / 搜刮 / 撤离读条共用一支笔。 */
function ringProgress(ctx, cx, cy, r, lw, ratio, color, track) {
  const t = Math.max(0, Math.min(1, ratio));
  ctx.lineCap = 'butt';
  ctx.lineWidth = lw;
  ctx.strokeStyle = track || dfAlpha(DF.dim, 0.22);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  if (t <= 0) return;
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); ctx.stroke();
}
/** 物品图标：优先用真 SVG（CC BY 图标，CSS mask 染色），没有映射时退回程序化矢量 */
function iconEl(kind, color, size = 26) {
  const url = iconUrl(kind);
  if (url) {
    // 为什么用 mask 而不是 <img>：图标要跟随稀有度/状态色染色，而 <img> 引入的
    // SVG 无法从外部改颜色（除非改文件）。mask 只取 alpha、颜色由背景色给，
    // 一张图能被染成任意颜色，且不需要给每个 kind 准备多个色版。
    const node = document.createElement('span');
    node.className = 'icon icon-mask';
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
    node.style.backgroundColor = color;
    node.style.setProperty('-webkit-mask-image', `url("${url}")`);
    node.style.setProperty('mask-image', `url("${url}")`);
    return node;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.className = 'icon';
  canvas.width = Math.floor(size * dpr);
  canvas.height = Math.floor(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  drawGlyph(ctx, kind, size / 2, size / 2, size * 0.74, color);
  return canvas;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function money(n) {
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}
/** P2 导航图标：纯程序化 SVG 路径，零外部素材、不用图标字体。 */
const HUB_GLYPHS = {
  target: '<circle cx="8" cy="8" r="5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  person: '<circle cx="8" cy="5" r="2.6"/><path d="M3 14c0-3 2.2-5 5-5s5 2 5 5"/>',
  gear: '<rect x="4" y="4" width="8" height="8"/><circle cx="8" cy="8" r="1.7"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  crate: '<rect x="2" y="4" width="12" height="9"/><path d="M2 8h12M8 4v9"/>',
  chart: '<path d="M2 13V8M6 13V4M10 13V9M14 13V3"/>',
  wrench: '<path d="M3 13L11 5a3 3 0 1 0-2-2L3 11z"/>',
  book: '<path d="M2 3h5c1 0 1 1 1 1v10c0-1 0-1-1-1H2zM14 3H9c-1 0-1 1-1 1v10c0-1 0-1 1-1h5z"/>',
  cart: '<path d="M1 2h2l2 8h8l2-6H4"/><circle cx="6" cy="13" r="1"/><circle cx="12" cy="13" r="1"/>',
};

function hubGlyph(name) {
  const body = HUB_GLYPHS[name] || HUB_GLYPHS.target;
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}


export {
  liveObjectiveRows,
  clipText,
  MONO,
  SANS,
  roundRect,
  cutPath,
  drawBrackets,
  tacticalPanel,
  segBar,
  ringProgress,
  iconEl,
  el,
  money,
  HUB_GLYPHS,
  hubGlyph,
};
