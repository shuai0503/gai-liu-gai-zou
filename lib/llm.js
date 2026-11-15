/* ============================================================
 * lib/llm.js · 模型调用卡口
 * ------------------------------------------------------------
 * 这里是全项目唯一发 HTTP 请求给模型的地方。
 * 统一处理四件事：
 *   1. API Key 只在这个文件里被放进请求头，任何地方都不记录它
 *   2. AbortController 超时（视觉 12s / 文本 8s，见规格 5.2）
 *   3. 强制 JSON 输出（response_format），外加 schema 校验
 *   4. 校验不合格自动重试 1 次（用更严格的追加指令）
 *
 * 接口协议：OpenAI 兼容 /chat/completions。
 * 因此 DeepSeek / 通义千问 / 硅基流动 / 火山方舟 / 智谱 都能直接用，
 * 换服务商只需改 API_BASE_URL + API_KEY + VISION_MODEL / TEXT_MODEL。
 * ============================================================ */

import { AppError } from './errors.js'
import { safeHost } from './env.js'

/** 把上游 body 截断成可用于日志的字符串（绝不包含请求头） */
function briefBody(text, limit = 200) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, limit)
}

/**
 * 单次请求
 * @param {object} p
 * @param {string} p.stage   'vision' | 'text'，只用于错误归类与日志
 * @param {object} p.cfg     配置（来自 env.getConfig）
 * @param {Function} p.fetchImpl 注入的 fetch
 * @param {Array} p.messages
 * @param {number} p.timeoutMs
 * @param {string} p.failCode 失败时的错误码
 * @returns {Promise<string>} 模型返回的文本
 */
async function callOnce({ stage, cfg, fetchImpl, messages, timeoutMs, failCode, temperature, jsonMode, extra }) {
  const url = `${cfg.apiBaseUrl}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  /* max_tokens 必须显式给。
   * 原因：OpenRouter 这类聚合服务在没有 max_tokens 时，
   * 会按「模型上下文窗口 + 未指定输出」预扣额度，
   * 于是一个实际只要几百 token 的请求被算成 11 万 token，
   * 直接报 402 额度不足。
   * 我们两段输出都很短：视觉段是 7 个字段的 JSON，
   * 文案段是一句话 + 一段文案，各给 800 绰绰有余。 */
  const OUT_TOKENS = { vision: 800, text: 800 }

  const body = {
    model: stage === 'vision' ? cfg.visionModel : cfg.textModel,
    messages,
    temperature: temperature !== undefined ? temperature : cfg.temperature,
    max_tokens: OUT_TOKENS[stage] || 800,
    stream: false
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  if (extra) Object.assign(body, extra)

  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        // 🔑 全项目唯一出现 key 的位置；不进日志、不进响应
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (e) {
    clearTimeout(timer)
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
      throw new AppError('TIMEOUT', {
        stage,
        detail: `${stage} 超过 ${timeoutMs}ms 未返回（${safeHost(cfg.apiBaseUrl)}）`
      })
    }
    throw new AppError(failCode, {
      stage,
      detail: `网络请求失败：${briefBody(e && e.message)}`
    })
  }

  if (!res.ok) {
    clearTimeout(timer)
    let text = ''
    try {
      text = await res.text()
    } catch { /* 忽略读取失败 */ }
    // 上游 4xx 常见原因：key 错、模型名错、额度不足；都在 detail 里留痕但不外泄
    throw new AppError(failCode, {
      stage,
      detail: `上游 HTTP ${res.status}：${briefBody(text)}`
    })
  }

  let payload
  try {
    payload = await res.json()
  } catch (e) {
    clearTimeout(timer)
    throw new AppError(failCode, { stage, detail: '上游返回的不是合法 JSON' })
  } finally {
    clearTimeout(timer)
  }

  /* 提取模型输出。
   * 不同服务商的返回结构有差异，这里做兼容：
   *   · 常规模型        → choices[0].message.content
   *   · 部分推理模型    → content 为空，正文在 reasoning / reasoning_content
   *   · 还有的会返回数组 → content: [{type:'text', text:'...'}]
   * 三种都试一遍，都拿不到才算失败。 */
  const msg = payload && payload.choices && payload.choices[0] && payload.choices[0].message
  let content = null

  if (msg) {
    if (typeof msg.content === 'string' && msg.content.trim()) {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      /* OpenAI 多段内容格式 */
      const parts = msg.content
        .map(p => (p && typeof p.text === 'string') ? p.text : '')
        .filter(Boolean)
      if (parts.length) content = parts.join('\n')
    }
    /* 推理模型：正文可能落在 reasoning 里 */
    if (!content && typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
      content = msg.reasoning
    }
    if (!content && typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
      content = msg.reasoning_content
    }
  }

  if (!content || typeof content !== 'string') {
    /* 把实际收到的结构摘要写进 detail，方便排查是哪种模型返回了什么 */
    let shape = 'unknown'
    try { shape = JSON.stringify(msg || payload).slice(0, 200) } catch { shape = 'unserializable' }
    throw new AppError(failCode, { stage, detail: `上游未返回可用的文本内容（结构：${shape}）` })
  }

  return content
}

/**
 * 带 schema 校验 + 一次重试的调用。
 *
 * 流程：
 *   callOnce → extractJson → validate
 *     ✅ 合格 → 返回
 *     ❌ 不合格 → 追加一条"上次哪里不合法"的纠正消息，重试 1 次
 *                → 仍不合格 → 抛 failCode（视情况带 retryable）
 *
 * @returns {Promise<{data:object, attempts:number, raw:string}>}
 */
export async function callJson({
  stage,
  cfg,
  fetchImpl,
  system,
  user,
  validator,          // (value) => { valid, errors, summary }
  extractor,          // (text) => object|null
  timeoutMs,
  failCode,
  temperature,
  jsonMode,
  maxAttempts = 2     // 2 = 首次 + 重试 1 次（规格 5.2 要求）
}) {
  let lastSummary = ''
  let lastRaw = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]

    // 第 2 次起：把上次的违规点直接回灌给模型，比重新描述规则有效
    if (attempt > 1 && lastSummary) {
      messages.push({ role: 'assistant', content: lastRaw || '{}' })
      messages.push({
        role: 'user',
        content: `你上一次的输出不合格，问题在：${lastSummary}\n请严格按 JSON 结构重新输出，不要任何额外文字，不要出现价格和平台名。`
      })
    }

    const raw = await callOnce({
      stage, cfg, fetchImpl, messages, timeoutMs, failCode, temperature, jsonMode
    })
    lastRaw = raw

    const value = extractor(raw)
    if (!value) {
      lastSummary = '输出不是合法 JSON'
      continue
    }

    const r = validator(value)
    if (r.valid) {
      return { data: value, attempts: attempt, raw }
    }

    lastSummary = r.summary
    // 置信度/品类不合法也算不合格，统一走重试
  }

  throw new AppError(failCode, {
    stage,
    retryable: true,
    detail: `连续 ${maxAttempts} 次输出未通过 schema 校验：${lastSummary}`
  })
}
