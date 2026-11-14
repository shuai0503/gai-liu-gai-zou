/**
 * scripts/make-qr.mjs
 * 在本地生成二维码 PNG（纯 Node，无外部依赖），便于直接看图和打印。
 * 实现：QR Code Model 2, 版本自适应，字节模式，纠错等级 M。
 *
 * 用法：node scripts/make-qr.mjs http://10.85.21.60:8899
 * 输出：当前目录 qr-<host>.png 与 qr-<host>.txt（ASCII 版，可直接贴到聊天里）
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

/* ============================================================
 * QR 编码核心
 * ============================================================ */

/* 纠错等级 M 的每块参数（版本 1-40） */
const EC_M = [
  null,
  [1, 26, 16, 10], [1, 44, 28, 16], [1, 70, 44, 26], [2, 100, 64, 36],
  [2, 134, 86, 48], [4, 172, 108, 64], [4, 196, 124, 72], [2, 242, 154, 88],
  [3, 292, 182, 110], [4, 346, 216, 130], [1, 404, 254, 150], [6, 466, 290, 176],
  [8, 532, 334, 198], [4, 581, 365, 216], [5, 655, 415, 254], [7, 733, 453, 282],
  [10, 815, 507, 316], [9, 901, 563, 354], [3, 991, 627, 382], [3, 1085, 669, 432],
  [17, 1156, 714, 450], [17, 1258, 782, 496], [4, 1364, 860, 514], [6, 1474, 914, 554],
  [8, 1588, 1000, 596], [19, 1706, 1062, 636], [22, 1828, 1128, 684], [3, 1921, 1190, 710],
  [21, 2051, 1276, 758], [19, 2185, 1370, 808], [2, 2323, 1462, 862], [24, 2465, 1550, 912],
  [25, 2611, 1638, 960], [9, 2761, 1728, 1012], [24, 2876, 1804, 1066], [35, 3034, 1908, 1108],
  [24, 3196, 1996, 1168], [26, 3362, 2108, 1228], [31, 3532, 2222, 1286], [27, 3706, 2316, 1344],
  [37, 3886, 2436, 1414]
]

/* 版本 1-40 的对齐图形中心坐标 */
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
  [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 30, 62, 90], [6, 34, 66, 94],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
]

function getVersionInfo(ver) {
  const [ecBlocks, totalCode, dataCode, eccPerBlock] = EC_M[ver]
  return { ecBlocks, totalCode, dataCode, eccPerBlock }
}

/* ---------- 位缓冲 ---------- */
class BitBuffer {
  constructor() { this.buf = []; this.len = 0 }
  put(num, len) {
    for (let i = len - 1; i >= 0; i--) this.putBit(((num >>> i) & 1) === 1)
  }
  putBit(bit) {
    const byteIdx = this.len >>> 3
    if (this.buf.length <= byteIdx) this.buf.push(0)
    if (bit) this.buf[byteIdx] |= 0x80 >>> (this.len & 7)
    this.len++
  }
  get length() { return this.len }
}

/* ---------- UTF-8 编码 ---------- */
function utf8Bytes(str) {
  const out = []
  for (const ch of str) {
    let code = ch.codePointAt(0)
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F))
    else if (code < 0x10000) out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    else out.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
  }
  return out
}

/* ---------- 选择最小版本 ---------- */
function chooseVersion(bytes) {
  for (let v = 1; v <= 40; v++) {
    const { dataCode } = getVersionInfo(v)
    // 模式 4 位 + 字符计数(8 或 16 位) + 数据 + 结束符
    const countBits = v <= 9 ? 8 : 16
    const need = 4 + countBits + bytes.length * 8
    if (need <= dataCode * 8) return v
  }
  throw new Error('内容过长，无法编码')
}

/* ---------- GF(256) 与 RS 纠错 ---------- */
const EXP = new Array(512), LOG = new Array(256)
;(function initGF() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11D
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function rsGenerator(deg) {
  let poly = [1]
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

function rsEncode(data, eccLen) {
  const gen = rsGenerator(eccLen)
  const res = new Array(eccLen).fill(0)
  for (const b of data) {
    const factor = b ^ res[0]
    res.shift()
    res.push(0)
    for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor)
  }
  return res
}

/* ---------- 编码数据到码字 ---------- */
function buildCodewords(bytes, ver) {
  const { ecBlocks, dataCode, eccPerBlock } = getVersionInfo(ver)

  const bits = new BitBuffer()
  bits.put(0b0100, 4)                       // 字节模式
  bits.put(bytes.length, ver <= 9 ? 8 : 16) // 字符计数
  for (const b of bytes) bits.put(b, 8)

  // 结束符
  const capBits = dataCode * 8
  if (bits.length + 4 <= capBits) bits.put(0, 4)
  // 补齐到字节
  while (bits.length % 8 !== 0) bits.putBit(false)
  // 填充码字
  const pad = [0xEC, 0x11]
  let padIdx = 0
  while (bits.length < capBits) {
    const byte = pad[padIdx++ % 2]
    bits.put(byte, 8)
  }

  const data = bits.buf.slice(0, dataCode)

  // 分块
  const totalBlocks = ecBlocks
  const shortBlockLen = Math.floor(dataCode / totalBlocks)
  const numLong = totalBlocks - (totalBlocks * shortBlockLen - dataCode) % totalBlocks
  // 重新按标准分块
  const blockLens = []
  const baseLen = Math.floor(dataCode / totalBlocks)
  const extra = dataCode % totalBlocks
  for (let i = 0; i < totalBlocks; i++) blockLens.push(baseLen + (i >= totalBlocks - extra ? 1 : 0))

  const blocks = []
  let p = 0
  for (let i = 0; i < totalBlocks; i++) {
    const blk = data.slice(p, p + blockLens[i])
    p += blockLens[i]
    blocks.push({ data: blk, ecc: rsEncode(blk, eccPerBlock) })
  }

  // 交织
  const out = []
  const maxData = Math.max(...blockLens)
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const b of blocks) out.push(b.ecc[i])
  }
  return out
}

