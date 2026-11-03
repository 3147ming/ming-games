/**
 * solver.js — 线性代数核心：稠密 MNA 矩阵 + 部分主元高斯消元 + Newton-Raphson 框架
 *
 * 为什么自己写：技术约束要求零依赖（不引 math.js），且电路规模很小
 * （100 节点以内），稠密 O(n³) 高斯消元完全够用，比引入稀疏库更简单可控。
 *
 * 矩阵用「行主序一维 Float64Array」而非嵌套数组：
 *   - 下标单次乘法即得，没有二级数组解引用，消元循环快一档；
 *   - 天然连续内存，复制 / 清零都是 O(1) 次操作；
 *   - 避免嵌套数组被误当作"共享子数组"传来传去。
 *
 * 分层（便于单测，也便于出问题时定位是装配错还是求解错）：
 *   makeMatrix / makeVector / stampAdd / stampRhs   —— 装配
 *   eliminate / backSubstitute                     —— 消元（就地，作用于自有副本）
 *   solveLinear                                    —— 对外纯接口（不改入参）
 *   newtonSolve                                    —— 非线性外层迭代
 *
 * 约定：矩阵求解中的所有"地面"节点不进矩阵。调用方（simdc）负责把
 * 地面节点映射为下标 -1，stampAdd / stampRhs 遇到 -1 直接忽略。
 */

/* ==========================================================================
   构造与基本操作
   ========================================================================== */

/** 建 n×n 零矩阵（行主序） */
export function makeMatrix(n) {
  return new Float64Array(n * n);
}

/** 建长度 n 的零向量 */
export function makeVector(n) {
  return new Float64Array(n);
}

/**
 * 往矩阵里叠加一个元素：A[i][j] += value。
 * i 或 j 为 -1 表示该端接地，按 MNA 惯例直接跳过（行列都不存在）。
 */
export function stampAdd(A, n, i, j, value) {
  if (i < 0 || j < 0 || i >= n || j >= n) return;
  A[i * n + j] += value;
}

/** 往右端项叠加：b[i] += value */
export function stampRhs(b, n, i, value) {
  if (i < 0 || i >= n) return;
  b[i] += value;
}

/**
 * 叠加一个二端导纳元件（电导 g 接在 p、n 之间）。
 * 四个位置：+g 在对角，-g 在非对角；接地端自动退化为 3 项 / 1 项。
 */
export function stampConductance(A, n, p, q, g) {
  stampAdd(A, n, p, p, g);
  stampAdd(A, n, q, q, g);
  stampAdd(A, n, p, q, -g);
  stampAdd(A, n, q, p, -g);
}

/** 矩阵乘向量（算残差用） */
export function matVec(A, n, x) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const row = i * n;
    for (let j = 0; j < n; j += 1) sum += A[row + j] * x[j];
    out[i] = sum;
  }
  return out;
}

/** 无穷范数（最大绝对值） */
export function normInf(v) {
  let max = 0;
  for (let i = 0; i < v.length; i += 1) {
    const abs = Math.abs(v[i]);
    if (abs > max) max = abs;
  }
  return max;
}

/** 全部为有限数（NaN / Infinity 检测） */
export function allFinite(v) {
  for (let i = 0; i < v.length; i += 1) {
    if (!Number.isFinite(v[i])) return false;
  }
  return true;
}

/** 复制矩阵 / 向量（solveLinear 用它保证不改入参） */
function copyOf(source) {
  const out = new Float64Array(source.length);
  out.set(source);
  return out;
}

/* ==========================================================================
   高斯消元
   ========================================================================== */

/**
 * 部分主元高斯消元（就地）。把 A 消成上三角，同时对 b 做同样的行变换。
 *
 * 奇异判定用「相对阈值」而不是绝对 0：
 * 完全精确为零当然奇异，但浮点误差会把接近奇异的矩阵算成 1e-18 这样的
 * 非零主元，随后回代得到 1e18 量级的垃圾解——比直接报错更有害。
 * 阈值取 1e-12 × 矩阵最大元素绝对值（下界 1），对电路矩阵（量级 1e-13 ~ 1e6）
 * 足够区分"真的病态"与"正常的小数值"。
 *
 * @returns {{ok:true, pivotColumn:number} | {ok:false, error:string}}
 */
export function eliminate(A, b, n) {
  let scale = 1;
  for (let i = 0; i < n * n; i += 1) {
    const abs = Math.abs(A[i]);
    if (abs > scale) scale = abs;
  }
  const eps = scale * 1e-12;

  for (let col = 0; col < n; col += 1) {
    // 选列主元：本列绝对值最大的行
    let pivotRow = col;
    let pivotAbs = Math.abs(A[col * n + col]);
    for (let row = col + 1; row < n; row += 1) {
      const abs = Math.abs(A[row * n + col]);
      if (abs > pivotAbs) {
        pivotAbs = abs;
        pivotRow = row;
      }
    }

    if (!(pivotAbs > eps)) {
      return { ok: false, error: '矩阵奇异（电路可能开路/短路）' };
    }

    // 换行：矩阵与右端项同步交换
    if (pivotRow !== col) {
      for (let k = 0; k < n; k += 1) {
        const a = col * n + k;
        const c = pivotRow * n + k;
        const tmp = A[a];
        A[a] = A[c];
        A[c] = tmp;
      }
      const tmpB = b[col];
      b[col] = b[pivotRow];
      b[pivotRow] = tmpB;
    }

    const pivot = A[col * n + col];
    const pivotRowStart = col * n;
    for (let row = col + 1; row < n; row += 1) {
      const rowStart = row * n;
      const factor = A[rowStart + col] / pivot;
      if (factor === 0) continue;
      A[rowStart + col] = 0;
      for (let k = col + 1; k < n; k += 1) {
        A[rowStart + k] -= factor * A[pivotRowStart + k];
      }
      b[row] -= factor * b[col];
    }
  }

  return { ok: true, pivotColumn: n };
}

