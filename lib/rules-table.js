/* ============================================================
 * ⚠️ 自动生成的文件，不要手改
 * ------------------------------------------------------------
 * 源文件：../该留该走-品类规则表.js
 * 生成命令：node scripts/sync-rules.mjs
 *
 * 这里的判定逻辑与源文件逐字节一致，只是为了满足
 * Vercel 函数目录不能引用上级目录的限制。
 * 改动请改源文件，再重新生成；test/run.js 会校验哈希一致性。
 *
 * source-sha256: 73a6b3027caac7f39f08b441c4ce8bc70befdb7555076ba98bb161d7f234de81
 * ============================================================ */

/* ============================================================
 * 该留该走 · 品类规则表 v1.2
 * ------------------------------------------------------------
 * ⚠️ 本文件于 2026-11-14 从 server/lib/rules-table.js 镜像恢复。
 *    工作目录中的源文件意外丢失，镜像内容完整（含品牌分档与价格上限）。
 *
 * 设计原则：
 *   1. 价格是「常见成交价区间」，不是最高价，也不是全新价
 *   2. 价格为 null 表示「二手无流通价值」，强制走 fallback
 *   3. 品牌分三档，默认 brand(1.0)，只有用户选 generic 才打折
 *   4. 超过品类价格上限时等比压缩，不做硬截断
 * ============================================================ */

export const CONDITION_FACTOR = {
  '全新未拆':   1.00,
  '几乎全新':   0.90,
  '九成新':     0.80,
  '八成新':     0.65,
  '七成新':     0.50,
  '有轻微瑕疵': 0.35,
  '有明显破损': 0.15
}

/* ---------- 低价阈值：低于此值不挂平台，直接建议捐赠 ---------- */
export const MIN_SELLABLE = 20   // 元

/* ---------- 破损阈值：成色系数低于此值，不再走出售 ---------- */
export const MIN_SELLABLE_FACTOR = 0.35

/* ---------- 宽区间阈值：高/低比超过此值，说明表太粗，需提示 ---------- */
export const WIDE_RANGE_RATIO = 4

/* ============================================================
 * 品牌档位系数
 * ------------------------------------------------------------
 * 为什么分三档而不是记具体品牌：
 *   1. 视觉模型判断"这是不是名牌"远比判断"这是哪个牌子"准
 *   2. 三档是枚举，可以进 schema 校验，超出就重试
 *   3. 系数是常数，可复现、可解释、可被用户看见
 *
 * ⚠️ 基准是 brand = 1.0，不是 generic。
 *    原因：品类表里的 [low, high] 本来就是"市场上混合牌子的常见成交价"，
 *    它已经包含了杂牌和名牌。如果默认再乘 0.6，等于把基准价整体打六折，
 *    叠加成色系数后只剩市价的 4 折 —— 用户拿去挂价卖不掉。
 *    正确做法：默认用基准价，只有用户明确说"这是杂牌"时才打折。
 *
 * ⚠️ 系数必须由真实市场采样校准，这里只是骨架。
 * ============================================================ */
export const BRAND_TIER_FACTOR = {
  generic: 0.60,   // 杂牌 / 无品牌 / 看不出品牌 —— 用户主动选了才生效
  brand:   1.00,   // 有明确品牌，大众价位 —— 默认档
  premium: 2.50    // 明显高溢价品牌
}

/** 默认档位：用户没指定品牌时用它 */
export const BRAND_DEFAULT_TIER = 'brand'

/** 品牌档位的中文标签（前端展示用） */
export const BRAND_TIER_LABEL = {
  generic: '普通品牌',
  brand: '品牌正品',
  premium: '高端品牌'
}

