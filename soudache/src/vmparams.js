/**
 * 武器视图模型参数表（唯一真值）
 *
 * 为什么单独成文件：3D 枪模（models.js）与战前改枪台的 2D 侧视线稿（gunsketch.js）
 * 必须读同一份尺寸，否则预览像一把枪、进局内是另一把，两份表还会随时间各自漂移。
 * 本文件**零依赖**（不 import three / 不碰 DOM），纯逻辑层可直接被 Node 单测 import。
 *
 * 单位：米；坐标系为相机局部空间，枪口朝 -Z（与 THREE 相机默认前向一致）。
 */
export const VM_PARAMS = {
  rifle: {
    receiver: [0.085, 0.115, 0.62], receiverAt: [0, 0, -0.14],
    barrel: [0.042, 0.042, 0.42], barrelAt: [0, 0.012, -0.60],
    mag: [0.062, 0.20, 0.11], magAt: [0, -0.14, -0.02],
    stock: [0.070, 0.10, 0.28], stockAt: [0, -0.012, 0.26],
    grip: [0.060, 0.15, 0.075], gripAt: [0, -0.13, 0.12],
    sight: [0.030, 0.055, 0.13], sightAt: [0, 0.085, -0.16],
    muzzleAt: [0, 0.012, -0.84],
  },
  smg: {
    receiver: [0.082, 0.105, 0.44], receiverAt: [0, 0, -0.08],
    barrel: [0.038, 0.038, 0.26], barrelAt: [0, 0.008, -0.40],
    mag: [0.056, 0.24, 0.10], magAt: [0, -0.16, -0.04],
    stock: [0.055, 0.075, 0.20], stockAt: [0, -0.01, 0.22],
    grip: [0.056, 0.14, 0.072], gripAt: [0, -0.12, 0.10],
    sight: [0.026, 0.045, 0.10], sightAt: [0, 0.075, -0.10],
    muzzleAt: [0, 0.008, -0.56],
  },
  pistol: {
    receiver: [0.062, 0.10, 0.30], receiverAt: [0, 0, -0.04],
    barrel: [0.034, 0.034, 0.14], barrelAt: [0, 0.006, -0.24],
    mag: [0.048, 0.16, 0.085], magAt: [0, -0.14, 0.02],
    stock: [0.040, 0.055, 0.06], stockAt: [0, -0.03, 0.17],
    grip: [0.054, 0.17, 0.075], gripAt: [0, -0.13, 0.11],
    sight: [0.020, 0.030, 0.05], sightAt: [0, 0.062, -0.12],
    muzzleAt: [0, 0.006, -0.32],
  },
  carbine: {
    receiver: [0.085, 0.115, 0.54], receiverAt: [0, 0, -0.12],
    barrel: [0.042, 0.042, 0.36], barrelAt: [0, 0.012, -0.52],
    mag: [0.062, 0.20, 0.11], magAt: [0, -0.14, -0.02],
    stock: [0.070, 0.10, 0.24], stockAt: [0, -0.012, 0.22],
    grip: [0.060, 0.15, 0.075], gripAt: [0, -0.13, 0.12],
    sight: [0.030, 0.055, 0.13], sightAt: [0, 0.085, -0.14],
    muzzleAt: [0, 0.012, -0.74],
  },
  pdw: {
    receiver: [0.080, 0.100, 0.36], receiverAt: [0, 0, -0.06],
    barrel: [0.036, 0.036, 0.20], barrelAt: [0, 0.008, -0.32],
    mag: [0.054, 0.22, 0.095], magAt: [0, -0.15, -0.03],
    stock: [0.050, 0.070, 0.16], stockAt: [0, -0.01, 0.18],
    grip: [0.054, 0.13, 0.070], gripAt: [0, -0.11, 0.09],
    sight: [0.024, 0.042, 0.09], sightAt: [0, 0.072, -0.08],
    muzzleAt: [0, 0.008, -0.46],
  },
  lmg: {
    receiver: [0.095, 0.125, 0.70], receiverAt: [0, 0, -0.16],
    barrel: [0.046, 0.046, 0.50], barrelAt: [0, 0.014, -0.66],
    mag: [0.075, 0.30, 0.14], magAt: [0, -0.18, -0.03],
    stock: [0.080, 0.12, 0.32], stockAt: [0, -0.014, 0.30],
    grip: [0.066, 0.16, 0.085], gripAt: [0, -0.14, 0.14],
    sight: [0.034, 0.060, 0.15], sightAt: [0, 0.092, -0.18],
    muzzleAt: [0, 0.014, -0.94],
  },
  dmr: {
    receiver: [0.085, 0.115, 0.60], receiverAt: [0, 0, -0.14],
    barrel: [0.044, 0.044, 0.46], barrelAt: [0, 0.012, -0.60],
    mag: [0.062, 0.18, 0.10], magAt: [0, -0.14, -0.02],
    stock: [0.070, 0.10, 0.30], stockAt: [0, -0.012, 0.26],
    grip: [0.060, 0.15, 0.075], gripAt: [0, -0.13, 0.12],
    sight: [0.030, 0.055, 0.13], sightAt: [0, 0.085, -0.16],
    muzzleAt: [0, 0.012, -0.90],
  },
  battle: {
    receiver: [0.088, 0.118, 0.58], receiverAt: [0, 0, -0.14],
    barrel: [0.044, 0.044, 0.40], barrelAt: [0, 0.012, -0.54],
    mag: [0.064, 0.22, 0.12], magAt: [0, -0.15, -0.02],
    stock: [0.072, 0.10, 0.26], stockAt: [0, -0.012, 0.24],
    grip: [0.060, 0.15, 0.078], gripAt: [0, -0.13, 0.12],
    sight: [0.028, 0.048, 0.11], sightAt: [0, 0.080, -0.14],
    muzzleAt: [0, 0.012, -0.82],
  },
  shotgun: {
    receiver: [0.092, 0.114, 0.46], receiverAt: [0, 0, -0.10],
    barrel: [0.052, 0.052, 0.50], barrelAt: [0, 0.010, -0.58], // 霰弹枪长枪管外露
    mag: [0.066, 0.14, 0.10], magAt: [0, -0.12, 0.04], // 管式弹仓/下护木
    stock: [0.078, 0.11, 0.30], stockAt: [0, -0.014, 0.22], // 木质固定枪托
    grip: [0.062, 0.16, 0.07], gripAt: [0, -0.13, 0.10],
    sight: [0.022, 0.040, 0.09], sightAt: [0, 0.072, -0.10], // 简易珠状准星
    muzzleAt: [0, 0.010, -0.92],
  },
};

