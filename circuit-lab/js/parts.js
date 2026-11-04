/**
 * parts.js — 元件类型注册表
 *
 * 每个类型定义：
 *   size            未旋转时的网格占位（w × h，单位=孔位）
 *   terminals[]     { name, dx, dy, direction: 'in'|'out'|'bidir' }
 *   defaultParams   新建元件时的默认参数
 *   paramFields[]   右栏参数面板的表单字段描述
 *   draw(ctx, comp, style)  2.5D 外观绘制，style.frame 提供等距投影
 *
 * 绘制约定：只消费 style.frame.project(dx, dy)（dx/dy 为元件内部网格偏移），
 * 不直接接触画布原点，因此同一套 draw 既可用于主画布也可用于元件库图标。
 */

import { normalizeType, pinLabel, getDigModel, DIG_MODEL_ORDER, DIG_MODELS } from './digmodels.js';

/* ==========================================================================
   等距绘制基元
   ========================================================================== */

/** 填充一个多边形 */
export function poly(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

/** 把点整体上移 */
export function lift(point, height) {
  return { x: point.x, y: point.y - height };
}

/**
 * 画一个从网格矩形 [gx0..gx1] × [gy0..gy1] 立起来的等距棱柱。
 * 只绘制朝向观察者的两个侧面 + 顶面，保证遮挡关系正确。
 */
export function prism(ctx, frame, gx0, gy0, gx1, gy1, height, top, side1, side2, edge) {
  const a = frame.project(gx0, gy0);
  const b = frame.project(gx1, gy0);
  const c = frame.project(gx1, gy1);
  const d = frame.project(gx0, gy1);

  const at = lift(a, height);
  const bt = lift(b, height);
  const ct = lift(c, height);
  const dt = lift(d, height);

  // 右侧面 b-c，左侧面 c-d（c 是离观察者最近的点）
  poly(ctx, [bt, ct, c, b]);
  ctx.fillStyle = side1;
  ctx.fill();

  poly(ctx, [ct, dt, d, c]);
  ctx.fillStyle = side2;
  ctx.fill();

  poly(ctx, [at, bt, ct, dt]);
  ctx.fillStyle = top;
  ctx.fill();

  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** 在元件端子位置画一个金属接点 */
function drawLead(ctx, from, to, color, width) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** 元件下方投影：让元件"坐"在台面上 */
function drawContactShadow(ctx, frame, gx0, gy0, gx1, gy1) {
  // LOD 降档（拖拽/缩放中）直接跳过：接触阴影是纯装饰，省下来的填充很可观
  if (frame.flat) return;
  const a = frame.project(gx0, gy0);
  const b = frame.project(gx1, gy0);
  const c = frame.project(gx1, gy1);
  const d = frame.project(gx0, gy1);
  poly(ctx, [a, b, c, d]);
  ctx.fillStyle = 'rgba(24, 24, 34, 0.14)';
  ctx.fill();
}

/* ==========================================================================
   各类型绘制
   ========================================================================== */

/** 电阻：米色柱体 + 三道色环 */
function drawResistor(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;

  drawContactShadow(ctx, frame, 0.15, 0.12, frame.w - 0.15, frame.h - 0.12);

  const body0 = 0.55;
  const body1 = frame.w - 0.55;
  const cy0 = 0.18;
  const cy1 = frame.h - 0.18;

  prism(ctx, frame, body0, cy0, body1, cy1, 9, '#e2d6b4', '#b8a87f', '#a0916c', 'rgba(60,52,36,0.45)');

  // 引线：从端子引到本体两端
  const leadColor = '#9aa0ae';
  const t1 = frame.project(0, 0);
  const t2 = frame.project(frame.w - 1, 0);
  const b1 = frame.project(body0, (cy0 + cy1) / 2);
  const b2 = frame.project(body1, (cy0 + cy1) / 2);
  drawLead(ctx, t1, b1, leadColor, 2);
  drawLead(ctx, t2, b2, leadColor, 2);

  // 色环（沿本体等距分布）
  const bands = ['#8c4a3c', '#c9772f', '#d8b34a'];
  const span = body1 - body0;
  bands.forEach((color, index) => {
    const gx = body0 + span * (0.24 + index * 0.2);
    const p0 = lift(frame.project(gx, cy0), 9);
    const p1 = lift(frame.project(gx, cy1), 9);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  });

  if (pinLabels) {
    drawPinLabel(ctx, t1, '1');
    drawPinLabel(ctx, t2, '2');
  }
}

/** LED：半透明灯珠 + 底座 */
function drawLed(ctx, comp, style) {
  const { frame, pinLabels } = style;
  const palette = {
    red: '#e2685f', green: '#5fd39a', yellow: '#f2c94c', blue: '#6fa8f2',
  };
  const color = palette[comp.params.color] || palette.red;

  drawContactShadow(ctx, frame, 0.15, 0.12, frame.w - 0.15, frame.h - 0.12);
  prism(ctx, frame, 0.28, 0.16, frame.w - 0.28, frame.h - 0.16, 4, '#3a3a48', '#23232d', '#1c1c25', 'rgba(0,0,0,0.5)');

  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 5);
  const radius = Math.max(6, Math.min(frame.tileW * 0.42, 13));

  // 灯珠：外圈 + 高光
  ctx.beginPath();
  ctx.arc(center.x, center.y - radius * 0.55, radius, Math.PI, 0);
  ctx.lineTo(center.x + radius, center.y + 1);
  ctx.lineTo(center.x - radius, center.y + 1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(center.x - radius * 0.3, center.y - radius * 0.9, radius * 0.26, radius * 0.4, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fill();

  // 引线
  drawLead(ctx, frame.project(0, 0), frame.project(0.3, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(frame.w - 0.3, frame.h / 2 - 0.5), '#9aa0ae', 1.6);

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), 'A');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), 'K');
  }
}

/** 开关：底座 + 可动拨杆（state 只影响外观，不参与仿真） */
function drawSwitch(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.15, 0.12, frame.w - 0.15, frame.h - 0.12);
  prism(ctx, frame, 0.22, 0.14, frame.w - 0.22, frame.h - 0.14, 6, '#4a4a5c', '#2e2e3b', '#262631', 'rgba(0,0,0,0.5)');

  const closed = comp.params.state === 'closed';
  const pivot = lift(frame.project(0.5, frame.h / 2 - 0.5), 7);
  const tip = lift(frame.project(frame.w - 0.62, frame.h / 2 - 0.5), closed ? 7 : 11);

  drawLead(ctx, pivot, tip, closed ? '#f2a93b' : '#9aa0b8', 3);

  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#c8ccd8';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = closed ? '#f2a93b' : '#c8ccd8';
  ctx.fill();

  drawLead(ctx, frame.project(0, 0), frame.project(0.22, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(frame.w - 0.22, frame.h / 2 - 0.5), '#9aa0ae', 1.6);

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), 'COM');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), 'NO');
  }
}

