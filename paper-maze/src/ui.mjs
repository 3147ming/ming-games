// 《纸上迷城》— 渲染与输入层
// 只做三件事：把 engine 的结果画出来、把点击翻译成 engine 调用、顺手存盘。
// 所有判定都在 engine.mjs，这里不写任何游戏规则。

import {
  META,
  ITEMS,
  CLUES,
  RECIPES,
  PUZZLES,
  ENDINGS,
  ENDING_ORDER,
  DIRECTIONS,
  getItem,
  getPuzzle,
  describeRequirement,
} from './story.mjs';
import {
  createState,
  move,
  interact,
  solvePuzzle,
  combine,
  availableRecipes,
  chooseEnding,
  endingChoices,
  hint,
  shouldOfferHint,
  hintCountdown,
  visibleExits,
  visibleHotspots,
  currentRoom,
  progress,
  collectionRatio,
  clueList,
  inventoryList,
  formatDuration,
  elapsedMs,
  tick,
} from './engine.mjs';
import {
  loadSave,
  writeSave,
  clearSave,
  saveFromState,
  stateFromSave,
  recordEnding,
  codex,
  endingStats,
  startNewRun,
  getStorage,
  defaultSave,
} from './save.mjs';
import { createSfx } from './sfx.mjs';

const $ = (id) => document.getElementById(id);

