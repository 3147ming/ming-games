/**
 * list-filter.js — 实验列表搜索 / 筛选（指令包 19 · 阶段 3 / R15）
 *
 * 纯函数：不碰 DOM、不碰存储，tools/test-model.mjs 可直接对拍。
 * 筛选条件全部「组合生效」：关键词 AND 平台 AND 难度 AND 标签。
 */

/** 平台筛选项：all / exp-box / breadboard */
export const PLATFORM_FILTERS = [
  { value: 'all', label: '全部平台' },
  { value: 'exp-box', label: '实验箱' },
  { value: 'breadboard', label: '面包板' },
];

/** 难度筛选项：0 = 全部 */
export const DIFFICULTY_FILTERS = [
  { value: 0, label: '全部难度' },
  { value: 1, label: '难度 1' },
  { value: 2, label: '难度 2' },
  { value: 3, label: '难度 3' },
];

/** 默认条件（内存态，不落盘） */
export function defaultCriteria() {
  return { query: '', platform: 'all', difficulty: 0, tag: 'all' };
}

/** 从实验清单聚合标签（去重、按出现顺序，最多 12 个，避免 chips 撑爆一行） */
export function collectTags(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((exp) => {
    (Array.isArray(exp.tags) ? exp.tags : []).forEach((raw) => {
      const tag = String(raw || '').trim();
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      if (out.length < 12) out.push(tag);
    });
  });
  return out;
}

/** 归一化条件：非法值一律回落到「全部」，避免脏状态导致空列表 */
export function normalizeCriteria(raw = {}) {
  const base = defaultCriteria();
  const platform = PLATFORM_FILTERS.some((p) => p.value === raw.platform)
    ? raw.platform : base.platform;
  const difficulty = DIFFICULTY_FILTERS.some((d) => d.value === raw.difficulty)
    ? raw.difficulty : base.difficulty;
  return {
    query: typeof raw.query === 'string' ? raw.query.trim().toLowerCase() : '',
    platform,
    difficulty,
    tag: typeof raw.tag === 'string' && raw.tag ? raw.tag : base.tag,
  };
}

/** 关键词模糊匹配：标题 / 描述 / 标签，不区分大小写；多个词按 AND 处理 */
function matchesQuery(exp, query) {
  if (!query) return true;
  const haystack = [
    exp.title || '',
    exp.desc || '',
    (Array.isArray(exp.tags) ? exp.tags.join(' ') : ''),
  ].join(' ').toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/**
 * 过滤实验清单。
 * @param {Array} list getExperiments() 的返回值
 * @param {object} criteria { query, platform, difficulty, tag }
 * @returns {Array} 过滤后的新数组（保持原顺序）
 */
export function filterExperiments(list, criteria = {}) {
  const c = normalizeCriteria(criteria);
  return (Array.isArray(list) ? list : []).filter((exp) => {
    if (!exp || typeof exp !== 'object') return false;
    if (!matchesQuery(exp, c.query)) return false;
    if (c.platform !== 'all' && exp.platform !== c.platform) return false;
    if (c.difficulty !== 0 && Number(exp.difficulty) !== Number(c.difficulty)) return false;
    if (c.tag !== 'all') {
      const tags = Array.isArray(exp.tags) ? exp.tags : [];
      if (!tags.includes(c.tag)) return false;
    }
    return true;
  });
}

/** 当前是否有生效的筛选条件（用于空态文案区分「没有实验」与「没匹配」） */
export function hasActiveFilter(criteria = {}) {
  const c = normalizeCriteria(criteria);
  return Boolean(c.query) || c.platform !== 'all' || c.difficulty !== 0 || c.tag !== 'all';
}
