/**
 * hep-skin.js — HEP-DCTS-01 数字电路实验平台「实物外观」皮肤
 *
 * 设计边界（改动前务必读）：
 *   - 只负责「怎么画」。不产生节点、不改 platforms.js 的几何 / id / 分组。
 *   - 所有可连接孔位严格用 platform.nodes 的 (x, y) 经 project() 投影，
 *     所以拾取、连线、存档 v4、935 项探针完全不受影响。
 *   - 写实绘制全部落在「平台层」（离屏缓存），动态层（元件 / 导线 / 悬停 /
 *     探针标记）一行不动，run6 / runA 的 getImageData 像素断言不受干扰。
 *   - 本文件零 import：project / poly / lift 由调用方通过 api 传入，
 *     避免与 render.js 形成 ESM 循环依赖。
 *
 * 实物对应（用户 5 张照片）：
 *   白色机箱 + 提手 + 「数字电路实验平台 / HEP」铭牌 + 6 块深蓝模块板（2×3）；
 *   蓝色 PCB 主板（白丝印走线）、DIP 锁紧座、CON 接口、+5V/GND 电源区、
 *   频率/脉宽调节、单次脉冲、逻辑笔、拨码开关、LED 指示、七段数码管。
 */

export const HEP_SKIN_ID = 'hep';

/** 6 大模块分区（网格坐标；仅用于绘制与前面板控件定位，不产生节点） */
export const HEP_MODULES = [
  { id: 'm1', label: 'LED 逻辑开关模块 A', sub: '8 路电平 · 8 路指示', x: 0.6, y: 0.6, w: 11.6, h: 7.8, kind: 'switches' },
  { id: 'm2', label: 'IC 插座 / 逻辑笔模块 A', sub: '14P · 16P 锁紧座', x: 12.5, y: 0.6, w: 11.2, h: 7.8, kind: 'sockets' },
  { id: 'm3', label: 'LED 逻辑开关模块 B', sub: '拨码开关 · 状态指示', x: 24.0, y: 0.6, w: 11.4, h: 7.8, kind: 'switches' },
  { id: 'm4', label: '七段数码管显示模块', sub: '共阴 · 段码输入', x: 0.6, y: 8.7, w: 11.6, h: 7.9, kind: 'display' },
  { id: 'm5', label: '单脉冲 / 连续脉冲模块', sub: '频率选择 · 脉宽调节', x: 12.5, y: 8.7, w: 11.2, h: 7.9, kind: 'pulse' },
  { id: 'm6', label: '电源 / CON / 逻辑笔模块', sub: '+5V · GND · CON · 逻辑笔', x: 24.0, y: 8.7, w: 11.4, h: 7.9, kind: 'utility' },
];

const C = {
  caseTop: '#eceadf',
  caseSideR: '#c7c3b1',
  caseSideL: '#b4b0a0',
  caseEdge: '#8d8978',
  caseInner: '#f4f2e9',
  caseShadow: 'rgba(28, 30, 26, 0.35)',
  brandInk: '#3a3d42',
  brandMuted: '#7c807f',
  pcb: '#12427e',
  pcbDark: '#0b2d58',
  pcbEdge: '#072145',
  silk: 'rgba(226, 238, 252, 0.62)',
  silkFaint: 'rgba(214, 231, 250, 0.28)',
  modTop: '#123b7c',
  modTop2: '#0e3169',
  modSideR: '#082449',
  modSideL: '#061c3a',
  modEdge: '#051832',
  modInk: '#eaf2ff',
  modSub: 'rgba(206, 226, 250, 0.72)',
  screw: '#c9c6b6',
  screwSlot: '#6c6a5d',
  socket: '#11151b',
  socketHi: '#2b323d',
  lever: '#c6ccd6',
  leverDark: '#7e8694',
  holeRim: '#e9eef5',
  holeInner: '#1a2230',
  pinInner: '#090d13',
  ledOff: '#582326',
  ledRim: '#8a3a37',
  segOff: '#3a1c1e',
  knob: '#ded8c2',
  knobHi: '#f2eeda',
  knobDark: '#8e8974',
  red: '#c0453c',
  bnc: '#d8c98a',
  bncDark: '#8c814f',
};

