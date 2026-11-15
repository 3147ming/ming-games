/**
 * stage6-panels.js — 阶段 6 面板层（R12 录像回放 / 成就 / 排行榜）
 *
 * 纯 DOM API 构建，所有应用能力通过 ctx 注入（与 stage5-panels 同一套路）：
 * ctx = {
 *   openModal(title, build), toast(msg, kind),
 *   model(),            // model.js 命名空间（回放要 addComponent 等）
 *   expId(),            // 当前实验 id
 *   platform(),         // 当前平台 id
 *   applyCircuit(data, label),
 *   recorder(),         // recorder.js 的 createRecorder 实例
 *   recordOps(),        // 当前内存里的操作数组（不落盘）
 *   loadOps(ops),       // 回放用：把一组操作灌进当前录像（导入用）
 *   clearOps(),
 *   flushRecord(),      // 立刻落盘
 *   download(name, text),
 *   pickText(),         // 选文件的 Promise<string|null>（导入用）
 *   exps(), progress(),
 *   achievements(), gamifyState(), track(event, fields)
 * }
 */
import {
  createPlayer, exportRecord, importRecord, summarize, opLabel, RECORD_MAX,
} from './recorder.js';
import {
  ACHIEVEMENTS, achievementProgress, buildLeaderboard,
} from './gamify.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

