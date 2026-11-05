import { openSession, startServer, sleep } from './cdp.mjs';
const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'frame', width: 1024, height: 576 });
const variants = [
  { n: 'A', view: { scale: 0.62, position: { x: 0.18, y: -0.13, z: -0.48 }, rotation: { x: 0.0, y: 0.05, z: 0.015 }, offset: { x: 0, y: 0, z: 0.12 } } },
  { n: 'B', view: { scale: 0.58, position: { x: 0.20, y: -0.12, z: -0.52 }, rotation: { x: -0.02, y: 0.06, z: 0.02 }, offset: { x: 0, y: 0, z: 0.18 } } },
  { n: 'C', view: { scale: 0.54, position: { x: 0.22, y: -0.10, z: -0.55 }, rotation: { x: -0.03, y: 0.07, z: 0.03 }, offset: { x: 0, y: 0, z: 0.24 } } },
  { n: 'D', view: { scale: 0.66, position: { x: 0.16, y: -0.14, z: -0.44 }, rotation: { x: 0.0, y: 0.04, z: 0.01 }, offset: { x: 0, y: 0, z: 0.08 } } },
];
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
    document.getElementById('wave-banner').classList.remove('show');
  })()`);
  await c.frame(4);
  for (const v of variants) {
    await c.evaluate(`window.__game.weaponView.setViewConfig(${JSON.stringify(v.view)})`);
    await c.frame(4);
    const info = await c.evaluate(`({
      size: (() => { const s = window.__game.weaponView.modelSize; return [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)]; })(),
      muzzle: (() => { const m = window.__game.weaponView.muzzleLocal; return [+m.x.toFixed(2), +m.y.toFixed(2), +m.z.toFixed(2)]; })(),
    })`);
    await c.evaluate(`(() => { const g = window.__game; g.gun.cooldown = 0; g.gun.mag = 30; g.gun.debugFire(); })()`);
    await c.frame(1);
    await c.shot(`frame-${v.n}.png`);
    console.log(v.n, JSON.stringify(info));
  }
} finally { c.close(); server.close(); await sleep(120); }
