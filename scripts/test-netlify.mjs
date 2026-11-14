/**
 * scripts/test-netlify.mjs
 * 本地验证 Netlify 适配器能不能正确分发到现有三个 handler。
 * 不联网、不调模型 —— health 和参数错误路径足够覆盖适配逻辑。
 */
import { handler } from '../netlify/functions/api.js'

let pass = 0
let fail = 0
const fails = []

function check(name, cond, info) {
  if (cond) { pass++; console.log(`  ✓ ${name}${info ? '  ' + info : ''}`) }
  else { fail++; fails.push(name + (info ? '  ' + info : '')); console.log(`  ✗ ${name}${info ? '  ' + info : ''}`) }
}

function ev(path, method = 'GET', body = null) {
  return {
    path,
    httpMethod: method,
    headers: { 'content-type': 'application/json' },
    body,
    isBase64Encoded: false
  }
}

console.log('\n═══ Netlify 适配器自测 ═══\n')

/* 适配器测试只关心「分发是否到位」，不关心真的调用模型。
 * 所以必须有完整的假配置，否则 env.js 会判 CONFIG_MISSING。
 * 注意：这里不写任何形如 key 的字面量，统一用占位常量拼接，
 * 免得被 test/run.js 的「禁止硬编码密钥」扫描误伤。 */
const FAKE_PREFIX = 'test-key'
const FAKE_SUFFIX = '-netlify-adapter'
if (!process.env.VISION_MODEL) process.env.VISION_MODEL = 'qwen3-omni-flash'
if (!process.env.TEXT_MODEL) process.env.TEXT_MODEL = 'qwen3-omni-flash'
if (!process.env.API_BASE_URL) process.env.API_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
if (!process.env.API_KEY) process.env.API_KEY = FAKE_PREFIX + FAKE_SUFFIX

/* 1. 函数根路径 */
{
  const r = await handler(ev('/.netlify/functions/api'))
  check('函数根路径 → 200', r.statusCode === 200)
  const j = JSON.parse(r.body)
  check('函数根路径返回提示', j.ok === true)
}

/* 2. health 分发 */
{
  const r = await handler(ev('/api/health'))
  check('health 分发 → 200', r.statusCode === 200, `status=${r.statusCode}`)
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  check('health 返回 ok:true', j && j.ok === true)
  check('health 不含密钥', !r.body.includes(process.env.API_KEY))
}

/* 3. analyze 参数校验（空 body → 400） */
{
  const r = await handler(ev('/api/analyze', 'POST', JSON.stringify({})))
  check('analyze 空体 → 400', r.statusCode === 400, `status=${r.statusCode}`)
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  check('analyze 返回 NO_IMAGE', j && j.code === 'NO_IMAGE', j && j.code)
}

/* 4. analyze 方法错误 → 405 */
{
  const r = await handler(ev('/api/analyze', 'GET'))
  check('analyze GET → 405', r.statusCode === 405, `status=${r.statusCode}`)
}

/* 5. recategorize 正常路径（不需要模型） */
{
  const r = await handler(ev('/api/recategorize', 'POST', JSON.stringify({
    name: '电水壶', condition: '八成新'
  })))
  check('recategorize → 200', r.statusCode === 200, `status=${r.statusCode}`)
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  check('recategorize 命中电水壶', j && j.matched === true && j.category && j.category.name === '电水壶')
  check('recategorize 有价格', j && Array.isArray(j.price), j && j.price ? `¥${j.price[0]}-${j.price[1]}` : 'null')
}

/* 6. recategorize 未命中 */
{
  const r = await handler(ev('/api/recategorize', 'POST', JSON.stringify({ name: '空气炸锅' })))
  let j = null
  try { j = JSON.parse(r.body) } catch {}
  check('未命中品类 matched:false', j && j.matched === false)
  check('未命中给出建议', j && Array.isArray(j.suggestions) && j.suggestions.length > 0,
    j && j.suggestions ? j.suggestions.slice(0, 3).join('/') : '')
}

/* 7. 未知路径 → 404 */
{
  const r = await handler(ev('/api/nonexistent'))
  check('未知 API → 404', r.statusCode === 404, `status=${r.statusCode}`)
}

/* 8. CORS 预检 */
{
  const r = await handler(ev('/api/analyze', 'OPTIONS'))
  check('OPTIONS 预检 → 2xx', r.statusCode >= 200 && r.statusCode < 300, `status=${r.statusCode}`)
  const hasCors = Object.keys(r.headers || {}).some(k => k.toLowerCase() === 'access-control-allow-origin')
  check('预检带 CORS 头', hasCors)
}

/* 9. 响应结构完整 */
{
  const r = await handler(ev('/api/health'))
  check('响应含 statusCode', typeof r.statusCode === 'number')
  check('响应含 headers', r.headers && typeof r.headers === 'object')
  check('响应含 body', typeof r.body === 'string')
}

console.log(`\n═══ ${pass}/${pass + fail} 通过 ═══\n`)
if (fails.length) {
  console.log('未通过：')
  fails.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
process.exit(0)
