/**
 * 3D 场景搭建
 * 垂直切片：程序化几何 + 程序化贴图（ADR-004），无外部资源、无构建步骤。
 *
 * 场景结构（升级后）：
 *   场地 28×24（ROOM）—— 便利店（STORE，保留全部原有交互锚点与坐标）
 *   + 广场 / 电玩区 / 休息区（南侧）+ 后巷（北侧）
 *
 * 碰撞体与渲染网格分离 —— 将来换 CC0 资产时逻辑层零改动。
 */
import * as THREE from 'three';
import {
  SKU_BY_ID, ROOM, STORE, ZONES, PROPS, PROP_SIZE,
  EYE_HEIGHT, FOV, SLOT_COUNT, SLOT_CAP, INTERACT_BOX, POS, SHELF_ROWS, GARBAGE,
  FACILITIES, POND, SNACK_STALL, EXPANSIONS, EXPANSION_BY_ID, DEVICE_UPGRADE,
  PRODUCT_VARIANTS, productVariant, CLAW_CABINET, DELIVERY,
} from './config.mjs';
import { createMaterials, applyBoxUV, applyFaceUVAll, drawPoster, productTexture } from './textures.mjs';
import { buildColliders } from './layout.mjs';
import { hitBox, facilityCost } from './facilities.mjs';
import { createCharacter } from './character.mjs';
import { NEON } from './art.mjs';
import { fmtYuan } from './fmt.mjs';
import { state } from './state.mjs';

let MATS = null;
/** 钓鱼池塘逐帧动画引用（水面顶点起伏 + 鱼浮动），由 buildFacility 赋值 */
let pondAnim = null;
/** 娃娃机玻璃柜引用（P0-4）：fac.id → { dolls, hint }，由 setClawCabinet 统一控制显隐 */
const clawCabinets = new Map();

const W = ROOM.width;     // x: -14..14
const D = ROOM.depth;     // z: -12..12
const SH = STORE.height;

/* 关键位置（数值来自 config.POS，保持单一真源） */
export const DOOR_POS = new THREE.Vector3(POS.door.x, 0, POS.door.z);
export const COUNTER_POS = new THREE.Vector3(POS.counter.x, 0, POS.counter.z);
export const CRATE_POS = new THREE.Vector3(POS.crate.x, 0, POS.crate.z);
export const SPAWN_POS = new THREE.Vector3(POS.spawn.x, EYE_HEIGHT, POS.spawn.z);

export function slotWorldPos(i) {
  const row = SHELF_ROWS[Math.floor(i / 4)] ?? SHELF_ROWS[0];
  const col = i % 4;
  return new THREE.Vector3(row.x, 0, row.zs[col] ?? 0);
}

/* ---------- 几何工具 ---------- */

/** 贴图立方体：按实际尺寸缩放 UV，全场 texel 密度一致、不拉伸 */
function box(w, h, d, kind, texScale = 2) {
  const geo = new THREE.BoxGeometry(w, h, d);
  applyBoxUV(geo, w, h, d, texScale);
  return new THREE.Mesh(geo, MATS[kind]);
}

/** 纯色立方体（商品小盒等不需要贴图的场合） */
function boxColor(w, h, d, color, opts = {}) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.03, ...opts }),
  );
}

/**
 * 牛皮纸货箱：每面各铺满一次贴图。
 * 不能走 box()（applyBoxUV 按尺寸平铺）—— 1.1×0.9×1.1 的箱体会把图案重复 1.1/0.9 次，
 * 接缝把图案切成周期性子块，正面就被读成"彩色棋盘格"（用户报的就是这条）。
 */
function boxCrate(w, h, d) {
  const m = new THREE.Mesh(applyFaceUVAll(new THREE.BoxGeometry(w, h, d)), MATS.goodsCrate);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/* ---------- 货架商品模型（P0-1：可区分的商品外观） ----------
 * 变体（形状 + 主色 + 辅色）来自 config.PRODUCT_VARIANTS，形状构造器在这里。
 * 约定：**原点在模型的底部中心**，SIZE.h 是整体高度，摆放时按"层板顶面 + h/2"落位。
 * 全部低多边形、1~3 个零件，但轮廓必须一眼分得开：
 * 高瘦易拉罐 / 带盖塑料瓶 / 带吸管杯 / 立式袋装 / 立盒 / 小方盒 / 棒棒糖 / 杯面 / 便当盒 / 热狗 / 烤肠。
 * 材质与几何都按 key 缓存复用（同色同形只有一份）。
 */
const _prodMatCache = new Map();
function prodMat(hex, { clear = false, rough = 0.62, metal = 0.05 } = {}) {
  const key = `${hex}|${clear ? 1 : 0}|${rough}|${metal}`;
  let m = _prodMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal });
    if (clear) { m.transparent = true; m.opacity = 0.5; }
    _prodMatCache.set(key, m);
  }
  return m;
}
/**
 * 带包装贴图的商品材质（2026-10-06 块1）。
 *
 * 与 prodMat 的区别只在多一个 map。之所以单独开一个函数而不是给 prodMat 加参数：
 * prodMat 被形状构造器按"颜色/透明度/粗糙度"缓存复用（同色不同件共享一张材质），
 * 而贴图是**按变体**（shape+color+accent）唯一的 —— 混进同一个 cache key 会让
 * "同色不同贴图"的两个变体互相串图（改一个另一个跟着变）。
 * 所以这里按变体 key 单独缓存一层，取不到贴图时原样回落到 prodMat（纯色）。
 */
const _prodTexMatCache = new Map();
function prodMatTx(variant, opts = {}) {
  const tex = productTexture(variant);
  if (!tex) return prodMat(variant.color, opts);
  const key = `${variant.shape}|${variant.color}|${variant.accent}|${opts.clear ? 1 : 0}|${opts.rough ?? ''}`;
  let m = _prodTexMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      // 贴图已含主色，这里 color 必须留白 —— 否则颜色被乘两遍（贴图×color）整体发暗
      color: 0xFFFFFF,
      map: tex,
      roughness: opts.rough ?? 0.62,
      metalness: opts.metal ?? 0.05,
    });
    if (opts.clear) { m.transparent = true; m.opacity = 0.5; }
    _prodTexMatCache.set(key, m);
  }
  return m;
}
const _prodGeoCache = new Map();
function prodGeo(key, make) {
  let geo = _prodGeoCache.get(key);
  if (!geo) { geo = make(); _prodGeoCache.set(key, geo); }
  return geo;
}
function addPart(group, geo, mat, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  group.add(mesh);
  return mesh;
}

const PRODUCT_SHAPE = {
  /** 易拉罐（高瘦）：罐身 + 顶盖圈 + 底圈 */
  can: {
    h: 0.166,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('can.body', () => new THREE.CylinderGeometry(0.030, 0.030, 0.150, 10)), prodMatTx(v), 0, 0.076);
      addPart(g, prodGeo('can.rim', () => new THREE.CylinderGeometry(0.0312, 0.0312, 0.010, 10)), prodMat(v.accent, { metal: 0.45, rough: 0.35 }), 0, 0.156);
      addPart(g, prodGeo('can.foot', () => new THREE.CylinderGeometry(0.0312, 0.0312, 0.008, 10)), prodMat(v.accent, { metal: 0.45, rough: 0.35 }), 0, 0.005);
      return g;
    },
  },
  /** 塑料瓶（带盖）：瓶身 + 肩锥 + 螺纹盖 */
  bottle: {
    h: 0.180,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('bt.body', () => new THREE.CylinderGeometry(0.0295, 0.031, 0.110, 10)), prodMatTx(v, { clear: v.clear }), 0, 0.056);
      addPart(g, prodGeo('bt.shoulder', () => new THREE.CylinderGeometry(0.014, 0.0295, 0.028, 10)), prodMatTx(v, { clear: v.clear }), 0, 0.125);
      addPart(g, prodGeo('bt.cap', () => new THREE.CylinderGeometry(0.0155, 0.0155, 0.020, 8)), prodMat(v.accent), 0, 0.149);
      return g;
    },
  },
  /** 杯装（奶茶）：锥形杯 + 圆盖 + 斜插吸管 */
  cup: {
    h: 0.196,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('cup.body', () => new THREE.CylinderGeometry(0.034, 0.026, 0.130, 12)), prodMatTx(v), 0, 0.066);
      addPart(g, prodGeo('cup.lid', () => new THREE.CylinderGeometry(0.0365, 0.0365, 0.014, 12)), prodMat(v.accent), 0, 0.138);
      addPart(g, prodGeo('cup.straw', () => new THREE.CylinderGeometry(0.005, 0.005, 0.062, 6)), prodMat(v.accent), 0.013, 0.168);
      return g;
    },
  },
  /** 袋装（薯片 / 辣条 / 糖果）：立式扁袋 + 顶部封口压边 */
  bag: {
    h: 0.170,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('bag.body', () => new THREE.BoxGeometry(0.082, 0.148, 0.042)), prodMatTx(v, { rough: 0.78 }), 0, 0.074);
      addPart(g, prodGeo('bag.crimp', () => new THREE.BoxGeometry(0.090, 0.014, 0.046)), prodMat(v.accent, { rough: 0.8 }), 0, 0.163);
      return g;
    },
  },
  /** 盒装（饼干 / 巧克力）：立盒 + 一圈标签色带 */
  box: {
    h: 0.120,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('box.body', () => new THREE.BoxGeometry(0.082, 0.112, 0.052)), prodMatTx(v, { rough: 0.8 }), 0, 0.056);
      addPart(g, prodGeo('box.band', () => new THREE.BoxGeometry(0.085, 0.030, 0.055)), prodMat(v.accent, { rough: 0.8 }), 0, 0.044);
      return g;
    },
  },
  /** 小方盒（口香糖）：矮扁盒 + 浅色盒盖 */
  smallbox: {
    h: 0.054,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('sb.body', () => new THREE.BoxGeometry(0.070, 0.046, 0.044)), prodMatTx(v, { rough: 0.7 }), 0, 0.024);
      addPart(g, prodGeo('sb.lid', () => new THREE.BoxGeometry(0.072, 0.008, 0.046)), prodMat(v.accent, { rough: 0.5 }), 0, 0.049);
      return g;
    },
  },
  /** 棒棒糖：细棍 + 糖球 */
  lolli: {
    h: 0.164,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('lo.stick', () => new THREE.CylinderGeometry(0.0045, 0.0045, 0.106, 6)), prodMat(v.accent, { rough: 0.4 }), 0, 0.053);
      addPart(g, prodGeo('lo.head', () => new THREE.SphereGeometry(0.029, 8, 6)), prodMatTx(v, { rough: 0.35 }), 0, 0.134);
      return g;
    },
  },
  /** 泡面杯：上粗下细的杯身 + 封口盖 */
  noodlecup: {
    h: 0.124,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('nc.body', () => new THREE.CylinderGeometry(0.046, 0.034, 0.108, 12)), prodMatTx(v, { rough: 0.8 }), 0, 0.055);
      addPart(g, prodGeo('nc.lid', () => new THREE.CylinderGeometry(0.048, 0.048, 0.012, 12)), prodMat(v.accent), 0, 0.115);
      return g;
    },
  },
  /** 便当盒：扁平盒 + 盖 + 横向扎带 */
  bentobox: {
    h: 0.064,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('bb.body', () => new THREE.BoxGeometry(0.132, 0.046, 0.098)), prodMatTx(v, { rough: 0.75 }), 0, 0.024);
      addPart(g, prodGeo('bb.lid', () => new THREE.BoxGeometry(0.135, 0.012, 0.100)), prodMat(v.accent), 0, 0.053);
      addPart(g, prodGeo('bb.band', () => new THREE.BoxGeometry(0.024, 0.064, 0.102)), prodMat(v.accent, { rough: 0.6 }), 0, 0.031);
      return g;
    },
  },
  /** 热狗：面包夹 + 中间一根肠 */
  hotdog: {
    h: 0.062,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('hd.bun', () => new THREE.BoxGeometry(0.122, 0.038, 0.056)), prodMatTx(v, { rough: 0.86 }), 0, 0.020);
      const sausage = addPart(g, prodGeo('hd.sausage', () => new THREE.CapsuleGeometry(0.017, 0.088, 3, 8)), prodMat(v.accent, { rough: 0.6 }), 0, 0.045);
      sausage.rotation.z = Math.PI / 2;
      return g;
    },
  },
  /** 烤肠：竹签 + 一串肠 */
  sausage: {
    h: 0.142,
    build(v) {
      const g = new THREE.Group();
      addPart(g, prodGeo('sg.stick', () => new THREE.CylinderGeometry(0.004, 0.004, 0.140, 6)), prodMat(v.accent, { rough: 0.5 }), 0, 0.071);
      addPart(g, prodGeo('sg.body', () => new THREE.CapsuleGeometry(0.018, 0.086, 3, 8)), prodMatTx(v, { rough: 0.7 }), 0, 0.071);
      return g;
    },
  },
  /* ---- 2026-10-06 块1：三个新 SKU 的造型 ----
   * 轮廓刻意与既有形状全不重叠（见 PRODUCT_VARIANTS 里的说明）。 */
  /** 电池四联卡：立式卡纸 + 挂孔凸起 + 顶部电池露出 */
  batterycard: {
    h: 0.158,
    build(v) {
      const g = new THREE.Group();
      // 卡纸主体（薄板，正反两面贴图 → 电池与挂孔图案都看得见）
      addPart(g, prodGeo('bc.card', () => new THREE.BoxGeometry(0.096, 0.150, 0.014)), prodMatTx(v, { rough: 0.72 }), 0, 0.078);
      // 挂孔凸台（真实电池卡都有，打破"纯平板"）
      addPart(g, prodGeo('bc.hole', () => new THREE.CylinderGeometry(0.010, 0.010, 0.020, 8)), prodMat(v.accent, { rough: 0.6 }), 0, 0.163);
      // 顶部露出的电池头（提示"里面装着电池"）
      addPart(g, prodGeo('bc.cell', () => new THREE.CylinderGeometry(0.013, 0.013, 0.016, 8)), prodMat(v.accent, { metal: 0.4, rough: 0.35 }), 0, 0.160, 0.014);
      return g;
    },
  },
  /** 杂志薄本：立着薄封面 + 侧页边 + 卷起一角 */
  magazine: {
    h: 0.172,
    build(v) {
      const g = new THREE.Group();
      // 封面：applyFaceUVAll 写在几何工厂**内部**（只对首次 new 出来的几何生效）。
      // 若挪到 addPart 之后去改 cover.geometry，改的是 prodGeo 缓存里那份共享对象 ——
      // 所有杂志实例会被反复重写 UV，而其它形状若也用同名几何就会被连带污染。
      addPart(g, prodGeo('mg.cover', () => applyFaceUVAll(new THREE.BoxGeometry(0.108, 0.168, 0.010))), prodMatTx(v, { rough: 0.46 }), 0, 0.086);
      // 内页边（米白，露出一侧纸口）
      addPart(g, prodGeo('mg.pages', () => new THREE.BoxGeometry(0.100, 0.160, 0.012)), prodMat(0xEDE6D8, { rough: 0.85 }), 0.004, 0.084, 0.002);
      return g;
    },
  },
};

/** 按变体造一个商品模型；形状名不认识时回落到易拉罐（保证"有货就一定看得见东西"） */
function buildProduct(variant) {
  const shape = PRODUCT_SHAPE[variant?.shape] ?? PRODUCT_SHAPE.can;
  return { group: shape.build(variant), h: shape.h };
}

/** 低多边形小鱼（装饰，钓鱼池塘用；身体 + 尾鳍，不含碰撞） */
function makeFish() {
  const g = new THREE.Group();
  const cols = [0xE8743B, 0xE8D8C8, 0xD85A5A, 0x6FCF97];
  const col = cols[Math.floor(Math.random() * cols.length)];
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 8, 6),
    new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.1, flatShading: true }),
  );
  body.scale.set(1.7, 0.9, 0.8);
  g.add(body);
  const tail = new THREE.Mesh(
    new THREE.ConeGeometry(0.1, 0.18, 4),
    new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, flatShading: true }),
  );
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -0.22;
  g.add(tail);
  return g;
}

/** 钓竿（装饰，斜靠在木栈道上） */
function makeRod() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.02, 1.3, 6),
    new THREE.MeshStandardMaterial({ color: 0x2A2E36, roughness: 0.5, metalness: 0.4 }),
  );
  shaft.position.y = 0.65;
  g.add(shaft);
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8),
    new THREE.MeshStandardMaterial({ color: 0x6B4A2A, roughness: 0.9 }),
  );
  handle.position.y = 0.05;
  g.add(handle);
  return g;
}

function aabb(cx, cz, halfW, halfD) {
  return { min: { x: cx - halfW, z: cz - halfD }, max: { x: cx + halfW, z: cz + halfD } };
}

/**
 * 娃娃机"缺货"提示牌（P0-4）。
 * 画在玻璃柜内的自发光小立牌上：柜子见底时它是唯一的说明，
 * 否则玩家只会觉得"这台机器坏了"。文案取自 config.CLAW_CABINET.restockHint（单一真源）。
 */