/* ==========================================================================
   基础绘制辅助（等距投影下的一切都由 project 决定）
   ========================================================================== */

function lift(p, h) { return { x: p.x, y: p.y - h }; }

function poly(ctx, pts) {
  if (!pts || pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** 网格矩形 → 屏幕四角 */
function quad(P, x, y, w, h) {
  return [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
}

function fillQuad(ctx, P, x, y, w, h, fill, stroke, lw) {
  const q = quad(P, x, y, w, h);
  poly(ctx, q);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw || 1;
    ctx.stroke();
  }
  return q;
}

/** 带厚度的板：两个可见侧面 + 顶面 */
function prism(ctx, P, x, y, w, h, height, top, sideR, sideL, edge) {
  const a = P(x, y);
  const b = P(x + w, y);
  const c = P(x + w, y + h);
  const d = P(x, y + h);
  const A = lift(a, height);
  const B = lift(b, height);
  const Cc = lift(c, height);
  const D = lift(d, height);

  poly(ctx, [b, c, Cc, B]);
  ctx.fillStyle = sideR;
  ctx.fill();
  poly(ctx, [d, c, Cc, D]);
  ctx.fillStyle = sideL;
  ctx.fill();
  poly(ctx, [A, B, Cc, D]);
  ctx.fillStyle = top;
  ctx.fill();
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  return [A, B, Cc, D];
}

function disc(ctx, x, y, r, fill, stroke, lw) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw || 1;
    ctx.stroke();
  }
}

function screw(ctx, P, gx, gy, r) {
  const p = P(gx, gy);
  disc(ctx, p.x, p.y, r, C.screw, '#8c8979', Math.max(0.6, r * 0.18));
  ctx.beginPath();
  ctx.moveTo(p.x - r * 0.55, p.y - r * 0.2);
  ctx.lineTo(p.x + r * 0.55, p.y + r * 0.2);
  ctx.strokeStyle = C.screwSlot;
  ctx.lineWidth = Math.max(0.7, r * 0.24);
  ctx.stroke();
}

