/**
 * 美术升级（2026-11）—— 豆包生成的 4 张特效贴图（Sprite）接入。
 * ---------------------------------------------------------------------------
 * 职责边界（务必保持）：
 *   · 纯表现层：只在新时机叠一张会放大+淡出的公告板贴图，不碰任何战斗判定 / 数值 / RNG。
 *   · 完全自包含：加载、对象池、事件处理、生命周期都在本文件，main 只加实例化 + handle + update。
 *   · 失败静默：No-WebGL / 图片缺失 / 加载器异常 → 整个模块 no-op，游戏照常运行。
 *   · 对象池：每种特效 6 个 Sprite 槽位循环复用，热路径零分配。
 *
 * 触发映射：
 *   art1(裂空斩)        → 金色剑气  fx_swordqi.png
 *   art2(震地击)        → 斗气流光  fx_douqi.png
 *   musou-release(无双) → 无双爆破  fx_musou.png
 *   重击 damage(H/C技)  → 暴击星芒  fx_crit.png（带 0.12s 节流，防刷屏）
 */
import {
  AdditiveBlending,
  Sprite,
  SpriteMaterial,
  TextureLoader,
} from '../../vendor/three/three.module.js';

const TEX_DIR = './assets/fx/';
// kind → { file, 起始尺寸(米), 结束尺寸倍数, 寿命(s), 起始不透明度 }
const DEFS = {
  swordqi: { file: 'fx_swordqi.png', base: 3.2, grow: 1.7, life: 0.42, alpha: 0.95 },
  douqi:   { file: 'fx_douqi.png',   base: 3.6, grow: 1.6, life: 0.55, alpha: 0.9 },
  musou:   { file: 'fx_musou.png',   base: 5.0, grow: 2.4, life: 0.7,  alpha: 1.0 },
  crit:    { file: 'fx_crit.png',    base: 1.8, grow: 1.9, life: 0.3,  alpha: 0.85 },
};
const POOL = 6;
const HEAVY_CD = 0.12; // 重击星芒节流间隔（秒）

function isHeavy(id = '') {
  return id === 'H' || id.startsWith('C') || id === 'CHARGED' || id === 'musou' || id.startsWith('art');
}

export class ArtSprites {
  /**
   * @param scene THREE.Scene
   * @param opts { reducedMotion?:boolean }
   */
  constructor(scene, opts = {}) {
    this.enabled = true;
    this.reducedMotion = !!opts.reducedMotion;
    this.root = null;
    this.slots = {};
    this.loaded = {};
    this._heavyCd = 0;
    this._alive = 0;
    if (!scene || typeof scene.add !== 'function') { this.enabled = false; return; }

    try {
      this.root = scene; // Sprite 直接挂到 scene，随相机朝向自动 billboard
      const loader = new TextureLoader();
      for (const kind of Object.keys(DEFS)) {
        const arr = [];
        for (let i = 0; i < POOL; i++) {
          const mat = new SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
          const sp = new Sprite(mat);
          sp.visible = false;
          sp.frustumCulled = false;
          sp.renderOrder = 5;
          scene.add(sp);
          arr.push({ sp, life: 0, max: DEFS[kind].life, def: DEFS[kind] });
        }
        this.slots[kind] = arr;
        this.loaded[kind] = false;
        // 异步加载：成功给所有槽位贴上贴图；失败保持 no-op（槽位仍 invisible）
        loader.load(TEX_DIR + DEFS[kind].file,
          (tex) => {
            tex.anisotropy = 1;
            for (const s of arr) s.sp.material.map = tex, s.sp.material.needsUpdate = true;
            this.loaded[kind] = true;
          },
          undefined,
          () => { /* 图片缺失：静默降级，不影响游戏 */ }
        );
      }
    } catch (e) {
      // 构造期任何异常（无 WebGL / 加载器异常）→ 关闭整个模块
      this.enabled = false;
    }
  }

  /** 播放一个特效：从对应池里取一个空闲（或最旧）槽位。 */
  _burst(kind, x, y, z, scaleMul = 1) {
    if (!this.enabled || !this.loaded[kind]) return;
    const arr = this.slots[kind];
    if (!arr) return;
    let slot = null;
    for (const s of arr) if (s.life <= 0) { slot = s; break; }
    if (!slot) slot = arr.reduce((a, b) => (a.life <= b.life ? a : b)); // 全占用：抢剩余寿命最短的
    const d = slot.def;
    slot.sp.visible = true;
    slot.sp.position.set(x, y, z);
    slot.sp.scale.setScalar(d.base * scaleMul);
    slot.sp.material.opacity = d.alpha;
    slot.life = d.life;
    slot.max = d.life;
    slot.scaleMul = scaleMul;
  }

  /** 解析战斗事件（与 inkFx.handle 吃同一份 combat.events）。
   *  @param playerPos 玩家当前坐标 {x,z}；art/musou 事件本身不带坐标，用它定位。 */
  handle(events, playerPos) {
    if (!this.enabled || !events) return;
    const px = playerPos?.x ?? 0, pz = playerPos?.z ?? 0;
    for (const ev of events) {
      if (ev.type === 'musou-release') {
        this._burst('musou', ev.x ?? px, 1.2, ev.z ?? pz, 1.0);
      } else if (ev.type === 'art') {
        const kind = ev.id === 'art2' ? 'douqi' : 'swordqi';
        this._burst(kind, ev.x ?? px, 1.1, ev.z ?? pz, 1.0);
      } else if (ev.type === 'damage' && isHeavy(ev.move?.id)) {
        // 重击星芒：带节流，只取命中点；无双/武艺的 damage 不放（避免和大招图叠）。
        const hp = ev.result?.hitPoint;
        this.onHeavyHit(hp);
      }
    }
  }

  /** 重击命中时播放暴击星芒，带 0.12s 节流防刷屏。 */
  onHeavyHit(hp) {
    if (!this.enabled || this._heavyCd > 0 || !hp) return;
    this._burst('crit', hp.x, Math.max(0.4, hp.y ?? 1), hp.z, 1.0);
    this._heavyCd = HEAVY_CD;
  }

  /** 每帧推进：淡出 + 放大 + 计时。 */
  update(dt) {
    if (!this.enabled) return;
    if (this._heavyCd > 0) this._heavyCd = Math.max(0, this._heavyCd - dt);
    for (const kind of Object.keys(this.slots)) {
      const arr = this.slots[kind];
      for (const s of arr) {
        if (s.life <= 0) { if (s.sp.visible) s.sp.visible = false; continue; }
        s.life -= dt;
        const k = Math.max(0, s.life / s.max);       // 1 → 0
        const grow = 1 + (s.def.grow - 1) * (1 - k); // 随寿命放大
        s.sp.scale.setScalar(s.def.base * (s.scaleMul || 1) * grow);
        s.sp.material.opacity = s.def.alpha * k;
        if (s.life <= 0) s.sp.visible = false;
      }
    }
  }

  /** 无障碍：减弱动态效果时关掉（与 inkFx.setMotion 口径一致）。 */
  setMotion(m = {}) {
    if (m.reducedMotion !== undefined) {
      this.reducedMotion = !!m.reducedMotion;
      if (this.reducedMotion) {
        for (const kind of Object.keys(this.slots))
          for (const s of this.slots[kind]) { s.life = 0; s.sp.visible = false; }
      }
    }
  }

  dispose() {
    for (const kind of Object.keys(this.slots)) {
      for (const s of this.slots[kind]) {
        s.sp.material.map?.dispose?.();
        s.sp.material.dispose();
        s.sp.parent?.remove?.(s.sp);
      }
    }
    this.slots = {};
  }
}
