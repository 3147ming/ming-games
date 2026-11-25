/* =============================================================================
 * party-tools/src/main.mjs —— 聚会工具箱主控
 * -----------------------------------------------------------------------------
 * 五件套：随机分组 / 多面骰 / 转盘 / 抽签 / 计分板。
 * 全部纯前端、离线可用、数据只存本机 localStorage。
 *
 * 纪律：所有 localStorage 读写都 try/catch（隐私模式不炸）。
 * ========================================================================== */

const $ = (id) => document.getElementById(id);

/* ---- 通用：名字解析（一行一个，或逗号/顿号/空格分隔） ---- */
function parseNames(text) {
  const raw = String(text || '');
  const byLine = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (byLine.length > 1) return byLine;
  /* 只有一行时按分隔符拆 */
  return raw.split(/[,，、;；\t]+/).map((s) => s.trim()).filter(Boolean);
}

/* ---- 通用：洗牌（Fisher–Yates） ---- */
function shuffle(arr, rnd) {
  const a = arr.slice();
  const r = rnd || Math.random;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ---- 通用：随机整数（含两端） ---- */
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/* =============================================================================
 * Tab 切换
 * ========================================================================== */
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.tab;
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    panels.forEach((p) => p.classList.toggle('on', p.id === 'p-' + id));
  });
});

/* =============================================================================
 * 1. 随机分组
 * ========================================================================== */
