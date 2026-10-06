// 确定性随机（种子可复现）
// 口径：同一个种子必须产出完全相同的整局游戏。这是存档、回放、单元测试、
//      平衡模拟器四件事的共同地基 —— 没有它，平衡调参只能靠手感。
// 算法：FNV-1a 字符串哈希 → mulberry32。纯整数运算，跨平台结果一致。

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

  /**
   * 派生一个独立的子随机流（阶段 6 · 荒野遭遇）。
   * 口径：荒野关是「实时手操作」子系统，必须隔离，不能污染主 rng 的确定性
   *      （否则后续卡牌关的 seed 复现会失效）。子流只消费自己的内部状态，
   *      永不调用主 rng 的 next()，因此主 rng 的状态在子流派生前后保持不变。
   *      派生串把「主种子 + 标签 + 主 rng 当前状态 s」编码进去，
   *      同一时刻同标签 → 同一子流（确定性）。详见 docs/07-荒野模式.md §RNG 隔离。
   */
  sub(label) {
    return new Rng(`${this.seed}::${label}::${this.s}`);
  }
}

  /** 生成人类可读的种子（3 段字母数字，便于口头分享复现） */
export function makeSeed(rng) {
  const A = 'ACDEFGHJKLMNPQRTUVWXY3456789';
  let out = '';
  for (let i = 0; i < 9; i++) out += A[rng.int(A.length)];
  return `${out.slice(0, 3)}-${out.slice(3, 6)}-${out.slice(6, 9)}`;
}