function drawClawHint(canvas, tex) {
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, canvas.width, canvas.height);
  /* 这块牌子是"见底"状态下唯一的说明，必须在**很暗的电玩区 + 隔着玻璃**也一眼可见。
   * 第一版是深色底 + 细橙描边，实测能渲染（像素采样得到 481 个 #E8A94E 像素）
   * 但在夜景里读起来像柜子里的一道反光，容易被忽略 —— 所以改成亮底深字的高对比立牌。 */
  c.fillStyle = 'rgba(232,169,78,0.96)';
  c.strokeStyle = '#2A1B08';
  c.lineWidth = 6;
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(5, 5, canvas.width - 10, canvas.height - 10, 18);
  else c.rect(5, 5, canvas.width - 10, canvas.height - 10);
  c.fill();
  c.stroke();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#241705';
  // 字号必须给足宽度：第一版 34px 下 "🧸 缺货 · 待补娃娃" 实测宽约 306px，超了 256px 画布，
  // 最后一个字被裁掉。画布加宽到 320 并把字号收到 30px，两侧各留 ~25px 余量。
  c.font = 'bold 30px system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  c.fillText(CLAW_CABINET.restockHint, canvas.width / 2, 58);
  c.fillStyle = '#4A3111';
  c.font = '24px system-ui, sans-serif';
  c.fillText('上货员会从仓库补货', canvas.width / 2, 114);
  tex.needsUpdate = true;
}

/* ---------- 货架标牌（沿用原实现） ---------- */
function makeLabelSprite() {  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  /* depthTest: true —— 标签要被墙体/柜体遮挡（P2-10 的"遮挡剔除"）。
   * 原来是 false，标签永远画在最上层，隔着货架甚至隔墙都能看到一排信息牌，
   * 这正是"互相重叠 / 全都浮在屏幕上"的根源之一。 */
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.1, 0.55, 1);
  sprite.renderOrder = 10;
  return { sprite, canvas, tex };
}

function drawLabel(canvas, tex, { emoji = '', title = '', sub = '', tint = '#E6E2D6' }) {
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = 'rgba(35,42,56,0.92)';
  c.strokeStyle = '#465468';
  c.lineWidth = 4;
  c.beginPath();
  // roundRect 兼容性兜底（旧内核没有该方法，否则每帧抛错）
  if (typeof c.roundRect === 'function') {
    c.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 16);
  } else {
    c.rect(4, 4, canvas.width - 8, canvas.height - 8);
  }
  c.fill();
  c.stroke();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = tint;
  c.font = '44px system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  c.fillText(emoji, 52, 64);
  c.font = 'bold 34px system-ui, sans-serif';
  c.fillText(title, 150, 50);
  c.font = '26px system-ui, sans-serif';
  c.fillStyle = '#9AA3B2';
  c.fillText(sub, 150, 92);
  tex.needsUpdate = true;
}

