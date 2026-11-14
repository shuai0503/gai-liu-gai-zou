/* ============================================================
 * lib/mock.js · 假模型（仅用于本地测试与演示）
 * ------------------------------------------------------------
 * 为什么需要它：
 *   这个产品最关键的部分不是"调通 API"，而是
 *   「模型说的话不合格时，系统怎么拒绝它」。
 *   那部分逻辑必须能被自动化验证，而不依赖真实 Key 和网络。
 *
 * 实现方式：伪造一个与 OpenAI 兼容接口同形的 fetch，
 * 由 MOCK_SCENARIO 决定这一轮模型表现如何。
 * 业务代码完全不知道自己在跟假模型说话 —— 这就是注入 fetch 的意义。
 *
 * ⚠️ production 环境默认禁止启用（见 lib/env.js）。
 * ============================================================ */

/** 构造一个 AbortError，形状与 Node 原生一致 */
function abortError() {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/** 可被 AbortSignal 打断的延时 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError())
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(abortError())
      }, { once: true })
    }
  })
}

/** 伪造 Response */
function fakeResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text)
  }
}

/** 包成 OpenAI 兼容的 choices 结构 */
function completion(content) {
  return fakeResponse(200, JSON.stringify({
    id: 'mock-completion',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }))
}

/** 判断这次请求是视觉段还是文本段 */
function detectStage(init) {
  try {
    const body = JSON.parse(init.body)
    const text = JSON.stringify(body.messages)
    return text.includes('image_url') ? 'vision' : 'text'
  } catch {
    return 'text'
  }
}

/* ---------- 各类假返回 ---------- */

const VISION_OK = {
  recognized: true,
  categoryId: 'down-jacket',
  categoryName: '羽绒服',
  condition: '八成新',
  material: '鹅绒',
  damage: '',
  confidence: 'high',
  brandTier: 'brand'
}

const VISION_UNKNOWN = {
  recognized: false,
  categoryId: '',
  categoryName: '',
  condition: '八成新',
  material: '',
  damage: '',
  confidence: 'low',
  brandTier: 'generic'
}

/** 认出了东西，但品类不在规则表里（模型爱编"北面1996羽绒服"这类） */
const VISION_NOT_IN_TABLE = {
  recognized: true,
  categoryId: 'north-face-1996-nuptse',
  categoryName: '北面1996羽绒服',
  condition: '八成新',
  material: '鹅绒',
  damage: '',
  confidence: 'high',
  brandTier: 'premium'
}

/** 品牌档位非法：用来测 vision.js 会不会把它回退成 generic */
const VISION_BAD_BRAND = {
  ...VISION_OK,
  brandTier: 'ultra-luxury'
}

/** 不合格：少字段 + 多字段，模拟模型不听话 */
const VISION_INVALID = {
  recognized: true,
  categoryId: 'down-jacket',
  price: 120,
  channel: '闲鱼'
}

/** 文本段：只在 sell 分支给文案 */
function writerOk(userPrompt) {
  const isSell = /程序的处置结论：卖掉/.test(userPrompt)
  if (!isSell) {
    return { reason: '这个成色和品类，按规则表走这条处置路径更稳妥。', copywriting: '' }
  }
  return {
    reason: '还在穿得出去，二手有明确买家。',
    copywriting: [
      '八成新鹅绒羽绒服，L 码，无破损无污渍。',
      '去年入的，今年瘦了穿不下，版型偏宽松，165–175 身高都合适。',
      '实物就是照片这样，介意二手勿拍。',
      '#羽绒服 #冬装 #闲置'
    ].join('\n')
  }
}

/** 文本段不合格：给自己编了个价格，还顺手提了平台 */
const WRITER_INVALID = {
  reason: '这件 120 元挂闲鱼很好卖。',
  copywriting: '八成新鹅绒羽绒服，¥150，包邮。'
}

/**
 * 创建假 fetch
 * @param {string} scenario
 * @returns {{fetch:Function, stats:{calls:Array}}}
 */
export function createMockFetch(scenario = 'normal') {
  const stats = { scenario, calls: [] }
  let visionCount = 0
  let textCount = 0

  async function fetchImpl(url, init = {}) {
    const stage = detectStage(init)
    const n = stage === 'vision' ? ++visionCount : ++textCount
    stats.calls.push({ stage, attempt: n, url, scenario })

    // 每个场景都能配置模拟延迟，默认 30ms（不拖慢测试）
    const latency = Number(process.env.MOCK_LATENCY_MS || 30)
    if (latency > 0) await delay(latency, init.signal)

    /* ---------- 场景：超时 ---------- */
    // 一直不返回，交给调用方的 AbortController 打断
    if (scenario === 'timeout') {
      await new Promise((_, reject) => {
        if (init.signal) init.signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    }

    /* ---------- 场景：上游 500 ---------- */
    if (scenario === 'upstream-error') {
      return fakeResponse(500, JSON.stringify({ error: { message: 'internal server error' } }))
    }

    /* ---------- 视觉段 ---------- */
    if (stage === 'vision') {
      switch (scenario) {
        case 'unknown':
          return completion(JSON.stringify(VISION_UNKNOWN))
        case 'not-in-table':
          return completion(JSON.stringify(VISION_NOT_IN_TABLE))
        case 'low-confidence':
          return completion(JSON.stringify({ ...VISION_OK, confidence: 'low' }))
        case 'schema-fail-once':
          // 第一次给垃圾，第二次给合格 —— 验证"自动重试 1 次"
          return completion(n === 1 ? JSON.stringify(VISION_INVALID) : JSON.stringify(VISION_OK))
        case 'schema-fail-always':
          return completion(JSON.stringify(VISION_INVALID))
        case 'not-json':
          return completion('我不太确定这是什么，看起来像衣服。')
        case 'category-name':
          // 模型给中文名而不是 id，验证模糊匹配
          return completion(JSON.stringify({
            ...VISION_OK, categoryId: '', categoryName: '鸭绒服'
          }))
        case 'kettle':
          // 电水壶：八成新 → 13–33 元，high < 100，
          // 保修期开关会真的改变结论（keep vs sell），用来验证参数透传
          return completion(JSON.stringify({
            ...VISION_OK,
            categoryId: 'kettle',
            categoryName: '电水壶',
            material: '不锈钢'
          }))
        default:
          return completion(JSON.stringify(VISION_OK))
      }
    }

    /* ---------- 文本段 ---------- */
    const userPrompt = (() => {
      try {
        const body = JSON.parse(init.body)
        const msg = body.messages.filter(m => m.role === 'user').pop()
        return typeof msg?.content === 'string' ? msg.content : ''
      } catch { return '' }
    })()

    switch (scenario) {
      case 'writer-schema-fail-once':
        return completion(n === 1 ? JSON.stringify(WRITER_INVALID) : JSON.stringify(writerOk(userPrompt)))
      case 'writer-schema-fail-always':
        return completion(JSON.stringify(WRITER_INVALID))
      case 'writer-error':
        return fakeResponse(500, JSON.stringify({ error: { message: 'text model down' } }))
      case 'degrade':
        return fakeResponse(503, JSON.stringify({ error: { message: 'text model unavailable' } }))
      default:
        return completion(JSON.stringify(writerOk(userPrompt)))
    }
  }

  return { fetch: fetchImpl, stats }
}
