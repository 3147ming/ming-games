# 仓库行动（简易 CF 网页 FPS）—— 公网部署文档

> 本项目为**纯静态前端项目**，无后端、无构建流程、无 npm 依赖。
> 只需把 `web/` 目录上传到任意静态托管服务，即可通过公网域名直接访问。
> 全部资源路径均为相对路径，兼容 Gitee Pages / GitHub Pages / Vercel / Netlify / Nginx / 阿里云 OSS / 腾讯云 COS 等任意静态托管平台。

---

## 一、项目结构说明

```
web/                              ← 整个目录即站点根目录，直接上传此目录内容
├── index.html                    ← 入口页面（含 import map、HUD、菜单）
├── .nojekyll                     ← 空文件，让 Gitee/GitHub Pages 不做 Jekyll 处理
├── _headers                      ← Netlify/Vercel/Cloudflare Pages 缓存策略
├── DEPLOY.md                     ← 本文档
│
├── styles/
│   └── hud.css                   ← HUD / 菜单 / 准星 样式
│
├── src/                          ← 游戏逻辑（原生 ES Module，无打包）
│   ├── main.js                   ← 启动入口
│   ├── config/weapon.js          ← 武器/伤害/AI 全部数值配置
│   ├── core/
│   │   ├── Game.js               ← 主控：状态机、环境检测、主循环
│   │   ├── AssetManager.js       ← FBX/贴图加载、路径重定向、加载进度
│   │   ├── AudioManager.js       ← 音效播放（MP3，距离衰减、并发控制）
│   │   ├── CollisionWorld.js     ← AABB 碰撞检测
│   │   └── Input.js              ← 键鼠输入
│   ├── player/                   ← 玩家控制器 / 鼠标视角 / 血量护甲
│   ├── weapons/                  ← 射击 / 换弹 / 后坐力 / 枪口火焰 / 弹壳
│   ├── enemies/                  ← 敌人 AI（巡逻/警戒/追击/交火）/ 管理器
│   ├── world/WarehouseMap.js     ← 仓库地图、掩体、光影、雾
│   └── ui/                       ← HUD 更新 / 菜单交互
│
├── vendor/three/                 ← 本地化的 Three.js（r150+，含 FBXLoader）
│   ├── three.module.js
│   ├── loaders/FBXLoader.js, TGALoader.js
│   ├── libs/fflate.module.js
│   ├── curves/, utils/
│
└── public/assets/                ← 已压缩的轻量化资源
    ├── audio/                    ← 16 个 MP3（64kbps，共约 184 KB）
    ├── textures/                 ← 3 张 WebP（共约 145 KB）
    └── models/                   ← 12 个 FBX（主模型+5 动画+4 箱子+武器，共约 8.3 MB）
```

**总体积约 10.3 MB**（其中 FBX 模型占 8.3 MB，可被服务器 gzip 进一步压缩传输）。

---

## 二、前置说明：为什么必须用 HTTPS 部署

浏览器出于安全考虑，对以下 API 做了**安全上下文（Secure Context）限制**，仅在 `https://` 或 `http://localhost` 下可用：

| API | 作用 | HTTP 公网下行为 |
|---|---|---|
| **Pointer Lock API**（鼠标锁定） | 瞄准、视角转动 | ❌ 被禁用，点击后无法锁定鼠标 |
| **Web Audio API（自动播放）** | 音效 | ⚠️ 需用户点击后才能播放（本项目已处理） |
| **WebGL2** | 3D 渲染 | ✅ 一般可用，但部分浏览器在 HTTP 下降级 |

**结论**：要获得完整的 CF 式鼠标锁定瞄准体验，**必须通过 HTTPS 域名访问**。
如果用户用 HTTP 打开，本项目会在页面顶部显示红色提示横幅：
> 当前为 HTTP 访问，浏览器限制鼠标锁定功能，推荐使用 HTTPS 链接打开游戏

---

## 三、部署方式 1：Gitee Pages（国内推荐，速度快）

Gitee Pages 提供免费 HTTPS 静态托管，国内访问速度快。

### 步骤

1. **注册 / 登录 Gitee**：<https://gitee.com>
2. **新建仓库**：
   - 仓库名称随意（例如 `warehouse-strike`）
   - 选择 **公开**（公开仓库才能开启 Pages）
   - 初始化方式选「不使用」或「使用 Readme」均可
3. **上传代码**：
   - 把本地 `web/` 目录内的**全部内容**上传到仓库根目录
   - 即仓库根目录应直接包含 `index.html`、`src/`、`public/`、`vendor/`、`.nojekyll`、`_headers`
   - 注意：`.nojekyll` 文件必须上传（否则 Gitee Pages 可能忽略 `_` 开头的文件/目录）
4. **开启 Gitee Pages**：
   - 进入仓库 → 「服务」→「Gitee Pages」
   - 部署分支选 `master`（或你上传代码的分支）
   - 部署目录留空（即根目录）
   - 勾选 **「强制 HTTPS」** ✅（关键）
   - 点击「启动」
5. **访问**：
   - 启动后得到地址形如 `https://你的用户名.gitee.io/仓库名/`
   - 用浏览器打开即可游玩

### 常见问题
- **404 / 资源加载失败**：检查是否上传了 `.nojekyll`；检查 `public/`、`vendor/` 目录是否完整上传。
- **鼠标锁定无效**：确认地址是 `https://` 开头；若 Gitee 未自动转 HTTPS，手动在地址前加 `https://`。
- **更新后不生效**：Gitee Pages 免费版需手动在「Gitee Pages」页面点「重新部署」。

---

## 四、部署方式 2：Nginx 静态托管（自有服务器）

