/* ============================================================
 * api/recategorize.js · POST /api/recategorize
 * ------------------------------------------------------------
 * 用户在结果页把品类名改掉之后，需要按新名字重新查价。
 *
 * 设计要点：
 *   1) 只用「规则表 + 字符串匹配」，不调模型。
 *      理由：用户改名字是想要一个确定的结果，再来一次模型调用
 *      既慢又可能给出不同答案，反而更让人困惑。
 *   2) 匹配不上就明确返回 matched:false，前端保留原价并提示，
 *      绝不猜一个相近品类把价格套上去。
 *   3) 只接受品类名，不接受图片 —— 这个接口不碰用户照片。
 *
 * 请求：{ "name": "电水壶", "condition": "八成新", "hasWarranty": false }
 * 响应：
 *   命中 { ok:true, matched:true, category:{...}, price, channels, verdict, reason, ... }
 *   未中 { ok:true, matched:false, message:"表里没有这个品类", suggestions:[...] }
 * ============================================================ */

import { AppError, toAppError } from '../lib/errors.js'
import { sendError, sendJson, handlePreflight } from '../lib/http.js'
import { loadRules, judge, resolveCategory, conditionEnum } from '../lib/rules.js'
import { describeChannels } from '../lib/channels.js'

/** 读 JSON body（这个接口只有一个很小的对象，不处理 multipart） */
async function readJson(req, limit = 8 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      const s = req.body.toString('utf8')
      if (!s.trim()) return {}
      try { return JSON.parse(s) } catch { throw new AppError('PAYLOAD_INVALID', { detail: 'body 不是合法 JSON' }) }
    }
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {}
      try { return JSON.parse(req.body) } catch { throw new AppError('PAYLOAD_INVALID', { detail: 'body 不是合法 JSON' }) }
    }
    if (typeof req.body === 'object') return req.body
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new AppError('PAYLOAD_INVALID', { detail: '请求体过大' })
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { throw new AppError('PAYLOAD_INVALID', { detail: 'body 不是合法 JSON' }) }
}

/**
 * 用同义词表把用户输入翻译成规则表的品类名
 * ------------------------------------------------------------
 * resolveCategory 只认规则表里的 id / 名称 / 别名。
 * 但用户会说「保温杯」「毛衣」「iPad」——这些词表里没有。
 * 这一步先把它们映射过去，再交给 resolveCategory 精确匹配。
 *
 * @returns {string|null} 命中的规则表品类名
 */
function translateBySynonym(query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null
  for (const [keys, target] of SYNONYM_HINTS) {
    // 完全相等优先，其次互相包含
    if (keys.some(k => k === q)) return target
  }
  for (const [keys, target] of SYNONYM_HINTS) {
    if (keys.some(k => q.includes(k) || k.includes(q))) return target
  }
  return null
}

/** 常见叫法 → 规则表品类名（覆盖用户最可能改错的说法） */
const SYNONYM_HINTS = [
  [['ipad', 'ipad', '平板电脑', 'pad', '平板'], '平板'],
  [['iphone', '苹果手机', '手机'], '手机'],
  [['macbook', '笔记本电脑', '电脑', 'notebook'], '笔记本'],
  [['airpods', '蓝牙耳机', '无线耳机', '耳机'], '耳机'],
  [['switch', '游戏机', 'ps5', '掌机'], '笔记本'],
  [['kindle', '电子书', '阅读器'], '平板'],
  [['保温杯', '水杯', '杯子', '马克杯', '茶壶'], '电水壶'],
  [['电饭锅', '电饭煲', '饭锅'], '电饭煲'],
  [['微波炉', '烤箱'], '微波炉'],
  [['吹风机', '电吹风', '风机'], '吹风机'],
  [['台灯', '灯', '落地灯'], '台灯'],
  [['电磁炉', '电陶炉'], '微波炉'],
  [['毛衣', '针织衫', '卫衣', 't恤', '短袖', '上衣'], '卫衣 / T恤'],
  [['外套', '风衣', '夹克', '棉服'], '大衣 / 风衣'],
  [['羽绒', '鸭绒', '鹅绒', '棉袄'], '羽绒服'],
  [['裤子', '牛裤', '牛仔'], '牛仔裤'],
  [['鞋子', '球鞋', '板鞋', '靴子', '拖鞋', '皮鞋'], '运动鞋'],
  [['包', '背包', '双肩包', '书包', '登山包', '电脑包'], '背包 / 双肩包'],
  [['手提包', '钱包', '单肩包', '斜挎包'], '女包（非名牌）'],
  [['书', '小说', '杂志', '绘本', '童书'], '小说 / 文学书'],
  [['教材', '课本', '教辅'], '教材 / 教辅'],
  [['玩具', '积木', '娃娃'], '塑料玩具'],
  [['婴儿车', '推车', '童车'], '婴儿车'],
  [['童装', '宝宝衣服', '小孩衣服'], '童装'],
  [['被子', '床单', '枕头', '床品'], '被褥 / 床品'],
  [['哑铃', '杠铃', '健身'], '哑铃 / 健身器材'],
  [['瑜伽', '垫子'], '瑜伽垫'],
  [['自行车', '单车', '山地车'], '自行车'],
  [['充电宝', '移动电源'], '充电宝'],
  [['数据线', '充电线', '线材'], '数据线 / 充电器'],
  [['充电器', '电源适配器', '适配器'], '充电器（笔记本电源）'],
  [['键盘', '鼠标', '键鼠'], '键鼠'],
  [['wifi', '路由', '路由器'], '路由器'],
  [['药', '药品', '药片'], '药品'],
  [['证件', '身份证', '票据'], '证件 / 票据'],
  [['化妆品', '护肤品', '口红'], '化妆品（未开封）']
]

