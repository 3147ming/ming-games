/**
 * 主探针：真实无头 Edge + CDP，黑盒验证「加载 → 开局 → 射击命中 → 换弹 → 三波推进 → 胜利/失败结算 → 再来一局」。
 * 不依赖任何测试桩，断言全部落在真实 DOM 与真实游戏对象上。
 *
 *   node tools/probe.mjs
 */
import { existsSync } from 'node:fs';
import { openSession, startServer, sleep } from './cdp.mjs';

const ROOT = process.cwd();
if (!existsSync(`${ROOT}/index.html`)) {
  console.error('请在项目根目录运行：node tools/probe.mjs');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const rec = (label, ok, got = '') => {
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${got !== '' ? ` — ${got}` : ''}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);
const txt = (c, expr) => c.evaluate(expr);

const { server, port } = await startServer(ROOT);
const url = `http://127.0.0.1:${port}/`;
const c = await openSession({ tag: 'probe', width: 1024, height: 576 });

/** 清空当前波：刷一个杀一个，直到本波总人数打完 */
const clearWave = async () => {
  const n = await c.evaluate(`(() => {
    const em = window.__game.enemies;
    let guard = 0;
    while (em.waveKilled < em.waveTotal && guard++ < 80) {
      em._spawnOne();
      em.enemies.filter((e) => !e.dead).forEach((e) => e.takeDamage(999999));
    }
    return { spawned: em.waveSpawned, killed: em.waveKilled, total: em.waveTotal };
  })()`);
  return n;
};

try {
  await c.send('Page.navigate', { url });
  await c.frame(2);

  section('A. 启动与资源加载');
  const ready = await c.waitFor('window.__game && window.__game.state === "menu"', 60000);
  rec('进入菜单（资源全部加载完成）', ready, ready ? '' : String(await txt(c, 'window.__game && window.__game.state')));
  rec('加载界面已隐藏', String(await txt(c, 'document.getElementById("loading").classList.contains("hidden")')) === 'true');
  rec('菜单可见', String(await txt(c, '!document.getElementById("menu").classList.contains("hidden")')) === 'true');
  const texOk = await c.evaluate(`(() => {
    const t = window.__game.assets.textures;
    return Object.entries(t).map(([k, v]) => [k, v && v.image ? v.image.width : 0]);
  })()`);
  rec('三张贴图都真正解码（>64px）', Array.isArray(texOk) && texOk.every(([, w]) => w >= 64), JSON.stringify(texOk));
  rec('无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 2).join(' | '));
  rec('无 console.error', c.consoleErrors.length === 0, c.consoleErrors.slice(0, 2).join(' | '));
  await c.shot('01-menu.png');

  section('B. 开局与波次初始化');
  await c.evaluate('document.getElementById("btn-start").click()');
  const playing = await c.waitFor('window.__game.state === "playing"', 10000);
  rec('进入 playing', playing, String(await txt(c, 'window.__game.state')));
  await c.frame(6);
  rec('HUD 可见', String(await txt(c, '!document.getElementById("hud").classList.contains("hidden")')) === 'true');
  rec('生命 100 / 护甲 50',
    String(await txt(c, 'document.getElementById("hp-value").textContent + "/" + document.getElementById("armor-value").textContent')) === '100/50');
  rec('弹药 30/120',
    String(await txt(c, 'document.getElementById("mag-value").textContent + "/" + document.getElementById("reserve-value").textContent')) === '30/120');
  rec('波次指示 1/3', String(await txt(c, 'document.getElementById("wave-now").textContent + "/" + document.getElementById("wave-total").textContent')) === '1/3');
  await c.waitFor('window.__game.enemies.waveSpawned > 0', 8000);
  const w0 = await c.evaluate('({ total: window.__game.enemies.waveTotal, alive: window.__game.enemies.aliveCount, spawned: window.__game.enemies.waveSpawned })');
  rec('第 1 波共 6 只丧尸', w0.total === 6, JSON.stringify(w0));
  rec('场上存活不超过并发上限（4）', w0.alive <= 4, `alive=${w0.alive}`);
  const box = await c.evaluate(`(() => {
    const el = document.querySelector('#app canvas');
    if (!el) return { ok: false, why: 'canvas 不存在' };
    const r = el.getBoundingClientRect();
    return { ok: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2,
             why: Math.round(r.width) + '×' + Math.round(r.height) + ' vs ' + innerWidth + '×' + innerHeight };
  })()`);
  rec('画布铺满视口', !!(box && box.ok), box && box.why);
  await c.shot('02-gameplay.png');

  section('C. 射击 / 统计');
  const before = await c.evaluate('window.__game.gun.mag');
  await c.evaluate(`(() => {
    // debugFire 会检查冷却，必须逐发清零，否则只在第一发真正开枪
    for (let i = 0; i < 5; i++) { window.__game.gun.cooldown = 0; window.__game.gun.debugFire(); }
  })()`);
  const after = await c.evaluate('window.__game.gun.mag');
  rec('连开 5 发弹药递减', after === before - 5, `${before} → ${after}`);
  rec('HUD 弹药同步', String(await txt(c, 'document.getElementById("mag-value").textContent')) === String(after));
  rec('本局统计已记录 5 次开火', Number(await c.evaluate('window.__game.stats.shots')) === 5, `shots=${await c.evaluate('window.__game.stats.shots')}`);
  const tracer = await c.evaluate(`(() => {
    const g = window.__game;
    const before = g.effects.tracerPool.filter((t) => t.life > 0).length;
    g.gun.cooldown = 0;
    g.gun.debugFire();
    const after = g.effects.tracerPool.filter((t) => t.life > 0).length;
    return { before, after };
  })()`);
  rec('开火立即生成曳光弹', Number(tracer.after) > Number(tracer.before), JSON.stringify(tracer));

  section('C2. 丧尸无枪械（普通丧尸只能近战）');
  const meleeCheck = await c.evaluate(`(() => {
    const em = window.__game.enemies;
    const out = { variants: [], meleeOk: true, spitOk: true, noGunProps: true };
    // 全部实例的变体配置都不允许出现枪械字段
    for (const e of em.enemies) {
      const v = e.variant;
      if (!out.variants.includes(v.id)) out.variants.push(v.id);
      if (v.id !== 'spitter' && v.melee !== true) out.meleeOk = false;
      if (v.melee) {
        // 近战变体不得有 accuracy / 弹匣等枪械属性
        if ('accuracy' in v || 'magazineSize' in v || 'reloadTime' in v) out.noGunProps = false;
        if (v.attackRange > 4) out.meleeOk = false;   // 近战触及距离必须是短手
      }
    }
    // 普通丧尸（walker）在攻击范围内走 windup 近战判定，不产生曳光弹
    const w = em.enemies.find((e) => e.variantId === 'walker') || em.enemies[0];
    w.setVariant ? w.setVariant('walker') : null;
    return out;
  })()`);
  rec('普通丧尸变体只有近战（melee=true）', meleeCheck.meleeOk, JSON.stringify(meleeCheck));
  rec('近战变体无任何枪械属性（弹匣/精度）', meleeCheck.noGunProps, JSON.stringify(meleeCheck));
  const noTracer = await c.evaluate(`(() => {
    const g = window.__game;
    const w = g.enemies.enemies.find((e) => e.variantId === 'walker' && !e.dead) || g.enemies.enemies[0];
    w.dead = false; w.deadTimer = 0; w.root.visible = true;
    w.setVariant('walker'); w.health = w.maxHealth;
    w.position.set(0, 0, 3.6); w.root.position.copy(w.position);
    w.velocity.set(0, 0, 0);
    g.player.position.set(0, 0, 8); g.player.velocity.set(0, 0, 0);
    g.mouseLook.reset();
    // 相机位置由 player._syncCamera 写入，_canSeePlayer 读的就是 camera；
    // 不跑一帧玩家更新，丧尸永远"看不见人"，近战前摇根本不会启动
    g.player.update(0.016, g.mouseLook);
    g.player.health.health = 100; g.player.health.armor = 50; g.player.health.dead = false;
    w.heading = Math.atan2(g.player.position.x - w.position.x, g.player.position.z - w.position.z);
    w.targetHeading = w.heading;
    w.lastKnown.copy(g.player.position);
    w.attackTimer = 0; w.windupTimer = 0; w.windupDone = true;
    const tracersBefore = g.effects.tracerPool.filter((t) => t.life > 0).length;
    // 连跑 3 秒近战：逼近 → 前摇 → 判定
    for (let i = 0; i < 120; i++) w.update(0.025);
    const tracersAfter = g.effects.tracerPool.filter((t) => t.life > 0).length;
    return { tracersBefore, tracersAfter, hp: g.player.health.health, armor: g.player.health.armor };
  })()`);
  rec('普通丧尸近战不产生任何弹道曳光', noTracer.tracersAfter <= noTracer.tracersBefore, JSON.stringify(noTracer));
  rec('普通丧尸近战可对玩家造成伤害（含护甲吸收）', noTracer.hp < 100, `hp=${noTracer.hp} armor=${noTracer.armor}`);

  section('C3. 补给点（资源 / 弹药 / 物资）');
  const supplyCheck = await c.evaluate(`(() => {
    const g = window.__game;
    const s = g.supplies;
    const types = [...new Set(s.points.map((p) => p.type))];
    // 弹药拾取
    const ammoP = s.points.find((p) => p.type === 'ammo' && p.cooldown <= 0);
    g.gun.reserve = 10;
    g.player.position.set(ammoP.root.position.x, 0, ammoP.root.position.z);
    s.update(0.016);
    const reserveAfterAmmo = g.gun.reserve;
    const ammoCooling = ammoP.cooldown > 0;
    // 医疗拾取（先扣血）
    const medP = s.points.find((p) => p.type === 'med' && p.cooldown <= 0);
    g.player.health.health = 30;
    g.player.position.set(medP.root.position.x, 0, medP.root.position.z);
    s.update(0.016);
    const hpAfterMed = g.player.health.health;
    // 护甲拾取
    const armorP = s.points.find((p) => p.type === 'armor' && p.cooldown <= 0);
    g.player.health.armor = 5;
    g.player.position.set(armorP.root.position.x, 0, armorP.root.position.z);
    s.update(0.016);
    const armorAfter = g.player.health.armor;
    return {
      count: s.points.length,
      types,
      reserveAfterAmmo, ammoCooling, hpAfterMed, armorAfter,
    };
  })()`);
  rec('补给点已布置（≥8 个）', supplyCheck.count >= 8, `count=${supplyCheck.count}`);
  rec('补给类型齐全（弹药/医疗/护甲/物资）',
    ['ammo', 'med', 'armor', 'cache'].every((t) => supplyCheck.types.includes(t)), JSON.stringify(supplyCheck.types));
  rec('靠近弹药箱自动补弹（10 → 100）', supplyCheck.reserveAfterAmmo === 100, `reserve=${supplyCheck.reserveAfterAmmo}`);
  rec('拾取后补给点进入冷却', supplyCheck.ammoCooling === true);
  rec('靠近医疗包回复生命（30 → 75）', supplyCheck.hpAfterMed === 75, `hp=${supplyCheck.hpAfterMed}`);
  rec('靠近护甲板回复护甲（5 → 40）', supplyCheck.armorAfter === 40, `armor=${supplyCheck.armorAfter}`);

  section('D. 换弹');
  const magBeforeReload = Number(await c.evaluate('window.__game.gun.mag'));
  const reserveBefore = Number(await c.evaluate('window.__game.gun.reserve'));
  await c.evaluate('window.__game.gun.startReload()');
  await c.frame(3);
  rec('进入换弹状态', String(await txt(c, 'window.__game.gun.reloading')) === 'true');
  rec('换弹进度条可见', String(await txt(c, '!document.getElementById("reload-bar").classList.contains("hidden")')) === 'true');
  await c.evaluate('window.__game.gun.reloadElapsed = window.__game.gun.reloadDuration - 0.01');
  await c.frame(4);
  rec('换弹补满弹匣', Number(await c.evaluate('window.__game.gun.mag')) === 30, `mag=${await c.evaluate('window.__game.gun.mag')}`);
  const expectReserve = reserveBefore - (30 - magBeforeReload);
  const gotReserve = Number(await c.evaluate('window.__game.gun.reserve'));
  rec('备弹按缺额扣除', gotReserve === expectReserve, `${reserveBefore} → ${gotReserve}（应 ${expectReserve}）`);
  rec('进度条已隐藏', String(await txt(c, 'document.getElementById("reload-bar").classList.contains("hidden")')) === 'true');

  section('E. 命中判定（真射线 + 真扣血）');
  const hitResult = await c.evaluate(`(() => {
    const g = window.__game;
    const e = g.enemies.enemies.find((x) => !x.dead) || g.enemies.enemies[0];
    // 摆成「玩家在 (0,0,8) 面向 -Z，敌人正前方 5 米」
    g.player.position.set(0, 0, 8);
    g.player.velocity.set(0, 0, 0);
    g.mouseLook.reset();
    g.mouseLook.recoilPitch = 0;
    g.mouseLook.recoilYaw = 0;
    // 相机位置由 player._syncCamera 写入，必须真的跑一帧玩家更新，
    // 否则射线原点还停在旧位置（这是探针早期漏伤害假阴性的根因）
    g.player.update(0.016, g.mouseLook);
    g.mouseLook.update(0);
    e.dead = false; e.deadTimer = 0; e.root.visible = true;
    e.position.set(0, 0, 3); e.root.position.copy(e.position);
    e.velocity.set(0, 0, 0);
    e.health = e.maxHealth;
    e.bar.visible = false;
    const before = e.health;
    g.gun.mag = 30; g.gun.cooldown = 0; g.gun.reloading = false;
    const shotsBefore = g.stats.shots, hitsBefore = g.stats.hits;
    g.gun.debugFire();
    return { before, after: e.health, dmg: before - e.health, shots: g.stats.shots - shotsBefore, hits: g.stats.hits - hitsBefore };
  })()`);
  rec('正前方敌人被命中并扣血', hitResult.dmg > 0, `-${hitResult.dmg} HP`);
  rec('命中计入 stats.hits', hitResult.hits === 1 && hitResult.shots === 1, JSON.stringify(hitResult));

  const killResult = await c.evaluate(`(() => {
    const g = window.__game;
    const e = g.enemies.enemies.find((x) => !x.dead);
    const k0 = g.enemies.kills;
    let guard = 0;
    while (!e.dead && guard++ < 10) {
      g.gun.cooldown = 0; g.gun.mag = 30; g.gun.reloading = false;
      g.gun.debugFire();
    }
    return { killed: e.dead, kills: g.enemies.kills - k0 };
  })()`);
  rec('持续命中可击杀敌人', killResult.killed === true && killResult.kills === 1, JSON.stringify(killResult));
  rec('HUD 击杀数同步', Number(await txt(c, 'document.getElementById("kill-value").textContent')) === Number(await c.evaluate('window.__game.enemies.kills')));

  section('F. 三波推进');
  const w1 = await clearWave();
  rec('第 1 波按 total 刷满并清空', w1.spawned === w1.total && w1.killed === w1.total, JSON.stringify(w1));
  await c.frame(3);
  rec('清空后进入休整（break）', String(await c.evaluate('window.__game.enemies.waveState')) === 'break', String(await c.evaluate('window.__game.enemies.waveState')));
  rec('休整期补给已发放（备弹 +60）', Number(await c.evaluate('window.__game.gun.reserve')) >= 114, `reserve=${await c.evaluate('window.__game.gun.reserve')}`);
  await c.evaluate('window.__game.enemies.breakTimer = 0.001');
  await c.frame(3);
  rec('进入第 2 波', Number(await c.evaluate('window.__game.enemies.waveIndex')) === 1, String(await c.evaluate('window.__game.enemies.waveIndex')));
  rec('HUD 波次更新为 2/3', String(await txt(c, 'document.getElementById("wave-now").textContent')) === '2');
  const w2 = await clearWave();
  await c.frame(2);
  await c.evaluate('window.__game.enemies.breakTimer = 0.001');
  await c.frame(3);
  rec('第 2 波清空 → 第 3 波', Number(await c.evaluate('window.__game.enemies.waveIndex')) === 2, JSON.stringify(w2));
  const w3 = await clearWave();
  await c.frame(4);
  rec('第 3 波清空', w3.killed === w3.total, JSON.stringify(w3));

  section('G. 胜利结算');
  rec('状态切到 result', String(await c.evaluate('window.__game.state')) === 'result', String(await c.evaluate('window.__game.state')));
  rec('结算面板可见', String(await txt(c, '!document.getElementById("result").classList.contains("hidden")')) === 'true');
  rec('标题为「区域肃清」', String(await txt(c, 'document.getElementById("result-title").textContent')) === '区域肃清');
  rec('评级是 S/A/B/C 之一', /^[SABC]$/.test(String(await txt(c, 'document.getElementById("result-grade").textContent'))),
    String(await txt(c, 'document.getElementById("result-grade").textContent')));
  const rs = await c.evaluate(`({
    kills: document.getElementById('rs-kills').textContent,
    acc: document.getElementById('rs-acc').textContent,
    wave: document.getElementById('rs-wave').textContent,
    time: document.getElementById('rs-time').textContent,
  })`);
  rec('结算击杀 = 24（三波总数）', rs.kills === '24', JSON.stringify(rs));
  rec('结算波次 = 3/3', rs.wave === '3/3', rs.wave);
  rec('命中率为百分比格式', /^\d+%$/.test(rs.acc), rs.acc);
  await c.shot('03-result-win.png');

  section('H. 再来一局');
  await c.evaluate('document.getElementById("btn-again").click()');
  await c.frame(4);
  rec('回到 playing', String(await c.evaluate('window.__game.state')) === 'playing', String(await c.evaluate('window.__game.state')));
  rec('波次重置为 1/3', Number(await c.evaluate('window.__game.enemies.waveIndex')) === 0);
  rec('击杀与统计清零', Number(await c.evaluate('window.__game.enemies.kills')) === 0 && Number(await c.evaluate('window.__game.stats.kills')) === 0);
  rec('生命/护甲/弹药全部重置',
    String(await txt(c, 'document.getElementById("hp-value").textContent + "/" + document.getElementById("armor-value").textContent + "/" + document.getElementById("mag-value").textContent')) === '100/50/30');
  rec('结算面板已隐藏', String(await txt(c, 'document.getElementById("result").classList.contains("hidden")')) === 'true');

  section('I. 阵亡 → 失败结算');
  await c.evaluate('window.__game.player.takeDamage(9999)');
  await c.frame(4);
  rec('状态切到 result', String(await c.evaluate('window.__game.state')) === 'result');
  rec('标题为「行动阵亡」', String(await txt(c, 'document.getElementById("result-title").textContent')) === '行动阵亡');
  rec('面板带 lose 样式', String(await txt(c, 'document.getElementById("result").classList.contains("lose")')) === 'true');
  await c.shot('04-result-lose.png');

  section('J. 返回主菜单');
  await c.evaluate('document.getElementById("btn-menu").click()');
  await c.frame(3);
  rec('回到主菜单', String(await c.evaluate('window.__game.state')) === 'menu', String(await c.evaluate('window.__game.state')));
  rec('菜单可见 / HUD 隐藏',
    String(await txt(c, '!document.getElementById("menu").classList.contains("hidden") && document.getElementById("hud").classList.contains("hidden")')) === 'true');

  section('K. 稳定性');
  rec('全程无未捕获异常', c.exceptions.length === 0, c.exceptions.slice(0, 3).join(' | '));
  rec('全程无 console.error', c.consoleErrors.length === 0, c.consoleErrors.slice(0, 3).join(' | '));
  const callCount = await c.evaluate('window.__game.renderer.info.render.calls');
  rec('单帧 draw call 控制在 220 以内', Number(callCount) < 220, `calls=${callCount}`);
  await c.shot('05-final.png');
} catch (err) {
  console.error('\n探针异常：', err);
  fail += 1;
} finally {
  console.log(`\n=== 探针结果：${pass}/${pass + fail} 通过 ===`);
  if (c.exceptions.length) console.log('未捕获异常：\n' + c.exceptions.join('\n'));
  if (c.consoleErrors.length) console.log('console.error：\n' + c.consoleErrors.join('\n'));
  c.close();
  server.close();
  await sleep(200);
}
process.exit(fail ? 1 : 0);