function silkLine(ctx, P, x0, y0, x1, y1, color, width) {
  const a = P(x0, y0);
  const b = P(x1, y1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color || C.silkFaint;
  ctx.lineWidth = width || 1;
  ctx.stroke();
}

/** 在网格坐标处写水平文字（不随等距倾斜，与现有 drawExpBox 一致） */
function stamp(ctx, P, gx, gy, text, opts = {}) {
  const p = P(gx, gy);
  const size = opts.size || 10;
  ctx.font = `${opts.weight || 500} ${size}px ${opts.mono ? '"Cascadia Mono", Consolas, monospace' : '"Microsoft YaHei", "PingFang SC", sans-serif'}`;
  ctx.textAlign = opts.align || 'center';
  ctx.textBaseline = 'middle';
  if (opts.pill) {
    const w = ctx.measureText(text).width + 10;
    const h = size + 5;
    ctx.beginPath();
    ctx.moveTo(p.x - w / 2 + h / 2, p.y - h / 2);
    ctx.lineTo(p.x + w / 2 - h / 2, p.y - h / 2);
    ctx.arcTo(p.x + w / 2, p.y - h / 2, p.x + w / 2, p.y, h / 2);
    ctx.arcTo(p.x + w / 2, p.y + h / 2, p.x + w / 2 - h / 2, p.y + h / 2, h / 2);
    ctx.lineTo(p.x - w / 2 + h / 2, p.y + h / 2);
    ctx.arcTo(p.x - w / 2, p.y + h / 2, p.x - w / 2, p.y, h / 2);
    ctx.arcTo(p.x - w / 2, p.y - h / 2, p.x - w / 2 + h / 2, p.y - h / 2, h / 2);
    ctx.closePath();
    ctx.fillStyle = opts.pill;
    ctx.fill();
  }
  ctx.fillStyle = opts.color || C.modInk;
  ctx.fillText(text, p.x, p.y);
}

function partRect(part) {
  switch (part.kind) {
    case 'holes': return { x: part.x - 0.4, y: part.y - 0.4, w: part.cols + 0.8, h: part.rows + 0.8 };
    case 'dip': return { x: part.x - 0.7, y: part.y - 0.7, w: part.pins / 2 + 1.4, h: 3.4 };
    case 'dipswitch': return { x: part.x - 0.5, y: part.y - 0.5, w: part.bits + 1, h: 4 };
    case 'ledbank': return { x: part.x - 0.5, y: part.y - 0.5, w: part.count + 1, h: 4 };
    case 'segment': return { x: part.x - 0.6, y: part.y - 0.6, w: 4.8, h: 6.2 };
    case 'power': return { x: part.x - 1.1, y: part.y - 1.1, w: 5.2, h: 2.8 };
    case 'buzzer': return { x: part.x - 1.1, y: part.y - 1.1, w: 5.2, h: 2.8 };
    default: return { x: part.x, y: part.y, w: part.w || 1, h: part.h || 1 };
  }
}

/* ==========================================================================
   机箱外壳 / 品牌区
   ========================================================================== */

function drawCase(ctx, view, P) {
  const h = Math.max(3, view.tileH * 0.42);
  // 落影 + 米白机箱
  ctx.save();
  ctx.shadowColor = C.caseShadow;
  ctx.shadowBlur = Math.max(12, view.tileW * 0.8);
  ctx.shadowOffsetY = Math.max(6, view.tileW * 0.34);
  fillQuad(ctx, P, 0, 0, 36, 20, C.caseTop);
  ctx.restore();

  prism(ctx, P, 0, 0, 36, 20, h, C.caseTop, C.caseSideR, C.caseSideL, C.caseEdge);
  // 内嵌白色面板（留出机箱边框）
  fillQuad(ctx, P, 0.35, 0.35, 35.3, 19.3, C.caseInner, 'rgba(150,146,130,0.55)', 1);
  // 四角螺丝
  const r = Math.max(1.6, view.tileW * 0.075);
  [[0.7, 0.7], [35.3, 0.7], [0.7, 19.3], [35.3, 19.3]].forEach(([x, y]) => screw(ctx, P, x, y, r));

  // 顶部两只提手（机箱上沿）
  const handleY = -0.12;
  [8.5, 25.5].forEach((hx) => {
    prism(ctx, P, hx, handleY, 2.6, 0.55, Math.max(2, view.tileH * 0.2),
      '#8f9aa6', '#5d6874', '#4a535d', '#3c444d');
  });
}

function drawBrand(ctx, view, P) {
  const h = Math.max(3, view.tileH * 0.42);
  // 下半部白色铭牌区（模块板下方）
  fillQuad(ctx, P, 0.6, 16.9, 34.8, 2.6, '#f7f5ec', 'rgba(160,156,140,0.5)', 1);
  const cx = 18;
  const cy = 17.6;
  const big = Math.max(11, Math.min(20, view.tileW * 0.5));
  stamp(ctx, P, cx, cy, '数 字 电 路 实 验 平 台', {
    size: big, weight: 700, color: C.brandInk,
  });
  const hep = Math.max(13, Math.min(24, view.tileW * 0.62));
  stamp(ctx, P, cx, cy + 1.15, 'HEP', {
    size: hep, weight: 800, color: C.brandInk, mono: true,
  });
  // 圆章 logo
  const logo = P(cx - 5.2, cy + 0.55);
  const lr = Math.max(6, view.tileW * 0.32);
  disc(ctx, logo.x, logo.y, lr, 'rgba(255,255,255,0.9)', 'rgba(120,60,60,0.65)', 1.5);
  stamp(ctx, P, cx - 5.2, cy + 0.55, 'HEP', {
    size: Math.max(6, lr * 0.62), weight: 700, color: '#9c3b3b', mono: true,
  });
  stamp(ctx, P, 33.4, cy + 1.05, 'HEP-DCTS-01', {
    size: Math.max(7, Math.min(10, view.tileW * 0.26)), color: C.brandMuted, mono: true,
  });
  stamp(ctx, P, 2.6, cy + 1.05, '北京中教仪装备技术有限公司', {
    size: Math.max(6, Math.min(9, view.tileW * 0.24)), color: C.brandMuted,
  });
  void h;
}

/* ==========================================================================
   蓝色 PCB 主板 + 白丝印
   ========================================================================== */

function drawPcb(ctx, view, P) {
  // 蓝色主板：覆盖 6 大模块区，白色丝印走线
  fillQuad(ctx, P, 0.75, 0.75, 34.5, 15.95, C.pcb, C.pcbEdge, Math.max(1, view.tileW * 0.05));
  fillQuad(ctx, P, 0.9, 0.9, 34.2, 15.65, C.pcbDark);

  // 板边丝印框
  fillQuad(ctx, P, 1.0, 1.0, 34.0, 15.45, C.pcb, 'rgba(220,235,252,0.35)', 1);

  // 白色丝印走线：从插孔区向 DIP 区横向引出，模拟实物 PCB 布线
  const lw = Math.max(0.6, view.tileW * 0.022);
  for (let i = 0; i < 10; i += 1) {
    const gy = 1.9 + i * 1.35;
    silkLine(ctx, P, 1.2, gy, 12.0, gy, C.silkFaint, lw);
    silkLine(ctx, P, 12.0, gy, 12.7, gy + 0.35, C.silkFaint, lw);
  }
  for (let i = 0; i < 8; i += 1) {
    const gx = 24.6 + i * 1.3;
    silkLine(ctx, P, gx, 4.4, gx, 5.4, C.silkFaint, lw);
  }
  // 板边一排测试点丝印
  for (let x = 2; x < 34; x += 2) {
    silkLine(ctx, P, x, 16.3, x + 0.8, 16.3, C.silkFaint, lw);
  }
}

/* ==========================================================================
   6 块深蓝模块板
   ========================================================================== */

function drawModuleBoards(ctx, view, P) {
  const h = Math.max(2.2, view.tileH * 0.22);
  HEP_MODULES.forEach((mod, index) => {
    const top = index % 2 === 0 ? C.modTop : C.modTop2;
    prism(ctx, P, mod.x, mod.y, mod.w, mod.h, h, top, C.modSideR, C.modSideL, C.modEdge);
    // 板内细边框（白丝印）
    fillQuad(ctx, P, mod.x + 0.25, mod.y + 0.25, mod.w - 0.5, mod.h - 0.5,
      'rgba(255,255,255,0.02)', 'rgba(206,226,250,0.34)', 1);
    // 四角螺丝
    const r = Math.max(1.1, view.tileW * 0.055);
    [[mod.x + 0.42, mod.y + 0.42], [mod.x + mod.w - 0.42, mod.y + 0.42],
      [mod.x + 0.42, mod.y + mod.h - 0.42], [mod.x + mod.w - 0.42, mod.y + mod.h - 0.42]]
      .forEach(([x, y]) => screw(ctx, P, x, y, r));
    // 顶部铭牌
    const labelSize = Math.max(7, Math.min(11, view.tileW * 0.29));
    stamp(ctx, P, mod.x + mod.w / 2, mod.y + 0.28, mod.label, {
      size: labelSize, weight: 700, color: C.modInk,
      pill: 'rgba(6, 24, 52, 0.72)',
    });
    stamp(ctx, P, mod.x + mod.w / 2, mod.y + 1.05, mod.sub, {
      size: Math.max(5.5, labelSize * 0.78), color: C.modSub,
    });
  });
}

/* ==========================================================================
   各部件写实绘制（位置严格沿用 platforms.js 的 boxParts 坐标）
   ========================================================================== */

function drawHolesPart(ctx, view, P, part) {
  const rect = partRect(part);
  // 蓝色插孔区底座
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.4, view.tileH * 0.1),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  // 每列一组的分组带（与 getConnectedNodes 同规则）
  for (let col = 0; col < part.cols; col += 5) {
    fillQuad(ctx, P, part.x + col - 0.35, part.y - 0.15, 0.18, part.rows + 0.3,
      'rgba(150, 200, 240, 0.2)');
  }
  // 列号丝印
  if (view.tileW > 16) {
    for (let col = 0; col < part.cols; col += 1) {
      stamp(ctx, P, part.x + col, part.y - 0.42, String(col + 1), {
        size: Math.max(5, Math.min(7, view.tileW * 0.18)), color: C.modSub, mono: true,
      });
    }
  }
}

