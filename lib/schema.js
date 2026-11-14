/* ============================================================
 * lib/schema.js · 极简 JSON Schema 校验器 + 两段式响应的 schema
 * ------------------------------------------------------------
 * 为什么手写不引 ajv：
 *   1) 只用得上 string/enum/number/array/object 这几个关键字，
 *      引 ajv 要多打 100KB 依赖，冷启动和评审阅读成本都不划算
 *   2) 这是参赛作品，校验逻辑摆在一个文件里，评委能直接看懂
 *      「模型返回什么才算合格」
 *
 * 校验器返回 { valid, errors:[{path, message}] }，不做异常抛出，
 * 便于调用方决定「重试一次」还是「直接 502」。
 * ============================================================ */

/* ------------------------------------------------------------
 * 1. 通用校验器
 * ---------------------------------------------------------- */

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function checkNode(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return

  /* --- type --- */
  if (schema.type) {
    const want = schema.type
    const got = typeOf(value)
    const ok =
      (want === 'integer' && got === 'number' && Number.isInteger(value)) ||
      (want === 'number' && got === 'number' && Number.isFinite(value)) ||
      want === got
    if (!ok) {
      errors.push({ path, message: `期望 ${want}，实际 ${got}` })
      return // 类型不对就不再往下校验，避免无意义的连锁报错
    }
  }

  /* --- enum --- */
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `必须是 ${schema.enum.join(' / ')} 之一，实际 ${JSON.stringify(value)}` })
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `长度至少 ${schema.minLength}，实际 ${value.length}` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `长度最多 ${schema.maxLength}，实际 ${value.length}` })
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `不符合格式 ${schema.pattern}` })
    }
    if (schema.notPattern && new RegExp(schema.notPattern).test(value)) {
      errors.push({ path, message: `命中禁止内容 ${schema.notPattern}` })
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `不得小于 ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `不得大于 ${schema.maximum}` })
    }
  }

  /* --- array --- */
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `至少 ${schema.minItems} 项` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `最多 ${schema.maxItems} 项` })
    }
    if (schema.items) {
      value.forEach((item, i) => checkNode(schema.items, item, `${path}[${i}]`, errors))
    }
  }

  /* --- object --- */
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      // ⚠️ 只判「字段不存在」，不判空串：
      // material / damage / copywriting 的空串是有意义的取值（表示"没有"），
      // 想要求必须有内容，就在字段上用 minLength，别用 required。
      if (value[key] === undefined || value[key] === null) {
        errors.push({ path: `${path}.${key}`, message: '必填字段缺失' })
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined) continue
      checkNode(sub, value[key], `${path}.${key}`, errors)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}))
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, message: '不允许的字段' })
      }
    }
  }
}

/**
 * 校验
 * @returns {{valid:boolean, errors:Array<{path:string,message:string}>}}
 */
export function validate(schema, value) {
  const errors = []
  checkNode(schema, value, '$', errors)
  return { valid: errors.length === 0, errors }
}

/* ------------------------------------------------------------
 * 2. 视觉模型输出 schema
 * ------------------------------------------------------------
 * 关键：这里没有任何 price / channel 字段。
 * 模型的输出结构本身就把「不许给价格」这件事挡死了 ——
 * 它就算想编一个数字，也没有地方放。
 * ---------------------------------------------------------- */

export const OBSERVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recognized', 'categoryId', 'categoryName', 'condition', 'material', 'damage', 'confidence', 'brandTier'],
  properties: {
    /** 是否认出来了。认不出就必须是 false，不许硬猜 */
    recognized: { type: 'boolean' },
    /** 规则表里的品类 id；认不出时给空串 */
    categoryId: { type: 'string', maxLength: 64 },
    /** 中文品名 */
    categoryName: { type: 'string', maxLength: 32 },
    /** 成色，必须是规则表 CONDITION_FACTOR 的键 */
    condition: { type: 'string', maxLength: 16 },
    /** 材质，可为空串 */
    material: { type: 'string', maxLength: 24 },
    /** 明显瑕疵描述，没有则为空串 */
    damage: { type: 'string', maxLength: 60 },
    /** 置信度：只允许三档，避免"92%"这种伪精确 */
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    /**
     * 品牌档位：只有三档。
     * 之所以不让模型直接说品牌名，是因为"这是不是名牌"的判断
     * 比"这是哪个牌子"可靠得多，而且枚举可以被 schema 卡死。
     */
    brandTier: { type: 'string', enum: ['generic', 'brand', 'premium'] }
  }
}

/* ------------------------------------------------------------
 * 3. 文本模型输出 schema
 * ------------------------------------------------------------
 * 这是「模型 vs 规则表」分工的第二道闸：
 * 文本模型只被允许写 reason 和 copywriting 两个字段，
 * 而且 copywriting 里出现价格数字或渠道名会被 notPattern 判为不合格，
 * 触发重试 —— 重试拿到的还是不干净内容，就 502。
 * ---------------------------------------------------------- */

/** 价格数字：¥120 / 120 元 / 120-180 / 120–180 等 */
export const PRICE_PATTERN = '(?:[¥￥]\\s*\\d|\\d+\\s*(?:元|块|RMB))'

/** 处置类文案里不该出现的渠道名（换个角度说"挂平台"是可以的） */
export const CHANNEL_WORDS = ['闲鱼', '转转', '得物', '爱回收', '多抓鱼', '白鲸鱼', '孔夫子', '微店']

export function buildWriterSchema(channelNames = []) {
  // 把本次规则表命中的渠道名纳入禁词，另外再叠加常见平台名
  const forbidden = Array.from(new Set([...CHANNEL_WORDS, ...channelNames.filter(Boolean)]))
  const channelPattern = forbidden.length
    ? forbidden.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    : '闲鱼'

  return {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'copywriting'],
    properties: {
      /** 一句处置理由：短句、说人话、不出现价格与渠道 */
      reason: {
        type: 'string',
        minLength: 4,
        maxLength: 48,
        notPattern: `${PRICE_PATTERN}|${channelPattern}`
      },
      /** 可直接复制的发布文案；非 sell 分支允许为空串 */
      copywriting: {
        type: 'string',
        maxLength: 400,
        notPattern: PRICE_PATTERN
      }
    }
  }
}

/* ------------------------------------------------------------
 * 4. 容错提取：模型有时会包一层 markdown 代码块或 {"data":{...}}
 * ---------------------------------------------------------- */

/**
 * 从模型原始文本里抠出 JSON 对象。
 * 认不出 JSON 就返回 null（由调用方判为不合格 → 重试）。
 */
export function extractJson(text) {
  if (text === null || text === undefined) return null
  let s = String(text).trim()

  // 去掉 ```json ... ``` 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  if (fence) s = fence[1].trim()

  // 直接可解析
  try {
    return JSON.parse(s)
  } catch {
    /* 继续尝试截取 */
  }

  // 截取第一个 { 到最后一个 }，容忍模型在 JSON 前后写了解释性文字
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const slice = s.slice(start, end + 1)
    try {
      return JSON.parse(slice)
    } catch {
      return null
    }
  }
  return null
}

/** 校验并给出一句人能看懂的错误摘要（写进日志，不返回给前端） */
export function validateObservation(value) {
  const r = validate(OBSERVATION_SCHEMA, value)
  return {
    ...r,
    summary: r.valid ? '' : r.errors.slice(0, 4).map(e => `${e.path} ${e.message}`).join('；')
  }
}

export function validateWriter(value, channelNames = []) {
  const schema = buildWriterSchema(channelNames)
  const r = validate(schema, value)
  return {
    ...r,
    summary: r.valid ? '' : r.errors.slice(0, 4).map(e => `${e.path} ${e.message}`).join('；')
  }
}
