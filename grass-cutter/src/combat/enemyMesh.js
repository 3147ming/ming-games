/**
 * 敌人外观（模块 4）—— 全部走 **InstancedMesh**，整支军队合计 5~6 次 draw call。
 * ---------------------------------------------------------------------------
 * 为什么非这么做不可（这是本模块唯一"性能优先"的设计决定）：
 *
 *   模块 3 的草人是"一个 Group + 12 个 Mesh"。照抄到 160 个敌人身上就是 1920 次 draw call，
 *   每次的 JS 侧固定开销约 0.02ms —— 38ms/帧，直接锁死在 26fps，跟显卡没关系。
 *
 *   所以：**几何只烘一次、颜色烘成顶点色、个体差异走每实例矩阵与每实例颜色**。
 *   最后的账单是 3（兵种剪影 × 身体）+ 3（武器）+ 1（硬直标记）+ 2（血条底/血条）+ 1（调试状态环）
 *   ≈ 6 次（常态）+ 4 次（有硬直/血条时）= 10 次封顶，比一个草人还省。
 *
 * 代价与补偿（都写在这里，免得后来者以为漏了）：
 *   · 不能给单个敌人挂 Group 层级的动画 → 改在 CPU 侧按状态直接合成每实例矩阵
 *     （走路的上下颠、起手时的后仰、出手时的前压，都是矩阵里的一句话）。
 *   · 血条不常显 → 只在**受过伤**时出现（无双类杂兵的标准做法，也把 draw call 省下来）。
 *   · 硬直标记用 1 个环而不是草人那 3 颗星 —— 160 个 ×3 颗 = 480 次额外 draw call，
 *     那不是省钱，是把刚省下的又还回去。
 *
 * 朝向约定：全项目统一 yaw=0 → 面向 -Z；局部坐标里也是"面朝 -Z"，武器握在 +X 侧的手上。
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '../../vendor/three/three.module.js';
import { ENEMY_AI, SCENE_INK } from '../core/config.js';
import { hexToRgb } from '../core/inkTone.js';
import { at, mergeParts, placed } from '../core/geoMerge.js';
import { ENEMY_STATE } from './enemyAI.js';

// ─────────────────────────────────────────────────────────────────────────────
// 调色板与几何常量（改外观只改这一段）
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  cloth: 0x5d6470,
  clothDark: 0x454b55,
  leather: 0x6a5443,
  steel: 0x8f98a6,
  steelDark: 0x646d7a,
  skin: 0xb98a63,
  trim: 0x8b6b3e,
  blade: 0xb9c2cf,
  wood: 0x6b4f2f,
};

/** 三态染色（**乘性**，> 1 = 提亮）。用数组而不是 Color：每帧 160 次，不该分配对象。 */
const STATE_TINT = {
  [ENEMY_STATE.IDLE]: [0.6, 0.64, 0.73], // 待机：冷、暗 —— 一眼看出"它还没盯上我"
  [ENEMY_STATE.THREATEN]: [0.94, 0.96, 1.0], // 威慑：本色（围上来的那一圈）
  [ENEMY_STATE.ATTACK]: [1.34, 1.02, 0.86], // 攻击：暖、亮。35 个亮点就是"压力"本身
};
const FLASH_TINT = [2.4, 1.7, 1.5];
const STUN_TINT = [1.5, 1.35, 0.7]; // 硬直整体泛黄，和头顶的环呼应
const DEAD_TINT = [0.34, 0.31, 0.33];

const BAR_W = 0.86; // 血条宽度（米）—— "从左边掉"的平移量由它派生
const BAR_Y = 2.06;
const MARKER_Y = 1.99;
const HP_OK = [0.29, 0.87, 0.5];
const HP_LOW = [0.94, 0.27, 0.27];
const BAR_BG = [0.07, 0.08, 0.1];
const HAND_X = 0.4; // 手部锚点（敌人局部空间：右手）
const HAND_Y = 1.16;
const HAND_Z = -0.02;

