// 《纸上迷城》— 纯数据层
// 只导出常量与查询函数，不含任何 DOM / localStorage / 随机数。
// 口径：一切"内容"都在这里，engine 只负责判定，ui 只负责渲染。

export const META = {
  id: 'paper-maze',
  title: '纸上迷城',
  subtitle: '一座纸做的、写不完的城',
  version: '1.0.0',
  start: 'cell',
};

/** 方向 → 中文标签。x 为特殊出口（暗门）。 */
export const DIRECTIONS = {
  n: '北',
  s: '南',
  e: '东',
  w: '西',
  u: '上',
  d: '下',
  x: '暗',
};

/* ------------------------------------------------------------------ 物品 */

const rawItems = [
  ['lamp', '纸灯', '灯', '你唯一的光源，油只剩薄薄一层。灯罩内侧写着一行小字。', 'tool', true],
  ['flint', '火石', '石', '边缘被反复敲出白痕的燧石。', 'tool', false],
  ['note_torn', '残破纸条', '纸', '揉皱的纸角，只剩半句话：「……灯灭之后，纸会记得。」', 'clue', false],
  ['brush', '秃笔', '笔', '笔锋已经写秃，但还蘸得住墨。', 'tool', false],
  ['ink_bottle', '半瓶墨', '墨', '瓶底沉着化不开的墨块，摇一摇就散。', 'tool', false],
  ['brass_dial', '铜刻度盘', '盘', '一圈细密刻度，正中央却是一个空洞，像是缺了什么。', 'tool', false],
  ['oil_can', '油壶', '油', '壶底浅浅一层灯油，够润开一把锁。', 'tool', false],
  ['bread', '干粮', '粮', '硬得能敲响。纸鼠大概不在乎。', 'tool', false],
  ['iron_rod', '铁钎', '钎', '一根趁手的铁钎，可以撬开翘起的东西。', 'tool', false],
  ['stone_rubbing', '石刻拓片', '拓', '从石碑上拓下的笔画，四组，次序不明。', 'clue', false],
  ['thread', '白丝线', '线', '一小卷白丝线，白得不像这屋里该有的东西。', 'tool', false],
  ['silver_coin', '银币', '币', '边沿被磨平的银币，图案剩下一半。', 'tool', false],
  ['rope', '麻绳', '绳', '发黑的麻绳，放下来够长。', 'tool', false],
  ['diary_page1', '日记残页·一', '页', '「他们把我关在这里，说只要把宅子写完就放我走。可这宅子越写越大。」', 'clue', false],
  ['diary_page2', '日记残页·二', '页', '「井壁是空的。百八尺之下，还有一台灯，照着不该有的东西。」', 'clue', false],
  ['diary_page3', '日记残页·三', '页', '「第七排第九架，放着我的心。谁找到它，谁就得替我在这里写下去。」', 'clue', false],
  ['book_emblems', '纹样册', '册', '一页一种纹样：云纹、水纹、纸纹、心纹。', 'clue', false],
  ['key_mold', '钥匙模', '模', '两片空的模具，合起来是一个钥匙的形状。', 'tool', false],
  ['file_rasp', '锉刀', '锉', '细齿已经磨圆，但还能锉软金属。', 'tool', false],
  ['hook', '铁钩', '钩', '从纹样压板后取下的铁钩，弯得正好。', 'tool', false],
  ['candle', '白蜡烛', '烛', '半截白蜡，没点过。', 'tool', false],
  ['bone_needle', '骨针', '针', '磨得极细的骨针，穿得住丝线。', 'tool', false],
  ['glass_lens', '凸透镜', '镜', '边缘磨得很薄的凸透镜，透光时烫手。', 'tool', false],
  ['music_box_note', '八音盒便签', '签', '便签上只有五个字：「先三，后一，再二。」', 'clue', false],
  ['ledger', '账本', '账', '记着粮、油、灯的开销，最后一页写着「三等分之，称平」。', 'clue', false],
  ['paper_mouse', '纸鼠', '鼠', '一只纸折的老鼠，闻得到干粮。', 'tool', false],
  ['rusty_key', '锈钥匙', '钥', '锈得发红，插得进锁，转不动。', 'tool', false],
  ['paper_scrap', '空白宣纸', '纸', '案上摊着的宣纸，摸得出反复折叠过的折痕。', 'tool', false],
  // ---- 合成产物 ----
  ['oiled_key', '润过油的钥匙', '钥', '锈被灯油泡软，钥匙齿上重新有了光泽。', 'tool', false],
  ['lit_candle', '点燃的蜡烛', '烛', '火苗很小，但很稳。', 'tool', false],
  ['marked_note', '显字纸条', '纸', '火一燎，纸上浮出一句：「灯下有影，影中有人。」', 'clue', false],
  ['grappling_hook', '绳钩', '钩', '麻绳系上铁钩，够得着高处。', 'tool', false],
  ['ink_brush', '蘸墨的笔', '笔', '笔尖吸饱了墨，落笔就是黑的。', 'tool', false],
  ['lens_dial', '聚光刻盘', '盘', '凸透镜嵌进铜盘中央，刻度被光串成一条线。', 'tool', false],
  ['key_blank', '钥匙胚', '胚', '银币在模里压出的粗胚，齿还钝着。', 'tool', false],
  ['curved_key', '复刻钥匙', '钥', '齿纹被锉出弧度，和你见过的锁孔一模一样。', 'tool', false],
  ['diary_part', '日记（残）', '页', '两页接得起来，中间还缺一段。', 'clue', false],
  ['full_diary', '完整日记', '日', '最后一页写着三个数：「灯七，井三，阁九。」', 'clue', false],
  ['secret_map', '手绘地图', '图', '你照着折痕画出的图：地窖北墙，纸最薄的地方有一道门。', 'clue', false],
  ['fed_mouse', '吃饱的纸鼠', '鼠', '纸鼠吃完干粮，开始往地窖北墙跑，跑两步就回头等你。', 'tool', false],
];

