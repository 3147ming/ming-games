/**
 * 前台手机系统（需求：按 O 打开）—— 点评 APP / 跑腿接单 / 消息箱
 *
 * ── 纯逻辑、零 THREE / DOM（ADR-002）────────────────────
 * 本模块只负责数据与判定，旧屏风格 UI 在 hud.mjs 的 openPhone 里渲染。
 * 所有状态存进 state（见下方字段），由 save.mjs 白名单统一持久化。
 *
 * ── 点评为什么用"累计值差分"而不是埋点 ──────────────────
 * 成交发生在 economy.checkout()，失销分散在 economy 的售罄分支与
 * customers.loseCustomer() 两处。若在这三处埋"记一条点评"的钩子，
 * 就要改两个核心模块，且漏埋处会静默不计数 —— 这正是 quests.mjs
 * 文件头点名要避免的坑。所以这里沿用它的口径：phone.update 每帧对比
 * state.served / state.lostSales 的增量，增了几笔就补几条点评，
 * 零埋点、不碰 economy / customers 的任何一行（只加不改）。
 *
 * ── 跑腿 = 纯计时订单（不做"离开店铺"）──────────────────
 * 原需求只说"跑腿接单赚外快"。真做成"玩家走到店外送货"会动到玩家移动 /
 * 场景寻路这一整条老链路，风险大、收益低。所以做成接了之后倒计时、
 * 到点自动到账的纯计时订单：代价由"每夜接单上限 + 奖励与门店营收解耦"
 * 体现（奖励直接 state.cash +=，不计 revenue / earned，与 quests.complete 同口径）。
 *
 * ── 差评 → 补救任务（给玩家一个救口碑的出口）────────────
 * 累计未补救差评（badReviewStreak，跨夜累积）达到阈值触发补救任务：
 * 再接待 N 位顾客即完成，回补口碑 + 现金，并清零差评标记。
 */
import { PHONE } from './config.mjs';
import { fmtYuan, fmtYuanSigned } from './fmt.mjs';

const numOr = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let seq = 0;

/** 点评文案池（好 / 中 / 差）。程序化生成，不引外部资源（ADR-004）。 */
const REVIEW_TEXT = {
  good: [
    '店员很热情，下次还来',
    '东西新鲜，价格公道',
    '凌晨能买到热乎的，太暖了',
    '老板人超好，五星好评',
    '干净又安静，加班后的小确幸',
    '货架摆得整整齐齐，舒服',
  ],
  mid: [
    '还行，就是结账慢了点',
    '东西一般，胜在方便',
    '能买到就行，不挑剔',
    '中规中矩，下次看看再说',
  ],
  bad: [
    '等太久了，差评',
    '想买的没货了',
    '店员态度有点冷漠',
    '店里有点乱',
    '价格比别家贵',
    '体验很差，不会再来',
  ],
};

/** 好评 / 中评 / 差评 → 展示 emoji（HUD 消费） */
export const RATING_EMOJI = { good: '😊', mid: '😐', bad: '😡' };

/**
 * @param opts.state   state.mjs 单一真源（需已含 phone 字段，见 state.mjs）
 * @param opts.rng     () => number 随机源（测试注入）
 * @param opts.onEvent (type, payload) —— 'review-bad' | 'errand-done' |
 *                     'remedy-new' | 'remedy-done' | 'errand-accept'
 */