const DRAW_RANGE = 140; // 超过它不画（130m 处一个兵约 13 像素，正好被雾吃掉）
const BAR_RANGE = 30; // 血条只在这个距离内出现
const DEATH_SHRINK = 0.34; // 死亡收缩时长（秒），借 respawnTimer 的前 0.34s 表达
const TMP_COLOR = new Color();

// ── ★SPEC(模块13) 远处小兵淡墨剪影 ──
//   从 ENEMY_FAR_START 米开始线性揉进淡墨，到 DRAW_RANGE 达到满额 mix / 最低对比。
//   三点常量预先拆好（不拆成对象）：这段每帧要跑几百次，不能分配。
const FAR_INK = hexToRgb(SCENE_INK.ENEMY_FAR_INK);
const FAR_INK_R = FAR_INK.r;
const FAR_INK_G = FAR_INK.g;
const FAR_INK_B = FAR_INK.b;
const INK_FAR_START2 = SCENE_INK.ENEMY_FAR_START * SCENE_INK.ENEMY_FAR_START;
const INK_FAR_INV = 1 / Math.max(1, DRAW_RANGE - SCENE_INK.ENEMY_FAR_START);

const SWING = {
  REST: -0.32, // 持械待机角（绕局部 X）
  RAISED: -2.25, // 起手：举过头顶 —— 这就是"看得见的预警"
  STRUCK: 1.15, // 出手：劈下来
  YAW_REST: 0.22,
  YAW_STRUCK: -0.55,
};

// ─────────────────────────────────────────────────────────────────────────────
// 几何烘焙
// ─────────────────────────────────────────────────────────────────────────────
function bodyParts() {
  const B = (w, h, d, x, y, z, color, shade = 1) => ({
    geometry: new BoxGeometry(w, h, d),
    color,
    shade,
    matrix: at(x, y, z),
  });
  return [
    // 腿 + 靴
    B(0.17, 0.76, 0.19, -0.125, 0.4, 0, C.clothDark, 0.92),
    B(0.17, 0.76, 0.19, 0.125, 0.4, 0, C.clothDark, 0.92),
    B(0.2, 0.14, 0.25, -0.125, 0.07, -0.02, C.leather, 0.85),
    B(0.2, 0.14, 0.25, 0.125, 0.07, -0.02, C.leather, 0.85),
    // 战裙
    B(0.54, 0.3, 0.38, 0, 0.9, 0, C.cloth, 0.98),
    B(0.58, 0.09, 0.42, 0, 1.04, 0, C.leather, 1.0),
    // 躯干 + 胸甲 + 腰带
    B(0.46, 0.5, 0.3, 0, 1.26, 0, C.cloth, 1.05),
    B(0.5, 0.28, 0.34, 0, 1.32, 0, C.steel, 1.0),
    B(0.52, 0.1, 0.35, 0, 1.45, 0, C.trim, 1.05),
    // 肩甲
    B(0.2, 0.18, 0.3, -0.32, 1.44, 0, C.steelDark, 0.95),
    B(0.2, 0.18, 0.3, 0.32, 1.44, 0, C.steelDark, 0.95),
    // 手臂
    B(0.14, 0.46, 0.15, -0.33, 1.17, 0, C.cloth, 0.9),
    B(0.14, 0.46, 0.15, 0.33, 1.17, 0, C.cloth, 0.9),
    // 颈 / 头 / 盔 / 盔缨
    { geometry: new CylinderGeometry(0.07, 0.08, 0.12, 6), color: C.skin, matrix: at(0, 1.56, 0) },
    { geometry: new SphereGeometry(0.135, 10, 8), color: C.skin, matrix: at(0, 1.66, 0) },
    {
      geometry: new SphereGeometry(0.16, 10, 8),
      color: C.steelDark,
      matrix: placed({ x: 0, y: 1.7, z: 0 }, 0, { x: 1, y: 0.72, z: 1 }),
    },
    B(0.06, 0.1, 0.2, 0, 1.83, 0.02, C.trim, 1.1),
  ];
}

