# 知识问答（quiz）

书架式分类刷题：选择题 / 程序编写 / 填空题三个板块，1314 道静态题（含电路与模拟电子 507 题）（权威数据在 `data/pools.json`）+ 生成器 + 50 道手写题，支持 PWA 离线与 AI 建题。

线上入口：<https://ming-games.pages.dev/quiz/>（实测可直开单文件形态）。统一构建形态在 `dist/games/quiz/index.html`，只有在 Cloudflare Pages 以 `dist` 为发布目录时才对应 `/games/quiz/index.html`；`deploy.config.json` 登记的是 `dist`，但线上实测以仓库根为发布目录，两条路径的差异见 `DEPLOY.md`，改线上配置前先量一次。

---

## 一、源码与产物

**`index.html` 是生成文件，不要直接改。** 它由 `quiz/src/` 下的源码片，加上 `build.js` 里的两段内联片段，按固定顺序拼装：

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | `src/head.html` | `<!DOCTYPE>` 到 `<script>`：CSS、静态骨架、无障碍标记 |
| 2 | `.build/build.js` 内的 `FRAMEWORK` | 全局框架：`S`（存储）、`shuffle`、`h`、`clearNode`、共享答题状态 |
| 3 | `src/logic.js` | **Q3 纯逻辑层**：SRS 间隔/降档/干扰项/`validItem`/状态合法性断言（UMD，Node 直接单测） |
| 4 | `src/net.js` | **A4 网络适配层**：超时/中断/错误分类/失败文案/显式降级表/逐源重试（UMD） |
| 5 | `src/state.js` | **Q1 单一状态源**：`qaState()` / `setQAState()` / `assertQAState()` |
| 6 | `src/engine_core.js` | 引擎：`POOLS` 镜像、`QA_TYPES`、`SUBJECT_GROUPS`、出题/判分/SRS |
| 7 | `src/wrongbook.js` | 错题本导出导入的纯函数（UMD） |
| 8 | `src/quiz-ui.js` | UI：书架、答题、统计、AI 建题、音乐、设置（整体包在 IIFE 内） |
| 9 | `.build/build.js` 内的 `IDB` | IndexedDB 辅助（导入本地音乐） |

拼装顺序有依赖：`engine_core.js` 用到的 `QALogic` / `QANet` 必须先注入，`quiz-ui.js` 依赖引擎与状态源的函数。所有自建 `vm` 沙箱探针都必须按同一顺序装配，否则报 `ReferenceError`。

**题库权威数据**：`data/pools.json`（12 分类 / 1314 题）。`engine_core.js` 里保留一段 JSON 生成的 `POOLS` 镜像，仅供「只装配 `engine_core.js`」的离线探针直接运行；`build.js` 在构建前用 `_pools.cjs` 校验 JSON，并断言镜像与 JSON 逐字一致，然后**用 JSON 序列化结果替换镜像**注入产物。改题流程：改 `pools.json` → `node quiz/.build/_pools.cjs --sync` → `node quiz/.build/build.js`。

```bash
node quiz/.build/build.js           # 生成产物 + 同步部署包 + 重算 SW 版本
node quiz/.build/build.js --check   # 只校验：产物 / 部署包 / SW / dist 是否与源码一致
node quiz/.build/_pools.cjs --check # 只校验题库 JSON 与引擎镜像
```

`--check` 不一致时退出码为 1，并逐项打印实际值与期望值。

## 二、三份产物

| 位置 | 谁写入 | 说明 |
|---|---|---|
| `quiz/index.html` + `quiz/sw.js` | `.build/build.js` | 独立站形态（线上 `/quiz/` 用的就是这份） |
| `_deploy_gym/quiz/` | `.build/build.js` | 独立部署包，与上者逐字节相同 |
| `dist/games/quiz/` | `tools/build.mjs` | 统一大厅形态，多一层游戏桥与 SW 中和脚本，内容必然不同 |

三者的一致性由两处守：

