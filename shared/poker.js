/* 扑克牌桌底座 · Poker Table Kit
 *
 * 斗地主 / 510K / 同心 / 三张牌共用。只做「一张真正的扑克牌桌」里与规则无关的部分：
 *   ① 牌堆 —— 余牌张数、可见的背牌堆、发牌时逐张飞出、牌堆耗尽的状态
 *   ② 座位区 —— 对家 / 左家 / 右家 / 自己各自的独立屏幕区域：
 *               头像、称呼、标签（地主 / 红队 / 队友）、牌背扇形、张数、已出牌、当前回合光晕
 *   ③ 出牌动作 —— 牌从该座位飞向桌心，落定盖一枚 PLAY 印章；空墩回落到「等待出牌」
 *
 * 用法：
 *   import * as Poker from '../../shared/poker.js';
 *   var T = Poker.mount(el, { seats: [{ name: '你', me: true }, { name: 'AI·左' }] });
 *   T.deck(54);
 *   T.hand(1, 17);                 // 左家 17 张牌背
 *   T.deal(1, 0);                  // 视觉上从牌堆飞一张给左家
 *   T.turn(1); T.play(1, cards);   // 左家出牌：飞向桌心 + PLAY 印章
 *   T.fresh('等待出牌');
 *
 * DOM 一次性建好，之后只改类名/文本，避免整块 innerHTML 重建打断动画。
 */

export const SUITS = ['♠', '♥', '♦', '♣'];
export const SUIT_NAMES = ['黑桃', '红桃', '方块', '梅花'];
const SUIT_RED = [false, true, true, false];
const SUIT_NAME_MAP = { '♠': '黑桃', '♥': '红桃', '♦': '方块', '♣': '梅花' };

/** 统一的牌面字段：{ rank, suit, red, joker }。大小王单独一档。 */
export function faceOf(c) {
  if (!c) return { rank: '', suit: '', red: false, joker: '' };
  const big = c.v === 17 || c.r === 'BJ';
  const small = c.v === 16 || c.r === 'wj' || c.r === 'joker';
  if (big || small) return { rank: big ? '大' : '小', suit: '王', red: big, joker: big ? 'big' : 'small' };
  const isNum = typeof c.s === 'number';
  const suit = isNum ? SUITS[c.s] : c.s;
  const red = isNum ? SUIT_RED[c.s] : (c.s === '♥' || c.s === '♦');
  return { rank: String(c.r), suit, red, joker: '' };
}

/** 完整中文牌名，给 aria-label 与结算文案用。 */
export function cardName(c) {
  if (!c) return '';
  const f = faceOf(c);
  if (f.joker) return (f.rank === '大' ? '大' : '小') + '王';
  const base = typeof c.s === 'number' ? SUIT_NAMES[c.s] : SUIT_NAME_MAP[c.s];
  return base ? base + c.r : String(c.r);
}

/** 手牌排序：点数从大到小，同点按花色（♠♥♦♣）。 */
export function sortCards(h) {
  h.sort((a, b) => (b.v - a.v) || SUITS.indexOf(a.s) - SUITS.indexOf(b.s));
  return h;
}

/** 牌面元素（可读、带 aria-label）。 */
export function faceEl(card, cls) {
  const f = faceOf(card);
  const el = document.createElement('div');
  el.className = 'pk-face' + (f.red ? ' red' : '') + (f.joker ? ' joker' : '') + (cls ? ' ' + cls : '');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', cardName(card));
  el.innerHTML = f.joker
    ? `<span class="pk-jr">${f.rank}</span><span class="pk-js">王</span>`
    : `<span class="pk-r">${f.rank}</span><span class="pk-s">${f.suit}</span>`;
  return el;
}

