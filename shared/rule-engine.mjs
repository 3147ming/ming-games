/**
 * 规则工坊 · 本地规则引擎（第三批任务块 K）—— 纯逻辑，零 DOM / 零 fetch / 零 API
 * 模板库 → 关键词解析 → 槽位填充 → 冲突检测 → RuleSet → 规则书 → 体检 → 自对弈 → 短码。
 * 浏览器与 Node 均可用；所有"规则 AI"都在这里，UI 只负责三步流程与展示。
 */

/* ---------------- 模式与牌型表（第四批：牌类模式） ----------------
 * mode 只有两值：board = 棋盘与吃子；card = 发牌/出牌/过牌/补给/洗回/先出完。
 * 牌类规则未问清前，card 里的槽位一律为 null，规则书显示「待确认」，绝不写棋类默认值。
 */
export const MODES = Object.freeze({ BOARD: 'board', CARD: 'card' });

export const CARD_PATTERN_SETS = Object.freeze([
  { id: 'doudizhu', label: '斗地主式（含炸弹、王炸）', short: '斗地主式',
    patterns: ['single', 'pair', 'triple', 'triple-single', 'triple-pair', 'straight', 'double-straight', 'plane', 'bomb', 'rocket'],
    bomb: true, rocket: true, straightMin: 5, excludesTwo: true,
    desc: '单张/对子/三张/三带一/三带二/顺子/连对/飞机/炸弹/王炸，炸弹压普通牌型，王炸最大。' },
  { id: 'zhengshangyou', label: '争上游式', short: '争上游式',
    patterns: ['single', 'pair', 'triple', 'straight', 'double-straight', 'bomb'],
    bomb: true, rocket: false, straightMin: 5, excludesTwo: false,
    desc: '单张/对子/三张/顺子/连对/炸弹，2 可进顺子，无王炸。' },
  { id: 'single', label: '单张压单张', short: '单张压单张',
    patterns: ['single'], bomb: false, rocket: false, straightMin: 0, excludesTwo: false,
    desc: '每次只出一张，点数大者压小者，没有顺子与炸弹。' },
  { id: 'custom', label: '自定义', short: '自定义',
    patterns: ['single', 'pair', 'straight', 'bomb'], bomb: true, rocket: false, straightMin: 5, excludesTwo: false,
    desc: '按描述里的牌型清单生成，不额外补规则。' },
]);
export const CARD_PATTERN_DEFAULT = 'doudizhu';
export const patternSet = (id) => CARD_PATTERN_SETS.find((s) => s.id === id) || CARD_PATTERN_SETS[0];

