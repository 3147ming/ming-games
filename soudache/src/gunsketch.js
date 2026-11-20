/**
 * 改枪台侧视线稿（P14）：纯逻辑层
 *
 * 为什么需要这一层：战前改枪台此前只有数字预览，「装了什么」对玩家完全不可见；
 * 但它又不能直接跑 3D —— 战前屏没有渲染器，不该为一个预览起 WebGL。
 * 所以这里把 vmparams.VM_PARAMS 的同一份尺寸投影成 2D 侧视示意图元，
 * 再由 ui.js 拼成内联 SVG。尺寸只有一个来源，不会出现"预览一把枪、进局内另一把"。
 *
 * 模块边界：不 import three / 不碰 DOM / 不读 localStorage —— Node 单测可直接 import。
 * 坐标系：沿用枪模的相机局部空间（米），x = -z（枪口朝右为正），y 向上为正。
 *         渲染成 SVG 时才把 y 取反（SVG 的 y 轴向下）。
 */

import { VM_PARAMS, resolvedBarrel } from './vmparams.js';

/**
 * 枪管/枪口真值解析**不在本文件实现**，而是放在 vmparams.js 里，
 * 因为 3D 枪模（models.js）也要读同一份 —— 两处各写一份必然漂移。
 * 这里只做转出，方便调用方从线稿层一起拿到。
 */
export { resolvedBarrel };

/** 部件色调：body=枪身主体 / dark=金属深色件 / accent=卡箍・弹匣井之类的高亮小件 */
const DEFAULT_COLORS = { body: '#C9D2DB', dark: '#78838F', accent: '#FF5A1F' };

/** 线稿四周留白（米）：太小配件贴边，太大枪显得小。 */
const PAD = 0.06;

/** 圆整到 4 位小数，避免 0.30000000000000004 这类浮点尾数进 SVG。 */
function fmt(n) {
  return String(Math.round(n * 10000) / 10000);
}

/** 图元收集器：把画法收敛成四个动词，后续算法改动只在这一层。 */
function makeSink() {
  const parts = [];
  return {
    parts,
    rect(x, y, w, h, tone = 'body') {
      parts.push({ k: 'rect', x, y, w, h, tone });
    },
    circle(x, y, r, tone = 'dark') {
      parts.push({ k: 'circle', x, y, r, tone });
    },
    poly(pts, tone = 'dark') {
      parts.push({ k: 'poly', pts, tone });
    },
    line(x1, y1, x2, y2, tone = 'dark') {
      parts.push({ k: 'line', x1, y1, x2, y2, tone });
    },
    /** 给刚推入的图元打个语义标记（'mag' / 'stock' / 'drum' …），供测试与调试定位。 */
    tag(name) {
      if (parts.length) parts[parts.length - 1].id = name;
    },
  };
}

/**
 * 把一把枪 + 已装配件摊平成侧视示意图元（米制，y 向上）。
 * @param {string} weaponId 武器 id
 * @param {string[]} [mods] 已装配件 id 列表
 * @returns {{parts:Array<object>, barrel:object}} 图元与枪管真值
 */
