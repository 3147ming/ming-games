/* server.mjs — 零依赖本地静态服务（serve.bat 调用）
 *   node server.mjs --root=dist --port=5390
 *   node server.mjs --root=offline --port=5391
 * 只服务产物目录，不解析 hash 路由（客户端 hash 路由不需要服务端 fallback）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const rootDir = path.resolve(ROOT, arg('root', 'dist'));
const port = Number(arg('port', '5390'));
if (!fs.existsSync(rootDir)) {
  console.error(`[server] 产物目录不存在: ${rootDir}\n请先运行: node tools/build.mjs --target=all`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Bad Request'); return; }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  let abs = path.resolve(rootDir, '.' + pathname);
  if (!abs.startsWith(rootDir + path.sep) && abs !== rootDir) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    // 先判存在再 stat：否则缺文件会被 statSync 抛异常误报成 500
    if (!fs.existsSync(abs)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found: ' + pathname); return; }
    if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
    if (!fs.existsSync(abs)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found: ' + pathname); return; }
    const body = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + e.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('=== ming-games 本地服务已启动 ===');
  console.log(`产物目录: ${rootDir}`);
  console.log(`大厅入口: http://127.0.0.1:${port}/`);
  console.log(`离线产物也可用 http 验证: node server.mjs --root=offline --port=${port + 1}`);
  console.log('按 Ctrl+C 停止');
});