/**
 * 各枪口装置相对「安装基座」再往前伸出的距离（米）。
 *
 * 为什么要单独列出来：`muzzleAt` 是**装置安装点**，不是枪口焰的位置。
 * 装 0.26m 长的消音器后，枪口焰必须前移 0.23m，否则火焰会从消音器中间冒出来。
 * 3D 枪模与 2D 线稿都读这张表，避免两边各写一份偏移量。
 */
const MUZZLE_TIP_INSET = {
  suppressor: 0.23,
  compensator: 0.095,
  flash: 0.048,
  choke: 0.10,
};

/**
 * 解析一把枪在给定配件下的枪管实长与枪口位置。
 *
 * 返回的两个 z 不是一回事，混用会导致枪口焰/枪口装置错位：
 *  - muzzleZ：枪口装置的**安装基座**（配件几何挂在这里）
 *  - tipZ：   **最前端**（枪口焰、曳光弹起点用它）
 *
 * @param {object} p VM_PARAMS 里该枪的参数
 * @param {(id:string)=>boolean} has 是否装了某附件
 * @returns {{len:number,w:number,delta:number,frontZ:number,muzzleZ:number,tipZ:number}}
 */
export function resolvedBarrel(p, has) {
  let len = p.barrel[2];
  let w = p.barrel[0];
  if (has('longbarrel')) len += 0.12;
  else if (has('heavybarrel')) { len += 0.06; w = p.barrel[0] * 1.35; }
  else if (has('shortbarrel')) len = Math.max(p.barrel[2] * 0.72, p.barrel[2] - 0.10);
  const delta = len - p.barrel[2];
  const muzzleZ = p.muzzleAt[2] - delta;
  let inset = 0;
  for (const id of Object.keys(MUZZLE_TIP_INSET)) {
    if (has(id)) { inset = MUZZLE_TIP_INSET[id]; break; }
  }
  return { len, w, delta, frontZ: p.barrelAt[2] - len / 2, muzzleZ, tipZ: muzzleZ - inset };
}

/** 枪口装置长度表（3D 建几何用，线稿画梯形/矩形也用同一份）。 */
export { MUZZLE_TIP_INSET };
