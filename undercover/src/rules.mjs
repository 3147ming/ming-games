/* =============================================================================
 * undercover/src/rules.mjs —— 谁是卧底 · 规则引擎
 * -----------------------------------------------------------------------------
 * 玩法（线下「谁是卧底」四人版简化）：
 *   1. 发词：抽一组「平民词 / 卧底词」。平民拿平民词，卧底拿相近但不同的
 *      卧底词。**卧底自己也不知道自己是卧底**（只看得到自己的词），
 *      只能从别人的描述里猜 —— 这正是这游戏最好玩的地方。
 *   2. 描述轮：按座位顺序，每人提交一句描述（不许直接说出自己的词）。
 *   3. 投票轮：每人投一票，指认「谁是卧底」（不能投自己）。
 *   4. 结算：得票最高者出局（平票则无人出局），出局者的身份当场公开。
 *   5. 胜负：卧底全被投出 → 平民胜；存活卧底数 ≥ 存活平民数 → 卧底胜；
 *      否则开下一轮。
 *
 * -----------------------------------------------------------------------------
 * 三个关键设计
 *
 * A. 一切状态变化都是「动作」
 *    pub（公开局面）完全由动作序列折叠得到。
 *    房主把每个动作写进 actions，状态用 reduce 增量推进；
 *    校验摘要时用 replay 从头折叠一遍 —— 两条路走同一个 applyAction，
 *    结果必然一致。
 *    如果让「结算」作为隐式推导（房主算完直接改状态），重放路径就少了一步，
 *    两端很容易分叉 —— 这个坑在 UNO 上踩过一次（本地路径与重放路径语义不同）。
 *
 * B. 私密信息绝不进动作，也绝不进广播
 *    卧底身份一旦泄漏游戏直接结束。所以：
 *      · 词与身份只存在于**房主的内存**里，不进 actions、不进 pub、不进 seed；
 *      · 加入方只通过一条独立通道消息拿到「你自己的那个词 + 中性提示」；
 *      · 加入方就算拿到全部动作序列，也推不出别人的词
 *        （动作里根本没有这个词）。
 *    注意：加入方**不会**被告知「你是不是卧底」—— 线下玩法也是如此，
 *      自己那张不一样的词就是唯一的线索。
 *
 * C. 投票在结算前不公开
 *    pub.votes 里确实存着票，但界面只在结算阶段展示 ——
 *    否则先投的人能通过别人的票反推信息。
 * ========================================================================== */

/* =============================================================================
 * 词库：每组是「平民词 / 卧底词」+ 共用中性提示 + 各自的关键词
 * ========================================================================== */
