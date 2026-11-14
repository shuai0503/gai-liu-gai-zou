/* ============================================================
 * lib/rules.js · 规则表接入层（本项目最关键的边界）
 * ------------------------------------------------------------
 * 「模型 vs 规则表」的分工在这里被固化成一个接口：
 *
 *     judge(categoryId, condition) → { verdict, price, channels, wide, ruleReason }
 *
 * 全项目只有这一个函数能产生价格和渠道，它内部是纯函数查表，
 * 没有网络调用、没有随机数、没有模型参与。
 * 模型永远拿不到「生成价格」的机会 —— 它的 schema 里就没有价格字段。
 *
 * 引入方式（详见 README）：
 *   1) 本地/测试：直接 import 上一级的「该留该走-品类规则表.js」原件，
 *      保证测的就是线上那份，不是抄来的副本。
 *   2) 部署/Vercel：函数目录内不允许引上级目录，所以由
 *      scripts/sync-rules.mjs 生成 lib/rules-table.js 镜像。
 *   两者内容受 test 里的哈希一致性检查保护，镜像过期会直接测试失败。
 * ============================================================ */

import { AppError } from './errors.js'

/* ============================================================
 * 规则表加载
 * ------------------------------------------------------------
 * ⚠️ 这里踩过一个坑，记下来防止再犯：
 *   最初用 `new URL('../../xxx.js', import.meta.url)` 拼路径，
 *   本地和 Vercel 都正常，但 **Netlify 的 esbuild 打包后
 *   import.meta.url 可能为 undefined**，于是 new URL 抛
 *   "Invalid URL"，整个函数 502。
 *
 * 现在改成两级：
 *   1) 静态 import 镜像文件（打包器能直接内联，最可靠）
 *   2) 如果镜像缺失，再退回动态路径加载（本地开发用）
 *
 * 镜像由 scripts/sync-rules.mjs 从根目录源文件生成，
 * 内容逐字节一致，测试里校验 SHA-256 防分叉。
 * ============================================================ */

/* 静态导入镜像：打包友好，Netlify / Vercel / 本地都走这条 */
import * as MIRROR_MOD from './rules-table.js'

let cached = null

/** 把一个模块对象规整成统一的 rules 结构 */
function normalize(mod, sourceName) {
  if (!mod || !Array.isArray(mod.CATEGORIES) || typeof mod.decide !== 'function') {
    throw new Error('模块缺少 CATEGORIES / decide 导出')
  }
  return {
    source: sourceName,
    CATEGORIES: mod.CATEGORIES,
    CONDITION_FACTOR: mod.CONDITION_FACTOR,
    MIN_SELLABLE: mod.MIN_SELLABLE,
    MIN_SELLABLE_FACTOR: mod.MIN_SELLABLE_FACTOR,
    WIDE_RANGE_RATIO: mod.WIDE_RANGE_RATIO,
    BRAND_TIER_FACTOR: mod.BRAND_TIER_FACTOR,
    BRAND_TIER_LABEL: mod.BRAND_TIER_LABEL,
    BRAND_SENSITIVE: mod.BRAND_SENSITIVE,
    decide: mod.decide,
    selfCheck: mod.selfCheck
  }
}

/**
 * 加载规则表。
 * 优先静态镜像；只有镜像不可用时才尝试动态加载源文件。
 */
export async function loadRules() {
  if (cached) return cached

  /* 第一优先：静态导入的镜像（打包环境最可靠） */
  try {
    cached = normalize(MIRROR_MOD, 'mirror')
    return cached
  } catch (e) {
    /* 落到动态加载 */
  }

  /* 第二优先：动态加载源文件（仅本地开发时可能用到）。
   * 用 try 包住 import.meta.url，防止打包环境下它是 undefined 直接抛错。 */
  const errors = []
  try {
    const metaUrl = import.meta && import.meta.url
    if (metaUrl) {
      const sourceUrl = new URL('../../该留该走-品类规则表.js', metaUrl)
      const mod = await import(sourceUrl.href)
      cached = normalize(mod, 'source')
      return cached
    } else {
      errors.push('source: import.meta.url 不可用')
    }
  } catch (e) {
    errors.push('source: ' + (e && e.message ? e.message : e))
  }

  try {
    const metaUrl = import.meta && import.meta.url
    if (metaUrl) {
      const mirrorUrl = new URL('./rules-table.js', metaUrl)
      const mod = await import(mirrorUrl.href)
      cached = normalize(mod, 'mirror-dynamic')
      return cached
    }
  } catch (e) {
    errors.push('mirror-dynamic: ' + (e && e.message ? e.message : e))
  }

  throw new AppError('INTERNAL', {
    detail: `规则表加载失败（${errors.join(' | ') || '未知原因'}）`
  })
}

/* ============================================================
 * 品类匹配
 * ------------------------------------------------------------
 * 视觉模型可能返回 id（down-jacket），也可能返回中文名（羽绒服），
 * 甚至返回"鸭绒服/派克"这类别名。三级匹配，匹配不上才算 unknown。
 * ============================================================ */

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s·・、/／\\|（）()【】\[\]{}]/g, '')
    .replace(/[，,。.]/g, '')
}