- `node quiz/.build/build.js --check`：产物 / 部署包 / SW 版本严格比对 md5（SW 版本 `quiz-<md5前10>` 由产物自动派生），`dist` 产物只校验「没被削成空壳」。
- `node tools/check-artifacts.mjs`：15 款 ready 游戏 × dist/offline 两形态的产物完整性。

> 历史事故：统一构建链的 `stripLegacyTags()` 曾把「含 `serviceWorker.register` 的整段脚本」删掉。quiz 的全部应用代码就在那一段里，产物因此只剩 39KB 外壳、题库 0 题。现在改成注入中和脚本，并加了体积护栏。

`games.json` 里 quiz 的 `copyIgnore: ["src","data"]` 阻止已内联的源码与题库 JSON 被拷进 `dist/offline`（题库是构建期序列化进 HTML 的，运行时不 fetch）。

## 三、架构分层（中长期重构结果）

- **新增学科 circuit（电路与模拟电子）**：507 题人工精编题库（5 档），与编程同等地位——同走 genStdPool、支持 diffMatters 自动升档、归入💻信息技术组；`_probe_circuit.cjs` 34 项接线校验 + `probe_circuit_ui.cjs` 10 项真实 UI 全流程。
- **Q1 单一状态源**：8 个并行模式标志（`autoMode` / `reviewMode` / `handMode` / `quizOver` / `locked` / `promoState` / `qaSection` / `customMixed`）以前散在 30 多处直接赋值。现在所有写点统一走 `setQAState(patch, ctx)`，先合并、再经 `QALogic.validateState()` 断言非法组合，最后一次性写回 8 个全局镜像（读点保持不动，避免改 3000+ 行）。关键入口 `showQuestion()` 还会 `assertQAState()`。
- **Q3 纯逻辑层**：SRS 间隔推进、降档判定、干扰项生成、`validItem` 抽成无 DOM 的纯函数，`_probe_logic.cjs` 做 62 项单测 + 200+200 组与旧实现的随机等价对照。
- **A4 网络适配层**：`FALLBACK` 显式降级表、`FAIL_TEXT`、`timedFetch`、`chain`、`reason`。联网题库 / `callAI` / `testAI` / `callAIRaw` 统一走它。注意 `envOf()` 必须用 `f.call(globalThis, ...)` 调用原生 `fetch` / `setTimeout`，否则浏览器里会 `Illegal invocation`。
- **P3 滚动重绘**：渐变背景改 `body::before` 固定合成层，顶栏 `backdrop-filter` 放进 `@supports` 兜底。

## 四、性能（P2 / P4：先测再动）

`_probe_perf.cjs` 是可复现的测量探针，结论是**不改代码结构**：

- **P2 首屏整包**：产物 523 KB / gzip 186 KB / br 162 KB（31%）。限速 1.6 Mbps / RTT 150ms 下，主文档下载完成 raw ~2.7s → br ~0.97s，LCP 中位数 448ms → 228ms。瓶颈是 HTML 整包下载，压缩已在线上生效；**不拆包**（会破坏离线单文件形态），主文档保持 `max-age=0` 以便 SW 版本即时生效。
- **P4 整卡重建**：`showQuestion()` 每次 `clearNode(stageEl)` 重建 40+ 节点。无限自适应连跑 100 题、每 25 题强制 GC 后量：堆 1005 KB → 1201 KB（+196 KB），DOM 节点与监听器零增长。按诊断「不要提前优化」，**不复用骨架**。
- 仓库根 `_headers` 只给 `/quiz/icons/*`、`/quiz/audio/*`（及 `/games/quiz/` 对应路径）7 天缓存；文件名不带内容哈希，所以**不加 `immutable`**。`tools/build.mjs` 在 web 形态把它复制进 `dist/_headers`，两种发布目录都覆盖；`offline/` 不带。

## 五、存储

20 个 `bt_qa_*` 键没有统一的版本号，导出备份的清单靠手工维护必然漏项。现在用一张注册表同时充当**备份清单**与**迁移目标**：

```js
var STORE_SCHEMA = 2;
var STORE_REG = { stats:{k:'bt_qa_stats',t:'obj',d:{},b:1}, ... };
var BACKUP_KEYS = /* 由 STORE_REG 里 b:1 的项派生，外加 bt_qa_schema */;
```

