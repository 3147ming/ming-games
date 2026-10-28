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

/** 奖励卡池：稀有度加权（口径 60/30/10），不放回抽 n 张
 *  机制批 P0-4：opts.guaranteeArch 先给本流派留一个位置，其余按原权重补齐；
 *              保持旧调用签名可用（荒野关 rollWildReward 不传这个参数就还是旧行为）。 */
export function rollRewardCards(rng, unlockedCids, n = CONST.REWARD_CHOICES, opts = {}) {
  const pool = POOL_CARDS.filter((c) => unlockedCids.has(c.id));
  const picked = [];
  const used = new Set();
  // 口径：先给本流派一个位置，再按稀有度权重补齐 —— 否则 28.9%~42.3% 的局一张关键牌都摸不到。
  const own = opts.guaranteeArch ? pool.filter((c) => c.a === opts.guaranteeArch) : [];
  if (own.length && n > 1) {
    const c = rng.weighted(own, (x) => CONST.RARITY_WEIGHT[x.r] || 0);
    used.add(c.id);
    picked.push(c);
  }
  let guard = 0;
  while (picked.length < n && guard++ < 200) {
    const c = rng.weighted(pool, (x) => CONST.RARITY_WEIGHT[x.r] || 0);
    if (used.has(c.id)) continue;
    used.add(c.id);
    picked.push(c);
  }
  return rng.shuffled(picked); // 打散顺序：保底牌不能永远排第一
}

/** 从存档恢复时把 UID 推到已用过的最大值之上，否则新牌会和旧牌撞号（removeFromDeck 会删错） */
export function ensureUidAbove(maxUid) {
  if (UID <= maxUid) UID = maxUid + 1;
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
