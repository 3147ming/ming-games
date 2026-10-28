// 事件配置表（20 个：内容批 P0-1 扩到 20，并给每个事件补第三个选项）
// 口径：事件只有一个目的——提供「非战斗的资源转换」。不做剧情分支（阶段 0 已冻结 F3）。
// 数量口径：FLOOR_SKELETON 中 event 出现 1 次 → 单局恰好 1 次遗迹抉择，见 docs/02 §2.1 与 docs/03 §2.1。
// apply 支持的载荷：heal / loseHp / maxHp / gainCard / gainRelic / removeCard / nothing
//
// 内容批 P0-1 改动说明：
//   1. 原 12 个事件各补第 3 个选项（统一形态「小代价换小收益」：代价 4~5 血，收益 1 张随机牌）。
//      不许出现「两个选项都纯收益」——价目表约束见 balance.json event_pool.constraints。
//   2. 新增 8 个事件（ev.salt / ev.stitch / ev.ledger / ev.altar / ev.cage / ev.loom / ev.pool / ev.nail），
//      定价一律落在既有价目表内（随机牌 4~6 HP / 稀有牌 5~6 HP / 遗物 8 HP / 纯收益 ≤ +12 HP）。

export const EVENTS = [
  {
    id: 'ev.lamp',
    n: '熄灭的灯',
    text: '灯芯只剩最后一点红。你把手掌贴上灯壁——它想从你身上取走一些东西，才肯再亮一次。',
    choices: [
      { label: '把手按上去', note: '失去 6 点生命，获得 1 张稀有卡牌', apply: { loseHp: 6, gainCard: 'rare', count: 1 } },
      { label: '收回手', note: '什么也不发生', apply: { nothing: true } },
      { label: '只擦亮灯罩', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    id: 'ev.bones',
    n: '骨堆',
    text: '第九层的一半都埋在这里。有些骨头上面还挂着牌。',
    choices: [
      { label: '翻找', note: '获得 1 张随机卡牌，失去 4 点生命', apply: { gainCard: 'random', count: 1, loseHp: 4 } },
      { label: '不碰', note: '回复 12 点生命', apply: { heal: 12 } },
      { label: '只捡不翻', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    id: 'ev.nameless',
    n: '无名的牌',
    text: '一张空白的牌。你盯着它，它开始出现纹路——像是从你的记忆里刻下来的。',
    choices: [
      { label: '刻下去', note: '获得 2 张随机卡牌', apply: { gainCard: 'random', count: 2 } },
      { label: '撕碎它', note: '失去 1 张牌（从牌组中移除）', apply: { removeCard: 1 } },
      { label: '只描名字', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    id: 'ev.well',
    n: '沉水井',
    text: '井下没有水。只有一层缓慢转动的黑，上面浮着几张牌。',
    choices: [
      { label: '伸手捞', note: '获得 1 张稀有卡牌', apply: { gainCard: 'rare', count: 1 } },
      { label: '沉下去', note: '失去 8 点生命，获得 1 件遗物', apply: { loseHp: 8, gainRelic: 1 } },
      { label: '只摸井壁', note: '失去 5 点生命，获得 1 张随机卡牌', apply: { loseHp: 5, gainCard: 'random', count: 1 } },
    ],
  },
  {
    id: 'ev.carving',
    n: '刻痕石',
    text: '石面上密密麻麻都是刻痕。前人在这里记下了他们最强的那一世。',
    choices: [
      { label: '刻上名字', note: '生命上限 +12', apply: { maxHp: 12 } },
      { label: '抄走一段', note: '获得 1 张随机卡牌', apply: { gainCard: 'random', count: 1 } },
      { label: '刮下一层石粉', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    id: 'ev.wormhole',
    n: '蚀虫洞',
    text: '洞壁上全是蠕动的绿。它能吃——也愿意给你一点它在吃的东西。',
    choices: [
      { label: '让它咬一口', note: '失去 10 点生命，获得 2 张稀有卡牌', apply: { loseHp: 10, gainCard: 'rare', count: 2 } },
      { label: '绕开', note: '什么也不发生', apply: { nothing: true } },
      { label: '只尝一口', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },

  // ───────────────────────────────────────────────────────────
  // 阶段 4 / T3：遗迹 6 → 12。
  // 定价口径一律取自 docs/04 §3.2 既有价目表，不新设价格：
  //   1 张随机牌 = 4~6 HP ／ 1 张稀有牌 = 5~6 HP ／ 1 件遗物 = 8 HP
  // 硬约束：不许再增加「两个选项都纯收益」的事件；本批 6 个里有 4 个是「两个选项都要付代价」，
  //   另 2 个保留一个纯收益备选项（对齐 ev.bones，幅度 ≤ +12 HP）。
  // ───────────────────────────────────────────────────────────

  {
    // 取舍轴：稀有度 vs 数量，同一个币种（HP）买不同的东西。
    id: 'ev.anvil',
    n: '断砧',
    text: '铁砧从中间裂开。裂口里嵌着牌——一张是被人反复锻过的好货，两张是还没开刃的毛坯。',
    choices: [
      { label: '取那张好货', note: '失去 5 点生命，获得 1 张稀有卡牌', apply: { loseHp: 5, gainCard: 'rare', count: 1 } },
      { label: '抱走两张毛坯', note: '失去 8 点生命，获得 2 张随机卡牌', apply: { loseHp: 8, gainCard: 'random', count: 2 } },
      { label: '只敲一锤', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：资源 vs 血量，遗物是本作用一口价 8 HP 标过的东西。
    id: 'ev.vein',
    n: '脉棺',
    text: '棺里躺着一排细长的管子，里面还在一鼓一鼓地跳。它既能给你东西，也能给你血。',
    choices: [
      { label: '插进管子', note: '失去 8 点生命，获得 1 件遗物', apply: { loseHp: 8, gainRelic: 1 } },
      { label: '只是借个暖', note: '回复 10 点生命', apply: { heal: 10 } },
      { label: '只抽半管', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：立刻回血 vs 拿一张稀有，备选项幅度对齐 ev.bones（+12）。
    id: 'ev.thirst',
    n: '渴泉',
    text: '泉眼很小，一次只够一个人喝饱，或者灌满一张漂在上面的牌。',
    choices: [
      { label: '喝下去', note: '回复 12 点生命', apply: { heal: 12 } },
      { label: '浇那张牌', note: '失去 6 点生命，获得 1 张稀有卡牌', apply: { loseHp: 6, gainCard: 'rare', count: 1 } },
      { label: '只润润口', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：确定 vs 随机。B 付 4 血换 1 张已知（随机）牌；A 不付血但烧掉一张随机牌。
    id: 'ev.kiln',
    n: '焚窑',
    text: '窑还热着。丢一张牌进去，它会吐出一点你用得上的热气；或者你自己掏血买一张新的。',
    choices: [
      { label: '丢一张进去', note: '随机移除 1 张牌，回复 12 点生命', apply: { removeCard: 1, heal: 12 } },
      { label: '不用它的火', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
      { label: '只凑近看', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：同一口价买不同维度的东西（8 HP 的遗物 vs 5 HP 的稀有牌）。
    id: 'ev.gallows',
    n: '绞架',
    text: '绳套上挂着一件东西，看起来像遗物。架下的土里，半张稀有牌露在外面。两样都不能同时带走。',
    choices: [
      { label: '解下那件东西', note: '失去 8 点生命，获得 1 件遗物', apply: { loseHp: 8, gainRelic: 1 } },
      { label: '抠出那张牌', note: '失去 5 点生命，获得 1 张稀有卡牌', apply: { loseHp: 5, gainCard: 'rare', count: 1 } },
      { label: '只瞟一眼', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 组合包：定价 = 价目表两项之和（遗物 8 + 随机牌 4 = 12），不打折也不加价。
    id: 'ev.marrow',
    n: '髓窟',
    text: '窟壁上两层架子：下层是一排遗物，上层是一摞牌。守着它的是一层薄薄的髓——你得先给它。',
    choices: [
      { label: '两层都要', note: '失去 12 点生命，获得 1 件遗物与 1 张随机卡牌', apply: { loseHp: 12, gainRelic: 1, gainCard: 'random', count: 1 } },
      { label: '只取髓液', note: '回复 8 点生命', apply: { heal: 8 } },
      { label: '只舔一层', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },

  // ───────────────────────────────────────────────────────────
  // 内容批 P0-1：新增 8 个事件（ev.salt / ev.stitch / ev.ledger / ev.altar / ev.cage / ev.loom / ev.pool / ev.nail）。
  // 每个都有「一个可被一句话说出的取舍轴」，且至少有一个选项带代价。
  // ───────────────────────────────────────────────────────────

  {
    // 取舍轴：牌组质量 vs 牌组厚度。B 是本批唯一「删牌 + 回血」的组合，代价是失去一张随机牌。
    id: 'ev.salt',
    n: '盐井',
    text: '井底结着一层白。有人往里撒过盐，也有人往里丢过牌——两样都还在。',
    choices: [
      { label: '捞牌', note: '失去 5 点生命，获得 1 张稀有卡牌', apply: { loseHp: 5, gainCard: 'rare', count: 1 } },
      { label: '刮盐', note: '随机移除 1 张牌，回复 12 点生命', apply: { removeCard: 1, heal: 12 } },
      { label: '舔一口', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：立刻变强 vs 留一条命。全池唯一「不付血就能拿遗物」的入口，代价是压上限。
    id: 'ev.stitch',
    n: '缝口',
    text: '一道缝，缝着的东西还在动。线是牌做的。',
    choices: [
      { label: '拆线', note: '生命上限 −6，获得 1 件遗物', apply: { maxHp: -6, gainRelic: 1 } },
      { label: '补一针', note: '回复 10 点生命', apply: { heal: 10 } },
      { label: '抽走一根线', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：一次拿两张（随机）vs 一次拿一张（稀有），与 ev.anvil 同轴但换币种（付的是牌，不是血）。
    id: 'ev.ledger',
    n: '旧账',
    text: '一叠账页，每一页都写着"欠一世"。最后一页是空白的，留给你。',
    choices: [
      { label: '翻到最后', note: '随机移除 1 张牌，获得 2 张随机卡牌', apply: { removeCard: 1, gainCard: 'random', count: 2 } },
      { label: '只抄一页', note: '失去 5 点生命，获得 1 张稀有卡牌', apply: { loseHp: 5, gainCard: 'rare', count: 1 } },
      { label: '合上它', note: '回复 8 点生命', apply: { heal: 8 } },
    ],
  },
  {
    // 取舍轴：上限 vs 现金。maxHp 是唯一能跨节点生效的资源，定价必须比回血贵。
    id: 'ev.altar',
    n: '矮坛',
    text: '坛口只到膝盖。里面堆着别人没带走的、下一世的本钱。',
    choices: [
      { label: '抓一把', note: '获得 1 张随机卡牌与 1 件遗物，失去 8 点生命', apply: { loseHp: 8, gainCard: 'random', count: 1, gainRelic: 1 } },
      { label: '跪下', note: '生命上限 +10', apply: { maxHp: 10 } },
      { label: '踢翻它', note: '随机移除 1 张牌，获得 1 张稀有卡牌', apply: { removeCard: 1, gainCard: 'rare', count: 1 } },
    ],
  },
  {
    // 取舍轴：稀有牌 vs 删牌回血（与 ev.salt 同构，换名字）。
    id: 'ev.cage',
    n: '铁笼',
    text: '笼子是用断剑焊的。里面关着的不是活物，是几张蜷起来的牌。',
    choices: [
      { label: '撬开', note: '失去 6 点生命，获得 1 张稀有卡牌', apply: { loseHp: 6, gainCard: 'rare', count: 1 } },
      { label: '关回去', note: '随机移除 1 张牌，回复 12 点生命', apply: { removeCard: 1, heal: 12 } },
      { label: '探一手', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：遗物 vs 回血 vs 过牌（量多）。
    id: 'ev.loom',
    n: '织机',
    text: '机杼还在动，梭子里穿着牌的经线。坐上去，它会替你织点什么出来。',
    choices: [
      { label: '拆线', note: '失去 8 点生命，获得 1 件遗物', apply: { loseHp: 8, gainRelic: 1 } },
      { label: '坐着织', note: '回复 10 点生命', apply: { heal: 10 } },
      { label: '抽一缕', note: '失去 5 点生命，获得 2 张随机卡牌', apply: { loseHp: 5, gainCard: 'random', count: 2 } },
    ],
  },
  {
    // 取舍轴：稀有牌 vs 回血 vs 随机牌（与 ev.pool 同构，换名字）。
    id: 'ev.pool',
    n: '静水',
    text: '一洼不动的水，水面平得能当镜子。水底沉着一张牌的影子。',
    choices: [
      { label: '汲起', note: '随机移除 1 张牌，获得 1 张稀有卡牌', apply: { removeCard: 1, gainCard: 'rare', count: 1 } },
      { label: '饮一口', note: '回复 12 点生命', apply: { heal: 12 } },
      { label: '掬一捧', note: '失去 4 点生命，获得 1 张随机卡牌', apply: { loseHp: 4, gainCard: 'random', count: 1 } },
    ],
  },
  {
    // 取舍轴：上限 vs 遗物 vs 回血。
    id: 'ev.nail',
    n: '钉墙',
    text: '一面墙，钉满了牌。有的被钉死，有的只是挂着的，风一吹就晃。',
    choices: [
      { label: '钉进墙', note: '失去 5 点生命，生命上限 +8', apply: { loseHp: 5, maxHp: 8 } },
      { label: '撬下钉子', note: '失去 8 点生命，获得 1 件遗物', apply: { loseHp: 8, gainRelic: 1 } },
      { label: '靠着歇脚', note: '回复 8 点生命', apply: { heal: 8 } },
    ],
  },
];

export const EVENT_MAP = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
