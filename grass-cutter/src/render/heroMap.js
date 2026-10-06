/**
 * 模块 12 —— 外部角色资产的「骨骼 / 动画 / 表情」映射（纯逻辑，零 Three.js 依赖）。
 * ---------------------------------------------------------------------------
 * 为什么独立成文件：映射规则是纯函数，不碰 WebGL，可在 node --test 里用 mock 验证；
 * 真正的 THREE.Group / AnimationMixer 放在 heroAsset.js（依赖 THREE），两者解耦。
 *
 * 引擎骨骼名（与 characters.js 的 HeroAnimator 完全对齐，模块 3 打击盒/判定随之不动）：
 *   hips / spine / chest / head / armL / armR / legL / legR / weapon
 * 其中 weapon 是右手下的刀柄挂点，命中盒随它自动贴合武器轨迹。
 */
import { HERO } from '../core/config.js';

// 引擎骨骼名清单
export const ENGINE_BONES = ['hips', 'spine', 'chest', 'head', 'armL', 'armR', 'legL', 'legR', 'weapon'];

// VRM humanoid 标准骨骼 → 引擎名（一个 VRM 骨骼可能覆盖多个引擎层级，取语义兜底）
const VRM_BONE_MAP = {
  hips: 'hips',
  spine: 'spine',
  chest: 'chest',
  upperChest: 'chest',
  neck: 'head',
  head: 'head',
  leftShoulder: 'armL',
  leftUpperArm: 'armL',
  leftLowerArm: 'armL',
  leftHand: 'armL',
  rightShoulder: 'armR',
  rightUpperArm: 'armR',
  rightLowerArm: 'armR',
  rightHand: 'armR',
  leftUpperLeg: 'legL',
  leftLowerLeg: 'legL',
  leftFoot: 'legL',
  rightUpperLeg: 'legR',
  rightLowerLeg: 'legR',
  rightFoot: 'legR',
};

/**
 * 用 VRM humanoid 语义检索骨骼。映射失败时用 getNormalizedBoneNode 按语义兜底。
 * @param {object} humanoid VRM.humanoid（含 getNormalizedBoneNode / getBoneNode）
 * @returns {Record<string, object>} 引擎名 → 骨骼节点
 */
export function mapBonesByHumanoid(humanoid) {
  const out = {};
  const get = (name) => {
    try {
      return humanoid.getNormalizedBoneNode?.(name) || humanoid.getBoneNode?.(name) || null;
    } catch {
      return null;
    }
  };
  for (const [vrmName, eng] of Object.entries(VRM_BONE_MAP)) {
    const node = get(vrmName);
    if (node) out[eng] = node;
  }
  // weapon 挂点默认落在右手（rightHand）；若模型自带 weapon 节点则优先
  if (!out.weapon) out.weapon = out.armR || null;
  return out;
}

/**
 * 对普通 glTF（无 humanoid 语义）按节点名启发式匹配骨骼。
 * @param {object} root gltf.scene（需有 traverse 方法）
 * @returns {Record<string, object>}
 */
export function mapGltfBones(root) {
  const out = {};
  const find = (re) => {
    let found = null;
    root.traverse?.((o) => {
      // 匹配任意 Object3D：真实 glTF 里骨骼节点可能是 Bone（蒙皮骨架）、Group（无蒙皮分离节点），
      // 也可能是 Mesh（像本项目的合成模型：每个身体部件是"带 mesh 的变换节点"，GLTFLoader 直接
      // 生成 THREE.Mesh，isMesh=true）。按名匹配时一律纳入，避免漏掉可驱动的骨骼节点。
      if (!found && re.test(o.name) && (o.isBone || o.isObject3D)) found = o;
    });
    return found;
  };
  const set = (eng, node) => { if (node) out[eng] = node; };
  set('hips', find(/hips|pelvis|root/i));
  set('spine', find(/spine/i));
  set('chest', find(/chest|upperChest|torso/i) || out.spine);
  set('head', find(/head/i) || find(/neck/i));
  set('armL', find(/leftUpperArm|leftArm|arm[_Ll]|upperarm_l/i));
  set('armR', find(/rightUpperArm|rightArm|arm[_Rr]|upperarm_r/i));
  set('legL', find(/leftUpperLeg|leftLeg|leg[_Ll]|upperleg_l/i));
  set('legR', find(/rightUpperLeg|rightLeg|leg[_Rr]|upperleg_r/i));
  // weapon 挂点优先匹配右手/刀柄节点；缺失时兜底到右手上臂
  set('weapon', find(/rightHand|hand[_Rr]|wrist[_Rr]|weapon|katana|sword|grip|tool/i));
  if (!out.weapon) out.weapon = out.armR || null;
  return out;
}

/**
 * 构建表情控制器。优先 VRM expressionManager，其次通用 morphTargetDictionary。
 * @param {object} source VRM 实例 / 含 scene 的 glTF 根
 * @returns {{ set: (name: 'normal'|'fierce'|'clench') => void }}
 */
