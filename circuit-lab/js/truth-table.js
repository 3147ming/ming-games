/**
 * truth-table.js — 真值表 / Quine-McCluskey / 卡诺图（阶段 2 · R5）
 *
 * 纯函数层：不碰 DOM、不碰 model，可在 node 里直接对拍。
 * 变量顺序约定：vars[0] 为**最高位**（与 examples-measure.js 的数字测量一致），
 * 行号 m 的第 i 个输入 = (m >> (N-1-i)) & 1，显示出来就是 ABC 顺序。
 *
 * 为什么把 Q-M 和 K 图放在同一个文件：规格第 2 卷 §4.4 要求「表达式与圈图
 * 共用同一套质蕴涵项」，分两个文件各算一遍迟早会不一致。kmapLayout() 直接
 * 消费 quineMcCluskey() 的 primes，从根上保证一致。
 */

export const MAX_VARS = 6;

/** 变量显示名：A..Z，超出用 A1.. */
export function varNames(n) {
  const names = [];
  for (let i = 0; i < n; i += 1) {
    names.push(i < 26 ? String.fromCharCode(65 + i) : `A${i - 25}`);
  }
  return names;
}

/** n 位格雷码序列（反射二进制），K 图的行列顺序 */
export function grayCode(n) {
  // 反射构造：第 i 轮给上半镜像补第 i 位（从最低位往上），
  // n=2 → 00,01,11,10 = [0,1,3,2]。写成 (n-1-i) 会得到 [0,2,3,1]，列序就错了。
  let out = [0];
  for (let i = 0; i < n; i += 1) {
    const upper = out.map((v) => v | (1 << i));
    out = out.concat(upper.reverse());
  }
  return out;
}

/** 把行号展开成输入位数组（高位在前） */
export function bitsOf(index, n) {
  const bits = [];
  for (let i = 0; i < n; i += 1) bits.push((index >> (n - 1 - i)) & 1);
  return bits;
}

function normOutput(value) {
  if (value === 1 || value === true || value === '1') return 1;
  if (value === 0 || value === false || value === '0') return 0;
  return 'X';
}

/**
 * 枚举 2^N 行真值表。
 * @param {Array<{id:string,label?:string,enabled?:boolean}>} vars 输入变量
 * @param {(bits:number[], index:number)=>0|1|'X'} evaluate 求值回调（由 UI 提供，内部改开关并 solveCoupled）
 * @returns {{ok:boolean,error?:string,n:number,vars:Array,rows:Array<{index:number,inputs:number[],output:0|1|'X'}>}}
 */
export function enumerateTruthTable(vars, evaluate) {
  const all = Array.isArray(vars) ? vars : [];
  const active = all.filter((v) => v && v.enabled !== false);
  const n = active.length;
  if (n > MAX_VARS) {
    return { ok: false, n, vars: active, rows: [], error: `变量 ${n} 个超过上限 ${MAX_VARS}，请先化简或减少输入` };
  }
  if (typeof evaluate !== 'function') {
    return { ok: false, n, vars: active, rows: [], error: '缺少求值函数' };
  }
  const rows = [];
  for (let m = 0; m < (1 << n); m += 1) {
    const bits = bitsOf(m, n);
    let output = 'X';
    try { output = normOutput(evaluate(bits, m)); } catch (_) { output = 'X'; }
    rows.push({ index: m, inputs: bits, output });
  }
  return { ok: true, n, vars: active, rows };
}

/* ==========================================================================
   Quine-McCluskey
   ========================================================================== */

/** 项的字符串表示：'10-1'（'-' = 该变量不出现） */
function termOf(index, n) {
  return bitsOf(index, n).join('');
}

/** 两个项只差一位时返回合并结果，否则 null */
function mergeTerms(a, b) {
  let diff = -1;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    // 只有「0 vs 1」可以合并；含 '-' 的两项必须 '-' 位置完全一致
    if (a[i] === '-' || b[i] === '-') return null;
    if (diff >= 0) return null;
    diff = i;
  }
  if (diff < 0) return null;
  return `${a.slice(0, diff)}-${a.slice(diff + 1)}`;
}

