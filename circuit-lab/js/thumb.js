/**
 * thumb.js — 实验卡片缩略图（指令包 19 · 阶段 3 / R15）
 *
 * 与 R16 共用 circuit-export.js 的同一份原理图几何，避免「缩略图一套画法、
 * 导出图另一套画法」。缩略图本质是 SVG data URL 画进小 Canvas。
 *
 * 规格要点：
 *   - 异步逐张生成（requestIdleCallback），不阻塞列表渲染；
 *   - 缓存键 localStorage['lab-sim:thumb:<expId>']，值为 { sig, url } JSON；
 *     sig 是电路结构签名，导入新配置 / 改模板后缓存自动失效；
 *   - localStorage 不可用 / 超配额时静默降级为「本次会话内不缓存」。
 */

import { getExample } from './examples-data.js';
import {
  circuitToSvg, circuitSignature, svgDataUrl,
} from './circuit-export.js';

/** 缓存键前缀：与规格 15.1 一致 */
export const THUMB_PREFIX = 'lab-sim:thumb:';

/** 存档前缀：非示例实验用当前存档渲染（board.js 的 STORAGE_PREFIX） */
const CIRCUIT_PREFIX = 'lab-sim-circuit-';

/** 缩略图默认尺寸（CSS 像素）；实际 canvas 按 dpr 放大 */
export const THUMB_HEIGHT = 104;

/** 内存兜底：localStorage 不可用时仍避免同一张图重复生成 */
const memoryCache = new Map();

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

export function thumbKey(expId) {
  return `${THUMB_PREFIX}${expId}`;
}

/** 从存档里取电路（board.js 存的是序列化对象，含 components / wires） */
function circuitFromArchive(expId) {
  const raw = safeGet(`${CIRCUIT_PREFIX}${expId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const candidate = parsed && parsed.circuit ? parsed.circuit : parsed;
    if (candidate && Array.isArray(candidate.components)) return candidate;
  } catch (_) { /* 脏存档按无电路处理 */ }
  return null;
}

/**
 * 缩略图用的电路：示例实验用其模板，其余用当前存档；都没有则空电路。
 * 模板只读，这里不改动它。
 */
export function thumbCircuit(exp) {
  if (!exp || !exp.id) return { platform: '', components: [], wires: [] };
  const example = getExample(exp.id);
  if (example && example.circuit) return example.circuit;
  return circuitFromArchive(exp.id)
    || { platform: exp.platform || '', components: [], wires: [] };
}

/** 读缓存：签名不匹配视为失效，返回 null */
export function readThumb(expId, sig) {
  const key = thumbKey(expId);
  const raw = safeGet(key);
  if (raw) {
    try {
      const cached = JSON.parse(raw);
      if (cached && cached.sig === sig && typeof cached.url === 'string'
        && cached.url.startsWith('data:image/svg+xml')) return cached.url;
    } catch (_) { /* 旧版本 / 脏值按失效处理 */ }
  }
  const mem = memoryCache.get(key);
  if (mem && mem.sig === sig) return mem.url;
  return null;
}

/** 写缓存：同时落 localStorage 与内存，任一失败都不影响渲染 */
export function writeThumb(expId, sig, url) {
  const key = thumbKey(expId);
  const payload = JSON.stringify({ sig, url });
  memoryCache.set(key, { sig, url });
  safeSet(key, payload);
  return url;
}

/** 把 SVG data URL 按 contain 方式画进 canvas（背景纯白，不拉伸变形） */
function paint(canvas, url, empty) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const parent = canvas.parentElement;
  const cssW = Math.max(80, Math.round(canvas.clientWidth || (parent && parent.clientWidth) || 240));
  const cssH = THUMB_HEIGHT;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = '100%';
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  if (empty) {
    ctx.fillStyle = '#8a93a6';
    ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无电路模板', cssW / 2, cssH / 2 + 4);
    canvas.dataset.thumbState = 'empty';
    return true;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width || 240;
      const h = img.height || 120;
      const scale = Math.min(cssW / w, cssH / h, 1.6);
      const dw = w * scale;
      const dh = h * scale;
      ctx.drawImage(img, (cssW - dw) / 2, (cssH - dh) / 2, dw, dh);
      canvas.dataset.thumbState = 'ready';
      resolve(true);
    };
    img.onerror = () => {
      canvas.dataset.thumbState = 'error';
      resolve(false);
    };
    img.src = url;
  });
}

/**
 * 渲染单张缩略图。命中缓存时直接用，否则现场生成 SVG → 缓存 → 绘制。
 * @returns {Promise<boolean>} 是否成功绘制
 */
export async function renderThumb(canvas, exp) {
  if (!canvas || !exp) return false;
  const circuit = thumbCircuit(exp);
  const sig = circuitSignature(circuit);
  const empty = !circuit.components || circuit.components.length === 0;
  let url = empty ? null : readThumb(exp.id, sig);

  if (!url && !empty) {
    const built = circuitToSvg(circuit, { cell: 14, padding: 1.5 });
    url = writeThumb(exp.id, sig, svgDataUrl(built.svg));
  }

  canvas.dataset.thumbExp = exp.id;
  canvas.dataset.thumbSig = sig;
  return paint(canvas, url || '', empty);
}

/** idle 调度：逐卡片生成，避免一次 20 张 SVG 阻塞列表首帧 */
function idle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 600 });
  } else {
    setTimeout(fn, 16);
  }
}

/**
 * 为容器内所有 [data-thumb-exp] 的 canvas 调度缩略图渲染。
 * 已渲染过的（thumbState=ready）跳过，避免切换筛选条件时重复绘制。
 * @param {Element} host 列表网格
 * @param {(id:string)=>object|null} [resolveExp] 按 id 取实验定义（拿 platform 等字段）
 */
export function scheduleThumbs(host, resolveExp) {
  if (!host) return 0;
  const canvases = Array.from(host.querySelectorAll('canvas.thumb-canvas'));
  canvases.forEach((canvas) => {
    const expId = canvas.dataset.thumbExp;
    if (!expId || canvas.dataset.thumbState === 'ready') return;
    idle(() => {
      // 卡片可能已被下一次过滤移除，重新确认仍在文档里
      if (!canvas.isConnected) return;
      const exp = typeof resolveExp === 'function' ? resolveExp(expId) : null;
      renderThumb(canvas, exp || { id: expId });
    });
  });
  return canvases.length;
}