/** 电容：两片极板 */
function drawCapacitor(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.15, 0.12, frame.w - 0.15, frame.h - 0.12);
  prism(ctx, frame, 0.25, 0.16, frame.w - 0.25, frame.h - 0.16, 5, '#33405c', '#232c40', '#1b2334', 'rgba(0,0,0,0.5)');

  const mid = frame.w / 2;
  const plateTop = lift(frame.project(mid - 0.12, 0.1), 5);
  const plateBot = lift(frame.project(mid - 0.12, frame.h - 0.1), 5);
  const plateTop2 = lift(frame.project(mid + 0.12, 0.1), 5);
  const plateBot2 = lift(frame.project(mid + 0.12, frame.h - 0.1), 5);

  ctx.beginPath();
  ctx.moveTo(plateTop.x, plateTop.y);
  ctx.lineTo(plateBot.x, plateBot.y);
  ctx.moveTo(plateTop2.x, plateTop2.y);
  ctx.lineTo(plateBot2.x, plateBot2.y);
  ctx.strokeStyle = '#cfd6e6';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  drawLead(ctx, frame.project(0, 0), frame.project(mid - 0.3, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(mid + 0.3, frame.h / 2 - 0.5), '#9aa0ae', 1.6);

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '1');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), '2');
  }
}

/** 74 系列 DIP 芯片壳：黑色本体 + 缺口 + 两排引脚 */
function drawIc(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.05, 0.55, frame.w - 0.05, frame.h - 0.55);
  prism(ctx, frame, 0.1, 0.55, frame.w - 0.1, frame.h - 0.55, 8, '#32323e', '#1e1e26', '#191920', 'rgba(0,0,0,0.55)');

  // 14 脚（ic74xx）/ 16 脚（ic74xx16）共用这一套画法：
  // 端子几何、顶边脚数、电源脚位置全部从元件定义与数字模型读，不再写死
  const def = PARTS[comp.type] || PARTS.ic74xx;
  const model = getDigModel(comp.type, comp.params);
  const powerPins = model ? [model.power.gnd, model.power.vcc] : ['7', '14'];
  const topCount = def.terminals.filter((t) => t.dy === 0).length;
  const pinColor = '#c2c7d4';
  for (let i = 0; i < topCount; i += 1) {
    const from = frame.project(0.1 + i, 0.55);
    const to = frame.project(i, 0);
    drawLead(ctx, from, to, pinColor, 1.6);
    const from2 = frame.project(0.1 + i, frame.h - 0.55);
    const to2 = frame.project(i, frame.h - 1);
    drawLead(ctx, from2, to2, pinColor, 1.6);
  }

  // 缺口：靠近 1 脚的半圆
  const notch = lift(frame.project(0.5, 0.55), 8);
  ctx.beginPath();
  ctx.arc(notch.x, notch.y, Math.max(2.5, frame.tileW * 0.13), 0, Math.PI * 2);
  ctx.fillStyle = '#12121a';
  ctx.fill();

  // 型号丝印
  const label = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 8);
  const size = Math.max(7, Math.min(11, frame.tileW * 0.3));
  ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = 'rgba(226, 231, 242, 0.78)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(comp.params.type || (def.defaultParams && def.defaultParams.type) || '74LS00'),
    label.x, label.y);

  if (pinLabels) {
    const modelId = normalizeType(comp.params.type);
    def.terminals.forEach((t) => {
      const name = pinLabel(modelId, t.name);
      // 电源脚用琥珀色强调：接错 7/14（或 8/16）是实验台上最常见的"不工作"原因
      drawPinLabel(ctx, frame.project(t.dx, t.dy), name, powerPins.includes(t.name));
    });
  }
}

/** 电压源：深色电源模块 + 顶面 ＋/− 标记 */
function drawVsource(ctx, comp, style) {
  drawSourceBase(ctx, style, true);
  const { frame, pinLabels } = style;
  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 7);
  const size = Math.max(4.5, Math.min(8, frame.tileW * 0.42));
  const ink = '#f2a93b';

  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  // 长板（正极）
  ctx.beginPath();
  ctx.moveTo(center.x - size * 0.55, center.y - size * 0.7);
  ctx.lineTo(center.x - size * 0.55, center.y + size * 0.7);
  ctx.stroke();
  // 短板（负极）
  ctx.beginPath();
  ctx.moveTo(center.x + size * 0.55, center.y - size * 0.38);
  ctx.lineTo(center.x + size * 0.55, center.y + size * 0.38);
  ctx.stroke();

  const voltage = Number(comp.params.voltage);
  if (Number.isFinite(voltage) && voltage < 0) {
    // 反接：在模块下方画一个向下的箭头，避免只能靠端子小字辨认
    const tip = lift(frame.project(frame.w / 2 - 0.5, frame.h - 0.1), 6);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y - 5);
    ctx.lineTo(tip.x, tip.y + 3);
    ctx.moveTo(tip.x - 3, tip.y);
    ctx.lineTo(tip.x, tip.y + 3);
    ctx.lineTo(tip.x + 3, tip.y);
    ctx.stroke();
  }

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '+');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), '−');
  }
}

/** 电流源：深色电源模块 + 顶面指向 − 端的箭头 */
function drawIsource(ctx, comp, style) {
  drawSourceBase(ctx, style, true);
  const { frame, pinLabels } = style;
  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 7);
  const size = Math.max(5, Math.min(9, frame.tileW * 0.46));

  ctx.strokeStyle = '#6fb2d8';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(center.x - size * 0.75, center.y);
  ctx.lineTo(center.x + size * 0.55, center.y);
  ctx.moveTo(center.x + size * 0.15, center.y - size * 0.38);
  ctx.lineTo(center.x + size * 0.6, center.y);
  ctx.lineTo(center.x + size * 0.15, center.y + size * 0.38);
  ctx.stroke();

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '+');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), '−');
  }
}

/** 逻辑电平开关：单端子拨动开关，拨杆抬起 = 高电平 */
function drawLogicSwitch(ctx, comp, style) {
  const { frame, pinLabels } = style;
  const hi = comp.params.state === 'hi';
  drawContactShadow(ctx, frame, 0.15, 0.12, frame.w - 0.15, frame.h - 0.12);
  prism(
    ctx, frame, 0.24, 0.14, frame.w - 0.24, frame.h - 0.14, 6,
    hi ? '#4a4433' : '#3a3a48', hi ? '#322d20' : '#26262f', hi ? '#272318' : '#1e1e26',
    'rgba(0,0,0,0.5)',
  );

  // 拨杆：低电平倒向左侧，高电平倒向右侧并抬高
  const base = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 6);
  const tipX = base.x + (hi ? 1 : -1) * Math.max(3, frame.tileW * 0.24);
  const tipY = base.y - Math.max(6, frame.tileH * 0.9);
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(tipX, tipY);
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = hi ? '#f2a93b' : '#9aa0b8';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(tipX, tipY, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = hi ? '#f2a93b' : '#c8ccd8';
  ctx.fill();

  // 高/低标记
  const mark = lift(frame.project(0.55, frame.h - 0.55), 6);
  ctx.font = `${Math.max(7, Math.min(9, frame.tileW * 0.3))}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hi ? 'rgba(242, 169, 59, 0.92)' : 'rgba(150, 158, 175, 0.9)';
  ctx.fillText(hi ? '1' : '0', mark.x, mark.y);

  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(frame.w - 0.26, frame.h / 2 - 0.5), '#9aa0ae', 1.6);

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), 'OUT');
  }
}

/** 脉冲源：按键帽 + 脉冲波形，按一次发一个上升沿 */
function drawPulse(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawSourceBase(ctx, style, false);

  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 7);
  const radius = Math.max(4, Math.min(7, frame.tileW * 0.34));
  ctx.beginPath();
  ctx.arc(center.x, center.y - radius * 0.35, radius, 0, Math.PI * 2);
  ctx.fillStyle = comp.params.mode === 'toggle' ? '#4a6a8c' : '#5a5f74';
  ctx.fill();
  ctx.strokeStyle = 'rgba(210, 220, 240, 0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 键帽上的脉冲符号
  const w = radius * 0.55;
  ctx.beginPath();
  ctx.moveTo(center.x - w, center.y - radius * 0.35 + w * 0.5);
  ctx.lineTo(center.x - w * 0.3, center.y - radius * 0.35 + w * 0.5);
  ctx.lineTo(center.x - w * 0.3, center.y - radius * 0.35 - w * 0.5);
  ctx.lineTo(center.x + w * 0.4, center.y - radius * 0.35 - w * 0.5);
  ctx.lineTo(center.x + w * 0.4, center.y - radius * 0.35 + w * 0.5);
  ctx.lineTo(center.x + w, center.y - radius * 0.35 + w * 0.5);
  ctx.strokeStyle = '#e8eefc';
  ctx.lineWidth = 1.3;
  ctx.stroke();

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '+');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), '−');
  }
}

/** 时钟源：方波图标 + 频率丝印 */
function drawClock(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawSourceBase(ctx, style, true);

  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 7);
  const size = Math.max(4, Math.min(7, frame.tileW * 0.34));

  ctx.beginPath();
  ctx.moveTo(center.x - size, center.y + size * 0.5);
  ctx.lineTo(center.x - size * 0.5, center.y + size * 0.5);
  ctx.lineTo(center.x - size * 0.5, center.y - size * 0.5);
  ctx.lineTo(center.x + size * 0.2, center.y - size * 0.5);
  ctx.lineTo(center.x + size * 0.2, center.y + size * 0.5);
  ctx.lineTo(center.x + size, center.y + size * 0.5);
  ctx.strokeStyle = '#7fd6c2';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const hz = Number(comp.params.frequency);
  if (Number.isFinite(hz)) {
    ctx.font = `${Math.max(6.5, Math.min(8.5, frame.tileW * 0.26))}px "Cascadia Mono", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(180, 200, 215, 0.8)';
    ctx.fillText(`${hz}Hz`, center.x, center.y + size * 1.35);
  }

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '+');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), 'GND');
  }
}