export const WORD_PAIRS = [
  { a: '火锅', b: '麻辣烫', hint: '冬天来一份，暖到胃里', ka: ['锅'], kb: ['烫'] },
  { a: '咖啡', b: '奶茶', hint: '打工人的续命水', ka: ['咖'], kb: ['茶'] },
  { a: '篮球', b: '排球', hint: '室内进行的球类对抗', ka: ['篮'], kb: ['网'] },
  { a: '米饭', b: '面条', hint: '食堂永远有的主食', ka: ['米'], kb: ['面'] },
  { a: '地铁', b: '公交车', hint: '上下班挤的那个', ka: ['铁'], kb: ['交'] },
  { a: '医生', b: '护士', hint: '医院里穿白大褂的', ka: ['医'], kb: ['护'] },
  { a: '西瓜', b: '哈密瓜', hint: '夏天切开很甜的水果', ka: ['瓜'], kb: ['密'] },
  { a: '沙发', b: '床', hint: '回家就躺着的家具', ka: ['沙'], kb: ['床'] },
  { a: '雨伞', b: '帽子', hint: '下雨天出门戴的', ka: ['伞'], kb: ['帽'] },
  { a: '钢琴', b: '电子琴', hint: '按下去会响的乐器', ka: ['钢'], kb: ['键'] },
  { a: '游泳', b: '潜水', hint: '都要泡在水里的运动', ka: ['游'], kb: ['潜'] },
  { a: '日记', b: '博客', hint: '写下来的东西', ka: ['记'], kb: ['博'] },
  { a: '躺椅', b: '办公椅', hint: '坐久了会腰疼的那种', ka: ['躺'], kb: ['办'] },
  { a: '风筝', b: '气球', hint: '会飘上天的东西', ka: ['筝'], kb: ['球'] },
  { a: '麻辣香锅', b: '水煮鱼', hint: '川菜里的重口味', ka: ['锅'], kb: ['鱼'] },
  { a: '快递', b: '外卖', hint: '不用出门就能收到的东西', ka: ['递'], kb: ['卖'] },
  { a: '图书馆', b: '书店', hint: '有很多书可以看的地方', ka: ['馆'], kb: ['店'] },
  { a: '镜子', b: '玻璃', hint: '能照出你的东西', ka: ['镜'], kb: ['璃'] },
  { a: '雪山', b: '岩浆', hint: '地质课本上的插图', ka: ['雪'], kb: ['浆'] },
  { a: '口罩', b: '围巾', hint: '冬天出门戴的', ka: ['罩'], kb: ['巾'] },
  { a: '地铁站', b: '火车站', hint: '出门换乘的地方', ka: ['铁'], kb: ['火'] },
  { a: '奶茶店', b: '咖啡馆', hint: '写作业爱去的地方', ka: ['奶'], kb: ['馆'] },
  { a: '西瓜刀', b: '水果刀', hint: '厨房里的小工具', ka: ['瓜'], kb: ['果'] },
  { a: '快递员', b: '外卖员', hint: '风里来雨里去的职业', ka: ['递'], kb: ['卖'] },
  { a: '钢琴家', b: '演奏家', hint: '以演出为生的人', ka: ['钢'], kb: ['奏'] },
];

/* =============================================================================
 * 常量
 * ========================================================================== */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const CIVILIAN = 'civilian';
export const UNDERCOVER = 'undercover';

export const PHASE = {
  DESCRIBE: 'describe',
  VOTE: 'vote',
  RESOLVE: 'resolve',
  OVER: 'over',
};

/* =============================================================================
 * 可复现随机数
 * ========================================================================== */
export function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位散列，用来把 (seed, 座位, 轮次) 变成稳定的随机数。 */
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* =============================================================================
 * 发词（只在房主侧调用；结果绝不进动作序列，也绝不广播）
 * ========================================================================== */

/**
 * 抽词并分配身份。
 * @param {number} seed
 * @param {number} n 玩家数
 * @returns {{words:string[], roles:string[], pair:object, pairIndex:number, spyCount:number}}
 */
export function deal(seed, n) {
  const count = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n | 0));
  const rnd = mulberry32(seed >>> 0);
  const pairIndex = Math.floor(rnd() * WORD_PAIRS.length) % WORD_PAIRS.length;
  const pair = WORD_PAIRS[pairIndex];
  /* 卧底数量：5~6 人 2 个，其余 1 个（经典比例大致 1/4） */
  const spyCount = count >= 5 ? 2 : 1;

  const roles = new Array(count).fill(CIVILIAN);
  const words = new Array(count).fill(pair.a);
  const seats = [];
  for (let i = 0; i < count; i++) seats.push(i);
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = seats[i]; seats[i] = seats[j]; seats[j] = t;
  }
  for (let i = 0; i < spyCount; i++) {
    const seat = seats[i];
    roles[seat] = UNDERCOVER;
    words[seat] = pair.b;
  }
  return { words, roles, pair, pairIndex, spyCount };
}

/* =============================================================================
 * 公开局面
 * ========================================================================== */

/** 默认座位名。 */
export function defaultNames(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push('玩家 ' + (i + 1));
  return out;
}

/**
 * 开一局的公开局面（全员在场、还没开始）。
 *
 * @param {number} n 玩家数
 * @param {object} [opt]
 * @param {string[]} [opt.names] 座位名（公开）
 * @param {boolean[]} [opt.ai] 哪些座位是 AI（公开 —— 大家知道谁是电脑）
 * @param {number} [opt.spyCount] 卧底数量（公开 —— 4 人 1 卧底大家都知道）
 */
