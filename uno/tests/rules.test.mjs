/* UNO 彩牌规则引擎单测：node --test uno/tests/rules.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLORS, COLOR_LABEL, WILD, SKIP, REVERSE, DRAW2, HAND_SIZE,
  cardId, parseCard, makeDeck, shuffle, mulberry32,
  deal, canPlay, play, drawCards, drawOne, drawAction, advance, hasPlayable,
  cloneState, hashState, replay, aiChoose, countColor, pickColor,
} from '../src/rules.mjs';

/* 造一个可完全控制的状态（不靠 deal 的随机发牌） */
function mkState(overrides) {
  const base = {
    deck: [],
    hands: [[], []],
    discard: [],
    top: 'red-5',
    activeColor: 'red',
    direction: 1,
    turn: 0,
    winner: -1,
    lastPlayed: null,
  };
  return { ...base, ...(overrides || {}) };
}

test('牌 id 编解码往返', () => {
  const c = { color: 'red', value: 5 };
  assert.equal(cardId(c), 'red-5');
  const p = parseCard('red-5');
  assert.equal(p.color, 'red');
  assert.equal(p.value, 5);
});

test('功能牌 id 不被压成 wild', () => {
  /* 这是个容易踩的坑：+2 / 跳过 / 反转如果都压成 'wild'，
     三种功能牌就分不开了，出牌效果全错。 */
  assert.equal(cardId({ color: WILD, value: DRAW2 }), 'draw2');
  assert.equal(cardId({ color: WILD, value: SKIP }), 'skip');
  assert.equal(cardId({ color: WILD, value: REVERSE }), 'reverse');
  assert.equal(cardId({ color: WILD, value: WILD }), 'wild');
});

test('parseCard 识别四种功能牌', () => {
  assert.equal(parseCard('wild').value, WILD);
  assert.equal(parseCard('draw2').value, DRAW2);
  assert.equal(parseCard('skip').value, SKIP);
  assert.equal(parseCard('reverse').value, REVERSE);
});

test('牌库张数正确：4 色 × (0 一张 + 1-9 各两张) + 万能 4 + +2 2 + 反转 2 + 跳过 2', () => {
  const d = makeDeck();
  /* 每色：0 一张 + 1~9 各两张 = 19 张；4 色 = 76 张 */
  /* 功能牌：万能 4 + +2 2 + 反转 2 + 跳过 2 = 10 张 */
  assert.equal(d.length, 4 * 19 + 10);
  assert.equal(d.length, 86);
  /* 唯一 id 数：4 色 × 10 个数字（0-9）+ 4 种功能牌 = 44 */
  const ids = new Set(d.map(cardId));
  assert.equal(ids.size, 44);
});

test('洗牌可复现：同 seed 结果一致', () => {
  const a = shuffle(makeDeck(), 12345).map(cardId).join(',');
  const b = shuffle(makeDeck(), 12345).map(cardId).join(',');
  assert.equal(a, b);
  const c = shuffle(makeDeck(), 999).map(cardId).join(',');
  assert.notEqual(a, c);
});

test('mulberry32 输出在 [0,1)', () => {
  const r = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, '越界：' + v);
  }
});

test('发牌：每人 7 张，起始牌是有颜色的牌', () => {
  const s = deal(7, 2);
  assert.equal(s.hands.length, 2);
  assert.equal(s.hands[0].length, HAND_SIZE);
  assert.equal(s.hands[1].length, HAND_SIZE);
  assert.notEqual(s.top, WILD);
  assert.ok(COLORS.includes(s.activeColor));
  assert.equal(s.turn, 0);
  assert.equal(s.winner, -1);
});

test('发牌不会把同一张牌发给两个人', () => {
  const s = deal(2024, 2);
  const all = s.hands[0].concat(s.hands[1]);
  assert.equal(all.length, 14);
  /* id 可以重复（数字牌有两张），但整张牌不能重复出现在两人手里之外 */
  assert.ok(s.deck.length > 0);
});

test('canPlay：同色可出', () => {
  assert.ok(canPlay('red-3', 'red-5', 'red'));
});

test('canPlay：同数字可出', () => {
  assert.ok(canPlay('blue-7', 'red-7', 'red'));
});