export function mapExpressions(source) {
  const map = HERO.EXPRESSION;
  const vrm = source?.expressionManager || source?.expression;
  if (vrm && typeof vrm.setValue === 'function') {
    return {
      set(name) {
        const vn = map[name];
        if (!vn) return;
        // 先把同组其它表情清零，再置位（避免叠加）
        for (const k of Object.values(map)) {
          if (k !== vn) { try { vrm.setValue(k, 0); } catch { /* ignore */ } }
        }
        try { vrm.setValue(vn, 1); } catch { /* ignore */ }
      },
    };
  }
  // 通用 morph 兜底（取出第一个带 morphTargetDictionary 的 mesh）
  let mesh = null;
  source?.scene?.traverse?.((o) => { if (!mesh && o.morphTargetDictionary) mesh = o; });
  mesh = mesh || (source?.morphTargetDictionary ? source : null);
  if (mesh && mesh.morphTargetDictionary) {
    const dict = mesh.morphTargetDictionary;
    return {
      set(name) {
        const vn = map[name];
        const idx = vn != null ? dict[vn] : undefined;
        if (idx == null || !mesh.morphTargetInfluences) return;
        for (let i = 0; i < mesh.morphTargetInfluences.length; i++) mesh.morphTargetInfluences[i] = 0;
        mesh.morphTargetInfluences[idx] = 1;
      },
    };
  }
  return { set() { /* 无表情能力：静默 */ } };
}

/**
 * 计算引擎目标姿态（纯函数，被程序化武将与资产武将共用，保证两种主角手感一致）。
 * @param {object} snap 玩家快照（state / grounded）
 * @param {object} chain 连段状态（busy / progress / phase）
 * @param {number} t 累计时间（秒）
 * @param {number} speed 当前速度
 */
export function computeHeroTarget(snap, chain, t, speed = 0) {
  const crouch = snap.state === 'dodge' ? 0.22 : snap.grounded ? 0 : 0.05;
  const cur = {
    spineX: 0, spineY: 0, headX: 0,
    armLX: 0.2, armRX: -0.2,
    legLX: 0, legRX: 0,
    hipY: 0.95 - crouch, capeX: 0.2, glow: 0.15,
  };
  const moving = speed > 0.4 && snap.grounded;
  if (moving) {
    const ph = t * 9;
    const sw = Math.sin(ph) * 0.5;
    cur.legLX = sw; cur.legRX = -sw;
    cur.armLX = 0.2 - sw * 0.5; cur.armRX = -0.2 + sw * 0.5;
    cur.spineX = 0.08; cur.capeX = 0.2 + Math.abs(Math.cos(ph)) * 0.25;
  } else {
    cur.capeX = 0.2 + Math.sin(t * 1.5) * 0.05;
  }
  if (chain && chain.busy) {
    const p = chain.progress ?? 0.5;
    const sw = p < 0.45 ? -p / 0.45 : 1 - (p - 0.45) / 0.55;
    cur.spineY = sw * -0.6;
    cur.armRX = -0.2 - sw * 1.5;
    cur.armLX = 0.2 + sw * 0.4;
    cur.spineX = -0.1 * sw;
    cur.legRX = sw * -0.2;
  } else if (chain && chain.phase === 'charging') {
    cur.spineY = 0.25; cur.armRX = -1.0; cur.armLX = 0.6; cur.glow = 0.9;
    cur.spineX = 0.05;
  }
  if (snap.state === 'air') { cur.spineX = -0.15; cur.legLX = 0.3; cur.legRX = -0.2; }
  if (snap.state === 'dodge') { cur.legLX = 0.6; cur.legRX = 0.6; cur.spineX = 0.3; }
  return cur;
}

// ─────────────────────────────────────────────────────────────── 模块 12：动画名 → 引擎状态映射
/**
 * 每个引擎状态的同义词（按优先级排序，越靠前越具体）。真实模型导出的 clip 命名千奇百怪，
 * resolveClipMap 用它做模糊匹配，省去逐个手调。
 * ⚠ 关键词顺序很关键：'run' 的 'walk' 必须排在 'run'/'jog' 之后，否则 idle 会被 'walk' 抢走；
 *   'ultimate' 只给 musou（C5 用 combo5/finisher5 等更具体的词，避免两个状态抢同一 clip）。
 */
