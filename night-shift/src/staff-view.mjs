/**
 * 店员 3D 表现层（第三批 · 任务块 H-2）
 *
 * 为什么需要这一层：
 *   staff.mjs / staff-decision.mjs 是纯逻辑（ADR-002，不依赖 THREE / DOM），
 *   店员的"智能"（任务优先级 / 疲惫降效 / 偏好 / 任务锁）此前只在 HUD 数字面板里可见，
 *   3D 场景里根本没有店员实体 —— 于是"店员智能"这条需求在 3D 层无人验证。
 *
 * 这一层只做"表现"：读 staffApi().snapshot() 与 worldState 的故障/垃圾位置，
 * 给每个雇佣店员建一个角色 + 头顶气泡 + 移动虚线，按 status 把它们送到对应工作点。
 * 不改任何逻辑状态，纯消费 —— 与 customers.mjs 的分层约定一致（系统只算、view 只画）。
 */
import * as THREE from 'three';
import { createCharacter } from './character.mjs';
import { POS, STAFF, STORE, SHELF_ROWS } from './config.mjs';

/* 头顶气泡文案：与 staff-decision.BUBBLE 对齐，另补 staff.mjs 的实际 status */
const BUBBLE = {
  restock: '补货中', 'stock-shelf': '补货中', 'stock-vending': '补货中', 'stock-claw': '补货中',
  checkout: '收银中', patrol: '巡逻中', event: '处理中',
  resting: '休息中', idle: '待命', errand: '外出采购', stopped: '停工',
  repair: '维修中', clean: '清理中', off: '今夜休息', working: '工作中',
};
const STATUS_TINT = {
  repair: '#E8A94E', clean: '#6FCF97', resting: '#9AA3B2', errand: '#4FD1E8',
  stopped: '#E05A5A', off: '#6B7280', idle: '#E6E2D6',
};

