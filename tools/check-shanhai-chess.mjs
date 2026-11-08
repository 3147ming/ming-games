/**
 * 棋艺核心逻辑自检（开发期用，不参与构建）。
 *   node tools/check-shanhai-chess.mjs
 * 验证：各模式开局合法、规则正确、AI 能落子、自对弈不崩。
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const here = resolve();
await import(pathToFileURL(resolve(here, 'shanhai/src/chess-core.mjs')).href);
const C = globalThis.ShanhaiChessCore;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（得到 ${a}，期望 ${b}）`); }

function selfPlay(mode, plies, seed) {
  let s = C.createGame(mode, { seed });
  let guard = 0;
  while (s.status === 'playing' && guard < plies) {
    s = C.prepareTurn(s);
    if (s.status !== 'playing') break;
    const a = C.aiAction(s, s.turn);
    if (!a) break;
    s = C.applyAction(s, a);
    guard++;
  }
  return s;
}

console.log('— 象棋 —');
{
  const s = C.createGame('xiangqi');
  eq(s.board.length, 10, '棋盘 10 行');
  eq(s.board[0].length, 9, '棋盘 9 列');
  eq(C.allActions(s, 'r').length > 0, true, '红方有合法开局');
  // 炮二平五式：红炮 (7,1) 应可平移到 (7,4)
  const cannon = C.actionsAt(s, 1, 7, 'r').find((a) => a.to && a.to[0] === 4);
  ok(cannon, '红炮可从 (1,7) 走到 (4,7)');
  // 飞将：把两将中间的子清空，红将直上时应当被禁（这里只验证 generalsFacing 函数）
  ok(typeof C._internal.generalsFacing(s) === 'boolean', 'generalsFacing 可调用');
  // AI 落子
  const a = C.aiAction(s, 'r');
  ok(a && (a.from || a.to), '象棋 AI 返回动作');
  const ns = C.applyAction(s, a);
  ok(ns.board.length === 10, 'AI 走子后棋盘完整');
  // 自对弈若干回合不崩
  const sp = selfPlay('xiangqi', 6, 123);
  ok(sp.status === 'playing' || sp.winner, '象棋自对弈 6 手无异常');
}

console.log('— 五子棋 —');
{
  const s = C.createGame('gomoku');
  eq(s.board.length, 15, '棋盘 15 行');
  // 红连五（强制红方连续落子以验证胜负判定）
  let cur = s;
  const line = [[7, 7], [7, 8], [7, 9], [7, 10], [7, 11]];
  for (const [x, y] of line) { cur.turn = 'r'; cur = C.applyAction(cur, { to: [x, y] }); }
  eq(cur.status, 'over', '五子连珠判胜');
  eq(cur.winner, 'r', '连五者（红）获胜');
  // AI
  const a = C.aiAction(C.createGame('gomoku'), 'r');
  ok(a && a.to, '五子棋 AI 返回落点');
  const sp = selfPlay('gomoku', 30);
  ok(sp.status === 'playing' || sp.winner, '五子棋自对弈 30 手无异常');
}

console.log('— 西洋跳棋 —');
{
  const s = C.createGame('checkers');
  eq(s.board.length, 8, '棋盘 8 行');
  const acts = C.allActions(s, 'r');
  eq(acts.length > 0, true, '红方有合法开局');
  ok(acts.every((a) => a.from && a.to), '开局动作均为移动');
  const a = C.aiAction(s, 'r');
  ok(a && a.from, '跳棋 AI 返回动作');
  const ns = C.applyAction(s, a);
  eq(C.countPieces(ns, 'r') + C.countPieces(ns, 'b'), 24, '走子后子数守恒（无吃子开局）');
  const sp = selfPlay('checkers', 40);
  ok(sp.status === 'playing' || sp.winner, '跳棋自对弈 40 手无异常');
}

console.log('— 暗棋 —');
{
  const s = C.createGame('banqi', { seed: 7 });
  let down = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) if (s.board[y][x] && s.board[y][x].faceUp === false) down++;
  eq(down, 32, '三十二子初始皆覆面');
  // 翻棋动作
  const flip = C.actionsAt(s, 0, 0, 'r').find((a) => a.flip);
  ok(flip, '可翻 (0,0)');
  const ns = C.applyAction(s, flip);
  ok(ns.board[0][0].faceUp === true, '翻棋后该子翻开');
  ok(ns.turn === 'b', '翻棋后轮到黑方');
  // 贪心 AI
  const a = C.aiAction(s, 'r');
  ok(a, '暗棋 AI 返回动作（翻或吃）');
  const sp = selfPlay('banqi', 60, 7);
  ok(sp.status === 'playing' || sp.winner, '暗棋自对弈 60 手无异常');
}

console.log('— 翻转棋（Reversi）—');
{
  const s = C.createGame('reversi');
  eq(C.countSide(s, 'r'), 2, '初始红 2 子');
  eq(C.countSide(s, 'b'), 2, '初始黑 2 子');
  const acts = C.allActions(s, 'b');
  eq(acts.length, 4, '开局黑方恰好 4 个合法点');
  const a = acts[0];
  const ns = C.applyAction(s, a);
  ok(C.countSide(ns, 'b') >= 3, '落子后黑子数增加（夹反生效）');
  ok(ns.turn === 'r' || ns.passed === true || ns.status === 'over', '落子后轮转正常（含 pass）');
  const ai = C.aiAction(s, 'b');
  ok(ai && ai.to, '翻转棋 AI 返回落点');
  const sp = selfPlay('reversi', 60);
  ok(sp.status === 'playing' || sp.winner, '翻转棋自对弈 60 手无异常');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
