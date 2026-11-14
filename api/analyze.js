/* ============================================================
 * api/analyze.js · POST /api/analyze
 * ------------------------------------------------------------
 * 主接口。整个产品的两段式调用在这里串起来：
 *
 *   图片 ──▶ ①视觉模型 ──▶ { categoryId, condition, material, confidence }
 *                │
 *                ├─ 认不出 / 品类不在表里 ──▶ 直接返回 unknown（不进第二段）
 *                │
 *                ▼
 *           ②规则表 judge()  ← 唯一的「价格 / 渠道 / 处置结论」来源
 *                │              （纯函数，无网络，可复现）
 *                ▼
 *           ③文本模型 ──▶ { reason, copywriting }
 *                │
 *                ▼
 *            组装响应
 *
 * 「模型 vs 规则表」的分工在代码里的落实方式：
 *   · lib/schema.js 的 OBSERVATION_SCHEMA 里没有 price / channels 字段
 *     → 视觉模型即使想给价格，也没有槽位可以放
 *   · lib/schema.js 的 WRITER 校验用 notPattern 拦截价格数字和平台名
 *     → 文本模型即使想给价格，也会被判不合格并重试
 *   · lib/rules.js 的 judge() 是全项目唯一能返回 price / channels 的函数
 *     → 价格只能来自查表
 * 三道闸共同保证了「模型不输出价格和渠道」这条立论。
 * ============================================================ */

import { AppError, toAppError } from '../lib/errors.js'
import { buildDeps } from '../lib/env.js'
import { sendError, sendJson, handlePreflight } from '../lib/http.js'
import { extractImage } from '../lib/upload.js'
import { loadRules, judge } from '../lib/rules.js'
import { runVision, visionMeta } from '../lib/vision.js'
import { runWriter, fallbackWriter } from '../lib/writer.js'

/**
 * 组装成功响应。
 * 字段与原型 DATA 对象、以及规格 5.2 的建议结构保持一致。
 */
function buildSuccess({ observation, category, decision, writer, meta }) {
  return {
    ok: true,
    verdict: decision.verdict,
    category: {
      id: category.id,
      name: category.name,
      group: category.group
    },
    condition: observation.condition,
    material: observation.material || '',
    damage: observation.damage || '',
    reason: writer.reason,
    // ⚠️ 以下两个字段只可能来自规则表
    price: decision.price,
    wide: decision.wide,
    /* 品牌分档：是否影响价格、用的哪档、系数多少 */
    brand: {
      applied: Boolean(decision.brandApplied),
      tier: decision.brandTier || null,
      unknown: Boolean(decision.brandUnknown),
      factor: decision.brandFactor || 1,
      /* 模型这次的判断，前端展示用 */
      modelSaid: observation.brandTier || null
    },
    channels: writer.channelDescs,
    copywriting: writer.copywriting || null,
    meta
  }
}

/**
 * 识别失败的统一形状。
 * 规格要求：HTTP 200 + verdict:"unknown"，前端据此展示 E1 错误页，
 * 且绝对不给猜测性结论。
 */