function suggest(categories, query) {
  const q = String(query || '').trim().toLowerCase()
  const names = categories.map(c => c.name)
  const out = []
  const push = n => { if (n && names.includes(n) && !out.includes(n)) out.push(n) }

  if (!q) {
    return names.slice(0, 6)
  }

  /* 第 1 层：同义词命中 */
  for (const [keys, target] of SYNONYM_HINTS) {
    if (keys.some(k => q.includes(k) || k.includes(q))) push(target)
  }

  /* 第 2 层：名字互相包含 */
  for (const n of names) {
    const ln = n.toLowerCase()
    if (ln.includes(q) || q.includes(ln)) push(n)
  }

  /* 第 3 层：共享汉字（至少 2 个字重合才给，避免噪声） */
  if (out.length < 6) {
    const scored = names.map(n => {
      let overlap = 0
      for (const ch of new Set(q)) {
        if (/[\u4e00-\u9fa5]/.test(ch) && n.includes(ch)) overlap++
      }
      return { n, overlap }
    }).filter(x => x.overlap >= 2)
    scored.sort((a, b) => b.overlap - a.overlap)
    for (const s of scored) { if (out.length < 6) push(s.n) }
  }

  /* 兜底：给最通用的几项，也好过给完全无关的 */
  if (!out.length) {
    return ['手机', '笔记本', '羽绒服', '运动鞋', '电水壶', '小说 / 文学书']
  }

  return out.slice(0, 6)
}

export default async function handler(req, res) {
  let allowOrigin = process.env.ALLOW_ORIGIN || '*'

  if (handlePreflight(req, res, allowOrigin)) return

  if (req.method !== 'POST') {
    return sendError(res, new AppError('METHOD_NOT_ALLOWED', { detail: `method=${req.method}` }), allowOrigin)
  }

  try {
    /* 注意：这里刻意不调 buildDeps()。
     * 改名重查只用规则表 + 字符串匹配，不需要模型，
     * 也就不该依赖 API_KEY —— 没配 key 时仍应能正常查价。 */
    allowOrigin = process.env.ALLOW_ORIGIN || '*'

    const rules = await loadRules()
    const body = await readJson(req)

    const name = String(body.name || '').trim().slice(0, 32)
    if (!name) {
      return sendJson(res, 400, {
        ok: false,
        code: 'NO_NAME',
        message: '请填写品类名称'
      }, allowOrigin)
    }

    /* 成色必须在枚举里，否则用默认值（和 vision.js 的处理保持一致） */
    const enums = conditionEnum()
    const condition = enums.includes(body.condition) ? body.condition : '八成新'
    const hasWarranty = Boolean(body.hasWarranty)

    /* 品牌档位：只接受三档；非法值一律当未指定（按保守价算） */
    const TIERS = ['generic', 'brand', 'premium']
    const brandTier = TIERS.includes(body.brandTier) ? body.brandTier : null

    const { cat, via } = resolveCategory(rules.CATEGORIES, name)

    /* 直接匹配不上时，先过一遍同义词表再匹配一次。
     * 例：保温杯 → 电水壶，毛衣 → 卫衣 / T恤 */
    let resolvedCat = cat
    let resolvedVia = via
    if (!resolvedCat) {
      const translated = translateBySynonym(name)
      if (translated) {
        const t = resolveCategory(rules.CATEGORIES, translated)
        if (t.cat) {
          resolvedCat = t.cat
          resolvedVia = 'synonym'
        }
      }
    }

    if (!resolvedCat) {
      return sendJson(res, 200, {
        ok: true,
        matched: false,
        query: name,
        message: `表里没有「${name}」这个品类，价格先按原识别结果保留`,
        suggestions: suggest(rules.CATEGORIES, name),
        condition
      }, allowOrigin)
    }

    const decision = judge(resolvedCat.id, { condition, hasWarranty, brandTier })

    if (decision.verdict === 'unknown') {
      return sendJson(res, 200, {
        ok: true,
        matched: false,
        query: name,
        message: '这个品类暂时给不了建议',
        suggestions: suggest(rules.CATEGORIES, name),
        condition
      }, allowOrigin)
    }

    return sendJson(res, 200, {
      ok: true,
      matched: true,
      query: name,
      via: resolvedVia,
      category: { id: resolvedCat.id, name: resolvedCat.name, group: resolvedCat.group },
      condition,
      verdict: decision.verdict,
      price: decision.price,
      wide: decision.wide,
      damaged: decision.damaged,
      tip: decision.tip,
      brand: {
        applied: Boolean(decision.brandApplied),
        tier: decision.brandTier || null,
        unknown: Boolean(decision.brandUnknown),
        factor: decision.brandFactor || 1
      },
      reason: decision.ruleReason,
      channels: describeChannels(decision.channels, resolvedCat, 2)
    }, allowOrigin)

  } catch (rawErr) {
    const err = toAppError(rawErr)
    console.error('[recategorize] 失败', {
      code: err.code,
      stage: err.stage,
      detail: err.detail
    })
    return sendError(res, err, allowOrigin)
  }
}
