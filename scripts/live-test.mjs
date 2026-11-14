/* ============================================================
 * scripts/live-test.mjs · 真实模型联调脚本
 * ------------------------------------------------------------
 * 用途：用真实的模型服务跑一遍完整链路，验证三件事：
 *   1. 视觉模型能认出图里的东西
 *   2. 它返回的品类能映射到规则表的 34 个 id 上
 *   3. 两段模式（视觉观察 → 规则判定 → 文案生成）能串起来
 *
 * 用法（Key 只从环境变量读，绝不写进文件）：
 *   PowerShell:
 *     $env:API_KEY="sk-..."; node scripts/live-test.mjs
 *   CMD:
 *     set API_KEY=sk-... && node scripts/live-test.mjs
 *
 * 可选环境变量：
 *   API_BASE_URL   默认 https://dashscope.aliyuncs.com/compatible-mode/v1
 *   VISION_MODEL   默认 qwen3-omni-flash
 *   TEXT_MODEL     默认 qwen3-omni-flash
 *   IMAGE_PATH     指定本地图片；不给则用内置生成的测试图
 *   CASES          只跑指定用例，逗号分隔，如 CASE=jacket,router
 * ============================================================ */

import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

/* ---------- 读配置 ---------- */
const API_KEY = process.env.API_KEY
const API_BASE_URL = process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const VISION_MODEL = process.env.VISION_MODEL || 'qwen3-omni-flash'
const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen3-omni-flash'
const IMAGE_PATH = process.env.IMAGE_PATH || ''
const ONLY = (process.env.CASES || '').split(',').map(s => s.trim()).filter(Boolean)

if (!API_KEY) {
  console.error('缺少 API_KEY 环境变量。\n')
  console.error('PowerShell 用法：')
  console.error('  $env:API_KEY="sk-..."; node scripts/live-test.mjs\n')
  process.exit(1)
}

/* ---------- 载入规则表（复用生产逻辑，不另写一份） ---------- */
const rulesSrc = readFileSync(resolve(ROOT, '..', '该留该走-品类规则表.js'), 'utf8')
  .replace(/export const/g, 'const')
  .replace(/export function/g, 'function')
const rules = new Function(rulesSrc + '\nreturn {CATEGORIES,CONDITION_FACTOR,decide,resolveCategoryForTest:null};')()
const { CATEGORIES, CONDITION_FACTOR, decide } = rules

/* ---------- 载入服务端现有的规则接入层（品类匹配逻辑要测的是线上那份） ---------- */
// Windows 下 ESM 动态 import 必须用 file:// URL，不能直接给盘符路径
const rulesModUrl = new URL('../lib/rules.js', import.meta.url).href
const rulesMod = await import(rulesModUrl)

/* ============================================================
 * 造测试图
 * ------------------------------------------------------------
 * 不用真实照片，用 canvas 风格的极简绘制图片：
 *   - 好处：零依赖、可重现、不涉及他人肖像与版权
 *   - 代价：模型可能认不准（这本身也是有价值的观察）
 * 想用真实照片就设 IMAGE_PATH。
 * ============================================================ */

/** 极简 PNG 编码器：把 RGB 像素写成无损 PNG */
function encodePng(width, height, pixelFn) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter type 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y)
      raw[p++] = r; raw[p++] = g; raw[p++] = b
    }
  }

  const idat = deflateSync(raw, { level: 9 })

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (c ^ -1) >>> 0
}

