/**
 * 娱乐设施小游戏（可玩设施）
 *
 * 统一外壳：靠近设施 → 交互提示 → 按 E 进入 → 说明面板 → 游玩 → 结算 → 退出。
 * 四个游戏共用同一套流程与绘制工具，新增同类设施只需：
 *   1) 在 config.FACILITIES 加一条
 *   2) 在 config.MINIGAME 加参数
 *   3) 在下面的 GAMES 注册一个 kind（或复用已有 kind）
 *
 * 平衡原则：期望收益 ≤ 投入（成本 + 占用时间），因此"刷小游戏"不会取代便利店经营。
 * 游玩期间**不暂停游戏时钟**，顾客照常进店排队/流失 —— 这就是机会成本。
 */
import { MINIGAME } from './config.mjs';
import { FACILITY_BY_ID } from './facilities.mjs';
import sfx from './sfx.mjs';
import { fmtYuan, fmtYuanSigned } from './fmt.mjs';

const CW = 480;   // 画布逻辑宽
const CH = 620;   // 画布逻辑高

/* 美术圣经色板（与 tokens.css 一致） */
const C = {
  panel: '#232A38', panel2: '#1B2230', line: '#3A4457',
  text: '#E6E2D6', dim: '#9AA3B2',
  money: '#6FCF97', danger: '#EB5757', brand: '#E8A94E', info: '#6BA8E8',
};

