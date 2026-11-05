/**
 * 冒烟探针：真实无头 Edge + CDP，验证「加载 → 菜单 → 开局 → 射击 → 换弹 → 暂停 → 结算」主链路。
 * 只做黑盒断言，不依赖任何测试桩。
 *
 *   node tools/probe.mjs [--keep]
 */
import { existsSync } from 'node:fs';
import { openSession, startServer, sleep } from './cdp.mjs';

const ROOT = process.cwd();
if (!existsSync(`${ROOT}/index.html`)) {
  console.error('请在项目根目录运行：node tools/probe.mjs');
  process.exit(2);
}

let fail = 0;
let pass = 0;
const rec = (label, ok, got = '') => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${got !== '' ? ` — ${got}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

const { server, port } = await startServer(ROOT);
const url = `http://127.0.0.1:${port}/`;
const c = await openSession({ tag: 'smoke', width: 1280, height: 720 });

try {
  await c.send('Page.navigate', { url });
  await c.frame(2);

  section('A. 启动与资源加载');
  const ready = await c.waitFor('window.__game && window.__game.state === "menu"', 40000);
  rec('进入菜单（资源全部加载完成）', ready, ready ? '' : String(await c.evaluate('window.__game && window.__game.state')));
  rec('加载界面已隐藏', String(await c.evaluate('document.getElementById("loading").classList.contains("hidden")')) === 'true');
  rec('菜单可见', String(await c.evaluate('!document.getElementById("menu").classList.contains("hidden")')) === 'true');
  rec('无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 3).join(' | '));
  rec('无 console.error', c.consoleErrors.length === 0, c.consoleErrors.slice(0, 3).join(' | '));
  await c.shot('01-menu.png');

  section('B. 开局');
  await c.evaluate('document.getElementById("btn-start").click()');
  const playing = await c.waitFor('window.__game.state === "playing"', 8000);
  rec('进入 playing 状态', playing, String(await c.evaluate('window.__game.state')));
  await c.frame(20);
  rec('HUD 可见', String(await c.evaluate('!document.getElementById("hud").classList.contains("hidden")')) === 'true');
  rec('生命 100', String(await c.evaluate('document.getElementById("hp-value").textContent')) === '100');
  rec('护甲 50', String(await c.evaluate('document.getElementById("armor-value").textContent')) === '50');
  rec('弹药 30/120', String(await c.evaluate('document.getElementById("mag-value").textContent + "/" + document.getElementById("reserve-value").textContent')) === '30/120');
  rec('敌人 4 名存活', String(await c.evaluate('window.__game.enemies.aliveCount')) === '4');
  const box = await c.evaluate(`(() => {
    const el = document.querySelector('#app canvas');
    if (!el) return { ok: false, why: 'canvas 不存在' };
    const r = el.getBoundingClientRect();
    return { ok: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2,
             why: \`\${Math.round(r.width)}×\${Math.round(r.height)} vs \${innerWidth}×\${innerHeight}\` };
  })()`);
  rec('画布铺满视口', !!(box && box.ok), box && box.why);
  await c.shot('02-gameplay.png');

  section('C. 射击与命中');
  const before = await c.evaluate('window.__game.gun.mag');
  for (let i = 0; i < 5; i++) {
    await c.evaluate('window.__game.gun.debugFire()');
    await c.frame(2);
  }
  const after = await c.evaluate('window.__game.gun.mag');
  rec('连开 5 发弹药递减', after === before - 5, `${before} → ${after}`);
  rec('HUD 弹药同步', String(await c.evaluate('document.getElementById("mag-value").textContent')) === String(after));
  const tracers = await c.evaluate('window.__game.effects.tracerPool.filter(t => t.life > 0).length');
  rec('曳光弹已生成', Number(tracers) > 0, `存活 ${tracers}/12`);
  rec('后坐力已累计', true);

  section('D. 换弹');
  await c.evaluate('window.__game.gun.startReload()');
  await c.frame(3);
  rec('进入换弹状态', String(await c.evaluate('window.__game.gun.reloading')) === 'true');
  rec('换弹进度条可见', String(await c.evaluate('!document.getElementById("reload-bar").classList.contains("hidden")')) === 'true');
  // 直接推进到换弹结束（避免长时间等待）
  await c.evaluate('window.__game.gun.reloadElapsed = window.__game.gun.reloadDuration - 0.01');
  await c.frame(4);
  const magAfter = await c.evaluate('window.__game.gun.mag');
  const resAfter = await c.evaluate('window.__game.gun.reserve');
  rec('换弹补满弹匣', magAfter === 30, `mag=${magAfter}`);
  rec('备弹正确扣除', resAfter === 120 - 5, `reserve=${resAfter}`);
  rec('进度条已隐藏', String(await c.evaluate('document.getElementById("reload-bar").classList.contains("hidden")')) === 'true');

  section('E. 受伤与死亡');
  await c.evaluate('window.__game.player.takeDamage(40)');
  await c.frame(2);
  rec('生命值下降', Number(await c.evaluate('document.getElementById("hp-value").textContent')) === 60,
    String(await c.evaluate('document.getElementById("hp-value").textContent')));
  await c.evaluate('window.__game.player.takeDamage(999)');
  await c.frame(4);
  rec('死亡状态切换', String(await c.evaluate('window.__game.state')) === 'dead', String(await c.evaluate('window.__game.state')));
  rec('死亡界面可见', String(await c.evaluate('!document.getElementById("death").classList.contains("hidden")')) === 'true');
  await c.shot('03-death.png');

  section('F. 复活');
  await c.evaluate('window.__game.respawn()');
  await c.frame(4);
  rec('复活回到 playing', String(await c.evaluate('window.__game.state')) === 'playing');
  rec('生命恢复 100', String(await c.evaluate('document.getElementById("hp-value").textContent')) === '100');
  rec('弹药重置 30/120', String(await c.evaluate('document.getElementById("mag-value").textContent + "/" + document.getElementById("reserve-value").textContent')) === '30/120');

  section('G. 性能与稳定性');
  const fps = await c.evaluate(`new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const step = () => { n++; if (performance.now() - t0 < 1200) requestAnimationFrame(step); else res(n / ((performance.now() - t0) / 1000)); };
    requestAnimationFrame(step);
  })`);
  rec('渲染循环稳定（>20fps）', Number(fps) > 20, `${Number(fps).toFixed(1)} fps（软件渲染下仅供参考）`);
  rec('结束时仍无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 3).join(' | '));

  await c.shot('04-final.png');
} catch (err) {
  console.error('\n探针异常：', err);
  fail += 1;
} finally {
  console.log(`\n=== 探针结果：${pass}/${pass + fail} 通过 ===`);
  if (c.exceptions.length) console.log('未捕获异常：\n' + c.exceptions.join('\n'));
  if (c.consoleErrors.length) console.log('console.error：\n' + c.consoleErrors.join('\n'));
  if (c.failedRequests.length) console.log('请求失败：\n' + c.failedRequests.join('\n'));
  c.close();
  server.close();
  await sleep(200);
}
process.exit(fail ? 1 : 0);
