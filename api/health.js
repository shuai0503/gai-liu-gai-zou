/* ============================================================
 * api/health.js · GET /api/health
 * ------------------------------------------------------------
 * 规格 5.5 明确要求：「设置一个 /health 返回 200，自己写个脚本每天 ping 一次」。
 * 评审期必须一直在线，这个端点就是那条生命线的探针。
 *
 * 返回内容刻意克制：
 *   · 只说「配没配」，不说「配了什么」
 *   · 不含任何 key、不含上游地址的路径，只给域名
 *   · 不触发任何模型调用（避免被刷成本）
 * ============================================================ */

import { sendJson, handlePreflight } from '../lib/http.js'
import { getSafeInfo } from '../lib/env.js'
import { loadRules, ruleSelfCheck } from '../lib/rules.js'

export default async function handler(req, res) {
  if (handlePreflight(req, res, process.env.ALLOW_ORIGIN || '*')) return

  const allowOrigin = process.env.ALLOW_ORIGIN || '*'
  const info = getSafeInfo()

  // 规则表是纯本地计算，探活时顺手验一次，能提前发现构建产物缺失
  let rules = { loaded: false }
  try {
    const r = await loadRules()
    const check = ruleSelfCheck()
    rules = {
      loaded: true,
      source: r.source,
      categories: r.CATEGORIES.length,
      selfCheck: check.tally,
      total: check.total
    }
  } catch (e) {
    rules = { loaded: false, error: e.code || 'LOAD_FAILED' }
  }

  const healthy = info.configured && rules.loaded

  sendJson(
    res,
    healthy ? 200 : 503,
    {
      ok: healthy,
      service: 'gai-liu-gai-zou-analyze',
      time: new Date().toISOString(),
      config: info,
      rules
    },
    allowOrigin
  )
}
