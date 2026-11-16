/* 生成 Word 文档：为 quiz 项目新增"电路与模拟电子技术"学科的完整改动文档 */
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageBreak
} = require('docx');

const CJK = { ascii: "Noto Sans CJK SC", hAnsi: "Noto Sans CJK SC", eastAsia: "Noto Sans CJK SC" };
const MONO = { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "Noto Sans CJK SC" };

function H1(text){ return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing:{before:360,after:180}, children:[new TextRun({ text, bold:true, font:CJK, size:36 })] }); }
function H2(text){ return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing:{before:280,after:120}, children:[new TextRun({ text, bold:true, font:CJK, size:28 })] }); }
function H3(text){ return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing:{before:200,after:80}, children:[new TextRun({ text, bold:true, font:CJK, size:24 })] }); }
function P(text, bold){
  const r = new TextRun({ text: text ?? '', font: CJK, size: 22 });
  if(bold) r.bold = true;
  return new Paragraph({ spacing:{after:80}, children:[r] });
}
function CODE(text){
  return new Paragraph({
    spacing:{before:60,after:60},
    shading:{ fill:"F2F2F2", type:ShadingType.CLEAR },
    indent:{ left:360 },
    children:[new TextRun({ text: text ?? '', font:MONO, size:18 })]
  });
}
function NOTE(text){
  return new Paragraph({
    spacing:{before:60,after:60},
    shading:{ fill:"FFF9C4", type:ShadingType.CLEAR },
    indent:{ left:360 },
    children:[new TextRun({ text: "⚠ "+(text ?? ''), font:CJK, size:20, color:"7A5A00" })]
  });
}

/* ========= 表格辅助 ========= */
const thin = { style: BorderStyle.SINGLE, size: 1, color: "BBBBBB" };
const borders = { top:thin, bottom:thin, left:thin, right:thin };
function makeCell(text, opts){
  opts = opts || {};
  const run = new TextRun({ text, font:CJK, size:20, bold:opts.bold });
  const cell = new TableCell({
    borders,
    width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts.header ? { fill: "E3F2FD", type: ShadingType.CLEAR } : undefined,
    margins:{ top:80, bottom:80, left:120, right:120 },
    children:[new Paragraph({ children:[run] })]
  });
  return cell;
}

/* ========= 读取题库 ========= */
const circuitPool = JSON.parse(fs.readFileSync(__dirname+'/circuit_pool.json','utf8'));
const circuitObj = circuitPool.circuit;
const difficultyNames = {
  "0": "🔋 入门（电路基础与元件）",
  "1": "📡 基础（电容电感与半导体）",
  "2": "🧰 进阶（运放 / 负反馈 / 基本放大）",
  "3": "🔬 熟练（频率响应 / 滤波 / ADC / DAC）",
  "4": "⚡ 精通（高频 / 噪声 / 集成电路设计）"
};
let totalQ = 0;
for(const k in circuitObj){ totalQ += circuitObj[k].length; }

/* ========= 组装文档 ========= */
const children = [];

// --- 封面 ---
children.push(new Paragraph({ spacing:{before:2400}, children:[] }));
children.push(new Paragraph({ alignment:AlignmentType.CENTER, children:[
  new TextRun({ text:"知识问答新增学科改动文档", bold:true, font:CJK, size:56 })
]}));
children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{before:240}, children:[
  new TextRun({ text:"电路与模拟电子技术  ·  与编程同等地位", font:CJK, size:32, color:"555555" })
]}));
children.push(new Paragraph({ alignment:AlignmentType.CENTER, spacing:{before:1200}, children:[
  new TextRun({ text:"2026-11-16  ·  完整可复制版本", font:CJK, size:22, color:"888888" })
]}));
children.push(new Paragraph({ children:[new PageBreak()] }));

