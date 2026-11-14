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

/* 规则表原件位置（相对本文件）：server/lib → server → D:\清理 */
const SOURCE_URL = new URL('../../该留该走-品类规则表.js', import.meta.url)
const MIRROR_URL = new URL('./rules-table.js', import.meta.url)

let cached = null

/**
 * 按优先级加载规则表：
 *   1. 上一级原件（本地开发 / 测试 / 源码同仓部署）
 *   2. lib/rules-table.js 镜像（Vercel 独立部署 server 目录时）
 * 任一路径成功即返回，并记录来源，方便 /health 与测试核对。
 */
export async function loadRules() {
  if (cached) return cached

  const attempts = [
    { name: 'source', url: SOURCE_URL },
    { name: 'mirror', url: MIRROR_URL }
  ]

  const errors = []
  for (const attempt of attempts) {
    try {
      const mod = await import(attempt.url.href)
      if (!mod || !Array.isArray(mod.CATEGORIES) || typeof mod.decide !== 'function') {
        throw new Error('模块缺少 CATEGORIES / decide 导出')
      }
      cached = {
        source: attempt.name,
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
      return cached
    } catch (e) {
      errors.push(`${attempt.name}: ${e && e.message ? e.message : e}`)
    }
  }

  throw new AppError('INTERNAL', {
    detail: `规则表加载失败（${errors.join(' | ')}）`
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
