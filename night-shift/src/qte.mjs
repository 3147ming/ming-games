/**
 * QTE 小游戏（维修 / 清洁 / 上货）
 *
 * 玩家**亲手**做这三件事时，弹一个 5 秒内的迷你挑战；成功更快更便宜。
 * 三类动作本来的语义是"按 E → 立即完成 + 一小段 BUSY"，QTE 把这段"动作"可视化，
 * 并给做得好的玩家一个正向回馈（维修打折 / 动作更短）。
 *
 * ── 与店员 / 道具路径完全解耦 ────────────────
 * 店员 AI（staff.mjs）与道具（快速维修包 / 清洁喷雾）直接调 worldState / economy，
 * **不经过** interaction 的 repair/clean/place 分支，因此天然跳过 QTE ——
 * 这正是需求里"店员自动干可跳过动画"的含义。
 *
 * ── 架构（ADR-002 同精神）──────────────────
 * 上半部是三个纯逻辑工厂（createRepairQte / createCleanQte / createRestockQte），
 * 不碰 DOM / canvas，可在 Node 里完整单测；
 * 下半部是 openQte 外壳 —— 只负责 DOM 渲染、倒计时、pointer 交互与生命周期，
 * 动作真正落地（扣钱 / 清垃圾 / 上架）由 main 通过 onDone 回调执行。
 *
 * ── 为什么 QTE 期间要暂停（main 负责置 state.paused）────────────────
 * 原动作（维修 1.2s / 清洁 0.8s / 上货 0.8s）是"即时完成 + BUSY 锁定"，
 * 期间游戏时钟照走（机会成本）。QTE 化后玩家需要几秒专注操作，
 * 若时钟照走，顾客会在这几秒里流失，等于"做 QTE 反而更亏"，与需求背道而驰。
 * 因此 QTE 期间暂停游戏时钟，倒计时走**墙钟**（performance.now），两者解耦。
 */
import { QTE } from './config.mjs';
import sfx from './sfx.mjs';
import { fmtYuan } from './fmt.mjs';

const CW = 480;   // 画布逻辑宽
const CH = 420;   // 画布逻辑高

/* 美术色板（与 minigames.mjs / tokens.css 一致） */
const C = {
  panel: '#232A38', panel2: '#1B2230', line: '#3A4457',
  text: '#E6E2D6', dim: '#9AA3B2',
  money: '#6FCF97', danger: '#EB5757', brand: '#E8A94E', info: '#6BA8E8',
};

/* ============================================================
 *  纯逻辑工厂（可单测）
 * ========================================================== */

/**
 * 维修 QTE：生成打乱顺序的螺丝序列，判定点击、计错、算折扣。
 * @param params config.QTE.repair
 * @param rng    随机源（测试注入固定种子，生产用 Math.random）
 */
export function createRepairQte(params = QTE.repair, rng = Math.random) {
  const n = params.screws ?? 4;
  // Fisher-Yates 洗牌：螺丝"该点的顺序"随机，每次维修的序列都不同
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let progress = 0;   // 下一个应点的是 order[progress] 号螺丝
  let mistakes = 0;
  let done = false;

  return {
    get screws() { return n; },
    /** 螺丝的点击顺序（快照，测试用） */
    order() { return order.slice(); },
    /** 当前应点的螺丝编号；已完成为 -1 */
    target() { return done ? -1 : order[progress]; },
    get progress() { return progress; },
    get mistakes() { return mistakes; },
    /**
     * 点击第 i 号螺丝（i = 螺丝原始编号 0..n-1）。
     * 点对 → 推进；点错 → mistakes+1（最终维修费 +10%）。
     */
    tap(i) {
      if (done) return { ok: false, hit: false, reason: 'done' };
      if (i === order[progress]) {
        progress += 1;
        if (progress >= n) done = true;
        return { ok: true, hit: true, done };
      }
      mistakes += 1;
      return { ok: true, hit: false, done: false };
    },
    isDone() { return done; },
    /** 维修费倍率 = 折扣 × (1 + 错误×惩罚)，封顶 maxCostMul（做得差也不比直接修贵） */
    costMul() {
      const mul = (params.discountMul ?? 0.6) * (1 + (params.mistakePenalty ?? 0.1) * mistakes);
      return Math.min(params.maxCostMul ?? 1, mul);
    },
  };
}

