/**
 * 谁是卧底 · 规则引擎单测
 * 覆盖：发词、动作折叠、重放一致性、投票计票、胜负判定、私密信息不泄漏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORD_PAIRS, MIN_PLAYERS, MAX_PLAYERS, CIVILIAN, UNDERCOVER, PHASE,
  mulberry32, hashStr, deal, initPub, applyAction, fold, replay, hashPub,
  tally, judge, aliveCounts, nextAlive, nextPending, firstAlive,
  aiDescribe, aiVote, aiRandom,
} from '../src/rules.mjs';

/* ---------- 词库 ---------- */
test('词库每组都有平民词/卧底词/提示/关键词', () => {
  assert.ok(WORD_PAIRS.length >= 20, '词库至少 20 组');
  for (const p of WORD_PAIRS) {
    assert.ok(p.a && p.b, '词不能为空');
    assert.notEqual(p.a, p.b, '平民词和卧底词不能相同');
    assert.ok(p.hint && p.hint.length > 0, '要有中性提示');
    assert.ok(p.ka.length > 0 && p.kb.length > 0, '双方都要有关键词');
  }
});

test('词库里没有重复的词组', () => {
  const seen = new Set();
  for (const p of WORD_PAIRS) {
    const k = p.a + '/' + p.b;
    assert.ok(!seen.has(k), '词组重复：' + k);
    seen.add(k);
  }
});

/* ---------- 发词 ---------- */
test('发词：人数被夹在 2..6 之间', () => {
  assert.equal(deal(1, 1).words.length, MIN_PLAYERS);
  assert.equal(deal(1, 99).words.length, MAX_PLAYERS);
});

test('发词：同 seed 结果完全一致（联机两端必须一致）', () => {
  const a = deal(12345, 4);
  const b = deal(12345, 4);
  assert.deepEqual(a.words, b.words);
  assert.deepEqual(a.roles, b.roles);
  assert.equal(a.pairIndex, b.pairIndex);
});

test('发词：不同 seed 大概率抽到不同词组', () => {
  const a = deal(1, 4);
  const b = deal(999, 4);
  assert.notEqual(a.pairIndex, b.pairIndex);
});

test('发词：卧底拿卧底词，平民拿平民词', () => {
  for (let seed = 0; seed < 50; seed++) {
    const d = deal(seed * 7919, 4);
    for (let i = 0; i < d.words.length; i++) {
      if (d.roles[i] === UNDERCOVER) assert.equal(d.words[i], d.pair.b);
      else assert.equal(d.words[i], d.pair.a);
    }
  }
});

test('发词：卧底数量符合规则（4 人 1 个，6 人 2 个）', () => {
  assert.equal(deal(1, 4).spyCount, 1);
  assert.equal(deal(1, 6).spyCount, 2);
  assert.equal(deal(1, 2).spyCount, 1);
});

/* ---------- 公开局面 ---------- */
test('初始局面：全员在场、描述阶段', () => {
  const p = initPub(4);
  assert.equal(p.n, 4);
  assert.equal(p.phase, PHASE.DESCRIBE);
  assert.equal(p.round, 0);
  assert.deepEqual(p.alive, [true, true, true, true]);
  assert.deepEqual(p.eliminated, []);
});

test('nextAlive / firstAlive', () => {
  const p = initPub(4);
  assert.equal(nextAlive(p, 0), 1);
  assert.equal(firstAlive(p), 0);
  p.alive[0] = false;
  assert.equal(nextAlive(p, 0), 1);
  assert.equal(firstAlive(p), 1);
});

/* ---------- 动作折叠 ---------- */
test('round 动作开新一轮', () => {
  let p = initPub(4);
  const r = applyAction(p, { act: 'round', n: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.pub.round, 1);
  assert.equal(r.pub.phase, PHASE.DESCRIBE);
  assert.equal(r.pub.turnSeat, 0);
});

test('round 跳号被拒', () => {
  const p = initPub(4);
  assert.equal(applyAction(p, { act: 'round', n: 3 }).ok, false);
});

test('描述必须轮到自己', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  assert.equal(applyAction(p, { act: 'desc', p: 1, text: 'x' }).ok, false);
  const r = applyAction(p, { act: 'desc', p: 0, text: '好吃的' });
  assert.equal(r.ok, true);
  assert.equal(r.pub.turnSeat, 1);
  assert.equal(r.pub.descs.length, 1);
});

test('同一轮不能描述两次', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  p = applyAction(p, { act: 'desc', p: 0, text: 'a' }).pub;
  p = applyAction(p, { act: 'desc', p: 1, text: 'b' }).pub;
  p = applyAction(p, { act: 'desc', p: 2, text: 'c' }).pub;
  /* 回到 0 号，但这一轮 0 号已经说过了 —— 应被拒 */
  const r = applyAction(p, { act: 'desc', p: 0, text: 'd' });
  assert.equal(r.ok, false);
});

