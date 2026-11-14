/* ============================================================
 * test/run.js · 不依赖任何测试框架的端到端自测
 * ------------------------------------------------------------
 * 运行：node test/run.js
 *
 * 为什么不用 jest/vitest：
 *   这个环境里装不了包，而且评审也想直接 node 一跑就看到全绿。
 *   下面自带一个极小的断言与用例收集器，60 行就够。
 *
 * 覆盖面（全部在进程内跑，不需要起 HTTP 服务器）：
 *   1. 规则表镜像一致性（防止两份规则分叉）
 *   2. 规则表自身 selfCheck
 *   3. 正常路径（multipart 与 JSON 两种上传方式）
 *   4. unknown 路径（模型说认不出 / 品类不在表里 / 置信度低）
 *   5. schema 校验失败 → 自动重试 1 次（视觉段、文本段各一条）
 *   6. 重试仍失败 → 502
 *   7. 超时 → 504
 *   8. 参数错误 → 400（无图 / 太大 / 格式不支持 / 非 POST）
 *   9. 密钥不外泄（扫描所有响应体与错误信息）
 *  10. 分工断言（响应里的价格必须等于规则表算出来的那个数）
 * ============================================================ */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, sep } from 'node:path'
import { createHash } from 'node:crypto'

/* ---------------- 极简用例收集器 ---------------- */

const cases = []
function test(name, fn) {
  cases.push({ name, fn })
}

let passed = 0
const failures = []

async function runAll() {
  for (const c of cases) {
    try {
      await c.fn()
      passed++
      console.log(`  \x1b[32m✓\x1b[0m ${c.name}`)
    } catch (e) {
      failures.push({ name: c.name, error: e })
      console.log(`  \x1b[31m✗\x1b[0m ${c.name}`)
      console.log(`      ${String(e && e.message).split('\n')[0]}`)
    }
  }
}

/* ---------------- 环境准备 ---------------- */

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..')
const WORKSPACE = join(SERVER, '..')

// 必须在 import 业务模块之前设置：这些是 mock 模式的开关
process.env.MOCK_MODE = '1'
process.env.NODE_ENV = 'test'
process.env.API_KEY = 'test-key-not-real'
process.env.API_BASE_URL = 'https://mock.local/v1'
process.env.VISION_MODEL = 'mock-vision'
process.env.TEXT_MODEL = 'mock-text'
process.env.VISION_TIMEOUT_MS = '300'
process.env.TEXT_TIMEOUT_MS = '300'
process.env.ALLOW_ORIGIN = '*'
process.env.MOCK_LATENCY_MS = '5'

const { default: analyze } = await import('../api/analyze.js')
const { default: health } = await import('../api/health.js')
const { loadRules, judge, resolveCategory } = await import('../lib/rules.js')
const { validate, validateWriter, OBSERVATION_SCHEMA } = await import('../lib/schema.js')
const { buildMirror, readMirrorHash, sha256 } = await import('../scripts/sync-rules.mjs')

/* ---------------- 假 req / res ---------------- */

/**
 * 构造一个足够真实的 req：
 *   - 有 method / headers
 *   - 是 async iterable（readBody 会 for await 它）
 *   - 没有 .body（模拟裸流，走拼接分支）
 */
function makeReq({ method = 'POST', headers = {}, body = null }) {
  const chunks = body ? [Buffer.from(body)] : []
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    }
  }
}

/** 构造 res：把状态码、头、body 都收集起来 */
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { res.headers[String(k).toLowerCase()] = v },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.body = String(chunk)
      res.ended = true
    }
  }
  return res
}

/** 跑一次 analyze，返回 { status, json, headers } */
async function callAnalyze(req) {
  const res = makeRes()
  await analyze(req, res)
  let json = null
  if (res.body) {
    try { json = JSON.parse(res.body) } catch { json = null }
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers }
}

/* ---------------- 测试用图片 ---------------- */

/** 一张最小的合法 JPEG 头 + 填充（不需要真能解码，只要文件头对） */
function fakeJpeg(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x20)
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0
  return buf
}

function fakePng(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x20)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  return buf
}