/** 清洁 QTE：累计擦拭次数（擦满 need 下完成） */
export function createCleanQte(params = QTE.clean) {
  const need = params.wipes ?? 3;
  let wipes = 0;
  return {
    get need() { return need; },
    get wipes() { return wipes; },
    /** 擦一下（钳制到 need，不超） */
    swipe() { wipes = Math.min(need, wipes + 1); return wipes >= need; },
    isDone() { return wipes >= need; },
  };
}

/** 上货 QTE：判定"拖到哪一格合法"（空 / 同 SKU 未满） */
export function createRestockQte(params = QTE.restock) {
  let item = null;    // { skuId }
  let slots = [];     // [{ skuId|null, qty, cap? }]
  let dropped = false;
  return {
    /** 注入上下文（手上货物 + 当前货架状态） */
    setContext(item_, slots_) { item = item_; slots = slots_; },
    /** 第 i 格是否能放下手上的货（空 / 同 SKU 且未满） */
    canDrop(i) {
      const s = slots[i];
      if (!s || !item) return false;
      if (!s.skuId) return true;                 // 空格
      if (s.skuId !== item.skuId) return false;  // 异 SKU
      const cap = s.cap ?? Infinity;             // 未满（cap 缺省视为无上限）
      return (s.qty ?? 0) < cap;
    },
    drop(i) {
      if (dropped || !this.canDrop(i)) return false;
      dropped = true;
      return true;
    },
    isDone() { return dropped; },
  };
}

/* ============================================================
 *  DOM 外壳
 * ========================================================== */

let active = null;
export function isQteOpen() { return active !== null; }
export function closeQte() { if (active) active.abort('esc'); }