export function sketchParts(weaponId, mods = []) {
  const p = VM_PARAMS[weaponId] || VM_PARAMS.pistol;
  const has = (id) => mods.indexOf(id) >= 0;
  const s = makeSink();
  const X = (z) => -z; // 枪口朝右
  const bar = resolvedBarrel(p, has);

  // ---- 枪管 ----
  s.rect(X(p.barrelAt[2] - bar.delta / 2), p.barrelAt[1], bar.len, bar.w, 'dark');
  s.tag('barrel');
  if (has('heavybarrel')) {
    for (const dz of [0.09, 0.17]) {
      s.rect(X(bar.frontZ + dz), p.barrelAt[1], 0.02, bar.w * 1.4, 'dark');
    }
  }

  // ---- 机匣 + 顶部导轨 ----
  s.rect(X(p.receiverAt[2]), p.receiverAt[1], p.receiver[2], p.receiver[1], 'body');
  s.tag('receiver');
  s.rect(X(p.receiverAt[2]), p.receiverAt[1] + p.receiver[1] / 2 + 0.018,
    p.receiver[2] * 0.72, 0.035, 'dark');

  // ---- 枪托（骨架托是替换件，基础实心托跳过）----
  if (!has('skeleton')) {
    s.rect(X(p.stockAt[2]), p.stockAt[1], p.stock[2], p.stock[1], 'body');
    s.tag('stock');
  }

  // ---- 握把：向后倾斜的四边形 ----
  // 正正方方的矩形在侧视里像"贴了块砖"，读不出是握把；真实握把是后倾的，斜切一下立刻像枪。
  const gx = X(p.gripAt[2]);
  const gy = p.gripAt[1];
  const gw = p.grip[2];
  const gh = p.grip[1];
  const rake = Math.min(0.05, gw * 0.62);
  s.poly([
    [gx - gw / 2, gy + gh / 2],
    [gx + gw / 2, gy + gh / 2],
    [gx + gw / 2 - rake, gy - gh / 2],
    [gx - gw / 2 - rake, gy - gh / 2],
  ], 'dark');
  s.tag('grip');

  // ---- 扳机护圈：机匣下方的一道开口 U 形（底横 + 前立柱）----
  // 这一笔成本极低，但它是"这是把枪"最有效的轮廓线索，手枪尤其依赖它。
  const gapBack = p.gripAt[2] - p.grip[2] / 2; // 握把前缘
  const gapFront = weaponId === 'pistol'
    ? gapBack - 0.075
    : p.magAt[2] + p.mag[2] / 2; // 弹匣后缘：护圈夹在握把与弹匣之间
  const tgW = Math.max(0.03, Math.min(0.085, gapBack - gapFront));
  const tgX = X(gapBack - tgW / 2);
  const tgH = Math.min(0.055, p.receiver[1] * 0.55);
  const tgY = p.receiverAt[1] - p.receiver[1] / 2 - tgH / 2;
  s.rect(tgX, tgY - tgH / 2, tgW, 0.011, 'dark'); // 护圈底
  s.rect(tgX + tgW / 2, tgY, 0.011, tgH, 'dark'); // 前端立柱
  s.tag('guard');

  // ---- 准星 ----
  s.rect(X(p.sightAt[2]), p.sightAt[1], p.sight[2], p.sight[1], 'dark');
  s.tag('sight');

  // ---- 弹匣：底部前倾的香蕉形；手枪弹匣在握把内，不单画 ----
  if (!has('drum') && !has('dualmag') && weaponId !== 'pistol') {
    const mx = X(p.magAt[2]);
    const my = p.magAt[1];
    const mw = p.mag[2];
    const mh = p.mag[1];
    const mRake = mw * 0.85;
    s.poly([
      [mx - mw / 2, my + mh / 2],
      [mx + mw / 2, my + mh / 2],
      [mx + mw / 2 + mRake, my - mh / 2],
      [mx - mw / 2 + mRake, my - mh / 2],
    ], 'dark');
    s.tag('mag');
  }

  /* ================= 枪口 ================= */
  const mz = bar.muzzleZ;
  const mzX = X(mz);
  if (has('suppressor')) {
    s.rect(X(mz - 0.13 + 0.03), p.muzzleAt[1], 0.26, bar.w * 0.95, 'dark');
  } else if (has('compensator')) {
    s.rect(X(mz - 0.03), p.muzzleAt[1], 0.13, bar.w * 1.55, 'dark');
  } else if (has('flash')) {
    s.rect(X(mz - 0.01), p.muzzleAt[1], 0.075, bar.w * 1.5, 'dark');
  } else if (has('choke')) {
    // 收束器：前窄后宽的梯形 + 尾部卡箍环
    const len = 0.12;
    const x0 = mzX - 0.02;
    const x1 = x0 + len;
    const y = p.muzzleAt[1];
    const hb = bar.w * 0.62;
    const hf = bar.w * 0.50;
    s.poly([[x0, y - hb / 2], [x1, y - hf / 2], [x1, y + hf / 2], [x0, y + hb / 2]], 'dark');
    s.rect(X(mz + 0.012), y, 0.024, bar.w * 1.32, 'accent');
  } else if (weaponId !== 'pistol') {
    // 默认制退器（与 3D 枪模一致：手枪不画）
    s.rect(mzX, p.muzzleAt[1], 0.09, p.barrel[0] * 1.4, 'dark');
  }

  /* ================= 瞄具 ================= */
  if (has('acog')) {
    const bh = 0.075;
    const oy = p.sightAt[1] + bh / 2 + 0.010;
    s.rect(X(p.sightAt[2] - 0.02), oy, 0.20, bh, 'dark');
    s.rect(X(p.sightAt[2] - 0.02 - 0.104), oy, 0.008, 0.062, 'accent');
    s.rect(X(p.sightAt[2] - 0.02 + 0.098), oy, 0.008, 0.062, 'accent');
    s.rect(X(p.sightAt[2] - 0.02), oy + bh / 2 + 0.010, 0.026, 0.020, 'body');
  } else if (has('scope2x')) {
    const bh = 0.056;
    const oy = p.sightAt[1] + bh / 2 + 0.008;
    s.rect(X(p.sightAt[2] - 0.02), oy, 0.15, bh, 'dark');
    s.rect(X(p.sightAt[2] - 0.02 - 0.075), oy, 0.014, 0.036, 'body');
    s.rect(X(p.sightAt[2] - 0.02 + 0.075), oy, 0.014, 0.036, 'body');
  } else if (has('holo') || has('reddot')) {
    const big = has('holo');
    const bh = big ? 0.062 : 0.048;
    const bd = big ? 0.075 : 0.085;
    const oy = p.sightAt[1] + bh / 2 + 0.006;
    s.rect(X(p.sightAt[2] - 0.01), oy, bd, bh, 'dark');
    s.circle(X(p.sightAt[2] - 0.01 - bd / 2) + 0.006, oy, 0.010, 'accent');
  }

  /* ================= 前握把 ================= */
  if (has('bipod')) {
    const bz = p.barrelAt[2] + p.barrel[2] * 0.20;
    const by = p.barrelAt[1] - 0.050;
    s.rect(X(bz), by, 0.05, 0.026, 'dark');
    s.line(X(bz) - 0.055, by - 0.006, X(bz) - 0.075, by - 0.168, 'dark');
    s.line(X(bz) + 0.055, by - 0.006, X(bz) + 0.075, by - 0.168, 'dark');
  } else if (has('vgrip')) {
    s.rect(X(p.barrelAt[2] + p.barrel[2] * 0.34), p.barrelAt[1] - 0.10, 0.05, 0.13, 'dark');
  } else if (has('agrip')) {
    const cx = X(p.barrelAt[2] + p.barrel[2] * 0.26);
    const cy = p.barrelAt[1] - 0.095;
    s.poly([[cx - 0.025, cy + 0.058], [cx + 0.025, cy + 0.058],
      [cx + 0.041, cy - 0.058], [cx - 0.009, cy - 0.058]], 'dark');
  } else if (weaponId !== 'pistol') {
    s.rect(X(p.barrelAt[2] + p.barrel[2] * 0.32), p.barrelAt[1] - 0.065, 0.05, 0.12, 'dark');
  }

  /* ================= 弹匣 ================= */
  if (has('drum')) {
    const r = Math.max(p.mag[1] * 0.50, 0.095);
    s.circle(X(p.magAt[2]), p.magAt[1] - p.mag[1] * 0.05, r, 'dark');
    s.rect(X(p.magAt[2]), p.magAt[1] + p.mag[1] * 0.42, p.mag[2] * 0.9, 0.06, 'body');
    s.tag('drum');
  } else if (has('dualmag')) {
    // 侧视看不到左右并排，所以第二支沿 z 后错一点画出来 —— 线稿是示意，读得出"两支"最重要
    s.rect(X(p.magAt[2] + 0.035), p.magAt[1], p.mag[2] * 0.92, p.mag[1] * 1.02, 'dark');
    s.rect(X(p.magAt[2] - 0.032), p.magAt[1], p.mag[2] * 0.92, p.mag[1] * 1.02, 'dark');
    s.rect(X(p.magAt[2]), p.magAt[1] - p.mag[1] * 0.16, p.mag[2] * 1.5, 0.024, 'accent');
    s.tag('dualmag');
  } else if (has('extmag')) {
    s.rect(X(p.magAt[2]), p.magAt[1] - p.mag[1] / 2 - 0.05, p.mag[2] * 0.96, 0.10, 'dark');
    s.tag('extmag');
  } else if (has('fastmag')) {
    s.rect(X(p.magAt[2]), p.magAt[1] + p.mag[1] / 2 + 0.014, p.mag[2] * 1.14, 0.028, 'accent');
    s.tag('fastmag');
  }

  /* ================= 枪托 ================= */
  if (has('skeleton')) {
    const sz = p.stockAt[2];
    const sl = p.stock[2];
    s.rect(X(sz), p.stockAt[1] + p.stock[1] * 0.38, sl, 0.022, 'dark');
    s.rect(X(sz - sl * 0.02), p.stockAt[1] - p.stock[1] * 0.40, sl * 0.84, 0.020, 'dark');
    s.rect(X(sz + sl / 2 - 0.014), p.stockAt[1], 0.028, p.stock[1] * 0.92, 'body');
    s.rect(X(sz - sl / 2 + 0.013), p.stockAt[1], 0.026, p.stock[1] * 0.78, 'dark');
    s.tag('skeleton');
  } else if (has('tacticalstock')) {
    s.rect(X(p.stockAt[2]), p.stockAt[1] + p.stock[1] / 2 + 0.014, p.stock[2] * 0.8, 0.032, 'body');
  } else if (has('heavystock')) {
    s.rect(X(p.stockAt[2] + p.stock[2] / 2 + 0.045), p.stockAt[1], 0.10, p.stock[1] * 0.9, 'body');
  }

  return { parts: s.parts, barrel: bar };
}