export function initPub(n, opt) {
  const o = opt || {};
  const count = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n | 0));
  return {
    n: count,
    names: o.names ? o.names.slice(0, count) : defaultNames(count),
    ai: o.ai ? o.ai.slice(0, count) : new Array(count).fill(false),
    spyCount: o.spyCount || 1,
    round: 0,
    phase: PHASE.DESCRIBE,
    turnSeat: 0,
    descs: [],
    votes: {},
    alive: new Array(count).fill(true),
    eliminated: [],
    reveals: {},
    lastElim: -1,
    winner: null,
  };
}

/** 从某个座位起，找下一个还活着的人；找不到返回 -1。 */
export function nextAlive(pub, from) {
  const n = pub.n;
  for (let step = 1; step <= n; step++) {
    const seat = (from + step) % n;
    if (pub.alive[seat]) return seat;
  }
  return -1;
}

/**
 * 从某个座位起，找下一个「还活着且本轮还没行动」的人；找不到返回 -1。
 *
 * 注意不能用 nextAlive —— 那个只看「是否出局」。
 * 描述轮里，人虽然还活着，但可能已经说过话了，得跳过。
 * （这个坑踩过一次：描述阶段用 nextAlive，导致第一个人说完
 *   turnSeat 又绕回自己，永远轮不到第二个人。）
 */
export function nextPending(pub, from, done) {
  const n = pub.n;
  for (let step = 1; step <= n; step++) {
    const seat = (from + step) % n;
    if (pub.alive[seat] && !(done && done[seat])) return seat;
  }
  return -1;
}

/** 第一个还活着的人（阶段切换后从这里重新开始）。 */
export function firstAlive(pub) {
  for (let i = 0; i < pub.n; i++) if (pub.alive[i]) return i;
  return -1;
}

/**
 * 应用一个动作 —— 公开局面的**唯一**变更入口。
 * @param {object} pub
 * @param {object} act
 * @returns {{ok:boolean, pub:object, reason?:string}}
 */
