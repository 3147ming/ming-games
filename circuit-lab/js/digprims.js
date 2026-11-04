/**
 * digprims.js — 数字域三值逻辑原语（leaf 模块，零依赖）
 *
 * 为什么单独拆这一层：
 *   `digital-chips.js`（8 个 MSI 芯片）要复用 `norm` / `X` / `TTL` / `TPD_*`。
 *   如果它直接 import `digmodels.js`，而 `digmodels.js` 又 import 它，就形成 ESM
 *   循环依赖：模块求值顺序上 `digital-chips.js` 先跑，此时 `digmodels.js` 里的
 *   `const TPD_GATE` 还在 TDZ，`buildLs138()` 立刻读它 → ReferenceError。
 *   把原语下沉成零依赖的 leaf 模块后，依赖方向变成单向：
 *       digmodels → digital-chips → digprims
 *   两个模块都从 leaf 取原语，既没有循环，也不复制一份实现。
 *
 * 三层分工不变：本文件只是"三值逻辑 + TTL 常量"，不属于 parts / devmodels / digmodels 任何一层。
 */

/** 未知态 */
export const X = 'X';

/** TTL 输入阈值（74LS 系列 datasheet：Vih ≥ 2.0V，Vil ≤ 0.8V） */
export const TTL = Object.freeze({ vih: 2.0, vil: 0.8 });

/** 传播延迟：74LS 门典型 10ns，触发器 20ns。本包只用于报告，不驱动暂态波形 */
export const TPD_GATE = 10e-9;
export const TPD_FF = 20e-9;

/** 归一化成 0 / 1 / X（外部可能传布尔或字符串） */
export function norm(value) {
  if (value === 0 || value === '0' || value === false) return 0;
  if (value === 1 || value === '1' || value === true) return 1;
  return X;
}

/** AND：任一输入为 0 就一定是 0；否则有 X 就是 X */
export function logicAnd(values) {
  if (values.some((v) => norm(v) === 0)) return 0;
  if (values.some((v) => norm(v) !== 1)) return X;
  return 1;
}

/** OR：任一输入为 1 就一定是 1；否则有 X 就是 X */
export function logicOr(values) {
  if (values.some((v) => norm(v) === 1)) return 1;
  if (values.some((v) => norm(v) !== 0)) return X;
  return 0;
}

export function logicNot(value) {
  const v = norm(value);
  if (v === 0) return 1;
  if (v === 1) return 0;
  return X;
}

/**
 * XOR：按"未知传播"实现——任一输入 X 即输出 X。
 * 严格三值代数里 X XOR 1 可以化简成 X̅，但那样会让"某个输入没接好"
 * 看起来像"电路正常工作"，这里宁可保守。
 */
export function logicXor(values) {
  if (values.some((v) => norm(v) !== 0 && norm(v) !== 1)) return X;
  let acc = 0;
  values.forEach((v) => {
    acc ^= norm(v);
  });
  return acc;
}