export const CARD_SUITS = Object.freeze([
  { id: 'S', label: '♠', name: '黑桃', color: '#1c1c28' },
  { id: 'H', label: '♥', name: '红桃', color: '#c62f3b' },
  { id: 'C', label: '♣', name: '梅花', color: '#1c1c28' },
  { id: 'D', label: '♦', name: '方块', color: '#c62f3b' },
]);
export const CARD_RANKS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
export const RANK_LABEL = Object.freeze({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王' });
export const rankLabel = (r) => RANK_LABEL[r] || String(r);

/* ---------------- 模板库（四类各 ≥2，共 12） ---------------- */
const base = (id, type, name, patch = {}) => ({
  id: `tpl-${id}`, type, name, players: 2,
  mode: type === 'board' || id === 'free' ? 'board' : 'card',
  board: { cols: 7, rows: 7, topology: 'grid', zones: [] },
  pieces: [{ id: 'stone', name: '子', count: 12, power: 1,
    move: ['orth1'], art: { glyph: '子', palette: '#B4462F', motif: 'ring2' } }],
  actions: [
    { type: 'place', phase: 'setup', count: 9 },
    { type: 'move', select: 'one', range: 1, dirs: ['orth'] },
    { type: 'capture', by: 'replace', compare: 'power' },
  ],
  win: [{ type: 'eliminate', target: 'all' }],
  draw: [{ type: 'no-capture', rounds: 60 }],
  score: { capture: 1, win: 10 },
  ...patch,
});

export const TEMPLATES = [
  base('capture', 'board', '吃子棋', {
    pieces: [{ id: 'warrior', name: '兵', count: 12, power: 2, move: ['orth1'], art: { glyph: '兵', palette: '#B4462F', motif: 'ring1' } }],
    win: [{ type: 'eliminate', target: 'all' }],
  }),
  base('lineup', 'board', '连线棋', {
    actions: [{ type: 'place', phase: 'setup', count: 12 }, { type: 'move', select: 'one', range: 1, dirs: ['orth'] }],
    win: [{ type: 'lineup', count: 3, times: 1 }],
  }),
  base('surround', 'board', '围困棋', {
    actions: [{ type: 'place', phase: 'setup', count: 10 }, { type: 'move', select: 'one', range: 1, dirs: ['orth'] },
      { type: 'capture', by: 'surround', need: 4 }],
  }),
  base('jump', 'board', '跳吃棋', {
    actions: [{ type: 'place', phase: 'setup', count: 9 }, { type: 'move', select: 'one', range: 1, dirs: ['orth', 'diag'] },
      { type: 'capture', by: 'jump', need: 1 }],
  }),
  base('den', 'board', '兽穴棋', {
    board: { cols: 7, rows: 9, topology: 'grid', zones: [{ name: '兽穴', cells: [[3, 8]] }] },
    pieces: ['鼠','猫','狗','狼','豹','虎','狮','象'].map((n, i) => ({
      id: `beast${i}`, name: n, count: 1, power: i + 1, move: ['orth1'],
      art: { glyph: n, palette: '#B4462F', motif: `ring${(i % 3) + 1}` },
    })),
    win: [{ type: 'reach', zone: '兽穴' }],
  }),
  base('territory', 'board', '占点棋', {
    win: [{ type: 'score', target: 20 }],
    score: { capture: 1, win: 10 },
  }),
  base('race', 'card', '抢分牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    pieces: [{ id: 'card', name: '牌', count: 54, power: 1, move: [], art: { glyph: '牌', palette: '#2DD4BF', motif: 'ring1' } }],
    card: { decks: 1, size: 54, handSize: 5, winBy: 'score', replenish: { winner: 2, others: 1 }, shuffleLimit: 3, patternSet: 'doudizhu', scoreTarget: 21 },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 5 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'score', target: 21 }],
  }),
  base('solitaire', 'card', '接龙牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    card: { decks: 1, size: 54, handSize: 7, winBy: 'empty', replenish: { winner: 0, others: 0 }, shuffleLimit: 3, patternSet: 'single' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 7 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
  base('compare', 'card', '比大小牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    card: { decks: 1, size: 54, handSize: 5, winBy: 'empty', replenish: { winner: 3, others: 1 }, shuffleLimit: 3, patternSet: 'single' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 5 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
  /* 四套牌类族模板：id 与 CARD_FAMILIES 一一对应 */
  base('card-doudizhu', 'card', '斗地主式牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    card: { decks: 1, size: 54, handSize: 17, winBy: 'empty', replenish: { winner: 0, others: 0 }, shuffleLimit: 3, patternSet: 'doudizhu' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 17 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
  base('card-zhengshangyou', 'card', '争上游式牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    card: { decks: 1, size: 54, handSize: 17, winBy: 'empty', replenish: { winner: 0, others: 0 }, shuffleLimit: 3, patternSet: 'zhengshangyou' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 17 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
  base('card-single', 'card', '单张压单张牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    card: { decks: 1, size: 54, handSize: 17, winBy: 'empty', replenish: { winner: 0, others: 0 }, shuffleLimit: 3, patternSet: 'single' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 17 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
  base('card-custom', 'card', '自定义牌型牌', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    card: { decks: 1, size: 54, handSize: 10, winBy: 'empty', replenish: { winner: 6, others: 3 }, shuffleLimit: 3, patternSet: 'custom' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 10 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
  base('mcr', 'mahjong', '简化麻将', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'mahjong', zones: [] },
    pieces: [{ id: 'tile', name: '牌', count: 136, power: 1, move: [], art: { glyph: '牌', palette: '#E8833A', motif: 'ring2' } }],
    actions: [{ type: 'tiles', suits: ['wan', 'tiao', 'tong'] }, { type: 'hu', pattern: '4m1p' }, { type: 'fan', enabled: true }],
    win: [{ type: 'score', target: 8 }],
  }),
  base('sevenpairs', 'mahjong', '七对麻将', {
    mode: 'card', board: { cols: 0, rows: 0, topology: 'mahjong', zones: [] },
    actions: [{ type: 'tiles', suits: ['wan', 'tiao', 'tong'] }, { type: 'hu', pattern: '7pairs' }, { type: 'fan', enabled: true }],
    win: [{ type: 'score', target: 8 }],
  }),
  base('free', 'custom', '自定义棋盘', {
    name: '自定义规则',
    board: { cols: 7, rows: 7, topology: 'grid', zones: [] },
  }),
  base('freecard', 'custom', '自定义抢分', {
    name: '自定义抢分', mode: 'card',
    board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    pieces: [{ id: 'card', name: '牌', count: 54, power: 1, move: [], art: { glyph: '牌', palette: '#8E7CC3', motif: 'ring1' } }],
    card: { decks: 1, size: 54, handSize: 5, winBy: 'empty', replenish: { winner: 0, others: 0 }, shuffleLimit: 3, patternSet: 'doudizhu' },
    actions: [{ type: 'deck', size: 54 }, { type: 'deal', count: 5 }, { type: 'play' }, { type: 'pass' }],
    win: [{ type: 'empty-hand' }],
  }),
];

export const templateByType = (type) => TEMPLATES.filter((t) => t.type === type);
/** 四套牌类模板（合并指令 块5）：按牌型表 families 显式列出，便于工坊按族挑选 */
export const CARD_FAMILIES = Object.freeze([
  { id: 'card-doudizhu', label: '斗地主式（含炸弹）', patternSet: 'doudizhu' },
  { id: 'card-zhengshangyou', label: '争上游式', patternSet: 'zhengshangyou' },
  { id: 'card-single', label: '单张压单张', patternSet: 'single' },
  { id: 'card-custom', label: '自定义牌型', patternSet: 'custom' },
]);
export const TEMPLATE_TYPES = Object.freeze([
  { key: 'board', label: '棋类' }, { key: 'card', label: '扑克' },
  { key: 'mahjong', label: '麻将' }, { key: 'custom', label: '自定义' },
]);

/* ---------------- 关键词 → 原语 ---------------- */
export const KEYWORDS = Object.freeze({
  capture: ['吃', '吃掉', '吃子', 'replace'],
  flank: ['夹', '夹吃', '夹住'],
  surround: ['围', '围吃', '围住', '包围'],
  jump: ['跳吃', '跳过', '跳格吃'],
  lineup: ['连线', '成线', '三连', '连成', '一条线'],
  flip: ['翻', '翻棋', '暗棋'],
  hu: ['胡', '和牌', '七对'],
  fan: ['番', '番型', '翻倍'],
  score: ['分数', '抢分', '得分', '积分'],
  turn: ['回合', '轮次'],
  den: ['兽穴', '目标区', '终点', '到达'],
  board: ['棋盘', '格', '×', 'x'],
  anywhere: ['满天飞', '任意落点', '飞到任意'],
  unsupported: ['传送', '飞行', '时间倒流', '隐藏身份', '骰子'],
});

const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function numOf(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (CN_DIGIT[s]) return CN_DIGIT[s];
  return null;
}

/** 人类可读问题（绝不出现 flank / replace 这类字段名） */
function q(key, text, options, apply, defaultIndex = options.length - 1) {
  return { key, text, options, default: options[defaultIndex], apply };
}

/* 6 类牌类追问：问清之前不允许把棋类默认值（52 张 / 5 张 / 21 分 / 60 回合）写进规则 */
/** 6 类牌类追问；spec 名为合并指令 块6 的类别名，key 为内部字段（兼容既有规则卡）。 */
export const CARD_Q_DEFS = Object.freeze([
  { spec: 'deck-count', key: 'deck-count', text: '牌堆用几副牌？',
    options: ['1 副（54 张）', '2 副（108 张）', '3 副（162 张）', '126 张（自定义）'], field: 'decks', must: true },
  { spec: 'deal-count', key: 'hand-size', text: '开局每人发几张？',
    options: ['5 张', '10 张', '13 张', '17 张'], field: 'handSize', must: true },
  { spec: 'win-mode', key: 'win-by', text: '胜负看「先出完」还是「算分」？',
    options: ['先出完手牌获胜', '达到目标分数获胜'], field: 'winBy', must: true },
  { spec: 'refill', key: 'replenish', text: '一轮出完后怎么补给？',
    options: ['赢家 6 张、其余 3 张', '按名次 6/3/3 递减', '赢家 2 张、其余 1 张', '不补给'], field: 'replenish', must: true },
  { spec: 'reshuffle', key: 'shuffle-limit', text: '牌堆抽空后，弃牌最多洗回几次？',
    options: ['1 次', '3 次', '5 次', '不限次数'], field: 'shuffleLimit', must: true },
  { spec: 'card-ranking', key: 'pattern-set', text: '牌型用哪一套？',
    options: ['斗地主式（含炸弹、王炸）', '争上游式', '单张压单张', '自定义'], field: 'patternSet', must: true },
]);

const EXTRA_CARD_Q = Object.freeze({
  players: { key: 'players', text: '几个人玩？', options: ['2 人', '3 人', '4 人'], field: 'players' },
  'deck-size': { key: 'deck-size', text: '自定义牌堆总共多少张？', options: ['126 张', '108 张', '54 张'], field: 'size' },
  'score-target': { key: 'score-target', text: '算分的话，多少分获胜？', options: ['10 分', '20 分', '50 分'], field: 'scoreTarget' },
});

/** 规则集里还悬而未决的追问（含选择「算分」后的追追问） */
export function pendingQuestions(rs) {
  if (rs?.mode !== 'card' || !rs.pending?.length) return [];
  return rs.pending.map((key) => {
    const def = CARD_Q_DEFS.find((d) => d.key === key) || EXTRA_CARD_Q[key];
    if (!def) return null;
    return q(key, def.text, def.options, () => {}, key === 'pattern-set' ? 0 : def.options.length - 1);
  }).filter(Boolean);
}

/**
 * 描述 → { ruleSet, questions, warnings }
 * 不确定的一律进 questions，绝不自己拍板。
 */
export function parseDescription(text = '', type = 'board') {
  const src = String(text || '');
  const isCard = type === 'card' || type === 'mahjong'
    || (type === 'custom' && /牌|扑克|炸弹|顺子|手牌|出牌/.test(src));
  const mode = type === 'board' || !isCard ? 'board' : 'card';
  const tpl = mode === 'card'
    ? (type === 'custom' ? TEMPLATES.find((t) => t.id === 'tpl-freecard') : templateByType(type)[0])
    : templateByType(type)[0];
  const rs = JSON.parse(JSON.stringify(tpl ?? TEMPLATES[11]));
  rs.mode = mode;
  rs.id = `custom-${Date.now().toString(36)}`;
  rs.name = (src.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:棋|牌|规则)/)?.[1] || rs.name).slice(0, 12);
  const questions = [], warnings = [], hit = new Set();

  /* ===== 牌类模式：6 类必问，未答之前所有牌类槽位都是 null ===== */
  if (mode === 'card') {
    rs.card = { decks: null, size: null, handSize: null, winBy: null,
      replenish: null, shuffleLimit: null, patternSet: null, scoreTarget: null };
    rs.pending = [];
    rs.win = []; rs.draw = [];
    rs.actions = [{ type: 'deck' }, { type: 'deal' }, { type: 'play' }, { type: 'pass' }];
    rs.pieces = [{ id: 'card', name: '牌', count: null, move: [],
      art: { glyph: '牌', palette: '#2DD4BF', motif: 'ring1' } }];

    const decks = src.match(/(\d+|[一两二三四五六])\s*副/);
    if (decks) { rs.card.decks = Math.max(1, Math.min(6, numOf(decks[1]) || 1)); hit.add('deck-count'); }
    const size = src.match(/牌堆\s*(\d+)\s*张|(\d+)\s*张\s*牌堆/);
    if (size) { rs.card.size = Number(size[1] || size[2]); hit.add('deck-count'); }
    const hand = src.match(/(?:发|每人|手牌|起手|开局)\s*(\d+|[一二三四五六七八九十])\s*张/)
      || src.match(/(\d+|[一二三四五六七八九十])\s*张\s*(?:手牌|起手)/);
    if (hand) { rs.card.handSize = numOf(hand[1]); hit.add('hand-size'); }

    if (/先出完|出完手牌|先走完|先走/.test(src)) {
      rs.card.winBy = 'empty'; rs.win = [{ type: 'empty-hand' }]; hit.add('win-by');
    } else if (/算分|目标分|分数达到|积分/.test(src)) {
      rs.card.winBy = 'score'; hit.add('win-by');
      const t = src.match(/分数达到\s*(\d+)|(\d+)\s*分(?:获胜|赢)/);
      if (t) { rs.card.scoreTarget = Number(t[1] || t[2]); rs.win = [{ type: 'score', target: rs.card.scoreTarget }]; }
      else rs.pending.push('score-target');
    }

    const rep = src.match(/赢家\s*(\d+)\s*张?\s*[、,，]?\s*其余\s*(\d+)/);
    if (rep) { rs.card.replenish = { winner: Number(rep[1]), others: Number(rep[2]) }; hit.add('replenish'); }
    else if (/名次|排名/.test(src)) {
      const m = src.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
      rs.card.replenish = { rank: m ? m.slice(1).map(Number) : [6, 3, 3] }; hit.add('replenish');
    } else if (/不补给|无补给/.test(src)) { rs.card.replenish = { winner: 0, others: 0 }; hit.add('replenish'); }

    const sh = src.match(/(?:洗回|洗牌|重洗|洗)\s*(\d+|[一两二三四五六])\s*次|最多\s*(\d+)\s*次\s*(?:洗|重洗)/);
    if (sh) { rs.card.shuffleLimit = numOf(sh[1] || sh[2]) ?? 3; hit.add('shuffle-limit'); }
    else if (/不限次数|无限洗/.test(src)) { rs.card.shuffleLimit = -1; hit.add('shuffle-limit'); }

    const pat = /斗地主/.test(src) ? 'doudizhu' : /争上游/.test(src) ? 'zhengshangyou'
      : /单张压单张|只比单张/.test(src) ? 'single' : /炸弹|王炸|顺子|连对|飞机/.test(src) ? 'doudizhu'
      : /自定义牌型/.test(src) ? 'custom' : null;
    if (pat) { rs.card.patternSet = pat; hit.add('pattern-set'); }

    const players = src.match(/(\d+|[一两二三四])\s*人/);
    if (players) rs.players = Math.max(2, Math.min(4, numOf(players[1]) || 2));
    else { rs.pending.push('players'); questions.push(q('players', '几个人玩？', ['2 人', '3 人', '4 人'], () => {}, 0)); }

    // 6 类牌类问题一律列出（已写明的标 settled 供确认，未写明的进 pending 阻断生成）
    for (const d of CARD_Q_DEFS) {
      const settled = hit.has(d.key);
      const question = q(d.key, d.text, d.options, () => {}, d.key === 'pattern-set' ? 0 : d.options.length - 1);
      question.spec = d.spec;
      question.must = d.must;
      question.settled = settled;
      questions.push(question);
      if (!settled) rs.pending.push(d.key);
    }
    if (rs.card.decks && !rs.card.size) rs.card.size = rs.card.decks * 54;
    if (rs.card.size && !rs.card.decks) rs.card.decks = Math.max(1, Math.ceil(rs.card.size / 54));
    if (hit.size < 3) warnings.push('牌类规则要问清牌堆、手牌、胜负、补给、洗牌与牌型；下面逐项回答，绝不会替你填 52 张 / 5 张 / 21 分 / 60 回合这类棋类默认值。');
    return { ruleSet: rs, questions, warnings };
  }

  // 槽位：棋盘尺寸
  const size = src.match(/(\d+|[一二三四五六七八九十])\s*[×xX*]\s*(\d+|[一二三四五六七八九十])/);
  if (size) {
    rs.board.cols = Math.max(3, Math.min(19, numOf(size[1]) || 7));
    rs.board.rows = Math.max(3, Math.min(19, numOf(size[2]) || 7));
    hit.add('board');
  } else if (type === 'board' || type === 'custom') {
    questions.push(q('board-size', '棋盘要多大？', ['7×7（推荐）', '9×9', '5×5'], (o) => {
      const [c, r] = o.match(/\d+/g).map(Number); rs.board.cols = c; rs.board.rows = r;
    }));
  }

  // 槽位：人数
  const players = src.match(/(\d+|[一两二三四])\s*人/);
  if (players) rs.players = Math.max(2, Math.min(4, numOf(players[1]) || 2));
  else questions.push(q('players', '几个人玩？', ['2 人', '3 人', '4 人'], (o) => { rs.players = Number(o[0]); }));

  // 槽位：连线数 / 回合数 / 棋子数
  const line = src.match(/(三|四|五|\d+)\s*子?\s*(?:连线|连成一线|成线)/);
  if (line) { rs.win = [{ type: 'lineup', count: numOf(line[1]) || 3, times: 1 }]; hit.add('lineup'); }
  const rounds = src.match(/(\d+)\s*回合/);
  if (rounds) rs.draw = [{ type: 'no-capture', rounds: Number(rounds[1]) }];
  const pieces = src.match(/(\d+|[一二三四五六七八九十])\s*枚?\s*(?:子|棋)/);
  if (pieces) rs.pieces[0].count = Math.max(1, Math.min(30, numOf(pieces[1]) || 12));

  // 关键词 → 吃法（只认引擎原语）
  const found = new Set();
  for (const [key, words] of Object.entries(KEYWORDS)) {
    if (words.some((w) => src.includes(w))) found.add(key);
  }
  if (found.has('surround')) { rs.actions = rs.actions.filter((a) => a.type !== 'capture'); rs.actions.push({ type: 'capture', by: 'surround', need: 4 }); hit.add('surround'); }
  if (found.has('flank')) { rs.actions = rs.actions.filter((a) => a.type !== 'capture'); rs.actions.push({ type: 'capture', by: 'flank', need: 2 }); hit.add('flank'); }
  if (found.has('jump')) { rs.actions = rs.actions.filter((a) => a.type !== 'capture'); rs.actions.push({ type: 'capture', by: 'jump', need: 1 }); hit.add('jump'); }
  if (found.has('lineup')) { rs.win = [{ type: 'lineup', count: 3, times: 1 }]; hit.add('lineup'); }
  if (found.has('den')) {
    rs.pieces = JSON.parse(JSON.stringify(templateByType('board')[4].pieces));
    rs.board.zones = [{ name: '目标区', cells: [[Math.floor(rs.board.cols / 2), rs.board.rows - 1]] }];
    rs.win = [{ type: 'reach', zone: '目标区' }]; hit.add('den');
  }
  if (found.has('score')) { rs.win = [{ type: 'score', target: 21 }]; hit.add('score'); }
  if (found.has('hu')) { rs.actions.push({ type: 'hu', pattern: src.includes('七对') ? '7pairs' : '4m1p' }); hit.add('hu'); }
  if (found.has('fan')) { rs.actions.push({ type: 'fan', enabled: true }); hit.add('fan'); }
  if (found.has('anywhere')) { rs.actions.push({ type: 'move', select: 'one', range: -1, dirs: ['anywhere'] }); hit.add('anywhere'); }

  // 冲突：不自己选，转成问题
  if (found.has('surround') && found.has('jump')) {
    questions.push(q('capture-conflict', '你同时写了「围住吃」和「跳着吃」，先用哪一种？',
      ['围住四周才吃', '隔一子跳吃', '两种都要（默认）'], (o) => {
        const by = o.startsWith('围') ? 'surround' : o.startsWith('隔') ? 'jump' : 'both';
        rs.actions = rs.actions.filter((a) => a.type !== 'capture');
        if (by === 'both') rs.actions.push({ type: 'capture', by: 'surround', need: 4 }, { type: 'capture', by: 'jump', need: 1 });
        else rs.actions.push({ type: 'capture', by, need: by === 'surround' ? 4 : 1 });
      }));
  }
  if (found.has('den') && found.has('lineup')) {
    questions.push(q('win-conflict', '到目标区就赢，还是连成一线就赢？',
      ['到目标区获胜', '连成一线获胜', '两者皆可（默认）'], (o) => {
        const w = o.startsWith('到') ? [{ type: 'reach', zone: '目标区' }]
          : o.startsWith('连') ? [{ type: 'lineup', count: 3, times: 1 }]
          : [{ type: 'reach', zone: '目标区' }, { type: 'lineup', count: 3, times: 1 }];
        rs.win = w;
      }));
  }
  if (found.has('unsupported')) {
    questions.push(q('unsupported', `「${[...found].filter((k) => k === 'unsupported').map(() => '传送/飞行/骰子等').join('')}」这版引擎还不会做，要不要换成已有的走法？`,
      ['改成普通走一格', '改成满天飞', '保持但我先只做能做的（默认）'], (o) => {
        if (o.startsWith('改成普通')) rs.actions.push({ type: 'move', select: 'one', range: 1, dirs: ['orth'] });
        if (o.startsWith('改成满天')) rs.actions.push({ type: 'move', select: 'one', range: -1, dirs: ['anywhere'] });
      }));
  }

  // 必问情形：描述里没提就别默认替玩家决定（胜负 / 和棋先清空再问）
  const hasWinWords = ['吃光', '消灭', '到达', '到目标', '连线', '成线', '分数', '赢', '胜', '胡'].some((w) => src.includes(w));
  const hasDrawWords = ['回合', '和棋', '平局', '僵持', '重复'].some((w) => src.includes(w));
  if (!hasWinWords && (type === 'board' || type === 'custom')) rs.win = [];
  if (!hasDrawWords && (type === 'board' || type === 'custom')) rs.draw = [];

  // 描述完全没提吃法时，不要把模板自带的吃法当成玩家的规则（必问）
  const hasCaptureWord = ['吃', '夹', '围', '跳', '占', 'replace'].some((w) => src.includes(w));
  if (!hasCaptureWord && (type === 'board' || type === 'custom')) {
    rs.actions = rs.actions.filter((a) => a.type !== 'capture');
  }

  // 必问情形：缺吃法 / 缺胜负 / 缺和棋
  if (!hit.size) warnings.push('描述里没有识别到明确原语，已按模板生成，可在第 3 步追问修改。');
  if (!rs.actions.some((a) => a.type === 'capture') && (type === 'board' || type === 'custom')) {
    questions.push(q('capture-missing', '棋子怎么吃对方？',
      ['走一步占掉对方的格子', '夹住两边才吃', '这一局不设吃子（默认）'], (o) => {
        if (o.startsWith('走一步')) rs.actions.push({ type: 'capture', by: 'replace', compare: 'power' });
        if (o.startsWith('夹住')) rs.actions.push({ type: 'capture', by: 'flank', need: 2 });
      }));
  }
  if (!rs.win.length) questions.push(q('win-missing', '怎样算赢？', ['吃光对方', '先到目标区', '先达到分数（默认）'], (o) => {
    rs.win = [o.startsWith('吃光') ? { type: 'eliminate', target: 'all' }
      : o.startsWith('先到') ? { type: 'reach', zone: '目标区' } : { type: 'score', target: 21 }];
  }));
  if (!rs.draw.length) questions.push(q('draw-missing', '一直僵持不下怎么办？', ['60 回合无吃子判和', '三次重复局面判和', '不设和棋（默认）'], (o) => {
    rs.draw = o.startsWith('60') ? [{ type: 'no-capture', rounds: 60 }]
      : o.startsWith('三次') ? [{ type: 'threefold' }] : [];
  }));

  return { ruleSet: rs, questions: questions.slice(0, 3), warnings };
}

/** 回答追问：写回 RuleSet，版本号 +1 */
/** 牌类追问写回：选项 → 明确参数；未答的继续留在 pending 里 */
function applyCardAnswer(parsed, key, o) {
  const c = parsed.card || (parsed.card = {});
  const num = () => Number((String(o).match(/\d+/) || [0])[0]);
  switch (key) {
    case 'players': parsed.players = num() || 2; break;
    case 'deck-count':
      if (String(o).includes('126')) { c.size = 126; c.decks = 3; }
      else { c.decks = num() || 1; c.size = c.decks * 54; }
      break;
    case 'deck-size': c.size = num() || 54; c.decks = Math.max(1, Math.ceil(c.size / 54)); break;
    case 'hand-size': c.handSize = num(); break;
    case 'win-by':
      if (String(o).startsWith('先出完')) { c.winBy = 'empty'; parsed.win = [{ type: 'empty-hand' }]; }
      else {
        c.winBy = 'score';
        if (!c.scoreTarget) { parsed.win = []; parsed.pending = [...new Set([...(parsed.pending || []), 'score-target'])]; }
      }
      break;
    case 'score-target': c.scoreTarget = num(); parsed.win = [{ type: 'score', target: c.scoreTarget }]; break;
    case 'replenish':
      if (String(o).startsWith('赢家 6')) c.replenish = { winner: 6, others: 3 };
      else if (String(o).startsWith('按名次')) c.replenish = { rank: [6, 3, 3] };
      else if (String(o).startsWith('赢家 2')) c.replenish = { winner: 2, others: 1 };
      else c.replenish = { winner: 0, others: 0 };
      break;
    case 'shuffle-limit': c.shuffleLimit = String(o).includes('不限') ? -1 : num(); break;
    case 'pattern-set':
      c.patternSet = String(o).startsWith('斗地主') ? 'doudizhu'
        : String(o).startsWith('争上游') ? 'zhengshangyou'
        : String(o).startsWith('单张') ? 'single' : 'custom';
      break;
    default: return;
  }
  if (parsed.pending) parsed.pending = parsed.pending.filter((k) => k !== key);
  if (c.size && parsed.pieces?.[0]) parsed.pieces[0].count = c.size;
  const deal = (parsed.actions || []).find((a) => a.type === 'deal');
  if (deal && c.handSize) deal.count = c.handSize;
  const deck = (parsed.actions || []).find((a) => a.type === 'deck');
  if (deck && c.size) deck.size = c.size;
}

export function answerQuestions(rs, answers = []) {
  const parsed = typeof rs === 'string' ? JSON.parse(rs) : JSON.parse(JSON.stringify(rs));
  for (const a of answers) {
    if (!a?.key || !a?.option) continue;
    if (parsed.mode === 'card') { applyCardAnswer(parsed, a.key, a.option); continue; }
    // 选项的写回函数在 parse 时闭包丢失，这里按 key 做等价写回
    const o = a.option;
    if (a.key === 'board-size') { const [c, r] = o.match(/\d+/g).map(Number); parsed.board.cols = c; parsed.board.rows = r; }
    if (a.key === 'players') parsed.players = Number(o[0]);
    if (a.key === 'capture-missing') {
      if (o.startsWith('走一步')) parsed.actions.push({ type: 'capture', by: 'replace', compare: 'power' });
      if (o.startsWith('夹住')) parsed.actions.push({ type: 'capture', by: 'flank', need: 2 });
    }
    if (a.key === 'capture-conflict') {
      parsed.actions = parsed.actions.filter((x) => x.type !== 'capture');
      const by = o.startsWith('围') ? 'surround' : o.startsWith('隔') ? 'jump' : 'both';
      if (by === 'both') parsed.actions.push({ type: 'capture', by: 'surround', need: 4 }, { type: 'capture', by: 'jump', need: 1 });
      else parsed.actions.push({ type: 'capture', by, need: by === 'surround' ? 4 : 1 });
    }
    if (a.key === 'win-conflict' || a.key === 'win-missing') {
      parsed.win = [o.startsWith('吃光') ? { type: 'eliminate', target: 'all' }
        : o.startsWith('到') || o.startsWith('先到') ? { type: 'reach', zone: '目标区' }
        : o.startsWith('连') ? { type: 'lineup', count: 3, times: 1 }
        : { type: 'score', target: 21 }];
    }
    if (a.key === 'draw-missing') {
      parsed.draw = o.startsWith('60') ? [{ type: 'no-capture', rounds: 60 }]
        : o.startsWith('三次') ? [{ type: 'threefold' }] : [];
    }
    if (a.key === 'unsupported') {
      if (o.startsWith('改成普通')) parsed.actions.push({ type: 'move', select: 'one', range: 1, dirs: ['orth'] });
      if (o.startsWith('改成满天')) parsed.actions.push({ type: 'move', select: 'one', range: -1, dirs: ['anywhere'] });
    }
  }
  parsed.version = (parsed.version || 1) + 1;
  return parsed;
}

/* ---------------- RuleSet 校验 ---------------- */
export function validateRuleSet(rs) {
  const issues = [];
  if (!rs || typeof rs !== 'object') return { ok: false, blocking: false, issues: ['不是有效的规则对象'] };
  if (!rs.id || !rs.name || !rs.type) issues.push('缺少 id / name / type');
  if (!Array.isArray(rs.pieces) || !rs.pieces.length) issues.push('缺少棋子定义');
  if (!Array.isArray(rs.actions) || !rs.actions.length) issues.push('缺少行为定义');
  const pending = rs.mode === 'card' && rs.pending?.length;
  if (!pending && (!Array.isArray(rs.win) || !rs.win.length)) issues.push('缺少终止条件');
  if (!Array.isArray(rs.draw)) issues.push('缺少和棋配置');
  if (!rs.score || typeof rs.score !== 'object') issues.push('缺少计分配置');
  if (rs.mode !== 'card' && rs.board && (!Number.isFinite(rs.board.cols) || !Number.isFinite(rs.board.rows))) issues.push('棋盘尺寸无效');
  if (rs.mode === 'card' && !pending && rs.card) {
    const need = ['decks', 'size', 'handSize', 'winBy', 'replenish', 'shuffleLimit', 'patternSet'];
    if (rs.card.winBy === 'score') need.push('scoreTarget');
    for (const k of need) {
      if (rs.card[k] === null || rs.card[k] === undefined) issues.push(`牌类参数待确认：${k}`);
    }
  }
  for (const a of rs.actions || []) {
    if (!['place', 'move', 'capture', 'deck', 'deal', 'patterns', 'tiles', 'hu', 'fan', 'play', 'pass', 'reshuffle'].includes(a.type)) {
      issues.push(`不支持的行为：${a.type}`);
    }
    if (a.type === 'capture' && !['replace', 'flank', 'surround', 'jump'].includes(a.by)) {
      issues.push(`不支持的吃法：${a.by}`);
    }
  }
  for (const w of rs.win || []) {
    if (!['eliminate', 'reach', 'lineup', 'score', 'empty-hand'].includes(w.type)) issues.push(`不支持的胜负条件：${w.type}`);
  }
  // 合并指令 块6：必问项未答 → blocking:true，禁止进入生成步骤，页面显示具体缺项
  const missing = [];
  if (rs.mode === 'card' && Array.isArray(rs.pending)) {
    for (const key of rs.pending) {
      const def = CARD_Q_DEFS.find((d) => d.key === key || d.spec === key);
      if (def) missing.push(`${def.spec}（${def.text}）`);
      else if (key === 'players') missing.push('players（几个人玩？）');
      else if (key === 'score-target') missing.push('目标分数（算分获胜需填多少分？）');
      else if (key === 'deck-size') missing.push('牌堆张数（自定义牌堆总共多少张？）');
    }
  }
  const blocking = missing.length > 0;
  if (blocking) issues.push(`牌类必问项未答，不能生成：${missing.join('、')}`);
  return { ok: issues.length === 0 && !blocking, blocking, missing, issues, pending: pending ? [...rs.pending] : [] };
}

/* ---------------- 规则书 Markdown ---------------- */
const wait = (v) => (v === null || v === undefined ? '待确认' : String(v));

/** 牌类规则卡：只写问到的参数，未答的一律「待确认」，绝不出现棋类默认数字 */
export function cardRuleBook(rs) {
  const c = rs.card || {};
  const set = CARD_PATTERN_SETS.find((s) => s.id === c.patternSet);
  const rep = c.replenish;
  const repText = !rep ? '待确认'
    : Array.isArray(rep.rank) ? `按名次 ${rep.rank.join('/')} 张`
    : `${rep.winner} 张、其余 ${rep.others} 张`;
  const L = [];
  L.push(`# ${rs.name || '自定义牌规则'}`);
  L.push('', `> 规则 ID 　\`${rs.id}\`　·　模式 牌类　·　${wait(rs.players)} 人`);
  if (rs.pending?.length) L.push('', `> ⚠ 待你确认：${rs.pending.join(' / ')}。这些项不填默认值。`);
  L.push('', '## 牌堆');
  L.push(`- 共 ${wait(c.size)} 张（${wait(c.decks)} 副，每副 54 张）。`);
  L.push(`- 开局每人发 ${wait(c.handSize)} 张。`);
  L.push(`- 牌堆抽空后弃牌洗回，最多 ${c.shuffleLimit === null || c.shuffleLimit === undefined ? '待确认' : c.shuffleLimit < 0 ? '不限' : c.shuffleLimit} 次。`);
  L.push('', '## 牌型');
  L.push(`- ${set ? set.label : '待确认'}：${set ? set.desc : '请从四套内置方案里选一套。'}`);
  L.push('', '## 出牌');
  L.push('- 轮流出牌，跟不出可以过牌；一轮结束后按补给方案补牌。');
  L.push(`- 补给：赢家 ${repText}。`);
  L.push('', '## 胜负');
  if (c.winBy === 'empty') L.push('- 先出完手牌者获胜。');
  else if (c.winBy === 'score') L.push(`- 先达到 ${wait(c.scoreTarget)} 分者获胜。`);
  else L.push('- 胜负口径待确认：先出完手牌，还是算分？');
  L.push('', '## 计分');
  L.push(`洗回次数 ${c.shuffleLimit === -1 ? '不限' : wait(c.shuffleLimit)}，赢家按补给方案优先摸牌；不设吃子计分。`);
  L.push('', `<!-- version:${rs.version || 1} -->`);
  return L.join('\n');
}

export function ruleBook(rs) {
  if (rs?.mode === 'card') return cardRuleBook(rs);
  const L = [];
  L.push(`# ${rs.name || '自定义规则'}`);
  L.push('', `> 规则 ID 　\`${rs.id}\`　·　类型 ${rs.type}　·　${rs.players || 2} 人`);
  L.push('', '## 棋盘');
  L.push(rs.board?.cols ? `${rs.board.cols} × ${rs.board.rows}（${rs.board.topology || 'grid'}）` : '牌类对局，无棋盘。');
  for (const z of rs.board?.zones || []) L.push(`- 特殊区域「${z.name}」：${(z.cells || []).map((c) => `(${c[0]},${c[1]})`).join(' ')}`);
  L.push('', '## 棋子');
  for (const p of rs.pieces || []) L.push(`- **${p.name}** ×${p.count}${p.power ? `，战力 ${p.power}` : ''}，走法：${(p.move || []).join(' / ') || '—'}`);
  L.push('', '## 走法');
  for (const a of rs.actions || []) {
    if (a.type === 'move') L.push(a.range < 0 ? '- 可飞到任意空点。' : `- 每次走 ${a.range || 1} 格，方向 ${(a.dirs || []).join(' / ')}。`);
    if (a.type === 'place') L.push(`- 布子阶段每方放 ${a.count} 枚。`);
    if (a.type === 'deal') L.push(`- 每人发 ${a.count} 张。`);
  }
  L.push('', '## 吃法');
  const captures = (rs.actions || []).filter((a) => a.type === 'capture');
  if (!captures.length) L.push('- 本局不设吃子。');
  for (const a of captures) {
    L.push(({ replace: '- 走到对方所在位置即吃掉（战力大吃小 / 同级可吃）。',
      flank: `- 夹住对方两边（需 ${a.need || 2} 枚）即吃。`,
      surround: `- 四面围住（需 ${a.need || 4} 枚）即吃。`,
      jump: `- 隔一子跳吃。` })[a.by] || `- ${a.by}`);
  }
  L.push('', '## 胜负');
  for (const w of rs.win || []) L.push(`- ${({ eliminate: '吃光对方全部棋子即胜。', reach: `到达「${w.zone}」即胜。`,
    lineup: `连成 ${w.count || 3} 子一线 ${w.times || 1} 次即胜。`, score: `分数达到 ${w.target} 即胜。` })[w.type] || w.type}`);
  L.push('', '## 和棋');
  L.push((rs.draw || []).map((d) => ({ 'no-capture': `${d.rounds} 回合无吃子判和`, threefold: '三次重复局面判和', stalemate: '无子可动判和' })[d.type] || d.type).join('；') || '未设置和棋条件。');
  L.push('', '## 计分');
  L.push(`吃子 ${rs.score?.capture ?? 1} 分，获胜 ${rs.score?.win ?? 10} 分。`);
  L.push('', `<!-- version:${rs.version || 1} -->`);
  return L.join('\n');
}

/** 用户改规则书文字 → 能同步的参数同步回去；对不上的标红返回 */
export function applyBookEdits(rs, md) {
  const next = JSON.parse(JSON.stringify(rs));
  const conflict = [];
  const size = md.match(/(\d+)\s*[×xX]\s*(\d+)/);
  if (size) {
    const [c, r] = size.slice(1).map(Number);
    if (c !== next.board.cols || r !== next.board.rows) {
      if (/\d+\s*×\s*\d+/.test(ruleBook(next))) { next.board.cols = c; next.board.rows = r; }
      else conflict.push('棋盘尺寸原文对不上，请确认');
    }
  }
  const rounds = md.match(/(\d+)\s*回合无吃子/);
  if (rounds && next.draw?.[0]?.type === 'no-capture') next.draw[0].rounds = Number(rounds[1]);
  const target = md.match(/分数达到\s*(\d+)/);
  if (target) { const w = next.win.find((x) => x.type === 'score'); if (w) w.target = Number(target[1]); else conflict.push('原文里的分数目标在 RuleSet 中不存在'); }
  const line = md.match(/连成\s*(\d+)\s*子/);
  if (line) { const w = next.win.find((x) => x.type === 'lineup'); if (w) w.count = Number(line[1]); else conflict.push('原文里的连线长度在 RuleSet 中不存在'); }
  return { ruleSet: next, conflict };
}

/* ---------------- 通用规则引擎（网格类） ---------------- */
const DIRS = { orth: [[1,0],[-1,0],[0,1],[0,-1]], diag: [[1,1],[1,-1],[-1,1],[-1,-1]] };
function key(x, y) { return `${x},${y}`; }

/* ---------------- 牌类引擎：发牌 / 出牌 / 过牌 / 补给 / 洗回 / 先出完 ---------------- */
function rngFrom(seed) {
  let s = 2166136261;
  for (const ch of String(seed)) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 按副数与自定义张数造牌：52 普通牌 + 大小王，每副 54 张 */
export function buildDeck(spec = {}) {
  const decks = Math.max(1, Number(spec.decks) || Math.ceil((Number(spec.size) || 54) / 54));
  const cards = [];
  let seq = 0;
  for (let d = 0; d < decks; d++) {
    for (const s of CARD_SUITS) for (const r of CARD_RANKS) {
      cards.push({ id: `c${seq++}`, suit: s.id, suitLabel: s.label, suitName: s.name,
        color: s.color, rank: r, label: rankLabel(r), deck: d, joker: false });
    }
    for (const [rank, label] of [[16, '小王'], [17, '大王']]) {
      cards.push({ id: `c${seq++}`, suit: 'JOKER', suitLabel: '★', suitName: '王',
        color: '#c62f3b', rank, label, deck: d, joker: true });
    }
  }
  const size = Number(spec.size);
  return Number.isFinite(size) && size > 0 ? cards.slice(0, size) : cards;
}

/** 识别一手牌的牌型；不在所选牌型表里返回 null */
export function identifyPattern(cards = [], setId = 'doudizhu') {
  const set = patternSet(setId);
  const cs = cards.slice().sort((a, b) => a.rank - b.rank);
  const n = cs.length;
  if (!n) return null;
  const ranks = cs.map((c) => c.rank);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const allSame = counts.size === 1;
  const base = { cards: cs, len: n, rank: ranks[ranks.length - 1] };
  const allow = (id) => set.patterns.includes(id);

  if (n === 1 && allow('single')) return { ...base, id: 'single', name: '单张' };
  if (n === 2 && cs.every((c) => c.suit === 'JOKER') && allow('rocket'))
    return { ...base, id: 'rocket', name: '王炸', rank: 17 };
  if (n === 2 && allSame && allow('pair')) return { ...base, id: 'pair', name: '对子' };
  if (n === 3 && allSame && allow('triple')) return { ...base, id: 'triple', name: '三张' };
  if (n === 4 && allSame && allow('bomb')) return { ...base, id: 'bomb', name: '炸弹' };
  if (n === 4 && counts.size === 2 && [...counts.values()].includes(3) && allow('triple-single'))
    return { ...base, id: 'triple-single', name: '三带一', rank: [...counts.entries()].find(([, c]) => c === 3)[0] };
  if (n === 5 && counts.size === 2 && [...counts.values()].includes(3) && allow('triple-pair'))
    return { ...base, id: 'triple-pair', name: '三带二', rank: [...counts.entries()].find(([, c]) => c === 3)[0] };

  const plain = cs.filter((c) => !c.joker);
  const pr = plain.map((c) => c.rank);
  const consecutive = (rs) => rs.every((r, i) => i === 0 || r === rs[i - 1] + 1);
  const unique = (rs) => new Set(rs).size === rs.length;
  const usable = (rs) => !set.excludesTwo || rs.every((r) => r < 15);
  if (n >= set.straightMin && n === plain.length && unique(pr) && consecutive(pr) && usable(pr) && allow('straight'))
    return { ...base, id: 'straight', name: '顺子', rank: Math.max(...pr) };
  if (n >= 6 && n % 2 === 0 && n === plain.length && counts.size === n / 2
    && [...counts.values()].every((c) => c === 2) && consecutive([...counts.keys()].sort((a, b) => a - b))
    && usable([...counts.keys()]) && allow('double-straight'))
    return { ...base, id: 'double-straight', name: '连对', rank: Math.max(...counts.keys()) };
  if (n >= 6 && n % 3 === 0 && n === plain.length && counts.size === n / 3
    && [...counts.values()].every((c) => c === 3) && consecutive([...counts.keys()].sort((a, b) => a - b))
    && usable([...counts.keys()]) && allow('plane'))
    return { ...base, id: 'plane', name: '飞机', rank: Math.max(...counts.keys()) };
  return null;
}

/** a 能否压住 b（b 为空表示自由出牌） */
export function beatsPattern(a, b, setId = 'doudizhu') {
  if (!a) return false;
  if (!b) return true;
  if (a.id === 'rocket') return true;
  if (b.id === 'rocket') return false;
  if (a.id === 'bomb' && b.id !== 'bomb') return true;
  if (b.id === 'bomb' && a.id !== 'bomb') return false;
  return a.id === b.id && a.len === b.len && a.rank > b.rank;
}

function candidatePlays(hand = [], setId = 'doudizhu', target = null) {
  const set = patternSet(setId);
  const groups = new Map();
  for (const c of hand) {
    if (!groups.has(c.rank)) groups.set(c.rank, []);
    groups.get(c.rank).push(c);
  }
  const tries = [];
  for (const cs of groups.values()) {
    tries.push([cs[0]]);
    if (cs.length >= 2) tries.push(cs.slice(0, 2));
    if (cs.length >= 3) tries.push(cs.slice(0, 3));
    if (cs.length >= 4 && set.bomb) tries.push(cs.slice(0, 4));
  }
  const jokers = hand.filter((c) => c.suit === 'JOKER');
  if (jokers.length === 2 && set.rocket) tries.push(jokers);
  const ranks = [...groups.keys()].filter((r) => r < 15).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    const run = [ranks[i]];
    for (let j = i + 1; j < ranks.length && ranks[j] === run[run.length - 1] + 1; j++) {
      run.push(ranks[j]);
      if (run.length >= (set.straightMin || 5)) tries.push(run.map((r) => groups.get(r)[0]));
    }
  }
  const seen = new Set();
  const out = [];
  for (const cs of tries.slice(0, 160)) {
    const pat = identifyPattern(cs, setId);
    const k = cs.map((c) => c.id).sort().join(',');
    if (!pat || seen.has(k) || !beatsPattern(pat, target, setId)) continue;
    seen.add(k);
    out.push({ cards: cs.map((c) => c.id), pattern: pat });
  }
  return out;
}

function createCardEngine(rs) {
  const c = rs.card || {};
  const cfg = {
    decks: c.decks ?? 1, size: c.size ?? 54, handSize: c.handSize ?? 5,
    winBy: c.winBy ?? 'empty', replenish: c.replenish ?? { winner: 0, others: 0 },
    shuffleLimit: c.shuffleLimit ?? 3, patternSet: c.patternSet ?? 'doudizhu',
    scoreTarget: c.scoreTarget ?? (rs.win || []).find((w) => w.type === 'score')?.target ?? 20,
  };
  const ids = Array.from({ length: Math.max(2, Math.min(4, rs.players || 2)) }, (_, i) => String.fromCharCode(97 + i));

  function start(seed = 0) {
    const rng = rngFrom(`${rs.id || 'rule'}|${rs.version || 1}|${seed}`);
    const pile = shuffle(buildDeck(cfg), rng);
    const hands = Object.fromEntries(ids.map((id) => [id, []]));
    for (let i = 0; i < cfg.handSize; i++) for (const id of ids) {
      if (pile.length) hands[id].push(pile.pop());
    }
    return {
      mode: 'card', cfg, ids, rng, turn: ids[0], leader: ids[0], round: 1,
      hands, pile, discard: [], lastPlay: null, passed: {}, shuffles: 0,
      maxShuffles: cfg.shuffleLimit < 0 ? Infinity : cfg.shuffleLimit,
      winner: null, reason: null, steps: 0, tricks: 0,
      score: Object.fromEntries(ids.map((id) => [id, 0])), ranks: {},
      log: [`发牌：每人 ${cfg.handSize} 张，牌堆剩 ${pile.length} 张`],
    };
  }

  function moves(s, side = s.turn) {
    if (s.winner || !s.hands[side]?.length) return [];
    const leading = !s.lastPlay || s.lastPlay.side === side;
    const plays = candidatePlays(s.hands[side], cfg.patternSet, leading ? null : s.lastPlay.pattern);
    return leading ? plays : [...plays, { pass: true }];
  }

  function nextTurn(s) {
    const i = s.ids.indexOf(s.turn);
    s.turn = s.ids[(i + 1) % s.ids.length];
    if (i === s.ids.length - 1) s.round++;
  }

  function reshuffle(s) {
    if (!s.discard.length) return false;
    if (s.shuffles >= s.maxShuffles) {
      s.log.push(`洗牌上限 ${s.maxShuffles} 次已到，停止洗回`);
      return false;
    }
    const cards = s.discard.splice(0);
    s.pile = shuffle(cards, s.rng);
    s.shuffles++;
    s.log.push(`牌堆抽空：第 ${s.shuffles} 次洗回 ${cards.length} 张`);
    return true;
  }

  function replenish(s, winner) {
    const rep = cfg.replenish || {};
    for (const id of s.ids) {
      let n = id === winner ? (rep.winner ?? 0)
        : Array.isArray(rep.rank) ? (rep.rank[s.ids.indexOf(id)] ?? rep.rank[rep.rank.length - 1] ?? 0)
        : (rep.others ?? 0);
      for (let k = 0; k < n; k++) {
        if (!s.pile.length && !reshuffle(s)) break;
        s.hands[id].push(s.pile.pop());
      }
    }
  }

  function finishGame(s, side) {
    s.winner = side;
    s.reason = cfg.winBy === 'score' ? 'score' : 'empty-hand';
    const rest = s.ids.filter((id) => id !== side).sort((a, b) => s.hands[b].length - s.hands[a].length);
    s.ranks[side] = 1;
    rest.forEach((id, i) => { s.ranks[id] = i + 2; });
    s.log.push(`终局：${side} 获胜（${s.reason}），名次 ${s.ids.map((id) => `${id}:${s.ranks[id]}`).join(' ')}`);
  }

  function finishTrick(s) {
    const winner = s.leader;
    s.tricks++;
    s.log.push(`第 ${s.round} 轮 ${winner} 赢下本轮`);
    if (cfg.winBy === 'score') s.score[winner] += 1;
    replenish(s, winner);
    if (cfg.winBy === 'score' && s.score[winner] >= cfg.scoreTarget) { finishGame(s, winner); return; }
    s.lastPlay = null; s.passed = {}; s.turn = winner; s.round++;
  }

  /** 非法出牌必须返回具体原因，不静默吞掉（合并指令 块5 第3条） */
  function illegal(s, reason) {
    s.lastError = reason;
    s.log.push(`非法出牌（${s.turn}）：${reason}`);
    return s;
  }

  function apply(s, m) {
    if (s.winner) return illegal(s, '对局已结束，不能出牌');
    const side = s.turn;
    s.lastError = null;
    if (!m || m.pass) {
      if (!s.lastPlay) return illegal(s, '你是领出方，必须出牌不能过');
      s.passed[side] = true; s.steps++;
      s.log.push(`第 ${s.round} 轮 ${side} 过牌`);
      const done = s.ids.filter((id) => id !== side).every((id) => id === s.lastPlay.side || s.passed[id]);
      if (done) finishTrick(s); else nextTurn(s);
      return s;
    }
    const ids = Array.isArray(m.cards) ? m.cards : [];
    if (!ids.length) return illegal(s, '没有选出任何牌');
    if (new Set(ids).size !== ids.length) return illegal(s, '同一张牌不能重复出');
    const cards = ids.map((id) => s.hands[side].find((c) => c.id === id));
    if (cards.some((c) => !c)) return illegal(s, '出的牌不在自己的手牌里');
    const pat = identifyPattern(cards, cfg.patternSet);
    if (!pat) return illegal(s, `牌型不符合${patternSet(cfg.patternSet).short}规则（${cards.length} 张无法组成合法牌型）`);
    if (s.lastPlay && s.lastPlay.side !== side && !beatsPattern(pat, s.lastPlay.pattern, cfg.patternSet)) {
      return illegal(s, `压不过上家的${s.lastPlay.pattern.name}（需同牌型且点数更大，或用炸弹/王炸）`);
    }
    s.hands[side] = s.hands[side].filter((c) => !ids.includes(c.id));
    s.discard.push(...cards);
    s.lastPlay = { side, pattern: pat, cards };
    s.leader = side; s.passed = {}; s.steps++;
    s.log.push(`第 ${s.round} 轮 ${side} 出 ${pat.name} ${cards.map((x) => x.label + x.suitLabel).join(' ')}，余 ${s.hands[side].length} 张`);
    if (!s.hands[side].length) { finishGame(s, side); return s; }
    nextTurn(s);
    return s;
  }

  /** 预检一手牌是否合法，返回 null=合法 / 字符串=具体原因（不改状态） */
  function checkPlay(s, m) {
    if (s.winner) return '对局已结束，不能出牌';
    const side = s.turn;
    if (!m || m.pass) return s.lastPlay ? null : '你是领出方，必须出牌不能过';
    const ids = Array.isArray(m.cards) ? m.cards : [];
    if (!ids.length) return '没有选出任何牌';
    if (new Set(ids).size !== ids.length) return '同一张牌不能重复出';
    const cards = ids.map((id) => s.hands[side].find((c) => c.id === id));
    if (cards.some((c) => !c)) return '出的牌不在自己的手牌里';
    const pat = identifyPattern(cards, cfg.patternSet);
    if (!pat) return `牌型不符合${patternSet(cfg.patternSet).short}规则（${cards.length} 张无法组成合法牌型）`;
    if (s.lastPlay && s.lastPlay.side !== side && !beatsPattern(pat, s.lastPlay.pattern, cfg.patternSet)) {
      return `压不过上家的${s.lastPlay.pattern.name}（需同牌型且点数更大，或用炸弹/王炸）`;
    }
    return null;
  }

  function judge(s) {
    if (!s || s.winner) return s;
    const empty = s.ids.find((id) => !s.hands[id].length);
    if (empty) finishGame(s, empty);
    return s;
  }

  function aiMove(s) {
    const ms = moves(s);
    if (!ms.length) return null;
    const plays = ms.filter((m) => !m.pass);
    if (!plays.length) return { pass: true };
    plays.sort((a, b) => a.cards.length - b.cards.length || a.pattern.rank - b.pattern.rank);
    const safe = plays.filter((p) => !['bomb', 'rocket'].includes(p.pattern.id));
    return safe[0] || plays[0];
  }

  function selfPlay(maxSteps = 500, seed = 0) {
    const s = start(seed);
    let guard = 0;
    while (!s.winner && guard++ < maxSteps) {
      const before = s.steps;
      const m = aiMove(s);
      if (!m) { s.winner = 'draw'; s.reason = 'stalemate'; break; }
      apply(s, m);
      if (s.steps === before) { s.winner = 'draw'; s.reason = 'stall'; break; }
    }
    if (!s.winner) { s.winner = 'draw'; s.reason = 'step-limit'; }
    return {
      winner: s.winner, reason: s.reason, steps: s.steps, shuffles: s.shuffles,
      tricks: s.tricks, seed, hands: Object.fromEntries(s.ids.map((id) => [id, s.hands[id].length])),
      stall: ['stall', 'step-limit', 'stalemate'].includes(s.reason), log: s.log.slice(-18),
    };
  }

  return { start, moves, apply, checkPlay, judge, aiMove, selfPlay, identify: (cards) => identifyPattern(cards, cfg.patternSet),
    beats: (a, b) => beatsPattern(a, b, cfg.patternSet),
    get boardInfo() { return { cols: 0, rows: 0, cards: true, size: cfg.size }; } };
}

export function createEngine(rs) {
  if (rs?.mode === 'card' || rs?.type === 'card' || rs?.type === 'mahjong' || !rs?.board?.cols) return createCardEngine(rs);
  const cols = rs.board?.cols || 7, rows = rs.board?.rows || 7;
  const total = Math.max(1, (rs.pieces || []).reduce((a, p) => a + (numOf(p.count) || 0), 0) || 8);
  const set = (s) => s.board;
  function start() {
    const board = {};
    const spots = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) spots.push([x, y]);
    for (let i = 0; i < Math.min(total, spots.length); i++) {
      const p = spots[i]; board[key(p[0], p[1])] = i % 2 === 0 ? 'a' : 'b';
    }
    return { board, turn: 'a', round: 1, noCapture: 0, winner: null, reason: null,
      score: { a: 0, b: 0 }, history: [], steps: 0 };
  }
  function moves(s, side = s.turn) {
    if (s.winner) return [];
    const out = [];
    const dirs = [...(DIRS.orth || [])];
    const hasDiag = (rs.actions || []).some((a) => (a.dirs || []).includes('diag'))
      || (rs.pieces || []).some((p) => (p.move || []).includes('diag1'));
    if (hasDiag) dirs.push(...DIRS.diag);
    const anywhere = (rs.actions || []).some((a) => a.range < 0);
    for (const [k, v] of Object.entries(s.board)) {
      if (v !== side) continue;
      const [x, y] = k.split(',').map(Number);
      if (anywhere) {
        for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) {
          if (!s.board[key(xx, yy)]) out.push({ from: k, to: key(xx, yy) });
        }
      }
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const t = key(nx, ny);
        if (!s.board[t]) out.push({ from: k, to: t });
        else if (s.board[t] !== side && (rs.actions || []).some((a) => a.type === 'capture')) out.push({ from: k, to: t, capture: true });
      }
    }
    return out;
  }
  function apply(s, m) {
    const victim = s.board[m.to];
    delete s.board[m.from];
    s.board[m.to] = s.turn;
    s.steps++;
    if (victim && victim !== s.turn) {
      s.score[s.turn] += rs.score?.capture ?? 1;
      s.noCapture = 0;
    } else s.noCapture++;
    s.turn = s.turn === 'a' ? 'b' : 'a';
    if (s.turn === 'a') s.round++;
    judge(s);
    return s;
  }
  function lineupCount(board, side) {
    let best = 0;
    const need = (rs.win.find((w) => w.type === 'lineup')?.count) || 3;
    for (let y = 0; y < rows; y++) for (let x = 0; x <= cols - need; x++) {
      let n = 0;
      for (let i = 0; i < need; i++) if (board[key(x+i, y)] === side) n++;
      best = Math.max(best, n);
    }
    for (let x = 0; x < cols; x++) for (let y = 0; y <= rows - need; y++) {
      let n = 0;
      for (let i = 0; i < need; i++) if (board[key(x, y+i)] === side) n++;
      best = Math.max(best, n);
    }
    return best >= need ? 1 : 0;
  }
  function judge(s) {
    for (const w of rs.win || []) {
      if (w.type === 'eliminate') {
        // 刚走完的一方为赢家候选；对方棋子清空即胜
        const otherSide = s.turn === 'a' ? 'b' : 'a';
        if (!Object.values(s.board).includes(otherSide)) { s.winner = s.turn; s.reason = 'eliminate'; }
      }
      if (w.type === 'lineup' && lineupCount(s.board, s.turn === 'a' ? 'b' : 'a')) {
        s.winner = s.turn === 'a' ? 'b' : 'a'; s.reason = 'lineup';
      }
      if (w.type === 'score' && s.score[s.turn === 'a' ? 'b' : 'a'] >= (w.target || 21)) {
        s.winner = s.turn === 'a' ? 'b' : 'a'; s.reason = 'score';
      }
      if (w.type === 'reach' && w.zone) {
        const z = (rs.board?.zones || []).find((x) => x.name === w.zone);
        if (z?.cells?.some(([x, y]) => s.board[key(x, y)] === (s.turn === 'a' ? 'b' : 'a'))) {
          s.winner = s.turn === 'a' ? 'b' : 'a'; s.reason = 'reach';
        }
      }
    }
    const noCap = (rs.draw || []).find((d) => d.type === 'no-capture');
    if (!s.winner && noCap && s.noCapture >= (noCap.rounds || 60)) { s.winner = 'draw'; s.reason = 'no-capture'; }
    if (!s.winner && s.round > 400) { s.winner = 'draw'; s.reason = 'stalemate'; }
    if (!s.winner && !Object.values(s.board).includes(s.turn)) { s.winner = s.turn === 'a' ? 'b' : 'a'; s.reason = 'eliminate'; }
  }
  function aiMove(s) {
    const ms = moves(s);
    if (!ms.length) return null;
    const scored = ms.map((x) => ({ x, v: (x.capture ? 10 : 0) + Math.random() }));
    scored.sort((a, b) => b.v - a.v);
    return scored[0].x;
  }
  function selfPlay(maxSteps = 500) {
    const s = start();
    let guard = 0;
    while (!s.winner && guard++ < maxSteps) {
      const m = aiMove(s);
      if (!m) { s.winner = 'draw'; s.reason = 'stalemate'; break; }
      apply(s, m);
    }
    if (!s.winner) { s.winner = 'draw'; s.reason = 'step-limit'; }
    return { winner: s.winner, reason: s.reason, steps: s.steps };
  }
  return { start, moves, apply, judge, aiMove, selfPlay, get boardInfo() { return { cols, rows }; } };
}