function buildUnknown(failureReason, meta, extra = {}) {
  /* 不同失败原因给不同的用户提示，别一律"没认出来" */
  const REASONS = {
    model_not_recognized: '没认出来，请换个角度重拍',
    low_confidence: '看不太清，光线好一点再试',
    category_not_in_table: '认出来了，但这个品类还不在支持范围里',
    decision_unknown: '这个品类暂时给不了建议',
    not_recognized: '没认出来，请换个角度重拍'
  }
  return {
    ok: true,
    verdict: 'unknown',
    reason: REASONS[failureReason] || REASONS.not_recognized,
    category: extra.guessed ? { id: null, name: extra.guessed, group: null } : null,
    condition: extra.condition || null,
    material: '',
    price: null,
    wide: false,
    channels: [],
    copywriting: null,
    meta: { ...meta, rejected: failureReason, guessedCategory: extra.guessed || null }
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now()
  // CORS 的允许来源。即使后面装配依赖失败，预检也必须能正常返回，
  // 所以这里先从环境变量取一次，失败也不影响。
  let cfgForCors = process.env.ALLOW_ORIGIN || '*'


  // CORS 预检
  if (handlePreflight(req, res, cfgForCors)) return

  // 只接 POST
  if (req.method !== 'POST') {
    return sendError(res, new AppError('METHOD_NOT_ALLOWED', { detail: `method=${req.method}` }), cfgForCors)
  }

  try {
    /* ========== 0. 依赖装配（配置缺失会在这里就 500，不会走到模型） ========== */
    const { cfg, fetchImpl, mock, mockStats } = buildDeps()
    cfgForCors = cfg.allowOrigin

    /* ========== 1. 规则表（价格与渠道的唯一来源） ========== */
    const rules = await loadRules()

    /* ========== 2. 取图并校验 ========== */
    const image = await extractImage(req, cfg)

    /* ========== 3. 第一段：视觉模型 ========== */
    const vision = await runVision({
      image,
      cfg,
      fetchImpl,
      categories: rules.CATEGORIES
    })

    const baseMeta = {
      visionMs: vision.ms,
      mock: Boolean(mock),
      transport: image.transport,
      imageBytes: image.bytes
    }

    // 认不出 → 直接 unknown，不进入第二段调用（省一次模型成本，也不给猜测结论）
    if (!vision.resolved) {
      return sendJson(res, 200, buildUnknown(vision.reason || 'not_recognized', baseMeta, {
        guessed: vision.guessed,
        condition: vision.observation ? vision.observation.condition : null
      }), cfg.allowOrigin)
    }

    const category = vision.resolved
    const observation = vision.observation

    /* ========== 4. 规则表判定：价格 / 渠道 / 处置结论都在这 ========== */
    const decision = judge(category.id, {
      condition: observation.condition,
      hasWarranty: image.options.hasWarranty,
      brandTier: observation.brandTier
    })

    // 规则表本身返回 unknown（品类未收录）也不该硬编结果
    if (decision.verdict === 'unknown') {
      return sendJson(res, 200, buildUnknown('decision_unknown', baseMeta), cfg.allowOrigin)
    }

    /* ========== 5. 第二段：文本模型 ========== */
    let writer
    try {
      writer = await runWriter({
        observation,
        category,
        decision,
        cfg,
        fetchImpl,
        hasWarranty: image.options.hasWarranty
      })
    } catch (e) {
      const err = toAppError(e)
      // 可选降级：结论和价格都是规则表算的，模型只负责文案，
      // 所以模型挂了并不影响"能不能照着做"。
      if (cfg.degradeOnWriterFailure) {
        writer = fallbackWriter({ decision, category })
        writer.degradedReason = err.code
      } else {
        throw err
      }
    }

    /* ========== 6. 组装响应 ========== */
    const meta = {
      visionMs: vision.ms,
      writerMs: writer.ms,
      model: cfg.visionModel,
      textModel: cfg.textModel,
      visionAttempts: vision.attempt,
      writerAttempts: writer.attempt,
      transport: image.transport,
      imageBytes: image.bytes,
      totalMs: Date.now() - startedAt
    }
    if (writer.degraded) meta.degraded = writer.degradedReason || true
    if (mock) {
      meta.mock = true
      meta.mockCalls = mockStats ? mockStats.calls.length : 0
    }

    return sendJson(res, 200, buildSuccess({
      observation, category, decision, writer, meta
    }), cfg.allowOrigin)

  } catch (rawErr) {
    const err = toAppError(rawErr)

    // 记录到服务端日志（Vercel 会收集）。
    // ⚠️ 只打 code / stage / detail，绝不打请求头和 key。
    console.error('[analyze] 失败', {
      code: err.code,
      stage: err.stage,
      status: err.status,
      detail: err.detail,
      elapsedMs: Date.now() - startedAt
    })

    return sendError(res, err, cfgForCors)
  }
}

