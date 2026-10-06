/**
 * 抉择事件（每晚 1–2 次暂停级弹窗，两个选项，立刻生效）
 *
 * ── 为什么必须"暂停级" ──────────────────────────────────
 * 弹窗期间夜时钟必须停住，否则玩家在读题的 10 秒里会流失顾客 ——
 * 那就不是"抉择"而是"惩罚读字慢"。所以由 main 在弹出时置 state.paused = true，
 * 选完恢复（与既有 pause 语义完全一致，不新造一套暂停）。
 *
 * ── 为什么不影响挂机玩法 ────────────────────────────────
 * 五个事件的后果全是**一次性**的（一笔钱 / 一次满意度 / 一段限时 buff），
 * 不会给玩家挂上"必须持续操作"的负担：选完就结束，玩家可以继续挂机。
 * 唯一跨夜的是"网红拍摄"的 3 夜客流 buff —— 它是**正向**buff，不需要操作。
 *
 * ── 纯逻辑、零 DOM/THREE 依赖 ────────────────────────────
 * 所有副作用走注入的 api（现金 / 满意度 / 垃圾 / 提示 / 账本），
 * rng 可注入 → 可在 Node 里断言"选 A 得钱、选 B 无事"，以及概率分支的分布。
 */

import { fmtYuan } from './fmt.mjs';

