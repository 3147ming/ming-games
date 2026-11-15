/**
 * stage5-panels.js — 阶段 5 面板层（R14 题库 / R17 版本管理）
 *
 * 纯 DOM API 构建，不 innerHTML 拼接。所有应用能力通过 ctx 注入，
 * 本模块只依赖 question-bank / versions 两个纯函数层，便于独立替换。
 *
 * ctx = {
 *   openModal(title, build), toast(msg, kind), model(), expId(),
 *   applyCircuit(circuit, label), openExperiment(expId),
 *   getExample(id), measure(modelApi, example), track(event, fields)
 * }
 */
import {
  QUESTIONS, filterQuestions, dailyQuestion, questionById, gradeQuestion, questionTags,
} from './question-bank.js';
import {
  listVersions, saveVersion, getVersion, deleteVersion, diffVersions,
  autoVersionName, versionSummary, VERSION_LIMIT,
} from './versions.js';

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

function insertAction(actions, closeBtn, label, handler, primary = true) {
  const b = button(label, primary ? 'btn btn-primary' : 'btn btn-ghost', handler);
  actions.insertBefore(b, closeBtn);
  return b;
}

/* ==========================================================================
   R14 题库 / 答题 / 自动评分
   ========================================================================== */

function autoCircuitRatio(ctx, question) {
  const modelApi = ctx.model();
  const example = ctx.getExample(question.exampleId);
  if (!modelApi || !example) return 0;
  try {
    const m = ctx.measure(modelApi, example);
    if (!m || !Array.isArray(m.items) || m.items.length === 0) return 0;
    return m.items.filter((i) => i.pass).length / m.items.length;
  } catch (_) {
    return 0;
  }
}