/* 哪些品类吃品牌系数：不在这张表里的，品牌不影响价格。
 * 依据：材料/做工/功能占主导、品牌溢价弱的国家（被褥、教材、玩具、
 * 瑜伽垫等）不加系数，否则任何折价都会把它们误推进"捐掉"档。
 *
 * ⚠️ 值是该品类的 premium 系数倍率修正值（相对全局 2.5 的倍数）。
 *    依据：数码和奢侈品类的品牌价差远大于家电。
 *    例如耳机杂牌 30、AirPods 800，实际差 26 倍；
 *    而电水壶杂牌 30、大牌 80，只差 2.7 倍。
 */
export const BRAND_SENSITIVE = new Set([
  /* 服饰鞋包：品牌溢价最明显 */
  'down-jacket', 'coat', 'sneakers', 'bag-normal', 'bag-brand', 'backpack',
  /* 数码：型号和品牌直接决定价格 */
  'phone', 'tablet', 'laptop', 'earbuds', 'router',
  /* 小家电：品牌有一定影响，但弱于数码 */
  'kettle', 'microwave', 'hair-dryer', 'rice-cooker', 'desk-lamp',
  /* 运动：碳纤维车架、品牌跑鞋有溢价；哑铃基本没有，已排除 */
  'bicycle'
])

/* 按品类覆盖 premium 系数（不写的用 BRAND_TIER_FACTOR.premium） */
export const BRAND_PREMIUM_OVERRIDE = {
  earbuds:      8.0,   // 杂牌 30 → AirPods 级 800+
  phone:        5.0,   // 千元机 → 旗舰
  tablet:       4.0,
  laptop:       3.5,
  'bag-brand':  6.0,   // 奢侈品包
  'bag-normal': 2.0,
  sneakers:     3.5,   // 杂牌鞋 → 联名/限量
  'down-jacket':3.0,   // 普通 → 北面/始祖鸟
  coat:         2.5
}

/** 取某个品类的实际档位系数 */
export function tierFactorFor(categoryId, tier) {
  if (!BRAND_SENSITIVE.has(categoryId)) return 1
  if (tier === 'premium' && BRAND_PREMIUM_OVERRIDE[categoryId] !== undefined) {
    return BRAND_PREMIUM_OVERRIDE[categoryId]
  }
  return BRAND_TIER_FACTOR[tier] !== undefined ? BRAND_TIER_FACTOR[tier] : BRAND_TIER_FACTOR[BRAND_DEFAULT_TIER]
}

/* ------------------------------------------------------------
 * 绝对价格上限（元）
 * 目的：防止系数叠乘后给出离谱数字。
 * 依据：二手交易里超过这个数的单品，买家一定会走专业渠道
 * （验机/鉴定/担保），不是我们这个工具该给建议的场景。
 * 给出超过上限的数字，等于在不可信的范围里装可信。
 * ---------------------------------------------------------- */
export const PRICE_CEILING = {
  default: 5000,
  'bag-brand': 20000,
  phone: 12000,
  laptop: 15000,
  tablet: 8000
}

export function ceilingFor(categoryId) {
  return PRICE_CEILING[categoryId] || PRICE_CEILING.default
}

/* ============================================================
 * 品类库
 * ============================================================ */
