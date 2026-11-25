/* =============================================================================
 * shanhai-merge/src/main.mjs —— 「山海合成」主控
 * -----------------------------------------------------------------------------
 * 模式：
 *   daily      每日固定局：种子由日期派生，当天所有人盘面与飘落序列完全一样，可比分数
 *   free       自由对局：随机种子，目标是合出目标阶
 *   challenge  步数挑战：随机种子 + 步数上限，先到先得
 *
 * ---------------------------------------------------------------------------
 * 交互（pointer 事件，鼠标与触摸通用）
 * -----------------------------------------------------------------------------
 *   按下 → 移动 → 松手：
 *     · 位移小于阈值（8px）算「点击」：点一只、再点另一只同阶的即可合成；
 *     · 位移超过阈值算「拖动」：拖到同阶的另一只上松手即合成。
 *   两种都走同一份规则引擎 —— UI 只是把「从哪拖到哪」翻译成
 *   {act:'merge', from, to}，合法性一律由 rules.mjs 判定。
 *
 * ---------------------------------------------------------------------------
 * 动画
 * -----------------------------------------------------------------------------
 *   · 棋盘用 DOM（不是 canvas）：格子是 div，每只神兽是一个 div。
 *     位置变化靠 CSS transform/opacity 过渡，不逐帧改 top/left。
 *   · 新飘落的神兽：从上方滑入（.in）。
 *   · 合成：来源格淡出缩小（.out），目标格弹出（.pop）。
 *   · prefers-reduced-motion 下所有动画被 CSS 关掉。
 *
 * ---------------------------------------------------------------------------
 * 随机与可复现
 * -----------------------------------------------------------------------------
 *   规则引擎里的一切随机都来自 seed（mulberry32 计数式伪随机），
 *   这里只在「自由对局 / 步数挑战」开局时用 Math.random() 造一次 seed ——
 *   那是一次性的，造完就写进状态，之后全部由 seed 推导。
 *   每日固定局的 seed 直接由日期派生，不需要随机。
 *
 * ---------------------------------------------------------------------------
 * 存档
 * -----------------------------------------------------------------------------
 *   key = mg_shanhai-merge.v1
 *   只存：最高分 / 胜局 / 每日固定局的种子与日期 / 上次玩的模式。
 *   localStorage 全部在函数里 try/catch —— file:// 下某些浏览器会抛。
 *
 * 纪律：顶层不碰 DOM（模块底部启动段统一做），不碰 localStorage。
 * ========================================================================== */

import {
  SIZE, MAX_LEVEL, BEASTS, beastOf, beastName,
  randomSeed, seedFromDate,
  initState, applyAction, replay, hashState, publicView,
  mergePairs, canMerge, hasMerge, isFull, topLevel, describeEvents,
} from './rules.mjs';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */
let mode = 'daily';
let st = null;
let base = { seed: 0, opts: {} };
let acts = [];                 /* 动作序列（可重放） */
let sel = -1;                  /* 选中的格子下标（点选模式） */
let drag = null;               /* 拖拽中的信息 */
let lastBoard = null;          /* 上一次的盘面（用于做动画） */

/* 拖拽阈值：小于这个位移算「点击」 */
const DRAG_THRESHOLD = 8;

/* 调试钩子（端到端测试用） */
globalThis.__SHANHAI__ = {
  get pub() { return st ? publicView(st) : null; },
  get seed() { return st ? st.seed : 0; },
  get hash() { return st ? hashState(st) : ''; },
  get over() { return st ? st.over : false; },
  get won() { return st ? st.won : false; },
  get moves() { return st ? st.moves : 0; },
  get score() { return st ? st.score : 0; },
  get mode() { return mode; },
  get actionCount() { return acts.length; },
  get actionList() { return acts.slice(); },
  get sel() { return sel; },
  get best() { return st ? st.best : 0; },
  /* 测试用：直接提交一个动作 */
  act: (act) => doAct(act),
  /* 测试用：摆一个局面（只改 board，规则仍由引擎判定） */
  setBoard: (arr) => {
    if (!st) return;
    st = Object.assign({}, st, { board: arr.slice(), score: 0, moves: 0, best: 0, history: [], over: false, overReason: '', won: false });
    lastBoard = null;
    $('over').hidden = true;
    render();
  },
  /* 测试用：列出当前所有可合成对 */
  pairs: () => (st ? mergePairs(st.board) : []),
  replay: (seed, as) => replay(seed, as, base.opts),
};

