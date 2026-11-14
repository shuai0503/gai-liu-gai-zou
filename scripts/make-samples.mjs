/**
 * scripts/make-samples.mjs
 * 生成一批「有足够细节」的测试图，用于验证识别链路。
 * 之前失败的原因是测试图过于抽象（几个色块），模型看不出是什么。
 * 这次画得更像实物：加阴影、渐变、细节纹理。
 *
 * 用法：node scripts/make-samples.mjs
 * 输出到 D:\清理\samples\
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = 'D:\\清理\\samples'
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let p = 0
  for (let y = 0; y < h; y++) {
    raw[p++] = 0
    for (let x = 0; x < w; x++) {
      const c = paint(x, y)
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]
    }
  }
  const idat = deflateSync(raw, { level: 6 })
  const crc = b => {
    let c = -1
    for (let i = 0; i < b.length; i++) {
      c ^= b[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
    }
    return (c ^ -1) >>> 0
  }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length)
    const tb = Buffer.from(t, 'ascii')
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([tb, d])))
    return Buffer.concat([l, tb, d, c])
  }
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ])
}

/* 工具 */
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t)
]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/* 背景：浅灰渐变 + 轻微噪点，模拟手机拍摄墙面 */
function bg(x, y, w, h) {
  const t = y / h
  const base = mix([246, 246, 248], [226, 228, 232], t)
  const n = ((x * 13 + y * 7) % 5) - 2
  return [clamp(base[0] + n, 0, 255), clamp(base[1] + n, 0, 255), clamp(base[2] + n, 0, 255)]
}

/* 投影：椭圆软阴影 */
function shadow(cx, cy, rx, ry, x, y, strength = 0.18) {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  const d = dx * dx + dy * dy
  if (d > 1) return 0
  return strength * (1 - d) * (1 - d)
}

/* ============================================================
 * 1. 运动鞋（白底鞋侧面）
 * ============================================================ */
function paintShoe(x, y) {
  const W = 800, H = 800
  const sh = shadow(400, 610, 300, 55, x, y, 0.22)
  const b = bg(x, y, W, H)

  // 鞋底（厚橡胶，灰色）
  const soleTop = 545, soleBot = 610
  if (y >= soleTop && y <= soleBot) {
    const t = (y - soleTop) / (soleBot - soleTop)
    // 鞋底轮廓：两端收窄
    const rx = 130 + Math.sin(Math.PI * clamp((x - 150) / 550, 0, 1)) * 210
    const inRange = Math.abs(x - 420) < rx
    if (inRange) {
      const base = mix([248, 249, 250], [200, 202, 206], t)
      // 底部一圈更深
      if (y > soleBot - 8) return [176, 178, 183]
      return base
    }
  }

  // 鞋面（白色皮革，带高光）
  if (y >= 330 && y <= soleTop) {
    const t = (y - 330) / (soleTop - 330)
    const leftEdge = 165 + t * 55
    const rightEdge = 660 - t * 175
    if (x > leftEdge && x < rightEdge) {
      // 左侧暗、中间亮，形成立体感
      const rel = (x - leftEdge) / Math.max(1, rightEdge - leftEdge)
      const lit = Math.exp(-Math.pow((rel - 0.42) / 0.3, 2))
      const base = mix([218, 220, 224], [252, 253, 255], lit)
      // 鞋面顶部更深
      const topDark = 1 - clamp(t * 1.6, 0, 1) * 0.35
      return [
        clamp(base[0] * topDark, 0, 255),
        clamp(base[1] * topDark, 0, 255),
        clamp(base[2] * topDark, 0, 255)
      ]
    }
  }

  // 鞋帮（后跟更高）
  if (y >= 250 && y <= 330 && x >= 480 && x <= 660) {
    const t = (y - 250) / 80
    return mix([206, 210, 216], [232, 235, 239], t)
  }

  // 鞋带（深灰交叉线）
  if (y >= 360 && y <= 530 && x >= 250 && x <= 520) {
    const rel = (x - 250) / 270
    const diag1 = Math.abs((rel * 270) - ((y - 360) % 60) - 30) < 4
    const diag2 = Math.abs((270 - rel * 270) - ((y - 360) % 60) - 30) < 4
    if (diag1 || diag2) return [96, 100, 108]
  }

  // 装饰条纹
  if (y >= 430 && y <= 480 && x >= 220 && x <= 600) {
    const rel = (x - 220) / 380
    if (rel > 0.45 && rel < 0.55) return [66, 112, 176]
  }

  return [
    clamp(b[0] * (1 - sh) + 40 * sh, 0, 255),
    clamp(b[1] * (1 - sh) + 42 * sh, 0, 255),
    clamp(b[2] * (1 - sh) + 46 * sh, 0, 255)
  ]
}

/* ============================================================
 * 2. 书堆
 * ============================================================ */
