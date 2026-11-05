import { openSession, startServer, sleep } from './cdp.mjs';
const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'axes', width: 1024, height: 576 });
try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await c.waitFor('window.__game && window.__game.state === "menu"', 60000);
  await c.evaluate('document.getElementById("btn-start").click()');
  await c.waitFor('window.__game.state === "playing"', 10000);
  await c.frame(3);
  const r = await c.evaluate(`(() => {
    const g = window.__game, w = g.weaponView;
    w.model.updateMatrixWorld(true);
    const out = [];
    w.model.traverse(o => {
      if (!o.isMesh) return;
      const p = o.getWorldPosition(new (o.position.constructor)());
      const cp = p.clone().applyMatrix4(g.camera.matrixWorldInverse);
      out.push({ name: o.name, vis: o.visible, world: p.toArray().map(v=>+v.toFixed(2)), camZ: +cp.z.toFixed(2),
                 scaleWorld: o.getWorldScale(new (o.position.constructor)()).toArray().map(v=>+v.toFixed(3)),
                 matOp: o.material && o.material.opacity, frustum: o.frustumCulled });
    });
    return {
      pivotVisible: w.pivot.visible,
      pivotParent: w.pivot.parent && w.pivot.parent.type,
      cameraInScene: !!g.camera.parent,
      camChildren: g.camera.children.length,
      modelVisible: w.model.visible,
      modelLayers: w.model.layers.mask,
      camLayers: g.camera.layers.mask,
      camPos: g.camera.position.toArray().map(v=>+v.toFixed(2)),
      pivotPos: w.pivot.position.toArray().map(v=>+v.toFixed(2)),
      pivotScale: w.pivot.scale.toArray(),
      modelScale: w.model.scale.x,
      near: g.camera.near,
      meshes: out,
    };
  })()`);
  console.log(JSON.stringify(r, null, 1));
} finally { c.close(); server.close(); await sleep(120); }
