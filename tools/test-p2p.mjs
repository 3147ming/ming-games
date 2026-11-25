/* tools/test-p2p.mjs —— 纯 P2P 底座自测（浏览器内跑）
 *
 * 用法：node tools/test-p2p.mjs
 *
 * 覆盖：
 *   1. 连接码编解码往返
 *   2. 压缩 / 不压缩两条路径
 *   3. 损坏的码要给出中文人话提示，不能抛栈
 *   4. 密码派生与证明：同密码同证明、异密码异证明
 *   5. 空密码的特例
 *   6. 真连一次：host 与 guest 在同一个浏览器里建通道并互发消息
 *   7. 房主权威：动作推进 + 状态广播 + 摘要校验
 *
 * 第 6、7 项是真联机：两个页面在同一 Chromium 实例里，用 WebRTC 直连
 * （iceServers 为空，走本机回环 / 主机候选）。跑通即说明底座可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra !== undefined ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};

/* ---------- 起一个只提供 p2p.js 的静态服务 ---------- */
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'net', 'p2p.js'), 'utf8');
const PAGE = `<!doctype html><meta charset="utf-8"><title>p2p test</title>
<script type="module">
import * as P2P from '/src/net/p2p.js';
window.P2P = P2P;
window.__ready = true;
</script>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/src/net/p2p.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(SRC);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });

try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrs = [];
  page.on('pageerror', (e) => pageErrs.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

  console.log('\n=== 1. 环境自检 ===');
  const support = await page.evaluate(() => window.P2P.checkSupport());
  ok('浏览器支持 WebRTC', support.ok === true, support.reason);

  console.log('\n=== 2. 连接码编解码往返 ===');
  const rt = await page.evaluate(async () => {
    const obj = { v: 1, role: 'host', gameId: 'gomoku', roomId: '12345', name: '房主', note: '测试内容 ~!@#$%^&*()' };
    const code = await window.P2P.encodeCode(obj);
    const back = await window.P2P.decodeCode(code);
    return { code, back, len: code.length };
  });
  ok('编码成功且非空', rt.code.length > 0, '长度 ' + rt.len);
  ok('解码后内容一致', JSON.stringify(rt.back) === JSON.stringify({
    v: 1, role: 'host', gameId: 'gomoku', roomId: '12345', name: '房主', note: '测试内容 ~!@#$%^&*()'
  }));
  ok('码以 M 或 P 开头', rt.code[0] === 'M' || rt.code[0] === 'P', '首字符 ' + rt.code[0]);

  console.log('\n=== 3. 压缩效果 ===');
  const comp = await page.evaluate(async () => {
    const big = { v: 1, sdp: 'v=0\r\n'.repeat(200), candidates: [], junk: 'x'.repeat(3000) };
    const code = await window.P2P.encodeCode(big);
    const raw = JSON.stringify(big).length;
    return { codeLen: code.length, rawLen: raw };
  });
  ok('压缩后比原文短', comp.codeLen < comp.rawLen, `${comp.codeLen} < ${comp.rawLen}`);

  console.log('\n=== 4. 坏码要给人话提示 ===');
  const bad = await page.evaluate(async () => {
    const out = {};
    const grab = async (k, t) => { try { await window.P2P.decodeCode(t); out[k] = 'NO_ERROR'; } catch (e) { out[k] = e.message; } };
    await grab('empty', '');
    await grab('garbage', 'X' + 'abc');
    await grab('truncated', (await window.P2P.encodeCode({ v: 1, x: 'y'.repeat(200) })).slice(0, 20));
    await grab('notBase64', 'M@@@@@@@@');
    return out;
  });
  ok('空码有提示', bad.empty !== 'NO_ERROR' && bad.empty.length > 0, bad.empty);
  ok('乱码有提示', bad.garbage !== 'NO_ERROR', bad.garbage);
  ok('截断码有提示', bad.truncated !== 'NO_ERROR', bad.truncated);
  ok('非 base64 有提示', bad.notBase64 !== 'NO_ERROR', bad.notBase64);

  console.log('\n=== 5. 密码派生与证明 ===');
  const pw = await page.evaluate(async () => {
    const salt = 'c2FsdHNhbHRzYWx0c2FsdA';
    const k1 = await window.P2P.deriveKey('secret', salt);
    const k2 = await window.P2P.deriveKey('secret', salt);
    const k3 = await window.P2P.deriveKey('wrong', salt);
    const p1 = await window.P2P.makeProof(k1, '12345');
    const p2 = await window.P2P.makeProof(k2, '12345');
    const p3 = await window.P2P.makeProof(k3, '12345');
    const empty = await window.P2P.deriveKey('', salt);
    return { same: k1 === k2, diff: k1 !== k3, pSame: p1 === p2, pDiff: p1 !== p3, empty, p1 };
  });
  ok('同密码派生同密钥', pw.same);
  ok('异密码派生异密钥', pw.diff);
  ok('同密钥证明一致', pw.pSame);
  ok('异密钥证明不同', pw.pDiff);
  ok('空密码返回空密钥', pw.empty === '');

  console.log('\n=== 6. 真连一次（host ↔ guest） ===');
  const conn = await page.evaluate(async () => {
    const P2P = window.P2P;
    const host = new P2P.P2PSession({ role: 'host', gameId: 'test', name: '房主' });
    const guest = new P2P.P2PSession({ role: 'guest', gameId: 'test', name: '客人' });

    const hostMsgs = [], guestMsgs = [];
    host.on('message', (m) => hostMsgs.push(m));
    guest.on('message', (m) => guestMsgs.push(m));

    const hostCode = await host.createHostCode('');
    const guestCode = await guest.createGuestCode(hostCode, '');
    await host.acceptGuestCode(guestCode);

    const opened = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15000);
      const check = () => {
        if (host.isOpen && guest.isOpen) { clearTimeout(t); resolve(true); }
        else setTimeout(check, 100);
      };
      check();
    });
    if (!opened) return { opened, hostState: host.state, guestState: guest.state };

    /* 通道通了，两边互发一条。 */
    guest.send({ t: 'chat', text: '你好' });
    host.send({ t: 'chat', text: '收到' });
    await new Promise((r) => setTimeout(r, 800));

    return {
      opened: true,
      hostState: host.state,
      guestState: guest.state,
      hostGotChat: hostMsgs.some((m) => m.t === 'chat' && m.text === '你好'),
      guestGotChat: guestMsgs.some((m) => m.t === 'chat' && m.text === '收到'),
      hostPeerName: host.peerName,
      guestPeerName: guest.peerName,
      roomId: host.roomId,
      hostMsgs: hostMsgs.map((m) => m.t),
      guestMsgs: guestMsgs.map((m) => m.t),
    };
  });
  ok('通道建立成功', conn.opened === true, conn.opened ? '' : `host=${conn.hostState} guest=${conn.guestState}`);
  if (conn.opened) {
    ok('guest→host 消息到达', conn.hostGotChat);
    ok('host→guest 消息到达', conn.guestGotChat);
    ok('host 认出了对端名字', conn.hostPeerName === '客人', conn.hostPeerName);
    ok('guest 认出了对端名字', conn.guestPeerName === '房主', conn.guestPeerName);
    ok('房号一致', conn.roomId && conn.roomId.length === 5, conn.roomId);
    ok('hello 握手已发生', conn.hostMsgs.includes('hello') && conn.guestMsgs.includes('hello'));
  }

  console.log('\n=== 7. 密码房间：错误密码要被拒 ===');
  const pwRoom = await page.evaluate(async () => {
    const P2P = window.P2P;
    const host = new P2P.P2PSession({ role: 'host', gameId: 'test', name: '房主' });
    const hostCode = await host.createHostCode('正确密码');
    const guest = new P2P.P2PSession({ role: 'guest', gameId: 'test', name: '客人' });
    const guestCode = await guest.createGuestCode(hostCode, '错误密码');
    try {
      await host.acceptGuestCode(guestCode);
      return { rejected: false, msg: '没有被拒绝' };
    } catch (e) {
      return { rejected: true, msg: e.message };
    }
  });
  ok('错误密码被拒绝', pwRoom.rejected === true, pwRoom.msg);

  console.log('\n=== 8. 房主权威：动作推进 + 状态广播 ===');
  const auth = await page.evaluate(async () => {
    const P2P = window.P2P;
    const host = new P2P.P2PSession({ role: 'host', gameId: 'test', name: '房主' });
    const guest = new P2P.P2PSession({ role: 'guest', gameId: 'test', name: '客人' });
    const hostCode = await host.createHostCode('');
    const guestCode = await guest.createGuestCode(hostCode, '');
    await host.acceptGuestCode(guestCode);
    await new Promise((r) => setTimeout(r, 1200));
    if (!host.isOpen) return { ok: false, reason: '通道未建立' };

    /* 一个极简的棋盘：state = { seed, moves: [] } */
    const replay = (seed, actions) => ({ seed: seed, moves: actions.slice() });
    const reduce = (state, actions) => ({ seed: state.seed, moves: state.moves.concat(actions) });
    const hash = (state) => 'h' + state.moves.length + ':' + state.moves.join(',');

    const ha = new P2P.HostAuthority(host, { reduce, replay, hash });
    const ga = new P2P.HostAuthority(guest, { reduce, replay, hash });
    let guestState = null;
    ga.onState((s) => { guestState = s; });

    ha.init('seed-1');
    await new Promise((r) => setTimeout(r, 300));
    const afterInit = guestState ? guestState.moves.length : -1;

    /* 客人落一手 → 房主权威推进 → 广播 → 客人收到 */
    ga.input({ x: 3, y: 4 });
    await new Promise((r) => setTimeout(r, 600));
    const afterMove = guestState ? guestState.moves.length : -1;

    return {
      ok: true,
      afterInit, afterMove,
      guestMoves: guestState ? guestState.moves : null,
      hostMoves: ha.state.moves,
    };
  });
  ok('房主权威通道建立', auth.ok === true, auth.reason || '');
  if (auth.ok) {
    ok('初始化状态已同步给客人', auth.afterInit === 0, 'moves=' + auth.afterInit);
    ok('客人动作经房主推进后广播', auth.afterMove === 1, 'moves=' + auth.afterMove);
    ok('双方状态一致', JSON.stringify(auth.guestMoves) === JSON.stringify(auth.hostMoves),
      JSON.stringify(auth.guestMoves) + ' vs ' + JSON.stringify(auth.hostMoves));
  }

  console.log('\n=== 9. 页面零报错 ===');
  ok('无未捕获错误', pageErrs.length === 0, pageErrs.slice(0, 2).join(' | '));

  await ctx.close();
} catch (e) {
  console.error('测试执行异常：', e);
  fail++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
