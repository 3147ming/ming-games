/**
 * 第一人称视图 / 敌人外观 视觉探针：把枪模与僵尸摆到镜头前逐项截图，供人工比对。
 *   node tools/probe-viewmodel.mjs
 */
import { openSession, startServer, sleep } from './cdp.mjs';

const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'viewmodel', width: 1280, height: 720 });
const shots = [];
try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await c.waitFor('window.__game && window.__game.state === "menu"', 40000);
  await c.evaluate('document.getElementById("btn-start").click()');
  await c.waitFor('window.__game.state === "playing"', 8000);

  // 站到空旷处、面向北墙，排除掩体干扰
  await c.evaluate(`(() => {
    const g = window.__game;
    g.player.position.set(0, 0, 8);
    g.mouseLook.yaw = 0; g.mouseLook.pitch = 0;
    g.input.yaw = 0;
    g.enemies.enemies.forEach(e => { e.root.visible = false; });
    document.getElementById('tips').classList.add('hide');
  })()`);
  await c.frame(6);

  // 1) 枪模：三种 Y 朝向下各截一张，判断哪一侧才是枪口前方
  for (const [name, yaw] of [['pi', Math.PI], ['half', Math.PI / 2], ['zero', 0]]) {
    await c.evaluate(`window.__game.weaponView.baseRot.set(${-0.18}, ${yaw}, 0.06)`);
    await c.frame(4);
    shots.push(await c.shot(`vm-yaw-${name}.png`));
  }

  // 2) 手臂显示出来看看姿势
  await c.evaluate(`(() => {
    const v = window.__game.weaponView;
    v.baseRot.set(-0.18, Math.PI, 0.06);
    v.model.traverse(o => { if (o.isMesh) o.visible = true; });
  })()`);
  await c.frame(6);
  shots.push(await c.shot('vm-arms-visible.png'));

  // 3) 敌人特写
  await c.evaluate(`(() => {
    const g = window.__game;
    const e = g.enemies.enemies[0];
    e.position.set(0, 0, 2.2);
    e.root.position.copy(e.position);
    e.root.visible = true;
    e.dead = false; e.deadTimer = 0; e.health = 100;
    e.state = 'idle';
    e.root.rotation.y = Math.PI;           // 面向玩家
    e.bar.visible = false;
    g.weaponView.model.visible = false;    // 挡视野，先藏枪
  })()`);
  await c.frame(8);
  shots.push(await c.shot('enemy-closeup.png'));

  console.log(shots.join('\n'));
  console.log('exceptions:', c.exceptions, c.consoleErrors);
} finally { c.close(); server.close(); await sleep(150); }
