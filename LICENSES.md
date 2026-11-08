# LICENSES.md · 素材与许可登记（P1）

> 口径：自研项目标「用户自研」；第三方开源按上游许可登记并注明来源；明确「不并入」的资产给出许可/合规原因。本文件只做登记，不改变任何既有源码，也不触发构建与部署。

| 素材来源 | 许可 | 是否并入产物 | 备注 |
|---|---|---|---|
| ROOT 13 张既有主站卡片：`wild` / `raid`(soudache) / `card`(one-card) / `gym`(brain-gym) / `sim`(night-shift) / `zhaoyun` / `quiz` / `lab`(circuit-lab) / `paper-maze` / `neon-rhythm` / `pixel-runner` / `grass-cutter` / `shanhai` | 用户自研 | 是 | 13 个 ROOT 一级子目录，业务源码零 diff；`status` 见 `games.json` |
| `future-light` ← `D:\Projects\FUTURE-LIGHT` | 用户自研 | 是（P1 收录） | git HEAD `a32aba1`；`LIMITS.md` L01–L04 的解限目标由 P3 patch 层实现，源码不改 |
| `warehouse-strike` ← `D:\Projects\WAREHOUSE-STRIKE` | 用户自研 | 是（受控收录） | 本地快照 `3cea92d`；12 个实验系统标 `experimental`、feature flag 默认 `false`；5 个 `tools/_analyze_glb*.mjs` 探针不拷入 |
| `lab-simulator` ← `D:\Projects\lab-simulator` | 用户自研 | 是（共用逻辑） | `js/*.js` 36 文件与 `circuit-lab/js/*.js` SHA256 全量一致，两个入口 HTML 共用一份逻辑 |
| `enlisten` ← `D:\Projects\EN-LISTEN`（Kotlin Android App） | 用户自研 | 部分（仅网页版新建内容） | 纯函数与演示数据移植；`.so` / APK **不并入**网页版；`LIMITS.md` 无该游戏的既有源码限制条目 |
| `soudache/vendor/three.module.js` | MIT（three.js r160，来源：https://github.com/mrdoob/three.js / https://threejs.org/） | 是 | 已核实版本常量 `t="160"`；随 `soudache/` 原样保留，零 diff |
| `night-shift/vendor/three.module.js` | MIT（three.js r160，来源：https://github.com/mrdoob/three.js） | 是 | 同上 |
| `grass-cutter/vendor/three/three.module.js` 与 `grass-cutter/vendor/three/jsm/loaders/GLTFLoader.js`（jsm addons） | MIT（three.js r160 及其 addons，来源：https://github.com/mrdoob/three.js） | 是 | `REVISION` 常量可核；GLTFLoader 属 three 官方 jsm addons，随仓库原样保留 |
| `WAREHOUSE-STRIKE/vendor/three/loaders/GLTFLoader.js`（外部仓库内） | MIT（three.js r160 addons） | 是（受控收录时随仓库带入） | 来源同上；不单独改写 |
| `shared/tokens.css`（ROOT 及各游戏 `shared/tokens.css` 副本） | 本项目自研 | 是 | 共用设计 token，非第三方；各游戏内为同源副本 |
| WorldHub 的 **23 条第三方开源 ITEMS**（`D:\Projects\WorldHub`） | 多源第三方开源许可（如 soundmanager2 的 BSD 等，逐条未逐一审计） | **否（不并入产物）** | 许可原因：ITEMS 多为第三方开源、授权未逐条核对，且内容与主站重复；随 WorldHub 整体归档到 `D:\Projects\_archive\`，不进入大厅 |
| EN-LISTEN 的 `sherpa-onnx` / `llama.cpp` 原生库：`libsherpa-onnx-c-api.so`、`libsherpa-onnx-jni.so`、`libllama.so`、`libggml.so`、`libonnxruntime.so` 等 | 各自上游开源许可（sherpa-onnx / llama.cpp / ONNX Runtime，未逐一审计） | **否（不并入网页版）** | 网页版为新建，原生 `.so` / APK 与 Android 构建产物留在外部仓库；不做二进制移植、不做许可再分发 |
| `HUB` / `zuoye` / `deploy-hub.bat` / ROOT 旧大厅 `index.html` | 用户自研（历史残余） | 否（归档，不并入） | 归档到 `D:\Projects\_archive\` 与 `D:\Projects\_archive\old-lobby\`；本阶段只登记不执行 |

## 说明

- 「是否并入产物」指是否进入 `dist/` / `offline/` 的统一大厅产物；本阶段不生成产物，判断为 P1 收录口径。
- three.js 及其 jsm addons 均为 MIT，允许随产物分发（保留版权声明即可）；已按来源登记，未改动上游文件。
- `shared/tokens.css` 头部注释明确为「ming-games 共用设计 token」，属本项目自研，不属第三方素材。
- WorldHub 的 23 条 ITEMS 与 EN-LISTEN 原生库**均不并入**，这是许可与合规层面的显式取舍，不是遗漏。
- **全程不 push、不部署**。