function renderQuestionDetail(host, question, ctx) {
  host.replaceChildren();
  const head = el('div', 'qb-detail-head');
  head.append(el('h3', 'qb-detail-title', question.title));
  head.append(el('span', 'qb-badge', `难度 ${question.difficulty}`));
  host.append(head);
  host.append(el('p', 'qb-desc', question.desc));
  host.append(el('p', 'qb-expected', `参考答案：${question.expected}`));
  host.append(el('p', 'qb-hint', `提示：${question.hint}`));

  const checks = {};
  const cpHost = el('div', 'qb-checkpoints');
  question.checkpoints.forEach((cp) => {
    const row = el('label', 'qb-check-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.addEventListener('change', () => { checks[cp.key] = cb.checked; });
    row.append(cb, el('span', 'qb-check-label', cp.label), el('span', 'qb-weight', `${cp.weight} 分`));
    cpHost.append(row);
  });
  host.append(cpHost);

  const bar = el('div', 'qb-actions');
  bar.append(button('用当前电路自动评分', 'btn btn-ghost', () => {
    const ratio = autoCircuitRatio(ctx, question);
    checks.circuit = ratio;
    const cb = cpHost.querySelectorAll('input[type=checkbox]');
    const last = cb[cb.length - 1];
    if (last) { last.checked = ratio >= 1; last.indeterminate = ratio > 0 && ratio < 1; }
    result.textContent = ratio > 0
      ? `自动评分：电路检查点完成度 ${Math.round(ratio * 100)}%（关联实验 ${question.exampleId}）`
      : '自动评分：未检测到通过项，请先打开关联实验并搭好电路';
  }));
  bar.append(button('进入关联实验', 'btn btn-ghost', () => {
    if (typeof ctx.openExperiment === 'function') ctx.openExperiment(question.exampleId);
  }));
  bar.append(button('计算总分', 'btn btn-primary', () => {
    const g = gradeQuestion(question, checks);
    result.replaceChildren();
    result.append(el('strong', 'qb-score', `${g.score} / ${g.total} 分 · ${g.verdict}`));
    g.details.forEach((d) => {
      result.append(el('div', 'qb-score-row',
        `${d.label}：${Math.round(d.ratio * 100)}% → ${d.points}/${d.weight} 分`));
    });
    if (typeof ctx.track === 'function') {
      ctx.track('submit', { expId: question.exampleId, kind: 'question', score: g.score });
    }
    if (typeof ctx.toast === 'function') ctx.toast(`本题得分 ${g.score}/${g.total}`, 'success');
    if (typeof ctx.onQuestionGraded === 'function') ctx.onQuestionGraded(question, g);
  }));
  host.append(bar);
  const result = el('div', 'qb-result');
  result.append(el('span', '', '勾选检查点或点「用当前电路自动评分」，然后计算总分。'));
  host.append(result);
}

/** 打开题库面板；focusId 存在时直接展开该题（每日一题入口用） */
export function openQuestionBank(ctx, focusId = null) {
  const state = { query: '', difficulty: 0, tags: [] };
  ctx.openModal('电路题库 / 每日一题', (body, actions, dismiss, closeBtn) => {
    const lead = el('p', 'info-modal-lead',
      `共 ${QUESTIONS.length} 道题 · 按难度/标签筛选 · 勾选检查点即可加权评分`);
    body.append(lead);

    const tools = el('div', 'info-form-row');
    const search = el('input', 'info-input qb-search');
    search.type = 'search';
    search.placeholder = '搜索题目 / 标签';
    search.setAttribute('aria-label', '搜索题目');
    tools.append(search);
    [0, 1, 2, 3].forEach((d) => {
      const b = button(d === 0 ? '全部难度' : `难度 ${d}`, 'qb-chip' + (d === 0 ? ' is-on' : ''), () => {
        state.difficulty = d;
        tools.querySelectorAll('.qb-chip[data-kind=diff]').forEach((x) => x.classList.toggle('is-on', x === b));
        renderList();
      });
      b.dataset.kind = 'diff';
      tools.append(b);
    });
    body.append(tools);

    const tagRow = el('div', 'qb-tags');
    questionTags(QUESTIONS).forEach((tag) => {
      const b = button(tag, 'qb-chip', () => {
        const i = state.tags.indexOf(tag);
        if (i >= 0) state.tags.splice(i, 1); else state.tags.push(tag);
        b.classList.toggle('is-on');
        renderList();
      });
      tagRow.append(b);
    });
    body.append(tagRow);

    const listHost = el('div', 'qb-list');
    const detailHost = el('div', 'qb-detail');
    body.append(listHost, detailHost);

    let debounce = null;
    search.addEventListener('input', () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { state.query = search.value; renderList(); }, 200);
    });

    function renderList() {
      listHost.replaceChildren();
      const rows = filterQuestions(QUESTIONS, state);
      if (rows.length === 0) {
        listHost.append(el('p', 'info-modal-lead', '没有匹配的题目，换个关键词或筛选条件。'));
        return;
      }
      rows.forEach((q) => {
        const card = el('div', 'qb-card');
        const title = el('div', 'qb-card-title', q.title);
        const meta = el('div', 'qb-card-meta', `难度 ${q.difficulty} · ${(q.tags || []).join(' / ')} · 满分 ${q.checkpoints.reduce((a, c) => a + c.weight, 0)}`);
        card.append(title, meta);
        card.addEventListener('click', () => {
          listHost.querySelectorAll('.qb-card').forEach((x) => x.classList.toggle('is-active', x === card));
          renderQuestionDetail(detailHost, q, ctx);
        });
        listHost.append(card);
      });
    }

    renderList();
    const focus = focusId ? questionById(QUESTIONS, focusId) : null;
    if (focus) {
      renderQuestionDetail(detailHost, focus, ctx);
      const card = [...listHost.querySelectorAll('.qb-card')]
        .find((c) => c.textContent.includes(focus.title));
      if (card) card.classList.add('is-active');
    } else {
      detailHost.append(el('p', 'info-modal-lead', '点左侧题目查看检查点、提示与自动评分。'));
    }
    insertAction(actions, closeBtn, '今日一题', () => {
      const q = dailyQuestion(QUESTIONS, new Date());
      if (q) renderQuestionDetail(detailHost, q, ctx);
    }, false);
    void dismiss;
  });
}

/** 列表页「每日一题」卡片（R12 成就联动） */
export function renderDailyQuestion(host, ctx) {
  if (!host) return null;
  const q = dailyQuestion(QUESTIONS, new Date());
  host.replaceChildren();
  if (!q) return null;
  const badge = el('span', 'daily-badge', '每日一题');
  const title = el('span', 'daily-title', q.title);
  const meta = el('span', 'daily-meta', `难度 ${q.difficulty} · ${(q.tags || []).join(' / ')}`);
  const go = button('开始答题', 'btn btn-ghost', () => openQuestionBank(ctx, q.id));
  host.append(badge, title, meta, go);
  host.dataset.questionId = q.id;
  return q;
}

/* ==========================================================================
   R17 版本管理
   ========================================================================== */

