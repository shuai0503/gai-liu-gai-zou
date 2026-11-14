/**
 * scripts/debug-vision.mjs
 * 诊断：把服务端真实的 prompt + schema 发给模型，打印原始返回。
 * 目的：搞清楚为什么真实照片总是返回 recognized:false。
 */
import { readFileSync } from 'node:fs'
import { buildVisionPrompt } from '../lib/prompt.js'
import { loadRules, conditionEnum, categoryPromptList, resolveCategory } from '../lib/rules.js'
import { OBSERVATION_SCHEMA, extractJson, validateObservation } from '../lib/schema.js'

const KEY = process.env.API_KEY
if (!KEY) { console.error('缺少 API_KEY'); process.exit(1) }

const BASE = process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL = process.env.VISION_MODEL || 'qwen3-omni-flash'
const paths = process.argv.slice(2)

if (!paths.length) { console.error('用法：node scripts/debug-vision.mjs <图片> [...]'); process.exit(1) }

const rules = await loadRules()
console.log(`规则表来源：${rules.source}，${rules.CATEGORIES.length} 个品类\n`)

const { system, user } = buildVisionPrompt({
  categories: rules.CATEGORIES,
  conditionList: conditionEnum(),
  categoryListText: categoryPromptList(rules.CATEGORIES)
})

for (const p of paths) {
  const buf = readFileSync(p)
  const ext = p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
  const dataUrl = `data:${ext};base64,` + buf.toString('base64')

  console.log('─'.repeat(60))
  console.log(`图片：${p.split(/[\\/]/).pop()}  ${Math.round(buf.length / 1024)}KB`)

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
        ]
      }
    ],
    temperature: 0.2,
    stream: false,
    response_format: { type: 'json_object' }
  }

  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  const ms = Date.now() - t0

  console.log(`HTTP ${res.status} · ${ms}ms`)

  if (!res.ok) {
    console.log('原始返回：', text.slice(0, 800))
    continue
  }

  let payload
  try { payload = JSON.parse(text) } catch { payload = null }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content

  console.log('模型原始 content：')
  console.log(String(content || '(空)').slice(0, 900))

  const parsed = extractJson(content)
  console.log('\n解析成 JSON：')
  console.log(parsed ? JSON.stringify(parsed, null, 2) : '(解析失败)')

  if (parsed) {
    const v = validateObservation(parsed)
    console.log(`\nschema 校验：${v.valid ? '通过' : '不通过'}`)
    if (!v.valid) console.log('  ' + v.summary)

    if (parsed.recognized) {
      const { cat, via } = resolveCategory(rules.CATEGORIES, parsed.categoryId || parsed.categoryName)
      console.log(`品类映射：${parsed.categoryId || parsed.categoryName} → ${cat ? cat.id + ' (' + via + ')' : '未匹配'}`)
    } else {
      console.log('模型自己说 recognized=false')
    }
  }
  console.log('')
}
