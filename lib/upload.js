/* ============================================================
 * lib/upload.js · 把两种请求格式收敛成同一张图
 * ------------------------------------------------------------
 * 支持：
 *   A) multipart/form-data，字段名 image
 *   B) application/json，{ imageBase64: "data:image/jpeg;base64,..." }
 *
 * 手写 multipart 解析的原因：
 *   前端只会传一个字段，引 formidable / busboy 不值得；
 *   Vercel 的 Node 运行时也不预置这两个包。
 * ============================================================ */

import { AppError } from './errors.js'
import { parseContentType, readBody } from './http.js'
import { normalizeImage, parseDataUrl } from './image.js'

/** ---------- multipart ---------- */

/**
 * 在 Buffer 里找分隔符
 */
function indexOfBuf(buf, needle, from = 0) {
  return buf.indexOf(needle, from)
}

/**
 * 解析 multipart/form-data，返回字段名 → { filename, mime, data:Buffer }
 * 只解析一层，不处理嵌套 multipart（用不到）。
 */
export function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = {}
  let pos = indexOfBuf(buffer, delimiter)
  if (pos === -1) throw new AppError('PAYLOAD_INVALID', { detail: '找不到 multipart 分隔符' })

  while (pos !== -1) {
    pos += delimiter.length
    // 结束标记 --
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break
    // 跳过 CRLF
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2

    const headerEnd = indexOfBuf(buffer, Buffer.from('\r\n\r\n'), pos)
    if (headerEnd === -1) break

    const headerText = buffer.toString('utf8', pos, headerEnd)
    const nextDelim = indexOfBuf(buffer, delimiter, headerEnd + 4)
    if (nextDelim === -1) break

    // 内容末尾会多一个 CRLF（分隔符前）
    let dataEnd = nextDelim
    if (buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) dataEnd -= 2
    const data = buffer.subarray(headerEnd + 4, dataEnd)

    const nameMatch = /name="([^"]*)"/i.exec(headerText)
    const fileMatch = /filename="([^"]*)"/i.exec(headerText)
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText)

    if (nameMatch) {
      parts[nameMatch[1]] = {
        filename: fileMatch ? fileMatch[1] : null,
        mime: typeMatch ? typeMatch[1].trim().toLowerCase() : null,
        data: Buffer.from(data) // 拷贝，避免持有整个 body
      }
    }

    pos = nextDelim
  }

  return parts
}

/** ---------- 统一入口 ---------- */

/** 从各种形态里解析布尔值（"1" / "true" / "yes" / 字段存在即真） */
function asBool(v) {
  if (v === undefined || v === null || v === '') return false
  return /^(1|true|yes|on)$/i.test(String(v).trim())
}

/**
 * 从请求里取出并归一化图片。
 * 顺带解析一个可选的用户补充信息 hasWarranty（是否在保修期内），
 * 它会传给规则表的 decide()，是「建议先留着」这个分支的触发条件之一。
 *
 * @param {object} req
 * @param {object} cfg
 * @returns {Promise<{mime, buffer, base64, dataUrl, bytes, transport, options:{hasWarranty:boolean}}>}
 */
export async function extractImage(req, cfg) {
  const limits = { maxBytes: cfg.maxImageBytes, minBytes: cfg.minImageBytes }
  const { type, params } = parseContentType(req.headers['content-type'] || '')

  /* ---- A. multipart ---- */
  if (type === 'multipart/form-data') {
    const boundary = params.boundary
    if (!boundary) throw new AppError('PAYLOAD_INVALID', { detail: 'multipart 缺少 boundary' })

    // 传图的 base64 会比原图大 4/3，留出 30% 余量给表单头
    const body = await readBody(req, Math.ceil(cfg.maxImageBytes * 1.4) + 64 * 1024)
    const parts = parseMultipart(body, boundary)

    // 字段名放宽一点：image / file / photo 都收，前端不难写
    const field = parts.image || parts.file || parts.photo
    if (!field || !field.data || field.data.length === 0) {
      throw new AppError('NO_IMAGE', { detail: `multipart 里没有 image 字段（收到：${Object.keys(parts).join(',') || '空'}）` })
    }

    const image = normalizeImage({ buffer: field.data, mime: field.mime }, limits)
    const warrantyField = parts.hasWarranty
    return {
      ...image,
      transport: 'multipart',
      options: { hasWarranty: asBool(warrantyField && warrantyField.data.toString('utf8')) }
    }
  }

  /* ---- B. JSON ---- */
  if (type === 'application/json' || type === 'text/plain' || type === '') {
    const body = await readBody(req, Math.ceil(cfg.maxImageBytes * 1.4) + 8 * 1024)
    let json
    try {
      json = JSON.parse(body.toString('utf8') || '{}')
    } catch (e) {
      throw new AppError('PAYLOAD_INVALID', { detail: '请求体不是合法 JSON' })
    }

    const raw = json.imageBase64 || json.image || json.data
    if (!raw || typeof raw !== 'string') {
      throw new AppError('NO_IMAGE', { detail: 'JSON 里没有 imageBase64 字段' })
    }

    const { mime, base64 } = parseDataUrl(raw)
    const image = normalizeImage({ base64, mime }, limits)
    return {
      ...image,
      transport: 'json',
      options: { hasWarranty: asBool(json.hasWarranty) }
    }
  }

  throw new AppError('IMAGE_INVALID_FORMAT', {
    detail: `不支持的 Content-Type：${type || '(空)'}，请用 multipart/form-data 或 application/json`
  })
}
