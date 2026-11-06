/**
 * 音频设置 UI（主音量滑杆 + 百分比 + 静音按钮）
 * ---------------------------------------------------------------------------
 * 为什么单独一个模块，而不是塞进 main.js：
 *   它只做"DOM ↔ AudioManager"的翻译，不含任何声音逻辑。audio.js 那边暴露
 *   setVolume/getVolume/getGain/subscribe，这里只负责把值画出来、把拖动写回去。
 *   main.js 因此只多一行 `new AudioUi(audio)`，战斗主循环完全不用知道滑杆存在。
 *
 * 关键行为：
 *   - 滑杆监听 `input`（不是 `change`）：拖动过程中就实时改增益，松手才生效会显得"卡"。
 *   - 状态**单向**：UI 从不自己记 volume，只读 AudioManager 的快照；M 键静音后
 *     subscribe 回调会把按钮/百分比一起刷新，不会出现"键盘静音了、按钮还写着声音开"。
 *   - 静音时滑杆仍可拖：静音只是把最终增益乘 0，音量值原地保留；UI 用变暗 + 划掉音符
 *     表示"当前无声"，而不是把滑杆归零（归零会让玩家取消静音后丢失原音量）。
 */

import { fromPercent, toPercent } from '../audio/volume.js';

export class AudioUi {
  /**
   * @param {object} audio AudioManager（只需要 getVolume/isMuted/subscribe/setVolume/toggleMute）
   * @param {Document|HTMLElement} [root] 查找范围，默认 document；单测/嵌入时可注入
   */
  constructor(audio, root = typeof document !== 'undefined' ? document : null) {
    this.audio = audio;
    this.root = root ? root.getElementById?.('audio-ui') || root.querySelector?.('#audio-ui') : null;
    // 页面还没放这个控件（例如旧缓存里的 index.html）时安静退出：
    // 音频功能本身不依赖它，不能因为少一个 div 就让整个 main.js 抛错。
    if (!this.root) return;

    this.muteBtn = this.root.querySelector('#audio-mute');
    this.range = this.root.querySelector('#audio-vol');
    this.valueEl = this.root.querySelector('#audio-vol-val');
    this._unsub = null;

    // 先按当前设置渲染一次：刷新页面后滑杆要停在存档音量上，而不是 HTML 里的 100。
    this.render();

    if (this.muteBtn) {
      this.muteBtn.addEventListener('click', () => {
        // 只发意图，不改本地状态；AudioManager 才是唯一事实来源。
        this.audio.toggleMute();
      });
    }
    if (this.range) {
      // input：拖动中实时生效（change 要等松手，手感像坏了）
      this.range.addEventListener('input', () => {
        this.audio.setVolume(fromPercent(this.range.value));
      });
      // 键盘方向键调滑杆同样会触发 input，无需单独处理 keydown。
    }
    if (typeof audio.subscribe === 'function') {
      this._unsub = audio.subscribe((snapshot) => this.render(snapshot));
    }
  }

  /** 把 AudioManager 的当前值画到 DOM。允许传 subscribe 的快照，避免重复取值。 */
  render(snapshot = null) {
    if (!this.root) return;
    const volume = snapshot && Number.isFinite(snapshot.volume) ? snapshot.volume : this.audio.getVolume();
    const muted = snapshot && typeof snapshot.muted === 'boolean' ? snapshot.muted : this.audio.isMuted;
    const pct = toPercent(volume);

    if (this.range) {
      // 拖动中不要回写 value：浏览器在 input 事件里重设 value 会把滑块拽回去。
      // 只有外部变化（M 键 / 读档 / 程序设置）才同步，这里用"值不同才写"来区分。
      if (this.range.value !== String(pct)) this.range.value = String(pct);
      this.range.style.setProperty('--vol', `${pct}%`);
      this.range.setAttribute('aria-valuetext', `${pct}%`);
    }
    if (this.valueEl) this.valueEl.textContent = `${pct}%`;
    if (this.muteBtn) {
      this.muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
      const text = this.muteBtn.querySelector('.au-txt');
      if (text) text.textContent = muted ? '已静音' : '声音';
      this.muteBtn.title = muted ? '取消静音（M）' : '静音（M）';
    }
    // 只加一个 class，所有"静音可辨"的样式（红边 / 划掉音符 / 滑杆变暗）交给 CSS。
    this.root.classList.toggle('muted', !!muted);
  }

  /** 退订并摘事件（本页不用，留给将来热重载/单测，避免监听器泄漏）。 */
  destroy() {
    if (typeof this._unsub === 'function') this._unsub();
    this._unsub = null;
    this.root = null;
  }
}
