/**
 * scripts/test-recategorize.mjs
 * 自测改名重查接口：启动 server → 打各种名字 → 报告匹配与建议
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8798
const env = Object.assign({}, process.env, {
  PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development',
  API_KEY: process.env.API_KEY || 'test-key-for-local',
  API_BASE_URL: process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
})

const child = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', d => { log += d.toString() })
child.stderr.on('data', d => { log += d.toString() })

function post(path, obj) {
  return new Promise(resolve => {
    const body = JSON.stringify(obj)
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, resp => {
      let d = ''
      resp.on('data', c => { d += c })
      resp.on('end', () => {
        let j = null
        try { j = JSON.parse(d) } catch {}
        resolve({ status: resp.statusCode, body: j })
      })
    })
    r.on('error', e => resolve({ err: String(e.message).slice(0, 60) }))
    r.write(body); r.end()
  })
}

let ready = false
for (let i = 0; i < 40; i++) {
  const r = await post('/api/recategorize', { name: 'ping' })
  if (r.status) { ready = true; break }
  await sleep(250)
}
if (!ready) { console.log('服务器没起来\n' + log.slice(-1200)); child.kill(); process.exit(1) }

console.log('\n═══ 改名重查自测 ═══\n')

const CASES = [
  // [输入名, 期望命中, 期望品类或null, 说明]
  ['电水壶', true, '电水壶', '精确命中'],
  ['iPad', true, '平板', '同义词映射到平板'],
  ['保温杯', true, '电水壶', '同义词映射'],
  ['毛衣', true, '卫衣 / T恤', '同义词映射'],
  ['空气炸锅', false, null, '表里没有'],
  ['iphone', true, '手机', '同义词映射到手机'],
  ['macbook', true, '笔记本', '同义词映射到笔记本'],
  ['羽绒服', true, '羽绒服', '精确命中'],
  ['大衣', true, '大衣 / 风衣', '拆分名命中'],
  ['鸭绒服', true, '羽绒服', '别名命中'],
  ['背包', true, '背包 / 双肩包', '同义词映射到背包（已从女包独立）'],
  ['', false, null, '空名应 400']
]

let pass = 0
const fails = []

for (const [name, wantMatch, wantCat, note] of CASES) {
  const r = await post('/api/recategorize', { name, condition: '八成新' })
  const b = r.body || {}

  if (name === '') {
    const ok = r.status === 400 && b.code === 'NO_NAME'
    console.log(`  ${ok ? '✓' : '✗'} 空名 → ${r.status} ${b.code || ''}`)
    ok ? pass++ : fails.push('空名应返回 400 NO_NAME')
    continue
  }

  const okMatch = b.matched === wantMatch
  const okCat = wantCat === null || (b.category && b.category.name === wantCat)
  const ok = okMatch && okCat

  const detail = b.matched
    ? `${b.category.name} · ${b.verdict} · ${b.price ? '¥' + b.price[0] + '-' + b.price[1] : '无价'}`
    : `未命中 → 建议 [${(b.suggestions || []).slice(0, 4).join(' / ')}]`

  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(10)} ${detail}`)
  if (!ok) fails.push(`${name}: 期望 matched=${wantMatch} cat=${wantCat}，实际 matched=${b.matched} cat=${b.category ? b.category.name : null}`)
  ok ? pass++ : null
}

/* 建议质量检查：真正表里没有的品类，要给有用的建议 */
const sugCheck = await post('/api/recategorize', { name: 'switch游戏机' })
const sug = (sugCheck.body && sugCheck.body.suggestions) || []
console.log(`\n  「switch游戏机」的建议：${sug.join(' / ') || '(空)'}`)

const emptySug = await post('/api/recategorize', { name: '空气炸锅' })
console.log(`  「空气炸锅」的建议：${((emptySug.body && emptySug.body.suggestions) || []).join(' / ') || '(空)'}`)

/* 未命中时必须给出非空建议，否则用户无从下手 */
for (const [label, resp] of [['switch游戏机', sugCheck], ['空气炸锅', emptySug]]) {
  if (resp.body && resp.body.matched === false) {
    const list = resp.body.suggestions || []
    if (!list.length) fails.push(`${label} 未命中但没有给建议`)
  }
}

console.log(`\n═══ ${pass}/${CASES.length} 通过 ═══`)
if (fails.length) {
  console.log('\n未通过：')
  fails.forEach(f => console.log('  - ' + f))
}

child.kill()
await sleep(200)
process.exit(fails.length ? 1 : 0)
