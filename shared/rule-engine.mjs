/**
 * 规则工坊 · 本地规则引擎（第三批任务块 K）—— 纯逻辑，零 DOM / 零 fetch / 零 API
 * 模板库 → 关键词解析 → 槽位填充 → 冲突检测 → RuleSet → 规则书 → 体检 → 自对弈 → 短码。
 * 浏览器与 Node 均可用；所有"规则 AI"都在这里，UI 只负责三步流程与展示。
 */

/* ---------------- 模板库（四类各 ≥2，共 12） ---------------- */
const base = (id, type, name, patch = {}) => ({
  id: `tpl-${id}`, type, name, players: 2,
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
    board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    pieces: [{ id: 'card', name: '牌', count: 52, power: 1, move: [], art: { glyph: '牌', palette: '#2DD4BF', motif: 'ring1' } }],
    actions: [{ type: 'deck', size: 52 }, { type: 'deal', count: 5 }, { type: 'patterns', list: ['single', 'pair', 'straight'] }],
    win: [{ type: 'score', target: 21 }],
  }),
  base('solitaire', 'card', '接龙牌', {
    board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    actions: [{ type: 'deck', size: 52 }, { type: 'deal', count: 7 }, { type: 'patterns', list: ['single', 'sequence'] }],
    win: [{ type: 'eliminate', target: 'all' }],
  }),
  base('compare', 'card', '比大小牌', {
    board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    actions: [{ type: 'deck', size: 32 }, { type: 'deal', count: 5 }, { type: 'patterns', list: ['single', 'pair', 'bomb'] }],
    win: [{ type: 'score', target: 10 }],
  }),
  base('mcr', 'mahjong', '简化麻将', {
    board: { cols: 0, rows: 0, topology: 'mahjong', zones: [] },
    pieces: [{ id: 'tile', name: '牌', count: 136, power: 1, move: [], art: { glyph: '牌', palette: '#E8833A', motif: 'ring2' } }],
    actions: [{ type: 'tiles', suits: ['wan', 'tiao', 'tong'] }, { type: 'hu', pattern: '4m1p' }, { type: 'fan', enabled: true }],
    win: [{ type: 'score', target: 8 }],
  }),
  base('sevenpairs', 'mahjong', '七对麻将', {
    board: { cols: 0, rows: 0, topology: 'mahjong', zones: [] },
    actions: [{ type: 'tiles', suits: ['wan', 'tiao', 'tong'] }, { type: 'hu', pattern: '7pairs' }, { type: 'fan', enabled: true }],
    win: [{ type: 'score', target: 8 }],
  }),
  base('free', 'custom', '自定义棋盘', {
    name: '自定义规则',
    board: { cols: 7, rows: 7, topology: 'grid', zones: [] },
  }),
  base('freecard', 'custom', '自定义抢分', {
    name: '自定义抢分',
    board: { cols: 0, rows: 0, topology: 'card', zones: [] },
    pieces: [{ id: 'card', name: '牌', count: 52, power: 1, move: [], art: { glyph: '牌', palette: '#8E7CC3', motif: 'ring1' } }],
    actions: [{ type: 'deck', size: 52 }, { type: 'deal', count: 5 }],
    win: [{ type: 'score', target: 15 }],
  }),
];

export const templateByType = (type) => TEMPLATES.filter((t) => t.type === type);
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
function q(key, text, options, apply) {
  return { key, text, options, default: options[options.length - 1], apply };
}

/**
 * 描述 → { ruleSet, questions, warnings }
 * 不确定的一律进 questions，绝不自己拍板。
 */
