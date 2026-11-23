/**
 * 美术分层渲染器
 *
 * 旧版对所有模板统一用「圆 / 圆角矩形 / 环层」那套程序化画法，
 * 牌类也画成一块带字的圆角矩形 —— 根本认不出是牌。
 *
 * 这里按 mode 分层：
 *   - 棋类 → renderPiece（棋子：圆/方载体 + 纹样）
 *   - 牌类 → renderCardFace（52/156 张：花色 + 点数，4 色分组）
 *           renderCardBack（3 套牌背纹样）
 *
 * 同时提供 artContactSheet()：生成后并排 8 张缩略图，供「美术参数实拍对照」，
 * 一眼就能否认掉画错的那张。
 */

/* 本模块自持常量，不依赖牌引擎，避免循环引用 */
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_LABEL = { S: '♠', H: '♥', D: '♦', C: '♣', JOKER: '★' };
const RANK_LABEL = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

const RED = '#c8382f';
const BLACK = '#1b1a1f';
const CARD_BG = '#fdfbf5';

export const CARD_BACKS = [
  { key: 'lattice', name: '菱格纹', accent: '#2f5d8a' },
  { key: 'orbit', name: '同心圆', accent: '#7a3f6d' },
  { key: 'stripe', name: '斜纹', accent: '#2e6b52' },
];

export const isRedCard = (card) => card.suit === 'H' || card.suit === 'D' || card.rank === 17;
export { SUITS, SUIT_LABEL, RANK_LABEL };

/* ---------------- 牌面 ---------------- */
/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{suit:string, rank:number}} card
 * @param {{x?:number,y?:number,w?:number,h?:number,faceUp?:boolean,shadow?:boolean}} opt
 */
export function renderCardFace(ctx, card, opt = {}) {
  const w = opt.w || 96, h = opt.h || 134, x = opt.x || 0, y = opt.y || 0;
  const r = Math.max(4, w * 0.09);
  ctx.save();
  if (opt.shadow !== false) {
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = Math.max(2, w * 0.08);
    ctx.shadowOffsetY = Math.max(1, h * 0.015);
  }
  /* 牌底 */
  ctx.fillStyle = CARD_BG;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#c9c2b2';
  ctx.lineWidth = Math.max(1, w * 0.012);
  roundRect(ctx, x, y, w, h, r);
  ctx.stroke();

  const col = isRedCard(card) ? RED : BLACK;
  const pad = w * 0.1;

  /* 王：竖排「小王 / 大王」+ 花王标记 */
  if (card.suit === 'JOKER') {
    const big = card.rank === 17;
    ctx.fillStyle = big ? RED : BLACK;
    ctx.font = `bold ${Math.round(w * 0.38)}px "Songti SC","SimSun",serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const chars = big ? ['大', '王'] : ['小', '王'];
    ctx.fillText(chars[0], x + w / 2, y + h * 0.36);
    ctx.fillText(chars[1], x + w / 2, y + h * 0.62);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, w * 0.02);
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h * 0.14, w * 0.06, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const rankTxt = RANK_LABEL[card.rank] || String(card.rank);
  const suitTxt = SUIT_LABEL[card.suit] || '';
  const isFace = card.rank >= 11 && card.rank <= 13;   // J / Q / K
  const isAce = card.rank === 14;

  /* 左上角 / 右下角：点数 + 花色。字模高度按实际墨迹量出来，
     否则 A、2 这种大字点数会把花色符号推得离点位老远，看着像多出来一颗花 */
  const rf = Math.round(w * (rankTxt.length > 1 ? 0.25 : 0.3));
  const drawCorner = (bx, by, flip) => {
    ctx.save();
    ctx.translate(bx, by);
    if (flip) ctx.rotate(Math.PI);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = col;
    ctx.font = `bold ${rf}px "Songti SC","SimSun",Georgia,serif`;
    ctx.fillText(rankTxt, 0, 0);
    const mm = ctx.measureText(rankTxt);
    const ink = (Number.isFinite(mm.actualBoundingBoxAscent) && mm.actualBoundingBoxAscent > 0)
      ? mm.actualBoundingBoxAscent + mm.actualBoundingBoxDescent
      : rf * 0.74;
    ctx.font = `${Math.round(w * 0.2)}px "PingFang SC",system-ui,sans-serif`;
    ctx.fillText(suitTxt, 0, ink + w * 0.035);
    ctx.restore();
  };
  drawCorner(x + pad, y + pad * 0.7, false);
  drawCorner(x + w - pad, y + h - pad * 0.7, true);

  /* 中央图案：J/Q/K 画人像框，A 画大花色，数字牌画点数花阵 */
  const cx = x + w / 2, cy = y + h / 2;
  if (isFace) {
    const fw = w * 0.5, fh = h * 0.42;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, w * 0.018);
    roundRect(ctx, cx - fw / 2, cy - fh / 2, fw, fh, w * 0.04);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.14;
    roundRect(ctx, cx - fw / 2, cy - fh / 2, fw, fh, w * 0.04);
    ctx.fill();
    ctx.globalAlpha = 1;
    /* 简笔人像：头 + 肩 */
    ctx.beginPath();
    ctx.arc(cx, cy - fh * 0.16, w * 0.075, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.15, cy + fh * 0.34);
    ctx.quadraticCurveTo(cx, cy - fh * 0.08, cx + w * 0.15, cy + fh * 0.34);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.font = `bold ${Math.round(w * 0.17)}px "Songti SC",serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(rankTxt, cx, cy + fh * 0.62);
  } else if (isAce) {
    ctx.fillStyle = col;
    ctx.font = `${Math.round(w * 0.62)}px "PingFang SC",system-ui,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(suitTxt, cx, cy + h * 0.03);
  } else {
    /* 数字牌：按真扑克的点阵摆花（2-10 的经典列阵，下半区点倒置） */
    const n = card.rank >= 15 ? 2 : card.rank;      /* rank 15 是「2」，不是 15 个点 */
    const UNIT = { x: w * 0.24, y: h * 0.28 };
    const PIPS = {
      2: [[0, -1], [0, 1]],
      3: [[0, -1], [0, 0], [0, 1]],
      4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
      5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
      6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
      7: [[-1, -1], [1, -1], [0, -0.5], [-1, 0], [1, 0], [-1, 1], [1, 1]],
      8: [[-1, -1], [1, -1], [0, -0.5], [-1, 0], [1, 0], [0, 0.5], [-1, 1], [1, 1]],
      9: [[-1, -1], [1, -1], [-1, -0.33], [1, -0.33], [0, 0], [-1, 0.33], [1, 0.33], [-1, 1], [1, 1]],
      10: [[-1, -1], [1, -1], [0, -0.66], [-1, -0.33], [1, -0.33], [-1, 0.33], [1, 0.33], [0, 0.66], [-1, 1], [1, 1]],
    };
    const layout = PIPS[n] || PIPS[Math.min(10, Math.max(2, n))];
    const ps = Math.round(w * 0.185);
    ctx.fillStyle = col;
    ctx.font = `${ps}px "PingFang SC",system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [ux, uy] of layout) {
      const px = cx + ux * UNIT.x;
      const py = cy + uy * UNIT.y;
      ctx.save();
      if (uy > 0.01) { ctx.translate(px, py); ctx.rotate(Math.PI); ctx.fillText(suitTxt, 0, 0); }
      else ctx.fillText(suitTxt, px, py);
      ctx.restore();
    }
  }

  ctx.restore();
}

