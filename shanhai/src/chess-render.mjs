/**
 * 《山海拾遗 · 棋艺》绘制层 —— 只碰 Canvas 2D，不碰游戏逻辑、不碰事件。
 *
 * 设计原则（对应用户需求“棋子不要是字，要是一个真的棋子”）：
 *   - 五子棋 / 翻转棋 / 跳棋：玻璃光泽的实体棋子（黑白 / 红黑），带高光与投影。
 *   - 象棋 / 暗棋：木质圆棋子，以矢量徽记表示兵种（将=王冠、车=城楼、马=马首……），
 *     绝不写汉字；暗棋覆面时画一枚素面“谜底”棋子。
 */
(function attachChessRender(root) {
  'use strict';

  const SIDE_COLOR = {
    r: { main: '#c8443a', dark: '#7d2018', light: '#f0a79c', rim: '#5e160f' },
    b: { main: '#2f3a4a', dark: '#16202c', light: '#7e93ab', rim: '#0e141c' },
  };

  function computeLayout(state, cssW, cssH, pad) {
    pad = pad == null ? 14 : pad;
    const cell = Math.max(18, Math.floor(Math.min((cssW - pad * 2) / state.cols, (cssH - pad * 2) / state.rows)));
    const w = cell * state.cols, h = cell * state.rows;
    const ox = Math.floor((cssW - w) / 2);
    const oy = Math.floor((cssH - h) / 2);
    return { cell, ox, oy, w, h };
  }
  function cellAt(layout, px, py) {
    const { cell, ox, oy, w, h } = layout;
    if (px < ox || py < oy || px >= ox + w || py >= oy + h) return null;
    return [Math.floor((px - ox) / cell), Math.floor((py - oy) / cell)];
  }

  /* ── 棋子基类：玻璃/木质圆棋子 ─────────────────────────────────────── */
  function disc(ctx, cx, cy, r, c, glow) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = r * 0.5;
    ctx.shadowOffsetY = r * 0.18;
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.15, cx, cy, r);
    g.addColorStop(0, c.light);
    g.addColorStop(0.55, c.main);
    g.addColorStop(1, c.dark);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (glow) {
      ctx.lineWidth = Math.max(2, r * 0.12);
      ctx.strokeStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2); ctx.stroke();
    }
    // 表面高光
    ctx.beginPath();
    ctx.arc(cx - r * 0.32, cy - r * 0.38, r * 0.34, 0, Math.PI * 2);
    const hg = ctx.createRadialGradient(cx - r * 0.32, cy - r * 0.38, 1, cx - r * 0.32, cy - r * 0.38, r * 0.4);
    hg.addColorStop(0, 'rgba(255,255,255,0.55)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.fill();
    ctx.restore();
  }

  function gomokuStone(ctx, cx, cy, r, side) {
    const c = side === 'r'
      ? { light: '#5a5a5a', main: '#2a2a2a', dark: '#0a0a0a' }
      : { light: '#ffffff', main: '#eef0f2', dark: '#c4c8cc' };
    disc(ctx, cx, cy, r, c, null);
  }

  function reversiStone(ctx, cx, cy, r, side) {
    const c = side === 'r'
      ? { light: '#3a3a3a', main: '#161616', dark: '#000' }
      : { light: '#ffffff', main: '#e9edf1', dark: '#b9bfc6' };
    disc(ctx, cx, cy, r, c, null);
  }

  function checkersPiece(ctx, cx, cy, r, side, king) {
    const c = side === 'r'
      ? { light: '#f0776b', main: '#c8443a', dark: '#7d2018' }
      : { light: '#9fb0c4', main: '#46566b', dark: '#1c2733' };
    disc(ctx, cx, cy, r, c, null);
    if (king) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,221,120,0.95)';
      ctx.lineWidth = Math.max(2, r * 0.14);
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.stroke();
      // 小皇冠：三点
      ctx.fillStyle = 'rgba(255,221,120,0.95)';
      for (const a of [-0.6, 0, 0.6]) {
        ctx.beginPath();
        ctx.arc(cx + Math.sin(a) * r * 0.4, cy - Math.cos(a) * r * 0.34, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ── 矢量徽记（取代汉字） ─────────────────────────────────────────── */
  function icon(ctx, cx, cy, r, kind, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.6, r * 0.09);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const u = r * 0.62;
    switch (kind) {
      case 'general': { // 王冠
        ctx.beginPath();
        ctx.moveTo(-u, u * 0.5);
        ctx.lineTo(-u, -u * 0.2);
        ctx.lineTo(-u * 0.5, u * 0.25);
        ctx.lineTo(0, -u * 0.55);
        ctx.lineTo(u * 0.5, u * 0.25);
        ctx.lineTo(u, -u * 0.2);
        ctx.lineTo(u, u * 0.5);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'advisor': { // 盾
        ctx.beginPath();
        ctx.moveTo(0, -u);
        ctx.lineTo(u * 0.8, -u * 0.4);
        ctx.lineTo(u * 0.6, u * 0.7);
        ctx.lineTo(0, u);
        ctx.lineTo(-u * 0.6, u * 0.7);
        ctx.lineTo(-u * 0.8, -u * 0.4);
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case 'elephant': { // 象首（长鼻）
        ctx.beginPath();
        ctx.moveTo(-u * 0.7, -u * 0.5);
        ctx.quadraticCurveTo(u * 0.2, -u * 0.9, u * 0.7, -u * 0.2);
        ctx.lineTo(u * 0.5, u * 0.2);
        ctx.lineTo(u * 0.2, -u * 0.1);
        ctx.lineTo(0, u * 0.8);
        ctx.lineTo(-u * 0.2, u * 0.2);
        ctx.lineTo(-u * 0.7, u * 0.5);
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case 'horse': { // 马首
        ctx.beginPath();
        ctx.moveTo(-u * 0.5, u * 0.8);
        ctx.lineTo(-u * 0.5, -u * 0.2);
        ctx.quadraticCurveTo(-u * 0.5, -u * 0.8, 0, -u * 0.8);
        ctx.lineTo(u * 0.6, -u * 0.8);
        ctx.lineTo(u * 0.6, -u * 0.3);
        ctx.lineTo(u * 0.2, -u * 0.3);
        ctx.lineTo(u * 0.2, u * 0.8);
        ctx.closePath();
        ctx.stroke();
        // 鬃毛
        ctx.beginPath();
        ctx.moveTo(0, -u * 0.8); ctx.lineTo(-u * 0.2, -u * 0.4);
        ctx.moveTo(u * 0.3, -u * 0.8); ctx.lineTo(u * 0.15, -u * 0.4);
        ctx.stroke();
        break;
      }
      case 'chariot': { // 城楼
        ctx.beginPath();
        ctx.rect(-u * 0.7, -u * 0.1, u * 1.4, u * 0.9);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-u * 0.7, -u * 0.1);
        ctx.lineTo(-u * 0.7, -u * 0.5);
        ctx.lineTo(0, -u * 0.75);
        ctx.lineTo(u * 0.7, -u * 0.5);
        ctx.lineTo(u * 0.7, -u * 0.1);
        ctx.stroke();
        break;
      }
      case 'cannon': { // 炮（炮管 + 轮）
        ctx.beginPath();
        ctx.moveTo(-u * 0.8, u * 0.4);
        ctx.lineTo(u * 0.8, u * 0.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.rect(-u * 0.6, -u * 0.1, u * 1.2, u * 0.4);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, u * 0.55, u * 0.32, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'soldier': { // 矛兵
        ctx.beginPath();
        ctx.moveTo(0, -u); ctx.lineTo(0, u * 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-u * 0.35, u * 0.7); ctx.lineTo(u * 0.35, u * 0.7);
        ctx.lineTo(0, u); ctx.closePath();
        ctx.fill();
        break;
      }
      default: {
        ctx.beginPath(); ctx.arc(0, 0, u * 0.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function woodPiece(ctx, cx, cy, r, side, kind, faceUp) {
    const c = SIDE_COLOR[side];
    disc(ctx, cx, cy, r, { light: '#f3e3c4', main: '#e7d2a6', dark: '#b89b66' }, faceUp ? null : 'rgba(120,90,40,0.35)');
    // 外圈
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, r * 0.08); ctx.strokeStyle = c.rim; ctx.stroke();
    ctx.restore();
    if (faceUp) {
      icon(ctx, cx, cy, r * 0.82, kind, c.dark);
    } else {
      // 覆面：素面 + 中央小点（谜底），不写任何字
      ctx.save();
      ctx.fillStyle = 'rgba(120,90,40,0.5)';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /* ── 棋盘背景 ─────────────────────────────────────────────────────── */
  function drawBoardBg(ctx, state, L) {
    const { cell, ox, oy, w, h } = L;
    const pad = 4;
    ctx.save();
    if (state.mode === 'xiangqi' || state.mode === 'banqi') {
      const g = ctx.createLinearGradient(ox, oy, ox, oy + h);
      g.addColorStop(0, '#f1dcb4'); g.addColorStop(1, '#e3c894');
      ctx.fillStyle = g;
      ctx.fillRect(ox - pad, oy - pad, w + pad * 2, h + pad * 2);
      ctx.strokeStyle = 'rgba(90,60,20,0.65)';
      ctx.lineWidth = 1;
      for (let x = 0; x < state.cols; x++) {
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + h); ctx.stroke();
      }
      for (let y = 0; y < state.rows; y++) {
        ctx.beginPath(); ctx.moveTo(ox, oy + y * cell); ctx.lineTo(ox + w, oy + y * cell); ctx.stroke();
      }
      if (state.mode === 'xiangqi') {
        // 九宫斜线
        for (const pal of [[3, 0], [3, 7]]) {
          const px = ox + pal[0] * cell, py = oy + pal[1] * cell;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 2 * cell, py + 2 * cell); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(px + 2 * cell, py); ctx.lineTo(px, py + 2 * cell); ctx.stroke();
        }
        // 楚河汉界
        ctx.fillStyle = 'rgba(90,60,20,0.35)';
        ctx.fillRect(ox, oy + 4 * cell, w, cell * 2);
      }
    } else if (state.mode === 'gomoku') {
      ctx.fillStyle = '#e7c98c';
      ctx.fillRect(ox - pad, oy - pad, w + pad * 2, h + pad * 2);
      ctx.strokeStyle = 'rgba(70,45,15,0.8)';
      ctx.lineWidth = 1;
      for (let x = 0; x < state.cols; x++) {
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + h); ctx.stroke();
      }
      for (let y = 0; y < state.rows; y++) {
        ctx.beginPath(); ctx.moveTo(ox, oy + y * cell); ctx.lineTo(ox + w, oy + y * cell); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(70,45,15,0.9)';
      for (const [sx, sy] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]) {
        ctx.beginPath(); ctx.arc(ox + sx * cell, oy + sy * cell, Math.max(2, cell * 0.08), 0, Math.PI * 2); ctx.fill();
      }
    } else if (state.mode === 'checkers') {
      for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
        const dark = (x + y) % 2 === 1;
        ctx.fillStyle = dark ? '#7a4a2a' : '#d9b483';
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    } else if (state.mode === 'reversi') {
      for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
        ctx.fillStyle = ((x + y) % 2 === 0) ? '#1f6b3a' : '#1a5d33';
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    }
    ctx.restore();
  }

  /* ── 入口：绘制整盘 ───────────────────────────────────────────────── */
  function draw(ctx, state, layout, opts) {
    opts = opts || {};
    const L = layout;
    const { cell, ox, oy } = L;
    drawBoardBg(ctx, state, L);

    // 合法落点标记
    if (opts.targets) {
      for (const t of opts.targets) {
        const cx = ox + t.x * cell + cell / 2, cy = oy + t.y * cell + cell / 2;
        ctx.save();
        ctx.fillStyle = 'rgba(120,230,160,0.85)';
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(3, cell * 0.12), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    // 上一手
    if (opts.lastMove) {
      const lm = opts.lastMove;
      const xs = lm.flip ? lm.flip[0] : lm.to[0];
      const ys = lm.flip ? lm.flip[1] : lm.to[1];
      ctx.save();
      ctx.strokeStyle = 'rgba(255,210,90,0.9)';
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.strokeRect(ox + xs * cell + 2, oy + ys * cell + 2, cell - 4, cell - 4);
      ctx.restore();
    }
    // 落子类（五子棋/翻转棋）的悬停合法点
    if (opts.hover && (state.mode === 'gomoku' || state.mode === 'reversi')) {
      const Core = globalThis.ShanhaiChessCore;
      const [hx, hy] = opts.hover;
      if (Core.actionsAt(state, hx, hy, state.turn).length) {
        const cx = ox + hx * cell + cell / 2, cy = oy + hy * cell + cell / 2;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,225,120,0.9)';
        ctx.lineWidth = Math.max(2, cell * 0.06);
        ctx.beginPath(); ctx.arc(cx, cy, cell * 0.34, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    // 选中
    if (opts.selected) {
      const [sx, sy] = opts.selected;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,225,120,0.95)';
      ctx.lineWidth = Math.max(2, cell * 0.07);
      ctx.strokeRect(ox + sx * cell + 2, oy + sy * cell + 2, cell - 4, cell - 4);
      ctx.restore();
    }

    // 棋子
    for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
      const info = globalThis.ShanhaiChessCore.cellInfo(state, x, y);
      if (!info) continue;
      const cx = ox + x * cell + cell / 2, cy = oy + y * cell + cell / 2;
      const r = cell * 0.42;
      if (state.mode === 'gomoku') gomokuStone(ctx, cx, cy, r, info.side);
      else if (state.mode === 'reversi') reversiStone(ctx, cx, cy, r, info.side);
      else if (state.mode === 'checkers') checkersPiece(ctx, cx, cy, r, info.side, info.king);
      else woodPiece(ctx, cx, cy, r, info.side, info.kind, info.faceUp);
    }
  }

  root.ShanhaiChessRender = Object.freeze({
    computeLayout, cellAt, draw,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
