/**
 * 敌人管理器：波次调度、生成、更新、命中检测。
 *
 * 玩法闭环（v0.2 重写）：
 *   一局 = MATCH.waves 三波敌人 → 全部肃清即胜利。
 *   每波有 total（总人数）与 alive（同时存活上限）：
 *   场上人数低于上限时从出生点补位刷新，直到本波总人数刷完；
 *   本波全部击杀且场上无存活 → 进入 breakTime 休整（补弹补甲）→ 下一波。
 *
 *   旧版本是「死了 3~6 秒原地复活、无限循环」，任务简报写着"清理全部目标"
 *   却永远清不完，HUD 的敌人数也始终是 4 —— 这是个玩法闭环缺陷，已修。
 */
import * as THREE from 'three';
import { ENEMY, MATCH } from '../config/weapon.js';
import { EnemyAI } from './EnemyAI.js';

const STATE = {
  IDLE: 'idle',
  ACTIVE: 'active',
  BREAK: 'break',
  DONE: 'done',
};

export class EnemyManager {
  constructor(opts) {
    this.scene = opts.scene;
    this.assets = opts.assets;
    this.collision = opts.collision;
    this.audio = opts.audio;
    this.player = opts.player;
    this.effects = opts.effects;
    this.hud = opts.hud;
    this.onKill = opts.onKill || (() => {});
    this.onWaveStart = opts.onWaveStart || (() => {});
    this.onWaveClear = opts.onWaveClear || (() => {});
    this.onVictory = opts.onVictory || (() => {});
    this.onPlayerHit = opts.onPlayerHit || (() => {});

    // 敌人实例池：数量取所有波次的并发上限
    const poolSize = Math.max(...MATCH.waves.map((w) => w.alive));
    this.enemies = [];
    for (let i = 0; i < poolSize; i++) {
      const enemy = new EnemyAI({
        scene: this.scene,
        assets: this.assets,
        collision: this.collision,
        audio: this.audio,
        player: this.player,
        spawn: new THREE.Vector3(0, 0, 0),
        index: i,
        onDeath: (e) => this._handleDeath(e),
        onShoot: (from, to, e) => this._handleEnemyShoot(from, to, e),
        onPlayerHit: (dmg) => this._handlePlayerHit(dmg),
      });
      enemy.root.visible = false;
      enemy.dead = true;
      this.enemies.push(enemy);
    }

    this.kills = 0;
    this.headshotKills = 0;
    this.waveIndex = -1;
    this.waveState = STATE.IDLE;
    this.waveTotal = 0;
    this.waveSpawned = 0;
    this.waveKilled = 0;
    this.waveCfg = null;
    this.breakTimer = 0;
    this.spawnTimer = 0;
    this._lastSpawnPoint = null;
  }

  // ---------------- 波次调度 ----------------
  /** 开始新的一局（重置全部波次状态） */
  startMatch() {
    this.kills = 0;
    this.headshotKills = 0;
    this.waveIndex = -1;
    this.waveState = STATE.IDLE;
    for (const e of this.enemies) {
      e.dead = true;
      e.root.visible = false;
      e.state = 'idle';
      e.health = ENEMY.maxHealth;
    }
    this._beginWave(0);
  }

  _beginWave(index) {
    this.waveIndex = index;
    this.waveCfg = MATCH.waves[index];
    this.waveTotal = this.waveCfg.total;
    this.waveSpawned = 0;
    this.waveKilled = 0;
    this.waveState = STATE.ACTIVE;
    this.spawnTimer = 0.4;   // 开局稍作停顿，别一进场就贴脸
    this.onWaveStart(index, this.waveTotal, MATCH.waves.length);
  }

  /** 本波是否已经打完（总人数刷完且全部死亡） */
  _isWaveCleared() {
    return this.waveKilled >= this.waveTotal && this.aliveCount === 0;
  }

  _clearWave() {
    const isLast = this.waveIndex >= MATCH.waves.length - 1;
    this.onWaveClear(this.waveIndex, isLast);
    if (isLast) {
      this.waveState = STATE.DONE;
      this.onVictory();
      return;
    }
    this.waveState = STATE.BREAK;
    this.breakTimer = MATCH.breakTime;
  }

