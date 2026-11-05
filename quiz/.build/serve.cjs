// 极简静态服务（仅测试用）：node serve.cjs [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/Projects/_github_pages/ming-games';
const PORT = parseInt(process.argv[2] || '8848', 10);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(path.resolve(ROOT))) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 ' + p); return; }
    /* 必须显式给 Content-Length：不写就跑 chunked，本机的抓包代理会把大 HTML 截断
       （同一 URL 连拉会拿到 147136 / 179904 / 453637 三种长度，前缀完全一致），
       截断的文档里 QA_TYPES/addWeak 是 undefined，整串断言连锁假失败。 */
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT + '/'));
