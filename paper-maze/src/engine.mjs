// 《纸上迷城》— 纯逻辑引擎
// 铁律：不碰 DOM、不碰 localStorage、不读时钟（时间一律由调用方注入）。
// 所有函数都"改 state 并返回结果对象"，state 必须可 JSON 序列化。

import {
  META,
  ROOMS,
  ROOM_IDS,
  ITEMS,
  RECIPES,
  PUZZLES,
  ENDINGS,
  CLUES,
  START_ITEMS,
  DIRECTIONS,
  getRoom,
  getHotspot,
  getItem,
  getPuzzle,
  getEnding,
  getClue,
  recipeFor,
  describeRequirement,
} from './story.mjs';

export const STATE_VERSION = 1;

/* ------------------------------------------------------------ 状态构造 */

export function createState(opts = {}) {
  const state = {
    v: STATE_VERSION,
    roomId: opts.roomId || META.start,
    inventory: Array.isArray(opts.inventory) ? [...opts.inventory] : [...START_ITEMS],
    clues: Array.isArray(opts.clues) ? [...opts.clues] : [],
    solvedPuzzles: Array.isArray(opts.solvedPuzzles) ? [...opts.solvedPuzzles] : [],
    takenHotspots: Array.isArray(opts.takenHotspots) ? [...opts.takenHotspots] : [],
    visits: opts.visits ? { ...opts.visits } : { [opts.roomId || META.start]: 1 },
    steps: opts.steps || 0,
    hintsUsed: opts.hintsUsed || 0,
    startedAt: opts.startedAt ?? null,
    lastActionAt: opts.lastActionAt ?? null,
    endedAt: opts.endedAt ?? null,
    endingId: opts.endingId ?? null,
    ngPlus: !!opts.ngPlus,
    journal: [],
  };
  return state;
}

/** 只保留可序列化字段，供存档使用。 */
export function serializeState(state) {
  return {
    v: STATE_VERSION,
    roomId: state.roomId,
    inventory: [...state.inventory],
    clues: [...state.clues],
    solvedPuzzles: [...state.solvedPuzzles],
    takenHotspots: [...state.takenHotspots],
    visits: { ...state.visits },
    steps: state.steps,
    hintsUsed: state.hintsUsed,
    startedAt: state.startedAt,
    lastActionAt: state.lastActionAt,
    endedAt: state.endedAt,
    endingId: state.endingId,
    ngPlus: state.ngPlus,
  };
}

export function loadState(data) {
  const s = createState(data || {});
  s.journal = [];
  return s;
}

/* ------------------------------------------------------------ 时间 / 记录 */

/** 注入时间：首次调用建立起始时间，之后刷新"最后动作时间"。 */
export function tick(state, now) {
  if (state.startedAt == null) state.startedAt = now;
  state.lastActionAt = now;
  return state;
}

export function elapsedMs(state, now) {
  if (state.startedAt == null) return 0;
  const end = state.endedAt ?? now;
  return Math.max(0, end - state.startedAt);
}

export function formatDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function log(state, text) {
  state.journal.push(text);
  if (state.journal.length > 40) state.journal.shift();
}

function bump(state, now) {
  state.steps += 1;
  if (now != null) tick(state, now);
}

/* ------------------------------------------------------------ 条件判定 */

export function meetsRequirement(state, req) {
  if (!req) return true;
  if (req.items && !req.items.every((i) => state.inventory.includes(i))) return false;
  if (req.puzzles && !req.puzzles.every((p) => state.solvedPuzzles.includes(p))) return false;
  if (req.clues && state.clues.length < req.clues) return false;
  return true;
}

export function missingRequirement(state, req) {
  if (meetsRequirement(state, req)) return '';
  return describeRequirement(req);
}

export function hasItem(state, id) {
  return state.inventory.includes(id);
}

export function hasClue(state, id) {
  return state.clues.includes(id);
}

export function isSolved(state, puzzleId) {
  return state.solvedPuzzles.includes(puzzleId);
}

/* ------------------------------------------------------------ 视图数据 */

export function currentRoom(state) {
  return getRoom(state.roomId);
}

