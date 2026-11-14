/**
 * scripts/e2e-photo.mjs
 * 用真实照片跑完整链路（这才是评审时会遇到的真实输入）
 * 用法：node scripts/e2e-photo.mjs "C:\path\to\photo.jpg"
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8795
const KEY = process.env.API_KEY
if (!KEY) { console.error('缺少 API_KEY'); process.exit(1) }

const paths = process.argv.slice(2).filter(p => existsSync(p))
if (!paths.length) { console.error('用法：node scripts/e2e-photo.mjs <图片路径> [...]'); process.exit(1) }

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

let ready = false
for (let i = 0; i < 40; i++) {
  const r = await request('/api/health')
  if (r.status === 200) { ready = true; break }
  await sleep(250)
}
if (!ready) { console.log('服务器未启动\n' + serverLog); child.kill(); process.exit(1) }

console.log('\n═══ 真实照片识别 ═══\n')

const rows = []
for (const p of paths) {
  const buf = readFileSync(p)
  const ext = p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
  const dataUrl = `data:${ext};base64,` + buf.toString('base64')
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

  const name = p.split(/[\\/]/).pop()
  console.log(`▶ ${name}  (${Math.round(buf.length / 1024)}KB)`)
  console.log(`  状态 ${r.status} · ${ms}ms`)
  if (j && j.verdict === 'unknown') {
    console.log(`  → unknown（${(j.meta && j.meta.rejected) || 'not_recognized'}）`)
  } else if (j && j.verdict) {
    console.log(`  品类：${j.category && j.category.name}（${j.category && j.category.group}）`)
    console.log(`  成色：${j.condition}  材质：${j.material || '未识别'}`)
    console.log(`  结论：${j.verdict}`)
    console.log(`  价格：${j.price ? '¥' + j.price[0] + '–' + j.price[1] : '无'}`)
    console.log(`  渠道：${(j.channels || []).map(c => (typeof c === 'string' ? c : c.name)).join(' · ')}`)
    console.log(`  理由：${j.reason}`)
    if (j.damage) console.log(`  瑕疵：${j.damage}`)
    if (j.copywriting) console.log(`  文案：${String(j.copywriting).replace(/\n/g, ' / ')}`)
    console.log(`  meta：${JSON.stringify(j.meta).slice(0, 220)}`)
  } else {
    console.log(`  异常响应：${r.body.slice(0, 300)}`)
  }
  console.log('')
  rows.push({ name, verdict: j && j.verdict, category: j && j.category && j.category.name, price: j && j.price })
}

const recognized = rows.filter(r => r.verdict && r.verdict !== 'unknown').length
const priced = rows.filter(r => r.price).length
console.log(`═══ 识别成功 ${recognized}/${rows.length} · 给出价格 ${priced}/${rows.length} ═══\n`)

child.kill()
await sleep(300)
process.exit(0)
