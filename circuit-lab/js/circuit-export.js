/**
 * circuit-export.js — 电路原理图导出（指令包 19 · 阶段 3 / R16）
 *
 * 纯函数内核：把 circuit 数据变成「干净、可缩放」的 SVG 字符串。
 * 不依赖 DOM / Canvas / 视图层 layout，因此：
 *   - tools/test-model.mjs 可以直接对拍字符串结构；
 *   - 报告内嵌、列表缩略图、SVG/PNG 下载共用同一份几何与符号，不会两套画法漂移。
 *
 * 设计取舍（对齐规格 16.2）：
 *   - 符号尺寸、引脚位置、元件标注一律取自 symparts.js 的 symSize / pinList /
 *     symbolLabel；drawSymbol 是 Canvas 专用，无法产出矢量，所以这里按同一份
 *     几何数据画等价的 SVG 图元（矩形 / 圆 / 折线），不套 2.5D 投影。
 *   - 布局用确定性的自动排布（按原电路 y 分行、行内按 x 排序），不读
 *     schematic.js 的视图层 layout（那是纯视图态、依赖 DOM 与 rAF，不落盘）。
 *   - 导线按 wire 两端端子坐标用正交折线绘制；重复端点对去重。
 *   - 输出不含阴影、光晕、网格、选中框、投影。
 */

import { symSize, pinList, pinByName, symbolLabel } from './symparts.js';
import { symGeometry } from './symrender.js';

/** 导出画布的默认格距（像素 / 格），PNG 2x 时再整体放大 */
export const EXPORT_CELL = 18;

/** 元件之间的留白（格） */
const GAP_X = 3;
const GAP_Y = 3;

/** 画布四周留白（格） */
const PAD = 2;

/** 配色：白纸 + 深墨线，打印友好 */
export const EXPORT_COLORS = {
  paper: '#ffffff',
  ink: '#26303f',
  wire: '#3d5a80',
  pin: '#26303f',
  muted: '#6b7688',
  fill: '#f7f9fc',
};

/* ---------------------------------------------------------------- 工具 */

/** XML 文本转义：元件标注 / 引脚名可能含 & < > " ' */
export function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 数字格式化：避免 SVG 里出现 1.3000000000000003 这种脏坐标 */
function n(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '0';
  return String(Number(v.toFixed(3)));
}

/** 电路结构签名：缩略图缓存用它判断电路是否变了 */
export function circuitSignature(circuit) {
  if (!circuit || !Array.isArray(circuit.components)) return 'empty';
  const comps = circuit.components
    .map((c) => `${c.id}:${c.type}:${c.x}:${c.y}`)
    .sort()
    .join(',');
  const wires = (circuit.wires || []).length;
  return `${circuit.platform || ''}|${circuit.components.length}|${wires}|${comps}`;
}

/* ---------------------------------------------------------------- 布局 */

/**
 * 确定性自动布局：按原电路的 y 分行，行内按 x 排序，逐个水平摆放。
 * 同一行判定用「元件中心 y 差 < 2 格」，能保留面包板上并排 / 上下两排的观感。
 *
 * @param {object} circuit { components, wires, platform }
 * @returns {{ entries: Map, bounds: object, terminals: Map }}
 *   entries: id → { sx, sy, w, h, rot }
 *   terminals: `${componentId}:${terminal}` → { x, y }（格坐标，未乘 cell）
 */