function doSplit() {
  const names = parseNames($('split-names').value);
  const groups = Math.max(1, Math.min(20, parseInt($('split-n').value, 10) || 1));
  const leaderCount = Math.max(0, Math.min(20, parseInt($('split-leader').value, 10) || 0));
  const out = $('split-out');

  if (!names.length) { out.textContent = '先把名单粘进来。'; return; }

  const shuffled = shuffle(names);
  const buckets = [];
  for (let i = 0; i < groups; i++) buckets.push([]);

  /* 轮流发牌：这样各组人数最多差 1，比一次性切块均匀。 */
  shuffled.forEach((n, i) => buckets[i % groups].push(n));

  /* 组长：从每组里各挑一人（也可以从全局挑），放到组首。 */
  const leaders = [];
  if (leaderCount > 0) {
    const pool = shuffled.slice();
    for (let i = 0; i < leaderCount && pool.length; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      leaders.push(pool.splice(idx, 1)[0]);
    }
    /* 把组长换回自己组（换不了就算了 —— 分组已经定了，组长只是标记）。 */
    leaders.forEach((leader, gi) => {
      const gi2 = gi % groups;
      const from = buckets.findIndex((b) => b.includes(leader));
      if (from >= 0 && from !== gi2) {
        buckets[from].splice(buckets[from].indexOf(leader), 1);
        buckets[gi2].push(leader);
      }
    });
  }

  let html = '';
  buckets.forEach((b, i) => {
    if (!b.length) return;
    const leader = leaders[i] || '';
    html += '<div class="grp"><b>第 ' + (i + 1) + ' 组' +
      (leader ? ' · 组长：' + esc(leader) : '') + '</b><span>' +
      esc(b.join('、')) + '</span></div>';
  });
  out.innerHTML = '<div class="groups">' + html + '</div>';
  out.style.minHeight = '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

$('split-go').addEventListener('click', doSplit);
$('split-clear').addEventListener('click', () => {
  $('split-names').value = '';
  $('split-out').textContent = '粘上名单就能分。';
});

/* =============================================================================
 * 2. 多面骰
 * ========================================================================== */
const FACES = [2, 3, 4, 6, 8, 10, 12, 20, 100];
let diceFaces = 6;
const facesHost = $('dice-faces');
FACES.forEach((f) => {
  const b = document.createElement('button');
  b.className = 'pill';
  b.type = 'button';
  b.textContent = 'D' + f;
  b.setAttribute('aria-pressed', String(f === diceFaces));
  b.addEventListener('click', () => {
    diceFaces = f;
    facesHost.querySelectorAll('.pill').forEach((x) => {
      x.setAttribute('aria-pressed', String(x.textContent === 'D' + f));
    });
  });
  facesHost.appendChild(b);
});

function doDice() {
  const count = Math.max(1, Math.min(20, parseInt($('dice-count').value, 10) || 1));
  const mod = Math.max(0, Math.min(99, parseInt($('dice-mod').value, 10) || 0));
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(randInt(1, diceFaces));
  let shown = rolls.slice();
  if (mod > 0) shown = shown.map((v) => v % mod);
  const sum = shown.reduce((a, b) => a + b, 0);
  const label = count + 'd' + diceFaces + (mod ? ' mod ' + mod : '');
  $('dice-out').textContent = count > 1 ? String(sum) : String(shown[0]);
  $('dice-detail').textContent = label + ' → ' + shown.join(' + ') + ' = ' + sum;
}
$('dice-go').addEventListener('click', doDice);

/* =============================================================================
 * 3. 转盘
 * ========================================================================== */
const wheelCv = $('wheel-cv');
const wctx = wheelCv.getContext('2d');
let wheelAngle = 0;
let wheelSpinning = false;

/** 解析转盘选项，支持「名称*次数」设权重。 */
function parseWheelItems(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  lines.forEach((line) => {
    const m = line.match(/^(.*?)\s*[*x×]\s*(\d+)$/);
    if (m) {
      const n = Math.max(1, Math.min(50, parseInt(m[2], 10) || 1));
      for (let i = 0; i < n; i++) out.push(m[1].trim() || '选项');
    } else {
      out.push(line);
    }
  });
  return out;
}

const WHEEL_COLORS = ['#c8963e', '#7ee0c0', '#ff9f9f', '#a89ae6', '#8ff0b5', '#f0a76e', '#6fc2ef', '#e8b45a'];

function drawWheel(items) {
  const W = wheelCv.width, H = wheelCv.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 6;
  wctx.clearRect(0, 0, W, H);
  if (!items.length) {
    wctx.fillStyle = '#2b231a';
    wctx.beginPath(); wctx.arc(cx, cy, R, 0, Math.PI * 2); wctx.fill();
    wctx.fillStyle = '#8d8378';
    wctx.font = '600 26px system-ui,sans-serif';
    wctx.textAlign = 'center'; wctx.textBaseline = 'middle';
    wctx.fillText('先填选项', cx, cy);
    return;
  }
  const step = (Math.PI * 2) / items.length;
  items.forEach((label, i) => {
    const a0 = wheelAngle + i * step - Math.PI / 2;
    const a1 = a0 + step;
    wctx.beginPath();
    wctx.moveTo(cx, cy);
    wctx.arc(cx, cy, R, a0, a1);
    wctx.closePath();
    wctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
    wctx.fill();
    wctx.strokeStyle = 'rgba(20,14,8,.5)';
    wctx.lineWidth = 2;
    wctx.stroke();
    /* 文字 */
    const am = (a0 + a1) / 2;
    wctx.save();
    wctx.translate(cx + Math.cos(am) * R * 0.62, cy + Math.sin(am) * R * 0.62);
    wctx.rotate(am + Math.PI / 2);
    wctx.fillStyle = '#241b10';
    wctx.font = '600 ' + Math.max(14, Math.min(26, 150 / items.length)) + 'px "PingFang SC",system-ui,sans-serif';
    wctx.textAlign = 'center'; wctx.textBaseline = 'middle';
    const t = label.length > 6 ? label.slice(0, 5) + '…' : label;
    wctx.fillText(t, 0, 0);
    wctx.restore();
  });
  /* 中心 */
  wctx.beginPath(); wctx.arc(cx, cy, 26, 0, Math.PI * 2);
  wctx.fillStyle = '#241b10'; wctx.fill();
  wctx.strokeStyle = '#c8963e'; wctx.lineWidth = 3; wctx.stroke();
}

function spinWheel() {
  if (wheelSpinning) return;
  const items = parseWheelItems($('wheel-items').value);
  if (!items.length) { $('wheel-out').textContent = '先填几个选项'; return; }
  wheelSpinning = true;
  /* 转到哪一格：pointer 在正上方（-90°），所以目标格索引 = -angle/step */
  const step = (Math.PI * 2) / items.length;
  const pick = randInt(0, items.length - 1);
  const target = -pick * step + (Math.random() * 0.6 - 0.3) * step;
  const turns = 5 + Math.floor(Math.random() * 3);
  const from = wheelAngle;
  const to = target + turns * Math.PI * 2;
  const dur = 2600;
  const t0 = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - t0) / dur);
    /* easeOutQuart：先快后慢，像真的转盘 */
    const e = 1 - Math.pow(1 - t, 4);
    wheelAngle = from + (to - from) * e;
    drawWheel(items);
    if (t < 1) requestAnimationFrame(frame);
    else {
      wheelSpinning = false;
      const label = items[pick];
      $('wheel-out').textContent = label;
      const log = $('wheel-log');
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      log.textContent = time + ' → ' + label + '\n' + log.textContent;
    }
  }
  requestAnimationFrame(frame);
}
$('wheel-go').addEventListener('click', spinWheel);
$('wheel-items').addEventListener('input', () => drawWheel(parseWheelItems($('wheel-items').value)));
drawWheel(parseWheelItems($('wheel-items').value));