export const CATEGORIES = [

  /* ==================== 服饰鞋包 ==================== */
  {
    id: 'down-jacket',
    name: '羽绒服',
    group: '服饰',
    aliases: ['鸭绒服', '鹅绒服', '派克'],
    price: [120, 180],
    channels: ['闲鱼', '转转'],
    note: '冬季流通快，成色和充绒量影响大'
  },
  {
    id: 'coat',
    name: '大衣 / 风衣',
    group: '服饰',
    aliases: ['毛呢大衣', '外套'],
    price: [60, 150],
    channels: ['闲鱼'],
    note: '版型经典的好卖，流行款掉价快'
  },
  {
    id: 'hoodie-tshirt',
    name: '卫衣 / T恤',
    group: '服饰',
    price: [15, 40],
    channels: ['闲鱼'],
    note: '单个价值低，适合打包出售'
  },
  {
    id: 'jeans',
    name: '牛仔裤',
    group: '服饰',
    price: [25, 60],
    channels: ['闲鱼'],
    note: '经典款有稳定需求'
  },
  {
    id: 'sneakers',
    name: '运动鞋',
    group: '服饰',
    price: [50, 200],
    channels: ['闲鱼', '得物'],
    note: '鞋底磨损是主要折价因素'
  },
  {
    id: 'bag-normal',
    name: '女包（非名牌）',
    group: '服饰',
    price: [30, 80],
    channels: ['闲鱼'],
    note: '五金磨损影响较大'
  },
  {
    /* 从「女包」里分出来的独立品类。
     * 依据：真实照片验证时，一个黄色双肩包被就近匹配到女包，
     * 得出 ¥16–43 —— 而正常双肩包能卖 ¥100–300 以上。
     * 品类粒度不够会导致价格失真，这是必须补的。 */
    id: 'backpack',
    name: '背包 / 双肩包',
    group: '服饰',
    aliases: ['双肩包', '书包', '登山包', '电脑包', '旅行包'],
    price: [40, 180],
    channels: ['闲鱼'],
    note: '通勤/学生款好出手，户外大牌溢价明显'
  },
  {
    id: 'bag-brand',
    name: '名牌包',
    group: '服饰',
    price: [200, 2000],
    channels: ['闲鱼', '得物', '线下奢侈品回收'],
    risk: 'authentication',
    note: '⚠️ 需鉴定，建议走平台验货，不接受私下交易'
  },

  /* ==================== 数码电子 ==================== */
  {
    id: 'phone',
    name: '手机',
    group: '数码',
    price: [300, 2500],
    channels: ['闲鱼', '转转（验机）', '爱回收'],
    risk: 'privacy',
    note: '⚠️ 出前必须抹掉数据；价格跨度大，按机龄和成色分档'
  },
  {
    id: 'tablet',
    name: '平板',
    group: '数码',
    price: [400, 1800],
    channels: ['闲鱼', '转转（验机）'],
    risk: 'privacy',
    note: '屏幕划痕和电池健康是主要折价点'
  },
  {
    id: 'laptop',
    name: '笔记本',
    group: '数码',
    price: [800, 3500],
    channels: ['闲鱼', '转转（验机）', '爱回收'],
    risk: 'privacy',
    note: '⚠️ 出前抹盘；建议当面验机或走验机服务'
  },
  {
    id: 'earbuds',
    name: '耳机',
    group: '数码',
    /* 基准价上调：原来的 [30, 400] 是按"杂牌有线耳机"定的，
     * 但现实里来问的耳机绝大多数是 TWS / 头戴式，
     * 结果 AirPods Pro 这类 premium 档只算出 ¥216 下限，明显不真实。
     * 现基准 [60, 700]，配合 premium ×8 → ¥480–5600，落在合理区间。 */
    price: [60, 700],
    channels: ['闲鱼'],
    risk: 'e_waste',
    note: '建议先恢复出厂设置；电池衰减是主要折价点'
  },
  {
    id: 'router',
    name: '路由器',
    group: '数码',
    price: [30, 80],
    channels: ['闲鱼'],
    risk: 'e_waste',
    note: '出前恢复出厂设置；老机型流通慢，可考虑回收'
  },
  {
    id: 'keyboard-mouse',
    name: '键鼠',
    group: '数码',
    price: [40, 150],
    channels: ['闲鱼'],
    note: '机械键盘保值度高于薄膜'
  },
  {
    id: 'powerbank',
    name: '充电宝',
    group: '数码',
    price: null,
    fallback: 'recycle',
    channels: ['小区有害垃圾点', '品牌门店回收'],
    risk: 'battery',
    note: '⚠️ 锂电池鼓包有起火风险，不出二手，直接回收'
  },
  {
    id: 'cable-charger',
    name: '数据线 / 充电器',
    group: '数码',
    price: null,
    fallback: 'recycle',
    channels: ['小区有害垃圾点', '电子回收箱'],
    risk: 'battery',
    note: '价值极低且多为电子垃圾'
  },
  {
    id: 'charger-large',
    name: '充电器（笔记本电源）',
    group: '数码',
    price: [30, 80],
    channels: ['闲鱼'],
    note: '原装电源有明确需求'
  },

  /* ==================== 家电 ==================== */
  {
    id: 'kettle',
    name: '电水壶',
    group: '家电',
    price: [20, 50],
    channels: ['闲鱼'],
    note: '水垢影响观感，但功能件决定价值'
  },
  {
    id: 'microwave',
    name: '微波炉',
    group: '家电',
    price: [50, 150],
    channels: ['闲鱼（同城自提）'],
    note: '大件，只走同城，运费会吃掉利润'
  },
  {
    id: 'hair-dryer',
    name: '吹风机',
    group: '家电',
    price: [30, 100],
    channels: ['闲鱼'],
    note: '品牌溢价明显'
  },
  {
    id: 'rice-cooker',
    name: '电饭煲',
    group: '家电',
    price: [40, 120],
    channels: ['闲鱼（同城自提）'],
    note: '内胆涂层磨损是主要折价点'
  },
  {
    id: 'desk-lamp',
    name: '台灯',
    group: '家电',
    price: [25, 70],
    channels: ['闲鱼'],
    note: '护眼类溢价高'
  },

  /* ==================== 母婴儿童 ==================== */
  {
    id: 'kid-book',
    name: '儿童绘本',
    group: '母婴',
    price: [5, 15],
    channels: ['多抓鱼', '社区图书馆', '闲鱼（打包）'],
    note: '单本价值低，适合打包或捐赠'
  },
  {
    id: 'kid-clothes',
    name: '童装',
    group: '母婴',
    price: [10, 30],
    channels: ['闲鱼（打包）', '白鲸鱼（捐赠）'],
    note: '孩子长得快，成色普遍好'
  },
  {
    id: 'stroller',
    name: '婴儿车',
    group: '母婴',
    price: [100, 400],
    channels: ['闲鱼（同城自提）'],
    risk: 'safety',
    note: '⚠️ 需确认安全标准有效期内，结构件无隐患'
  },
  {
    id: 'toy-plastic',
    name: '塑料玩具',
    group: '母婴',
    price: [10, 40],
    channels: ['闲鱼（打包）', '社区捐赠'],
    note: '含小零件的需注明适龄'
  },

  /* ==================== 图书音像 ==================== */
  {
    id: 'book-fiction',
    name: '小说 / 文学书',
    group: '图书',
    price: [5, 20],
    channels: ['多抓鱼', '闲鱼'],
    note: '品相和版次影响大，畅销书好卖'
  },
  {
    id: 'book-textbook',
    name: '教材 / 教辅',
    group: '图书',
    price: null,
    fallback: 'donate',
    channels: ['毕业季回收', '闲鱼（考研类）', '捐赠'],
    note: '普通教材无二手价值，考研/考证类例外'
  },

  /* ==================== 运动户外 ==================== */
  {
    id: 'yoga-mat',
    name: '瑜伽垫',
    group: '运动',
    price: [15, 40],
    channels: ['闲鱼'],
    note: '卫生敏感，有使用痕迹的难卖'
  },
  {
    id: 'fitness-equip',
    name: '哑铃 / 健身器材',
    group: '运动',
    price: [30, 150],
    channels: ['闲鱼（同城自提）'],
    note: '重量大，只走同城，运费超过货值'
  },
  {
    id: 'bicycle',
    name: '自行车',
    group: '运动',
    price: [200, 800],
    channels: ['闲鱼（同城自提）'],
    risk: 'safety',
    note: '⚠️ 刹车轮胎需检查；建议当面试骑'
  },

  /* ==================== 家居床品 ==================== */
  {
    id: 'bedding',
    name: '被褥 / 床品',
    group: '家居',
    price: [20, 60],
    channels: ['闲鱼', '捐赠（需清洗消毒）'],
    note: '卫生敏感，成色要求高'
  },

  /* ==================== 特殊品类（不走价格逻辑） ==================== */
  {
    id: 'medicine',
    name: '药品',
    group: '特殊',
    price: null,
    fallback: 'recycle',
    channels: ['药店回收点', '社区卫生中心'],
    risk: 'medical',
    note: '⚠️ 严禁转卖或捐赠；过期药属有害垃圾，交药店回收点'
  },
  {
    id: 'documents',
    name: '证件 / 票据',
    group: '特殊',
    price: null,
    fallback: 'keep',
    channels: [],
    risk: 'privacy',
    note: '⚠️ 不建议外流；作废件用碎纸机处理'
  },
  {
    id: 'cosmetics',
    name: '化妆品（未开封）',
    group: '特殊',
    price: null,
    fallback: 'keep',
    channels: [],
    risk: 'expiry',
    note: '⚠️ 二次流通有卫生与合规风险，建议自用或送熟人'
  }
]

