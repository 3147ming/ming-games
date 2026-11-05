/**
 * 资源管理器
 * 统一加载仓库中复用的 FBX 模型 / 贴图，并提供加载进度。
 * 使用 THREE.LoadingManager 重定向 FBX 内部引用的贴图路径，
 * 避免浏览器去请求 Unity 工程里的绝对路径（会 404）。
 */
import * as THREE from 'three';
import { FBXLoader } from '../../vendor/three/loaders/FBXLoader.js';
import { TGALoader } from '../../vendor/three/loaders/TGALoader.js';

const TEX_DIR = './public/assets/textures/';
const MODEL_DIR = './public/assets/models/';

// 1x1 透明占位贴图（用于屏蔽 FBX 中不需要的法线/高光贴图请求）
const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class AssetManager {
  constructor() {
    this.manager = new THREE.LoadingManager();
    this.fbx = new FBXLoader(this.manager);
    this.tex = new THREE.TextureLoader(this.manager);
    this.tga = new TGALoader(this.manager);
    this.assets = {};

    // 贴图路径重定向：FBX 内部写的是 Unity 工程的绝对/相对路径
    this.manager.setURLModifier((url) => {
      if (url.startsWith('data:')) return url;
      const name = url.split(/[\\/]/).pop().toLowerCase();
      // 仅对贴图扩展名做重定向，避免误伤 zombie.fbx 等同名模型
      const isTex = /\.(jpg|jpeg|png|tga|bmp|dds|psd|webp)$/.test(name);

      // ⚠ 项目自身的 WebP 贴图必须原样放行。
      // 早期版本漏了这一步，导致 _tex() 显式请求的 ak74/arm 贴图被下面
      // 的 "其余贴图一律返回占位图" 分支替换成 1×1 透明 PNG，
      // 武器最终渲染成一块没有纹理的纯色模型。
      if (isTex && /\.webp$/.test(name)) return url;

      // 项目自身提供的贴图已压缩为 WebP，统一重定向到 textures 目录
      if (isTex && (name === 'ak74_color.jpg' || name.startsWith('ak74color'))) return TEX_DIR + 'ak74_color.webp';
      if (isTex && (name === 'arm_color.jpg' || name.startsWith('armcolor'))) return TEX_DIR + 'arm_color.webp';
      if (isTex && (name === 'zombie.tga' || name.startsWith('zombie'))) return TEX_DIR + 'zombie.webp';
      // 其余 FBX 引用的法线/金属度/UV 等贴图网页版不需要，返回占位图避免 404
      if (isTex) return PLACEHOLDER;
      return url;
    });
  }

  _tex(path, isTga = false) {
    return new Promise((resolve, reject) => {
      const loader = isTga ? this.tga : this.tex;
      loader.load(path, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve(t);
      }, undefined, reject);
    });
  }

  _fbx(path) {
    return new Promise((resolve, reject) => {
      this.fbx.load(path, resolve, undefined, reject);
    });
  }

  /** 第一人称武器：优先使用带手臂的 AK 模型，解析失败时回退到 Unity 示例武器 */
  async _loadWeapon() {
    try {
      return await this._fbx(MODEL_DIR + 'weapon_arms.fbx');
    } catch (err) {
      console.warn('[AssetManager] 手臂武器模型解析失败，回退到备用武器模型:', err);
      return await this._fbx(MODEL_DIR + 'fps_weapon.fbx');
    }
  }

  /**
   * 加载全部资源
   * @param {(percent:number)=>void} onProgress
   */
  async loadAll(onProgress) {
    const tasks = [
      ['weaponModel', () => this._loadWeapon()],
      ['zombieModel', () => this._fbx(MODEL_DIR + 'zombie.fbx')],
      ['animIdle', () => this._fbx(MODEL_DIR + 'anim/z_idle.fbx')],
      ['animWalk', () => this._fbx(MODEL_DIR + 'anim/z_walk.fbx')],
      ['animRun', () => this._fbx(MODEL_DIR + 'anim/z_run.fbx')],
      ['animAttack', () => this._fbx(MODEL_DIR + 'anim/z_attack.fbx')],
      ['animDeath', () => this._fbx(MODEL_DIR + 'anim/z_death.fbx')],
      ['box1', () => this._fbx(MODEL_DIR + 'box_1.fbx')],
      ['box2', () => this._fbx(MODEL_DIR + 'box_2.fbx')],
      ['box3', () => this._fbx(MODEL_DIR + 'box_3.fbx')],
      ['box4', () => this._fbx(MODEL_DIR + 'box_4.fbx')],
      ['ak74Color', () => this._tex(TEX_DIR + 'ak74_color.webp')],
      ['armColor', () => this._tex(TEX_DIR + 'arm_color.webp')],
      ['zombieColor', () => this._tex(TEX_DIR + 'zombie.webp')],
    ];

    let done = 0;
    const total = tasks.length;
    const results = {};

    // 顺序加载：避免单线程静态服务器/浏览器连接数限制导致请求被中断
    for (const [key, fn] of tasks) {
      try {
        results[key] = await fn();
      } catch (err) {
        console.error('[AssetManager] 资源加载失败:', key, err);
        results[key] = null;
      }
      done += 1;
      if (onProgress) onProgress(Math.round((done / total) * 100));
    }

    this.assets = {
      weaponModel: results.weaponModel,
      zombieModel: results.zombieModel,
      anims: {
        idle: pickClip(results.animIdle),
        walk: pickClip(results.animWalk),
        run: pickClip(results.animRun),
        attack: pickClip(results.animAttack),
        death: pickClip(results.animDeath),
      },
      boxes: [results.box1, results.box2, results.box3, results.box4].filter(Boolean),
      textures: {
        ak74: results.ak74Color,
        arm: results.armColor,
        zombie: results.zombieColor,
      },
    };
    return this.assets;
  }
}

/** 从 FBX 结果中取出第一条动画 */
function pickClip(fbx) {
  if (!fbx || !fbx.animations || fbx.animations.length === 0) return null;
  return fbx.animations[0];
}
