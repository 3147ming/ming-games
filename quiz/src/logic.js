/* ===== 知识问答 · 无 DOM 纯逻辑层（UMD：浏览器挂 globalThis.QALogic，Node 可 require 单测） =====
   为什么单独成文件：
   1) SRS 间隔推进、降档门槛、干扰项生成、validItem 是四类「错了会教错人」的高风险判定，
      以前只能整页起浏览器验（分钟级）；抽出来后 Node 秒级跑单测（.build/_probe_logic.cjs）。
   2) 构建时由 .build/build.js 内联进单文件产物，不新增 <script src>、不给离线 PWA 加缓存缺口。
   约束：本文件不许出现 document / window / localStorage / Date.now() 之外的环境依赖，
        所有需要时间的值都由调用方显式传入 now，保证纯函数可重复断言。 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.QALogic = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ---------- SRS：SM-2 简化，6 级阶梯 1/2/4/7/15/30 天 ---------- */
    var DAY = 86400000;
    var SRS_INTERVALS = [1, 2, 4, 7, 15, 30];
    var NON_CHOICE = { fill: 1, calc: 1, experiment: 1 };

    function srsInit(now) {
        return { lv: 0, due: now + DAY };
    }
    function srsDue(state, now) {
        if (!state) { return false; }
        return state.due <= now;
    }
    /* 就地改 state（与浏览器端 srsAdvance(rec,correct) 的副作用一致），返回「是否已掌握」。 */
    function srsAdvance(state, correct, now) {
        if (!state) { return false; }
        if (correct) {
            state.lv = Math.min(state.lv + 1, SRS_INTERVALS.length - 1);
            state.due = now + SRS_INTERVALS[state.lv] * DAY;
            return state.lv >= SRS_INTERVALS.length - 1;
        }
        state.lv = 0;
        state.due = now + DAY;
        return false;
    }

    /* ---------- 自适应降档门槛（原 answer() 里的内联判定） ----------
       win：最近 ≤12 题的 1/0 数组；rank：当前档；cool：升/降档冷却剩余题数。
       返回 {demote, coolDelta}：coolDelta 是冷却计数本轮该减多少（-1）或重置值。 */
    function demoteDecision(win, rank, cool, opt) {
        var o = opt || {};
        var min = o.min == null ? 6 : o.min;
        var threshold = o.threshold == null ? 0.4 : o.threshold;
        var cooldown = o.cooldown == null ? 2 : o.cooldown;
        if (cool > 0) { return { demote: false, cool: cool - 1 }; }
        if (!win || win.length < min || rank <= 0) { return { demote: false, cool: 0 }; }
        var hit = 0;
        for (var i = 0; i < win.length; i++) { if (win[i]) { hit++; } }
        var acc = hit / win.length;
        if (acc <= threshold) { return { demote: true, cool: cooldown }; }
        return { demote: false, cool: 0 };
    }

    /* ---------- 干扰项生成 ---------- */
    function ansClass(s) {
        s = String(s);
        if (/^O\(/.test(s)) { return 'bigo'; }
        if (/^-?\d+(\.\d+)?$/.test(s)) { return 'num'; }
        return 'txt';
    }
    function fallbackWrongs(ans) {
        var num = Number(ans);
        if (ans !== '' && isFinite(num) && String(num) === String(ans).trim()) {
            return [String(num + 1), String(num - 1), String(num + 2), String(num - 2),
                    String(num + 3), String(num - 3)];
        }
        return ['以上都不对', '不确定', '其他答案'];
    }
    /* 数值答案干扰项不足时的邻居补齐：与旧 mkQA 内联逐步长算法逐值一致。
       seen 是「已占用选项」对象，会被就地更新；返回新补出的字符串数组。 */
    function numericNeighbors(ans, seen, need) {
        var out = [];
        var n = Number(ans);
        if (!isFinite(n) || String(n) !== ans || need <= 0) { return out; }
        var k = 1;
        while (out.length < need && k < 40) {
            var d = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
            var w = String(n + d);
            if (!seen[w]) { seen[w] = 1; out.push(w); }
            k++;
        }
        return out;
    }

    /* ---------- 题目合法性（全站统一闸门） ----------
       两种来源：源静态题 item[3] 是 3 个干扰项（不含答案）；运行时题 it.opts 是 4 个选项（含答案）。
       非选择题（fill/calc/experiment）只要题干与答案非空。缺省 type 一律按选择题走老逻辑。 */
    function validItem(it) {
        if (!it) { return false; }
        if (NON_CHOICE[it.type]) {
            var q = (it.q == null) ? '' : String(it.q).trim();
            var a = (it.a == null) ? '' : String(it.a).trim();
            return !!(q && a);
        }
        var o = it.opts;
        if (!o && it[3] != null) { o = String(it[3]).split('|'); }
        if (!Array.isArray(o) || o.length < 3) { return false; }
        /* 与浏览器端旧实现一致：用 Set 按原始值去重，不做 String 隐式转换。 */
        if (new Set(o).size !== o.length) { return false; }
        if (it.opts) { return o.length === 4 && o.indexOf(String(it.a)) >= 0; }
        return o.length === 3 && o.indexOf(String(it.a)) < 0;
    }

    /* ---------- Q1：状态合法性（纯函数，浏览器与 Node 共用） ----------
       8 个并行模式标志以前靠 if 组合推断局面；现在每次 setQAState 都先过这道断言，
       非法组合在开发期（甚至探针里）立刻抛错，不再等到跑完 29 套才发现状态错乱。 */
    var QA_BOOL_KEYS = ['autoMode', 'reviewMode', 'handMode', 'quizOver', 'locked', 'customMixed'];
    var QA_SECTIONS = ['choice', 'code', 'fill'];
    function validateState(s, ctx) {
        if (!s) { throw new Error('状态快照为空 @' + (ctx || '')); }
        for (var i = 0; i < QA_BOOL_KEYS.length; i++) {
            var k = QA_BOOL_KEYS[i];
            if (typeof s[k] !== 'boolean') {
                throw new Error('状态字段必须是布尔：' + k + '=' + String(s[k]) + ' @' + (ctx || ''));
            }
        }
        if (QA_SECTIONS.indexOf(s.qaSection) < 0) {
            throw new Error('非法板块：' + String(s.qaSection) + ' @' + (ctx || ''));
        }
        if (typeof s.promoState !== 'string' || !s.promoState) {
            throw new Error('非法挑战状态：' + String(s.promoState) + ' @' + (ctx || ''));
        }
        var bad = [];
        if (s.autoMode && s.reviewMode) { bad.push('autoMode && reviewMode'); }
        if (s.reviewMode && s.handMode) { bad.push('reviewMode && handMode'); }
        if (bad.length) {
            throw new Error('非法状态组合：' + bad.join(' / ') + ' @' + (ctx || ''));
        }
        return true;
    }

    return {
        DAY: DAY,
        SRS_INTERVALS: SRS_INTERVALS,
        validateState: validateState,
        QA_BOOL_KEYS: QA_BOOL_KEYS,
        QA_SECTIONS: QA_SECTIONS,
        srsInit: srsInit,
        srsDue: srsDue,
        srsAdvance: srsAdvance,
        demoteDecision: demoteDecision,
        ansClass: ansClass,
        fallbackWrongs: fallbackWrongs,
        numericNeighbors: numericNeighbors,
        validItem: validItem
    };
});
