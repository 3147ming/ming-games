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

/* ------------------------------------------------------------ 提示 */

const HINT_RULES = [
  { when: (s) => !hasItem(s, 'flint') || !hasItem(s, 'note_torn'), text: '囚室里的东西还没摸全：草席下面硌人，墙缝里塞着纸。' },
  { when: (s) => !hasItem(s, 'iron_rod'), text: '灶房的柴堆里插着一根铁钎——书房书架后面那扇翘起的纸板门需要它。' },
  { when: (s) => !isSolved(s, 'cellar_weight') && !hasItem(s, 'rusty_key'), text: '地窖的天平要你把秤砣分成几等份；答案写在那本账本的最后一页。' },
  { when: (s) => hasItem(s, 'rusty_key') && !hasItem(s, 'oiled_key'), text: '锈钥匙转不动。厨房拿到的油壶可以润开它——把两样东西合成一下。' },
  { when: (s) => !hasItem(s, 'candle') && !hasItem(s, 'lit_candle'), text: '灯堂的四座灯台要按顺序点。顺序在纸庭石碑的拓片上：骨、烛、纸、心。' },
  { when: (s) => hasItem(s, 'note_torn') && !hasItem(s, 'marked_note'), text: '残破纸条要用火燎才会显字。先想办法点起一根蜡烛。' },
  { when: (s) => hasItem(s, 'marked_note') && !hasItem(s, 'diary_page3'), text: '显字纸条上写着藏东西的地方——去藏书阁推一推第三排的书。' },
  { when: (s) => !hasItem(s, 'diary_page1'), text: '藏书阁那排歪斜的书脊连成一句缺字的话，缺的那个字写在显字纸条上。' },
  { when: (s) => !hasItem(s, 'diary_page2'), text: '井栏刻痕是三位数，石碑拓片上拼得出「井深百八尺」。' },
  { when: (s) => !hasItem(s, 'full_diary') && hasItem(s, 'diary_page1'), text: '三页日记可以两两拼起来，拼到最后会告诉你三个数字。' },
  { when: (s) => hasItem(s, 'full_diary') && !hasItem(s, 'brass_dial'), text: '书房抽屉是三位数字锁，数字就在完整日记的最后一页：灯七、井三、阁九。' },
  { when: (s) => !hasItem(s, 'grappling_hook') && (!hasItem(s, 'hook') || !hasItem(s, 'rope')), text: '想去阁楼得有绳钩：井绳在井台，铁钩在匠作间的纹样压板后面——纹样册说匠人只用心纹。' },
  { when: (s) => !hasItem(s, 'lens_dial'), text: '铜刻度盘中央是空的，阁楼木箱里有枚凸透镜，两者嵌在一起才有用。' },
  { when: (s) => !hasItem(s, 'curved_key'), text: '银币配钥匙模能压出钥匙胚，再用锉刀锉出弧度，就是复刻钥匙。' },
  { when: (s) => !hasItem(s, 'secret_map'), text: '书房的空白宣纸上有折痕，用蘸墨的笔把折痕按出来，就是一张地图。' },
  { when: (s) => !hasItem(s, 'fed_mouse'), text: '地窖的纸鼠闻到干粮就会带路——把干粮和它合成起来。' },
  { when: (s) => hasItem(s, 'oiled_key') && hasItem(s, 'curved_key') && hasItem(s, 'lens_dial') && !s.endingId, text: '三门要件都齐了。去地窖北边那道纸门，门厅的三联锁在等你。' },
  { when: (s) => s.clues.length < 8 && hasItem(s, 'lens_dial'), text: '地窖北墙的暗门要地图、刻盘和带路的纸鼠三样齐全，而且你得先看遍这座宅子。' },
];

export function hint(state, now) {
  const rule = HINT_RULES.find((r) => {
    try {
      return r.when(state);
    } catch {
      return false;
    }
  });
  state.hintsUsed += 1;
  bump(state, now);
  const text = rule ? rule.text : '把还没点过的物件都点一遍；日记面板里记着你已知的所有线索。';
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
