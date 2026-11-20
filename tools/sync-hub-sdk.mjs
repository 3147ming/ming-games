/* sync-hub-sdk.mjs — 从 shared/hub.mjs 生成 classic 版 src/hub/hub-sdk.js
 *
 * 为什么要生成：旧大厅（根目录 index.html）走 ESM `import './shared/hub.mjs'`；
 * 新大厅（src/hub）走 classic script + 占位符注入，没有 module 作用域。
 * 两份逻辑必须同源，本脚本是唯一生成入口，勿手改 hub-sdk.js。
 *
 * 用法：node tools/sync-hub-sdk.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'shared', 'hub.mjs');
const DST = path.join(ROOT, 'src', 'hub', 'hub-sdk.js');

let s = fs.readFileSync(SRC, 'utf8');
s = s.replace(/^export\s+(const|function|class)\b/gm, '$1');
const m = s.match(/^export default (\{[\s\S]*?\});?\s*$/m);
if (m) {
  s = s.slice(0, m.index) + 'globalThis.HubSDK = ' + m[1] + ';\n';
} else {
  s += "\nglobalThis.HubSDK = { VERSION, NS, GAMES, OWNER_TAGS, OTHER_TAGS, isOwner, todayKey, dailySeed, report, getBoard, getBest, legacyBest, mergedBoard, overview };\n";
}
const header = `/* hub-sdk.js — 跨游戏复玩性 SDK（classic 版，由 shared/hub.mjs 生成，勿手改）
 * 新大厅 src/hub 走 classic script + 占位符注入，不能用 ESM import。
 * 逻辑与 shared/hub.mjs 同源；同步命令：node tools/sync-hub-sdk.mjs。
 * 游戏都在同域 iframe 中，localStorage 与大厅共享。
 */
(function () {
'use strict';
`;
fs.writeFileSync(DST, header + s + '\n})();\n', 'utf8');
console.log(`[sync-hub-sdk] shared/hub.mjs -> src/hub/hub-sdk.js (${fs.statSync(DST).size} B)`);
