/**
 * 构建脚本：把 src 全部 ES 模块打包成单个 minified bundle，
 * 文件名带内容哈希（soudache.<hash>.js），实现部署时的版本指纹。
 *
 * 用法（在 soudache 目录下）：node build.js
 * 产物输出到 build/ 目录，供部署（surge）使用。
 *
 * 背景：surge 的 keep-alive 只有 5s，21 个模块请求在弱网下容易复用已断开的
 * 空闲连接被 RST。打包成单文件后首屏只剩 1 个 JS 请求。
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const BUILD = path.join(ROOT, 'build');

// 1) 清掉旧 bundle，避免残留多个带哈希文件
fs.mkdirSync(BUILD, { recursive: true });
for (const f of fs.readdirSync(BUILD)) {
  if (/^soudache\..+\.js$/.test(f)) {
    try { fs.unlinkSync(path.join(BUILD, f)); } catch (e) { /* 忽略 */ }
  }
}

// 2) esbuild 打包（本地 node_modules 安装）
const outTmp = path.join(BUILD, 'soudache.tmp.js');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src', 'main.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  outfile: outTmp,
  logLevel: 'warning',
});

// 3) 内容哈希命名
const code = fs.readFileSync(outTmp);
const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 10);
const finalName = `soudache.${hash}.js`;
fs.renameSync(outTmp, path.join(BUILD, finalName));

// 4) 写一份 index.html 引用的文件名清单（部署脚本读取）
fs.writeFileSync(path.join(BUILD, 'bundle-name.txt'), finalName);

// 5) 回写 index.html 的 script src —— 否则哈希一变，页面仍在引用已被清理的旧文件名，
//    线上直接 404 → 看门狗重试一次后报「资源加载失败」。这一步是打包方案能否落地的关键。
const indexPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const RE_SRC = /(\.\/build\/)soudache\.[^"'\s]+\.js/; // 检测用（不带 g，避免 lastIndex 影响）
if (!RE_SRC.test(html)) {
  console.error('[build] 未在 index.html 中找到 ./build/soudache.<hash>.js 引用，请检查 script 标签');
  process.exitCode = 1;
} else {
  const nextHtml = html.replace(/(\.\/build\/)soudache\.[^"'\s]+\.js/g, `$1${finalName}`);
  if (nextHtml === html) {
    console.log(`[build] index.html 已是最新（${finalName}）`);
  } else {
    fs.writeFileSync(indexPath, nextHtml);
    console.log(`[build] index.html 已指向 ${finalName}`);
  }
}

console.log(`[build] 产物: build/${finalName} (${(code.length / 1024).toFixed(0)} KB)`);
