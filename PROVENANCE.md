# PROVENANCE.md · 来源追踪（P1）

> 本文件登记统一大厅 `D:\Projects\_github_pages\ming-games\`（ROOT）内每一份内容的**来源、纳入方式、取舍理由**。它是 `LICENSES.md` 与 `LIMITS.md` 的来源依据。**全程不 push、不部署**；本阶段只做登记，不执行归档/拷贝/发布动作。

## 1. 13 个既有游戏（ROOT 根目录一级子目录）

13 个既有主站卡片本身就是 ROOT 的一级子目录，业务源码原地保留、零 diff。其 `status` 逐条见 `games.json`（`ready`=已接入构建链，`pending`=待接入）：

| ROOT 一级子目录 | games.json id | status |
|---|---|---|
| `wild/` | `wild` | pending |
| `soudache/` | `raid` | pending |
| `one-card/` | `card` | ready |
| `brain-gym/` | `gym` | ready |
| `night-shift/` | `sim` | pending |
| `zhaoyun/` | `zhaoyun` | ready |
| `quiz/` | `quiz` | ready |
| `circuit-lab/` | `lab` | pending |
| `paper-maze/` | `paper-maze` | ready |
| `neon-rhythm/` | `neon-rhythm` | pending |
| `pixel-runner/` | `pixel-runner` | pending |
| `grass-cutter/` | `grass-cutter` | pending |
| `shanhai/` | `shanhai` | ready |

> `enlisten/` 目录当前仅含占位 `version.json`，属 P5 新增，不计入 13 个既有游戏。

## 2. 外部项目纳入

### future-light ← `D:\Projects\FUTURE-LIGHT`
- git HEAD：`a32aba1`（已核实 `git rev-parse --short HEAD`）。
- 核心文件：`src/core/store.js`、`src/core/shell.js`、`src/core/contract.js`、`src/games/*.js`（connect / conveyor / dual / light / match3 / nonogram / octagram / stroop 共 8 款）。
- 纳入方式：P1 收录到 ROOT `future-light/`（目录稍后建），`LIMITS.md` 中 L01–L04 的路径按未来 ROOT 相对路径登记，当前实际读取的是外部 `D:/Projects/FUTURE-LIGHT/src/`。
- `games.json` 标记 `source: D:/Projects/FUTURE-LIGHT`、`addedIn: P1`、`listed: false`。

### warehouse-strike ← `D:\Projects\WAREHOUSE-STRIKE`
- **本地快照 commit `3cea92d`**（`snapshot: 固化 42 条在途改动…`），前一次 HEAD 为 `15219cb`。
- 已核实的快照规模：`40 files changed, 8627 insertions(+), 199 deletions(-)`（即 40 文件 / +8627−199）。
- **实验系统清单（必须标 `experimental`，feature flag 默认 `false`）**：
  `AwakeningSystem` / `PerkSystem` / `TrapSystem` / `ThrowSystem` / `DayNightSystem` / `Minimap` / `PostFX`，以及对应的 config / ui：
  `src/config/awakening.js`、`src/config/perks.js`、`src/config/traps.js`、`src/ui/Minimap.js`、`src/ui/PerkUI.js`、`src/ui/ThrowUI.js`、`src/world/ThrowSystem.js`、`src/world/TrapSystem.js`、`src/core/DayNightSystem.js`、`src/core/PostFX.js` 等（共 12 个系统文件）。
  > 说明：外部仓库当前源码中**不存在** `experimental` / feature flag 常量；`experimental` 归类与「默认 false」是 P1 的受控收录策略（`LIMITS.md` L35 因此标注 `anchor: null`），由 P3 在收录层落实。
- **5 个 `tools/_analyze_glb*.mjs` 探针不拷入**：当前 `tools/` 目录只有 `cdp.mjs`、`check.mjs`、`probe.mjs`、`probe-viewmodel.mjs` 四个文件，git 历史中亦未检索到 `_analyze_glb*.mjs`（属一次性临时探针，不纳入大厅产物）。

### lab-sandbox 与 lab（`circuit-lab`）同源
- `D:\Projects\lab-simulator\js\*.js` 共 **36** 个文件，与 `ROOT\circuit-lab\js\*.js` 的 **36** 个文件经 SHA256 全量比对**逐一同名一致**（`diff` 为空，36/36）。
- 结论：**共用一份逻辑、两个入口 HTML**；`games.json` 中 `lab-sandbox` 标记 `sharesSourceWith: "lab"`、`source: D:/Projects/lab-simulator`。
- 对应 `src/openall/lab/openall.json` 为唯一一份逻辑配置，`src/openall/lab-sandbox/openall.json` 写成 `{"sharesWith":"lab"}` 指针（见 `INDEPENDENT_LOGIC=16`）。

### enlisten ← `D:\Projects\EN-LISTEN`
- 来源为 **Kotlin Android App**（`app/`、`build.gradle.kts`、`gradle/` 等）。
- **网页版为新建**（P5），只移植纯函数与演示数据；**不并入 `.so` / APK**。已核实的原生库如 `libsherpa-onnx-c-api.so`、`libsherpa-onnx-jni.so`、`libllama.so`、`libggml.so`、`libonnxruntime.so` 等均留在外部仓库，不进入网页版产物。详见 `LICENSES.md`。

## 3. 归档（本阶段只登记，不执行）

| 来源 | 归档目标 | 理由 |
|---|---|---|
| `D:\Projects\HUB`（surge 跳转镜像） | `D:\Projects\_archive\` | 历史跳转镜像，不并入主站 |
| `D:\Projects\WorldHub`（2D 世界大厅，23 条 ITEMS 多为第三方开源） | `D:\Projects\_archive\` | 许可与重复内容原因 |
| `D:\Projects\zuoye`（WorldHub 旧快照 v1.3.0） | `D:\Projects\_archive\` | 旧快照 |
| `D:\Projects\deploy-hub.bat` | `D:\Projects\_archive\` | 历史发布脚本 |
| ROOT 根 `index.html`（旧大厅） | `D:\Projects\_archive\old-lobby\` | 旧大厅，交由 `src/hub/hub.html` 模板替代 |

> 说明：`D:\Projects\_archive\` 目前尚不存在，归档动作留待后续批次执行；`HUB` / `WorldHub` / `zuoye` / `deploy-hub.bat` 当前均仍在 `D:\Projects\` 下。ROOT 根 `index.html` 本阶段**只读、不改动**。

## 4. 纪律

- **全程不 push、不部署**：不执行 `git add` / `git commit` / `git push`，不触发 `tools/build.mjs`（避免写 `dist/` / `offline/`），不触碰 Cloudflare Pages。
- 不修改 `games.json`、`tools/build.mjs`、`index.html`、`DECISIONS.md`、`DEPLOY.md` 等既有文件。
- 16 份既有业务源码保持零 diff；解锁由 P3 构建期 patch 层实现。
