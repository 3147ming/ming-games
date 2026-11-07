/**
 * 常客剧情线（storylines）
 *
 * ── 为什么要有这一层 ────────────────────────────────────────
 * 常客系统（regulars.mjs）已经能让同一张脸跨夜累积忠诚度、拿折扣、带「熟」标，
 * 但顾客本质上仍是"数据"：每次到店就是一条固定 toast（⭐ 老周（熟客·夜猫子）来了），
 * 玩家记住的是一个名字 + 一句人设台词，而不是"这个人身上发生了什么"。
 * 本模块给 4 位常客各写一条 3 段的连续剧情，让"多来几晚"这件事本身有内容可看。
 *
 * ── 三条设计约束（改本文件前先读）─────────────────────────────
 * ① **节奏优先于效率**：一次到店最多推进一段（advanceOne 只评估当前段）。
 *    如果写成"条件满足就一路跳到最新段"，玩家买齐东西后回店，
 *    三段对白会糊在同一秒里 —— 那不是剧情，是弹窗。
 *    需求里"今天聊一句，明天推进一段"讲的就是这条，所以推进点只有一个：到店。
 * ② **结账只记账，到店才推进**：notePurchase 只累加"他买过多少"，
 *    真正的推进发生在下一次到店。结账是高频动作，把对白挂在收银瞬间
 *    会打断玩家自己的操作节奏；而"客人下次来时接着说"才像便利店里的闲聊。
 * ③ **奖励必须幂等**：entry.rewarded 记录已发过的段 id，发之前查一次。
 *    即使将来有人回滚 stage、或存档被手改成旧值，也不会二次发钱。
 *    钱直接写 state.cash（与 quests.mjs 的任务奖励同口径），
 *    刻意**不计入 state.revenue**：这是故事奖励，不是门店营收。
 *
 * ── 触发条件为什么是这几种 ──────────────────────────────────
 *   nights  —— 累计到店夜数（去重，按"夜"而不是"次"）：到店次数才是"熟"的量纲，
 *              同一夜反复刷脸不该让剧情往前跑。
 *   bought  —— 他**本人**买走某 SKU 的累计件数：用购买而不是到店，
 *              是因为很多段讲的就是"他认这一样东西"；玩家卖给他，才配听到后面的话。
 *   night   —— 绝对夜号（第 N 夜起）：有的段需要"过了几天"，比如第 2 周才肯说出口。
 *   prev    —— 前一段已完成：这一条由引擎**强制**保证（只评估当前段下标），
 *              配置里不写也不会跳段 —— 顺序性是引擎不变量，不靠数据自觉。
 *
 * ── 绑定哪张脸 ──────────────────────────────────────────────
 * 常客的名字是创建脸谱时随机抽的（见 regulars.judge），同一个名字可能落在多张脸上。
 * 这里按"首次遇到同名脸即绑定"处理：绑定后只认这张脸，其他同名脸只是同名的人。
 * 不按名字模糊推进的理由：剧情是"同一个人"的连续对话，
 * 换一张脸接着说会让"他记得上次"这件事直接崩掉。
 *
 * ── 存档与兼容 ──────────────────────────────────────────────
 * 进度存在 state.storylines（已进 save.mjs 的 STATE_FIELDS 白名单）：
 *   { chars: { [charId]: { faceId, stage, nights:[], bought:{}, rewarded:[] } } }
 * 老存档没有这个字段 → ensure() 现场补空结构，所有角色按"未开始"（stage=0）。
 * applySave 读到缺失字段时还会显式清空（见 save.mjs），避免读老档后残留上一局的剧情。
 *
 * ── 纯逻辑、零 DOM / THREE（可在 Node 单测）──────────────────
 */

import { CONSUMABLE_BY_ID, SKU_BY_ID } from './config.mjs';
import { fmtMoney } from './fmt.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOr = (v, d) => (Number.isFinite(v) ? v : d);
const intOr = (v, d) => (Number.isFinite(v) ? Math.round(v) : d);