/** 规则体检：终止条件 / 死锁 / 先手胜率（20 局自对弈） */
export function healthCheck(rs, games = 20) {
  const v = validateRuleSet(rs);
  const notes = [];
  if (!v.ok) notes.push(...v.issues);
  const isCard = rs.mode === 'card';
  if (!rs.win?.length && !rs.pending?.length) notes.push('缺少终止条件：对局可能永不结束');
  if (!rs.draw?.length && !isCard) notes.push('缺少和棋条件：僵局无法收场');
  if (isCard && rs.pending?.length) notes.push(`还有 ${rs.pending.length} 项牌类参数没问清，当前不写默认值`);
  let first = 0, drawn = 0, totalSteps = 0, stalled = 0, shuffles = 0;
  const eng = createEngine(rs);
  const n = Math.max(1, games);
  for (let i = 0; i < n; i++) {
    const r = isCard ? eng.selfPlay(500, i) : eng.selfPlay();
    if (r.winner === 'a') first++;
    if (r.winner === 'draw') drawn++;
    if (r.stall) stalled++;
    shuffles += r.shuffles || 0;
    totalSteps += r.steps;
  }
  const firstRate = first / n;
  if (firstRate > 0.75) notes.push(`先手胜率 ${Math.round(firstRate*100)}% 偏高，建议给后手补偿`);
  if (drawn === n) notes.push(`${n} 局全部和棋，可能存在死锁或胜负条件过难`);
  if (isCard && stalled) notes.push(`${n} 局里有 ${stalled} 局卡死，检查补给与洗回上限`);
  if (isCard && !shuffles && n) notes.push(`${n} 局均未触发弃牌洗回，检查牌堆与补给参数`);
  return { ok: notes.length === 0, notes, firstRate, drawRate: drawn / n,
    avgSteps: Math.round(totalSteps / n), stalled, shuffles, games: n };
}

