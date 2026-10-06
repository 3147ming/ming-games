/**
 * 模块 12 —— 外部角色资产加载与驱动（依赖 THREE）。
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. loadHeroAsset()       异步加载 .glb/.gltf（GLTFLoader）或 .vrm（@pixiv/three-vrm），
 *                            返回归一化结构 { type, scene, bones, clips, expressions, dispose }；
 *                            无资产 / 加载器缺失 / 加载失败 → 返回 null（调用方退回程序化武将）。
 *   2. HeroAssetAnimator     用引擎骨骼契约驱动外部模型（与 characters.js 的 HeroAnimator 同接口），
 *                            优先播放资产自带动画 clip（按名称映射 + 0.12s crossfade），
 *                            缺 clip 时退回 computeHeroTarget 程序化姿态；表情 blendshape 同步切换。
 *   3. createHeroMeshFromAsset() / createSilhouette()  组装网格 / 加载期水墨剪影占位。
 *
 * 设计要点：
 *   · 整体 try/catch 兜底，构造或加载失败都不影响主循环（模块 9/10/11 照常）。
 *   · 缺加载器（vendor 里没放 GLTFLoader / 没装 three-vrm）时优雅降级，不抛未捕获异常。
 *   · 所有模块 3~11 的判定/打击盒/数值一律不动——本文件只换"皮"与"骨骼姿态来源"。
 */
import {
  AnimationMixer,
  CapsuleGeometry,
  Color,
  Group,
  LOD,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from '../../vendor/three/three.module.js';
import { HERO } from '../core/config.js';
import { createKatana, createHeroPlume, attachHeroRimLight } from './characters.js';
import {
  ENGINE_BONES,
  mapBonesByHumanoid,
  mapGltfBones,
  mapExpressions,
  computeHeroTarget,
  resolveClipMap,
  deriveLodPaths,
  countTris,
} from './heroMap.js';

// GLTFLoader 放 vendor/three/jsm/loaders/（需自行放置；不引入 npm 依赖，保持零构建）。
// 借助 index.html 的 importmap，其内部的裸 'three' 会解析到同一份 three.module.js。
const GLTF_LOADER_URL = '../../vendor/three/jsm/loaders/GLTFLoader.js';

/**
 * 尝试用 GLTFLoader 加载一个 .glb/.gltf 并返回其 scene；失败（文件缺失/损坏/加载器缺失）返回 null。
 * 用于加载 LOD 副资产：任一 LOD 缺失都不影响整体，调用方会退化到更低层级。
 * @param {string} path
 * @returns {Promise<object|null>}
 */
async function tryLoadGlbScene(path) {
  if (!path) return null;
  let mod;
  try { mod = await import(GLTF_LOADER_URL); } catch { return null; }
  if (!mod || !mod.GLTFLoader) return null;
  try {
    const gltf = await new mod.GLTFLoader().loadAsync(path);
    return gltf.scene || null;
  } catch (e) {
    console.warn('[heroAsset] LOD 副资产加载失败（忽略，退回更低层级）：', path, e && e.message);
    return null;
  }
}

/**
 * 加载外部角色资产。返回归一化对象或 null。
 * @returns {Promise<{type:string,scene:object,bones:object,clips:Array,expressions:object,dispose:Function}|null>}
 */
export async function loadHeroAsset() {
  const path = HERO.ASSET_PATH;
  if (!path) return null;
  const ext = String(path).toLowerCase().split('.').pop();
  try {
    if (ext === 'vrm') {
      // ⚠ VRM 需要 @pixiv/three-vrm 包（npm 依赖，破零依赖铁律），需主理人授权后安装。
      const vrmMod = await import('@pixiv/three-vrm').catch(() => null);
      if (!vrmMod || !vrmMod.GLTFLoader || !vrmMod.VRMLoaderPlugin) {
        console.warn('[heroAsset] 未安装 @pixiv/three-vrm，无法加载 VRM，退回程序化武将。');
        return null;
      }
      const loader = new vrmMod.GLTFLoader();
      loader.register((parser) => new vrmMod.VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(path);
      const vrm = gltf.userData.vrm;
      if (!vrm) { console.warn('[heroAsset] VRM 解析失败（无 vrm 实例），退回程序化武将。'); return null; }
      const scene = vrm.scene || gltf.scene;
      const bones = mapBonesByHumanoid(vrm.humanoid);
      const clips = gltf.animations || [];
      const expressions = mapExpressions(vrm);
      return {
        type: 'vrm',
        scene,
        bones,
        clips,
        expressions,
        lod: { lod1: null, lod2: null },
        dispose() { scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.()); }); },
      };
      console.log('[heroAsset] VRM 资产加载成功');
    }
    // .glb / .gltf
    const gltfMod = await import(GLTF_LOADER_URL).catch(() => null);
    if (!gltfMod || !gltfMod.GLTFLoader) {
      console.warn('[heroAsset] 未找到 GLTFLoader（vendor/three/jsm/loaders/GLTFLoader.js），退回程序化武将。');
      return null;
    }
    const loader = new gltfMod.GLTFLoader();
    const gltf = await loader.loadAsync(path);
    const scene = gltf.scene;
    const bones = mapGltfBones(scene);
    const clips = gltf.animations || [];
    const expressions = mapExpressions(scene);
    // LOD 副资产（离线减面产物）：缺失则对应层级为 null，运行时退化到更低层级
    const lodPaths = deriveLodPaths(path);
    const lod = {
      lod1: HERO.LOD.ENABLED ? await tryLoadGlbScene(lodPaths.lod1) : null,
      lod2: HERO.LOD.ENABLED ? await tryLoadGlbScene(lodPaths.lod2) : null,
    };
    console.log(`[heroAsset] glTF 资产加载成功：bones=${Object.keys(bones).join(',')} clips=${clips.map((c) => c.name).join(',')} lod=${lod.lod1 ? 'L1' : '-'}${lod.lod2 ? 'L2' : '-'}`);
    return {
      type: 'glb',
      scene,
      bones,
      clips,
      expressions,
      lod,
      dispose() { scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.()); }); },
    };
  } catch (e) {
    console.warn('[heroAsset] 资产加载失败，退回程序化武将：', e && e.message);
    return null;
  }
}