function drawDipSocket(ctx, view, P, part) {
  const rect = partRect(part);
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.6, view.tileH * 0.12),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  const half = part.pins / 2;
  // 黑色锁紧座本体
  const bodyH = Math.max(3, view.tileH * 0.42);
  prism(ctx, P, part.x - 0.55, part.y + 0.3, half - 0.0 + 1.1, 1.45, bodyH,
    C.socket, C.socketHi, '#0a0e13', '#05080b');
  // 两端银色扳手
  const leverH = bodyH + Math.max(1, view.tileH * 0.12);
  prism(ctx, P, part.x - 0.62, part.y + 0.32, 0.42, 1.4, leverH,
    C.lever, C.leverDark, '#5c636f', '#444b55');
  prism(ctx, P, part.x + half - 0.3, part.y + 0.32, 0.42, 1.4, leverH,
    C.lever, C.leverDark, '#5c636f', '#444b55');
  // 1 脚缺口
  const notch = lift(P(part.x - 0.35, part.y + 1.0), bodyH);
  disc(ctx, notch.x, notch.y, Math.max(1.6, view.tileW * 0.075), '#05080b');
  // 型号丝印
  stamp(ctx, P, part.x + half / 2 - 0.3, part.y + 2.55, `${part.pins}P 锁紧座`, {
    size: Math.max(6, Math.min(9, view.tileW * 0.23)), color: C.modInk,
    pill: 'rgba(6, 24, 52, 0.66)',
  });
  if (view.tileW > 16) {
    stamp(ctx, P, part.x - 0.1, part.y - 0.28, '1', {
      size: Math.max(6, view.tileW * 0.2), color: '#f2a93b', mono: true,
    });
  }
}

