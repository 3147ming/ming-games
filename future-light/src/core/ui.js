// 弹窗 / 提示系统：统一结算弹窗、菜单、toast
// 统一图标语义：⭐ 星星(得分) / 🚩 旗帜(进度) / ❤️ 红心(生命)
export const ICONS = { star: '⭐', flag: '🚩', heart: '❤️' };

let overlayEl = null;

export function initUI(root) {
  overlayEl = document.createElement('div');
  overlayEl.className = 'overlay';
  overlayEl.style.display = 'none';
  root.appendChild(overlayEl);
}

function open(html) {
  overlayEl.innerHTML = `<div class="modal result-wrap">${html}</div>`;
  overlayEl.style.display = 'flex';
}
export function closeOverlay() {
  if (!overlayEl) return;
  overlayEl.style.display = 'none';
  overlayEl.innerHTML = '';
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 1500);
}

function starsHtml(n) {
  return [1, 2, 3]
    .map(i => `<span class="star ${i <= n ? 'on' : ''}">★</span>`)
    .join('');
}

/**
 * 统一结算弹窗
 * @param {object} o
 *   type: 'win' | 'lose'
 *   stars: 1~3
 *   score: 本局得分（win 时展示）
 *   best: 历史最佳（win 时展示对比）
 *   isRecord: 是否破纪录
 *   coins: 金币奖励（win 时展示）
 *   hasNext: 是否有下一关
 *   onRetry / onHome / onNext
 */
export function showResult({ type = 'win', stars = 1, score = 0, best = 0, isRecord = false, coins = 0, hasNext = false, onRetry, onHome, onNext }) {
  const win = type === 'win';
  const title = win ? '挑战成功' : '挑战失败';
  const medal = win ? '🏆' : '💥';
  const bestLine = win
    ? (isRecord
        ? `<div class="result-best rec">${ICONS.star} 新纪录！</div>`
        : `<div class="result-best">最佳成绩：${best}</div>`)
    : `<p class="modal-sub">未达成关卡目标</p>`;
  const scoreBlock = win
    ? `<div class="result-score">${score}</div>
       <div class="result-score-label">本局得分</div>
       ${bestLine}`
    : bestLine;
  open(`
    <div class="result-head ${win ? 'win' : 'lose'}">
      <div class="medal">${medal}</div>
      <h2 class="modal-title ${win ? 'win' : 'lose'}">${title}</h2>
    </div>
    <div class="result-stars">${starsHtml(stars)}</div>
    ${scoreBlock}
    ${win ? `<div class="reward">+${coins} 🪙 金币</div>` : ''}
    <div class="modal-btns">
      <button class="btn primary" id="m-retry">${win ? '再来一次' : '重试'}</button>
      ${win && hasNext ? '<button class="btn next" id="m-next">下一关 ›</button>' : ''}
      <button class="btn" id="m-home">返回菜单</button>
    </div>`);
  overlayEl.querySelector('#m-retry').onclick = () => { closeOverlay(); onRetry && onRetry(); };
  if (win && hasNext) overlayEl.querySelector('#m-next').onclick = () => { closeOverlay(); onNext && onNext(); };
  overlayEl.querySelector('#m-home').onclick = () => { closeOverlay(); onHome && onHome(); };
}

// 兼容旧调用
export function showWin(o) { return showResult(Object.assign({ type: 'win' }, o)); }
export function showLose(o) { return showResult(Object.assign({ type: 'lose' }, o)); }

export function showMenu({ onResume, onRestart, onHome }) {
  open(`
    <h2 class="modal-title">菜单</h2>
    <div class="modal-btns col">
      <button class="btn primary" id="m-resume">继续游戏</button>
      <button class="btn" id="m-restart">重新开始</button>
      <button class="btn ghost" id="m-home">退出关卡</button>
    </div>`);
  overlayEl.querySelector('#m-resume').onclick = () => { closeOverlay(); onResume && onResume(); };
  overlayEl.querySelector('#m-restart').onclick = () => { closeOverlay(); onRestart && onRestart(); };
  overlayEl.querySelector('#m-home').onclick = () => { closeOverlay(); onHome && onHome(); };
}
