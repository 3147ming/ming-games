/**
 * 丧尸管理器：波次调度、生成、更新、命中检测（v0.3 丧尸改造）。
 *
 *   一局 = MATCH.waves 三波尸潮 → 全部肃清即胜利。
 *   每波有 total（总数）、alive（同时存活上限）、mix（变体配额）：
 *   场上人数低于上限时从出生点补位刷新（按 mix 抽变体），直到本波刷完；
 *   本波全部击杀且场上无存活 → breakTime 休整（补弹补甲）→ 下一波。
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
        onSpit: (from, to, e) => this._handleSpit(from, to, e),
        onMelee: (e) => this._handleMelee(e),
        onPlayerHit: (dmg) => this._handlePlayerHit(dmg),
        onExplode: (e) => this._handleExplode(e),
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
      e.health = e.maxHealth;
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
    this._buildVariantQueue();
    this.onWaveStart(index, this.waveTotal, MATCH.waves.length);
  }

  /**
   * 本波变体抽取队列：按 mix 配额铺开后打乱，
   * 补位刷新时依次 pop，保证变体构成稳定（不会全是同一种）。
   */
  _buildVariantQueue() {
    const mix = (this.waveCfg && this.waveCfg.mix) || { walker: this.waveCfg ? this.waveCfg.total : 1 };
    const queue = [];
    for (const [id, n] of Object.entries(mix)) {
      for (let i = 0; i < (n || 0); i++) queue.push(id);
    }
    while (queue.length < this.waveTotal) queue.push('walker');
    queue.length = this.waveTotal;
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    this.variantQueue = queue;
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
    const variant = (this.variantQueue && this.variantQueue.pop()) || 'walker';
    enemy.configure({
      variant,
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

  /** 吐酸丧尸喷吐：酸液弹道视觉（非枪械，复用曳光弹通道但换低沉音色） */
  _handleSpit(from, to, enemy) {
    if (this.effects) this.effects.spawnTracer(from, to);
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(enemy.position) : 30;
      this.audio.play('fire2', { volume: this.audio.distanceVolume(dist) * 0.8, rate: 0.55 });
    }
  }

  /** 普通丧尸近战挥击：只出音效提示，伤害在前摇结束后由 EnemyAI 判定 */
  _handleMelee(enemy) {
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(enemy.position) : 30;
      this.audio.play('fire2', { volume: this.audio.distanceVolume(dist) * 0.7, rate: 0.38 });
    }
  }

  _handleExplode(enemy) {
    // 爆炸视觉特效
    if (this.effects) {
      this.effects.spawnExplosion(enemy.position.clone(), enemy.variant.explodeRadius);
    }
    // 爆炸音效（用 fire2 低频代替爆炸声）
    if (this.audio) {
      const dist = this.player ? this.player.position.distanceTo(enemy.position) : 30;
      this.audio.play('fire2', { volume: this.audio.distanceVolume(dist) * 1.2, rate: 0.28 });
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

  /** 穿透射击：返回沿射线方向所有被命中的敌人（按距离排序） */
  raycastAll(origin, dir, maxDist) {
    const hits = [];
    for (const e of this.enemies) {
      const hit = e.raycast(origin, dir, maxDist);
      if (hit) hits.push(hit);
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /** 重开：清场并重新开始第一波 */
  resetAll() {
    this.startMatch();
  }
}
