/**
 * 靶子外观（模块 3 的临时物件）—— ⚠ 模块 4 会换掉，连同 targets.js 一起。
 * ---------------------------------------------------------------------------
 * 一个稻草人 + 一条血条。存在的唯一理由是"让攻击判定在浏览器里**看得见**"：
 * 打中了要闪白、要被打退、血条要掉、打碎了要消失再立起来。
 *
 * 血条用两个面向镜头的平面（不是 Sprite）：Sprite 的缩放是屏幕空间的，
 * 血量掉一半时会看起来像"变短了一点点"，而平面可以直接按比例改宽度。
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
} from '../../vendor/three/three.module.js';
import { DUMMY } from './targets.js';

const FLASH = 0xff4a3a;
const STRAW = 0xc9a86a;
const STRAW_DARK = 0x9a7d46;
const WOOD = 0x6b4f2f;
const CLOTH = 0x8c3a3a;
const HP_BG = 0x1a1a1a;
const HP_FG = 0x4ade80;
const HP_LOW = 0xef4444;
const STUN = 0xffe066; // 硬直提示色（头顶转圈的"晕星"）

function makeBar(width, color, opacity) {
  const g = new PlaneGeometry(width, 0.14);
  const m = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false });
  const mesh = new Mesh(g, m);
  mesh.renderOrder = 20;
  return mesh;
}

export function createDummyMesh(target) {
  const g = new Group();
  g.name = `dummy-${target.id}`;

  const strawMat = new MeshStandardMaterial({ color: STRAW, roughness: 0.95, metalness: 0 });
  const strawDarkMat = new MeshStandardMaterial({ color: STRAW_DARK, roughness: 0.95, metalness: 0 });
  const woodMat = new MeshStandardMaterial({ color: WOOD, roughness: 0.8, metalness: 0.05 });
  const clothMat = new MeshStandardMaterial({ color: CLOTH, roughness: 0.9, metalness: 0 });

  const base = new Mesh(new CylinderGeometry(0.34, 0.46, 0.22, 10), woodMat);
  base.position.y = 0.11;
  const post = new Mesh(new CylinderGeometry(0.085, 0.085, 1.1, 8), woodMat);
  post.position.y = 0.66;
  const body = new Mesh(new BoxGeometry(0.72, 0.96, 0.44), strawMat);
  body.position.y = 1.2;
  const belt = new Mesh(new BoxGeometry(0.76, 0.12, 0.48), strawDarkMat);
  belt.position.y = 1.06;
  const head = new Mesh(new SphereGeometry(0.23, 12, 10), clothMat);
  head.position.y = 1.82;
  const arms = new Mesh(new BoxGeometry(1.5, 0.16, 0.16), strawDarkMat);
  arms.position.y = 1.48;

  // 身体部件单独放一个组：受击硬直时要让**整套身体往后仰**，
  // 但血条和"晕星"必须保持竖直/朝向镜头，所以不能一起转。
  const parts = new Group();
  for (const m of [base, post, body, belt, head, arms]) {
    m.castShadow = true;
    m.receiveShadow = true;
    parts.add(m);
  }
  g.add(parts);

  // ★受击硬直提示：头顶转圈的晕星（模块 4 的敌人也会共用这套读法）
  const stun = new Group();
  const stunMat = new MeshBasicMaterial({ color: STUN, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false });
  for (let i = 0; i < 3; i++) {
    const s = new Mesh(new SphereGeometry(0.075, 8, 6), stunMat);
    const a = (i / 3) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32);
    s.renderOrder = 21;
    stun.add(s);
  }
  stun.position.y = 2.14;
  stun.visible = false;
  g.add(stun);

  // 血条（面向镜头的两个平面）
  const bars = new Group();
  const width = DUMMY.RADIUS * 2.2;
  const bg = makeBar(width + 0.04, HP_BG, 0.7);
  const fg = makeBar(width, HP_FG, 0.95);
  bg.position.z = 0.001;
  fg.position.z = 0.002;
  bars.add(bg, fg);
  bars.position.y = 2.25;
  g.add(bars);

  g.position.set(target.x, 0, target.z);
  g.userData = { parts, body, head, base, post, belt, arms, bars, fg, stun, barWidth: width, spin: 0 };
  return g;
}

/**
 * 每帧同步：位置 / 受击闪白 / 受击硬直 / 血条 / 死亡隐藏 / 面向镜头。
 * @param dt 帧长（旋转晕星用；不传就退回一个固定增量，仍然能看懂）
 */
export function updateDummyMesh(mesh, target, camera, dt = 1 / 60) {
  const u = mesh.userData;
  mesh.position.set(target.x, 0, target.z);

  // 受击闪白：用材质颜色直接插值（比 emissive 更显眼，而且不用管光照）
  const f = Math.max(0, Math.min(1, target.hitFlash / 0.14 || 0));
  u.body.material.color.setHex(STRAW).lerp(new THREE_COLOR(FLASH), f * 0.85);
  u.head.material.color.setHex(CLOTH).lerp(new THREE_COLOR(FLASH), f * 0.85);

  const alive = target.alive !== false;
  mesh.visible = alive;
  if (!alive) return;

  // ★受击硬直：头顶晕星转起来 + 身体往后仰（仰角与剩余硬直成比例）
  const stunned = target.stunTimer > 0;
  u.stun.visible = stunned;
  if (stunned) {
    u.spin += dt * 6.5;
    u.stun.rotation.y = u.spin;
    const lean = Math.min(1, target.stunTimer / (target.lastStun || 1));
    u.parts.rotation.z = -0.26 * lean;
    u.parts.rotation.x = 0.12 * lean;
  } else if (u.parts.rotation.z !== 0 || u.parts.rotation.x !== 0) {
    u.parts.rotation.z = 0;
    u.parts.rotation.x = 0;
  }

  const ratio = Math.max(0, Math.min(1, target.hp / (target.maxHp || 1)));
  u.fg.scale.x = ratio || 1e-4;
  u.fg.position.x = -(u.barWidth * (1 - ratio)) / 2;
  u.fg.material.color.setHex(ratio > 0.35 ? HP_FG : HP_LOW);

  if (camera) u.bars.quaternion.copy(camera.quaternion);
}

// 小工具：避免每次闪白都 new 一个 Color（每帧 ×5 个目标 ×2 = 10 次分配，还是省掉好）
const FLASH_COLORS = new Map();
function THREE_COLOR(hex) {
  let c = FLASH_COLORS.get(hex);
  if (!c) {
    c = new Color(hex);
    FLASH_COLORS.set(hex, c);
  }
  return c;
}