function drawDipSwitch(ctx, view, P, part) {
  const rect = partRect(part);
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.6, view.tileH * 0.12),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  for (let bit = 0; bit < part.bits; bit += 1) {
    const x = part.x + bit;
    const h = Math.max(2.2, view.tileH * 0.34);
    prism(ctx, P, x - 0.3, part.y + 0.35, 0.6, 1.3, h,
      '#d9d5c6', '#a39d8c', '#8b8575', '#6f6a5c');
    const knob = lift(P(x, part.y + 1.0), h + 1.5);
    disc(ctx, knob.x, knob.y, Math.max(1.4, view.tileW * 0.07), C.red, '#7d2c26', 1);
    stamp(ctx, P, x, part.y + 2.35, String(bit + 1), {
      size: Math.max(5.5, Math.min(8, view.tileW * 0.2)), color: C.modSub, mono: true,
    });
  }
  stamp(ctx, P, part.x + part.bits / 2 - 0.3, part.y - 0.35, 'ON  1 2 3 4 5 6 7 8', {
    size: Math.max(5.5, Math.min(8, view.tileW * 0.2)), color: C.modSub, mono: true,
  });
}

function drawLedBank(ctx, view, P, part) {
  const rect = partRect(part);
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.6, view.tileH * 0.12),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  for (let i = 0; i < part.count; i += 1) {
    const c = P(part.x + i, part.y + 1);
    const r = Math.max(2.4, view.tileW * 0.15);
    disc(ctx, c.x, c.y, r * 1.35, 'rgba(6, 24, 52, 0.85)', 'rgba(206,226,250,0.4)', 1);
    disc(ctx, c.x, c.y, r, C.ledOff, C.ledRim, 1);
    // 高光
    disc(ctx, c.x - r * 0.3, c.y - r * 0.3, r * 0.28, 'rgba(255,255,255,0.22)');
    stamp(ctx, P, part.x + i, part.y + 2.4, `D${i + 1}`, {
      size: Math.max(5, Math.min(7.5, view.tileW * 0.19)), color: C.modSub, mono: true,
    });
  }
}

