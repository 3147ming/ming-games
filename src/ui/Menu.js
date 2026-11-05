/**
 * 菜单 / 加载界面控制
 */
export class Menu {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.loading = document.getElementById('loading');
    this.loadingFill = document.getElementById('loading-fill');
    this.loadingText = document.getElementById('loading-text');
    this.menu = document.getElementById('menu');
    this.pause = document.getElementById('pause');
    this.death = document.getElementById('death');
    this.deathKills = document.getElementById('death-kills');

    document.getElementById('btn-start').addEventListener('click', () => {
      this.callbacks.onStart && this.callbacks.onStart();
    });
    document.getElementById('btn-resume').addEventListener('click', () => {
      this.callbacks.onResume && this.callbacks.onResume();
    });
    document.getElementById('btn-respawn').addEventListener('click', () => {
      this.callbacks.onRespawn && this.callbacks.onRespawn();
    });
    const btnRestart = document.getElementById('btn-restart');
    if (btnRestart) {
      btnRestart.addEventListener('click', () => {
        this.callbacks.onRestart && this.callbacks.onRestart();
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
    this.death.classList.add('hidden');
  }

  showPause() {
    this.menu.classList.add('hidden');
    this.pause.classList.remove('hidden');
    this.death.classList.add('hidden');
  }

  showDeath(kills) {
    this.deathKills.textContent = kills;
    this.menu.classList.add('hidden');
    this.pause.classList.add('hidden');
    this.death.classList.remove('hidden');
  }

  hideAll() {
    this.menu.classList.add('hidden');
    this.pause.classList.add('hidden');
    this.death.classList.add('hidden');
  }

  get deathVisible() {
    return !this.death.classList.contains('hidden');
  }

  get pauseVisible() {
    return !this.pause.classList.contains('hidden');
  }
}
