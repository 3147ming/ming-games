/**
 * 游戏主控制器：渲染循环、状态机、模块装配
 * 状态：loading → menu → playing ⇄ paused → result
 *
 * v0.2 改动：
 *  - 接入波次系统，敌人不再无限原地复活；清完三波即胜利结算
 *  - 新增本局统计（击杀 / 爆头 / 命中率 / 用时 / 承受伤害）与 S~C 评级
 *  - 死亡不再"按 R 复活"重开一局，而是进入结算面板，可再来一局或回主菜单
 */
import * as THREE from 'three';
import { WORLD, MATCH, WEAPON } from '../config/weapon.js';
import { Input } from './Input.js';
import { AssetManager } from './AssetManager.js';
import { AudioManager } from './AudioManager.js';
import { CollisionWorld } from './CollisionWorld.js';
import { SaveManager } from './SaveManager.js';
import { computeAccuracy, computeScore, pickGrade } from './scoring.js';
import { OutdoorMap } from '../world/OutdoorMap.js';
import { SupplyManager } from '../world/SupplyManager.js';
import { MouseLook } from '../player/MouseLook.js';
import { PlayerController } from '../player/PlayerController.js';
import { WeaponView } from '../weapons/WeaponView.js';
import { GunSystem } from '../weapons/GunSystem.js';
import { Effects } from '../weapons/Effects.js';
import { CasingSystem } from '../weapons/CasingSystem.js';
import { EnemyManager } from '../enemies/EnemyManager.js';
import { HUD } from '../ui/HUD.js';
import { Menu } from '../ui/Menu.js';

export class Game {
  constructor() {
    this.state = 'loading';
    this.clock = new THREE.Clock();
    this.accentColor = 0xffb020;
    this.stats = this._emptyStats();
  }

  _emptyStats() {
    return {
      kills: 0,
      headshots: 0,
      shots: 0,
      hits: 0,
      damageTaken: 0,
      startedAt: 0,
      endedAt: 0,
      wavesCleared: 0,
    };
  }

  async init() {
    // ---- 环境检测（公网部署适配：WebGL 支持 / HTTPS 鼠标锁定提示）----
    if (!this._checkWebGL()) return;
    this._checkProtocol();

    // ---- 渲染器 ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    // 第三轮：开启软阴影（箱子、墙体投射阴影）
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(WORLD.fogColor);
    this.scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.03, 200);
    this.scene.add(this.camera);

    // ---- 加载资源 ----
    this.menu = new Menu({
      onStart: () => this.startGame(),
      onResume: () => this.resumeGame(),
      onRestart: () => this.restart(),
      onMenu: () => this.backToMenu(),
    });

    // 局外存档：大厅资源与战绩从这里读
    this.save = new SaveManager();
    this._refreshLobby();

    this.assets = await new AssetManager().loadAll((p) => this.menu.setLoading(p));

    this.menu.setLoading(100, '正在初始化音频…');
    this.audio = new AudioManager();
    await this.audio.init();

    // ---- 世界与玩家 ----
    this.collision = new CollisionWorld();
    // ?level=N（从 1 开始）用于开发期直接进入指定关卡，默认第 1 关
    const levelParam = Number(new URLSearchParams(location.search).get('level'));
    this.levelIndex = Number.isFinite(levelParam) && levelParam >= 1 ? Math.floor(levelParam) - 1 : 0;
    this.map = new OutdoorMap(this.scene, this.collision, this.assets, this.levelIndex).build();

    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = (locked) => this._onLockChange(locked);

    this.mouseLook = new MouseLook(this.camera);
    this.player = new PlayerController(this.camera, this.input, this.collision, this.audio, this.map.playerSpawn);

    this.hud = new HUD();
    this.effects = new Effects(this.scene);
    this.casings = new CasingSystem(this.scene, this.audio);
    this.weaponView = new WeaponView(this.camera, this.assets);

    this.enemies = new EnemyManager({
      scene: this.scene,
      assets: this.assets,
      collision: this.collision,
      audio: this.audio,
      player: this.player,
      effects: this.effects,
      hud: this.hud,
      spawnPoints: this.map.spawnPoints,
      patrolPoints: this.map.waypoints,
      onKill: () => this._onKill(),
      onWaveStart: (i, total) => this._onWaveStart(i, total),
      onWaveClear: (i, isLast) => this._onWaveClear(i, isLast),
      onVictory: () => this._onVictory(),
      onPlayerHit: (dmg) => { this.stats.damageTaken += dmg; },
    });

    this.gun = new GunSystem({
      camera: this.camera,
      player: this.player,
      mouseLook: this.mouseLook,
      weaponView: this.weaponView,
      effects: this.effects,
      casings: this.casings,
      audio: this.audio,
      collision: this.collision,
      enemies: this.enemies,
      hud: this.hud,
      onKill: () => {},
      onShot: (info) => this._onShot(info),
    });