/** 三种兵种剪影的武器（握把在原点附近，沿 +Y 伸出） */
function weaponParts(variant) {
  const stick = (len, y) => ({
    geometry: new CylinderGeometry(0.032, 0.036, len, 7),
    color: C.wood,
    matrix: at(0, y, 0),
  });
  if (variant === 1) {
    // 枪兵：一丈长杆
    return [
      stick(2.5, 1.06),
      { geometry: new BoxGeometry(0.05, 0.34, 0.1), color: C.blade, matrix: at(0, 2.44, 0) },
      { geometry: new BoxGeometry(0.09, 0.06, 0.09), color: C.trim, matrix: at(0, 2.26, 0) },
      { geometry: new BoxGeometry(0.07, 0.09, 0.07), color: C.trim, matrix: at(0, 0.16, 0) },
    ];
  }
  if (variant === 2) {
    // 斧兵：短柄大斧
    return [
      stick(1.0, 0.4),
      { geometry: new BoxGeometry(0.07, 0.3, 0.42), color: C.steelDark, matrix: at(0, 0.94, -0.1) },
      { geometry: new BoxGeometry(0.055, 0.34, 0.5), color: C.blade, matrix: at(0, 0.94, -0.16) },
      { geometry: new BoxGeometry(0.09, 0.1, 0.1), color: C.trim, matrix: at(0, 0.94, 0.08) },
    ];
  }
  // 刀兵：直刀 + 护手
  return [
    stick(0.44, 0.12),
    { geometry: new BoxGeometry(0.16, 0.05, 0.06), color: C.trim, matrix: at(0, 0.3, 0) },
    { geometry: new BoxGeometry(0.055, 0.94, 0.11), color: C.blade, matrix: at(0, 0.78, 0) },
    { geometry: new BoxGeometry(0.05, 0.16, 0.07), color: C.steel, matrix: at(0, 1.28, 0) },
  ];
}

/** 硬直标记：两个细圆环（在头顶转） */
function markerGeometry() {
  return mergeParts([
    { geometry: new TorusGeometry(0.24, 0.022, 6, 14), color: 0xffffff },
    { geometry: new TorusGeometry(0.16, 0.014, 6, 12), color: 0xffffff, matrix: at(0, 0.07, 0) },
  ]).geometry;
}

/** 血条：底 + 前景（前景靠每实例缩放改宽度、平移对齐左端） */
function barGeometries() {
  return {
    bg: mergeParts([{ geometry: new PlaneGeometry(BAR_W + 0.05, 0.11), color: 0xffffff }]).geometry,
    fg: mergeParts([{ geometry: new PlaneGeometry(BAR_W, 0.08), color: 0xffffff }]).geometry,
  };
}

