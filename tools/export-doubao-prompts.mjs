/* export-doubao-prompts.mjs — 从真源 src/art/cover-prompts.json 生成可复制给豆包的指令单
 *
 * 用法：node tools/export-doubao-prompts.mjs
 * 产物：DOUBAO-PROMPTS.md（用 LF 写入，避免 Windows CRLF diff 爆炸）
 * 目的：提示词只维护一份（cover-prompts.json），豆包手贴版与 Seedream API 版不会跑偏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/art/cover-prompts.json'), 'utf8'));
const lines = [];
const add = (...xs) => lines.push(...xs);

add('# 给豆包的生图指令（统一大厅封面）');
add('');
add('> 真源：`src/art/cover-prompts.json`。本文件由 `node tools/export-doubao-prompts.mjs` 生成，不要手改。');
add('> 用法：把下面每一段**单独**粘进豆包的「图片生成」，出 4 张原图后发回给我。');
add('');
add('## 一、豆包里的设置');
add('');
add('- 模式：图片生成 / AI 作图（不要在普通对话里顺带让它出图）');
add('- 比例：**3:2 横版**，或 16:9；别用 1:1 方图，主体会被裁掉');
add('- 清晰度：选最高档 / 高清');
add('- 一次只发**一段**指令、出 1 张；4 段分 4 次，不要把四段塞进一条消息');
add('- 若有质感选项，选「3D」「可爱」「插画」，别选「写实」「摄影」');
add('');
add('## 二、四段指令（逐段复制，代码块内全部复制）');
add('');
const names = {
  'warehouse-strike': '仓库行动',
  'lab-sandbox': '电路实验 · 沙盒版',
  enlisten: '英语听力 · 网页版'
};
cfg.items.forEach((it, i) => {
  add(`### ${i + 1}. ${names[it.id] || it.id}  →  文件名建议 \`${it.id}.png\``);
  add('');
  add('```text');
  add(cfg.common + it.subject);
  add('```');
  add('');
});
add('## 三、发回给我时');
add('');
add('- 发**原图**（PNG / JPG / WebP 都行），不要压缩、不要裁剪、不要拼成一张长图');
add('- 每张告诉我对应哪个主题，或把文件命名成 `warehouse-strike` / `lab-sandbox` / `enlisten`');
add('- **可以分批发**，几张都行，我按文件名精确对应，不用凑齐 4 张');
add('- **水印不用管**：豆包叠加的「AI生成」标识我这边会裁掉；若水印压在主体上，跟我说，我让你重生成或单独修');
add('- 若画面里出现中文标题、字母或数字，也告诉我一道——成品封面要求画面内零文字');
add('');
add('## 四、我收到后会做');
add('');
add('1. 存到 `.tmp/covers-doubao/`，按 id 命名');
add('2. 看图确认水印位置，必要时用 `--trim=` 调整底部裁切比例');
add('3. `node tools/build-covers.mjs --src=.tmp/covers-doubao` → 统一 1280×800 WebP（约 70–100KB/张）');
add('4. 上墙到 `covers/`，跑 `node tools/build.mjs --target=all`、部署门禁与无头浏览器验收');
add('5. 本地 commit（**不 push、不部署**），把换图前后对比发给你看');
add('');
add('## 五、通用模板（后续 P4 批量素材可复用）');
add('');
add('固定风格前缀不要改：');
add('');
add('```text');
add(cfg.common);
add('```');
add('');
add('只替换主体句：');
add('');
add('```text');
add('主题：<主题>。一个圆滚滚的 Q 版<主角>（大眼睛、腮红、<特征>）站在画面右侧，周围有<3–6 个元素>。配色：<4 色>。');
add('```');
add('');
add('角色立绘 / 图标 / UI 框体是另一套构图，别套横版封面模板；需要时我再给对应指令。');
add('');

const text = lines.join('\n');
fs.writeFileSync(path.join(ROOT, 'DOUBAO-PROMPTS.md'), text);
console.log(`=== 已生成 DOUBAO-PROMPTS.md：${cfg.items.length} 段指令，${Buffer.byteLength(text)} B ===`);
console.log('ids: ' + cfg.items.map((x) => x.id).join(', '));
