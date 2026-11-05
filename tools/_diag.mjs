import { openSession, startServer, sleep } from './cdp.mjs';
const { server, port } = await startServer(process.cwd());
const c = await openSession({ tag: 'diag', width: 1280, height: 720 });
try {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await c.waitFor('window.__game && window.__game.state === "menu"', 40000);
  const info = await c.evaluate(`(() => {
    const v = window.__game.weaponView;
    const meshes = [];
    v.model.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      meshes.push({ name: o.name, min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z], visible: o.visible });
    });
    return {
      meshes,
      rootRot: [v.model.rotation.x, v.model.rotation.y, v.model.rotation.z],
      pivotRot: [v.pivot.rotation.x, v.pivot.rotation.y, v.pivot.rotation.z],
      tex: Object.fromEntries(Object.entries(window.__game.assets.textures).map(([k,x])=>[k, x ? [x.image.width, x.image.height] : null])),
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
} finally { c.close(); server.close(); await sleep(100); }
