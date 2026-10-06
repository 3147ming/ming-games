// 牌库操作（纯函数式，无 DOM）
// 口径：牌组里存的是「实例」（{ uid, cid }），不是定义本身。
//      这样才能支持同一张卡带多份、以及后续做「升级版」而不污染配置表。

import { CARDS, CARD_MAP, POOL_CARDS, starterDeck } from '../config/cards.js';
import { CONST } from '../config/constants.js';

let UID = 1;

export function newUid() {
  return UID++;
}

export function makeInstance(cid) {
  return { uid: newUid(), cid };
}

export function def(inst) {
  return CARD_MAP[inst.cid];
}

export function makeDeck(cids) {
  return cids.map((cid) => makeInstance(cid));
}

export function playerStarterDeck(archetypeId) {
  return makeDeck(starterDeck(archetypeId));
}

/** 抽牌；牌堆空则把弃牌堆洗回来（用同一颗 rng，保证可复现） */
export function drawCards(state, n, rng) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (state.draw.length === 0) {
      if (state.discard.length === 0) break;
      state.draw = rng.shuffled(state.discard);
      state.discard = [];
      state.log.push({ t: 'info', text: '弃牌堆洗回牌堆。' });
    }
    const c = state.draw.pop();
    if (state.hand.length >= 10) {
      // 手牌上限 10（口径：防止熵流无限循环把内存拖爆，也保护手机端渲染）
      state.discard.push(c);
    } else {
      state.hand.push(c);
      drawn.push(c);
    }
  }
  return drawn;
}

export function discardAllHand(state) {
  state.discard.push(...state.hand);
  state.hand = [];
}

export function addCard(state, cid, to = 'discard') {
  const inst = makeInstance(cid);
  state[to].push(inst);
  return inst;
}

export function removeCard(state, uid) {
  const pools = ['hand', 'draw', 'discard', 'exhaust'];
  for (const p of pools) {
    const i = state[p].findIndex((c) => c.uid === uid);
    if (i >= 0) {
      state[p].splice(i, 1);
      return true;
    }
  }
  return false;
}

/** 奖励卡池：稀有度加权（口径 60/30/10），不放回抽 n 张 */
export function rollRewardCards(rng, unlockedCids, n = CONST.REWARD_CHOICES) {
  const pool = POOL_CARDS.filter((c) => unlockedCids.has(c.id));
  const picked = [];
  const used = new Set();
  let guard = 0;
  while (picked.length < n && guard++ < 200) {
    const c = rng.weighted(pool, (x) => CONST.RARITY_WEIGHT[x.r] || 0);
    if (used.has(c.id)) continue;
    used.add(c.id);
    picked.push(c);
  }
  return picked;
}

export function rollCardsByRarity(rng, unlockedCids, rarity, n) {
  const pool = POOL_CARDS.filter((c) => unlockedCids.has(c.id) && c.r === rarity);
  const list = pool.length ? pool : POOL_CARDS.filter((c) => unlockedCids.has(c.id));
  return rng.sample(list, n);
}

export function deckCount(state) {
  return state.hand.length + state.draw.length + state.discard.length + state.exhaust.length;
}

/** 从「局外牌组」（纯数组）里移除一张实例 */
export function removeFromDeck(deck, uid) {
  const i = deck.findIndex((c) => c.uid === uid);
  if (i < 0) return false;
  deck.splice(i, 1);
  return true;
}
