/**
 * 像素跑酷 · 矢量骨架角色（heroes made of parts, not a single sprite）
 * ============================================================================
 * 纯逻辑模块：姿态计算是纯函数，Node 可直接单测；canvas 绘制只依赖注入的 ctx。
 * 部件：头 / 躯干 / 上臂×2 / 前臂×2 / 大腿×2 / 小腿×2 / 脚×2 —— 全部 canvas 绘制。
 *
 * 关节角度驱动的状态机：
 *   idle  呼吸 6 帧      run  奔跑 8 帧（大腿 ±30°、小腿滞后 2 帧、双臂反摆、躯干前倾 8°）
 *   jump  起跳 4 帧压缩伸展   rise 上升   fall 下降收腿   slide 滑铲 4 帧   hit 翻滚 6 帧
 * 步频随速度变化：速度低→8fps，速度高→16fps（改变帧推进速率，不是整体加速）。
 */
'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const DEG = Math.PI / 180;

  /** 每种状态的帧数（动画循环长度）。 */
  const FRAMES = { idle: 6, run: 8, jump: 4, rise: 4, fall: 4, slide: 4, hit: 6 };

  /** 把引擎速度(px/s)映射到步频 fps：BASE→8fps，MAX→16fps。 */
  function frameRate(speed, base, max) {
    base = base || 430; max = max || 1180;
    const t = clamp((speed - base) / (max - base), 0, 1);
    return 8 + t * 8;
  }

  /**
   * 计算给定时刻的骨架姿态（纯函数）。
   * @param {string} state 动画状态
   * @param {number} t 该状态已持续的秒数
   * @param {number} speed 当前速度(px/s)，决定帧率
   * @param {object} opts {base,max,boosting}
   * @returns {object} 姿态：各关节角度(度)、bob、squashX/Y、leanDeg、frame
   */
  function poseAt(state, t, speed, opts) {
    opts = opts || {};
    const n = FRAMES[state] || 8;
    const fps = frameRate(speed, opts.base, opts.max);
    // 帧相位 0..1
    const f = ((t * fps) % n + n) % n;
    const p = f / n;
    const tau = Math.PI * 2;
    const wave = Math.sin(p * tau);
    // 小腿滞后 2 帧
    const lag = Math.sin(((f - 2 + n) % n) / n * tau);
    const boosting = !!opts.boosting;

    const pose = {
      state, frame: Math.floor(f), fps: +fps.toFixed(2),
      head: 0, torso: 0,
      upperArmL: 0, upperArmR: 0, foreArmL: 0, foreArmR: 0,
      thighL: 0, thighR: 0, shinL: 0, shinR: 0,
      footL: 0, footR: 0,
      bob: 0, squashX: 1, squashY: 1, leanDeg: 0,
    };

    switch (state) {
      case 'run': {
        // 大腿 30°→-30° 交替；小腿滞后 2 帧且只在抬腿时弯曲
        pose.thighL = wave * 30;
        pose.thighR = -wave * 30;
        pose.shinL = Math.max(0, -lag) * 62;
        pose.shinR = Math.max(0, lag) * 62;
        pose.footL = -pose.shinL * 0.3;
        pose.footR = -pose.shinR * 0.3;
        // 双臂反摆（与同侧腿相反）
        pose.upperArmL = -wave * 42;
        pose.upperArmR = wave * 42;
        pose.foreArmL = -28 - Math.max(0, wave) * 34;
        pose.foreArmR = -28 - Math.max(0, -wave) * 34;
        pose.torso = 8 + (boosting ? 4 : 0);       // 躯干前倾 8°
        pose.leanDeg = pose.torso;
        pose.bob = -Math.abs(wave) * (boosting ? 5 : 3.5);
        pose.squashX = 1 - Math.abs(wave) * 0.035;
        pose.squashY = 1 + Math.abs(wave) * 0.045;
        break;
      }
      case 'idle': {
        const br = Math.sin(p * tau);              // 呼吸
        pose.bob = br * 1.5;
        pose.squashY = 1 + br * 0.02;
        pose.squashX = 1 - br * 0.015;
        pose.upperArmL = 6 + br * 3; pose.upperArmR = 6 - br * 3;
        pose.foreArmL = -18; pose.foreArmR = -18;
        pose.head = br * 2;
        break;
      }
      case 'jump': {
        // 压缩→伸展 4 帧
        const c = Math.sin(p * Math.PI);
        pose.squashY = lerp(0.82, 1.16, c);
        pose.squashX = lerp(1.12, 0.9, c);
        pose.thighL = -18; pose.thighR = 18;
        pose.shinL = 34; pose.shinR = 34;
        pose.upperArmL = -70; pose.upperArmR = -70;
        pose.foreArmL = -20; pose.foreArmR = -20;
        pose.bob = -6 * c;
        break;
      }
      case 'rise': {
        pose.thighL = -12; pose.thighR = 22;
        pose.shinL = 28; pose.shinR = 14;
        pose.upperArmL = -64; pose.upperArmR = -50;
        pose.foreArmL = -16; pose.foreArmR = -24;
        pose.squashY = 1.08; pose.squashX = 0.94;
        pose.leanDeg = 6;
        break;
      }
      case 'fall': {
        pose.thighL = 26; pose.thighR = -6;         // 落体收腿
        pose.shinL = 46; pose.shinR = 30;
        pose.upperArmL = -34; pose.upperArmR = -46;
        pose.foreArmL = -30; pose.foreArmR = -22;
        pose.squashY = 1.04; pose.squashX = 0.97;
        pose.leanDeg = 10;
        break;
      }
      case 'slide': {
        const s = Math.sin(p * tau);
        pose.torso = 64; pose.leanDeg = 64;          // 身体压低前倾
        pose.thighL = -70; pose.thighR = -52;
        pose.shinL = 78; pose.shinR = 60;
        pose.upperArmL = 40 + s * 6; pose.upperArmR = -28;
        pose.foreArmL = -50; pose.foreArmR = -40;
        pose.bob = 2;
        pose.squashY = 0.72; pose.squashX = 1.14;
        break;
      }
      case 'hit': {
        // 翻滚 6 帧：整体旋转由 drawVectorHero 按 frame 处理
        const r = p * tau;
        pose.torso = 20 * Math.sin(r);
        pose.thighL = 60 * Math.sin(r); pose.thighR = 60 * Math.sin(r + Math.PI);
        pose.shinL = 70; pose.shinR = 70;
        pose.upperArmL = -50; pose.upperArmR = 50;
        pose.foreArmL = -40; pose.foreArmR = -40;
        pose.squashY = 0.9; pose.squashX = 1.1;
        pose.roll = r;
        break;
      }
    }
    return pose;
  }

  /** 根据引擎运行状态推断动画状态。 */
  function stateOf(run) {
    if (run.dead) return 'hit';
    if (run.sliding) return 'slide';
    if (!run.onGround) {
      if (run.vy > 120) return 'rise';
      if (run.vy < -120) return 'fall';
      return 'jump';
    }
    if (run.landSquashT > 0) return 'jump';   // 落地压缩短促回弹
    const spd = run.speed ?? 430;
    if (spd < 60) return 'idle';
    return 'run';
  }

  /**
   * 用 canvas 2D 绘制骨架角色。
   * @param ctx canvas 2D 上下文（调用方已 translate/scale 到角色脚底中心）
   * @param pose poseAt() 的姿态
   * @param box {w,h} 角色包围盒像素尺寸
   * @param palette {main,dark,accent,skin,outline} 配色
   */
  function draw(ctx, pose, box, palette) {
    const w = box.w, h = box.h;
    const P = Object.assign({
      main: '#2DD4BF', dark: '#159c8c', accent: '#ffe08a',
      skin: '#f6d3a8', outline: '#06201d',
    }, palette || {});
    // 以脚底为原点，向上为负 y；整体身高 h
    const unit = h / 8;
    const hipY = -unit * 3.4;
    const shoulderY = -unit * 6.0;
    const headR = unit * 0.95;
    const roll = pose.roll || 0;

    ctx.save();
    // bob / 落地压缩 / 翻滚
    ctx.translate(0, pose.bob * (unit / 8));
    ctx.scale(pose.squashX, pose.squashY);
    if (roll) { ctx.translate(0, -h * 0.5); ctx.rotate(roll); ctx.translate(0, h * 0.5); }
    if (pose.leanDeg) ctx.rotate(pose.leanDeg * DEG * 0.35);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 画一条"骨段"：从 (x,y) 按角度(度，0=向下)和长度画粗线
    function limb(x, y, angDeg, len, width, color) {
      const a = angDeg * DEG;
      const ex = x + Math.sin(a) * len;
      const ey = y + Math.cos(a) * len;
      ctx.strokeStyle = P.outline; ctx.lineWidth = width + 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      return { x: ex, y: ey };
    }
    function joint(x, y, r, color) {
      ctx.fillStyle = P.outline; ctx.beginPath(); ctx.arc(x, y, r + 1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    const legW = unit * 0.5, armW = unit * 0.42;
    // 后侧肢体（先画，制造前后层次）
    const kneeR = limb(unit * 0.22, hipY, pose.thighR, unit * 1.7, legW, P.dark);
    limb(kneeR.x, kneeR.y, pose.thighR + pose.shinR, unit * 1.6, legW * 0.9, P.dark);
    const elbowR = limb(unit * 0.34, shoulderY, pose.upperArmR, unit * 1.5, armW, P.dark);
    limb(elbowR.x, elbowR.y, pose.upperArmR + pose.foreArmR, unit * 1.3, armW * 0.85, P.dark);

    // 躯干（像素矩形 + 描边）
    ctx.fillStyle = P.outline;
    ctx.fillRect(-unit * 0.62, shoulderY - unit * 0.2, unit * 1.24, (hipY - shoulderY) + unit * 0.5);
    ctx.fillStyle = P.main;
    ctx.fillRect(-unit * 0.52, shoulderY - unit * 0.1, unit * 1.04, (hipY - shoulderY) + unit * 0.3);
    ctx.fillStyle = P.dark;
    ctx.fillRect(-unit * 0.52, hipY - unit * 0.5, unit * 1.04, unit * 0.5);
    // 胸口能量条
    ctx.fillStyle = P.accent;
    ctx.fillRect(-unit * 0.3, shoulderY + unit * 0.5, unit * 0.6, unit * 0.22);

    // 头
    const hy = shoulderY - headR * 0.9;
    ctx.fillStyle = P.outline; ctx.beginPath(); ctx.arc(0, hy, headR + 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = P.skin; ctx.beginPath(); ctx.arc(0, hy, headR, 0, Math.PI * 2); ctx.fill();
    // 护目镜（发光条）
    ctx.fillStyle = P.main;
    ctx.fillRect(-headR * 0.95, hy - headR * 0.18, headR * 1.9, headR * 0.5);
    ctx.fillStyle = P.outline;
    ctx.fillRect(headR * 0.15, hy - headR * 0.12, headR * 0.34, headR * 0.3);
    // 头顶天线
    ctx.strokeStyle = P.accent; ctx.lineWidth = Math.max(1, unit * 0.13);
    ctx.beginPath(); ctx.moveTo(0, hy - headR); ctx.lineTo(unit * 0.35, hy - headR - unit * 0.55); ctx.stroke();
    ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(unit * 0.35, hy - headR - unit * 0.55, unit * 0.18, 0, Math.PI * 2); ctx.fill();

    // 前侧肢体
    const elbowL = limb(-unit * 0.34, shoulderY, pose.upperArmL, unit * 1.5, armW, P.main);
    limb(elbowL.x, elbowL.y, pose.upperArmL + pose.foreArmL, unit * 1.3, armW * 0.85, P.main);
    joint(elbowL.x, elbowL.y, armW * 0.45, P.accent);
    const kneeL = limb(-unit * 0.22, hipY, pose.thighL, unit * 1.7, legW, P.main);
    const footL = limb(kneeL.x, kneeL.y, pose.thighL + pose.shinL, unit * 1.6, legW * 0.9, P.main);
    joint(kneeL.x, kneeL.y, legW * 0.5, P.accent);
    // 脚（像素块）
    ctx.fillStyle = P.outline;
    ctx.fillRect(footL.x - unit * 0.35, footL.y - unit * 0.12, unit * 0.8, unit * 0.34);
    ctx.fillStyle = P.dark;
    ctx.fillRect(footL.x - unit * 0.28, footL.y - unit * 0.06, unit * 0.66, unit * 0.22);
    const footR = { x: kneeR.x + Math.sin((pose.thighR + pose.shinR) * DEG) * unit * 1.6,
                    y: kneeR.y + Math.cos((pose.thighR + pose.shinR) * DEG) * unit * 1.6 };
    ctx.fillStyle = P.outline;
    ctx.fillRect(footR.x - unit * 0.35, footR.y - unit * 0.12, unit * 0.8, unit * 0.34);
    ctx.fillStyle = P.dark;
    ctx.fillRect(footR.x - unit * 0.28, footR.y - unit * 0.06, unit * 0.66, unit * 0.22);

    ctx.restore();
  }

export { FRAMES, frameRate, poseAt, stateOf, draw };