export function applyAction(pub, act) {
  if (!act) return { ok: false, pub, reason: '空动作' };
  if (pub.phase === PHASE.OVER) return { ok: false, pub, reason: '这局已经结束了' };

  switch (act.act) {
    case 'round': {
      const round = Number(act.n);
      if (!Number.isInteger(round) || round < 1) return { ok: false, pub, reason: '轮次不合法' };
      /* 轮次必须严格 +1 —— 不能跳号 */
      if (round !== pub.round + 1) return { ok: false, pub, reason: '轮次跳号了' };
      /* 第一轮随时可开；之后必须在结算阶段开 */
      if (pub.round > 0 && pub.phase !== PHASE.RESOLVE) {
        return { ok: false, pub, reason: '现在不能开新一轮' };
      }
      return {
        ok: true,
        pub: Object.assign({}, pub, {
          round,
          phase: PHASE.DESCRIBE,
          turnSeat: firstAlive(pub),
          descs: [],
          votes: {},
          lastElim: -1,
        }),
      };
    }

    case 'desc': {
      if (pub.phase !== PHASE.DESCRIBE) return { ok: false, pub, reason: '现在不是描述阶段' };
      const p = act.p;
      if (!Number.isInteger(p) || p < 0 || p >= pub.n) return { ok: false, pub, reason: '座位不合法' };
      if (!pub.alive[p]) return { ok: false, pub, reason: '你已经出局了' };
      if (pub.turnSeat !== p) return { ok: false, pub, reason: '还没轮到你描述' };
      if ((pub.descs || []).some((d) => d.p === p)) return { ok: false, pub, reason: '这轮你已经描述过了' };
      const text = String(act.text || '').trim();
      if (!text) return { ok: false, pub, reason: '描述不能为空' };
      if (text.length > 60) return { ok: false, pub, reason: '描述太长了（60 字以内）' };
      const descs = pub.descs.concat([{ p, text }]);
      const done = {};
      for (const d of descs) done[d.p] = true;
      const nx = nextPending(pub, p, done);
      if (nx < 0) {
        /* 全员描述完 → 进入投票阶段，从第一个活着的人开始 */
        return { ok: true, pub: Object.assign({}, pub, { descs, phase: PHASE.VOTE, turnSeat: firstAlive(pub) }) };
      }
      return { ok: true, pub: Object.assign({}, pub, { descs, turnSeat: nx }) };
    }

    case 'vote': {
      if (pub.phase !== PHASE.VOTE) return { ok: false, pub, reason: '现在不是投票阶段' };
      const p = act.p;
      if (!Number.isInteger(p) || p < 0 || p >= pub.n) return { ok: false, pub, reason: '座位不合法' };
      if (!pub.alive[p]) return { ok: false, pub, reason: '你已经出局了' };
      if (pub.turnSeat !== p) return { ok: false, pub, reason: '还没轮到你投票' };
      if (pub.votes[p] !== undefined) return { ok: false, pub, reason: '你已经投过了' };
      const target = act.target;
      if (!Number.isInteger(target) || target < 0 || target >= pub.n) {
        return { ok: false, pub, reason: '投票对象不合法' };
      }
      if (target === p) return { ok: false, pub, reason: '不能投自己' };
      if (!pub.alive[target]) return { ok: false, pub, reason: '不能投已出局的人' };
      const votes = Object.assign({}, pub.votes);
      votes[p] = target;
      const done = {};
      for (const k of Object.keys(votes)) done[k] = true;
      const nx = nextPending(pub, p, done);
      if (nx < 0) {
        return { ok: true, pub: Object.assign({}, pub, { votes, phase: PHASE.RESOLVE }) };
      }
      return { ok: true, pub: Object.assign({}, pub, { votes, turnSeat: nx }) };
    }

    case 'eliminate': {
      if (pub.phase !== PHASE.RESOLVE) return { ok: false, pub, reason: '现在不是结算阶段' };
      const seat = act.seat;
      if (seat === -1) {
        /* 平票：无人出局 */
        return { ok: true, pub: Object.assign({}, pub, { lastElim: -1 }) };
      }
      if (!Number.isInteger(seat) || seat < 0 || seat >= pub.n) return { ok: false, pub, reason: '座位不合法' };
      if (!pub.alive[seat]) return { ok: false, pub, reason: '这个人已经出局了' };
      const alive = pub.alive.slice();
      alive[seat] = false;
      const eliminated = pub.eliminated.concat([seat]);
      /* 出局者的身份当场公开 —— 这是公开信息（不是泄漏）。 */
      const reveals = Object.assign({}, pub.reveals);
      if (act.role === CIVILIAN || act.role === UNDERCOVER) reveals[seat] = act.role;
      return {
        ok: true,
        pub: Object.assign({}, pub, { alive, eliminated, reveals, lastElim: seat }),
      };
    }

    case 'win': {
      const who = act.who;
      if (who !== CIVILIAN && who !== UNDERCOVER) return { ok: false, pub, reason: '胜负方不合法' };
      return { ok: true, pub: Object.assign({}, pub, { phase: PHASE.OVER, winner: who }) };
    }

    default:
      return { ok: false, pub, reason: '未知动作：' + act.act };
  }
}

/**
 * 投票计票：得票最高者出局（多人局平票则无人出局）。
 * 纯函数，两端各自算结果一致 —— 但**结果仍由房主以动作形式广播**，
 * 这样重放路径不需要任何「隐式推导」。
 * @returns {number} 出局座位；-1 表示平票/无人出局
 */
export function tally(pub) {
  const counts = new Array(pub.n).fill(0);
  let any = false;
  for (const k of Object.keys(pub.votes || {})) {
    /* 出局者的票不作数（正常流程下不会发生，但重放时不能依赖这个假设） */
    if (!pub.alive[k]) continue;
    const t = pub.votes[k];
    if (Number.isInteger(t) && pub.alive[t]) { counts[t] += 1; any = true; }
  }
  if (!any) return -1;
  let best = -1;
  let bestCount = 0;
  let tie = false;
  for (let i = 0; i < counts.length; i++) {
    if (!pub.alive[i]) continue;
    if (counts[i] > bestCount) { best = i; bestCount = counts[i]; tie = false; }
    else if (counts[i] === bestCount && bestCount > 0) { tie = true; }
  }
  if (tie || best < 0) return -1;
  return best;
}