// --- 第 1 节：改动概览 ---
children.push(H1("1  改动概览"));
children.push(P("以下 3 个文件需要改动，改动后电路与模拟电子技术将以「💻 信息技术」分组下的独立学科出现，享受与编程完全平等的待遇：同样的 5 档难度体系、同样支持 diffMatters 自动升档挑战、同样的书架卡片和数据存储路径。"));

children.push(H2("1.1 改动清单"));
const overviewTable = new Table({
  width:{ size:100, type:WidthType.PERCENTAGE },
  columnWidths:[2600, 2000, 4400, 3060],
  rows:[
    new TableRow({ cantSplit:true, children:[
      makeCell("文件", {header:true, width:2600}),
      makeCell("改动位置", {header:true, width:2000}),
      makeCell("改动内容", {header:true, width:4400}),
      makeCell("类型", {header:true, width:3060})
    ]}),
    new TableRow({ cantSplit:true, children:[
      makeCell("quiz/data/pools.json", { width:2600 }),
      makeCell("顶层 key", { width:2000 }),
      makeCell("新增 \"circuit\" 块，0~4 共 5 档难度，合计 "+totalQ+" 题人工精编题库", { width:4400 }),
      makeCell("新增题库", { width:3060 })
    ]}),
    new TableRow({ cantSplit:true, children:[
      makeCell("quiz/src/engine_core.js", { width:2600 }),
      makeCell("QA_DIFFS / QA_TYPES / SUBJECT_GROUPS", { width:2000 }),
      makeCell("新增 QA_DIFFS_CIRCUIT、注册 circuit 到 QA_TYPES、tech 组加 circuit", { width:4400 }),
      makeCell("引擎层注册", { width:3060 })
    ]}),
    new TableRow({ cantSplit:true, children:[
      makeCell("quiz/src/quiz-ui.js", { width:2600 }),
      makeCell("6 处 bk==='code' 硬编码", { width:2000 }),
      makeCell("stdAvail / diffMatters / shelfCount / pickDiffPanel hint / 新建分类屏蔽 / 文案调整", { width:4400 }),
      makeCell("UI 层扩展", { width:3060 })
    ]})
  ]
});
children.push(overviewTable);

children.push(H2("1.2 改完跑一下"));
children.push(P("三个文件改完以后，务必运行一次构建校验脚本，脚本会验证 engine_core.js 里 POOLS 与 pools.json 是否一致、QA_TYPES 引用的 key 是否都在 POOLS 里存在："));
children.push(CODE("cd /workspace/quiz && node .build/_pools.cjs --sync"));
children.push(P("脚本输出 OK 或没有红色报错就说明改动正确。"));

children.push(new Paragraph({ children:[new PageBreak()] }));

// --- 第 2 节：改动 1 — pools.json ---
children.push(H1("2  改动 1：quiz/data/pools.json"));
children.push(P("在 JSON 顶层、紧跟 \"code\" 块之后，新增一个名为 \"circuit\" 的 key。value 是一个对象，key \"0\"~\"4\" 分别对应 5 档难度，每档都是数组，每个元素是一个长度为 4 的子数组，格式为 [题干, 正确答案, 分类标签, 干扰项（用 \"|\" 分隔）]。"));

children.push(H2("2.1 完整 circuit 块（可直接复制粘贴）"));
children.push(P("完整 JSON 已随本文档附件 circuit_pool.json 一起生成，以下为 5 档结构概览："));
children.push(CODE(JSON.stringify(Object.keys(circuitObj).map(k => ({
  难度等级: k,
  难度名称: difficultyNames[k],
  题目数量: circuitObj[k].length
})), null, 2)));

// --- 第 3 节：改动 2 — engine_core.js ---
children.push(H1("3  改动 2：quiz/src/engine_core.js"));
children.push(P("这一步是引擎层注册，告诉系统有了 circuit 这个学科、难度体系长什么样、应该放在哪个书架组里。"));