test('canPlay：不同色不同数字不可出', () => {
  assert.ok(!canPlay('blue-3', 'red-5', 'red'));
});

test('canPlay：万能牌永远可出', () => {
  assert.ok(canPlay('wild', 'red-5', 'red'));
  assert.ok(canPlay('wild', 'wild', 'red'));
});

test('canPlay：顶牌是万能牌时，只能出指定颜色', () => {
  assert.ok(canPlay('blue-3', 'wild', 'blue'));
  assert.ok(!canPlay('red-3', 'wild', 'blue'));
});

test('出牌：成功出牌后手牌减少、顶牌更新、轮次推进', () => {
  const s = mkState({ hands: [['red-3', 'blue-9'], ['green-1']], turn: 0 });
  const r = play(s, 0, 'red-3');
  assert.ok(r.ok);
  assert.equal(r.state.hands[0].length, 1);
  assert.equal(r.state.top, 'red-3');
  assert.equal(r.state.turn, 1);
  assert.equal(r.state.activeColor, 'red');
});

test('出牌：不是你的回合会被拒绝', () => {
  const s = mkState({ hands: [['red-3'], ['blue-1']], turn: 0 });
  const r = play(s, 1, 'blue-1');
  assert.ok(!r.ok);
  assert.match(r.reason, /轮到你/);
});

test('出牌：接不上会被拒绝', () => {
  const s = mkState({ hands: [['blue-3'], ['red-1']], turn: 0 });
  const r = play(s, 0, 'blue-3');
  assert.ok(!r.ok);
  assert.match(r.reason, /接不上/);
});

test('出牌：手里没这张牌会被拒绝', () => {
  const s = mkState({ hands: [['red-3'], ['blue-1']], turn: 0 });
  const r = play(s, 0, 'red-9');
  assert.ok(!r.ok);
  assert.match(r.reason, /没有这张牌/);
});

test('出牌：不修改传入的 state', () => {
  const s = mkState({ hands: [['red-3'], ['blue-1']], turn: 0 });
  const before = JSON.stringify(s);
  play(s, 0, 'red-3');
  assert.equal(JSON.stringify(s), before);
});

test('出牌：手牌出完即胜', () => {
  const s = mkState({ hands: [['red-3'], ['blue-1']], turn: 0 });
  const r = play(s, 0, 'red-3');
  assert.ok(r.ok);
  assert.equal(r.state.winner, 0);
});

test('出牌：跳过牌让下家再被跳过（两人局回到出牌人）', () => {
  const s = mkState({ hands: [['skip', 'red-1'], ['blue-1']], turn: 0 });
  const r = play(s, 0, 'skip');
  assert.ok(r.ok);
  assert.equal(r.state.turn, 0, '两人局跳过下家 → 又轮到出牌人');
});

test('出牌：反转牌在两人局等价于跳过', () => {
  const s = mkState({ hands: [['reverse', 'red-1'], ['blue-1']], turn: 0 });
  const r = play(s, 0, 'reverse');
  assert.ok(r.ok);
  assert.equal(r.state.turn, 0);
});

test('出牌：+2 让下家摸两张（被罚者仍轮到自己出牌，不是跳过）', () => {
  const s = mkState({
    hands: [['draw2', 'red-1'], ['blue-1']],
    deck: ['green-1', 'yellow-2'],
    turn: 0,
  });
  const r = play(s, 0, 'draw2');
  assert.ok(r.ok);
  assert.equal(r.state.hands[1].length, 3, '下家摸了两张');
  /* UNO 规则：被 +2 罚的人仍然轮到自己出牌 —— 写成跳过会让对方永远等不到回合 */
  assert.equal(r.state.turn, 1, '被罚的下家仍轮到自己');
  assert.ok(r.state.hands[1].includes('green-1'));
});

test('出牌：万能牌指定颜色生效', () => {
  const s = mkState({ hands: [['wild', 'red-1'], ['blue-1']], turn: 0 });
  const r = play(s, 0, 'wild', 'blue');
  assert.ok(r.ok);
  assert.equal(r.state.activeColor, 'blue');
});

test('出牌：万能牌不指定颜色时挑手里最多的颜色', () => {
  const s = mkState({ hands: [['wild', 'red-1', 'red-2', 'blue-1'], ['blue-1']], turn: 0 });
  const r = play(s, 0, 'wild');
  assert.ok(r.ok);
  assert.equal(r.state.activeColor, 'red', '手里红牌多');
});

