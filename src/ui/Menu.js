/**
 * 菜单 / 加载 / 暂停 / 结算界面控制
 * 只做 DOM 显隐与数值填充，不含任何游戏逻辑。
 */
export class Menu {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.loading = document.getElementById('loading');
    this.loadingFill = document.getElementById('loading-fill');
    this.loadingText = document.getElementById('loading-text');
    this.menu = document.getElementById('menu');
    this.pause = document.getElementById('pause');
    this.result = document.getElementById('result');

    // 结算面板字段
    this.resultKicker = document.getElementById('result-kicker');
    this.resultTitle = document.getElementById('result-title');
    this.resultGrade = document.getElementById('result-grade');
    this.resultScore = document.getElementById('result-score');
    this.rs = {
      kills: document.getElementById('rs-kills'),
      heads: document.getElementById('rs-heads'),
      acc: document.getElementById('rs-acc'),
      time: document.getElementById('rs-time'),
      dmg: document.getElementById('rs-dmg'),
      wave: document.getElementById('rs-wave'),
    };

    document.getElementById('btn-start').addEventListener('click', () => {
      this.callbacks.onStart && this.callbacks.onStart();
    });
    document.getElementById('btn-resume').addEventListener('click', () => {
      this.callbacks.onResume && this.callbacks.onResume();
    });
    const btnRestart = document.getElementById('btn-restart');
    if (btnRestart) {
      btnRestart.addEventListener('click', () => {
        this.callbacks.onRestart && this.callbacks.onRestart();
      });
    }
    const btnAgain = document.getElementById('btn-again');
    if (btnAgain) {
      btnAgain.addEventListener('click', () => {
        this.callbacks.onRestart && this.callbacks.onRestart();
      });
    }
    const btnMenu = document.getElementById('btn-menu');
    if (btnMenu) {
      btnMenu.addEventListener('click', () => {
        this.callbacks.onMenu && this.callbacks.onMenu();
      });
    }
  }

  setLoading(percent, text) {
    this.loadingFill.style.width = percent + '%';
    this.loadingText.textContent = text || `正在加载资源 ${percent}%`;
  }

  hideLoading() {
    this.loading.classList.add('hidden');
  }

  showStart() {
    this.hideLoading();
    this.menu.classList.remove('hidden');
    this.pause.classList.add('hidden');
    if (this.result) this.result.classList.add('hidden');
  }

  showPause() {
    this.menu.classList.add('hidden');
    this.pause.classList.remove('hidden');
    if (this.result) this.result.classList.add('hidden');
  }

  /**
   * 结算面板
   * @param {{win:boolean, score:number, grade:string, kills:number, headshots:number,
   *          accuracy:number, seconds:number, damageTaken:number,
   *          wavesCleared:number, waveTotal:number, totalEnemies:number}} r
   */
  showResult(r) {
    if (!this.result) return;
    this.result.classList.toggle('win', !!r.win);
    this.result.classList.toggle('lose', !r.win);
    this.resultKicker.textContent = r.win ? 'MISSION COMPLETE' : 'MISSION FAILED';
    this.resultTitle.textContent = r.win ? '区域肃清' : '行动阵亡';
    this.resultGrade.textContent = r.grade;
    this.resultGrade.dataset.grade = r.grade;
    this.resultScore.textContent = String(r.score);

    if (this.rs.kills) this.rs.kills.textContent = String(r.kills);
    if (this.rs.heads) this.rs.heads.textContent = String(r.headshots);
    if (this.rs.acc) this.rs.acc.textContent = Math.round(r.accuracy * 100) + '%';
    if (this.rs.time) {
      const m = Math.floor(r.seconds / 60);
      const s = Math.floor(r.seconds % 60);
      this.rs.time.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
    if (this.rs.dmg) this.rs.dmg.textContent = String(r.damageTaken);
    if (this.rs.wave) {
      this.rs.wave.textContent = `${r.wavesCleared}/${r.waveTotal}`;
    }

    // 标题下方的小字：胜利说明战果，失败说明差多少
    this.resultKicker.title = r.win
      ? `共歼灭 ${r.totalEnemies} 名敌人`
      : `已肃清 ${r.wavesCleared}/${r.waveTotal} 波`;

    this.menu.classList.add('hidden');
    this.pause.classList.add('hidden');
    this.result.classList.remove('hidden');
  }

  hideAll() {
    this.menu.classList.add('hidden');
    this.pause.classList.add('hidden');
    if (this.result) this.result.classList.add('hidden');
  }

  get resultVisible() {
    return !!this.result && !this.result.classList.contains('hidden');
  }

  get pauseVisible() {
    return !this.pause.classList.contains('hidden');
  }
}
