/**
 * 《山海拾遗 · 棋艺》绘制层 —— 只碰 Canvas 2D，不碰游戏逻辑、不碰事件。
 *
 * 三种棋盘几何（2026-11-16 重做）：
 *   · point  —— 象棋 / 五子棋：**棋子落在线的交叉点**，棋盘线与棋子共用同一套坐标。
 *               旧版把棋子画在格子中心、线画在格边，两套坐标错开半格，
 *               看上去就是"棋子摆在格子里，不是摆在交叉处"，规则与画面互相对不上。
 *   · grid   —— 暗棋 / 翻转棋：这类棋本来就落在格子里，保持原样。
 *   · hexstar—— 跳棋：六角星 121 孔，孔位由 chess-core 的轴向坐标生成。
 *
 * 棋子形制（2026-11-16 按需求调整）：
 *   · 象棋 / 暗棋：木质圆棋子 + **汉字**（帅仕相马车炮兵 / 将士象马车炮卒）。
 *     之前那套矢量徽记（王冠/城楼/马首）识别成本太高，一眼看不出是哪个兵种。
 *   · 五子棋 / 翻转棋 / 跳棋：实体圆珠，本来就没有文字位置。
 */
(function attachChessRender(root) {
  'use strict';

  const SIDE_COLOR = {
    r: { main: '#c8443a', dark: '#7d2018', light: '#f0a79c', rim: '#5e160f' },
    b: { main: '#2f3a4a', dark: '#16202c', light: '#7e93ab', rim: '#0e141c' },
  };

  /* 象棋/暗棋的汉字。红黑各一套，与实体棋盘一致。 */
  const ANIMALS = { rat:'鼠', cat:'猫', dog:'犬', wolf:'狼', leopard:'豹', tiger:'虎', lion:'狮', elephant:'象' };
  const PIECE_LABEL = {
    r: Object.assign({ general: '帅', advisor: '仕', elephant: '相', chariot: '车', horse: '马', cannon: '炮', soldier: '兵' }, ANIMALS),
    b: Object.assign({ general: '将', advisor: '士', elephant: '象', chariot: '车', horse: '马', cannon: '炮', soldier: '卒' }, ANIMALS),
  };
  const SERIF = '"Songti SC","STSong","SimSun","Noto Serif CJK SC",serif';

  const Core = () => globalThis.ShanhaiChessCore;

  function geomOf(state) {
    if (state.mode === 'checkers') return 'hexstar';
    if (state.mode === 'gomoku' || state.mode === 'xiangqi') return 'point';
    return 'grid';
  }

  /* ── 布局 ─────────────────────────────────────────────────────────── */

  function pointLayout(state, cssW, cssH, pad) {
    const cols = state.cols, rows = state.rows;
    // +0.9：交叉点棋盘的最外一圈棋子有一半在棋盘线之外，不留这点余量会被裁掉
    const pitch = Math.max(9, Math.min(
      (cssW - pad * 2) / (cols - 1 + 0.9),
      (cssH - pad * 2) / (rows - 1 + 0.9),
    ));
    const w = pitch * (cols - 1), h = pitch * (rows - 1);
    const ox = Math.round((cssW - w) / 2);
    const oy = Math.round((cssH - h) / 2);
    return { kind: 'point', cell: pitch, pitch, ox, oy, w, h, cols, rows };
  }

  function gridLayout(state, cssW, cssH, pad) {
    const cell = Math.max(16, Math.floor(Math.min(
      (cssW - pad * 2) / state.cols,
      (cssH - pad * 2) / state.rows,
    )));
    const w = cell * state.cols, h = cell * state.rows;
    const ox = Math.floor((cssW - w) / 2);
    const oy = Math.floor((cssH - h) / 2);
    return { kind: 'grid', cell, pitch: cell, ox, oy, w, h, cols: state.cols, rows: state.rows };
  }

  function hexLayout(state, cssW, cssH, pad) {
    const holes = Core().CC.HOLES;
    const S3 = Math.sqrt(3);
    const xs = holes.map((h) => S3 * (h.q + h.r / 2));
    const ys = holes.map((h) => 1.5 * h.r);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY);
    // 0.5 个孔距的余量，避免最外圈棋子贴边
    const size = Math.max(4, Math.min((cssW - pad * 2) / (spanX + 0.9), (cssH - pad * 2) / (spanY + 0.9)));
    const ox = (cssW - spanX * size) / 2 - minX * size;
    const oy = (cssH - spanY * size) / 2 - minY * size;
    return { kind: 'hexstar', size, cell: size * S3, pitch: size * S3, ox, oy, w: spanX * size, h: spanY * size };
  }

  function computeLayout(state, cssW, cssH, pad) {
    pad = pad == null ? 14 : pad;
    const geom = geomOf(state);
    if (geom === 'hexstar') return hexLayout(state, cssW, cssH, pad);
    if (geom === 'point') return pointLayout(state, cssW, cssH, pad);
    return gridLayout(state, cssW, cssH, pad);
  }

  /** 逻辑坐标 → 画布像素。point 用交叉点，grid 用格子中心，hexstar 用孔位。 */
  function posOf(L, x, y) {
    if (L.kind === 'hexstar') {
      const h = Core().CC.HOLES[x | 0];
      if (!h) return null;
      const S3 = Math.sqrt(3);
      return [L.ox + S3 * (h.q + h.r / 2) * L.size, L.oy + 1.5 * h.r * L.size];
    }
    if (L.kind === 'point') return [L.ox + (x | 0) * L.pitch, L.oy + (y | 0) * L.pitch];
    return [L.ox + (x | 0) * L.cell + L.cell / 2, L.oy + (y | 0) * L.cell + L.cell / 2];
  }

  /** 像素 → 逻辑坐标。越界返回 null。 */
  function cellAt(L, px, py) {
    if (L.kind === 'hexstar') {
      const holes = Core().CC.HOLES;
      const S3 = Math.sqrt(3);
      let best = -1, bestD = Infinity;
      for (let i = 0; i < holes.length; i++) {
        const cx = L.ox + S3 * (holes[i].q + holes[i].r / 2) * L.size;
        const cy = L.oy + 1.5 * holes[i].r * L.size;
        const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        if (d < bestD) { bestD = d; best = i; }
      }
      return bestD <= (L.size * 0.72) ** 2 ? [best, 0] : null;
    }
    if (px < L.ox - L.pitch * 0.55 || py < L.oy - L.pitch * 0.55
      || px > L.ox + L.w + L.pitch * 0.55 || py > L.oy + L.h + L.pitch * 0.55) return null;
    if (L.kind === 'point') {
      const x = Math.round((px - L.ox) / L.pitch);
      const y = Math.round((py - L.oy) / L.pitch);
      if (x < 0 || y < 0 || x >= L.cols || y >= L.rows) return null;
      return [x, y];
    }
    const x = Math.floor((px - L.ox) / L.cell);
    const y = Math.floor((py - L.oy) / L.cell);
    if (x < 0 || y < 0 || x >= L.cols || y >= L.rows) return null;
    return [x, y];
  }

  /* ── 棋子底形 ─────────────────────────────────────────────────────── */

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

  function checkerStone(ctx, cx, cy, r, side) {
    const c = side === 'r'
      ? { light: '#f4b0a6', main: '#cf5b4c', dark: '#8d3125' }
      : { light: '#b9c9db', main: '#5a6c82', dark: '#26313d' };
    disc(ctx, cx, cy, r, c, null);
    // 圆珠中央一圈细环，近距离也能分清敌我（不写字，跳棋本来就没有字）
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
    ctx.restore();
  }

  /** 木质棋子 + 汉字；暗棋覆面时画背面纹样（不露字，这是玩法本身）。 */
  function woodPiece(ctx, cx, cy, r, side, kind, faceUp) {
    const c = SIDE_COLOR[side] || SIDE_COLOR.r;
    disc(ctx, cx, cy, r, { light: '#f7ead0', main: '#e8d3a8', dark: '#bb9e6b' }, null);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, r * 0.08); ctx.strokeStyle = c.rim; ctx.stroke();
    ctx.restore();
    if (!faceUp) {
      // 覆面：同心环 + 中心方点，读作"还没翻开"
      ctx.save();
      ctx.strokeStyle = 'rgba(120,90,40,0.45)';
      ctx.lineWidth = Math.max(1, r * 0.07);
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.46, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(120,90,40,0.42)';
      const q = r * 0.16;
      ctx.fillRect(cx - q, cy - q, q * 2, q * 2);
      ctx.restore();
      return;
    }
    const text = (PIECE_LABEL[side] || {})[kind];
    if (!text) return;
    ctx.save();
    ctx.fillStyle = c.dark;
    ctx.font = `700 ${Math.max(9, Math.round(r * 1.12))}px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 汉字在圆里视觉重心偏上，往下挪 1px 更居中
    ctx.fillText(text, cx, cy + r * 0.04);
    ctx.restore();
  }

  /* ── 棋盘背景 ─────────────────────────────────────────────────────── */

  function drawPointBoard(ctx, state, L) {
    const { pitch, ox, oy, w, h, cols, rows } = L;
    const pad = Math.max(8, pitch * 0.55);
    const g = ctx.createLinearGradient(ox, oy, ox, oy + h);
    if (state.mode === 'xiangqi') {
      g.addColorStop(0, '#f3deb6'); g.addColorStop(1, '#e2c58e');
    } else {
      g.addColorStop(0, '#ebcf95'); g.addColorStop(1, '#dfbe7d');
    }
    ctx.fillStyle = g;
    ctx.fillRect(ox - pad, oy - pad, w + pad * 2, h + pad * 2);

    ctx.strokeStyle = state.mode === 'xiangqi' ? 'rgba(92,60,22,0.78)' : 'rgba(78,50,16,0.72)';
    ctx.lineWidth = Math.max(1, pitch * 0.035);

    if (state.mode === 'xiangqi') {
      // 10 条横线；9 条竖线在"河界"处断开（中间两行之间只留外框）
      for (let y = 0; y < rows; y++) {
        ctx.beginPath();
        ctx.moveTo(ox, oy + y * pitch);
        ctx.lineTo(ox + w, oy + y * pitch);
        ctx.stroke();
      }
      for (let x = 0; x < cols; x++) {
        ctx.beginPath();
        ctx.moveTo(ox + x * pitch, oy);
        if (x === 0 || x === cols - 1) {
          ctx.lineTo(ox + x * pitch, oy + h);
        } else {
          // 河界（第 4 条与第 5 条横线之间）不画
          ctx.lineTo(ox + x * pitch, oy + 4 * pitch);
          ctx.moveTo(ox + x * pitch, oy + 5 * pitch);
          ctx.lineTo(ox + x * pitch, oy + h);
        }
        ctx.stroke();
      }
      // 九宫斜线
      for (const top of [0, 7]) {
        ctx.beginPath();
        ctx.moveTo(ox + 3 * pitch, oy + top * pitch);
        ctx.lineTo(ox + 5 * pitch, oy + (top + 2) * pitch);
        ctx.moveTo(ox + 5 * pitch, oy + top * pitch);
        ctx.lineTo(ox + 3 * pitch, oy + (top + 2) * pitch);
        ctx.stroke();
      }
      // 楚河汉界
      ctx.save();
      ctx.fillStyle = 'rgba(92,60,22,0.28)';
      ctx.fillRect(ox, oy + 4 * pitch, w, pitch);
      ctx.fillStyle = 'rgba(72,44,14,0.5)';
      ctx.font = `600 ${Math.max(10, Math.round(pitch * 0.52))}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('楚 河', ox + w * 0.28, oy + 4.5 * pitch);
      ctx.fillText('汉 界', ox + w * 0.72, oy + 4.5 * pitch);
      ctx.restore();
    } else {
      for (let x = 0; x < cols; x++) {
        ctx.beginPath(); ctx.moveTo(ox + x * pitch, oy); ctx.lineTo(ox + x * pitch, oy + h); ctx.stroke();
      }
      for (let y = 0; y < rows; y++) {
        ctx.beginPath(); ctx.moveTo(ox, oy + y * pitch); ctx.lineTo(ox + w, oy + y * pitch); ctx.stroke();
      }
      // 五子棋星位（15 路：3/7/11）
      ctx.fillStyle = 'rgba(70,45,15,0.85)';
      for (const sx of [3, 7, 11]) for (const sy of [3, 7, 11]) {
        ctx.beginPath();
        ctx.arc(ox + sx * pitch, oy + sy * pitch, Math.max(2, pitch * 0.09), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawGridBoard(ctx, state, L) {
    const { cell, ox, oy, w, h } = L;
    const pad = 4;
    if (state.mode === 'banqi') {
      const g = ctx.createLinearGradient(ox, oy, ox, oy + h);
      g.addColorStop(0, '#f1dcb4'); g.addColorStop(1, '#e3c894');
      ctx.fillStyle = g;
      ctx.fillRect(ox - pad, oy - pad, w + pad * 2, h + pad * 2);
      ctx.strokeStyle = 'rgba(90,60,20,0.55)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= state.cols; x++) {
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + h); ctx.stroke();
      }
      for (let y = 0; y <= state.rows; y++) {
        ctx.beginPath(); ctx.moveTo(ox, oy + y * cell); ctx.lineTo(ox + w, oy + y * cell); ctx.stroke();
      }
    } else if (state.mode === 'reversi') {
      for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
        ctx.fillStyle = ((x + y) % 2 === 0) ? '#1f6b3a' : '#1a5d33';
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    } else if (state.mode === 'jungle') {
      const J = Core().JUNGLE;
      for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
        let fill = ((x + y) % 2 === 0) ? '#e8d4a8' : '#dcc392'; // 陆地：暖沙色
        if (J.isWater(x, y)) fill = '#5a9bb5';                    // 河流：水蓝
        ctx.fillStyle = fill;
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
        // 陷阱：淡红圈标记
        const trap = J.trapOf(x, y);
        if (trap) {
          ctx.save();
          ctx.strokeStyle = trap === 'r' ? 'rgba(200,68,58,.75)' : 'rgba(47,58,74,.75)';
          ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
          ctx.strokeRect(ox + x * cell + 3, oy + y * cell + 3, cell - 6, cell - 6);
          ctx.restore();
        }
      }
      // 兽穴：金色菱形
      for (const side of ['r', 'b']) {
        const [dx, dy] = J.den(side), px = ox + dx * cell + cell / 2, py = oy + dy * cell + cell / 2;
        ctx.save(); ctx.fillStyle = side === 'r' ? 'rgba(200,68,58,.85)' : 'rgba(47,58,74,.85)';
        ctx.beginPath(); ctx.moveTo(px, py - cell*0.34); ctx.lineTo(px + cell*0.34, py);
        ctx.lineTo(px, py + cell*0.34); ctx.lineTo(px - cell*0.34, py); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#f5e6b0'; ctx.font = `bold ${Math.max(10,cell*0.32)}px ${SERIF}`;
        ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('穴', px, py);
        ctx.restore();
      }
      // 网格线
      ctx.strokeStyle = 'rgba(90,60,20,0.4)'; ctx.lineWidth = 1;
      for (let x=0;x<=state.cols;x++){ctx.beginPath();ctx.moveTo(ox+x*cell,oy);ctx.lineTo(ox+x*cell,oy+h);ctx.stroke();}
      for (let y=0;y<=state.rows;y++){ctx.beginPath();ctx.moveTo(ox,oy+y*cell);ctx.lineTo(ox+w,oy+y*cell);ctx.stroke();}
    }
  }

  function drawHexBoard(ctx, state, L) {
    const CC = Core().CC;
    const holes = CC.HOLES;
    const S3 = Math.sqrt(3);
    const r = L.size * 0.46;
    const at = (i) => [L.ox + S3 * (holes[i].q + holes[i].r / 2) * L.size, L.oy + 1.5 * holes[i].r * L.size];

    // 外轮廓：把 121 个孔连起来太丑，这里用两个三角做底
    ctx.save();
    ctx.fillStyle = 'rgba(60,42,24,0.10)';
    ctx.beginPath();
    const first = at(0);
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < holes.length; i++) { const p = at(i); ctx.lineTo(p[0], p[1]); }
    ctx.closePath();
    ctx.fill();

    // 两端起始三角着色（红方 +q 角、黑方 -q 角）
    for (const [side, zone, fill] of [
      ['r', CC.ZONE.r, 'rgba(200,68,58,0.20)'],
      ['b', CC.ZONE.b, 'rgba(47,58,74,0.22)'],
    ]) {
      ctx.beginPath();
      zone.forEach((i, k) => { const p = at(i); k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // 孔位
    for (let i = 0; i < holes.length; i++) {
      const [cx, cy] = at(i);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,246,226,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(96,66,30,0.45)';
      ctx.lineWidth = Math.max(1, L.size * 0.05);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBoardBg(ctx, state, L) {
    if (L.kind === 'hexstar') return drawHexBoard(ctx, state, L);
    if (L.kind === 'point') return drawPointBoard(ctx, state, L);
    return drawGridBoard(ctx, state, L);
  }

  /* ── 入口：绘制整盘 ───────────────────────────────────────────────── */

  function draw(ctx, state, layout, opts) {
    opts = opts || {};
    const L = layout;
    drawBoardBg(ctx, state, L);

    const radius = L.kind === 'hexstar' ? L.size * 0.46
      : L.kind === 'point' ? L.pitch * 0.44
        : L.cell * 0.44;

    // 合法落点
    if (opts.targets) {
      const isCheckers = state.mode === 'checkers';
      for (const t of opts.targets) {
        const p = posOf(L, t.x, t.y);
        if (!p) continue;
        ctx.save();
        if (isCheckers) {
          // 跳棋：落点用醒目的双层标记 —— 外圈描边 + 内实心点，跳跃落点(有 from)更亮更大。
          // 一维孔位棋盘上普通小点极易和空孔混淆，这里刻意放大并加光晕。
          const jump = !!(t.action && t.action.jump);
          const rr = Math.max(5, radius * (jump ? 0.42 : 0.34));
          ctx.shadowColor = jump ? 'rgba(255,206,74,0.9)' : 'rgba(96,214,142,0.9)';
          ctx.shadowBlur = 10;
          ctx.strokeStyle = jump ? 'rgba(255,206,74,0.95)' : 'rgba(96,214,142,0.95)';
          ctx.lineWidth = Math.max(2, radius * 0.14);
          ctx.beginPath(); ctx.arc(p[0], p[1], rr, 0, Math.PI * 2); ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.fillStyle = jump ? 'rgba(255,206,74,0.5)' : 'rgba(96,214,142,0.42)';
          ctx.beginPath(); ctx.arc(p[0], p[1], rr * 0.6, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(96,214,142,0.85)';
          ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(3, radius * 0.26), 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }
    // 上一手
    if (opts.lastMove) {
      const lm = opts.lastMove;
      const from = lm.flip ? lm.flip : lm.from;
      const to = lm.flip ? lm.flip : lm.to;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,206,74,0.92)';
      ctx.lineWidth = Math.max(2, radius * 0.14);
      for (const q of [from, to]) {
        if (!q) continue;
        const p = posOf(L, q[0], q[1]);
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p[0], p[1], radius * 1.02, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // 悬停合法点（五子棋/翻转棋）
    if (opts.hover && (state.mode === 'gomoku' || state.mode === 'reversi')) {
      const [hx, hy] = opts.hover;
      if (Core().actionsAt(state, hx, hy, state.turn).length) {
        const p = posOf(L, hx, hy);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,225,120,0.9)';
        ctx.lineWidth = Math.max(2, radius * 0.16);
        ctx.beginPath(); ctx.arc(p[0], p[1], radius * 0.8, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    // 选中
    if (opts.selected) {
      const [sx, sy] = opts.selected;
      const p = posOf(L, sx, sy);
      if (p) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,225,120,0.95)';
        ctx.lineWidth = Math.max(2, radius * 0.18);
        ctx.beginPath();
        ctx.arc(p[0], p[1], radius * 1.04, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 棋子
    if (state.mode === 'checkers') {
      for (let i = 0; i < Core().CC.HOLES.length; i++) {
        const info = Core().cellInfo(state, i, 0);
        if (!info) continue;
        const p = posOf(L, i, 0);
        checkerStone(ctx, p[0], p[1], radius, info.side);
      }
      return;
    }
    for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
      const info = Core().cellInfo(state, x, y);
      if (!info) continue;
      const p = posOf(L, x, y);
      if (!p) continue;
      if (state.mode === 'gomoku') gomokuStone(ctx, p[0], p[1], radius, info.side);
      else if (state.mode === 'reversi') reversiStone(ctx, p[0], p[1], radius, info.side);
      else if (state.mode === 'jungle') {
        // 斗兽棋：木质圆棋子 + 动物汉字（PIECE_LABEL 已并入八兽）
        woodPiece(ctx, p[0], p[1], radius, info.side, info.kind, true);
      }
      else woodPiece(ctx, p[0], p[1], radius, info.side, info.kind, info.faceUp);
    }
  }

  root.ShanhaiChessRender = Object.freeze({ computeLayout, cellAt, posOf, draw });
}(typeof globalThis !== 'undefined' ? globalThis : this));
