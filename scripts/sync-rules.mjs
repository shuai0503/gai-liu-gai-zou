/* ============================================================
 * scripts/sync-rules.mjs · 把规则表原件镜像成 lib/rules-table.js
 * ------------------------------------------------------------
 * 为什么需要这一步：
 *
 *   Vercel 在构建 serverless 函数时，函数只能引用「函数所在目录及其子目录」
 *   里的文件。如果项目根目录指向 D:\清理\server，那么
 *   ../该留该走-品类规则表.js 就不在原件的可达范围内，构建会直接失败。
 *
 * 所以这里不是"复制一份改改"，而是生成一份**逐字节一致的镜像**，
 * 并且在文件头写入源文件的内容哈希。test/run.js 会校验哈希：
 *   原件一改而镜像没重新生成 → 测试立刻失败。
 * 这样既满足了 Vercel 的目录约束，又不会出现两份规则悄悄分叉。
 *
 * 用法：
 *   node scripts/sync-rules.mjs          # 生成 / 覆盖镜像
 *   node scripts/sync-rules.mjs --check  # 只检查，不写文件（CI 用）
 * ============================================================ */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = join(HERE, '..')
const SOURCE = join(SERVER_ROOT, '..', '该留该走-品类规则表.js')
const MIRROR = join(SERVER_ROOT, 'lib', 'rules-table.js')

const HEADER = `/* ============================================================
 * ⚠️ 自动生成的文件，不要手改
 * ------------------------------------------------------------
 * 源文件：../该留该走-品类规则表.js
 * 生成命令：node scripts/sync-rules.mjs
 *
 * 这里的判定逻辑与源文件逐字节一致，只是为了满足
 * Vercel 函数目录不能引用上级目录的限制。
 * 改动请改源文件，再重新生成；test/run.js 会校验哈希一致性。
 *
 * source-sha256: %HASH%
 * ============================================================ */

`

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 生成镜像内容
 * @returns {Promise<{mirror:string, hash:string, source:string}>}
 */
export async function buildMirror() {
  const source = await readFile(SOURCE, 'utf8')
  const hash = sha256(source)
  const header = HEADER.replace('%HASH%', hash)
  return { mirror: header + source, hash, source }
}

/** 读取已存在的镜像里的哈希 */
export async function readMirrorHash() {
  try {
    const text = await readFile(MIRROR, 'utf8')
    const m = /source-sha256:\s*([a-f0-9]{64})/.exec(text)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** 主流程 */
async function main() {
  const checkOnly = process.argv.includes('--check')
  const { mirror, hash } = await buildMirror()
  const existing = await readMirrorHash()

  if (existing === hash) {
    console.log(`✅ 镜像已是最新（sha256 ${hash.slice(0, 12)}…）`)
    return
  }

  if (checkOnly) {
    console.error(
      `❌ 镜像过期：源文件 sha256=${hash.slice(0, 12)}…，镜像=${(existing || '缺失').slice(0, 12)}…\n` +
      `   请运行 node scripts/sync-rules.mjs`
    )
    process.exitCode = 1
    return
  }

  await writeFile(MIRROR, mirror, 'utf8')
  console.log(
    `✅ 已生成 ${relative(SERVER_ROOT, MIRROR)}\n` +
    `   源文件 sha256 ${hash.slice(0, 12)}…（${Buffer.byteLength(mirror, 'utf8')} 字节）`
  )
}

// 只有直接执行时才跑 main，被 import 时只导出函数
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
