/**
 * 自测脚本：启动 dev-server（子进程，独立于调用方），
 * 跑完接口用例后自己退出。用 node 直接执行，不依赖 pwsh。
 *
 * 用法：
 *   node scripts/e2e.mjs
 * key 从环境变量 API_KEY 读；没给就用进程内已有的。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8791
const KEY = process.env.API_KEY
if (!KEY) {
  console.error('缺少 API_KEY')
  process.exit(1)
}

const env = Object.assign({}, process.env, {
  PORT: String(PORT),
  API_BASE_URL: process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  VISION_MODEL: process.env.VISION_MODEL || 'qwen3-omni-flash',
  TEXT_MODEL: process.env.TEXT_MODEL || 'qwen3-omni-flash',
  NODE_ENV: 'development'
})

const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: process.cwd(),
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
child.stdout.on('data', d => { serverLog += d.toString() })
child.stderr.on('data', d => { serverLog += '[ERR]' + d.toString() })

function request(path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise(resolve => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path, method, headers },
      resp => {
        let d = ''
        resp.on('data', c => { d += c })
        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: d }))
      }
    )
    r.on('error', e => resolve({ err: e.message }))
    if (body) r.write(body)
    r.end()
  })
}

/** 造一张有内容的 PNG（带噪声，保证体积 > 2KB 且视觉上可辨认） */
function makePng(w, h, kind) {
  const zlib = require('node:zlib')
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let p = 0
  for (let y = 0; y < h; y++) {
    raw[p++] = 0
    for (let x = 0; x < w; x++) {
      let r, g, b
      if (kind === 'router') {
        // 白色方盒 + 两根天线
        const inBody = y >= 150 && y <= 210 && x >= 60 && x <= 220
        const inBase = y > 210 && y <= 218 && x >= 64 && x <= 216
        const inAnt1 = x >= 84 && x <= 92 && y >= 60 && y <= 150
        const inAnt2 = x >= 188 && x <= 196 && y >= 60 && y <= 150
        if (inBody) { r = 232; g = 233; b = 236 }
        else if (inBase) { r = 198; g = 201; b = 206 }
        else if (inAnt1 || inAnt2) { r = 62; g = 64; b = 70 }
        else { r = 238 + ((x * 7 + y * 3) % 6); g = 241; b = 245 }
      } else {
        // 彩色噪声
        r = (x * 5 + y * 3) % 256
        g = (x * 3 + y * 7) % 256
        b = (x * 7 + y * 5) % 256
      }
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
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ])
}

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

const results = []
const check = (name, ok, info) => {
  results.push({ name, ok, info })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${info ? '  ' + info : ''}`)
}

console.log('\n═══ 端到端自测 ═══\n')

/* 等待服务器就绪 */
let ready = false
for (let i = 0; i < 40; i++) {
  const r = await request('/api/health')
  if (r.status === 200) { ready = true; break }
  await sleep(250)
}
check('服务器启动', ready)
if (!ready) {
  console.log(serverLog)
  child.kill()
  process.exit(1)
}

/* 1. health */
{
  const r = await request('/api/health')
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  check('health 返回 200', r.status === 200)
  check('health 不含密钥', !r.body.includes(KEY))
  check('health ok:true', j && j.ok === true)
}

/* 2. 静态首页 */
{
  const r = await request('/')
  check('首页 200', r.status === 200)
  check('首页是 HTML', (r.headers['content-type'] || '').includes('text/html'))
  check('首页含应用标题', (r.body || '').includes('该留该走'))
  check('首页含接口地址', (r.body || '').includes('/api/analyze'))
}

/* 3. 405 / OPTIONS */
{
  const r = await request('/api/analyze', { method: 'GET' })
  check('GET /api/analyze → 405', r.status === 405)
  const o = await request('/api/analyze', { method: 'OPTIONS' })
  check('OPTIONS 预检 → 2xx', o.status >= 200 && o.status < 300)
  check('预检带 CORS 头', Boolean(o.headers['access-control-allow-origin']))
}

/* 4. 参数错误 */
{
  const r = await request('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  const j = (() => { try { return JSON.parse(r.body) } catch { return null } })()
  check('空 JSON → 400 NO_IMAGE', r.status === 400 && j && j.code === 'NO_IMAGE', j && j.code)

  const r2 = await request('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json'
  })
  const j2 = (() => { try { return JSON.parse(r2.body) } catch { return null } })()
  check('坏 JSON → 400', r2.status === 400, j2 && j2.code)
}

/* 5. 真实识别（画一个路由器轮廓，看能否走通全链路） */
{
  const png = makePng(640, 640, 'router')
  const dataUrl = 'data:image/png;base64,' + png.toString('base64')
  console.log(`  · 测试图 ${png.length} 字节`)
  const t0 = Date.now()
  const bodyStr = JSON.stringify({ imageBase64: dataUrl })
  const r = await request('/api/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr)
    },
    body: bodyStr
  })
  const ms = Date.now() - t0
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  check('识别请求完成', r.status === 200, `${ms}ms`)
  check('响应 ok:true', j && j.ok === true, j && j.code ? j.code : '')
  check('有 verdict', Boolean(j && j.verdict), j && j.verdict)

  if (j && j.verdict === 'unknown') {
    check('unknown 时 price 为 null', j.price === null)
  } else if (j && j.verdict) {
    check('非 unknown 时含 category', Boolean(j.category && j.category.name), j.category && j.category.name)
    check('价格来自规则表（有价或明确无价）', j.price === null || (Array.isArray(j.price) && j.price.length === 2),
      j.price ? `¥${j.price[0]}–${j.price[1]}` : 'null')
    check('channels 是数组', Array.isArray(j.channels), `${(j.channels || []).length} 个`)
    check('有 reason', Boolean(j.reason), (j.reason || '').slice(0, 30))
  }
  check('响应不含密钥', !r.body.includes(KEY))
  check('响应不含上游地址', !r.body.includes('dashscope'))
  if (j && j.meta) check('meta 含耗时', Boolean(j.meta.visionMs || j.meta.totalMs), JSON.stringify(j.meta).slice(0, 160))
}

/* ---------- 汇总 ---------- */
const pass = results.filter(r => r.ok).length
console.log(`\n═══ 结果：${pass}/${results.length} 通过 ═══\n`)
if (pass < results.length) {
  console.log('未通过：')
  results.filter(r => !r.ok).forEach(r => console.log('  - ' + r.name + ' ' + (r.info || '')))
  console.log('\n服务器日志片段：')
  console.log(serverLog.slice(-1500))
}

child.kill()
await sleep(300)
process.exit(pass === results.length ? 0 : 1)
