/**
 * 规则工坊纯逻辑单测（第三批任务块 K）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TEMPLATES, TEMPLATE_TYPES, templateByType, parseDescription, answerQuestions,
  validateRuleSet, ruleBook, applyBookEdits, createEngine, healthCheck,
  encodeShort, decodeShort, diffBooks, makeVersion, artParams,
  MODES, CARD_PATTERN_SETS, CARD_PATTERN_DEFAULT, CARD_Q_DEFS, pendingQuestions,
  buildDeck, identifyPattern, beatsPattern, artSamples, rulePageHtml,
} from '../../shared/rule-engine.mjs';

/* ---------- 模板库 ---------- */
test('四种类型各内置 ≥2 个模板，共 12 个，选完即可开局', () => {
  for (const t of TEMPLATE_TYPES) assert.ok(templateByType(t.key).length >= 2, t.label);
  assert.ok(TEMPLATES.length >= 10);
  for (const tpl of TEMPLATES) {
    assert.equal(validateRuleSet(tpl).ok, true, tpl.name);
    assert.equal(createEngine(tpl).selfPlay(100).steps > 0, true, tpl.name);
  }
});

test('断网可用：引擎源码无 fetch / CDN / 外部 API 调用', () => {
  const src = readFileSync(new URL('../../shared/rule-engine.mjs', import.meta.url), 'utf-8');
  assert.equal(/fetch\s*\(/.test(src), false);
  assert.equal(/https?:\/\//.test(src), false);
  assert.equal(/cdn|unpkg|jsdelivr/i.test(src), false);
});

/* ---------- 全链路 ---------- */
test('描述 → RuleSet → 规则书 → 美术 → AI 对手 一条龙', () => {
  const { ruleSet, questions } = parseDescription('7×7 两人吃子棋，三子连线赢，60 回合无吃子判和', 'board');
  assert.equal(validateRuleSet(ruleSet).ok, true);
  const book = ruleBook(ruleSet);
  for (const h of ['# ', '## 棋盘', '## 棋子', '## 走法', '## 吃法', '## 胜负', '## 和棋', '## 计分']) {
    assert.ok(book.includes(h), h);
  }
  const art = artParams(ruleSet.pieces[0], ruleSet.type);
  assert.ok(art.glyph && art.palette && art.motif && art.carrier);
  const r = createEngine(ruleSet).selfPlay(200);
  assert.ok(['a', 'b', 'draw'].includes(r.winner));
  const edit = applyBookEdits(ruleSet, book.replace(/7 × 7/, '9 × 9'));
  assert.equal(edit.ruleSet.board.cols, 9);
  void questions;
});

/* ---------- 追问引擎 ≥8 类 ---------- */
test('追问覆盖 8 类缺失 / 冲突情形，且问题不说字段名', () => {
  const cases = [
    ['', 'board', 'board-size'],
    ['9×9 吃子棋', 'board', 'players'],
    ['7×7 两人 棋盘上摆子', 'board', 'capture-missing'],
    ['7×7 两人 吃子 60 回合和棋', 'board', 'win-missing'],
    ['7×7 两人 吃子 吃光获胜', 'board', 'draw-missing'],
    ['7×7 两人 围吃 跳吃 吃光获胜 60回合和棋', 'board', 'capture-conflict'],
    ['7×7 两人 到目标区 三子连线 吃光获胜 60回合和棋', 'board', 'win-conflict'],
    ['7×7 两人 吃光获胜 60回合和棋 传送', 'board', 'unsupported'],
  ];
  const keys = new Set();
  for (const [text, type, want] of cases) {
    const { questions } = parseDescription(text, type);
    const all = questions.map((q) => q.key);
    assert.ok(all.includes(want), `${want} 未出现在 ${JSON.stringify(all)}`);
    for (const q of questions) {
      assert.ok(!/flank|replace|surround|lineup|no-capture/.test(q.text), '问题不能出现字段名');
      assert.ok(q.options.length >= 2);
      assert.ok(q.default);
    }
    keys.add(want);
  }
  assert.ok(keys.size >= 8);
});

test('回答追问写回 RuleSet 且版本 +1', () => {
  const { ruleSet } = parseDescription('', 'board');
  const next = answerQuestions(ruleSet, [
    { key: 'board-size', option: '9×9' },
    { key: 'players', option: '4 人' },
    { key: 'win-missing', option: '吃光对方' },
  ]);
  assert.equal(next.board.cols, 9);
  assert.equal(next.players, 4);
  assert.equal(next.win[0].type, 'eliminate');
  assert.equal(next.version, 2);
});

/* ---------- 美术 ---------- */
test('程序化美术参数：同集一致、不同名不同纹样、载体正确', () => {
  const a = artParams({ name: '龙' }, 'board');
  const b = artParams({ name: '龙' }, 'board');
  const c = artParams({ name: '虎' }, 'board');
  assert.deepEqual(a, b);
  assert.notEqual(a.motif, c.motif);
  assert.equal(a.carrier, 'round');
  assert.equal(artParams({ name: '牌' }, 'card').carrier, 'rect');
  assert.equal(artParams({ name: '筒' }, 'mahjong').carrier, 'brick');
  assert.ok(/^#[0-9A-F]{6}$/i.test(a.palette));
});

/* ---------- 短码 / 版本 ---------- */
test('短码可在另一浏览器还原同一规则', () => {
  const { ruleSet } = parseDescription('9×9 两人吃子棋，吃光获胜，60回合和棋', 'board');
  const code = encodeShort(ruleSet);
  assert.ok(code.length > 20 && !/[+/=]/.test(code));
  const back = decodeShort(code);
  assert.deepEqual(back, ruleSet);
  assert.equal(decodeShort('bad-code'), null);
});

test('版本 v1→v2 可 diff、可回滚', () => {
  const { ruleSet } = parseDescription('7×7 两人吃子棋，吃光获胜，60回合和棋', 'board');
  const v1 = makeVersion({ ...ruleSet, version: 1 }, []);
  const v2rs = { ...ruleSet, version: 2, draw: [{ type: 'no-capture', rounds: 30 }] };
  const v2 = makeVersion(v2rs, v1);
  assert.equal(v2.length, 2);
  const d = diffBooks(v1[0].book, v2[1].book);
  assert.ok(d.some((l) => l.startsWith('- ') && l.includes('60')));
  assert.ok(d.some((l) => l.startsWith('+ ') && l.includes('30')));
  // 回滚 = 取 v1
  assert.equal(v1[0].draw[0].rounds, 60);
});

/* ---------- 体检 ---------- */
test('规则体检能报出终止条件缺失', () => {
  const bad = JSON.parse(JSON.stringify(TEMPLATES[0]));
  bad.win = [];
  const h = healthCheck(bad, 5);
  assert.equal(h.ok, false);
  assert.ok(h.notes.some((n) => n.includes('终止条件')));
});

test('规则体检能报出先手胜率过高', () => {
  const fast = JSON.parse(JSON.stringify(TEMPLATES[0]));
  fast.board.cols = 3; fast.board.rows = 3;
  fast.pieces[0].count = 2;
  fast.win = [{ type: 'score', target: 1 }];
  fast.draw = [{ type: 'no-capture', rounds: 200 }];
  const h = healthCheck(fast, 20);
  assert.ok(h.firstRate > 0.75, `先手胜率 ${h.firstRate}`);
  assert.ok(h.notes.some((n) => n.includes('先手胜率')));
});

test('一键试玩：AI 自对弈 5 局，每局有步数与终局原因', () => {
  const { ruleSet } = parseDescription('7×7 两人吃子棋，吃光获胜，60回合和棋', 'board');
  const eng = createEngine(ruleSet);
  const games = Array.from({ length: 5 }, () => eng.selfPlay());
  assert.ok(games.every((g) => g.steps > 0));
  assert.ok(games.every((g) => !!g.reason));
});

/* -------- 第四批：牌类模式 -------- */
test('mode 只有 board / card，棋牌模板各自归位', () => {
  assert.deepEqual(Object.values(MODES).sort(), ['board', 'card']);
  for (const t of TEMPLATES) assert.ok(Object.values(MODES).includes(t.mode), t.name);
  assert.ok(TEMPLATES.filter((t) => t.type === 'board').every((t) => t.mode === 'board'));
  assert.ok(TEMPLATES.filter((t) => t.type === 'card').every((t) => t.mode === 'card'));
});

test('内置四套牌型表，回牌默认斗地主式', () => {
  assert.deepEqual(CARD_PATTERN_SETS.map((s) => s.id),
    ['doudizhu', 'zhengshangyou', 'single', 'custom']);
  assert.equal(CARD_PATTERN_DEFAULT, 'doudizhu');
  const ddz = CARD_PATTERN_SETS[0];
  assert.ok(ddz.patterns.includes('bomb') && ddz.patterns.includes('rocket'));
  assert.equal(CARD_PATTERN_SETS[2].patterns.length, 1);
});

test('6 类牌类追问齐备，未答前不写 52/5/21/60 这类棋类默认值', () => {
  const { ruleSet, questions } = parseDescription('', 'card');
  const keys = questions.map((q) => q.key);
  for (const d of CARD_Q_DEFS) assert.ok(keys.includes(d.key), d.key);
  assert.equal(questions.find((q) => q.key === 'pattern-set').default.includes('斗地主'), true);
  for (const v of Object.values(ruleSet.card)) assert.notEqual(v, 52);
  assert.equal(ruleSet.card.handSize, null);
  assert.equal(ruleSet.card.scoreTarget, null);
  const book = ruleBook(ruleSet);
  for (const bad of ['52 张', '5 张', '21', '60 回合']) assert.equal(book.includes(bad), false, bad);
  assert.ok(book.includes('待确认'));
  assert.deepEqual(pendingQuestions(ruleSet).length >= 6, true);
});

test('牌类追问写回：输 20 局参数逐项落到 RuleSet，版本 +1', () => {
  const { ruleSet, questions } = parseDescription('', 'card');
  const pick = { 'players': '4 人', 'deck-count': '126 张（自定义）', 'hand-size': '10 张',
    'win-by': '先出完手牌获胜', 'replenish': '赢家 6 张、其余 3 张',
    'shuffle-limit': '3 次', 'pattern-set': '斗地主式（含炸弹、王炸）' };
  const next = answerQuestions(ruleSet, questions.map((q) => ({ key: q.key, option: pick[q.key] || q.default })));
  assert.equal(next.card.size, 126);
  assert.equal(next.card.handSize, 10);
  assert.deepEqual(next.card.replenish, { winner: 6, others: 3 });
  assert.equal(next.card.shuffleLimit, 3);
  assert.equal(next.card.patternSet, 'doudizhu');
  assert.equal(next.card.winBy, 'empty');
  assert.deepEqual(next.pending, []);
  assert.equal(next.version, 2);
  assert.equal(validateRuleSet(next).ok, true);
});

test('牌型判定：顺子能出、炸弹压顺子、王炸压炸弹、单张压单张', () => {
  const card = (suit, rank) => ({ id: `${suit}${rank}`, suit, rank, label: String(rank), suitLabel: suit });
  const straight = identifyPattern([3, 4, 5, 6, 7, 8].map((r) => card('S', r)), 'doudizhu');
  assert.equal(straight?.id, 'straight');
  const bomb = identifyPattern([9, 9, 9, 9].map((r) => card('H', r)), 'doudizhu');
  assert.equal(bomb?.id, 'bomb');
  const rocket = identifyPattern([card('JOKER', 16), card('JOKER', 17)], 'doudizhu');
  assert.equal(rocket?.id, 'rocket');
  assert.equal(beatsPattern(bomb, straight, 'doudizhu'), true);
  assert.equal(beatsPattern(rocket, bomb, 'doudizhu'), true);
  assert.equal(beatsPattern(identifyPattern([card('S', 9)], 'single'),
    identifyPattern([card('H', 8)], 'single'), 'single'), true);
  assert.equal(identifyPattern([3, 4, 5, 6, 7].map((r) => card('S', r)), 'single'), null);
});

test('牌堆构造：54 / 108 / 126 张，花色点数与王齐全', () => {
  assert.equal(buildDeck({ decks: 1 }).length, 54);
  assert.equal(buildDeck({ decks: 2 }).length, 108);
  assert.equal(buildDeck({ size: 126 }).length, 126);
  const cards = buildDeck({ decks: 1 });
  assert.equal(cards.filter((c) => c.suit === 'JOKER').length, 2);
  assert.equal(new Set(cards.map((c) => c.rank)).has(14), true);
  assert.equal(new Set(cards.map((c) => c.suit)).size, 5);
});

test('牌类引擎：发牌 / 轮流出牌 / 过牌 / 弃牌洗回 / 先出完判胜，20 局不卡死', () => {
  const { ruleSet } = parseDescription('三人斗地主，牌堆 108 张，每人 10 张，赢家 6 张其余 3 张，洗回 3 次，先出完获胜，斗地主式牌型', 'card');
  const eng = createEngine(ruleSet);
  const s = eng.start(0);
  assert.equal(s.ids.length, 3);
  for (const id of s.ids) assert.equal(s.hands[id].length, 10);
  assert.equal(s.pile.length, 78);
  const legal = eng.moves(s, s.turn);
  assert.ok(legal.length > 0 && legal.every((m) => m.cards));
  assert.equal(eng.moves(s, s.turn).some((m) => m.pass), false, '自由出牌不能过');
  const games = Array.from({ length: 20 }, (_, i) => eng.selfPlay(500, i));
  assert.ok(games.every((g) => !g.stall), '20 局都不能卡死');
  assert.ok(games.every((g) => g.steps > 0 && !!(g.reason)));
  assert.ok(games.some((g) => g.shuffles > 0), '至少一局触发洗回');
  assert.ok(games.every((g) => g.shuffles <= 3), '洗回不超过 3 次');
  assert.equal(validateRuleSet(ruleSet).ok, true);
});

test('洗回上限硬约束：上限 1 次时不会洗第 2 次', () => {
  const { ruleSet } = parseDescription('两人，牌堆 54 张，每人发 10 张，赢家 6 张其余 3 张，洗回 1 次，先出完获胜，斗地主式', 'card');
  const eng = createEngine(ruleSet);
  for (let i = 0; i < 10; i++) assert.ok(eng.selfPlay(500, i).shuffles <= 1);
});

test('美术分层：棋类 8 棋子 / 牌类 8 张含牌背，规则页由规则卡生成', () => {
  const board = artSamples(TEMPLATES[0]);
  assert.equal(board.length, 8);
  assert.ok(board.every((x) => x.kind === 'piece' && x.renderer === 'piece'));
  const { ruleSet } = parseDescription('两人，牌堆 108 张，每人 10 张，赢家 6 张其余 3 张，洗回 3 次，先出完获胜，斗地主式', 'card');
  const card = artSamples(ruleSet);
  assert.equal(card.length, 8);
  assert.equal(card.filter((x) => x.kind === 'card').length, 6);
  assert.equal(card.filter((x) => x.kind === 'back').length, 1);
  assert.equal(card.filter((x) => x.kind === 'piece').length, 1);
  const page = rulePageHtml(ruleSet);
  const book = ruleBook(ruleSet);
  assert.ok(page.includes('<title>'));
  for (const h of ['牌堆', '牌型', '出牌', '胜负']) assert.ok(page.includes(h) && book.includes(h));
  assert.equal(page.includes('出处'), false);
  assert.equal(validateRuleSet(ruleSet).ok, true);
});
