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

/**
 * 奖励卡池：稀有度加权（口径 60/30/10），不放回抽 n 张。
 *
 * 三层保底，依次生效（越靠前越优先占位）：
 *  ① opts.keyCards + opts.seenKey + opts.rewardIndex —— 本局前 4 次奖励、且还没见过关键牌时，
 *     先给一张没见过的关键牌（第三批 P0-6）。
 *     口径：只保底 **1 次**，保证「凑得起来」，不保证「一定凑齐」。
 *     起因：实测全解锁池下一局 9 次三选一，蚀/熵有 49% 一张关键牌都见不到，
 *          「凑出 combo 的瞬间」这个写在 project.json 里的核心幻想根本不发生。
 *  ② opts.guaranteeArch —— 先给本流派留一个位置（机制批 P0-4）。
 *  ③ 其余按稀有度权重补齐。
 *
 * 保持旧调用签名可用：荒野关 rollWildReward 不传 opts，就仍是 ②③ 的旧行为
 * （荒野奖励里不该出现关键牌保底 —— 那是节点奖励的设计，不是实时关的）。
 */
export function rollRewardCards(rng, unlockedCids, n = CONST.REWARD_CHOICES, opts = {}) {
  const pool = POOL_CARDS.filter((c) => unlockedCids.has(c.id));
  const picked = [];
  const used = new Set();
  const own = opts.guaranteeArch ? pool.filter((c) => c.a === opts.guaranteeArch) : [];
  const keyIds = opts.keyCards || [];
  const seenKey = opts.seenKey || new Set();
  const unseenKey = pool.filter((c) => keyIds.includes(c.id) && !seenKey.has(c.id));
  // 第三批 P0-6：**整局只保底 1 次**。
  //   判据必须是「本局一张关键牌都还没见过」，不是「还有没见过的关键牌」——
  //   后者会在前 4 次奖励里连发，三张全齐率实测 100%，把「凑 combo」直接变成白送。
  const seenAnyKey = keyIds.some((id) => seenKey.has(id));
  if (!seenAnyKey && unseenKey.length && opts.rewardIndex < CONST.KEYCARD_GUARANTEE_WINDOW) {
    const c = rng.weighted(unseenKey, (x) => CONST.RARITY_WEIGHT[x.r] || 0);
    used.add(c.id);
    picked.push(c);
  } else if (own.length && n > 1) {
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