/* ---------- 矩阵构建 ---------- */
function buildMatrix(ver, codewords) {
  const size = ver * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(null))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))

  const set = (x, y, v) => { m[y][x] = v; reserved[y][x] = true }

  // 定位图形
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, dist !== 2 && dist !== 4 ? 1 : 0)
      }
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    if (m[i][6] === null) set(i, 6, i % 2 === 0 ? 1 : 0)
    if (m[6][i] === null) set(6, i, i % 2 === 0 ? 1 : 0)
  }

  // 对齐图形
  const ap = ALIGN[ver - 1]
  for (const ay of ap) {
    for (const ax of ap) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy))
          set(ax + dx, ay + dy, d !== 1 ? 1 : 0)
        }
      }
    }
  }

  // 备用位
  set(8, size - 8, 0)

  // 预留格式信息区
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true
    if (!reserved[i][8]) reserved[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = true
    if (!reserved[size - 1 - i][8]) reserved[size - 1 - i][8] = true
  }

  // 版本信息（版本 >= 7）
  if (ver >= 7) {
    let bits = ver
    for (let i = 0; i < 12; i++) bits = (bits << 1) ^ ((bits >>> 11) * 0x1F25)
    const vb = (ver << 12) | bits
    for (let i = 0; i < 18; i++) {
      const bit = (vb >>> i) & 1
      const a = Math.floor(i / 3)
      const b = i % 3
      set(size - 11 + b, a, bit)
      set(a, size - 11 + b, bit)
    }
  }

  // 放置数据：右下向上之字形
  let bitIdx = 0
  const totalBits = codewords.length * 8
  const getBit = i => (i < totalBits ? (codewords[i >>> 3] >>> (7 - (i & 7))) & 1 : 0)

  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert
      for (let c = 0; c < 2; c++) {
        const x = right - c
        if (x < 0 || reserved[y][x]) continue
        let bit = getBit(bitIdx++)
        // 掩码 0：(y+x)%2===0 → 反色
        if ((x + y) % 2 === 0) bit ^= 1
        m[y][x] = bit
        reserved[y][x] = true
      }
    }
    upward = !upward
  }

  return { matrix: m, size }
}

/* ---------- 渲染成 PNG ---------- */
function renderPng(size, matrix, scale = 8, border = 4) {
  const total = (size + border * 2) * scale
  const raw = Buffer.alloc((total * 3 + 1) * total)
  let p = 0
  for (let y = 0; y < total; y++) {
    raw[p++] = 0
    for (let x = 0; x < total; x++) {
      const mx = Math.floor(x / scale) - border
      const my = Math.floor(y / scale) - border
      let dark = false
      if (mx >= 0 && my >= 0 && mx < size && my < size) {
        dark = matrix[my][mx] === 1
      }
      const v = dark ? 17 : 255
      raw[p++] = v; raw[p++] = v; raw[p++] = v
    }
  }
  const idat = deflateSync(raw, { level: 9 })
  const crc = b => {
    let c = -1
    for (let i = 0; i < b.length; i++) {
      c ^= b[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
    }
    return (c ^ -1) >>> 0
  }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length)
    const tb = Buffer.from(t, 'ascii')
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([tb, d])))
    return Buffer.concat([l, tb, d, c])
  }
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(total, 0); ih.writeUInt32BE(total, 4); ih[8] = 8; ih[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- ASCII 渲染（方便贴到对话里） ---------- */
function renderAscii(size, matrix) {
  const lines = []
  // 上边框
  lines.push('　' + '▀'.repeat(size + 2))
  for (let y = 0; y < size; y++) {
    let line = '　▌'
    for (let x = 0; x < size; x++) {
      line += matrix[y][x] === 1 ? '█' : ' '
    }
    line += '▐'
    lines.push(line)
  }
  lines.push('　' + '▄'.repeat(size + 2))
  return lines.join('\n')
}

/* ---------- 主流程 ---------- */
const url = process.argv[2] || 'http://127.0.0.1:8899'
const bytes = utf8Bytes(url)
const ver = chooseVersion(bytes)
const codewords = buildCodewords(bytes, ver)
const { matrix, size } = buildMatrix(ver, codewords)
const png = renderPng(size, matrix, 10, 4)

const safe = url.replace(/[^a-zA-Z0-9]/g, '_')
const outPng = `D:\\清理\\qr-${safe}.png`
const outTxt = `D:\\清理\\qr-${safe}.txt`

writeFileSync(outPng, png)
writeFileSync(outTxt, url + '\n\n' + renderAscii(size, matrix), 'utf8')

console.log(`URL     ${url}`)
console.log(`版本    ${ver}  尺寸 ${size}x${size}  字节 ${bytes.length}`)
console.log(`PNG     ${outPng}  (${Math.round(png.length / 1024)}KB)`)
console.log(`ASCII   ${outTxt}`)
console.log('')
console.log(renderAscii(size, matrix))
