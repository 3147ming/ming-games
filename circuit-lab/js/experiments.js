/**
 * experiments.js — 实验数据模型、结构校验与内置实验清单
 * 模型字段：id / title / desc / durationMin / difficulty(1-3) / tags[]
 *          platform('exp-box'|'breadboard'|null) / equipment[]
 */

/** 难度取值范围 */
const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 3;

/** 预计时长上限（分钟），防止异常配置把界面撑坏 */
const DURATION_MAX = 600;

/** 标签数量上限 */
const TAG_LIMIT = 6;

/** 实验平台合法取值：exp-box=数字电路实验箱，breadboard=面包板 */
const PLATFORMS = ['exp-box', 'breadboard'];

/** 仪器数量上限 */
const EQUIPMENT_LIMIT = 6;

/** 内置实验清单（后续指令包逐步扩充） */
const experiments = [
  {
    id: 'demo-basic-gates',
    title: '基本门电路逻辑验证',
    desc: '验证与/或/非门真值表',
    durationMin: 30,
    difficulty: 1,
    tags: ['数字电路', '入门'],
    platform: 'exp-box',
    equipment: ['数字电路实验箱'],
  },
];

/** 转成一份带防御性副本的实验对象，避免调用方改动内部数据 */
function cloneExperiment(exp) {
  return {
    id: exp.id,
    title: exp.title,
    desc: exp.desc,
    durationMin: exp.durationMin,
    difficulty: exp.difficulty,
    tags: exp.tags.slice(),
    platform: exp.platform,
    equipment: exp.equipment.slice(),
  };
}

/** 规整平台字段：只认两个合法全集值，缺失 / 大小写变体 / 其它类型一律归 null */
export function normalizePlatform(raw) {
  return PLATFORMS.includes(raw) ? raw : null;
}

/** 规整仪器列表：去掉非字符串、空白项与重复项，最多保留上限条数 */
export function normalizeEquipment(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  raw.forEach((item) => {
    if (result.length >= EQUIPMENT_LIMIT) return;
    if (typeof item !== 'string') return;
    const name = item.trim();
    if (name === '' || seen.has(name)) return;
    seen.add(name);
    result.push(name);
  });
  return result;
}

/** 把任意输入规整为合法实验对象：缺省补值、类型纠正、数值夹紧 */
export function normalizeExperiment(raw) {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const desc = typeof raw.desc === 'string' ? raw.desc.trim() : '';

  const rawDuration = Number(raw.durationMin);
  const durationMin = Number.isFinite(rawDuration)
    ? Math.min(Math.max(Math.round(rawDuration), 1), DURATION_MAX)
    : 0;

  const rawDifficulty = Number(raw.difficulty);
  const difficulty = Number.isFinite(rawDifficulty)
    ? Math.min(Math.max(Math.round(rawDifficulty), DIFFICULTY_MIN), DIFFICULTY_MAX)
    : DIFFICULTY_MIN;

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        .map((tag) => tag.trim())
        .slice(0, TAG_LIMIT)
    : [];

  const platform = normalizePlatform(raw.platform);
  const equipment = normalizeEquipment(raw.equipment);

  return { id, title, desc, durationMin, difficulty, tags, platform, equipment };
}

/** 校验配置文件结构：必须是对象且 id / title 为非空字符串 */
export function validateExperiment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '配置内容必须是一个 JSON 对象' };
  }
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    return { ok: false, message: '缺少必填字段 id（非空字符串）' };
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    return { ok: false, message: '缺少必填字段 title（非空字符串）' };
  }
  return { ok: true, message: '' };
}

/** 返回实验清单副本 */
export function getExperiments() {
  return experiments.map(cloneExperiment);
}

/** 按 id 查找实验，未找到返回 null */
export function getExperimentById(id) {
  if (typeof id !== 'string') return null;
  const found = experiments.find((exp) => exp.id === id);
  return found ? cloneExperiment(found) : null;
}

/** 新增实验：id 必须为非空字符串且未被占用；成功返回 true */
export function addExperiment(exp) {
  const check = validateExperiment(exp);
  if (!check.ok) return false;
  const normalized = normalizeExperiment(exp);
  if (experiments.some((item) => item.id === normalized.id)) return false;
  experiments.push(normalized);
  return true;
}

/** 用同 id 的实验整体替换既有条目；id 不存在时返回 false */
export function replaceExperiment(exp) {
  const check = validateExperiment(exp);
  if (!check.ok) return false;
  const normalized = normalizeExperiment(exp);
  const index = experiments.findIndex((item) => item.id === normalized.id);
  if (index === -1) return false;
  experiments[index] = normalized;
  return true;
}
