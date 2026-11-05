import { openSession, startServer, sleep } from './cdp.mjs';
const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'diag', width: 1280, height: 720 });
try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await c.waitFor('window.__game && window.__game.state === "menu"', 40000);
  await c.evaluate('document.getElementById("btn-start").click()');
  await c.waitFor('window.__game.state === "playing"', 8000);
  await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(0, 0, 8);
    g.enemies.enemies.forEach(e => { e.root.visible = false; e.dead = true; e.deadTimer = 999; });
    g.audio.enabled = false;
    document.getElementById('tips').classList.add('hide');
    g.hud.setVisible(false);
    // 隔离武器：只保留枪模
    g.map.group.visible = false;
    g.scene.background = new (g.scene.background.constructor)(0x2a2f36);
    g.scene.fog = null;
  })()`);
  await c.frame(6);
  for (const [name, yaw] of [['0', 0], ['90', Math.PI/2], ['180', Math.PI], ['270', -Math.PI/2]]) {
    await c.evaluate(`(() => {
      const v = window.__game.weaponView;
      v.baseRot.set(0, ${yaw}, 0);
      v.pivot.rotation.set(0, ${yaw}, 0);
      v.basePos.set(0, 0, -1.2);
      v.pivot.position.set(0, 0, -1.2);
      v.flash.visible = true;
      v.flash.scale.setScalar(0.12);
    })()`);
    await c.frame(4);
    await c.shot(`axis-${name}.png`);
  }
  console.log('done');
} finally { c.close(); server.close(); await sleep(100); }