/** 项覆盖了哪些最小项（'-' 展开）；超过 6 变量时上限 64，开销可忽略 */
function coversOf(term) {
  let list = [''];
  for (const ch of term) {
    const next = [];
    list.forEach((prefix) => {
      if (ch === '-') next.push(`${prefix}0`, `${prefix}1`);
      else next.push(prefix + ch);
    });
    list = next;
  }
  return list.map((bits) => parseInt(bits, 2));
}

/**
 * 最小项分组 → 反复合并 → 质蕴涵项 → 核心项 + 贪心覆盖 → 最简 SOP。
 * @param {Array<{index:number,inputs:number[],output:0|1|'X'}>} rows
 * @param {string[]} names 变量名（长度 = N）
 */
export function quineMcCluskey(rows, names) {
  const list = Array.isArray(rows) ? rows : [];
  const n = list.length > 0 ? list[0].inputs.length : 0;
  const labels = (names && names.length === n) ? names : varNames(n);
  const ones = list.filter((r) => r.output === 1).map((r) => r.index);
  const dont = list.filter((r) => r.output === 'X').map((r) => r.index);
  const base = { n, labels, minterms: ones, dontcares: dont, primes: [], selected: [], expression: '', constant: null };

  if (n === 0) {
    const only = list.length ? list[0].output : 0;
    const c = only === 1 ? 1 : (only === 0 ? 0 : null);
    return { ...base, constant: c, expression: c === null ? 'F = X' : `F = ${c}` };
  }
  if (ones.length === 0) return { ...base, constant: 0, expression: 'F = 0（恒 0）' };
  if (ones.length + dont.length === (1 << n)) {
    return { ...base, constant: 1, expression: 'F = 1（恒 1）' };
  }

  // ① 反复合并：每轮把「能合并的」标记掉，没被合并的即为质蕴涵项
  let current = [...new Set(ones.concat(dont).map((m) => termOf(m, n)))];
  const primes = new Set();
  for (let round = 0; round <= n; round += 1) {
    const used = new Set();
    const merged = new Set();
    for (let i = 0; i < current.length; i += 1) {
      for (let j = i + 1; j < current.length; j += 1) {
        const combo = mergeTerms(current[i], current[j]);
        if (combo) { used.add(current[i]); used.add(current[j]); merged.add(combo); }
      }
    }
    current.forEach((term) => { if (!used.has(term)) primes.add(term); });
    if (merged.size === 0) break;
    current = [...merged];
  }
  // 只保留至少覆盖一个「1」的质蕴涵项（纯 don't-care 项不必选）
  const oneSet = new Set(ones);
  const primeList = [...primes].filter((term) => coversOf(term).some((m) => oneSet.has(m)));

  // ② 核心蕴涵项：某个最小项只被一个质蕴涵项覆盖 → 必选
  const coverage = primeList.map((term) => new Set(coversOf(term).filter((m) => oneSet.has(m))));
  const selected = new Set();
  ones.forEach((m) => {
    const owners = coverage.filter((set) => set.has(m));
    if (owners.length === 1) selected.add(primeList[coverage.indexOf(owners[0])]);
  });

  // ③ 剩余最小项贪心：每次选覆盖最多未覆盖项的质蕴涵项
  const covered = () => {
    const set = new Set();
    selected.forEach((term) => coversOf(term).forEach((m) => set.add(m)));
    return set;
  };
  let done = covered();
  while (ones.some((m) => !done.has(m))) {
    let best = null;
    let bestGain = 0;
    primeList.forEach((term, idx) => {
      if (selected.has(term)) return;
      const gain = [...coverage[idx]].filter((m) => !done.has(m)).length;
      if (gain > bestGain) { bestGain = gain; best = term; }
    });
    if (!best) break; // 理论不可达（质蕴涵项必然覆盖所有最小项），兜底防死循环
    selected.add(best);
    done = covered();
  }

  // 按项名排序：表决器输出稳定的 "AB + AC + BC"（与验收文案一致）
  const selectedList = primeList.filter((t) => selected.has(t))
    .sort((a, b) => termText(a, labels).localeCompare(termText(b, labels)));
  return {
    ...base,
    primes: primeList,
    selected: selectedList,
    constant: null,
    expression: `F = ${selectedList.map((t) => termText(t, labels)).join(' + ')}`,
  };
}