test('描述不能为空、不能太长', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  assert.equal(applyAction(p, { act: 'desc', p: 0, text: '   ' }).ok, false);
  assert.equal(applyAction(p, { act: 'desc', p: 0, text: 'x'.repeat(61) }).ok, false);
  assert.equal(applyAction(p, { act: 'desc', p: 0, text: 'x'.repeat(60) }).ok, true);
});

test('全员描述完自动进入投票阶段', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  p = applyAction(p, { act: 'desc', p: 0, text: 'a' }).pub;
  p = applyAction(p, { act: 'desc', p: 1, text: 'b' }).pub;
  p = applyAction(p, { act: 'desc', p: 2, text: 'c' }).pub;
  assert.equal(p.phase, PHASE.VOTE);
  assert.equal(p.turnSeat, 0);
});

test('投票不能投自己、不能投已出局的人', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  p = applyAction(p, { act: 'desc', p: 0, text: 'a' }).pub;
  p = applyAction(p, { act: 'desc', p: 1, text: 'b' }).pub;
  p = applyAction(p, { act: 'desc', p: 2, text: 'c' }).pub;
  assert.equal(applyAction(p, { act: 'vote', p: 0, target: 0 }).ok, false);
  assert.equal(applyAction(p, { act: 'vote', p: 0, target: 9 }).ok, false);
  const r = applyAction(p, { act: 'vote', p: 0, target: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.pub.votes[0], 1);
});

test('不能重复投票', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  for (let i = 0; i < 3; i++) p = applyAction(p, { act: 'desc', p: i, text: 'x' + i }).pub;
  p = applyAction(p, { act: 'vote', p: 0, target: 1 }).pub;
  assert.equal(applyAction(p, { act: 'vote', p: 0, target: 2 }).ok, false);
});

test('全员投票完进入结算阶段', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  for (let i = 0; i < 3; i++) p = applyAction(p, { act: 'desc', p: i, text: 'x' + i }).pub;
  p = applyAction(p, { act: 'vote', p: 0, target: 1 }).pub;
  p = applyAction(p, { act: 'vote', p: 1, target: 2 }).pub;
  p = applyAction(p, { act: 'vote', p: 2, target: 0 }).pub;
  assert.equal(p.phase, PHASE.RESOLVE);
});

