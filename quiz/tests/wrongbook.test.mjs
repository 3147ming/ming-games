/* 错题本（薄弱题本）导出/导入纯逻辑单测：node --test tests/wrongbook.test.mjs
   不依赖任何第三方包 —— Node 24 自带 node:test。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import wb from '../src/wrongbook.js';

const { exportWeak, parseWeak, importWeak } = wb;

/* 真实 saveWeak 写进 bt_qa_weak 的条目形状（含 SRS） */
function sample() {
    return [
        {
            n: 2,
            t: 1700000000000,
            type: 'math',
            diff: 1,
            q: '12 × 8 = ?',
            a: '96',
            opts: ['86', '96', '106', '108'],
            pick: '86',
            tag: '',
            srs: { lv: 1, due: 1700086400000 }
        },
        {
            n: 1,
            t: 1700000100000,
            type: 'english',
            q: 'What is the plural of "child"?',
            a: 'children',
            opts: ['childs', 'children'],
            code: 'print("child")',
            exp: '不规则复数',
            src: '自建题库',
            fillin: false,
            srs: { lv: 0, due: 1700086500000 }
        }
    ];
}

function entry(over) {
    return Object.assign({
        n: 1,
        t: 1700000000000,
        type: 'math',
        q: '1 + 1 = ?',
        a: '2',
        opts: ['1', '2', '3', '4'],
        srs: { lv: 0, due: 1700086400000 }
    }, over || {});
}

test('空薄弱题本也能导出且可解析（不崩）', () => {
    const text = exportWeak([]);
    const parsed = parseWeak(text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, []);
    assert.equal(JSON.parse(text).count, 0);
    assert.equal(JSON.parse(text).version, wb.VERSION);
});

test('导出 → 导入往返一致（空数组起点）', () => {
    const origin = sample();
    const res = importWeak(exportWeak(origin), []);
    assert.equal(res.ok, true);
    assert.equal(res.stats.added, origin.length);
    assert.deepEqual(res.data, origin);
});

test('parseWeak 往返一致（数据本身不丢字段）', () => {
    const origin = sample();
    const parsed = parseWeak(exportWeak(origin));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, origin);
    assert.ok(parsed.meta.exportedAt, '应带导出时间');
});

test('合并：同题取错次更多的那条（本地更强时保留本地）', () => {
    const local = entry({ n: 3, t: 1700000000000 });
    const incoming = entry({ n: 1, t: 1700009999999 });
    const res = importWeak(exportWeak([incoming]), [local]);
    assert.equal(res.ok, true);
    assert.equal(res.data.length, 1, '同一题不能出现两条');
    assert.equal(res.data[0].n, 3);
    assert.equal(res.stats.kept, 1);
    assert.equal(res.stats.updated, 0);
});

test('合并：导入的错次更多时覆盖本地', () => {
    const local = entry({ n: 2 });
    const incoming = entry({ n: 5, t: 1700009999999 });
    const res = importWeak(exportWeak([incoming]), [local]);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].n, 5);
    assert.equal(res.data[0].t, 1700009999999);
    assert.equal(res.stats.updated, 1);
});

test('合并：错次相同取更早到期的那条', () => {
    const local = entry({ n: 2, srs: { lv: 1, due: 1700200000000 } });
    const incoming = entry({ n: 2, srs: { lv: 2, due: 1700100000000 } });
    const res = importWeak(exportWeak([incoming]), [local]);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].srs.due, 1700100000000);
    assert.equal(res.stats.updated, 1);
});

test('合并：不同题都保留，不丢任何一边', () => {
    const local = entry({ q: '本地题' });
    const incoming = entry({ q: '导入题' });
    const res = importWeak(exportWeak([incoming]), [local]);
    assert.equal(res.data.length, 2);
    assert.deepEqual(res.data.map((x) => x.q).sort(), ['导入题', '本地题']);
    assert.equal(res.stats.added, 1);
    assert.equal(res.stats.total, 2);
});

test('合并：未知分类（本地题库里不存在的 type）也保留', () => {
    const incoming = entry({ type: 'totally-unknown', q: '换设备后分类不见了' });
    const res = importWeak(exportWeak([incoming]), []);
    assert.equal(res.ok, true);
    assert.equal(res.data[0].type, 'totally-unknown');
});

test('容错：非法输入全部 ok:false 且不抛异常', () => {
    const badInputs = [
        '',
        '   ',
        'null',
        '{',
        '[]',
        '42',
        '"x"',
        '{"data":[]}',
        '{"version":1}',
        '{"version":1,"data":"x"}',
        '{"version":1,"data":null}',
        '{"version":1,"data":[{}]}',
        '{"version":1,"data":[{"q":"缺分类"}]}',
        '{"version":"abc","data":[]}'
    ];
    for (const text of badInputs) {
        let res;
        assert.doesNotThrow(() => {
            res = parseWeak(text);
        }, 'parseWeak 不应抛异常: ' + text);
        assert.equal(res.ok, false, '应拒绝: ' + text);
        assert.equal(typeof res.error, 'string');
        assert.ok(res.error.length > 0, '错误信息不能为空: ' + text);
    }
});

test('容错：非字符串输入（null / undefined / 数字 / 对象）不抛异常', () => {
    for (const v of [null, undefined, 123, {}, []]) {
        let res;
        assert.doesNotThrow(() => {
            res = parseWeak(v);
        });
        assert.equal(res.ok, false);
        assert.match(res.error, /不是文本/);
    }
});

test('版本号不匹配时明确拒绝，并给出可读提示', () => {
    const res = parseWeak('{"version":2,"data":[]}');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'VERSION_MISMATCH');
    assert.match(res.error, /版本不匹配/);
    assert.match(res.error, /v2/);
});

test('缺 version / 缺 data 分别给出明确原因', () => {
    const noVer = parseWeak('{"data":[]}');
    assert.equal(noVer.ok, false);
    assert.equal(noVer.code, 'NO_VERSION');
    assert.match(noVer.error, /version/);

    const noData = parseWeak('{"version":1}');
    assert.equal(noData.ok, false);
    assert.equal(noData.code, 'NO_DATA');
    assert.match(noData.error, /data/);
});

test('importWeak 失败时原样返回现有数据，调用方无需回滚', () => {
    const local = [entry()];
    const res = importWeak('{', local);
    assert.equal(res.ok, false);
    assert.equal(res.stats, null);
    assert.deepEqual(res.data, local);
    assert.match(res.error, /JSON/);
});

test('部分坏条目：跳过坏的，导入好的并统计 skipped', () => {
    const mixed = JSON.stringify({
        version: 1,
        data: [entry(), { q: '缺分类' }, null, 42]
    });
    const parsed = parseWeak(mixed);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.length, 1);
    assert.equal(parsed.skipped, 3);

    const res = importWeak(mixed, []);
    assert.equal(res.ok, true);
    assert.equal(res.stats.added, 1);
    assert.equal(res.stats.skipped, 3);
});

test('data 用 {id: 条目} 对象形式也能导入', () => {
    const payload = JSON.stringify({
        version: 1,
        data: { a: entry({ q: '对象形式的题' }) }
    });
    const res = importWeak(payload, []);
    assert.equal(res.ok, true);
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].q, '对象形式的题');
});

test('exportWeak 对异常入参（null / 非数组对象）不崩', () => {
    assert.doesNotThrow(() => exportWeak(null));
    const text = exportWeak({ x: entry() });
    assert.equal(parseWeak(text).data.length, 1);
});