export function exportLayout(circuit) {
  const entries = new Map();
  const terminals = new Map();
  const comps = circuit && Array.isArray(circuit.components)
    ? circuit.components.filter((c) => c && typeof c.id === 'string')
    : [];

  if (comps.length === 0) {
    return { entries, terminals, bounds: { maxX: PAD * 2, maxY: PAD * 2 } };
  }

  // 分行：按 y 排序后，中心 y 差小于 2 视为同一行
  const sorted = comps.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  sorted.forEach((comp) => {
    const size = symSize(comp.type, 0);
    const cy = Number(comp.y) + size.h / 2;
    const row = rows[rows.length - 1];
    if (!row || Math.abs(cy - row.cy) >= 2) {
      rows.push({ cy, items: [comp] });
    } else {
      row.items.push(comp);
    }
  });

  let cursorY = 0;
  let maxX = 0;
  rows.forEach((row) => {
    let cursorX = 0;
    let rowH = 0;
    row.items.sort((a, b) => a.x - b.x).forEach((comp) => {
      const size = symSize(comp.type, 0);
      entries.set(comp.id, {
        sx: cursorX,
        sy: cursorY,
        w: size.w,
        h: size.h,
        rot: 0,
      });
      pinList(comp.type, 0).forEach((pin) => {
        terminals.set(`${comp.id}:${pin.name}`, {
          x: cursorX + pin.x,
          y: cursorY + pin.y,
        });
      });
      // 兼容 pinList 未覆盖到的端子（自定义符号 / 别名），回落到 pinByName
      cursorX += size.w + GAP_X;
      rowH = Math.max(rowH, size.h);
      maxX = Math.max(maxX, cursorX);
    });
    cursorY += rowH + GAP_Y;
  });

  return {
    entries,
    terminals,
    bounds: { maxX: Math.max(1, maxX - GAP_X), maxY: Math.max(1, cursorY - GAP_Y) },
  };
}

/* ---------------------------------------------------------------- 符号 */

/** 符号形状分类：只影响矢量图元，几何尺寸仍来自 symparts */
function shapeKind(type) {
  if (type === 'ic74xx' || type === 'ic74xx16' || type === 'dip4'
    || type === 'opamp' || type === 'comparator' || type === 'buffer74'
    || type === 'dac8' || type === 'adc8') return 'ic';
  if (type === 'vsource' || type === 'isource' || type === 'clock'
    || type === 'fgen' || type === 'pulse') return 'circle';
  if (type === 'capacitor') return 'cap';
  if (type === 'diode' || type === 'zener' || type === 'led') return 'diode';
  if (type === 'resistor' || type === 'pot' || type === 'inductor'
    || type === 'switch' || type === 'relay' || type === 'buzzer') return 'rect';
  return 'rect';
}

