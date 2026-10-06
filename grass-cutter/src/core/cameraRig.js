/**
 * 第三人称摄像机（模块 1 的核心交付物）
 * ---------------------------------------------------------------------------
 * spec：距离 8m / 高度 4m / 平滑跟随插值系数 0.08 / 碰撞检测自动拉近 /
 *       禁止穿过模型 / 跟随平滑不剧烈抖动。
 *
 * 拆成"四件事"，每件都能单独验证：
 *   ① 平滑  —— 只对**注视点 pivot** 做 0.08 插值。视角（yaw/pitch）不做插值。
 *              给视角加平滑 = 鼠标输入被延迟 = 手感发飘，这是新手最常踩的坑。
 *   ② 几何  —— 由「水平 8m + 抬升 4m」反算俯角与直线距离（见 cameraMath）。
 *   ③ 碰撞  —— 从 pivot 打 3 条射线（中心 + 左右），取最近命中再退 COLLIDE_MARGIN。
 *   ④ 反抖  —— 拉近用快系数(0.55)、推远用慢系数(0.08)；末尾再补一道"硬守卫"，
 *              保证平滑过程中的抖动**也不可能**把相机留在墙里。
 *
 * 分层：本文件负责与 three 交互；所有数值计算都在 cameraMath（纯函数，可单测）。
 */
import { PerspectiveCamera, Raycaster, Vector3 } from '../../vendor/three/three.module.js';
import { BATTLEFIELD, CAMERA, DEG } from './config.js';
import { pointInOBB } from './battlefieldLayout.js';
import {
  basePitch,
  boomLength,
  boomSmoothK,
  cameraPosition,
  clampHeight,
  clampPitch,
  damp,
  dampVec3,
  groundLimitedBoom,
  resolveBoomLength,
  rightVector,
  wrapYaw,
} from './cameraMath.js';

export class CameraRig {
  constructor(camera, { colliders = [], blockers = [], cfg = CAMERA, tank = BATTLEFIELD } = {}) {
    this.camera = camera;
    this.colliders = colliders;
    // blockers：所有实体的**解析形状**（来自布局数据），只用来判断
    // "注视点是不是已经在实体内部"。这一步不能用射线代替，原因见 battlefieldLayout.blockerShapes。
    this.blockers = blockers;
    this.cfg = cfg;
    this.tank = tank;

    this.basePitch = basePitch(cfg.DISTANCE, cfg.HEIGHT); // ≈ 26.57°
    this.boom = boomLength(cfg.DISTANCE, cfg.HEIGHT); // ≈ 8.94m

    this.yaw = cfg.YAW_INIT_DEG * DEG;
    this.userPitch = cfg.PITCH_INIT_DEG * DEG;

    this.target = { x: 0, y: 0, z: 0 }; // 玩家真实位置（模块 2 每帧喂进来）
    this.pivot = { x: 0, y: cfg.PIVOT_HEIGHT, z: 0 }; // 平滑后的注视点
    this.boomCurrent = this.boom;
    this.blocked = false;
    this.hitDistance = Infinity;
    this.groundClampHits = 0; // 地面钳制生效次数：正常应恒为 0（见 config 的俯角推导）
    this.guardHits = 0; // 硬守卫生效次数：遮挡边界会触发，属于**已知且被接受**的代价

    this.raycaster = new Raycaster();
    this.raycaster.near = 0;
    this.raycaster.far = this.boom + 2;

    this._dir = new Vector3();    this._origin = new Vector3();

    // 诊断读数（HUD / 探针用）
    this.debug = {
      yawDeg: 0,
      pitchDeg: 0,
      boomDesired: this.boom,
      boomCurrent: this.boom,
      boomUsed: this.boom,
      groundCap: Infinity,
      blocked: false,
      hitDistance: Infinity,
      groundClampHits: 0,
      guardHits: 0,
      enclosed: false,
      pivot: { ...this.pivot },
      position: { x: 0, y: 0, z: 0 },
      horizontalDistance: cfg.DISTANCE,
      heightAbovePivot: cfg.HEIGHT,
    };
  }

  /** 每帧喂入玩家位置（模块 2 的 PlayerController 会调它） */
  setTarget(pos) {
    const p = pos || {};
    this.target = {
      x: Number.isFinite(p.x) ? p.x : 0,
      y: Number.isFinite(p.y) ? p.y : 0,
      z: Number.isFinite(p.z) ? p.z : 0,
    };
  }