/**
 * 判定胜负（需要私密身份数组，所以只在房主侧调用；结论以动作广播）。
 * @returns {{winner:string|null, aliveSpy:number, aliveCivil:number}}
 */
export function judge(pub, roles) {
  const c = aliveCounts(pub, roles);
  if (c.aliveSpy === 0) return { winner: CIVILIAN, aliveSpy: c.aliveSpy, aliveCivil: c.aliveCivil };
  if (c.aliveSpy >= c.aliveCivil) return { winner: UNDERCOVER, aliveSpy: c.aliveSpy, aliveCivil: c.aliveCivil };
  return { winner: null, aliveSpy: c.aliveSpy, aliveCivil: c.aliveCivil };
}

/** 存活人数统计（公开信息：出局者身份在结算时已公开）。 */
export function aliveCounts(pub, roles) {
  let aliveSpy = 0;
  let aliveCivil = 0;
  for (let i = 0; i < pub.n; i++) {
    if (!pub.alive[i]) continue;
    if (roles[i] === UNDERCOVER) aliveSpy += 1;
    else aliveCivil += 1;
  }
  return { aliveSpy, aliveCivil };
}

/* =============================================================================
 * 重放与摘要
 * ========================================================================== */

/**
 * 把动作序列折叠成公开局面。
 * 非法动作直接跳过（不能让整局卡死）。
 */
export function fold(base, actions) {
  let pub = initPub(base.n, base);
  for (const act of actions || []) {
    const r = applyAction(pub, act);
    if (r.ok) pub = r.pub;
  }
  return pub;
}

/**
 * HostAuthority 用的重放入口。
 * seed 形如 { s: <数字>, base: { n, names, ai, spyCount } }。
 * 注意 base 里**没有**任何私密信息 —— 词和身份不在这里。
 *
 * moves 一起返回：房主侧的 state 需要带着已确认的动作序列，
 * 否则下一次 reduce 只会拿到最后一个动作，重放出来的局面就是错的。
 */
export function replay(seed, actions) {
  const base = (seed && seed.base) || { n: 4 };
  const acts = (actions || []).slice();
  return { base, pub: fold(base, acts), moves: acts };
}

/**
 * 公开局面摘要（两端一致 —— 因为不含任何私密信息）。
 */
export function hashPub(pub) {
  if (!pub) return '';
  const descs = (pub.descs || []).map((d) => d.p + ':' + d.text).join(',');
  const votes = Object.keys(pub.votes || {}).sort().map((k) => k + '>' + pub.votes[k]).join(',');
  return [
    'n' + pub.n,
    'r' + pub.round,
    pub.phase,
    't' + pub.turnSeat,
    'a' + (pub.alive || []).map((x) => (x ? 1 : 0)).join(''),
    'd:' + descs,
    'v:' + votes,
    'e:' + (pub.eliminated || []).join(','),
    'w:' + (pub.winner || ''),
  ].join('|');
}

/* =============================================================================
 * 公开视图裁剪
 * -----------------------------------------------------------------------------
 * 房主广播的是「公开视图」，不是内部完整局面。
 * 裁掉的东西只有一样：**投票明细**。
 *
 * 为什么：投票阶段时，先投的人如果能看到对端状态里的票，
 * 就能推断出谁投了谁 —— 这在现实里当然不可能。
 * 线下玩法是「都投完一起亮票」，这里必须照做。
 *
 * 一进入结算阶段，票就该公开了（亮票环节），所以那时不裁。
 * ========================================================================== */

/** 生成公开视图：投票阶段裁掉票明细，其余阶段保留（亮票）。 */
export function publicView(pub) {
  if (!pub) return pub;
  if (pub.phase !== PHASE.VOTE) return pub;
  const out = Object.assign({}, pub);
  delete out.votes;
  return out;
}