export const ITEMS = Object.fromEntries(
  rawItems.map(([id, name, icon, desc, tag, start]) => [
    id,
    { id, name, icon, desc, tag, start: !!start },
  ]),
);

export const START_ITEMS = rawItems.filter((r) => r[5]).map((r) => r[0]);

/* ------------------------------------------------------------------ 线索 */

export const CLUES = {
  clue_lamp: { id: 'clue_lamp', title: '灯罩上的字', text: '灯罩内侧写着：「油尽之前，请离开。」' },
  clue_scratch: { id: 'clue_scratch', title: '门框上的抠痕', text: '纸门框上有一道被指甲反复抠出的痕，高度正好是你握门把的手。' },
  clue_footprints: { id: 'clue_footprints', title: '湿脚印', text: '脚印往北消失在书房门口，又往南折回灶房——有人在两处之间走了很久。' },
  clue_desk: { id: 'clue_desk', title: '反复折叠的宣纸', text: '案上的宣纸什么也没写，折痕却是新压出来的。它被折起来过，而且不止一次。' },
  clue_window: { id: 'clue_window', title: '被封死的窗', text: '窗从里面一层层糊上纸。封窗的人不想看外面，也不想被外面看见。' },
  clue_oil: { id: 'clue_oil', title: '油味', text: '灶房里油味很淡，但确实在——油壶最近被动过。' },
  clue_stele: { id: 'clue_stele', title: '半截石碑', text: '碑上的字被凿掉一半，剩下的笔画还能拓下来。四组笔画，次序被打乱了。' },
  clue_well: { id: 'clue_well', title: '井栏刻痕', text: '井栏内侧刻着一串数字，最前面是「深」，后面被磨平了。' },
  clue_altar: { id: 'clue_altar', title: '焦痕', text: '灯堂中央的地面被烧出一圈焦痕，直径刚好一个人。有人在这里站到灯烧尽。' },
  clue_clothes: { id: 'clue_clothes', title: '旧衣口袋', text: '旧衣口袋里有一小截断掉的笔杆，断口很新。写字的人换过笔。' },
  clue_mouse: { id: 'clue_mouse', title: '纸鼠的路线', text: '纸鼠一直绕着北墙打转，像在找一条只有它知道的缝。' },
  clue_outside: { id: 'clue_outside', title: '门缝外的光', text: '门缝里透进来的光是冷白的，不像屋里任何一盏灯。外面确实有别的世界。' },
  clue_nook: { id: 'clue_nook', title: '被推到底的书', text: '第三排有几本书被推到了最里面，书脊上的灰被蹭掉一条。' },
};