/** 临期货：进货便宜 30%，但今夜未售完全部报废 */
export const SUPPLIER_DISCOUNT = 0.7;
export const SUPPLIER_BATCH = { skuId: 'noodle', qty: 12 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const numOr = (v, d = 0) => (Number.isFinite(v) ? v : d);

/**
 * 五个抉择事件。
 * apply(api, rng, state) → { text:string, ledger?:{key,label,value} }
 */
export const CHOICES = [
  {
    id: 'thief',
    title: '小偷进店',
    emoji: '🥷',
    body: '一个年轻人把两包泡面塞进了外套，正快步走向门口。',
    options: [
      {
        id: 'catch',
        label: '当场抓住',
        hint: '追回货款 ¥80 · 但有概率遭到报复',
        apply(api, rng) {
          api.earnCash(80, '追回货款');
          api.ledger('choice.thief', '抉择 · 抓住小偷', 80);
          let text = '你一把按住他的肩膀，追回了 ¥80 货款。';
          if (rng() < 0.25) {
            api.addRep(-3);
            api.addLitter(3);
            api.ledger('choice.thief', '抉择 · 抓住小偷', 0);
            text += ' 他临走时踢翻了货架 —— 满意度 -3，地上多了几件垃圾。';
          }
          return { text };
        },
      },
      {
        id: 'letgo',
        label: '装作没看见',
        hint: '无事发生',
        apply() {
          return { text: '你低下头继续理货。两包泡面而已，不值得。' };
        },
      },
    ],
  },
  {
    id: 'drunk',
    title: '醉汉闹事',
    emoji: '🍺',
    body: '一个醉醺醺的客人倒在零食架旁，嘴里嘟囔着不肯起来。',
    options: [
      {
        id: 'police',
        label: '报警驱赶',
        hint: '满意度短暂下降 · 之后自动恢复',
        apply(api) {
          api.addRep(-6);
          api.scheduleRepRestore(6, 60); // 60 游戏秒后自动补回
          api.ledger('choice.drunk', '抉择 · 报警驱赶', 0);
          return { text: '警察把他带走了。店里安静下来，但客人们明显被吓到（满意度 -6，稍后恢复）。' };
        },
      },
      {
        id: 'pay',
        label: '赔钱安抚',
        hint: '花 ¥60 保住满意度 · 满意度 +2',
        apply(api) {
          const paid = api.payCash(60, '安抚醉汉');
          if (!paid) return { text: '现金不够，只能干看着。' };
          api.addRep(2);
          api.ledger('choice.drunk', '抉择 · 赔钱安抚', -60);
          return { text: '你塞给他 ¥60 打车费，他心满意足地走了（满意度 +2）。' };
        },
      },
    ],
  },
  {
    id: 'supplier',
    title: '供应商推销临期货',
    emoji: '📦',
    body: '供货商拍着车厢：「这批泡面明天就到期，三折拿走，卖多少算多少。」',
    options: [
      {
        id: 'buy',
        label: '低价吃下',
        hint: `进价便宜 30% · 但今夜未售完全部报废`,
        apply(api) {
          const unit = Math.round(api.skuCost(SUPPLIER_BATCH.skuId) * SUPPLIER_DISCOUNT * 100) / 100;
          const total = Math.round(unit * SUPPLIER_BATCH.qty);
          const paid = api.payCash(total, '临期货');
          if (!paid) return { text: '现金不够，只能婉拒。' };
          api.addBackroom(SUPPLIER_BATCH.skuId, SUPPLIER_BATCH.qty);
          api.markExpiringTonight(SUPPLIER_BATCH.skuId, SUPPLIER_BATCH.qty, total);
          api.ledger('choice.supplier', '抉择 · 临期货进货', -total);
          return { text: `你吃下了 ${SUPPLIER_BATCH.qty} 件临期泡面（进价 ${fmtYuan(total)}）。今晚卖不完就全烂在库里。` };
        },
      },
      {
        id: 'refuse',
        label: '婉拒',
        hint: '无事发生',
        apply() {
          return { text: '你摇摇头。临期货砸手里更亏。' };
        },
      },
    ],
  },
  {
    id: 'wallet',
    title: '捡到钱包',
    emoji: '👛',
    body: '收银台下有个鼓鼓的钱包，里面露出一沓现金。四下无人。',
    options: [
      {
        id: 'return',
        label: '上交失物',
        hint: '名声提升 · 满意度 +5',
        apply(api) {
          api.addRep(5);
          api.ledger('choice.wallet', '抉择 · 上交钱包', 0);
          return { text: '你把钱包交到了服务台。失主连连道谢（满意度 +5）。' };
        },
      },
      {
        id: 'keep',
        label: '悄悄收下',
        hint: '得 ¥120 · 低概率次日被认出',
        apply(api, rng, state) {
          api.earnCash(120, '拾获现金');
          api.ledger('choice.wallet', '抉择 · 私吞钱包', 120);
          let text = '你把钱包塞进了围裙口袋（+¥120）。';
          if (rng() < 0.2) {
            api.scheduleNextNight({ rep: -8, note: '失主带着朋友来店里认出了你' });
            text += ' 但你总觉得有人在看你……';
          }
          return { text };
        },
      },
    ],
  },
  {
    id: 'influencer',
    title: '网红拍摄',
    emoji: '📸',
    body: '一个拿着补光灯的博主探进头来：「老板，拍个深夜便利店 vlog，三分钟就好！」',
    options: [
      {
        id: 'agree',
        label: '同意拍摄',
        hint: '之后 3 夜客流 +30%',
        apply(api, _rng, state) {
          api.setInfluence(3, 1.3);
          api.ledger('choice.influencer', '抉择 · 网红拍摄', 0);
          return { text: '镜头扫过货架。视频火了 —— 之后 3 夜客流 +30%。' };
        },
      },
      {
        id: 'decline',
        label: '礼貌拒绝',
        hint: '无事发生',
        apply() {
          return { text: '你指了指"请勿拍摄"的贴纸。他耸耸肩走了。' };
        },
      },
    ],
  },
];

export const CHOICE_BY_ID = Object.fromEntries(CHOICES.map((c) => [c.id, c]));

/**
 * @param {object} opts
 * @param {object} opts.state
 * @param {() => number} opts.rng
 * @param {object} opts.api 副作用出口（见文件头）
 */
export function createChoices(opts = {}) {
  const state = opts.state;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const api = opts.api ?? {};

  /** 今晚的排期：[{ id, at }]（at = 游戏小时 0..8） */
  function planForNight() {
    const n = rng() < 0.45 ? 2 : 1;
    const pool = CHOICES.slice();
    const queue = [];
    for (let i = 0; i < n && pool.length; i++) {
      const k = Math.floor(rng() * pool.length);
      const c = pool.splice(k, 1)[0];
      // 分散在 S1–S4：第一题 0.4–3h，第二题 3–7h，避免连着弹两次打断节奏
      const at = i === 0 ? 0.4 + rng() * 2.6 : 3 + rng() * 4;
      queue.push({ id: c.id, at });
    }
    queue.sort((a, b) => a.at - b.at);
    state.choiceQueue = queue;
    return queue;
  }

  /** 到点该弹的抉择（返回定义或 null） */
  function due(gameHour) {
    const q = Array.isArray(state.choiceQueue) ? state.choiceQueue : [];
    const hit = q.find((e) => !e.done && gameHour >= e.at);
    return hit ? CHOICE_BY_ID[hit.id] ?? null : null;
  }

  /** 标记已处理 */
  function markDone(id) {
    const q = Array.isArray(state.choiceQueue) ? state.choiceQueue : [];
    const e = q.find((x) => x.id === id && !x.done);
    if (e) e.done = true;
  }

  /** 还剩几个没弹 */
  function remaining() {
    return (Array.isArray(state.choiceQueue) ? state.choiceQueue : []).filter((e) => !e.done).length;
  }

  /**
   * 执行一个选项。
   * @returns { text, choiceId, optionId }
   */
  function resolve(choiceId, optionId) {
    const c = CHOICE_BY_ID[choiceId];
    if (!c) return { text: '', ok: false };
    const opt = c.options.find((o) => o.id === optionId);
    if (!opt) return { text: '', ok: false };
    let out = { text: '' };
    try {
      out = opt.apply(api, rng, state) ?? { text: '' };
    } catch {
      out = { text: '' };
    }
    markDone(choiceId);
    if (!Array.isArray(state.choiceLog)) state.choiceLog = [];
    state.choiceLog.push({ id: choiceId, option: optionId, night: state.night });
    return { ...out, ok: true, choiceId, optionId };
  }

  /** 网红 buff 是否生效；返回客流倍率 */
  function arrivalMul() {
    const until = numOr(state.influenceUntilNight, 0);
    if (until >= numOr(state.night, 1)) return numOr(state.influenceMul, 1);
    return 1;
  }

  /** 每帧推进满意度恢复计时（报警驱赶的"短暂下降"） */
  function tick(wallElapsed) {
    const list = Array.isArray(state.repRestore) ? state.repRestore : [];
    if (!list.length) return 0;
    let add = 0;
    const keep = [];
    for (const r of list) {
      if (wallElapsed >= numOr(r.at, 0)) add += numOr(r.amount, 0);
      else keep.push(r);
    }
    state.repRestore = keep;
    if (add) api.addRep?.(add);
    return add;
  }

  /** 跨夜：结算掉"次日被认出"之类的延后后果 */
  function applyPendingNight() {
    const list = Array.isArray(state.pendingNextNight) ? state.pendingNextNight : [];
    const fired = [];
    const keep = [];
    for (const p of list) {
      if (numOr(p.night, 0) <= numOr(state.night, 1)) {
        if (p.rep) api.addRep?.(p.rep);
        fired.push(p);
      } else keep.push(p);
    }
    state.pendingNextNight = keep;
    return fired;
  }

  /** 打烊时：临期货未售完的报废损失 */
  function settleExpiring(countBackroom) {
    const e = state.expiringTonight;
    if (!e || !e.skuId) return null;
    const inBox = typeof countBackroom === 'function' ? countBackroom(e.skuId) : 0;
    /* 手上那份也必须算进去：临期货卡在玩家手里、没能上成架时，它同样属于"今夜没卖掉"。
     * 只按库存箱统计会让它既不算售出也不算报废 → 凭空蒸发（数量守恒被打破）。 */
    const inHand = state.held && state.held.skuId === e.skuId ? (state.held.qty | 0) : 0;
    const left = inBox + inHand;
    const sold = Math.max(0, numOr(e.qty, 0) - left);
    // 未售完的部分按进价全额报废（进价已经是三折，所以损失不会太夸张）
    const unitCost = numOr(e.qty, 1) > 0 ? numOr(e.cost, 0) / numOr(e.qty, 1) : 0;
    const loss = Math.round(left * unitCost);
    // 两处回收口径必须分开：箱里的走 removeBackroom，手上的直接清空（它从没进过箱子的账）
    if (typeof api.removeBackroom === 'function' && inBox > 0) {
      api.removeBackroom(e.skuId, inBox);
    }
    if (inHand > 0) state.held = null;
    state.expiringTonight = null;
    return { skuId: e.skuId, qty: numOr(e.qty, 0), sold, left, loss, inBox, inHand };
  }

  return {
    planForNight, due, resolve, markDone, remaining, arrivalMul, tick,
    applyPendingNight, settleExpiring,
    /** 面板快照（HUD 用） */
    snapshot() {
      return {
        pending: remaining(),
        influence: arrivalMul() !== 1 ? { untilNight: numOr(state.influenceUntilNight, 0), mul: arrivalMul() } : null,
        log: (Array.isArray(state.choiceLog) ? state.choiceLog : []).slice(-6),
      };
    },
  };
}

export default createChoices;
