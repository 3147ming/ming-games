// 回牌 规则卡（由 rules/huipai.json 生成，勿手改）
export default {
  "slug": "huipai",
  "name": "回牌",
  "mode": "card",
  "version": 6,
  "players": 3,
  "ai": "本地启发式（无 API）",
  "deck": {
    "decks": 3,
    "total": 156,
    "jokers": 6,
    "withJoker": true
  },
  "deal": {
    "handSize": 10,
    "pile": 126,
    "first": "random",
    " thereafter": "上一局第一个出完者先出"
  },
  "patterns": {
    "basic": [
      "单张",
      "对子",
      "三张",
      "三带一",
      "三带二",
      "顺子(≥5,3→A,不含2与王)",
      "连对(≥3对)",
      "飞机(连续三张+等量单/对)",
      "四带二",
      "炸弹(≥4张同点)",
      "王炸(六张王)"
    ],
    "special": {
      "id": "510k",
      "name": "5-10-K",
      "cards": [
        5,
        10,
        13
      ],
      "count": 3,
      "rule": "三张必须同一手出，不得拆开混入其他牌型"
    }
  },
  "powerLadder": [
    "四炸",
    "异色5-10-K",
    "五炸",
    "方片5-10-K",
    "六炸",
    "梅花5-10-K",
    "七炸",
    "红桃5-10-K",
    "八炸",
    "黑桃5-10-K",
    "九炸",
    "十炸",
    "十一炸",
    "十二炸",
    "王炸(六王)"
  ],
  "suitStrength": {
    "♦": 1,
    "♣": 2,
    "♥": 3,
    "♠": 4
  },
  "suitRule": {
    "threeDifferent": "异色档",
    "threeSame": "对应花色档",
    "twoSameOneDiff": "异色档",
    "sameTierTie": "同档5-10-K相遇视为平手，先出者压住"
  },
  "rankOrder": "3<4<…<A<2<小王<大王",
  "compareRule": "同牌型才可比，跨牌型不可比；炸弹与5-10-K之间只按牌力阶梯比，不用点数比",
  "refill": {
    "winner": 6,
    "others": 3,
    "byRank": [
      6,
      3,
      3
    ]
  },
  "reshuffle": {
    "max": 3,
    "after": "牌堆抽空则弃牌洗回；用尽后不再补给，只用手牌打完"
  },
  "win": "先出完手牌者胜，名次按出完顺序",
  "draw": "无",
  "score": "不计局分（只记名次与洗牌次数）",
  "saveKey": "mg_huipai.v1",
  "edges": [
    "顺子/连对/飞机不得含2与王；顺子最长3→A共12张",
    "飞机带翅膀必须连续三张各带同数量，三带一与三带二不混用",
    "5-10-K三张必须同一手出，不得拆散",
    "炸弹与5-10-K之间只能同档互压，不能用点数比"
  ]
};