export const CLUE_COUNT = Object.keys(CLUES).length;

/* ------------------------------------------------------------------ 谜题 */

export const PUZZLES = {
  study_drawer: {
    id: 'study_drawer',
    roomId: 'study',
    type: 'code',
    title: '三位数字锁',
    prompt: '抽屉上是一把三位数字转盘锁，转盘边缘有磨损的三个数字位。',
    answer: '739',
    length: 3,
    clueItemIds: ['full_diary'],
    derivation: '完整日记末页写着「灯七，井三，阁九」，即 7-3-9。',
    successText: '三个数字对齐，锁簧弹开。抽屉里躺着一枚铜刻度盘，中央是空的。',
    gives: ['brass_dial'],
    wrongText: '转盘咬住了，纹丝不动。你并不知道这三个数字从哪来。',
  },
  chapel_lamps: {
    id: 'chapel_lamps',
    roomId: 'chapel',
    type: 'sequence',
    title: '四座灯台',
    prompt: '四座灯台各用不同材料做成，需要按顺序点燃。点错一座，火就全灭。',
    options: ['骨', '烛', '纸', '心'],
    answer: ['骨', '烛', '纸', '心'],
    clueItemIds: ['stone_rubbing'],
    derivation: '石碑拓片上的四组笔画，从上到下依次对应骨、烛、纸、心。',
    successText: '四座灯台依次亮起，火光是同一个颜色。北面窄门上的纸闩「啪」地松开。',
    gives: ['candle'],
    wrongText: '点到第二座时火苗倒卷，四座灯台一起灭了。',
  },
  library_word: {
    id: 'library_word',
    roomId: 'library',
    type: 'word',
    title: '书架上的空缺',
    prompt: '被翻过的那排书脊连成一句缺一个字的话：「灯下有（　），（　）中有人」。',
    answer: '影',
    clueItemIds: ['marked_note'],
    derivation: '显字纸条上浮出的原句是「灯下有影，影中有人」，缺的字是「影」。',
    successText: '你把「影」字填进去，书脊发出轻微的错位声，一本书退了出来——里面夹着一页日记。',
    gives: ['diary_page1'],
    wrongText: '书脊纹丝不动。填错字的书架不肯让路。',
  },
  workshop_pattern: {
    id: 'workshop_pattern',
    roomId: 'workshop',
    type: 'pattern',
    title: '纹样压板',
    prompt: '木板上压着四个凹槽，只能嵌进一种纹样。嵌错就等于毁掉这块板。',
    options: ['云纹', '水纹', '纸纹', '心纹'],
    answer: '心纹',
    clueItemIds: ['book_emblems'],
    derivation: '纹样册上写着：匠人只用一种纹样落款——心纹，其余三种是给外人看的。',
    successText: '心纹嵌到底，压板弹开一条缝，里面卡着一枚铁钩。',
    gives: ['hook'],
    wrongText: '凹槽把纹样顶了回来，木板上留下一道新划痕。',
  },
  cellar_weight: {
    id: 'cellar_weight',
    roomId: 'cellar',
    type: 'weight',
    title: '三等分的天平',
    prompt: '天平两边空着，底座刻着「分」的刻度。你得决定把秤砣分成几等份，天平才会落锁。',
    options: ['一', '二', '三', '四'],
    answer: '三',
    clueItemIds: ['ledger'],
    derivation: '账本最后一页写着「三等分之，称平」，秤砣要分三等份。',
    successText: '秤盘沉到底，天平底座弹开，滚出一把锈得发红的钥匙。',
    gives: ['rusty_key'],
    wrongText: '秤杆晃了几下，又回到原来的位置。等份不对。',
  },
  attic_music: {
    id: 'attic_music',
    roomId: 'attic',
    type: 'sequence',
    title: '八音盒的发条',
    prompt: '八音盒侧面有三个齿位，编号 1、2、3。上发条的顺序错了，它就只会空转。',
    options: ['1', '2', '3'],
    answer: ['3', '1', '2'],
    clueItemIds: ['music_box_note'],
    derivation: '八音盒便签上写着「先三，后一，再二」。',
    successText: '发条转到最后一格，八音盒响起半句曲子——盒盖弹开，掉出一张便签。',
    gives: ['music_box_note'],
    wrongText: '齿轮空转了两圈，什么也没发生。顺序不对。',
  },
  well_depth: {
    id: 'well_depth',
    roomId: 'well',
    type: 'code',
    title: '井栏上的数字',
    prompt: '井栏内侧的刻痕只留下「深」字和几个被磨平的数位，并排三位。',
    answer: '108',
    length: 3,
    clueItemIds: ['stone_rubbing'],
    derivation: '石碑拓片上拼得出「井深百八尺」，即 108。',
    successText: '井里传来「咔」的一声，一块井壁砖退进去，露出一个石匣——里面是一页日记。',
    gives: ['diary_page2'],
    wrongText: '井下没有回应。数字不对，机关不会动。',
  },
};

