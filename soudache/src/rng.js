/**
 * 可复现随机数工具（纯逻辑模块）
 *
 * 使用 mulberry32：32 位状态的快速 PRNG，同一种子必然产生同一序列，
 * 因此地图、战利品、敌人配置都可以用"种子"复现。
 */

/**
 * mulberry32 伪随机数发生器。
 * @param {number} seed 32 位整数种子
 * @returns {() => number} 返回 [0, 1) 区间的函数
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把任意字符串映射为 32 位整数种子。
 * @param {string} str 输入字符串
 * @returns {number} 32 位无符号整数
 */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 创建一个带便捷方法的随机数发生器。
 * @param {number|string} seed 数字或字符串种子
 * @returns {object} rng 实例
 */
export function createRng(seed) {
  const baseSeed = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  const next = mulberry32(baseSeed || 1);

  const rng = {
    seed: baseSeed,
    /** [0,1) 浮点 */
    next,
    /** [min, max) 浮点 */
    float(min = 0, max = 1) {
      return min + next() * (max - min);
    },
    /** [min, max] 整数（含两端） */
    int(min = 0, max = 1) {
      if (max < min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    /** 以 p 的概率返回 true */
    chance(p = 0.5) {
      return next() < p;
    },
    /** 从数组中随机取一个元素 */
    pick(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return undefined;
      return arr[Math.floor(next() * arr.length)];
    },
    /** 原地洗牌（Fisher-Yates），返回同一数组 */
    shuffle(arr) {
      const a = Array.isArray(arr) ? arr : [];
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
      }
      return a;
    },
    /** 近似正态分布，均值 0、标准差 1（Box-Muller） */
    gauss() {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /**
     * 加权随机。
     * @param {Array<[any, number]>|Record<string, number>} entries 键值对或 [[值, 权重], ...]
     * @returns {any} 命中的键（对象形式）或值（数组形式）
     */
    weighted(entries) {
      const list = Array.isArray(entries)
        ? entries
        : Object.entries(entries || {});
      let total = 0;
      for (const pair of list) total += Math.max(0, Number(pair[1]) || 0);
      if (total <= 0) return list.length ? list[0][0] : undefined;
      let roll = next() * total;
      for (const pair of list) {
        roll -= Math.max(0, Number(pair[1]) || 0);
        if (roll <= 0) return pair[0];
      }
      return list[list.length - 1][0];
    },
    /** 派生一个独立子流（用于给不同系统分配互不干扰的随机序列） */
    fork(salt = 0) {
      return createRng((baseSeed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0);
    },
  };

  return rng;
}

/**
 * 生成一个新的随机种子（用于每局战局）。
 * @returns {number} 32 位整数种子
 */
export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}
