/**
 * 待机大厅面板（P0 骨架）
 * 只负责大厅内部的标签页切换与数值展示，不含游戏逻辑。
 * 后续 P3/P4/P5 会把机甲、天赋、商店的真实交互接到这里。
 */
export class LobbyUI {
  constructor() {
    this.root = document.getElementById('menu');
    this.nav = document.getElementById('lobby-nav');
    this.pages = {
      battle: document.getElementById('tab-battle'),
      mech: document.getElementById('tab-mech'),
      talent: document.getElementById('tab-talent'),
      stats: document.getElementById('tab-stats'),
    };

    this.cores = document.getElementById('lobby-cores');
    this.coins = document.getElementById('lobby-coins');
    this.stats = {
      runs: document.getElementById('st-runs'),
      kills: document.getElementById('st-kills'),
      level: document.getElementById('st-level'),
      wave: document.getElementById('st-wave'),
    };

    this.activeTab = 'battle';
    this._bindNav();
  }

  _bindNav() {
    if (!this.nav) return;
    this.nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      this.showTab(btn.dataset.tab);
    });
  }

  /** 切换到指定标签页（battle / mech / talent / stats） */
  showTab(name) {
    if (!this.pages[name]) return;
    this.activeTab = name;
    for (const [key, page] of Object.entries(this.pages)) {
      if (page) page.classList.toggle('active', key === name);
    }
    if (this.nav) {
      for (const btn of this.nav.querySelectorAll('.nav-item')) {
        btn.classList.toggle('active', btn.dataset.tab === name);
      }
    }
  }

  /** 每次打开大厅时回到作战页 */
  resetTab() {
    this.showTab('battle');
  }

  /** 顶部资源显示（P5 经济系统接入后由存档驱动） */
  setResources(cores, coins) {
    if (this.cores) this.cores.textContent = String(cores);
    if (this.coins) this.coins.textContent = String(coins);
  }

  /** 战绩页数值（P0 先显示占位，P5 接存档） */
  setStats({ runs = 0, kills = 0, level = 1, wave = 0 } = {}) {
    if (this.stats.runs) this.stats.runs.textContent = String(runs);
    if (this.stats.kills) this.stats.kills.textContent = String(kills);
    if (this.stats.level) this.stats.level.textContent = String(level);
    if (this.stats.wave) this.stats.wave.textContent = String(wave);
  }
}