export const ANIM_SYNONYMS = {
  idle: ['idle', 'stand', 'wait', 'breath', 'rest', 'neutral', 'pose', 'stay'],
  run: ['run', 'jog', 'sprint', 'locomotion', 'move', 'walk'],
  dash: ['dash', 'dodge', 'evade', 'roll', 'step', 'sidestep', 'flash'],
  jump: ['jump', 'leap', 'hop', 'air'],
  N1: ['n1', 'attack1', 'slash1', 'combo1', 'atk01', 'melee1', 'swing1', 'light1', 'a1', 'attack_light'],
  N2: ['n2', 'attack2', 'slash2', 'combo2', 'atk02', 'melee2', 'swing2', 'light2', 'a2', 'attack_02'],
  C3: ['c3', 'spin', 'whirl', 'cyclone', 'combo3', 'finisher3', 'skill3', 'combo03'],
  C4: ['c4', 'pierce', 'thrust', 'combo4', 'finisher4', 'skill4', 'combo04'],
  C5: ['c5', 'combo5', 'finisher5', 'skill5', 'combo05', 'bigfinish'],
  heavy: ['heavy', 'strong', 'hard', 'power', 'heavy1', 'atk_h', 'attack_heavy'],
  charge: ['charge', 'charging', 'windup', 'powerup', 'hold', 'build'],
  musou: ['musou', 'ult', 'ultimate', 'rampage', 'madness', 'special', 'awaken'],
  art1: ['art1', 'skill1', 'art_1', 'ability1', 'tech1'],
  art2: ['art2', 'skill2', 'art_2', 'ability2', 'tech2'],
  hitFront: ['hit_front', 'hitfront', 'hit_f', 'damage_front', 'hurt_front', 'hit1'],
  hitBack: ['hit_back', 'hitback', 'hit_b', 'damage_back', 'hurt_back', 'hit2'],
  hitLeft: ['hit_left', 'hitleft', 'hit_l', 'damage_left', 'hurt_left', 'hit3'],
  hitRight: ['hit_right', 'hitright', 'hit_r', 'damage_right', 'hurt_right', 'hit4'],
  death: ['death', 'die', 'dead', 'down', 'knockdown', 'ko', 'faint'],
};

/**
 * 把"资产自带 clip 名列表"映射到引擎状态。优先级：
 *   1) 精确匹配 HERO.ANIM[state] 里配置的名字（作者手动指定的最高优先级）；
 *   2) 按 ANIM_SYNONYMS 的优先级做子串模糊匹配（第一个命中即采用）；
 *   3) 都没有 → null（调用方退回程序化姿态驱动）。
 * 纯函数，可在 node --test 里用 mock 验证。
 * @param {string[]} clipNames 资产里 AnimationClip 的名字数组
 * @param {object} animConfig 默认 HERO.ANIM（状态 → 期望 clip 名）
 * @returns {Record<string,string|null>}
 */
export function resolveClipMap(clipNames, animConfig = HERO.ANIM) {
  const names = (clipNames || []).map((n) => String(n));
  const lower = names.map((n) => n.toLowerCase());
  const out = {};
  for (const state of Object.keys(ANIM_SYNONYMS)) {
    let pick = null;
    const cfg = animConfig[state];
    if (cfg != null) {
      const ci = lower.indexOf(String(cfg).toLowerCase());
      if (ci >= 0) pick = names[ci];
    }
    if (!pick) {
      for (const kw of ANIM_SYNONYMS[state]) {
        const idx = lower.findIndex((n) => n.includes(kw));
        if (idx >= 0) { pick = names[idx]; break; }
      }
    }
    out[state] = pick;
  }
  return out;
}

/**
 * 由主资产路径推导出 LOD 副资产路径（离线减面产物）。
 * 例：'assets/hero/model.glb' → { lod1:'assets/hero/model.lod1.glb', lod2:'assets/hero/model.lod2.glb' }
 * 纯函数（字符串处理），可在 node --test 里验证。
 * @param {string} path 主资产路径
 * @returns {{lod1:string|null, lod2:string|null}}
 */
export function deriveLodPaths(path) {
  if (!path) return { lod1: null, lod2: null };
  const base = String(path).replace(/\.[^.]+$/, '');
  return { lod1: `${base}.lod1.glb`, lod2: `${base}.lod2.glb` };
}

/**
 * 统计一个 Object3D 子树的总三角面数（用于 LOD 阈值判断与离线减面提示）。
 * 纯遍历，可在 node --test 里用 mock 验证（mock 只需 traverse + geometry.index/attributes）。
 * @param {object} root 含 traverse 方法的 Object3D
 * @returns {number}
 */
export function countTris(root) {
  let tris = 0;
  root?.traverse?.((o) => {
    const g = o.geometry;
    if (!g) return;
    if (g.index && g.index.count) tris += g.index.count / 3;
    else if (g.attributes && g.attributes.position) tris += g.attributes.position.count / 3;
  });
  return tris;
}

/**
 * 解析当前帧的墨色描边风格（纯逻辑，可单测）。
 * ★SPEC：常态墨色 2px；无双乱舞与武艺期间转朱砂红 3px。
 *
 * 为什么单独抽出来：描边的"什么时候变红"是**玩法状态 → 表现参数**的映射，
 * 属于规则而不是渲染细节；抽成纯函数才能在 node 里断言"无双中一定是 3px 朱砂"，
 * 而不必起浏览器看画面。
 *
 * @param {{musouActive?:boolean, artFlash?:boolean}} s
 * @param {object} [cfg] 默认取 HERO
 * @returns {{px:number, color:number, cinnabar:boolean}}
 */
export function resolveOutlineStyle(s = {}, cfg = HERO) {
  const cinnabar = !!(s.musouActive || s.artFlash);
  return {
    cinnabar,
    px: cinnabar ? cfg.OUTLINE_WIDTH_BOSS : cfg.OUTLINE_WIDTH,
    color: cinnabar ? cfg.OUTLINE_COLOR_CINNABAR : cfg.OUTLINE_COLOR,
  };
}