/** 单个元件的 SVG 图元（局部坐标已换算成像素） */
function symbolFragments(comp, entry, cell) {
  const out = [];
  const x = entry.sx * cell;
  const y = entry.sy * cell;
  const w = entry.w * cell;
  const h = entry.h * cell;
  const kind = shapeKind(comp.type);
  const stroke = `stroke="${EXPORT_COLORS.ink}" stroke-width="1.4"`;

  if (kind === 'circle') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2 - 2;
    out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${EXPORT_COLORS.fill}" ${stroke}/>`);
    out.push(`<text x="${n(cx)}" y="${n(cy + 3)}" text-anchor="middle" font-size="${n(cell * 0.5)}" fill="${EXPORT_COLORS.ink}">${escapeXml(symbolShort(comp))}</text>`);
  } else if (kind === 'cap') {
    const cx = x + w / 2;
    const top = y + h * 0.2;
    const bottom = y + h * 0.8;
    out.push(`<line x1="${n(cx - cell * 0.5)}" y1="${n(top)}" x2="${n(cx + cell * 0.5)}" y2="${n(top)}" ${stroke}/>`);
    out.push(`<line x1="${n(cx - cell * 0.5)}" y1="${n(bottom)}" x2="${n(cx + cell * 0.5)}" y2="${n(bottom)}" ${stroke}/>`);
  } else if (kind === 'diode') {
    const cy = y + h / 2;
    const cx = x + w / 2;
    const half = Math.min(w, h) * 0.28;
    out.push(`<path d="M ${n(cx - half)} ${n(cy - half)} L ${n(cx + half)} ${n(cy)} L ${n(cx - half)} ${n(cy + half)} Z" fill="${EXPORT_COLORS.fill}" ${stroke}/>`);
    out.push(`<line x1="${n(cx + half)}" y1="${n(cy - half)}" x2="${n(cx + half)}" y2="${n(cy + half)}" ${stroke}/>`);
    if (comp.type === 'led') {
      out.push(`<path d="M ${n(cx)} ${n(cy - half)} l ${n(cell * 0.6)} ${n(-cell * 0.45)} M ${n(cx + cell * 0.25)} ${n(cy - half * 1.4)} l ${n(cell * 0.6)} ${n(-cell * 0.45)}" fill="none" ${stroke}/>`);
    }
  } else {
    const rx = kind === 'ic' ? 2 : 3;
    out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${rx}" fill="${EXPORT_COLORS.fill}" ${stroke}/>`);
    if (kind === 'ic') {
      const chip = comp.params && comp.params.type ? String(comp.params.type) : '';
      out.push(`<text x="${n(x + w / 2)}" y="${n(y + h * 0.42)}" text-anchor="middle" font-size="${n(cell * 0.52)}" font-weight="600" fill="${EXPORT_COLORS.ink}">${escapeXml(chip || comp.type)}</text>`);
      out.push(`<line x1="${n(x)}" y1="${n(y + h * 0.55)}" x2="${n(x + w)}" y2="${n(y + h * 0.55)}" stroke="${EXPORT_COLORS.muted}" stroke-width="0.8"/>`);
    } else {
      out.push(`<text x="${n(x + w / 2)}" y="${n(y + h / 2 + cell * 0.2)}" text-anchor="middle" font-size="${n(cell * 0.5)}" fill="${EXPORT_COLORS.ink}">${escapeXml(symbolShort(comp))}</text>`);
    }
  }

  // 引脚圆点 + 引脚号（规格 16.2：符号 + 引脚号）
  const pins = pinList(comp.type, 0);
  pins.forEach((pin) => {
    const px = x + pin.x * cell;
    const py = y + pin.y * cell;
    out.push(`<circle cx="${n(px)}" cy="${n(py)}" r="1.8" fill="${EXPORT_COLORS.pin}"/>`);
    const fs = n(cell * (kind === 'ic' ? 0.38 : 0.44));
    let tx = px;
    let ty = py;
    let anchor = 'middle';
    if (pin.side === 'left') { tx = px + cell * 0.28; anchor = 'start'; ty = py - cell * 0.14; }
    else if (pin.side === 'right') { tx = px - cell * 0.28; anchor = 'end'; ty = py - cell * 0.14; }
    else if (pin.side === 'top') { ty = py + cell * 0.62; }
    else if (pin.side === 'bottom') { ty = py - cell * 0.28; }
    out.push(`<text x="${n(tx)}" y="${n(ty)}" text-anchor="${anchor}" font-size="${fs}" fill="${EXPORT_COLORS.muted}">${escapeXml(pin.name)}</text>`);
  });

  // 元件标注（如 "R 1kΩ"），放在符号下方；IC 已有芯片名，仍补一行编号
  const label = symbolLabel(comp);
  const labelY = y + h + cell * 0.78;
  out.push(`<text x="${n(x + w / 2)}" y="${n(labelY)}" text-anchor="middle" font-size="${n(cell * 0.5)}" font-weight="600" fill="${EXPORT_COLORS.ink}">${escapeXml(`${comp.id}  ${label}`)}</text>`);

  return out;
}

/** 符号内的短标签：取标注里第一段，避免长文本撑破 */
function symbolShort(comp) {
  const sym = symbolLabel(comp);
  const first = String(sym).split(/\s+/)[0];
  return first || comp.type;
}

/* ---------------------------------------------------------------- 导线 */

/** wire 端点 → 格坐标；node 类型端点无元件端子，返回 null */
function endpointOf(endpoint, circuit, layout) {
  if (!endpoint || !endpoint.componentId || !endpoint.terminal) return null;
  const key = `${endpoint.componentId}:${endpoint.terminal}`;
  if (layout.terminals.has(key)) return layout.terminals.get(key);
  // 自定义端子别名：从元件本体再查一次 pinByName
  const comp = (circuit.components || []).find((c) => c.id === endpoint.componentId);
  const entry = layout.entries.get(endpoint.componentId);
  if (!comp || !entry) return null;
  const pin = pinByName(comp.type, endpoint.terminal, 0);
  if (!pin) return null;
  return { x: entry.sx + pin.x, y: entry.sy + pin.y };
}

