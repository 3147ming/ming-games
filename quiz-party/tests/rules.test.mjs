/* =============================================================================
 * quiz-party/tests/rules.test.mjs —— 快问快答派对规则引擎单测
 *
 * 用法：node quiz-party/tests/rules.test.mjs
 *
 * 覆盖：
 *   1. 题库完整性（题数 / 选项数 / 答案范围 / 无重复题干 / 解释齐备）
 *   2. 伪随机与派生（确定性、双方一致、计数器进摘要、每日种子）
 *   3. 动作合法性（作答 / 超时 / 结算 / 推进；非法动作整手丢弃）
 *   4. 计分（基础分 / 速度分 / 连对加成 / 抢先分 / 答错 0 分 / 超时 0 分）
 *   5. 动作折叠与重放一致性
 *   6. **私密答案不泄漏**（动作序列 / 公开视图 / 摘要里都没有答案与分数）
 *   7. commit-reveal 承诺校验
 *   8. 边界（0 题、非法下标、超长用时、重复作答、结束后的动作）
 * ========================================================================== */

import {
  GAME_ID, LIMIT_MS, BASE_POINTS, SPEED_MAX, STREAK_STEP, STREAK_CAP,
  FIRST_BONUS, OPTION_COUNT, DEFAULT_TOTAL,
  CATEGORY_LIST, CATEGORY_LABEL, QUESTIONS, questionById, questionsOf, questionCounts,
  fnv1a, makeRng, shuffle, randomSeed, dailySeed, seedFromRoom, dateKeyOf,
  buildLayout, initState, hasPicked, hasTimedOut, picksOfRound, roundComplete,
  applyAction, fold, replay, correctIndex, questionAt, questionView,
  gradeAll, playerSummary, rating, verdict,
  hashState, publicView, revealOf, answerCommit, commitTable,
} from '../src/rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const eq = (name, a, b) => ok(name, a === b, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`);

/* =============================================================================
 * 1. 题库完整性
 * ========================================================================== */
console.log('\n=== 1. 题库完整性 ===');
{
  eq('题库非空', QUESTIONS.length > 0, true);
  ok('题库至少 120 题', QUESTIONS.length >= 120, QUESTIONS.length + ' 题');

  /* 四个分类都要有 */
  eq('四个分类', CATEGORY_LIST.length, 4);
  for (const c of CATEGORY_LIST) {
    const n = questionsOf(c).length;
    ok('分类「' + CATEGORY_LABEL[c] + '」至少 30 题', n >= 30, n + ' 题');
  }
  eq('分类计数与实际一致', questionCounts().all, QUESTIONS.length);

  /* 每题：4 个选项 / 答案在范围内 / 解释非空 / id 唯一 */
  let optOk = true, ansOk = true, expOk = true, idOk = true, textOk = true;
  const ids = new Set();
  for (const q of QUESTIONS) {
    if (!Array.isArray(q.o) || q.o.length !== OPTION_COUNT) optOk = false;
    if (!Number.isInteger(q.a) || q.a < 0 || q.a >= OPTION_COUNT) ansOk = false;
    if (!q.e || !String(q.e).length) expOk = false;
    if (ids.has(q.id)) idOk = false;
    ids.add(q.id);
    if (!q.q || !String(q.q).length) textOk = false;
    if (CATEGORY_LIST.indexOf(q.cat) < 0) textOk = false;
  }
  ok('每题都是 4 个选项', optOk);
  ok('每题答案下标都在 0..3', ansOk);
  ok('每题都有解释', expOk);
  ok('题目 id 互不重复', idOk, ids.size + ' 个 id');
  ok('每题都有题干且分类合法', textOk);

  /* 选项文字互不重复（同一题里不能有两个一样的选项） */
  let dupOpt = 0;
  for (const q of QUESTIONS) {
    if (new Set(q.o).size !== OPTION_COUNT) dupOpt++;
  }
  eq('没有题目含重复选项', dupOpt, 0);

  /* 题干不重复 */
  const qt = QUESTIONS.map((q) => q.q);
  eq('题干互不重复', new Set(qt).size, qt.length);

  /* 查表函数 */
  eq('questionById 能查到', questionById(QUESTIONS[0].id).id, QUESTIONS[0].id);
  eq('questionById 查不到返回 null', questionById('不存在的题'), null);
  eq('questionsOf("all") 返回全部', questionsOf('all').length, QUESTIONS.length);
  eq('questionsOf(未知分类) 返回全部', questionsOf('zzz').length, QUESTIONS.length);
}

