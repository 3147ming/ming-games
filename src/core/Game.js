/**
 * 游戏主控制器：渲染循环、状态机、模块装配
 * 状态：loading → menu → playing ⇄ paused / dead
 */
import * as THREE from 'three';
import { WORLD } from '../config/weapon.js';
import { Input } from './Input.js';
import { AssetManager } from './AssetManager.js';
import { AudioManager } from './AudioManager.js';
import { CollisionWorld } from './CollisionWorld.js';
import { WarehouseMap } from '../world/WarehouseMap.js';
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
    this.renderer.toneMappingExposure = 1.18;
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
      onRespawn: () => this.respawn(),
      onRestart: () => this.restart(),
    });

    this.assets = await new AssetManager().loadAll((p) => this.menu.setLoading(p));

    this.menu.setLoading(100, '正在初始化音频…');
    this.audio = new AudioManager();
    await this.audio.init();

    // ---- 世界与玩家 ----
    this.collision = new CollisionWorld();
    this.map = new WarehouseMap(this.scene, this.collision, this.assets).build();

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
      onKill: () => {},
    });
    this.enemies.spawnAll();

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
    });

    // 初始数值同步
    this.hud.reset();
    this.hud.setKills(0);
    this.hud.setEnemies(this.enemies.aliveCount);

    // 第三轮：开局操作提示（3 秒后自动淡出）+ FPS 面板
    this.tipsEl = document.getElementById('tips');
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
    this.hud.setVisible(true);
    this.hud.reset();
    this.hud.setKills(0);
    this.menu.hideAll();
    this.input.enabled = true;
    this.mouseLook.reset();
    this.input.consumeMouseDelta();
    this.input.requestLock();
    this.gun.resetAmmo();
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

  handleDeath() {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.input.enabled = false;
    this.input.releaseLock();
    this.gun.setMouseDown(false);
    this.menu.showDeath(this.enemies.kills);
    this.hud.setVisible(false);
  }

  respawn() {
    if (this.state !== 'dead') return;
    this.player.respawn(this.map.playerSpawn);
    this.mouseLook.reset();
    this.gun.resetAmmo();
    this.hud.reset();
    this.hud.setVisible(true);
    this.menu.hideAll();
    this.state = 'playing';
    this.input.enabled = true;
    this.audio.resume();
    this.input.requestLock();
  }

  /** 暂停面板"重新开始"：重置敌人/玩家/弹药/击杀数并直接进入游戏 */
  restart() {
    this.player.respawn(this.map.playerSpawn);
    this.player.health.reset();
    this.mouseLook.reset();
    this.gun.resetAmmo();
    if (this.enemies && this.enemies.resetAll) this.enemies.resetAll();
    this.enemies.kills = 0;
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

      // 特效与弹壳
      this.effects.update(dt);
      this.casings.update(dt);

      // HUD 数值
      this.hud.setHealth(this.player.health.health);
      this.hud.setArmor(this.player.health.armor);
      this.hud.setEnemies(this.enemies.aliveCount);

      // 死亡判定
      if (this.player.dead) this.handleDeath();
    } else if (this.state === 'dead') {
      // 死亡后仍保留敌人与特效更新
      this.enemies.update(dt);
      this.effects.update(dt);
      this.casings.update(dt);
      this.player.update(dt, this.mouseLook);
      this.mouseLook.update(dt);

      // R 复活
      if (this.input.consume('KeyR')) this.respawn();
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
          `enemies=${this.enemies.aliveCount} kills=${this.enemies.kills} anims=${anims}\n` +
          `spread=${this.gun.spread.toFixed(3)}` +
          (this.weaponView.modelSize
            ? `\nviewSize=${this.weaponView.modelSize.x.toFixed(2)},${this.weaponView.modelSize.y.toFixed(2)},${this.weaponView.modelSize.z.toFixed(2)} meshes=${(this.weaponView.meshNames || []).join(',')}`
            : '');
      }
    }
  }
}