children.push(H2("3.1 新增 QA_DIFFS_CIRCUIT 定义"));
children.push(P("在 QA_DIFFS_CODE 定义（约第 761 行）之后、QA_DIFFS_STD 之前，插入以下代码："));
children.push(CODE(`var QA_DIFFS_CIRCUIT=[
 {n:'🔋 入门',d:'电路基础与元件',cnt:10},
 {n:'📡 基础',d:'电容电感与半导体',cnt:10},
 {n:'🧰 进阶',d:'运放/负反馈/基本放大',cnt:10},
 {n:'🔬 熟练',d:'频率响应/滤波/ADC/DAC',cnt:10},
 {n:'⚡ 精通',d:'高频/噪声/集成电路设计',cnt:10}
];`));

children.push(H2("3.2 注册 circuit 到 QA_TYPES"));
children.push(P("在 QA_TYPES 对象里、code 那一行的下一行（约第 805 行），插入："));
children.push(CODE(`circuit:{name:'电路与模拟电子',icon:'🔌',alias:['circuit','diianlu','monyidianzi','模拟电路','电路'],gen:genStdPool('circuit'),diffs:QA_DIFFS_CIRCUIT},`));

children.push(H2("3.3 修改 SUBJECT_GROUPS 的 tech 组"));
children.push(P("原代码 tech 组只有 code 一个学科，改成把 circuit 也加进去："));
children.push(new Paragraph({ spacing:{before:60}, children:[
  new TextRun({ text:"// 原代码", font:MONO, size:18, color:"888888" })
]}));
children.push(CODE(`{k:'tech',    n:'💻 信息技术',   sub:['code']}`));
children.push(new Paragraph({ spacing:{before:60}, children:[
  new TextRun({ text:"// 改为", font:MONO, size:18, color:"888888" })
]}));
children.push(CODE(`{k:'tech',    n:'💻 信息技术',   sub:['code','circuit']}`));

children.push(new Paragraph({ children:[new PageBreak()] }));

// --- 第 4 节：改动 3 — quiz/src/quiz-ui.js ---
children.push(H1("4  改动 3：quiz/src/quiz-ui.js"));
children.push(P("UI 层有 6 处硬编码只认 math/code，需要把 circuit 也加进去。每一处都给出 old 和 new。"));

children.push(H2("4.1 stdAvail — 让 circuit 也返回 Infinity"));
children.push(P("约第 159 行。circuit 和 math/code 一样是按难度分档的题库，不是扁平题库，也应返回 Infinity 表示题量不受物理上限约束。"));
children.push(CODE(`// old
if(!bk||bk==='math'||bk==='code')return Infinity;
// new
if(!bk||bk==='math'||bk==='code'||bk==='circuit')return Infinity;`));

children.push(H2("4.2 diffMatters — 让 circuit 支持自动升档挑战"));
children.push(P("约第 167 行。diffMatters 决定某个学科是否走「实力驱动」模式——题目难度跟随 selfRank 变化、支持连对 3 题触发升档挑战。circuit 有完整的 5 档难度体系，应加入。"));
children.push(CODE(`// old
function diffMatters(bk){return bk==='math'||bk==='code';}
// new
function diffMatters(bk){return bk==='math'||bk==='code'||bk==='circuit';}`));

children.push(H2("4.3 shelfCount — 书架卡片显示 circuit 的题量"));
children.push(P("约第 170-171 行。code 分支之后加一个 circuit 分支。circuit 是人工精编题库，直接按难度档累加题量即可，不需要 code 那样的语言过滤和模板估算。"));
children.push(CODE(`// 紧接 if(bk==='code'){...} 那个分支之后，加：
if(bk==='circuit'){
  var n=0;
  for(var d in POOLS.circuit){
    if(POOLS.circuit.hasOwnProperty(d)) n+=POOLS.circuit[d].length;
  }
  return n+' 题（人工精编）';
}`));