test('eliminate 动作把人标出局', () => {
  let p = initPub(4);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  for (let i = 0; i < 4; i++) p = applyAction(p, { act: 'desc', p: i, text: 'x' + i }).pub;
  for (let i = 0; i < 4; i++) {
    const t = (i + 1) % 4;
    p = applyAction(p, { act: 'vote', p: i, target: t }).pub;
  }
  assert.equal(p.phase, PHASE.RESOLVE);
  const r = applyAction(p, { act: 'eliminate', seat: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.pub.alive[2], false);
  assert.deepEqual(r.pub.eliminated, [2]);
});

test('eliminate 平票用 -1 表示无人出局', () => {
  let p = initPub(4);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  for (let i = 0; i < 4; i++) p = applyAction(p, { act: 'desc', p: i, text: 'x' + i }).pub;
  p = applyAction(p, { act: 'vote', p: 0, target: 1 }).pub;
  p = applyAction(p, { act: 'vote', p: 1, target: 0 }).pub;
  p = applyAction(p, { act: 'vote', p: 2, target: 3 }).pub;
  p = applyAction(p, { act: 'vote', p: 3, target: 2 }).pub;
  const r = applyAction(p, { act: 'eliminate', seat: -1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pub.aliminated || r.pub.eliminated, []);
});

test('终局后不能再有动作', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  p = applyAction(p, { act: 'win', who: CIVILIAN }).pub;
  assert.equal(p.phase, PHASE.OVER);
  assert.equal(p.winner, CIVILIAN);
  assert.equal(applyAction(p, { act: 'desc', p: 0, text: 'x' }).ok, false);
});

/* ---------- 计票 ---------- */
test('计票：得票最高者出局', () => {
  const p = { n: 4, alive: [true, true, true, true], votes: { 0: 2, 1: 2, 2: 1, 3: 0 } };
  assert.equal(tally(p), 2);
});

test('计票：平票则无人出局', () => {
  const p = { n: 4, alive: [true, true, true, true], votes: { 0: 1, 1: 0, 2: 3, 3: 2 } };
  assert.equal(tally(p), -1);
});

test('计票：投给已出局的人不算数', () => {
  const p = { n: 4, alive: [false, true, true, true], votes: { 0: 2, 1: 0, 2: 1 } };
  assert.equal(tally(p), 1);
});

/* ---------- 胜负判定 ---------- */
test('卧底全被投出 → 平民胜', () => {
  const pub = { n: 4, alive: [true, false, true, true] };
  const roles = [CIVILIAN, UNDERCOVER, CIVILIAN, CIVILIAN];
  const j = judge(pub, roles);
  assert.equal(j.winner, CIVILIAN);
  assert.equal(j.aliveSpy, 0);
});

test('存活卧底数 ≥ 存活平民数 → 卧底胜', () => {
  const pub = { n: 4, alive: [true, true, false, false] };
  const roles = [CIVILIAN, UNDERCOVER, CIVILIAN, UNDERCOVER];
  const j = judge(pub, roles);
  assert.equal(j.winner, UNDERCOVER);
});

test('还没分胜负时 winner 为 null', () => {
  const pub = { n: 4, alive: [true, true, true, true] };
  const roles = [CIVILIAN, UNDERCOVER, CIVILIAN, CIVILIAN];
  const j = judge(pub, roles);
  assert.equal(j.winner, null);
  assert.equal(j.aliveSpy, 1);
  assert.equal(j.aliveCivil, 3);
});

test('aliveCounts 统计存活平民与卧底', () => {
  const pub = { n: 4, alive: [true, false, true, true] };
  const roles = [CIVILIAN, UNDERCOVER, CIVILIAN, CIVILIAN];
  const c = aliveCounts(pub, roles);
  assert.equal(c.aliveSpy, 0);
  assert.equal(c.aliveCivil, 3);
});

/* ---------- 重放一致性（联机的命门） ---------- */
test('重放与增量折叠结果一致', () => {
  const acts = [
    { act: 'round', n: 1 },
    { act: 'desc', p: 0, text: '甲' },
    { act: 'desc', p: 1, text: '乙' },
    { act: 'desc', p: 2, text: '丙' },
    { act: 'desc', p: 3, text: '丁' },
    { act: 'vote', p: 0, target: 2 },
    { act: 'vote', p: 1, target: 2 },
    { act: 'vote', p: 2, target: 0 },
    { act: 'vote', p: 3, target: 1 },
    { act: 'eliminate', seat: 2 },
  ];
  const folded = fold({ n: 4 }, acts);
  /* 增量折叠 */
  let inc = initPub(4);
  for (const a of acts) {
    const r = applyAction(inc, a);
    assert.equal(r.ok, true, '动作应该都合法：' + JSON.stringify(a));
    inc = r.pub;
  }
  assert.equal(hashPub(folded), hashPub(inc));
});

test('重放忽略非法动作（不能整局卡死）', () => {
  const acts = [
    { act: 'round', n: 1 },
    { act: 'desc', p: 5, text: '越界' },     /* 非法 */
    { act: 'desc', p: 0, text: '正常' },
  ];
  const pub = fold({ n: 4 }, acts);
  assert.equal(pub.descs.length, 1);
  assert.equal(pub.descs[0].text, '正常');
});

test('重放里不含任何私密信息（词与身份都不在动作里）', () => {
  const acts = [{ act: 'round', n: 1 }, { act: 'desc', p: 0, text: '好吃' }];
  const text = JSON.stringify(acts);
  for (const p of WORD_PAIRS) {
    assert.ok(text.indexOf(p.a) < 0, '动作里不该出现词：' + p.a);
    assert.ok(text.indexOf(p.b) < 0, '动作里不该出现词：' + p.b);
  }
});

test('摘要随局面变化', () => {
  const a = hashPub(fold({ n: 4 }, [{ act: 'round', n: 1 }]));
  const b = hashPub(fold({ n: 4 }, [{ act: 'round', n: 1 }, { act: 'desc', p: 0, text: 'x' }]));
  assert.notEqual(a, b);
});

/* ---------- 随机数 ---------- */
test('mulberry32 可复现且在 [0,1)', () => {
  const r1 = mulberry32(42);
  const r2 = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test('hashStr 稳定', () => {
  assert.equal(hashStr('abc'), hashStr('abc'));
  assert.notEqual(hashStr('abc'), hashStr('abd'));
});

/* ---------- AI ---------- */
test('AI 描述总是非空且长度合规', () => {
  const pair = WORD_PAIRS[0];
  for (let i = 0; i < 50; i++) {
    const d = aiDescribe(pair, pair.a, i / 50);
    assert.ok(d.length > 0 && d.length <= 60);
  }
});

test('AI 描述不会直接说出自己的词', () => {
  for (const pair of WORD_PAIRS.slice(0, 10)) {
    for (let i = 0; i < 20; i++) {
      const d = aiDescribe(pair, pair.a, i / 20);
      assert.ok(d.indexOf(pair.a) < 0, '描述里不该出现完整词：' + pair.a);
    }
  }
});

test('卧底 AI 的描述不露馅（绝不出现卧底词关键词）', () => {
  for (const pair of WORD_PAIRS) {
    for (let i = 0; i < 20; i++) {
      const d = aiDescribe(pair, pair.b, i / 20);
      assert.ok(d.indexOf(pair.b) < 0, '卧底 AI 不该说出完整卧底词：' + pair.b);
      for (const k of pair.kb) {
        assert.ok(d.indexOf(k) < 0, '卧底 AI 的描述露馅了，关键词：' + k + '（' + pair.b + '）');
      }
    }
  }
});

test('AI 投票不会投自己、不会投已出局的人', () => {
  const pub = { n: 4, alive: [true, true, true, false], descs: [], votes: {}, turnSeat: 0, phase: PHASE.VOTE };
  const pair = WORD_PAIRS[0];
  for (let i = 0; i < 30; i++) {
    const t = aiVote(pub, pair.a, pair, i / 30);
    assert.ok(t >= 0 && t < 4);
    assert.notEqual(t, 0);
    assert.notEqual(t, 3);
  }
});

test('AI 投票在只剩两人时有合法目标', () => {
  const pub = { n: 4, alive: [true, true, false, false], descs: [], votes: {}, turnSeat: 0, phase: PHASE.VOTE };
  const pair = WORD_PAIRS[0];
  const t = aiVote(pub, pair.a, pair, 0.5);
  assert.equal(t, 1);
});

test('aiRandom 可复现', () => {
  assert.equal(aiRandom('x'), aiRandom('x'));
  assert.notEqual(aiRandom('x'), aiRandom('y'));
});

/* ---------- 私密信息隔离（卧底这游戏的核心） ---------- */
test('replay 的 seed 里不含任何词', () => {
  const seed = { s: 12345, base: { n: 4, names: ['A', 'B', 'C', 'D'], ai: [false, true, true, true], spyCount: 1 } };
  const text = JSON.stringify(seed);
  for (const p of WORD_PAIRS) {
    assert.ok(text.indexOf(p.a) < 0, 'seed 里不该出现词：' + p.a);
    assert.ok(text.indexOf(p.b) < 0, 'seed 里不该出现词：' + p.b);
  }
});

test('replay 产出的公开局面不含词与身份', () => {
  const seed = { s: 1, base: { n: 4, spyCount: 1 } };
  const r = replay(seed, [{ act: 'round', n: 1 }]);
  const text = JSON.stringify(r);
  for (const p of WORD_PAIRS) {
    assert.ok(text.indexOf(p.a) < 0, '公开局面里不该出现词：' + p.a);
    assert.ok(text.indexOf(p.b) < 0, '公开局面里不该出现词：' + p.b);
  }
  assert.ok(text.indexOf(UNDERCOVER) < 0, '公开局面里不该出现身份标记');
  assert.ok(text.indexOf(CIVILIAN) < 0, '公开局面里不该出现身份标记');
});

test('eliminate 会公开出局者身份（这是公开信息，不是泄漏）', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  for (let i = 0; i < 3; i++) p = applyAction(p, { act: 'desc', p: i, text: 'x' + i }).pub;
  for (let i = 0; i < 3; i++) p = applyAction(p, { act: 'vote', p: i, target: (i + 1) % 3 }).pub;
  const r = applyAction(p, { act: 'eliminate', seat: 1, role: UNDERCOVER });
  assert.equal(r.ok, true);
  assert.equal(r.pub.reveals[1], UNDERCOVER);
});

test('nextPending 跳过本轮已行动的人', () => {
  const p = initPub(4);
  const done = { 0: true };
  assert.equal(nextPending(p, 0, done), 1);
  assert.equal(nextPending(p, 3, { 0: true, 1: true, 2: true, 3: true }), -1);
});

test('第二轮必须在结算阶段开', () => {
  let p = initPub(3);
  p = applyAction(p, { act: 'round', n: 1 }).pub;
  assert.equal(applyAction(p, { act: 'round', n: 2 }).ok, false);
  for (let i = 0; i < 3; i++) p = applyAction(p, { act: 'desc', p: i, text: 'x' + i }).pub;
  for (let i = 0; i < 3; i++) p = applyAction(p, { act: 'vote', p: i, target: (i + 1) % 3 }).pub;
  p = applyAction(p, { act: 'eliminate', seat: 0 }).pub;
  assert.equal(applyAction(p, { act: 'round', n: 2 }).ok, true);
});