/* ---------------------------------------------------------------------------
 * 日期与种子
 * ------------------------------------------------------------------------- */

/** 今天的日期键（本地时区）YYYY-MM-DD。 */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 当前模式下的开局种子。 */
function seedForMode() {
  if (mode === 'daily') return seedFromDate(todayKey());
  return randomSeed();
}

/** 当前模式下的规则参数。 */
function optsForMode() {
  const target = parseInt($('target').value, 10) || 5;
  let maxMoves = parseInt($('movelimit').value, 10) || 0;
  if (mode === 'challenge' && maxMoves === 0) maxMoves = 60;
  return { size: SIZE, target, maxMoves };
}

/* ---------------------------------------------------------------------------
 * 动作
 * ------------------------------------------------------------------------- */

/** 提交一个动作（引擎判定合法性）。 */
function doAct(act) {
  if (!st) return st;
  const next = applyAction(st, act);
  if (next === st) {
    /* 非法动作：给个提示，不改状态 */
    if (act && act.act === 'merge') {
      setMsg('这两只不能合体 —— 要同阶才行', 'warn');
    }
    return st;
  }
  acts = acts.concat([act]);
  st = next;
  afterAction();
  render();
  return st;
}

/** 动作之后：更新提示、判定胜负、存档。 */
function afterAction() {
  const ev = st.events;
  if (ev && ev.type === 'merge') {
    setMsg(describeEvents(st), 'ok');
  } else if (ev && ev.type === 'undo') {
    setMsg('已撤销一步', 'dim');
  } else if (ev && ev.type === 'wait') {
    setMsg('等来了一只 ' + beastName(ev.drops[0].level), 'dim');
  }
  if (st.over) {
    const reason = st.overReason;
    if (reason === 'win') {
      setMsg('合成出 ' + beastName(st.best) + ' —— 赢了！', 'ok');
    } else if (reason === 'steps') {
      setMsg('步数用完了', 'warn');
    } else {
      setMsg('棋盘塞满又合不动了', 'warn');
    }
    showOver(reason);
    saveScore(st.won);
  }
}

/* ---------------------------------------------------------------------------
 * 渲染
 * ------------------------------------------------------------------------- */

/** 棋盘格子元素（惰性创建）。 */
const cellEls = [];
function boardEl() { return $('board'); }

/** 建一次棋盘 DOM（尺寸固定，后面只更新内容）。 */
function buildBoard() {
  const b = boardEl();
  b.innerHTML = '';
  cellEls.length = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.dataset.i = String(i);
    b.appendChild(c);
    cellEls.push(c);
  }
}

/** 生成一只神兽的 DOM。 */
function makeBlk(level, idx) {
  const info = beastOf(level);
  const d = document.createElement('div');
  d.className = 'blk';
  d.dataset.i = String(idx);
  d.dataset.level = String(level);
  d.style.background = 'linear-gradient(160deg,' + info.color + ',' + shade(info.color, -0.28) + ')';
  d.style.boxShadow = '0 2px 6px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.22),0 0 12px ' + info.glow;
  /* 底色太亮（金色的饕餮）就用深字，不然白字看不清 */
  if (isLight(info.color)) d.classList.add('ondark');
  const nm = document.createElement('span');
  nm.className = 'lv';
  nm.textContent = info.name;
  if (info.name.length >= 3) d.classList.add('long');
  const no = document.createElement('span');
  no.className = 'no';
  no.textContent = String(level);
  d.appendChild(nm);
  d.appendChild(no);
  return d;
}

/** 这个底色算不算「亮」（亮底要配深字）。 */
function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

/** 颜色变亮（amt>0）或变暗（amt<0）。 */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) {
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
  } else {
    r = Math.round(r * (1 + amt));
    g = Math.round(g * (1 + amt));
    b = Math.round(b * (1 + amt));
  }
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