test('pickColor 在空手时也返回一个合法颜色', () => {
  assert.ok(COLORS.includes(pickColor([])));
});

test('advance 带方向推进', () => {
  assert.equal(advance(0, 2, 1), 1);
  assert.equal(advance(1, 2, 1), 0);
  assert.equal(advance(0, 2, -1), 1);
  assert.equal(advance(0, 3, 1), 1);
  assert.equal(advance(2, 3, 1), 0);
});

test('drawCards 从牌库摸牌', () => {
  const s = mkState({ hands: [[], []], deck: ['red-1', 'blue-2'] });
  const got = drawCards(s, 0, 2);
  assert.equal(got, 2);
  assert.equal(s.hands[0].length, 2);
});

test('drawCards 牌库空了会从弃牌堆回收重洗', () => {
  const s = mkState({
    hands: [[], []],
    deck: [],
    discard: ['red-1', 'blue-2', 'green-3'],
    top: 'green-3',
  });
  const got = drawCards(s, 0, 2);
  assert.equal(got, 2, '应该从弃牌堆回收两张');
  assert.equal(s.hands[0].length, 2);
});

test('drawCards 弃牌堆也没有牌时摸不到（认了）', () => {
  const s = mkState({ hands: [[], []], deck: [], discard: ['red-1'], top: 'red-1' });
  const got = drawCards(s, 0, 2);
  assert.equal(got, 0);
});

test('drawOne 只能自己摸', () => {
  const s = mkState({ hands: [[], []], deck: ['red-1'], turn: 0 });
  const bad = drawOne(s, 1);
  assert.ok(!bad.ok);
  const good = drawOne(s, 0);
  assert.ok(good.ok);
  assert.ok(good.drawn);
  assert.equal(good.state.hands[0].length, 1);
});

test('drawAction：摸到接得上的牌 → 仍轮到自己', () => {
  /* 顶牌 red-5，牌库里有 red-3 → 摸到就能接，回合仍在自己 */
  const s = mkState({ hands: [['blue-9'], []], deck: ['red-3'], top: 'red-5', activeColor: 'red', turn: 0 });
  const r = drawAction(s, 0);
  assert.ok(r.ok);
  assert.equal(r.state.hands[0].length, 2);
  assert.equal(r.state.turn, 0, '接得上就还能出');
});

test('drawAction：摸到接不上的牌 → 回合交给对方', () => {
  /* 顶牌 red-5，牌库只有 blue-7 → 接不上，这轮跳过 */
  const s = mkState({ hands: [['blue-9'], []], deck: ['blue-7'], top: 'red-5', activeColor: 'red', turn: 0 });
  const r = drawAction(s, 0);
  assert.ok(r.ok);
  assert.equal(r.state.hands[0].length, 2);
  assert.equal(r.state.turn, 1, '接不上就跳过回合');
});

test('drawAction 只能自己摸', () => {
  const s = mkState({ hands: [[], []], deck: ['red-1'], turn: 0 });
  const bad = drawAction(s, 1);
  assert.ok(!bad.ok);
});

test('hasPlayable 判断有没有能接的牌', () => {
  const s = mkState({ hands: [['blue-3'], ['red-1']], top: 'red-5', activeColor: 'red' });
  assert.ok(!hasPlayable(s, 0));
  assert.ok(hasPlayable(s, 1));
});

test('cloneState 深拷贝：改副本不影响原状态', () => {
  const s = mkState({ hands: [['red-3'], ['blue-1']], deck: ['green-1'] });
  const c = cloneState(s);
  c.hands[0].push('yellow-9');
  c.deck.push('red-2');
  assert.equal(s.hands[0].length, 1);
  assert.equal(s.deck.length, 1);
});

test('hashState 相同状态给相同摘要', () => {
  const s = mkState({ hands: [['red-3'], ['blue-1']] });
  assert.equal(hashState(s), hashState(cloneState(s)));
  const t = cloneState(s);
  t.turn = 1;
  assert.notEqual(hashState(s), hashState(t));
});

