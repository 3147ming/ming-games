/**
 * 调试信息条（模块 1 临时）
 * ---------------------------------------------------------------------------
 * ⚠ 这不是模块 7 的"战场 UI"。它只服务于三件事：
 *   ① 让你肉眼确认 spec 的数值真的落在运行时上（相机水平距离是不是 8、高度是不是 4）；
 *   ② 让无头浏览器探针有一个可靠的"应用真的起来了"的锚点（window.MUSOU.debug）；
 *   ③ 出了问题能立刻看到是不是 NaN 传进来了。
 * 模块 7 会把它换成正式的战场 UI（血条/无双槽/击杀数/据点进度），届时本文件降级为
 * 按 F3 才出现的开发面板，不再是常驻 HUD。
 */

const ROWS = [
  ['fps', 'FPS'],
  ['frame', '帧号'],
  ['pos', '玩家位置'],
  ['pstate', '角色状态'],
  ['pspeed', '移动速度'],
  ['pdodge', '闪避 / 无敌'],
  ['pfacing', '朝向 / 镜头'],
  ['cmove', '招式 / 进度'],
  ['ccombo', '连击数'],
  ['cmeters', '无双 / 斗气'],
  ['cstats', '挥击 / 命中 / 击杀'],
  ['ctargets', '练武场 / 顿帧 / 池'],
  ['estates', '★敌人三态 / 上限'],
  ['eslots', '★攻击插槽 / 分层距离'],
  ['ecombat', '★敌人出手 / 击中玩家'],
  ['eperf', '★敌人绘制 / 分离开销'],
  ['camDist', '相机水平距离'],
  ['camHeight', '相机在 pivot 之上'],
  ['boom', '摇臂长度（当前/期望）'],
  ['blocked', '遮挡拉近'],
  ['pitch', '俯角 / yaw'],
  ['pivotLag', '注视点滞后'],
  ['meshes', '网格 / 碰撞体 / 绘制调用'],
  ['layout', '布局种子 / 物件 / 草丛'],
  ['warn', '告警'],
];

export class DebugHud {
  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'dbg';
    this.root.id = 'dbg-hud';
    const title = document.createElement('div');
    title.className = 'dbg-title';
    title.textContent = '模块 1-4 · 战场/摄像机/玩家/C技/敌人分层AI —— F3 隐藏 · F4 坐标轴 · F5 敌人状态环';
    this.root.appendChild(title);
    this.cells = {};
    for (const [key, label] of ROWS) {
      const row = document.createElement('div');
      row.className = 'dbg-row';
      const k = document.createElement('span');
      k.className = 'dbg-k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'dbg-v';
      v.textContent = '—';
      row.append(k, v);
      this.root.appendChild(row);
      this.cells[key] = v;
    }
    document.body.appendChild(this.root);
  }

  toggle() {
    this.root.classList.toggle('hidden');
    return !this.root.classList.contains('hidden');
  }

  /**
   * 显式设置显隐。
   * ⚠ 探针抓拍前必须把它收起来：面板固定在左上，正好压住刀光/靶子那一片，
   *   拍出来的图会"看起来没特效"——其实是特效被面板盖住了。
   */
  show(visible) {
    this.root.classList.toggle('hidden', !visible);
    return !this.root.classList.contains('hidden');
  }

  set(key, text) {
    const c = this.cells[key];
    if (c) c.textContent = text;
  }

  /** 每帧调用，但内部限频到 4Hz —— DOM 写操作不该跟着渲染帧率跑 */
  update(snapshot) {
    const now = performance.now();
    if (this._last && now - this._last < 240) return;
    this._last = now;
    for (const [key] of ROWS) {
      if (snapshot[key] !== undefined) this.set(key, snapshot[key]);
    }
  }
}