children.push(H2("4.4 pickDiffPanel 的 hint 文案"));
children.push(P("约第 297 行。原代码是一个嵌套三元：bk==='math' 出数学提示，bk==='code' 出编程提示，其他出通用提示。加一层 circuit 分支，让书架卡片上的难度说明更贴合学科。"));
children.push(CODE(`// old（约第 297 行）
(bk==='math'?'🎓 按学业阶段出题：':(bk==='code'?'💻 按学习进度出题（已按你掌握的语言过滤）：':'⚙️ 选择难度，题量与扣分随档位变化'))

// new（多加一层三元）
(bk==='math'?'🎓 按学业阶段出题：':(bk==='code'?'💻 按学习进度出题（已按你掌握的语言过滤）':(bk==='circuit'?'🔌 按学习进度出题，从电路基础到模拟 IC 设计全覆盖：':'⚙️ 选择难度，题量与扣分随档位变化')))`));

children.push(H2("4.5 「新建分类」屏蔽内置学科"));
children.push(P("约第 3338 行。这一行是 openNewCategory 里的 guard 语句，屏蔽所有内置学科。circuit 是新注册的内置学科，也应该屏蔽，不让用户在「新建」里重复创建。"));
children.push(CODE(`// old
if(!bk||bk==='code'||bk==='online')return;
// new
if(!bk||bk==='code'||bk==='circuit'||bk==='online')return;`));

children.push(H2("4.6 circuit 不走语言过滤（无需改动）"));
children.push(P("code 有一段语言过滤逻辑（codeLangState / langGuard），circuit 不涉及编程语言，所以那一段完全不用动。circuit 直接走 genStdPool('circuit')，按难度档抽题即可。"));

children.push(new Paragraph({ children:[new PageBreak()] }));

// --- 第 5 节：完整题库 ---
children.push(H1("5  完整题库"));
children.push(P("以下为 circuit 学科的全部题库 JSON，共 5 档 "+totalQ+" 题。每档一个标题 + 代码块，可直接复制粘贴到 pools.json 顶层。"));

for(const diffKey of Object.keys(circuitObj).sort()){
  children.push(H2("5."+(parseInt(diffKey,10)+1)+"  "+difficultyNames[diffKey]+"（"+circuitObj[diffKey].length+" 题）"));
  children.push(CODE(JSON.stringify(circuitObj[diffKey], null, 2)));
}

// ========= 生成文档 =========
const doc = new Document({
  styles:{
    default:{
      document:{ run:{ font:CJK, size:22 } }
    },
    paragraphStyles:[
      { id:"Heading1", name:"Heading 1", basedOn:"Normal", next:"Normal", quickFormat:true,
        run:{ size:36, bold:true, font:CJK },
        paragraph:{ spacing:{ before:360, after:180 }, outlineLevel:0, keepNext:false, keepLines:false } },
      { id:"Heading2", name:"Heading 2", basedOn:"Normal", next:"Normal", quickFormat:true,
        run:{ size:28, bold:true, font:CJK },
        paragraph:{ spacing:{ before:280, after:120 }, outlineLevel:1, keepNext:false, keepLines:false } },
      { id:"Heading3", name:"Heading 3", basedOn:"Normal", next:"Normal", quickFormat:true,
        run:{ size:24, bold:true, font:CJK },
        paragraph:{ spacing:{ before:200, after:80 }, outlineLevel:2, keepNext:false, keepLines:false } }
    ]
  },
  sections:[{
    properties:{
      page:{
        size:{ width:11906, height:16838 },
        margin:{ top:1440, right:1440, bottom:1440, left:1440 }
      }
    },
    children: children
  }]
});

const outPath = '/workspace/电路与模拟电子技术-新增学科改动文档.docx';
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log('✅ Word 文档已生成：'+outPath);
  console.log('   文件大小：'+(buf.length/1024).toFixed(1)+' KB');
});
