/**
 * 二次元风格角色（程序化，无外部资源）
 *
 * 设计取舍：
 * - 头身比 ~6.5（头高 0.26 / 身高 1.71），比原来的"胶囊+球"更拟人。
 * - 服装层次用**贴图**表现（衬衫 + 外套领 + 腰带画在同一张躯干贴图上），
 *   这样 1 个 mesh 就能有层次感，部件数压到 9 个 —— 同屏多角色时 draw call 可控。
 * - 几何与材质全部模块级共享缓存，只有 Group 是每个角色一份。
 * - 基础动作：走动摆臂摆腿 + 身体起伏；待机呼吸微晃；朝向随移动方向平滑转动。
 */
import * as THREE from 'three';

/* ---------- 调色板 ---------- */
const SKIN = [0xF2C9A8, 0xE8B48C, 0xC98F63, 0xF7DCC0];
const HAIR = [0x2B2B33, 0x4A3728, 0x6E4B8C, 0x2F6E8F, 0xB4553F, 0xD8C48A];
const CLOTH = [0x3F5E8C, 0x8C4A5E, 0x4E7A5E, 0x6B6B8C, 0x8C7A3F, 0x3A3A4A];
const PANTS = [0x2F3646, 0x3E4A3A, 0x4A3A4A, 0x33404F];

/* ---------- 共享几何（只建一次） ---------- */
let GEO = null;
function geos() {
  if (GEO) return GEO;
  GEO = {
    // 头：略扁的球
    head: new THREE.SphereGeometry(0.13, 16, 12),
    // 脸：贴在头前方的透明贴图面片
    face: new THREE.PlaneGeometry(0.2, 0.2),
    // 头发：碗状（上半球再压一点），thetaLength 控制覆盖到额头上方
    hair: new THREE.SphereGeometry(0.152, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    // 躯干：上窄下宽的圆柱（衬衫 + 外套，靠贴图分层次）
    torso: new THREE.CylinderGeometry(0.145, 0.185, 0.5, 14),
    // 下装：裙/裤
    skirt: new THREE.CylinderGeometry(0.19, 0.24, 0.3, 14),
    // 手臂 / 腿：胶囊（手部用臂末端收口表现，省 2 个 mesh / 角色）
    arm: new THREE.CapsuleGeometry(0.042, 0.26, 3, 8),
    leg: new THREE.CapsuleGeometry(0.058, 0.38, 3, 8),
  };
  return GEO;
}

/* ---------- 共享材质缓存 ---------- */
const matCache = new Map();
function std(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color, roughness: 0.85, metalness: 0.02, ...opts,
    }));
  }
  return matCache.get(key);
}