/** 图元包围盒（米制，未翻转 y）。 */
function bbox(parts) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const pt of parts) {
    if (pt.k === 'rect') {
      add(pt.x - pt.w / 2, pt.y - pt.h / 2);
      add(pt.x + pt.w / 2, pt.y + pt.h / 2);
    } else if (pt.k === 'circle') {
      add(pt.x - pt.r, pt.y - pt.r);
      add(pt.x + pt.r, pt.y + pt.r);
    } else if (pt.k === 'poly') {
      for (const [x, y] of pt.pts) add(x, y);
    } else {
      add(pt.x1, pt.y1);
      add(pt.x2, pt.y2);
    }
  }
  return { minX, maxX, minY, maxY };
}

/** y 轴翻转：模型 y 向上 → SVG y 向下。 */
function flip(parts) {
  return parts.map((pt) => {
    if (pt.k === 'rect' || pt.k === 'circle') return { ...pt, y: -pt.y };
    if (pt.k === 'poly') return { ...pt, pts: pt.pts.map(([x, y]) => [x, -y]) };
    return { ...pt, y1: -pt.y1, y2: -pt.y2 };
  });
}

/**
 * 生成改枪台用的内联 SVG 侧视线稿。
 * @param {string} weaponId 武器 id
 * @param {string[]} [mods] 已装配件 id 列表
 * @param {object} [opts] { colors?:{body,dark,accent}, width?, height?, className? }
 * @returns {string} SVG 字符串（viewBox 按实际内容自适应，不含外链与脚本）
 */
