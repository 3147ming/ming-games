/* ===== 错题本（薄弱题本）导出 / 导入 —— 纯逻辑，不碰 DOM、不碰 localStorage =====
   为什么单独成文件：
   1) 解析、校验、合并都是纯函数，可以在 Node 里直接跑单测（tests/wrongbook.test.mjs）；
   2) 浏览器端由 .build/build.js 内联进 index.html（UMD 挂到 window.WrongBook），
      不额外发网络请求 —— 这个游戏是单文件 + 离线 PWA，多一个 <script src> 就多一个缓存缺口。
   为什么沿用「薄弱题本」的数据：
   页面里叫「错题本」，数据层历史名字是「薄弱题本」（localStorage 键 bt_qa_weak）。两者是同一份数据：
   再新建一套 bt_qa_wrongbook 会让同一道错题被记两遍、两个入口语义还不一致。本次只补「导出/导入」，
   不新增存储键，不改 addWeak/removeWeak/loadWeak/saveWeak 与 SRS 逻辑。
   条目身份 = type（分类）+ q（题干）。题目是快照（自带 opts/a/exp/sol），所以导入时不需要回题库查 id；
   type 在本地题库里不存在也照样保留（UI 会显示成「其他」），不因为换设备/题库改名就丢数据。 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.WrongBook = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* 导出格式版本：只在「字段含义变了」时 +1。
       导入端不认识更高版本就明确拒绝 —— 静默导入一份未来格式的数据，
       比报错更危险：字段含义不同，会让复习间隔/错题次数被写坏。 */
    var VERSION = 1;
    var APP = 'ming-quiz';
    var KIND = 'weakbook';
    var MAX_ENTRIES = 5000;      /* 防御：粘贴一个超大文件时别把内存和 localStorage 打满（上限远高于题本 150 条） */

    /* 文本字段统一截断：错题本只用于复习，超长题干/解析（整篇阅读材料）没必要原样备份，
       截断能避免单个条目把 5MB 的 localStorage 配额吃掉。 */
    var LIMIT = { q: 4000, a: 2000, code: 8000, exp: 4000, sol: 8000, pick: 2000, src: 500, tag: 200 };

    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }
    function cut(v, max) {
        if (typeof v !== 'string') {
            return '';
        }
        return v.length > max ? v.slice(0, max) : v;
    }
    function toNum(v, def) {
        var n = Number(v);
        return isFinite(n) ? n : def;
    }
    function entryKey(e) {
        return String(e.type) + '\u0001' + String(e.q);
    }
    function dueOf(e) {
        var s = e && e.srs;
        if (!s || !isFinite(Number(s.due))) {
            return Infinity;      /* 没有 SRS 记录 = 不参与「更早到期」比较 */
        }
        return Number(s.due);
    }
    function fail(code, error) {
        return { ok: false, code: code, error: error, data: null, meta: null, skipped: 0 };
    }

    /* 把一条弱题记录收敛成固定字段：非法字段丢弃而不是抛错。
       只保留白名单字段（而不是 {...raw}）—— 导入的是外部文本，不能把任意键写进存档。 */
    function normalizeEntry(raw) {
        if (!isPlainObject(raw)) {
            return null;
        }
        var q = cut(raw.q, LIMIT.q).trim();
        var type = cut(raw.type, 200).trim();
        /* 没有分类或题干就无法去重、也无法重新出题 —— 这条判坏，跳过，但别让整份文件失败 */
        if (!q || !type) {
            return null;
        }
        var out = {
            n: Math.max(1, Math.floor(toNum(raw.n, 1))),
            t: Math.max(0, toNum(raw.t, 0)),
            type: type,
            q: q
        };
        if (typeof raw.a === 'string') {
            out.a = cut(raw.a, LIMIT.a);
        }
        if (raw.opts === null) {
            out.opts = null;
        } else if (Array.isArray(raw.opts)) {
            out.opts = raw.opts.slice(0, 12).map(function (o) {
                return cut(String(o), 400);
            });
        }
        /* 代码块 / 解析 / 参考代码：保留原文（含换行），只截长度 */
        ['code', 'exp', 'sol'].forEach(function (k) {
            if (typeof raw[k] === 'string' && raw[k]) {
                out[k] = cut(raw[k], LIMIT[k]);
            }
        });
        if (Array.isArray(raw.steps)) {
            out.steps = raw.steps.slice(0, 20).map(function (s) {
                return cut(String(s), 500);
            });
        }
        if (typeof raw.fillin === 'boolean') {
            out.fillin = raw.fillin;
        }
        if (typeof raw.diff === 'number' && isFinite(raw.diff)) {
            out.diff = raw.diff;
        }
        if ('pick' in raw) {
            out.pick = raw.pick == null ? null : cut(String(raw.pick), LIMIT.pick);
        }
        if ('src' in raw) {
            out.src = raw.src == null ? null : cut(String(raw.src), LIMIT.src);
        }
        if (typeof raw.tag === 'string') {
            out.tag = cut(raw.tag, LIMIT.tag);
        }
        /* SRS：只认 lv/due 都合法的对象，坏数据直接丢掉（loadWeak 会在本地自愈补 srsInit） */
        if (isPlainObject(raw.srs)) {
            var lv = Math.floor(toNum(raw.srs.lv, -1));
            var due = toNum(raw.srs.due, -1);
            if (lv >= 0 && lv <= 10 && due >= 0) {
                out.srs = { lv: lv, due: due };
            }
        }
        return out;
    }

    /* 把 localStorage 里的数组 / 对象（按 id 索引）都转成数组：
       历史上有人手工改过存档，宽松一点能救回来，而不是直接判定「文件损坏」。 */
    function asList(v) {
        if (Array.isArray(v)) {
            return v.slice(0, MAX_ENTRIES);
        }
        if (isPlainObject(v)) {
            return Object.keys(v).slice(0, MAX_ENTRIES).map(function (k) {
                return v[k];
            });
        }
        return null;
    }

    /* 导出：输入是 loadWeak() 的数组（也接受 {id: 条目} 形式），输出可直接粘贴/存盘的 JSON 文本。
       自带 exportedAt 方便人看；导入只把它放进 meta，不参与数据比较。 */
    function exportWeak(weakList, now) {
        var list = asList(weakList) || [];
        var data = [];
        for (var i = 0; i < list.length; i++) {
            var e = normalizeEntry(list[i]);
            if (e) {
                data.push(e);
            }
        }
        var ts = toNum(now, Date.now());
        return JSON.stringify({
            app: APP,
            kind: KIND,
            version: VERSION,
            exportedAt: new Date(ts).toISOString(),
            count: data.length,
            data: data
        }, null, 2);
    }

    /* 纯解析 + 校验：任何非法输入都返回 {ok:false, error:'人话'}，绝不抛异常。
       导入端拿到 ok:false 时直接显示 error 即可，不需要再猜是哪一步坏了。 */
    function parseWeak(jsonText) {
        if (typeof jsonText !== 'string') {
            return fail('NOT_TEXT', '导入内容不是文本：请粘贴导出文件里的 JSON 字符串');
        }
        var text = jsonText.trim();
        if (!text) {
            return fail('EMPTY', '导入内容为空：请先点「导出」生成文本，或粘贴别处的错题本 JSON');
        }
        var raw = null;
        try {
            raw = JSON.parse(text);
        } catch (e) {
            /* V8 的原文是英文（Expected property name...），对玩家不友好；保留原信息帮助定位，
               再补一句中文排查提示，UI 直接 toast 这段文字即可。 */
            return fail('BAD_JSON', 'JSON 解析失败：' + (e && e.message ? e.message : '格式有误') + '（请检查引号、括号、逗号是否完整）');
        }
        if (!isPlainObject(raw)) {
            return fail('BAD_ROOT', '文件格式不对：顶层应该是一个 JSON 对象（不是数组 / 数字 / 字符串）');
        }
        /* app/kind 只在「有写」时校验：兼容早期只导出 data 的简版文件 */
        if (raw.app != null && raw.app !== APP) {
            return fail('BAD_APP', '这不是「知识问答」的错题本文件（app 不匹配）');
        }
        if (raw.kind != null && raw.kind !== KIND) {
            return fail('BAD_KIND', '这不是错题本的导出文件（kind 不匹配）');
        }
        if (!('version' in raw) || raw.version == null) {
            return fail('NO_VERSION', '缺少 version 字段：无法确认这是错题本导出文件');
        }
        var ver = Number(raw.version);
        if (!isFinite(ver)) {
            return fail('BAD_VERSION', 'version 不是数字：' + String(raw.version));
        }
        if (ver !== VERSION) {
            return fail('VERSION_MISMATCH', '版本不匹配：文件是 v' + ver + '，当前只支持 v' + VERSION + '（请更新页面或换用对应版本导出的文件）');
        }
        if (!('data' in raw) || raw.data == null) {
            return fail('NO_DATA', '缺少 data 字段：文件里没有错题数据');
        }
        var list = asList(raw.data);
        if (!list) {
            return fail('BAD_DATA', 'data 必须是错题数组（或按题目 id 索引的对象），当前是 ' + typeof raw.data);
        }
        var data = [];
        var skipped = 0;
        for (var i = 0; i < list.length; i++) {
            var e = normalizeEntry(list[i]);
            if (e) {
                data.push(e);
            } else {
                skipped++;
            }
        }
        /* 空数组是合法的（空题本也能导出/导入）；「有条目但全都不可用」才是错误 */
        if (!data.length && skipped > 0) {
            return fail('NO_VALID', '没有可导入的错题：每条至少要有 type（分类）与 q（题干），已跳过 ' + skipped + ' 条');
        }
        return {
            ok: true,
            code: 'OK',
            error: null,
            data: data,
            skipped: skipped,
            meta: {
                app: raw.app || APP,
                kind: raw.kind || KIND,
                version: ver,
                exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
                count: data.length
            }
        };
    }

    /* 合并规则：同一题（type + q）只留一条，取「错得更多」的那条；次数相同则取「更早到期」的
       （复习更紧迫，不能因为导入把 due 往后推）。现有条目胜出时原样保留，避免无意义的数据抖动。 */
    function isStronger(a, b) {
        var an = Math.max(1, Math.floor(toNum(a.n, 1)));
        var bn = Math.max(1, Math.floor(toNum(b.n, 1)));
        if (an !== bn) {
            return an > bn;
        }
        return dueOf(a) < dueOf(b);
    }

    function importWeak(jsonText, existingWeak) {
        var existing = asList(existingWeak);
        var base = existing ? existing.slice() : [];
        var parsed = parseWeak(jsonText);
        if (!parsed.ok) {
            /* 失败时把「现有数据」原样还回去，调用方不需要自己保存旧值 */
            return { ok: false, code: parsed.code, error: parsed.error, data: base, stats: null, meta: null };
        }
        var index = {};
        for (var i = 0; i < base.length; i++) {
            var old = base[i];
            if (isPlainObject(old) && old.type && old.q) {
                index[entryKey(old)] = i;
            }
        }
        var stats = {
            file: parsed.data.length,
            added: 0,
            updated: 0,
            kept: 0,
            skipped: parsed.skipped || 0,
            total: 0
        };
        for (var j = 0; j < parsed.data.length; j++) {
            var inc = parsed.data[j];
            var k = entryKey(inc);
            var at = index[k];
            if (at == null) {
                base.push(inc);
                index[k] = base.length - 1;
                stats.added++;
            } else if (isStronger(inc, base[at])) {
                base[at] = inc;
                stats.updated++;
            } else {
                stats.kept++;
            }
        }
        stats.total = base.length;
        return { ok: true, code: 'OK', error: null, data: base, stats: stats, meta: parsed.meta };
    }

    return {
        VERSION: VERSION,
        APP: APP,
        KIND: KIND,
        exportWeak: exportWeak,
        parseWeak: parseWeak,
        importWeak: importWeak
    };
});