function wireFragments(circuit, layout, cell) {
  const out = [];
  const seen = new Set();
  const wires = Array.isArray(circuit.wires) ? circuit.wires : [];
  wires.forEach((wire) => {
    const a = endpointOf(wire.a, circuit, layout);
    const b = endpointOf(wire.b, circuit, layout);
    if (!a || !b) return;
    const ka = `${n(a.x)}:${n(a.y)}`;
    const kb = `${n(b.x)}:${n(b.y)}`;
    const key = [ka, kb].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const segments = symGeometry.orthoRoute(a, b);
    segments.forEach((segment) => {
      const points = segment
        .map((p) => `${n(p.x * cell)},${n(p.y * cell)}`)
        .join(' ');
      out.push(`<polyline points="${points}" fill="none" stroke="${EXPORT_COLORS.wire}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    });
    // 接线点：两端各一个小实心点
    [a, b].forEach((p) => {
      out.push(`<circle cx="${n(p.x * cell)}" cy="${n(p.y * cell)}" r="2.2" fill="${EXPORT_COLORS.wire}"/>`);
    });
  });
  return out;
}

/* ---------------------------------------------------------------- 导出 */

/**
 * 生成干净 SVG 字符串。
 * @param {object} circuit { platform, components, wires }
 * @param {{cell?:number, padding?:number, title?:string}} [opts]
 * @returns {{svg:string, width:number, height:number, layout:object}}
 */
export function circuitToSvg(circuit, opts = {}) {
  const cell = Number.isFinite(opts.cell) && opts.cell > 0 ? opts.cell : EXPORT_CELL;
  const pad = Number.isFinite(opts.padding) ? opts.padding : PAD;
  const layout = exportLayout(circuit);
  const width = Math.max(cell * 4, Math.ceil((layout.bounds.maxX + pad * 2) * cell));
  const height = Math.max(cell * 3, Math.ceil((layout.bounds.maxY + pad * 2) * cell));
  const offset = pad * cell;

  const parts = [];
  // XML 声明必须显式写 UTF-8：元件标注含中文，base64 data URL 解码时靠它定编码
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="电路原理图">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${EXPORT_COLORS.paper}"/>`);
  parts.push(`<g transform="translate(${offset} ${offset})" font-family="Segoe UI, Microsoft YaHei, sans-serif">`);
  // 先画导线，符号压在上面，端点圆点不会被矩形盖掉
  parts.push(...wireFragments(circuit || {}, layout, cell));
  (circuit && Array.isArray(circuit.components) ? circuit.components : []).forEach((comp) => {
    const entry = layout.entries.get(comp.id);
    if (!entry) return;
    parts.push(`<g data-component="${escapeXml(comp.id)}">`);
    parts.push(...symbolFragments(comp, entry, cell));
    parts.push('</g>');
  });
  parts.push('</g>');
  parts.push('</svg>');

  return { svg: parts.join('\n'), width, height, layout };
}

/** SVG 字符串 → UTF-8 安全的 base64 data URL（浏览器 / Node 均可） */
export function svgDataUrl(svg) {
  const bytes = new TextEncoder().encode(String(svg));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

/** 便捷入口：一次拿到可直接 <img src> 的矢量图 URL */
export function circuitSvgDataUrl(circuit, opts) {
  return svgDataUrl(circuitToSvg(circuit, opts).svg);
}

/**
 * SVG → PNG data URL（浏览器）。scale=2 即规格要求的 2x 分辨率。
 * 用 Image 加载 data URL，再按 scale 放大绘制到离屏 Canvas。
 */
export function svgToPngDataUrl(svg, scale = 2, background = '#ffffff') {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      reject(new Error('SVG→PNG 需要浏览器环境'));
      return;
    }
    const meta = svgDimensions(svg);
    const img = new Image();
    img.onload = () => {
      try {
        const w = Math.max(1, Math.round(meta.width * scale));
        const h = Math.max(1, Math.round(meta.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('无法创建 2D 上下文')); return; }
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error('SVG 图像加载失败'));
    img.src = svgDataUrl(svg);
  });
}

/** 从 SVG 字符串里读 width / height（纯字符串解析，Node 可用） */
export function svgDimensions(svg) {
  const text = String(svg || '');
  const w = /<svg[^>]*\bwidth="([\d.]+)"/.exec(text);
  const h = /<svg[^>]*\bheight="([\d.]+)"/.exec(text);
  return {
    width: w ? Number(w[1]) : 640,
    height: h ? Number(h[1]) : 360,
  };
}

/** 浏览器下载（data URL / Blob URL 通用） */
export function downloadDataUrl(dataUrl, filename) {
  if (typeof document === 'undefined') return false;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  return true;
}