    // 补给点系统（弹药 / 医疗 / 护甲 / 综合物资）
    this.supplies = new SupplyManager({
      scene: this.scene,
      player: this.player,
      gun: this.gun,
      playerHealth: this.player.health,
      hud: this.hud,
      audio: this.audio,
    });

    // 初始数值同步
    this.hud.reset();
    this.hud.setKills(0);
    this.hud.setEnemies(0);
    this.hud.setWave(1, MATCH.waves.length, 0);

    // 第三轮：开局操作提示（3 秒后自动淡出）+ FPS 面板
    this.tipsEl = document.getElementById('tips');
    this.waveBannerEl = document.getElementById('wave-banner');
    this.fpsPanel = document.getElementById('fps-panel');
    this.fpsValue = document.getElementById('fps-value');
    this._fpsFrames = 0;
    this._fpsAcc = 0;
    this._fpsVisible = new URLSearchParams(location.search).has('debug');
    if (this._fpsVisible && this.fpsPanel) this.fpsPanel.classList.remove('hidden');

    // 让相机在菜单界面就处于正确位置
    this.player.update(0.016, this.mouseLook);
    this.mouseLook.update(0.016);

    // 相机点击：游戏中重新锁定鼠标
    this.renderer.domElement.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    window.addEventListener('resize', () => this._onResize());