/**
 * 用外部模型驱动角色姿态（与 characters.js HeroAnimator 同接口：update(snap, chain, dt, speed)）。
 */
export class HeroAssetAnimator {
  constructor(asset) {
    this.asset = asset;
    this.bones = asset.bones || {};
    this.expressions = asset.expressions;
    this.mixer = asset.clips && asset.clips.length ? new AnimationMixer(asset.scene) : null;
    this.actions = {};
    if (this.mixer) {
      for (const clip of asset.clips) {
        if (clip && clip.name) this.actions[clip.name] = this.mixer.clipAction(clip);
      }
    }
    // 动画名 → 引擎状态映射表（模糊匹配，纯逻辑 resolveClipMap）：缺 clip 的状态为 null → 退回程序化姿态
    this.clipMap = resolveClipMap(asset.clips.map((c) => c.name), HERO.ANIM);
    this.cur = { spineX: 0, spineY: 0, headX: 0, armLX: 0.2, armRX: -0.2, legLX: 0, legRX: 0, hipY: 0.95, capeX: 0.2, glow: 0.15 };
    this.target = { ...this.cur };
    this.hitTimer = 0;
    this.hitTilt = { spineX: 0, spineY: 0, headX: 0 };
    this._t = 0;
    this.currentClip = null;
    this.broken = false;
  }

  /** 受击：dirAngle 为攻击者相对玩家的世界方位角（弧度，yaw 约定同项目）。沿用引擎四向硬直。 */
  flashHit(dirAngle, facing) {
    let rel = (dirAngle ?? 0) - (facing ?? 0);
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    let tx = 0, ty = 0, hx = 0;
    if (Math.abs(rel) < Math.PI / 4) { tx = -0.25; ty = 0; hx = -0.1; }
    else if (Math.abs(rel) > 3 * Math.PI / 4) { tx = 0.25; ty = 0; hx = 0.1; }
    else if (rel > 0) { ty = 0.4; }
    else { ty = -0.4; }
    this.hitTilt = { spineX: tx, spineY: ty, headX: hx };
    this.hitTimer = 0.18;
  }

  /**
   * 把引擎运行态归约成"动画逻辑状态键"（与 HERO.ANIM / ANIM_SYNONYMS 的键对齐）。
   * 由 resolveClipMap 预先生成的 clipMap 再查到真实 clip 名，查不到则退回程序化姿态。
   * @param {object} snap 玩家快照
   * @param {object} chain 连段状态
   * @param {number} speed 当前速度（>0.4 且站立 → run）
   * @returns {string}
   */
  _stateKeyFor(snap, chain, speed = 0) {
    if (chain && chain.busy) {
      if (chain.phase === 'charging') return 'charge';
      const moveId = chain.move?.id;
      if (moveId === 'C3' || moveId === 'C4' || moveId === 'C5') return moveId;
      if (chain.heavy) return 'heavy';
      return 'N1'; // 普攻三连用 N1/N2 近似（资产里通常只有 1 个 light attack clip）
    }
    if (snap.state === 'dodge') return 'dash';
    if (!snap.grounded) return 'jump';
    return speed > 0.4 ? 'run' : 'idle';
  }

