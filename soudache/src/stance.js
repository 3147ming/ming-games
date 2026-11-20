/**
 * 姿态输入合成（纯逻辑 · 零 DOM · 零 three · 零随机）。
 *
 * 为什么单独一个模块：蹲/卧有三条输入来源 ——
 *   ① 键盘按住（Ctrl，老习惯）② 键盘切换（C 蹲 / Z 卧，三角洲键位）③ 触屏（双击左摇杆 / 「卧倒」键）。
 * 它们必须先各自记账，再合成为 `input.prone` / `input.crouch` 两个**派生量**。
 * 直接让每个输入层自己写 `input.crouch = !input.crouch` 会出现两类假状态：
 *   - 按着 Ctrl 时点一下 C，松开 Ctrl 把蹲伏一起松掉（按住态与切换态被同一个布尔吃掉）；
 *   - 触屏双击与键盘 C 交替按，-toggle 的基准值互相打架。
 *
 * 因此：**raw 状态只写这里，派生量只由 syncStance 写 input**。
 * 判定真值（受击/散布/噪音/视距/相机）仍然只读 player.prone / player.crouching，
 * 本模块不参与任何玩法判定。
 */

/**
 * 创建一份姿态原始状态。
 * @returns {{prone:boolean,crouchHold:boolean,crouchToggled:boolean}}
 */
export function createStanceState() {
  return { prone: false, crouchHold: false, crouchToggled: false };
}

/**
 * 把 raw 状态合成为 input 上的两个派生量。
 * 规则：卧倒优先级最高（趴着时蹲伏位恒为 false，player 侧再把 crouching 拉成 true）。
 * @param {object} st raw 状态
 * @param {object} input 与游戏主循环共用的输入对象
 * @returns {object} input（便于链式调用）
 */
export function syncStance(st, input) {
  if (!st || !input) return input;
  input.prone = Boolean(st.prone);
  input.crouch = !st.prone && Boolean(st.crouchHold || st.crouchToggled);
  return input;
}

/**
 * 按住类输入（Ctrl）：按下/松开只改 hold 位，不动切换位。
 * @param {object} st raw 状态
 * @param {object} input 输入对象
 * @param {boolean} on 是否按住
 * @returns {object} input
 */
export function setCrouchHold(st, input, on) {
  if (st) st.crouchHold = Boolean(on);
  return syncStance(st, input);
}

/**
 * 蹲下切换（C 键 / 触屏「蹲」）：趴着时按蹲 = 起到蹲（三角洲习惯），否则在蹲/站之间翻。
 * @param {object} st raw 状态
 * @param {object} input 输入对象
 * @returns {object} input
 */
export function toggleCrouch(st, input) {
  if (!st) return input;
  if (st.prone) {
    st.prone = false;
    st.crouchToggled = true;
  } else {
    st.crouchToggled = !st.crouchToggled;
  }
  return syncStance(st, input);
}

/**
 * 卧倒切换（Z 键 / 触屏「卧倒」）：趴下时顺手清掉蹲伏切换位，起身回站立。
 * @param {object} st raw 状态
 * @param {object} input 输入对象
 * @returns {object} input
 */
export function toggleProne(st, input) {
  if (!st) return input;
  st.prone = !st.prone;
  if (st.prone) st.crouchToggled = false;
  return syncStance(st, input);
}

/**
 * 窗口失焦：按住态必须清（键松了但事件可能丢），切换态与卧倒是玩家意图，保留。
 * @param {object} st raw 状态
 * @param {object} input 输入对象
 * @returns {object} input
 */
export function releaseStanceHolds(st, input) {
  return setCrouchHold(st, input, false);
}

/**
 * 进局重置：上局趴着死的人，下一局不该一睁眼就趴在地上。
 * @param {object} st raw 状态
 * @param {object} input 输入对象
 * @returns {object} input
 */
export function resetStance(st, input) {
  if (st) {
    st.prone = false;
    st.crouchHold = false;
    st.crouchToggled = false;
  }
  return syncStance(st, input);
}