/** 重放一次 CSS 动画（先摘掉 class 再加回去，强制 reflow）。 */
function replayAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function render() {
  if (!st) return;
  const board = st.board;

  for (let i = 0; i < cellEls.length; i++) {
    const cell = cellEls[i];
    const level = board[i];
    const old = lastBoard ? lastBoard[i] : undefined;
    const has = cell.firstElementChild;

    if (!level) {
      if (has) {
        /* 合成后来源格：淡出后移除 */
        const blk = has;
        replayAnim(blk, 'out');
        const cell2 = cell;
        setTimeout(() => { if (cell2.firstElementChild === blk) cell2.innerHTML = ''; }, 210);
      }
      continue;
    }

    if (!has) {
      /* 新飘落 / 合成结果：从上方滑入 */
      const blk = makeBlk(level, i);
      cell.appendChild(blk);
      replayAnim(blk, 'in');
    } else {
      const blk = has;
      if (Number(blk.dataset.level) !== level) {
        /* 合成升级：换成新阶并弹出 */
        const fresh = makeBlk(level, i);
        cell.innerHTML = '';
        cell.appendChild(fresh);
        replayAnim(fresh, 'pop');
      } else if (old !== undefined && old !== level) {
        replayAnim(blk, 'pop');
      }
    }

    /* 选中态 */
    const blk = cell.firstElementChild;
    if (blk) {
      blk.classList.toggle('sel', sel === i);
      blk.classList.toggle('dim', sel >= 0 && sel !== i && Number(blk.dataset.level) !== Number(board[sel]));
    }
  }

  lastBoard = board.slice();

  $('score').textContent = String(st.score);
  $('hint').textContent = hintText();
  $('btn-undo').disabled = st.history.length === 0;
  /* 「等一等」只在「没有对可合、但棋盘还没满」的时候出现 */
  $('btn-wait').hidden = !(st && !st.over && !hasMerge(st.board) && !isFull(st.board));
  renderCodex();
}

function hintText() {
  if (st.over) return '本局结束，点「新开一局」再来。';
  if (sel >= 0) {
    const lvl = st.board[sel];
    if (!lvl) return '再点一只同阶神兽就能合体。';
    return '已选中 ' + beastName(lvl) + '，再点一只同阶的（也可以直接拖过去）。';
  }
  if (!hasMerge(st.board) && !isFull(st.board)) {
    return '现在没有能合的一对 —— 点「等一等」，天上会再飘一只下来。';
  }
  return '拖动一只神兽到同阶的另一只上即可合成；也可以先点一只、再点另一只。';
}

/** 图鉴条：显示八阶神兽和当前盘面里的数量。 */
function renderCodex() {
  const box = $('codex');
  const counts = new Array(MAX_LEVEL + 1).fill(0);
  if (st) for (const v of st.board) if (v) counts[v]++;
  if (box.childElementCount === MAX_LEVEL) {
    /* 只更新数字，别每步重建 DOM */
    for (let i = 0; i < MAX_LEVEL; i++) {
      const n = box.children[i].querySelector('b');
      const c = counts[i + 1];
      n.textContent = c ? String(c) : '';
    }
    return;
  }
  box.innerHTML = '';
  BEASTS.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'cx';
    const dot = document.createElement('i');
    dot.style.background = b.color;
    const nm = document.createElement('span');
    nm.textContent = b.name;
    const n = document.createElement('b');
    n.textContent = counts[i + 1] ? String(counts[i + 1]) : '';
    d.appendChild(dot);
    d.appendChild(nm);
    d.appendChild(n);
    box.appendChild(d);
  });
}

/* ---------------------------------------------------------------------------
 * 交互：pointer 事件（鼠标 + 触摸统一）
 * ------------------------------------------------------------------------- */

/** 从事件里找出被按下的格子下标。 */
function cellFromEvent(e) {
  let el = e.target;
  while (el && el !== document.body) {
    if (el.classList && el.classList.contains('blk')) {
      const c = el.parentElement;
      if (c && c.dataset && c.dataset.i != null) return Number(c.dataset.i);
      return null;
    }
    if (el.classList && el.classList.contains('cell')) return Number(el.dataset.i);
    el = el.parentElement;
  }
  return null;
}