/* ---------- 主构建 ---------- */
export function createWorld(canvas) {
  MATS = createMaterials();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141A24);
  scene.fog = new THREE.Fog(0x141A24, 16, 46); // 场地变大，雾距同步放宽

  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 120);
  camera.position.copy(SPAWN_POS);

  // 夜空球（BackSide 内表面；fog:false 否则会被雾染成一片死色）
  const sky = new THREE.Mesh(new THREE.SphereGeometry(52, 24, 16), MATS.sky);
  sky.material.side = THREE.BackSide;
  scene.add(sky);

  // 碰撞体来自 layout.mjs（与连通性测试共用同一份真源）
  const colliders = buildColliders();
  const world = new THREE.Group();
  scene.add(world);

  /* ================= 地面 + 场地外墙（可重建：店铺扩建会改变边界） =================
   * 两者放进独立的 shell 分组，扩建时整组 dispose 重建 ——
   * 比"逐个改位置/缩放"稳：打通门洞时墙段数量会变（1 段 → 2 段 + 门楣），
   * 改缩放很容易漏掉"多出来/少掉"的那一段，表现为墙上有缝或者门被堵死。
   * 注意只 dispose 几何：材质来自共享的 MATS，dispose 了全场都会变黑。 */
  const shell = new THREE.Group();
  world.add(shell);

  const wallT = ROOM.wallT;
  const outerH = 3.6;

  function clearGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.geometry?.dispose?.();
    }
  }

  /**
   * @param b    { minX,maxX,minZ,maxZ }
   * @param opts { east?: {min,max}, north?: {min,max} } —— 该面要开的门洞（z 向 / x 向）
   */
  function buildShell(b, opts = {}) {
    clearGroup(shell);
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;

    const ground = box(w, 0.2, d, 'asphalt', 4);
    ground.position.set(cx, -0.1, cz);
    shell.add(ground);

    const addWall = (ww, dd, x, z) => {
      const m = box(ww, outerH, dd, 'wall', 2);
      m.position.set(x, outerH / 2, z);
      shell.add(m);
    };
    /** 门楣：门洞上方的墙体（2.2m 以上，2D 碰撞里刻意不挡路 —— 见 layout.mjs 注释） */
    const addLintel = (ww, dd, x, z) => {
      const gapH = 2.2;
      const m = box(ww, outerH - gapH, dd, 'wall', 2);
      m.position.set(x, gapH + (outerH - gapH) / 2, z);
      shell.add(m);
    };

    if (opts.north) {
      const g0 = Math.max(b.minX, Math.min(opts.north.min, opts.north.max));
      const g1 = Math.min(b.maxX, Math.max(opts.north.min, opts.north.max));
      if (g0 > b.minX) addWall(g0 - b.minX, wallT, (b.minX + g0) / 2, b.minZ - wallT / 2);
      if (b.maxX > g1) addWall(b.maxX - g1, wallT, (g1 + b.maxX) / 2, b.minZ - wallT / 2);
      addLintel(g1 - g0, wallT, (g0 + g1) / 2, b.minZ - wallT / 2);
    } else {
      addWall(w + wallT * 2, wallT, cx, b.minZ - wallT / 2); // 北
    }
    addWall(w + wallT * 2, wallT, cx, b.maxZ + wallT / 2);   // 南
    addWall(wallT, d, b.minX - wallT / 2, cz);               // 西

    if (opts.east) {
      const g0 = Math.max(b.minZ, Math.min(opts.east.min, opts.east.max));
      const g1 = Math.min(b.maxZ, Math.max(opts.east.min, opts.east.max));
      if (g0 > b.minZ) addWall(wallT, g0 - b.minZ, b.maxX + wallT / 2, (b.minZ + g0) / 2);
      if (b.maxZ > g1) addWall(wallT, b.maxZ - g1, b.maxX + wallT / 2, (g1 + b.maxZ) / 2);
      addLintel(wallT, g1 - g0, b.maxX + wallT / 2, (g0 + g1) / 2);
    } else {
      addWall(wallT, d, b.maxX + wallT / 2, cz);             // 东
    }
  }

  buildShell({ minX: -W / 2, maxX: W / 2, minZ: -D / 2, maxZ: D / 2 });

  // 广场铺装
  const plazaZ = ZONES.plaza;
  const plazaW = plazaZ.maxX - plazaZ.minX;
  const plazaD = plazaZ.maxZ - plazaZ.minZ;
  const plaza = box(plazaW, 0.06, plazaD, 'plaza', 2);
  plaza.position.set((plazaZ.minX + plazaZ.maxX) / 2, 0.02, (plazaZ.minZ + plazaZ.maxZ) / 2);
  world.add(plaza);

  // 便利店地面
  const storeW = STORE.maxX - STORE.minX;
  const storeD = STORE.maxZ - STORE.minZ;
  const floor = box(storeW, 0.08, storeD, 'floor', 2);
  floor.position.set((STORE.minX + STORE.maxX) / 2, 0.035, (STORE.minZ + STORE.maxZ) / 2);
  world.add(floor);

  /* ================= 便利店（保留原有坐标与交互锚点） ================= */
  const st = STORE.wallT;
  const storeCx = (STORE.minX + STORE.maxX) / 2;
  const storeCz = (STORE.minZ + STORE.maxZ) / 2;

  // 北墙
  const nWall = box(storeW + st * 2, SH, st, 'wall', 2);
  nWall.position.set(storeCx, SH / 2, STORE.minZ - st / 2);
  world.add(nWall);

  // 东西墙
  for (const sx of [-1, 1]) {
    const x = sx > 0 ? STORE.maxX + st / 2 : STORE.minX - st / 2;
    const m = box(st, SH, storeD, 'wall', 2);
    m.position.set(x, SH / 2, storeCz);
    world.add(m);
  }

  // 南墙：两段 + 门楣（门洞 x ∈ [-doorHalfW, doorHalfW]，洞高 2.2）
  const dh = STORE.doorHalfW;
  const segW = STORE.maxX - dh; // 5.8
  const segCx = dh + segW / 2;  // 4.1
  for (const sx of [-1, 1]) {
    const m = box(segW, SH, st, 'wall', 2);
    m.position.set(sx * segCx, SH / 2, STORE.maxZ + st / 2);
    world.add(m);
  }
  const lintel = box(dh * 2, SH - 2.2, st, 'wall', 2);
  lintel.position.set(0, 2.2 + (SH - 2.2) / 2, STORE.maxZ + st / 2);
  world.add(lintel);

  // 店招（发光，美术圣经 §6.2：emissive 仅灯/招牌）
  const sign = boxColor(2.8, 0.5, 0.16, 0xE8A94E, {
    emissive: new THREE.Color(0xE8A94E), emissiveIntensity: 0.7,
  });
  sign.position.set(0, 2.75, STORE.maxZ + st + 0.06);
  world.add(sign);

  // 天花板
  const ceil = box(storeW, 0.2, storeD, 'ceiling', 2);
  ceil.position.set(storeCx, SH + 0.1, storeCz);
  world.add(ceil);

  /* ---------- 货架（8 格，结构沿用，材质换贴图） ---------- */
  const slotMeshes = [];
  const slotLabels = [];
  const slotItems = [];

  /* 商品模型（P0-1）：形状与配色都来自 config.PRODUCT_VARIANTS 的变体池，
   * 具体构造在文件顶部的 PRODUCT_SHAPE（模块级，格位与手持共用）。
   * 每个形状带自己的高度 h，摆放时按"层板顶面 + h/2"落位，避免陷进板里或悬空。 */
  /** 层板顶面高度（与下方 shelf 的 y 保持一致） */
  const BOARD_TOP = [0.53, 1.13];

  /** 单格货架构建（开放货架：背板 + 顶盖 + 四柱 + 两层板 + 交互体 + 商品占位 + 标签）。
   * 抽成函数：起始 8 格在下面循环里建；「新货架排」扩张项解锁后 applyShelfRow 对 slots 8,9 复用，
   * 这样两格的几何/交互/标签与起始货架完全一致，不会出现"新货架点不动"的坑。 */
  function buildShelf(i) {
    const p = slotWorldPos(i);
    const g = new THREE.Group();
    g.position.copy(p);

    // 开放货架：四面透空框架（正面 +Z 敞开），层板顶面严格对齐 BOARD_TOP，商品才露得出来
    const backPanel = box(1.5, 1.5, 0.05, 'metal', 1);
    backPanel.position.set(0, 0.75, -0.25);
    g.add(backPanel);
    const topCap = box(1.5, 0.06, 0.55, 'metal', 1);
    topCap.position.set(0, 1.47, 0);
    g.add(topCap);
    for (const px of [-0.72, 0.72]) {
      for (const pz of [-0.24, 0.24]) {
        const post = box(0.06, 1.5, 0.06, 'metal', 1);
        post.position.set(px, 0.75, pz);
        g.add(post);
      }
    }
    for (let s = 0; s < 2; s++) {
      const shelf = box(1.5, 0.06, 0.55, 'wood', 1);
      shelf.position.set(0, 0.5 + s * 0.6, 0.02);
      g.add(shelf);
    }
    // 交互体（不可见，userData 驱动 interaction）
    const hit = box(INTERACT_BOX.slot.w, INTERACT_BOX.slot.h, INTERACT_BOX.slot.d, 'metal', 1);
    hit.material = new THREE.MeshBasicMaterial({ visible: false });
    hit.position.y = INTERACT_BOX.slot.y;
    hit.userData = { interact: 'place', slotIndex: i };
    g.add(hit);
    slotMeshes.push(hit);

    // 商品模型：每格 8 个位置（2 层 × 4 列），按库存显隐；命名 shelf-items-${i} 供探针定位
    const itemsGroup = new THREE.Group();
    itemsGroup.name = `shelf-items-${i}`;
    const itemSlots = [];
    for (let k = 0; k < 8; k++) {
      const holder = new THREE.Group();
      holder.userData.board = Math.floor(k / 4);
      holder.userData.col = k % 4;
      holder.userData.variantKey = '';
      holder.userData.h = 0.1;
      holder.position.set(-0.5 + (k % 4) * 0.33, BOARD_TOP[Math.floor(k / 4)], 0);
      holder.rotation.y = 0;
      holder.visible = false;
      itemsGroup.add(holder);
      itemSlots.push(holder);
    }
    itemsGroup.position.set(0, 0, 0.06);
    g.add(itemsGroup);
    slotItems.push({ group: itemsGroup, slots: itemSlots, kindKey: '' });

    const lab = makeLabelSprite();
    lab.sprite.position.set(0, 2.05, 0);
    lab.index = i;
    lab.baseScale = lab.sprite.scale.x;
    g.add(lab.sprite);
    slotLabels.push(lab);

    world.add(g);
    return g;
  }

  for (let i = 0; i < SLOT_COUNT; i++) buildShelf(i);

  /* ---------- 收银台 ---------- */
  const counterGroup = new THREE.Group();
  counterGroup.position.copy(COUNTER_POS);
  const counterBody = box(1.8, 1.0, 0.8, 'wood', 1);
  counterBody.position.y = 0.5;
  counterGroup.add(counterBody);
  const register = box(0.5, 0.3, 0.4, 'metal', 1);
  register.position.set(0, 1.15, 0);
  counterGroup.add(register);
  const counterHit = box(INTERACT_BOX.counter.w, INTERACT_BOX.counter.h, INTERACT_BOX.counter.d, 'metal', 1);
  counterHit.material = new THREE.MeshBasicMaterial({ visible: false });
  counterHit.position.y = INTERACT_BOX.counter.y;
  counterHit.userData = { interact: 'checkout' };
  counterGroup.add(counterHit);
  world.add(counterGroup);

  /* ---------- 库存箱 ---------- */
  const crateGroup = new THREE.Group();
  crateGroup.position.copy(CRATE_POS);
  const crateBody = boxCrate(1.1, 0.9, 1.1);
  crateBody.position.y = 0.45;
  crateGroup.add(crateBody);
  const crateHit = box(INTERACT_BOX.crate.w, INTERACT_BOX.crate.h, INTERACT_BOX.crate.d, 'metal', 1);
  crateHit.material = new THREE.MeshBasicMaterial({ visible: false });
  crateHit.position.y = INTERACT_BOX.crate.y;
  crateHit.userData = { interact: 'take' };
  crateGroup.add(crateHit);
  world.add(crateGroup);

  /* ---------- 块6：垃圾桶 + 垃圾堆（收银台旁，不挡动线、不穿货架） ----------
   * 收银台在 (3.6,3.4)，货架在 x≤-1.4（左侧），这里把垃圾桶放到收银台右前方
   * (5.1,3.4)，处于开阔地面（STORE 范围 x∈[-7,7]、z∈[-5,5]），与任何货架/设备都不相交。
   * 垃圾桶是交互锚点（userData.interact='trashcan'）；垃圾堆是纯视觉（动态池，不进 targets）。 */
  const trashcanPos = new THREE.Vector3(COUNTER_POS.x + 1.5, 0, COUNTER_POS.z); // (5.1, 0, 3.4)
  const trashcanGroup = new THREE.Group();
  trashcanGroup.position.copy(trashcanPos);
  // 白色桶身（圆柱）
  const canBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.3, 0.66, 18),
    new THREE.MeshStandardMaterial({ color: 0xF2F2F2, roughness: 0.6, metalness: 0.05 }),
  );
  canBody.position.y = 0.33;
  canBody.castShadow = true; canBody.receiveShadow = true;
  trashcanGroup.add(canBody);
  // 桶盖
  const canLid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.38, 0.1, 18),
    new THREE.MeshStandardMaterial({ color: 0xD8D8D8, roughness: 0.5, metalness: 0.1 }),
  );
  canLid.position.y = 0.72;
  canLid.castShadow = true;
  trashcanGroup.add(canLid);
  // 交互命中盒（不可见）
  const trashcanHit = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 1.2, 0.9),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  trashcanHit.position.y = 0.6;
  trashcanHit.userData = { interact: 'trashcan' };
  trashcanGroup.add(trashcanHit);
  world.add(trashcanGroup);

  /* 垃圾堆（动态池，最多 GARBAGE.cap 件，堆在垃圾桶前方一点）。
   * 只在 state.garbage>0 时显示，是"垃圾堆积"的视觉出口；清空后全部隐藏。 */
  const garbagePileGroup = new THREE.Group();
  garbagePileGroup.position.set(trashcanPos.x, 0, trashcanPos.z + 0.95);
  const garbagePool = [];
  const garbageColors = [0xE8C99B, 0xC9B79B, 0xD8C0A0, 0xBFB39A]; // 牛皮纸/纸箱色系
  for (let i = 0; i < GARBAGE.cap; i++) {
    const g = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.18, 0.22),
      new THREE.MeshStandardMaterial({ color: garbageColors[i % garbageColors.length], roughness: 0.95, metalness: 0 }),
    );
    g.castShadow = true; g.receiveShadow = true;
    g.visible = false;
    garbagePileGroup.add(g);
    garbagePool.push(g);
  }
  world.add(garbagePileGroup);

  /**
   * 同步垃圾堆网格到 state.garbage（块6）。
   * @param n 当前垃圾件数（0~cap）
   */
  function setGarbage(n) {
    const cnt = Math.max(0, Math.min(GARBAGE.cap, n | 0));
    for (let i = 0; i < garbagePool.length; i++) {
      const m = garbagePool[i];
      if (i < cnt) {
        // 在垃圾桶前方错落铺一小堆（螺旋排列，避免重叠穿模）
        const ring = Math.floor(i / 4);
        const ang = (i % 4) * (Math.PI / 2) + ring * 0.6;
        const r = 0.22 + ring * 0.2;
        m.position.set(Math.cos(ang) * r, 0.1 + (i % 3) * 0.16, Math.sin(ang) * r);
        m.rotation.set(0, ang, (i % 2) ? 0.2 : -0.2);
        m.visible = true;
      } else {
        m.visible = false;
      }
    }
  }
  setGarbage(0); // 开局无垃圾

  /* ---------- 门口货箱（2026-10-06 块5：进货运输闭环） ----------
   * 与"库存箱"是两件东西：
   *   · 库存箱（上面那个，POS.crate）在店**内** {x:4.6,z:-3.4}，是"已入库的货"
   *   · 门口货箱在店**门口** {x:2.2,z:4.2}，是"刚送到、还没搬的货"
   * 位置刻意分开：玩家必须真的走到门口按 E 才能开始搬运，
   * 这 45 秒的等待才有"去把它拿回来"的仪式感，而不是"UI 刷新一下就到了"。
   *
   * 默认隐藏（visible=false），由 setDeliveryCrates(n) 按在门口的数量显示。
   * 判定盒 userData.interact='delivery' —— 交互层据此给"按 E 拾取"提示。 */
  const deliveryCratePos = new THREE.Vector3(DELIVERY.crate.x, 0, DELIVERY.crate.z);
  const deliveryCrates = [];
  for (let ci = 0; ci < DELIVERY.maxCrates; ci++) {
    const g = new THREE.Group();
    g.position.set(deliveryCratePos.x + ci * 0.85, 0, deliveryCratePos.z);
    /* 交互标记挂在 **Group** 上而不是子判定盒上：
     * 锥选对 Group 取包围盒并 describe(group.userData)，标记在子 mesh
     * 上会因 Group.userData 为空而永远"没对准·最近：?"（2026-10-06 实锤）。 */
    g.userData = { interact: 'delivery', crateIndex: ci };
    const body = boxCrate(0.72, 0.56, 0.62);      // 比库存箱小一号（它是"待搬运的包裹"）
    body.position.y = 0.28;
    g.add(body);
    // 封箱胶带（一条横带 + 一个标签片）：让"这是货箱"一眼可辨
    const tape = box(0.74, 0.05, 0.64, 'metal', 1);
    tape.position.y = 0.30;
    g.add(tape);
    const hit = box(INTERACT_BOX.crate.w, INTERACT_BOX.crate.h, INTERACT_BOX.crate.d, 'metal', 1);
    hit.material = new THREE.MeshBasicMaterial({ visible: false });
    hit.position.y = INTERACT_BOX.crate.y;
    g.add(hit);
    g.visible = false;
    world.add(g);
    deliveryCrates.push(g);
  }

  /** 门口货箱显示控制：n 个箱子可见（n 由 delivery.panel().crates.length 驱动） */
  function setDeliveryCrates(n) {
    const k = Math.max(0, Math.min(deliveryCrates.length, n | 0));
    for (let i = 0; i < deliveryCrates.length; i++) deliveryCrates[i].visible = i < k;
  }

  /* ================= 室外：电玩区 ================= */
  const arcade = ZONES.arcade;
  // 顶棚 + 四柱
  const canopyW = arcade.maxX - arcade.minX;
  const canopyD = arcade.maxZ - arcade.minZ;
  const canopy = box(canopyW, 0.18, canopyD, 'metal', 2);
  canopy.position.set((arcade.minX + arcade.maxX) / 2, 3.3, (arcade.minZ + arcade.maxZ) / 2);
  world.add(canopy);

  for (const cx of [arcade.minX + 0.3, arcade.maxX - 0.3]) {
    for (const cz of [arcade.minZ + 0.3, arcade.maxZ - 0.3]) {
      const pillar = box(0.18, 3.2, 0.18, 'metal', 1);
      pillar.position.set(cx, 1.6, cz);
      world.add(pillar);
    }
  }

  for (const a of PROPS.arcades) {
    const g = new THREE.Group();
    g.position.set(a.x, 0, a.z);
    g.rotation.y = a.rot ?? 0;
    const sz = PROP_SIZE.arcade;
    const cab = box(sz.w, 1.78, sz.d, 'arcade', 1);
    cab.position.y = 0.89;
    g.add(cab);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.46), MATS.screen);
    screen.position.set(0, 1.28, sz.d / 2 + 0.012);
    screen.rotation.x = -0.22;
    g.add(screen);
    world.add(g);
  }

  /* ================= 室外：休息区 ================= */
  for (const t of PROPS.tables) {
    const g = new THREE.Group();
    g.position.set(t.x, 0, t.z);

    const top = box(1.3, 0.08, 1.3, 'wood', 1);
    top.position.y = 0.74;
    g.add(top);
    const leg = box(0.14, 0.7, 0.14, 'metal', 1);
    leg.position.y = 0.35;
    g.add(leg);
    // 两把椅子
    for (const sx of [-1, 1]) {
      const seat = box(0.46, 0.07, 0.46, 'wood', 1);
      seat.position.set(sx * 1.0, 0.45, 0);
      g.add(seat);
      const back = box(0.46, 0.5, 0.07, 'wood', 1);
      back.position.set(sx * 1.0, 0.7, -sx * 0.2);
      g.add(back);
      const cleg = box(0.08, 0.45, 0.08, 'metal', 1);
      cleg.position.set(sx * 1.0, 0.22, 0);
      g.add(cleg);
    }
    // 遮阳伞
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 2.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x8A93A5, roughness: 0.6, metalness: 0.3 }),
    );
    pole.position.set(0.55, 1.15, -0.55);
    g.add(pole);
    const umbrella = new THREE.Mesh(
      new THREE.ConeGeometry(1.25, 0.42, 12),
      new THREE.MeshStandardMaterial({ color: 0xE8A94E, roughness: 0.85 }),
    );
    umbrella.position.set(0.55, 2.35, -0.55);
    g.add(umbrella);

    world.add(g);
  }

  /* ================= 室外：广场设施 ================= */
  for (const b of PROPS.benches) {
    const g = new THREE.Group();
    g.position.set(b.x, 0, b.z);
    const seat = box(PROP_SIZE.bench.w, 0.09, PROP_SIZE.bench.d, 'wood', 1);
    seat.position.y = 0.45;
    g.add(seat);
    const back = box(PROP_SIZE.bench.w, 0.42, 0.08, 'wood', 1);
    back.position.set(0, 0.68, -0.22);
    g.add(back);
    for (const sx of [-0.7, 0.7]) {
      const l = box(0.09, 0.45, 0.09, 'metal', 1);
      l.position.set(sx, 0.22, 0);
      g.add(l);
    }
    world.add(g);
  }

  for (const p of PROPS.plants) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.2, 0.36, 10),
      new THREE.MeshStandardMaterial({ color: 0x6B5636, roughness: 0.92 }),
    );
    pot.position.y = 0.18;
    g.add(pot);
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.46, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x3E7A52, roughness: 0.95, flatShading: true }),
    );
    leaf.position.y = 0.72;
    leaf.scale.set(1, 0.9, 1);
    g.add(leaf);
    const leaf2 = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x4E8B5E, roughness: 0.95, flatShading: true }),
    );
    leaf2.position.set(0.2, 0.98, 0.12);
    g.add(leaf2);
    world.add(g);
  }

  for (const l of PROPS.lamps) {
    const g = new THREE.Group();
    g.position.set(l.x, 0, l.z);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 3.1, 8),
      new THREE.MeshStandardMaterial({ color: 0x39424F, roughness: 0.7, metalness: 0.35 }),
    );
    pole.position.y = 1.55;
    g.add(pole);
    const headM = boxColor(0.5, 0.16, 0.5, 0xF2C879, {
      emissive: new THREE.Color(0xF2C879), emissiveIntensity: 0.9,
    });
    headM.position.y = 3.12;
    g.add(headM);
    world.add(g);
  }

  /* ================= 可玩娱乐设施（电玩区 + 广场池塘 + 扩建区） ================= */
  // 每个设施 ≤ 5 个 mesh + 1 个标牌 sprite，控制在 draw call 预算内
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x14405C, roughness: 0.16, metalness: 0.3,
    emissive: new THREE.Color(0x0A2233), emissiveIntensity: 0.55,
    transparent: true, opacity: 0.9,
  });
  /* 玻璃材质：透明玻璃**必须 depthWrite:false**。
   * 否则会踩一个很隐蔽的坑（2026-09-21 实测）：three.js 的透明对象按"由远及近"排序，
   * 玻璃盒（中心更远）先画并写深度，于是柜内**同样是透明**的补货提示牌在深度测试里被剔除 ——
   * 提示牌 hint.visible=true、世界坐标投影也正好落在屏幕正中，但画面上完全看不到。
   * （柜里的娃娃是不透明材质，在不透明批次里先画，所以一直正常 —— 这才让问题看起来"只针对提示牌"。）
   * 透明玻璃不该写深度，这也是它唯一正确的设置。 */
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9FC9E8, roughness: 0.1, metalness: 0.12,
    transparent: true, opacity: 0.26, depthWrite: false,
  });
  const facilityHits = [];
  const facilityLabels = [];
  /** 设施屏幕（逐台克隆材质，供故障闪烁用） */
  const facilityScreens = new Map();
  /** 设施状态灯：绿=正常，红闪=故障（需求④的视觉出口） */
  const facilityLamps = new Map();
  /** 需求I 第①条：等级灯带（lv2 冰蓝 / lv3 霓虹紫；lv1 隐藏）—— 设备外观随等级小幅变化 */
  const facilityRanks = new Map();

  /**
   * 建一台设施。基础 5 台与扩建附带的 2~3 台共用这个函数 ——
   * 两者的差别只有"建完是否立刻可见 / 是否立刻可交互"。
   * @returns { fac, group, hit, lamp, screen, rankBar, label }
   */
  function buildFacility(fac) {
    const g = new THREE.Group();
    g.position.set(fac.x, 0, fac.z);
    g.rotation.y = fac.kind === 'fishing' ? 0 : (fac.rot ?? 0);
    let screen = null;

    if (fac.kind === 'pachinko') {
      const cab = box(0.95, 1.92, 0.8, 'arcade', 1);
      cab.position.y = 0.96;
      g.add(cab);
      // 屏幕材质**逐台克隆**：MATS.screen 是全局共享材质，
      // 若直接改它的 emissiveIntensity 做故障闪烁，会让全场屏幕一起闪。
      screen = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.82), MATS.screen.clone());
      screen.position.set(0, 1.34, 0.405);
      screen.rotation.x = -0.14;
      g.add(screen);
      const coin = boxColor(0.52, 0.14, 0.05, 0xE8A94E, {
        emissive: new THREE.Color(0xE8A94E), emissiveIntensity: 0.6,
      });
      coin.position.set(0, 0.72, 0.42);
      g.add(coin);
    } else if (fac.kind === 'basketball') {
      const base = box(1.2, 0.12, 1.2, 'metal', 1);
      base.position.y = 0.06;
      g.add(base);
      const pole = box(0.14, 2.6, 0.14, 'metal', 1);
      pole.position.set(0, 1.3, -0.32);
      g.add(pole);
      const board = box(1.15, 0.82, 0.1, 'wood', 1);
      board.position.set(0, 2.34, -0.2);
      g.add(board);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.24, 0.035, 6, 14),
        new THREE.MeshStandardMaterial({ color: 0xE05A5A, roughness: 0.5, metalness: 0.3 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(0, 2.02, 0.06);
      g.add(rim);
      /* 正面屏幕（P0-1）：投篮机的"得分界面"屏（篮板正面），之前这台只有篮筐没有屏幕 */
      screen = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.5), MATS.screen.clone());
      screen.position.set(0, 2.34, -0.14);
      g.add(screen);
    } else if (fac.kind === 'claw') {
      const base = box(1.0, 0.92, 1.0, 'arcade', 1);
      base.position.y = 0.46;
      g.add(base);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.0, 0.92), glassMat);
      glass.position.y = 1.42;
      g.add(glass);
      const cap = box(1.04, 0.12, 1.04, 'metal', 1);
      cap.position.y = 1.98;
      g.add(cap);
      /* 正面屏幕（P0-1）：抓娃娃机的"娃娃陈列 / 操控"屏 */
      screen = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.36), MATS.screen.clone());
      screen.position.set(0, 0.66, 0.505);
      screen.rotation.x = -0.08;
      g.add(screen);

      /* 玻璃柜里的娃娃（P0-4）。线上问题："柜子里一只娃娃都没有，透光就是个空箱子"。
       * 位置用固定公式而不是随机：同一台机器每次重建都长一样（不会开局变样），也不逐帧抖动。
       * 柜内 5 列 × 2 排，最多 CLAW_CABINET.maxDolls 只，配色循环取 CLAW_CABINET.colors
       * （4 色 → 一眼能看出"一柜子不同娃娃"，不是一排同色球）。 */
      const dolls = new THREE.Group();
      for (let i = 0; i < CLAW_CABINET.maxDolls; i++) {
        const col = CLAW_CABINET.colors[i % CLAW_CABINET.colors.length];
        const d = new THREE.Group();
        const body = new THREE.Mesh(
          prodGeo('doll.body', () => new THREE.SphereGeometry(0.072, 8, 6)),
          prodMat(col, { rough: 0.88 }),
        );
        body.scale.set(1, 1.12, 0.94);
        body.position.y = 0.083;
        d.add(body);
        const head = new THREE.Mesh(
          prodGeo('doll.head', () => new THREE.SphereGeometry(0.050, 8, 6)),
          prodMat(col, { rough: 0.88 }),
        );
        head.position.y = 0.182;
        d.add(head);
        for (const sgn of [-1, 1]) {
          const ear = new THREE.Mesh(
            prodGeo('doll.ear', () => new THREE.SphereGeometry(0.020, 6, 5)),
            prodMat(col, { rough: 0.88 }),
          );
          ear.position.set(sgn * 0.040, 0.220, 0);
          d.add(ear);
        }
        // 玻璃盒底面在 y = 0.92；排布错位一点，读成"堆着的一柜"而不是整齐的兵阵
        const gx = (i % 5) - 2;
        const gz = Math.floor(i / 5) === 0 ? -0.5 : 0.5;
        d.position.set(gx * 0.150 + (i % 2 ? 0.022 : -0.022), 0.925, gz * 0.30);
        d.rotation.y = i * 0.72;
        dolls.add(d);
      }
      g.add(dolls);

      // 见底时的补货提示（自发光小立牌，夜景也看得见）
      const hintCanvas = document.createElement('canvas');
      hintCanvas.width = 320;      // 比例必须与下面的 PlaneGeometry 一致，否则文字被拉伸
      hintCanvas.height = 160;
      const hintTex = new THREE.CanvasTexture(hintCanvas);
      drawClawHint(hintCanvas, hintTex);
      const hint = new THREE.Mesh(
        new THREE.PlaneGeometry(0.72, 0.36),
        new THREE.MeshBasicMaterial({ map: hintTex, transparent: true, depthWrite: false }),
      );
      // 玻璃柜内偏上（柜体 y 0.92–1.92，娃娃只占下半）。
      // 为什么不是正中：屏幕正中会被「E 游玩」交互提示条压住，抬高一点两边都读得清。
      hint.position.set(0, 1.56, 0.30);
      hint.rotation.x = -0.05;
      hint.visible = false;
      g.add(hint);
      clawCabinets.set(fac.id, { dolls, hint });
    } else if (fac.kind === 'fishing') {
      // 池塘本体（世界朝向，不随 rot 旋转）
      const rim = boxColor(POND.w + 0.5, 0.14, POND.d + 0.5, 0x6E7686, { roughness: 0.92 });
      rim.position.y = 0.07;
      g.add(rim);
      // 水面：带波纹贴图 + 分段平面（updatePond 做顶点起伏，模拟涟漪）
      const waterGeo = new THREE.PlaneGeometry(POND.w, POND.d, 18, 14);
      const wmat = MATS.water;
      wmat.transparent = true;
      wmat.opacity = 0.92;
      wmat.map.wrapS = wmat.map.wrapT = THREE.RepeatWrapping;
      wmat.map.repeat.set(1.4, 1.2);
      wmat.map.needsUpdate = true;
      const water = new THREE.Mesh(waterGeo, wmat);
      water.rotation.x = -Math.PI / 2;
      water.position.y = 0.12;
      g.add(water);
      // 鱼（装饰，不参与碰撞）：低多边形身体 + 尾鳍
      const fish = [];
      for (let i = 0; i < 4; i++) {
        const f = makeFish();
        f.position.set(
          (Math.random() - 0.5) * POND.w * 0.7,
          0.08,
          (Math.random() - 0.5) * POND.d * 0.6,
        );
        f.userData.ph = Math.random() * Math.PI * 2;
        f.rotation.y = Math.random() * Math.PI * 2;
        g.add(f);
        fish.push(f);
      }
      // 钓竿（斜靠在木栈道上）
      const rod = makeRod();
      rod.position.set(POND.w / 2 + 0.15, 0.42, 0.1);
      rod.rotation.set(0, 0, Math.PI / 2 - 0.35);
      g.add(rod);
      // 记录引用供逐帧动画
      if (fac.id === 'pond') {
        pondAnim = { waterGeo, base: waterGeo.attributes.position.array.slice(), fish, t: 0 };
      }
      const dock = box(0.7, 0.12, 1.2, 'wood', 1);
      dock.position.set(POND.w / 2 + 0.3, 0.06, 0);
      g.add(dock);
    } else if (fac.kind === 'vending') {
      // 需求I 第⑦条：售货专区的可售货机（正面用发光面板贴图，与普通街机区分开）
      const sz = PROP_SIZE.vending;
      const geo = new THREE.BoxGeometry(sz.w, 1.9, sz.d);
      const side = MATS.metal;
      const m = new THREE.Mesh(geo, [side, side, side, side, MATS.vending, side]);
      m.position.y = 0.95;
      g.add(m);
    } else if (fac.kind === 'dance') {
      /* 跳舞机（2★ 解锁）：踏板平台 + 立柜 + 大屏 + 四个箭头踏板。
       * 踏板用四块不同颜色的小方块 —— 玩家远看就能认出"这是跳舞机"。 */
      const pad = box(1.5, 0.14, 0.9, 'metal', 1);
      pad.position.y = 0.07;
      g.add(pad);
      const cab = box(1.15, 1.85, 0.55, 'arcade', 1);
      cab.position.set(0, 0.95, -0.22);
      g.add(cab);
      screen = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.72), MATS.screen.clone());
      screen.position.set(0, 1.32, 0.07);
      g.add(screen);
      const cols = [0x6BA8E8, 0x6FCF97, 0xB15BD8, 0xE8A94E];
      for (let i = 0; i < 4; i++) {
        const t = boxColor(0.26, 0.05, 0.26, cols[i], {
          emissive: new THREE.Color(cols[i]), emissiveIntensity: 0.7,
        });
        t.position.set(-0.42 + i * 0.28, 0.16, 0.36);
        g.add(t);
      }
    } else if (fac.kind === 'racing') {
      /* 赛车机（3★ 解锁）：座舱 + 方向盘 + 宽屏 */
      const base = box(1.4, 0.16, 1.2, 'metal', 1);
      base.position.y = 0.08;
      g.add(base);
      const seat = box(0.55, 0.6, 0.55, 'arcade', 1);
      seat.position.set(0, 0.46, -0.3);
      g.add(seat);
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(0.19, 0.045, 6, 14),
        new THREE.MeshStandardMaterial({ color: 0x2B3342, roughness: 0.6, metalness: 0.4 }),
      );
      wheel.position.set(0, 0.78, 0.16);
      wheel.rotation.x = -0.5;
      g.add(wheel);
      const cab = box(1.3, 1.3, 0.4, 'arcade', 1);
      cab.position.set(0, 0.65, 0.42);
      g.add(cab);
      screen = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.66), MATS.screen.clone());
      screen.position.set(0, 0.95, 0.63);
      screen.rotation.x = -0.16;
      g.add(screen);
    } else if (fac.kind === 'ktv') {
      /* KTV（4★ 解锁）：隔音包厢（三面墙）+ 电视 + 麦克风 + 顶部霓虹帘 */
      const backW = box(1.7, 2.0, 0.12, 'wood', 1);
      backW.position.set(0, 1.0, -0.5);
      g.add(backW);
      for (const sx of [-1, 1]) {
        const w = box(0.12, 2.0, 1.0, 'wood', 1);
        w.position.set(sx * 0.85, 1.0, 0);
        g.add(w);
      }
      const bench = box(1.5, 0.4, 0.45, 'arcade', 1);
      bench.position.set(0, 0.2, -0.2);
      g.add(bench);
      screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.62), MATS.screen.clone());
      screen.position.set(0, 1.45, -0.43);
      g.add(screen);
      const mic = box(0.05, 0.26, 0.05, 'metal', 1);
      mic.position.set(0.42, 1.05, 0.18);
      mic.rotation.z = 0.25;
      g.add(mic);
    } else if (fac.kind === 'jukebox') {
      /* 点唱机（5★ 解锁）：纯氛围机 —— 木壳 + 发光面板 + 顶部拱灯。
       * 刻意不做屏幕小游戏：它是"切曲风"的开关，不是收益机器。 */
      const body = box(0.86, 1.35, 0.6, 'wood', 1);
      body.position.y = 0.68;
      g.add(body);
      const face = boxColor(0.7, 0.6, 0.06, 0xE8A94E, {
        emissive: new THREE.Color(0xE8A94E), emissiveIntensity: 0.55,
      });
      face.position.set(0, 0.95, 0.31);
      g.add(face);
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(0.42, 0.05, 6, 16, Math.PI),
        new THREE.MeshStandardMaterial({
          color: 0x1B2130, emissive: new THREE.Color(0xF2C879), emissiveIntensity: 1.1, roughness: 0.4,
        }),
      );
      arch.position.set(0, 1.36, 0);
      g.add(arch);
    }

    // 交互判定盒（不可见；userData 驱动 interaction.mjs）
    const hb = hitBox(fac);
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(hb.w, hb.h, hb.d),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = hb.y;
    hit.userData = { interact: 'facility', facilityId: fac.id };
    g.add(hit);
    facilityHits.push(hit);

    // 状态灯：挂在柜体右上角，避开标牌（标牌在正中 2.35 高）
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x1B2130,
      emissive: new THREE.Color(0x6FCF97),
      emissiveIntensity: 1.0,
      roughness: 0.45,
    });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), lampMat);
    lamp.position.set(0.46, (fac.kind === 'fishing' || fac.kind === 'vending') ? 1.55 : 2.08, 0.02);
    g.add(lamp);
    facilityLamps.set(fac.id, lamp);

    /* 需求I 第①条：等级灯带 —— 柜体顶部一条细灯条，
     * lv1 不亮（保持需求G 的原样），lv2 冰蓝、lv3 霓虹紫。
     * 用"灯条"而不是换整机贴图：贴图是共享的 MATS，逐台换会把同款机器一起换掉。 */
    const rankMat = new THREE.MeshStandardMaterial({
      color: 0x1B2130,
      emissive: new THREE.Color(0x4FD1E8),
      emissiveIntensity: 1.1,
      roughness: 0.4,
    });
    const rankBar = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.06, 0.06), rankMat);
    rankBar.position.set(0, (fac.kind === 'fishing' || fac.kind === 'vending') ? 1.72 : 2.24, 0.14);
    rankBar.visible = false;
    g.add(rankBar);
    facilityRanks.set(fac.id, rankBar);

    // 标牌：emoji + 名称 + 投币额
    const lab = makeLabelSprite();
    if (fac.kind === 'fishing') lab.sprite.position.set(POND.w / 2 + 0.75, 1.55, 0);
    else lab.sprite.position.set(0, 2.35, 0);
    g.add(lab.sprite);
    const cost = facilityCost(fac);
    drawLabel(lab.canvas, lab.tex, {
      emoji: fac.emoji,
      title: fac.name,
      sub: fac.kind === 'vending' ? '按 E 收货款' : (cost > 0 ? `投币 ${fmtYuan(cost)}` : '免费 · 按 E'),
      tint: '#F2C879',
    });
    facilityLabels.push({ sprite: lab.sprite, canvas: lab.canvas, tex: lab.tex, id: fac.id });

    if (screen) facilityScreens.set(fac.id, screen);
    world.add(g);
    return { fac, group: g, hit, lamp, screen, rankBar, label: lab };
  }

  // 基础 5 台立刻可见可交互（与需求G 时期完全一致）
  for (const fac of FACILITIES) buildFacility(fac);

  /** 已建过的设施 id —— 星级解锁是"运行时补建"，重复解锁不能建出第二台 */
  const builtIds = new Set(FACILITIES.map((f) => f.id));

  /* ================= 需求I 第⑦条：扩建区与附赠设施（预建隐藏） =================
   * 几何在开局就建好、默认 visible=false，解锁时才显示 ——
   * 而不是解锁时现场建：现场建会让"买下扩建"那一帧掉一次明显的帧（贴图/几何创建），
   * 而玩家此刻正好在点确认按钮，卡顿感最强。
   * 注意：隐藏的**光源**不会被 group.visible 关掉（THREE 的光照与 visible 无关），
   * 所以扩建区的灯要在解锁时才 addLight（见 applyExpansion）。 */
  const expansionGroups = new Map();
  const expansionParts = new Map();

  /** 灯柱（广场的 PROPS.lamps 与扩建区共用同一套外观） */
  function addLampPost(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 3.1, 8),
      new THREE.MeshStandardMaterial({ color: 0x39424F, roughness: 0.7, metalness: 0.35 }),
    );
    pole.position.y = 1.55;
    g.add(pole);
    const headM = boxColor(0.5, 0.16, 0.5, 0xF2C879, {
      emissive: new THREE.Color(0xF2C879), emissiveIntensity: 0.9,
    });
    headM.position.y = 3.12;
    g.add(headM);
    parent.add(g);
    return g;
  }

  for (const exp of EXPANSIONS) {
    const zone = exp.zone;
    const zg = new THREE.Group();
    zg.visible = false;

    const zw = zone.maxX - zone.minX;
    const zd = zone.maxZ - zone.minZ;
    const pave = box(zw, 0.06, zd, 'plaza', 2);
    pave.position.set((zone.minX + zone.maxX) / 2, 0.025, (zone.minZ + zone.maxZ) / 2);
    zg.add(pave);
    for (const l of exp.lamps ?? []) addLampPost(zg, l.x, l.z);

    world.add(zg);
    expansionGroups.set(exp.id, zg);

    const parts = [];
    for (const fac of exp.facilities ?? []) {
      const p = buildFacility(fac);
      builtIds.add(fac.id);
      p.group.visible = false;
      // 未解锁时不参与锥选：从交互列表里先摘掉（解锁时再挂回去）
      const i = facilityHits.indexOf(p.hit);
      if (i >= 0) facilityHits.splice(i, 1);
      parts.push(p);
    }
    expansionParts.set(exp.id, parts);
  }

  /* ================= 小吃摊（R2 · 极简占位） ================= */
  // 程序化低面 mesh（台面 + 顶棚 + 暖灯）+ 复用顾客 rig 的摊主 + 纯代码 lerp 烹饪动画。
  // 摊位三角面预算 ≤ 800（摊主 rig 单独计入「≤4 同屏」规则）；不开启阴影（ADR-004）。
  let stallAnim = null;
  const stallHits = [];
  {
    const g = new THREE.Group();
    g.position.set(-4.4, 0, 9.4); // 广场西侧，不压绿植/长椅

    // 台面
    const counterTop = box(1.6, 0.12, 0.7, 'wood', 1);
    counterTop.position.set(0, 0.95, 0);
    g.add(counterTop);
    const counterBody = box(1.5, 0.95, 0.6, 'metal', 1);
    counterBody.position.set(0, 0.48, 0);
    g.add(counterBody);

    // 顶棚（4 柱 + 顶板）
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = box(0.08, 2.4, 0.08, 'metal', 1);
        post.position.set(sx * 0.78, 1.2, sz * 0.5);
        g.add(post);
      }
    }
    const roof = box(2.0, 0.1, 1.2, 'wood', 1);
    roof.position.set(0, 2.5, 0);
    g.add(roof);

    // 暖灯（发光，美术圣经 §6.2：仅灯/招牌发光）
    const lamp = boxColor(0.5, 0.16, 0.5, 0xF2C879, {
      emissive: new THREE.Color(0xF2C879), emissiveIntensity: 0.9,
    });
    lamp.position.set(0, 2.25, -0.5);
    g.add(lamp);

    // 摊主（复用顾客 rig；面朝 -Z，即朝向从店里走来的玩家）
    const vendor = createCharacter({ seed: 0.3, cloth: 0xE8A94E });
    vendor.group.position.set(0, 0, 0.55);
    vendor.group.rotation.y = Math.PI;
    g.add(vendor.group);

    // 平底锅 + 铲（挂在摊主手上，纯代码 lerp/循环动画）
    const pan = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 0.05, 12),
      new THREE.MeshStandardMaterial({ color: 0x2A2E36, roughness: 0.55, metalness: 0.4 }),
    );
    pan.position.set(0.22, 1.0, 0.18);
    vendor.group.add(pan);
    const spatula = boxColor(0.05, 0.05, 0.42, 0xC9CDD6, { metalness: 0.3, roughness: 0.5 });
    spatula.position.set(0.22, 1.12, 0.4);
    vendor.group.add(spatula);

    // 交互判定盒（不可见；userData 驱动 interaction.mjs 的 BUY_SNACK；位于朝店里一侧）
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 2.6, 1.4),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.set(0, 1.3, -0.4);
    hit.userData = { interact: 'buySnack' };
    g.add(hit);
    stallHits.push(hit);

    // 标牌
    const lab = makeLabelSprite();
    lab.sprite.position.set(0, 2.95, 0);
    g.add(lab.sprite);
    drawLabel(lab.canvas, lab.tex, {
      emoji: '🥟', title: '宵夜摊', sub: '¥15 · 按 E 买', tint: '#F2C879',
    });

    world.add(g);
    stallAnim = { vendor, pan, spatula, t: 0 };
  }

  /* ================= 自动售货机（正面用发光贴图） ================= */
  for (const v of PROPS.vendings) {
    const sz = PROP_SIZE.vending;
    const geo = new THREE.BoxGeometry(sz.w, 1.9, sz.d);
    const side = MATS.metal;
    const arr = [side, side, side, side, MATS.vending, side]; // +Z 面用发光面板
    const m = new THREE.Mesh(geo, arr);
    m.position.set(v.x, 0.95, v.z);
    m.rotation.y = v.rot ?? 0;
    world.add(m);
  }

  /* ================= 后巷：货箱（仓库风格：堆叠货箱 + 存货托盘堆） ================= */
  /** 存货托盘堆（纯装饰，不占碰撞）：木托盘上叠 n 只货箱，错落摆放 */
  function buildPalletStack(x, z, n) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pallet = box(PROP_SIZE.crate.w * 1.1, 0.12, PROP_SIZE.crate.d * 1.1, 'wood', 1);
    pallet.position.y = 0.06;
    g.add(pallet);
    let y = 0.12;
    for (let i = 0; i < n; i++) {
      const s = 1 - i * 0.12;
      const b = boxCrate(PROP_SIZE.crate.w * s, 0.55, PROP_SIZE.crate.d * s);
      b.position.set((Math.random() - 0.5) * 0.12, y + 0.275, (Math.random() - 0.5) * 0.12);
      b.rotation.y = Math.random() * 0.8;
      g.add(b);
      y += 0.55;
    }
    world.add(g);
  }
  for (const c of PROPS.crates) {
    const sz = PROP_SIZE.crate;
    const m = boxCrate(sz.w, 0.8, sz.d);
    m.position.set(c.x, 0.4, c.z);
    m.rotation.y = (c.x % 1) * 0.6;
    world.add(m);
    // 顶部叠放一只小货箱（仓库堆放感）
    const top = boxCrate(sz.w * 0.66, 0.5, sz.d * 0.66);
    top.position.set(c.x + (c.x % 1) * 0.12, 1.05, c.z - (c.z % 1) * 0.12);
    top.rotation.y = (c.z % 1) * 0.6;
    world.add(top);
  }
  // 后巷存货托盘堆（纯装饰，落点避开既有货箱碰撞体）
  for (const st of [
    { x: -8.6, z: -9.8, n: 2 }, { x: 4.6, z: -9.6, n: 3 },
    { x: 0.6, z: -10.6, n: 2 }, { x: 7.6, z: -9.2, n: 2 },
  ]) buildPalletStack(st.x, st.z, st.n);

  /* ================= 装饰区（仅视觉，不占用碰撞 / 不改动交互锚点） ================= */
  const decor = new THREE.Group();
  world.add(decor);

  // 霓虹海报（墙面，MeshBasicMaterial 自发光，variant 控制内容）
  function makePosterMat(variant) {
    const { albedo } = drawPoster(1024, variant);
    const tex = new THREE.CanvasTexture(albedo);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: false });
  }
  const posterMats = [0, 1, 2, 3, 4].map(makePosterMat);
  const posterSpots = [
    { x: -5, z: STORE.minZ + STORE.wallT / 2 + 0.03, ry: 0 },
    { x: 0, z: STORE.minZ + STORE.wallT / 2 + 0.03, ry: 0 },
    { x: 5, z: STORE.minZ + STORE.wallT / 2 + 0.03, ry: 0 },
    { x: STORE.maxX - STORE.wallT / 2 - 0.03, z: 0, ry: -Math.PI / 2 },
  ];
  posterSpots.forEach((p, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.0), posterMats[i % posterMats.length]);
    m.position.set(p.x, 2.0, p.z);
    m.rotation.y = p.ry;
    decor.add(m);
  });

  // 安全出口指示牌（门口上方，朝店内 / 出门方向）
  {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.42), MATS.exitSign);
    m.position.set(0, 2.92, STORE.maxZ - STORE.wallT / 2 - 0.04);
    decor.add(m);
  }

  // 垃圾桶（广场）
  for (const t of [[-5.0, 7.0], [5.0, 7.0], [0, 9.6]]) {
    const g = new THREE.Group();
    g.position.set(t[0], 0, t[1]);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.6, 10), MATS.metal);
    can.position.y = 0.3;
    g.add(can);
    const lid = boxColor(0.5, 0.06, 0.5, 0x39424F, { metalness: 0.4, roughness: 0.6 });
    lid.position.y = 0.62;
    g.add(lid);
    decor.add(g);
  }

  // 地面霓虹导视箭头（广场）—— P1-7：这是"新手引导"，只在新手期显示
  const guideDecals = [];
  {
    const dm = MATS.decal;
    const spots = [[-1.0, 7.3, 0], [8.6, 7.2, Math.PI / 2], [0, 9.2, Math.PI]];
    for (const s of spots) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), dm);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = s[2];
      m.position.set(s[0], 0.075, s[1]);
      decor.add(m);
      guideDecals.push(m);
    }
  }
  /** 显示 / 隐藏地面导视箭头（main 按"第 1 夜前 3 分钟"的条件调用） */
  function setGuideVisible(v) {
    const on = v !== false;
    for (const m of guideDecals) m.visible = on;
  }

  /* ================= 接触阴影（观感 2） =================
   * renderer 没开 shadowMap（为保帧数），静态物体因此看起来"浮"在地面上。
   * 用一张程序化径向渐变贴图贴在物体脚下的地面 —— 成本极低，却能立刻消除漂浮感。 */
  const contactShadowMat = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g2 = c.getContext('2d');
    const rg = g2.createRadialGradient(64, 64, 4, 64, 64, 62);
    rg.addColorStop(0, 'rgba(0,0,0,0.45)');
    rg.addColorStop(0.55, 'rgba(0,0,0,0.22)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g2.fillStyle = rg;
    g2.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.9 });
  })();
  function addContactShadow(x, z, size) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), contactShadowMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.02, z);
    m.renderOrder = 1;
    decor.add(m);
    return m;
  }
  {
    const spots = [
      ...SHELF_ROWS.flatMap((r) => r.zs.map((z) => [r.x, z, 1.9])),
      [COUNTER_POS.x, COUNTER_POS.z, 2.4],
      [CRATE_POS.x, CRATE_POS.z, 1.7],
      ...FACILITIES.map((f) => [f.x, f.z, f.kind === 'fishing' ? 4.8 : (f.w ?? 1) + 1.2]),
      ...PROPS.plants.map((p) => [p.x, p.z, 1.0]),
      ...PROPS.lamps.map((p) => [p.x, p.z, 0.7]),
      ...PROPS.benches.map((p) => [p.x, p.z, 2.1]),
      ...PROPS.tables.map((p) => [p.x, p.z, 2.4]),
      ...PROPS.vendings.map((p) => [p.x, p.z, 1.6]),
      ...PROPS.crates.map((p) => [p.x, p.z, 1.5]),
      [-5.0, 7.0, 0.8], [5.0, 7.0, 0.8], [0, 9.6, 0.8], // 垃圾桶
      [SNACK_STALL.x, SNACK_STALL.z, 2.4],
    ];
    for (const [x, z, s] of spots) addContactShadow(x, z, s);
  }

  /* ================= 悬浮标签的距离 / 对准过滤（P1-5 / P2-10） =================
   * 原来每台机器、每格货架的标签**永远同时显示**，在准星上方堆成一片、
   * 还会被右上角统计栏裁掉。现在：同一时刻只保留"准星当前对准的 + 最近且在视野内的"，
   * 按距离淡入淡出，超距或在身后则隐藏 —— 一个货架只会看到一张信息卡。 */
  /* P1-5：标签只在"准星对着的"或"近到 1m 上下"时才出现，并随距离淡出。
   * 原来所有标签在 5m 内一律淡淡地挂着，站在货架区头顶会同时浮起 5~6 块牌子，
   * 既遮挡视线又读不出"我到底对着哪个"。现在：准星命中的那块最亮最远可见，
   * 没命中的邻居只有在 1.6m 内才勉强露头，其余一律隐藏。 */
  const LABEL_NEAR = 1.6;    // 未被瞄准的邻居标签：超过它直接不显示
  const LABEL_FAR = 4.2;     // 被瞄准的标签：超过它完全隐藏
  const LABEL_FOCUS_FULL = 2.4; // 被瞄准的标签：这个距离内满不透明
  const tmpLbl = new THREE.Vector3();
  const camFwd = new THREE.Vector3();

  function labelOpacityFor(sprite, focus) {
    sprite.getWorldPosition(tmpLbl);
    const dx = tmpLbl.x - camera.position.x;
    const dz = tmpLbl.z - camera.position.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    camera.getWorldDirection(camFwd);
    const facing = (dx * camFwd.x + dz * camFwd.z) / dist;
    if (facing < 0.1) return 0;              // 在身后 / 侧后方 → 不显示
    if (focus) {
      if (dist > LABEL_FAR) return 0;
      return Math.max(0, Math.min(1, (LABEL_FAR - dist) / (LABEL_FAR - LABEL_FOCUS_FULL)));
    }
    if (dist > LABEL_NEAR) return 0;
    return Math.max(0, Math.min(1, (LABEL_NEAR - dist) / (LABEL_NEAR - 0.5)));
  }

  function applyLabelSet(list, focusId, getId) {
    for (const it of list) {
      const focus = focusId != null && getId(it) === focusId;
      const op = labelOpacityFor(it.sprite, focus);
      it.sprite.visible = op > 0.02;
      it.sprite.material.opacity = op;
      // 近大远小 + 对准的略放大，读起来更像"当前目标"
      const s = (focus ? 1.32 : 1.1) * (0.7 + 0.3 * op);
      it.sprite.scale.set(s, s * 0.5, 1);
    }
  }

  /**
   * 每帧刷新标签可见性。
   * @param st state.mjs 的 state（读 hover 判断"准星对准了谁"）
   */
  function updateLabels(st) {
    const hover = st?.hover ?? null;
    const focusFac = hover?.facilityId ?? null;
    const focusSlot = (hover?.type === 'place' && Number.isInteger(hover.slotIndex)) ? hover.slotIndex : null;
    applyLabelSet(facilityLabels, focusFac, (it) => it.id);
    applyLabelSet(slotLabels, focusSlot, (it) => it.index);
  }

  // 电玩区顶部悬挂霓虹灯条
  {
    const bar = boxColor(ZONES.arcade.maxX - ZONES.arcade.minX - 0.6, 0.08, 0.08, NEON.purple, {
      emissive: new THREE.Color(NEON.purple), emissiveIntensity: 1.0,
    });
    bar.position.set((ZONES.arcade.minX + ZONES.arcade.maxX) / 2, 3.05, ZONES.arcade.minZ + 0.4);
    decor.add(bar);
  }

  /* ================= 灯光 =================
   * ambient / hemi 保留引用：昼夜轮换要按插值结果实时改它们的强度（需求G 第⑥条）。
   * 之前是 add 完就丢引用，导致昼夜系统无处下手的尴尬。 */
  const ambient = new THREE.AmbientLight(0x2A3446, 1.0);
  scene.add(ambient);
  // 室外夜空微光（上半冷、下半暖）
  const hemi = new THREE.HemisphereLight(0x9FB6D8, 0x2A2F3A, 0.55);
  scene.add(hemi);

  const lights = [];
  /** 霓虹灯（紫/蓝）单独分组：白天要几乎熄灭，夜里全开 */
  const neonLights = [];
  /** 顶部筒灯（暖黄）：白天反而更亮 */
  const downLights = [];

  function addLight(color, intensity, x, y, z, dist, group = 'down') {
    const l = new THREE.PointLight(color, intensity, dist);
    l.position.set(x, y, z);
    // 基准强度挂在灯上：昼夜插值是在它之上做**倍率**，而不是直接覆盖绝对值。
    // 存成数组再 indexOf 反查也能跑，但每帧 O(n²) 且容易因顺序错位改错灯。
    l.userData.baseIntensity = intensity;
    scene.add(l);
    lights.push(l);
    if (group === 'neon') neonLights.push(l);
    else downLights.push(l);
    return l;
  }

  // 便利店：吊灯 ×2（暖白）
  addLight(0xFFE2B8, 1.5, -2.5, 2.7, 0, 16);
  addLight(0xFFE2B8, 1.3, 2.5, 2.7, 0, 16);
  // 收银台局部（暖）
  addLight(0xF2C879, 1.1, COUNTER_POS.x, 2.3, COUNTER_POS.z, 9);
  // 广场（灯柱已挪到店门两侧 z=6.2）
  addLight(0xF2C879, 1.4, -1.8, 3.0, 6.2, 14);
  addLight(0xF2C879, 1.4, 1.8, 3.0, 6.2, 14);
  // 池塘冷光（让水面在夜里读得出来）
  addLight(0x6BA8E8, 1.1, POND.x, 2.2, POND.z, 10, 'neon');
  // 电玩区（紫霓虹）
  addLight(0xB15BD8, 1.6, 10.5, 2.6, 8.5, 12, 'neon');
  // 电玩区补一盏冰蓝，与紫霓虹形成冷暖对比（需求E 配色：紫 / 冰蓝 / 暖黄）
  addLight(0x3FD8C8, 1.2, 12.6, 2.4, 5.6, 10, 'neon');
  // 休息区（暖）
  addLight(0xFFD9A0, 1.2, -10.2, 2.6, 8.6, 11);

  // 便利店内灯管（可见几何，增加真实感）
  for (const x of [-2.5, 2.5]) {
    const tube = boxColor(1.6, 0.08, 0.16, 0xFFF3DC, {
      emissive: new THREE.Color(0xFFE2B8), emissiveIntensity: 1.1,
    });
    tube.position.set(x, 2.82, 0);
    world.add(tube);
  }

  /* ================= 环境交互物：垃圾 =================
   * 垃圾是**运行时动态**生成的（worldstate 刷新），所以这里用对象池：
   * 只在数量变化时增删，不每帧重建网格 —— 否则清理/刷新时会有可见的 GC 抖动。 */
  const litterGroup = new THREE.Group();
  world.add(litterGroup);
  /** 池中网格：与 worldstate.litter 一一对应（多出来的隐藏而不是销毁） */
  const litterPool = [];
  /** 3 种垃圾形态（观感需求：纸屑 / 倒了的饮料杯 / 包装袋，不再是橙色圆点）。
   *  几何与材质共享，仅按索引轮换，动态生成时不反复建资源。 */
  const LITTER_FORMS = (() => {
    const paperGeo = new THREE.PlaneGeometry(0.26, 0.2);
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xCFC7B0, roughness: 0.96, side: THREE.DoubleSide });
    const cupGeo = new THREE.CylinderGeometry(0.045, 0.038, 0.11, 8);
    const cupMat = new THREE.MeshStandardMaterial({ color: 0xD8DCE6, roughness: 0.8 });
    const wrapGeo = new THREE.BoxGeometry(0.17, 0.07, 0.13);
    const wrapMat = new THREE.MeshStandardMaterial({ color: 0xB4693F, roughness: 0.9 });
    return [
      { geo: paperGeo, mat: paperMat, y: 0.015, rot: [-Math.PI / 2, 0, 0] },
      { geo: cupGeo, mat: cupMat, y: 0.05, rot: [0, 0, Math.PI / 2] },   // 侧倒的杯子
      { geo: wrapGeo, mat: wrapMat, y: 0.04, rot: [0, 0, 0] },
    ];
  })();
  const litterGeo = LITTER_FORMS[0].geo;
  const litterMat = LITTER_FORMS[0].mat;

  /**
   * 同步垃圾网格到 worldstate 的垃圾列表。
   * @param list [{ id, x, z }]
   */
  function setLitter(list) {
    const n = Array.isArray(list) ? list.length : 0;
    while (litterPool.length < n) {
      const m = new THREE.Mesh(litterGeo, litterMat);
      m.userData.yaw = Math.random() * Math.PI * 2;
      litterPool.push(m);
      litterGroup.add(m);
    }
    for (let i = 0; i < litterPool.length; i++) {
      const m = litterPool[i];
      if (i < n) {
        const l = list[i];
        const f = LITTER_FORMS[i % LITTER_FORMS.length];
        m.geometry = f.geo;
        m.material = f.mat;
        m.rotation.set(f.rot[0], (f.rot[1] ?? 0) + (m.userData.yaw ?? 0), f.rot[2]);
        m.visible = true;
        m.position.set(l.x, f.y, l.z);
        m.userData.interact = 'litter';
        m.userData.litterId = l.id;
        m.userData.yaw = m.userData.yaw ?? 0;
      } else {
        m.visible = false;
        m.userData = { yaw: m.userData.yaw ?? 0 };
      }
    }
  }

  /* ================= 设备故障的视觉出口 =================
   * worldstate 只产出数据（broken / flicker 相位），这里负责把它画出来：
   *   · 屏幕：故障时压暗并闪烁（相位由 worldstate 推进，保证与逻辑同步）
   *   · 状态灯：绿常亮 = 正常；红闪 = 故障中；橙常亮 = 已过最低停摆、等维修
   */
  const OK_GREEN = new THREE.Color(0x6FCF97);
  const BAD_RED = new THREE.Color(0xEB5757);
  const WAIT_AMBER = new THREE.Color(0xE8A94E);

  /**
   * 娃娃机玻璃柜的娃娃数（P0-4）。由 main 每帧按 state.deviceStock.claw 脏检查调用。
   *   n > 0 → 至少摆 CLAW_CABINET.minDolls 只（"摆满"的观感底线），最多 maxDolls 只
   *   n <= 0 → 娃娃全部隐藏（玻璃见底）+ 显示补货提示牌
   * 无论哪一档都不会出现"空着又什么都不说"的柜子 —— 空柜子是不可接受的观感事故。
   */
  /**
   * 诊断出口：娃娃机柜当前显示状态。
   * "见底必须挂补货提示"是外观契约，光看娃娃数看不出提示牌有没有真的露出来 ——
   * 探针据此断言「归零时 shown=0 且 hintVisible=true」，避免"柜子空了但什么都没说"。
   */
  function clawCabinetState() {
    const out = [];
    const wp = new THREE.Vector3();
    for (const [id, { dolls, hint }] of clawCabinets) {
      hint.getWorldPosition(wp);
      out.push({
        id,
        shown: dolls.children.filter((c) => c.visible).length,
        dollsVisible: dolls.visible,
        hintVisible: hint.visible,
        // 提示牌的世界坐标：光知道 visible=true 不够 —— 摆到画面外/被柜体挡住一样"看不见"
        hintAt: { x: +wp.x.toFixed(2), y: +wp.y.toFixed(2), z: +wp.z.toFixed(2) },
      });
    }
    return out;
  }

  function setClawCabinet(n) {
    const inCab = Math.max(0, Math.round(Number(n) || 0));
    const show = inCab > 0
      ? Math.min(CLAW_CABINET.maxDolls, Math.max(CLAW_CABINET.minDolls, inCab))
      : 0;
    for (const { dolls, hint } of clawCabinets.values()) {
      const list = dolls.children;
      for (let i = 0; i < list.length; i++) list[i].visible = i < show;
      dolls.visible = show > 0;
      hint.visible = show === 0;
    }
  }

  /**
   * @param devices worldstate.deviceList() —— [{ id, broken, flicker, awaitingRepair }]
   * @param levels  { [id]: 1..3 } 设备等级（需求I 第①条：外观随等级小幅变化）
   * @param opts    { now, blackout, lowStock }
   *   now      —— 秒（用于"慢闪"的相位；与 flicker 分开，两者频率不同）
   *   blackout —— 停电中：所有状态灯全灭（需求"停电：全灭"）
   *   lowStock —— Set<id>：库存将尽的设备（售货机 / 娃娃机）→ 黄灯慢闪
   */
  function updateDeviceVisuals(devices, levels, opts = {}) {
    if (!Array.isArray(devices)) return;
    const blackout = opts.blackout === true;
    const lowStock = opts.lowStock;
    const now = opts.now ?? 0;    // 慢闪：0.8Hz 方波。用 now 而不是 flicker —— 故障闪（7Hz）与"缺货慢闪"必须看得出区别
    const slowOn = Math.sin(now * Math.PI * 2 * 0.8) > 0;
    for (const d of devices) {
      const lamp = facilityLamps.get(d.id);
      const screen = facilityScreens.get(d.id);

      /* 等级灯带：lv1 不亮（保持需求G 的原样），lv2 / lv3 换色 */
      const rank = facilityRanks.get(d.id);
      if (rank) {
        const lv = Math.max(1, Math.round(levels?.[d.id] ?? 1));
        if (lv >= 2 && !blackout) {
          const tint = DEVICE_UPGRADE.tint[Math.min(lv, DEVICE_UPGRADE.tint.length) - 1] ?? 0x4FD1E8;
          rank.visible = true;
          rank.material.emissive.setHex(tint);
          rank.material.emissiveIntensity = 1.1;
        } else {
          rank.visible = false;
        }
      }

      // 停电：灯全灭、屏幕全黑（需求"停电：全灭"）—— 先于其它分支处理，优先级最高
      if (blackout) {
        if (lamp) lamp.material.emissiveIntensity = 0.0;
        if (screen) { screen.visible = false; }
        continue;
      }

      if (!d.broken) {
        if (lamp) {
          // 缺货（售货机 / 娃娃机）：黄灯慢闪；否则绿灯常亮
          const low = lowStock ? lowStock.has(d.id) : false;
          if (low) {
            lamp.material.emissive.copy(WAIT_AMBER);
            lamp.material.emissiveIntensity = slowOn ? 1.25 : 0.2;
          } else {
            lamp.material.emissive.copy(OK_GREEN);
            lamp.material.emissiveIntensity = 1.0;
          }
        }
        if (screen) {
          screen.visible = true;
          screen.material.emissiveIntensity = 0.85;
        }
        continue;
      }

      // 故障：屏幕用方波闪烁（相位来自 worldstate.flicker，逻辑与表现同源）
      const on = Math.sin(d.flicker * Math.PI * 2) > 0;
      if (screen) {
        screen.visible = on;
        screen.material.emissiveIntensity = on ? 0.25 : 0.05;
      }
      if (lamp) {
        if (d.awaitingRepair) {
          lamp.material.emissive.copy(WAIT_AMBER);
          lamp.material.emissiveIntensity = 1.1;
        } else {
          lamp.material.emissive.copy(BAD_RED);
          lamp.material.emissiveIntensity = on ? 1.4 : 0.25;
        }
      }
    }
  }

  /* ================= 可感知的反馈表现（需求：一眼看懂状态） =================
   * 情绪图标 / 粒子 / 远处指引点三件都在这里收口。
   * 全部走**对象池**：这些是高频增删的表现层，每帧新建/销毁 THREE 对象会让 GC 抖动，
   * 玩家会读成"卡了一下"。池子建好后就只切 visible / 改 position。
   */

  /** 画一张 64×64 的情绪图标。**不用 emoji**：emoji 字体在不同机器上形状差异极大，
   * 有的还会渲染成黑白轮廓，状态图标必须"任何机器上都一眼认得出"，所以手绘图形。 */
  const makeEmotionTexture = (kind) => {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 64;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    if (kind === 'alert') {
      // 红底圆角菱形 + 白"!"
      g.fillStyle = '#EB5757';
      g.beginPath();
      g.moveTo(32, 4); g.lineTo(60, 32); g.lineTo(32, 60); g.lineTo(4, 32);
      g.closePath();
      g.fill();
      g.strokeStyle = '#8C2F2F';
      g.lineWidth = 3;
      g.stroke();
      g.fillStyle = '#FFFFFF';
      g.font = 'bold 36px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('!', 32, 33);
    } else if (kind === 'wait') {
      // 灰气泡 + 白点（"还在等"）
      g.fillStyle = 'rgba(150,160,178,0.95)';
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(6, 12, 52, 34, 14);
      else g.rect(6, 12, 52, 34);
      g.fill();
      g.beginPath();
      g.moveTo(20, 44); g.lineTo(32, 58); g.lineTo(40, 44);
      g.closePath();
      g.fill();
      g.fillStyle = '#FFFFFF';
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.arc(20 + i * 12, 29, 4.5, 0, Math.PI * 2);
        g.fill();
      }
    } else if (kind === 'happy') {
      // 绿心（两个圆 + 一个三角，纯路径，不依赖字形）
      g.fillStyle = '#6FCF97';
      g.beginPath();
      g.arc(22, 24, 14, 0, Math.PI * 2);
      g.arc(42, 24, 14, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(8, 28); g.lineTo(56, 28); g.lineTo(32, 58);
      g.closePath();
      g.fill();
      g.strokeStyle = '#3E8C63';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(8, 28); g.lineTo(32, 58); g.lineTo(56, 28);
      g.stroke();
    } else if (kind === 'angry') {
      // 红脸 + 怒眉 + 撇嘴
      g.fillStyle = '#EB5757';
      g.beginPath();
      g.arc(32, 32, 26, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#8C2F2F';
      g.lineWidth = 3;
      g.stroke();
      g.fillStyle = '#FFFFFF';
      g.beginPath();
      g.arc(22, 30, 5, 0, Math.PI * 2);
      g.arc(42, 30, 5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(14, 18); g.lineTo(28, 24); g.stroke();  // 左怒眉
      g.beginPath(); g.moveTo(50, 18); g.lineTo(36, 24); g.stroke();  // 右怒眉
      g.beginPath(); g.moveTo(22, 48); g.quadraticCurveTo(32, 40, 42, 48); g.stroke(); // 撇嘴
    }
    const t = new THREE.CanvasTexture(cv);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  const EMO_TEX = {
    alert: makeEmotionTexture('alert'),
    wait: makeEmotionTexture('wait'),
    happy: makeEmotionTexture('happy'),
    angry: makeEmotionTexture('angry'),
  };

  const emoGroup = new THREE.Group();
  world.add(emoGroup);
  const EMO_POOL = 20;
  const emoPool = [];
  for (let i = 0; i < EMO_POOL; i++) {
    const mat = new THREE.SpriteMaterial({ map: EMO_TEX.alert, transparent: true, depthTest: true, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.34, 0.34, 1);
    sp.visible = false;
    emoGroup.add(sp);
    emoPool.push(sp);
  }

  /**
   * 同步头顶情绪图标。
   * @param list [{ x, y, z, kind }] kind ∈ alert | wait | happy | angry
   */
  function setEmotions(list) {
    const n = Math.min(Array.isArray(list) ? list.length : 0, emoPool.length);
    for (let i = 0; i < emoPool.length; i++) {
      const sp = emoPool[i];
      if (i >= n) { sp.visible = false; continue; }
      const e = list[i];
      const tex = EMO_TEX[e.kind] ?? EMO_TEX.alert;
      if (sp.material.map !== tex) { sp.material.map = tex; sp.material.needsUpdate = true; }
      sp.position.set(e.x, (e.y ?? 2.0) + Math.sin(fbTime * 3.2 + i) * 0.05, e.z);
      sp.visible = true;
    }
  }

  /* ---------- 粒子（清理垃圾 / 修好机器的一小撮反馈） ---------- */
  const PARTICLE_MAX = 72;
  const pPos = new Float32Array(PARTICLE_MAX * 3);
  const pCol = new Float32Array(PARTICLE_MAX * 3);
  const pVel = new Float32Array(PARTICLE_MAX * 3);
  const pLife = new Float32Array(PARTICLE_MAX);
  const pMax = new Float32Array(PARTICLE_MAX);
  const pBase = new Float32Array(PARTICLE_MAX * 3);
  let pCursor = 0;
  for (let i = 0; i < PARTICLE_MAX; i++) pPos[i * 3 + 1] = -100;  // 先全部藏到地下

  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 0.055, vertexColors: true, sizeAttenuation: true,
    transparent: true, depthWrite: false,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  world.add(points);

  /**
   * 在某处爆一小撮粒子。
   * @param kind 'spark'（维修火花，暖黄、短促、向上）| 'paper'（纸屑飞走，浅色、飘散）
   */
  function burst(x, z, kind = 'spark') {
    const count = kind === 'spark' ? 14 : 10;
    for (let k = 0; k < count; k++) {
      const i = pCursor;
      pCursor = (pCursor + 1) % PARTICLE_MAX;
      const a = Math.random() * Math.PI * 2;
      const sp = kind === 'spark' ? 0.6 + Math.random() * 1.4 : 0.4 + Math.random() * 0.9;
      pPos[i * 3] = x + (Math.random() - 0.5) * 0.16;
      pPos[i * 3 + 1] = kind === 'spark' ? 0.55 + Math.random() * 0.2 : 0.06 + Math.random() * 0.1;
      pPos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.16;
      pVel[i * 3] = Math.cos(a) * sp;
      pVel[i * 3 + 1] = kind === 'spark' ? 1.1 + Math.random() * 1.3 : 0.5 + Math.random() * 0.7;
      pVel[i * 3 + 2] = Math.sin(a) * sp;
      pLife[i] = pMax[i] = kind === 'spark' ? 0.42 : 1.0;
      // 颜色：火花暖黄偏白，纸屑米白
      const c = kind === 'spark'
        ? [1.0, 0.72 + Math.random() * 0.28, 0.28]
        : [0.86, 0.83, 0.72];
      pBase[i * 3] = c[0]; pBase[i * 3 + 1] = c[1]; pBase[i * 3 + 2] = c[2];
      pCol[i * 3] = c[0]; pCol[i * 3 + 1] = c[1]; pCol[i * 3 + 2] = c[2];
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  /* ---------- 收银飞钱（2026-10-06 块3） ----------
   * 需求：收银时"钱从顾客到收银台"的小幅飞行动画。做法：一枚金币 mesh
   * 沿抛物线从顾客脚边飞到收银台上方，途中逐渐缩小并淡出。
   *
   * 为什么不用 burst()：那是"向上炸开 + 落地"的地面粒子，语义是火花/纸屑。
   * 钱的语义是"从 A 点移动到 B 点"，用移动的 mesh 才读得出来 ——
   * 粒子群从 A 炸到 B，视觉上就是"炸了一堆灰"。
   *
   * 刻意做得很小（半径 0.03、飞 0.42s、缩到 0.2）：需求要的是"小幅反馈"，
   * 不是特效秀。粒子数也控制在 1~3 枚，避免手机端在收银瞬间掉帧。
   */
  const coinFlights = [];   // { mesh, t, from: Vector3, to: Vector3 }
  let coinMeshProto = null;
  function flyCoins(fromX, fromZ, toX, toZ, n = 3) {
    if (!world) return;
    if (!coinMeshProto) {
      coinMeshProto = new THREE.Mesh(
        new THREE.CylinderGeometry(0.030, 0.030, 0.008, 12),
        new THREE.MeshStandardMaterial({ color: 0xF2C879, metalness: 0.6, roughness: 0.3 }),
      );
    }
    const count = Math.max(1, Math.min(3, n | 0));
    for (let k = 0; k < count; k++) {
      const m = coinMeshProto.clone();
      // 起点在顾客脚下略偏一点（不是所有钱从同一点飞出）
      const fx = fromX + (Math.random() - 0.5) * 0.3;
      const fz = fromZ + (Math.random() - 0.5) * 0.3;
      m.position.set(fx, 1.0, fz);
      world.add(m);
      coinFlights.push({
        mesh: m,
        t: -k * 0.07,                                  // 错开一点，像一枚枚抛过去
        from: new THREE.Vector3(fx, 1.0, fz),
        to: new THREE.Vector3(toX, 1.05, toZ),
        spin: 6 + Math.random() * 5,
      });
    }
  }
  const COIN_FLY_SEC = 0.42;
  function tickCoinFlights(dt) {
    for (let p = coinFlights.length - 1; p >= 0; p--) {
      const c = coinFlights[p];
      c.t += dt / COIN_FLY_SEC;
      if (c.t < 0) { c.mesh.visible = false; continue; }   // 还没轮到起飞
      c.mesh.visible = true;
      const k = Math.min(1, c.t);
      c.mesh.position.lerpVectors(c.from, c.to, k);
      // 抛物线：中途抬高 0.22m，比直线更像"抛"
      c.mesh.position.y += Math.sin(k * Math.PI) * 0.22;
      // 旋转（金币翻滚）+ 缩小消失
      c.mesh.rotation.x += dt * c.spin;
      c.mesh.rotation.z += dt * c.spin * 0.6;
      const s = 1 - 0.8 * k;                            // 1 → 0.2
      c.mesh.scale.setScalar(Math.max(0.05, s));
      if (k >= 1) {
        world.remove(c.mesh);                           // 不用 dispose：几何/材质是共享 proto 的
        coinFlights.splice(p, 1);
      }
    }
  }

  /* ---------- 远处指引小圆点（坏机器 / 缺货机器在暗店里找不到） ---------- */
  const beaconGroup = new THREE.Group();
  world.add(beaconGroup);
  const beaconTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(cv);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const BEACON_POOL = 8;
  const beacons = [];
  for (let i = 0; i < BEACON_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: beaconTex, transparent: true, depthTest: false, depthWrite: false,
      color: 0xEB5757, opacity: 0.9,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.4, 0.4, 1);
    sp.renderOrder = 20;   // 永远浮在场景之上，暗店里也能被看见
    sp.visible = false;
    beaconGroup.add(sp);
    beacons.push(sp);
  }

  /**
   * 同步远处的指引点。
   * @param list [{ x, y, z, kind }] kind: 'broken'（红） | 'stock'（黄）
   */
  function setBeacons(list) {
    const n = Math.min(Array.isArray(list) ? list.length : 0, BEACON_POOL);
    for (let i = 0; i < BEACON_POOL; i++) {
      const sp = beacons[i];
      if (i >= n) { sp.visible = false; continue; }
      const b = list[i];
      sp.material.color.setHex(b.kind === 'stock' ? 0xE8A94E : 0xEB5757);
      const bob = Math.sin(fbTime * 2.6 + i) * 0.09;
      sp.position.set(b.x, (b.y ?? 2.5) + bob, b.z);
      sp.material.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(fbTime * 3.4 + i));
      sp.visible = true;
    }
  }

  /** 反馈层统一推进（情绪浮动 / 粒子 / 指引点呼吸）。 */
  let fbTime = 0;
  /* ---------- 上货放置动画（2026-10-05 升级：逐件放入） ----------
   * 2026-10-06 反馈：不是"拖"，是选中格子直接放、一件一件放进去。
   * 所以动画改为**逐件递进**：pulseSlot(i, putQty) 先把该格视觉件数压回放前值，
   * 再在 PULSE_DURATION 内逐件亮起（每件带一次落位弹跳），模拟"一件一件放进去"。
   * 音效由 main.mjs 按视觉步数播放（每件一声 tick + 完成确认音）。
   * 推进放 updateFeedback（每帧有 dt 才跑）；动画结束清 slotCache 强制一次真实重绘。 */
  const placeAnims = [];   // { i, cur, target, t, lastStep }
  const PULSE_DURATION = 0.6;
  function pulseSlot(i, putQty = 1) {
    const items = slotItems[i];
    if (!items) return;
    const cur = items.slots.filter((h) => h.visible).length;      // 放前视觉件数
    const inc = Math.max(1, Math.round(8 * (putQty | 0) / SLOT_CAP)); // 视觉增量
    placeAnims.push({ i, cur, target: cur + inc, t: 0, lastStep: cur });
  }
  /* ---------- 清仓：格子变暗再清空（2026-10-06 块3） ----------
   * 需求：清仓不该"瞬间消失"。做法分两段：
   *   ① 0.28s 内所有商品材质压暗（emissive 归零 + 乘 0.45）并轻微下沉
   *   ② 之后直接隐藏（真清空），由 updateSlotVisual 的脏检查接管空架态
   *
   * 压暗用 material.color 缩放而不是加一层黑面片：黑面片会挡住标签、
   * 在斜视时穿出商品体积；改颜色是"这件货变旧了/被打下来了"的语义，更贴。
   * 材质是 prodMatTx/prodMat 的**共享缓存**，所以只能改不能换 ——
   * 动画结束时必须还原，否则同一 SKU 的其它格子会被永久压暗。
   */
  const clearAnims = [];   // { i, t, holders, mats }
  function fadeOutSlot(i) {
    const items = slotItems[i];
    if (!items) return;
    const holders = items.slots.filter((h) => h.visible);
    if (!holders.length) return;
    /* 收集**去重后的材质**而不是只记 holder：
     * 材质是 prodMat/prodMatTx 的全局共享缓存（同一 SKU 的所有格子共用一份），
     * 只还原"这批 holder 用到的"看似够用，实则漏了一种情况 ——
     * 动画播放期间玩家在同一格补了同 SKU 的货，新商品的 mesh 拿的是**同一份材质**，
     * 它会跟着一起变暗，而它并不在 a.holders 里、也就不会被还原 → 那个格子永久变暗。
     * 收集材质数组 + Set 去重，保证"凡是动过的都还原"。 */
    const mats = new Set();
    for (const h of holders) {
      h.traverse((o) => {
        if (!o.material || !o.material.color) return;
        if (o.userData._fadeBase === undefined) o.userData._fadeBase = o.material.color.getHex();
        /* 基准色记在**材质**上（userData），不只在 mesh 上：
         * 还原时按材质统一处理，mesh 那边只清标记。 */
        const m = o.material;
        if (m.userData._fadeBaseHex === undefined) m.userData._fadeBaseHex = o.userData._fadeBase;
        mats.add(m);
      });
    }
    clearAnims.push({ i, t: 0, holders, mats: [...mats] });
  }
  const CLEAR_FADE_SEC = 0.28;
  function tickClearFades(dt) {
    for (let p = clearAnims.length - 1; p >= 0; p--) {
      const a = clearAnims[p];
      a.t = Math.min(1, a.t + dt / CLEAR_FADE_SEC);
      const k = 1 - a.t;                       // 1 → 0
      for (const h of a.holders) {
        h.traverse((o) => {
          if (!o.material || !o.material.color) return;
          const base = o.userData._fadeBase;
          if (base === undefined) return;
          /* 亮度系数：从 1（正常）线性降到 0.45（暗）。
           * 三个通道同乘一个系数 —— 等于"整体变暗"而不是"偏色"，
           * 语义是"这批货被打下来了"，不是"换了个颜色的货"。
           *
           * 用「基准色 × 当前系数」而不是「在当前色上再乘」——
           * 后者在两格同 SKU 先后清仓时会指数级变暗（第二次乘的是已经暗过的值）。 */
          const dim = 1 - 0.55 * a.t;
          o.material.color.setRGB(
            (((base >> 16) & 255) / 255) * dim,
            (((base >> 8) & 255) / 255) * dim,
            ((base & 255) / 255) * dim,
          );
        });
        h.position.y -= dt * 0.02;              // 轻微下沉
      }
      if (a.t >= 1) {
        /* 还原：按记录的基准色 setHex 回去，而不是"再乘一遍 dim 的倒数"。
         * 共享材质只能这样还原 —— 一旦漏了，同 SKU 的其它格子会永久变暗。 */
        for (const m of a.mats) {
          const base = m.userData?._fadeBaseHex;
          if (base !== undefined) m.color.setHex(base);
        }
        for (const h of a.holders) {
          h.traverse((o) => { if (o.userData._fadeBase !== undefined) delete o.userData._fadeBase; });
          h.visible = false;
        }
        slotCache[a.i] = '';                   // 让 updateSlotVisual 重绘空架态
        clearAnims.splice(p, 1);
      }
    }
  }

  function easeOutBack(k) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  }
  function tickPlacePulses(dt) {
    for (let p = placeAnims.length - 1; p >= 0; p--) {
      const a = placeAnims[p];
      a.t = Math.min(1, a.t + dt / PULSE_DURATION);
      const holders = slotItems[a.i]?.slots ?? [];
      const cur = a.cur + Math.round(a.t * (a.target - a.cur));
      holders.forEach((h, idx) => { h.visible = idx < cur; });   // 逐件亮起
      if (cur > a.lastStep) {                                     // 新落位的一件弹跳
        a.lastStep = cur;
        const h = holders[cur - 1];
        if (h) { h.scale.setScalar(0.35); h.userData.popT = 0; }
      }
      for (const h of holders) {                                  // 弹跳回位
        if (h.userData.popT !== undefined) {
          h.userData.popT = Math.min(1, h.userData.popT + dt / 0.22);
          h.scale.setScalar(0.35 + 0.65 * easeOutBack(h.userData.popT));
          if (h.userData.popT >= 1) { h.scale.setScalar(1); delete h.userData.popT; }
        }
      }
      if (a.t >= 1) {
        for (const h of holders) h.scale.setScalar(1);
        slotCache[a.i] = '';   // 动画结束：强制下一帧 updateSlotVisual 重绘真实状态
        placeAnims.splice(p, 1);
      }
    }
  }

  function updateFeedback(dt) {
    if (!(dt > 0)) return;
    fbTime += dt;
    tickPlacePulses(dt);
    tickClearFades(dt);
    tickCoinFlights(dt);
    tickPromoFlash(dt);
    // 粒子积分：火花的重力大、纸屑轻（飘）
    for (let i = 0; i < PARTICLE_MAX; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      if (pLife[i] <= 0) {
        pPos[i * 3 + 1] = -100;
        continue;
      }
      pVel[i * 3 + 1] -= (pBase[i * 3] > 0.9 ? 6.5 : 2.2) * dt;  // 火花坠得快，纸屑轻飘
      pPos[i * 3] += pVel[i * 3] * dt;
      pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
      pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      if (pPos[i * 3 + 1] < 0.02) { pPos[i * 3 + 1] = 0.02; pVel[i * 3 + 1] *= -0.3; }
      // 颜色随寿命衰减（暗场景里等价于淡出，且不需要逐粒子材质）
      const f = pLife[i] / pMax[i];
      pCol[i * 3] = pBase[i * 3] * f;
      pCol[i * 3 + 1] = pBase[i * 3 + 1] * f;
      pCol[i * 3 + 2] = pBase[i * 3 + 2] * f;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  /* ================= 昼夜光照的应用 =================
   * daynight.mjs 只产出一组纯数值，这里把它落到具体的灯与雾上。
   * 拆分的意义：daynight 可以脱离 WebGL 单测，scene 只做机械的赋值。 */
  const bgColor = new THREE.Color(0x141A24);

  function applyDayNight(s) {
    if (!s) return;
    ambient.intensity = s.ambientIntensity;
    hemi.intensity = s.hemiIntensity;
    for (const l of neonLights) {
      l.intensity = (l.userData.baseIntensity ?? 1) * s.neonIntensity;
    }
    for (const l of downLights) {
      l.intensity = (l.userData.baseIntensity ?? 1) * s.downlightIntensity;
    }
    bgColor.setHex(s.background);
    scene.background = bgColor;
    if (scene.fog) {
      scene.fog.near = s.fogNear;
      scene.fog.far = s.fogFar;
    }
  }

  /* ---------- 第一人称手部（P0-3 重做） ----------
   * 原来只有一个**永远可见**的米色方块（handMesh）钉在右下角 —— 那就是玩家抱怨的
   * "视角右下角永远漂浮一个米色方块"。正确做法：
   *   · 空手 → 显示第一人称手臂（前臂 + 手掌），有"人在这里"的存在感
   *   · 有货 → 显示抱箱模型（箱子随 SKU 上色）
   *   · 空手时**不显示任何方块**
   */
  const hands = new THREE.Group();

  // 空手：前臂 + 手掌（右下角，跟随镜头）
  const armGroup = new THREE.Group();
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x2E6E8F, roughness: 0.9 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: 0x21506A, roughness: 0.85 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xE0A97E, roughness: 0.82 });
  {
    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.34, 4, 8), sleeveMat);
    forearm.position.set(0.30, -0.40, -0.38);
    forearm.rotation.set(-1.22, 0.10, 0.20);
    armGroup.add(forearm);

    /* 掌 + 四指 + 拇指。
     * 只用一块盒当"掌"的话，空手时右下角看起来仍然是"一块米色方块"——
     * 那正是玩家最初抱怨的东西。必须让轮廓读成**手**：加四根手指和一根拇指，
     * 指节微微内屈，一眼就能认出是握空的第一人称手。 */
    const hand = new THREE.Group();
    hand.position.set(0.30, -0.255, -0.60);
    hand.rotation.set(-0.30, 0.12, 0.08);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.098, 0.034, 0.105), skinMat);
    hand.add(palm);
    const fingerGeo = new THREE.CapsuleGeometry(0.0135, 0.052, 3, 6);
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(fingerGeo, skinMat);
      finger.position.set(-0.036 + f * 0.024, 0.002, -0.078 - Math.abs(f - 1.5) * 0.006);
      finger.rotation.set(-0.34, 0, 0);
      hand.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.05, 3, 6), skinMat);
    thumb.position.set(-0.056, -0.004, -0.03);
    thumb.rotation.set(-0.2, 0, 0.95);
    hand.add(thumb);
    armGroup.add(hand);

    // 袖口（把前臂和掌接上，避免"一块悬空的肉色")
    const cuff = new THREE.Mesh(new THREE.CapsuleGeometry(0.068, 0.06, 4, 8), cuffMat);
    cuff.position.set(0.30, -0.30, -0.50);
    cuff.rotation.set(-1.22, 0.10, 0.20);
    armGroup.add(cuff);
  }
  hands.add(armGroup);

  // 抱货：纸箱 + 封箱胶带（随 SKU 上色；空手时整组隐藏）
  const carryGroup = new THREE.Group();
  const heldMesh = boxColor(0.28, 0.23, 0.23, 0xffffff, { roughness: 0.88 });
  heldMesh.position.set(0.14, -0.36, -0.64);
  carryGroup.add(heldMesh);
  const tapeMesh = boxColor(0.28, 0.034, 0.05, 0xC79A6B, { roughness: 0.9 });
  tapeMesh.position.set(0.14, -0.36, -0.52);
  carryGroup.add(tapeMesh);
  // 两只前臂从下方托住箱子。没有它们，"抱箱"会读成一块**悬空的方块** ——
  // 正是玩家最初抱怨的那种观感；有了托举的前臂才像"抱着货在走"。
  for (const sgn of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.30, 4, 8), sleeveMat);
    arm.position.set(0.14 + sgn * 0.25, -0.56, -0.46);
    arm.rotation.set(-0.9, 0, sgn * 0.24);
    carryGroup.add(arm);
  }
  carryGroup.visible = false;
  hands.add(carryGroup);

  camera.add(hands);
  scene.add(camera); // 相机加入场景，子对象才会渲染

  /* ---------- 表现同步（脏检查） ---------- */
  const slotCache = slotLabels.map(() => '');

  /** 把某格的商品模型刷成指定 SKU / 数量（P0-1：多色多形状、卖空见底、0 空置） */
  /**
   * 摆放错开层次（2026-10-06 块1 · 需求3）。
   *
   * 原来 8 个占位是"整齐排队"：同一条 y、同一套朝向，看起来像一排复制粘贴。
   * 现在给每个占位一个**确定性的**错落量（由 slotIndex/k 推出，不用 Math.random）：
   *   · 高度 ±0.006m —— 前后错开，像手摆上去的
   *   · 绕 Y 轴 ±0.22rad —— 有的正面朝外、有的侧着，像被翻过
   *   · 水平 ±0.012m —— 前后微错，避免连成一条笔直的线
   *   · 后排（board 1）额外抬高一点点，形成"里侧堆更高"的层次
   *
   * 为什么必须确定性：Math.random() 会让每次重绘（脏检查失效时）商品位置全变，
   * 玩家正看着货架却见商品集体跳位 —— 观感比整齐更糟。错落量一旦由
   * (slotIndex, k) 决定就永远稳定，只有换 SKU/换格时才重排。
   */
  const JITTER = (slotIndex, k, board) => {
    // 用两个互质乘数做简易散列，避免相邻 (slot,k) 拿到同一位移
    const h = (slotIndex * 7 + k * 13 + board * 29) % 1000;
    const a = (h % 100) / 100;          // 0..1
    const b = ((h * 7) % 100) / 100;    // 另一条散列
    return {
      dy: (a - 0.5) * 0.012,
      dx: (b - 0.5) * 0.024,
      rotY: (a - 0.5) * 0.44,
      // 里侧层板抬高一档：真实堆货时后排会靠上一点，形成两层高度差
      lift: board === 1 ? 0.010 : 0,
    };
  };

  /* ---------- 促销标签闪一下（2026-10-06 块3） ----------
   * 需求：促销开启时货架标签闪一下。实现：记下"促销从关到开"的那一刻，
   * 之后 0.9s 内让所有在售格的标签 sprite 做 3 次缩放脉冲。
   *
   * 为什么用缩放而不是改颜色：颜色已经被 onPromo 的橙红 tint 占用了（那是持续状态），
   * 闪色会和它打架；缩放是"跳动"，读起来是"刚刚发生了什么"，不冲突。
   * 只动 scale 不动位置 —— 标签有固定的世界锚点，位移会让它飘离货架。
   */
  let promoFlashT = -1;          // -1 = 不在闪
  let promoWasOn = false;
  const PROMO_FLASH_SEC = 0.9;
  function notePromoState(on) {
    if (on && !promoWasOn) promoFlashT = 0;   // 关→开的那一刻开始闪
    promoWasOn = on;
  }
  function tickPromoFlash(dt) {
    if (promoFlashT < 0) return;
    promoFlashT += dt;
    if (promoFlashT >= PROMO_FLASH_SEC) { promoFlashT = -1; resetLabelScale(); return; }
    // 3 次脉冲：每个周期 0.3s，用 sin 的半波做"闪"（0 → 大 → 0）
    const k = (promoFlashT % 0.3) / 0.3;
    const s = 1 + 0.22 * Math.sin(k * Math.PI);
    for (const lab of slotLabels) {
      if (!lab?.sprite) continue;
      if (!lab.sprite.visible) continue;
      lab.sprite.scale.setScalar(lab.baseScale * s);
    }
  }
  /** 复位所有标签缩放（闪完必须复位，否则标签会一直偏大） */
  function resetLabelScale() {
    for (const lab of slotLabels) {
      if (!lab?.sprite || lab.baseScale === undefined) continue;
      lab.sprite.scale.setScalar(lab.baseScale);
    }
  }

  function applyShelfItems(items, sku, qty, slotIndex) {
    if (!items) return;
    const shown = Math.min(items.slots.length, Math.max(0, Math.round(qty)));
    for (let k = 0; k < items.slots.length; k++) {
      const holder = items.slots[k];
      if (k >= shown) { holder.visible = false; continue; }
      // 变体由"格位 + 列位"决定：相邻格位错位取值 → 同一排货架不会两格一模一样
      const variant = productVariant(sku.id, slotIndex, k);
      const key = variant ? `${variant.shape}|${variant.color}|${variant.accent}` : 'none';
      if (holder.userData.variantKey !== key) {
        holder.userData.variantKey = key;
        for (const child of [...holder.children]) holder.remove(child);
        if (variant) {
          const built = buildProduct(variant);
          holder.add(built.group);
          holder.userData.h = built.h;
        }
      }
      holder.visible = !!variant;
      if (variant) {
        // 按层板顶面 + 该形状半高落位 —— 不同形状高度不同，避免陷进板里或悬空
        const j = JITTER(slotIndex, k, holder.userData.board);
        // ⚠ x 必须是「列基准位 + 错落」，不能只用 j.dx：
        // 列基准位由 buildSlots 建 holder 时按 k%4 铺开（-0.5/0.33 步距），
        // 8 件商品各占一列；若这里只写 j.dx（±0.012m）而丢掉列基准，
        // 8 个占位会全部挤到格子中心叠成一坨 —— 正是"摆放层次"想要的结果的反面。
        const baseX = -0.5 + (holder.userData.col % 4) * 0.33;
        holder.position.set(baseX + j.dx, BOARD_TOP[holder.userData.board] + (holder.userData.h ?? 0.1) / 2 + j.dy + j.lift, 0);
        holder.rotation.y = j.rotY;
      }
    }
  }

  function updateSlotVisual(st) {
    for (let i = 0; i < slotMeshes.length; i++) {
      const slot = st.slots[i];
      const items = slotItems[i];
      if (!items) continue;
      const sku = slot?.skuId ? SKU_BY_ID[slot.skuId] : null;

      if (!sku || slot.qty <= 0) {
        if (slotCache[i] !== 'empty') {
          if (items.kindKey) { for (const h of items.slots) h.visible = false; }
          items.kindKey = '';
          drawLabel(slotLabels[i].canvas, slotLabels[i].tex, {
            emoji: '⬜', title: '空货架', sub: '按 E 上货', tint: '#6B7484',
          });
          slotCache[i] = 'empty';
        }
        continue;
      }

      const near = slot.expiryNight <= st.night;
      const price = st.prices[sku.id] ?? sku.price;
      /* 2026-10-05 促销可视化：促销期间货架标签显示"特价"并橙红高亮，
       * 玩家一眼看出哪些货在打折（折扣 = PRICING.promo.mul 0.9，写死避免循环依赖）。 */
      const onPromo = st.promoUntil != null && st.promoUntil !== undefined && (st.wallElapsed ?? 0) < st.promoUntil;
      notePromoState(onPromo);   // 2026-10-06 块3：检测促销开启瞬间以触发标签闪
      const shownPrice = onPromo ? Math.round(price * 0.9 * 100) / 100 : price;
      const labelTint = onPromo ? '#F06C3C' : (near ? '#E8A94E' : '#E6E2D6');
      const labelSub = onPromo
        ? `${fmtYuan(shownPrice)} 🔥特价${near ? ' ⚠今夜到期' : ''}`
        : `${fmtYuan(price)}${near ? ' ⚠今夜到期' : ''}`;
      /* 视觉商品数随 qty 按比例变化（最多 8 个占位）：货架容量 24，8 个位置摆不下
       * 全部货物，但若固定显示 8 个，满架买走几件后商品模型一个不少、观感"没变化"。
       * 按 8×qty/容量 取整：24→8、21→7、12→4、8→3、1→1（有货至少 1 个）。 */
      const shown = Math.min(8, Math.max(1, Math.round(8 * slot.qty / SLOT_CAP)));
      /* 脏检查 key 必须用**真实 qty** 而不是 shown：用 shown 的话 qty 从 24 卖到 21 时
       * shown 恒为 8 → key 不变 → 整个格子跳过重绘，标签数字也停在旧值
       * （2026-10-05 反馈"买完货架上的数量没变"）。 */
      const key = `${sku.id}|${slot.qty}|${shownPrice}|${near ? 1 : 0}|${onPromo ? 1 : 0}`;
      if (slotCache[i] === key) continue;
      slotCache[i] = key;

      applyShelfItems(items, sku, shown, i);
      drawLabel(slotLabels[i].canvas, slotLabels[i].tex, {
        emoji: sku.emoji,
        title: `${slot.qty}`,
        sub: labelSub,
        tint: labelTint,
      });
    }
  }

  let handsKey = '';
  function updateHands(st) {
    const key = st.held ? `${st.held.skuId}|${st.held.qty}` : 'none';
    if (key === handsKey) return;
    handsKey = key;
    const holding = !!(st.held && SKU_BY_ID[st.held.skuId]);
    // 空手 → 手臂；有货 → 抱箱。两者互斥，空手不再有任何方块（P0-3）
    armGroup.visible = !holding;
    carryGroup.visible = holding;
    if (holding) {
      heldMesh.material.color.setHex(SKU_BY_ID[st.held.skuId].color);
      // 抱得多一点 → 箱子略大，体现"手上这份货"的分量
      const s = Math.min(1.35, 0.9 + st.held.qty * 0.05);
      carryGroup.scale.setScalar(s);
    }
  }

  /** 小吃摊：摊主待机呼吸 + 锅摇 + 铲翻（纯代码 lerp 循环，无外部动画资源） */
  function updateSnack(dt) {
    const a = stallAnim;
    if (!a) return;
    a.t += dt;
    a.pan.rotation.z = Math.sin(a.t * 3.0) * 0.22;             // 平底锅左右摇
    a.spatula.rotation.x = -0.3 + Math.sin(a.t * 4.5) * 0.5;  // 铲上下翻
    a.vendor.update(dt, false, null);                         // 摊主待机呼吸
  }

  /** 钓鱼池塘：水面顶点起伏（涟漪）+ 鱼轻微浮动（纯几何动画，无外部资源） */
  function updatePond(dt) {
    if (!pondAnim) return;
    pondAnim.t += dt;
    const arr = pondAnim.waterGeo.attributes.position.array;
    const base = pondAnim.base;
    for (let i = 0; i < arr.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      arr[i + 2] = Math.sin(x * 1.6 + pondAnim.t * 1.4) * 0.035
                + Math.sin(y * 1.3 + pondAnim.t * 1.1) * 0.03;
    }
    pondAnim.waterGeo.attributes.position.needsUpdate = true;
    for (const f of pondAnim.fish) {
      f.position.y = 0.08 + Math.sin(pondAnim.t * 1.5 + f.userData.ph) * 0.05;
      f.rotation.y += dt * 0.3;
    }
  }

  /** 重建地面与外墙（扩建后边界外扩 + 打通门洞）。见 buildShell 的注释 */
  function rebuildShell(bounds, gates = {}) {
    buildShell(bounds, gates);
  }

  /**
   * 解锁一处扩建：显示区域铺装、把附赠设施挂回交互列表、点亮该区的灯。
   * @returns 本次解锁的设施定义数组（main 用它去注册碰撞体与设施表）
   */
  /* ================= 环境互动（深夜猫 / 外卖员 / 墙上老电视） =================
   * 三个对象都是"可交互的道具"，走 interaction 的 ambient 分支（见 interaction.mjs）。
   * 判定盒做法与设施一致：不可见 mesh + userData.interact='ambient'。 */

  const ambientHits = [];
  const ambientActors = new Map();

  function makeAmbientActor(kind, build, x, z, hitW, hitH) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    build(g);
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(hitW, hitH ?? 1.2, hitW),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = (hitH ?? 1.2) / 2;
    hit.userData = { interact: 'ambient', ambientId: kind };
    g.add(hit);
    ambientHits.push(hit);
    g.visible = false;
    world.add(g);
    ambientActors.set(kind, g);
    return g;
  }

  /** 深夜猫：低多边形（身体 + 头 + 双耳 + 尾巴），蹲在店门内侧 */
  makeAmbientActor('cat', (g) => {
    const body = boxColor(0.34, 0.2, 0.16, 0x4A4A55, { roughness: 0.9 });
    body.position.y = 0.16;
    g.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0x5A5A66, roughness: 0.9 }),
    );
    head.position.set(0.17, 0.3, 0);
    g.add(head);
    for (const dz of [-0.06, 0.06]) {
      const ear = new THREE.Mesh(
        new THREE.ConeGeometry(0.045, 0.09, 4),
        new THREE.MeshStandardMaterial({ color: 0x5A5A66, roughness: 0.9 }),
      );
      ear.position.set(0.17, 0.4, dz);
      g.add(ear);
    }
    const tail = boxColor(0.05, 0.05, 0.22, 0x4A4A55, { roughness: 0.9 });
    tail.position.set(-0.2, 0.24, 0);
    tail.rotation.z = 0.6;
    g.add(tail);
  }, 1.8, 3.7, 0.7, 0.6);

  /** 外卖员 / 送货员：简化人形（躯干 + 头 + 手里的箱子），站在门外 */
  makeAmbientActor('courier', (g) => {
    const torso = boxColor(0.36, 0.62, 0.24, 0x2F6E8F, { roughness: 0.85 });
    torso.position.y = 0.72;
    g.add(torso);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xE8C9A0, roughness: 0.9 }),
    );
    head.position.y = 1.2;
    g.add(head);
    const parcel = boxColor(0.3, 0.28, 0.26, 0xB98A2E, { roughness: 0.9 });
    parcel.position.set(0.28, 0.72, 0.1);
    g.add(parcel);
    for (const dx of [-0.1, 0.1]) {
      const leg = boxColor(0.12, 0.42, 0.14, 0x232A38, { roughness: 0.9 });
      leg.position.set(dx, 0.21, 0);
      g.add(leg);
    }
  }, 0, 6.2, 0.9, 1.6);

  /** 墙上老电视：挂在店内西墙高处，带一个显示节目的标牌 */
  let tvLabel = null;
  let tvScreen = null;
  {
    const g = new THREE.Group();
    g.position.set(-6.72, 0, 0);
    g.rotation.y = Math.PI / 2;   // 屏幕朝向店内（+X）
    const shell = box(0.14, 0.72, 1.05, 'wood', 1);
    shell.position.y = 2.3;
    g.add(shell);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.58), MATS.screen.clone());
    scr.position.set(0.08, 2.3, 0);
    g.add(scr);
    tvScreen = scr;
    const lab = makeLabelSprite();
    lab.sprite.position.set(0, 2.82, 0);
    g.add(lab.sprite);
    tvLabel = lab;
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 1.0, 1.1),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 2.3;
    hit.userData = { interact: 'ambient', ambientId: 'tv' };
    g.add(hit);
    ambientHits.push(hit);
    world.add(g);
    ambientActors.set('tv', g);
  }

  /* ================= 疲劳系统：咖啡机 / 洗手台（常驻可交互点） =================
   * 与猫/外卖员不同：这两者是**常驻**的（一直可见、不随时间出现消失）。
   * 咖啡机买了 upgrade 才亮起可交互，洗手台恒可交互。
   * 交互判定走 ambient 分支，main 的 ambientHint 决定"能不能用"。 */
  {
    // 咖啡机：摆在收银台旁，一个小机身 + 出水口 + 杯托
    const g = new THREE.Group();
    g.position.set(2.4, 0, 1.9);
    const body = boxColor(0.42, 0.66, 0.42, 0x3A3A46, { roughness: 0.7 });
    body.position.y = 0.33;
    g.add(body);
    const head = boxColor(0.42, 0.16, 0.3, 0x2A2A34, { roughness: 0.7 });
    head.position.set(0, 0.74, -0.06);
    g.add(head);
    const spout = boxColor(0.08, 0.1, 0.16, 0x888894, { roughness: 0.6 });
    spout.position.set(0, 0.55, 0.22);
    g.add(spout);
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.07, 0.14, 12),
      new THREE.MeshStandardMaterial({ color: 0xD8C9A0, roughness: 0.85 }),
    );
    cup.position.set(0, 0.14, 0.22);
    g.add(cup);
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 1.1, 0.8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 0.55;
    hit.userData = { interact: 'ambient', ambientId: 'coffee' };
    g.add(hit);
    ambientHits.push(hit);
    world.add(g);
    ambientActors.set('coffee', g);
  }
  {
    // 洗手台：靠墙一个台面 + 水龙头 + 面盆
    const g = new THREE.Group();
    g.position.set(-2.6, 0, 5.6);
    const top = boxColor(1.0, 0.12, 0.5, 0xC8C4BC, { roughness: 0.6 });
    top.position.y = 0.86;
    g.add(top);
    const basin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.2, 0.12, 16),
      new THREE.MeshStandardMaterial({ color: 0xE8E4DC, roughness: 0.5 }),
    );
    basin.position.set(0.1, 0.8, 0);
    g.add(basin);
    const tap = boxColor(0.06, 0.2, 0.06, 0x9A9AA4, { roughness: 0.4 });
    tap.position.set(0.1, 0.98, -0.06);
    g.add(tap);
    const legs = [];
    for (const dx of [-0.4, 0.4]) {
      const leg = boxColor(0.08, 0.86, 0.08, 0x8A8A94, { roughness: 0.7 });
      leg.position.set(dx, 0.43, 0.1);
      g.add(leg);
      legs.push(leg);
    }
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.2, 0.9),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 0.6;
    hit.userData = { interact: 'ambient', ambientId: 'sink' };
    g.add(hit);
    ambientHits.push(hit);
    world.add(g);
    ambientActors.set('sink', g);
  }

  /* ================= 成长线：星级解锁的机器 / 装修（运行时补建） =================
   * 与扩建不同：星级解锁是"升星那一刻"才发生的，无法在开局预建
   * （不知道玩家会不会升星、升到几星），所以走**现场建**。
   * 现场建的成本（贴图/几何）只有 4 台机器，且发生在结算界面之后，
   * 玩家不在操作动线上，卡顿感可以忽略。 */
  function addFacilities(list) {
    const added = [];
    for (const fac of list ?? []) {
      if (!fac || !fac.id || builtIds.has(fac.id)) continue;
      const p = buildFacility(fac);
      builtIds.add(fac.id);
      p.group.visible = true;
      if (!facilityHits.includes(p.hit)) facilityHits.push(p.hit);
      added.push(p.fac);
    }
    return added;
  }

  /** 解锁一档星级内容：建机器 + 点亮后巷 + 摆装修件 */
  function applyStarUnlock(unlock) {
    const facs = addFacilities(unlock?.facilities ?? []);
    for (const l of unlock?.lamps ?? []) addLight(0xF2C879, 1.25, l.x, 3.0, l.z, 11);
    applyDeco(unlock?.deco);
    return facs;
  }

  /** 装修件：每台新机器旁边一条同色霓虹地条（"新装修"的可视化） */
  const decoColors = {
    neonFloor: 0xB15BD8, racingBanner: 0x6BA8E8, ktvCurtain: 0xE05A8C, goldPlaque: 0xE8A94E,
  };
  const decoAnchor = {
    neonFloor: { x: -8.0, z: -6.1 }, racingBanner: { x: -3.5, z: -6.1 },
    ktvCurtain: { x: 1.2, z: -6.1 }, goldPlaque: { x: 5.6, z: -6.1 },
  };
  const appliedDecos = new Set();
  function applyDeco(id) {
    if (!id || appliedDecos.has(id)) return null;
    appliedDecos.add(id);
    const color = decoColors[id] ?? 0xF2C879;
    const strip = boxColor(2.4, 0.04, 0.12, color, {
      emissive: new THREE.Color(color), emissiveIntensity: 1.2, roughness: 0.5,
    });
    const anchor = decoAnchor[id];
    strip.position.set(anchor?.x ?? 0, 0.06, anchor?.z ?? -6.0);
    world.add(strip);
    return strip;
  }

  function applyExpansion(id) {
    const exp = EXPANSION_BY_ID[id];
    const zg = expansionGroups.get(id);
    if (zg) {
      zg.visible = true;
      // 隐藏的 group 不会关掉光源（THREE 的光照与 visible 无关），
      // 所以扩建区的灯必须**在解锁时**才加进场景，否则未解锁时就会照亮一片空地。
      if (!zg.userData.lit) {
        zg.userData.lit = true;
        for (const l of exp?.lamps ?? []) addLight(0xF2C879, 1.3, l.x, 3.0, l.z, 12);
      }
    }
    const parts = expansionParts.get(id) ?? [];
    const unlocked = [];
    for (const p of parts) {
      p.group.visible = true;
      if (!facilityHits.includes(p.hit)) facilityHits.push(p.hit);
      unlocked.push(p.fac);
    }
    return unlocked;
  }

  /* ============ 店铺成长线（B）：扩张投资表现 ============
   * 三个 applyXxx 都是「幂等 + 依 state.expansion 判定」：读档 syncExpansions 只对已购项调用，
   * 运行时 onBuy 在 buyExpansion 置位后立即调用。appliedGrowth 防止重复建模型。 */
  const appliedGrowth = new Set();

  /** 新货架排：在第 3 行 SHELF_ROWS[2] 建 slots 8,9 两格 + 碰撞 + 接触阴影。 */
  function applyShelfRow() {
    if (appliedGrowth.has('shelfRow') || !state.expansion.shelfRow) return;
    appliedGrowth.add('shelfRow');
    for (const i of [SLOT_COUNT, SLOT_COUNT + 1]) buildShelf(i);
    const row = SHELF_ROWS[2];
    for (const z of row.zs) {
      // 碰撞体与 layout.buildColliders 的货架占位同形（halfW 0.78 / halfD 0.32）
      colliders.push({
        min: { x: row.x - 0.78, z: z - 0.32 },
        max: { x: row.x + 0.78, z: z + 0.32 },
      });
      addContactShadow(row.x, z, 1.9);
    }
  }

  /** 店外夜市摊：门口广场摆一个带条纹遮阳棚的摊位（纯表现，无碰撞——广场本就不在走动边界内）。 */
  function applyNightStall() {
    if (appliedGrowth.has('nightStall') || !state.expansion.nightStall) return;
    appliedGrowth.add('nightStall');
    const g = new THREE.Group();
    g.position.set(3.2, 0, STORE.maxZ + 3.0);
    const counter = box(2.0, 0.9, 0.9, 'wood', 1);
    counter.position.y = 0.45;
    g.add(counter);
    for (const px of [-0.9, 0.9]) for (const pz of [-0.35, 0.35]) {
      const post = box(0.08, 2.0, 0.08, 'metal', 1);
      post.position.set(px, 1.0, pz);
      g.add(post);
    }
    // 条纹遮阳棚（程序化交替色）
    const stripeA = 0xE8A94E, stripeB = 0xF4E4C1;
    for (let s = 0; s < 4; s++) {
      const seg = box(0.5, 0.08, 0.9, 'metal', 1);
      seg.material = new THREE.MeshStandardMaterial({ color: s % 2 ? stripeA : stripeB, roughness: 0.8 });
      seg.position.set(-0.75 + s * 0.5, 2.0, 0);
      g.add(seg);
    }
    const lamp = new THREE.PointLight(0xF2C879, 1.0, 8);
    lamp.position.set(0, 2.2, 0);
    g.add(lamp);
    world.add(g);
    addContactShadow(g.position.x, g.position.z, 2.2);
  }

  /** 装修升级：地板换色（clone 材质避免污染复用 MATS.floor 的区域）+ 灯光增亮 + 招牌换色。纯视觉。 */
  function applyRenovation() {
    if (appliedGrowth.has('renovation') || !state.expansion.renovation) return;
    appliedGrowth.add('renovation');
    if (floor.material === MATS.floor) floor.material = MATS.floor.clone();
    floor.material.color?.set(0x8C6A4A);
    floor.material.needsUpdate = true;
    // 改 baseIntensity，昼夜插值在它之上做倍率，装修后亮度始终生效
    for (const l of lights) {
      l.userData.baseIntensity = (l.userData.baseIntensity ?? l.intensity) * 1.3;
      l.intensity = l.userData.baseIntensity;
    }
    if (sign?.material) {
      sign.material.color?.set(0x7CE0C0);
      sign.material.emissive?.set(0x7CE0C0);
      sign.material.needsUpdate = true;
    }
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer, scene, camera, world, colliders, lights,
    anchors: {
      slots: slotMeshes, counter: counterHit, crate: crateHit,
      /** 门口货箱（块5）：交互层靠 interact:'delivery' 认它 */
      delivery: deliveryCrates,
      facilities: facilityHits, stalls: stallHits,
      /** 环境互动对象（猫 / 外卖员 / 电视）：参与锥选，由 interaction 的 ambient 分支处理 */
      ambient: ambientHits,
      /** 垃圾网格池（动态增删；交互系统每帧读它参与锥选） */
      litter: litterPool,
      /** 块6：垃圾桶命中盒（收银台旁），交互层靠 interact:'trashcan' 认它 */
      trashcan: trashcanHit,
    },
    updateSlotVisual, updateHands, updateSnack, updatePond, resize,
    /** 上货放置动画：让第 i 格商品做一次落位弹跳（配合 sfx.done('stock')） */
    pulseSlot,
    /** 清仓：格子变暗再清空（块3） */
    fadeOutSlot,
    /** 收银飞钱：从顾客脚边抛到收银台（块3） */
    flyCoins,
    /** 设置页：视场角（70–90 度）。改完必须 updateProjectionMatrix，否则不生效 */
    setFov(deg) {
      if (!Number.isFinite(deg)) return;
      camera.fov = Math.max(30, Math.min(110, deg));
      camera.updateProjectionMatrix();
    },
    /** 标签过滤 / 新手引导箭头（P1-5、P1-7、P2-10） */
    updateLabels, setGuideVisible,
    /** 环境系统（需求G ③④⑤⑥）的表现出口 */
    setLitter, updateDeviceVisuals, applyDayNight,
    /** 块6：垃圾堆同步（state.garbage → 垃圾桶前的纸箱堆） */
    setGarbage,
    /** 门口货箱显隐（块5） */
    setDeliveryCrates,
    /** 娃娃机玻璃柜的娃娃数（P0-4：有货摆满 / 见底挂补货提示，绝不空柜） */
    setClawCabinet, clawCabinetState,
    /** 可感知反馈：情绪图标 / 粒子 / 远处指引点 */
    setEmotions, setBeacons, burst, updateFeedback,
    /** 需求I 第⑦条：店铺扩建的表现出口 */
    applyExpansion, rebuildShell,
    /** 店铺成长线（B）：扩张投资的表现出口 */
    applyShelfRow, applyNightStall, applyRenovation,
    /** 成长线：星级解锁（运行时补建机器 + 装修） */
    addFacilities, applyStarUnlock,
    /** 环境互动：猫 / 外卖员 显隐；电视换节目 */
    setActor(kind, opts = {}) {
      const g = ambientActors.get(kind);
      if (!g) return;
      g.visible = opts.visible !== false;
      if (Number.isFinite(opts.x) && Number.isFinite(opts.z)) g.position.set(opts.x, 0, opts.z);
    },
    /** 电视换节目：改屏幕自发光 + 标牌文案（节目由 ambient.mjs 决定，这里只画） */
    setTvProgram(program) {
      if (!program || !tvLabel) return;
      drawLabel(tvLabel.canvas, tvLabel.tex, {
        emoji: program.emoji ?? '📺',
        title: program.name ?? '电视节目',
        sub: '按 E 收看',
        tint: '#6BA8E8',
      });
      if (tvScreen?.material) {
        // 换台 = 屏幕颜色变一下：低成本但能读出"节目变了"
        const hue = (program.name ?? '').length * 0.11;
        tvScreen.material.emissive?.setHSL(hue % 1, 0.45, 0.35);
        tvScreen.material.needsUpdate = true;
      }
    },
    /** 当前已解锁的扩建（读档后要按存档把场景补回来） */
    get expansionsApplied() { return [...expansionGroups.keys()].filter((id) => expansionGroups.get(id).visible); },
  };
}