/* ---------- 脸部贴图（透明 canvas） ---------- */
const faceTexCache = new Map();
function faceTexture(variant = 0) {
  if (faceTexCache.has(variant)) return faceTexCache.get(variant);
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);

  const eyeY = size * 0.46;
  const eyeDx = size * 0.19;
  const cx = size / 2;

  // 腮红
  for (const sx of [-1, 1]) {
    g.globalAlpha = 0.35;
    g.fillStyle = '#FF9BA8';
    g.beginPath();
    g.ellipse(cx + sx * size * 0.27, size * 0.62, size * 0.08, size * 0.045, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // 眼睛（二次元：大眼 + 高光）
  for (const sx of [-1, 1]) {
    const ex = cx + sx * eyeDx;
    g.fillStyle = '#20222C';
    g.beginPath();
    g.ellipse(ex, eyeY, size * 0.055, size * 0.075, 0, 0, Math.PI * 2);
    g.fill();
    // 虹膜
    g.fillStyle = variant === 1 ? '#4A90D9' : variant === 2 ? '#6FCF97' : '#8C5A3C';
    g.beginPath();
    g.ellipse(ex, eyeY + size * 0.012, size * 0.038, size * 0.055, 0, 0, Math.PI * 2);
    g.fill();
    // 高光
    g.fillStyle = '#FFFFFF';
    g.beginPath();
    g.arc(ex - size * 0.018, eyeY - size * 0.022, size * 0.016, 0, Math.PI * 2);
    g.fill();
    // 上睫毛线
    g.strokeStyle = '#20222C';
    g.lineWidth = size * 0.018;
    g.beginPath();
    g.arc(ex, eyeY, size * 0.058, Math.PI * 1.12, Math.PI * 1.88);
    g.stroke();
    // 眉
    g.strokeStyle = '#3A3140';
    g.lineWidth = size * 0.012;
    g.beginPath();
    g.moveTo(ex - size * 0.05, eyeY - size * 0.11);
    g.lineTo(ex + size * 0.05, eyeY - size * 0.13);
    g.stroke();
  }

  // 嘴（小小的弧）
  g.strokeStyle = '#B4655F';
  g.lineWidth = size * 0.014;
  g.beginPath();
  if (variant === 2) {
    g.arc(cx, size * 0.72, size * 0.035, 0.15 * Math.PI, 0.85 * Math.PI);
  } else {
    g.moveTo(cx - size * 0.028, size * 0.73);
    g.quadraticCurveTo(cx, size * 0.78, cx + size * 0.028, size * 0.73);
  }
  g.stroke();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  faceTexCache.set(variant, t);
  return t;
}

/* ---------- 躯干服装贴图（在 1 个 mesh 上表现层次） ---------- */
const clothTexCache = new Map();
function clothTexture(colorHex) {
  if (clothTexCache.has(colorHex)) return clothTexCache.get(colorHex);
  const w = 64;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const base = `#${colorHex.toString(16).padStart(6, '0')}`;
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  // 外套：两侧深一档的竖条（开襟感）
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, 0, w * 0.16, h);
  g.fillRect(w * 0.84, 0, w * 0.16, h);
  // 内衬（浅色 V 领）
  g.fillStyle = 'rgba(255,255,255,0.82)';
  g.beginPath();
  g.moveTo(w * 0.34, 0);
  g.lineTo(w * 0.66, 0);
  g.lineTo(w * 0.5, h * 0.32);
  g.closePath();
  g.fill();
  // 领子
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(w * 0.34, 0);
  g.lineTo(w * 0.5, h * 0.32);
  g.lineTo(w * 0.66, 0);
  g.stroke();
  // 腰带
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, h * 0.78, w, h * 0.07);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  clothTexCache.set(colorHex, t);
  return t;
}

/* ---------- 组装 ---------- */
/**
 * @param {object} opt { seed, skin, hair, cloth, pants, face }
 *   需求I 第⑤条新增：
 *   @param {number} opt.scale     整体体型缩放（儿童 0.72 / 老年 0.93）
 *   @param {number[]} opt.hairPool  发色候选（覆盖默认池；老年给灰白发）
 *   @param {number[]} opt.clothPool 服装色候选（儿童给亮色）
 *   @param {boolean} opt.stoop    驼背（老年）
 * @returns {{ group: THREE.Group, update: (dt:number, moving:boolean, heading:number)=>void }}
 */