function drawSegment(ctx, view, P, part) {
  const rect = partRect(part);
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.6, view.tileH * 0.12),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  // 黑色显示窗
  prism(ctx, P, part.x - 0.4, part.y - 0.4, 3.1, 5.2, Math.max(2, view.tileH * 0.26),
    '#0a1017', '#070b10', '#05080c', 'rgba(180,200,225,0.3)');
  const rise = Math.max(2, view.tileH * 0.26);
  const segs = [
    [0.6, 0, 1.4, 0], [2, 0.6, 2, 1.4], [2, 2.6, 2, 3.4],
    [0.6, 4, 1.4, 4], [0, 2.6, 0, 3.4], [0, 0.6, 0, 1.4], [0.6, 2, 1.4, 2],
  ];
  segs.forEach(([x0, y0, x1, y1]) => {
    const a = lift(P(part.x + x0, part.y + y0), rise);
    const b = lift(P(part.x + x1, part.y + y1), rise);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = C.segOff;
    ctx.lineWidth = Math.max(2, view.tileW * 0.12);
    ctx.lineCap = 'round';
    ctx.stroke();
  });
  // 旁边两位装饰数码管（不产生节点）
  for (let k = 0; k < 2; k += 1) {
    const ox = part.x + 3.3 + k * 1.3;
    prism(ctx, P, ox - 0.15, part.y + 0.7, 1.0, 2.6, rise * 0.7,
      '#0a1017', '#070b10', '#05080c', 'rgba(180,200,225,0.22)');
    stamp(ctx, P, ox + 0.35, part.y + 2.0, '8', {
      size: Math.max(9, view.tileW * 0.42), weight: 700, color: '#482225', mono: true,
    });
  }
  stamp(ctx, P, part.x + 1.5, part.y + 5.05, 'DS1 · 共阴', {
    size: Math.max(6, Math.min(9, view.tileW * 0.22)), color: C.modInk,
    pill: 'rgba(6, 24, 52, 0.66)',
  });
}

function drawPowerSwitch(ctx, view, P, part) {
  const rect = partRect(part);
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.6, view.tileH * 0.12),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  const h = Math.max(2.6, view.tileH * 0.4);
  prism(ctx, P, part.x - 0.45, part.y - 0.5, 2.9, 1.1, h,
    '#e8e4d5', '#b0aa98', '#948e7d', '#6d6859');
  const knob = lift(P(part.x + 1, part.y), h + 1.5);
  disc(ctx, knob.x, knob.y, Math.max(2, view.tileW * 0.11), C.red, '#7d2c26', 1);
  stamp(ctx, P, part.x + 1, part.y + 1.35, 'POWER', {
    size: Math.max(6, Math.min(9, view.tileW * 0.22)), color: C.modInk, mono: true,
  });
}

function drawBuzzer(ctx, view, P, part) {
  const rect = partRect(part);
  prism(ctx, P, rect.x, rect.y, rect.w, rect.h, Math.max(1.6, view.tileH * 0.12),
    '#0b2f61', '#061f42', '#051a36', 'rgba(206,226,250,0.3)');
  const c = lift(P(part.x + 1, part.y), Math.max(2, view.tileH * 0.32));
  const r = Math.max(3.5, view.tileW * 0.24);
  disc(ctx, c.x, c.y, r, '#0e131a', 'rgba(200,214,232,0.5)', 1.2);
  disc(ctx, c.x, c.y, r * 0.55, 'rgba(190,198,214,0.22)');
  disc(ctx, c.x, c.y, r * 0.2, 'rgba(190,198,214,0.45)');
  stamp(ctx, P, part.x + 1, part.y + 1.3, 'BZ', {
    size: Math.max(6, Math.min(9, view.tileW * 0.22)), color: C.modInk, mono: true,
  });
}