/**
 * 4 位常客 × 3 段剧情。
 *
 * 选角与题材的口径：四个人分别对应夜班便利店里最典型的四种"夜里不睡的人"——
 * 守夜的老头、赶考的学生、加班的白领、睡不着的年轻人。
 * 他们各自的偏好商品（关东煮 / 热咖啡 / 便当 / 冰淇淋）同时就是剧情道具，
 * 于是"进什么货"和"听谁的 story"是同一条经营决策，而不是并行的两套内容。
 *
 * ⚠ name 必须取自 config.REGULARS.names（测试会断言）：
 * 剧情靠"名字"把随机脸谱认成剧中人，名字不在池子里就永远绑定不上。
 */
export const STORYLINES = [
  {
    id: 'zhou',
    name: '老周',
    emoji: '🧓',
    title: '关东煮的老汤',
    stages: [
      {
        id: 'zhou-1',
        /* 第一段只要"到过店"：第一次见面只该是打个照面，
         * 玩家不需要在这之前做任何经营动作 —— 剧情的第一句永远免费。 */
        cond: { nights: 1 },
        text: '老周把关东煮的纸杯捧了很久才走："还是这个味儿。老伴在的时候，我们俩就分这一杯。"',
      },
      {
        id: 'zhou-2',
        /* 第二段要他"真的常买关东煮"（累计 2 份）：这段讲的就是"他认这锅汤"，
         * 玩家卖给他两次，才配听到后面的话 —— 条件本身就是台词的一部分。 */
        cond: { nights: 3, bought: { oden: 2 } },
        text: '老周说年轻时他也守过夜班："夜里最难熬的不是困，是没人说话。"临走硬塞给你一袋自家腌的萝卜。',
        reward: { cash: 40 },
      },
      {
        id: 'zhou-3',
        /* 第三段放到第 2 周（night>=7）：一周之内把一个人的故事讲完太赶，
         * "下周他还来"本身就是夜班便利店的日常感。 */
        cond: { nights: 5, night: 7 },
        text: '老周带来一张褪色的合照，说想贴在收银台边上："这店有人气，我老伴喜欢热闹。"',
        /* 海报（人气海报）= 他把合照贴出去，店门口真的热闹了一点 ——
         * 奖励的形态跟剧情说的是同一件事，不做"剧情讲完再凭空发钱"。 */
        reward: { items: { poster: 1 } },
      },
    ],
  },
  {
    id: 'min',
    name: '小敏',
    emoji: '📚',
    title: '考试周的第三杯',
    stages: [
      {
        id: 'min-1',
        cond: { nights: 1 },
        text: '小敏抱着一摞真题坐下："还有三天。一杯热咖啡，不加糖，我要清醒着错。"',
      },
      {
        id: 'min-2',
        /* 靠咖啡续命的人才有的对话：所以条件是"她本人买过 3 杯热咖啡"，
         * 而不是"玩家卖过 3 杯咖啡" —— 别人买的不算，这段是她的。 */
        cond: { nights: 2, bought: { hotcoffee: 3 } },
        text: '她把同一页真题翻了三遍，忽然小声问："你说，考不上是不是也还能活？"你给她续了半杯。',
        /* 刻意**纯叙事**：她的这个问题不该用钱来回答。
         * 一条剧情线里必须留一两段"什么也不给"的，否则玩家会默认
         * 每段对白都是一个奖励触发器，只在等奖励时看剧情。 */
      },
      {
        id: 'min-3',
        /* 第 5 夜起：考试周结束的时间点，不必精确到某一天，
         * 但要跨过"考试"这个叙事节点，否则"考完了"这句话会显得突兀。 */
        cond: { nights: 4, night: 5 },
        text: '考完的小敏冲进来报喜，把剩下的零花钱全换成了热咖啡请同学："以后我也会常来的。"',
        reward: { cash: 60, tokens: 2 },
      },
    ],
  },
  {
    id: 'jie',
    name: '阿杰',
    emoji: '💼',
    title: '加班到打烊',
    stages: [
      {
        id: 'jie-1',
        /* 第一段要"第 2 次到店"：第一次他只买了就走，不熟的客人不会开口。
         * 用 nights:2 而不是 nights:1，是为了让"沉默的第一次"真的发生过 ——
         * 玩家会记得第一晚他一句话没说，第二晚才搭话。 */
        cond: { nights: 2 },
        text: '阿杰第二次来，才在等微波炉的时候开口："你们这儿几点关门？我最近总赶不上末班车。"',
      },
      {
        id: 'jie-2',
        cond: { nights: 4, bought: { bento: 2 } },
        text: '他连着几天买同一种便当："图省事。反正回家也是一个人吃。"说完自己先笑了，把一张整钞推过来，"不用找，当我预支下个月的便当。"',
        reward: { cash: 80 },
      },
      {
        id: 'jie-3',
        cond: { nights: 5, night: 7 },
        text: '阿杰换了个不用加班的岗位，特意绕路来道别："以后我早点来，买刚上架的。"',
        reward: { cash: 120, tokens: 3 },
      },
    ],
  },
  {
    id: 'wanzi',
    name: '丸子',
    emoji: '🎧',
    title: '睡不着的凌晨',
    stages: [
      {
        id: 'wanzi-1',
        cond: { nights: 1 },
        text: '丸子戴着耳机挑了半天的冰淇淋："睡不着，出来走走。你们这儿灯亮着，挺好。"',
      },
      {
        id: 'wanzi-2',
        cond: { nights: 3, bought: { icecream: 2 } },
        text: '她玩完一局抓娃娃，把多出来的代币全倒在柜台上："拿着，你们这儿的娃娃比别处好抓。"',
        /* 代币奖励跟"她在电玩区玩过"直接对上：奖励的来源在剧情里是看得见的 */
        reward: { tokens: 3 },
      },
      {
        id: 'wanzi-3',
        cond: { nights: 5, night: 7 },
        text: '丸子拖着行李箱来买最后一支冰淇淋："去外地念书了。这个留给你，别总熬夜。"她放下一瓶提神喷雾。',
        reward: { items: { energyspray: 1 } },
      },
    ],
  },
];