/* ------------------------------------------------------------------ 配方 */

export const RECIPES = [
  { id: 'r_oil_key', in: ['oil_can', 'rusty_key'], out: 'oiled_key', text: '你把壶底那点灯油淋在钥匙上，红锈开始松动，齿纹重新有了光泽。' },
  { id: 'r_light_candle', in: ['candle', 'flint'], out: 'lit_candle', text: '火石擦过两下，烛芯亮了。火苗很小，但很稳。' },
  { id: 'r_mark_note', in: ['note_torn', 'lit_candle'], out: 'marked_note', text: '你举着纸条在火苗上方慢慢过了一遍，纸上浮出字：「灯下有影，影中有人。」' },
  { id: 'r_grapple', in: ['rope', 'hook'], out: 'grappling_hook', text: '麻绳在铁钩上绕了三圈，打了个死结——够得着高处了。' },
  { id: 'r_ink_brush', in: ['brush', 'ink_bottle'], out: 'ink_brush', text: '笔尖吸饱了墨，落笔就是黑的。' },
  { id: 'r_lens_dial', in: ['brass_dial', 'glass_lens'], out: 'lens_dial', text: '凸透镜正好嵌进铜盘中央，刻度被光串成一条线。' },
  { id: 'r_key_blank', in: ['silver_coin', 'key_mold'], out: 'key_blank', text: '银币在模具里被压成粗胚，齿还钝着。' },
  { id: 'r_curved_key', in: ['key_blank', 'file_rasp'], out: 'curved_key', text: '你照着记忆里的锁孔锉下去，齿纹弯出了弧度。' },
  { id: 'r_diary_part', in: ['diary_page1', 'diary_page2'], out: 'diary_part', text: '两页日记接得起来，纸边严丝合缝，中间还缺一段。' },
  { id: 'r_full_diary', in: ['diary_part', 'diary_page3'], out: 'full_diary', text: '三页拼齐。最后一页写着三个数：「灯七，井三，阁九。」' },
  { id: 'r_secret_map', in: ['paper_scrap', 'ink_brush'], out: 'secret_map', keeps: ['ink_brush'], text: '你照着宣纸上的折痕把墨按下去。折痕显成一张图：地窖北墙，纸最薄的地方有一道门。' },
  { id: 'r_fed_mouse', in: ['bread', 'paper_mouse'], out: 'fed_mouse', text: '纸鼠把干粮啃出一个缺口，然后开始往北墙跑，跑两步就回头等你。' },
];

/* ------------------------------------------------------------------ 结局 */