/* ============================================================
 * 判定引擎
 * ------------------------------------------------------------
 * 顺序很重要：硬风险 → 无价格 fallback → 成色太差 → 低价 → 保修 → 出售
 * ============================================================ */

/* 硬拦截：这些品类不论值多少钱、成色多好，都不走二手。
 * 判断标准是「二次流通有真实的安全或法律风险」，不是「含电池」。
 * 注意 battery 只留给真正有起火/渗漏风险的品类（充电宝、线材），
 * 路由器、耳机这类含少量电池但可正常交易的不在此列。 */
const HARD_RECYCLE_RISK = ['battery', 'medical']

/* 软提醒：可正常交易，但需要附加处置提示（恢复出厂、抹数据等） */
const SOFT_RISK_NOTE = {
  e_waste: '出前记得恢复出厂设置、退出账号',
  privacy: '出前记得抹掉数据',
  safety: '交付前检查一下安全性',
  authentication: '建议走平台验货，别私下交易',
  expiry: '注意保质期'
}

export function decide(categoryId, opts = {}) {
  const { condition = '八成新', hasWarranty = false, brandTier = null } = opts
  const cat = CATEGORIES.find(c => c.id === categoryId)

  if (!cat) {
    return { verdict: 'unknown', reason: '品类未收录，建议换角度重拍' }
  }

  /* 品牌系数只对本表内的品类生效。
   * 未指定时用 BRAND_DEFAULT_TIER（brand=1.0，即基准价），
   * 而不是 generic —— 否则基准价会被整体打六折。 */
  const tier = BRAND_TIER_FACTOR[brandTier] !== undefined ? brandTier : BRAND_DEFAULT_TIER
  const tierFactor = tierFactorFor(cat.id, tier)
  const brandApplied = BRAND_SENSITIVE.has(cat.id)
  const brandUnspecified = !brandTier

  /* 1. 硬风险：含电池/医药 → 强制回收 */
  if (cat.risk && HARD_RECYCLE_RISK.includes(cat.risk)) {
    return {
      verdict: 'recycle',
      category: cat,
      reason: cat.note.replace(/^⚠️\s*/, ''),
      channels: cat.channels
    }
  }

  /* 2. 无价格 → 走 fallback */
  if (cat.price === null) {
    const map = {
      keep:    '这类东西不建议外流，自己留着处理更稳妥。',
      donate:  '二手卖不上价，捐掉更快。',
      recycle: '不能直接扔，需要送专门回收点。'
    }
    return {
      verdict: cat.fallback,
      category: cat,
      reason: map[cat.fallback],
      channels: cat.channels
    }
  }

  /* 3. 价格 × 成色系数 × 品牌档位系数
   * 顺序：先按品类基准价，再乘成色，最后乘品牌。
   * 品牌放在最后是因为它对区间两端是同比例缩放，
   * 不会把 low 推到 high 之上。 */
  const f = CONDITION_FACTOR[condition] ?? 0.65
  const ceiling = ceilingFor(cat.id)
  const rawLow = Math.max(1, Math.round(cat.price[0] * f * tierFactor))
  const rawHigh = Math.round(cat.price[1] * f * tierFactor)

  /* 超过上限时整体等比压缩，而不是硬截断 ——
   * 硬截断会造出 "¥5000–5000" 这种没有信息的假精确区间。 */
  const capped = rawHigh > ceiling
  const scale = capped ? ceiling / rawHigh : 1
  const low = Math.max(1, Math.round(rawLow * scale))
  const high = capped ? ceiling : Math.max(low + 5, rawHigh)

  /* 品牌相关元信息，供前端展示与"为什么这么判断"使用 */
  const brandMeta = {
    brandApplied,
    brandTier: brandApplied ? tier : null,
    brandUnknown: brandUnspecified,
    brandFactor: tierFactor,
    capped
  }

  /* 3.5 成色太差 → 不再建议出售
   * 但留一个"值钱的还是能卖"的口子：高值品类（残值仍 >= 3×最低可售额）
   * 即便判成破损，也仍有二手价值，不该一刀切推进捐赠。
   * 依据：视觉模型极易把"使用痕迹"误判成"明显破损"，
   * 一刀切会让整个产品滑向只捐不卖，核心功能失效。 */
  if (f < MIN_SELLABLE_FACTOR) {
    const worthRepairing = high >= MIN_SELLABLE * 3
    if (!worthRepairing) {
      return {
        verdict: 'donate',
        category: cat,
        price: null,
        ...brandMeta,
        reason: `这个成色挂平台也不好卖，捐掉或回收更省事。`,
        channels: ['社区捐赠', '白鲸鱼（回收）', '小区旧衣回收箱']
      }
    }
    /* 高值+破损：仍给出售建议，但把瑕疵明确标出来，不隐瞒 */
    return {
      verdict: 'sell',
      category: cat,
      price: [low, high],
      wide: false,
      damaged: true,
      ...brandMeta,
      reason: `有明显瑕疵，但这类东西还有人收，如实描述能卖掉。`,
      channels: cat.channels
    }
  }

  /* 4. 低价阈值：卖不上价 → 捐赠 */
  if (high < MIN_SELLABLE) {
    return {
      verdict: 'donate',
      category: cat,
      price: null,
      ...brandMeta,
      reason: `这类二手成交价大约 ${low}–${high} 元，挂平台的时间成本高于收益。`,
      channels: ['多抓鱼', '社区捐赠', '白鲸鱼（回收）']
    }
  }

  /* 4.5 保修期内且残值不高 → 建议留 */
  if (hasWarranty && high < 100) {
    return {
      verdict: 'keep',
      category: cat,
      price: [low, high],
      ...brandMeta,
      reason: '还在保修期内，送人就没法送修了。',
      channels: []
    }
  }

  /* 5. 正常出售 */
  return {
    verdict: 'sell',
    category: cat,
    price: [low, high],
    /* 宽区间：用"品牌缩放后的实际区间"判断，而不是品类原始区间。
     * 因为品牌一旦明确，区间往往就收窄了，不该再提示"跨度大"。 */
    wide: !brandApplied && (cat.price[1] / Math.max(1, cat.price[0]) > WIDE_RANGE_RATIO),
    ...brandMeta,
    reason: '还能用，二手有明确买家。',
    /* 软风险提示：可交易但需要提醒（恢复出厂、抹数据等） */
    tip: cat.risk ? (SOFT_RISK_NOTE[cat.risk] || '') : '',
    channels: cat.channels
  }
}

/* ============================================================
 * 自测：控制台跑一遍看覆盖是否合理
 * ============================================================ */
export function selfCheck() {
  const tally = { keep: 0, sell: 0, donate: 0, recycle: 0, unknown: 0 }
  CATEGORIES.forEach(c => {
    const r = decide(c.id, { condition: '八成新' })
    tally[r.verdict] = (tally[r.verdict] || 0) + 1
  })
  return { total: CATEGORIES.length, tally }
}