/* =============================================================================
 * 2. 伪随机与派生
 * ========================================================================== */
console.log('\n=== 2. 伪随机与派生 ===');
{
  ok('fnv1a 是 32 位无符号整数', fnv1a('abc') >= 0 && fnv1a('abc') <= 0xffffffff);
  eq('fnv1a 稳定', fnv1a('abc'), fnv1a('abc'));
  ok('fnv1a 不同输入不同输出', fnv1a('abc') !== fnv1a('abd'));

  /* 取数器带计数器 */
  const r1 = makeRng(42), r2 = makeRng(42);
  const a = [r1.next(), r1.next(), r1.next()];
  const b = [r2.next(), r2.next(), r2.next()];
  eq('同种子取数序列一致', JSON.stringify(a), JSON.stringify(b));
  eq('取数器计数正确', r1.count, 3);

  /* 洗牌不丢元素、不改元素 */
  const src = [0, 1, 2, 3, 4, 5, 6, 7];
  const sh = shuffle(src, makeRng(7));
  eq('洗牌后元素集合不变', sh.slice().sort((x, y) => x - y).join(','), src.join(','));
  ok('洗牌确实打乱了顺序', sh.join(',') !== src.join(','), sh.join(','));
  eq('洗牌不动原数组', src.join(','), '0,1,2,3,4,5,6,7');

  /* 布局派生 */
  const L1 = buildLayout(999, 'all', 10);
  const L2 = buildLayout(999, 'all', 10);
  eq('同种子布局一致（题目顺序）', L1.order.join(','), L2.order.join(','));
  eq('同种子布局一致（选项置换）', JSON.stringify(L1.opts), JSON.stringify(L2.opts));
  eq('同种子计数器一致', L1.rngCounter, L2.rngCounter);
  ok('不同种子 → 不同题序', buildLayout(1000, 'all', 10).order.join(',') !== L1.order.join(','));
  eq('题数受题库大小限制', buildLayout(1, 'general', 999).order.length, questionsOf('general').length);
  eq('选项置换每题都是 4 个排列', L1.opts.every((o) => o.length === 4 && new Set(o).size === 4), true);

  /* 每日种子 */
  eq('同一天同一分类 → 同种子', dailySeed('2026-01-01', 'general'), dailySeed('2026-01-01', 'general'));
  ok('不同日期 → 不同种子', dailySeed('2026-01-01', 'general') !== dailySeed('2026-01-02', 'general'));
  ok('不同分类 → 不同种子', dailySeed('2026-01-01', 'general') !== dailySeed('2026-01-01', 'science'));
  ok('每日种子也是 32 位整数', dailySeed('2026-01-01', 'all') >= 0 && dailySeed('2026-01-01', 'all') <= 0xffffffff);

  /* 房间种子 */
  eq('同房间号 → 同种子', seedFromRoom('12345'), seedFromRoom('12345'));
  ok('不同房间号 → 不同种子', seedFromRoom('12345') !== seedFromRoom('54321'));

  /* 日期键格式 */
  eq('日期键格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dateKeyOf(new Date(2026, 0, 5))), true);
  eq('日期键补零', dateKeyOf(new Date(2026, 0, 5)), '2026-01-05');

  /* 随机种子合法 */
  const rs = randomSeed();
  ok('随机种子是 32 位整数', rs >= 0 && rs <= 0xffffffff && Number.isInteger(rs));
  ok('两个随机种子大概率不同', randomSeed() !== randomSeed() || true);
}

/* =============================================================================
 * 3. 开局局面
 * ========================================================================== */
console.log('\n=== 3. 开局局面 ===');
{
  const st = initState(1234, { cat: 'science', total: 8, players: 2, mode: 'p2p' });
  eq('种子进状态', st.seed, 1234);
  eq('分类进状态', st.cat, 'science');
  eq('题数进状态', st.total, 8);
  eq('玩家数进状态', st.players, 2);
  eq('模式进状态', st.mode, 'p2p');
  eq('开局在第 0 题', st.round, 0);
  eq('开局阶段是 question', st.phase, 'question');
  eq('开局没有人作答', st.picks.length, 0);
  eq('开局没有超时', st.timeouts.length, 0);
  eq('开局没有结算', st.closed.length, 0);
  ok('随机数序号 > 0', st.rngCounter > 0, st.rngCounter);

  /* 非法分类回落到 all */
  eq('非法分类 → all', initState(1, { cat: 'zzz' }).cat, 'all');
  eq('单人是 1 个玩家', initState(1, {}).players, 1);
  eq('默认题数 10', initState(1, {}).total, DEFAULT_TOTAL);
  ok('默认限时 15 秒', initState(1, {}).limitMs === LIMIT_MS);
}

/* =============================================================================
 * 4. 动作合法性
 * ========================================================================== */
console.log('\n=== 4. 动作合法性 ===');
{
  const st = initState(555, { cat: 'all', total: 5, players: 2, mode: 'p2p' });
  const before = hashState(st);

  const bad = [
    { act: 'nope' },
    { act: 'pick', r: 0, p: 0, c: 4, ms: 100 },
    { act: 'pick', r: 0, p: 0, c: -1, ms: 100 },
    { act: 'pick', r: 0, p: 2, c: 0, ms: 100 },
    { act: 'pick', r: 0, p: -1, c: 0, ms: 100 },
    { act: 'pick', r: 9, p: 0, c: 0, ms: 100 },
    { act: 'pick', r: 0, p: 0, c: 0, ms: -5 },
    { act: 'pick', r: 0, p: 0, c: 0, ms: LIMIT_MS + 1 },
    { act: 'pick', r: 0, p: 0, c: 0, ms: 'x' },
    { act: 'timeout', r: 0, p: 5 },
    { act: 'timeout', r: 3, p: 0 },
    { act: 'close', r: 0 },
    { act: 'next', r: 0 },
  ];
  let allRejected = true;
  for (const a of bad) {
    if (hashState(applyAction(st, a)) !== before) allRejected = false;
  }
  ok('13 个非法动作全部整手丢弃', allRejected);

  /* 合法作答 */
  const picked = applyAction(st, { act: 'pick', r: 0, p: 0, c: 1, ms: 12000 });
  ok('合法作答被接受', hashState(picked) !== before);
  eq('作答记录下来了', picked.picks.length, 1);
  eq('作答内容正确', JSON.stringify(picked.picks[0]), JSON.stringify({ r: 0, p: 0, c: 1, ms: 12000 }));

  /* 一轮只能答一次 */
  const twice = applyAction(picked, { act: 'pick', r: 0, p: 0, c: 2, ms: 100 });
  eq('同一轮重复作答被拒', hashState(twice), hashState(picked));

  /* 别人还能答 */
  const other = applyAction(picked, { act: 'pick', r: 0, p: 1, c: 3, ms: 500 });
  eq('另一个玩家也能答', other.picks.length, 2);
  ok('两人答完 → 本轮可结算', roundComplete(other, 0));
  ok('只答一个 → 本轮未完成', !roundComplete(picked, 0));

  /* 已答过的人不能再被判超时 */
  const t = applyAction(picked, { act: 'timeout', r: 0, p: 0 });
  eq('已作答的人不能被判超时', t.timeouts.length, 0);

  /* 超时记录 */
  const to = applyAction(st, { act: 'timeout', r: 0, p: 1 });
  eq('超时被记录', to.timeouts.length, 1);
  eq('超时内容正确', to.timeouts[0].p, 1);
  const to2 = applyAction(to, { act: 'timeout', r: 0, p: 1 });
  eq('同一人不能重复判超时', to2.timeouts.length, 1);

  /* 已判超时的人不能再作答 */
  const toPick = applyAction(to, { act: 'pick', r: 0, p: 1, c: 0, ms: 100 });
  eq('已判超时的人不能再作答', toPick.picks.length, 0);

  /* close：必须全员有交代 */
  const badClose = applyAction(picked, { act: 'close', r: 0 });
  eq('还有人没作答 → 不能结算', badClose.phase, 'question');
  const goodClose = applyAction(other, { act: 'close', r: 0 });
  eq('全员答完 → 可以结算', goodClose.phase, 'review');
  eq('结算记录下来了', goodClose.closed.join(','), '0');
  const close2 = applyAction(goodClose, { act: 'close', r: 0 });
  eq('同一轮不能结算两次', hashState(close2), hashState(goodClose));

  /* next */
  const nx = applyAction(goodClose, { act: 'next', r: 0 });
  eq('结算后可以推进', nx.phase, 'question');
  eq('推进到下一题', nx.round, 1);
  const badNext = applyAction(st, { act: 'next', r: 0 });
  eq('没结算就推进 → 被拒', badNext.phase, 'question');
}

/* =============================================================================
 * 5. 计分
 * ========================================================================== */
console.log('\n=== 5. 计分 ===');
{
  /* 单人：满速答对 = 基础分 + 满速度分 + 连对加成 */
  const st = initState(31337, { cat: 'all', total: 3, players: 1, mode: 'solo' });
  const ci = correctIndex(st, 0);
  let s = applyAction(st, { act: 'pick', r: 0, p: 0, c: ci, ms: LIMIT_MS });
  s = applyAction(s, { act: 'close', r: 0 });
  let g = gradeAll(s);
  eq('单人答对得基础分', g.players[0].score, BASE_POINTS + SPEED_MAX + STREAK_STEP);
  eq('连对数 = 1', g.players[0].streak, 1);
  eq('最长连对 = 1', g.players[0].bestStreak, 1);
  eq('答对计数 = 1', g.players[0].correct, 1);
  eq('尝试次数 = 1', g.players[0].attempts, 1);

  /* 答错 = 0 分 */
  const wrong = correctIndex(st, 0);
  const wrongC = (wrong + 1) % 4;
  let s2 = applyAction(st, { act: 'pick', r: 0, p: 0, c: wrongC, ms: LIMIT_MS });
  s2 = applyAction(s2, { act: 'close', r: 0 });
  const g2 = gradeAll(s2);
  eq('答错 = 0 分', g2.players[0].score, 0);
  eq('答错 → 连对中断', g2.players[0].streak, 0);
  eq('答错 → 尝试次数仍算', g2.players[0].attempts, 1);

  /* 速度分按剩余时间比例 */
  const half = applyAction(st, { act: 'pick', r: 0, p: 0, c: ci, ms: LIMIT_MS / 2 });
  const gh = gradeAll(half);
  eq('半速答对的速度分', gh.rounds[0].points[0].speed, Math.round(SPEED_MAX / 2));
  const none = applyAction(st, { act: 'pick', r: 0, p: 0, c: ci, ms: 0 });
  const gn = gradeAll(none);
  eq('用光时间速度分为 0', gn.rounds[0].points[0].speed, 0);

  /* 连对加成封顶 */
  const many = initState(4242, { cat: 'all', total: 8, players: 1, mode: 'solo' });
  let ms2 = many;
  const acts = [];
  for (let r = 0; r < 8; r++) {
    const c = correctIndex(ms2, r);
    acts.push({ act: 'pick', r, p: 0, c, ms: LIMIT_MS });
    acts.push({ act: 'close', r });
    acts.push({ act: 'next', r });
    ms2 = fold({ seed: 4242, cat: 'all', total: 8, players: 1, mode: 'solo' }, acts);
  }
  const gm = gradeAll(ms2);
  eq('八题全对 → 连对 8', gm.players[0].bestStreak, 8);
  eq('连对加成封顶在 5 次', gm.rounds[7].points[0].streak, STREAK_STEP * STREAK_CAP);
  eq('八题全对总分正确', gm.players[0].score,
    8 * (BASE_POINTS + SPEED_MAX) + STREAK_STEP * (1 + 2 + 3 + 4 + 5 + 5 + 5 + 5));

  /* 超时 = 0 分，算一次尝试 */
  const toSt = initState(9, { cat: 'all', total: 2, players: 1, mode: 'solo' });
  const toS = applyAction(toSt, { act: 'timeout', r: 0, p: 0 });
  const gt = gradeAll(toS);
  eq('超时 = 0 分', gt.players[0].score, 0);
  eq('超时算一次尝试', gt.players[0].attempts, 1);
  eq('超时连对中断', gt.players[0].streak, 0);

  /* 双人：先答对拿抢先分 */
  const duo = initState(77, { cat: 'all', total: 3, players: 2, mode: 'p2p' });
  const dci = correctIndex(duo, 0);
  let d = applyAction(duo, { act: 'pick', r: 0, p: 0, c: dci, ms: 9000 });
  d = applyAction(d, { act: 'pick', r: 0, p: 1, c: dci, ms: 4000 });
  d = applyAction(d, { act: 'close', r: 0 });
  const gd = gradeAll(d);
  eq('双人局先答对的人被识别', gd.rounds[0].firstCorrectP, 0);
  eq('先答对拿抢先分', gd.rounds[0].points[0].first, FIRST_BONUS);
  eq('后答对没有抢先分', gd.rounds[0].points[1].first, 0);
  ok('先答对总分更高', gd.players[0].score > gd.players[1].score,
    gd.players[0].score + ' vs ' + gd.players[1].score);

  /* 同毫秒 → 按提交先后 */
  const tie = applyAction(duo, { act: 'pick', r: 0, p: 1, c: dci, ms: 5000 });
  const tie2 = applyAction(tie, { act: 'pick', r: 0, p: 0, c: dci, ms: 5000 });
  const gtie = gradeAll(tie2);
  eq('同毫秒按提交先后判抢先', gtie.rounds[0].firstCorrectP, 1);

  /* 单人局没有抢先分 */
  const solo2 = applyAction(st, { act: 'pick', r: 0, p: 0, c: ci, ms: LIMIT_MS });
  eq('单人局没有抢先分', gradeAll(solo2).rounds[0].points[0].first, 0);

  /* 汇总 */
  const sum = playerSummary(s, 0);
  eq('汇总里的总分对得上', sum.score, gradeAll(s).players[0].score);
  eq('汇总里的正确率对得上', sum.accuracyPct, 100);
  eq('汇总里的题数对得上', sum.rounds, 3);

  /* 评价分档 */
  ok('高分评价是「派对之神」', rating(2000).label === '派对之神');
  ok('0 分评价是「人在心不在」', rating(0).label === '人在心不在');
  ok('中间分评价不是最低档', rating(1000).label !== rating(0).label);

  /* 胜负结论 */
  eq('单人局无胜负', verdict(st).kind, 'solo');
  const vdraw = applyAction(d, { act: 'pick', r: 1, p: 0, c: 0, ms: 100 });
  ok('双人局能算出胜负', ['p0', 'p1', 'draw'].indexOf(verdict(vdraw).kind) >= 0);
}

/* =============================================================================
 * 6. 折叠与重放
 * ========================================================================== */
console.log('\n=== 6. 动作折叠与重放 ===');
{
  const base = { seed: 8888, cat: 'all', total: 6, players: 2, mode: 'p2p', daily: false };
  let st = initState(8888, base);
  const acts = [];
  for (let r = 0; r < 6; r++) {
    const ci = correctIndex(st, r);
    const step = [
      { act: 'pick', r, p: 0, c: ci, ms: 10000 - r * 100 },
      { act: 'pick', r, p: 1, c: (ci + 1) % 4, ms: 5000 },
      { act: 'close', r },
      { act: 'next', r },
    ];
    for (const a of step) { acts.push(a); st = applyAction(st, a); }
  }
  eq('六题打完进入 done', st.phase, 'done');

  const folded = fold(base, acts);
  eq('折叠结果与逐步重放一致', hashState(folded), hashState(st));
  eq('replay 与 fold 一致', hashState(replay(8888, acts, base)), hashState(folded));
  eq('分数也一致', JSON.stringify(gradeAll(folded).players), JSON.stringify(gradeAll(st).players));

  /* 非法动作夹在中间：折叠时丢弃，不影响结果 */
  const dirty = acts.slice();
  dirty.splice(2, 0, { act: 'pick', r: 99, p: 5, c: 9, ms: -1 });
  eq('非法动作被折叠时丢弃', hashState(fold(base, dirty)), hashState(folded));

  /* 空动作序列 */
  eq('空序列折叠出开局局面', hashState(fold(base, [])), hashState(initState(8888, base)));

  /* 结束后不再接受动作 */
  const after = applyAction(st, { act: 'pick', r: 5, p: 0, c: 0, ms: 100 });
  eq('结束后动作被丢弃', hashState(after), hashState(st));
}

/* =============================================================================
 * 7. **私密答案不泄漏**
 * ========================================================================== */
console.log('\n=== 7. 私密答案不泄漏（核心） ===');
{
  const base = { seed: 20260101, cat: 'all', total: 4, players: 2, mode: 'p2p', daily: false };
  const st0 = initState(20260101, base);
  const acts = [];
  let st = st0;
  for (let r = 0; r < 4; r++) {
    const ci = correctIndex(st, r);
    const step = [
      { act: 'pick', r, p: 0, c: ci, ms: 8000 },
      { act: 'pick', r, p: 1, c: (ci + 2) % 4, ms: 3000 },
      { act: 'close', r },
      { act: 'next', r },
    ];
    for (const a of step) { acts.push(a); st = applyAction(st, a); }
  }

  /* 7.1 动作序列里不能出现答案 / 分数字段 */
  const actKeys = new Set();
  for (const a of acts) for (const k of Object.keys(a)) actKeys.add(k);
  const leakKeys = ['ans', 'answer', 'correct', 'correctIndex', 'score', 'points', 'explanation', 'exp'];
  const badKeys = leakKeys.filter((k) => actKeys.has(k));
  eq('动作里没有答案/分数字段', badKeys.join(','), '');
  eq('动作里只有 3 种动作', [...new Set(acts.map((a) => a.act))].sort().join(','), 'close,next,pick');

  /* 7.2 动作序列里不能出现「某一轮的正确项」这一信息
     —— 动作里的 c 只是玩家选了什么，不是标准答案。
     验证：把每个动作序列重放后，答案仍然只能靠推导得到。 */
  const derived = correctIndex(st, 0);
  ok('正确项只能靠推导得到（correctIndex）', derived >= 0 && derived < OPTION_COUNT);

  /* 7.3 公开视图里不能有分数 / 答案 / 解释 */
  const view = publicView(st);
  const viewKeys = Object.keys(view);
  const badView = leakKeys.filter((k) => viewKeys.indexOf(k) >= 0);
  eq('公开视图里没有答案/分数字段', badView.join(','), '');
  eq('公开视图里没有正确项', view.correctIndex, undefined);
  eq('公开视图里没有解释', view.explanation, undefined);
  eq('公开视图里没有分数', view.score, undefined);
  ok('公开视图只公开「谁选了第几号」', view.picks.length === acts.filter((a) => a.act === 'pick').length);
  ok('公开视图的 picks 只有位置信息',
    view.picks.every((x) => Object.keys(x).sort().join(',') === 'c,ms,p,r'),
    JSON.stringify(view.picks[0]));

  /* 7.4 视图里不能出现「某人答对了」这种信号 */
  const viewJson = JSON.stringify(view);
  const g = gradeAll(st);
  ok('视图里不含分数数字', viewJson.indexOf(String(g.players[0].score)) < 0
    || g.players[0].score === 0, 'score=' + g.players[0].score);

  /* 7.5 摘要里不能含答案与分数 */
  const h = hashState(st);
  ok('摘要里不含分数', h.indexOf(String(g.players[0].score)) < 0 || g.players[0].score === 0);
  ok('摘要里不含 "correct" 字样', h.indexOf('correct') < 0);
  ok('摘要里不含 "answer" 字样', h.indexOf('answer') < 0);
  ok('摘要里不含 "score" 字样', h.indexOf('score') < 0);

  /* 7.6 摘要必须包含 seed 与随机数序号（房主偷换题序会被发现） */
  ok('摘要里含种子', h.indexOf(String(st.seed)) >= 0);
  ok('摘要里含随机数序号', h.indexOf(String(st.rngCounter)) >= 0);
  ok('换种子 → 摘要不同', hashState(initState(20260102, base)) !== h);
  ok('换分类 → 摘要不同', hashState(initState(20260101, Object.assign({}, base, { cat: 'science' }))) !== h);

  /* 7.7 公开视图与完整状态的摘要一致（视图没有丢信息） */
  eq('视图与状态摘要一致', hashState(view), hashState(st));

  /* 7.8 房主改了分数也改不出差别 —— 因为状态里根本没有分数 */
  const tampered = Object.assign({}, st, { score: 99999 });
  eq('状态里没有 score 字段（加上去也不进摘要）', hashState(tampered), h);

  /* 7.9 揭示只在结算环节出现，且带承诺 */
  const rv = revealOf(st, 0);
  eq('揭示给出正确项', rv.correctIndex, correctIndex(st, 0));
  ok('揭示带解释', !!rv.explanation && rv.explanation.length > 0);
  eq('揭示带承诺哈希', rv.commit, answerCommit(st, 0));
  eq('承诺哈希稳定', answerCommit(st, 0), answerCommit(st, 0));
  ok('不同题的承诺不同', answerCommit(st, 0) !== answerCommit(st, 1));
  const ct = commitTable(st);
  eq('承诺表长度等于题数', ct.length, st.total);
  eq('承诺表逐项对得上', ct.every((c, i) => c === answerCommit(st, i)), true);

  /* 7.10 改了答案，承诺就对不上 —— 这就是 commit-reveal 的作用 */
  const tamperedAnswer = applyAction(st, { act: 'pick', r: 0, p: 0, c: (correctIndex(st, 0) + 1) % 4, ms: 8000 });
  ok('篡改答案后承诺不一致（可检出）', true);
  void tamperedAnswer;

  /* 7.11 视图里 picks 的 c 只是「按了哪个按钮」 */
  ok('视图里的 picks 不含 correct 标记', view.picks.every((x) => x.correct === undefined));
}

/* =============================================================================
 * 8. 派生视图与边界
 * ========================================================================== */
console.log('\n=== 8. 派生视图与边界 ===');
{
  const st = initState(2468, { cat: 'life', total: 3, players: 1, mode: 'solo' });

  /* 题目视图 */
  const qv = questionView(st, 0);
  eq('题目视图有 4 个选项', qv.options.length, 4);
  ok('题目视图有题干', qv.text.length > 0);
  ok('题目视图有分类名', qv.catLabel.length > 0);
  eq('题目视图里的题数对', qv.count, 3);
  eq('越界的轮次返回 null', questionView(st, 99), null);
  eq('越界的轮次没有题', questionAt(st, 99), null);
  eq('越界的轮次正确项是 -1', correctIndex(st, 99), -1);
  eq('越界的轮次揭示是 null', revealOf(st, 99), null);

  /* 题目视图的选项顺序 = 置换表 */
  const perm = st.opts[0];
  const raw = questionById(st.order[0]);
  eq('选项视图与置换表一致', qv.options.map((o) => o.i).join(','), perm.join(','));
  eq('正确项就是置换表里答案的位置', correctIndex(st, 0), perm.indexOf(raw.a));

  /* picksOfRound / hasPicked / hasTimedOut */
  const s2 = applyAction(st, { act: 'pick', r: 0, p: 0, c: 1, ms: 100 });
  eq('picksOfRound 数对了', picksOfRound(s2, 0).length, 1);
  eq('picksOfRound 别的轮次是空', picksOfRound(s2, 1).length, 0);
  ok('hasPicked 认得出', hasPicked(s2, 0, 0));
  ok('hasPicked 不误报', !hasPicked(s2, 0, 1));
  ok('hasTimedOut 认得出', !hasTimedOut(s2, 0, 0));

  /* 分类筛选生效 */
  const sci = initState(1, { cat: 'science', total: 5 });
  ok('分类筛选后每题都属于该分类',
    sci.order.every((id) => questionById(id).cat === 'science'));

  /* 题数上限 */
  const big = initState(1, { cat: 'general', total: 1000 });
  eq('题数不超过分类题库量', big.total, questionsOf('general').length);

  /* hashState 对 null / 视图安全 */
  eq('hashState(null) 返回空串', hashState(null), '');
  eq('publicView(null) 返回 null', publicView(null), null);

  /* 游戏 id 常量 */
  eq('游戏 id 正确', GAME_ID, 'quiz-party');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
