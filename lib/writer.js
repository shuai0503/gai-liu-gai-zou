/* ============================================================
 * lib/writer.js · 第二段调用：观察 + 规则结论 → 理由与文案
 * ------------------------------------------------------------
 * 契约（必须守住）：
 *   输入  视觉观察 + 规则表已经算好的 verdict / price / channels
 *   输出  只有两个字段：{ reason, copywriting }
 *
 * 注意输入里为什么要把价格和渠道传给模型：
 *   不是让它复述，而是让它知道边界——它得知道这单是"卖"，
 *   才能写出"留出讨价空间"这类符合场景的文案。
 *   而 schema 里的 notPattern 会拦住任何价格数字和平台名，
 *   两道闸同时存在。
 * ============================================================ */

import { callJson } from './llm.js'
import { buildWriterPrompt, findBannedWords } from './prompt.js'
import { extractJson, validateWriter } from './schema.js'
import { describeChannels } from './channels.js'

/**
 * @param {object} p
 * @param {object} p.observation 视觉观察
 * @param {object} p.category    规则表品类
 * @param {object} p.decision    judge() 的结果
 * @param {object} p.cfg
 * @param {Function} p.fetchImpl
 * @param {boolean} [p.hasWarranty]
 * @returns {Promise<{reason:string, copywriting:string, ms:number, attempt:number, channelDescs:Array}>}
 */
export async function runWriter({ observation, category, decision, cfg, fetchImpl, hasWarranty = false }) {
  const startedAt = Date.now()

  // 渠道说明在这里就定稿：与最终响应里展示的完全一致，
  // 模型看到的名字 = 用户看到的名字 = 规则表给的名字
  const channelDescs = describeChannels(decision.channels, category, 2)
  const channelNames = channelDescs.map(c => c.name)

  const { system, user } = buildWriterPrompt({
    categoryName: category.name,
    categoryGroup: category.group,
    condition: observation.condition,
    material: observation.material || '',
    damage: observation.damage || '',
    verdict: decision.verdict,
    ruleReason: decision.ruleReason,
    price: decision.price,
    channelNames,
    withWarranty: hasWarranty
  })

  const result = await callJson({
    stage: 'text',
    cfg,
    fetchImpl,
    system,
    user,
    validator: v => validateWriter(v, channelNames),
    extractor: extractJson,
    timeoutMs: cfg.textTimeoutMs,
    failCode: 'TEXT_FAILED'
  })

  let reason = String(result.data.reason || '').trim()
  let copywriting = String(result.data.copywriting || '').trim()

  /* ---------- 兜底清洗 ----------
   * schema 已经拦住了价格与平台名，这里再补三件事：
   *   1. 非 sell 分支不允许有发布文案（避免"捐掉"却给一段卖货文案）
   *   2. 禁用词（智能 / 赋能 / 一站式…）命中就整句替换为规则表的原话，
   *      而不是报错 —— 一个用词不该让用户重试整单
   *   3. reason 为空时退回规则表的原句，保证界面上永远有一句理由
   */
  if (decision.verdict !== 'sell') {
    copywriting = ''
  }

  const banned = findBannedWords(`${reason}\n${copywriting}`)
  if (banned.length > 0) {
    reason = decision.ruleReason || '按内置品类规则表判断。'
    copywriting = ''
  }

  if (!reason) {
    reason = decision.ruleReason || '按内置品类规则表判断。'
  }

  return {
    reason,
    copywriting,
    ms: Date.now() - startedAt,
    attempt: result.attempts,
    channelDescs,
    bannedHit: banned.length > 0 ? banned : null
  }
}

/**
 * 文本模型不可用时的降级产物。
 * 只在 DEGRADE_ON_WRITER_FAILURE=1 时启用：
 * 结论、价格、渠道全部来自规则表，只有文案缺失。
 * 这样即使模型挂了，用户拿到的仍然是一份可信的处置方案。
 */
export function fallbackWriter({ decision, category }) {
  return {
    reason: decision.ruleReason || '按内置品类规则表判断。',
    copywriting: '',
    ms: 0,
    attempt: 0,
    degraded: true,
    channelDescs: describeChannels(decision.channels, category, 2)
  }
}