/** 程序化美术参数：由棋子名 hash 决定纹样族，同规则集共用调色板 */
export function artParams(piece = {}, type = 'board') {
  const name = String(piece.name || piece.id || '子');
  const palette = ({ board: '#B4462F', card: '#2DD4BF', mahjong: '#E8833A', custom: '#8E7CC3' })[type] || '#B4462F';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    glyph: name[0], palette,
    motif: `ring${(h % 3) + 1}`,
    rings: (h % 3) + 1,
    corners: (h >> 2) % 5,
    texture: (h >> 4) % 4,
    carrier: type === 'board' ? 'round' : type === 'card' ? 'rect' : 'brick',
    renderer: type === 'board' ? 'piece' : 'card',
  };
}

/** 美术分层：棋类用棋子渲染器，牌类用牌面渲染器（花色 / 点数 / 牌背三套绘制） */
export function artSamples(rs) {
  if (rs?.mode !== 'card') {
    return ['帅', '兵', '马', '炮', '龙', '虎', '象', '将'].map((glyph, i) => ({
      kind: 'piece', label: `棋子 · ${glyph}`, ...artParams({ name: glyph }, 'board'), index: i,
    }));
  }
  return [
    { kind: 'card', suit: 'S', rank: 14, label: '黑桃 A' },
    { kind: 'card', suit: 'H', rank: 10, label: '红桃 10' },
    { kind: 'card', suit: 'C', rank: 13, label: '梅花 K' },
    { kind: 'card', suit: 'D', rank: 12, label: '方块 Q' },
    { kind: 'card', suit: 'JOKER', rank: 16, label: '小王' },
    { kind: 'card', suit: 'JOKER', rank: 17, label: '大王' },
    { kind: 'back', label: '牌背' },
    { kind: 'piece', glyph: '棋', label: '棋子对照', ...artParams({ name: '棋' }, 'board') },
  ].map((x, i) => ({ ...x, index: i, renderer: x.kind === 'piece' ? 'piece' : 'card' }));
}