/* =============================================================================
 * 4. 抽签
 * ========================================================================== */
let drawPool = [];
let drawNoRepeat = true;

function refreshPool() {
  drawPool = parseNames($('draw-items').value);
  $('draw-pool').textContent = drawPool.length
    ? '池子里还有 ' + drawPool.length + ' 个。'
    : '池子是空的。';
}
$('draw-items').addEventListener('input', refreshPool);
refreshPool();

function doDraw() {
  if (!drawPool.length) refreshPool();
  if (!drawPool.length) { $('draw-out').textContent = '先填名单'; return; }
  const n = Math.max(1, Math.min(50, parseInt($('draw-n').value, 10) || 1));
  const picked = [];
  for (let i = 0; i < n; i++) {
    if (!drawPool.length) break;
    const idx = Math.floor(Math.random() * drawPool.length);
    const name = drawPool.splice(idx, 1)[0];
    picked.push(name);
    if (!drawNoRepeat) drawPool.push(name);   /* 可重复：放回去 */
  }
  $('draw-out').textContent = picked.join('、');
  refreshPool();
}
$('draw-go').addEventListener('click', doDraw);
$('draw-reset').addEventListener('click', () => { refreshPool(); $('draw-out').textContent = '—'; });
$('draw-norep').addEventListener('click', () => {
  drawNoRepeat = true;
  $('draw-norep').setAttribute('aria-pressed', 'true');
  $('draw-rep').setAttribute('aria-pressed', 'false');
});
$('draw-rep').addEventListener('click', () => {
  drawNoRepeat = false;
  $('draw-norep').setAttribute('aria-pressed', 'false');
  $('draw-rep').setAttribute('aria-pressed', 'true');
});

/* =============================================================================
 * 5. 计分板
 * ========================================================================== */
const SCORE_KEY = 'ming.partytools.score.v1';

function loadScores() {
  try {
    const raw = localStorage.getItem(SCORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.name === 'string') : [];
  } catch (e) { return []; }
}
function saveScores(list) {
  try { localStorage.setItem(SCORE_KEY, JSON.stringify(list)); } catch (e) { /* 隐私模式 */ }
}
let scores = loadScores();

function renderScores() {
  const tb = $('score-rows');
  if (!scores.length) {
    tb.innerHTML = '<tr><td colspan="4" style="opacity:.6;padding:16px 8px">还没有人 —— 上面加一个。</td></tr>';
    return;
  }
  tb.innerHTML = '';
  scores.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="n"><input type="text" value="' + esc(p.name) + '" data-i="' + i + '" data-f="name" maxlength="12"></td>' +
      '<td class="s"><input type="number" value="' + (Number(p.score) || 0) + '" data-i="' + i + '" data-f="score"></td>' +
      '<td class="d"><button type="button" data-inc="1" data-i="' + i + '">+1</button></td>' +
      '<td class="d"><button type="button" data-inc="-1" data-i="' + i + '">−1</button></td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const i = Number(inp.dataset.i);
      const f = inp.dataset.f;
      if (f === 'score') scores[i].score = Number(inp.value) || 0;
      else scores[i].name = inp.value.trim() || ('玩家' + (i + 1));
      saveScores(scores);
    });
  });
  tb.querySelectorAll('button[data-inc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      scores[i].score = (Number(scores[i].score) || 0) + Number(btn.dataset.inc);
      saveScores(scores);
      renderScores();
    });
  });
}

$('score-add-go').addEventListener('click', () => {
  const name = $('score-add').value.trim();
  if (!name) return;
  scores.push({ name: name, score: 0 });
  saveScores(scores);
  $('score-add').value = '';
  renderScores();
});
$('score-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('score-add-go').click(); });
$('score-clear').addEventListener('click', () => {
  scores.forEach((p) => { p.score = 0; });
  saveScores(scores);
  renderScores();
});
$('score-remove').addEventListener('click', () => {
  scores.pop();
  saveScores(scores);
  renderScores();
});
$('score-wipe').addEventListener('click', () => {
  scores = [];
  saveScores(scores);
  renderScores();
});
renderScores();