/** 调试状态环（F5）：贴地的细环 */
function ringGeometry() {
  const g = new RingGeometry(0.62, 0.8, 20);
  g.rotateX(-Math.PI / 2);
  return mergeParts([{ geometry: g, color: 0xffffff }]).geometry;
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染器
// ─────────────────────────────────────────────────────────────────────────────
export class EnemyRenderer {
  constructor(scene, { maxCount = 256, stateRings = false } = {}) {
    this.scene = scene;
    this.maxCount = maxCount;
    this.root = new Group();
    this.root.name = 'enemy-horde';
    scene.add(this.root);

    const bodyMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.08 });
    const weaponMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 });
    const emissiveMat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.4,
      metalness: 0,
      emissive: 0xffd24a,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.95,
    });
    const barMat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    });

    const bodyGeo = mergeParts(bodyParts()).geometry;

    // 三种兵种剪影各一组实例（同一份体模，武器几何不同）
    this.variants = [0, 1, 2].map((i) => ({
      body: this._instanced(bodyGeo, bodyMat, true),
      weapon: this._instanced(mergeParts(weaponParts(i)).geometry, weaponMat, true),
    }));

    this.marker = this._instanced(markerGeometry(), emissiveMat, false);
    const bars = barGeometries();
    this.barBg = this._instanced(bars.bg, barMat, false);
    this.barFg = this._instanced(bars.fg, barMat, false);
    this.rings = this._instanced(ringGeometry(), emissiveMat, false);
    this.rings.visible = !!stateRings;
    // （marker / barBg / barFg / rings 在 _instanced 里已经是 count = 0，"一个都不画"）

    // 复用的矩阵/向量（每帧 160 次，绝不能 new）
    this._m = new Matrix4();
    this._hand = new Matrix4();
    this._tmp = new Matrix4();
    this._q = new Quaternion();
    this._v = new Vector3();
    this._v2 = new Vector3();
    this._s = new Vector3();
    this._axisY = new Vector3(0, 1, 0);
    this._camQuat = new Quaternion();
    this._time = 0;

    this.stats = { drawn: 0, hidden: 0, bodies: 0, markers: 0, bars: 0, rings: 0, meshes: 6 };
  }

  _instanced(geometry, material, shadow) {
    const mesh = new InstancedMesh(geometry, material, this.maxCount);
    // ⚠ InstancedMesh 的包围球按**几何**算，不知道实例被摆去了哪 ——
    //   不关掉视锥剔除的话，整支军队会随镜头平移突然整体消失（经典坑）。
    mesh.frustumCulled = false;
    mesh.castShadow = !!shadow;
    mesh.receiveShadow = !!shadow;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    this.root.add(mesh);
    return mesh;
  }

  setStateRings(on) {
    this.rings.visible = !!on;
    return this.rings.visible;
  }

  /**
   * 每帧同步。
   * @param items  敌人（读 x/z/y/alive/state/yaw/speed/tone/scale/variant/hp/maxHp/
   *                      windup/recover/stunTimer/lastStun/hitFlash/respawnTimer/seed）
   * @param camera 血条与硬直环做公告板朝向用
   * @param dt     帧长（**已含顿帧缩放**：顿帧时 dt=0，走路颠簸也会停住 —— 正是想要的）
   */
  sync(items, camera, dt = 1 / 60) {
    this._time += dt;
    if (camera) this._camQuat.copy(camera.quaternion);
    else this._camQuat.identity();

    const counts = [0, 0, 0];
    let markers = 0;
    let barN = 0;
    let rings = 0;
    let drawn = 0;
    let hidden = 0;

    const camX = camera?.position?.x ?? 0;
    const camZ = camera?.position?.z ?? 0;
    const range2 = DRAW_RANGE * DRAW_RANGE;
    const bar2 = BAR_RANGE * BAR_RANGE;

    for (const e of items) {
      const dxc = e.x - camX;
      const dzc = e.z - camZ;
      const far2 = dxc * dxc + dzc * dzc;

      if (!e.alive) {
        // 死亡收缩：借 respawnTimer 的前 0.34s，不用给实体再加一个字段
        const k = 1 - Math.max(0, Math.min(1, (e.respawnTimer || 0) / DEATH_SHRINK));
        if (k <= 0.001 || far2 > range2) {
          hidden++;
          continue;
        }
        this._writeBody(e, counts, {
          sizeK: k,
          tint: DEAD_TINT,
          sink: -0.78 * (1 - k),
          arm: 'dead',
        });
        drawn++;
        continue;
      }
      if (far2 > range2) {
        hidden++;
        continue;
      }
      drawn++;

      // —— 颜色三层：状态染色 × 个体色差 → 硬直泛黄 → 受击闪白
      const flash = Math.max(0, Math.min(1, (e.hitFlash || 0) / 0.14));
      const stunned = (e.stunTimer || 0) > 0;
      const base = STATE_TINT[e.state] ?? STATE_TINT[ENEMY_STATE.IDLE];
      const tone = e.tone ?? 1;
      let r = base[0] * tone;
      let g = base[1] * tone;
      let b = base[2] * tone;
      if (stunned) {
        r *= STUN_TINT[0];
        g *= STUN_TINT[1];
        b *= STUN_TINT[2];
      }
      if (flash > 0) {
        r += (FLASH_TINT[0] - r) * flash;
        g += (FLASH_TINT[1] - g) * flash;
        b += (FLASH_TINT[2] - b) * flash;
      }

      // ── ★SPEC(模块13) 远处小兵转淡墨剪影 + 减对比 ──
      //   远处一堆"高对比彩色小人"会把视线从主角身上抢走（主角才是要一眼定位的那个）。
      //   按距离线性揉进淡墨，并把通道往自身明度收（减对比），越远越像一层墨影。
      //   公式与 core/inkTone.js 的 silhouette() 完全一致 —— 这里内联展开是为了不分配临时对象，
      //   那边的导出版本留给单测当"参考实现"校验。
      if (INK_FAR_START2 > 0 && far2 > INK_FAR_START2) {
        const far = Math.sqrt(far2);
        const k = Math.min(1, (far - SCENE_INK.ENEMY_FAR_START) * INK_FAR_INV);
        const mix = SCENE_INK.ENEMY_FAR_MIX * k;
        const ct = 1 - (1 - SCENE_INK.ENEMY_FAR_CONTRAST) * k;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const fr = lum + (r - lum) * ct;
        const fg = lum + (g - lum) * ct;
        const fb = lum + (b - lum) * ct;
        r = fr + (FAR_INK_R - fr) * mix;
        g = fg + (FAR_INK_G - fg) * mix;
        b = fb + (FAR_INK_B - fb) * mix;
      }

      this._writeBody(e, counts, { tint: [r, g, b] });

      // 硬直标记（只有被硬直的那几个占实例）
      if (stunned && far2 <= bar2) {
        this._writeBillboard(this.marker, markers, e.x, MARKER_Y, e.z, 1, 1, 1, STUN_TINT);
        markers++;
      }

      // 血条：只给"受过伤"的，且只在近处
      const ratio = e.maxHp > 0 ? Math.max(0, e.hp) / e.maxHp : 0;
      if (ratio < 0.999 && far2 <= bar2) {
        const col = ratio > 0.35 ? HP_OK : HP_LOW;
        this._writeBillboard(this.barBg, barN, e.x, BAR_Y, e.z, 1, 1, 1, BAR_BG);
        this._writeBillboard(this.barFg, barN, e.x, BAR_Y, e.z, Math.max(0.001, ratio), 1, 1, col);
        barN++;
      }

      if (this.rings.visible) {
        this._writeRing(e, rings);
        rings++;
      }
    }

    // 压紧实例数（"画几个"是动态的；instanceMatrix 的缓冲区只分配一次、永不重建）
    for (let i = 0; i < 3; i++) {
      const v = this.variants[i];
      v.body.count = counts[i];
      v.weapon.count = counts[i];
      if (counts[i] > 0) {
        v.body.instanceMatrix.needsUpdate = true;
        v.weapon.instanceMatrix.needsUpdate = true;
        v.body.instanceColor.needsUpdate = true;
        v.weapon.instanceColor.needsUpdate = true;
      }
    }
    this._flush(this.marker, markers);
    this._flush(this.barBg, barN);
    this._flush(this.barFg, barN);
    this._flush(this.rings, this.rings.visible ? rings : 0);

    const s = this.stats;
    s.drawn = drawn;
    s.hidden = hidden;
    s.bodies = counts[0] + counts[1] + counts[2];
    s.markers = markers;
    s.bars = barN;
    s.rings = this.rings.visible ? rings : 0;
    return s;
  }

  _flush(mesh, count) {
    mesh.count = count;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * 写一个"身体 + 武器"实例。
   * 手臂姿势直接由 e.windup / e.recover 推出来 —— 这正是"先摇后砍"能被玩家读到的原因
   * （刀真的举起来了，而不是后台偷偷倒计时）。
   */
  _writeBody(e, counts, opts = {}) {
    const v = Math.max(0, Math.min(2, e.variant | 0));
    const group = this.variants[v];
    const k = counts[v];
    if (k >= this.maxCount) return;
    counts[v] = k + 1;

    const ai = ENEMY_AI;
    const scale = (e.scale ?? 1) * (opts.sizeK ?? 1);
    const moving = (e.speed ?? 0) > 0.05;
    const walkPhase = this._time * 9 + (e.seed ?? 0) * 0.001;
    const bob = moving ? Math.abs(Math.sin(walkPhase)) * 0.045 : 0;

    let tilt = 0;
    let swing = SWING.REST;
    let swingYaw = SWING.YAW_REST;
    if (opts.arm === 'dead') {
      tilt = 0.5;
      swing = SWING.REST - 1.1;
    } else if ((e.stunTimer || 0) > 0) {
      tilt = -0.34 * Math.min(1, (e.stunTimer || 0) / (e.lastStun || 1));
      swing = SWING.REST - 0.5;
    } else if ((e.windup || 0) > 0) {
      const t = 1 - Math.min(1, e.windup / Math.max(1e-6, ai.ATTACK_WINDUP));
      tilt = -0.16 * t;
      swing = SWING.REST + (SWING.RAISED - SWING.REST) * t;
      swingYaw = SWING.YAW_REST + 0.5 * t;
    } else if ((e.recover || 0) > 0) {
      const t = 1 - Math.min(1, e.recover / Math.max(1e-6, ai.ATTACK_RECOVER));
      const ease = 1 - (1 - t) * (1 - t); // 收招要"快出慢收"，线性会显得软
      tilt = 0.26 * (1 - ease);
      swing = SWING.REST + (SWING.STRUCK - SWING.REST) * (1 - ease);
      swingYaw = SWING.YAW_REST + (SWING.YAW_STRUCK - SWING.YAW_REST) * (1 - ease);
    } else if (moving) {
      tilt = 0.06;
    }

    this._q.setFromAxisAngle(this._axisY, e.yaw ?? 0);
    this._m.compose(
      this._v.set(e.x, (e.y ?? 0) + bob + (opts.sink ?? 0), e.z),
      this._q,
      this._s.set(scale, scale, scale)
    );
    if (tilt !== 0) {
      this._tmp.makeRotationX(tilt);
      this._m.multiply(this._tmp);
    }
    const tint = opts.tint ?? [1, 1, 1];

    group.body.setMatrixAt(k, this._m);
    group.body.setColorAt(k, TMP_COLOR.setRGB(tint[0], tint[1], tint[2]));

    // 武器 = 身体矩阵 × （劈砍旋转 · 手腕朝向 · 手部锚点）
    this._tmp.makeRotationX(swing);
    this._q.setFromAxisAngle(this._axisY, swingYaw);
    this._hand.makeRotationFromQuaternion(this._q);
    this._tmp.multiply(this._hand);
    this._tmp.setPosition(HAND_X, HAND_Y, HAND_Z);
    this._m.multiply(this._tmp);
    group.weapon.setMatrixAt(k, this._m);
    group.weapon.setColorAt(k, TMP_COLOR.setRGB(tint[0], tint[1], tint[2]));
  }

  /**
   * 公告板实例（血条 / 硬直环）：位置 + 跟随相机朝向 + 沿"屏幕横轴"平移并缩放。
   * 血条要"从左边开始掉"，所以先按缺口的一半沿相机横轴左移，再按比例缩放宽度。
   */
  _writeBillboard(mesh, index, x, y, z, scaleX, scaleY, scaleZ, color) {
    if (index >= this.maxCount) return;
    const px = this._v2.set(x, y, z);
    if (scaleX < 1) {
      const gap = (BAR_W * (1 - scaleX)) / 2;
      this._v.set(-gap, 0, 0).applyQuaternion(this._camQuat);
      px.x += this._v.x;
      px.z += this._v.z;
    }
    this._m.compose(px, this._camQuat, this._s.set(scaleX, scaleY, scaleZ));
    mesh.setMatrixAt(index, this._m);
    mesh.setColorAt(index, TMP_COLOR.setRGB(color[0], color[1], color[2]));
  }

  _writeRing(e, index) {
    if (index >= this.maxCount) return;
    this._q.setFromAxisAngle(this._axisY, 0);
    this._m.compose(this._v.set(e.x, 0.03, e.z), this._q, this._s.set(1, 1, 1));
    this.rings.setMatrixAt(index, this._m);
    const tint = STATE_TINT[e.state] ?? STATE_TINT[ENEMY_STATE.IDLE];
    this.rings.setColorAt(index, TMP_COLOR.setRGB(tint[0], tint[1], tint[2]));
  }

  dispose() {
    this.root.traverse((o) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    });
    this.scene.remove(this.root);
  }
}