export const ENDINGS = {
  escape: {
    id: 'escape',
    title: '逃出',
    tone: '冷白',
    glyph: '门',
    text: '三联锁同时松开，纸门向内塌了一角。外面的光涌进来，冷得像水。你走出去，身后传来纸张重新合拢的声音——宅子把门补上了，好像从没有人来过。',
  },
  truth: {
    id: 'truth',
    title: '留下真相',
    tone: '墨黑',
    glyph: '墨',
    text: '你把墨滴进池子，把日记、地图和你知道的一切都写进去。纸面开始渗字，密密麻麻爬满整面墙——那是这座宅子里所有被撕掉的内容。你留下来了。从这一夜起，宅子里多了一盏灯。',
  },
  burn: {
    id: 'burn',
    title: '焚城',
    tone: '火红',
    glyph: '火',
    text: '你把烛火按在门缝上。纸是最诚实的东西——烧起来毫不含糊。宅子从门厅开始卷曲、发黑、塌下。你站在火里，第一次看清它的全貌：一座纸做的、写不完的城。',
  },
  hidden: {
    id: 'hidden',
    title: '纸心',
    tone: '暗金',
    glyph: '心',
    text: '你吹灭了灯。黑暗里，纸心自己亮起来，比灯更亮。你听见很远的地方有人在继续写。你伸手，握住了那支笔。',
  },
};

export const ENDING_ORDER = ['escape', 'truth', 'burn', 'hidden'];

/* ------------------------------------------------------------------ 房间 */

const R = (id, name, glyph, desc, hotspots, exits) => [id, { id, name, glyph, desc, hotspots, exits }];

