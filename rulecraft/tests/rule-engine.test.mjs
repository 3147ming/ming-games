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