/** 牌背元素。 */
export function backEl(cls) {
  const el = document.createElement('div');
  el.className = 'pk-back' + (cls ? ' ' + cls : '');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

const SLOTS = ['opp', 'left', 'right', 'me'];

/**
 * 挂载一张牌桌。
 * @param {HTMLElement} root 容器
 * @param {{seats?: Array<{name:string, initial?:string, me?:boolean, slot?:string, accent?:string}>,
 *          emptyText?:string, dealMs?:number}} opts
 */
export function mount(root, opts) {
  const o = opts || {};
  const cfg = o.seats || [];
  root.classList.add('pk-table');
  root.textContent = '';

  const deck = document.createElement('div');
  deck.className = 'pk-deck';
  deck.innerHTML = '<span class="pk-deck-label">牌堆</span><span class="pk-deck-stack"></span><span class="pk-deck-count"><b>0</b> 张</span>';
  const stack = deck.querySelector('.pk-deck-stack');
  const deckNum = deck.querySelector('.pk-deck-count b');

  const board = document.createElement('div');
  board.className = 'pk-board';

  const center = document.createElement('div');
  center.className = 'pk-center';
  const emptyEl = document.createElement('div');
  emptyEl.className = 'pk-empty';
  emptyEl.textContent = o.emptyText || '等待出牌';
  const live = document.createElement('div');
  live.className = 'pk-live';
  live.hidden = true;
  center.append(emptyEl, live);
  board.append(center);
  root.append(deck, board);

  const seats = cfg.map((c, i) => {
    const slot = c.slot || SLOTS[i] || 'me';
    const el = document.createElement('div');
    el.className = 'pk-seat pk-' + slot + (c.me ? ' is-me' : '');
    if (c.accent) el.style.setProperty('--seat', c.accent);
    el.innerHTML =
      '<div class="pk-seat-head">' +
        '<span class="pk-avatar"></span>' +
        '<span class="pk-who"></span>' +
        '<span class="pk-tag"></span>' +
        '<span class="pk-n"></span>' +
      '</div>' +
      '<div class="pk-fan"></div>' +
      '<div class="pk-say"></div>';
    el.querySelector('.pk-who').textContent = c.name || '';
    el.querySelector('.pk-avatar').textContent = c.initial || String(c.name || '?').replace(/[（(].*?[)）]/g, '').slice(0, 1);
    board.append(el);
    return {
      el, cfg: c, slot,
      fan: el.querySelector('.pk-fan'),
      nEl: el.querySelector('.pk-n'),
      tag: el.querySelector('.pk-tag'),
      say: el.querySelector('.pk-say')
    };
  });

  let stampTimer = 0;
  const api = {
    root, board, deckEl: deck, center, faceEl, backEl, cardName, faceOf,

    /** 刷新牌堆张数与背牌堆厚度；animate=true 播一次洗牌抖动。 */
    deck(n, animate) {
      deckNum.textContent = String(Math.max(0, n));
      deck.classList.toggle('is-empty', n <= 0);
      const layers = Math.min(6, Math.ceil(Math.max(0, n) / 9));
      stack.textContent = '';
      for (let i = 0; i < layers; i++) {
        const b = backEl();
        b.style.transform = `translate(${-i * 1.5}px,${-i * 1.5}px)`;
        b.style.zIndex = String(10 - i);
        stack.append(b);
      }
      if (animate) {
        deck.classList.remove('is-shuffle');
        void deck.offsetWidth;
        deck.classList.add('is-shuffle');
      }
    },

    /** 座位外的牌背/明牌。faceUp 给牌数组时直接亮牌（如对手摊牌）。 */
    hand(i, n, faceUp) {
      const s = seats[i];
      if (!s) return;
      s.fan.textContent = '';
      const me = !!(cfg[i] && cfg[i].me);
      if (faceUp && faceUp.length) faceUp.forEach((c) => s.fan.append(faceEl(c)));
      else if (me) {
        /* 自己的区域不画牌背（真实手牌就在下面），用几段色条示意张数 */
        for (let j = 0; j < Math.min(14, Math.ceil(n / 2)); j++) s.fan.append(backEl('pk-tick'));
      } else for (let j = 0; j < Math.min(12, n); j++) s.fan.append(backEl());
      s.fan.setAttribute('data-n', String(n));
      api.count(i, n);
    },

    count(i, n) {
      const s = seats[i];
      if (s) s.nEl.textContent = n > 0 ? n + ' 张' : '';
    },

    tag(i, text, tone) {
      const s = seats[i];
      if (!s) return;
      s.tag.textContent = text || '';
      s.tag.className = 'pk-tag' + (tone ? ' t-' + tone : '');
    },

    turn(i) {
      seats.forEach((s, k) => s.el.classList.toggle('is-turn', k === i));
    },

    say(i, text) {
      const s = seats[i];
      if (!s) return;
      s.say.textContent = text || '';
      s.say.classList.toggle('on', !!text);
    },

    /** 发牌动画：从牌堆飞一张背牌到某座位。delay 用于逐张错开。 */
    deal(i, delay) {
      const s = seats[i];
      if (!s) return;
      const host = root.getBoundingClientRect();
      const a = deck.getBoundingClientRect();
      const b = s.el.getBoundingClientRect();
      const fly = backEl('pk-fly');
      fly.style.left = (a.left - host.left + a.width / 2 - 11) + 'px';
      fly.style.top = (a.top - host.top + a.height / 2 - 15) + 'px';
      root.append(fly);
      const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
      const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      const anim = fly.animate(
        [{ transform: 'translate(0,0)', opacity: 1 },
         { transform: `translate(${dx}px,${dy}px) rotate(${dx > 0 ? 10 : -10}deg)`, opacity: 0.85 }],
        { duration: o.dealMs || 300, delay: delay || 0, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' }
      );
      anim.onfinish = () => fly.remove();
      setTimeout(() => {
        s.el.classList.remove('is-dealt');
        void s.el.offsetWidth;
        s.el.classList.add('is-dealt');
      }, (delay || 0) + (o.dealMs || 300));
    },

    /**
     * 出牌动作：牌从座位飞向桌心，落定后盖 PLAY 印章。
     * @param {number} i 座位下标
     * @param {Array} cards 牌数组
     * @param {string} [kind] 额外类名标记（k-score / k-new / k-hot …）
     */
    play(i, cards, kind) {
      const s = seats[i];
      const list = cards || [];
      if (s) {
        s.el.classList.add('is-acting');
        setTimeout(() => s.el.classList.remove('is-acting'), 460);
      }
      const made = [];
      /* 只有桌心本来是空的时候才清空；同一墩里后续出牌是「接在」已有牌后面，
         之前无脑 textContent='' 会把上一家刚打出的牌擦掉。 */
      if (live.hidden) live.textContent = '';
      live.hidden = false;
      emptyEl.style.display = 'none';
      list.forEach((c, idx) => {
        const el = faceEl(c, 'pk-trick' + (kind ? ' ' + kind : ''));
        el.style.position = 'fixed';
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.zIndex = '60';
        el.style.opacity = '0';
        document.body.append(el);
        made.push(el);
      });
      /* 先量一次坐标（此时牌已经在 body 里、尚未参与布局动画） */
      const from = (s ? s.el : root).getBoundingClientRect();
      const to = live.getBoundingClientRect();
      const GAP = 24;
      const prev = live.childElementCount;
      made.forEach((el, idx) => {
        const w = el.offsetWidth || 28;
        const h = el.offsetHeight || 40;
        const sx = from.left + from.width / 2 - w / 2;
        const sy = from.top + from.height / 2 - h / 2;
        el.style.left = sx + 'px';
        el.style.top = sy + 'px';
        const tx = to.left + to.width / 2 - w / 2 + (prev + idx - (prev + list.length - 1) / 2) * GAP;
        const ty = to.top + to.height / 2 - h / 2;
        const anim = el.animate(
          [{ transform: 'translate(0,0) scale(.7) rotate(-14deg)', opacity: 0.15 },
           { transform: `translate(${tx - sx}px,${ty - sy}px) scale(1) rotate(0deg)`, opacity: 1 }],
          { duration: 360, delay: idx * 45, easing: 'cubic-bezier(.22,.9,.3,1)', fill: 'forwards' }
        );
        anim.onfinish = () => {
          /* 必须先 cancel 再摘样式：Web Animation（fill:forwards）的最终帧会一直压在上面，
             只删 inline 样式也擦不掉那条 transform/opacity，牌会停在错位的半透明状态。 */
          anim.cancel();
          el.removeAttribute('style');
          el.classList.add('pk-trick');
          live.append(el);
          live.setAttribute('data-n', String(live.childElementCount));
        };
      });
      /* 三张底牌属于「摊开展示」，不是出牌，不盖印章 */
      const stamp = kind !== 'k-new';
      const total = 360 + Math.max(0, list.length - 1) * 45;
      clearTimeout(stampTimer);
      if (stamp) {
        stampTimer = setTimeout(() => {
          live.classList.remove('stamped');
          void live.offsetWidth;
          live.classList.add('stamped');
        }, total);
      }
      live.setAttribute('data-count', String(list.length));
      return total;
    },

    /** 清空桌心，回到「等待出牌」。 */
    fresh(text) {
      clearTimeout(stampTimer);
      live.textContent = '';
      live.classList.remove('stamped');
      live.hidden = true;
      emptyEl.style.display = '';
      emptyEl.textContent = text || o.emptyText || '等待出牌';
    },

    /** 桌心直接摆牌（不发动画），用于看底牌 / 亮牌。 */
    show(cards, kind) {
      api.fresh('');
      live.hidden = false;
      emptyEl.style.display = 'none';
      (cards || []).forEach((c) => live.append(faceEl(c, kind)));
    },

    /** 结算飘字：墩分、谁赢了本墩。 */
    claim(text, tone) {
      const t = document.createElement('div');
      t.className = 'pk-claim' + (tone ? ' ' + tone : '');
      t.textContent = text;
      board.append(t);
      setTimeout(() => t.remove(), 1400);
    },

    seat(i) { return seats[i]; }
  };

  root.__pk = api;
  return api;
}

export default { mount, faceEl, backEl, faceOf, cardName, sortCards, SUITS };