/* =============================================================================
 * AI
 * ========================================================================== */

/**
 * 生成 AI 的描述句。
 *
 * 关键：AI 是卧底时，**绝不能说出卧底词的关键词** ——
 * 一旦露馅（描述里出现「麻」「烫」这种只属于卧底词的字），
 * 平民立刻就能锁定他，这游戏就没得玩了。
 * 所以卧底 AI 说的是「平民词那边」的关键词，只是语气更虚一点。
 *
 * @param {object} pair 词对
 * @param {string} myWord AI 拿到的词
 * @param {number} rnd  0..1 的随机数（来自可复现随机源）
 */
export function aiDescribe(pair, myWord, rnd) {
  const isSpy = myWord === pair.b;
  const k = pair.ka[Math.floor(rnd * pair.ka.length) % pair.ka.length];
  /* 关键：卧底 AI 也要提**平民词**那边的关键词（伪装），
     但语气更虚 —— 平民说得笃定，卧底说得犹豫。
     之前有一半模板完全不提关键词，结果卧底 AI 一开口就被票出去，
     这游戏就没得玩了（真问题，已修）。
     卧底绝不能提自己那个词的关键词 —— 一提就露馅。 */
  const civilianTemplates = [
    '应该是「' + pair.hint + '」里的' + k + '吧',
    '「' + pair.hint + '」，而且是' + k + '的那种',
    '我觉得就是' + k + '，属于「' + pair.hint + '」',
    '「' + pair.hint + '」—— 关键特征是' + k,
  ];
  const spyTemplates = [
    '感觉是「' + pair.hint + '」，跟' + k + '有点像',
    '应该是「' + pair.hint + '」，就是' + k + '那一类的吧',
    '我理解它属于「' + pair.hint + '」，可能跟' + k + '差不多',
    '「' + pair.hint + '」吧…… 有点像' + k + '，但我说不太准',
  ];
  const pool = isSpy ? spyTemplates : civilianTemplates;
  return pool[Math.floor(rnd * pool.length) % pool.length];
}

/**
 * AI 的投票。
 * 启发式：谁的描述里**完全没出现平民词关键词**，那人多半在描述另一个词
 *         → 投他；否则在还活着的人里挑一个。
 *
 * 注意 AI 的动作最终由房主写进动作序列 —— 描述是「玩家输入」性质的内容，
 * 如果让两端各自随机生成，重放出来的描述必然不同。
 *
 * @param {object} pub 公开局面
 * @param {string} myWord AI 自己的词
 * @param {object} pair 词对
 * @param {number} rnd 可复现随机数
 */
export function aiVote(pub, myWord, pair, rnd) {
  const alive = pub.alive;
  const me = pub.turnSeat;
  const candidates = [];
  for (let i = 0; i < pub.n; i++) {
    if (alive[i] && i !== me) candidates.push(i);
  }
  if (!candidates.length) return -1;

  /* 判据只用**平民词关键词**：
     谁的话里完全找不到平民词的影子，谁才最可疑。
     注意：卧底 AI 也会提平民词关键词（伪装），所以这一招不会一击必杀；
     真要靠它定胜负，还得看谁说话更虚、更不像平民。 */
  const unrelated = candidates.filter((c) => {
    const d = (pub.descs || []).find((x) => x.p === c);
    if (!d) return false;
    return !pair.ka.some((k) => d.text.indexOf(k) >= 0);
  });
  /* 稍微偏心「完全不提关键词」的人，但不是铁定投他 —— 加点随机性，
     不然 AI 局会变成「谁没提关键词谁第一个出局」，一眼看穿。 */
  if (unrelated.length && rnd < 0.65) {
    return unrelated[Math.floor(rnd * unrelated.length) % unrelated.length];
  }
  return candidates[Math.floor(rnd * candidates.length) % candidates.length];
}

/** 给某个座位生成一个稳定随机的 0..1（用于 AI 的可复现决策）。 */
export function aiRandom(seedKey) {
  return mulberry32(hashStr(seedKey))();
}
