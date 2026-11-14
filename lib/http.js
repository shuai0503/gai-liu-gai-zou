/* ============================================================
 * lib/http.js · HTTP 小工具
 * ------------------------------------------------------------
 * 只做三件事：CORS 头、统一 JSON 响应、读原始请求体。
 * 不引入 express —— 这里只有两个 serverless 函数，用原生 req/res 足够。
 * ============================================================ */

import { AppError, errorPayload } from './errors.js'

/** 允许跨域的响应头。H5 可能挂在别的域名下，所以默认全放开。 */
export function corsHeaders(allowOrigin = '*') {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  }
}

/** 统一 JSON 响应（含 CORS、禁缓存） */
export function sendJson(res, status, body, allowOrigin = '*') {
  const safeBody = status === 204 ? null : JSON.stringify(body)
  for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) res.setHeader(k, v)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.statusCode = status
  res.end(safeBody)
}

/** 统一错误响应：{ ok:false, code, message } */
export function sendError(res, err, allowOrigin = '*') {
  const payload = errorPayload(err)
  const e = err instanceof AppError ? err : null
  const status = e ? e.status : 500
  sendJson(res, status, payload, allowOrigin)
}

/** 预检请求直接 204 */
export function handlePreflight(req, res, allowOrigin = '*') {
  if (req.method !== 'OPTIONS') return false
  for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) res.setHeader(k, v)
  res.setHeader('Cache-Control', 'no-store')
  res.statusCode = 204
  res.end()
  return true
}

/** 限制 JSON 体积，防止有人拿 40MB 的 base64 把函数打爆 */
export const MAX_RAW_BODY_BYTES = 12 * 1024 * 1024

/**
 * 读取请求体为 Buffer。
 * 兼容两种情况：
 *   - Vercel / Node 已经把 body 解析成对象（req.body）→ 重新序列化
 *   - 裸流 → 逐块拼接
 */
export async function readBody(req, limit = MAX_RAW_BODY_BYTES) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8')
    // Vercel 对 application/json 会预解析成对象
    return Buffer.from(JSON.stringify(req.body), 'utf8')
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw new AppError('IMAGE_TOO_LARGE', { detail: `请求体超过 ${limit} 字节` })
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** 取 content-type 里的 mime 与参数 */
export function parseContentType(header = '') {
  const [rawType, ...rest] = String(header).split(';')
  const type = rawType.trim().toLowerCase()
  const params = {}
  for (const part of rest) {
    const [k, v] = part.split('=')
    if (!k) continue
    params[k.trim().toLowerCase()] = (v || '').trim().replace(/^"|"$/g, '')
  }
  return { type, params }
}