/** 建索引：id / name / name 拆分 / aliases 全部映射到品类 */
function buildIndex(categories) {
  const index = new Map()
  const put = (key, cat, weight) => {
    const k = norm(key)
    if (!k) return
    const prev = index.get(k)
    // 权重高的先占位，避免别名覆盖正式名
    if (!prev || prev.weight < weight) index.set(k, { cat, weight })
  }

  for (const cat of categories) {
    put(cat.id, cat, 100)
    put(cat.name, cat, 90)
    // 「大衣 / 风衣」这类名称拆开也要能命中
    for (const part of String(cat.name).split(/[\/／、]/)) put(part, cat, 80)
    for (const alias of cat.aliases || []) put(alias, cat, 70)
  }
  return index
}

/**
 * 把模型给的品类串解析成规则表里的品类对象。
 * @returns {{cat: object, via: 'exact'|'contains'|null}}
 */
export function resolveCategory(categories, raw) {
  const input = String(raw || '').trim()
  if (!input) return { cat: null, via: null }

  const index = buildIndex(categories)

  // 1) 精确匹配（含 id / 名称 / 拆分名 / 别名）
  const exact = index.get(norm(input))
  if (exact) return { cat: exact.cat, via: 'exact' }

  // 2) 包含匹配：模型多写了修饰词（"黑色羽绒服"、"iPhone 手机"）也能救回来
  //    优先匹配更长的键，避免"包"吃掉"名牌包"
  const nInput = norm(input)
  let best = null
  for (const [key, entry] of index) {
    if (key.length < 2) continue
    if (nInput.includes(key) || key.includes(nInput)) {
      const score = (entry.weight * 100) + key.length
      if (!best || score > best.score) best = { score, cat: entry.cat }
    }
  }
  if (best) return { cat: best.cat, via: 'contains' }

  return { cat: null, via: null }
}

/* ============================================================
 * judge：唯一产出价格与渠道的入口
 * ------------------------------------------------------------
 * 这是「责任可信」维度的代码证据：价格只有这一条路，
 * 而且这条路里没有模型。
 * ============================================================ */
export function judge(categoryId, { condition = '八成新', hasWarranty = false, brandTier = null } = {}) {
  const rules = cached
  if (!rules) throw new AppError('INTERNAL', { detail: '规则表尚未加载' })
  const result = rules.decide(categoryId, { condition, hasWarranty, brandTier })
  return {
    verdict: result.verdict,
    category: result.category || null,
    price: Array.isArray(result.price) ? result.price : null,
    wide: Boolean(result.wide),
    /* 高值+破损仍建议出售时标记出来，前端要如实提示 */
    damaged: Boolean(result.damaged),
    /* 软风险提示（恢复出厂、抹数据等），可为空 */
    tip: result.tip || '',
    /* 品牌分档信息：是否应用、用的哪档、系数多少 */
    brandApplied: Boolean(result.brandApplied),
    brandTier: result.brandTier || null,
    brandUnknown: Boolean(result.brandUnknown),
    brandFactor: result.brandFactor || 1,
    ruleReason: result.reason || '',
    channels: Array.isArray(result.channels) ? result.channels : []
  }
}

/** 品牌档位标签与系数，供前端与 prompt 共用（来源仍是规则表） */
export function brandInfo() {
  const rules = cached
  if (!rules) throw new AppError('INTERNAL', { detail: '规则表尚未加载' })
  return {
    factors: rules.BRAND_TIER_FACTOR || {},
    labels: rules.BRAND_TIER_LABEL || {},
    sensitive: rules.BRAND_SENSITIVE ? [...rules.BRAND_SENSITIVE] : []
  }
}

/** 某个品类是否吃品牌系数 */
export function isBrandSensitive(categoryId) {
  const rules = cached
  if (!rules) throw new AppError('INTERNAL', { detail: '规则表尚未加载' })
  return rules.BRAND_SENSITIVE ? rules.BRAND_SENSITIVE.has(categoryId) : false
}

/** 成色枚举（供 schema 与 prompt 共用，来源仍是规则表，不另写一份） */
export function conditionEnum() {
  const rules = cached
  if (!rules) throw new AppError('INTERNAL', { detail: '规则表尚未加载' })
  return Object.keys(rules.CONDITION_FACTOR)
}

/** 给 prompt 用的品类白名单（id + 中文名 + 别名） */
export function categoryPromptList(categories) {
  return categories
    .map(c => {
      const alias = (c.aliases || []).length ? `（别名：${(c.aliases || []).join('、')}）` : ''
      return `${c.id} = ${c.name}${alias}`
    })
    .join('\n')
}

/** 规则表自检，测试与 /health 用 */
export function ruleSelfCheck() {
  const rules = cached
  if (!rules) throw new AppError('INTERNAL', { detail: '规则表尚未加载' })
  return rules.selfCheck()
}
