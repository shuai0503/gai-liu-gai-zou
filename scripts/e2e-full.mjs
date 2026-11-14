/**
 * scripts/e2e-full.mjs
 * 完整链路验证：启动 server → 多张图真实识别 → 检查响应 → 关闭
 * 与 e2e.mjs 的区别：这个专门测「识别成功」分支，要拿到 sell/donate 结果。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const zlib = require('node:zlib')

const PORT = 8793
const KEY = process.env.API_KEY
if (!KEY) { console.error('缺少 API_KEY'); process.exit(1) }

const env = Object.assign({}, process.env, {
  PORT: String(PORT),
  API_BASE_URL: process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  VISION_MODEL: process.env.VISION_MODEL || 'qwen3-omni-flash',
  TEXT_MODEL: process.env.TEXT_MODEL || 'qwen3-omni-flash',
  NODE_ENV: 'development'
})

const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
child.stdout.on('data', d => { serverLog += d.toString() })
child.stderr.on('data', d => { serverLog += '[ERR]' + d.toString() })

function request(path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, resp => {
      let d = ''
      resp.on('data', c => { d += c })
      resp.on('end', () => resolve({ status: resp.statusCode, body: d }))
    })
    r.on('error', e => resolve({ err: String(e.message) }))
    if (body) r.write(body)
    r.end()
  })
}

/* ---------- 画图 ---------- */
function makePng(size, paint) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b] = paint(x, y, size)
      raw[p++] = r; raw[p++] = g; raw[p++] = b
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 })
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
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ])
}

const S = 640

/* 书堆：横条彩色矩形，最像书 */
const booksPaint = (x, y) => {
  const bands = [
    [430, 500, 120, 530, [186, 92, 84]],
    [350, 430, 145, 505, [74, 124, 176]],
    [280, 350, 168, 485, [214, 176, 86]],
    [210, 280, 192, 462, [104, 156, 116]]
  ]
  for (const [y0, y1, x0, x1, c] of bands) {
    if (y >= y0 && y < y1 && x >= x0 && x <= x1) {
      if (x - x0 < 12 || x1 - x < 12) return [c[0] * 0.72, c[1] * 0.72, c[2] * 0.72]
      return c
    }
  }
  return [250, 248, 244]
}

/* 鞋：侧面轮廓 */
const shoePaint = (x, y) => {
  const bg = [242, 244, 247]
  // 鞋底
  if (y >= 430 && y <= 470 && x >= 150 && x <= 520) return [58, 60, 66]
  // 鞋身
  if (y >= 320 && y <= 430) {
    const t = (y - 320) / 110
    const left = 150 + t * 30
    const right = 520 - t * 120
    if (x >= left && x <= right) return [232, 234, 238]
  }
  // 鞋帮
  if (y >= 250 && y <= 320 && x >= 300 && x <= 470) return [204, 208, 214]
  // 鞋带
  if (y >= 300 && y <= 420 && x >= 250 && x <= 400) return [90, 94, 102]
  return bg
}

const CASES = [
  { key: 'books', label: '一摞彩色书', paint: booksPaint },
  { key: 'shoe', label: '白色运动鞋', paint: shoePaint }
]

console.log('\n═══ 完整链路验证（真实模型）═══\n')

let ready = false
for (let i = 0; i < 40; i++) {
  const r = await request('/api/health')
  if (r.status === 200) { ready = true; break }
  await sleep(250)
}
if (!ready) { console.log('服务器未启动\n' + serverLog); child.kill(); process.exit(1) }
console.log('服务器就绪\n')

const rows = []