/* ---------------- 牌背 ---------------- */
/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x,y,w,h,variant:number}} opt
 */
export function renderCardBack(ctx, opt = {}) {
  const w = opt.w || 96, h = opt.h || 134, x = opt.x || 0, y = opt.y || 0;
  const variant = CARD_BACKS[(opt.variant ?? 0) % CARD_BACKS.length];
  const r = Math.max(4, w * 0.09);
  ctx.save();
  /* 底 */
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, variant.accent);
  g.addColorStop(1, shade(variant.accent, -28));
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  /* 内框 */
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = Math.max(1, w * 0.016);
  roundRect(ctx, x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.84, r * 0.7);
  ctx.stroke();

  ctx.save();
  roundRect(ctx, x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.84, r * 0.7);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.lineWidth = Math.max(1, w * 0.014);
  if (variant.key === 'lattice') {
    const step = w * 0.16;
    for (let i = -h; i < w + h; i += step) {
      ctx.beginPath(); ctx.moveTo(x + i, y); ctx.lineTo(x + i + h, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); ctx.stroke();
    }
  } else if (variant.key === 'orbit') {
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, (w * 0.1) * i, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    const step = w * 0.11;
    for (let i = -h; i < w + h; i += step) {
      ctx.beginPath(); ctx.moveTo(x + i, y); ctx.lineTo(x + i + h, y + h); ctx.stroke();
    }
  }
  ctx.restore();
  ctx.restore();
}

