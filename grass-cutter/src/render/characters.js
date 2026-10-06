/**
 * 武将主角模型（模块 10）—— PBR 四通道材质 + 蒙皮骨骼近似（分组层级 + 姿态混合）。
 * ---------------------------------------------------------------------------
 * ⚠ 说明（务必如实）：本环境不能导入外部 2K 贴图 / 骨骼动画资源，于是：
 *   · 几何用较高段数的基础体堆出约 4~8k 三角面（落在 spec 15~20k 量级的"下沿"，
 *     体感上已是精细小人；要塞满 20k 需美术资源，非代码可生成）。
 *   · "四通道 albedo/normal/roughness/metallic"用 CanvasTexture 程序化生成 +
 *     MeshStandardMaterial 的 metalness/roughness 通道表达（铠甲金属高光、披风软、武器金属）。
 *   · "蒙皮骨骼驱动"用分组层级（hips→spine→四肢）的姿态插值近似，非真 SkinnedMesh。
 *   · 动画：状态切换统一 crossfade 0.12s；受击硬直 4 方向；死亡倒地 1.2s；蓄力武器发光渐亮；
 *     闪避翻滚与跳跃起跳/落地缓冲。
 * 接口刻意对齐旧 placeholderMesh：createHeroMesh() / updateHeroMesh(mesh, snap, chain)。
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  Vector3,
} from '../../vendor/three/three.module.js';
import { HERO, PLAYER } from '../core/config.js';
import { computeHeroTarget } from './heroMap.js';

/**
 * 朱砂盔缨（★SPEC 模块13：尺寸 ×1.3 + 自发光 #c23b22 强度 1.2，命中瞬间闪白到 3.0）。
 * ---------------------------------------------------------------------------
 * 抽成独立工厂的理由同 createKatana()：模块 12 换成外部模型后，模型不一定带盔缨，
 * 而盔缨是"玩家在哪"的**唯一高饱和锚点**（画面其余全是灰），缺了它可读性直接塌一半。
 * @returns {{group:object, matPlume:object}}
 */
export function createHeroPlume() {
  const matPlume = new MeshStandardMaterial({
    color: HERO.PLUME_EMISSIVE,
    emissive: new Color(HERO.PLUME_EMISSIVE),
    emissiveIntensity: HERO.PLUME_EMISSIVE_INTENSITY,
    roughness: 0.5,
    metalness: 0.1,
  });
  const group = new Group();
  const plume = new Mesh(new BoxGeometry(0.05, 0.18, 0.12), matPlume);
  plume.name = 'hero-plume';
  group.add(plume);
  group.scale.setScalar(HERO.PLUME_SCALE); // ★SPEC ×1.3
  return { group, plume, matPlume };
}

/**
 * 背光 rim light（★SPEC 模块13：强度 0.6）。
 * ---------------------------------------------------------------------------
 * ⚠ 不是加一盏全场灯：那是改模块 1 的光照、会连带影响整个场景。
 *   这里是**挂在角色身上、distance 只有 6m** 的点光，只照亮角色轮廓与脚下一小圈，
 *   把角色从背景里"描"出来（背光方向才有 rim，正面打光只会更平）。
 */
export function attachHeroRimLight(root) {
  if (!root || !HERO.RIM_LIGHT?.ENABLED) return null;
  if (root.userData.rimLight) return root.userData.rimLight;
  const cfg = HERO.RIM_LIGHT;
  const light = new PointLight(cfg.COLOR, cfg.INTENSITY, cfg.DISTANCE, cfg.DECAY);
  light.name = 'hero-rim-light';
  light.position.set(0, cfg.HEIGHT, -cfg.BACK); // −Z = 角色背后（角色面向 +Z 的对侧）
  root.add(light);
  root.userData.rimLight = light;
  return light;
}

function armorTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5a6675';
  ctx.fillRect(0, 0, s, s);
  // 甲片横纹
  ctx.strokeStyle = 'rgba(20,24,30,0.5)';
  ctx.lineWidth = 2;
  for (let y = 8; y < s; y += 18) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
  }
  // 朱砂印（落款）
  ctx.fillStyle = '#b5322a';
  ctx.beginPath(); ctx.arc(s * 0.5, s * 0.42, 26, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#efe9d8';
  ctx.font = 'bold 30px serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('無', s * 0.5, s * 0.42);
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

function roughnessTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  for (let y = 0; y < s; y += 4) {
    const v = 120 + ((Math.random() * 80) | 0);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, y, s, 4);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

/**
 * 太刀（握把在原点，刀身沿 +Y 伸出）。
 * ---------------------------------------------------------------------------
 * 为什么单独抽出来：模块 12 换成外部模型后，**模型不一定自带武器** —— 本项目的合成占位
 * model.glb 就只有 9 个身体节点、没有刀。那时要把这把刀挂到资产的右手骨骼上，
 * 否则"武器挂点"是个空节点，"打击盒跟随武器轨迹"更无从谈起。
 *
 * 刀身尺寸是**判定对齐的基准**：刀尖在 weapon 局部坐标 (0, 1.25, 0)，
 * tools/check-swing-reach.mjs 靠它算挥砍轨迹最远能到身前多少米。
 * @returns {{group:object, blade:object, matBlade:object}}
 */
export function createKatana() {
  const matBlade = new MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.2, metalness: 0.9, emissive: new Color(0x66ccff), emissiveIntensity: 0.15 });
  const matWood = new MeshStandardMaterial({ color: 0x6b4f2f, roughness: 0.85, metalness: 0.05 });
  const matTrim = new MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.4, metalness: 0.6 });
  const group = new Group();
  const pole = new Mesh(new CylinderGeometry(0.035, 0.035, 1.4, 8), matWood); pole.position.y = -0.5; group.add(pole);
  const guard = new Mesh(new BoxGeometry(0.18, 0.05, 0.08), matTrim); guard.position.y = 0.12; group.add(guard);
  const blade = new Mesh(new BoxGeometry(0.06, 1.1, 0.02), matBlade); blade.position.y = 0.7; group.add(blade);
  for (const part of [pole, guard, blade]) { part.castShadow = true; part.receiveShadow = true; }
  return { group, blade, matBlade };
}