  _playClip(name) {
    if (!this.mixer) return false;
    const action = this.actions[name];
    if (!action) return false;
    if (this.currentClip === action) return true;
    action.reset();
    if (this.currentClip) action.crossFadeFrom(this.currentClip, HERO.CROSSFADE, false);
    else action.play();
    this.currentClip = action;
    return true;
  }

  _proceduralPose(snap, chain, dt, speed) {
    this.target = computeHeroTarget(snap, chain, this._t, speed);
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      const hk = Math.max(0, this.hitTimer / 0.18);
      this.target.spineX += this.hitTilt.spineX * hk;
      this.target.spineY += this.hitTilt.spineY * hk;
      this.target.headX += this.hitTilt.headX * hk;
    }
    const k = Math.min(1, dt / HERO.CROSSFADE);
    for (const key in this.cur) this.cur[key] += (this.target[key] - this.cur[key]) * k;
    const b = this.bones;
    if (b.spine) { b.spine.rotation.x = this.cur.spineX; b.spine.rotation.y = this.cur.spineY; }
    if (b.head) b.head.rotation.x = this.cur.headX;
    if (b.armL) b.armL.rotation.x = this.cur.armLX;
    if (b.armR) b.armR.rotation.x = this.cur.armRX;
    if (b.legL) b.legL.rotation.x = this.cur.legLX;
    if (b.legR) b.legR.rotation.x = this.cur.legRX;
    if (b.hips) b.hips.position.y = this.cur.hipY;
    // 武器/披风若有对应骨骼也可在此驱动；模型自带则交给 clip
  }

  _applyExpression(snap, chain) {
    if (!this.expressions || !this.expressions.set) return;
    let name = 'normal';
    if (this.hitTimer > 0) name = 'clench';
    else if (chain && chain.busy) name = 'fierce';
    this.expressions.set(name);
  }

  update(snap, chain, dt, speed = 0) {
    if (this.broken) return;
    try {
      this._t += dt;
      // 优先播放资产自带动画；查不到 clip 时退回程序化姿态驱动（保证动作连贯）
      const key = this._stateKeyFor(snap, chain, speed);
      const clipName = this.clipMap[key] ?? null;
      if (clipName && this._playClip(clipName)) {
        this.mixer.update(dt);
      } else {
        this._proceduralPose(snap, chain, dt, speed);
      }
      this._applyExpression(snap, chain);
    } catch (e) {
      console.warn('[HeroAssetAnimator] 更新异常，转程序化兜底：', e && e.message);
      try { this._proceduralPose(snap, chain, dt, speed); } catch { this.broken = true; }
    }
  }
}

/** 用已加载的资产组装玩家根节点（userData.hero = HeroAssetAnimator）。 */
export function createHeroMeshFromAsset(asset) {
  const root = new Group();
  root.name = 'hero';
  // ★SPEC(模块13) 主角可读性：外部模型也要过一遍墨灰阶。
  //   否则"换了真模型 → 可读性又没了"——spec 的验收口径是画面效果，不是哪套代码在画。
  if (HERO.TONE_APPLY_TO_ASSET) applyInkToneToScene(asset.scene);
  // ★SPEC(模块13) 盔缨：模型不带盔缨时补一支到头骨（画面里唯一的朱砂锚点）
  if (HERO.PLUME_FOR_ASSET && asset.bones) {
    const headBone = asset.bones.head || asset.bones.chest || asset.bones.spine;
    if (headBone && !hasPlumeMesh(headBone)) {
      const kit = createHeroPlume();
      kit.group.position.set(0, 0.12, -0.06);
      headBone.add(kit.group);
      asset.plume = kit;
    }
  }
  // ★SPEC(模块13) 背光 rim light（强度 0.6）
  attachHeroRimLight(root);
  // ★SPEC 武器挂点：太刀挂在 rightHand（weapon 骨骼）。
  // 外部模型常常**不自带武器**（本项目的合成占位 model.glb 就是纯身体节点），
  // 那一刀就没有，"打击盒跟随武器挥砍轨迹"也无从谈起 —— 所以检测不到武器网格时补挂引擎自带的太刀。
  // 自带武器的模型（节点名含 katana/sword/blade/weapon/刀）不会被重复挂。
  const weaponBone = asset.bones && asset.bones.weapon;
  if (weaponBone && !hasWeaponMesh(weaponBone)) {
    const kat = createKatana();
    weaponBone.add(kat.group);
    asset.katana = kat;
  }
  const anim = new HeroAssetAnimator(asset);
  const lod = asset.lod || { lod1: null, lod2: null };
  const hasLod = HERO.LOD.ENABLED && (lod.lod1 || lod.lod2);
  if (hasLod) {
    // 构建 THREE.LOD：LOD0 完整（带骨骼动画），LOD1/LOD2 为离线减面的静态副资产
    const lodObj = new LOD();
    lodObj.addLevel(asset.scene, 0);
    if (lod.lod1) lodObj.addLevel(lod.lod1, HERO.LOD.NEAR);
    if (lod.lod2) lodObj.addLevel(lod.lod2, HERO.LOD.FAR);
    root.add(lodObj);
    root.userData.lod = lodObj;
  } else {
    root.add(asset.scene);
    // 模型三角面超阈值却没生成 LOD → 提示走离线减面（不影响运行，只是远处更耗）
    const tris = countTris(asset.scene);
    if (HERO.LOD.ENABLED && tris > HERO.LOD.DECIMATE_THRESHOLD) {
      console.warn(`[heroAsset] 模型三角面 ${Math.round(tris)} > ${HERO.LOD.DECIMATE_THRESHOLD}，建议运行 node tools/make-hero-lod.mjs 生成 LOD1/LOD2 以降载`);
    }
  }
  root.userData.hero = anim;
  root.userData.asset = asset;
  return root;
}