- **新增存储键只改 `STORE_REG` 一处**：`b:1` 自动进备份，`b:0` 不进（可重取的缓存，如联网题库）。
- 启动时 `migrateStore()` 幂等执行：只把「结构真的坏了」的键重置成默认值（JSON 解析失败 / `bt_qa_weak` 不是数组），合法数据逐字节不动；格式不确定的键（`profile_code`、`learn_before`、`quickjump`）完全不碰。
- 带前缀的动态键（`bt_qa_rank_*`、`bt_qa_recent_*`）按族进备份，由 `STORE_PREFIX_BACKUP` 声明。
- `_probe_shelf.cjs` 会反向扫描源码里的 `bt_qa_*` 字面量，出现游离在注册表外的键直接失败。

## 六、音频

- 曲目按「基名 + 扩展名链」探测，扩展名顺序 `mp3 → flac → wav → m4a → ogg → aac`，`mp3` 命中最早。
- 仓库里放的是转码后的 128kbps MP3（`flower-dance.mp3` 4.1MB / `windy-hill.mp3` 4.7MB）。原始 flac 26MB / wav 54MB 不再入库，也不再进发布目录。
- `sw.js` 的 `AUDIO_WARM_MAX` 是 2MB：整首 BGM 不在安装阶段预热，等用户点了播放再缓存；`AUDIO_MAX_BYTES` 60MB 是单曲上限。
- 音频本身被 `.gitignore` 忽略，发布时由部署目录带上。新增曲目请直接放 MP3。

## 七、验证

```bash
node quiz/.build/build.js --check          # 产物一致性（秒级）
node tools/verify-all.mjs --unit           # 部署门禁 + 产物一致性 + 产物完整性
node quiz/.build/_probe_logic.cjs          # Q3 纯逻辑 62 项
node quiz/.build/_probe_pools.cjs          # M3 题库 21 项
node quiz/.build/_probe_net.cjs            # A4 网络适配 37 项
node quiz/.build/_probe_state.cjs          # Q1 状态源 26 项
node quiz/.build/_probe_circuit.cjs        # circuit 学科接线 34 项
node quiz/.build/probe_circuit_ui.cjs      # circuit 真实 UI 全流程 10 项
node quiz/.build/_probe_perf.cjs           # P2 / P4 性能测量 + _headers 静态门禁
node quiz/.build/_runall.cjs 0 36          # 36 套定向验证（含浏览器探针，约 30-60 分钟）
```

- `_runall.cjs` 逐套单独起浏览器，逐套落盘到 `_reg_<start>_<end>.txt`；**判定只看汇总行 `N/M 通过` 或 `=== … N/M 通过 ===`，不要看退出码**（部分探针在失败时仍返回 0）。
- 浏览器类探针依赖本机 Edge 与 `cdp.cjs`。`probe_section.cjs` 的 A 段专用 vm 夹具显式声明 `qaSection=''`，因为 `state.js` 会把未声明的 `qaSection` 补成 `'choice'`；不这么做会让「无板块兜底」被误判成选择题板块。
- `_probe_perf.cjs` 用本地服务对同一份 HTML 做 br / 原样 A/B，并用 `performance.timeOrigin` 防串页；跑之前先 `node tools/build.mjs --target=web` 以生成 `dist/_headers`。

## 八、约束

1. 改样式/骨架 → `head.html`；改题库 → `data/pools.json` + 同步镜像；改出题与判分 → `engine_core.js`；改交互 → `quiz-ui.js`；改错题本序列化 → `src/wrongbook.js`。
2. 改完必须 `node quiz/.build/build.js`，否则 `--check` 会拦。
3. `build.js` 写产物前会跑 `_guard_tags.cjs`：手写题语言标签缺失 / 非法直接阻断，不产出 `index.html`。
4. 产物首行带「生成文件」注释；新增任何构建路径都要保留这条标识。
5. 新增源码片必须同时更新 `build.js` 与 `.build/_sandbox.cjs` 的装配顺序，否则 Node 探针先炸。