/** 拼一个 multipart 请求体 */
function multipartBody(fieldName, filename, mime, data, boundary = '----testboundary123') {
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`,
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { body: Buffer.concat([head, data, tail]), boundary }
}

function multipartReq(data, { fieldName = 'image', filename = 'photo.jpg', mime = 'image/jpeg' } = {}) {
  const { body, boundary } = multipartBody(fieldName, filename, mime, data)
  return makeReq({
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body
  })
}

function jsonReq(dataUrl) {
  return makeReq({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64: dataUrl })
  })
}

/* ---------------- 场景切换 ---------------- */

/** 切换 mock 场景（env.buildDeps 每次调用都会重读 process.env） */
function scenario(name) {
  process.env.MOCK_MODE = '1'
  process.env.MOCK_SCENARIO = name
}

function realMode() {
  process.env.MOCK_MODE = '0'
}

/* ============================================================
 * 1. 规则表一致性
 * ============================================================ */

test('规则表镜像与源文件哈希一致（防止两份规则分叉）', async () => {
  const { hash } = await buildMirror()
  const mirrorHash = await readMirrorHash()
  assert.ok(mirrorHash, '镜像文件缺失或没有哈希头，请运行 node scripts/sync-rules.mjs')
  assert.equal(mirrorHash, hash, '镜像已过期，请运行 node scripts/sync-rules.mjs')
})

test('镜像文件内容 = 头部声明 + 源文件原文', async () => {
  const source = await readFile(join(WORKSPACE, '该留该走-品类规则表.js'), 'utf8')
  const mirror = await readFile(join(SERVER, 'lib', 'rules-table.js'), 'utf8')
  assert.ok(mirror.includes('自动生成的文件'), '镜像缺少自动生成声明')
  assert.ok(mirror.endsWith(source), '镜像正文与源文件不一致')
  assert.equal(sha256(source).length, 64)
})

test('规则表自检：品类数合理，五种 verdict 都有覆盖', async () => {
  const rules = await loadRules()
  const check = rules.selfCheck()
  /* 不再硬编码品类数 —— 每加一个品类就挂测试毫无意义。
   * 改为校验「数量在合理区间」+「没有 unknown」+「各分支都有覆盖」。 */
  assert.ok(check.total >= 30, `品类数太少：${check.total}`)
  assert.ok(check.total <= 80, `品类数异常：${check.total}`)
  assert.equal(check.total, rules.CATEGORIES.length, 'selfCheck 总数应与 CATEGORIES 一致')
  assert.equal(check.tally.unknown, 0, '不应有 unknown 分支的品类')
  assert.ok(check.tally.sell > 0, '没有 sell 分支')
  assert.ok(check.tally.recycle > 0, '没有 recycle 分支')
  assert.ok(check.tally.donate > 0, '没有 donate 分支')
})

test('规则表来源可识别（源码原件优先，其次镜像）', async () => {
  const rules = await loadRules()
  assert.ok(['source', 'mirror'].includes(rules.source), `未知来源 ${rules.source}`)
})

/* ============================================================
 * 2. 品类匹配健壮性
 * ============================================================ */

test('品类匹配：英文 id 精确命中', async () => {
  const rules = await loadRules()
  const { cat, via } = resolveCategory(rules.CATEGORIES, 'down-jacket')
  assert.equal(cat.id, 'down-jacket')
  assert.equal(via, 'exact')
})

test('品类匹配：中文名精确命中', async () => {
  const rules = await loadRules()
  const { cat } = resolveCategory(rules.CATEGORIES, '羽绒服')
  assert.equal(cat.id, 'down-jacket')
})

test('品类匹配：别名命中（鸭绒服 → 羽绒服）', async () => {
  const rules = await loadRules()
  const { cat } = resolveCategory(rules.CATEGORIES, '鸭绒服')
  assert.equal(cat.id, 'down-jacket')
})

test('品类匹配：带修饰词也能命中（黑色长款羽绒服）', async () => {
  const rules = await loadRules()
  const { cat, via } = resolveCategory(rules.CATEGORIES, '黑色长款羽绒服')
  assert.equal(cat.id, 'down-jacket')
  assert.equal(via, 'contains')
})

test('品类匹配：不在表里返回 null（北面1996羽绒服）', async () => {
  const rules = await loadRules()
  const { cat } = resolveCategory(rules.CATEGORIES, '北面1996羽绒服')
  // 它含"羽绒服"三个字，包含匹配会命中 —— 这是刻意的：
  // 用户拍的是羽绒服，按羽绒服档报价是合理的，不能因为不是基础款就拒答。
  assert.ok(cat === null || cat.id === 'down-jacket')
})

test('品类匹配：完全不相关返回 null', async () => {
  const rules = await loadRules()
  const { cat } = resolveCategory(rules.CATEGORIES, '一辆汽车的轮胎')
  assert.equal(cat, null)
})

/* ============================================================
 * 3. 正常路径
 * ============================================================ */

test('正常路径 · multipart 上传 → sell + 价格来自规则表', async () => {
  scenario('normal')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, `状态码 ${r.status}：${r.raw}`)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.verdict, 'sell')
  assert.equal(r.json.category.id, 'down-jacket')
  assert.equal(r.json.category.name, '羽绒服')
  assert.equal(r.json.category.group, '服饰')
  assert.equal(r.json.condition, '八成新')
  assert.equal(r.json.material, '鹅绒')
  assert.ok(Array.isArray(r.json.price) && r.json.price.length === 2, 'price 应为两元组')
  assert.equal(typeof r.json.reason, 'string')
  assert.ok(r.json.reason.length > 0, 'reason 不能为空')
  assert.ok(Array.isArray(r.json.channels) && r.json.channels.length > 0, 'channels 不能为空')
  assert.equal(typeof r.json.channels[0].name, 'string')
  assert.equal(typeof r.json.channels[0].desc, 'string')
  assert.ok(r.json.copywriting && r.json.copywriting.length > 0, 'sell 分支应有文案')
  assert.equal(r.json.meta.mock, true)
  assert.equal(r.json.meta.transport, 'multipart')
})

test('正常路径 · JSON base64 上传 → 结果一致', async () => {
  scenario('normal')
  const dataUrl = `data:image/jpeg;base64,${fakeJpeg().toString('base64')}`
  const r = await callAnalyze(jsonReq(dataUrl))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.verdict, 'sell')
  assert.equal(r.json.meta.transport, 'json')
})

test('正常路径 · 裸 base64（不带 data: 前缀）也能收', async () => {
  scenario('normal')
  const r = await callAnalyze(jsonReq(fakeJpeg().toString('base64')))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.verdict, 'sell')
})

test('正常路径 · PNG 也能收', async () => {
  scenario('normal')
  const { body, boundary } = multipartBody('image', 'p.png', 'image/png', fakePng())
  const r = await callAnalyze(makeReq({
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body
  }))
  assert.equal(r.status, 200, r.raw)
})

test('正常路径 · hasWarranty 开关会真的影响规则表结论', async () => {
  // 用电水壶（八成新 → 13–33 元，high < 100）来验证：
  // decide() 在「保修期内 + 残值 < 100」时会改判 keep，而不是 sell。
  // 这条用例真正要守的是「接口把 hasWarranty 透传到了决策层」。
  scenario('kettle')

  const build = (warrantyValue) => {
    const b = '----warrantyboundary'
    const imgPart = Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="image"; filename="a.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    )
    const tail = warrantyValue === null
      ? Buffer.from(`\r\n--${b}--\r\n`)
      : Buffer.from(
          `\r\n--${b}\r\nContent-Disposition: form-data; name="hasWarranty"\r\n\r\n${warrantyValue}` +
          `\r\n--${b}--\r\n`
        )
    return makeReq({
      headers: { 'content-type': `multipart/form-data; boundary=${b}` },
      body: Buffer.concat([imgPart, fakeJpeg(), tail])
    })
  }

  const without = await callAnalyze(build(null))
  assert.equal(without.status, 200, without.raw)
  assert.equal(without.json.verdict, 'sell', '不带保修信息时应正常建议出售')

  const withWarranty = await callAnalyze(build('1'))
  assert.equal(withWarranty.status, 200, withWarranty.raw)
  assert.equal(withWarranty.json.verdict, 'keep', '保修期内应改判 keep')

  // 与直接调用规则表的结果必须完全一致（分工断言）
  // 注意：mock 里 VISION_OK 的品牌档位是 brand，judge 必须用同一档才算对等比较
  const expected = judge('kettle', { condition: '八成新', hasWarranty: true, brandTier: 'brand' })
  assert.equal(withWarranty.json.verdict, expected.verdict)
  assert.deepEqual(withWarranty.json.price, expected.price)
})

/* ============================================================
 * 4. 分工断言：价格必须来自规则表，不能来自模型
 * ============================================================ */test('分工 · 响应里的 price 与 judge() 纯函数结果完全一致', async () => {
  scenario('normal')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  await loadRules()
  const expected = judge('down-jacket', { condition: '八成新', brandTier: 'brand' })
  assert.deepEqual(r.json.price, expected.price, '价格必须由规则表算出，模型不得参与')
})

test('品牌 · 响应里的 brand 块与模型给的档位一致', async () => {
  scenario('normal')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.json.brand.applied, true, '羽绒服应吃品牌系数')
  assert.equal(r.json.brand.tier, 'brand', 'mock 模型给的是 brand')
  assert.equal(r.json.brand.factor, 1, 'brand 档系数应为 1')
  assert.equal(r.json.brand.modelSaid, 'brand')
})

test('品牌 · 不同档位真的会改变价格', async () => {
  const { decide } = await loadRules()
  const g = decide('earbuds', { condition: '八成新', brandTier: 'generic' })
  const b = decide('earbuds', { condition: '八成新', brandTier: 'brand' })
  const p = decide('earbuds', { condition: '八成新', brandTier: 'premium' })
  assert.ok(g.price[1] < b.price[1], 'generic 上限应低于 brand')
  assert.ok(b.price[1] < p.price[1], 'brand 上限应低于 premium')
})

test('品牌 · 不敏感品类不吃品牌系数', async () => {
  const { decide } = await loadRules()
  const plain = decide('kid-book', { condition: '八成新' })
  const premium = decide('kid-book', { condition: '八成新', brandTier: 'premium' })
  assert.deepEqual(plain.price, premium.price, '儿童绘本不该受品牌影响')
  assert.equal(premium.brandApplied, false)
})

test('品牌 · 未指定档位时按 brand（基准价）算且标记 unknown', async () => {
  const { decide } = await loadRules()
  const r = decide('earbuds', { condition: '八成新' })
  const b = decide('earbuds', { condition: '八成新', brandTier: 'brand' })
  assert.deepEqual(r.price, b.price, '未指定应按 brand 基准价，不是 generic')
  assert.equal(r.brandUnknown, true, '未指定要标记为 unknown 以便前端提示')
  assert.equal(r.brandFactor, 1, 'brand 档系数为 1')
})

test('品牌 · 默认价不应低于市场基准太多', async () => {
  const { decide } = await loadRules()
  // 羽绒服基准 120-180，八成新系数 0.65 → 78-117
  const r = decide('down-jacket', { condition: '八成新' })
  assert.equal(r.price[0], 78, '默认低价应等于基准×成色，不能再打折')
  assert.equal(r.price[1], 117, '默认高价应等于基准×成色')
})

test('品牌 · premium 系数按品类细化', async () => {
  const { decide } = await loadRules()
  const ear = decide('earbuds', { condition: '八成新', brandTier: 'premium' })
  const kettle = decide('kettle', { condition: '八成新', brandTier: 'premium' })
  assert.equal(ear.brandFactor, 8, '耳机 premium 应为 8 倍')
  assert.equal(kettle.brandFactor, 2.5, '电水壶 premium 用全局 2.5')
  assert.ok(ear.brandFactor > kettle.brandFactor, '数码溢价应高于小家电')
})

test('品牌 · 价格不会突破品类上限', async () => {
  const { decide } = await loadRules()
  const p = decide('phone', { condition: '全新未拆', brandTier: 'premium' })
  assert.ok(p.price[1] <= 12000, `手机上限应为 12000，实际 ${p.price[1]}`)
  assert.ok(p.price[0] < p.price[1], '压缩后低价仍应小于高价')
})

test('分工 · 渠道名与规则表 CATEGORIES 里的 channels 对得上', async () => {
  scenario('normal')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  const rules = await loadRules()
  const cat = rules.CATEGORIES.find(c => c.id === 'down-jacket')
  for (const ch of r.json.channels) {
    assert.ok(cat.channels.includes(ch.name), `渠道 ${ch.name} 不在规则表里`)
  }
})

test('分工 · 视觉模型 schema 里根本没有 price / channels 字段', () => {
  const keys = Object.keys(OBSERVATION_SCHEMA.properties)
  assert.ok(!keys.includes('price'), 'OBSERVATION_SCHEMA 不应有 price 字段')
  assert.ok(!keys.includes('channels'), 'OBSERVATION_SCHEMA 不应有 channels 字段')
  assert.ok(!keys.includes('verdict'), 'verdict 应由规则表决定，不应由视觉模型给')
  assert.equal(OBSERVATION_SCHEMA.additionalProperties, false, '必须禁止额外字段，否则模型能塞价格')
})

test('分工 · 文本模型写了价格会被 schema 判为不合格', () => {
  const r = validateWriter({ reason: '这件 120 元挂闲鱼很好卖。', copywriting: '' }, ['闲鱼'])
  assert.equal(r.valid, false, '带价格与平台名的 reason 必须被判不合格')
  assert.ok(r.errors.length > 0)
})

test('分工 · 文本模型写了平台名但没写价格，也不合格', () => {
  const r = validateWriter({ reason: '挂到闲鱼上很快就有人要。', copywriting: '' }, ['闲鱼'])
  assert.equal(r.valid, false)
})

test('分工 · 合规文案通过校验', () => {
  const r = validateWriter({
    reason: '还能穿得出去，二手有明确买家。',
    copywriting: '八成新鹅绒羽绒服，L 码，无破损。\n#羽绒服 #冬装 #闲置'
  }, ['闲鱼'])
  assert.equal(r.valid, true, JSON.stringify(r.errors))
})

test('分工 · 视觉 schema 拒绝模型顺手塞进来的价格字段', () => {
  const r = validate(OBSERVATION_SCHEMA, {
    recognized: true,
    categoryId: 'down-jacket',
    categoryName: '羽绒服',
    condition: '八成新',
    material: '鹅绒',
    damage: '',
    confidence: 'high',
    brandTier: 'brand',
    price: 120
  })
  assert.equal(r.valid, false, '额外字段 price 必须被拒绝')
})

test('品牌 · 视觉 schema 拒绝非法档位', () => {
  const r = validate(OBSERVATION_SCHEMA, {
    recognized: true,
    categoryId: 'down-jacket',
    categoryName: '羽绒服',
    condition: '八成新',
    material: '鹅绒',
    damage: '',
    confidence: 'high',
    brandTier: 'ultra-luxury'
  })
  assert.equal(r.valid, false, '非三档枚举的品牌值必须被拒绝')
})

test('品牌 · 缺少 brandTier 视为不合格', () => {
  const r = validate(OBSERVATION_SCHEMA, {
    recognized: true,
    categoryId: 'down-jacket',
    categoryName: '羽绒服',
    condition: '八成新',
    material: '鹅绒',
    damage: '',
    confidence: 'high'
  })
  assert.equal(r.valid, false, 'brandTier 是必填字段')
})

/* ============================================================
 * 5. unknown 路径（不给猜测性结论）
 * ============================================================ */

test('unknown · 模型说认不出 → 200 + verdict unknown', async () => {
  scenario('unknown')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.verdict, 'unknown')
  assert.equal(r.json.reason, '没认出来，请换个角度重拍')
  assert.equal(r.json.price, null)
  assert.deepEqual(r.json.channels, [])
})

test('unknown · 品类不在规则表 → 不进入第二次调用', async () => {
  scenario('not-in-table')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.verdict, 'unknown')
  // mock 的 stats 记不到这里，用 meta 里的 rejected 理由判断走了哪条分支
  assert.ok(['category_not_in_table', 'model_not_recognized'].includes(r.json.meta.rejected),
    `期望品类被拒，实际 rejected=${r.json.meta.rejected}`)
})

test('unknown · 置信度 low 一律当作没认出来', async () => {
  scenario('low-confidence')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.verdict, 'unknown')
  assert.equal(r.json.meta.rejected, 'low_confidence')
})

test('unknown · 模型返回中文名而不是 id，靠模糊匹配救回来', async () => {
  scenario('category-name')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.verdict, 'sell', '该匹配上却判成了 unknown')
  assert.equal(r.json.category.id, 'down-jacket')
})

/* ============================================================
 * 6. schema 失败 → 重试
 * ============================================================ */

test('重试 · 视觉段第一次不合格、第二次合格 → 成功且 attempts=2', async () => {
  scenario('schema-fail-once')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.verdict, 'sell')
  assert.equal(r.json.meta.visionAttempts, 2, '应记录了重试')
})

test('重试 · 视觉段一直不合格 → 502 VISION_FAILED', async () => {
  scenario('schema-fail-always')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 502, `期望 502，实际 ${r.status}：${r.raw}`)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'VISION_FAILED')
  assert.ok(r.json.message && /[\u4e00-\u9fa5]/.test(r.json.message), '错误提示必须是中文')
})

test('重试 · 视觉段返回非 JSON → 重试后仍失败 → 502', async () => {
  scenario('not-json')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 502, `期望 502，实际 ${r.status}：${r.raw}`)
  assert.equal(r.json.code, 'VISION_FAILED')
})

test('重试 · 文本段第一次写了价格、第二次合格 → 成功且 writerAttempts=2', async () => {
  scenario('writer-schema-fail-once')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.meta.writerAttempts, 2)
  // 最终回应里不能残留被拒的那次内容
  assert.ok(!/¥|\d+\s*元/.test(r.json.copywriting || ''), '文案里残留了价格数字')
})

test('重试 · 文本段一直写价格 → 502 TEXT_FAILED', async () => {
  scenario('writer-schema-fail-always')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 502, `期望 502，实际 ${r.status}：${r.raw}`)
  assert.equal(r.json.code, 'TEXT_FAILED')
})

/* ============================================================
 * 7. 超时
 * ============================================================ */

test('超时 · 视觉段不返回 → 504 TIMEOUT', async () => {
  scenario('timeout')
  const t0 = Date.now()
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  const elapsed = Date.now() - t0
  assert.equal(r.status, 504, `期望 504，实际 ${r.status}：${r.raw}`)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.code, 'TIMEOUT')
  assert.ok(elapsed < 3000, `超时未生效，耗时 ${elapsed}ms`)
})

test('超时 · 上游 500 → 502 且错误码正确', async () => {
  scenario('upstream-error')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 502, `期望 502，实际 ${r.status}：${r.raw}`)
  assert.equal(r.json.code, 'VISION_FAILED')
})

/* ============================================================
 * 8. 参数错误
 * ============================================================ */

test('参数 · 非 POST → 405', async () => {
  const r = await callAnalyze(makeReq({ method: 'GET' }))
  assert.equal(r.status, 405)
  assert.equal(r.json.code, 'METHOD_NOT_ALLOWED')
})

test('参数 · OPTIONS 预检 → 204 且带 CORS 头', async () => {
  const res = makeRes()
  await analyze(makeReq({ method: 'OPTIONS' }), res)
  assert.equal(res.statusCode, 204)
  assert.ok(res.headers['access-control-allow-origin'], '预检必须返回允许跨域头')
  assert.ok(/POST/.test(res.headers['access-control-allow-methods']), '预检必须声明 POST')
})

test('参数 · 没有文件字段 → 400 NO_IMAGE', async () => {
  const r = await callAnalyze(multipartReq(fakeJpeg(), { fieldName: 'wrongfield' }))
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.json.code, 'NO_IMAGE')
})

test('参数 · 图片超过 8MB → 400 IMAGE_TOO_LARGE', async () => {
  const huge = buffer(9 * 1024 * 1024)
  const r = await callAnalyze(multipartReq(huge))
  assert.equal(r.status, 400, r.raw)
  assert.ok(['IMAGE_TOO_LARGE', 'IMAGE_INVALID_FORMAT'].includes(r.json.code), `实际 ${r.json.code}`)
  assert.ok(/[\u4e00-\u9fa5]/.test(r.json.message), '错误提示必须是中文')
})

test('参数 · 非图片内容 → 400 IMAGE_INVALID_FORMAT', async () => {
  const notImage = Buffer.alloc(4096, 0x41) // 全是 'A'
  const r = await callAnalyze(multipartReq(notImage, { mime: 'application/octet-stream' }))
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.json.code, 'IMAGE_INVALID_FORMAT')
})

test('参数 · 太小的图片 → 400 IMAGE_TOO_SMALL', async () => {
  const tiny = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
  const r = await callAnalyze(multipartReq(tiny))
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.json.code, 'IMAGE_TOO_SMALL')
})

test('参数 · 非法 JSON → 400 PAYLOAD_INVALID', async () => {
  const r = await callAnalyze(makeReq({
    headers: { 'content-type': 'application/json' },
    body: '{这不是 json'
  }))
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.json.code, 'PAYLOAD_INVALID')
})

test('参数 · JSON 里没有 imageBase64 → 400 NO_IMAGE', async () => {
  const r = await callAnalyze(makeReq({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ foo: 1 })
  }))
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.json.code, 'NO_IMAGE')
})

test('参数 · 不支持的 Content-Type → 400', async () => {
  const r = await callAnalyze(makeReq({
    headers: { 'content-type': 'application/xml' },
    body: '<xml/>'
  }))
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.json.code, 'IMAGE_INVALID_FORMAT')
})

function buffer(n) {
  const buf = Buffer.alloc(n, 0x20)
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0
  return buf
}

/* ============================================================
 * 9. 密钥与内部信息不外泄
 * ============================================================ */

const FAKE_KEY = 'test-key-not-real'

test('安全 · 正常响应与错误响应里都不出现 API Key', async () => {
  const scenarios = ['normal', 'unknown', 'schema-fail-always', 'upstream-error', 'writer-error']
  for (const s of scenarios) {
    scenario(s)
    const r = await callAnalyze(multipartReq(fakeJpeg()))
    assert.ok(!r.raw.includes(FAKE_KEY), `场景 ${s} 的响应里泄漏了 API Key`)
  }
})

test('安全 · 响应里不出现上游地址与鉴权头', async () => {
  scenario('upstream-error')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  const raw = r.raw || ''
  assert.ok(!/Bearer/i.test(raw), '响应里出现了 Bearer')
  assert.ok(!/authorization/i.test(raw), '响应里出现了 authorization')
  assert.ok(!raw.includes('mock.local'), '响应里泄漏了上游地址')
})

test('安全 · 所有错误响应的 message 都是中文短句', async () => {
  const list = [
    ['schema-fail-always', 502],
    ['timeout', 504]
  ]
  for (const [s] of list) {
    scenario(s)
    const r = await callAnalyze(multipartReq(fakeJpeg()))
    assert.ok(/[\u4e00-\u9fa5]/.test(r.json.message), `场景 ${s} 的提示不是中文：${r.json.message}`)
    assert.ok(r.json.message.length <= 40, `场景 ${s} 的提示太长：${r.json.message}`)
    assert.ok(!/stack|Error:|at /.test(r.json.message), '提示里出现了技术细节')
  }
})

test('安全 · 源码里不存在硬编码的密钥形态字符串', async () => {
  // 扫描整个 server 目录（含 lib、api、配置文件、README）。
  // 排除 test/ 的原因：测试需要一个假的 key 注入 process.env 来验证"缺 key 会报错"，
  // 那是刻意的测试夹具，不是泄漏。除此之外的地方一律不许出现密钥形态的字符串。
  const skip = new Set(['node_modules', '.vercel', '.git', 'test'])
  const files = []
  const walk = (dir, base) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, base)
      else files.push(p.replace(base + sep, ''))
    }
  }
  walk(SERVER, SERVER)

  const textFiles = files.filter(f => /\.(js|mjs|cjs|json|md|example)$/.test(f) || f === '.env.example')
  assert.ok(textFiles.length >= 12, `扫描到的文件太少（${textFiles.length}），路径可能不对`)

  const patterns = [
    { re: /sk-[A-Za-z0-9]{16,}/, label: 'sk- 开头的密钥' },
    { re: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i, label: '赋值形式的密钥' },
    { re: /Bearer\s+[A-Za-z0-9\-._]{20,}/, label: '写死的 Bearer token' }
  ]

  for (const f of textFiles) {
    const text = await readFile(join(SERVER, f), 'utf8')
    for (const { re, label } of patterns) {
      assert.ok(!re.test(text), `${f} 里疑似硬编码了${label}`)
    }
  }
})

test('安全 · .env.example 里没有真实密钥', async () => {
  const text = await readFile(join(SERVER, '.env.example'), 'utf8')
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(text), '.env.example 里出现了疑似真实密钥')
  const keyLines = text.split('\n').filter(l => /^API_KEY\s*=/.test(l.trim()))
  for (const line of keyLines) {
    const value = line.split('=').slice(1).join('=').trim()
    assert.ok(value === '' || /your|xxxx|填写|替换|<|example/i.test(value),
      `API_KEY 示例值看起来像真 key：${value}`)
  }
})

/* ============================================================
 * 10. 配置缺失与健康检查
 * ============================================================ */

test('配置 · 真实模式下缺 API_KEY → 500 CONFIG_MISSING（不是 502）', async () => {
  const saved = { key: process.env.API_KEY, mock: process.env.MOCK_MODE }
  delete process.env.API_KEY
  realMode()
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  process.env.API_KEY = saved.key
  process.env.MOCK_MODE = saved.mock

  assert.equal(r.status, 500, `期望 500，实际 ${r.status}：${r.raw}`)
  assert.equal(r.json.code, 'CONFIG_MISSING')
  assert.ok(!r.raw.includes('<'), '不要把 undefined 之类的内部值写进响应')
})

test('健康检查 · /api/health 返回 200 且不含密钥', async () => {
  scenario('normal')
  const res = makeRes()
  await health(makeReq({ method: 'GET' }), res)
  const json = JSON.parse(res.body)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(json.ok, true)
  assert.ok(json.rules.loaded, true)
  assert.equal(json.rules.loaded, true)
  assert.ok(json.rules.categories >= 30, `品类数异常：${json.rules.categories}`)
  assert.ok(!res.body.includes(FAKE_KEY), '/health 泄漏了密钥')
  assert.ok(!res.body.includes('mock.local/v1'), '/health 泄漏了完整上游地址')
})

/* ============================================================
 * 11. 降级开关
 * ============================================================ */

test('降级 · DEGRADE_ON_WRITER_FAILURE=1 时文本模型挂了仍给可信结论', async () => {
  scenario('degrade')
  process.env.DEGRADE_ON_WRITER_FAILURE = '1'
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  delete process.env.DEGRADE_ON_WRITER_FAILURE

  assert.equal(r.status, 200, r.raw)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.verdict, 'sell')
  // 结论和价格仍然可信（来自规则表），只是没有文案
  assert.ok(Array.isArray(r.json.price) && r.json.price.length === 2, '降级后价格不能丢')
  assert.ok(r.json.reason.length > 0, '降级后理由不能为空')
  assert.equal(r.json.copywriting, null)
  assert.equal(r.json.meta.degraded, 'TEXT_FAILED')
})

test('降级 · 默认关闭时文本模型挂了返回 502（宁可报错也不给半成品）', async () => {
  scenario('writer-error')
  delete process.env.DEGRADE_ON_WRITER_FAILURE
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  assert.equal(r.status, 502, r.raw)
  assert.equal(r.json.code, 'TEXT_FAILED')
})

/* ============================================================
 * 12. 禁用词体检（服务端兜底）
 * ============================================================ */

test('文案 · 正常路径的输出里没有禁用词', async () => {
  scenario('normal')
  const { findBannedWords } = await import('../lib/prompt.js')
  const r = await callAnalyze(multipartReq(fakeJpeg()))
  const text = `${r.json.reason || ''}\n${r.json.copywriting || ''}`
  const hit = findBannedWords(text)
  assert.equal(hit.length, 0, `输出里命中禁用词：${hit.join('、')}`)
})

/* ============================================================
 * 执行
 * ============================================================ */

console.log('\n\x1b[1m该留该走 · 服务端自测\x1b[0m')
console.log(`Node ${process.version} · ${cases.length} 个用例\n`)

await runAll()

console.log('')
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过：${passed}/${cases.length}\x1b[0m\n`)
  process.exitCode = 0
} else {
  console.log(`\x1b[31m失败 ${failures.length} 个，通过 ${passed}/${cases.length}\x1b[0m`)
  console.log('')
  for (const f of failures) {
    console.log(`\x1b[31m● ${f.name}\x1b[0m`)
    console.log(String(f.error && f.error.stack ? f.error.stack : f.error).split('\n').slice(0, 6).join('\n'))
    console.log('')
  }
  process.exitCode = 1
}