  update(dt) {
    // 敌人自身逻辑始终更新（尸体淡出、受击闪红等都靠它）
    for (const e of this.enemies) e.update(dt);

    if (this.waveState === STATE.ACTIVE) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 &&
          this.waveSpawned < this.waveTotal &&
          this.aliveCount < this.waveCfg.alive) {
        this._spawnOne();
        this.spawnTimer = MATCH.spawnGap;
      }
      if (this._isWaveCleared()) this._clearWave();
    } else if (this.waveState === STATE.BREAK) {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) this._beginWave(this.waveIndex + 1);
    }
  }

  /** 取一个死掉的实例，配置好波次倍率后投放到合适出生点 */
  _spawnOne() {
    const enemy = this.enemies.find((e) => e.dead);
    if (!enemy) return;
    const point = this._pickSpawnPoint();
    enemy.configure({
      healthMul: this.waveCfg.healthMul,
      damageMul: this.waveCfg.damageMul,
      accuracyMul: this.waveCfg.accuracyMul,
      speedMul: this.waveCfg.speedMul,
    });
    enemy.respawn(point);
    this.waveSpawned += 1;
    this._lastSpawnPoint = point;
  }

  /**
   * 选择出生点：优先「离玩家够远 且 不在玩家视野正面」的点。
   * 这样敌人不会凭空出现在瞄准镜里，也不会贴脸复活。
   */
  _pickSpawnPoint() {
    const p = this.player;
    if (!p) return this._toVec(ENEMY.spawnPoints[0]);
    const candidates = ENEMY.spawnPoints.map((sp) => {
      const d = Math.hypot(sp.x - p.position.x, sp.z - p.position.z);
      return { sp, d };
    });

    const yaw = p.camera ? p.camera.rotation.y : 0;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const visible = (sp) => {
      const dx = sp.x - p.position.x;
      const dz = sp.z - p.position.z;
      const len = Math.hypot(dx, dz) || 1;
      return (dx / len) * fwdX + (dz / len) * fwdZ > 0.35;   // 在正前方 ±70° 内
    };

    // 1) 远且不在视野里  2) 只要够远  3) 退而求其次取最远的
    let pool = candidates.filter((c) => c.d >= MATCH.minSpawnDist && !visible(c.sp));
    if (pool.length === 0) pool = candidates.filter((c) => c.d >= MATCH.fallbackSpawnDist);
    if (pool.length === 0) pool = candidates.slice().sort((a, b) => b.d - a.d).slice(0, 2);

    // 避免连续两次刷在同一点
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && this._lastSpawnPoint) {
      const same = pick.sp.x === this._lastSpawnPoint.x && pick.sp.z === this._lastSpawnPoint.z;
      if (same) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    }
    return this._toVec(pick.sp);
  }

  _toVec(sp) {
    return new THREE.Vector3(sp.x, 0, sp.z);
  }

  // ---------------- 事件回调 ----------------
  _handleDeath(enemy) {
    this.kills += 1;
    this.waveKilled += 1;
    this.hud.setKills(this.kills);
    if (this.audio) this.audio.play('kill', { volume: 0.7, rate: 1.0 });
    this.onKill(enemy);
  }

  _handleEnemyShoot(from, to, enemy) {
    if (!this.effects) return;
    this.effects.spawnTracer(from, to);
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(enemy.position) : 30;
      this.audio.play('fire2', { volume: this.audio.distanceVolume(dist), rate: 0.85 });
    }
  }

  _handlePlayerHit(dmg) {
    if (this.audio) this.audio.play('hurt', { volume: 0.55, rate: 1.0 });
    if (this.hud) {
      this.hud.showDamage(dmg);
      this.hud.setDamageAmount(dmg);
    }
    this.onPlayerHit(dmg);
  }

  // ---------------- 查询 ----------------
  /** 场上存活数 */
  get aliveCount() {
    return this.enemies.filter((e) => !e.dead && e.root.visible).length;
  }

  /** 本波还没解决掉的总数（含未出场） */
  get waveRemaining() {
    if (this.waveState !== STATE.ACTIVE) return 0;
    return Math.max(0, this.waveTotal - this.waveKilled);
  }

  get waveCount() {
    return MATCH.waves.length;
  }

  get isDone() {
    return this.waveState === STATE.DONE;
  }

  /** 玩家射击的命中检测（返回最近敌人） */
  raycast(origin, dir, maxDist) {
    let best = null;
    for (const e of this.enemies) {
      const hit = e.raycast(origin, dir, maxDist);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }

  /** 重开：清场并重新开始第一波 */
  resetAll() {
    this.startMatch();
  }
}