/** 名字 → 角色（测试 / 调试用；运行时不靠它，免得缓存配置漂移） */
export const STORYLINE_BY_ID = Object.fromEntries(STORYLINES.map((d) => [d.id, d]));

/** 单条角色进度的**唯一**结构定义：ensureEntry 补字段时也用它 */
function freshEntry() {
  return { faceId: null, stage: 0, nights: [], bought: {}, rewarded: [] };
}

/**
 * 把存档里/内存里的脏数据修成合法结构。
 *
 * 为什么每一步都兜底：state.storylines 是**跨版本**存活的数据，
 * 手改存档、旧版本写下的半截结构、配置删掉一段，都会让这里读到 undefined。
 * 剧情线坏了不该让游戏起不来，最差也只是"剧情停在原地"。
 */
function ensureEntry(raw, total) {
  if (!isObj(raw)) return freshEntry();
  const e = raw;
  e.faceId = typeof e.faceId === 'string' && e.faceId ? e.faceId : null;
  /* 上钳到段数：配置改短（或存档来自内容更多的版本）时，
   * stage 若大于段数，后面读 def.stages[stage] 会拿到 undefined。 */
  e.stage = Math.max(0, Math.min(intOr(e.stage, 0), total));
  e.nights = Array.isArray(e.nights) ? e.nights.filter((n) => Number.isFinite(n)) : [];
  e.bought = isObj(e.bought) ? e.bought : {};
  e.rewarded = Array.isArray(e.rewarded) ? e.rewarded.filter((x) => typeof x === 'string') : [];
  return e;
}

/**
 * 触发条件的可读文案（HUD / 手机面板 / 探针展示用）。
 * 放在这里而不是 HUD：条件字段的语义属于本模块，HUD 只该拿字符串。
 */
export function condText(cond) {
  if (!isObj(cond)) return '';
  const parts = [];
  if (Number.isFinite(cond.nights)) parts.push(`到店 ${cond.nights} 夜`);
  if (isObj(cond.bought)) {
    for (const [sku, need] of Object.entries(cond.bought)) {
      parts.push(`买过 ${SKU_BY_ID[sku]?.name ?? sku} ${need} 份`);
    }
  }
  if (Number.isFinite(cond.night)) parts.push(`第 ${cond.night} 夜起`);
  return parts.join(' · ');
}