/** 项 → 文本乘积：1 写 A，0 写 A'，- 省略 */
export function termText(term, labels) {
  const parts = [];
  for (let i = 0; i < term.length; i += 1) {
    if (term[i] === '1') parts.push(labels[i]);
    else if (term[i] === '0') parts.push(`${labels[i]}'`);
  }
  return parts.length ? parts.join('') : '1';
}

/* ==========================================================================
   卡诺图布局 + 圈选（直接消费 Q-M 的质蕴涵项）
   ========================================================================== */

/**
 * K 图布局。N=2 → 2×2；N=3 → 2×4；N=4 → 4×4；N≥5 只给提示不画图。
 * 行取前 rowBits 个变量，列取剩余，行列均按格雷码排列。
 * @returns {{ok:boolean,n:number,rowBits:number,colBits:number,rowLabels:string[],colLabels:string[],
 *            cells:Array<{r:number,c:number,index:number,value:0|1|'X'}>,
 *            groups:Array<{term:string,cells:Array<{r:number,c:number}>}>,hint:string}}
 */
export function kmapLayout(rows, names, qm) {
  const list = Array.isArray(rows) ? rows : [];
  const n = list.length > 0 ? list[0].inputs.length : 0;
  const labels = (names && names.length === n) ? names : varNames(n);
  const empty = { ok: false, n, rowBits: 0, colBits: 0, rowLabels: [], colLabels: [], cells: [], groups: [], hint: '' };
  if (n < 2 || n > 4) {
    return { ...empty, hint: n < 2 ? '至少 2 个变量才画 K 图' : '5/6 变量 K 图请用四变量分组法（本工具只列真值表与最简式）' };
  }
  const rowBits = Math.floor(n / 2);
  const colBits = n - rowBits;
  const rSeq = grayCode(rowBits);
  const cSeq = grayCode(colBits);
  const valueByIndex = new Map(list.map((r) => [r.index, r.output]));
  const cells = [];
  const posOf = new Map();
  for (let r = 0; r < rSeq.length; r += 1) {
    for (let c = 0; c < cSeq.length; c += 1) {
      const index = (rSeq[r] << colBits) | cSeq[c];
      cells.push({ r, c, index, value: valueByIndex.has(index) ? valueByIndex.get(index) : 'X' });
      posOf.set(index, { r, c });
    }
  }
  const rowLabels = rSeq.map((v) => bitsOf(v, rowBits).join(''));
  const colLabels = cSeq.map((v) => bitsOf(v, colBits).join(''));

  // 圈 = 被选中的质蕴涵项覆盖的格集合；表达式与圈图共用同一份 selected
  let groups = ((qm && qm.selected) || []).map((term) => ({
    term: termText(term, labels),
    cells: coversOf(term)
      .filter((m) => posOf.has(m))
      .map((m) => posOf.get(m)),
  })).filter((g) => g.cells.length > 0);
  // 恒 1：没有质蕴涵项可选，但 K 图应显示一个覆盖全图的圈
  if (qm && qm.constant === 1) groups = [{ term: '1', cells: cells.map((c) => ({ r: c.r, c: c.c })) }];

  return {
    ok: true, n, rowBits, colBits, rowLabels, colLabels, cells, groups,
    hint: `${labels.slice(0, rowBits).join('')} 为行 / ${labels.slice(rowBits).join('')} 为列（格雷码）`,
  };
}

/** 一步拿到全部结果，UI 只需要这一个入口 */
export function buildTruthTable(vars, evaluate) {
  const table = enumerateTruthTable(vars, evaluate);
  if (!table.ok) return { ok: false, error: table.error, table, qm: null, kmap: null };
  const labels = varNames(table.n);
  const qm = quineMcCluskey(table.rows, labels);
  const kmap = kmapLayout(table.rows, labels, qm);
  return { ok: true, error: null, table, qm, kmap, labels };
}