/** 打开版本面板：保存 / 恢复 / 双版本对比 / 删除 */
export function openVersions(ctx) {
  const expId = ctx.expId();
  if (!expId) {
    if (typeof ctx.toast === 'function') ctx.toast('请先进入一个实验', 'error');
    return;
  }
  ctx.openModal('电路版本管理', (body, actions, dismiss, closeBtn) => {
    const lead = el('p', 'info-modal-lead',
      `实验 ${expId} · 最多保留 ${VERSION_LIMIT} 个版本 · 每 30 秒自动生成一次`);
    body.append(lead);

    const saveRow = el('div', 'info-form-row');
    const nameInput = el('input', 'info-input ver-name');
    nameInput.type = 'text';
    nameInput.placeholder = '版本名称';
    nameInput.setAttribute('aria-label', '版本名称');
    saveRow.append(nameInput, button('保存当前版本', 'btn btn-ghost', () => {
      const circuit = ctx.model() && ctx.model().serializeCircuit
        ? ctx.model().serializeCircuit() : null;
      if (!circuit) { ctx.toast('当前没有可保存的电路', 'error'); return; }
      saveVersion(expId, nameInput.value || `手动 · ${new Date().toLocaleString('zh-CN')}`, circuit);
      nameInput.value = '';
      render();
      ctx.toast('版本已保存', 'success');
    }));
    body.append(saveRow);

    const selected = new Set();
    const diffBar = el('div', 'info-form-row');
    diffBar.append(button('对比选中（2 个）', 'btn btn-ghost', () => {
      const ids = [...selected];
      if (ids.length !== 2) { ctx.toast('请勾选两个版本', 'info'); return; }
      const a = getVersion(expId, ids[0]);
      const b = getVersion(expId, ids[1]);
      if (!a || !b) return;
      const d = diffVersions(a, b);
      const box = el('div', 'ver-diff');
      box.append(el('strong', '', `${a.name} → ${b.name}`));
      const lines = [
        ['ver-add', `新增元件 ${d.addedComps.length}：${d.addedComps.join(', ') || '无'}`],
        ['ver-del', `删除元件 ${d.removedComps.length}：${d.removedComps.join(', ') || '无'}`],
        ['ver-chg', `参数变化 ${d.changedComps.length}：${d.changedComps.join(', ') || '无'}`],
        ['ver-add', `新增导线 ${d.addedWires.length}`],
        ['ver-del', `删除导线 ${d.removedWires.length}`],
      ];
      lines.forEach(([cls, text]) => box.append(el('div', cls, text)));
      result.replaceChildren(box);
    }));
    body.append(diffBar);

    const listHost = el('div', 'ver-list');
    const result = el('div', 'ver-result');
    body.append(listHost, result);

    function render() {
      selected.clear();
      listHost.replaceChildren();
      const versions = listVersions(expId).slice().reverse();
      if (versions.length === 0) {
        listHost.append(el('p', 'info-modal-lead', '还没有版本，点「保存当前版本」建一个。'));
        return;
      }
      const table = el('table', 'info-table');
      const tbody = el('tbody');
      versions.forEach((v) => {
        const s = versionSummary(v);
        const tr = el('tr');
        const pick = el('td');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(v.id); else selected.delete(v.id);
        });
        pick.append(cb);
        tr.append(pick);
        [
          s.auto ? `${s.name}（自动）` : s.name,
          new Date(s.time).toLocaleString('zh-CN'),
          `${s.components} 元件 / ${s.wires} 导线`,
        ].forEach((text) => tr.append(el('td', '', text)));
        const ops = el('td');
        ops.append(button('恢复', 'btn btn-ghost', () => {
          ctx.applyCircuit(v.circuit, `已恢复版本：${s.name}`);
          dismiss();
        }));
        ops.append(button('删除', 'btn btn-ghost', () => {
          deleteVersion(expId, v.id);
          render();
        }));
        tr.append(ops);
        tbody.append(tr);
      });
      table.append(tbody);
      listHost.append(table);
    }

    render();
    insertAction(actions, closeBtn, '保存并关闭', () => {
      const circuit = ctx.model() && ctx.model().serializeCircuit
        ? ctx.model().serializeCircuit() : null;
      if (circuit) saveVersion(expId, '离开前快照', circuit);
      dismiss();
    }, false);
  });
}

/* ==========================================================================
   R17 自动版本（30 秒）
   ========================================================================== */
let autoTimer = null;
let lastSnapshot = '';

export function startAutoVersion(ctx) {
  stopAutoVersion();
  autoTimer = window.setInterval(() => {
    const expId = ctx.expId();
    const modelApi = ctx.model();
    if (!expId || !modelApi || typeof modelApi.serializeCircuit !== 'function') return;
    let circuit;
    try { circuit = modelApi.serializeCircuit(); } catch (_) { return; }
    const sig = JSON.stringify(circuit);
    if (!circuit || sig === lastSnapshot) return;
    lastSnapshot = sig;
    saveVersion(expId, autoVersionName(), circuit, { auto: true });
  }, 30000);
  return autoTimer;
}

export function stopAutoVersion() {
  if (autoTimer) { window.clearInterval(autoTimer); autoTimer = null; }
}

export function resetAutoSnapshot() {
  lastSnapshot = '';
}