for (const c of CASES) {
  const png = makePng(S, c.paint)
  const dataUrl = 'data:image/png;base64,' + png.toString('base64')
  const bodyStr = JSON.stringify({ imageBase64: dataUrl })
  const t0 = Date.now()
  const r = await request('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    body: bodyStr
  })
  const ms = Date.now() - t0
  let j = null
  try { j = JSON.parse(r.body) } catch {}

  const row = {
    case: c.key,
    label: c.label,
    imgBytes: png.length,
    ms,
    status: r.status,
    verdict: j && j.verdict,
    category: j && j.category && j.category.name,
    condition: j && j.condition,
    price: j && j.price,
    reason: j && j.reason,
    copywriting: j && j.copywriting,
    channels: j && j.channels && j.channels.map(x => (typeof x === 'string' ? x : x.name)),
    visionMs: j && j.meta && j.meta.visionMs
  }
  rows.push(row)

  console.log(`▶ ${c.label}  (${png.length} 字节)`)
  console.log(`  状态 ${r.status} · 总耗时 ${ms}ms${row.visionMs ? ' · 视觉 ' + row.visionMs + 'ms' : ''}`)
  if (row.verdict === 'unknown') {
    console.log('  结果 unknown（模型没认出来）')
  } else if (row.verdict) {
    console.log(`  品类 ${row.category} / 成色 ${row.condition}`)
    console.log(`  结论 ${row.verdict} / 价格 ${row.price ? '¥' + row.price[0] + '–' + row.price[1] : '无'}`)
    console.log(`  渠道 ${(row.channels || []).join(' · ') || '-'}`)
    console.log(`  理由 ${row.reason}`)
    console.log(`  文案 ${row.copywriting ? String(row.copywriting).replace(/\n/g, ' ') : '(空)'}`)
  }
  if (j && j.meta) console.log(`  meta ${JSON.stringify(j.meta).slice(0, 200)}`)
  console.log('')
}

/* ---------- 断言 ---------- */
console.log('═══ 检查项 ═══')
const checks = []
const push = (n, ok, info) => { checks.push({ n, ok, info }); console.log(`  ${ok ? '✓' : '✗'} ${n}${info ? '  ' + info : ''}`) }

for (const r of rows) {
  push(`${r.case}: HTTP 200`, r.status === 200)
  push(`${r.case}: ok:true`, r.verdict !== undefined)
  push(`${r.case}: 有 verdict`, Boolean(r.verdict), r.verdict)
  if (r.verdict && r.verdict !== 'unknown') {
    push(`${r.case}: 品类非空`, Boolean(r.category), r.category)
    push(`${r.case}: reason 非空`, Boolean(r.reason), (r.reason || '').slice(0, 20))
    push(`${r.case}: 渠道来自规则表`, Array.isArray(r.channels), (r.channels || []).join('/'))
    if (r.price) {
      push(`${r.case}: 价格是二元数组`, Array.isArray(r.price) && r.price.length === 2, JSON.stringify(r.price))
      push(`${r.case}: 低价<高价`, r.price[0] < r.price[1])
    }
    if (r.copywriting) {
      const noPrice = !/(?:[¥￥]\s*\d|\d+\s*(?:元|块))/.test(r.copywriting)
      push(`${r.case}: 文案不含价格数字`, noPrice, noPrice ? '' : r.copywriting.slice(0, 40))
    }
  }
}

const pass = checks.filter(c => c.ok).length
console.log(`\n═══ ${pass}/${checks.length} 通过 ═══\n`)

const unknownCount = rows.filter(r => r.verdict === 'unknown').length
console.log(`识别成功 ${rows.length - unknownCount}/${rows.length}，unknown ${unknownCount}`)
const priced = rows.filter(r => r.price).length
console.log(`给出价格 ${priced}/${rows.length}`)
const vTimes = rows.map(r => r.visionMs).filter(Boolean)
if (vTimes.length) console.log(`视觉耗时 ${Math.min(...vTimes)}–${Math.max(...vTimes)}ms`)

if (pass < checks.length) {
  console.log('\n未通过：')
  checks.filter(c => !c.ok).forEach(c => console.log('  - ' + c.n + ' ' + (c.info || '')))
  console.log('\n服务器日志：')
  console.log(serverLog.slice(-2000))
}

child.kill()
await sleep(300)
process.exit(pass === checks.length ? 0 : 1)
