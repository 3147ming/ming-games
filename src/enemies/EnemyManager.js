/**
 * 敌人管理器：批量生成、更新、命中检测、死亡后重新投放
 */
import * as THREE from 'three';
import { ENEMY } from '../config/weapon.js';
import { EnemyAI } from './EnemyAI.js';

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
    this.enemies = [];
    this.respawnTimers = [];
    this.kills = 0;
  }

  /** 生成初始敌人 */
  spawnAll() {
    for (let i = 0; i < ENEMY.count; i++) {
      const p = ENEMY.spawnPoints[i % ENEMY.spawnPoints.length];
      const spawn = new THREE.Vector3(p.x, 0, p.z);
      const enemy = new EnemyAI({
        scene: this.scene,
        assets: this.assets,
        collision: this.collision,
        audio: this.audio,
        player: this.player,
        spawn,
        index: i,
        onDeath: (e) => this._handleDeath(e),
        onShoot: (from, to, e) => this._handleEnemyShoot(from, to, e),
        onPlayerHit: (dmg) => this._handlePlayerHit(dmg),
      });
      this.enemies.push(enemy);
      this.respawnTimers.push(0);
    }
  }

  update(dt) {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      e.update(dt);

      // 死亡后随机 2~5 秒在出生点重新投放（第三轮：随机刷新）
      if (e.dead) {
        this.respawnTimers[i] -= dt;
        if (this.respawnTimers[i] <= 0) {
          const spawn = this._pickSpawn();
          e.respawn(spawn);
          this.respawnTimers[i] = 0;
        }
      }
    }
  }

  _handleDeath(enemy) {
    const i = this.enemies.indexOf(enemy);
    // 第三轮：死亡后随机刷新时间（2.5~5 秒）
    if (i >= 0) {
      this.respawnTimers[i] = ENEMY.respawnMin +
        Math.random() * (ENEMY.respawnMax - ENEMY.respawnMin);
    }
    this.kills += 1;
    this.hud.setKills(this.kills);
    // 第三轮：击杀独立音效
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
    // 第三轮：受伤独立音效 + 红边强度随伤害变化
    if (this.audio) this.audio.play('hurt', { volume: 0.55, rate: 1.0 });
    if (this.hud) {
      this.hud.showDamage(dmg);
      this.hud.setDamageAmount(dmg);
    }
  }

  /** 选择离玩家最远的出生点 */
  _pickSpawn() {
    let best = ENEMY.spawnPoints[0];
    let bestDist = -1;
    for (const p of ENEMY.spawnPoints) {
      const d = this.player
        ? Math.hypot(p.x - this.player.position.x, p.z - this.player.position.z)
        : 0;
      if (d > bestDist) { bestDist = d; best = p; }
    }
    return new THREE.Vector3(best.x, 0, best.z);
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

  /** 存活数量（用于 HUD） */
  get aliveCount() {
    return this.enemies.filter((e) => !e.dead).length;
  }

  /** 复活时重置所有敌人（可选：清理战场） */
  resetAll() {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) e.respawn(this._pickSpawn());
      this.respawnTimers[i] = 0;
    }
  }
}