/* ==========================================================================
   附加装饰：CON / 电源区 / 旋钮 / 单次脉冲 / 逻辑笔
   ========================================================================== */

function drawKnob(ctx, P, gx, gy, r, label) {
  const p = P(gx, gy);
  disc(ctx, p.x, p.y, r * 1.28, 'rgba(6, 24, 52, 0.8)', 'rgba(206,226,250,0.4)', 1);
  disc(ctx, p.x, p.y, r, C.knob, C.knobDark, 1.2);
  disc(ctx, p.x - r * 0.25, p.y - r * 0.25, r * 0.34, C.knobHi);
  // 指示线
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + r * 0.78, p.y - r * 0.5);
  ctx.strokeStyle = '#5a5a4c';
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.stroke();
  stamp(ctx, P, gx, gy + r * 0.14 + 1.1, label, {
    size: Math.max(5.5, Math.min(8, r * 0.9)), color: C.modSub, mono: true,
  });
}

function drawBnc(ctx, P, gx, gy, r) {
  const p = P(gx, gy);
  disc(ctx, p.x, p.y, r * 1.32, '#0b2f61', 'rgba(206,226,250,0.45)', 1);
  disc(ctx, p.x, p.y, r, C.bnc, C.bncDark, 1.2);
  disc(ctx, p.x, p.y, r * 0.52, '#2a2c28');
  disc(ctx, p.x, p.y, r * 0.22, '#d8c98a');
}

function drawDecor(ctx, view, P) {
  const kr = Math.max(3, view.tileW * 0.2);
  // 模块⑤：频率 / 脉宽调节 + 单次脉冲 + 连续脉冲指示
  drawKnob(ctx, P, 14.6, 12.3, kr, '频率 Hz');
  drawKnob(ctx, P, 18.0, 12.3, kr, '脉宽');
  const pulse = P(21.2, 12.3);
  disc(ctx, pulse.x, pulse.y, kr * 1.15, 'rgba(6, 24, 52, 0.8)', 'rgba(206,226,250,0.4)', 1);
  disc(ctx, pulse.x, pulse.y, kr * 0.82, C.red, '#7d2c26', 1.2);
  stamp(ctx, P, 21.2, 13.6, '单次脉冲', {
    size: Math.max(5.5, Math.min(8, view.tileW * 0.2)), color: C.modSub,
  });
  // 频率档位丝印
  ['1Hz', '10Hz', '100Hz', '1kHz', '10kHz'].forEach((t, i) => {
    stamp(ctx, P, 14.6 + i * 1.7, 14.1, t, {
      size: Math.max(5, Math.min(7, view.tileW * 0.17)), color: C.modSub, mono: true,
    });
  });

  // 模块⑥：+5V / GND 电源区 + CON + 逻辑笔
  fillQuad(ctx, P, 25.0, 10.1, 4.2, 2.4, '#0a2c58', 'rgba(206,226,250,0.45)', 1);
  stamp(ctx, P, 25.8, 10.9, '+5V', {
    size: Math.max(7, Math.min(10, view.tileW * 0.26)), weight: 700, color: '#ff8b7d', mono: true,
  });
  stamp(ctx, P, 28.4, 10.9, 'GND', {
    size: Math.max(7, Math.min(10, view.tileW * 0.26)), weight: 700, color: '#9fc4f5', mono: true,
  });
  [25.8, 28.4].forEach((gx) => drawBnc(ctx, P, gx, 11.9, Math.max(1.8, view.tileW * 0.1)));

  // CON 接口排
  fillQuad(ctx, P, 30.4, 10.1, 4.4, 3.0, '#0a2c58', 'rgba(206,226,250,0.45)', 1);
  stamp(ctx, P, 32.6, 10.55, 'CON', {
    size: Math.max(6, Math.min(9, view.tileW * 0.22)), color: C.modInk, mono: true,
  });
  for (let i = 0; i < 8; i += 1) {
    const p = P(30.9 + (i % 4) * 1.0, 11.3 + Math.floor(i / 4) * 0.95);
    disc(ctx, p.x, p.y, Math.max(1.2, view.tileW * 0.06), C.holeRim, C.holeInner, 1);
  }

  // 逻辑笔
  const probe = P(32.6, 14.5);
  disc(ctx, probe.x, probe.y, Math.max(2.4, view.tileW * 0.13), '#d8d3c0', '#8b8575', 1.2);
  disc(ctx, probe.x, probe.y - Math.max(3, view.tileW * 0.16), Math.max(1.4, view.tileW * 0.075),
    '#c9ccd4', '#7e8694', 1);
  stamp(ctx, P, 32.6, 15.5, '逻辑笔 LOGIC PROBE', {
    size: Math.max(5.5, Math.min(8, view.tileW * 0.2)), color: C.modSub, mono: true,
  });

  // 模块①/④ 附加装饰：拨动开关列 + 丝印
  for (let i = 0; i < 8; i += 1) {
    const gx = 1.4 + i * 1.35;
    const p = P(gx, 5.9);
    disc(ctx, p.x, p.y, Math.max(1.6, view.tileW * 0.085), '#d9d5c6', '#8b8575', 1);
    stamp(ctx, P, gx, 6.6, String(i + 1), {
      size: Math.max(5, Math.min(7, view.tileW * 0.17)), color: C.modSub, mono: true,
    });
  }
  stamp(ctx, P, 6.0, 7.5, 'K1–K8  逻辑电平开关', {
    size: Math.max(6, Math.min(9, view.tileW * 0.22)), color: C.modInk,
    pill: 'rgba(6, 24, 52, 0.66)',
  });
}