/* ---------- 三张测试图的绘制函数 ---------- */
const SCENES = {
  jacket: {
    label: '深蓝色横纹外套（期望：羽绒服 / 服饰类）',
    expectHint: ['羽绒服', '大衣', '卫衣', '运动鞋'], // 任一命中都算合理
    size: 320,
    paint: (x, y) => {
      const bg = [245, 242, 236]
      // 躯干梯形
      const inBody = y >= 70 && y <= 260 && x >= (90 + (110 - 90) * (260 - y) / 190) && x <= (230 - (230 - 210) * (260 - y) / 190)
      if (inBody) {
        // 横条纹
        const stripe = Math.floor((y - 70) / 26) % 2 === 0
        return stripe ? [44, 74, 110] : [54, 88, 128]
      }
      // 左袖
      if (y >= 75 && y <= 155 && x >= 80 && x <= 118) return [44, 74, 110]
      // 右袖
      if (y >= 75 && y <= 155 && x >= 202 && x <= 240) return [44, 74, 110]
      return bg
    }
  },

  router: {
    label: '白色方盒带两根天线（期望：路由器 / 数码类）',
    expectHint: ['路由器', '充电器', '电源', '音箱'],
    size: 320,
    paint: (x, y) => {
      const bg = [238, 241, 245]
      // 机身
      if (y >= 170 && y <= 235 && x >= 70 && x <= 250) return [232, 233, 236]
      // 底部阴影
      if (y > 235 && y <= 243 && x >= 74 && x <= 246) return [200, 203, 208]
      // 天线 1
      if (x >= 96 && x <= 106 && y >= 70 && y <= 170) return [60, 62, 68]
      // 天线 2
      if (x >= 214 && x <= 224 && y >= 70 && y <= 170) return [60, 62, 68]
      // 指示灯
      if (y >= 196 && y <= 202 && x >= 120 && x <= 200 && (x % 24) < 8) return [90, 200, 120]
      return bg
    }
  },

  books: {
    label: '一摞彩色书（期望：图书类）',
    expectHint: ['书', '绘本', '教材', '杂志'],
    size: 320,
    paint: (x, y) => {
      const bg = [250, 248, 244]
      const bands = [
        { y0: 210, y1: 245, x0: 60, x1: 265, c: [196, 92, 84] },
        { y0: 172, y1: 210, x0: 72, x1: 250, c: [80, 130, 180] },
        { y0: 136, y1: 172, x0: 84, x1: 240, c: [220, 180, 90] },
        { y0: 104, y1: 136, x0: 96, x1: 228, c: [110, 160, 120] }
      ]
      for (const b of bands) {
        if (y >= b.y0 && y < b.y1 && x >= b.x0 && x <= b.x1) {
          // 书脊细线
          if (x - b.x0 < 6 || b.x1 - x < 6) return [b.c[0] * 0.75, b.c[1] * 0.75, b.c[2] * 0.75]
          return b.c
        }
      }
      return bg
    }
  }
}

/* ---------- 把图片变成 data URL ---------- */
function makeDataUrl(caseKey) {
  if (IMAGE_PATH) {
    const ext = IMAGE_PATH.split('.').pop().toLowerCase()
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
    const b64 = readFileSync(IMAGE_PATH).toString('base64')
    return { dataUrl: `data:${mime};base64,${b64}`, bytes: readFileSync(IMAGE_PATH).length, from: 'file' }
  }
  const s = SCENES[caseKey]
  const png = encodePng(s.size, s.size, s.paint)
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, bytes: png.length, from: 'generated' }
}

/* ============================================================
 * 模型调用
 * ============================================================ */