/** 规则卡 → 规则页：直接由 ruleBook 渲染，不手抄、不追加任何「出处」之类的外部内容 */
export function rulePageHtml(rs) {
  const book = ruleBook(rs);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const body = [];
  let list = false;
  const closeList = () => { if (list) { body.push('</ul>'); list = false; } };
  for (const raw of book.split('\n')) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith('<!--')) continue;
    if (line.startsWith('# ')) { closeList(); body.push(`<h1>${esc(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { closeList(); body.push(`<h2>${esc(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('### ')) { closeList(); body.push(`<h3>${esc(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('> ')) { closeList(); body.push(`<blockquote>${esc(line.slice(2))}</blockquote>`); continue; }
    if (line.startsWith('- ')) {
      if (!list) { body.push('<ul>'); list = true; }
      body.push(`<li>${esc(line.slice(2)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')}</li>`);
      continue;
    }
    closeList(); body.push(`<p>${esc(line)}</p>`);
  }
  closeList();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(rs?.name || '规则')} · 规则页</title>`
    + `<style>body{margin:0;background:#171423;color:#eee8f5;font:15px/1.7 "PingFang SC",system-ui,sans-serif}`
    + `main{max-width:760px;margin:0 auto;padding:26px 18px 60px}h1{color:#d9b66a;font-size:24px}h2{color:#d9b66a;font-size:17px;margin-top:24px;border-bottom:1px solid #4a3f6b;padding-bottom:6px}`
    + `blockquote{margin:10px 0;padding:9px 12px;background:#221d33;border-left:3px solid #d9b66a;border-radius:8px;color:#a99fbd}`
    + `ul{padding-left:22px}li{margin:4px 0}code{background:#12101f;padding:2px 6px;border-radius:5px}footer{color:#a99fbd;font-size:12px;text-align:center;padding:20px}</style></head><body>`
    + `<main>${body.join('')}</main><footer>本页由规则卡自动生成 · v${esc(rs?.version || 1)}</footer></body></html>`;
}

/* ---------------- 短码 / diff ---------------- */
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64(code) {
  const s = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
export function encodeShort(rs) { return toB64(JSON.stringify(rs)); }
export function decodeShort(code) {
  try { const rs = JSON.parse(fromB64(code)); return validateRuleSet(rs).ok ? rs : null; }
  catch { return null; }
}

/** 规则书行级 diff（保留上下文，标 + / -） */
export function diffBooks(a = '', b = '') {
  const A = a.split('\n'), B = b.split('\n');
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push(`  ${A[i]}`); i++; j++; continue; }
    // 在 B 中找 A[i]（新增），在 A 中找 B[j]（删除）
    if (i < A.length && !B.slice(j, j + 6).includes(A[i])) { out.push(`- ${A[i]}`); i++; continue; }
    if (j < B.length) { out.push(`+ ${B[j]}`); j++; }
  }
  return out;
}

/** 版本历史工具 */
export function makeVersion(rs, versions = []) {
  const v = (rs.version || versions.length + 1);
  const next = { ...JSON.parse(JSON.stringify(rs)), version: v, book: ruleBook(rs), at: Date.now() };
  return [...versions, next];
}