/* ---------------- 棋子（原逻辑保留，按 mode 分派） ---------------- */
export function renderPiece(ctx, params, opt = {}) {
  const S = opt.size || Math.min(opt.w || 256, opt.h || 256);
  const ox = opt.x || 0, oy = opt.y || 0;
  const cx = ox + S / 2, cy = oy + S / 2;
  ctx.save();
  ctx.fillStyle = params.palette;
  if (params.carrier === 'round') {
    ctx.beginPath(); ctx.arc(cx, cy, S * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0005'; ctx.lineWidth = S * 0.03; ctx.stroke();
  } else {
    const w = S * 0.66, h = S * 0.78, rx = S * 0.055;
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, rx); ctx.fill();
    ctx.strokeStyle = '#0005'; ctx.lineWidth = S * 0.027; ctx.stroke();
  }
  ctx.strokeStyle = '#fff8'; ctx.lineWidth = S * 0.012;
  for (let i = 0; i < (params.rings || 0); i++) {
    ctx.beginPath(); ctx.arc(cx, cy, S * 0.16 + i * S * 0.07, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = '#fff9';
  for (let i = 0; i < (params.corners || 0); i++) {
    const a = (Math.PI * 2 * i) / Math.max(1, params.corners);
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * S * 0.32, cy + Math.sin(a) * S * 0.32, S * 0.02, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#0002';
  for (let i = 0; i < (params.texture || 0) * 8; i++) {
    ctx.fillRect(cx - S * 0.38 + (i * 29) % (S * 0.76), cy - S * 0.38 + (i * 47) % (S * 0.76), 3, 3);
  }
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(S * 0.33)}px "Songti SC",serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(params.glyph || '', cx, cy + S * 0.015);
  ctx.restore();
}

/* ---------------- 8 张缩略图对照表 ---------------- */
/**
 * 挑出「美术参数实拍对照」要画的 8 项。
 * 牌类：先把验收清单点名的 5 / 10 / K 摆上，再补 A 与 2，四个花色各出一次，
 *       剩下的用三套牌背填满 —— 花色、点数、牌背三件事一屏看全。
 * 棋类：从 pieces 里循环取，凑满 8 个。
 *
 * @returns {Array<{label:string, kind:'face'|'back'|'piece', card?, variant?, piece?}>}
 */
export function contactItems(rs, count = 8) {
  const items = [];
  const mode = rs?.mode || (rs?.type === 'card' ? 'card' : 'board');
  if (mode === 'card') {
    const faces = [
      { suit: 'S', rank: 5 }, { suit: 'H', rank: 10 }, { suit: 'D', rank: 13 },
      { suit: 'C', rank: 14 }, { suit: 'S', rank: 15 },
    ];
    for (const card of faces) {
      if (items.length >= count) break;
      items.push({ label: `${SUIT_LABEL[card.suit]}${RANK_LABEL[card.rank]}`, kind: 'face', card });
    }
    while (items.length < count) {
      const v = (items.length - faces.length) % CARD_BACKS.length;
      items.push({ label: `牌背·${CARD_BACKS[v].name}`, kind: 'back', variant: v });
    }
  } else {
    const ps = (rs?.pieces && rs.pieces.length) ? rs.pieces : [{ name: '子' }];
    for (let i = 0; i < count; i++) {
      items.push({ label: ps[i % ps.length].name || '子', kind: 'piece', piece: ps[i % ps.length] });
    }
  }
  return items;
}

/** 把一项画进一个「格位」：牌类铺满，棋子按最短边居中缩进 */
export function drawContactCell(ctx, item, box) {
  if (item.kind === 'piece') {
    const sz = Math.min(box.w, box.h) * 0.86;
    drawContactItem(ctx, item, { x: box.x + (box.w - sz) / 2, y: box.y + (box.h - sz) / 2, w: sz, h: sz });
  } else {
    drawContactItem(ctx, item, box);
  }
}

/** 把一项画进给定矩形（UI 单张画 / 对照表批量画都走这里） */
export function drawContactItem(ctx, item, box) {
  const { x, y, w, h } = box;
  if (item.kind === 'face') { renderCardFace(ctx, item.card, { x, y, w, h }); return; }
  if (item.kind === 'back') { renderCardBack(ctx, { x, y, w, h, variant: item.variant }); return; }
  const art = item.piece?.art || {};
  renderPiece(ctx, {
    palette: art.palette || '#B4462F',
    glyph: item.piece?.name?.[0] || '子',
    rings: art.rings ?? 2,
    corners: art.corners ?? 0,
    texture: art.texture ?? 0,
    carrier: art.carrier || 'round',
  }, { size: h, x, y, w, h });
}

/**
 * 生成「美术参数实拍对照」：一张长图里并排 8 张缩略图。
 * @returns {{canvas: HTMLCanvasElement, items: Array}}
 */
export function artContactSheet(rs, count = 8) {
  const cw = 116, ch = 160, gap = 10;
  const canvas = document.createElement('canvas');
  canvas.width = count * cw + (count + 1) * gap;
  canvas.height = ch + gap * 2 + 18;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14111f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const items = contactItems(rs, count);
  items.forEach((it, i) => {
    const x = gap + i * (cw + gap), y = gap;
    drawContactCell(ctx, it, { x, y, w: cw, h: ch });
    ctx.fillStyle = '#cfc6e0';
    ctx.font = '12px "PingFang SC",system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(it.label, x + cw / 2, ch + gap + 14);
  });

  return { canvas, items };
}

/* ---------------- 工具 ---------------- */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp((n >> 16) + amt), g = clamp(((n >> 8) & 255) + amt), b = clamp((n & 255) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