适合有自己云服务器（阿里云/腾讯云/华为云 ECS）的场景。

### 1. 上传文件
```bash
# 在服务器上
mkdir -p /var/www/warehouse-strike
# 将本地 web/ 目录内容上传到 /var/www/warehouse-strike/
```

### 2. Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;   # 改成你的域名
    return 301 https://$host$request_uri;   # 强制跳 HTTPS
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    root /var/www/warehouse-strike;
    index index.html;

    # SSL 证书（用 certbot 申请 Let's Encrypt 免费证书）
    ssl_certificate     /etc/nginx/ssl/your-domain.com.pem;
    ssl_certificate_key /etc/nginx/ssl/your-domain.com.key;

    # 开启 gzip 压缩（FBX 模型可压缩 60%+）
    gzip on;
    gzip_types text/plain text/css application/javascript application/json
               model/obj model/gltf-binary application/octet-stream;
    gzip_min_length 1024;

    # FBX 模型 / 贴图 / 音频：缓存 30 天
    location /public/assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Three.js 依赖：缓存 30 天
    location /vendor/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # 脚本 / 样式：缓存 1 小时
    location ~* \.(js|css)$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    # HTML：不缓存，确保用户拿到最新版
    location ~* \.html$ {
        add_header Cache-Control "no-cache";
    }

    # 单页入口回退
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 3. 申请免费 HTTPS 证书（Let's Encrypt）
```bash
# 安装 certbot
apt install certbot python3-certbot-nginx   # Ubuntu/Debian
# 或 yum install certbot python3-certbot-nginx   # CentOS

# 自动签发并配置
certbot --nginx -d your-domain.com
```

### 4. 重载 Nginx
```bash
nginx -t && nginx -s reload
```

---

## 五、部署方式 3：Vercel / Netlify / Cloudflare Pages

这三个平台都提供**免费的全球 CDN + 自动 HTTPS**，无需配置服务器。

### Vercel
1. 注册 <https://vercel.com>，关联 GitHub/Gitee 仓库（或直接拖拽 `web/` 文件夹上传）
2. 框架预设选 **Other**，构建命令留空，输出目录填 `web`（若仓库根就是 web 内容则填 `.`）
3. 部署完成后自动得到 `https://xxx.vercel.app` 域名，自动 HTTPS

### Netlify
1. 注册 <https://netlify.com>
2. 直接把 `web/` 文件夹**拖拽**到页面空白处即可上传部署
3. 自动得到 `https://xxx.netlify.app`，自动 HTTPS
4. 本项目已附带 `_headers` 文件，Netlify 会自动应用缓存策略

### Cloudflare Pages
1. 注册 <https://pages.cloudflare.com>
2. 关联仓库，构建命令留空，输出目录填 `web`
3. 自动得到 `https://xxx.pages.dev`，自动 HTTPS

---

## 六、其他静态托管（阿里云 OSS / 腾讯云 COS）

### 阿里云 OSS
1. 创建 Bucket，读写权限设为「公共读」
2. 上传 `web/` 目录全部内容
3. 在 Bucket 的「基础设置」→「静态页面」中，默认首页填 `index.html`
4. 绑定自定义域名并开启 HTTPS（OSS 域名需配置 CDN 或证书）

### 腾讯云 COS
1. 创建存储桶，访问权限设为「公有读私有写」
2. 上传 `web/` 内容
3. 「基础配置」→「静态网站」开启，索引文档填 `index.html`
4. 绑定自定义域名，在 CDN 中配置 HTTPS 证书

---

## 七、本地预览（开发调试）

无需任何依赖，用任意静态服务器即可：

```bash
# Python 3
cd web
python -m http.server 8080

# 或 Node（npx）
npx serve web
```

然后浏览器打开 `http://localhost:8080`。
> 注意：`localhost` 被视为安全上下文，鼠标锁定在 localhost 下可用。

---

## 八、浏览器兼容性

| 浏览器 | 版本要求 | 备注 |
|---|---|---|
| Chrome / Edge | 90+ | ✅ 完整支持 |
| Firefox | 88+ | ✅ 完整支持 |
| QQ 浏览器 / 360 浏览器 | 最新版 | ✅ 基于 Chromium，需切到「极速模式」 |
| Safari | 15+ | ✅ 支持，需 HTTPS |
| IE | — | ❌ 不支持 |

**必须 HTTPS 才能完整使用鼠标锁定瞄准功能。**

---

## 九、更新与缓存

- 修改了 `src/*.js` / `styles/*.css` 后，用户刷新即可（缓存 1 小时）。
- 修改了模型/贴图/音频后，由于缓存 30 天，用户可能拿到旧资源。
  - 临时解决方案：让用户按 `Ctrl+F5` 强制刷新。
  - 正式方案：在文件名后加版本号（如 `zombie_v2.fbx`）并同步修改 `AssetManager.js` 中的引用。

---

## 十、故障排查

| 现象 | 原因 | 解决方案 |
|---|---|---|
| 加载进度卡在某个百分比 | 某个资源 404 | 打开浏览器 F12 → Network，查看哪个资源 404，检查文件是否上传完整 |
| 敌人显示为红色胶囊 | zombie.fbx 加载失败 | 确认 `public/assets/models/zombie.fbx` 存在且大小正常（约 1.27 MB） |
| 点击开始后鼠标没锁定 | HTTP 访问 | 使用 HTTPS 链接打开，或在 localhost 下测试 |
| 没有声音 | 浏览器自动播放策略 | 本项目已处理，点击画布后才加载音频；若仍无声，检查系统音量 |
| 画面黑屏 | 不支持 WebGL | 使用最新版 Chrome/Edge；老电脑可能不支持 WebGL2 |