/* ---------- 绘制工具 ---------- */
function rr(g, x, y, w, h, r) {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}
function fill(g, x, y, w, h, r, color) {
  g.fillStyle = color;
  rr(g, x, y, w, h, r);
  g.fill();
}
function text(g, s, x, y, { size = 18, color = C.text, align = 'center', bold = false } = {}) {
  g.fillStyle = color;
  g.font = `${bold ? 'bold ' : ''}${size}px system-ui, "Segoe UI", sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}
/** 画一个"十字槽"螺丝（金属圆 + 一字槽） */
function drawScrew(g, x, y, r, { glow = false, done = false, wrong = false } = {}) {
  if (glow) {
    g.save();
    g.strokeStyle = C.brand;
    g.lineWidth = 4;
    g.shadowColor = C.brand;
    g.shadowBlur = 14;
    g.beginPath(); g.arc(x, y, r + 7, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  const body = wrong ? C.danger : done ? '#2E3A4E' : '#5A6577';
  g.fillStyle = body;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3A4457'; g.lineWidth = 2; g.stroke();
  // 一字槽（横 + 竖各一条细线）
  g.strokeStyle = done ? C.dim : '#232A38';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(x - r * 0.55, y); g.lineTo(x + r * 0.55, y); g.stroke();
  g.beginPath(); g.moveTo(x, y - r * 0.55); g.lineTo(x, y + r * 0.55); g.stroke();
  if (done) {
    // 已拧好：打一个淡色对勾
    g.strokeStyle = C.money;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x - r * 0.32, y); g.lineTo(x - r * 0.05, y + r * 0.28); g.lineTo(x + r * 0.36, y - r * 0.28);
    g.stroke();
  }
}

/**
 * 打开一个 QTE 面板。
 * @param spec { kind, title, baseCost?, item?, slots?, onDone }
 *   - kind: 'repair' | 'clean' | 'restock'
 *   - onDone(outcome): outcome = { ok, result?, reason? }
 *     repair.result  = { mistakes, costMul }
 *     clean.result   = { wipes }
 *     restock.result = { slotIndex }
 *     失败 reason = 'esc' | 'timeout'
 */
export function openQte(spec) {
  if (active) return null;
  const limit = spec.timeLimitSec ?? QTE.timeLimitSec;

  /* ---- 逻辑实例 ---- */
  let game = null;
  if (spec.kind === 'repair') {
    game = createRepairQte(QTE.repair, Math.random);
  } else if (spec.kind === 'clean') {
    game = createCleanQte(QTE.clean);
  } else if (spec.kind === 'restock') {
    game = createRestockQte(QTE.restock);
    game.setContext(spec.item ?? null, spec.slots ?? []);
  } else {
    return null;
  }

  /* ---- 布局常量（各 kind 自己的交互区坐标） ---- */
  const screws = spec.kind === 'repair'
    ? (() => {
      const n = game.screws;
      const positions = [];
      const cx = CW / 2, cy = CH / 2 + 10;
      const span = 150;
      if (n === 4) {
        positions.push({ x: cx - span / 2, y: cy - 90 }, { x: cx + span / 2, y: cy - 90 },
          { x: cx - span / 2, y: cy + 90 }, { x: cx + span / 2, y: cy + 90 });
      } else {
        for (let i = 0; i < n; i++) {
          positions.push({ x: cx + (i - (n - 1) / 2) * (span / (Math.max(2, n - 1) / 2)), y: cy });
        }
      }
      return positions;
    })()
    : [];

  const ERASE_LEN = 96;   // 抹布在污渍内拖过这么多像素算"擦一下"

  /* ---- DOM ---- */
  const root = document.createElement('div');
  root.style.cssText = `position:fixed;inset:0;z-index:85;display:flex;align-items:center;
    justify-content:center;background:rgba(8,11,17,.82);backdrop-filter:blur(2px);`;
  const card = document.createElement('div');
  card.style.cssText = `display:flex;flex-direction:column;gap:10px;max-height:94vh;`;
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  canvas.setAttribute('data-el', 'qte-canvas');
  canvas.style.cssText = `width:min(480px,92vw);height:auto;max-height:72vh;border-radius:14px;
    border:1px solid ${C.line};background:${C.panel2};display:block;touch-action:none;cursor:crosshair;`;
  const bar = document.createElement('div');
  bar.style.cssText = `width:min(480px,92vw);display:flex;justify-content:space-between;
    color:${C.dim};font:13px system-ui,sans-serif;padding:0 4px;`;
  card.appendChild(canvas);
  card.appendChild(bar);
  root.appendChild(card);
  document.body.appendChild(root);

  const g = canvas.getContext('2d');

  /* ---- 运行时状态 ---- */
  let elapsed = 0;
  let last = performance.now();
  let raf = 0;
  let finished = false;

  /* 清洁：抹布位置 + 上次指针在污渍内的位置 */
  const cloth = { x: CW / 2, y: CH / 2, lastX: null, lastY: null, dragging: false };
  /* 上货：货物方块中心 + 是否被拾起 */
  const box = { x: CW / 2, y: 80, grabbed: false, dx: 0, dy: 0 };
  const slotRects = [];   // 上货货架格的命中矩形

  function ptrPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (CW / r.width),
      y: (e.clientY - r.top) * (CH / r.height),
    };
  }

  /* ---------- 上货：货架格布局 ---------- */
  function layoutSlots() {
    slotRects.length = 0;
    const slots = spec.slots ?? [];
    const perRow = 4;
    const startY = 230;
    const rowH = 78;
    const w = 92, h = 62;
    const total = Math.max(1, slots.length);
    const rows = Math.ceil(total / perRow);
    slots.forEach((s, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const cols = Math.min(perRow, total - r * perRow);
      const x0 = CW / 2 + (c - cols / 2) * (w + 10);
      const y0 = startY + r * rowH;
      slotRects.push({ x0, y0, w, h, skuId: s.skuId, qty: s.qty });
    });
  }
  if (spec.kind === 'restock') layoutSlots();

  /* ---------- 交互处理 ---------- */
  function onDown(e) {
    const p = ptrPos(e);
    if (spec.kind === 'repair') {
      // 点最近的螺丝
      let hit = -1, best = 26 * 26;
      screws.forEach((s, i) => {
        const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
        if (d < best) { best = d; hit = i; }
      });
      if (hit >= 0) {
        const res = game.tap(hit);
        if (res.hit) { sfx.clack(); if (game.isDone()) finishOk(); }
        else { sfx.bad(); wrongFlash = 0.3; wrongIndex = hit; }
      }
    } else if (spec.kind === 'clean') {
      cloth.dragging = true;
      cloth.lastX = null; cloth.lastY = null;
    } else if (spec.kind === 'restock') {
      const r = boxRect();
      if (p.x >= r.x0 && p.x <= r.x0 + r.w && p.y >= r.y0 && p.y <= r.y0 + r.h) {
        box.grabbed = true;
        box.dx = p.x - box.x;
        box.dy = p.y - box.y;
      }
    }
  }
  function onMove(e) {
    const p = ptrPos(e);
    if (spec.kind === 'clean') {
      cloth.x = p.x; cloth.y = p.y;
      if (cloth.dragging && inStain(p.x, p.y)) {
        if (cloth.lastX == null) { cloth.lastX = p.x; cloth.lastY = p.y; }
        else {
          const d = Math.hypot(p.x - cloth.lastX, p.y - cloth.lastY);
          eraseAccum += d;
          cloth.lastX = p.x; cloth.lastY = p.y;
          while (eraseAccum >= ERASE_LEN && !game.isDone()) {
            eraseAccum -= ERASE_LEN;
            game.swipe();
            sfx.clack();
            if (game.isDone()) { finishOk(); return; }
          }
        }
      }
    } else if (spec.kind === 'restock' && box.grabbed) {
      box.x = p.x - box.dx;
      box.y = p.y - box.dy;
    }
  }
  function onUp(e) {
    const p = ptrPos(e);
    if (spec.kind === 'clean') { cloth.dragging = false; cloth.lastX = null; cloth.lastY = null; }
    else if (spec.kind === 'restock' && box.grabbed) {
      box.grabbed = false;
      // 松手时货物中心 = box.x = p.x - box.dx（onMove 里 box 中心一直跟随指针）
      const cx = p.x - box.dx;
      const cy = p.y - box.dy;
      let landed = -1;
      slotRects.forEach((r, i) => {
        if (cx >= r.x0 && cx <= r.x0 + r.w && cy >= r.y0 && cy <= r.y0 + r.h) landed = i;
      });
      if (landed >= 0) {
        if (game.drop(landed)) { finishOk({ slotIndex: landed }); return; }
        sfx.bad();
        // 拖到非法格：货物弹回原位
        box.x = CW / 2; box.y = 80;
      } else {
        box.x = CW / 2; box.y = 80;
      }
    }
  }
  function boxRect() {
    return { x0: box.x - 46, y0: box.y - 20, w: 92, h: 40 };
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  /* 清洁：污渍区判定 + 擦除累计 */
  let eraseAccum = 0;
  function inStain(x, y) {
    const sx = CW / 2, sy = CH / 2 + 10;
    return (x - sx) ** 2 / (150 ** 2) + (y - sy) ** 2 / (90 ** 2) <= 1;
  }

  let wrongFlash = 0;
  let wrongIndex = -1;

  /* ---------- 收尾 ---------- */
  function finishOk(extra = {}) {
    if (finished) return;
    finished = true;
    sfx.ok();
    if (spec.kind === 'repair') {
      spec.onDone?.({ ok: true, result: { mistakes: game.mistakes, costMul: game.costMul() } });
    } else if (spec.kind === 'clean') {
      spec.onDone?.({ ok: true, result: { wipes: game.wipes } });
    } else {
      spec.onDone?.({ ok: true, result: { slotIndex: extra.slotIndex } });
    }
    teardown();
  }
  function abort(reason) {
    if (finished) return;
    finished = true;
    spec.onDone?.({ ok: false, reason });
    teardown();
  }
  function teardown() {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey);
    root.remove();
    active = null;
  }
  function onKey(e) {
    if (e.code === 'Escape') { e.preventDefault(); abort('esc'); }
  }
  window.addEventListener('keydown', onKey);
  active = { abort };
  /* 探针/调试钩子：把逻辑与布局挂到 canvas 上，端到端探针据此模拟"点击螺丝/擦污渍/拖货"
   * 完成 QTE 并验证 onDone 的动作落地。仅附加只读引用，不影响正常游玩。 */
  canvas.__qte = {
    kind: spec.kind,
    game,
    screws,
    slotRects,
    box,
    cloth,
    CW,
    CH,
    stain: { x: CW / 2, y: CH / 2 + 10, rx: 150, ry: 90 },
  };

  /* ---------- 绘制 ---------- */
  function draw() {
    g.clearRect(0, 0, CW, CH);

    /* 倒计时条 */
    const remain = Math.max(0, 1 - elapsed / limit);
    fill(g, 20, 18, CW - 40, 10, 5, C.panel);
    fill(g, 20, 18, (CW - 40) * remain, 10, 5, remain < 0.25 ? C.danger : C.brand);
    text(g, spec.title, CW / 2, 52, { size: 20, bold: true });

    if (spec.kind === 'repair') {
      // 设备面板
      fill(g, CW / 2 - 190, 90, 380, 300, 14, C.panel);
      text(g, `拧好 ${game.screws} 颗螺丝 · 按高亮顺序 · 点错 +10%`, CW / 2, 120, { size: 14, color: C.dim });
      const target = game.target();
      screws.forEach((s, i) => {
        const isTarget = i === target;
        const isDone = game.order().indexOf(i) < game.progress;
        const isWrong = i === wrongIndex && wrongFlash > 0;
        drawScrew(g, s.x, s.y, 24, { glow: isTarget, done: isDone, wrong: isWrong });
      });
      if (wrongFlash > 0) {
        wrongFlash -= 0.016;
        text(g, `点错了！+10% ×${game.mistakes}`, CW / 2, 90, { size: 15, color: C.danger, bold: true });
      }
      if (spec.baseCost != null) {
        const final = Math.ceil(spec.baseCost * game.costMul());
        text(g, `维修费 ${fmtYuan(spec.baseCost)} → ${fmtYuan(final)}`, CW / 2, 380, { size: 15, color: final < spec.baseCost ? C.money : C.text });
      }
    } else if (spec.kind === 'clean') {
      fill(g, CW / 2 - 190, 100, 380, 230, 14, C.panel);
      const sx = CW / 2, sy = CH / 2 + 10;
      // 污渍：随擦拭次数变淡
      const fade = 1 - game.wipes / Math.max(1, game.need);
      g.save();
      g.globalAlpha = 0.25 + 0.65 * fade;
      g.fillStyle = '#6B5A48';
      g.beginPath(); g.ellipse(sx, sy, 150, 90, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4A3F32';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.beginPath();
        g.arc(sx + Math.cos(a) * 70, sy + Math.sin(a) * 40, 18 + (i % 3) * 8, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      // 抹布
      g.fillStyle = C.info;
      g.beginPath(); g.arc(cloth.x, cloth.y, 20, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      text(g, `按住拖动抹布擦污渍 · ${game.wipes}/${game.need}`, CW / 2, 90, { size: 14, color: C.dim });
      text(g, `洁净度擦除中…`, CW / 2, 380, { size: 15, color: C.text });
    } else if (spec.kind === 'restock') {
      const item = spec.item ?? { skuId: null, emoji: '📦', qty: 0 };
      // 货物方块（可拖动）
      const r = boxRect();
      fill(g, r.x0, r.y0, r.w, r.h, 10, C.info);
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
      text(g, `${item.emoji ?? '📦'} ${item.qty ?? 0}`, box.x, box.y, { size: 16, bold: true });
      text(g, '把货物拖到绿色货架格', CW / 2, 160, { size: 15, color: C.dim });
      // 货架格
      slotRects.forEach((s, i) => {
        const legal = game.canDrop(i);
        const color = legal ? C.money : '#3A4457';
        g.strokeStyle = color;
        g.lineWidth = legal ? 3 : 2;
        rr(g, s.x0, s.y0, s.w, s.h, 8);
        g.stroke();
        g.fillStyle = legal ? 'rgba(111,207,151,.10)' : 'rgba(58,68,87,.20)';
        rr(g, s.x0, s.y0, s.w, s.h, 8); g.fill();
        text(g, s.skuId ? `${s.qty}` : '空', s.x0 + s.w / 2, s.y0 + s.h / 2, { size: 15, color: legal ? C.money : C.dim });
      });
    }
  }

  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!finished) {
      elapsed += dt;
      if (elapsed >= limit) { abort('timeout'); return; }
    }
    draw();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return { abort };
}
