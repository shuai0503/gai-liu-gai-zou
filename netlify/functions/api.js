/* ============================================================
 * netlify/functions/api.js · Netlify 适配器
 * ------------------------------------------------------------
 * 为什么需要这个文件：
 *   Vercel 的约定是 api/analyze.js → /api/analyze
 *   Netlify 的约定是 netlify/functions/x.js → /.netlify/functions/x
 *   两者不一样。但我不想把已经验证过的 api/*.js 推倒重写。
 *
 * 所以这里做一个「薄适配器」：
 *   · 按路径分发到现有的 api/analyze.js / recategorize.js / health.js
 *   · 把 Netlify 的 event 转成类 Vercel 的 (req, res) 形状
 *   · 把返回值转回 Netlify 要求的 { statusCode, headers, body }
 *
 * 好处：原有三个 handler、全部测试、全部逻辑都不动。
 * 代价：多一层转发，冷启动多几十毫秒。
 * ============================================================ */

import analyze from '../../api/analyze.js'
import recategorize from '../../api/recategorize.js'
import health from '../../api/health.js'

/* ------------------------------------------------------------
 * 把 Netlify 的 event 包装成 Vercel 风格的 (req, res)
 * ---------------------------------------------------------- */

function makeReq(event) {
  const bodyBuf = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8'))
    : Buffer.alloc(0)

  const req = {
    method: event.httpMethod,
    url: event.path,
    headers: event.headers || {},
    /* lib/http.js 的 readBody 优先读 req.body，挂上 Buffer 即可 */
    body: bodyBuf,
    rawBody: bodyBuf,
    /* 兼容个别地方可能用到的异步迭代（这里不需要真流） */
    async *[Symbol.asyncIterator]() {
      if (bodyBuf.length) yield bodyBuf
    }
  }
  return req
}

function makeRes() {
  let statusCode = 200
  const headers = {}
  /* 用对象包装，避免闭包变量被判为"未赋值" */
  const state = { body: null, sent: false }
  let resolveDone
  const done = new Promise(r => { resolveDone = r })

  const res = {
    get statusCode() { return statusCode },
    set statusCode(v) { statusCode = v },
    setHeader(k, v) { headers[k] = v; return res },
    getHeader(k) { return headers[k] },
    json(obj) { return res.send(JSON.stringify(obj)) },
    send(body) {
      if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
        return res.json(body)
      }
      state.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
      state.sent = true
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json; charset=utf-8'
      }
      resolveDone()
      return res
    },
    end(body) {
      return res.send(body === undefined ? '' : body)
    }
  }

  res._done = done
  res._build = () => ({
    statusCode,
    headers,
    body: state.sent ? state.body : '',
    isBase64Encoded: false
  })
  res._isSent = () => state.sent
  return res
}

/* ------------------------------------------------------------
 * 主入口
 * ---------------------------------------------------------- */

export async function handler(event) {
  const path = (event.path || '').replace(/\/+$/, '')

  /* 按路径选 handler。
   * 注意：redirects 里已经统一转到这个函数，
   * 所以 event.path 会是原始路径（比如 /api/analyze）。 */
  let fn = null
  if (path.endsWith('/api/analyze')) fn = analyze
  else if (path.endsWith('/api/recategorize')) fn = recategorize
  else if (path.endsWith('/api/health')) fn = health
  else if (path.endsWith('/api') || path.endsWith('/.netlify/functions/api')) {
    /* 直接访问函数根，给个提示 */
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true, message: '接口正常，请访问 /api/health 或 /api/analyze' })
    }
  }

  if (!fn) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, code: 'NOT_FOUND', message: '接口不存在' })
    }
  }

  const req = makeReq(event)
  const res = makeRes()

  try {
    await fn(req, res)
  } catch (e) {
    /* handler 自己通常会捕获并返回结构化错误，走到这里说明是意外 */
    console.error('[netlify-adapter] 未捕获异常', e && e.message)
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, code: 'INTERNAL', message: '服务出了点问题' })
    }
  }

  /* 等 handler 真正写出响应。多数 handler 是同步 send，但保险起见等一小会儿 */
  const timeout = new Promise(r => setTimeout(r, 100))
  await Promise.race([res._done, timeout])

  if (!res._isSent()) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, code: 'INTERNAL', message: '处理超时' })
    }
  }
  return res._build()
}