/**
 * 判断某个节点子树里是否已经有武器网格（避免给自带武器的模型重复挂一把刀）。
 * @param {object} node
 * @returns {boolean}
 */
function hasWeaponMesh(node) {
  let found = false;
  node.traverse?.((o) => {
    if (found || !o.isMesh) return;
    if (/katana|sword|blade|weapon|saber|刀|太刀/i.test(o.name || '')) found = true;
  });
  return found;
}

function hasPlumeMesh(node) {
  let found = false;
  node.traverse?.((o) => {
    if (found || !o.isMesh) return;
    if (/plume|crest|ornament|缨/i.test(o.name || '')) found = true;
  });
  return found;
}

/**
 * 给外部模型的材质过一遍墨灰阶（★SPEC 模块13）。
 * ---------------------------------------------------------------------------
 * ⚠ 只改**颜色与高光参数**，不动贴图、不动几何、不改材质类型：
 *   · 有贴图的：color 是乘性的，按 TONE_MIX 往墨灰 lerp → 保留贴图细节，整体压成灰调；
 *   · 没贴图的纯色材质：直接把 color 拉到墨灰；
 *   · roughness/metalness 统一到 spec 值（金属高光增强）。
 *   朱砂盔缨（emissive 明显的）跳过，别把唯一的高饱和锚点也染灰了。
 */
export function applyInkToneToScene(scene) {
  if (!scene) return 0;
  const ink = new Color(HERO.BODY_ALBEDO);
  let n = 0;
  scene.traverse?.((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || m.userData?.inkToned) continue;
      // 自发光很强的部件 = 朱砂类强调件，不染。
      // ⚠⚠ 判据必须同时看"发光的颜色本身"，**不能只看 m.emissive 是否存在**：
      //     three 的 `material.emissive` 默认就是 Color(0x000000)（不是 null），
      //     且 `emissiveIntensity` 默认值是 1.0 —— 所以"emissive 存在 && intensity ≥ 0.9"
      //     对**每一个** MeshStandardMaterial 都成立，会把整棵模型全部跳过（实测：染色数 = 0）。
      //     这里用 getHex() 判断"真的在发光"：黑自发光的默认材质必须照常染。
      const glowing = m.emissive && m.emissiveIntensity >= 0.9 && m.emissive.getHex() !== 0x000000;
      if (glowing) { m.userData = m.userData || {}; m.userData.inkToned = true; m.userData.inkToneSkipped = true; continue; }
      if (m.color) m.color.lerp(ink, HERO.TONE_MIX);
      if (m.roughness !== undefined) m.roughness = HERO.BODY_ROUGHNESS;
      if (m.metalness !== undefined) m.metalness = HERO.BODY_METALNESS;
      m.userData = m.userData || {};
      m.userData.inkToned = true;
      n++;
    }
  });
  return n;
}

/**
 * 加载期水墨剪影占位（墨色半透人形 + 朱砂红发绳点缀）。加载完成/失败即移除。
 */
export function createSilhouette() {
  const g = new Group();
  g.name = 'hero-silhouette';
  const ink = new MeshBasicMaterial({ color: HERO.OUTLINE_COLOR, transparent: true, opacity: 0.5 });
  const body = new Mesh(new CapsuleGeometry(0.3, 1.0, 4, 8), ink);
  body.position.y = 1.0;
  const head = new Mesh(new SphereGeometry(0.22, 12, 12), ink);
  head.position.y = 1.82;
  const accent = new MeshBasicMaterial({ color: HERO.OUTLINE_COLOR_CINNABAR });
  const knot = new Mesh(new SphereGeometry(0.06, 8, 8), accent);
  knot.position.set(0, 1.98, -0.1);
  g.add(body, head, knot);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
  return g;
}