const button = (label, className, onClick) => {
  const b = el('button', className || 'btn btn-ghost', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

function fmtTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ==========================================================================
   R12 录像回放
   ========================================================================== */

/**
 * 打开录像面板：列表 + 回放控件（播放/暂停/步进/速度）+ 导出导入。
 * 回放前会备份当前电路，关闭面板时自动还原，避免把演示电路留在画布上。
 */
export function openRecorder(ctx) {
  const expId = ctx.expId();
  if (!expId) {
    if (typeof ctx.toast === 'function') ctx.toast('请先进入一个实验', 'error');
    return;
  }
  const ops0 = typeof ctx.recordOps === 'function' ? ctx.recordOps() : [];
  const backup = ctx.model() && ctx.model().serializeCircuit
    ? ctx.model().serializeCircuit() : null;
  let restored = false;

  ctx.openModal('操作录像与回放', (body, actions, dismiss, closeBtn) => {
    const sum = summarize(ops0);
    const lead = el('p', 'info-modal-lead',
      `实验 ${expId} · 已记录 ${sum.total} 条操作 · 时长 ${fmtTime(sum.durationMs)} · 上限 ${RECORD_MAX} 条`);
    body.append(lead);

    const hint = el('p', 'rec-hint',
      '回放会把画布逐步还原成当时的操作序列；关闭本面板会自动恢复你回放前的电路。');
    body.append(hint);

    // 操作列表（最近 60 条，倒序，便于看"刚刚做了什么"）
    const listBox = el('div', 'rec-list');
    const recent = ops0.slice(-60).reverse();
    if (recent.length === 0) {
      listBox.append(el('p', 'rec-empty', '还没有记录到操作。放置元件、连线、拨开关、改参数都会被记录。'));
    } else {
      recent.forEach((op) => {
        const row = el('div', 'rec-row');
        row.append(
          el('span', 'rec-t', fmtTime(op.t || 0)),
          el('span', 'rec-type', opLabel(op.type)),
          el('span', 'rec-detail', op.payload && (op.payload.type || op.payload.componentId || op.payload.wireId)
            ? String(op.payload.type || op.payload.componentId || op.payload.wireId) : ''),
        );
        listBox.append(row);
      });
    }
    body.append(listBox);

    /* ---- 回放控件 ---- */
    const ctl = el('div', 'rec-ctl');
    const playBtn = button('▶ 播放', 'btn btn-primary', () => togglePlay());
    const stepBtn = button('⏭ 步进', 'btn btn-ghost', () => {
      stopPlay();
      const res = player.step();
      afterStep(res);
    });
    const resetBtn = button('⏮ 重头', 'btn btn-ghost', () => {
      stopPlay();
      resetToEmpty();
      player.reset();
      renderProgress();
      afterStep({ ok: true });
    });
    const speedSel = el('select', 'rec-select');
    [0.5, 1, 2, 4].forEach((s) => {
      const opt = el('option', '', `${s}x`);
      opt.value = String(s);
      if (s === 1) opt.selected = true;
      speedSel.append(opt);
    });
    const progress = el('span', 'rec-progress', `0/${ops0.length}`);
    ctl.append(playBtn, stepBtn, resetBtn, speedSel, progress);
    body.append(ctl);

    const status = el('p', 'rec-status', '');
    body.append(status);

    let player = createPlayer(ops0, ctx.model());
    let timer = 0;
    let playing = false;
    let speed = 1;

    function renderProgress() {
      progress.textContent = `${player.index}/${player.total}`;
    }

    function afterStep(res) {
      renderProgress();
      if (res && res.ok === false) status.textContent = `跳过一步：${res.error || '无法应用'}`;
      else status.textContent = player.done ? '回放结束' : '回放中…';
      if (ctx.model() && ctx.model().getState) {
        // 让 board 重画：applyCircuit 只负责装载，逐步回放需要主动触发一帧
        const board = window.__labBoard;
        if (board && board.requestRender) board.requestRender();
      }
    }

    function resetToEmpty() {
      const platform = typeof ctx.platform === 'function' ? ctx.platform() : 'exp-box';
      ctx.applyCircuit({ platform, components: [], wires: [] }, '回放起点');
    }

    function stopPlay() {
      playing = false;
      playBtn.textContent = '▶ 播放';
      if (timer) { window.clearInterval(timer); timer = 0; }
    }

    function togglePlay() {
      if (playing) { stopPlay(); return; }
      if (player.done) {
        resetToEmpty();
        player.reset();
      }
      playing = true;
      playBtn.textContent = '⏸ 暂停';
      const interval = Math.max(40, Math.round(320 / speed));
      timer = window.setInterval(() => {
        const res = player.step();
        afterStep(res);
        if (!res || player.done) stopPlay();
      }, interval);
    }

    speedSel.addEventListener('change', () => {
      speed = Number(speedSel.value) || 1;
      if (playing) { stopPlay(); togglePlay(); }
    });

    /* ---- 导出 / 导入 / 清空 ---- */
    const fileRow = el('div', 'info-form-row');
    fileRow.append(
      button('导出 JSON', 'btn btn-ghost', () => {
        ctx.flushRecord();
        const text = exportRecord(ops0, { expId, title: expId });
        if (typeof ctx.download === 'function') ctx.download(`录像-${expId}.json`, text);
        ctx.toast(`已导出 ${ops0.length} 条操作`, 'success');
      }),
      button('导入 JSON', 'btn btn-ghost', async () => {
        if (typeof ctx.pickText !== 'function') return;
        const text = await ctx.pickText();
        if (!text) return;
        const res = importRecord(text);
        if (!res.ok) { ctx.toast(`导入失败：${res.error}`, 'error'); return; }
        if (typeof ctx.loadOps === 'function') ctx.loadOps(res.ops);
        player = createPlayer(res.ops, ctx.model());
        renderProgress();
        status.textContent = `已导入 ${res.ops.length} 条操作，点「播放」开始回放`;
        ctx.toast(`已导入 ${res.ops.length} 条操作`, 'success');
      }),
      button('清空录像', 'btn btn-ghost', () => {
        if (typeof ctx.clearOps === 'function') ctx.clearOps();
        player = createPlayer([], ctx.model());
        listBox.replaceChildren(el('p', 'rec-empty', '录像已清空'));
        renderProgress();
        ctx.toast('录像已清空', 'info');
      }),
    );
    body.append(fileRow);

    function restoreBackup() {
      if (restored || !backup) return;
      restored = true;
      if (typeof ctx.applyCircuit === 'function') ctx.applyCircuit(backup, '已还原回放前的电路');
    }
    if (closeBtn) closeBtn.addEventListener('click', () => { stopPlay(); restoreBackup(); });
    if (typeof dismiss === 'function') {
      // 遮罩点击 / Esc 关闭同样还原
      const observer = new MutationObserver(() => {
        if (!document.body.contains(body)) { stopPlay(); restoreBackup(); observer.disconnect(); }
      });
      observer.observe(document.body, { childList: true, subtree: false });
    }
    renderProgress();
  });
}

/* ==========================================================================
   R12 成就墙 + 本地排行榜
   ========================================================================== */

export function openAchievements(ctx) {
  ctx.openModal('成就与排行榜', (body, actions, dismiss, closeBtn) => {
    const ach = typeof ctx.achievements === 'function' ? ctx.achievements() : {};
    const state = typeof ctx.gamifyState === 'function' ? ctx.gamifyState() : { points: 0 };
    const prog = achievementProgress(ach);

    const head = el('div', 'ach-head');
    head.append(
      el('strong', 'ach-points', `成就点 ${state.points || 0}`),
      el('span', 'ach-progress', `徽章 ${prog.done}/${prog.total}（${prog.percent}%）`),
    );
    const bar = el('div', 'ach-bar');
    const fill = el('i', 'ach-bar-fill');
    fill.style.width = `${prog.percent}%`;
    bar.append(fill);
    head.append(bar);
    body.append(head);

    const grid = el('div', 'ach-grid');
    ACHIEVEMENTS.forEach((item) => {
      const on = Boolean(ach[item.id]);
      const card = el('div', `ach-card${on ? ' is-on' : ''}`);
      card.dataset.achId = item.id;
      card.dataset.on = on ? '1' : '0';
      card.append(
        el('span', 'ach-icon', on ? item.icon : '🔒'),
        el('span', 'ach-title', item.title),
        el('span', 'ach-desc', item.desc),
      );
      grid.append(card);
    });
    body.append(grid);

    // 本地排行榜
    const board = buildLeaderboard(
      typeof ctx.exps === 'function' ? ctx.exps() : [],
      typeof ctx.progress === 'function' ? ctx.progress() : {},
    );
    const lbTitle = el('h3', 'ach-subtitle', `本地排行（已完成 ${board.doneCount}/${board.total}）`);
    body.append(lbTitle);
    const table = el('table', 'info-table ach-table');
    const thead = el('thead');
    const hr = el('tr');
    ['#', '实验', '状态', '难度'].forEach((t) => hr.append(el('th', '', t)));
    thead.append(hr);
    table.append(thead);
    const tbody = el('tbody');
    board.rows.slice(0, 12).forEach((row, index) => {
      const tr = el('tr');
      if (row.done) tr.className = 'is-done';
      tr.append(
        el('td', '', String(index + 1)),
        el('td', '', row.title),
        el('td', '', row.done ? '已完成' : (row.opened ? '进行中' : '未开始')),
        el('td', '', readStars(row.difficulty)),
      );
      tbody.append(tr);
    });
    table.append(tbody);
    body.append(table);

    if (typeof closeBtn === 'function') void closeBtn;
    void actions;
    void dismiss;
  });
}

function readStars(n) {
  const k = Math.max(1, Math.min(5, Number(n) || 1));
  return '★'.repeat(k);
}