export function visibleExits(state) {
  const room = currentRoom(state);
  if (!room) return [];
  return room.exits.map((ex) => {
    const ok = meetsRequirement(state, ex.requires);
    return {
      dir: ex.dir,
      label: ex.label || DIRECTIONS[ex.dir] || ex.dir,
      to: ex.to,
      toName: getRoom(ex.to) ? getRoom(ex.to).name : ex.to,
      ok,
      blockedText: ok ? '' : ex.blockedText || '这里过不去。',
      missing: ok ? '' : missingRequirement(state, ex.requires),
    };
  });
}

export function visibleHotspots(state) {
  const room = currentRoom(state);
  if (!room) return [];
  return room.hotspots.map((h) => {
    const ok = meetsRequirement(state, h.requires);
    const solved = h.puzzle ? isSolved(state, h.puzzle) : false;
    return {
      id: h.id,
      label: h.label,
      ok,
      solved,
      puzzleId: h.puzzle || null,
      endingId: h.ending ? true : false,
      taken: state.takenHotspots.includes(h.id),
      lockedText: ok ? '' : h.lockedText || '现在还动不了它。',
      missing: ok ? '' : missingRequirement(state, h.requires),
    };
  });
}

/* ------------------------------------------------------------ 行动 */

export function move(state, dir, now) {
  if (state.endingId) return { ok: false, kind: 'ended', text: '这一局已经结束了。' };
  const room = currentRoom(state);
  if (!room) return { ok: false, text: '你不在这里。' };
  const exit = room.exits.find((e) => e.dir === dir);
  if (!exit) return { ok: false, text: '这个方向没有出口。' };
  if (!meetsRequirement(state, exit.requires)) {
    return { ok: false, kind: 'blocked', text: exit.blockedText || '这里过不去。' };
  }
  state.roomId = exit.to;
  state.visits[exit.to] = (state.visits[exit.to] || 0) + 1;
  bump(state, now);
  const target = getRoom(exit.to);
  log(state, `进入${target ? target.name : exit.to}`);
  return {
    ok: true,
    kind: 'move',
    roomId: exit.to,
    roomName: target ? target.name : exit.to,
    firstVisit: state.visits[exit.to] === 1,
    text: target ? target.desc : '',
  };
}

export function interact(state, hotspotId, now) {
  if (state.endingId) return { ok: false, kind: 'ended', text: '这一局已经结束了。' };
  const room = currentRoom(state);
  if (!room) return { ok: false, text: '你不在这里。' };
  const h = getHotspot(room.id, hotspotId);
  if (!h) return { ok: false, text: '这里没有那个东西。' };

  if (h.puzzle) {
    const puzzle = getPuzzle(h.puzzle);
    if (isSolved(state, h.puzzle)) {
      return { ok: true, kind: 'puzzle-done', text: '这里已经解开了，没有别的东西。' };
    }
    return { ok: true, kind: 'puzzle', puzzleId: h.puzzle, puzzle, text: puzzle.prompt };
  }

  if (h.ending) {
    return { ok: true, kind: 'ending', hotspotId: h.id, choices: endingChoices(state, h.id) };
  }

  if (!meetsRequirement(state, h.requires)) {
    return { ok: false, kind: 'locked', text: h.lockedText || '现在还动不了它。' };
  }

  const gained = [];
  if (h.gives) {
    for (const id of h.gives) {
      if (!state.inventory.includes(id)) {
        state.inventory.push(id);
        gained.push(id);
      }
    }
  }
  if (h.clue) addClue(state, h.clue);
  const first = !state.takenHotspots.includes(h.id);
  if (first) state.takenHotspots.push(h.id);
  bump(state, now);

  let text = h.text || '';
  if (gained.length) {
    text += `（获得：${gained.map((g) => (getItem(g) ? getItem(g).name : g)).join('、')}）`;
  } else if (!first) {
    text = '（这里已经没有别的东西了。）';
  }
  log(state, `查看${h.label}`);
  return { ok: true, kind: gained.length ? 'item' : 'text', text, items: gained };
}

export function addClue(state, clueId) {
  if (!CLUES[clueId]) return false;
  if (state.clues.includes(clueId)) return false;
  state.clues.push(clueId);
  return true;
}

/* ------------------------------------------------------------ 谜题 */

export function normalizeAnswer(puzzle, input) {
  if (puzzle.type === 'sequence') {
    if (Array.isArray(input)) return input.map((x) => String(x).trim());
    return String(input ?? '')
      .split(/[\s,，、>→-]+/)
      .filter(Boolean)
      .flatMap((s) => (puzzle.options && puzzle.options.includes(s) ? [s] : [...s]));
  }
  return String(input ?? '').trim();
}