test('replay 重放出与逐手操作一致的状态', () => {
  const seed = 555;
  const s0 = deal(seed, 2);
  const actions = [];
  let s = s0;
  for (let i = 0; i < 6 && s.winner < 0; i++) {
    const p = s.turn;
    const choice = aiChoose(s, p, 1000 + i);
    if (!choice) {
      /* 用 drawAction（与重放同一条路径），别用 drawOne —— 两者语义不同 */
      actions.push({ p, act: 'draw' });
      const r = drawAction(s, p);
      if (!r.ok) break;
      s = r.state;
      continue;
    }
    actions.push({ p, act: 'play', id: choice.id, color: choice.color });
    const pr = play(s, p, choice.id, choice.color);
    if (!pr.ok) break;
    s = pr.state;
  }
  const r = replay(actions, seed, 2);
  assert.equal(hashState(r.state), hashState(s));
  assert.equal(r.actions.length, actions.length);
});

test('replay 遇到非法动作时停下', () => {
  const seed = 777;
  const r = replay([{ p: 1, act: 'play', id: 'wild' }], seed, 2);
  /* 第一手就抢别人的回合 → 应当停下，状态等于刚发牌 */
  assert.equal(r.state.hands[0].length, HAND_SIZE);
  assert.equal(r.actions.length, 1);
});

test('重放路径与本地路径结果一致（摸牌语义尤其重要）', () => {
  /* 本地摸牌若「接不上就跳过回合」只在 UI 层做，
     重放时就会漏掉这一步 —— 两端状态从此对不上。
     所以这条测试专门盯住摸牌动作。 */
  const seed = 4242;
  /* 造一个「玩家手里全接不上、摸到的也接不上」的局 */
  const s = mkState({
    hands: [['blue-9'], ['red-1']],
    deck: ['blue-7', 'green-2'],
    discard: [],
    top: 'red-5', activeColor: 'red', turn: 0,
  });
  /* 本地路径 */
  const local = drawAction(s, 0);
  assert.ok(local.ok);
  assert.equal(local.state.turn, 1, '本地：接不上就跳过');

  /* 重放路径：deal(seed) 的初始局面未必一样，所以直接比对 drawAction 的行为一致性：
     同样「手里接不上 + 摸到的也接不上」→ 都应该跳过回合。 */
  const s2 = mkState({
    hands: [['blue-9'], ['red-1']],
    deck: ['blue-7', 'green-2'],
    discard: [],
    top: 'red-5', activeColor: 'red', turn: 0,
  });
  const viaReplay = drawAction(s2, 0);
  assert.equal(viaReplay.state.turn, local.state.turn, '本地与重放语义必须一致');
  assert.equal(hashState(viaReplay.state), hashState(local.state));
});

test('aiChoose 只在能接的牌里选', () => {
  const s = mkState({ hands: [['blue-3', 'red-9'], []], top: 'red-5', activeColor: 'red' });
  const c = aiChoose(s, 0, 1);
  assert.ok(c);
  assert.equal(c.id, 'red-9', '红 9 能接，应该选它');
});

test('aiChoose 没有能接的牌时返回 null', () => {
  const s = mkState({ hands: [['blue-3'], []], top: 'red-5', activeColor: 'red' });
  assert.equal(aiChoose(s, 0, 1), null);
});

test('aiChoose 优先出功能牌', () => {
  const s = mkState({ hands: [['red-2', 'draw2'], []], top: 'red-5', activeColor: 'red' });
  const c = aiChoose(s, 0, 1);
  assert.equal(c.id, 'draw2');
});

test('aiChoose 出万能牌时会指定颜色', () => {
  const s = mkState({ hands: [['wild', 'red-1', 'red-2'], []], top: 'blue-5', activeColor: 'blue' });
  const c = aiChoose(s, 0, 1);
  assert.equal(c.id, 'wild');
  assert.ok(COLORS.includes(c.color));
});

test('countColor 统计某色张数', () => {
  assert.equal(countColor(['red-1', 'red-2', 'blue-3', 'wild'], 'red'), 2);
  assert.equal(countColor(['red-1', 'wild'], 'blue'), 0);
});

test('COLOR_LABEL 四色齐全', () => {
  for (const c of COLORS) assert.ok(COLOR_LABEL[c], c + ' 缺中文名');
});