    // 调试信息（访问 index.html?debug=1 时显示）
    if (new URLSearchParams(location.search).has('debug')) {
      this.debugEl = document.createElement('div');
      this.debugEl.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:12px', 'z-index:99',
        'font:12px/1.5 Consolas,monospace', 'color:#9fe8ff',
        'background:rgba(0,0,0,0.68)', 'padding:8px 10px', 'white-space:pre',
        'pointer-events:none', 'border:1px solid rgba(120,200,255,0.4)',
      ].join(';');
      document.body.appendChild(this.debugEl);
      this._debugTimer = 0;
    }

    this.menu.showStart();
    this.state = 'menu';

    // 启动循环
    this.clock.start();
    this.renderer.setAnimationLoop(() => this._loop());
  }

  // ---------------- 状态切换 ----------------
  startGame() {
    this.audio.resume();
    this.state = 'playing';
    this.stats = this._emptyStats();
    this.stats.startedAt = performance.now();
    this.stats.wavesCleared = 0;

    this.hud.setVisible(true);
    this.hud.reset();
    this.hud.setKills(0);
    this.menu.hideAll();
    this.input.enabled = true;
    this.mouseLook.reset();
    this.input.consumeMouseDelta();
    this.input.requestLock();
    this.gun.resetAmmo();
    this.player.respawn(this.map.playerSpawn);
    this.enemies.startMatch();
    this.supplies.reset();
    this._showTips();
  }

  /** 第三轮：显示开局操作提示，3 秒后淡出 */
  _showTips() {
    if (!this.tipsEl) return;
    this.tipsEl.classList.remove('hide');
    clearTimeout(this._tipsTimer);
    this._tipsTimer = setTimeout(() => this.tipsEl.classList.add('hide'), 3000);
  }

  /** 第三轮：切换 FPS 面板显示 */
  _toggleFps() {
    this._fpsVisible = !this._fpsVisible;
    if (this.fpsPanel) this.fpsPanel.classList.toggle('hidden', !this._fpsVisible);
  }

  pauseGame() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.gun.setMouseDown(false);
    this.menu.showPause();
  }

  resumeGame() {
    if (this.state !== 'paused') return;
    this.audio.resume();
    this.state = 'playing';
    this.input.enabled = true;
    this.menu.hideAll();
    this.input.requestLock();
  }

  /** 暂停面板"重新开始" / 结算面板"再来一局" */
  restart() {
    this.player.respawn(this.map.playerSpawn);
    this.player.health.reset();
    this.mouseLook.reset();
    this.gun.resetAmmo();
    this.stats = this._emptyStats();
    this.stats.startedAt = performance.now();
    this.enemies.startMatch();
    this.supplies.reset();
    this.hud.setKills(0);
    this.hud.reset();
    this.hud.setVisible(true);
    this.menu.hideAll();
    this.state = 'playing';
    this.input.enabled = true;
    this.audio.resume();
    this.input.requestLock();
    this._showTips();
  }

  /** 结算面板"返回主菜单" */
  backToMenu() {
    if (this.state === 'result') this.stats.endedAt = performance.now();
    this.state = 'menu';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.hud.setVisible(false);
    this._refreshLobby();
    this.menu.showStart();
  }

  /** 把存档数据刷到大厅面板 */
  _refreshLobby() {
    if (!this.save || !this.menu || !this.menu.lobby) return;
    const d = this.save.data;
    this.menu.lobby.setResources(d.meta.cores, 0);
    this.menu.lobby.setStats({
      runs: d.stats.runs,
      kills: d.stats.kills,
      level: d.stats.bestLevel,
      wave: d.stats.bestWave,
    });
  }

  /** 指针锁定状态变化 */
  _onLockChange(locked) {
    if (!locked && this.state === 'playing') this.pauseGame();
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  }

  // ---------------- 波次 / 结算 ----------------
  /**
   * 击杀以「敌人死亡事件」为准，而不是以「最后一发子弹」为准。
   * 这样以后加爆炸物 / 环境击杀，统计也不会漏。
   */
  _onKill() {
    this.stats.kills += 1;
  }

  /** 每一发子弹都记一次，用于算命中率与爆头数 */
  _onShot(info) {
    this.stats.shots += 1;
    if (info && info.hit) this.stats.hits += 1;
    if (info && info.kill && info.headshot) this.stats.headshots += 1;
  }

  _onWaveStart(index, total) {
    const cfg = MATCH.waves[index];
    this.hud.setWave(index + 1, MATCH.waves.length, total);
    this.hud.setEnemies(total);
    this._showBanner(
      `第 ${index + 1} 波尸潮`,
      `丧尸 ${total} 只 · 同时最多 ${cfg.alive} 只在场`
    );
  }

  _onWaveClear(index, isLast) {
    this.stats.wavesCleared = index + 1;
    if (isLast) return;   // 最后一波直接走胜利流程
    // 休整补给：备弹 + 护甲
    this.gun.addSupply(MATCH.waveClearAmmo);
    this.player.health.addArmor(MATCH.waveClearArmor);
    this._showBanner(`第 ${index + 1} 波肃清`, `补给已投放：+${MATCH.waveClearAmmo} 发 · +${MATCH.waveClearArmor} 护甲`);
  }

  _onVictory() {
    if (this.state !== 'playing') return;
    this._endMatch(true);
  }

  /** 结束一局：true 胜利 / false 阵亡 */
  _endMatch(win) {
    this.stats.endedAt = performance.now();
    this.state = 'result';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.hud.setVisible(false);
    const result = this._buildResult(win);
    // 局外存档：累计战绩（关卡编号在 P2 接入多关卡后再改）
    this.save.recordRun({
      kills: result.kills,
      seconds: result.seconds,
      level: 1,
      wave: result.wavesCleared,
      win,
    });
    this._refreshLobby();
    this.menu.showResult(result);
  }

  /** 汇总本局数据：命中率 / 用时 / 得分 / 评级 */
  _buildResult(win) {
    const s = this.stats;
    const seconds = Math.max(1, (s.endedAt - s.startedAt) / 1000);
    const accuracy = computeAccuracy(s.shots, s.hits);
    const score = computeScore(s, seconds);
    return {
      win,
      score,
      grade: pickGrade(score, MATCH.grades),
      kills: s.kills,
      headshots: s.headshots,
      accuracy,
      seconds,
      damageTaken: Math.round(s.damageTaken),
      wavesCleared: s.wavesCleared,
      waveTotal: MATCH.waves.length,
      totalEnemies: MATCH.waves.reduce((n, w) => n + w.total, 0),
    };
  }

  /** 屏幕中央的波次横幅（自动淡出） */
  _showBanner(title, sub) {
    const el = this.waveBannerEl;
    if (!el) return;
    el.querySelector('[data-role="title"]').textContent = title;
    el.querySelector('[data-role="sub"]').textContent = sub || '';
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------------- 公网部署：环境检测 ----------------
  /** 检测 WebGL 支持；不支持时给出友好提示并阻止继续初始化 */
  _checkWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const ok = !!(window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')));
      if (ok) return true;
    } catch (e) { /* ignore */ }
    const text = document.getElementById('loading-text');
    if (text) {
      text.textContent = '当前浏览器不支持 WebGL，无法运行本游戏';
      text.style.color = '#ff5a2d';
    }
    const hint = document.querySelector('.loading-hint');
    if (hint) hint.innerHTML = '请使用最新版 Chrome / Edge / QQ / 360 浏览器，并开启硬件加速后重试。';
    return false;
  }

  /** 检测访问协议：非 HTTPS（且非 localhost）时，提示鼠标锁定可能被浏览器禁用 */
  _checkProtocol() {
    const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
    if (location.protocol === 'http:' && !isLocal) {
      const banner = document.createElement('div');
      banner.id = 'http-warning';
      banner.textContent = '当前为 HTTP 访问，浏览器限制鼠标锁定功能，推荐使用 HTTPS 链接打开游戏';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
        'background:rgba(180,40,20,0.92)', 'color:#fff', 'font:13px/1.6 sans-serif',
        'padding:8px 16px', 'text-align:center', 'box-shadow:0 2px 10px rgba(0,0,0,0.4)',
      ].join(';');
      document.body.appendChild(banner);
    }
  }

  // ---------------- 主循环 ----------------
  _loop() {
    const dt = Math.min(0.05, this.clock.getDelta());
    // 第三轮：FPS 统计（每 0.5 秒刷新一次显示）
    this._fpsFrames += 1;
    this._fpsAcc += dt;
    if (this._fpsAcc >= 0.5) {
      if (this.fpsValue && this._fpsVisible) {
        this.fpsValue.textContent = Math.round(this._fpsFrames / this._fpsAcc);
      }
      this._fpsFrames = 0;
      this._fpsAcc = 0;
    }
    this._update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  _update(dt) {
    // 第三轮：O 键随时切换 FPS 面板（暂停/死亡时也可用）
    if (this.input.consume('KeyO')) this._toggleFps();

    // 输入（键盘边沿事件在暂停/死亡时仍然有效）
    if (this.state === 'playing') {
      // 鼠标视角
      const delta = this.input.consumeMouseDelta();
      this.mouseLook.onMouseMove(delta.x, delta.y);

      // R：换弹
      if (this.input.consume('KeyR')) this.gun.startReload();

      // 1/2/3/4：切枪；滚轮：循环切枪
      if (this.input.consume('Digit1')) this.gun.switchWeapon('rifle');
      if (this.input.consume('Digit2')) this.gun.switchWeapon('pistol');
      if (this.input.consume('Digit3')) this.gun.switchWeapon('shotgun');
      if (this.input.consume('Digit4')) this.gun.switchWeapon('sniper');
      const wheel = this.input.consumeWheel();
      if (Math.abs(wheel) > 30) this.gun.switchWeaponByDelta(wheel);

      // 玩家 + 枪械
      this.player.update(dt, this.mouseLook);
      this.gun.setMouseDown(this.input.mouseDown);
      this.gun.setFirePressed(this.input.consume('Mouse0'));
      this.gun.update(dt, delta, true);

      // 调试模式快捷键：F 开枪 / G 自伤（用于自动化测试，普通模式无效）
      if (this.debugEl) {
        if (this.input.consume('KeyF')) this.gun.debugFire();
        if (this.input.consume('KeyG')) {
          this.player.takeDamage(35);
          this.hud.showDamage();
        }
      }

      // 敌人
      this.enemies.update(dt);

      // 补给点（靠近自动拾取 / 冷却刷新）
      this.supplies.update(dt);

      // 特效与弹壳
      this.effects.update(dt);
      this.casings.update(dt);

      // HUD 数值
      this.hud.setHealth(this.player.health.health);
      this.hud.setArmor(this.player.health.armor);
      this.hud.setEnemies(this.enemies.waveRemaining);

      // 死亡判定
      if (this.player.dead) this._endMatch(false);
    } else if (this.state === 'result') {
      // 结算界面保留场景渲染（轻微演出），但不再推进战斗
      this.effects.update(dt);
      this.casings.update(dt);
      this.mouseLook.update(0);
    } else if (this.state === 'paused') {
      this.input.consume('KeyR');
      this.mouseLook.update(0);
    }

    // 确保每帧结束清理边沿输入
    this.input.endFrame();

    // 调试面板刷新
    if (this.debugEl) {
      this._debugTimer = (this._debugTimer || 0) + dt;
      if (this._debugTimer > 0.15) {
        this._debugTimer = 0;
        const anims = Object.entries(this.assets.anims)
          .map(([k, v]) => k + (v ? '+' : '-')).join(' ');
        this.debugEl.textContent =
          `state=${this.state} locked=${this.input.locked} mouseDown=${this.input.mouseDown}\n` +
          `weapon=${this.assets.weaponModel ? 'ok' : 'MISSING'} mag=${this.gun.mag}/${this.gun.reserve} reload=${this.gun.reloading}\n` +
          `player=${this.player.position.x.toFixed(1)},${this.player.position.y.toFixed(1)},${this.player.position.z.toFixed(1)} ` +
          `grounded=${this.player.grounded} hp=${Math.round(this.player.health.health)}\n` +
          `wave=${this.enemies.waveIndex + 1}/${this.enemies.waveCount} state=${this.enemies.waveState} ` +
          `alive=${this.enemies.aliveCount} left=${this.enemies.waveRemaining} kills=${this.enemies.kills} anims=${anims}\n` +
          `spread=${this.gun.spread.toFixed(3)}` +
          (this.weaponView.modelSize
            ? `\nviewSize=${this.weaponView.modelSize.x.toFixed(2)},${this.weaponView.modelSize.y.toFixed(2)},${this.weaponView.modelSize.z.toFixed(2)} meshes=${(this.weaponView.meshNames || []).join(',')}`
            : '');
      }
    }
  }
}
