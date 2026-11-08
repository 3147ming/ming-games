/* tools/build-assets.test.mjs
 *
 * build-assets.mjs 自测。只新建本文件；不修改仓库其它文件。
 * 临时产物一律写系统 temp 目录（os.tmpdir()），不写 ROOT。
 *
 * 覆盖：
 *   1) 两个项目各跑一次 CLI --check，报告资源数 / 总字节 / warnings。
 *   2) 两个项目各真实生成到 temp，检查：
 *      - 生成文件数；每个 JS 文件 node --check（全量，含最大那个）；
 *      - __mg_asset_map.js / __mg_assets_sync.js 能被 vm 正常执行（globalThis stub）；
 *      - inlineShim 能被 new vm.Script() 编译通过；
 *      - LF 校验（无 CR）。
 *   3) fetch shim vm 拦截测试：
 *      a) 合成已知 key + base64，断言 Response 字节与 content-type；
 *      b) 用真实生成的 wrapper 文件 + 真实资源字节做端到端往返（含 Request 对象 / 绝对 file:// URL）；
 *      c) data:/blob:/http(s)/POST/未命中 均回退原生（不拦截）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildAssetLayer } from './build-assets.mjs';

const ROOT = 'D:/Projects/_github_pages/ming-games';
const TOOLS = path.join(ROOT, 'tools');
const GAMES = [
  { id: 'night-shift', src: path.join(ROOT, 'night-shift') },
  { id: 'warehouse-strike', src: path.join(ROOT, 'warehouse-strike') },
];

const silentConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {}, dir() {} };
const atobFn = globalThis.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));
const btoaFn = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
const ResponseCtor = globalThis.Response;

let PASS = 0, FAIL = 0;
const failLines = [];
function ok(label) { PASS++; console.log('    PASS  ' + label); }
function bad(label, e) { FAIL++; const m = (e && e.message) || String(e); failLines.push(label + ' -> ' + m); console.log('    FAIL  ' + label + ' -> ' + m); }
function run(label, fn) { try { fn(); ok(label); } catch (e) { bad(label, e); } }
async function runAsync(label, fn) { try { await fn(); ok(label); } catch (e) { bad(label, e); } }

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else out.push({ rel: r, abs, size: fs.statSync(abs).size });
    }
  })(dir, '');
  return out;
}

/* 构造一个最小 vm 沙箱：window===globalThis 风格，注入浏览器全局 */
function makeSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;                 // 浏览器里 window === globalThis
  sandbox.console = silentConsole;
  sandbox.Response = ResponseCtor;
  sandbox.atob = atobFn;
  sandbox.btoa = btoaFn;
  sandbox.queueMicrotask = queueMicrotask;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.fetch = (input, init) => Promise.resolve(new ResponseCtor('NATIVE_SENTINEL', { status: 599 }));
  return sandbox;
}

/* 让 document.createElement 返回的假 script 在设置 src 时立刻触发 onload；
 * loadWrapper(v) 用来模拟「包装脚本执行」把数据写入 __MG_ASSETS。 */
