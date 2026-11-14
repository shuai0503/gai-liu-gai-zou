/* ============================================================
 * lib/vision.js · 第一段调用：图片 → 结构化观察
 * ------------------------------------------------------------
 * 契约（必须守住）：
 *   输入  图片（data URL）
 *   输出  只有「观察」，没有「结论」：
 *         { recognized, categoryId, categoryName, condition, material, damage, confidence }
 *
 * 这里不产生价格、不产生渠道、不产生处置结论。
 * 判定交给 lib/rules.js 的纯函数 judge()。
 * ============================================================ */

import { callJson } from './llm.js'
import { buildVisionPrompt } from './prompt.js'
import {
  OBSERVATION_SCHEMA,
  extractJson,
  validateObservation
} from './schema.js'
import { conditionEnum, resolveCategory, categoryPromptList } from './rules.js'

/**
 * @param {object} p
 * @param {object} p.image    normalizeImage() 的产物
 * @param {object} p.cfg
 * @param {Function} p.fetchImpl
 * @param {Array} p.categories 规则表 CATEGORIES
 * @returns {Promise<{observation:object, resolved:object|null, via:string|null, ms:number, attempt:number}>}
 */
export async function runVision({ image, cfg, fetchImpl, categories }) {
  const startedAt = Date.now()

  const conditionList = conditionEnum()
  // 品类清单由 rules.js 统一生成，避免 prompt 与匹配逻辑各写一份
  const categoryListText = categoryPromptList(categories)

  const { system, user } = buildVisionPrompt({
    categories,
    conditionList,
    categoryListText
  })

  // 视觉能力靠多模态消息：OpenAI 兼容格式的 image_url
  const result = await callJson({
    stage: 'vision',
    cfg,
    fetchImpl,
    system,
    user: [
      { type: 'text', text: user },
      { type: 'image_url', image_url: { url: image.dataUrl, detail: 'low' } }
    ],
    validator: validateObservation,
    extractor: extractJson,
    timeoutMs: cfg.visionTimeoutMs,
    failCode: 'VISION_FAILED'
  })

  const obs = result.data
  const ms = Date.now() - startedAt

  /* ---------- 1. 模型自己说没认出来 ---------- */
  if (!obs.recognized) {
    return { observation: obs, resolved: null, via: null, ms, attempt: result.attempts, reason: 'model_not_recognized' }
  }

  /* ---------- 2. 置信度低 → 按没认出来处理 ----------
   * 规格 E1 明确要求「绝对不要给一个猜的答案」，
   * 所以 low 不进入后续任何步骤。 */
  if (cfg.lowConfidenceAsUnknown && obs.confidence === 'low') {
    return { observation: obs, resolved: null, via: null, ms, attempt: result.attempts, reason: 'low_confidence' }
  }

  /* ---------- 3. 品类必须在规则表里找得到 ----------
   * 模型可能返回中文名（羽绒服）而不是 id（down-jacket），
   * 用 name / aliases 做模糊匹配；还是匹配不上 → unknown。
   * 这一步是「模型说不清楚就闭嘴」的代码实现。 */
  const { cat, via } = resolveCategory(categories, obs.categoryId || obs.categoryName)
  if (!cat) {
    return {
      observation: obs, resolved: null, via: null, ms, attempt: result.attempts,
      reason: 'category_not_in_table',
      /* 把模型说的品类名带出去，便于诊断与前端提示 */
      guessed: obs.categoryName || obs.categoryId || ''
    }
  }

  /* ---------- 4. 成色必须落在规则表的枚举里 ----------
   * 模型如果返回了"挺新的"这种，不能直接喂给 decide()，
   * 否则 CONDITION_FACTOR 会 fallback 到 0.65，等于凭空造了个数字。 */
  const enumList = conditionList
  const condition = enumList.includes(obs.condition) ? obs.condition : '八成新'

  /* ---------- 5. 品牌档位也必须是合法枚举 ----------
   * 和成色同理：非法值不能透传，否则价格系数会 fallback。
   * 这里选择回退到 generic（保守价），而不是 brand —— 报低比报高安全。 */
  const TIERS = ['generic', 'brand', 'premium']
  const brandTier = TIERS.includes(obs.brandTier) ? obs.brandTier : 'generic'

  return {
    observation: { ...obs, condition, brandTier },
    resolved: cat,
    via,
    ms,
    attempt: result.attempts,
    reason: null
  }
}

/** 供测试/诊断：暴露 schema 便于断言 */
export { OBSERVATION_SCHEMA }

/** 把视觉结果落成审计用的元信息（不含图片内容、不含 key） */
export function visionMeta(v) {
  return {
    ms: v.ms,
    attempts: v.attempt,
    confidence: v.observation ? v.observation.confidence : null,
    categoryVia: v.via || null,
    rejected: v.reason || null
  }
}