export function parseDescription(text = '', type = 'board') {
  const src = String(text || '');
  const tpl = templateByType(type)[0] ?? TEMPLATES[11];
  const rs = JSON.parse(JSON.stringify(tpl));
  rs.id = `custom-${Date.now().toString(36)}`;
  rs.name = (src.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:棋|牌|规则)/)?.[1] || tpl.name).slice(0, 12);
  const questions = [], warnings = [], hit = new Set();

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
export function answerQuestions(rs, answers = []) {
  const parsed = typeof rs === 'string' ? JSON.parse(rs) : JSON.parse(JSON.stringify(rs));
  for (const a of answers) {
    if (!a?.key || !a?.option) continue;
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
  if (!rs || typeof rs !== 'object') return { ok: false, issues: ['不是有效的规则对象'] };
  if (!rs.id || !rs.name || !rs.type) issues.push('缺少 id / name / type');
  if (!Array.isArray(rs.pieces) || !rs.pieces.length) issues.push('缺少棋子定义');
  if (!Array.isArray(rs.actions) || !rs.actions.length) issues.push('缺少行为定义');
  if (!Array.isArray(rs.win) || !rs.win.length) issues.push('缺少终止条件');
  if (!Array.isArray(rs.draw)) issues.push('缺少和棋配置');
  if (!rs.score || typeof rs.score !== 'object') issues.push('缺少计分配置');
  if (rs.board && (!Number.isFinite(rs.board.cols) || !Number.isFinite(rs.board.rows))) issues.push('棋盘尺寸无效');
  for (const a of rs.actions || []) {
    if (!['place', 'move', 'capture', 'deck', 'deal', 'patterns', 'tiles', 'hu', 'fan'].includes(a.type)) {
      issues.push(`不支持的行为：${a.type}`);
    }
    if (a.type === 'capture' && !['replace', 'flank', 'surround', 'jump'].includes(a.by)) {
      issues.push(`不支持的吃法：${a.by}`);
    }
  }
  for (const w of rs.win || []) {
    if (!['eliminate', 'reach', 'lineup', 'score'].includes(w.type)) issues.push(`不支持的胜负条件：${w.type}`);
  }
  return { ok: issues.length === 0, issues };
}

/* ---------------- 规则书 Markdown ---------------- */
export function ruleBook(rs) {
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

/** 牌类简化引擎：摸打 / 计分 / 目标分终止，供模板试玩与体检使用 */
function createCardEngine(rs) {
  const target = (rs.win || []).find((w) => w.type === 'score')?.target
    || (rs.win || []).find((w) => w.type === 'eliminate') ? 8 : 21;
  function start() {
    return { turn: 'a', round: 1, score: { a: 0, b: 0 }, steps: 0, winner: null, reason: null };
  }
  function moves(s) { return s.winner ? [] : [{ draw: true }]; }
  function apply(s) {
    s.steps++;
    if (Math.random() < 0.22) s.score[s.turn] += 1;
    if (s.score[s.turn] >= target) { s.winner = s.turn; s.reason = 'score'; }
    else if (s.round > 40) { s.winner = 'draw'; s.reason = 'threefold'; }
    s.turn = s.turn === 'a' ? 'b' : 'a';
    if (s.turn === 'a') s.round++;
    return s;
  }
  function aiMove(s) { return moves(s)[0] ?? null; }
  function selfPlay(maxSteps = 500) {
    const s = start();
    let guard = 0;
    while (!s.winner && guard++ < maxSteps) {
      if (!aiMove(s)) { s.winner = 'draw'; s.reason = 'stalemate'; break; }
      apply(s);
    }
    if (!s.winner) { s.winner = 'draw'; s.reason = 'step-limit'; }
    return { winner: s.winner, reason: s.reason, steps: s.steps };
  }
  return { start, moves, apply, aiMove, selfPlay, judge: () => {}, get boardInfo() { return { cols: 0, rows: 0 }; } };
}

export function createEngine(rs) {
  // 牌类不走网格走子：用摸打计分引擎，保证模板选完就能试玩
  if (rs.type === 'card' || rs.type === 'mahjong' || !rs.board?.cols) return createCardEngine(rs);
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
  if (!rs.win?.length) notes.push('缺少终止条件：对局可能永不结束');
  if (!rs.draw?.length) notes.push('缺少和棋条件：僵局无法收场');
  let first = 0, drawn = 0, totalSteps = 0;
  const eng = createEngine(rs);
  const n = Math.max(1, games);
  for (let i = 0; i < n; i++) {
    const r = eng.selfPlay();
    if (r.winner === 'a') first++;
    if (r.winner === 'draw') drawn++;
    totalSteps += r.steps;
  }
  const firstRate = first / n;
  if (firstRate > 0.75) notes.push(`先手胜率 ${Math.round(firstRate*100)}% 偏高，建议给后手补偿`);
  if (drawn === n) notes.push('20 局全部和棋，可能存在死锁或胜负条件过难');
  return { ok: notes.length === 0, notes, firstRate, drawRate: drawn / n, avgSteps: Math.round(totalSteps / n) };
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
  };
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