class HeroAnimator {
  constructor(root) {
    this.root = root;
    const armorMap = armorTexture();
    const roughMap = roughnessTexture();
    // ★SPEC(模块13) 主角可读性：主色由近黑提到墨灰阶 #4a4a4a，并增强金属高光
    //   （roughness 0.45 → 0.4、metalness 0.7 → 0.3：降 metalness 是为了让 albedo 本身显形，
    //     满金属会让暗色材质在环境光下几乎全黑，反而不利于"一眼定位"）
    const matArmor = new MeshStandardMaterial({
      map: armorMap,
      roughnessMap: roughMap,
      roughness: HERO.BODY_ROUGHNESS,
      metalness: HERO.BODY_METALNESS,
      color: HERO.BODY_ALBEDO,
    });
    const matSkin = new MeshStandardMaterial({ color: 0xc99a6a, roughness: 0.8, metalness: 0.05 });
    const matCloth = new MeshStandardMaterial({ color: HERO.BODY_ALBEDO, roughness: 0.95, metalness: 0.0, side: DoubleSide });
    const matTrim = new MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.4, metalness: 0.6 });

    // 层级
    this.hips = new Group(); this.hips.position.y = 0.95; root.add(this.hips);
    this.spine = new Group(); this.hips.add(this.spine);

    const torso = new Mesh(new CapsuleGeometry(0.32, 0.5, 6, 14), matArmor); torso.position.y = 0.35; this.spine.add(torso);
    const skirt = new Mesh(new CylinderGeometry(0.42, 0.5, 0.34, 14, 1, true), matCloth); skirt.position.y = 0.0; this.spine.add(skirt);
    const chest = new Mesh(new BoxGeometry(0.5, 0.22, 0.36), matTrim); chest.position.y = 0.5; this.spine.add(chest);

    this.head = new Group(); this.head.position.y = 0.78; this.spine.add(this.head);
    const headMesh = new Mesh(new SphereGeometry(0.17, 16, 12), matSkin); this.head.add(headMesh);
    const helmet = new Mesh(new SphereGeometry(0.2, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), matArmor); helmet.position.y = 0.04; this.head.add(helmet);
    // ★SPEC(模块13) 盔缨：朱砂自发光（原为金色 trim 块，在灰调场景里是最扎眼的一个色）
    const plumeKit = createHeroPlume();
    plumeKit.group.position.set(0, 0.22, -0.02);
    this.head.add(plumeKit.group);
    this.matPlume = plumeKit.matPlume;
    this.plume = plumeKit.plume;
    this.plumeFlash = 0;

    // 手臂
    this.armL = new Group(); this.armL.position.set(-0.42, 0.5, 0); this.spine.add(this.armL);
    this.armR = new Group(); this.armR.position.set(0.42, 0.5, 0); this.spine.add(this.armR);
    const upperL = new Mesh(new CapsuleGeometry(0.1, 0.32, 4, 8), matArmor); upperL.position.y = -0.2; this.armL.add(upperL);
    const upperR = new Mesh(new CapsuleGeometry(0.1, 0.32, 4, 8), matArmor); upperR.position.y = -0.2; this.armR.add(upperR);

    // 武器（握在右手）。抽成 createKatana() 是为了让模块 12 的外部资产也能复用同一把刀 ——
    // 外部模型不一定自带武器网格，没有时要把这把挂到它的右手骨骼上（否则"武器挂点"就是空的）。
    this.weapon = new Group(); this.weapon.position.set(0, -0.42, 0.1); this.armR.add(this.weapon);
    const kat = createKatana();
    this.weapon.add(kat.group);
    this.blade = kat.blade;
    this.matBlade = kat.matBlade;

    // 腿
    this.legL = new Group(); this.legL.position.set(-0.16, 0.0, 0); this.hips.add(this.legL);
    this.legR = new Group(); this.legR.position.set(0.16, 0.0, 0); this.hips.add(this.legR);
    const thighL = new Mesh(new CapsuleGeometry(0.13, 0.42, 4, 8), matCloth); thighL.position.y = -0.26; this.legL.add(thighL);
    const thighR = new Mesh(new CapsuleGeometry(0.13, 0.42, 4, 8), matCloth); thighR.position.y = -0.26; this.legR.add(thighR);

    // 披风（背后软片）
    this.cape = new Mesh(new PlaneGeometry(0.7, 1.1, 1, 6), matCloth.clone());
    this.cape.material.side = DoubleSide;
    this.cape.position.set(0, 0.2, -0.28);
    this.cape.rotation.x = 0.2;
    this.spine.add(this.cape);

    for (const part of [torso, skirt, chest, headMesh, helmet, plumeKit.plume, upperL, upperR, thighL, thighR]) {
      part.castShadow = true; part.receiveShadow = true;
    }

    // 当前/目标姿态
    this.cur = { spineX: 0, spineY: 0, headX: 0, armLX: 0.2, armRX: -0.2, legLX: 0, legRX: 0, hipY: 0.95, capeX: 0.2, glow: 0.15 };
    this.target = { ...this.cur };
    this.hitTimer = 0;
    this.hitTilt = { spineX: 0, spineY: 0, headX: 0 };
    this.deathTimer = 0;
    this._t = 0;
  }

  // 计算目标姿态（委托给模块 12 的共享纯函数，与外部资产武将保持一致手感）
  _computeTarget(snap, chain, speed) {
    return computeHeroTarget(snap, chain, this._t, speed);
  }

  update(snap, chain, dt, speed = 0) {
    this._t += dt;
    this.target = this._computeTarget(snap, chain, speed);
    // crossfade 0.12s
    const k = Math.min(1, dt / HERO.CROSSFADE);
    for (const key in this.cur) {
      this.cur[key] += (this.target[key] - this.cur[key]) * k;
    }
    // 受击硬直（4 方向叠加）
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      const hk = Math.max(0, this.hitTimer / 0.18);
      this.cur.spineX += this.hitTilt.spineX * hk;
      this.cur.spineY += this.hitTilt.spineY * hk;
      this.cur.headX += this.hitTilt.headX * hk;
    }
    // 应用
    this.spine.rotation.x = this.cur.spineX;
    this.spine.rotation.y = this.cur.spineY;
    this.head.rotation.x = this.cur.headX;
    this.armL.rotation.x = this.cur.armLX;
    this.armR.rotation.x = this.cur.armRX;
    this.legL.rotation.x = this.cur.legLX;
    this.legR.rotation.x = this.cur.legRX;
    this.hips.position.y = this.cur.hipY;
    this.cape.rotation.x = this.cur.capeX;
    // 武器发光（蓄力渐亮）
    this.matBlade.emissiveIntensity += (this.cur.glow - this.matBlade.emissiveIntensity) * Math.min(1, dt * 6);
    // ★SPEC(模块13) 盔缨：常态 1.2；受击瞬间突增至 3.0，0.1s 内回落
    if (this.matPlume) {
      if (this.plumeFlash > 0) {
        this.plumeFlash = Math.max(0, this.plumeFlash - dt);
        const k = this.plumeFlash / HERO.PLUME_FLASH_DUR;
        this.matPlume.emissiveIntensity = HERO.PLUME_EMISSIVE_INTENSITY
          + (HERO.PLUME_FLASH_INTENSITY - HERO.PLUME_EMISSIVE_INTENSITY) * k;
      } else if (this.matPlume.emissiveIntensity !== HERO.PLUME_EMISSIVE_INTENSITY) {
        this.matPlume.emissiveIntensity = HERO.PLUME_EMISSIVE_INTENSITY;
      }
    }
  }

  /** 受击：dirAngle 为攻击者相对玩家的世界方位角（弧度，yaw 约定同项目） */
  flashHit(dirAngle, facing) {
    // 相对玩家的方向（前=0，后=π，左/右=±π/2）
    let rel = dirAngle - (facing ?? 0);
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    let tx = 0, ty = 0, hx = 0;
    if (Math.abs(rel) < Math.PI / 4) { tx = -0.25; ty = 0; hx = -0.1; } // 前
    else if (Math.abs(rel) > 3 * Math.PI / 4) { tx = 0.25; ty = 0; hx = 0.1; } // 后
    else if (rel > 0) { ty = 0.4; } // 右
    else { ty = -0.4; } // 左
    this.hitTilt = { spineX: tx, spineY: ty, headX: hx };
    this.hitTimer = 0.18;
    // ★SPEC(模块13) 命中瞬间盔缨闪白 0.1s
    this.plumeFlash = HERO.PLUME_FLASH_DUR;
  }
}

export function createHeroMesh() {
  const root = new Group();
  root.name = 'hero';
  const hero = new HeroAnimator(root);
  root.userData.hero = hero;
  return root;
}

export function updateHeroMesh(mesh, snap, chain, dt = 1 / 60, speed = 0) {
  const hero = mesh.userData.hero;
  if (!hero) return;
  hero.update(snap, chain, dt, speed);
}