/**
 * 回代（就地读上三角）。要求 A 已被 eliminate 处理过。
 * 对角线出现 0 说明矩阵奇异（eliminate 已挡过一次，这里是兜底）。
 */
export function backSubstitute(A, b, n) {
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row];
    const rowStart = row * n;
    for (let k = row + 1; k < n; k += 1) sum -= A[rowStart + k] * x[k];
    const pivot = A[rowStart + row];
    if (pivot === 0 || !Number.isFinite(pivot)) {
      return { ok: false, error: '矩阵奇异（电路可能开路/短路）' };
    }
    x[row] = sum / pivot;
  }
  return { ok: true, x };
}

/**
 * 解 Ax = b。不改入参（内部复制一份再消元）。
 * @returns {{ok:true, x:Float64Array} | {ok:false, error:string}}
 */
export function solveLinear(A, b, n) {
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: '矩阵维度非法' };
  if (n === 0) return { ok: true, x: new Float64Array(0) };
  if (!A || A.length < n * n) return { ok: false, error: '矩阵尺寸与维度不符' };
  if (!b || b.length < n) return { ok: false, error: '右端项尺寸与维度不符' };

  const matrix = copyOf(A.subarray ? A.subarray(0, n * n) : A);
  const rhs = copyOf(b.subarray ? b.subarray(0, n) : b);

  const removed = eliminate(matrix, rhs, n);
  if (!removed.ok) return { ok: false, error: removed.error };

  return backSubstitute(matrix, rhs, n);
}

/* ==========================================================================
   Newton-Raphson
   ========================================================================== */

/**
 * 通用 NR 迭代框架。
 *
 * @param {ArrayLike<number>} initial  初值向量
 * @param {(x:Float64Array) => {F:Float64Array, J:Float64Array}} iterate
 *        给定当前解，返回残差 F(x) 与雅可比 J(x)（行主序 n×n）
 * @param {object} [options]
 *        maxIter 最大迭代次数（默认 50）
 *        tol     收敛阈值：||Δx||∞ < tol（默认 1e-9）
 *        relax   阻尼因子（默认 1，0.5 可帮助硬非线性收敛）
 *
 * @returns {{ok:true, x, iter, residual} | {ok:false, x, iter, residual, error, reason}}
 *   reason ∈ 'maxIter' | 'singular' | 'nan' | 'shape'，供上层区分"真的不收敛"与"矩阵奇异"
 */
export function newtonSolve(initial, iterate, options = {}) {
  const maxIter = Number.isFinite(options.maxIter) ? Math.max(1, Math.trunc(options.maxIter)) : 50;
  const tol = Number.isFinite(options.tol) ? options.tol : 1e-9;
  const relax = Number.isFinite(options.relax) && options.relax > 0 ? options.relax : 1;

  const n = initial.length;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i += 1) x[i] = Number(initial[i]) || 0;

  if (n === 0) return { ok: true, x, iter: 0, residual: 0 };

  let iter = 0;
  let residual = Infinity;
  let reason = 'maxIter';

  while (iter < maxIter) {
    iter += 1;

    const evaluated = iterate(x);
    if (!evaluated || !evaluated.F || !evaluated.J) {
      return { ok: false, x, iter, residual, error: '迭代函数返回非法', reason: 'nan' };
    }
    const { F, J } = evaluated;
    // 形状校验：J 必须是行主序 n×n、F 必须是 n 维。
    // 传成嵌套数组时 allFinite 只会得到「不收敛」，排查成本很高，这里直接点明。
    if (F.length !== n || J.length !== n * n || (n > 0 && typeof J[0] !== 'number')) {
      return {
        ok: false,
        x,
        iter,
        residual,
        error: `迭代函数形状不对：F 应为 ${n} 维、J 应为行主序 ${n}×${n}`,
        reason: 'shape',
      };
    }
    if (!allFinite(F) || !allFinite(J)) return { ok: false, x, iter, residual, error: '不收敛', reason: 'nan' };

    residual = normInf(F);

    // 解 J·Δ = -F
    const rhs = new Float64Array(n);
    for (let i = 0; i < n; i += 1) rhs[i] = -F[i];
    const solved = solveLinear(J, rhs, n);
    if (!solved.ok) {
      return { ok: false, x, iter, residual, error: '不收敛', reason: 'singular', detail: solved.error };
    }

    let stepNorm = 0;
    for (let i = 0; i < n; i += 1) {
      const step = relax * solved.x[i];
      x[i] += step;
      const abs = Math.abs(step);
      if (abs > stepNorm) stepNorm = abs;
    }
    if (!allFinite(x)) return { ok: false, x, iter, residual, error: '不收敛', reason: 'nan' };

    if (stepNorm < tol) {
      // 收敛后再求一次残差：用上一轮的 F 汇报会偏大，对使用者是误导
      const finalEval = iterate(x);
      const finalF = finalEval && finalEval.F;
      const trueResidual = finalF && allFinite(finalF) ? normInf(finalF) : residual;
      return { ok: true, x, iter, residual: trueResidual };
    }
  }

  return { ok: false, x, iter, residual, error: '不收敛', reason };
}

/* ==========================================================================
   调试辅助
   ========================================================================== */

/** 把矩阵打成可读文本（单测 / 控制台排错用） */
export function formatMatrix(A, n, digits = 4) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const cells = [];
    for (let j = 0; j < n; j += 1) cells.push(Number(A[i * n + j]).toFixed(digits));
    lines.push(cells.join('  '));
  }
  return lines.join('\n');
}