function attachFakeDocument(sandbox, loadWrapper) {
  let ctxRef = null;
  sandbox.document = {
    head: { appendChild() {} },
    createElement(tag) {
      const el = { onload: null, onerror: null, _src: '' };
      Object.defineProperty(el, 'src', {
        get() { return el._src; },
        set(v) {
          el._src = v;
          try { if (loadWrapper) loadWrapper(v, ctxRef); } catch (e) { /* 让 onerror 处理 */ }
          if (typeof el.onload === 'function') el.onload();
        },
      });
      return el;
    },
  };
  return (ctx) => { ctxRef = ctx; };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-assets-test-'));
  console.log('=== build-assets 自测 ===');
  console.log('系统临时目录: ' + tmp);
  console.log('Node: ' + process.version + '\n');

  /* ---------- 1) 各跑一次 CLI --check ---------- */
  console.log('[1] CLI --check（只统计不写文件）');
  for (const g of GAMES) {
    const r = spawnSync(process.execPath,
      [path.join(TOOLS, 'build-assets.mjs'), '--src=' + g.src, '--game=' + g.id, '--check'],
      { encoding: 'utf8' });
    run(g.id + ': --check 退出码 0', () => {
      assert.equal(r.status, 0, 'stderr=' + r.stderr);
      assert.match(r.stdout, /fileCount\s*:\s*\d+/);
      assert.match(r.stdout, /totalBytes\s*:\s*\d+/);
    });
    console.log('    ---- ' + g.id + ' --check 输出 ----');
    for (const line of r.stdout.trimEnd().split('\n')) console.log('    ' + line);
    if (r.stderr && r.stderr.trim()) console.log('    STDERR ' + r.stderr.trim());
  }

  /* ---------- 2) 真实生成 + 产物校验 ---------- */
  console.log('\n[2] 真实生成到系统 temp + 产物逐项校验');
  const built = {};
  for (const g of GAMES) {
    const out = path.join(tmp, g.id);
    console.log('  ---- ' + g.id + ' ----');
    console.log('    out: ' + out);
    const r = buildAssetLayer({ srcDir: g.src, dstDir: out, gameId: g.id });
    built[g.id] = { out, r };
    console.log('    fileCount=' + r.fileCount + ' asyncCount=' + r.asyncCount +
      ' syncBytes=' + r.syncBytes + ' totalBytes=' + r.totalBytes);
    console.log('    scripts=' + JSON.stringify(r.scripts));
    console.log('    warnings=' + (r.warnings.length ? JSON.stringify(r.warnings) : '(none)'));

    run(g.id + ': fileCount > 0 且 scripts=[sync,map]', () => {
      assert.ok(r.fileCount > 0);
      assert.equal(r.scripts.length, 2);
      assert.equal(r.scripts[0], 'vendor/__mg_assets_sync.js');
      assert.equal(r.scripts[1], 'vendor/__mg_asset_map.js');
      assert.ok(r.inlineShim.length > 0);
    });

    const files = listFiles(out);
    const jsFiles = files.filter((f) => f.rel.endsWith('.js'));
    const largest = jsFiles.slice().sort((a, b) => b.size - a.size)[0];
    console.log('    生成文件数=' + files.length + '（其中 .js ' + jsFiles.length + ' 个）；最大文件=' + largest.rel + ' ' + largest.size + ' B');
    run(g.id + ': 生成文件数 == 包装数 + 2', () => {
      assert.equal(files.length, r.fileCount + 2);
    });

    /* 2a) node --check 全量（>=5，含最大那个） */
    let checked = 0, checkedLargest = false;
    for (const f of jsFiles) {
      try {
        execFileSync(process.execPath, ['--check', f.abs], { stdio: 'pipe' });
        checked++;
        if (f.abs === largest.abs) checkedLargest = true;
      } catch (e) {
        bad(g.id + ': node --check ' + f.rel, new Error(String(e.stderr || e.message).split('\n')[0]));
      }
    }
    run(g.id + ': node --check 全部 .js 通过（含最大文件）', () => {
      assert.ok(checked >= 5, '抽查数量不足: ' + checked);
      assert.equal(checked, jsFiles.length, '有 .js 未通过');
      assert.ok(checkedLargest, '最大文件未通过或被漏掉');
    });
    console.log('    node --check: ' + checked + '/' + jsFiles.length + ' 通过（含最大文件 ' + largest.rel + '）');

    /* 2b) LF 校验 */
    run(g.id + ': 所有生成文件为 LF（无 CR）', () => {
      for (const f of files) {
        const buf = fs.readFileSync(f.abs);
        assert.ok(!buf.includes(0x0d), '文件含 CR: ' + f.rel);
      }
    });

    /* 2c) map / sync vm 执行 */
    const mapCtx = vm.createContext({ console: silentConsole });
    const syncCtx = vm.createContext({ console: silentConsole });
    run(g.id + ': __mg_asset_map.js 在 vm 中执行成功且表非空', () => {
      vm.runInContext(fs.readFileSync(path.join(out, 'vendor/__mg_asset_map.js'), 'utf8'), mapCtx, { filename: '__mg_asset_map.js' });
      const m = vm.runInContext('globalThis.__MG_ASSET_MAP', mapCtx);
      const mime = vm.runInContext('globalThis.__MG_ASSET_MIME', mapCtx);
      assert.ok(m && typeof m === 'object' && Object.keys(m).length > 0);
      assert.ok(mime && typeof mime === 'object' && Object.keys(mime).length > 0);
    });
    run(g.id + ': __mg_assets_sync.js 在 vm 中执行成功且表为对象', () => {
      vm.runInContext(fs.readFileSync(path.join(out, 'vendor/__mg_assets_sync.js'), 'utf8'), syncCtx, { filename: '__mg_assets_sync.js' });
      const d = vm.runInContext('globalThis.__MG_ASSET_DATA', syncCtx);
      assert.ok(d && typeof d === 'object');
    });

    /* 2d) inlineShim 编译 */
    run(g.id + ': new vm.Script(inlineShim) 编译通过', () => {
      const s = new vm.Script(r.inlineShim, { filename: 'inlineShim.js' });
      assert.ok(s);
    });
  }

  /* ---------- 3) fetch shim vm 拦截测试 ---------- */
  console.log('\n[3] fetch shim vm 拦截测试');

  /* 3a) 合成 key：显式字节 + content-type */
  await runAsync('[3a] 合成 key：fetch 返回正确字节 / content-type / status', async () => {
    const canonical = 'public/assets/audio/tone.mp3';
    const wrapper = 'vendor/__mg_assets/tone.js';
    const bytes = Uint8Array.from([0, 1, 2, 3, 72, 101, 108, 108, 111, 255, 254, 253]);
    const b64 = Buffer.from(bytes).toString('base64');
    const sandbox = makeSandbox();
    sandbox.__MG_ASSETS = {};
    sandbox.__MG_ASSET_MAP = {
      [canonical]: wrapper,
      'assets/audio/tone.mp3': wrapper,
      './public/assets/audio/tone.mp3': wrapper,
      'tone.mp3': wrapper,
    };
    sandbox.__MG_ASSET_MIME = {
      [canonical]: 'audio/mpeg',
      'assets/audio/tone.mp3': 'audio/mpeg',
      './public/assets/audio/tone.mp3': 'audio/mpeg',
      'tone.mp3': 'audio/mpeg',
    };
    const setCtx = attachFakeDocument(sandbox, (v, ctx) => {
      // 模拟包装脚本执行：把已知 base64 写到规范 key
      vm.runInContext('globalThis.__MG_ASSETS[' + JSON.stringify(canonical) + '] = ' + JSON.stringify(b64) + ';', ctx);
    });
    const ctx = vm.createContext(sandbox);
    setCtx(ctx);
    const shim = buildAssetLayer({ srcDir: GAMES[1].src, dstDir: path.join(tmp, '_shim_only'), gameId: '_shim', write: false }).inlineShim;
    vm.runInContext(shim, ctx, { filename: 'inlineShim.js' });

    const res = await sandbox.window.fetch('./public/assets/audio/tone.mp3');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    const got = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(Array.from(got), Array.from(bytes));
    console.log('    -> 字节=' + JSON.stringify(Array.from(got)) + ' content-type=' + res.headers.get('content-type') + ' status=' + res.status);
  });

  /* 3a2) 不应拦截的请求一律回退原生（status 599 哨兵） */
  await runAsync('[3a2] data:/blob:/http(s)/POST/未命中 回退原生（不拦截）', async () => {
    const sandbox = makeSandbox();
    sandbox.__MG_ASSETS = {};
    sandbox.__MG_ASSET_MAP = {};
    sandbox.__MG_ASSET_MIME = {};
    const setCtx = attachFakeDocument(sandbox, null);
    const ctx = vm.createContext(sandbox);
    setCtx(ctx);
    const shim = buildAssetLayer({ srcDir: GAMES[1].src, dstDir: path.join(tmp, '_shim_only2'), gameId: '_shim', write: false }).inlineShim;
    vm.runInContext(shim, ctx, { filename: 'inlineShim.js' });
    const calls = [
      ['data:', 'data:image/png;base64,AAAA'],
      ['blob:', 'blob:file:///abc'],
      ['http(s)', 'https://cdn.example.com/a.png'],
      ['POST', { url: 'file:///x/public/assets/a.mp3', method: 'POST' }],
      ['未命中', 'file:///x/public/assets/missing.mp3'],
    ];
    for (const [name, input] of calls) {
      const init = name === 'POST' ? { method: 'POST' } : undefined;
      const res = await sandbox.window.fetch(input, init);
      assert.equal(res.status, 599, name + ' 未回退原生');
    }
    console.log('    -> 5 类请求均回退原生（status 599 哨兵）');
  });

  /* 3b) 真实文件端到端：warehouse-strike 的 weapon_arms.fbx（最大文件）走 fetch shim */
  await runAsync('[3b] 真实 wrapper + 真实资源字节：fetch(Request/绝对 file://) 往返一致', async () => {
    const { out } = built['warehouse-strike'];
    const canonical = 'public/assets/models/weapon_arms.fbx';
    const origAbs = path.join(GAMES[1].src, 'public/assets/models/weapon_arms.fbx');
    const orig = fs.readFileSync(origAbs);

    const sandbox = makeSandbox();
    sandbox.__MG_ASSETS = {};
    const setCtx = attachFakeDocument(sandbox, (v, ctx) => {
      // 真实懒加载：执行磁盘上对应的 JS 包装文件
      const wrapperAbs = path.join(out, v);
      const code = fs.readFileSync(wrapperAbs, 'utf8');
      vm.runInContext(code, ctx, { filename: v });
    });
    const ctx = vm.createContext(sandbox);
    setCtx(ctx);
    // 真实 map 脚本定义 __MG_ASSET_MAP / __MG_ASSET_MIME
    vm.runInContext(fs.readFileSync(path.join(out, 'vendor/__mg_asset_map.js'), 'utf8'), ctx, { filename: '__mg_asset_map.js' });
    // inlineShim 最后安装 fetch 包装
    const shim = built['warehouse-strike'].r.inlineShim;
    vm.runInContext(shim, ctx, { filename: 'inlineShim.js' });

    // 命中项必须存在
    const hit = vm.runInContext('globalThis.__MG_ASSET_MAP[' + JSON.stringify(canonical) + ']', ctx);
    assert.ok(hit, 'map 未包含规范 key ' + canonical);

    // 用 Request 风格对象 + 绝对 file:// URL（还原 FileLoader 的真实入参）
    const fakeRequest = {
      url: 'file:///D:/Projects/_github_pages/ming-games/warehouse-strike/public/assets/models/weapon_arms.fbx',
      method: 'GET',
    };
    const res = await sandbox.window.fetch(fakeRequest);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    const got = Buffer.from(await res.arrayBuffer());
    assert.equal(got.length, orig.length, '字节长度不一致');
    assert.ok(got.equals(orig), '字节内容不一致');
    console.log('    -> 往返 ' + got.length + ' B 与源文件逐字节一致；content-type=' + res.headers.get('content-type'));
  });

  /* ---------- 3c) URLModifier（图片 -> data URI）---------- */
  console.log('\n[3c] THREE.DefaultLoadingManager.setURLModifier 注册与命中');

  function makeMgrSandbox() {
    const sandbox = makeSandbox();
    let captured = null;
    sandbox.__mgCaptured = () => captured;
    sandbox.THREE = {
      DefaultLoadingManager: {
        urlModifier: undefined,
        setURLModifier(fn) { captured = fn; sandbox.__capturedFn = fn; },
      },
    };
    sandbox.__MG_ASSET_DATA = {
      'assets/art/items/drink.png': 'data:image/png;base64,iVBORw0KGgo=',
      'public/assets/textures/ak74_color.webp': 'data:image/webp;base64,UklGRg==',
    };
    sandbox.__MG_ASSETS = {};
    sandbox.__MG_ASSET_MAP = {};
    sandbox.__MG_ASSET_MIME = {};
    return sandbox;
  }
  const shimForModifier = built['night-shift'].r.inlineShim;

  await runAsync('[3c1] THREE 已存在：注册 modifier，图片 URL 返回 data URI、非图片原样返回', async () => {
    const sandbox = makeMgrSandbox();
    const setCtx = attachFakeDocument(sandbox, null);
    const ctx = vm.createContext(sandbox);
    setCtx(ctx);
    vm.runInContext(shimForModifier, ctx, { filename: 'inlineShim.js' });
    assert.equal(typeof sandbox.__capturedFn, 'function', '未调用 setURLModifier');
    const mod = sandbox.__capturedFn;
    assert.equal(mod('assets/art/items/drink.png'), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(mod('./public/assets/textures/ak74_color.webp'), 'data:image/webp;base64,UklGRg==');
    assert.equal(mod('./public/assets/models/weapon_arms.fbx'), './public/assets/models/weapon_arms.fbx');
    assert.equal(mod('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    console.log('    -> 2 个图片 URL 命中 data URI；fbx / data: 原样返回');
  });

  await runAsync('[3c2] THREE 在 shim 之后才定义：延迟钩子仍能注册 modifier', async () => {
    const sandbox = makeSandbox();
    delete sandbox.THREE;
    sandbox.__MG_ASSET_DATA = {
      'assets/art/items/drink.png': 'data:image/png;base64,iVBORw0KGgo=',
    };
    sandbox.__MG_ASSETS = {};
    sandbox.__MG_ASSET_MAP = {};
    sandbox.__MG_ASSET_MIME = {};
    const setCtx = attachFakeDocument(sandbox, null);
    const ctx = vm.createContext(sandbox);
    setCtx(ctx);
    vm.runInContext(shimForModifier, ctx, { filename: 'inlineShim.js' });
    // 模拟 three.classic.js 之后才挂上 globalThis.THREE
    vm.runInContext('globalThis.THREE = { DefaultLoadingManager: { urlModifier: undefined, setURLModifier: function (fn) { globalThis.__capturedFn = fn; } } };', ctx);
    await new Promise((r) => setImmediate(r)); // 让 defer 微任务跑完
    assert.equal(typeof sandbox.__capturedFn, 'function', '延迟钩子未注册 modifier');
    assert.equal(sandbox.__capturedFn('assets/art/items/drink.png'), 'data:image/png;base64,iVBORw0KGgo=');
    console.log('    -> 延迟赋值 THREE 后 modifier 生效，图片 URL 命中 data URI');
  });

  /* ---------- 3d) 统计口径核对 ---------- */
  console.log('\n[3d] 统计口径核对');
  const ns = built['night-shift'].r, ws = built['warehouse-strike'].r;
  console.log('    night-shift      : syncBytes=' + ns.syncBytes + ' totalBytes=' + ns.totalBytes + ' warnings=' + ns.warnings.length);
  console.log('    warehouse-strike : syncBytes=' + ws.syncBytes + ' totalBytes=' + ws.totalBytes + ' warnings=' + ws.warnings.length);
  run('warehouse totalBytes 在 12MB 量级', () => {
    assert.ok(ws.totalBytes >= 11 * 1024 * 1024 && ws.totalBytes <= 15 * 1024 * 1024,
      'totalBytes=' + ws.totalBytes);
  });
  run('warehouse 同步脚本远小于 9.44MB（未把资源全塞进首屏）', () => {
    assert.ok(ws.syncBytes < 1024 * 1024, 'syncBytes=' + ws.syncBytes);
  });
  run('night-shift syncBytes == 图片数据总量（base64 只写一次，无膨胀）', () => {
    // 19 张 png 原始 ~2.96MB，base64 后同步脚本应在 3.5~4.5MB 之间（含 data URI 前缀与 JSON 开销），
    // 不能是别名重复膨胀后的 ~11MB。
    assert.ok(ns.syncBytes > 3.5 * 1024 * 1024 && ns.syncBytes < 4.5 * 1024 * 1024,
      'syncBytes=' + ns.syncBytes);
  });

  /* ---------- 汇总 ---------- */
  console.log('\n=== 汇总: PASS ' + PASS + ' / FAIL ' + FAIL + ' ===');
  if (failLines.length) {
    console.log('失败明细:');
    for (const l of failLines) console.log('  - ' + l);
  }
  console.log('临时产物保留（系统 temp）: ' + tmp);
  if (FAIL) process.exitCode = 1;
}

main().catch((e) => {
  console.error('自测主流程异常: ' + (e && e.stack || e));
  process.exitCode = 1;
});
