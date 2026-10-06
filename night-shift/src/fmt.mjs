/**
 * 统一金额格式化（Bug⑤ · 2026-10-04）
 *
 * 为什么单独抽一个模块：`¥${x}` 这种拼法散落在 hud / main / interaction / minigames /
 * phone / scene / qte / staff / choices 九个文件里，谁都在拼、谁都没格式化 —— 于是
 * `成交+¥14.850000000000001`（第 4 夜）、`损失¥52.40799999999866`（第 7 夜）
 * 这类浮点尾数就漏到玩家眼前。**根因是"显示层各自为政"，所以解法必须是"单一入口"，
 * 而不是逐处打补丁**（逐处修补下个月新增面板时必然再漏）。
 *
 * 口径（对应需求）：
 *   - `Math.round(n * 100) / 100` —— 先按分四舍五入，消掉二进制表示误差；
 *   - 再 `toFixed(2)` + 去尾零 —— 整数显示 `¥15` 而不是 `¥15.00`，非整数最多两位；
 *   - **内部经济计算仍保留浮点精度**，只有"拼给玩家看"的那一刻才格式化（显示层格式化）。
 *
 * 空值兜底：金额理论上不该是 undefined / NaN，但一旦有就是"¥undefined"这种脏文案，
 * 比少显示一分钱更糟。统一收敛成 `¥0`。
 */

/** 数值守卫：非有限数（NaN / Infinity / null / undefined）一律当 0 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 纯数字金额：最多两位小数、去尾零、负数保留符号。
 *   14.850000000000001 → "14.85"
 *   52.40799999999866  → "52.41"
 *   15                 → "15"
 *   -3.5               → "-3.5"
 */
export function fmtMoney(v) {
  const r = Math.round(num(v) * 100) / 100;
  // 消掉 "-0"（Math.round(-0.001*100)/100 === -0，直接 String 会得到 "0"，
  // 但拼在 `+¥` 后面时若上层自己加了正号会出现 "+-0"，这里统一成 "0"）
  if (Object.is(r, -0)) return '0';
  // toFixed(2) 补到两位再砍尾零：14.5 → "14.50" → "14.5"；15 → "15.00" → "15"
  return r.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * 带 ¥ 符号的金额（显示层首选这个）。负数用 `-¥x` 而不是 `¥-x`。
 *   fmtYuan(14.850000000000001) → "¥14.85"
 */
export function fmtYuan(v) {
  const r = Math.round(num(v) * 100) / 100;
  if (Object.is(r, -0)) return '¥0';
  const sign = r < 0 ? '-' : '';
  return `${sign}¥${Math.abs(r).toFixed(2).replace(/\.?0+$/, '')}`;
}

/**
 * 带正负号的金额（增量场景，如 `+¥12.5` / `-¥40`），自动补 `+`。
 * 用于"入账 +¥x / 支出 −¥x"这类提示。
 */
export function fmtYuanSigned(v) {
  const r = Math.round(num(v) * 100) / 100;
  const sign = r < 0 ? '-' : '+';
  return `${sign}¥${Math.abs(r).toFixed(2).replace(/\.?0+$/, '')}`;
}

/**
 * 用户可见文案的通用空值保护：把 undefined / null / NaN 收成兜底串。
 * 修 Bug⑥（`undefined 完成补货`）时用它兜住所有模板变量，
 * 避免"某个事件漏传字段 → 玩家看见 undefined"。
 */
export function safeText(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number' && !Number.isFinite(v)) return fallback;
  const s = String(v).trim();
  return s === '' || s === 'undefined' || s === 'null' || s === 'NaN' ? fallback : s;
}
