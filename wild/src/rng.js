// 确定性随机（种子可复现）
// 口径：同一个种子必须产出完全相同的整局。这是单测、无头模拟、平衡调参三件事的共同地基
//      —— 没有它，"10 分钟跑满不 NaN""波次递进"这类结论只能靠手感。
// 算法：FNV-1a 字符串哈希 → mulberry32。纯整数运算，跨平台结果一致。
// 移植自 ONE-CARD（该模块与卡牌无关，原样保留；`sub()` 供将来派生独立子流用）。

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.seed = String(seed);
    this.s = hashSeed(this.seed);
  }

  /** 内部状态，可序列化进存档 */
  get state() {
    return this.s;
  }

  set state(v) {
    this.s = v >>> 0;
  }

  clone() {
    const r = new Rng(this.seed);
    r.s = this.s;
    return r;
  }

  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, n) 整数 */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** [a, b] 闭区间整数 */
  range(a, b) {
    return a + this.int(b - a + 1);
  }

  /** 概率命中，p ∈ [0,1] */
  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[this.int(arr.length)];
  }

  /** Fisher-Yates，返回新数组，不改原数组 */
  shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 按权重抽一个；weightOf 返回正整数权重 */
  weighted(items, weightOf) {
    let total = 0;
    for (const it of items) total += Math.max(0, weightOf(it));
    if (total <= 0) return items[this.int(items.length)];
    let roll = this.next() * total;
    for (const it of items) {
      roll -= Math.max(0, weightOf(it));
      if (roll < 0) return it;
    }
    return items[items.length - 1];
  }

  /** 不放回抽 n 个（不足则返回全部） */
  sample(arr, n) {
    if (n >= arr.length) return this.shuffled(arr);
    return this.shuffled(arr).slice(0, n);
  }
}

/** 生成人类可读的种子（3 段字母数字，便于口头分享复现） */
export function makeSeed(rng) {
  const A = 'ACDEFGHJKLMNPQRTUVWXY3456789';
  let out = '';
  for (let i = 0; i < 9; i++) out += A[rng.int(A.length)];
  return `${out.slice(0, 3)}-${out.slice(3, 6)}-${out.slice(6, 9)}`;
}