/* ==========================================================================
   混合信号边界元件（指令包 8）
   ========================================================================== */

/**
 * 比较器：小 DIP 壳 + 三角符号。
 * 端子：左「+ / −」，右「OUT / V+ / GND」——与真实 LM393 的双列封装不同，
 * 这里按教学接线习惯排成单排，避免 8 脚小芯片在面包板上跨度过大。
 */
function drawComparator(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.1, 0.12, frame.w - 0.1, frame.h - 0.12);
  prism(ctx, frame, 0.3, 0.22, frame.w - 0.3, frame.h - 0.22, 7, '#333a4e', '#1e2332', '#181c28', 'rgba(0,0,0,0.55)');

  const a = lift(frame.project(0.8, 0.62), 7);
  const b = lift(frame.project(0.8, frame.h - 0.62), 7);
  const c = lift(frame.project(frame.w - 0.7, frame.h / 2 - 0.5), 7);
  poly(ctx, [a, b, c]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(242, 169, 59, 0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 引线：每个端子接到本体边缘
  const def = PARTS.comparator;
  def.terminals.forEach((t) => {
    const to = frame.project(t.dx, t.dy);
    const from = frame.project(
      t.dx === 0 ? 0.3 : frame.w - 0.3,
      Math.min(frame.h - 0.3, Math.max(0.3, t.dy)),
    );
    drawLead(ctx, to, from, '#c2c7d4', 1.5);
  });

  if (pinLabels) {
    def.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name, t.name === 'V+' || t.name === 'GND');
    });
  }
}

/** 数字缓冲：4 脚小芯片 + 缓冲三角 */
function drawBuffer(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;
  drawContactShadow(ctx, frame, 0.12, 0.12, frame.w - 0.12, frame.h - 0.12);
  prism(ctx, frame, 0.34, 0.24, frame.w - 0.34, frame.h - 0.24, 6, '#31405a', '#1d2738', '#171f2d', 'rgba(0,0,0,0.55)');

  const a = lift(frame.project(0.52, 0.38), 6);
  const b = lift(frame.project(0.52, frame.h - 0.38), 6);
  const c = lift(frame.project(frame.w - 0.52, frame.h / 2 - 0.5), 6);
  poly(ctx, [a, b, c]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(127, 214, 194, 0.85)';
  ctx.fill();

  const def = PARTS.buffer74;
  def.terminals.forEach((t) => {
    const to = frame.project(t.dx, t.dy);
    const from = frame.project(
      t.dx === 0 ? 0.34 : frame.w - 0.34,
      Math.min(frame.h - 0.34, Math.max(0.34, t.dy)),
    );
    drawLead(ctx, to, from, '#c2c7d4', 1.5);
  });

  if (pinLabels) {
    def.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name, t.name === 'VCC' || t.name === 'GND');
    });
  }
}

/**
 * 8 位 DAC / ADC 的共用外壳：宽体芯片 + 顶部 8 个数据脚 + 底部 3 个脚。
 * 数据脚按 D0（最低位）在左、D7（最高位）在右排布，丝印直接写位号。
 */