/**
 * @param opts.state   state.mjs 单一真源（读写 state.storylines / cash / tokens / inventory）
 * @param opts.onEvent (type, payload) —— 'story-stage' | 'story-done'，表现层自己决定怎么播
 * @param opts.defs    剧情定义（默认 STORYLINES；测试可注入缩短版）
 */
export function createStorylines(opts = {}) {
  const state = opts.state ?? {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const defs = Array.isArray(opts.defs) && opts.defs.length ? opts.defs : STORYLINES;

  /** 补全 state.storylines 的结构并返回（幂等；每次读写前调用，老存档自然兼容） */
  function ensure() {
    if (!isObj(state.storylines)) state.storylines = {};
    const box = state.storylines;
    if (!isObj(box.chars)) box.chars = {};
    for (const def of defs) {
      box.chars[def.id] = ensureEntry(box.chars[def.id], def.stages.length);
    }
    return box;
  }

  function entryOf(charId) {
    const box = ensure();
    return box.chars[charId] ?? null;
  }

  /**
   * 条件判定（全部满足才是满足）。
   *
   * 刻意**没有**"段没写条件 = 直接通过"的兜底：缺条件是配置写错了，
   * 静默放行会让一段剧情在玩家什么也没做的时候就播出来，且很难复现。
   * 宁可不推进，也不要"剧情自己往前走"。
   */
  function met(stage, e, night) {
    const c = stage?.cond;
    if (!isObj(c)) return false;
    if (Number.isFinite(c.nights) && e.nights.length < c.nights) return false;
    if (Number.isFinite(c.night) && night < c.night) return false;
    if (isObj(c.bought)) {
      for (const [sku, need] of Object.entries(c.bought)) {
        if ((e.bought[sku] | 0) < need) return false;
      }
    }
    return true;
  }

  /** 把奖励写进 state；已发过就返回 null（幂等，见文件头约束③） */
  function grant(stage, e) {
    const r = stage.reward;
    if (!isObj(r)) return null;
    if (e.rewarded.includes(stage.id)) return null;
    const got = { cash: 0, tokens: 0, items: {} };
    const cash = Math.max(0, intOr(r.cash, 0));
    const tokens = Math.max(0, intOr(r.tokens, 0));
    if (cash) {
      state.cash = numOr(state.cash, 0) + cash;
      got.cash = cash;
    }
    if (tokens) {
      state.tokens = numOr(state.tokens, 0) + tokens;
      got.tokens = tokens;
    }
    if (isObj(r.items)) {
      if (!isObj(state.inventory)) state.inventory = {};
      for (const [id, qty] of Object.entries(r.items)) {
        const n = Math.max(0, intOr(qty, 0));
        if (!n) continue;
        state.inventory[id] = (state.inventory[id] | 0) + n;
        got.items[id] = n;
      }
    }
    e.rewarded.push(stage.id);
    return got;
  }

  /** 奖励文案：由本模块产出，HUD 只负责 toast（避免每个调用点各拼一遍） */
  function rewardText(got) {
    if (!got) return '';
    const parts = [];
    if (got.cash) parts.push(fmtMoney(got.cash));
    if (got.tokens) parts.push(`代币 ×${got.tokens}`);
    for (const [id, n] of Object.entries(got.items)) {
      parts.push(`${CONSUMABLE_BY_ID[id]?.name ?? id} ×${n}`);
    }
    return parts.length ? `🎁 剧情奖励 · ${parts.join(' / ')}` : '';
  }

  /**
   * 推进一段（只评估**当前**段下标 → 顺序性由引擎保证，而不是靠数据自觉）。
   * @returns payload | null
   */
  function advanceOne(def, e, night) {
    const idx = e.stage | 0;
    if (idx >= def.stages.length) return null;      // 已走完
    const stage = def.stages[idx];
    if (!met(stage, e, night)) return null;
    e.stage = idx + 1;
    const got = grant(stage, e);
    const payload = {
      charId: def.id,
      name: def.name,
      emoji: def.emoji,
      title: def.title,
      stage: e.stage,
      total: def.stages.length,
      stageId: stage.id,
      text: stage.text,
      reward: got,
      rewardText: rewardText(got),
      done: e.stage >= def.stages.length,
    };
    onEvent('story-stage', payload);
    if (payload.done) onEvent('story-done', payload);
    return payload;
  }

  /**
   * 顾客到店时调用（main 在 regularJudge 里接）。
   *
   * @param info.faceId 稳定脸谱 id
   * @param info.name   该脸的名字（来自 regulars.judge）—— 用来把随机脸认成剧中人
   * @param info.night  当前绝对夜号（缺省读 state.night）
   * @returns 本次推进的段数组（可能为空；一次到店每个角色最多推进一段）
   */
  function noteArrival(info = {}) {
    const faceId = typeof info.faceId === 'string' && info.faceId ? info.faceId : null;
    if (!faceId) return [];
    const night = numOr(info.night, numOr(state.night, 1));
    const name = typeof info.name === 'string' ? info.name : '';
    const box = ensure();

    /* 先查这张脸是不是已经被某位角色认领 —— 一张脸只能是一个人，
     * 否则同一句"我今天……”会被两个角色各说一遍。 */
    let claimedId = null;
    for (const def of defs) {
      if (box.chars[def.id].faceId === faceId) { claimedId = def.id; break; }
    }

    const advanced = [];
    for (const def of defs) {
      const e = box.chars[def.id];
      if (e.faceId == null) {
        // 未绑定：只在"名字对得上、且这张脸没被别的角色认领"时才认人
        if (claimedId && claimedId !== def.id) continue;
        if (!name || name !== def.name) continue;
        e.faceId = faceId;
        claimedId = def.id;
      } else if (e.faceId !== faceId) {
        continue;
      }
      /* 到店夜数按**夜**去重：同一夜反复刷脸不该让剧情往前跑。
       * 这也顺带保证了"重打本夜"（P0-7 的夜初快照）不会重复推进。 */
      if (!e.nights.includes(night)) e.nights.push(night);
      const res = advanceOne(def, e, night);
      if (res) advanced.push(res);
    }
    return advanced;
  }

  /**
   * 结账时调用：只记账，**不推进**（见文件头约束②）。
   * @returns { charId, skuId, count } | null —— 买的这张脸不是剧中人时返回 null
   */
  function notePurchase(faceId, skuId, qty = 1) {
    if (typeof faceId !== 'string' || !faceId) return null;
    if (typeof skuId !== 'string' || !skuId) return null;
    const n = Math.max(0, intOr(qty, 0));
    if (!n) return null;
    const box = ensure();
    for (const def of defs) {
      const e = box.chars[def.id];
      if (e.faceId !== faceId) continue;
      e.bought[skuId] = (e.bought[skuId] | 0) + n;
      return { charId: def.id, skuId, count: e.bought[skuId] };
    }
    return null;
  }

  /** 某位角色的进度视图（手机面板 / 探针用）；未开始的角色也返回 stage=0 */
  function progressOf(charId) {
    const def = defs.find((d) => d.id === charId);
    if (!def) return null;
    const e = entryOf(charId);
    const next = def.stages[e.stage] ?? null;
    return {
      id: def.id,
      name: def.name,
      emoji: def.emoji,
      title: def.title,
      stage: e.stage,
      total: def.stages.length,
      done: e.stage >= def.stages.length,
      faceId: e.faceId,
      nights: e.nights.length,
      bought: { ...e.bought },
      rewarded: [...e.rewarded],
      next: next ? { id: next.id, cond: next.cond, condText: condText(next.cond), text: next.text } : null,
    };
  }

  /** 全部角色的一览（HUD / 结算面板 / 探针；纯数据，可 JSON 化） */
  function snapshot() {
    const chars = defs.map((d) => progressOf(d.id)).filter(Boolean);
    return {
      total: chars.length,
      done: chars.filter((c) => c.done).length,
      chars,
    };
  }

  return { ensure, noteArrival, notePurchase, progressOf, snapshot, condText };
}
