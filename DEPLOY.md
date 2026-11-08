# 构建与部署

> 域名与写目标的唯一真源是 `deploy.config.json`。本文件只描述流程，不登记域名。

## 三种打开形态

| 形态 | 入口 | 适用 |
|---|---|---|
| 双击离线 | `offline/index.html` | 断网、U 盘、无需 Node；全部资源本地相对引用 |
| 本地服务 | `serve.bat` → `http://127.0.0.1:5390/` | 3D 大文件、多标签、开发与验收 |
| 线上 | `https://ming-games.pages.dev/` | 分享；**推送前必须先经用户确认** |

`serve.bat` 会先跑一次 `--target=all` 再起服务，保证 `dist/` 与源码一致。

## 构建命令

```bash
node tools/build.mjs --target=all          # 生成 dist/ 与 offline/
node tools/build.mjs --target=web          # 只生成 dist/
node tools/build.mjs --target=offline      # 只生成 offline/
node tools/build.mjs --game=paper-maze --target=all
node tools/build.mjs --no-openall          # P3 起：生成原版行为产物作为回退对照
node tools/check-deploy.mjs                # 部署写目标门禁
node tools/anchor.mjs --selftest           # 大文件改写纪律自检
node server.mjs --root=offline --port=5391 # 用 http 验证 offline 产物
```

产物目录 `dist/` 与 `offline/` 每次整体重建，是可再生产物；源码在 `games.json` 登记的 `dir` 下，构建过程**不修改任何游戏业务源码**。

## 产物结构

```
dist/ (或 offline/)
  index.html              大厅（由 src/hub/hub.html 模板生成）
  covers/                 卡片封面（真实游戏截图，非占位）
  games/<id>/index.html   单游戏产物（CSS 内联、ESM 转 classic、桥注入）
  games/<id>/assets/...   非代码资源
dist.manifest.json / offline.manifest.json   逐文件 sha256 + 体积
```

## 线上发布流程（需用户确认后执行）

1. `node tools/build.mjs --target=all`
2. `node tools/check-deploy.mjs`（必须为 0 违规）
3. `node tools/verify-all.mjs --target=all --unit --report`（P6 起提供，全绿才继续）
4. `git add -A && git commit && git push`（仓库 `3147ming/ming-games` master）
5. Cloudflare Pages 自动构建：`build` 命令见 `deploy.config.json` 的 `build.web`，publish 目录 `dist`

## 门禁说明

- `tools/check-deploy.mjs` 扫描活跃构建链，发现对 `frozen` / `deprecated` / `readonly` 域名的写入意图即失败。
- 两个曾互相覆盖的 surge 域名已冻结；仓库外的历史发布脚本只报告、不阻断，P1 归档时停用。
- `tools/anchor.mjs` 是所有大文件改写的唯一入口：锚点命中次数不为 1 立即抛错且不写盘，规避本环境的静默丢写风险。

## 三形态一致性

`dist/` 与 `offline/` 的游戏逻辑 JS 由同一份 `tools/esm-to-classic.mjs` 产物生成，SHA256 必须一致；差异仅限 `file://` 所需的资源内联、fetch shim、Worker blob 与存储降级。`verify-all.mjs` 会对此做静态断言。
