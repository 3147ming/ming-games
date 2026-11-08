/**
 * 棋艺绘制层自检：用桩 Canvas 上下文跑一遍 draw，确保各模式绘制路径不抛异常。
 *   node tools/check-shanhai-render.mjs
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const here = resolve();
await import(pathToFileURL(resolve(here, 'shanhai/src/chess-core.mjs')).href);
await import(pathToFileURL(resolve(here, 'shanhai/src/chess-render.mjs')).href);
const Core = globalThis.ShanhaiChessCore;
const Render = globalThis.ShanhaiChessRender;

// 桩 Canvas 2D 上下文：任何方法都是空操作，渐变返回带 addColorStop 的对象。
const gradient = { addColorStop() {} };
const ctx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
    return () => {};
  },
  set() { return true; },
});

let fail = 0;
for (const m of Core.MODES) {
  try {
    const s = Core.createGame(m.id, { seed: 1 });
    const L = Render.computeLayout(s, 360, 480, 16);
    Render.draw(ctx, s, L, { selected: null, targets: [], lastMove: s.lastMove, hover: null });
    // 选子 + 合法点高亮（走子类）
    if (m.id === 'xiangqi') {
      const acts = Core.allActions(s, 'r').slice(0, 3);
      const a = acts[0];
      const sel = a.from || null;
      const targets = acts.map((ac) => ({ x: ac.to[0], y: ac.to[1], action: ac }));
      Render.draw(ctx, s, L, { selected: sel, targets, lastMove: s.lastMove });
    }
    if (m.id === 'gomoku') {
      Render.draw(ctx, s, L, { hover: [7, 7] });
    }
    console.log('  ✓ ' + m.name + ' 绘制无异常');
  } catch (e) {
    fail++;
    console.log('  ✗ ' + m.name + ' 绘制抛错：' + e.message);
  }
}
// 布局命中测试：点中心格应落在棋盘内
const s = Core.createGame('xiangqi');
const L = Render.computeLayout(s, 360, 480, 16);
const hit = Render.cellAt(L, L.ox + L.cell * 4 + L.cell / 2, L.oy + L.cell * 5 + L.cell / 2);
if (hit && hit[0] === 4 && hit[1] === 5) console.log('  ✓ 布局命中换算正确');
else { fail++; console.log('  ✗ 布局命中换算错误：' + JSON.stringify(hit)); }

console.log(fail ? `\n失败 ${fail} 项` : '\n绘制层自检全部通过');
process.exit(fail ? 1 : 0);
