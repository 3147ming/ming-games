// 元进度：核心幻想的机制化身 ——「每一世，你只带回一张牌」
// 口径：无论胜负，每局结束都能且只能带回 1 张卡 + 1 件遗物。
//      这样「死亡」是唯一稳定的产出通道，幻想与机制同向（见 docs/01 §7.2）。

import { CARDS, POOL_CARDS } from '../config/cards.js';
import { RELICS } from '../config/relics.js';
import { CONST } from '../config/constants.js';
import { load, save } from './storage.js';

function initialUnlocked(kind) {
  const src = kind === 'card' ? POOL_CARDS : RELICS;
  return src.filter((x) => !x.sealed).map((x) => x.id);
}

export function defaultMeta() {
  return {
    unlockedCards: initialUnlocked('card'),
    unlockedRelics: initialUnlocked('relic'),
    unlockedAt: [],
    runs: 0,
    wins: 0,
    bestFloor: 0,
    totalMinutes: 0,
  };
}

export function loadMeta() {
  const m = load(CONST.SAVE_KEY, null);
  if (!m || !Array.isArray(m.unlockedCards) || !Array.isArray(m.unlockedRelics)) return defaultMeta();
  const d = defaultMeta();
  const merged = { ...d, ...m };
  // 口径：基础牌（稀有度 0）不参与解锁体系
  merged.unlockedCards = merged.unlockedCards.filter((id) => POOL_CARDS.some((c) => c.id === id));
  return merged;
}

export function saveMeta(meta) {
  save(CONST.SAVE_KEY, meta);
}

export function sealedCards(meta) {
  const set = new Set(meta.unlockedCards);
  return POOL_CARDS.filter((c) => !set.has(c.id));
}

export function sealedRelics(meta) {
  const set = new Set(meta.unlockedRelics);
  return RELICS.filter((r) => !set.has(r.id));
}

/** 每局结束给 3 张候选供玩家选 1 —— 「带回一张牌」的具体交互 */
export function rollUnlockChoices(rng, meta, n = 3) {
  const cards = rng.sample(sealedCards(meta), n);
  const relics = rng.sample(sealedRelics(meta), CONST.UNLOCK_RELICS_PER_RUN);
  return { cards, relics };
}

export function grantCardUnlock(meta, cid) {
  if (!meta.unlockedCards.includes(cid)) {
    meta.unlockedCards.push(cid);
    meta.unlockedAt.push({ kind: 'card', id: cid, run: meta.runs });
  }
  saveMeta(meta);
}

export function grantRelicUnlock(meta, rid) {
  if (!meta.unlockedRelics.includes(rid)) {
    meta.unlockedRelics.push(rid);
    meta.unlockedAt.push({ kind: 'relic', id: rid, run: meta.runs });
  }
  saveMeta(meta);
}

export function progress(meta) {
  return {
    cards: `${meta.unlockedCards.length} / ${POOL_CARDS.length}`,
    relics: `${meta.unlockedRelics.length} / ${RELICS.length}`,
    runsUntilComplete: sealedCards(meta).length,
  };
}

export function cardById(id) {
  return CARDS.find((c) => c.id === id) || null;
}
