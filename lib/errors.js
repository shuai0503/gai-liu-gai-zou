/* ============================================================
 * lib/errors.js · 统一错误定义
 * ------------------------------------------------------------
 * 设计意图：
 *   接口只对外暴露「一个稳定 code + 一句能直接给用户看的中文」，
 *   排查用的技术细节放在 detail 里。
 *
 *   ⚠️ 任何情况下都不能把 API Key、请求头、上游原始响应体
 *   放进 detail —— 这个对象会被序列化后返回给前端。
 * ============================================================ */

/**
 * 错误码 → HTTP 状态码 + 给用户看的提示语
 * 状态码遵循任务约定：400 参数错误 / 502 模型失败 / 504 超时
 */
export const ERROR_TABLE = {
  /* ---------- 400 · 参数问题（用户能自己改） ---------- */
  BAD_REQUEST:          { status: 400, message: '请求格式不对，请重新试一次' },
  NO_IMAGE:             { status: 400, message: '没有收到照片，请重新选一张' },
  IMAGE_TOO_LARGE:      { status: 400, message: '这张图有点大，换一张试试' },
  IMAGE_INVALID_FORMAT: { status: 400, message: '支持 JPG、PNG 的照片' },
  IMAGE_TOO_SMALL:      { status: 400, message: '图片太小了，拍清楚一点' },
  PAYLOAD_INVALID:      { status: 400, message: '请求格式不对，请重新试一次' },

  /* ---------- 405 · 用法问题 ---------- */
  METHOD_NOT_ALLOWED:   { status: 405, message: '请用 POST 上传照片' },

  /* ---------- 502 · 模型侧失败（用户重试可能成功） ---------- */
  VISION_FAILED:        { status: 502, message: '这次没成功，重试一下就好' },
  TEXT_FAILED:          { status: 502, message: '这次没成功，重试一下就好' },

  /* ---------- 504 · 超时 ---------- */
  TIMEOUT:              { status: 504, message: '这次没成功，网络好像不太稳定，重试一下' },

  /* ---------- 500 · 服务端自己的问题 ---------- */
  CONFIG_MISSING:       { status: 500, message: '服务暂时不可用，请稍后再试' },
  INTERNAL:             { status: 500, message: '服务出了点问题，稍后再试' }
}

/** 业务错误：带 code / status / 用户提示 / 排查细节 */
export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_TABLE} code 对外错误码
   * @param {object} [opts]
   * @param {string} [opts.message] 覆盖默认用户提示（仍然只能是中文短句）
   * @param {string} [opts.detail]  仅用于日志与排查的补充信息，不含密钥
   * @param {boolean} [opts.retryable] 是否值得重试一次（schema 不合格时为 true）
   * @param {string} [opts.stage]  出错阶段：vision / writer / input
   */
  constructor(code, opts = {}) {
    const row = ERROR_TABLE[code] || ERROR_TABLE.INTERNAL
    super(opts.message || row.message)
    this.name = 'AppError'
    this.code = ERROR_TABLE[code] ? code : 'INTERNAL'
    this.status = row.status
    this.detail = opts.detail || ''
    this.retryable = Boolean(opts.retryable)
    this.stage = opts.stage || ''
  }
}

/** 把任意抛出物收敛成 AppError（避免把栈信息泄漏给前端） */
export function toAppError(err) {
  if (err instanceof AppError) return err
  if (err && err.name === 'AbortError') {
    return new AppError('TIMEOUT', { detail: 'aborted by AbortController' })
  }
  return new AppError('INTERNAL', { detail: String(err && err.message ? err.message : err).slice(0, 300) })
}

/**
 * 错误响应的统一形状
 * { ok:false, code, message, detail? }
 */
export function errorPayload(err) {
  const e = toAppError(err)
  const payload = { ok: false, code: e.code, message: e.message }
  // detail 只在非生产环境返回，避免把内部实现细节暴露给公网
  if (e.detail && process.env.NODE_ENV !== 'production') payload.detail = e.detail
  return payload
}