export function checkAnswer(puzzle, input) {
  const got = normalizeAnswer(puzzle, input);
  if (puzzle.type === 'sequence') {
    return Array.isArray(got) && got.length === puzzle.answer.length && got.every((v, i) => v === puzzle.answer[i]);
  }
  return got === puzzle.answer;
}

export function solvePuzzle(state, puzzleId, input, now) {
  if (state.endingId) return { ok: false, kind: 'ended', text: '这一局已经结束了。' };
  const puzzle = getPuzzle(puzzleId);
  if (!puzzle) return { ok: false, text: '没有这个谜题。' };
  if (puzzle.roomId !== state.roomId) return { ok: false, text: '你不在这里。' };
  if (isSolved(state, puzzleId)) return { ok: false, kind: 'already', text: '这个谜题已经解开了。' };

  if (!checkAnswer(puzzle, input)) {
    bump(state, now);
    log(state, `${puzzle.title}：试错`);
    return { ok: false, kind: 'wrong', text: puzzle.wrongText || '不对。' };
  }

  state.solvedPuzzles.push(puzzleId);
  const gained = [];
  if (puzzle.gives) {
    for (const id of puzzle.gives) {
      if (!state.inventory.includes(id)) {
        state.inventory.push(id);
        gained.push(id);
      }
    }
  }
  bump(state, now);
  log(state, `解开${puzzle.title}`);
  return {
    ok: true,
    kind: 'solved',
    puzzleId,
    text: puzzle.successText,
    items: gained,
  };
}

/* ------------------------------------------------------------ 合成 */

export function availableRecipes(state) {
  const out = [];
  for (const r of RECIPES) {
    if (r.in.every((i) => state.inventory.includes(i))) out.push(r);
  }
  return out;
}

export function combine(state, a, b, now) {
  if (state.endingId) return { ok: false, kind: 'ended', text: '这一局已经结束了。' };
  if (a === b) return { ok: false, text: '同一件东西没法和自己合成。' };
  if (!state.inventory.includes(a) || !state.inventory.includes(b)) {
    return { ok: false, text: '你手上没有这两样东西。' };
  }
  const recipe = recipeFor(a, b);
  if (!recipe) return { ok: false, kind: 'no-recipe', text: '这两样东西凑不到一起。' };
  const kept = recipe.keeps || [];
  state.inventory = state.inventory.filter((i) => i !== a && i !== b);
  for (const k of kept) if ((k === a || k === b) && !state.inventory.includes(k)) state.inventory.push(k);
  if (!state.inventory.includes(recipe.out)) state.inventory.push(recipe.out);
  bump(state, now);
  log(state, `合成：${getItem(recipe.out) ? getItem(recipe.out).name : recipe.out}`);
  return {
    ok: true,
    kind: 'combine',
    recipeId: recipe.id,
    out: recipe.out,
    outName: getItem(recipe.out) ? getItem(recipe.out).name : recipe.out,
    text: recipe.text,
  };
}

/* ------------------------------------------------------------ 结局 */

export function endingChoices(state, hotspotId) {
  for (const rid of ROOM_IDS) {
    const h = ROOMS[rid].hotspots.find((x) => x.id === hotspotId);
    if (!h || !h.ending) continue;
    return h.ending.choices.map((c) => {
      const ok = meetsRequirement(state, c.requires);
      return {
        id: c.id,
        label: c.label,
        ending: c.ending,
        ok,
        missing: ok ? '' : describeRequirement(c.requires),
      };
    });
  }
  return [];
}

export function chooseEnding(state, hotspotId, choiceId, now) {
  if (state.endingId) return { ok: false, kind: 'ended', text: '这一局已经结束了。' };
  const room = currentRoom(state);
  if (!room) return { ok: false, text: '你不在这里。' };
  const h = room.hotspots.find((x) => x.id === hotspotId);
  if (!h || !h.ending) return { ok: false, text: '这里没有可做的选择。' };
  const choice = h.ending.choices.find((c) => c.id === choiceId);
  if (!choice) return { ok: false, text: '没有这个选项。' };
  if (!meetsRequirement(state, choice.requires)) {
    return { ok: false, kind: 'locked', text: `条件还不满足：${describeRequirement(choice.requires)}` };
  }
  const ending = getEnding(choice.ending);
  if (!ending) return { ok: false, text: '结局数据缺失。' };

  state.endingId = ending.id;
  bump(state, now);
  state.endedAt = state.lastActionAt ?? now ?? state.startedAt ?? null;
  log(state, `结局：${ending.title}`);
  return {
    ok: true,
    kind: 'ending',
    endingId: ending.id,
    title: ending.title,
    tone: ending.tone,
    glyph: ending.glyph,
    text: ending.text,
  };
}