export function boot(root = document) {
  const el = {
    roomGlyph: $('roomGlyph'),
    roomName: $('roomName'),
    desc: $('desc'),
    hotspots: $('hotspots'),
    exits: $('exits'),
    tabs: $('tabs'),
    sheet: $('sheet'),
    sheetTitle: $('sheetTitle'),
    sheetBody: $('sheetBody'),
    sheetClose: $('sheetClose'),
    modal: $('modal'),
    modalTitle: $('modalTitle'),
    modalBody: $('modalBody'),
    modalClose: $('modalClose'),
    toast: $('toast'),
    btnHint: $('btnHint'),
    btnMute: $('btnMute'),
    meterFill: $('meterFill'),
    bootOverlay: $('bootOverlay'),
    bootStart: $('bootStart'),
    bootStats: $('bootStats'),
  };

  /* ---------------------------------------------------------- 存档 */
  const storage = getStorage();
  let loaded = loadSave(storage);
  let save = loaded.save;
  let state = stateFromSave(save);

  const sfx = createSfx({ muted: save.settings.muted });

  function persist(now = Date.now()) {
    save = saveFromState(state, save, now);
    save.elapsedMs = elapsedMs(state, now);
    writeSave(save, storage);
  }

  /* ---------------------------------------------------------- 通知 */
  let toastTimer = 0;
  function toast(text, kind = '') {
    if (!text) return;
    el.toast.textContent = text;
    el.toast.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast';
    }, 3200);
  }

  /* ---------------------------------------------------------- 主视图 */
  function renderRoom() {
    const room = currentRoom(state);
    if (!room) return;
    el.roomGlyph.textContent = room.glyph;
    el.roomName.textContent = room.name;
    el.desc.textContent = room.desc;

    const hots = visibleHotspots(state);
    el.hotspots.replaceChildren(
      ...hots.map((h) => {
        const b = document.createElement('button');
        b.className = `hot ${h.ok ? '' : 'locked'} ${h.taken ? 'taken' : ''}`.trim();
        b.dataset.hot = h.id;
        b.type = 'button';
        const mark = h.endingId ? '终' : h.puzzleId ? (h.solved ? '✓' : '锁') : h.taken ? '·' : '';
        b.innerHTML = `<span class="hot-dot" aria-hidden="true">${mark}</span><span class="hot-txt"></span>`;
        b.querySelector('.hot-txt').textContent = h.label;
        b.setAttribute('aria-label', `查看${h.label}`);
        return b;
      }),
    );

    const exs = visibleExits(state);
    el.exits.replaceChildren(
      ...exs.map((x) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `exit ${x.ok ? '' : 'blocked'}`.trim();
        b.dataset.dir = x.dir;
        b.innerHTML = `<span class="exit-dir" aria-hidden="true">${x.label}</span><span class="exit-name"></span>`;
        b.querySelector('.exit-name').textContent = x.ok ? x.toName : `${x.toName}（锁）`;
        b.setAttribute('aria-label', `${x.label}：${x.toName}`);
        return b;
      }),
    );

    const p = progress(state);
    const ratio = collectionRatio(state);
    el.meterFill.style.width = `${Math.round(ratio * 100)}%`;
    el.meterFill.parentElement.setAttribute(
      'aria-label',
      `收集度 ${Math.round(ratio * 100)}%：房间 ${p.roomsVisited}/${p.roomsTotal}，物品 ${p.itemsOwned}，线索 ${p.clues}，谜题 ${p.puzzlesSolved}/${p.puzzlesTotal}`,
    );
  }

  function renderAll() {
    renderRoom();
    if (!el.sheet.hidden) renderSheet(activeTab);
    updateHintButton();
    persist();
  }

  /* ---------------------------------------------------------- 提示按钮 */
  function updateHintButton() {
    if (state.endingId) {
      el.btnHint.disabled = true;
      el.btnHint.textContent = '提示';
      el.btnHint.classList.remove('ready');
      return;
    }
    const now = Date.now();
    if (shouldOfferHint(state, now)) {
      el.btnHint.disabled = false;
      el.btnHint.textContent = '提示·可用';
      el.btnHint.classList.add('ready');
    } else {
      const left = Math.ceil(hintCountdown(state, now) / 1000);
      el.btnHint.disabled = true;
      el.btnHint.textContent = `提示 ${left}s`;
      el.btnHint.classList.remove('ready');
    }
  }

  /* ---------------------------------------------------------- 底部面板 */
  let activeTab = 'bag';
  let combineSel = [];
  let liveNode = null; // 设置面板里只更新这一行，避免每秒重建 DOM 打断点击

  function openSheet(tab) {
    activeTab = tab;
    el.sheet.hidden = false;
    el.sheet.classList.add('open');
    renderSheet(tab);
  }

  function closeSheet() {
    el.sheet.hidden = true;
    el.sheet.classList.remove('open');
  }

  const TAB_TITLE = { bag: '背包', journal: '日记·线索', codex: '结局图鉴', settings: '设置' };

  function renderSheet(tab) {
    el.sheetTitle.textContent = TAB_TITLE[tab] || '';
    const body = el.sheetBody;
    if (tab === 'bag') return renderBag(body);
    if (tab === 'journal') return renderJournal(body);
    if (tab === 'codex') return renderCodex(body);
    if (tab === 'settings') return renderSettings(body);
  }

  function renderBag(body) {
    const inv = inventoryList(state);
    const wrap = document.createElement('div');
    wrap.className = 'bag';
    const head = document.createElement('div');
    head.className = 'row between';
    head.innerHTML = `<span class="dim">${inv.length} 件 · 选中 ${combineSel.length}/2</span>`;
    const btns = document.createElement('div');
    btns.className = 'row gap';
    const bCombine = document.createElement('button');
    bCombine.type = 'button';
    bCombine.className = 'btn primary';
    bCombine.textContent = '合成';
    bCombine.disabled = combineSel.length !== 2;
    bCombine.onclick = () => tryCombine();
    const bClear = document.createElement('button');
    bClear.type = 'button';
    bClear.className = 'btn';
    bClear.textContent = '清空';
    bClear.onclick = () => {
      combineSel = [];
      renderSheet('bag');
    };
    btns.append(bCombine, bClear);
    head.append(btns);
    wrap.append(head);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const it of inv) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cell ${combineSel.includes(it.id) ? 'sel' : ''}`.trim();
      b.dataset.item = it.id;
      b.innerHTML = `<span class="glyph">${it.icon}</span><span class="nm"></span>`;
      b.querySelector('.nm').textContent = it.name;
      b.onclick = () => {
        const i = combineSel.indexOf(it.id);
        if (i >= 0) combineSel.splice(i, 1);
        else if (combineSel.length < 2) combineSel.push(it.id);
        else combineSel = [combineSel[1], it.id];
        renderSheet('bag');
      };
      grid.append(b);
    }
    wrap.append(grid);

    if (combineSel.length) {
      const info = document.createElement('div');
      info.className = 'card';
      const a = getItem(combineSel[0]);
      const b2 = combineSel[1] ? getItem(combineSel[1]) : null;
      info.innerHTML = `<b></b><p></p>`;
      info.querySelector('b').textContent = b2 ? `${a.name} + ${b2.name}` : a.name;
      info.querySelector('p').textContent = b2
        ? '点「合成」试试这两样能不能凑到一起。'
        : a.desc;
      wrap.append(info);
    }

    const ready = availableRecipes(state);
    const tip = document.createElement('p');
    tip.className = 'dim small';
    tip.textContent = ready.length
      ? `手上有 ${ready.length} 组可以合成：${ready
          .map((r) => r.in.map((i) => ITEMS[i].name).join('+'))
          .join('、')}`
      : '手上暂时没有可以合成的东西。多翻翻房间里的角落。';
    wrap.append(tip);
    body.replaceChildren(wrap);
  }

  function tryCombine() {
    if (combineSel.length !== 2) return;
    const [a, b] = combineSel;
    const res = combine(state, a, b, Date.now());
    combineSel = [];
    if (res.ok) {
      sfx.play('combine');
      toast(`${res.outName}：${res.text}`, 'ok');
      closeSheet();
    } else {
      sfx.play('wrong');
      toast(res.text, 'bad');
    }
    renderAll();
  }

  function renderJournal(body) {
    const clues = clueList(state);
    const total = Object.keys(CLUES).length;
    const wrap = document.createElement('div');
    const head = document.createElement('p');
    head.className = 'dim small';
    head.textContent = `已记录 ${clues.length} / ${total} 条线索 · 已解谜题 ${state.solvedPuzzles.length} / ${
      Object.keys(PUZZLES).length
    }`;
    wrap.append(head);
    if (!clues.length) {
      const p = document.createElement('p');
      p.className = 'dim';
      p.textContent = '日记还是空的。走遍房间、点开每个物件，线索会自动记进来。';
      wrap.append(p);
    }
    for (const c of clues) {
      const d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<b></b><p></p>';
      d.querySelector('b').textContent = c.title;
      d.querySelector('p').textContent = c.text;
      wrap.append(d);
    }
    const solved = state.solvedPuzzles.map((id) => PUZZLES[id]).filter(Boolean);
    if (solved.length) {
      const h2 = document.createElement('p');
      h2.className = 'dim small';
      h2.textContent = '已解开的机关';
      wrap.append(h2);
      for (const p of solved) {
        const d = document.createElement('div');
        d.className = 'card ok-card';
        d.innerHTML = '<b></b><p></p>';
        d.querySelector('b').textContent = p.title;
        d.querySelector('p').textContent = p.derivation;
        wrap.append(d);
      }
    }
    body.replaceChildren(wrap);
  }

  function renderCodex(body) {
    const list = codex(save);
    const st = endingStats(save);
    const wrap = document.createElement('div');
    const head = document.createElement('p');
    head.className = 'dim small';
    head.textContent = `已解锁 ${st.unlocked} / ${st.total} 个结局 · 本次存档共开局 ${st.runs} 次`;
    wrap.append(head);
    for (const e of list) {
      const d = document.createElement('div');
      d.className = `card ending-card ${e.unlocked ? 'unlocked' : 'locked'}`;
      const best = e.bestMs != null ? formatDuration(e.bestMs) : '—';
      d.innerHTML = '<b></b><p></p>';
      d.querySelector('b').textContent = e.unlocked ? `${e.glyph} ${e.title}` : `${e.glyph} ？？？`;
      d.querySelector('p').textContent = e.unlocked
        ? `${ENDINGS[e.id].text.slice(0, 40)}… · 达成 ${e.count} 次 · 最快 ${best}`
        : '尚未抵达这个结局。';
      wrap.append(d);
    }
    const hintP = document.createElement('p');
    hintP.className = 'dim small';
    hintP.textContent = '结局由关键选择与收集度共同决定：物件决定你能做什么，线索数量决定你能看懂多少。';
    wrap.append(hintP);
    body.replaceChildren(wrap);
  }

  function renderSettings(body) {
    const wrap = document.createElement('div');
    const info = document.createElement('div');
    info.className = 'card';
    info.innerHTML = '<b>本局进度</b><p></p>';
    liveNode = info.querySelector('p');
    liveNode.textContent = settingsText();
    wrap.append(info);

    const row1 = document.createElement('div');
    row1.className = 'row gap wrap';
    const bMute = mkBtn(save.settings.muted ? '音效：关' : '音效：开', () => {
      save.settings.muted = !save.settings.muted;
      sfx.setMuted(save.settings.muted);
      if (!save.settings.muted) {
        sfx.unlock();
        sfx.play('page');
      }
      writeSave(save, storage);
      el.btnMute.textContent = save.settings.muted ? '静' : '♪';
      renderSheet('settings');
    });
    const bRestart = mkBtn('重开本局', () => {
      if (!confirm('重开本局？本局进度会丢失，结局图鉴保留。')) return;
      const r = startNewRun(save, { ngPlus: state.ngPlus, now: Date.now() });
      save = r.save;
      state = r.state;
      combineSel = [];
      closeSheet();
      renderAll();
      toast('新的一局开始了。', 'ok');
    });
    const bNg = mkBtn('二周目（继承线索）', () => {
      const r = startNewRun(save, { ngPlus: true, now: Date.now() });
      save = r.save;
      state = r.state;
      combineSel = [];
      closeSheet();
      renderAll();
      toast(`二周目开始：继承 ${state.clues.length} 条线索，物品清空。`, 'ok');
    });
    const bWipe = mkBtn('清除全部存档', () => {
      if (!confirm('清除全部存档？结局图鉴与用时记录都会消失。')) return;
      clearSave(storage);
      save = defaultSave();
      state = stateFromSave(save);
      closeSheet();
      renderAll();
      toast('存档已清除。', 'ok');
    });
    bWipe.classList.add('danger');
    row1.append(bMute, bRestart, bNg, bWipe);
    wrap.append(row1);

    const about = document.createElement('p');
    about.className = 'dim small';
    about.textContent = `${META.title} v${META.version} · 纯静态零依赖 · 存档键 papermaze.save.v1`;
    wrap.append(about);
    body.replaceChildren(wrap);
  }

  function mkBtn(label, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.onclick = onclick;
    return b;
  }

  function settingsText() {
    const p = progress(state);
    return `房间 ${p.roomsVisited}/${p.roomsTotal} · 物品 ${p.itemsOwned} · 线索 ${p.clues}/${p.cluesTotal} · 谜题 ${p.puzzlesSolved}/${p.puzzlesTotal} · 步数 ${p.steps} · 提示 ${p.hintsUsed} 次 · 用时 ${formatDuration(elapsedMs(state, Date.now()))}`;
  }

  function writeSettingsLive() {
    if (!liveNode || !liveNode.isConnected) return;
    liveNode.textContent = settingsText();
  }

  /* ---------------------------------------------------------- 弹窗 */
  function openModal(title, node, closable = true) {
    el.modalTitle.textContent = title;
    el.modalBody.replaceChildren(node);
    el.modal.hidden = false;
    el.modal.classList.add('open');
    el.modalClose.hidden = !closable;
  }

  function closeModal() {
    el.modal.hidden = true;
    el.modal.classList.remove('open');
  }

  /* ---- 谜题 ---- */
  function openPuzzle(puzzleId) {
    const p = getPuzzle(puzzleId);
    if (!p) return;
    const known = p.clueItemIds.every((id) => state.inventory.includes(id) || state.clues.includes(id));
    let picked = [];
    let typed = '';

    const wrap = document.createElement('div');
    wrap.className = 'puzzle';
    const prompt = document.createElement('p');
    prompt.className = 'prompt';
    prompt.textContent = p.prompt;
    const clueLine = document.createElement('p');
    clueLine.className = `clue ${known ? 'ok' : 'dim'}`;
    clueLine.textContent = known
      ? `线索已具备：${p.clueItemIds.map((i) => ITEMS[i].name).join('、')}`
      : `你还没有拿到能推出答案的线索（${p.clueItemIds.map((i) => ITEMS[i].name).join('、')}）。现在只能硬猜。`;
    const display = document.createElement('div');
    display.className = 'answer-display';

    function refreshDisplay() {
      if (p.type === 'code') display.textContent = typed.padEnd(p.length || 3, '·');
      else if (p.type === 'sequence') display.textContent = picked.length ? picked.join(' → ') : '（点下面的选项排顺序）';
      else display.textContent = picked.length ? picked[0] : '（选一个）';
      submit.disabled = p.type === 'code' ? typed.length !== (p.length || 3) : picked.length === 0;
    }

    const pad = document.createElement('div');
    pad.className = 'pad';
    if (p.type === 'code') {
      for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '←', '清']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'key';
        b.textContent = d;
        b.onclick = () => {
          sfx.play('page');
          if (d === '←') typed = typed.slice(0, -1);
          else if (d === '清') typed = '';
          else if (typed.length < (p.length || 3)) typed += d;
          refreshDisplay();
        };
        pad.append(b);
      }
    } else if (p.type === 'word') {
      const input = document.createElement('input');
      input.className = 'word-input';
      input.setAttribute('inputmode', 'text');
      input.setAttribute('maxlength', '4');
      input.placeholder = '输入缺的字';
      input.oninput = () => {
        typed = input.value.trim();
        picked = typed ? [typed] : [];
        refreshDisplay();
      };
      pad.append(input);
    } else {
      for (const opt of p.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'key wide';
        b.textContent = opt;
        b.onclick = () => {
          sfx.play('page');
          if (p.type === 'sequence') {
            if (picked.includes(opt)) picked = picked.filter((x) => x !== opt);
            else picked.push(opt);
          } else {
            picked = [opt];
          }
          refreshDisplay();
        };
        pad.append(b);
      }
    }

    const row = document.createElement('div');
    row.className = 'row gap';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn primary';
    submit.textContent = '确认';
    const reset = mkBtn('重置', () => {
      picked = [];
      typed = '';
      refreshDisplay();
    });
    submit.onclick = () => {
      const res = solvePuzzle(state, p.id, p.type === 'code' || p.type === 'word' ? typed : picked, Date.now());
      if (res.ok) {
        sfx.play('solve');
        toast(res.text, 'ok');
        closeModal();
      } else {
        sfx.play('wrong');
        toast(res.text, 'bad');
        // 答错后清空输入，避免"继续按键却没反应"的错觉
        picked = [];
        typed = '';
        const input = wrap.querySelector('.word-input');
        if (input) input.value = '';
        refreshDisplay();
      }
      renderAll();
    };
    row.append(submit, reset);

    wrap.append(prompt, clueLine, display, pad, row);
    refreshDisplay();
    openModal(p.title, wrap);
  }

  /* ---- 结局选择 ---- */
  function openEndingChoice(hotspotId) {
    const choices = endingChoices(state, hotspotId);
    const wrap = document.createElement('div');
    wrap.className = 'choices';
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn wide ${c.ok ? 'primary' : ''}`.trim();
      b.disabled = !c.ok;
      b.textContent = c.ok ? c.label : `${c.label}（${c.missing}）`;
      b.onclick = () => doEnding(hotspotId, c.id);
      wrap.append(b);
    }
    const p = document.createElement('p');
    p.className = 'dim small';
    p.textContent = `当前收集度 ${Math.round(collectionRatio(state) * 100)}%，线索 ${state.clues.length} 条。收集得越多，能做的事越多。`;
    wrap.append(p);
    openModal('做出选择', wrap);
  }

  function doEnding(hotspotId, choiceId) {
    const res = chooseEnding(state, hotspotId, choiceId, Date.now());
    if (!res.ok) {
      sfx.play('wrong');
      toast(res.text, 'bad');
      return;
    }
    sfx.play('ending');
    const ms = elapsedMs(state, Date.now());
    save = recordEnding(save, res.endingId, ms, Date.now());
    persist();
    showEndingScreen(res.endingId, ms);
    renderAll();
  }

  function showEndingScreen(endingId, ms) {
    const e = ENDINGS[endingId];
    const p = progress(state);
    const wrap = document.createElement('div');
    wrap.className = 'ending-screen';
    const g = document.createElement('div');
    g.className = 'ending-glyph';
    g.textContent = e.glyph;
    const t = document.createElement('h3');
    t.textContent = e.title;
    const body = document.createElement('p');
    body.className = 'ending-text';
    body.textContent = e.text;
    const stats = document.createElement('p');
    stats.className = 'dim small';
    stats.textContent = `用时 ${formatDuration(ms)} · 步数 ${p.steps} · 提示 ${p.hintsUsed} 次 · 房间 ${p.roomsVisited}/${p.roomsTotal} · 物品 ${p.itemsOwned} · 线索 ${p.clues}/${p.cluesTotal} · 谜题 ${p.puzzlesSolved}/${p.puzzlesTotal} · 收集度 ${Math.round(
      collectionRatio(state) * 100,
    )}%`;
    const st = endingStats(save);
    const codexLine = document.createElement('p');
    codexLine.className = 'dim small';
    codexLine.textContent = `结局图鉴：${st.unlocked} / ${st.total}`;
    const row = document.createElement('div');
    row.className = 'row gap wrap';
    row.append(
      mkBtn('再走一遍（保留线索）', () => {
        const r = startNewRun(save, { ngPlus: true, now: Date.now() });
        save = r.save;
        state = r.state;
        combineSel = [];
        closeModal();
        renderAll();
        toast('二周目开始。线索还在，东西得重新找。', 'ok');
      }),
      mkBtn('从零开始', () => {
        const r = startNewRun(save, { ngPlus: false, now: Date.now() });
        save = r.save;
        state = r.state;
        combineSel = [];
        closeModal();
        renderAll();
        toast('新的一局开始了。', 'ok');
      }),
      mkBtn('看结局图鉴', () => {
        closeModal();
        openSheet('codex');
      }),
    );
    wrap.append(g, t, body, stats, codexLine, row);
    openModal('结局达成', wrap, false);
  }

  /* ---------------------------------------------------------- 输入绑定 */
  el.hotspots.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-hot]');
    if (!b) return;
    sfx.unlock();
    const res = interact(state, b.dataset.hot, Date.now());
    if (!res.ok) {
      sfx.play('wrong');
      toast(res.text, 'bad');
    } else if (res.kind === 'puzzle') {
      sfx.play('page');
      openPuzzle(res.puzzleId);
    } else if (res.kind === 'puzzle-done') {
      toast(res.text);
    } else if (res.kind === 'ending') {
      sfx.play('page');
      openEndingChoice(b.dataset.hot);
    } else if (res.kind === 'item') {
      sfx.play('item');
      toast(res.text, 'ok');
    } else {
      sfx.play('page');
      toast(res.text);
    }
    renderAll();
  });

  el.exits.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-dir]');
    if (!b) return;
    sfx.unlock();
    const res = move(state, b.dataset.dir, Date.now());
    if (!res.ok) {
      sfx.play('wrong');
      toast(res.text, 'bad');
    } else {
      sfx.play('step');
      if (res.firstVisit) toast(`第一次来到${res.roomName}。`);
      el.desc.classList.remove('fade');
      void el.desc.offsetWidth;
      el.desc.classList.add('fade');
    }
    renderAll();
  });

  el.tabs.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b) return;
    sfx.unlock();
    sfx.play('page');
    combineSel = [];
    openSheet(b.dataset.tab);
  });

  el.sheetClose.addEventListener('click', closeSheet);
  el.modalClose.addEventListener('click', closeModal);

  el.btnHint.addEventListener('click', () => {
    if (el.btnHint.disabled) return;
    sfx.unlock();
    const res = hint(state, Date.now());
    sfx.play('hint');
    toast(`提示（第 ${res.hintsUsed} 次）：${res.text}`, 'hint');
    renderAll();
  });

  el.btnMute.addEventListener('click', () => {
    save.settings.muted = !save.settings.muted;
    sfx.setMuted(save.settings.muted);
    if (!save.settings.muted) {
      sfx.unlock();
      sfx.play('page');
    }
    el.btnMute.textContent = save.settings.muted ? '静' : '♪';
    el.btnMute.setAttribute('aria-pressed', String(save.settings.muted));
    writeSave(save, storage);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!el.modal.hidden) closeModal();
      else if (!el.sheet.hidden) closeSheet();
    }
    const map = { ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'w', ArrowRight: 'e', w: 'n', s: 's', a: 'w', d: 'e', q: 'u', z: 'd' };
    const lower = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const dir = map[ev.key] || map[lower];
    if (dir && el.modal.hidden && el.sheet.hidden) {
      ev.preventDefault();
      el.exits.querySelector(`[data-dir="${dir}"]`)?.click();
    }
  });

  /* ---------------------------------------------------------- 计时与收尾 */
  setInterval(() => {
    updateHintButton();
    if (!el.sheet.hidden && activeTab === 'settings') writeSettingsLive();
  }, 1000);

  const flush = () => persist();
  addEventListener('pagehide', flush);
  addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  /* ---------------------------------------------------------- 开局遮罩 */
  function startGame() {
    sfx.unlock();
    sfx.play('page');
    el.bootOverlay.hidden = true;
    el.bootOverlay.classList.add('gone');
    tick(state, Date.now());
    if (!save.runs) {
      save = { ...save, runs: 1 };
    }
    renderAll();
    toast('灯还剩一层油。先看看这间囚室。');
  }

  if (el.bootStart) el.bootStart.addEventListener('click', startGame);

  // 初次进入 / 已有存档：遮罩文案不同，"继续"直接开局。
  const st = endingStats(save);
  const p = progress(state);
  el.bootStats.textContent = save.runs
    ? `已有进度：${p.roomsVisited}/${p.roomsTotal} 房间 · 线索 ${p.clues} · 结局图鉴 ${st.unlocked}/${st.total} · 开局 ${save.runs} 次`
    : '第 1 局 · 12 个房间 · 40 件物品 · 12 条配方 · 7 个谜题 · 4 个结局';
  el.bootStart.textContent = save.runs ? '继续' : '点亮纸灯';
  el.meterFill.parentElement.setAttribute('aria-label', '收集度');

  el.btnMute.textContent = save.settings.muted ? '静' : '♪';
  el.btnMute.setAttribute('aria-pressed', String(save.settings.muted));

  renderRoom();
  updateHintButton();

  return {
    get state() {
      return state;
    },
    get save() {
      return save;
    },
    persist,
    sfx,
  };
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  const ready = () => boot();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
}