async function callModel({ model, messages, maxTokens = 400, timeoutMs = 40000, jsonMode = false }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens
  }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const started = Date.now()
  try {
    const res = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    const json = JSON.parse(text)
    const content = json.choices?.[0]?.message?.content
    return {
      content: String(content || ''),
      ms: Date.now() - started,
      usage: json.usage || null
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型输出里抠 JSON（复用生产环境的容错思路） */
function extractJson(text) {
  if (!text) return null
  let s = String(text).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()
  try { return JSON.parse(s) } catch { /* continue */ }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}')
  if (a !== -1 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
  }
  return null
}

/* ============================================================
 * 两段式链路
 * ============================================================ */

const CONDITION_LIST = Object.keys(CONDITION_FACTOR)

function buildVisionPrompt() {
  const catList = CATEGORIES.map(c => {
    const alias = (c.aliases || []).length ? `（别名：${c.aliases.join('、')}）` : ''
    return `${c.id} = ${c.name}${alias}`
  }).join('\n')

  const system = [
    '你是一个二手闲置物品识别助手。你只负责"看清楚这是什么"，不做任何价值判断。',
    '',
    '严格按以下 JSON 输出，不要任何额外文字：',
    '{',
    '  "recognized": true 或 false,',
    '  "categoryId": "品类库里最匹配的 id，认不出给空字符串",',
    '  "categoryName": "中文品名",',
    '  "condition": "成色，只能从下列枚举里选一个",',
    '  "material": "材质，看不出给空字符串",',
    '  "damage": "明显瑕疵描述，没有给空字符串",',
    '  "confidence": "high / medium / low"',
    '}',
    '',
    '规则：',
    '1. 认不出或没有把握，recognized 必须是 false，categoryId 给空串，禁止猜测',
    '2. 不要输出价格、平台名、处置建议 —— 这些不由你负责',
    `3. condition 只能取：${CONDITION_LIST.join(' / ')}`,
    '4. confidence 只有三档；只要你不确定就选 low',
    '',
    '品类库（categoryId = 中文名）：',
    catList
  ].join('\n')

  return system
}

async function runCase(caseKey) {
  const scene = SCENES[caseKey]
  const img = makeDataUrl(caseKey)

  const report = {
    case: caseKey,
    label: scene.label,
    imageBytes: img.bytes,
    imageFrom: img.from,
    vision: null,
    match: null,
    judge: null,
    writer: null,
    problems: [],
    timings: {}
  }

  /* ---------- 第 1 段：视觉 ---------- */
  const system = buildVisionPrompt()
  const t0 = Date.now()
  let v
  try {
    v = await callModel({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: '识别这张图片里的物品，按要求的 JSON 输出。' },
          { type: 'image_url', image_url: { url: img.dataUrl, detail: 'low' } }
        ] }
      ],
      maxTokens: 300,
      jsonMode: true
    })
  } catch (e) {
    report.problems.push(`视觉调用失败：${e.message}`)
    return report
  }
  report.timings.visionMs = Date.now() - t0

  const obs = extractJson(v.content)
  report.vision = { raw: v.content.slice(0, 500), parsed: obs, usage: v.usage }

  if (!obs) {
    report.problems.push('视觉模型没有返回可解析的 JSON')
    return report
  }

  if (!obs.recognized) {
    report.problems.push('模型自述认不出来（这是合法结果，不是错误）')
    return report
  }

  /* ---------- 品类映射（用生产代码里的匹配器） ---------- */
  const { cat, via } = rulesMod.resolveCategory(CATEGORIES, obs.categoryId || obs.categoryName)
  report.match = {
    input: obs.categoryId || obs.categoryName,
    matchedId: cat ? cat.id : null,
    matchedName: cat ? cat.name : null,
    via
  }

  if (!cat) {
    report.problems.push(`品类「${obs.categoryId || obs.categoryName}」不在 34 个品类表里 → 会走 unknown`)
    return report
  }

  /* 期望命中检查 */
  if (!scene.expectHint.some(h => (cat.name || '').includes(h) || h.includes(cat.name || ''))) {
    report.problems.push(`品类命中「${cat.name}」，但期望在 [${scene.expectHint.join('/')}] 附近 —— 可能认偏了`)
  }

  /* ---------- 第 2 段：规则判定（纯查表，不调模型） ---------- */
  const condition = CONDITION_LIST.includes(obs.condition) ? obs.condition : '八成新'
  if (condition !== obs.condition) {
    report.problems.push(`模型给的成色「${obs.condition}」不在枚举里，已回退到「八成新」`)
  }
  const verdict = decide(cat.id, { condition })
  report.judge = {
    verdict: verdict.verdict,
    price: verdict.price,
    wide: verdict.wide,
    channels: verdict.channels,
    reason: verdict.reason
  }

  /* ---------- 第 3 段：文案生成 ---------- */
  const t1 = Date.now()
  try {
    const w = await callModel({
      model: TEXT_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            '你为一个二手闲置处置工具写文案。严格按 JSON 输出，不要额外文字：',
            '{ "reason": "一句话处置理由，12-30字", "copywriting": "发布文案或空串" }',
            '',
            '硬性规则：',
            '1. reason 和 copywriting 里绝对不能出现任何价格数字（不要写金额、不要写"多少钱"）',
            '2. reason 里不能出现平台名（闲鱼、转转、多抓鱼等）',
            '3. copywriting 只在需要出售时写，否则给空字符串',
            '4. 说人话，短句，不要"赋能""一站式"这类词'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            物品: cat.name,
            材质: obs.material || '',
            成色: condition,
            瑕疵: obs.damage || '',
            处置结论: verdict.verdict
          })
        }
      ],
      maxTokens: 400,
      jsonMode: true
    })
    report.timings.writerMs = Date.now() - t1
    const parsed = extractJson(w.content)
    report.writer = { parsed, raw: w.content.slice(0, 400) }
    if (!parsed) {
      report.problems.push('文案模型没有返回可解析的 JSON')
    } else {
      const priceRe = /(?:[¥￥]\s*\d|\d+\s*(?:元|块|RMB))/
      if (priceRe.test(parsed.reason || '')) report.problems.push('reason 里出现了价格数字（schema 会判不合格并重试）')
      if (/闲鱼|转转|得物|多抓鱼|白鲸鱼/.test(parsed.reason || '')) report.problems.push('reason 里出现了平台名（schema 会判不合格并重试）')
      if (priceRe.test(parsed.copywriting || '')) report.problems.push('copywriting 里出现了价格数字')
    }
  } catch (e) {
    report.problems.push(`文案调用失败：${e.message}`)
  }

  return report
}