/* ------------------------------------------------------------ 提示
 * ★ 改为「从第一步开始」的攻略式提示：
 *   不再按"当前卡在哪"动态挑一条规则，而是给出一条固定的通关时序（WALKTHROUGH）。
 *   每次提示都从第一步起展示进度，并指出"下一步 / 之后两步"，让玩家拿到一份可对照的
 *   从头到尾的攻略，而不是被卡住时才给一句零碎的提示。 */

const WALKTHROUGH = [
  { text: '折纸囚室：草席下拾取火石，从墙缝抽出残破纸条。', done: (s) => hasItem(s, 'flint') && hasItem(s, 'note_torn') },
  { text: '经墨廊进书房：书案取空白宣纸、笔架下取半瓶墨，墨廊顺手取秃笔。', done: (s) => hasItem(s, 'paper_scrap') && hasItem(s, 'ink_bottle') && hasItem(s, 'brush') },
  { text: '灶房柴堆里拔一根铁钎——它用来撬开书房书架后的纸板门。', done: (s) => hasItem(s, 'iron_rod') },
  { text: '回书房用铁钎撬开纸板门下到地窖；地窖酒坛里取账本。', done: (s) => hasItem(s, 'ledger') },
  { text: '灶房取油壶与干粮，留着后面用。', done: (s) => hasItem(s, 'oil_can') && hasItem(s, 'bread') },
  { text: '地窖天平把秤砣分三等份（账本末页写「三等分之」），得到锈钥匙。', done: (s) => hasItem(s, 'rusty_key') },
  { text: '油壶 + 锈钥匙合成，得到润过油的钥匙（可开地窖通往门厅的北锁）。', done: (s) => hasItem(s, 'oiled_key') },
  { text: '纸庭拓下石碑的四组笔画（拓片）。', done: (s) => hasItem(s, 'stone_rubbing') },
  { text: '灯堂按「骨、烛、纸、心」顺序点亮四座灯台，得到白蜡烛。', done: (s) => hasItem(s, 'candle') },
  { text: '蜡烛 + 火石点起烛火，得到点燃的蜡烛。', done: (s) => hasItem(s, 'lit_candle') },
  { text: '举残破纸条在烛火上燎一下，显出字迹（显字纸条）。', done: (s) => hasItem(s, 'marked_note') },
  { text: '拿显字纸条去藏书阁，推开第三排的书，取得日记残页·三。', done: (s) => hasItem(s, 'diary_page3') },
  { text: '藏书阁取走纹样册。', done: (s) => hasItem(s, 'book_emblems') },
  { text: '井台取井绳，并解「井深百八尺」(108) 取得日记残页·二。', done: (s) => hasItem(s, 'rope') && hasItem(s, 'diary_page2') },
  { text: '藏书阁书架空缺处填入「影」字，取得日记残页·一。', done: (s) => hasItem(s, 'diary_page1') },
  { text: '三页日记两两拼合，得到完整日记（末页「灯七、井三、阁九」）。', done: (s) => hasItem(s, 'full_diary') },
  { text: '书房用三位数字 7-3-9 打开抽屉锁，取得铜刻度盘。', done: (s) => hasItem(s, 'brass_dial') },
  { text: '纸庭取银币；匠作间取钥匙模与锉刀，压出钥匙胚再锉出弧度，得到复刻钥匙。', done: (s) => hasItem(s, 'curved_key') },
  { text: '阁楼木箱取凸透镜，与铜刻度盘嵌合，得到聚光刻盘。', done: (s) => hasItem(s, 'lens_dial') },
  { text: '匠作间纹样压板只用心纹，取得铁钩；与井绳合成绳钩，可上高处。', done: (s) => hasItem(s, 'grappling_hook') },
  { text: '空白宣纸 + 蘸墨的笔按出折痕，画出地窖北墙的手绘地图。', done: (s) => hasItem(s, 'secret_map') },
  { text: '地窖用干粮喂饱纸鼠，它会带你找到北墙暗门。', done: (s) => hasItem(s, 'fed_mouse') },
  { text: '集齐润油钥匙、复刻钥匙、聚光刻盘，去门厅对准三联锁（逃出 / 焚城）。', done: (s) => hasItem(s, 'oiled_key') && hasItem(s, 'curved_key') && hasItem(s, 'lens_dial') },
  { text: '集齐手绘地图、聚光刻盘、吃饱的纸鼠，开地窖北墙暗门进入纸心（吹灭灯→隐藏结局）。', done: (s) => hasItem(s, 'secret_map') && hasItem(s, 'lens_dial') && hasItem(s, 'fed_mouse') },
];