const rawRooms = [
  R(
    'cell',
    '折纸囚室',
    '囚',
    '你在一阵纸张摩擦声里醒来。四面墙是压平的旧纸，泛黄、发脆，接缝处渗出淡淡的墨色。头顶那盏纸灯是这里唯一的暖色，光晕只够照亮三步之内。门在你右手边，纸门框上有一道被指甲反复抠过的痕。',
    [
      { id: 'cell_bed', label: '草席', text: '薄草席被压出一个人形凹坑，凹坑深处硌着一样硬东西。', gives: ['flint'] },
      { id: 'cell_crack', label: '墙缝', text: '两片纸墙的接缝翘起，里面塞着一角揉皱的纸。你把它抽了出来。', gives: ['note_torn'], clue: 'clue_scratch' },
      { id: 'cell_lamp', label: '纸灯', text: '灯罩内侧写着一行小字，灯油只剩薄薄一层。', clue: 'clue_lamp' },
    ],
    [{ dir: 'e', to: 'corridor_ink' }],
  ),
  R(
    'corridor_ink',
    '墨廊',
    '廊',
    '走廊两侧挂着褪色的纸画，画面被墨渍浸透，只看得清轮廓。地板上有两行湿脚印，通向北方，又从南方折回——像是有人反复走了很久。',
    [
      { id: 'cor_painting', label: '纸画', text: '画中人手里握着一支秃笔，笔尖的方向指着北。你伸手把笔取了下来。', gives: ['brush'] },
      { id: 'cor_footprints', label: '湿脚印', text: '脚印走到北端就消失了，脚尖全部朝着书房。', clue: 'clue_footprints' },
    ],
    [
      { dir: 'w', to: 'cell' },
      { dir: 'n', to: 'study' },
      { dir: 's', to: 'kitchen' },
      { dir: 'e', to: 'garden' },
    ],
  ),
  R(
    'study',
    '书房',
    '书',
    '一张巨大的书案占据了大半个房间，案上笔墨纸砚都还在，唯独砚台是干的。墙边立着一排抽屉柜，最上面那个抽屉上有一把三位数字锁。书架贴着后墙，其中一格的颜色比别处深。',
    [
      { id: 'study_desk', label: '书案', text: '案上摊着一张空白的宣纸，纸上什么也没写，折痕却是新压出来的。', gives: ['paper_scrap'], clue: 'clue_desk' },
      { id: 'study_inkstand', label: '笔架', text: '砚台是干的，可笔架底下压着一只小墨瓶——塞得严实，墨还没干透。', gives: ['ink_bottle'] },
      { id: 'study_drawer', label: '数字锁抽屉', puzzle: 'study_drawer' },
      { id: 'study_window', label: '纸窗', text: '窗外没有风景，只有一层层糊上去的纸。有人从里面把窗封死了。', clue: 'clue_window' },
      { id: 'study_shelfdoor', label: '发深的书架格', text: '书架后面是一扇翘起的纸板门，边角已经掀起，但你的手指撬不动它。', requires: { items: ['iron_rod'] }, lockedText: '书架后面有一扇翘起的纸板门。你抠了两下，指甲生疼——得找样硬东西来撬。' },
    ],
    [
      { dir: 's', to: 'corridor_ink' },
      { dir: 'd', to: 'cellar', requires: { items: ['iron_rod'] }, blockedText: '书架后的纸板门翘着一角，你徒手撬不动。' },
    ],
  ),
  R(
    'kitchen',
    '灶房',
    '灶',
    '灶膛里冷着，锅底结了一层黑色的纸灰。横梁上挂着几串风干的纸辣椒，颜色是假的。空气里有油的味道，很淡，但确实在。',
    [
      { id: 'kit_stove', label: '灶台', text: '灶台角落蹲着一只小油壶，壶身还剩下浅浅一层。', gives: ['oil_can'], clue: 'clue_oil' },
      { id: 'kit_jar', label: '米缸', text: '米缸里没有米，只有一块硬得能敲响的干粮。', gives: ['bread'] },
      { id: 'kit_wood', label: '柴堆', text: '柴堆里插着一根铁钎，木柄早已朽烂。', gives: ['iron_rod'] },
    ],
    [
      { dir: 'n', to: 'corridor_ink' },
      { dir: 'w', to: 'well' },
    ],
  ),
  R(
    'well',
    '井台',
    '井',
    '一口石井嵌在地板中央，井沿被磨得发亮。井里没有水声，只有风从很深的地方吹上来，带着墨臭。井壁内侧钉着一排木楔，通向更黑的上面。',
    [
      { id: 'well_rope', label: '井绳', text: '井绳盘在木桩上，麻纤维已经发黑，但还结实。', gives: ['rope'] },
      { id: 'well_carving', label: '井栏刻痕', puzzle: 'well_depth' },
      { id: 'well_wind', label: '井底的风', text: '风里带着墨臭，说明下面还有东西在呼吸——或者说，在写字。', clue: 'clue_well' },
    ],
    [
      { dir: 'e', to: 'kitchen' },
      { dir: 'u', to: 'attic', requires: { items: ['grappling_hook'] }, blockedText: '井壁上的木楔一直通向上方，但第一级离地太高，你得有个能挂住的东西。' },
    ],
  ),
  R(
    'garden',
    '纸庭',
    '庭',
    '一座纸做的庭院。纸树、纸石、纸花，风一吹就沙沙作响。庭院正中立着一块石碑，碑上的字被人凿掉了一半，只剩笔画。',
    [
      { id: 'gar_stele', label: '石碑', text: '你用手掌覆上碑面，指腹沾下薄薄一层黑灰——这是能拓下来的东西。', gives: ['stone_rubbing'], clue: 'clue_stele' },
      { id: 'gar_flowers', label: '纸花', text: '花心里缠着一小卷白丝线，白得不像是这屋里该有的东西。', gives: ['thread'] },
      { id: 'gar_pond', label: '干涸的纸池', text: '池底干裂，裂纹里卡着一枚银币，边沿被磨平了。', gives: ['silver_coin'] },
    ],
    [
      { dir: 'w', to: 'corridor_ink' },
      { dir: 'n', to: 'library' },
      { dir: 'e', to: 'chapel' },
    ],
  ),
  R(
    'library',
    '藏书阁',
    '阁',
    '书架一直顶到看不见的高处，每一本书都是白纸压成的，抽出来才知道里面一个字也没有。只有一排歪斜的书例外——它们是被翻过的。书架前的地面上有一小片颜色更深的地方，像积过墨。',
    [
      { id: 'lib_shelf', label: '歪斜的书架', puzzle: 'library_word' },
      { id: 'lib_nook', label: '书架暗格', gives: ['diary_page3'], requires: { items: ['marked_note'] }, text: '你按着纸条上显出的字推开第三排的书，书架后弹出一个浅格，里面躺着一页日记。', clue: 'clue_nook' },
      { id: 'lib_emblems', label: '纹样册', text: '一本薄册子，每页画着一种纹样：云纹、水纹、纸纹、心纹。', gives: ['book_emblems'] },
      { id: 'lib_inkpool', label: '墨池', ending: { choices: [
        { id: 'write', label: '把知道的一切写进墨池', ending: 'truth', requires: { items: ['full_diary', 'ink_brush', 'secret_map'], clues: 5 } },
      ] } },
    ],
    [
      { dir: 's', to: 'garden' },
      { dir: 'u', to: 'attic', requires: { items: ['grappling_hook'] }, blockedText: '阁楼的入口在高处，没有绳钩你上不去。' },
    ],
  ),
  R(
    'workshop',
    '匠作间',
    '匠',
    '满地的纸屑和木屑。工作台上摆着没做完的东西：一个钥匙模、几根细铁条。墙上钉着一块木板，木板上压着四种纹样的凹槽。',
    [
      { id: 'work_bench', label: '工作台', text: '钥匙模是空的，边缘还带着没修完的毛刺。', gives: ['key_mold'] },
      { id: 'work_tools', label: '工具架', text: '工具架上只剩一把锉刀，细齿已经磨圆。', gives: ['file_rasp'] },
      { id: 'work_board', label: '纹样压板', puzzle: 'workshop_pattern' },
    ],
    [{ dir: 's', to: 'chapel' }],
  ),
  R(
    'chapel',
    '灯堂',
    '灯',
    '四座灯台围成半圆，台座分别用骨、烛、纸、心四种材料做成。中央的地面被烧出一圈焦痕，直径刚好一个人。北墙上开着一道窄门，门缝里透出木屑的气味。',
    [
      { id: 'chap_stands', label: '四座灯台', puzzle: 'chapel_lamps' },
      { id: 'chap_altar', label: '供桌', text: '供桌上没有供品，只有一根磨得极细的骨针。', gives: ['bone_needle'], clue: 'clue_altar' },
    ],
    [
      { dir: 'w', to: 'garden' },
      { dir: 'n', to: 'workshop', requires: { puzzles: ['chapel_lamps'] }, blockedText: '北面窄门被一道纸闩闩住。四座灯台没按顺序亮起之前，纸闩不会松。' },
    ],
  ),
  R(
    'attic',
    '阁楼',
    '阁',
    '屋梁低得直不起腰，灰尘在灯光里浮成一条条光柱。角落里堆着箱子和旧衣，还有一只八音盒，发条上得很紧，却一直没响。',
    [
      { id: 'attic_crate', label: '木箱', text: '箱子里塞满碎纸，最底下压着一枚凸透镜，边缘磨得很薄。', gives: ['glass_lens'] },
      { id: 'attic_musicbox', label: '八音盒', puzzle: 'attic_music' },
      { id: 'attic_clothes', label: '旧衣', text: '口袋里有一小截断掉的笔杆，断口很新。写字的人换过笔。', clue: 'clue_clothes' },
    ],
    [
      { dir: 'd', to: 'library' },
      { dir: 'w', to: 'well' },
    ],
  ),
  R(
    'cellar',
    '地窖',
    '窖',
    '地窖比上面冷。墙是整块的纸浆压成的，摸上去像结了一层壳。地上摆着一架小天平，秤盘里空着。角落里有东西在动——很小，是纸做的。北墙的颜色比别处浅，像被人反复摸过。',
    [
      { id: 'cell_scale', label: '天平', puzzle: 'cellar_weight' },
      { id: 'cell_jars', label: '酒坛', text: '坛子早就空了，其中一个坛口塞着一本薄薄的账本。', gives: ['ledger'] },
      { id: 'cell_mouse', label: '纸鼠', text: '一只纸折的老鼠在墙根打转，闻到干粮的味道就停下来，抬起纸耳朵看你。', gives: ['paper_mouse'], clue: 'clue_mouse' },
    ],
    [
      { dir: 'u', to: 'study' },
      { dir: 'n', to: 'gate', requires: { items: ['oiled_key'] }, blockedText: '通往大门的纸门锁着一把锈锁。钥匙你有了，但它转不动——得先让它转得动。' },
      { dir: 'x', to: 'hidden_heart', label: '北墙的暗门', requires: { items: ['secret_map', 'lens_dial', 'fed_mouse'] }, blockedText: '北墙颜色比别处浅，但你还看不出门在哪里。' },
    ],
  ),
  R(
    'gate',
    '门厅',
    '门',
    '两扇纸做的巨门堵住去路。门上没有把手，只有三个凹槽：一个钥匙孔、一个圆形刻度盘位、一道细长的缝。门缝外透进一线冷白的光——那是外面的光。',
    [
      { id: 'gate_lock', label: '门上的三个凹槽', ending: { choices: [
        { id: 'open', label: '把钥匙、刻盘和光对准三联锁', ending: 'escape', requires: { items: ['oiled_key', 'curved_key', 'lens_dial'] } },
        { id: 'burn', label: '把烛火按在门缝上', ending: 'burn', requires: { items: ['lit_candle'] } },
      ] } },
      { id: 'gate_crack', label: '门缝', text: '门缝里的光是冷白的，不像屋里任何一盏灯。外面确实有别的世界。', clue: 'clue_outside' },
    ],
    [{ dir: 's', to: 'cellar' }],
  ),
  R(
    'hidden_heart',
    '纸心',
    '心',
    '这里不算房间，只有一颗悬在半空的纸心，比人还高，纸面上写满密密麻麻的小字——那是整座宅子里所有被撕掉的内容。灯光照上去，字迹在纸心内部慢慢转。你手里的灯只剩最后一层油。',
    [
      { id: 'heart_surface', label: '纸面上的字', text: '你凑近看，字在动。每一句都是别人写下的、又被撕掉的话。最下面一行写着：「写不完的人，就留在这里。」' },
      { id: 'heart_beat', label: '纸心', ending: { choices: [
        { id: 'blow', label: '吹灭手里的灯', ending: 'hidden', requires: { clues: 8 } },
      ] } },
    ],
    [{ dir: 'u', to: 'cellar' }],
  ),
];

