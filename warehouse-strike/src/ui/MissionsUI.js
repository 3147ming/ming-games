/**
 * 任务 / 奖励面板（大厅）
 * 进度来自存档累计战绩，领取后发放金币 / 声望 / 核心 / 材料。
 */
import { MATERIALS } from '../config/progression.js';

const materialLabel = (key) => MATERIALS[key]?.name || key;

export class MissionsUI {
  /**
   * @param {{save:object, onChange?:Function}} opts
   */
  constructor({ save, onChange } = {}) {
    this.save = save;
    this.onChange = onChange || (() => {});
    this.list = document.getElementById('mission-list');
    this.feedback = document.getElementById('mission-feedback');
    if (this.list) {
      this.list.addEventListener('click', (e) => this._onClick(e));
    }
    this.refresh();
  }

  _onClick(e) {
    const btn = e.target.closest('[data-claim]');
    if (!btn) return;
    const id = btn.dataset.claim;
    const granted = this.save.claimMission(id);
    if (!granted) return;
    this.refresh();
    this._showFeedback(granted);
    this.onChange();
  }

  _showFeedback(granted) {
    if (!this.feedback) return;
    const parts = [];
    if (granted.coins) parts.push(`金币 +${granted.coins}`);
    if (granted.reputation) parts.push(`声望 +${granted.reputation}`);
    if (granted.cores) parts.push(`核心 +${granted.cores}`);
    for (const [key, value] of Object.entries(granted.materials || {})) {
      if (value) parts.push(`${materialLabel(key)} +${value}`);
    }
    this.feedback.textContent = parts.length ? `已领取：${parts.join(' · ')}` : '奖励已领取';
    this.feedback.classList.add('show');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.feedback.classList.remove('show'), 1800);
  }

  /** 奖励文案 */
  _rewardText(m) {
    const r = m.reward || {};
    const parts = [];
    if (r.coins) parts.push(`${r.coins} 金币`);
    if (r.reputation) parts.push(`${r.reputation} 声望`);
    if (r.cores) parts.push(`${r.cores} 核心`);
    for (const [key, value] of Object.entries(r.materials || {})) {
      if (value) parts.push(`${value} ${materialLabel(key)}`);
    }
    return parts.join(' · ') || '—';
  }

  refresh() {
    if (!this.list || !this.save) return;
    const states = this.save.getMissionStates();
    this.list.innerHTML = '';
    for (const m of states) {
      const done = m.progress >= m.target;
      const card = document.createElement('div');
      card.className = 'mission-card' + (m.claimed ? ' claimed' : done ? ' done' : '');
      const pct = Math.min(100, (m.progress / m.target) * 100);

      const head = document.createElement('div');
      head.className = 'mission-head';
      const title = document.createElement('h4');
      title.textContent = m.name;
      const state = document.createElement('span');
      state.textContent = m.claimed ? '已领取' : `${m.progress}/${m.target}`;
      head.append(title, state);

      const desc = document.createElement('p');
      desc.textContent = m.desc;

      const bar = document.createElement('div');
      bar.className = 'mission-bar';
      const fill = document.createElement('i');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);

      const foot = document.createElement('div');
      foot.className = 'mission-foot';
      const reward = document.createElement('span');
      reward.className = 'mission-reward';
      reward.textContent = `奖励：${this._rewardText(m)}`;
      const btn = document.createElement('button');
      btn.className = 'btn mini primary';
      btn.dataset.claim = m.id;
      btn.textContent = m.claimed ? '已领取' : '领取';
      btn.disabled = m.claimed || !done;
      foot.append(reward, btn);

      card.append(head, desc, bar, foot);
      this.list.appendChild(card);
    }
  }
}