export function createCharacter(opt = {}) {
  const G = geos();
  const r = opt.seed != null ? opt.seed : Math.random();
  const pick = (arr) => arr[Math.floor(r * arr.length * 97) % arr.length];
  const skin = opt.skin ?? pick(SKIN);
  // 类型化的配色池：不给就用默认池 —— 既有调用方（摊主 / 顾客）行为不变
  const hairPool = Array.isArray(opt.hairPool) && opt.hairPool.length ? opt.hairPool : HAIR;
  const clothPool = Array.isArray(opt.clothPool) && opt.clothPool.length ? opt.clothPool : CLOTH;
  const hairColor = opt.hair ?? pick(hairPool);
  const clothColor = opt.cloth ?? pick(clothPool);
  const pantsColor = opt.pants ?? pick(PANTS);
  const faceVariant = opt.face ?? Math.floor(r * 3) % 3;
  const scale = Number.isFinite(opt.scale) && opt.scale > 0 ? opt.scale : 1;

  const group = new THREE.Group();
  // 体型差（儿童矮、青年标准、老年略矮）—— 缩放挂在 group 上，动作逻辑完全不用改
  group.scale.setScalar(scale);

  /* 髋部枢轴（身体整体） */
  const body = new THREE.Group();
  body.position.y = 0;
  group.add(body);

  // 下装
  const skirt = new THREE.Mesh(G.skirt, std(pantsColor, { roughness: 0.9 }));
  skirt.position.y = 0.68;
  body.add(skirt);

  // 躯干（带服装贴图）
  const torsoMat = new THREE.MeshStandardMaterial({
    map: clothTexture(clothColor), roughness: 0.82, metalness: 0.02,
  });
  const torso = new THREE.Mesh(G.torso, torsoMat);
  torso.position.y = 1.08;
  // 驼背（老年）：躯干前倾 + 头部随之前移下压，比"整个人缩小"更像老人
  if (opt.stoop === true) {
    torso.rotation.x = 0.16;
    torso.position.z = 0.03;
  }
  body.add(torso);

  // 头
  const head = new THREE.Group();
  head.position.y = 1.44;
  if (opt.stoop === true) {
    head.position.z = 0.07;
    head.rotation.x = 0.1;
  }
  body.add(head);

  const headMesh = new THREE.Mesh(G.head, std(skin, { roughness: 0.78 }));
  headMesh.scale.set(1, 1.06, 0.96);
  head.add(headMesh);

  // 脸（贴在头前方）
  const faceMat = new THREE.MeshBasicMaterial({
    map: faceTexture(faceVariant), transparent: true, depthWrite: false,
  });
  const face = new THREE.Mesh(G.face, faceMat);
  face.position.set(0, -0.008, 0.118);
  face.renderOrder = 2;
  head.add(face);

  // 头发（碗状盖住上半头 + 前额）
  const hair = new THREE.Mesh(G.hair, std(hairColor, { roughness: 0.72 }));
  hair.position.y = 0.012;
  hair.scale.set(1.02, 1.0, 1.04);
  head.add(hair);

  // 刘海：一片略斜的薄盒遮住额头（1 片而非 2 片，省 draw call）
  const bangMat = std(hairColor, { roughness: 0.72 });
  const bang = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.1, 0.03), bangMat);
  bang.position.set(0, 0.078, 0.112);
  bang.rotation.x = -0.12;
  head.add(bang);

  /* 手臂（肩枢轴） */
  const arms = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.175, 1.3, 0);
    body.add(pivot);
    const arm = new THREE.Mesh(G.arm, std(skin, { roughness: 0.8 }));
    arm.position.y = -0.19;
    pivot.add(arm);
    pivot.rotation.z = sx * 0.08;
    arms.push(pivot);
  }

  /* 腿（髋枢轴） */
  const legs = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.085, 0.62, 0);
    body.add(pivot);
    const leg = new THREE.Mesh(G.leg, std(pantsColor, { roughness: 0.92 }));
    leg.position.y = -0.26;
    pivot.add(leg);
    legs.push(pivot);
  }

  /* ---------- 动作 ---------- */
  let t = Math.random() * 6;
  let facing = 0;

  /**
   * @param {number} dt 秒
   * @param {boolean} moving 是否在移动
   * @param {number} heading 目标朝向（弧度，绕 Y）
   */
  function update(dt, moving, heading) {
    if (moving) {
      t += dt * 9.5;
      const s = Math.sin(t);
      legs[0].rotation.x = s * 0.55;
      legs[1].rotation.x = -s * 0.55;
      arms[0].rotation.x = -s * 0.42;
      arms[1].rotation.x = s * 0.42;
      body.position.y = Math.abs(Math.sin(t)) * 0.022;
      head.rotation.y = s * 0.05;
    } else {
      t += dt * 1.6;
      // 待机：呼吸 + 轻微重心晃动，四肢回正
      const br = Math.sin(t) * 0.5 + 0.5;
      torso.scale.set(1 + br * 0.012, 1 + br * 0.008, 1 + br * 0.012);
      body.position.y = Math.sin(t * 0.7) * 0.006;
      for (const p of arms) p.rotation.x += (0 - p.rotation.x) * Math.min(1, dt * 6);
      for (const p of legs) p.rotation.x += (0 - p.rotation.x) * Math.min(1, dt * 6);
      head.rotation.y = Math.sin(t * 0.5) * 0.12;
    }

    // 朝向平滑转动（处理 ±π 绕行）
    if (heading != null) {
      let d = heading - facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      facing += d * Math.min(1, dt * 8);
      group.rotation.y = facing;
    }
  }

  return { group, update, height: 1.71 * scale, type: opt.type ?? null };
}

/** 释放共享缓存（切换场景时用；正常游玩不需要） */
export function disposeCharacterCache() {
  for (const g of Object.values(GEO ?? {})) g.dispose?.();
  for (const m of matCache.values()) m.dispose?.();
  for (const t of faceTexCache.values()) t.dispose?.();
  for (const t of clothTexCache.values()) t.dispose?.();
  GEO = null;
  matCache.clear();
  faceTexCache.clear();
  clothTexCache.clear();
}