function drawWideChip(ctx, style, label, accent, bottomLabel) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.05, 0.55, frame.w - 0.05, frame.h - 0.55);
  prism(
    ctx, frame, 0.12, 0.55, frame.w - 0.12, frame.h - 0.55, 8,
    '#32323e', '#1e1e26', '#191920', 'rgba(0,0,0,0.55)',
  );

  // 顶部 8 个数据脚
  for (let i = 0; i < 8; i += 1) {
    drawLead(ctx, frame.project(i, 0), frame.project(0.12 + i, 0.55), '#c2c7d4', 1.4);
    const dot = lift(frame.project(0.12 + i, 0.62), 8);
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 1.3, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
  // 底部 3 个脚
  [0, 3, 5].forEach((col) => {
    drawLead(ctx, frame.project(col, frame.h - 1), frame.project(0.12 + col, frame.h - 0.55), '#c2c7d4', 1.4);
  });

  // 缺口
  const notch = lift(frame.project(0.5, 0.55), 8);
  ctx.beginPath();
  ctx.arc(notch.x, notch.y, Math.max(2.5, frame.tileW * 0.13), 0, Math.PI * 2);
  ctx.fillStyle = '#12121a';
  ctx.fill();

  // 丝印
  const title = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 8);
  const size = Math.max(7, Math.min(12, frame.tileW * 0.32));
  ctx.font = `700 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, title.x, title.y);

  if (pinLabels) {
    for (let i = 0; i < 8; i += 1) {
      drawPinLabel(ctx, frame.project(i, 0), `D${i}`);
    }
    drawPinLabel(ctx, frame.project(0, frame.h - 1), bottomLabel);
    drawPinLabel(ctx, frame.project(3, frame.h - 1), 'VCC', true);
    drawPinLabel(ctx, frame.project(5, frame.h - 1), 'GND', true);
  }
}

function drawDac8(ctx, comp, style) {
  void comp;
  drawWideChip(ctx, style, 'DAC8', 'rgba(242, 169, 59, 0.9)', 'OUT');
}

function drawAdc8(ctx, comp, style) {
  void comp;
  drawWideChip(ctx, style, 'ADC8', 'rgba(127, 214, 194, 0.9)', 'IN');
}

/* ==========================================================================
   指令包 9：分立元件外观
   ========================================================================== */

/** 二极管/稳压管：小圆柱 + 色环（稳压管多一道折线标记） */
function drawDiodeBody(ctx, comp, style, zener) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.18, 0.14, frame.w - 0.18, frame.h - 0.14);
  prism(ctx, frame, 0.42, 0.16, frame.w - 0.42, frame.h - 0.16, 6, '#2f3542', '#1c212b', '#151a22', 'rgba(0,0,0,0.5)');

  const mid = frame.w / 2;
  const band0 = lift(frame.project(mid - 0.12, 0.16), 6);
  const band1 = lift(frame.project(mid - 0.12, frame.h - 0.16), 6);
  ctx.beginPath();
  ctx.moveTo(band0.x, band0.y);
  ctx.lineTo(band1.x, band1.y);
  ctx.strokeStyle = zener ? '#f2a93b' : '#cfd6e6';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  if (zener) {
    // 稳压管：色环上加两道小折线（Z 形）
    const z0 = lift(frame.project(mid + 0.16, 0.2), 6);
    const z1 = lift(frame.project(mid + 0.16, frame.h - 0.2), 6);
    ctx.beginPath();
    ctx.moveTo(z0.x - 2, z0.y);
    ctx.lineTo(z0.x + 2, z0.y + 2);
    ctx.lineTo(z1.x - 2, z1.y - 2);
    ctx.lineTo(z1.x + 2, z1.y);
    ctx.strokeStyle = '#f2a93b';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  drawLead(ctx, frame.project(0, 0), frame.project(0.42, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(frame.w - 0.42, frame.h / 2 - 0.5), '#9aa0ae', 1.6);

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), 'A');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), 'K');
  }
}

function drawDiode(ctx, comp, style) {
  drawDiodeBody(ctx, comp, style, false);
}

function drawZener(ctx, comp, style) {
  drawDiodeBody(ctx, comp, style, true);
}

/** 三极管：TO-92 半圆壳 + B/C/E 三根引线 */
function drawTransistor(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;
  drawContactShadow(ctx, frame, 0.7, 0.5, frame.w - 0.7, frame.h - 0.5);
  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 4);
  const radius = Math.max(7, Math.min(frame.tileW * 0.62, 15));
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, Math.PI * 0.95, Math.PI * 2.05);
  ctx.closePath();
  ctx.fillStyle = '#333a4a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ['B', 'C', 'E'].forEach((name) => {
    const pin = PARTS.transistor.terminals.find((t) => t.name === name);
    drawLead(ctx, frame.project(pin.dx, pin.dy), center, '#c2c7d4', 1.4);
  });

  if (pinLabels) {
    PARTS.transistor.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name);
    });
  }
}

/** 运放：DIP-8 黑色本体 + 缺口 + 5 个引脚 */
function drawOpamp(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;
  drawContactShadow(ctx, frame, 0.05, 0.5, frame.w - 0.05, frame.h - 0.5);
  prism(ctx, frame, 0.12, 0.5, frame.w - 0.12, frame.h - 0.5, 8, '#32323e', '#1e1e26', '#191920', 'rgba(0,0,0,0.55)');

  const def = PARTS.opamp;
  def.terminals.forEach((t) => {
    const to = frame.project(t.dx, t.dy);
    const from = frame.project(
      t.dx === 0 ? 0.12 : (t.dx === frame.w - 1 ? frame.w - 0.12 : t.dx),
      t.dy === 0 ? 0.5 : (t.dy === frame.h - 1 ? frame.h - 0.5 : t.dy),
    );
    drawLead(ctx, to, from, '#c2c7d4', 1.4);
  });

  const notch = lift(frame.project(0.5, 0.5), 8);
  ctx.beginPath();
  ctx.arc(notch.x, notch.y, Math.max(2.5, frame.tileW * 0.13), 0, Math.PI * 2);
  ctx.fillStyle = '#12121a';
  ctx.fill();

  const label = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 8);
  const size = Math.max(7, Math.min(11, frame.tileW * 0.32));
  ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = 'rgba(226, 231, 242, 0.8)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(comp.params.model || '741'), label.x, label.y);

  if (pinLabels) {
    def.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name, t.name === 'V+' || t.name === 'V-');
    });
  }
}

/** 电感：底座 + 三个线圈弧 */
function drawInductor(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;
  drawContactShadow(ctx, frame, 0.2, 0.14, frame.w - 0.2, frame.h - 0.14);
  prism(ctx, frame, 0.45, 0.16, frame.w - 0.45, frame.h - 0.16, 5, '#3a2f28', '#241d18', '#1b1612', 'rgba(0,0,0,0.5)');

  const base = lift(frame.project(0.55, frame.h - 0.28), 5);
  const radius = Math.max(3, frame.tileW * 0.2);
  for (let i = 0; i < 3; i += 1) {
    const p = lift(frame.project(0.85 + i * 0.48, frame.h - 0.28), 5);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, Math.PI, 0);
    ctx.strokeStyle = '#c98b52';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  void base;

  drawLead(ctx, frame.project(0, 0), frame.project(0.45, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(frame.w - 0.45, frame.h / 2 - 0.5), '#9aa0ae', 1.6);

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '1');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), '2');
  }
}

/** 蜂鸣器：圆柱壳 + 出声孔 */
function drawBuzzer(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;
  drawContactShadow(ctx, frame, 0.2, 0.16, frame.w - 0.2, frame.h - 0.16);
  prism(ctx, frame, 0.3, 0.2, frame.w - 0.3, frame.h - 0.2, 9, '#2a2a34', '#1a1a22', '#141419', 'rgba(0,0,0,0.55)');

  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 9);
  const radius = Math.max(4, Math.min(frame.tileW * 0.34, 9));
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#0f0f14';
  ctx.fill();
  for (let i = -1; i <= 1; i += 1) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * (0.35 + 0.22 * (i + 1)), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(180, 190, 210, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  if (pinLabels) {
    drawPinLabel(ctx, frame.project(0, 0), '+');
    drawPinLabel(ctx, frame.project(frame.w - 1, 0), '−');
  }
}

/** 继电器：蓝色外壳 + 线圈/触点丝印 */
function drawRelay(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.08, 0.14, frame.w - 0.08, frame.h - 0.14);
  prism(ctx, frame, 0.16, 0.18, frame.w - 0.16, frame.h - 0.18, 8, '#3a5a8a', '#22385a', '#19293f', 'rgba(0,0,0,0.55)');

  const def = PARTS.relay;
  def.terminals.forEach((t) => {
    const to = frame.project(t.dx, t.dy);
    const from = frame.project(
      t.dx === 0 ? 0.16 : (t.dx === frame.w - 1 ? frame.w - 0.16 : t.dx),
      t.dy === 0 ? 0.18 : (t.dy === frame.h - 1 ? frame.h - 0.18 : t.dy),
    );
    drawLead(ctx, to, from, '#c2c7d4', 1.4);
  });

  const label = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 8);
  const size = Math.max(6, Math.min(9, frame.tileW * 0.26));
  ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = 'rgba(226, 231, 242, 0.78)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RELAY', label.x, label.y);

  if (pinLabels) {
    def.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name);
    });
  }
}

/** 四位拨码：红色本体 + 4 个白色拨杆 */
function drawDip4(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawContactShadow(ctx, frame, 0.1, 0.14, frame.w - 0.1, frame.h - 0.14);
  prism(ctx, frame, 0.18, 0.2, frame.w - 0.18, frame.h - 0.2, 5, '#b8452f', '#7d2c1e', '#5d2016', 'rgba(0,0,0,0.5)');

  for (let i = 0; i < 4; i += 1) {
    const on = !comp.params || comp.params[`s${i + 1}`] !== 'off';
    const p = lift(frame.project(0.5 + i * 2, frame.h / 2 - 0.5), 6);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, Math.max(2, frame.tileW * 0.12), Math.max(4, frame.tileH * 0.35), on ? -0.3 : 0.3, 0, Math.PI * 2);
    ctx.fillStyle = '#f0ece0';
    ctx.fill();
  }

  if (pinLabels) {
    PARTS.dip4.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name);
    });
  }
}

/** 电位器：方形本体 + 一字螺丝槽 */
function drawPot(ctx, comp, style) {
  const { frame, pinLabels } = style;
  void comp;
  drawContactShadow(ctx, frame, 0.14, 0.14, frame.w - 0.14, frame.h - 0.14);
  prism(ctx, frame, 0.28, 0.22, frame.w - 0.28, frame.h - 0.22, 6, '#3d445c', '#262c3c', '#1e2331', 'rgba(0,0,0,0.5)');

  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 6);
  const radius = Math.max(4, Math.min(frame.tileW * 0.3, 8));
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#b9c0ce';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(center.x - radius * 0.6, center.y);
  ctx.lineTo(center.x + radius * 0.6, center.y);
  ctx.strokeStyle = '#2b2f3a';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (pinLabels) {
    PARTS.pot.terminals.forEach((t) => {
      drawPinLabel(ctx, frame.project(t.dx, t.dy), t.name);
    });
  }
}

/** 函数发生器：带波形丝印的小模块 */
function drawFgen(ctx, comp, style) {
  const { frame, pinLabels } = style;
  drawSourceBase(ctx, style, true);
  const center = lift(frame.project(frame.w / 2 - 0.5, frame.h / 2 - 0.5), 7);
  const size = Math.max(9, Math.min(13, frame.tileW * 0.42));
  ctx.font = `600 ${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.fillStyle = '#7fd6c2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const wave = comp.params && comp.params.wave;
  ctx.fillText(wave === 'square' ? '⎍' : wave === 'triangle' ? '⋀' : '∿', center.x, center.y);
  void pinLabels;
}