/** 每个岗位一个"待命/工作"基准点，分布在店内不挡主通道的位置 */
const HOME = {
  repairer: { x: 4.8, z: -3.4 },
  cleaner: { x: 5.4, z: 1.2 },
  purchaser: { x: 5.4, z: 3.0 },
  stocker: { x: -5.6, z: 0.2 },
};
const REST_POINT = { x: -10.2, z: 8.4 };   // 休息区（ZONES.rest 中心）
const DOOR_POINT = { x: POS.door.x, z: POS.door.z - 0.6 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createStaffView(opts = {}) {
  const scene = opts.scene;          // THREE.Scene
  const staffApi = opts.staffApi;    // () => snapshot()
  const worldState = opts.worldState;
  const entries = new Map();         // staffId -> { type, char, bubble, tex, line, pos, target, status, hair, cloth }
  let enabled = opts.enabled !== false;
  let nextSeed = 0.31;

  function makeBubble() {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 96;
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.35, 0.5, 1);
    sprite.position.y = 2.15;
    sprite.renderOrder = 12;
    sprite.userData.bubble = true;
    return { sprite, canvas, tex, last: null };
  }

  function drawBubble(b, text, tint) {
    const key = text + '|' + tint;
    if (b.last === key) return;
    b.last = key;
    const c = b.canvas.getContext('2d');
    c.clearRect(0, 0, b.canvas.width, b.canvas.height);
    c.fillStyle = 'rgba(28,34,46,0.94)';
    c.strokeStyle = tint; c.lineWidth = 4;
    c.beginPath();
    if (typeof c.roundRect === 'function') c.roundRect(4, 4, 248, 88, 20);
    else c.rect(4, 4, 248, 88);
    c.fill(); c.stroke();
    c.fillStyle = tint;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 40px system-ui, "Microsoft YaHei", sans-serif';
    c.fillText(text, 128, 48);
    b.tex.needsUpdate = true;
  }

  function makePathLine() {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineDashedMaterial({ color: 0x8ce8ff, dashSize: 0.22, gapSize: 0.16, transparent: true, opacity: 0.7 });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    line.visible = false;
    line.userData.pathLine = true;
    return line;
  }

  function setPath(line, from, to) {
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, from.x, 0.06, from.z);
    pos.setXYZ(1, to.x, 0.06, to.z);
    pos.needsUpdate = true;
    line.computeLineDistances();
    line.visible = true;
  }

  /** 根据 status 决定 3D 工作点 */
  function targetOf(status, type, extra = {}) {
    const home = HOME[type] ?? HOME.repairer;
    switch (status) {
      case 'resting': case 'off': return REST_POINT;
      case 'errand': return DOOR_POINT;
      case 'repair': {
        const d = worldState?.deviceList?.().find((x) => x.id === extra.targetId) || worldState?.deviceList?.().find((x) => x.broken);
        if (d && Number.isFinite(d.x) && Number.isFinite(d.z)) return { x: d.x, z: d.z };
        return home;
      }
      case 'clean': return { x: 2.0 + nextSeed, z: -2.0 };
      case 'stock-shelf': case 'stock-vending': case 'stock-claw': case 'restock': {
        const row = SHELF_ROWS[0];
        const zs = row.zs;
        return { x: row.x + 1.0, z: zs[Math.floor(nextSeed * zs.length) % zs.length] };
      }
      case 'checkout': case 'event': return { x: POS.counter.x - 1.1, z: POS.counter.z };
      default: return home;
    }
  }

  function ensureEntry(id, type) {
    let e = entries.get(id);
    if (e) return e;
    const def = STAFF.types[type] ?? STAFF.types.repairer;
    const seed = nextSeed = (nextSeed * 1.7 + 0.13) % 1;
    const char = createCharacter({ seed, cloth: def.color, hair: 0x2b2b33, type });
    char.group.userData.tag = 'staff';
    char.group.userData.staffId = id;
    const home = HOME[type] ?? HOME.repairer;
    char.group.position.set(home.x, 0, home.z);
    scene.add(char.group);

    const bubble = makeBubble();
    char.group.add(bubble.sprite);

    const line = makePathLine();
    scene.add(line);

    e = { id, type, char, bubble, tex: bubble.tex, line,
      pos: { x: home.x, z: home.z }, target: { x: home.x, z: home.z },
      status: 'idle', text: null };
    entries.set(id, e);
    return e;
  }

  function removeEntry(id) {
    const e = entries.get(id);
    if (!e) return;
    scene.remove(e.char.group);
    scene.remove(e.line);
    e.line.geometry.dispose?.();
    e.line.material.dispose?.();
    e.bubble.tex.dispose?.();
    entries.delete(id);
  }

  /** 每帧调用：同步实体集合 + 驱动移动/气泡/路径 */
  function update(dt = 0, ctx = {}) {
    if (!enabled || !scene) return;
    const snap = typeof staffApi === 'function' ? staffApi() : staffApi;
    const roster = (snap?.roster || []).filter((r) => r.hired);
    const liveIds = new Set();

    for (const r of roster) {
      const id = r.type || r.id;   // 每岗位各 1 人，用 type 作稳定 id
      liveIds.add(id);
      const e = ensureEntry(id, r.type);
      const status = r.status || 'idle';
      const t = targetOf(status, r.type, { targetId: r.targetId });
      // 目标变化才更新路径（避免每帧重算）
      if (!e.text || e.status !== status || !e.target || Math.abs(e.target.x - t.x) > 0.3 || Math.abs(e.target.z - t.z) > 0.3) {
        setPath(e.line, e.pos, t);
        e.target = t;
      }
      e.status = status;

      // 平滑移动
      const dx = t.x - e.pos.x, dz = t.z - e.pos.z;
      const dist = Math.hypot(dx, dz);
      const speed = 1.9;   // 米/秒
      let moving = false;
      if (dist > 0.12) {
        const step = Math.min(dist, speed * Math.max(0, dt));
        e.pos.x += dx / dist * step;
        e.pos.z += dz / dist * step;
        moving = true;
      }
      e.char.group.position.set(e.pos.x, 0, e.pos.z);
      if (moving) e.char.update(dt, true, Math.atan2(dx, dz));
      else e.char.update(dt, false);

      // 头顶气泡
      const text = BUBBLE[status] ?? '待命';
      e.text = text;
      drawBubble(e.bubble, text, STATUS_TINT[status] ?? '#E6E2D6');
    }

    // 解雇的店员移除实体
    for (const id of [...entries.keys()]) if (!liveIds.has(id)) removeEntry(id);
  }

  /** 诊断接口：3D 实体数量与快照，供浏览器验证断言 */
  function stats() {
    const list = [];
    for (const [id, e] of entries) {
      list.push({ id, type: e.type, status: e.status, text: e.text,
        pos: { x: +e.pos.x.toFixed(2), z: +e.pos.z.toFixed(2) },
        target: { x: +e.target.x.toFixed(2), z: +e.target.z.toFixed(2) },
        hasMesh: !!e.char.group, hasBubble: !!e.bubble.sprite, hasPath: !!e.line });
    }
    return { enabled, count: entries.size, staff: list };
  }

  return { update, stats, setEnabled(v) { enabled = !!v; }, _entries: entries };
}
