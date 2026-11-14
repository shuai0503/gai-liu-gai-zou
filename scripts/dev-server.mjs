/* ============================================================
 * scripts/dev-server.mjs · 本地联调服务器
 * ------------------------------------------------------------
 * 为什么需要它：
 *   这个环境里 pwsh 不可用、也没装 vercel CLI，
 *   所以用 node 原生 http 起一个和 Vercel 行为一致的小服务：
 *     GET  /            → public/index.html
 *     POST /api/analyze → 复用真实的 api/analyze.js handler
 *     GET  /api/health  → 同上
 *
 * 用法：
 *   $env:API_KEY="sk-..."; node scripts/dev-server.mjs
 *   然后浏览器打开 http://127.0.0.1:8787
 *
 * 它做的事和 vercel dev 的关键差别：
 *   · 没有 edge 缓存、没有 CDN，纯直连
 *   · 只实现本项目用到的 Vercel req/res 子集（json/status/end/send）
 * ============================================================ */

import http from 'node:http'
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, extname } from 'node:path'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PORT = Number(process.env.PORT || 8787)
/* 默认绑定 0.0.0.0，手机才能通过局域网访问；只想本机用就设 HOST=127.0.0.1 */
const HOST = process.env.HOST || '0.0.0.0'

if (!process.env.API_KEY) {
  console.error('缺少 API_KEY。用法：')
  console.error('  $env:API_KEY="sk-..."; node scripts/dev-server.mjs\n')
  process.exit(1)
}

/* ---------- 把 Vercel 的 res 子集模拟出来 ---------- */
function wrapRes(nodeRes) {
  let statusCode = 200
  const headers = {}

  const res = {
    status(code) { statusCode = code; return res },
    statusCode: 200,
    setHeader(k, v) { headers[k] = v; return res },
    getHeader(k) { return headers[k] },
    json(obj) { return send(JSON.stringify(obj), 'application/json; charset=utf-8') },
    send(body) {
      if (typeof body === 'object' && body !== null) return res.json(body)
      return send(body, 'text/plain; charset=utf-8')
    },
    end(body) {
      if (body !== undefined) return send(body, 'text/plain; charset=utf-8')
      nodeRes.writeHead(statusCode, headers)
      nodeRes.end()
    }
  }

  function send(body, type) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
    const finalHeaders = { 'Content-Length': buf.length, ...headers }
    if (!Object.keys(finalHeaders).some(k => k.toLowerCase() === 'content-type')) {
      finalHeaders['Content-Type'] = type
    }
    nodeRes.writeHead(statusCode, finalHeaders)
    nodeRes.end(buf)
  }

  // Vercel 允许直接写 res.statusCode / res.setHeader，这里也支持
  Object.defineProperty(res, 'statusCode', {
    get() { return statusCode },
    set(v) { statusCode = v }
  })

  return res
}

/** 收集请求体（限制 12MB，与服务端上限一致） */
function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolveP, rejectP) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) {
        rejectP(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks)))
    req.on('error', rejectP)
  })
}

/* ---------- 载入真实的 handler ---------- */
const analyzeMod = await import(new URL('../api/analyze.js', import.meta.url).href)
const healthMod = await import(new URL('../api/health.js', import.meta.url).href)
const recatMod = await import(new URL('../api/recategorize.js', import.meta.url).href)
const analyze = analyzeMod.default
const health = healthMod.default
const recategorize = recatMod.default

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

async function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname
  // 只暴露 public 目录，防目录穿越
  const filePath = resolve(ROOT, 'public', '.' + rel)
  if (!filePath.startsWith(resolve(ROOT, 'public'))) {
    res.writeHead(403); return res.end('forbidden')
  }
  try {
    const buf = await readFile(filePath)
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  }
}

/* ---------- 服务 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  // 请求日志：只打方法、路径、状态，绝不打 header
  const t0 = Date.now()
  res.on('finish', () => {
    console.log(`${req.method} ${pathname} → ${res.statusCode || 200} (${Date.now() - t0}ms)`)
  })

  try {
    if (pathname === '/api/analyze') {
      const buf = await readBody(req)
      // lib/http.js 的 readBody 会优先读 req.body（Buffer / string / object 都支持），
      // 所以这里只需要把原始字节挂上去，不需要重放 stream。
      req.body = buf
      req.rawBody = buf
      return analyze(req, wrapRes(res))
    }

    if (pathname === '/api/recategorize') {
      const buf = await readBody(req, 32 * 1024)
      req.body = buf
      return recategorize(req, wrapRes(res))
    }

    if (pathname === '/api/health') {
      return health(req, wrapRes(res))
    }

    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND', message: '接口不存在' }))
    }

    return serveStatic(pathname, res)
  } catch (e) {
    console.error('[dev-server] 未捕获异常', e && e.message ? e.message : e)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'INTERNAL', message: '服务出了点问题' }))
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log('')
  console.log('  该留该走 · 本地联调服务器')
  console.log('  ─────────────────────────────────────')
  console.log(`  监听   ${HOST}:${PORT}`)
  console.log(`  打开   http://127.0.0.1:${PORT}`)
  if (HOST === '0.0.0.0') {
    // 列出所有可用的局域网地址，方便手机扫码
    const nets = os.networkInterfaces()
    for (const [name, list] of Object.entries(nets)) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) {
          console.log(`  局域网 http://${n.address}:${PORT}   (${name})`)
        }
      }
    }
  }
  console.log(`  健康   http://127.0.0.1:${PORT}/api/health`)
  console.log(`  模型   ${process.env.VISION_MODEL || 'qwen3-omni-flash'}`)
  console.log(`  接口   ${process.env.API_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'}`)
  console.log('  ─────────────────────────────────────')
  console.log('  Ctrl+C 停止')
  console.log('')
})