function onPointerDown(e) {
  if (!st || st.over) return;
  const i = cellFromEvent(e);
  if (i == null || !st.board[i]) return;
  e.preventDefault();
  drag = {
    i,
    x0: e.clientX,
    y0: e.clientY,
    moved: false,
    target: -1,
    ghost: null,
  };
  if (e.target.setPointerCapture) {
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
    drag.moved = true;
    startGhost(drag.i);
  }
  if (!drag.moved) return;
  e.preventDefault();

  /* 找到指针下的格子 */
  const under = document.elementFromPoint(e.clientX, e.clientY);
  let ti = -1;
  if (under) {
    let el = under;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('cell')) { ti = Number(el.dataset.i); break; }
      el = el.parentElement;
    }
  }
  if (ti !== drag.target) {
    drag.target = ti;
    highlightTargets(drag.i, ti);
  }
  if (drag.ghost) {
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  endGhost();
  highlightTargets(-1, -1);
  drag = null;

  if (!st || st.over) return;

  if (d.moved) {
    /* 拖动：落到目标格 */
    if (d.target >= 0 && d.target !== d.i && st.board[d.target]) {
      doAct({ act: 'merge', from: d.i, to: d.target });
    } else {
      setMsg('要放到同阶的另一只神兽上才能合体', 'dim');
    }
    return;
  }

  /* 点击：点一只、再点另一只 */
  if (sel === d.i) {
    sel = -1;
    render();
    return;
  }
  if (sel >= 0 && st.board[sel]) {
    const from = sel;
    sel = -1;
    if (from !== d.i) {
      doAct({ act: 'merge', from, to: d.i });
      return;
    }
  }
  sel = d.i;
  render();
}

/** 拖拽时把可落点标绿。 */
function highlightTargets(from, to) {
  for (let i = 0; i < cellEls.length; i++) {
    cellEls[i].classList.remove('drop-ok');
    cellEls[i].classList.remove('hl');
  }
  if (from < 0 || !st) return;
  if (to >= 0 && to !== from && st.board[to] && canMerge(st.board, from, to)) {
    if (cellEls[to]) cellEls[to].classList.add('drop-ok');
  }
}

/** 拖拽时跟随手指的半透明神兽。 */
function startGhost(i) {
  const lvl = st.board[i];
  const info = beastOf(lvl);
  const g = document.createElement('div');
  g.className = 'ghost';
  g.style.background = 'linear-gradient(160deg,' + info.color + ',' + shade(info.color, -0.28) + ')';
  g.textContent = info.name;
  document.body.appendChild(g);
  drag.ghost = g;
}

function endGhost() {
  if (!drag) return;
  if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
  drag.ghost = null;
}

/* ---------------------------------------------------------------------------
 * 开局 / 结束
 * ------------------------------------------------------------------------- */

function newGame() {
  const opts = optsForMode();
  const seed = seedForMode();
  base = { seed, opts };
  acts = [];
  sel = -1;
  lastBoard = null;
  st = initState(seed, opts);
  $('over').hidden = true;
  render();
  if (mode === 'daily') {
    setMsg('今日盘面已就绪（' + todayKey() + '）—— 当天所有人都一样', 'dim');
  } else if (mode === 'challenge') {
    setMsg('步数挑战：' + opts.maxMoves + ' 步内合出 ' + beastName(opts.target), 'dim');
  } else {
    setMsg('自由对局：合出 ' + beastName(opts.target) + ' 即胜', 'dim');
  }
  saveMeta();
}

function showOver(reason) {
  const o = $('over');
  $('over-title').textContent = reason === 'win' ? '合成成功！' : '本局结束';
  $('over-score').textContent = String(st.score);
  $('over-desc').textContent = reason === 'win'
    ? ('合成出 ' + beastName(st.best) + '，用 ' + st.moves + ' 步')
    : (reason === 'steps'
      ? ('步数用尽（' + st.moves + ' 步），最高 ' + beastName(topLevel(st.board)))
      : ('棋盘塞满，最高档停在 ' + beastName(topLevel(st.board))));
  o.hidden = false;
}

/* ---------------------------------------------------------------------------
 * 存档
 * ------------------------------------------------------------------------- */