function paintBooks(x, y) {
  const W = 800, H = 800
  const sh = shadow(400, 630, 280, 45, x, y, 0.2)
  const b = bg(x, y, W, H)

  const books = [
    { y0: 540, y1: 620, x0: 150, x1: 660, c: [178, 76, 68] },
    { y0: 458, y1: 540, x0: 175, x1: 640, c: [62, 112, 168] },
    { y0: 382, y1: 458, x0: 200, x1: 615, c: [208, 168, 74] },
    { y0: 310, y1: 382, x0: 225, x1: 590, c: [92, 148, 106] },
    { y0: 252, y1: 310, x0: 250, x1: 565, c: [140, 96, 160] }
  ]

  for (const bk of books) {
    if (y >= bk.y0 && y < bk.y1 && x >= bk.x0 && x <= bk.x1) {
      // 书脊两端压暗，中间略亮
      const rel = (x - bk.x0) / (bk.x1 - bk.x0)
      const shade = 0.72 + 0.28 * Math.exp(-Math.pow((rel - 0.45) / 0.35, 2))
      // 书脊上下边缘有深色缝
      const edge = (y - bk.y0 < 5 || bk.y1 - y < 5) ? 0.62 : 1
      const k = shade * edge
      // 书脊上的横纹装饰
      const band = ((y - bk.y0) % 26) < 3 ? 0.7 : 1
      return [
        clamp(bk.c[0] * k * band, 0, 255),
        clamp(bk.c[1] * k * band, 0, 255),
        clamp(bk.c[2] * k * band, 0, 255)
      ]
    }
  }

  return [
    clamp(b[0] * (1 - sh) + 50 * sh, 0, 255),
    clamp(b[1] * (1 - sh) + 52 * sh, 0, 255),
    clamp(b[2] * (1 - sh) + 56 * sh, 0, 255)
  ]
}

/* ============================================================
 * 3. 路由器
 * ============================================================ */
function paintRouter(x, y) {
  const W = 800, H = 800
  const sh = shadow(400, 620, 300, 50, x, y, 0.2)
  const b = bg(x, y, W, H)

  // 天线
  const ant = [[230, 130], [570, 130]]
  for (const [ax, ay] of ant) {
    if (x >= ax - 9 && x <= ax + 9 && y >= ay && y <= 450) {
      const t = (y - ay) / (450 - ay)
      const c = mix([52, 54, 60], [92, 96, 104], t)
      // 天线高光
      if (x >= ax - 3 && x <= ax + 2) return [mix(c, [160, 164, 172], 0.35)[0], mix(c, [160, 164, 172], 0.35)[1], mix(c, [160, 164, 172], 0.35)[2]]
      return c
    }
  }

  // 机身
  if (y >= 440 && y <= 600 && x >= 130 && x <= 670) {
    const t = (y - 440) / 160
    const base = mix([242, 243, 245], [214, 216, 220], t)
    // 前面板指示灯
    if (y >= 500 && y <= 516) {
      for (let i = 0; i < 5; i++) {
        const lx = 200 + i * 85
        if (x >= lx && x <= lx + 34) {
          return i === 0 ? [90, 200, 120] : i === 4 ? [230, 150, 70] : [150, 200, 240]
        }
      }
    }
    // 顶部散热槽
    if (y >= 452 && y <= 470 && x >= 170 && x <= 630 && (x % 22) < 12) {
      return [190, 192, 197]
    }
    return base
  }

  // 底部支撑阴影
  if (y > 600 && y <= 616 && x >= 150 && x <= 650) {
    return [188, 190, 195]
  }

  return [
    clamp(b[0] * (1 - sh) + 48 * sh, 0, 255),
    clamp(b[1] * (1 - sh) + 50 * sh, 0, 255),
    clamp(b[2] * (1 - sh) + 54 * sh, 0, 255)
  ]
}

/* ============================================================
 * 4. 保温杯 / 水壶
 * ============================================================ */
function paintKettle(x, y) {
  const W = 800, H = 800
  const sh = shadow(400, 660, 200, 40, x, y, 0.22)
  const b = bg(x, y, W, H)

  // 杯身（圆柱，带渐变）
  const cx = 400, top = 240, bot = 640, halfW = 130
  if (y >= top && y <= bot) {
    // 轮廓随高度略收窄
    const t = (y - top) / (bot - top)
    const w = halfW * (0.92 + 0.08 * Math.sin(Math.PI * t))
    if (Math.abs(x - cx) < w) {
      const rel = (x - (cx - w)) / (w * 2)
      // 圆柱高光在 0.32 处
      const lit = Math.exp(-Math.pow((rel - 0.32) / 0.26, 2))
      const base = mix([92, 128, 118], [186, 214, 204], lit)
      // 顶部杯沿
      if (y - top < 14) return mix([70, 96, 90], base, 0.4)
      // 底部
      if (bot - y < 12) return mix([60, 84, 78], base, 0.45)
      return base
    }
  }

  // 杯盖
  if (y >= 196 && y <= 244) {
    const t = (y - 196) / 48
    const w = halfW * (0.96 - 0.04 * t)
    if (Math.abs(x - cx) < w) {
      const rel = (x - (cx - w)) / (w * 2)
      const lit = Math.exp(-Math.pow((rel - 0.34) / 0.28, 2))
      return mix([56, 62, 60], [128, 136, 133], lit)
    }
  }

  return [
    clamp(b[0] * (1 - sh) + 52 * sh, 0, 255),
    clamp(b[1] * (1 - sh) + 54 * sh, 0, 255),
    clamp(b[2] * (1 - sh) + 58 * sh, 0, 255)
  ]
}

const JOBS = [
  ['01-sneaker.png', 800, 800, paintShoe],
  ['02-books.png', 800, 800, paintBooks],
  ['03-router.png', 800, 800, paintRouter],
  ['04-kettle.png', 800, 800, paintKettle]
]

for (const [name, w, h, fn] of JOBS) {
  const buf = png(w, h, fn)
  writeFileSync(OUT + '\\' + name, buf)
  console.log(`${name}  ${Math.round(buf.length / 1024)}KB`)
}
console.log(`\n输出目录：${OUT}`)
