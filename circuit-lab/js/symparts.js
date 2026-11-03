/**
 * symparts.js — 原理图符号库（IEEE / IEC 风格，Canvas 2D）
 *
 * 与 parts.js 的分工：
 *   parts.js 描述元件的「实物」——2.5D 外观 + 孔位端子；
 *   本文件描述同一元件的「原理图符号」——线条 + 引脚。
 *   两者共用同一份元件类型 id 与端子 name。任一类型在两边注册的端子 name
 *   集合必须完全相等，否则联动时按 name 找不到对应端点。这条约束由
 *   tools/test-model.mjs 的断言锁定，不靠人工记忆。
 *
 * 坐标系：符号局部坐标，单位 = 原理图逻辑格，原点在符号左上角，
 * 范围 [0, w] × [0, h]。像素换算由 style.cell 提供，所有线宽用像素。
 *
 * 旋转：只支持 0° / 90°（与 parts.js 的元件旋转档位一致）。绕符号中心
 * 顺时针旋转 90° 的闭式解是 (dx, dy) → (h - dy, dx)，新占位交换宽高。
 */

// 单位格式化只保留一份实现（在 simdc）。符号标签与结果表格必须显示成同一个
// 数字——两处各写一份迟早会走样成 "5 V" 与 "5.000 V" 并存。
import { formatVolt, formatAmp } from './simdc.js';
import { normalizeType, pinLabel } from './digmodels.js';

/* ==========================================================================
   基础绘制工具
   ========================================================================== */

