/* ============================================================
 * lib/env.js · 环境变量与运行时依赖装配
 * ------------------------------------------------------------
 * 原则：
 *   1. 所有密钥、模型名、地址一律 process.env，代码里不出现任何常量 key
 *   2. 模型不写死，只要求「OpenAI 兼容接口」：
 *        POST {API_BASE_URL}/chat/completions
 *      所以 DeepSeek / 通义千问 / 硅基流动 / 火山方舟 / 智谱 都能用，
 *      换服务商只改 API_BASE_URL + API_KEY + *_MODEL 三个变量。
 *   3. 每次调用重新读 process.env（不缓存），便于测试按用例切换场景。
 * ============================================================ */

import { AppError } from './errors.js'
import { createMockFetch } from './mock.js'

/** 默认值集中在一处，README 里列出的就是这份 */
const DEFAULTS = {
  API_BASE_URL: 'https://api.deepseek.com/v1',
  VISION_MODEL: '',
  TEXT_MODEL: '',
  VISION_TIMEOUT_MS: 12000, // 视觉 12s（规格文档 5.2）
  TEXT_TIMEOUT_MS: 8000,    // 文本 8s（规格文档 5.2）
  TOTAL_BUDGET_MS: 22000,   // 单次请求总预算，兜住 Vercel maxDuration
  MAX_IMAGE_BYTES: 8 * 1024 * 1024, // 8MB，对齐 E3「超过 8MB」文案
  MIN_IMAGE_BYTES: 2 * 1024,        // 小于 2KB 基本是坏图
  ALLOW_ORIGIN: '*',
  JSON_MODE: '1',
  TEMPERATURE: '0.2',
  LOW_CONFIDENCE_AS_UNKNOWN: '1',   // 置信度 low 一律当作没认出来（不给猜测性结论）
  DEGRADE_ON_WRITER_FAILURE: '0'    // 0 = 文本模型失败返回 502；1 = 降级返回 200（见 README）
}

function num(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function bool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

function str(name, fallback = '') {
  const v = process.env[name]
  return v === undefined || v === null || v === '' ? fallback : String(v)
}

/** 提示语里可以出现服务商域名，但绝不出现 key */
export function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host
  } catch {
    return 'invalid-url'
  }
}

/**
 * 读取并校验配置。
 * 缺 key 或缺视觉模型名时抛 CONFIG_MISSING —— 这条错误不会泄漏缺的是什么的具体值。
 */
export function getConfig() {
  const baseUrl = str('API_BASE_URL', DEFAULTS.API_BASE_URL).replace(/\/+$/, '')
  const visionModel = str('VISION_MODEL')
  const textModel = str('TEXT_MODEL', visionModel)
  const mockMode = bool('MOCK_MODE', false)

  // 生产环境默认拒绝 mock：宁可 500，也不能给评委返回假结论
  if (mockMode && process.env.NODE_ENV === 'production' && !bool('ALLOW_MOCK_IN_PROD', false)) {
    throw new AppError('CONFIG_MISSING', {
      detail: 'MOCK_MODE 在 production 下被拒绝；如确实需要请显式设置 ALLOW_MOCK_IN_PROD=1'
    })
  }

  const cfg = {
    apiBaseUrl: baseUrl,
    apiKey: str('API_KEY'),
    visionModel,
    textModel,
    jsonMode: bool('JSON_MODE', true),
    temperature: Number(str('TEMPERATURE', DEFAULTS.TEMPERATURE)),
    visionTimeoutMs: num('VISION_TIMEOUT_MS', DEFAULTS.VISION_TIMEOUT_MS),
    textTimeoutMs: num('TEXT_TIMEOUT_MS', DEFAULTS.TEXT_TIMEOUT_MS),
    totalBudgetMs: num('TOTAL_BUDGET_MS', DEFAULTS.TOTAL_BUDGET_MS),
    maxImageBytes: num('MAX_IMAGE_BYTES', DEFAULTS.MAX_IMAGE_BYTES),
    minImageBytes: num('MIN_IMAGE_BYTES', DEFAULTS.MIN_IMAGE_BYTES),
    allowOrigin: str('ALLOW_ORIGIN', DEFAULTS.ALLOW_ORIGIN),
    lowConfidenceAsUnknown: bool('LOW_CONFIDENCE_AS_UNKNOWN', true),
    degradeOnWriterFailure: bool('DEGRADE_ON_WRITER_FAILURE', false),
    mockMode
  }

  // mock 模式下不必要求真实 key；真实模式缺 key 直接报配置错误
  if (!mockMode) {
    if (!cfg.apiKey) {
      throw new AppError('CONFIG_MISSING', { detail: '缺少环境变量 API_KEY' })
    }
    if (!cfg.visionModel) {
      throw new AppError('CONFIG_MISSING', { detail: '缺少环境变量 VISION_MODEL' })
    }
  }

  return cfg
}

/**
 * 装配一次请求用到的依赖。
 * 把 fetch 注入进来，是为了测试时能用假模型替换网络层，
 * 而不需要改业务代码（这就叫「可测性」）。
 */
export function buildDeps() {
  const cfg = getConfig()
  if (cfg.mockMode) {
    const mock = createMockFetch(process.env.MOCK_SCENARIO || 'normal')
    return { cfg, fetchImpl: mock.fetch, mockStats: mock.stats, mock: true }
  }
  return { cfg, fetchImpl: globalThis.fetch.bind(globalThis), mockStats: null, mock: false }
}

/** 给 /health 用的安全信息：不含 key，只说明「配了没有」 */
export function getSafeInfo() {
  try {
    const cfg = getConfig()
    return {
      configured: true,
      mock: cfg.mockMode,
      host: safeHost(cfg.apiBaseUrl),
      models: { vision: cfg.visionModel || null, text: cfg.textModel || null },
      timeouts: { visionMs: cfg.visionTimeoutMs, textMs: cfg.textTimeoutMs, budgetMs: cfg.totalBudgetMs }
    }
  } catch (e) {
    return { configured: false, reason: e.code || 'UNKNOWN' }
  }
}