/* ============================================================
 * 主流程
 * ============================================================ */

console.log('')
console.log('═'.repeat(66))
console.log('  该留该走 · 真实模型联调')
console.log('═'.repeat(66))
console.log(`  base   : ${API_BASE_URL}`)
console.log(`  vision : ${VISION_MODEL}`)
console.log(`  text   : ${TEXT_MODEL}`)
console.log(`  图片   : ${IMAGE_PATH ? IMAGE_PATH : '内置生成的 3 张测试图'}`)
console.log(`  品类库 : ${CATEGORIES.length} 个`)
console.log('═'.repeat(66))

const keys = ONLY.length ? ONLY : Object.keys(SCENES)
const results = []

for (const key of keys) {
  if (!SCENES[key]) {
    console.log(`\n⚠ 跳过未知用例：${key}`)
    continue
  }
  console.log(`\n▶ ${key} — ${SCENES[key].label}`)
  const r = await runCase(key)
  results.push(r)

  if (r.vision?.parsed) {
    const v = r.vision.parsed
    console.log(`  视觉：${v.categoryName || '(空)'} / 成色 ${v.condition || '(空)'} / 材质 ${v.material || '(空)'} / 置信 ${v.confidence}`)
    console.log(`  耗时：${r.timings.visionMs}ms`)
  }
  if (r.match) {
    console.log(`  映射：${r.match.input} → ${r.match.matchedId || '未匹配'} (${r.match.via || '-'})`)
  }
  if (r.judge) {
    const p = r.judge.price ? `¥${r.judge.price[0]}–${r.judge.price[1]}` : '无价格'
    console.log(`  判定：${r.judge.verdict} / ${p} / ${(r.judge.channels || []).slice(0, 2).join('·') || '-'}`)
  }
  if (r.writer?.parsed) {
    console.log(`  文案：${(r.writer.parsed.reason || '').slice(0, 40)}`)
  }
  if (r.problems.length) {
    for (const p of r.problems) console.log(`  ⚠ ${p}`)
  } else {
    console.log('  ✓ 本用例无异常')
  }
}

/* ---------- 汇总 ---------- */
console.log('\n' + '═'.repeat(66))
console.log('  汇总')
console.log('═'.repeat(66))

const okCount = results.filter(r => r.problems.length === 0).length
const matched = results.filter(r => r.match?.matchedId).length
const sellable = results.filter(r => r.judge?.price).length

console.log(`  用例         : ${results.length}`)
console.log(`  完全无异常   : ${okCount}/${results.length}`)
console.log(`  品类映射成功 : ${matched}/${results.length}`)
console.log(`  给出价格     : ${sellable}/${results.length}`)

const vTimes = results.map(r => r.timings.visionMs).filter(Boolean)
if (vTimes.length) {
  console.log(`  视觉耗时     : ${Math.min(...vTimes)}–${Math.max(...vTimes)}ms（平均 ${Math.round(vTimes.reduce((a, b) => a + b, 0) / vTimes.length)}ms）`)
  if (Math.max(...vTimes) > 12000) {
    console.log('  ⚠ 有视觉调用超过 12s，生产环境会触发 TIMEOUT，需调低超时或换更快的模型')
  }
}

console.log('\n  提示：这里测的是「模型 + 规则表」的串联效果，不是单元测试。')
console.log('  品类认偏不等于代码有 bug，多半是提示词或测试图太简陋。')
console.log('')