/* ---------- 绘制工具 ---------- */
function rr(g, x, y, w, h, r) {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}
function panel(g, x, y, w, h, fill = C.panel) {
  g.fillStyle = fill;
  rr(g, x, y, w, h, 12);
  g.fill();
  g.strokeStyle = C.line;
  g.lineWidth = 2;
  g.stroke();
}
function text(g, s, x, y, { size = 18, color = C.text, align = 'center', bold = false } = {}) {
  g.fillStyle = color;
  g.font = `${bold ? 'bold ' : ''}${size}px system-ui, "Segoe UI", sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}
/** 按权重抽一项 */
function pick(list) {
  const total = list.reduce((a, b) => a + (b.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const it of list) {
    r -= (it.weight ?? 1);
    if (r <= 0) return it;
  }
  return list[list.length - 1];
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ============================================================
 *  弹珠机：左右移动发射位 → 选球种/用道具 → 发射 → 碰钉下落 → 落槽计分
 *
 *  状态机设计（多球并发的关键）：
 *    phase 只表达"玩家接下来能做什么"，不表达"场上有没有球"。
 *      'aim'  可继续发射（还有余球）；此时**空中弹珠照常推进物理**
 *      'drop' 余球已发完，等场上最后一颗球落袋
 *      'done' 余球为 0 **且** 场上无球 —— 唯一结算条件
 *    历史 bug：旧版把 phase 当"场上是否有球"用，导致
 *      ① update() 在 aim 阶段直接 return → 空中球永久冻结（卡死）
 *      ② 单球落袋且仍有余球时立刻切回 aim → 同上，剩余球全冻住
 *      ③ 最后一颗球落袋的瞬间就判 done → 其它在空中的球被吞掉（提前结束）
 *    现在 airborne（场上球数）与 left（余球数）是两条独立线索，互不覆盖。
 *
 *  R4 玩法扩充（本函数内）：
 *    · 球种：normal / heavy / lucky / bomb —— 影响物理与倍率
 *    · 道具：导轨石（垂直下落）/ 磁石（吸向中央）/ 加倍符（下一球 ×3）
 *    · 连击：连续落进非空槽累积 combo，落空清零，倍率 1 + combo*step（封顶）
 *    · 关卡：按累计游玩次数取 P.levels，钉子变多、重力变大、槽位倍率提高
 *
 *  平衡护栏：期望收益仍须 ≤ 投币额。倍率与连击抬高的部分，由"更高关卡难度"
 *  和"道具额度有限"抵消；测试第 6 节对**基础局**（不带道具/连击）做硬断言，
 *  并额外断言"即便是完美连击也只在满级倍率内可控"。
 * ========================================================== */
function createPachinko(P, ctx = {}) {
  /* ---- 关卡：按该设施的累计游玩次数决定难度档 ---- */
  const plays = Math.max(0, ctx.plays ?? 0);
  const levels = P.levels ?? [];
  let lv = levels[0] ?? null;
  for (const L of levels) if (plays >= L.minPlays) lv = L;
  const pegRows = lv?.pegRows ?? P.pegRows;
  const pegCols = lv?.pegCols ?? P.pegCols;
  const gravity = lv?.gravity ?? P.gravity;
  const slotMul = lv?.slotMul ?? 1;

  /* 反馈出口：游戏只"报告发生了什么"，外壳决定听起来/看起来是什么。
   * 缺省空实现 —— 让游戏逻辑能在 Node 里脱离浏览器单测（见 createGame 的注释）。 */
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};

  const pegs = [];
  const topY = 150;
  const slotY = CH - 96;
  const rowGap = Math.max(46, 62 - (pegRows - 6) * 4); // 钉子变多时收紧行距，避免溢出
  for (let r = 0; r < pegRows; r++) {
    const cols = r % 2 === 0 ? pegCols : pegCols - 1;
    for (let c = 0; c < cols; c++) {
      const spanW = CW - 80;
      const x = 40 + (spanW * (c + 0.5)) / cols + (r % 2 === 0 ? 0 : spanW / (cols * 2));
      pegs.push({ x, y: topY + r * rowGap });
    }
  }
  // 落槽：宽度按 weight 比例分配 → 物理概率 = 权重
  const totalW = P.slots.reduce((a, s) => a + s.weight, 0);
  const slots = [];
  let acc = 40;
  const availW = CW - 80;
  for (const s of P.slots) {
    const w = (availW * s.weight) / totalW;
    slots.push({ ...s, x0: acc, x1: acc + w });
    acc += w;
  }

  const ballTypes = P.ballTypes ?? [{ id: 'normal', name: '标准珠', weight: 1, radius: 9, mul: 1, color: '#E8EAF0', edge: '#9AA3B2' }];
  const TYPE_BY_ID = Object.fromEntries(ballTypes.map((t) => [t.id, t]));
  const items = (P.items ?? []).map((it) => ({ ...it, left: it.uses ?? 1 }));
  const ITEM_BY_ID = Object.fromEntries(items.map((it) => [it.id, it]));
  const COMBO = P.combo ?? { step: 0.25, max: 8, label: '连击' };

  const S = {
    phase: 'aim',   // aim（可发射，球照常飞）→ drop（余球已发完，等落袋）→ done
    aimX: CW / 2,
    balls: [],
    left: P.balls,
    score: 0,
    lastGain: 0,
    launches: 0,    // 已发射数，用于判定"是否还能再发"
    msg: '按 ← → 调整位置，空格发射',
    /* R4 新增 */
    level: lv?.lv ?? 1,
    levelLabel: lv?.label ?? '',
    slotMul,
    combo: 0,
    bestCombo: 0,
    items,          // 剩余道具（含 left 计数）
    itemLog: [],    // 本局用过哪些道具（结算展示）
    lastType: null, // 上一次抽到的球种（UI 提示用）
    history: [],    // 每颗球的落槽记录 { typeId, label, raw, gain, combo }
  };

  /** 还能再发射一颗吗 */
  function canLaunch() {
    return S.left > 0;
  }

  /** 按权重抽一个球种 */
  function rollType() {
    const total = ballTypes.reduce((a, t) => a + (t.weight ?? 1), 0);
    let r = Math.random() * total;
    for (const t of ballTypes) {
      r -= (t.weight ?? 1);
      if (r <= 0) return t;
    }
    return ballTypes[ballTypes.length - 1];
  }

  /** 当前连击倍率 */
  function comboMul() {
    return 1 + Math.min(S.combo, COMBO.max) * COMBO.step;
  }

  function launch() {
    if (S.left <= 0) return;
    S.left -= 1;
    S.launches += 1;
    const type = rollType();
    S.lastType = type;
    const doubled = S._doubleNext === true;
    S._doubleNext = false;
    S.balls.push({
      x: S.aimX,
      y: 70,
      vx: S._verticalNext ? 0 : (Math.random() - 0.5) * 40,
      vy: 0,
      typeId: type.id,
      radius: type.radius,
      vMul: doubled ? 3 : 1,   // 加倍符：本球结算 ×3
      // 防"骑钉"（见 update 里的破平衡逻辑）：记录最高点与滞留时长
      refY: 70,
      stuckT: 0,
      stuckN: 0,
    });
    S._verticalNext = false;
    // 只要还有余球就留在 aim（玩家可以连发）；发完了才切 drop 等收尾
    S.phase = canLaunch() ? 'aim' : 'drop';
    S.msg = canLaunch()
      ? `${type.name}已发射，剩余 ${S.left} 颗 · 可继续发射`
      : `最后一颗（${type.name}）下落中…`;
  }

  /**
   * 使用道具。返回是否成功（额度不足 / 时机不对则失败）。
   * 道具一律在 aim 阶段使用 —— 让"什么时候花"成为决策点。
   */
  function useItem(id) {
    const it = ITEM_BY_ID[id];
    if (!it || it.left <= 0) return false;
    if (S.phase !== 'aim') return false;
    if (id === 'guide') {
      S._verticalNext = true;
    } else if (id === 'magnet') {
      // 把场上所有球吸向中央：给一个朝中心的横向速度
      for (const b of S.balls) {
        b.vx += (CW / 2 - b.x) * 1.6;
      }
      if (S.balls.length === 0) return false; // 场上没球可吸 → 不消耗额度
    } else if (id === 'double') {
      S._doubleNext = true;
    } else {
      return false;
    }
    it.left -= 1;
    S.itemLog.push(it.name);
    S.msg = `使用「${it.name}」· ${it.desc}`;
    return true;
  }

  function update(dt) {
    if (S.phase === 'done') return;

    // 注意：这里**不再**按 phase 提前 return。
    // 'aim' 阶段场上可能有球在飞（连发），物理必须照常推进，否则就是卡死。
    for (let i = S.balls.length - 1; i >= 0; i--) {
      const b = S.balls[i];
      const bt = TYPE_BY_ID[b.typeId] ?? ballTypes[0];
      const R = b.radius ?? bt.radius;
      b.vy += gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < 26) { b.x = 26; b.vx = Math.abs(b.vx) * 0.6; }
      if (b.x > CW - 26) { b.x = CW - 26; b.vx = -Math.abs(b.vx) * 0.6; }
      for (const p of pegs) {
        if (p.gone) continue;                       // 被爆破珠炸掉的钉子
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < R + 6) {
          const nx = dx / (d || 1);
          const ny = dy / (d || 1);
          b.x = p.x + nx * (R + 6);
          b.y = p.y + ny * (R + 6);
          const dot = b.vx * nx + b.vy * ny;
          b.vx -= 2 * dot * nx;
          b.vy -= 2 * dot * ny;
          b.vx += (Math.random() - 0.5) * 90;
          b.vx *= 0.86;
          b.vy *= 0.7;
          // 爆破珠：撞到钉子就炸掉它（一次一颗，避免连锁清屏）
          if (bt.id === 'bomb') p.gone = true;
        }
      }
      /* 防"骑钉"破平衡（真实 bug，不是测试问题）。
       * 钉子碰撞是"推出表面 + 反射速度 + ×0.7 衰减"：当球恰好停在**钉顶正上方**时，
       * 反射给的上抛速度每帧衰减、重力又把它压回来，会在钉顶形成一个**稳定平衡点** ——
       * 球永远悬在那，y 再也到不了 slotY，于是"余球发完且场上清空"的收尾条件永不成立，
       * 整局卡死（玩家只能 Esc 退出）。实测在随机种子下约 1/6 概率复现。
       * 这里只做一件事：**球只要 0.5s 内没有实际下移，就给一记随机横向冲量把它踢下钉子**，
       * 且越卡越用力（stuckN 递增）以确保有限时间内一定脱离。
       * 正常下落的球永远不会触发，因此不影响落点分布与期望收益。 */
      if (b.y > b.refY + 0.5) { b.refY = b.y; b.stuckT = 0; }
      else { b.stuckT += dt; }
      if (b.stuckT > 0.5) {
        b.stuckN += 1;
        const force = Math.min(4, b.stuckN);
        b.vx += (Math.random() - 0.5) * 140 * force;
        b.vy += 55 * force;
        b.stuckT = 0;
        b.refY = b.y;
      }

      if (b.y >= slotY) {
        const slot = slots.find((s) => b.x >= s.x0 && b.x < s.x1) ?? slots[0];
        // 连击：非空槽累积，空槽清零
        if (slot.score > 0) S.combo += 1;
        else S.combo = 0;
        S.bestCombo = Math.max(S.bestCombo, S.combo);
        /* 计分口径（刻意避免乘数连乘）：
         *   base  = 槽分 × 球种倍率 × 加倍符 × 关卡倍率   ← 这三个是"明确的付费/难度对应物"
         *   gain  = base + 槽分 × (连击倍率 − 1)          ← 连击只加成**槽分**，不放大前面那串倍率
         * 这样做的好处：连击是免费放大器，把它限制在"基础槽分"这个量级上，
         * 就不会与其它倍率相乘滚雪球（否则基础期望会被顶过投币额，见 gameplay.test 第 6 节）。 */
        const base = slot.score * (bt.mul ?? 1) * (b.vMul ?? 1) * slotMul;
        const comboBonus = slot.score * (comboMul() - 1);
        const gain = Math.round(base + comboBonus);
        S.score += gain;
        S.lastGain = gain;
        S.history.push({
          typeId: bt.id, label: slot.label, raw: slot.score, gain, combo: S.combo,
        });
        S.msg = slot.score > 0
          ? `落槽「${slot.label}」 +${gain}${S.combo > 1 ? ` · 连击×${S.combo}` : ''}`
          : '落槽「空」 · 连击中断';
        // 需求：落点"嗒"一声 + 微震；大奖金色粒子（由外壳按 slotScore 判定）
        fx('land', { slotScore: slot.score, gain, combo: S.combo });
        S.balls.splice(i, 1);
      }
    }

    // 唯一的收尾判定：余球发完 且 场上清空
    if (S.left === 0 && S.balls.length === 0) {
      S.phase = 'done';
      S.msg = `全部落袋 · 共得 ${S.score} 分`;
    } else if (S.phase === 'drop' && S.balls.length > 0) {
      S.msg = `收尾中 · 场上 ${S.balls.length} 颗`;
    }
  }

  function draw(g) {
    g.fillStyle = C.panel2;
    g.fillRect(0, 0, CW, CH);
    // 钉子（被炸掉的钉子画成暗色残迹）
    for (const p of pegs) {
      g.fillStyle = p.gone ? 'rgba(138,147,165,0.22)' : '#8A93A5';
      g.beginPath();
      g.arc(p.x, p.y, 6, 0, Math.PI * 2);
      g.fill();
    }
    // 落槽
    for (const s of slots) {
      const w = s.x1 - s.x0;
      g.fillStyle = s.score >= 10 ? 'rgba(232,169,78,0.30)' : 'rgba(107,168,232,0.16)';
      g.fillRect(s.x0, slotY, w, 46);
      g.strokeStyle = C.line;
      g.lineWidth = 1.5;
      g.strokeRect(s.x0, slotY, w, 46);
      text(g, `${s.label}`, s.x0 + w / 2, slotY + 16, { size: 11, color: C.dim });
      const shown = Math.round(s.score * slotMul);
      text(g, `+${shown}`, s.x0 + w / 2, slotY + 32, { size: 13, color: s.score >= 10 ? C.brand : C.text, bold: true });
    }
    // 发射轨道（余球为 0 时淡出，表示不能再发）
    g.fillStyle = S.left > 0 ? 'rgba(232,169,78,0.5)' : 'rgba(232,169,78,0.14)';
    g.fillRect(40, 40, CW - 80, 6);
    if (S.left > 0) {
      g.fillStyle = C.brand;
      g.beginPath();
      g.arc(S.aimX, 62, 11, 0, Math.PI * 2);
      g.fill();
    }
    // 弹珠（可同时多颗在场；按球种上色，爆破珠带红圈）
    for (const b of S.balls) {
      const bt = TYPE_BY_ID[b.typeId] ?? ballTypes[0];
      const R = b.radius ?? bt.radius;
      g.fillStyle = bt.color;
      g.beginPath();
      g.arc(b.x, b.y, R, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = bt.edge;
      g.lineWidth = 2;
      g.stroke();
      if (b.vMul > 1) {   // 加倍符生效：外圈高亮
        g.strokeStyle = C.money;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(b.x, b.y, R + 3, 0, Math.PI * 2);
        g.stroke();
      }
    }

    /* ---- HUD：关卡 / 连击 / 道具额度（画在画布内，随小游戏面板一起缩放） ---- */
    // 关卡条（左上）
    g.fillStyle = 'rgba(8,11,17,0.55)';
    rr(g, 12, 58, 132, 24, 8);
    g.fill();
    text(g, `Lv.${S.level} ${S.levelLabel}`, 78, 70, { size: 12, color: C.brand, bold: true });

    // 连击条（右上）：有连击才显眼
    const cm = comboMul();
    g.fillStyle = S.combo > 0 ? 'rgba(232,169,78,0.22)' : 'rgba(8,11,17,0.55)';
    rr(g, CW - 144, 58, 132, 24, 8);
    g.fill();
    text(g, `${COMBO.label} ×${S.combo}（倍率 ${cm.toFixed(2)}）`, CW - 78, 70, {
      size: 11, color: S.combo > 0 ? C.brand : C.dim, bold: S.combo > 0,
    });

    // 道具槽（底部消息条上方）
    const iy = CH - 118;
    items.forEach((it, i) => {
      const x = 40 + i * 96;
      const usable = it.left > 0 && S.phase === 'aim';
      g.fillStyle = usable ? 'rgba(107,168,232,0.20)' : 'rgba(58,68,87,0.30)';
      rr(g, x, iy, 88, 40, 9);
      g.fill();
      g.strokeStyle = usable ? C.info : C.line;
      g.lineWidth = 1.5;
      g.stroke();
      text(g, `${it.emoji} ${it.name}`, x + 44, iy + 14, { size: 11, color: usable ? C.text : C.dim });
      text(g, `×${it.left}`, x + 44, iy + 30, { size: 11, color: it.left > 0 ? C.money : C.dim, bold: true });
    });
    text(g, '按 1/2/3 使用道具', CW - 150, iy + 20, { size: 10, color: C.dim, align: 'left' });
  }

  /** 结算：把本局亮点汇总成一行文案 */
  function resultLabel() {
    const parts = [`弹珠机 ${S.score} 分`];
    if (S.bestCombo >= 2) parts.push(`最高连击×${S.bestCombo}`);
    if (S.level > 1) parts.push(`Lv.${S.level}`);
    return parts.join(' · ');
  }

  return {
    S,
    update,
    draw,
    confirm: launch,
    // canAct 供外壳判断"现在按键算不算一次有效操作"（多球在场时仍可继续发射）
    canAct: canLaunch,
    /** R4：道具接口，供外壳按 1/2/3 调用 */
    useItem,
    left: () => `剩余弹珠 ${S.left}`,
    scoreText: () => `得分 ${S.score}${S.combo > 0 ? ` · 连击×${S.combo}` : ''}`,
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => ({
      payout: S.score,
      label: resultLabel(),
      combo: S.bestCombo,
      level: S.level,
      items: [...S.itemLog],
    }),
    help: `投币 ${fmtYuan(P.cost)} 得 ${P.balls} 颗弹珠，可连发 · 落槽计分（1 分 = ¥1）\n`
      + `球种不同倍率不同，连击不断则分数翻倍；1/2/3 使用道具`,
  };
}

/* ============================================================
 *  钓鱼：抛竿 → 等待上钩 → 限时反应 → 收杆 QTE → 收获
 * ========================================================== */
function createFishing(P, ctx = {}) {
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};
  const S = {
    phase: 'ready',  // ready → wait → bite → reel → done
    t: 0,
    biteAt: 0,
    biteLeft: 0,
    ptr: 0,
    ptrDir: 1,
    green0: 0.35,
    green1: 0.35 + P.greenRatio,
    caught: null,
    /** 收杆前先抽好鱼：只为"稀有鱼拉扯时画面轻微抖动"的表现（抽取权重与时机无关） */
    pending: null,
    rare: false,
    tensionT: 0,
    msg: '按空格抛竿',
  };

  function cast() {
    S.phase = 'wait';
    S.t = 0;
    S.biteAt = P.castMinSec + Math.random() * (P.castMaxSec - P.castMinSec);
    S.msg = '抛竿完成…等待鱼儿上钩';
  }

  function bite() {
    S.phase = 'bite';
    S.biteLeft = 1.1; // 反应窗口
    S.msg = '⬆ 有动静！按空格收杆';
    fx('bite', {});   // 需求：咬钩瞬间鱼竿震动提示 + 水花声
  }

  function startReel() {
    S.phase = 'reel';
    S.ptr = 0;
    S.ptrDir = 1;
    const max0 = 1 - P.greenRatio;
    S.green0 = Math.random() * max0;
    S.green1 = S.green0 + P.greenRatio;
    /* 鱼在"进入收杆"时就抽定 —— 权重不变、期望不变，只是为了能提前表现
     * "稀有鱼拉扯"（大鱼才会让画面抖）。原来是在 confirm 时才抽。 */
    S.pending = pick(P.fish);
    S.rare = (S.pending?.price ?? 0) >= 20;
    S.tensionT = 0;
    S.msg = '在绿色区域按空格收杆！';
  }

  function finish(okItem) {
    S.phase = 'done';
    S.caught = okItem;
    S.msg = okItem ? `🎣 钓到 ${okItem.name}！` : '💧 鱼跑了…';
    fx('catch', { ok: !!okItem, price: okItem?.price ?? 0, name: okItem?.name ?? '' });
  }

  function update(dt) {
    if (S.phase === 'wait') {
      S.t += dt;
      if (S.t >= S.biteAt) bite();
    } else if (S.phase === 'bite') {
      S.biteLeft -= dt;
      if (S.biteLeft <= 0) finish(null);
    } else if (S.phase === 'reel') {
      S.ptr += S.ptrDir * P.reelSpeed * dt;
      if (S.ptr > 1) { S.ptr = 1; S.ptrDir = -1; }
      if (S.ptr < 0) { S.ptr = 0; S.ptrDir = 1; }
      // 稀有鱼会持续"拉扯"：每隔一小段触发一次轻微画面抖动（需求）
      if (S.rare) {
        S.tensionT -= dt;
        if (S.tensionT <= 0) {
          S.tensionT = 0.5 + Math.random() * 0.35;
          fx('tension', {});
        }
      }
    }
  }

  function confirm() {
    if (S.phase === 'ready') { cast(); return; }
    if (S.phase === 'bite') { startReel(); return; }
    if (S.phase === 'reel') {
      const ok = S.ptr >= S.green0 && S.ptr <= S.green1;
      finish(ok ? pick(P.fish) : null);
    }
  }

  function draw(g) {
    // 夜色水面
    const sky = g.createLinearGradient(0, 0, 0, CH * 0.55);
    sky.addColorStop(0, '#0B1220');
    sky.addColorStop(1, '#1B2A3D');
    g.fillStyle = sky;
    g.fillRect(0, 0, CW, CH * 0.55);
    const water = g.createLinearGradient(0, CH * 0.55, 0, CH);
    water.addColorStop(0, '#123049');
    water.addColorStop(1, '#0A1725');
    g.fillStyle = water;
    g.fillRect(0, CH * 0.55, CW, CH * 0.45);
    // 波纹
    g.strokeStyle = 'rgba(150,190,230,0.20)';
    g.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const y = CH * 0.58 + i * 26 + Math.sin(S.t * 2 + i) * 3;
      g.beginPath();
      g.moveTo(20, y);
      g.lineTo(CW - 20, y);
      g.stroke();
    }
    // 浮标
    const bobY = CH * 0.62 + (S.phase === 'bite' ? Math.sin(S.t * 22) * 8 : 0);
    g.fillStyle = S.phase === 'bite' ? C.brand : '#E05A5A';
    g.beginPath();
    g.arc(CW / 2, bobY, 12, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.stroke();
    // 钓线
    g.strokeStyle = 'rgba(230,226,214,0.5)';
    g.beginPath();
    g.moveTo(CW / 2, 120);
    g.lineTo(CW / 2, bobY);
    g.stroke();

    // 收杆 QTE 条
    if (S.phase === 'reel') {
      const bx = 60;
      const bw = CW - 120;
      const by = CH - 140;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      rr(g, bx, by, bw, 34, 8);
      g.fill();
      g.fillStyle = C.money;
      g.fillRect(bx + bw * S.green0, by, bw * (S.green1 - S.green0), 34);
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      g.strokeRect(bx, by, bw, 34);
      g.fillStyle = C.text;
      g.fillRect(bx + bw * S.ptr - 3, by - 8, 6, 50);
      // 咬钩倒计时
      text(g, '收杆！', CW / 2, by - 24, { size: 16, color: C.brand, bold: true });
    }
  }

  return {
    S,
    update,
    draw,
    confirm,
    left: () => (S.phase === 'wait' ? '等待上钩…' : S.phase === 'bite' ? `反应！${S.biteLeft.toFixed(1)}s` : '空闲'),
    scoreText: () => (S.caught ? `收获 ${S.caught.name}` : '鱼篓空空'),
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => (S.caught
      ? { payout: S.caught.price, label: `${S.caught.name} ${fmtYuan(S.caught.price)}`, item: S.caught.name }
      : { payout: 0, label: '鱼跑了' }),
    help: '免费游玩 · 抛竿等待上钩 → 抓住时机收杆 → 鱼可换钱',
  };
}

/* ============================================================
 *  投篮机：力度条 → 出手 → 抛物线 → 进/不进 → 计分
 * ========================================================== */
function createBasketball(P, ctx = {}) {
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};
  const S = {
    phase: 'aim',   // aim → fly → done
    power: 0,
    dir: 1,
    shots: P.shots,
    hits: 0,
    /** 连中数（连中 ≥2 时数字跳动 + 加倍反馈；投失清零） */
    streak: 0,
    bestStreak: 0,
    /** 命中后的"数字跳动"余量（1 → 0，仅影响显示，不参与结算，见 draw 的连中加倍） */
    _hitPop: 0,
    ball: null,
    t: 0,
    msg: '力度条到绿色区域时按空格出手',
  };
  const G = 1200;
  const hoop = { x: CW - 108, y: 250 };

  function shoot() {
    const p = S.power;               // 0..1
    const vx = 190 + p * 250;
    const vy = -(560 + p * 210);
    S.ball = { x: 120, y: 430, vx, vy, t: 0 };
    S.phase = 'fly';
    S.shots -= 1;
    S.msg = '出手！';
  }

  function update(dt) {
    S.t += dt;
    if (S._hitPop > 0) S._hitPop = Math.max(0, S._hitPop - dt * 2.6);  // 数字跳动余量自然回落
    if (S.phase === 'aim') {
      S.power += S.dir * 1.0 * dt;
      if (S.power > 1) { S.power = 1; S.dir = -1; }
      if (S.power < 0) { S.power = 0; S.dir = 1; }
      return;
    }
    if (S.phase === 'fly' && S.ball) {
      const b = S.ball;
      b.t += dt;
      b.vy += G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // 进筐判定：经过篮筐高度且水平接近
      if (b.vy > 0 && b.y >= hoop.y - 6 && b.y <= hoop.y + 22 && Math.abs(b.x - hoop.x) < 34) {
        S.hits += 1;
        S.streak += 1;
        S.bestStreak = Math.max(S.bestStreak, S.streak);
        S._hitPop = 1;                 // 触发"数字跳动"
        S.msg = S.streak >= 2 ? `🎯 空心入网！连中 ${S.streak}` : '🎯 空心入网！';
        fx('hit', { hits: S.hits, streak: S.streak });
        S.ball = null;
        nextShot();
        return;
      }
      if (b.y > CH - 60 || b.x > CW + 40) {
        S.msg = '💨 没进';
        S.streak = 0;
        fx('miss', {});
        S.ball = null;
        nextShot();
      }
    }
  }

  function nextShot() {
    if (S.shots > 0) { S.phase = 'aim'; S.power = 0; S.dir = 1; }
    else S.phase = 'done';
  }

  function confirm() {
    if (S.phase === 'aim') shoot();
  }

  function draw(g) {
    g.fillStyle = C.panel2;
    g.fillRect(0, 0, CW, CH);
    // 地板
    g.fillStyle = '#2A3342';
    g.fillRect(0, CH - 60, CW, 60);
    // 篮筐
    g.fillStyle = C.brand;
    g.fillRect(hoop.x - 34, hoop.y, 68, 8);
    g.strokeStyle = '#E05A5A';
    g.lineWidth = 4;
    g.strokeRect(hoop.x - 26, hoop.y + 8, 52, 26);
    // 球
    if (S.ball) {
      g.fillStyle = '#E8834E';
      g.beginPath();
      g.arc(S.ball.x, S.ball.y, 15, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#7A3E22';
      g.lineWidth = 2;
      g.stroke();
    } else {
      g.fillStyle = '#E8834E';
      g.beginPath();
      g.arc(120, 430, 15, 0, Math.PI * 2);
      g.fill();
    }
    // 连中反馈（需求）：命中瞬间数字跳动放大；连中 ≥2 时追加"×N"强调（加倍语义只在**显示**层，
    // 不改 result().payout —— 那是玩法数值，minigame.test 有硬断言）
    const pop = 1 + S._hitPop * 0.6;
    const money = S.hits * P.payPerHit;
    text(g, fmtYuan(money), CW / 2, 44, {
      size: Math.round(26 * pop), align: 'center',
      color: S._hitPop > 0.05 ? C.brand : C.text, bold: true,
    });
    if (S.streak >= 2) {
      text(g, `连中 ×${S.streak}`, CW / 2, 72, { size: 14, align: 'center', color: C.money, bold: true });
    }
    // 力度条（绿区来自配置，与实际命中区间一致）
    if (S.phase === 'aim') {
      const bx = 70;
      const bw = CW - 140;
      const by = CH - 120;
      const g0 = P.green0 ?? 0.55;
      const g1 = P.green1 ?? 0.78;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      rr(g, bx, by, bw, 30, 8);
      g.fill();
      g.fillStyle = C.money;
      g.fillRect(bx + bw * g0, by, bw * (g1 - g0), 30);
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      g.strokeRect(bx, by, bw, 30);
      g.fillStyle = C.text;
      g.fillRect(bx + bw * S.power - 3, by - 6, 6, 42);
      text(g, '力度', bx - 12, by + 15, { size: 13, color: C.dim, align: 'right' });
    }
  }

  return {
    S,
    update,
    draw,
    confirm,
    left: () => `剩余 ${S.shots} 球`,
    scoreText: () => `命中 ${S.hits}/${P.shots}`,
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => {
      const payout = S.hits * P.payPerHit;
      return {
        payout,
        hits: S.hits,
        streak: S.bestStreak,
        label: `命中 ${S.hits} 球 · ${fmtYuan(payout)}${S.bestStreak >= 2 ? ` · 最高连中 ${S.bestStreak}` : ''}`,
      };
    },
    help: `投币 ${fmtYuan(P.cost)} 得 ${P.shots} 球，每命中一球 ${fmtYuan(P.payPerHit)}`,
  };
}

/* ============================================================
 *  抓娃娃机：爪子摆动 → 空格下爪 → 成功率判定 → 奖品
 * ========================================================== */
function createClaw(P, ctx = {}) {
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};
  const S = {
    phase: 'move',  // move → drop → rise → done
    clawX: 0.2,
    dir: 1,
    clawY: 0,
    got: null,
    msg: '爪子左右摆动中，对准后按空格下爪',
  };
  const target = { x: 0.35 + Math.random() * 0.3, w: 0.12 }; // 目标娃娃位置

  function update(dt) {
    if (S.phase === 'move') {
      S.clawX += S.dir * P.moveSpeed * dt * 0.5;
      if (S.clawX > 0.9) { S.clawX = 0.9; S.dir = -1; }
      if (S.clawX < 0.1) { S.clawX = 0.1; S.dir = 1; }
    } else if (S.phase === 'drop') {
      S.clawY += dt * 1.4;
      if (S.clawY >= 1) { S.clawY = 1; S.phase = 'rise'; judge(); }
    } else if (S.phase === 'rise') {
      S.clawY -= dt * 1.2;
      if (S.clawY <= 0) { S.clawY = 0; S.phase = 'done'; }
    }
  }

  function judge() {
    const dist = Math.abs(S.clawX - target.x);
    // 对准有加成，越偏离越难
    const chance = clamp(P.grabBase + (1 - dist / 0.5) * (P.alignBonus ?? 0.3), 0.05, 0.92);
    const ok = Math.random() < chance;
    if (ok) {
      S.got = pick(P.prizes);
      S.msg = `🎉 抓到 ${S.got.name}！`;
    } else {
      S.msg = '😥 爪子松了…';
    }
    // 需求：抓到 → 闪光 + 震动；空抓 → 泄气声
    fx('grab', { ok, name: S.got?.name ?? '' });
  }

  function confirm() {
    if (S.phase === 'move') { S.phase = 'drop'; S.msg = '下爪中…'; fx('drop'); }
  }

  function draw(g) {
    g.fillStyle = C.panel2;
    g.fillRect(0, 0, CW, CH);
    // 机柜内景
    panel(g, 30, 60, CW - 60, CH - 220, '#182030');
    // 娃娃堆
    const bx = 40;
    const bw = CW - 80;
    for (let i = 0; i < 7; i++) {
      const x = bx + bw * (0.12 + (i % 4) * 0.2);
      const y = CH - 200 - Math.floor(i / 4) * 56;
      g.fillStyle = ['#E8834E', '#6FCF97', '#6BA8E8', '#B08BD8'][i % 4];
      g.beginPath();
      g.arc(x, y, 22, 0, Math.PI * 2);
      g.fill();
    }
    // 目标娃娃（高亮）
    g.strokeStyle = C.brand;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(bx + bw * target.x, CH - 200, 26, 0, Math.PI * 2);
    g.stroke();
    // 爪子
    const cx = bx + bw * S.clawX;
    const cy = 120 + (CH - 320) * S.clawY;
    g.strokeStyle = C.text;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx, 100);
    g.lineTo(cx, cy);
    g.stroke();
    g.fillStyle = C.dim;
    g.fillRect(cx - 18, cy, 36, 12);
    g.beginPath();
    g.moveTo(cx - 18, cy + 12);
    g.lineTo(cx - 26, cy + 34);
    g.moveTo(cx + 18, cy + 12);
    g.lineTo(cx + 26, cy + 34);
    g.stroke();
    // 目标提示
    text(g, '对准发光的娃娃', CW / 2, CH - 130, { size: 14, color: C.dim });
  }

  return {
    S,
    update,
    draw,
    confirm,
    left: () => (S.phase === 'move' ? '按空格下爪' : S.phase === 'done' ? '结束' : '操作中'),
    scoreText: () => (S.got ? `${S.got.name} ${fmtYuan(S.got.price)}` : '两手空空'),
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => (S.got
      ? { payout: S.got.price, label: `${S.got.name} ${fmtYuan(S.got.price)}`, item: S.got.name }
      : { payout: 0, label: '没抓到' }),
    help: `投币 ${fmtYuan(P.cost)} 玩一次，对准娃娃下爪，抓到可换钱`,
  };
}

/* ============================================================
 *  跳舞机（节奏 QTE）：箭头从上方进入判定圈 → 按对应方向键
 *
 *  判定口径：把"像素距离"换算成"时间差"再比对窗口 ——
 *  直接比像素的话，改一次 approachSec（出箭速度）判定手感就全变了；
 *  换算成秒之后，窗口就是 config 里写的那几个数，改速度不影响难度。
 *
 *  平衡：与弹珠机同一条纪律（期望 ≤ 投币额）—— 基础分 ×0.4 且封顶 ¥16，
 *  满连击完美通关才可能摸到上限，正常发挥在 ¥6–9。
 * ========================================================== */
function createDance(P, ctx = {}) {
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};
  const DIRS = [
    { id: 'left', label: '←', x: 0 },
    { id: 'down', label: '↓', x: 1 },
    { id: 'up', label: '↑', x: 2 },
    { id: 'right', label: '→', x: 3 },
  ];
  const RING_Y = 508;
  const SPAWN_Y = 74;
  const TRAVEL = RING_Y - SPAWN_Y;
  const approach = P.approachSec ?? 1.5;
  const spawnEvery = P.spawnEvery ?? 0.5;
  const arrowsTotal = P.arrows ?? 32;
  const KEYMAP = { ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', ArrowRight: 'right' };

  const S = {
    phase: 'play',
    t: 0,
    spawned: 0,
    arrows: [],          // { dir, born, judged, res }
    combo: 0, bestCombo: 0,
    perfect: 0, good: 0, miss: 0,
    score: 0,
    judge: '',
    judgeT: 0,
    msg: '箭头进圈的瞬间按对应方向键',
  };

  const speed = () => TRAVEL / approach;   // px/s
  /** 距离 → 时间差（秒） */
  const dtOf = (a) => Math.abs((SPAWN_Y + speed() * (S.t - a.born)) - RING_Y) / speed();

  function judgeArrow(a, res) {
    a.judged = true;
    a.res = res;
    if (res === 'perfect') {
      S.perfect += 1; S.combo += 1; S.score += (P.scorePer?.perfect ?? 3) * comboMul();
      S.judge = 'PERFECT!';
    } else if (res === 'good') {
      S.good += 1; S.combo += 1; S.score += (P.scorePer?.good ?? 1) * comboMul();
      S.judge = 'GOOD';
    } else {
      S.miss += 1; S.combo = 0; S.judge = 'MISS';
    }
    S.bestCombo = Math.max(S.bestCombo, S.combo);
    S.judgeT = 0.45;
    fx('step', { res, combo: S.combo });
  }

  function comboMul() {
    const step = P.comboStep ?? 0.05;
    const cap = 1 + (P.comboMax ?? 5) * step;
    return Math.min(cap, 1 + S.combo * step);
  }

  function onKey(code) {
    const dir = KEYMAP[code];
    if (!dir) return false;
    // 取"同方向且未判定、离判定圈最近"的那一支
    let best = null;
    let bestDt = Infinity;
    for (const a of S.arrows) {
      if (a.judged || a.dir !== dir) continue;
      const d = dtOf(a);
      if (d < bestDt) { bestDt = d; best = a; }
    }
    if (!best) return true;                       // 空按不惩罚，只是没反应
    if (bestDt <= (P.perfectWin ?? 0.09)) judgeArrow(best, 'perfect');
    else if (bestDt <= (P.goodWin ?? 0.2)) judgeArrow(best, 'good');
    else judgeArrow(best, 'miss');
    return true;
  }

  function update(dt) {
    S.t += dt;
    if (S.judgeT > 0) S.judgeT = Math.max(0, S.judgeT - dt);
    // 出箭
    while (S.spawned < arrowsTotal && S.t >= S.spawned * spawnEvery) {
      S.arrows.push({ dir: DIRS[Math.floor(Math.random() * DIRS.length)].id, born: S.spawned * spawnEvery, judged: false, res: null });
      S.spawned += 1;
    }
    // 越过判定窗 → 自动判 Miss
    for (const a of S.arrows) {
      if (a.judged) continue;
      const y = SPAWN_Y + speed() * (S.t - a.born);
      if (y > RING_Y + (P.goodWin ?? 0.2) * speed()) judgeArrow(a, 'miss');
    }
    // 结束条件：全部出完且全部判定完
    if (S.spawned >= arrowsTotal && S.arrows.every((a) => a.judged)) S.phase = 'done';
  }

  function draw(g) {
    g.fillStyle = C.panel2;
    g.fillRect(0, 0, CW, CH);
    // 四条轨道
    const laneW = (CW - 80) / 4;
    for (let i = 0; i < 4; i++) {
      const x = 40 + i * laneW;
      g.fillStyle = i % 2 ? 'rgba(35,42,56,.55)' : 'rgba(27,34,48,.55)';
      g.fillRect(x, 60, laneW - 6, RING_Y - 60 + 60);
    }
    // 判定圈
    for (let i = 0; i < 4; i++) {
      const cx = 40 + i * laneW + (laneW - 6) / 2;
      g.strokeStyle = C.info;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx, RING_Y, 34, 0, Math.PI * 2);
      g.stroke();
      text(g, DIRS[i].label, cx, RING_Y, { size: 26, color: C.dim });
    }
    // 箭头
    for (const a of S.arrows) {
      if (a.judged) continue;
      const idx = DIRS.findIndex((d) => d.id === a.dir);
      const cx = 40 + idx * laneW + (laneW - 6) / 2;
      const y = SPAWN_Y + speed() * (S.t - a.born);
      if (y < 40 || y > CH - 70) continue;
      g.fillStyle = idx === 0 ? '#6BA8E8' : idx === 3 ? '#E8A94E' : idx === 1 ? '#6FCF97' : '#B15BD8';
      rr(g, cx - 28, y - 24, 56, 48, 10);
      g.fill();
      text(g, DIRS[idx].label, cx, y, { size: 24, color: '#10141C', bold: true });
    }
    // 判定字
    if (S.judgeT > 0) {
      const col = S.judge === 'PERFECT!' ? C.money : S.judge === 'GOOD' ? C.info : C.danger;
      text(g, S.judge, CW / 2, RING_Y - 90, { size: 34, color: col, bold: true });
    }
    // HUD
    text(g, `连击 ${S.combo} · 最高 ${S.bestCombo}`, CW / 2, 92, { size: 18, color: C.brand, bold: true });
    text(g, `P ${S.perfect} / G ${S.good} / M ${S.miss}`, CW / 2, 118, { size: 14, color: C.dim });
  }

  return {
    S,
    update,
    draw,
    onKey,
    confirm() {},
    left: () => `剩余 ${arrowsTotal - S.spawned} 箭`,
    scoreText: () => `连击 ${S.combo}`,
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => {
      /* 上限取**投币额本身**：满连击也只是把币赚回来，金币上不赚不亏，
       * 真正的奖励是代币与排行榜成绩（沿用弹珠机那条"刷机不取代经营"的纪律）。
       * 这里刻意不写死数字 —— 写死过 16，而 cost 只有 10，等于白送 ¥6。 */
      const payout = Math.min(P.cost, Math.round(S.score * 0.4));
      return {
        payout,
        combo: S.bestCombo,
        score: S.score,
        label: `连击 ${S.bestCombo} · PERFECT ${S.perfect}`,
      };
    },
    help: `投币 ${fmtYuan(P.cost)} 玩一局 · 箭头进圈时按 ←↓↑→\n连击越高分越高`,
  };
}

/* ============================================================
 *  赛车机：30 秒漂移短局
 *
 *  玩法抽象：不模拟真实车辆物理（那需要赛道数据与调参，成本高且难平衡），
 *  而是"赛道中心线在摆动 → 玩家用左右键把车贴在中心线上"：
 *    · 贴线时间占比高的弯道 → 完美过弯
 *    · 每 3 秒算一个弯，一局 10 个弯
 *  这样"速度与完美过弯"是可读的、可断言的，也保留了漂移的手感判断。
 * ========================================================== */
function createRacing(P, ctx = {}) {
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};
  const DUR = P.durationSec ?? 30;
  const CORNER_SEC = 3;
  const S = {
    phase: 'run',
    t: 0,
    carX: 0,          // -1..1
    centerX: 0,       // -1..1 赛道中心线
    speed: P.baseSpeed ?? 60,
    inLine: false,
    cornerT: 0,
    cornerGood: 0,
    perfect: 0,
    driftScore: 0,
    corners: 0,
    msg: '用 ← → 把车贴在赛道中心线上',
    judge: '',
    judgeT: 0,
  };
  const steer = { left: false, right: false };

  /** 赛道中心线：两个不同频率的正弦叠加 → 弯道节奏不呆板 */
  function centerAt(t) {
    return Math.sin(t * 1.15) * 0.62 + Math.sin(t * 0.47 + 1.1) * 0.3;
  }

  function onKey(code) {
    if (code === 'ArrowLeft' || code === 'ArrowRight') {
      // 这里只做"按住"状态；真实转向在 update 里按 dt 积分
      steer[code === 'ArrowLeft' ? 'left' : 'right'] = true;
      return true;
    }
    return false;
  }
  /** 松键由外壳在 keyup 时调用（缺省空实现：不响应也不会卡住） */
  function onKeyUp(code) {
    if (code === 'ArrowLeft') steer.left = false;
    if (code === 'ArrowRight') steer.right = false;
  }

  function update(dt) {
    S.t += dt;
    if (S.judgeT > 0) S.judgeT = Math.max(0, S.judgeT - dt);
    // 速度：起步加速到上限
    S.speed = Math.min(P.maxSpeed ?? 120, S.speed + (P.accel ?? 18) * dt);
    // 转向
    const steerSpeed = 1.7;
    if (steer.left) S.carX -= steerSpeed * dt;
    if (steer.right) S.carX += steerSpeed * dt;
    S.carX = clamp(S.carX, -1.15, 1.15);
    S.centerX = centerAt(S.t);
    const off = Math.abs(S.carX - S.centerX);
    S.inLine = off < 0.26;
    if (S.inLine) {
      S.driftScore += (P.driftBonusPerSec ?? 2) * dt;
      S.cornerGood += dt;
    }
    // 弯道结算
    S.cornerT += dt;
    if (S.cornerT >= CORNER_SEC) {
      S.cornerT -= CORNER_SEC;
      S.corners += 1;
      const ratio = S.cornerGood / CORNER_SEC;
      if (ratio >= 0.7) {
        S.perfect += 1;
        S.judge = '完美过弯！';
        fx('perfect', { perfect: S.perfect });
      } else {
        S.judge = '过弯失误';
      }
      S.judgeT = 0.6;
      S.cornerGood = 0;
    }
    if (S.t >= DUR) S.phase = 'done';
  }

  function draw(g) {
    g.fillStyle = C.panel2;
    g.fillRect(0, 0, CW, CH);
    // 路面（自上而下的伪 3D：越往下越宽）
    const topW = 90;
    const botW = 330;
    for (let i = 0; i < 26; i++) {
      const p = i / 26;
      const y = 70 + p * (CH - 190);
      const w = topW + (botW - topW) * p;
      const cx = CW / 2 + centerAt(S.t + (1 - p) * 1.4) * (w * 0.42);
      g.fillStyle = i % 2 ? '#2A3242' : '#232A38';
      g.fillRect(cx - w / 2, y, w, (CH - 190) / 26 + 1);
      // 中心虚线
      if (i % 2 === 0) {
        g.fillStyle = 'rgba(232,169,78,.55)';
        g.fillRect(cx - 2, y, 4, (CH - 190) / 26 + 1);
      }
    }
    // 车
    const carY = CH - 150;
    const carX = CW / 2 + S.carX * (botW * 0.42);
    g.fillStyle = S.inLine ? C.money : C.danger;
    rr(g, carX - 26, carY - 18, 52, 36, 8);
    g.fill();
    text(g, '🏎️', carX, carY, { size: 22 });
    // HUD
    text(g, `完美过弯 ${S.perfect} / ${S.corners}`, CW / 2, 92, { size: 18, color: C.brand, bold: true });
    text(g, `速度 ${Math.round(S.speed)} km/h · 剩余 ${Math.max(0, Math.ceil(DUR - S.t))}s`, CW / 2, 118, { size: 14, color: C.dim });
    if (S.judgeT > 0) {
      text(g, S.judge, CW / 2, carY - 80, { size: 26, color: S.judge.includes('完美') ? C.money : C.danger, bold: true });
    }
  }

  return {
    S,
    update,
    draw,
    onKey,
    onKeyUp,
    confirm() {},
    left: () => `剩余 ${Math.max(0, Math.ceil(DUR - S.t))}s`,
    scoreText: () => `完美 ${S.perfect}`,
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => {
      const payout = Math.min(P.cost, Math.round(S.perfect * (P.scorePerCorner ?? 4) + S.driftScore * 0.1));
      return {
        payout,
        perfect: S.perfect,
        score: S.perfect,
        label: `完美过弯 ${S.perfect} 次`,
      };
    },
    help: `投币 ${fmtYuan(P.cost)} 玩 30 秒 · ← → 贴住赛道中心线\n每 3 秒算一个弯，贴线达标即完美过弯`,
  };
}

/* ============================================================
 *  KTV 唱歌机：选曲 → 按节奏在音准条上按空格 → 打分
 *
 *  社交属性：评分越高越可能"带友"—— 每台最多连带 3 名顾客进店。
 *  带友数由 result.friends 返回，main 决定怎么落地（生成 NPC），
 *  游戏本身不碰顾客系统（保持可脱离浏览器单测）。
 * ========================================================== */
function createKtv(P, ctx = {}) {
  const fx = typeof ctx.fx === 'function' ? ctx.fx : () => {};
  const songs = P.songs ?? [];
  const NOTES = P.notes ?? 10;
  const S = {
    phase: 'run',
    t: 0,
    songIdx: 0,
    song: songs[1] ?? songs[0] ?? { id: 'pop', name: '流行热歌', difficulty: 1, tempo: 1.15 },
    notes: [],           // { at, hit, judged }
    spawned: 0,
    hits: 0,
    score: 0,
    pointer: 0,          // 0..1 音准条上的指针位置
    dir: 1,
    judge: '',
    judgeT: 0,
    msg: '指针进入绿色区时按空格',
  };
  const every = 1.1;

  function buildNotes() {
    S.notes = [];
    for (let i = 0; i < NOTES; i++) {
      S.notes.push({ at: 0.9 + i * every / (S.song.tempo ?? 1), hit: false, judged: false });
    }
  }
  buildNotes();

  function onKey(code) {
    if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3') {
      const i = Number(code.slice(-1)) - 1;
      if (songs[i]) {
        S.songIdx = i;
        S.song = songs[i];
        S.msg = `已选曲：${S.song.name}`;
      }
      return true;
    }
    if (code !== 'Space') return false;
    // 取最近的未判定音符
    let best = null;
    let bestDt = Infinity;
    for (const n of S.notes) {
      if (n.judged) continue;
      const d = Math.abs(S.t - n.at);
      if (d < bestDt) { bestDt = d; best = n; }
    }
    if (!best) return true;
    best.judged = true;
    if (bestDt <= (P.hitWindow ?? 0.22)) {
      best.hit = true;
      S.hits += 1;
      S.score += Math.round((P.scorePerHit ?? 3) * (S.song.difficulty ?? 1) * 10) / 10;
      S.judge = '♪ 命中';
      fx('note', { ok: true, score: S.score });
    } else {
      S.judge = '跑调…';
      fx('note', { ok: false });
    }
    S.judgeT = 0.5;
    return true;
  }

  function update(dt) {
    S.t += dt;
    if (S.judgeT > 0) S.judgeT = Math.max(0, S.judgeT - dt);
    // 指针在音准条上往复
    S.pointer += S.dir * dt * (0.55 * (S.song.tempo ?? 1));
    if (S.pointer > 1) { S.pointer = 1; S.dir = -1; }
    if (S.pointer < 0) { S.pointer = 0; S.dir = 1; }
    // 漏掉的音符
    for (const n of S.notes) {
      if (!n.judged && S.t > n.at + (P.hitWindow ?? 0.22)) {
        n.judged = true;
        S.judge = '漏唱';
        S.judgeT = 0.4;
      }
    }
    const last = S.notes[S.notes.length - 1];
    if (last && S.t > last.at + (P.hitWindow ?? 0.22) + 0.4) S.phase = 'done';
  }

  function draw(g) {
    g.fillStyle = C.panel2;
    g.fillRect(0, 0, CW, CH);
    text(g, `🎤 ${S.song.name}`, CW / 2, 92, { size: 20, color: C.brand, bold: true });
    text(g, '1/2/3 换曲 · 指针进绿区按空格', CW / 2, 118, { size: 13, color: C.dim });

    // 音准条
    const bx = 60;
    const bw = CW - 120;
    const by = CH / 2 - 30;
    g.fillStyle = C.panel;
    rr(g, bx, by, bw, 60, 12);
    g.fill();
    // 绿区（0.42–0.58）
    g.fillStyle = 'rgba(111,207,151,.35)';
    g.fillRect(bx + bw * 0.42, by, bw * 0.16, 60);
    g.strokeStyle = C.money;
    g.lineWidth = 2;
    g.strokeRect(bx + bw * 0.42, by, bw * 0.16, 60);
    // 指针
    const px = bx + bw * S.pointer;
    g.fillStyle = C.brand;
    g.fillRect(px - 3, by - 8, 6, 76);

    // 音符轨道
    for (const n of S.notes) {
      const d = n.at - S.t;
      if (d > 3 || d < -0.6) continue;
      const x = CW / 2 + d * 120;
      g.fillStyle = n.judged ? (n.hit ? C.money : C.danger) : C.info;
      g.beginPath();
      g.arc(x, CH / 2 + 90, n.judged ? 8 : 11, 0, Math.PI * 2);
      g.fill();
    }
    // 判定环
    g.strokeStyle = C.text;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(CW / 2, CH / 2 + 90, 16, 0, Math.PI * 2);
    g.stroke();

    text(g, `得分 ${Math.round(S.score)} · 命中 ${S.hits}/${NOTES}`, CW / 2, CH / 2 + 150, { size: 18, color: C.text, bold: true });
    if (S.judgeT > 0) text(g, S.judge, CW / 2, CH / 2 + 190, { size: 22, color: S.judge.includes('命中') ? C.money : C.danger, bold: true });
  }

  return {
    S,
    update,
    draw,
    onKey,
    confirm() {},
    left: () => `命中 ${S.hits}/${NOTES}`,
    scoreText: () => `${Math.round(S.score)} 分`,
    msg: () => S.msg,
    isDone: () => S.phase === 'done',
    result: () => {
      const score = Math.round(S.score);
      const bf = P.bringFriends ?? { threshold: 18, max: 3 };
      const friends = score >= bf.threshold ? Math.min(bf.max, Math.floor(score / 12)) : 0;
      const payout = Math.min(P.cost, Math.round(score * 0.5));
      return {
        payout,
        score,
        friends,
        hits: S.hits,
        label: `${S.song.name} · ${score} 分${friends ? ` · 带来 ${friends} 位客人` : ''}`,
      };
    },
    help: `投币 ${fmtYuan(P.cost)} 唱一首 · 1/2/3 选曲\n指针进绿区按空格 · 分数越高越能带来客人`,
  };
}

export const GAMES = {
  pachinko: createPachinko,
  fishing: createFishing,
  basketball: createBasketball,
  claw: createClaw,
  /* 星级解锁的新机器（2★ 跳舞机 / 3★ 赛车机 / 4★ KTV） */
  dance: createDance,
  racing: createRacing,
  ktv: createKtv,
};

/**
 * 只建游戏逻辑（不碰 DOM），供测试与将来的"无 UI 自动演示"使用。
 * @param {string} kind
 * @param {object} params config.MINIGAME[kind]
 * @param {object} [ctx]  运行时上下文（R4：plays = 该设施累计游玩次数，决定关卡档）
 * @returns 游戏实例或 null（未知 kind）
 */
export function createGame(kind, params, ctx = {}) {
  const factory = GAMES[kind];
  if (!factory) return null;
  return factory(params ?? MINIGAME[kind] ?? {}, ctx);
}

/* ============================================================
 *  统一外壳
 * ========================================================== */
let active = null;

export function isMinigameOpen() {
  return active !== null;
}

/**
 * 打开一个小游戏
 * @param {string} facilityId config.FACILITIES 的 id
 * @param {object} hooks { canPay, pay, reward, onClose, plays, name, night, onLeaderboard }
 *   - plays：该设施累计游玩次数（R4 关卡递进用）
 *   - name / night：写入本地排行榜时展示的身份与夜次
 *   - onLeaderboard(kind, result)：结算后回报排行结果（返回 { rank, isBest } 时用于展示）
 */
export function openMinigame(facilityId, hooks = {}) {
  if (active) return null;
  const fac = FACILITY_BY_ID[facilityId];
  if (!fac) return null;
  const P = MINIGAME[fac.kind];

  /* ---------- 反馈状态（音效 / 震动 / 白闪 / 金色粒子） ----------
   * 放在建 game 之前：game 的 fx 回调会往上抛事件，这里必须先就绪。
   * 注意命名：本函数内已有一个 flashT（"现金不足"文字提示的计时），
   * 白闪另起 hitFlash，避免重名把那个提示顶掉。 */
  let shakeT = 0;
  let shakeDur = 0.2;
  let shakeAmp = 0;
  let hitFlash = 0;
  const sparks = [];

  function shake(amp, dur = 0.2) {
    shakeAmp = Math.max(shakeAmp, amp);
    shakeDur = dur;
    shakeT = dur;
  }

  function sparkBurst(n = 26) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 280;
      sparks.push({
        x: CW / 2 + (Math.random() - 0.5) * 70,
        y: CH / 2 + (Math.random() - 0.5) * 50,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 100,
        life: 0.7 + Math.random() * 0.5,
        max: 1.2,
        r: 2 + Math.random() * 3,
      });
    }
    if (sparks.length > 160) sparks.splice(0, sparks.length - 160);  // 兜底防堆积
  }

  /**
   * 游戏事件 → 反馈。
   * 游戏只喊"发生了什么"，这里决定"听起来/看起来是什么" ——
   * 于是调音效与调玩法互不干扰，游戏逻辑也能脱离浏览器单测。
   */
  function fxEvent(type, p = {}) {
    switch (type) {
      case 'land':
        sfx.clack();
        shake(3.5, 0.12);
        if (p.slotScore >= 8) { sfx.jackpot(); sparkBurst(30); shake(9, 0.3); hitFlash = 0.14; }
        else if (p.slotScore > 0) shake(5, 0.16);
        break;
      case 'hit':
        sfx.net();
        shake(4 + Math.min(6, (p.streak ?? 1) * 1.5), 0.16);
        break;
      case 'miss':
        break;                       // 不中不惩罚耳朵：只更新画面文案
      case 'drop':
        sfx.mech(0.55);              // 机械运转声
        break;
      case 'grab':
        if (p.ok) { sfx.cheer(); shake(11, 0.32); hitFlash = 0.2; sparkBurst(34); }
        else sfx.deflate();
        break;
      case 'bite':
        sfx.bite();
        shake(5, 0.25);              // 鱼竿震动
        break;
      case 'tension':
        shake(2.5, 0.12);            // 稀有鱼拉扯：轻微抖动
        break;
      case 'catch':
        sfx.splash();
        if (p.ok) {
          shake(p.price >= 20 ? 9 : 5, 0.26);
          if (p.price >= 20) sparkBurst(24);
        }
        break;
      case 'record':
        sfx.record();
        sparkBurst(30);
        break;
      /* ---- 星级解锁机（跳舞 / 赛车 / KTV）的反馈 ---- */
      case 'step':
        // 节奏游戏：每一步都要有确认音，但只能用极短的击打声，
        // 否则 32 支箭头会变成 32 次轰炸（与弹珠机落槽同理，短促即可）
        if (p.res === 'perfect') { sfx.clack(); shake(3, 0.1); }
        else if (p.res === 'good') sfx.clack();
        if ((p.combo ?? 0) > 0 && (p.combo ?? 0) % 10 === 0) { sfx.jackpot(); sparkBurst(22); }
        break;
      case 'perfect':
        sfx.cheer();
        shake(8, 0.24);
        sparkBurst(20);
        break;
      case 'note':
        if (p.ok) { sfx.clack(); shake(2.5, 0.1); }
        else sfx.deflate();
        break;
      default: break;
    }
  }

  const game = GAMES[fac.kind]?.(P, { plays: hooks.plays ?? 0, fx: fxEvent });
  if (!game) return null;

  /* ---- DOM ---- */
  const root = document.createElement('div');
  root.style.cssText = `position:fixed;inset:0;z-index:80;display:flex;align-items:center;
    justify-content:center;background:rgba(8,11,17,.78);backdrop-filter:blur(2px);`;
  const card = document.createElement('div');
  card.style.cssText = `display:flex;flex-direction:column;gap:10px;max-height:94vh;`;
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  canvas.style.cssText = `width:min(480px,92vw);height:auto;max-height:72vh;border-radius:14px;
    border:1px solid ${C.line};background:${C.panel2};display:block;`;
  const bar = document.createElement('div');
  bar.style.cssText = `width:min(480px,92vw);display:flex;justify-content:space-between;
    color:${C.dim};font:13px system-ui,sans-serif;padding:0 4px;`;
  card.appendChild(canvas);
  card.appendChild(bar);
  /* 可见的退出入口（需求：要有退出键）。
   * 只有底部一行 "Esc 退出" 文字时，玩家（尤其面板卡住时）不知道能按什么退出；
   * 给一个真实的按钮，任何阶段（ready/playing/result）都能一键回到店里。 */
  const quit = document.createElement('button');
  quit.type = 'button';
  quit.textContent = '✕ 退出游戏 (Esc)';
  quit.style.cssText = `align-self:flex-end;padding:7px 14px;border-radius:9px;cursor:pointer;
    border:1px solid ${C.line};background:${C.panel2};color:${C.dim};
    font:600 13px system-ui,"Segoe UI",sans-serif;-webkit-appearance:none;appearance:none;`;
  quit.addEventListener('mouseenter', () => { quit.style.color = C.danger; });
  quit.addEventListener('mouseleave', () => { quit.style.color = C.dim; });
  // 双端适配：手机无 hover，用 touch 等价反馈（按下高亮、松开还原）
  quit.addEventListener('touchstart', () => { quit.style.color = C.danger; }, { passive: true });
  quit.addEventListener('touchend', () => { quit.style.color = C.dim; });
  quit.addEventListener('touchcancel', () => { quit.style.color = C.dim; });
  quit.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  card.appendChild(quit);
  root.appendChild(card);
  document.body.appendChild(root);

  const g = canvas.getContext('2d');
  let phase = 'ready';   // ready → playing → result
  let result = null;
  let lbInfo = null;     // R4：本局在本地排行榜的名次 { rank, isBest }
  let paid = false;
  let last = performance.now();
  let raf = 0;

  function setBar() {
    bar.innerHTML = phase === 'ready'
      ? `<span>${fac.emoji} ${fac.name}</span><span>空格 / 点击开始 · Esc 退出</span>`
      : phase === 'playing'
        ? `<span>${game.scoreText()}</span><span>${game.left()}${
            fac.kind === 'pachinko' && game.S.balls.length > 0
              ? ` · 空中 ${game.S.balls.length}`
              : ''
          }</span>`
        : `<span style="color:${C.money}">结算${lbInfo?.rank ? ` · 第 ${lbInfo.rank} 名` : ''}</span><span>空格 / 点击 关闭</span>`;
  }
  setBar();

  function start() {
    const cost = P.cost ?? 0;
    if (cost > 0) {
      if (hooks.canPay && !hooks.canPay(cost)) {
        flash('现金不足');
        return;
      }
      if (hooks.pay) hooks.pay(cost);
    }
    paid = true;
    phase = 'playing';
    setBar();
  }

  let flashMsg = '';
  let flashT = 0;
  function flash(s) {
    flashMsg = s;
    flashT = 1.2;
  }

  function finish() {
    phase = 'result';
    result = game.result();
    if (hooks.reward) hooks.reward(result);
    // R3：把本局结果交给外部换算并计入当夜心理回血上限（见 main.openFacility.onMental）
    // 注意：必须带上本设施 kind（pachinko/fishing/...），main 的 onMental 签名是 (kind, result)
    if (hooks.onMental) hooks.onMental(fac.kind, result);
    // R4：本地排行榜 —— 由主模块负责写入并回报名次（minigames 不直接碰 localStorage，
    // 保持"只做玩法、不碰持久化"的分层；测试因此不需要 mock storage）
    if (hooks.onLeaderboard) {
      try {
        lbInfo = hooks.onLeaderboard(fac.kind, result) ?? null;
      } catch { lbInfo = null; }
    }
    // 需求：刷新纪录时给一个明确的"新纪录！"。
    // 音效在 finish 里补，标识由结算面板绘制（见 drawOverlay）。
    if (lbInfo?.isBest) fxEvent('record', {});
    setBar();
  }

  function close() {
    if (!active) return;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('pointerdown', onPointer);
    root.remove();
    active = null;
    if (hooks.onClose) hooks.onClose(result);
  }

  function onKey(e) {
    if (e.code === 'Escape') { e.preventDefault(); close(); return; }
    /* 新机器自带按键（跳舞机 ←↓↑→ / 赛车机 ←→ / KTV 空格与 1/2/3）。
     * 必须先给游戏、且游戏说"已消费"就不再走下面的默认分支 ——
     * 否则 KTV 按空格会在"打分"和"关闭结算"之间被抢。 */
    if (phase !== 'result' && typeof game.onKey === 'function') {
      if (game.onKey(e.code) === true) { e.preventDefault(); setBar(); return; }
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (phase === 'ready') start();
      else if (phase === 'playing') {
        // 多球并发：confirm() 是"再发一颗"，发不出来时（余球为 0）自然 no-op，
        // 不会因为"按键无效果"就误判为结束 —— 结束只由 isDone() 决定。
        game.confirm();
        if (game.isDone()) finish();
      } else if (phase === 'result') close();
      setBar();
      return;
    }
    // 弹珠机左右调整发射位：aim 阶段（含"还有余球、场上有球在飞"的连发期）都可调整
    if (phase === 'playing' && fac.kind === 'pachinko' && game.S.phase === 'aim') {
      if (e.code === 'ArrowLeft') game.S.aimX = clamp(game.S.aimX - 26, 46, CW - 46);
      if (e.code === 'ArrowRight') game.S.aimX = clamp(game.S.aimX + 26, 46, CW - 46);
    }
    // R4：弹珠机道具 1/2/3
    if (phase === 'playing' && fac.kind === 'pachinko' && typeof game.useItem === 'function') {
      const keys = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
      const idx = keys.indexOf(e.code);
      if (idx >= 0) {
        e.preventDefault();
        const it = game.S.items?.[idx];
        if (it && !game.useItem(it.id)) flash(`「${it.name}」现在用不了`);
        setBar();
      }
    }
  }
  function onPointer() {
    if (phase === 'ready') start();
    else if (phase === 'playing') {
      game.confirm();
      if (game.isDone()) finish();
    } else if (phase === 'result') close();
    setBar();
  }

  /* 赛车机需要"松开方向键"才能停止转向 —— 只有 keydown 会一直转。
   * 用可选方法（onKeyUp）而不是给所有游戏都加：老游戏没有这个方法也不受影响。 */
  function onKeyUp(e) {
    if (phase === 'playing' && typeof game.onKeyUp === 'function') game.onKeyUp(e.code);
  }

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointerdown', onPointer);

  function drawOverlay() {
    // 顶部标题栏
    g.fillStyle = 'rgba(8,11,17,0.86)';
    g.fillRect(0, 0, CW, 52);
    text(g, `${fac.emoji} ${fac.name}`, 16, 26, { size: 20, color: C.text, align: 'left', bold: true });
    text(g, P.cost > 0 ? fmtYuan(P.cost) : '免费', CW - 16, 26, {
      size: 16, color: P.cost > 0 ? C.brand : C.money, align: 'right',
    });
    // 底部消息条
    g.fillStyle = 'rgba(8,11,17,0.86)';
    g.fillRect(0, CH - 62, CW, 62);
    text(g, phase === 'ready' ? game.help : game.msg(), CW / 2, CH - 34, { size: 15, color: C.text });

    if (flashT > 0) {
      g.fillStyle = 'rgba(235,87,87,0.9)';
      rr(g, CW / 2 - 90, CH / 2 - 22, 180, 44, 10);
      g.fill();
      text(g, flashMsg, CW / 2, CH / 2, { size: 17, color: '#fff', bold: true });
    }

    if (phase === 'ready') {
      g.fillStyle = 'rgba(8,11,17,0.82)';
      g.fillRect(0, 52, CW, CH - 114);
      panel(g, 40, CH / 2 - 96, CW - 80, 192, C.panel);
      text(g, '玩法说明', CW / 2, CH / 2 - 62, { size: 20, color: C.text, bold: true });
      // help 支持换行：逐行居中绘制（弹珠机说明有两行）
      const helpLines = String(game.help).split('\n');
      helpLines.forEach((ln, i) => {
        text(g, ln, CW / 2, CH / 2 - 24 + i * 22, { size: 14, color: C.dim });
      });
      text(g, '空格 / 点击画面 开始', CW / 2, CH / 2 + 30, { size: 17, color: C.money, bold: true });
      text(g, 'Esc 随时退出', CW / 2, CH / 2 + 60, { size: 14, color: C.dim });
    }

    if (phase === 'result' && result) {
      g.fillStyle = 'rgba(8,11,17,0.82)';
      g.fillRect(0, 52, CW, CH - 114);
      const net = (result.payout ?? 0) - (P.cost ?? 0);
      /* 面板高度按内容长出来：
       *   基础（结算 + 本局得分 + 收益 + 净额）220
       *   + 排行名次行（lbInfo）        40
       *   + 历史最高行（lbInfo）        30
       * 之前是写死两档高度，加了"历史最高"就会溢出面板 —— 改成算出来。 */
      const pH = 220 + (lbInfo ? 70 : 0);
      const px = 40;
      const pw = CW - 80;
      const py = CH / 2 - pH / 2;
      panel(g, px, py, pw, pH, C.panel);

      /* 新纪录标识：需求「新纪录时弹出"新纪录！"标识」。
       * 做成面板顶部的横幅而不是小字，因为"破纪录"是这一局唯一值得炫耀的结果。 */
      if (lbInfo?.isBest) {
        g.fillStyle = 'rgba(232,169,78,0.22)';
        rr(g, px + 16, py + 14, pw - 32, 34, 10);
        g.fill();
        g.strokeStyle = C.brand;
        g.lineWidth = 2;
        g.stroke();
        text(g, '🏆 新纪录！', CW / 2, py + 31, { size: 19, color: C.brand, bold: true });
      }

      let y = py + (lbInfo?.isBest ? 96 : 36);
      text(g, '结算', CW / 2, y, { size: 22, color: C.text, bold: true });
      y += 42;
      text(g, result.label ?? '', CW / 2, y, { size: 16, color: C.brand });
      y += 34;
      text(g, `收益 ${fmtYuan(result.payout ?? 0)}`, CW / 2, y, { size: 18, color: C.money });
      y += 36;
      text(g, `净额 ${fmtYuanSigned(net)}`, CW / 2, y, {
        size: 20, color: net >= 0 ? C.money : C.danger, bold: true,
      });
      y += 40;
      /* 本局得分 / 历史最高（需求：每个小游戏结束显示本局得分与历史最高分）。
       * 口径由 main 传进来（basketball 是命中球数，其余是收益），这里只负责显示。 */
      if (lbInfo) {
        const u = lbInfo.unit ?? '';
        text(g, `本局 ${lbInfo.value}${u} · 历史最高 ${lbInfo.best}${u}`, CW / 2, y, { size: 15, color: C.info });
        y += 30;
        // rank 可能为 null（成绩没挤进前 10）—— 仍然要把"本局/最高"亮出来，别退回一行小字
        const isTop = lbInfo.rank === 1;
        const rankTxt = lbInfo.rank ? `本地排行第 ${lbInfo.rank} 名` : '未进本地榜（前 10）';
        text(
          g,
          lbInfo.isBest ? `${isTop ? '🏆 新纪录！' : '🎉 个人最佳！'} ${rankTxt}` : rankTxt,
          CW / 2, y,
          { size: 15, color: lbInfo.isBest ? C.brand : C.info, bold: true },
        );
      } else {
        text(g, '空格 / 点击 返回店铺', CW / 2, y, { size: 14, color: C.dim });
      }
    }

    /* 金色粒子 + 白闪：画在最后，盖在所有内容之上（都是"瞬间反馈"，不该被面板挡住） */
    for (const s of sparks) {
      const a = Math.max(0, s.life / s.max);
      g.fillStyle = `rgba(255,215,120,${a.toFixed(3)})`;
      g.beginPath();
      g.arc(s.x, s.y, s.r * (0.5 + a * 0.5), 0, Math.PI * 2);
      g.fill();
    }
    if (hitFlash > 0) {
      g.fillStyle = `rgba(255,255,255,${Math.min(0.45, hitFlash * 2.2).toFixed(3)})`;
      g.fillRect(0, 0, CW, CH);
    }
  }

  let barKey = '';
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (phase === 'playing') {
      game.update(dt);
      if (game.isDone()) { finish(); return; }
      // 状态条随"空中球数/剩余球数"变化实时刷新（脏检查避免每帧重排 DOM）。
      // 坑（线上事故）：这里曾无条件读 game.S.balls.length —— 只有弹珠机有 balls，
      // 抓娃娃机/投篮机/钓鱼没有该字段 → undefined.length 抛异常 → RAF 链中断，
      // 表现为"除弹珠机外其余机器一按开始就卡死"。必须对所有 kind 安全取值。
      const balls = game.S?.balls?.length ?? '';
      const key = `${game.scoreText()}|${game.left()}|${balls}`;
      if (key !== barKey) { barKey = key; setBar(); }
    }
    if (flashT > 0) flashT -= dt;
    if (hitFlash > 0) hitFlash -= dt;

    /* 粒子积分（落大奖 / 抓到娃娃的金色飞溅）—— 与震动共用一个 dt 源 */
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      s.vy += 620 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }

    /* 震动：整体位移 + 轻微放大（放大是为了抖动时不露出画布边缘）。
     * 用随机位移而不是正弦：机械撞击的观感更"硬"，正弦会像"呼吸"。 */
    let sx = 0;
    let sy = 0;
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt);
      const k = shakeDur > 0 ? shakeT / shakeDur : 0;
      const a = shakeAmp * k;
      sx = (Math.random() - 0.5) * a * 2;
      sy = (Math.random() - 0.5) * a * 2;
      if (shakeT === 0) shakeAmp = 0;
    }

    g.save();
    g.translate(sx, sy);
    g.translate(CW / 2, CH / 2);
    g.scale(1.04, 1.04);
    g.translate(-CW / 2, -CH / 2);
    game.draw(g);
    drawOverlay();
    g.restore();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  active = { close, facilityId };
  return active;
}

/** 关闭当前小游戏（外部需要打断时调用） */
export function closeMinigame() {
  active?.close();
}