export const ROOMS = Object.fromEntries(rawRooms);

export const ROOM_IDS = Object.keys(ROOMS);

/* ------------------------------------------------------------------ 查询 */

export function getRoom(id) {
  return ROOMS[id] || null;
}

export function getHotspot(roomId, hotspotId) {
  const room = ROOMS[roomId];
  if (!room) return null;
  return room.hotspots.find((h) => h.id === hotspotId) || null;
}

export function findHotspot(hotspotId) {
  for (const id of ROOM_IDS) {
    const h = ROOMS[id].hotspots.find((x) => x.id === hotspotId);
    if (h) return { roomId: id, hotspot: h };
  }
  return null;
}

export function getItem(id) {
  return ITEMS[id] || null;
}

export function recipeFor(a, b) {
  return RECIPES.find((r) => r.in.includes(a) && r.in.includes(b) && a !== b) || null;
}

export function recipesUsing(id) {
  return RECIPES.filter((r) => r.in.includes(id));
}

export function getPuzzle(id) {
  return PUZZLES[id] || null;
}

export function puzzleForHotspot(roomId, hotspotId) {
  const h = getHotspot(roomId, hotspotId);
  if (!h || !h.puzzle) return null;
  return getPuzzle(h.puzzle);
}

export function getEnding(id) {
  return ENDINGS[id] || null;
}

export function getClue(id) {
  return CLUES[id] || null;
}

/** 未被满足的条件说明（供 UI 展示"为什么还不能用"）。 */
export function describeRequirement(req) {
  if (!req) return '';
  const parts = [];
  if (req.items) {
    for (const it of req.items) parts.push(`需要「${ITEMS[it] ? ITEMS[it].name : it}」`);
  }
  if (req.puzzles) {
    for (const p of req.puzzles) parts.push(`需要先解开「${PUZZLES[p] ? PUZZLES[p].title : p}」`);
  }
  if (req.clues) parts.push(`需要至少 ${req.clues} 条线索`);
  return parts.join('，');
}