/* ==========================================================================
   孔位（严格按 platform.nodes，保证拾取与存档）
   ========================================================================== */

function drawNodes(ctx, view, P, platform) {
  const r = Math.max(1.5, Math.min(3.4, view.tileW * 0.105));
  platform.nodes.forEach((node) => {
    const p = P(node.x, node.y);
    const isPin = node.kind === 'pin';
    // 白色插座圈
    disc(ctx, p.x, p.y, r * 1.72, isPin ? 'rgba(220,228,240,0.55)' : C.holeRim,
      'rgba(10,30,60,0.55)', Math.max(0.6, view.tileW * 0.018));
    // 孔内
    disc(ctx, p.x, p.y, r, isPin ? C.pinInner : C.holeInner);
    // 高光
    disc(ctx, p.x - r * 0.28, p.y - r * 0.28, r * 0.32, 'rgba(255,255,255,0.16)');
  });
}

/* ==========================================================================
   对外主入口
   ========================================================================== */

/**
 * 画 HEP-DCTS-01 实物外观。
 * @param {CanvasRenderingContext2D} ctx 已设置好 dpr 变换的上下文
 * @param {object} view  render.js 的 view（提供 tileW / tileH）
 * @param {object} platform  platforms.js 的平台对象（几何只读）
 * @param {{project: function}} api 投影函数，避免循环依赖
 */
export function drawHepPlatform(ctx, view, platform, api) {
  const projectFn = api && api.project;
  if (typeof projectFn !== 'function') return;
  const P = (x, y) => projectFn(view, x, y);

  drawCase(ctx, view, P);
  drawPcb(ctx, view, P);
  drawModuleBoards(ctx, view, P);

  // 部件写实绘制
  (platform.boxParts || []).forEach((part) => {
    switch (part.kind) {
      case 'holes': drawHolesPart(ctx, view, P, part); break;
      case 'dip': drawDipSocket(ctx, view, P, part); break;
      case 'dipswitch': drawDipSwitch(ctx, view, P, part); break;
      case 'ledbank': drawLedBank(ctx, view, P, part); break;
      case 'segment': drawSegment(ctx, view, P, part); break;
      case 'power': drawPowerSwitch(ctx, view, P, part); break;
      case 'buzzer': drawBuzzer(ctx, view, P, part); break;
      default: break;
    }
  });

  drawDecor(ctx, view, P);
  drawNodes(ctx, view, P, platform);
  drawBrand(ctx, view, P);
}