  /** 鼠标增量 → 视角。dx 右为正、dy 下为正（与浏览器 mousemove 一致）
   *
   *  横向与纵向用**不同的**灵敏度（模块 2 spec：0.0022 / 0.0018），这是很常见的做法 ——
   *  纵向视野窄、同样的像素位移在纵向上"感觉更快"，所以纵向系数通常更小。
   *
   *  ⚠ 这里**不做 devicePixelRatio 折算**：movementX/Y 本身就是 CSS 像素，
   *    再除一次 DPR 等于在 HiDPI 屏上偷偷把灵敏度改小（而且让 spec 的数字失去意义）。
   */
  addLook(dx, dy) {
    const nx = Number.isFinite(dx) ? dx : 0;
    const ny = Number.isFinite(dy) ? dy : 0;
    this.yaw = wrapYaw(this.yaw - nx * this.cfg.MOUSE_SENS_YAW);
    this.userPitch -= ny * this.cfg.MOUSE_SENS_PITCH;
  }

  /** 由外部（输入系统）直接设定视角，模块 2 会主要用这个 */
  setLook(yaw, pitch) {
    this.yaw = wrapYaw(yaw);
    this.userPitch = pitch;
  }

  get pitch() {
    return clampPitch(this.basePitch + this.userPitch, this.cfg.PITCH_MIN_DEG * DEG, this.cfg.PITCH_MAX_DEG * DEG);
  }

  /** 从 pivot 向期望机位打射线，返回沿**中心射线**的各条命中长度（米）；无命中 = Infinity
   *
   *  侧向射线是"平移起点、方向不变"，如果直接用它自己的 hits[0].distance，
   *  斜着擦墙时会算长（等于放行了穿模）。所以统一把命中点**投影回中心射线**，
   *  得到同一个尺度上的长度后再比较。
   */
  _castBoom(pivot, yaw) {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cx = Math.sin(yaw) * cp;
    const cy = sp;
    const cz = Math.cos(yaw) * cp;
    this._dir.set(cx, cy, cz).normalize(); // 已归一，投影即长度
    const right = rightVector(yaw);

    const out = [];
    for (const off of [0, ...this.cfg.NUDGE_RAYS]) {
      this._origin.set(pivot.x + right.x * off, pivot.y, pivot.z + right.z * off);
      this.raycaster.set(this._origin, this._dir);
      this.raycaster.far = this.boom + 2;
      const hits = this.raycaster.intersectObjects(this.colliders, true);
      if (!hits.length) {
        out.push(Infinity);
        continue;
      }
      const hp = hits[0].point;
      const t = (hp.x - pivot.x) * this._dir.x + (hp.y - pivot.y) * this._dir.y + (hp.z - pivot.z) * this._dir.z;
      // t<=0 说明打到的是"身后/身侧"的面，不该据此把相机拉到脸上 —— 忽略这条射线
      out.push(t <= 0.05 ? Infinity : t);
    }
    return out;
  }

  /** 注视点是否已经落在某个实体内部（说明上游把玩家塞进墙里了） */
  pivotEnclosed(pivot = this.pivot) {
    if (!this.blockers.length) return false;
    for (const b of this.blockers) {
      if (pointInOBB(pivot.x, pivot.y, pivot.z, b)) return true;
    }
    return false;
  }