export function sketchSvg(weaponId, mods = [], opts = {}) {
  const colors = Object.assign({}, DEFAULT_COLORS, opts.colors || {});
  const parts = flip(sketchParts(weaponId, mods).parts);
  const b = bbox(parts);
  const vb = [
    fmt(b.minX - PAD),
    fmt(b.minY - PAD),
    fmt(b.maxX - b.minX + PAD * 2),
    fmt(b.maxY - b.minY + PAD * 2),
  ].join(' ');

  const shapes = parts.map((pt) => {
    const fill = colors[pt.tone] || colors.body;
    if (pt.k === 'rect') {
      return `<rect x="${fmt(pt.x - pt.w / 2)}" y="${fmt(pt.y - pt.h / 2)}"`
        + ` width="${fmt(pt.w)}" height="${fmt(pt.h)}" fill="${fill}"/>`;
    }
    if (pt.k === 'circle') {
      return `<circle cx="${fmt(pt.x)}" cy="${fmt(pt.y)}" r="${fmt(pt.r)}" fill="${fill}"/>`;
    }
    if (pt.k === 'poly') {
      const pts = pt.pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
      return `<polygon points="${pts}" fill="${fill}"/>`;
    }
    return `<line x1="${fmt(pt.x1)}" y1="${fmt(pt.y1)}" x2="${fmt(pt.x2)}" y2="${fmt(pt.y2)}"`
      + ` stroke="${fill}" stroke-width="0.016" stroke-linecap="round"/>`;
  }).join('');

  const cls = opts.className || 'gun-sketch';
  const w = opts.width || 260;
  const h = opts.height || 106;
  return `<svg class="${cls}" viewBox="${vb}" width="${w}" height="${h}"`
    + ` preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${shapes}</svg>`;
}
