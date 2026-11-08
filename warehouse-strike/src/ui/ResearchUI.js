/**
 * 大厅「科研所」页签
 *
 * 6 条研究线，各 5 级：消耗科研材料 + 金币，部分高级研究需要首领核心与地图材料。
 * 研究线首次升级前需要声望 / 等级 / 属性点门槛。
 */
import { RESEARCH, RESEARCH_ORDER, RESEARCH_UNLOCK, MATERIALS } from '../config/progression.js';

export class ResearchUI {
  /**
   * @param {{save: import('../core/SaveManager.js').SaveManager, onChange?: Function}} opts
   */
  constructor(opts) {
    this.save = opts.save;
    this.onChange = opts.onChange || (() => {});
    this.listEl = document.getElementById('research-list');
    this.feedbackEl = document.getElementById('research-feedback');
    this._bind();
    this.refresh();
  }

  _bind() {
    this.listEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-research]');
      if (!btn || btn.disabled) return;
      const res = this.save.upgradeResearch(btn.dataset.research);
      this._feedback(res.message);
      this.refresh();
      if (res.ok) this.onChange();
    });
  }

  _feedback(text) {
    if (!this.feedbackEl) return;
    this.feedbackEl.textContent = text || '';
  }

  refresh() {
    if (!this.listEl) return;
    const labOpen = this.save.researchUnlocked();
    this.listEl.innerHTML = RESEARCH_ORDER.map((id) => {
      const def = RESEARCH[id];
      const lv = this.save.researchLevel(id);
      const max = def.levels.length;
      const matKey = def.material;
      const matName = MATERIALS[matKey]?.name || matKey;
      const owned = this.save.materialCount(matKey);
      const unlocked = lv > 0 || this.save.researchLineUnlocked(id);
      const cost = lv < max ? def.levels[lv] : null;

      const pips = Array.from({ length: max }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('');
      const need = [];
      if (cost) {
        need.push(`${cost.coins} 金币`);
        if (cost.material) need.push(`${matName} ${cost.material}（持有 ${owned}）`);
        if (cost.bossCore) need.push(`首领核心 ${cost.bossCore}（持有 ${this.save.materialCount('bossCore')}）`);
        if (cost.map) need.push(`${MATERIALS[cost.map]?.name || cost.map} 1（持有 ${this.save.materialCount(cost.map)}）`);
      }

      let stateText;
      if (!labOpen) stateText = `科研所未开放：需要 ${this.save.requirementText(RESEARCH_UNLOCK)}`;
      else if (!unlocked) stateText = `研究线未解锁：需要 ${this.save.requirementText(def.unlock)}（首次解锁会扣除声望）`;
      else if (!cost) stateText = '已满级';
      else stateText = `下一级：${need.join(' · ')}`;

      const can = labOpen && unlocked && cost;
      return [
        `<div class="research-card${unlocked ? '' : ' locked'}">`,
        `  <div class="research-head">`,
        `    <h3>${def.name} <span class="research-lv">${lv}/${max}</span></h3>`,
        `    <div class="talent-nodes">${pips}</div>`,
        '  </div>',
        `  <p class="research-desc">${def.desc}（每级）</p>`,
        `  <p class="research-need">${stateText}</p>`,
        `  <button class="btn mini" data-research="${id}" ${can ? '' : 'disabled'}>${cost ? '升级研究' : '已满级'}</button>`,
        '</div>',
      ].join('');
    }).join('');
  }
}