/** 电源类共用的底座：深色矮模块 + 两侧引线 */
function drawSourceBase(ctx, style, accent) {
  const { frame } = style;
  drawContactShadow(ctx, frame, 0.15, 0.12, frame.w - 0.15, frame.h - 0.12);
  prism(
    ctx, frame, 0.26, 0.14, frame.w - 0.26, frame.h - 0.14, 7,
    accent ? '#3d445c' : '#3a3a48', '#262c3c', '#1e2331', 'rgba(0,0,0,0.5)',
  );
  drawLead(ctx, frame.project(0, 0), frame.project(0.28, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
  drawLead(ctx, frame.project(frame.w - 1, 0), frame.project(frame.w - 0.28, frame.h / 2 - 0.5), '#9aa0ae', 1.6);
}

/** 端子旁的小字标签 */
function drawPinLabel(ctx, point, text, highlight) {
  const size = 8.5;
  ctx.font = `${size}px "Cascadia Mono", Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = highlight ? 'rgba(242, 169, 59, 0.95)' : 'rgba(60, 66, 82, 0.85)';
  ctx.fillText(text, point.x, point.y - 7);
}

/* ==========================================================================
   类型注册表
   ========================================================================== */

/**
 * 型号下拉选项按**封装脚数**过滤。
 * 14 脚座（ic74xx）不能列 16 脚芯片，反之亦然——否则学生把 74LS160 插进 14 脚座，
 * 实物画不出 8/16 脚，逻辑求解也会按错的电源脚接法报"不工作"。
 * 脚数唯一来源是数字模型的 power.vcc（'14' / '16'），不另维护一张表。
 */
function modelOptionsByPins(pinCount) {
  return DIG_MODEL_ORDER
    .filter((id) => {
      const model = DIG_MODELS[id];
      return Boolean(model && model.power && Number(model.power.vcc) === pinCount);
    })
    .map((id) => ({ value: id, label: DIG_MODELS[id].label }));
}

export const PARTS = {
  resistor: {
    id: 'resistor',
    label: '电阻',
    group: '基础元件',
    size: { w: 3, h: 1 },
    terminals: [
      { name: '1', dx: 0, dy: 0, direction: 'bidir' },
      { name: '2', dx: 2, dy: 0, direction: 'bidir' },
    ],
    defaultParams: { resistance: 1000 },
    paramFields: [
      {
        key: 'resistance',
        label: '阻值',
        type: 'number',
        unit: 'kΩ',
        factor: 1000, // 存储单位 Ω，界面单位 kΩ
        step: 0.1,
        min: 0.001,
        max: 1000,
      },
    ],
    draw: drawResistor,
  },

  led: {
    id: 'led',
    label: 'LED',
    group: '基础元件',
    size: { w: 2, h: 1 },
    terminals: [
      { name: 'A', dx: 0, dy: 0, direction: 'in' },
      { name: 'K', dx: 1, dy: 0, direction: 'out' },
    ],
    defaultParams: { color: 'red', model: 'ideal' },
    paramFields: [
      {
        key: 'color',
        label: '颜色',
        type: 'select',
        options: [
          { value: 'red', label: '红色' },
          { value: 'green', label: '绿色' },
          { value: 'yellow', label: '黄色' },
          { value: 'blue', label: '蓝色' },
        ],
      },
      {
        // 电学型号：默认 ideal 保持 0.7V（包 5/6 的既有断言依赖它），
        // 选 red/green/yellow/blue 才切到真实压降（2.0/2.2/2.0/3.0V @10mA）
        key: 'model',
        label: '压降',
        type: 'select',
        options: [
          { value: 'ideal', label: '理想 0.7V' },
          { value: 'red', label: '红 2.0V' },
          { value: 'green', label: '绿 2.2V' },
          { value: 'yellow', label: '黄 2.0V' },
          { value: 'blue', label: '蓝 3.0V' },
        ],
      },
    ],
    draw: drawLed,
  },

  switch: {
    id: 'switch',
    label: '开关',
    group: '基础元件',
    size: { w: 2, h: 1 },
    terminals: [
      { name: 'COM', dx: 0, dy: 0, direction: 'bidir' },
      { name: 'NO', dx: 1, dy: 0, direction: 'bidir' },
    ],
    defaultParams: { state: 'open' },
    paramFields: [
      {
        key: 'state',
        label: '状态',
        type: 'select',
        options: [
          { value: 'open', label: '断开' },
          { value: 'closed', label: '闭合' },
        ],
      },
    ],
    draw: drawSwitch,
  },

  ic74xx: {
    id: 'ic74xx',
    label: '74LS 芯片',
    group: '集成电路',
    size: { w: 7, h: 3 },
    // 端子名就是**真实引脚号**（DIP-14）。逻辑功能（1A/1B/1Y…）由 digmodels 按
    // params.type 映射，所以七种芯片共用这一套 14 个端子，不需要每种重排。
    // 引脚 1..7 在顶边（1 在左），8..14 在底边（14 在最左）——与真实 DIP 封装一致。
    terminals: (() => {
      const list = [];
      for (let pin = 1; pin <= 14; pin += 1) {
        const isTop = pin <= 7;
        const col = isTop ? pin - 1 : 14 - pin;
        list.push({
          name: String(pin),
          dx: col,
          dy: isTop ? 0 : 2,
          direction: pin === 7 || pin === 14 ? 'power' : 'bidir',
          role: pin === 7 ? 'GND' : pin === 14 ? 'VCC' : 'io',
        });
      }
      return list;
    })(),
    defaultParams: { type: '74LS00' },
    paramFields: [
      {
        key: 'type',
        label: '型号',
        type: 'select',
        // 只列 14 脚芯片：16 脚的 74LS138/148/151/283/85/112/160/194 走 ic74xx16
        options: modelOptionsByPins(14),
        // 旧存档写的是 7408 这种四位短号，显示时归一化到 74LS08
        normalize: (value) => normalizeType(value),
      },
    ],
    draw: drawIc,
  },

  ic74xx16: {
    id: 'ic74xx16',
    label: '74LS 芯片（16 脚）',
    group: '集成电路',
    size: { w: 8, h: 3 },
    // DIP-16：1..8 在顶边（1 在左），9..16 在底边（16 在最左），与真实封装一致。
    // 8=GND、16=VCC；其余端子统一 bidir，方向交给 digmodels 的 pins.dir 决定。
    terminals: (() => {
      const list = [];
      for (let pin = 1; pin <= 16; pin += 1) {
        const isTop = pin <= 8;
        const col = isTop ? pin - 1 : 16 - pin;
        list.push({
          name: String(pin),
          dx: col,
          dy: isTop ? 0 : 2,
          direction: pin === 8 || pin === 16 ? 'power' : 'bidir',
          role: pin === 8 ? 'GND' : pin === 16 ? 'VCC' : 'io',
        });
      }
      return list;
    })(),
    defaultParams: { type: '74LS138' },
    paramFields: [
      {
        key: 'type',
        label: '型号',
        type: 'select',
        // 只列 16 脚芯片，避免把 74LS00 插到 16 脚座上
        options: modelOptionsByPins(16),
        normalize: (value) => normalizeType(value),
      },
    ],
    draw: drawIc,
  },

  capacitor: {
    id: 'capacitor',
    label: '电容',
    group: '基础元件',
    size: { w: 2, h: 1 },
    terminals: [
      { name: '1', dx: 0, dy: 0, direction: 'bidir' },
      { name: '2', dx: 1, dy: 0, direction: 'bidir' },
    ],
    defaultParams: { capacitance: 0.00001, dielectric: 'ceramic' },
    paramFields: [
      {
        key: 'capacitance',
        label: '容值',
        type: 'number',
        unit: 'μF',
        factor: 0.000001, // 存储单位 F，界面单位 μF
        step: 0.1,
        min: 0.001,
        max: 10000,
      },
      {
        key: 'dielectric',
        label: '介质',
        type: 'select',
        options: [
          { value: 'ceramic', label: '瓷片 / 薄膜' },
          { value: 'electrolytic', label: '电解（有极性）' },
        ],
      },
    ],
    draw: drawCapacitor,
  },

  vsource: {
    id: 'vsource',
    label: '电压源',
    group: '电源',
    size: { w: 2, h: 1 },
    terminals: [
      { name: '+', dx: 0, dy: 0, direction: 'out' },
      { name: '-', dx: 1, dy: 0, direction: 'out' },
    ],
    defaultParams: { voltage: 5 },
    paramFields: [
      {
        key: 'voltage',
        label: '电压',
        type: 'number',
        unit: 'V',
        factor: 1, // 存储单位 V，界面单位 V
        step: 0.5,
        min: -30,
        max: 30,
      },
    ],
    draw: drawVsource,
  },

  isource: {
    id: 'isource',
    label: '电流源',
    group: '电源',
    size: { w: 2, h: 1 },
    terminals: [
      { name: '+', dx: 0, dy: 0, direction: 'out' },
      { name: '-', dx: 1, dy: 0, direction: 'out' },
    ],
    defaultParams: { current: 0.01 },
    paramFields: [
      {
        key: 'current',
        label: '电流',
        type: 'number',
        unit: 'mA',
        factor: 0.001, // 存储单位 A，界面单位 mA
        step: 1,
        min: -1000,
        max: 1000,
      },
    ],
    draw: drawIsource,
  },

  'logic-switch': {
    id: 'logic-switch',
    label: '逻辑电平开关',
    group: '数字实验箱',
    size: { w: 2, h: 1 },
    terminals: [
      { name: 'OUT', dx: 1, dy: 0, direction: 'out' },
    ],
    defaultParams: { state: 'lo' },
    paramFields: [
      {
        key: 'state',
        label: '电平',
        type: 'select',
        options: [
          { value: 'lo', label: '低电平 0' },
          { value: 'hi', label: '高电平 1' },
        ],
      },
    ],
    draw: drawLogicSwitch,
  },

  pulse: {
    id: 'pulse',
    label: '脉冲源',
    group: '数字实验箱',
    size: { w: 2, h: 1 },
    terminals: [
      { name: '+', dx: 0, dy: 0, direction: 'out' },
      { name: '-', dx: 1, dy: 0, direction: 'out' },
    ],
    defaultParams: { mode: 'momentary', width: 0.1 },
    paramFields: [
      {
        key: 'mode',
        label: '方式',
        type: 'select',
        options: [
          { value: 'momentary', label: '按键脉冲（单次）' },
          { value: 'toggle', label: '翻转保持' },
        ],
      },
      {
        // 暂态波形用：单次触发时正脉冲的宽度（秒）。
        // 原参数只有 mode、无宽度，指令包 7.6 的「脉冲宽度符合参数」无从校验，
        // 按「如需加参数字段」补此字段（风格同 clock 的 frequency/duty），端子结构不动。
        key: 'width',
        label: '脉宽',
        type: 'number',
        unit: 's',
        factor: 1,
        step: 0.1,
        min: 0.01,
        max: 10,
      },
    ],
    draw: drawPulse,
  },

  clock: {
    id: 'clock',
    label: '时钟源',
    group: '数字实验箱',
    size: { w: 2, h: 1 },
    terminals: [
      { name: '+', dx: 0, dy: 0, direction: 'out' },
      { name: 'GND', dx: 1, dy: 0, direction: 'out' },
    ],
    defaultParams: { frequency: 1, duty: 50 },
    paramFields: [
      {
        key: 'frequency',
        label: '频率',
        type: 'number',
        unit: 'Hz',
        factor: 1,
        step: 1,
        min: 0.1,
        max: 1000,
      },
      {
        key: 'duty',
        label: '占空比',
        type: 'number',
        unit: '%',
        factor: 1,
        step: 5,
        min: 5,
        max: 95,
      },
    ],
    draw: drawClock,
  },

  /* ---- 混合信号边界元件（指令包 8） ---- */

  comparator: {
    id: 'comparator',
    label: '比较器',
    group: '混合信号',
    size: { w: 3, h: 3 },
    terminals: [
      { name: '+', dx: 0, dy: 0, direction: 'in', role: 'analog' },
      { name: '-', dx: 0, dy: 2, direction: 'in', role: 'analog' },
      { name: 'OUT', dx: 2, dy: 0, direction: 'out', role: 'logic' },
      { name: 'V+', dx: 2, dy: 1, direction: 'power', role: 'VCC' },
      { name: 'GND', dx: 2, dy: 2, direction: 'power', role: 'GND' },
    ],
    defaultParams: { threshold: 2.5, hysteresis: 0 },
    paramFields: [
      {
        key: 'threshold',
        label: '阈值',
        type: 'number',
        unit: 'V',
        factor: 1,
        step: 0.1,
        min: 0,
        max: 30,
      },
      {
        key: 'hysteresis',
        label: '滞回',
        type: 'number',
        unit: 'V',
        factor: 1,
        step: 0.1,
        min: 0,
        max: 30,
      },
    ],
    draw: drawComparator,
  },

  buffer74: {
    id: 'buffer74',
    label: '数字缓冲',
    group: '混合信号',
    size: { w: 2, h: 2 },
    terminals: [
      { name: 'IN', dx: 0, dy: 0, direction: 'in', role: 'logic' },
      { name: 'OUT', dx: 1, dy: 0, direction: 'out', role: 'logic' },
      { name: 'VCC', dx: 0, dy: 1, direction: 'power', role: 'VCC' },
      { name: 'GND', dx: 1, dy: 1, direction: 'power', role: 'GND' },
    ],
    defaultParams: {},
    paramFields: [],
    draw: drawBuffer,
  },

  dac8: {
    id: 'dac8',
    label: '8 位 DAC',
    group: '混合信号',
    size: { w: 8, h: 3 },
    terminals: (() => {
      const list = [];
      for (let i = 0; i < 8; i += 1) {
        list.push({ name: `D${i}`, dx: i, dy: 0, direction: 'in', role: 'logic' });
      }
      list.push({ name: 'OUT', dx: 0, dy: 2, direction: 'out', role: 'analog' });
      list.push({ name: 'VCC', dx: 3, dy: 2, direction: 'power', role: 'VCC' });
      list.push({ name: 'GND', dx: 5, dy: 2, direction: 'power', role: 'GND' });
      return list;
    })(),
    defaultParams: { vref: 5 },
    paramFields: [
      {
        key: 'vref',
        label: '基准',
        type: 'number',
        unit: 'V',
        factor: 1,
        step: 0.5,
        min: 0.1,
        max: 30,
      },
    ],
    draw: drawDac8,
  },

  adc8: {
    id: 'adc8',
    label: '8 位 ADC',
    group: '混合信号',
    size: { w: 8, h: 3 },
    terminals: (() => {
      const list = [];
      for (let i = 0; i < 8; i += 1) {
        list.push({ name: `D${i}`, dx: i, dy: 0, direction: 'out', role: 'logic' });
      }
      list.push({ name: 'IN', dx: 0, dy: 2, direction: 'in', role: 'analog' });
      list.push({ name: 'VCC', dx: 3, dy: 2, direction: 'power', role: 'VCC' });
      list.push({ name: 'GND', dx: 5, dy: 2, direction: 'power', role: 'GND' });
      return list;
    })(),
    defaultParams: { vref: 5 },
    paramFields: [
      {
        key: 'vref',
        label: '基准',
        type: 'number',
        unit: 'V',
        factor: 1,
        step: 0.5,
        min: 0.1,
        max: 30,
      },
    ],
    draw: drawAdc8,
  },

  fgen: {
    id: 'fgen',
    label: '函数发生器',
    group: '电源',
    size: { w: 2, h: 1 },
    terminals: [
      { name: 'OUT', dx: 0, dy: 0, direction: 'out', role: 'signal' },
      { name: 'GND', dx: 1, dy: 0, direction: 'out', role: 'GND' },
    ],
    defaultParams: { wave: 'sine', frequency: 1000, amplitude: 2, offset: 0, duty: 50 },
    paramFields: [
      {
        key: 'wave',
        label: '波形',
        type: 'select',
        options: [
          { value: 'sine', label: '正弦' },
          { value: 'square', label: '方波' },
          { value: 'triangle', label: '三角波' },
          { value: 'dc', label: '直流' },
        ],
      },
      {
        key: 'frequency',
        label: '频率',
        type: 'number',
        unit: 'Hz',
        factor: 1,
        step: 100,
        min: 0.1,
        max: 100000,
      },
      {
        key: 'amplitude',
        label: '幅值',
        type: 'number',
        unit: 'Vpp',
        factor: 1,
        step: 0.5,
        min: 0,
        max: 10,
      },
      {
        key: 'offset',
        label: '偏置',
        type: 'number',
        unit: 'V',
        factor: 1,
        step: 0.5,
        min: -5,
        max: 5,
      },
      {
        key: 'duty',
        label: '占空比',
        type: 'number',
        unit: '%',
        factor: 1,
        step: 5,
        min: 10,
        max: 90,
      },
    ],
    draw: drawFgen,
  },

  /* ---- 指令包 9：分立 / 动态 / 机电元件 ---- */

  diode: {
    id: 'diode',
    label: '二极管',
    group: '半导体',
    size: { w: 2, h: 1 },
    terminals: [
      { name: 'A', dx: 0, dy: 0, direction: 'in', role: 'anode' },
      { name: 'K', dx: 1, dy: 0, direction: 'out', role: 'cathode' },
    ],
    defaultParams: { model: '1N4148' },
    paramFields: [
      {
        key: 'model',
        label: '型号',
        type: 'select',
        options: [
          { value: '1N4148', label: '1N4148（0.7V / 100V）' },
          { value: '1N4007', label: '1N4007（0.7V / 1000V）' },
        ],
      },
    ],
    draw: drawDiode,
  },

  zener: {
    id: 'zener',
    label: '稳压管',
    group: '半导体',
    size: { w: 2, h: 1 },
    terminals: [
      { name: 'A', dx: 0, dy: 0, direction: 'in', role: 'anode' },
      { name: 'K', dx: 1, dy: 0, direction: 'out', role: 'cathode' },
    ],
    defaultParams: { vz: 5.1 },
    paramFields: [
      {
        key: 'vz',
        label: '稳压值',
        type: 'select',
        options: [
          { value: 3.3, label: '3.3V' },
          { value: 5.1, label: '5.1V' },
          { value: 6.2, label: '6.2V' },
          { value: 9.1, label: '9.1V' },
        ],
        // 存档里可能是字符串，统一成数字再比对
        normalize: (value) => String(Number(value)),
      },
    ],
    draw: drawZener,
  },

  transistor: {
    id: 'transistor',
    label: '三极管',
    group: '半导体',
    size: { w: 3, h: 3 },
    terminals: [
      { name: 'B', dx: 0, dy: 1, direction: 'in', role: 'base' },
      { name: 'C', dx: 2, dy: 0, direction: 'out', role: 'collector' },
      { name: 'E', dx: 2, dy: 2, direction: 'out', role: 'emitter' },
    ],
    defaultParams: { model: '2N2222', beta: 100 },
    paramFields: [
      {
        key: 'model',
        label: '型号',
        type: 'select',
        options: [
          { value: '2N2222', label: '2N2222（NPN）' },
          { value: '2N3906', label: '2N3906（PNP）' },
        ],
      },
      {
        key: 'beta',
        label: 'β',
        type: 'number',
        unit: '',
        factor: 1,
        step: 10,
        min: 2,
        max: 1000,
      },
    ],
    draw: drawTransistor,
  },

  opamp: {
    id: 'opamp',
    label: '运算放大器',
    group: '有源器件',
    size: { w: 7, h: 5 },
    terminals: [
      { name: '+', dx: 0, dy: 1, direction: 'in', role: 'in+' },
      { name: '-', dx: 0, dy: 3, direction: 'in', role: 'in-' },
      { name: 'OUT', dx: 6, dy: 2, direction: 'out', role: 'out' },
      { name: 'V+', dx: 3, dy: 0, direction: 'power', role: 'VCC' },
      { name: 'V-', dx: 3, dy: 4, direction: 'power', role: 'GND' },
    ],
    defaultParams: { model: 'LM741' },
    paramFields: [
      {
        key: 'model',
        label: '型号',
        type: 'select',
        options: [
          { value: 'LM741', label: 'LM741（摆幅 VCC−2V）' },
          { value: 'OP07', label: 'OP07（低失调）' },
        ],
      },
    ],
    draw: drawOpamp,
  },

  inductor: {
    id: 'inductor',
    label: '电感',
    group: '无源元件',
    size: { w: 3, h: 1 },
    terminals: [
      { name: '1', dx: 0, dy: 0, direction: 'bidir' },
      { name: '2', dx: 2, dy: 0, direction: 'bidir' },
    ],
    defaultParams: { inductance: 0.01 },
    paramFields: [
      {
        key: 'inductance',
        label: '电感量',
        type: 'number',
        unit: 'mH',
        factor: 0.001, // 存储单位 H，界面单位 mH
        step: 1,
        min: 0.1,
        max: 1000,
      },
    ],
    draw: drawInductor,
  },

  buzzer: {
    id: 'buzzer',
    label: '蜂鸣器',
    group: '有源器件',
    size: { w: 2, h: 2 },
    terminals: [
      { name: '+', dx: 0, dy: 0, direction: 'in', role: 'anode' },
      { name: '-', dx: 1, dy: 0, direction: 'in', role: 'cathode' },
    ],
    defaultParams: { mode: 'active' },
    paramFields: [
      {
        key: 'mode',
        label: '类型',
        type: 'select',
        options: [
          { value: 'active', label: '有源（通电即响，100Ω）' },
          { value: 'passive', label: '无源（需方波，1kΩ）' },
        ],
      },
    ],
    draw: drawBuzzer,
  },

  relay: {
    id: 'relay',
    label: '继电器',
    group: '有源器件',
    size: { w: 5, h: 3 },
    terminals: [
      { name: 'COIL1', dx: 0, dy: 0, direction: 'in', role: 'coil' },
      { name: 'COIL2', dx: 2, dy: 0, direction: 'in', role: 'coil' },
      { name: 'COM', dx: 0, dy: 2, direction: 'bidir', role: 'com' },
      { name: 'NO', dx: 2, dy: 2, direction: 'bidir', role: 'no' },
      { name: 'NC', dx: 4, dy: 2, direction: 'bidir', role: 'nc' },
    ],
    defaultParams: {},
    paramFields: [],
    draw: drawRelay,
  },

  dip4: {
    id: 'dip4',
    label: '4 位拨码',
    group: '数字实验箱',
    size: { w: 8, h: 2 },
    terminals: [
      { name: '1A', dx: 0, dy: 0, direction: 'bidir' },
      { name: '1B', dx: 0, dy: 1, direction: 'bidir' },
      { name: '2A', dx: 2, dy: 0, direction: 'bidir' },
      { name: '2B', dx: 2, dy: 1, direction: 'bidir' },
      { name: '3A', dx: 4, dy: 0, direction: 'bidir' },
      { name: '3B', dx: 4, dy: 1, direction: 'bidir' },
      { name: '4A', dx: 6, dy: 0, direction: 'bidir' },
      { name: '4B', dx: 6, dy: 1, direction: 'bidir' },
    ],
    defaultParams: { s1: 'on', s2: 'on', s3: 'on', s4: 'on' },
    paramFields: [1, 2, 3, 4].map((i) => ({
      key: `s${i}`,
      label: `第 ${i} 位`,
      type: 'select',
      options: [
        { value: 'on', label: '闭合' },
        { value: 'off', label: '断开' },
      ],
    })),
    draw: drawDip4,
  },

  pot: {
    id: 'pot',
    label: '电位器',
    group: '无源元件',
    size: { w: 4, h: 3 },
    terminals: [
      { name: '1', dx: 0, dy: 0, direction: 'bidir' },
      { name: '2', dx: 3, dy: 1, direction: 'bidir', role: 'wiper' },
      { name: '3', dx: 0, dy: 2, direction: 'bidir' },
    ],
    defaultParams: { resistance: 10000, wiper: 50 },
    paramFields: [
      {
        key: 'resistance',
        label: '总阻值',
        type: 'number',
        unit: 'kΩ',
        factor: 1000,
        step: 1,
        min: 0.1,
        max: 1000,
      },
      {
        key: 'wiper',
        label: '滑臂',
        type: 'range',
        unit: '%',
        min: 0,
        max: 100,
        step: 1,
      },
    ],
    draw: drawPot,
  },
};

/** 元件库展示顺序 */
export const PART_ORDER = [
  'resistor',
  'led',
  'switch',
  'capacitor',
  'vsource',
  'isource',
  'fgen',
  'logic-switch',
  'pulse',
  'clock',
  'ic74xx',
  'ic74xx16',
  'comparator',
  'buffer74',
  'dac8',
  'adc8',
  'inductor',
  'pot',
  'diode',
  'zener',
  'transistor',
  'opamp',
  'buzzer',
  'relay',
  'dip4',
];

/** 取元件定义，未知类型返回 null */
export function getPart(type) {
  return Object.prototype.hasOwnProperty.call(PARTS, type) ? PARTS[type] : null;
}

/** 旋转后的占位尺寸（90° / 270° 交换宽高；0° / 180° 不变） */
export function footprintOf(def, rotation) {
  if (!def) return { w: 1, h: 1 };
  const { w, h } = def.size;
  if (rotation === 90 || rotation === 270) return { w: h, h: w };
  return { w, h };
}

/**
 * 元件某端子的网格坐标（考虑四向旋转）。
 * 旋转约定与渲染层 canvas 变换一致：绕整数网格矩形 [0..w-1]×[0..h-1]
 * 的「左上角」旋转（90° 顺时针 → (dx,dy)=(h-1-dy,dx)）。
 */
export function terminalPos(comp, terminalName) {
  const def = getPart(comp.type);
  if (!def) return null;
  const terminal = def.terminals.find((item) => item.name === terminalName);
  if (!terminal) return null;
  const { dx, dy } = terminal;
  const { w, h } = def.size;
  const r = comp.rotation || 0;
  let lx = dx;
  let ly = dy;
  if (r === 90) { lx = h - 1 - dy; ly = dx; }
  else if (r === 270) { lx = dy; ly = w - 1 - dx; }
  else if (r === 180) { lx = w - 1 - dx; ly = h - 1 - dy; }
  return { x: comp.x + lx, y: comp.y + ly };
}

/** 元件全部端子的网格坐标 */
export function terminalPositions(comp) {
  const def = getPart(comp.type);
  if (!def) return [];
  return def.terminals.map((terminal) => ({
    name: terminal.name,
    direction: terminal.direction,
    ...terminalPos(comp, terminal.name),
  }));
}

/**
 * 在元件库小画布上用同一套 draw 函数画图标。
 * 让图标与画布上的实物保持同一视觉语言，避免维护两套素材。
 */
export function drawPaletteIcon(canvas, type, colors) {
  const def = getPart(type);
  if (!def || !canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 44;
  const cssH = canvas.clientHeight || 30;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const tileW = 9;
  const tileH = 4.5;
  const fw = def.size.w;
  const fh = def.size.h;
  const spanX = (fw + fh) * tileW / 2;
  const startX = (cssW - spanX) / 2 + fh * tileW / 2;
  const startY = (cssH - (fw + fh) * tileH / 2) / 2 + (fw + fh) * tileH / 4 - 3;

  const frame = {
    w: fw,
    h: fh,
    tileW,
    tileH,
    project: (dx, dy) => ({
      x: startX + (dx - dy) * tileW / 2,
      y: startY + (dx + dy) * tileH / 2,
    }),
  };

  const style = {
    frame,
    theme: colors || {},
    scale: 0.3, // 图标尺度：隐藏引脚小字
    pinLabels: false,
    selected: false,
    hover: false,
  };

  ctx.save();
  def.draw(ctx, { type, params: { ...def.defaultParams }, rotation: 0 }, style);
  ctx.restore();
}
