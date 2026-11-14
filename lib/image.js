/* ============================================================
 * lib/image.js · 图片归一化
 * ------------------------------------------------------------
 * 前端已经压过一次（长边 1280 / q0.8，见规格 5.1），
 * 但服务端不能信任前端，所以这里再校验一遍体积与格式。
 *
 * 同时负责把请求体的两种形状收敛成同一种内部表示：
 *   { mime, buffer, base64, dataUrl }
 * ⚠️ 不做转码 —— Vercel 的 Node 运行时没有内置图像库，
 *    加 sharp 会让冷启动变慢，而前端压缩已经足够。
 * ============================================================ */

import { AppError } from './errors.js'

/** 视觉模型普遍支持的位图格式（HEIC 前端已转 JPEG，这里只收位图） */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

/** 按文件头嗅探真实格式，避免「改后缀绕过校验」 */
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  // WEBP: RIFF....WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** 解析 data URL：data:image/jpeg;base64,xxxx */
export function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;[^,]*)?;base64,(.*)$/is.exec(String(dataUrl).trim())
  if (!m) {
    // 也接受不带 data: 前缀的裸 base64
    if (/^[A-Za-z0-9+/=\s]+$/.test(String(dataUrl).trim()) && String(dataUrl).trim().length > 64) {
      return { mime: null, base64: String(dataUrl).trim() }
    }
    throw new AppError('IMAGE_INVALID_FORMAT', { detail: 'imageBase64 不是合法的 data URL' })
  }
  return { mime: (m[1] || '').toLowerCase() || null, base64: m[3].replace(/\s+/g, '') }
}

/**
 * 校验并归一化一张图。
 * @param {{buffer?: Buffer, base64?: string, mime?: string|null}} input
 * @param {{maxBytes:number, minBytes:number}} limits
 * @returns {{mime:string, buffer:Buffer, base64:string, dataUrl:string, bytes:number}}
 */
export function normalizeImage(input, limits) {
  let buffer = input.buffer
  let base64 = input.base64

  if (!buffer && base64) buffer = Buffer.from(base64, 'base64')
  if (!buffer || buffer.length === 0) throw new AppError('NO_IMAGE')
  if (!base64) base64 = buffer.toString('base64')

  if (buffer.length > limits.maxBytes) {
    throw new AppError('IMAGE_TOO_LARGE', {
      detail: `${buffer.length} 字节 > 上限 ${limits.maxBytes}`
    })
  }
  if (buffer.length < limits.minBytes) {
    throw new AppError('IMAGE_TOO_SMALL', { detail: `${buffer.length} 字节 < 下限 ${limits.minBytes}` })
  }

  // 以文件头嗅探为准，兼容前端传错 mime 的情况
  const sniffed = sniffMime(buffer)
  const declared = input.mime ? String(input.mime).toLowerCase().replace('image/jpg', 'image/jpeg') : null
  const mime = sniffed || declared

  if (!mime || !ALLOWED_MIME.has(mime)) {
    throw new AppError('IMAGE_INVALID_FORMAT', {
      detail: `嗅探=${sniffed || 'unknown'} 声明=${declared || 'none'}`
    })
  }

  return {
    mime,
    buffer,
    base64,
    dataUrl: `data:${mime};base64,${base64}`,
    bytes: buffer.length
  }
}