export function createPhone(opts = {}) {
  const state = opts.state;
  const rnd = opts.rng ?? Math.random;
  const onEvent = opts.onEvent ?? (() => {});

  /** 差分基线：上次 update 看到的累计值（成交/失销各一份） */
  let lastServed = numOr(state.served, 0);
  let lastLostSales = numOr(state.lostSales, 0);

  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  /** 按口碑分档抽取评级：高口碑更易好评，低口碑更易差评 */
  function ratingForRep() {
    const rep = numOr(state.reputation, 50);
    const table = PHONE.ratingByRep;
    let tier = table[1]; // 中口碑
    if (rep >= PHONE.goodRepThreshold) tier = table[0];
    else if (rep < 45) tier = table[2];
    const r = rnd();
    if (r < tier.good) return 'good';
    if (r < tier.good + tier.mid) return 'mid';
    return 'bad';
  }

  function pushInbox(text, type) {
    const msg = {
      id: `M${++seq}`, night: state.night, time: state.gameHour,
      text, type, read: false,
    };
    state.inbox.push(msg);
    if (state.inbox.length > PHONE.inboxMax) state.inbox.splice(0, state.inbox.length - PHONE.inboxMax);
    return msg;
  }

  /** 记一条点评；差评会累积 badReviewStreak 并可能触发补救任务 */
  function pushReview(rating, kind) {
    const review = {
      id: `R${++seq}`,
      night: state.night,
      time: state.gameHour,
      rating,
      kind, // 'sale' 成交后点评 | 'lost' 失销差评
      text: pick(REVIEW_TEXT[rating]),
    };
    state.reviews.push(review);
    if (state.reviews.length > PHONE.reviewsMax) {
      state.reviews.splice(0, state.reviews.length - PHONE.reviewsMax);
    }
    if (rating === 'bad') {
      state.badReviewStreak += 1;
      onEvent('review-bad', { review });
    } else {
      onEvent('review', { review });
    }
    maybeTriggerRemedy();
    return review;
  }

  /** 差评累积到阈值 → 触发补救任务（已有任务时不重复触发） */
  function maybeTriggerRemedy() {
    if (state.remedy) return;
    if ((state.badReviewStreak | 0) < PHONE.badReviewThreshold) return;
    state.remedy = {
      id: `RM${++seq}`,
      metric: 'served',
      goal: PHONE.remedy.goal,
      baseline: state.served,
      progress: 0,
      reward: { rep: PHONE.remedy.rewardRep, cash: PHONE.remedy.rewardCash },
    };
    pushInbox(`😡 差评累积，触发补救任务：再接待 ${PHONE.remedy.goal} 位顾客`, 'remedy');
    onEvent('remedy-new', { remedy: state.remedy });
  }

  /**
   * 每帧推进（传**游戏**秒，暂停时 main 不调用）。
   * @param ctx { served, lostSales } 累计快照（由 main 传 state.served / state.lostSales）
   * @returns 本帧发生的事件数组（供测试断言；UI 提示走 onEvent 同步回调）
   */
  function update(dt, ctx = {}) {
    const served = numOr(ctx.served, state.served);
    const lost = numOr(ctx.lostSales, state.lostSales);

    /* 跨夜清零导致累计回退：重置基线，绝不把"回退"当成负成交/负失销 */
    if (served < lastServed || lost < lastLostSales) {
      lastServed = served;
      lastLostSales = lost;
    }

    const nServed = Math.max(0, served - lastServed);
    const nLost = Math.max(0, lost - lastLostSales);
    lastServed = served;
    lastLostSales = lost;

    const events = [];
    for (let i = 0; i < nServed; i++) {
      const rating = ratingForRep();
      const review = pushReview(rating, 'sale');
      events.push({ type: 'review', rating, review });
    }
    for (let i = 0; i < nLost; i++) {
      const review = pushReview('bad', 'lost');
      events.push({ type: 'review', rating: 'bad', review });
    }

    /* 跑腿订单倒计时 */
    if (state.errand && state.errand.state === 'active') {
      const e = state.errand;
      e.left = Math.max(0, e.left - (dt > 0 ? dt : 0));
      if (e.left <= 0) {
        e.state = 'done';
        state.cash += e.reward;
        state.errand = null;
        state.errandsDoneTonight += 1;
        pushInbox(`🛵 跑腿完成 · ${fmtYuanSigned(e.reward)}`, 'errand');
        events.push({ type: 'errand-done', reward: e.reward });
        onEvent('errand-done', { reward: e.reward });
      }
    }

    /* 补救任务推进（served 差分） */
    if (state.remedy) {
      const rm = state.remedy;
      rm.progress = Math.max(0, state.served - numOr(rm.baseline, 0));
      if (rm.progress >= rm.goal) {
        const rep = rm.reward.rep;
        const cash = rm.reward.cash;
        state.reputation = clamp(state.reputation + rep, 0, 100);
        state.cash += cash;
        state.badReviewStreak = 0;
        state.remedy = null;
        pushInbox(`💚 补救任务完成 · 口碑 +${rep} · ${fmtYuanSigned(cash)}`, 'remedy');
        events.push({ type: 'remedy-done', rep, cash });
        onEvent('remedy-done', { rep, cash });
      }
    }

    return events;
  }

  /** 接一单跑腿（每夜上限 / 同时只一单） */
  function acceptErrand() {
    if (state.errand) return { ok: false, reason: '已有进行中的跑腿单' };
    if ((state.errandsDoneTonight | 0) >= PHONE.errandMaxPerNight) {
      return { ok: false, reason: '今晚的跑腿单接满了' };
    }
    const kind = pick(PHONE.errands);
    const errand = {
      id: `E${++seq}`,
      kindId: kind.id,
      label: kind.label,
      emoji: kind.emoji,
      desc: kind.desc,
      reward: kind.reward,
      total: kind.sec,
      left: kind.sec,
      state: 'active',
    };
    state.errand = errand;
    pushInbox(`🛵 接了「${kind.label}」· ${kind.sec} 秒后到账 ${fmtYuan(kind.reward)}`, 'errand');
    onEvent('errand-accept', { errand });
    return { ok: true, errand };
  }

  function markAllRead() {
    for (const m of state.inbox) m.read = true;
  }

  function unread() {
    return state.inbox.filter((m) => !m.read).length;
  }

  /* ---- 视图方法（HUD 只读消费） ---- */
  const reviews = () => state.reviews.slice().reverse(); // 最新在前
  const inbox = () => state.inbox.slice().reverse();
  const errand = () => state.errand;
  const remedy = () => (state.remedy ? {
    ...state.remedy,
    ratio: Math.max(0, Math.min(1, state.remedy.goal > 0 ? state.remedy.progress / state.remedy.goal : 0)),
  } : null);
  const badReviewStreak = () => (state.badReviewStreak | 0);
  const errandsDone = () => (state.errandsDoneTonight | 0);

  /** 跨夜 / 读档后重置差分基线（避免把上一夜的累计带进新夜） */
  function reset() {
    lastServed = numOr(state.served, 0);
    lastLostSales = numOr(state.lostSales, 0);
  }

  return {
    update, acceptErrand, markAllRead, unread,
    reviews, inbox, errand, remedy, badReviewStreak, errandsDone, reset,
    get current() { return state; },
  };
}
