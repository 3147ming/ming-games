import { openSession, startServer, sleep } from './cdp.mjs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'zoom', width: 1024, height: 576 });
try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await c.waitFor('window.__game && window.__game.state === "menu"', 60000);
  await c.evaluate('document.getElementById("btn-start").click()');
  await c.waitFor('window.__game.state === "playing"', 10000);
  await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(0, 0, 8);
    g.enemies.enemies.forEach(e => { e.dead = true; e.root.visible = false; });
    g.enemies.waveState = 'done';
    g.audio.enabled = false;
    document.getElementById('tips').classList.add('hide');
    document.getElementById('hud').classList.add('hidden');
  })()`);
  await c.frame(4);
  // 开火并在同一帧内截图：把 flashTime 拉长，方便观察枪口位置
  await c.evaluate(`(() => {
    const g = window.__game;
    g.gun.cooldown = 0; g.gun.mag = 30; g.gun.debugFire();
    g.weaponView.flashTime = 3; g.weaponView.flash.visible = true;
    g.weaponView.flashLight.intensity = 2;
  })()`);
  await c.frame(2);
  const r = await c.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 420, y: 300, width: 604, height: 276, scale: 1.6 },
  });
  const f = resolve('.workbuddy/shots/zoom-weapon.png');
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(f);
} finally { c.close(); server.close(); await sleep(120); }