const SAVE_KEY = 'mg_shanhai-merge.v1';

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { best: 0, wins: 0, dailySeed: 0, dailyDate: '', mode: 'daily', target: 5 };
    const o = JSON.parse(raw) || {};
    return {
      best: o.best || 0,
      wins: o.wins || 0,
      dailySeed: o.dailySeed || 0,
      dailyDate: o.dailyDate || '',
      mode: o.mode || 'daily',
      target: o.target || 5,
    };
  } catch (e) {
    return { best: 0, wins: 0, dailySeed: 0, dailyDate: '', mode: 'daily', target: 5 };
  }
}

function writeSave(o) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(o)); } catch (e) { /* file:// 下可能抛 */ }
}

/** 只存模式、目标、每日种子 —— 这些是「下次继续」要用的。 */
function saveMeta() {
  const s = loadSave();
  s.mode = mode;
  s.target = parseInt($('target').value, 10) || 5;
  if (mode === 'daily') { s.dailySeed = st.seed; s.dailyDate = todayKey(); }
  writeSave(s);
}

/** 结算：最高分 + 胜局数。 */
function saveScore(won) {
  const s = loadSave();
  if (st.score > s.best) s.best = st.score;
  if (won) s.wins += 1;
  writeSave(s);
  renderBar();
}

function renderBar() {
  const s = loadSave();
  $('best').textContent = String(s.best);
  $('wins').textContent = String(s.wins);
}

/* ---------------------------------------------------------------------------
 * 提示条
 * ------------------------------------------------------------------------- */
function setMsg(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg' + (cls ? ' ' + cls : '');
}

/* ---------------------------------------------------------------------------
 * 启动段（模块底部统一做，顶层不碰 DOM）
 * ------------------------------------------------------------------------- */
function boot() {
  buildBoard();

  const board = boardEl();
  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('pointermove', onPointerMove);
  board.addEventListener('pointerup', onPointerUp);
  board.addEventListener('pointercancel', function () { endGhost(); drag = null; });  /* 防止拖动时页面滚动 / 选中文字 */
  board.addEventListener('touchmove', function (e) { if (drag && drag.moved) e.preventDefault(); }, { passive: false });
  board.addEventListener('contextmenu', function (e) { if (drag) e.preventDefault(); });

  $('btn-new').addEventListener('click', newGame);
  $('btn-again').addEventListener('click', newGame);
  $('btn-undo').addEventListener('click', () => {
    if (!st || !st.history.length) { setMsg('没有可撤销的步骤', 'dim'); return; }
    doAct({ act: 'undo' });
    $('over').hidden = true;
  });
  $('btn-info').addEventListener('click', () => { $('info').hidden = false; });
  $('info-close').addEventListener('click', () => { $('info').hidden = true; });
  $('btn-wait').addEventListener('click', () => { doAct({ act: 'wait' }); });

  const setMode = (m) => {
    mode = m;
    $('mode-daily').classList.toggle('on', m === 'daily');
    $('mode-free').classList.toggle('on', m === 'free');
    $('mode-challenge').classList.toggle('on', m === 'challenge');
    $('movelimit').disabled = (m !== 'challenge');
    $('modehint').textContent = m === 'daily'
      ? '今日盘面人人相同，可比分数'
      : (m === 'challenge' ? '步数用完即失败' : '换个种子，随便玩');
    newGame();
  };
  $('mode-daily').addEventListener('click', () => setMode('daily'));
  $('mode-free').addEventListener('click', () => setMode('free'));
  $('mode-challenge').addEventListener('click', () => setMode('challenge'));

  $('target').addEventListener('change', newGame);
  $('movelimit').addEventListener('change', newGame);

  /* 恢复上次的模式与目标 */
  const s = loadSave();
  if (s.target) $('target').value = String(s.target);
  mode = s.mode || 'daily';
  $('mode-daily').classList.toggle('on', mode === 'daily');
  $('mode-free').classList.toggle('on', mode === 'free');
  $('mode-challenge').classList.toggle('on', mode === 'challenge');
  $('movelimit').disabled = (mode !== 'challenge');

  renderBar();
  newGame();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
