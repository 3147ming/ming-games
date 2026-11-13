# 知识问答（quiz）

书架式分类刷题：选择题 / 程序编写 / 填空题三个板块，719 道人工题 + 8 个生成器 + 615 行程式化题库 + 50 道手写题，支持 PWA 离线与 AI 建题。

线上入口：<https://ming-games.pages.dev/games/quiz/index.html>

---

## 一、源码与产物

**`index.html` 是生成文件，不要直接改。** 它由四片源码按固定顺序拼装：

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | `.build/head.html` | `<!DOCTYPE>` 到 `<script>`：CSS、静态骨架、无障碍标记 |
| 2 | `.build/build.js` 内的 `FRAMEWORK` | 全局框架：`S`（存储）、`shuffle`、`h`、`clearNode`、共享答题状态 |
| 3 | `.build/engine_core.js` | 引擎：题库 `POOLS`、`QA_TYPES`、`SUBJECT_GROUPS`、出题/判分/SRS |
| 4 | `src/wrongbook.js` | 错题本导出导入的纯函数（UMD，可在 Node 里单测） |
| 5 | `.build/quiz-ui.js` | UI：书架、答题、统计、AI 建题、音乐、设置 |
| 6 | `.build/build.js` 内的 `IDB` | IndexedDB 辅助（导入本地音乐） |

拼装顺序有依赖：`engine_core.js` 用到的全局符号必须在 `FRAMEWORK` 里先声明，`quiz-ui.js` 依赖引擎的函数。

```bash
node quiz/.build/build.js           # 生成产物 + 同步部署包 + 重算 SW 版本
node quiz/.build/build.js --check   # 只校验：产物 / 部署包 / SW / dist 是否与源码一致
```

`--check` 不一致时退出码为 1，并逐项打印实际值与期望值。

## 二、三份产物

| 位置 | 谁写入 | 说明 |
|---|---|---|
| `quiz/index.html` + `quiz/sw.js` | `.build/build.js` | 独立站形态（根目录发布时用） |
| `_deploy_gym/quiz/` | `.build/build.js` | 独立部署包，与上者逐字节相同 |
| `dist/games/quiz/` | `tools/build.mjs` | 统一大厅形态，多一层游戏桥与 SW 中和脚本，内容必然不同 |

三者的一致性由两处守：

- `node quiz/.build/build.js --check`：产物 / 部署包 / SW 版本严格比对 md5，`dist` 产物只校验「没被削成空壳」（体量 ≥ 产物 80% 且含 `id="shelf"`、`SUBJECT_GROUPS`）。
- `node tools/check-artifacts.mjs`：15 款 ready 游戏 × dist/offline 两形态的产物完整性。

> 历史事故：统一构建链的 `stripLegacyTags()` 曾把「含 `serviceWorker.register` 的整段脚本」删掉。quiz 的全部应用代码就在那一段里，产物因此只剩 39KB 外壳、题库 0 题。现在改成注入中和脚本，并加了体积护栏。

## 三、存储

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

## 四、音频

- 曲目按「基名 + 扩展名链」探测，扩展名顺序 `mp3 → flac → wav → m4a → ogg → aac`，`mp3` 命中最早。
- 仓库里放的是转码后的 128kbps MP3（`flower-dance.mp3` 4.1MB / `windy-hill.mp3` 4.7MB）。原始 flac 26MB / wav 54MB 不再入库，也不再进发布目录。
- `sw.js` 的 `AUDIO_WARM_MAX` 是 2MB：整首 BGM 不在安装阶段预热，等用户点了播放再缓存；`AUDIO_MAX_BYTES` 60MB 是单曲上限。
- 音频本身被 `.gitignore` 忽略，发布时由部署目录带上。新增曲目请直接放 MP3。

## 五、验证

```bash
node quiz/.build/build.js --check          # 产物一致性（秒级）
node tools/verify-all.mjs --unit           # 部署门禁 + 产物完整性 + 单元测试
node quiz/.build/_probe_shelf.cjs          # 书架四组 / 存储迁移 / 备份清单（32 项）
node quiz/.build/_runall.cjs 0 27          # 27 套 CDP 定向验证（约 30-60 分钟）
```

- `_runall.cjs` 逐套单独起浏览器，逐套落盘到 `_reg_<start>_<end>.txt`；**判定只看汇总行 `N/M 通过`，不要看退出码**（部分探针在失败时仍返回 0）。
- 浏览器类探针依赖本机 Edge 与 `cdp.cjs`，跑之前确认没有别的实例占着调试端口。

## 六、约束

1. 改样式/骨架 → `head.html`；改出题与判分 → `engine_core.js`；改交互 → `quiz-ui.js`；改错题本序列化 → `src/wrongbook.js`。
2. 改完必须 `node quiz/.build/build.js`，否则 `--check` 会拦。
3. `build.js` 写产物前会跑 `_guard_tags.cjs`：手写题语言标签缺失 / 非法直接阻断，不产出 `index.html`。
4. 产物首行带「生成文件」注释；新增任何构建路径都要保留这条标识。