  update(dt) {
    const cfg = this.cfg;
    const desiredPivot = { x: this.target.x, y: this.target.y + cfg.PIVOT_HEIGHT, z: this.target.z };
    // ① 平滑：spec 的 0.08。帧率无关（见 cameraMath.dampFactor）
    this.pivot = dampVec3(this.pivot, desiredPivot, cfg.FOLLOW_K, dt);

    const pitch = this.pitch;

    // 每帧落位用的有效摇臂 = 平滑后的摇臂 与 地面几何上限 的较小者。
    // ⚠ 地面上限**不进平滑**：它是俯角的连续函数，跟着鼠标连续变化本来就是连续的；
    //   若把它塞进 boomCurrent 的平滑里，低头再抬头时摇臂要花 ~1s 慢慢推回去（很明显的滞后感）。
    const groundCap = groundLimitedBoom(this.pivot.y, pitch, cfg.GROUND_MIN_Y);

    // ③ 碰撞 → 目标摇臂长度
    //    先判"注视点是不是已经在实体内部"：这时射线会因背面剔除而静默返回空结果，
    //    若照常处理，相机会以为视野通畅而一路穿到墙后面去。退化为贴身是唯一安全解。
    const enclosed = this.pivotEnclosed(this.pivot);
    let targetBoom = this.boom;
    let nearest = Infinity;
    if (cfg.COLLIDE_ENABLED && this.colliders.length) {
      if (enclosed) {
        nearest = 0;
        targetBoom = cfg.GUARD_MIN_DISTANCE;
      } else {
        const dists = this._castBoom(this.pivot, this.yaw);
        nearest = Math.min(...dists);
        targetBoom = resolveBoomLength({
          desired: this.boom,
          hitDistances: dists,
          margin: cfg.COLLIDE_MARGIN,
          minDistance: cfg.MIN_DISTANCE,
        });
      }
    }

    // ④ 反抖：拉近快、推远慢
    const k = boomSmoothK(this.boomCurrent, targetBoom, cfg.PULL_IN_K, cfg.PUSH_OUT_K);
    this.boomCurrent = damp(this.boomCurrent, targetBoom, k, dt);

    // ④b 硬守卫：平滑本身有滞后，滞后期间仍可能贴进墙里。
    //     落位前用最终机位再验一次，命中就把摇臂直接钳到命中点内侧 —— 
    //     这一步的代价是"偶尔会硬拉一下"，但换来的是"绝不穿模"，值得。
    //     注意这里用的是 GUARD_MIN_DISTANCE（0.25m）而不是 MIN_DISTANCE：
    //     玩家贴墙时可用空间可能只有半米，坚持 1.6m 等于把相机推进墙里。
    // ⚠ boomUsed 是**真正落位用的那根摇臂**：它 = min(平滑摇臂, 地面上限)，被守卫钳过还会更短。
    //   必须单独记出来 —— boomCurrent 是平滑状态，压制它的地面上限**不进平滑**（理由见上），
    //   于是"相机被压到贴地"时 boomCurrent 仍然显示 8.94，HUD 会当场面说谎。
    let boomUsed = Math.min(this.boomCurrent, groundCap);
    let pos = cameraPosition(this.pivot, this.yaw, pitch, boomUsed);
    if (cfg.COLLIDE_ENABLED && this.colliders.length && !enclosed) {
      const dir = { x: pos.x - this.pivot.x, y: pos.y - this.pivot.y, z: pos.z - this.pivot.z };
      const len = Math.hypot(dir.x, dir.y, dir.z);
      if (len > 1e-4) {
        this._dir.set(dir.x / len, dir.y / len, dir.z / len);
        this._origin.set(this.pivot.x, this.pivot.y, this.pivot.z);
        this.raycaster.set(this._origin, this._dir);
        this.raycaster.far = len;
        const hits = this.raycaster.intersectObjects(this.colliders, true);
        if (hits.length) {
          const safe = Math.max(cfg.GUARD_MIN_DISTANCE, hits[0].distance - cfg.COLLIDE_MARGIN);
          if (safe < len) {
            this.boomCurrent = safe;
            boomUsed = safe;
            pos = cameraPosition(this.pivot, this.yaw, pitch, safe);
            this.guardHits++;
          }
        }
      }
    }

    // 地面硬下限：无论怎么转，相机都不许沉到地下。
    // ⚠ 这是**兜底**，不是常规路径。正常情况下 groundLimitedBoom 已经在几何上
    //   保证了相机不会低于它（俯角 -60° 时摇臂被压到 1.155m，相机 y 恰好 = 0.6m），
    //   所以这个计数器应当**恒为 0**；一旦它不是 0，说明那个几何推导被打破了 ——
    //   这是"不该发生的分支"的哨兵，不是"正常会走到的分支"。
    const y = clampHeight(pos.y, cfg.GROUND_MIN_Y);
    if (y !== pos.y) this.groundClampHits++;
    this.camera.position.set(pos.x, y, pos.z);
    this.camera.lookAt(this.pivot.x, this.pivot.y, this.pivot.z);

    // 诊断
    this.blocked = nearest < this.boom;
    this.hitDistance = nearest;
    const d = this.debug;
    d.yawDeg = (this.yaw / DEG) % 360;
    d.pitchDeg = pitch / DEG;
    d.boomDesired = this.boom;
    d.boomCurrent = this.boomCurrent;
    d.boomUsed = boomUsed;
    d.groundCap = groundCap;
    d.blocked = this.blocked;
    d.hitDistance = nearest;
    d.groundClampHits = this.groundClampHits;
    d.guardHits = this.guardHits;
    d.enclosed = enclosed;
    d.pivot = { ...this.pivot };
    d.position = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
    const flat = Math.hypot(this.camera.position.x - this.pivot.x, this.camera.position.z - this.pivot.z);
    d.horizontalDistance = flat;
    d.heightAbovePivot = this.camera.position.y - this.pivot.y;
    // ⚠ 返回**快照**而不是 this.debug 本身：
    // 否则调用方拿到的引用会被下一帧就地改写 —— "跑 600 帧之后再回头断言第 1 帧的读数"
    // 会读到最后一帧的值，测试会出现极难查的假绿/假红。
    return { ...d, pivot: { ...d.pivot }, position: { ...d.position } };
  }
}

export function createCamera(aspect, cfg = CAMERA) {
  const cam = new PerspectiveCamera(cfg.FOV, aspect, cfg.NEAR, cfg.FAR);
  cam.name = 'main-camera';
  return cam;
}