/** 折线 */
function polyline(ctx, points, color, width) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** 实心圆点（引脚接点用） */
function dot(ctx, center, radius, color) {
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** 空心矩形 */
function box(ctx, g, x0, y0, x1, y1) {
  const a = g.p(x0, y0);
  const b = g.p(x1, y1);
  ctx.beginPath();
  ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeStyle = g.color.ink;
  ctx.lineWidth = 1.8;
  ctx.stroke();
}

/** 三角形（实心） */
function triangle(ctx, points, color) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  ctx.lineTo(points[1].x, points[1].y);
  ctx.lineTo(points[2].x, points[2].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** 小箭头（LED 发光方向） */
function arrow(ctx, g, from, to, color) {
  const a = g.p(from[0], from[1]);
  const b = g.p(to[0], to[1]);
  polyline(ctx, [a, b], color, 1.4);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(2.6, g.cell * 0.22);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(angle - 0.5), b.y - head * Math.sin(angle - 0.5));
  ctx.lineTo(b.x - head * Math.cos(angle + 0.5), b.y - head * Math.sin(angle + 0.5));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/* ==========================================================================
   各类型符号
   ========================================================================== */

/** 电阻：IEEE 直角锯齿，两引脚在左右 */
function drawResistor(ctx, comp, g) {
  void comp;
  const cy = g.size.h / 2;
  const ink = g.color.ink;
  polyline(ctx, [g.p(0, cy), g.p(1, cy)], ink, 1.8);
  polyline(ctx, [g.p(3, cy), g.p(4, cy)], ink, 1.8);

  const points = [g.p(1, cy)];
  const steps = 6;
  for (let i = 0; i < steps; i += 1) {
    const x = 1 + (i + 0.5) * 2 / steps;
    const y = cy + (i % 2 === 0 ? -0.52 : 0.52);
    points.push(g.p(x, y));
  }
  points.push(g.p(3, cy));
  polyline(ctx, points, ink, 1.8);
}

/** LED：二极管三角 + 阴极杠 + 两个发光箭头 */
function drawLed(ctx, comp, g) {
  const cy = 1.3;
  const ink = g.color.ink;
  polyline(ctx, [g.p(0, cy), g.p(1, cy)], ink, 1.8);
  polyline(ctx, [g.p(2, cy), g.p(3, cy)], ink, 1.8);

  triangle(ctx, [g.p(1, cy - 0.55), g.p(1, cy + 0.55), g.p(2, cy)], ink);
  polyline(ctx, [g.p(2, cy - 0.55), g.p(2, cy + 0.55)], ink, 2);

  // 发光箭头：颜色跟随元件参数，让红/绿/黄一眼可分
  const palette = { red: '#c9524a', green: '#3f9a72', yellow: '#c99a20' };
  const glow = palette[comp.params.color] || palette.red;
  arrow(ctx, g, [1.32, cy - 0.55], [1.76, cy - 1.12], glow);
  arrow(ctx, g, [1.74, cy - 0.48], [2.18, cy - 1.05], glow);
}

/** 开关：两个触点 + 可动杠杆（state 决定闭合与否） */
function drawSwitch(ctx, comp, g) {
  const cy = g.size.h / 2;
  const ink = g.color.ink;
  const closed = comp.params.state === 'closed';
  polyline(ctx, [g.p(0, cy), g.p(0.95, cy)], ink, 1.8);
  polyline(ctx, [g.p(2.25, cy), g.p(3, cy)], ink, 1.8);
  dot(ctx, g.p(0.95, cy), Math.max(1.6, g.cell * 0.09), ink);
  dot(ctx, g.p(2.25, cy), Math.max(1.6, g.cell * 0.09), ink);

  const tip = closed ? [2.25, cy] : [2.08, cy - 0.66];
  polyline(ctx, [g.p(0.95, cy), g.p(tip[0], tip[1])], ink, 1.8);
}

/** 电容：两片平行极板 */
function drawCapacitor(ctx, comp, g) {
  void comp;
  const cy = g.size.h / 2;
  const ink = g.color.ink;
  polyline(ctx, [g.p(0, cy), g.p(1.28, cy)], ink, 1.8);
  polyline(ctx, [g.p(1.72, cy), g.p(3, cy)], ink, 1.8);
  polyline(ctx, [g.p(1.28, cy - 0.72), g.p(1.28, cy + 0.72)], ink, 2.2);
  polyline(ctx, [g.p(1.72, cy - 0.72), g.p(1.72, cy + 0.72)], ink, 2.2);
}

/** 电压源：电池符号（长板 = 正极）+ 极性标记 */
function drawVsource(ctx, comp, g) {
  const cy = g.size.h / 2;
  const ink = g.color.ink;
  polyline(ctx, [g.p(0, cy), g.p(1.05, cy)], ink, 1.8);
  polyline(ctx, [g.p(1.55, cy), g.p(3, cy)], ink, 1.8);
  // 长板（正极）/ 短板（负极）
  polyline(ctx, [g.p(1.05, cy - 0.62), g.p(1.05, cy + 0.62)], ink, 2.2);
  polyline(ctx, [g.p(1.55, cy - 0.3), g.p(1.55, cy + 0.3)], ink, 2.2);

  // 极性标记：+ 在长板上方，− 在短板下方
  const size = Math.max(4, Math.min(6, g.cell * 0.3));
  ctx.strokeStyle = g.color.muted;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const plus = g.p(1.05, cy - 0.95);
  ctx.moveTo(plus.x - size, plus.y);
  ctx.lineTo(plus.x + size, plus.y);
  ctx.moveTo(plus.x, plus.y - size);
  ctx.lineTo(plus.x, plus.y + size);
  const minus = g.p(1.55, cy - 0.95);
  ctx.moveTo(minus.x - size, minus.y);
  ctx.lineTo(minus.x + size, minus.y);
  ctx.stroke();
}

/** 电流源：圆圈 + 内部箭头（箭头指向 − 端，即电流在源内部的方向） */
function drawIsource(ctx, comp, g) {
  void comp;
  const cy = g.size.h / 2;
  const ink = g.color.ink;
  const cx = 1.5;
  const r = 0.62;
  polyline(ctx, [g.p(0, cy), g.p(cx - r, cy)], ink, 1.8);
  polyline(ctx, [g.p(cx + r, cy), g.p(3, cy)], ink, 1.8);

  const center = g.p(cx, cy);
  ctx.beginPath();
  ctx.arc(center.x, center.y, r * g.cell, 0, Math.PI * 2);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  arrow(ctx, g, [cx - 0.36, cy], [cx + 0.36, cy], ink);
}

/** 数字源共用的小方框：内部画一个图形符号 */
function digSourceBox(ctx, g, accent) {
  const cy = g.size.h / 2;
  const x0 = 1.0;
  const x1 = 2.16;
  box(ctx, g, x0, cy - 0.82, x1, cy + 0.82);
  dot(ctx, g.p(x0, cy), Math.max(1.4, g.cell * 0.08), accent || g.color.muted);
  return { cy, x0, x1 };
}

/** 逻辑电平开关：方框内一根拨杆，旁边标 1 / 0 */
function drawLogicSwitch(ctx, comp, g) {
  const ink = g.color.ink;
  const hi = comp.params.state === 'hi';
  const { cy, x0, x1 } = digSourceBox(ctx, g, hi ? '#c98a1f' : g.color.muted);

  polyline(ctx, [g.p(0, cy), g.p(x0, cy)], ink, 1.8);
  polyline(ctx, [g.p(x1, cy), g.p(3, cy)], ink, 1.8);

  const accent = hi ? '#c98a1f' : ink;
  polyline(ctx, [g.p(x0 + 0.26, cy + 0.34), g.p(x0 + 0.66, hi ? cy - 0.38 : cy + 0.06)], accent, 1.8);
  dot(ctx, g.p(x0 + 0.66, hi ? cy - 0.38 : cy + 0.06), Math.max(1.4, g.cell * 0.08), accent);

  ctx.font = `${Math.max(8, Math.min(11, g.cell * 0.5))}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = accent;
  ctx.fillText(hi ? '1' : '0', g.p(x1 - 0.3, cy - 0.42).x, g.p(x1 - 0.3, cy - 0.42).y);
}

/** 脉冲源：方框内单次脉冲波形 */
function drawPulse(ctx, comp, g) {
  const ink = g.color.ink;
  const { cy, x0, x1 } = digSourceBox(ctx, g, '#4a7ba8');
  polyline(ctx, [g.p(0, cy), g.p(x0, cy)], ink, 1.8);
  polyline(ctx, [g.p(x1, cy), g.p(3, cy)], ink, 1.8);

  polyline(ctx, [
    g.p(x0 + 0.2, cy + 0.32),
    g.p(x0 + 0.44, cy + 0.32),
    g.p(x0 + 0.44, cy - 0.32),
    g.p(x0 + 0.78, cy - 0.32),
    g.p(x0 + 0.78, cy + 0.32),
    g.p(x0 + 1.0, cy + 0.32),
  ], ink, 1.6);

  if (comp.params.mode === 'toggle') {
    ctx.font = `${Math.max(7, Math.min(9, g.cell * 0.42))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = g.color.muted;
    ctx.fillText('T', g.p(x1 - 0.24, cy - 0.5).x, g.p(x1 - 0.24, cy - 0.5).y);
  }
}

/** 时钟源：方框内方波 */
function drawClock(ctx, comp, g) {
  const ink = g.color.ink;
  const { cy, x0, x1 } = digSourceBox(ctx, g, '#3f8f7e');
  polyline(ctx, [g.p(0, cy), g.p(x0, cy)], ink, 1.8);
  polyline(ctx, [g.p(x1, cy), g.p(3, cy)], ink, 1.8);

  polyline(ctx, [
    g.p(x0 + 0.16, cy + 0.3),
    g.p(x0 + 0.16, cy - 0.3),
    g.p(x0 + 0.5, cy - 0.3),
    g.p(x0 + 0.5, cy + 0.3),
    g.p(x0 + 0.84, cy + 0.3),
    g.p(x0 + 0.84, cy - 0.3),
    g.p(x0 + 1.0, cy - 0.3),
  ], ink, 1.6);

  const hz = Number(comp.params.frequency);
  if (Number.isFinite(hz)) {
    ctx.font = `${Math.max(7, Math.min(9, g.cell * 0.42))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = g.color.muted;
    ctx.fillText(`${hz}Hz`, g.p((x0 + x1) / 2, cy + 1.15).x, g.p((x0 + x1) / 2, cy + 1.15).y);
  }
}

/** 74 系列：矩形本体 + 左右各 7 个引脚，标出 1 脚与 GND / VCC */
function drawIc(ctx, comp, g) {
  const sym = g.sym;
  const ink = g.color.ink;
  const x0 = 1.2;
  const x1 = 5.8;
  const y0 = 0.6;
  const y1 = 7.4;

  box(ctx, g, x0, y0, x1, y1);

  const muted = g.color.muted;
  const modelId = normalizeType(comp.params.type);
  sym.pins.forEach((pin) => {
    const inner = pin.side === 'left' ? x0 : x1;
    polyline(ctx, [g.p(pin.dx, pin.dy), g.p(inner, pin.dy)], ink, 1.8);

    // 引脚文字用 datasheet 上的功能名（1A / 1Y / 1CLK），比脚号更好读；
    // 脚号在 parts.js 的 2.5D 实物视图里仍然是唯一的端子名。
    const textX = pin.side === 'left' ? x0 + 0.34 : x1 - 0.34;
    const align = pin.side === 'left' ? 'left' : 'right';
    const at = g.p(textX, pin.dy);
    ctx.font = `${Math.max(8, Math.min(11, g.cell * 0.55))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = muted;
    ctx.fillText(pinLabel(modelId, pin.name), at.x, at.y);
  });

  // 1 脚标记：本体左上角外侧一个小实心点
  dot(ctx, g.p(x0 - 0.34, y0 + 0.34), Math.max(1.6, g.cell * 0.09), muted);

  // 型号：本体中央
  const model = normalizeType(comp.params.type) || '74LS00';
  const size = Math.max(10, Math.min(15, g.cell * 0.78));
  ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  const center = g.p((x0 + x1) / 2, (y0 + y1) / 2);
  ctx.fillText(model, center.x, center.y);
}

/* ==========================================================================
   混合信号边界元件符号（指令包 8）
   ========================================================================== */

/** 比较器：三角 + +/− 输入 + 电源脚 */
function drawComparatorSym(ctx, comp, g) {
  void comp;
  const ink = g.color.ink;
  const muted = g.color.muted;
  const a = g.p(1.5, 0.9);
  const b = g.p(1.5, 5.1);
  const c = g.p(4.6, 3);

  polyline(ctx, [a, b, c, a], ink, 1.8);

  // 输入引线与极性
  polyline(ctx, [g.p(0, 1.6), g.p(1.5, 1.6)], ink, 1.8);
  polyline(ctx, [g.p(0, 4.4), g.p(1.5, 4.4)], ink, 1.8);
  polyline(ctx, [c, g.p(6, 3)], ink, 1.8);

  const fontSize = Math.max(9, Math.min(13, g.cell * 0.62));
  ctx.font = `600 ${fontSize}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+', g.p(0.75, 1.6).x, g.p(0.75, 1.6).y);
  ctx.fillText('−', g.p(0.75, 4.4).x, g.p(0.75, 4.4).y);

  // 电源脚：从三角上下边接入
  polyline(ctx, [g.p(3, 0), g.p(3, 1.92)], ink, 1.6);
  polyline(ctx, [g.p(3, 6), g.p(3, 4.08)], ink, 1.6);
  ctx.font = `${Math.max(7, fontSize * 0.72)}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = muted;
  ctx.textAlign = 'left';
  ctx.fillText('V+', g.p(3.16, 0.55).x, g.p(3.16, 0.55).y);
  ctx.fillText('GND', g.p(3.16, 5.5).x, g.p(3.16, 5.5).y);
}

/** 数字缓冲：小三角 + 电源脚 */
function drawBufferSym(ctx, comp, g) {
  void comp;
  const ink = g.color.ink;
  const a = g.p(0.9, 0.6);
  const b = g.p(0.9, 2.4);
  const c = g.p(3.1, 1.5);
  polyline(ctx, [a, b, c, a], ink, 1.8);
  polyline(ctx, [g.p(0, 1.5), g.p(0.9, 1.5)], ink, 1.8);
  polyline(ctx, [c, g.p(4, 1.5)], ink, 1.8);
  polyline(ctx, [g.p(2, 0), g.p(2, 1.05)], ink, 1.5);
  polyline(ctx, [g.p(2, 4), g.p(2, 1.95)], ink, 1.5);
}

/** 8 位 DAC / ADC：宽体方框 + 8 个数据脚 */
function drawWideSym(ctx, comp, g, title) {
  const ink = g.color.ink;
  const muted = g.color.muted;
  const x0 = 1.2;
  const x1 = 5.8;
  const y0 = 0.6;
  const y1 = 8.4;
  box(ctx, g, x0, y0, x1, y1);

  const fontSize = Math.max(7, Math.min(10, g.cell * 0.5));
  ctx.font = `${fontSize}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = muted;

  g.sym.pins.forEach((pin) => {
    const vertical = pin.side === 'left' || pin.side === 'right';
    const inner = pin.side === 'left' ? x0 : pin.side === 'right' ? x1 : pin.dy;
    if (vertical) {
      const outer = pin.side === 'left' ? 0 : 7;
      polyline(ctx, [g.p(outer, pin.dy), g.p(inner, pin.dy)], ink, 1.6);
      if (pin.side === 'left') {
        const at = g.p(x0 + 0.26, pin.dy);
        ctx.textAlign = 'left';
        ctx.fillText(pin.name, at.x, at.y);
      }
    } else {
      polyline(ctx, [g.p(pin.dx, pin.dy), g.p(pin.dx, pin.side === 'top' ? y0 : y1)], ink, 1.6);
    }
  });

  const size = Math.max(9, Math.min(14, g.cell * 0.7));
  ctx.font = `700 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = ink;
  const center = g.p((x0 + x1) / 2 + 0.7, (y0 + y1) / 2);
  ctx.fillText(title, center.x, center.y);
}

function drawDacSym(ctx, comp, g) {
  void comp;
  drawWideSym(ctx, g, 'DAC8');
}

function drawAdcSym(ctx, comp, g) {
  void comp;
  drawWideSym(ctx, g, 'ADC8');
}

/* ==========================================================================
   指令包 9：分立 / 动态 / 机电元件符号
   ========================================================================== */

/** 二极管/稳压管：三角 + 阴极条（稳压管阴极条带折角） */
function drawDiodeSym(ctx, comp, g, zener) {
  const ink = g.color.ink;
  polyline(ctx, [g.p(0, 1.3), g.p(1.2, 1.3)], ink, 1.8);
  // 三角（指向 K）
  polyline(ctx, [g.p(1.2, 0.5), g.p(1.2, 2.1), g.p(2.5, 1.3), g.p(1.2, 0.5)], ink, 1.8);
  // 阴极条
  polyline(ctx, [g.p(2.5, 0.5), g.p(2.5, 2.1)], ink, 2);
  if (zener) {
    polyline(ctx, [g.p(2.2, 0.5), g.p(2.8, 0.9)], ink, 1.6);
    polyline(ctx, [g.p(2.2, 2.1), g.p(2.8, 1.7)], ink, 1.6);
  }
  polyline(ctx, [g.p(2.5, 1.3), g.p(4, 1.3)], ink, 1.8);
  void comp;
}

function drawDiodeSymbol(ctx, comp, g) {
  drawDiodeSym(ctx, comp, g, false);
}

function drawZenerSymbol(ctx, comp, g) {
  drawDiodeSym(ctx, comp, g, true);
}

/** 三极管：圆圈 + 基极条 + 发射极箭头 */
function drawTransistorSym(ctx, comp, g) {
  const ink = g.color.ink;
  const cx = g.p(2.4, 2.5);
  ctx.beginPath();
  ctx.arc(cx.x, cx.y, Math.max(10, g.cell * 0.85), 0, Math.PI * 2);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  polyline(ctx, [g.p(0, 2.5), g.p(1.9, 2.5)], ink, 1.8);
  polyline(ctx, [g.p(1.9, 1.3), g.p(1.9, 3.7)], ink, 2.4);
  polyline(ctx, [g.p(1.9, 1.9), g.p(5, 0.8)], ink, 1.8);
  polyline(ctx, [g.p(1.9, 3.1), g.p(5, 4.2)], ink, 1.8);
  // 发射极箭头（NPN 朝外）
  const ex = g.p(3.9, 3.55);
  const angle = Math.atan2(g.p(5, 4.2).y - g.p(1.9, 3.1).y, g.p(5, 4.2).x - g.p(1.9, 3.1).x);
  ctx.beginPath();
  ctx.moveTo(ex.x, ex.y);
  ctx.lineTo(ex.x - 6 * Math.cos(angle - 0.4), ex.y - 6 * Math.sin(angle - 0.4));
  ctx.lineTo(ex.x - 6 * Math.cos(angle + 0.4), ex.y - 6 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = ink;
  ctx.fill();
  void comp;
}

/** 运放：三角 + 电源脚 */
function drawOpampSym(ctx, comp, g) {
  const ink = g.color.ink;
  const muted = g.color.muted;
  polyline(ctx, [g.p(0.5, 0.5), g.p(0.5, 5.5), g.p(5.5, 3), g.p(0.5, 0.5)], ink, 1.8);
  polyline(ctx, [g.p(0, 1.6), g.p(0.5, 1.6)], ink, 1.8);
  polyline(ctx, [g.p(0, 4.4), g.p(0.5, 4.4)], ink, 1.8);
  polyline(ctx, [g.p(5.5, 3), g.p(6, 3)], ink, 1.8);
  const fontSize = Math.max(8, Math.min(12, g.cell * 0.55));
  ctx.font = `600 ${fontSize}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+', g.p(1.1, 1.6).x, g.p(1.1, 1.6).y);
  ctx.fillText('−', g.p(1.1, 4.4).x, g.p(1.1, 4.4).y);
  polyline(ctx, [g.p(3, 0), g.p(3, 1.5)], ink, 1.4);
  polyline(ctx, [g.p(3, 6), g.p(3, 4.5)], ink, 1.4);
  ctx.font = `${Math.max(6, fontSize * 0.7)}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = muted;
  ctx.textAlign = 'left';
  ctx.fillText('V+', g.p(3.15, 0.5).x, g.p(3.15, 0.5).y);
  ctx.fillText('V−', g.p(3.15, 5.5).x, g.p(3.15, 5.5).y);
  void comp;
}

/** 电感：四段半圆 */
function drawInductorSym(ctx, comp, g) {
  const ink = g.color.ink;
  polyline(ctx, [g.p(0, 1.3), g.p(0.6, 1.3)], ink, 1.8);
  for (let i = 0; i < 4; i += 1) {
    const a = g.p(0.6 + i * 0.7, 1.3);
    const b = g.p(1.3 + i * 0.7, 1.3);
    ctx.beginPath();
    ctx.arc(a.x + (b.x - a.x) / 2, a.y, Math.abs(b.x - a.x) / 2, Math.PI, 0);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  polyline(ctx, [g.p(3.4, 1.3), g.p(4, 1.3)], ink, 1.8);
  void comp;
}

/** 蜂鸣器：圆 + 声波弧 */
function drawBuzzerSym(ctx, comp, g) {
  const ink = g.color.ink;
  const c = g.p(1.4, 1.5);
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(6, g.cell * 0.5), 0, Math.PI * 2);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  for (let i = 1; i <= 2; i += 1) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(6, g.cell * 0.5) + i * 4, -0.7, 0.7);
    ctx.stroke();
  }
  polyline(ctx, [g.p(0, 1.5), g.p(0.6, 1.5)], ink, 1.6);
  polyline(ctx, [g.p(2.2, 1.5), g.p(3, 1.5)], ink, 1.6);
  void comp;
}

/** 继电器：线圈框 + 触点 */
function drawRelaySym(ctx, comp, g) {
  const ink = g.color.ink;
  box(ctx, g, 0.6, 0.4, 3.4, 2.2);
  polyline(ctx, [g.p(0, 1.3), g.p(0.6, 1.3)], ink, 1.6);
  polyline(ctx, [g.p(3.4, 1.3), g.p(4, 1.3)], ink, 1.6);
  // 线圈折线
  polyline(ctx, [g.p(1.2, 1.8), g.p(1.6, 0.8), g.p(2.0, 1.8), g.p(2.4, 0.8), g.p(2.8, 1.8)], ink, 1.4);
  // 触点
  polyline(ctx, [g.p(0, 4), g.p(1.4, 4)], ink, 1.6);
  polyline(ctx, [g.p(1.4, 4), g.p(2.6, 3.2)], ink, 1.6);
  polyline(ctx, [g.p(4, 3), g.p(2.6, 3)], ink, 1.6);
  polyline(ctx, [g.p(4, 5), g.p(2.6, 5)], ink, 1.6);
  void comp;
}

/** 四位拨码：4 个小开关 */
function drawDip4Sym(ctx, comp, g) {
  const ink = g.color.ink;
  for (let i = 0; i < 4; i += 1) {
    const y = 0.8 + i * 1.2;
    const on = !comp.params || comp.params[`s${i + 1}`] !== false;
    polyline(ctx, [g.p(0, y), g.p(1, y)], ink, 1.4);
    polyline(ctx, [g.p(3, y), g.p(4, y)], ink, 1.4);
    polyline(ctx, [g.p(1, y), g.p(2.6, on ? y - 0.6 : y - 1.0)], ink, 1.4);
  }
}

/** 电位器：电阻 + 滑臂箭头 */
function drawPotSym(ctx, comp, g) {
  const ink = g.color.ink;
  // 竖向电阻
  polyline(ctx, [g.p(0, 0.4), g.p(0, 3.6)], ink, 1.8);
  const x = 0;
  polyline(ctx, [
    g.p(x, 1.0), g.p(x + 0.7, 1.2), g.p(x - 0.7, 1.8), g.p(x + 0.7, 2.4), g.p(x - 0.7, 3.0), g.p(x, 3.2),
  ], ink, 1.6);
  polyline(ctx, [g.p(0, 2), g.p(2.6, 2)], ink, 1.6);
  // 箭头
  polyline(ctx, [g.p(2.6, 2), g.p(2.1, 1.7)], ink, 1.4);
  polyline(ctx, [g.p(2.6, 2), g.p(2.1, 2.3)], ink, 1.4);
  void comp;
}

/* ==========================================================================
   符号注册表
   ========================================================================== */

/** 74 系列 14 个引脚：左侧 1..7，右侧 8..14（DIP-14 真实封装顺序） */
function buildIcPins() {
  const pins = [];
  for (let pin = 1; pin <= 7; pin += 1) {
    pins.push({
      name: String(pin),
      dx: 0,
      dy: pin,
      side: 'left',
      role: pin === 7 ? 'GND' : 'io',
    });
  }
  for (let pin = 8; pin <= 14; pin += 1) {
    pins.push({
      name: String(pin),
      dx: 7,
      dy: 15 - pin,
      side: 'right',
      role: pin === 14 ? 'VCC' : 'io',
    });
  }
  return pins;
}

/**
 * 符号定义表。
 * size  —— 未旋转占位（逻辑格）
 * pins  —— { name, dx, dy, side, role }，name 必须与 parts.js 的 terminals 对齐
 * draw  —— (ctx, comp, { p, cell, size, sym, color }) => void
 * label —— (comp) => string，画在符号下方的文字
 */
export const SYMBOLS = {
  resistor: {
    id: 'resistor',
    label: '电阻',
    size: { w: 4, h: 2.6 },
    pins: [
      { name: '1', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: '2', dx: 4, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawResistor,
    labelText: (comp) => `R ${formatOhm(comp.params.resistance)}`,
  },

  led: {
    id: 'led',
    label: 'LED',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: 'A', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: 'K', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawLed,
    labelText: () => 'LED',
  },

  switch: {
    id: 'switch',
    label: '开关',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: 'COM', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: 'NO', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawSwitch,
    labelText: (comp) => (comp.params.state === 'closed' ? 'SW 闭合' : 'SW'),
  },

  capacitor: {
    id: 'capacitor',
    label: '电容',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: '1', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: '2', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawCapacitor,
    labelText: (comp) => `C ${formatFarad(comp.params.capacitance)}`,
  },

  ic74xx: {
    id: 'ic74xx',
    label: '74LS 芯片',
    size: { w: 7, h: 8 },
    pins: buildIcPins(),
    draw: drawIc,
    labelText: (comp) => normalizeType(comp.params.type) || '74LS00',
  },

  vsource: {
    id: 'vsource',
    label: '电压源',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: '+', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: '-', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawVsource,
    labelText: (comp) => `E ${formatVolt(comp.params.voltage)}`,
  },

  isource: {
    id: 'isource',
    label: '电流源',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: '+', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: '-', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawIsource,
    labelText: (comp) => `I ${formatAmp(comp.params.current)}`,
  },

  'logic-switch': {
    id: 'logic-switch',
    label: '逻辑开关',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: 'OUT', dx: 3, dy: 1.3, side: 'right', role: 'out' },
    ],
    draw: drawLogicSwitch,
    labelText: (comp) => `SW ${comp.params.state === 'hi' ? 'H' : 'L'}`,
  },

  pulse: {
    id: 'pulse',
    label: '脉冲源',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: '+', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: '-', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawPulse,
    labelText: (comp) => (comp.params.mode === 'toggle' ? 'PULSE T' : 'PULSE'),
  },

  clock: {
    id: 'clock',
    label: '时钟源',
    size: { w: 3, h: 2.6 },
    pins: [
      { name: '+', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: 'GND', dx: 3, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawClock,
    labelText: (comp) => {
      const hz = Number(comp.params.frequency);
      return Number.isFinite(hz) ? `CLK ${hz}Hz` : 'CLK';
    },
  },

  /* ---- 混合信号边界元件（指令包 8） ---- */

  comparator: {
    id: 'comparator',
    label: '比较器',
    size: { w: 6, h: 6 },
    pins: [
      { name: '+', dx: 0, dy: 1.6, side: 'left', role: 'in' },
      { name: '-', dx: 0, dy: 4.4, side: 'left', role: 'in' },
      { name: 'OUT', dx: 6, dy: 3, side: 'right', role: 'out' },
      { name: 'V+', dx: 3, dy: 0, side: 'top', role: 'VCC' },
      { name: 'GND', dx: 3, dy: 6, side: 'bottom', role: 'GND' },
    ],
    draw: drawComparatorSym,
    labelText: (comp) => {
      const th = Number(comp.params.threshold);
      return Number.isFinite(th) ? `CMP ${th}V` : 'CMP';
    },
  },

  buffer74: {
    id: 'buffer74',
    label: '数字缓冲',
    size: { w: 4, h: 4 },
    pins: [
      { name: 'IN', dx: 0, dy: 1.5, side: 'left', role: 'in' },
      { name: 'OUT', dx: 4, dy: 1.5, side: 'right', role: 'out' },
      { name: 'VCC', dx: 2, dy: 0, side: 'top', role: 'VCC' },
      { name: 'GND', dx: 2, dy: 4, side: 'bottom', role: 'GND' },
    ],
    draw: drawBufferSym,
    labelText: () => 'BUF',
  },

  dac8: {
    id: 'dac8',
    label: '8 位 DAC',
    size: { w: 7, h: 9 },
    pins: (() => {
      const list = [];
      for (let i = 0; i < 8; i += 1) {
        list.push({ name: `D${i}`, dx: 0, dy: i + 1, side: 'left', role: 'in' });
      }
      list.push({ name: 'OUT', dx: 7, dy: 4.5, side: 'right', role: 'out' });
      list.push({ name: 'VCC', dx: 3.5, dy: 0, side: 'top', role: 'VCC' });
      list.push({ name: 'GND', dx: 3.5, dy: 9, side: 'bottom', role: 'GND' });
      return list;
    })(),
    draw: drawDacSym,
    labelText: () => 'DAC8',
  },

  adc8: {
    id: 'adc8',
    label: '8 位 ADC',
    size: { w: 7, h: 9 },
    pins: (() => {
      const list = [];
      for (let i = 0; i < 8; i += 1) {
        list.push({ name: `D${i}`, dx: 0, dy: i + 1, side: 'left', role: 'out' });
      }
      list.push({ name: 'IN', dx: 7, dy: 4.5, side: 'right', role: 'in' });
      list.push({ name: 'VCC', dx: 3.5, dy: 0, side: 'top', role: 'VCC' });
      list.push({ name: 'GND', dx: 3.5, dy: 9, side: 'bottom', role: 'GND' });
      return list;
    })(),
    draw: drawAdcSym,
    labelText: () => 'ADC8',
  },

  fgen: {
    id: 'fgen',
    label: '函数发生器',
    size: { w: 4, h: 4 },
    pins: [
      { name: 'OUT', dx: 4, dy: 2, side: 'right', role: 'out' },
      { name: 'GND', dx: 0, dy: 2, side: 'left', role: 'io' },
    ],
    draw(ctx, comp, g) {
      const ink = g.color.ink;
      ctx.beginPath();
      ctx.arc(g.p(2, 2).x, g.p(2, 2).y, g.cell * 0.95, 0, Math.PI * 2);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // 正弦符号
      ctx.beginPath();
      const c = g.p(2, 2);
      for (let i = 0; i <= 24; i += 1) {
        const x = c.x - g.cell * 0.55 + (i / 24) * g.cell * 1.1;
        const y = c.y - Math.sin((i / 24) * Math.PI * 2) * g.cell * 0.3;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      polyline(ctx, [g.p(0, 2), g.p(1.05, 2)], ink, 1.6);
      polyline(ctx, [g.p(2.95, 2), g.p(4, 2)], ink, 1.6);
      void comp;
    },
    labelText: (comp) => {
      const f = Number(comp.params.frequency);
      return Number.isFinite(f) ? `FG ${f}Hz` : 'FG';
    },
  },

  /* ---- 指令包 9 ---- */

  diode: {
    id: 'diode',
    label: '二极管',
    size: { w: 4, h: 2.6 },
    pins: [
      { name: 'A', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: 'K', dx: 4, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawDiodeSymbol,
    labelText: (comp) => `D ${comp.params.model || '1N4148'}`,
  },

  zener: {
    id: 'zener',
    label: '稳压管',
    size: { w: 4, h: 2.6 },
    pins: [
      { name: 'A', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: 'K', dx: 4, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawZenerSymbol,
    labelText: (comp) => `DZ ${comp.params.vz}V`,
  },

  transistor: {
    id: 'transistor',
    label: '三极管',
    size: { w: 5, h: 5 },
    pins: [
      { name: 'B', dx: 0, dy: 2.5, side: 'left', role: 'in' },
      { name: 'C', dx: 5, dy: 0.8, side: 'right', role: 'out' },
      { name: 'E', dx: 5, dy: 4.2, side: 'right', role: 'out' },
    ],
    draw: drawTransistorSym,
    labelText: (comp) => `Q ${comp.params.model || '2N2222'}`,
  },

  opamp: {
    id: 'opamp',
    label: '运算放大器',
    size: { w: 6, h: 6 },
    pins: [
      { name: '+', dx: 0, dy: 1.6, side: 'left', role: 'in' },
      { name: '-', dx: 0, dy: 4.4, side: 'left', role: 'in' },
      { name: 'OUT', dx: 6, dy: 3, side: 'right', role: 'out' },
      { name: 'V+', dx: 3, dy: 0, side: 'top', role: 'VCC' },
      { name: 'V-', dx: 3, dy: 6, side: 'bottom', role: 'GND' },
    ],
    draw: drawOpampSym,
    labelText: (comp) => String(comp.params.model || 'LM741'),
  },

  inductor: {
    id: 'inductor',
    label: '电感',
    size: { w: 4, h: 2.6 },
    pins: [
      { name: '1', dx: 0, dy: 1.3, side: 'left', role: 'io' },
      { name: '2', dx: 4, dy: 1.3, side: 'right', role: 'io' },
    ],
    draw: drawInductorSym,
    labelText: (comp) => `L ${(Number(comp.params.inductance) * 1000).toFixed(1)}mH`,
  },

  buzzer: {
    id: 'buzzer',
    label: '蜂鸣器',
    size: { w: 3, h: 3 },
    pins: [
      { name: '+', dx: 0, dy: 1.5, side: 'left', role: 'in' },
      { name: '-', dx: 3, dy: 1.5, side: 'right', role: 'in' },
    ],
    draw: drawBuzzerSym,
    labelText: () => 'BZ',
  },

  relay: {
    id: 'relay',
    label: '继电器',
    size: { w: 6, h: 6 },
    pins: [
      { name: 'COIL1', dx: 0, dy: 1.3, side: 'left', role: 'in' },
      { name: 'COIL2', dx: 0, dy: 3.7, side: 'left', role: 'in' },
      { name: 'COM', dx: 6, dy: 1.5, side: 'right', role: 'io' },
      { name: 'NO', dx: 6, dy: 3.5, side: 'right', role: 'io' },
      { name: 'NC', dx: 6, dy: 5.2, side: 'right', role: 'io' },
    ],
    draw: drawRelaySym,
    labelText: () => 'K',
  },

  dip4: {
    id: 'dip4',
    label: '4 位拨码',
    size: { w: 4, h: 5 },
    pins: [
      { name: '1A', dx: 0, dy: 0.8, side: 'left', role: 'io' },
      { name: '1B', dx: 4, dy: 0.8, side: 'right', role: 'io' },
      { name: '2A', dx: 0, dy: 2.0, side: 'left', role: 'io' },
      { name: '2B', dx: 4, dy: 2.0, side: 'right', role: 'io' },
      { name: '3A', dx: 0, dy: 3.2, side: 'left', role: 'io' },
      { name: '3B', dx: 4, dy: 3.2, side: 'right', role: 'io' },
      { name: '4A', dx: 0, dy: 4.4, side: 'left', role: 'io' },
      { name: '4B', dx: 4, dy: 4.4, side: 'right', role: 'io' },
    ],
    draw: drawDip4Sym,
    labelText: () => 'SW4',
  },

  pot: {
    id: 'pot',
    label: '电位器',
    size: { w: 4, h: 4 },
    pins: [
      { name: '1', dx: 0, dy: 0.4, side: 'left', role: 'io' },
      { name: '3', dx: 0, dy: 3.6, side: 'left', role: 'io' },
      { name: '2', dx: 4, dy: 2, side: 'right', role: 'io' },
    ],
    draw: drawPotSym,
    labelText: (comp) => `RP ${(Number(comp.params.resistance) / 1000).toFixed(0)}k`,
  },
};

/** 90° 旋转后引脚所在的边（保留，便于单步推导） */
const SIDE_ROTATED = { left: 'top', top: 'right', right: 'bottom', bottom: 'left' };

/** 引脚边的顺时针递进链 */
const SIDE_NEXT = { left: 'top', top: 'right', right: 'bottom', bottom: 'left' };

/** 把引脚边按旋转档位（0/90/180/270）顺时针递进，得到旋转后的边 */
function rotateSide(side, rotation) {
  if (!side) return side;
  let s = side;
  const steps = (((rotation / 90) % 4) + 4) % 4;
  for (let i = 0; i < steps; i += 1) s = SIDE_NEXT[s] || s;
  return s;
}

/* ==========================================================================
   工程单位格式化（与 parts.js 的 factor 约定一致：存储用基本单位）
   ========================================================================== */

/** 去掉浮点尾差与多余的 .0 */
function trimNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Number(value.toPrecision(4));
  return String(rounded);
}

/** 电阻：存储单位 Ω */
export function formatOhm(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return `${trimNumber(v / 1e6)}MΩ`;
  if (Math.abs(v) >= 1e3) return `${trimNumber(v / 1e3)}kΩ`;
  return `${trimNumber(v)}Ω`;
}

/** 电容：存储单位 F */
export function formatFarad(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e-3) return `${trimNumber(v * 1e3)}mF`;
  if (Math.abs(v) >= 1e-6) return `${trimNumber(v * 1e6)}μF`;
  if (Math.abs(v) >= 1e-9) return `${trimNumber(v * 1e9)}nF`;
  return `${trimNumber(v * 1e12)}pF`;
}

/* ==========================================================================
   查询 API
   ========================================================================== */

/** 取符号定义，未知类型返回 null */
export function getSymbol(type) {
  return Object.prototype.hasOwnProperty.call(SYMBOLS, type) ? SYMBOLS[type] : null;
}

/** 已注册的符号类型列表 */
export function listSymbols() {
  return Object.keys(SYMBOLS);
}

/**
 * 注册新符号（后续仿真包扩展元件时使用）。
 * 会校验 pins 的 name 不重复；覆盖已有类型时返回 false，避免误伤。
 */
export function registerSymbol(type, def) {
  if (typeof type !== 'string' || !type) return false;
  if (Object.prototype.hasOwnProperty.call(SYMBOLS, type)) return false;
  if (!def || !def.size || !Array.isArray(def.pins) || typeof def.draw !== 'function') return false;
  const names = new Set();
  for (const pin of def.pins) {
    if (!pin || typeof pin.name !== 'string') return false;
    if (names.has(pin.name)) return false;
    names.add(pin.name);
  }
  SYMBOLS[type] = { id: type, label: def.label || type, ...def };
  return true;
}

/** 符号占位（90° / 270° 交换宽高；0° / 180° 不变） */
export function symSize(type, rotation = 0) {
  const sym = getSymbol(type);
  if (!sym) return { w: 3, h: 2 };
  const { w, h } = sym.size;
  if (rotation === 90 || rotation === 270) return { w: h, h: w };
  return { w, h };
}

/**
 * 引脚在符号局部坐标中的位置（已含四向旋转）。
 * 统一绕符号中心旋转：
 *   90° 顺时针 → (h - dy, dx)
 *   180°      → (w - dx, h - dy)
 *   270°      → (dy, w - dx)
 */
export function pinPos(sym, pin, rotation = 0) {
  if (!sym || !pin) return null;
  const { dx, dy } = pin;
  const { w, h } = sym.size;
  if (rotation === 90) return { x: h - dy, y: dx };
  if (rotation === 270) return { x: dy, y: w - dx };
  if (rotation === 180) return { x: w - dx, y: h - dy };
  return { x: dx, y: dy };
}

/** 列出某类型在给定旋转下的全部引脚（含边与角色） */
export function pinList(type, rotation = 0) {
  const sym = getSymbol(type);
  if (!sym) return [];
  return sym.pins.map((pin) => {
    const pos = pinPos(sym, pin, rotation);
    return {
      name: pin.name,
      role: pin.role || 'io',
      side: rotateSide(pin.side, rotation),
      x: pos.x,
      y: pos.y,
    };
  });
}

/** 单个引脚的局部坐标；找不到返回 null */
export function pinByName(type, name, rotation = 0) {
  const sym = getSymbol(type);
  if (!sym) return null;
  const pin = sym.pins.find((item) => item.name === name);
  if (!pin) return null;
  const pos = pinPos(sym, pin, rotation);
  return {
    name: pin.name,
    role: pin.role || 'io',
    side: rotation === 90 ? (SIDE_ROTATED[pin.side] || pin.side) : pin.side,
    x: pos.x,
    y: pos.y,
  };
}

/** 符号下方的标签文字（含参数，如 R 2.2kΩ） */
export function symbolLabel(comp) {
  const sym = getSymbol(comp.type);
  if (!sym) return comp.type;
  try {
    return sym.labelText ? String(sym.labelText(comp)) : sym.label;
  } catch (err) {
    return sym.label;
  }
}

/* ==========================================================================
   绘制入口
   ========================================================================== */

/**
 * 绘制一个符号。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} comp 元件（读 type / params / rotation）
 * @param {object} style { x, y, cell, rotation, color:{ ink, muted, ... }, pinDots }
 */
export function drawSymbol(ctx, comp, style) {
  const sym = getSymbol(comp.type);
  if (!sym) return;
  const rotation = style.rotation || 0;
  const cell = style.cell;

  // 绘制函数一律按「未旋转」的局部坐标写，旋转交给画布变换。
  // 这样 5 套符号只需实现一次，旋转正确性只依赖这一处变换。
  const g = {
    ctx,
    cell,
    size: { w: sym.size.w, h: sym.size.h },
    sym,
    color: style.color,
    rotation,
    // 局部格 → 画布像素（平移由 ctx 承担）
    p: (dx, dy) => ({ x: dx * cell, y: dy * cell }),
  };

  ctx.save();
  ctx.translate(style.x, style.y);
  // 四向旋转：绕符号左上角应用与 pinPos 一致的变换（已验证引脚位置重合）
  if (rotation === 90) {
    ctx.translate(sym.size.h * cell, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(sym.size.w * cell, sym.size.h * cell);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, sym.size.w * cell);
    ctx.rotate(-Math.PI / 2);
  }
  sym.draw(ctx, comp, g);
  ctx.restore();
}

/** 符号在画布上的外接矩形（用于选中框） */
export function symbolRect(comp, x, y, cell) {
  const size = symSize(comp.type, comp.rotation || 0);
  return { x, y, w: size.w * cell, h: size.h * cell };
}