export function hint(state, now) {
  state.hintsUsed += 1;
  bump(state, now);
  const total = WALKTHROUGH.length;
  const idx = WALKTHROUGH.findIndex((step) => !step.done(state));
  let text;
  if (idx < 0) {
    text = `攻略进度 ${total}/${total}（已全部完成）· 现在只需去门厅三联锁或地窖北墙暗门做结局选择。`;
  } else {
    const upcoming = WALKTHROUGH.slice(idx, idx + 3);
    const lines = upcoming.map((s, k) => `${k === 0 ? '下一步' : '之后'}：${s.text}`).join(' ｜ ');
    text = `通关攻略进度 ${idx}/${total}（前 ${idx} 步已完成）· ${lines}`;
  }
  log(state, '使用提示');
  return { ok: true, kind: 'hint', text, hintsUsed: state.hintsUsed };
}

export const HINT_STALL_MS = 90000;

/** 卡关判定：距上次动作 ≥90 秒且局面未结束。 */
export function shouldOfferHint(state, now, stallMs = HINT_STALL_MS) {
  if (state.endingId) return false;
  if (state.lastActionAt == null) return false;
  return now - state.lastActionAt >= stallMs;
}

export function hintCountdown(state, now, stallMs = HINT_STALL_MS) {
  if (state.lastActionAt == null) return stallMs;
  return Math.max(0, stallMs - (now - state.lastActionAt));
}

/* ------------------------------------------------------------ 进度 */

export function progress(state) {
  const itemsTotal = Object.keys(ITEMS).length - START_ITEMS.length;
  const ownable = Object.keys(ITEMS).filter((id) => !START_ITEMS.includes(id));
  return {
    roomsVisited: Object.keys(state.visits).length,
    roomsTotal: ROOM_IDS.length,
    itemsOwned: state.inventory.length,
    itemsTotal: Object.keys(ITEMS).length,
    itemsFound: ownable.filter((i) => state.inventory.includes(i)).length,
    itemsFindable: itemsTotal,
    clues: state.clues.length,
    cluesTotal: Object.keys(CLUES).length,
    puzzlesSolved: state.solvedPuzzles.length,
    puzzlesTotal: Object.keys(PUZZLES).length,
    recipesTotal: RECIPES.length,
    steps: state.steps,
    hintsUsed: state.hintsUsed,
    endingsTotal: Object.keys(ENDINGS).length,
    endingId: state.endingId,
  };
}

/** 收集度：0~1，用于结局分支展示。 */
export function collectionRatio(state) {
  const p = progress(state);
  const a = p.itemsFindable ? p.itemsFound / p.itemsFindable : 0;
  const b = p.cluesTotal ? p.clues / p.cluesTotal : 0;
  const c = p.puzzlesTotal ? p.puzzlesSolved / p.puzzlesTotal : 0;
  const d = p.roomsTotal ? p.roomsVisited / p.roomsTotal : 0;
  return Math.round(((a + b + c + d) / 4) * 100) / 100;
}

export function clueList(state) {
  return state.clues.map((id) => getClue(id)).filter(Boolean);
}

export function inventoryList(state) {
  return state.inventory.map((id) => getItem(id)).filter(Boolean);
}

export function endingSummary(state, now) {
  if (!state.endingId) return null;
  const e = getEnding(state.endingId);
  return {
    ...e,
    elapsedMs: elapsedMs(state, now),
    elapsedText: formatDuration(elapsedMs(state, now)),
    progress: progress(state),
    collection: collectionRatio(state),
  };
}
