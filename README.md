# 该留该走 · 服务端

> 拍一张照，告诉你这件闲置该留、该卖、该捐，还是该专业回收。
> 这个目录是它的服务端：**API Key 只在这里，价格和渠道只来自规则表。**

配套文件：
- 判定引擎：[`../该留该走-品类规则表.js`](../该留该走-品类规则表.js)（34 个品类，已自测）
- 产品规格：`../该留该走-单页H5信息架构与文案.md` 第 5 章
- 可点击原型：`../该留该走-交互原型.html`

---

## 一、这个服务的核心设计：一句话讲清「模型 vs 规则表」

> **需要生成的地方交给模型，需要准确的地方交给代码。**

| 谁负责 | 产出什么 | 代码位置 | 怎么保证它不越界 |
|---|---|---|---|
| 视觉模型 | 品类、成色、材质、瑕疵、置信度 | `lib/vision.js` | 输出的 schema 里**根本没有** `price` / `channels` / `verdict` 字段 |
| 文本模型 | 处置理由 `reason`、发布文案 `copywriting` | `lib/writer.js` | 输出的 schema 用正则**拒绝**任何价格数字和平台名 |
| **规则表（纯函数）** | **价格区间、渠道、处置结论** | `lib/rules.js` → `judge()` | 全项目**唯一**能返回 `price` 的函数，内部无网络、无随机 |

这三道闸是**代码结构**保证的，不是靠 prompt 里写「请不要给价格」来求模型自觉：

1. **视觉端闸门**（`lib/schema.js` · `OBSERVATION_SCHEMA`）
   `additionalProperties: false` + 字段表里没有价格。
   模型就算自己想报个价，也没有槽位可以放，塞了额外字段会被判为不合格。

2. **文本端闸门**（`lib/schema.js` · `buildWriterSchema`）
   `reason` 和 `copywriting` 上挂了 `notPattern`，命中价格数字或平台名 → 判为不合格 → 自动重试 → 仍不合格返回 502。
   有专门的测试用例守着这条（见测试清单第 12、13 条）。

3. **产出端闸门**（`lib/rules.js` · `judge`）
   响应里的 `price` 只可能从这一个函数出来，它调的是 `decide()`，纯查表。
   测试里直接断言「接口返回的价格 === 单独调用 `judge()` 算出来的价格」。

---

## 二、目录结构

```
server/
├── api/
│   ├── analyze.js          # POST /api/analyze 主接口（两段式调用的编排）
│   └── health.js           # GET  /api/health 存活探针（评审期每天 ping）
├── lib/
│   ├── env.js              # 环境变量装配，注入 fetch（可测性的关键）
│   ├── errors.js           # 统一错误码 → HTTP 状态 + 中文提示
│   ├── http.js             # CORS、JSON 响应、读请求体
│   ├── image.js            # 图片格式嗅探与体积校验
│   ├── upload.js           # multipart / JSON 两种上传方式收敛
│   ├── llm.js              # 唯一发请求给模型的地方（超时 + 重试 + Key）
│   ├── prompt.js           # 两个 prompt 模板 + 禁用词清单
│   ├── schema.js           # 手写 JSON Schema 校验器 + 两段 schema
│   ├── vision.js           # 第一段：图片 → 观察
│   ├── writer.js           # 第二段：观察 + 规则结论 → 理由与文案
│   ├── rules.js            # 规则表接入 + 品类模糊匹配 + judge()
│   ├── channels.js         # 渠道说明（确定性文案，不经过模型）
│   ├── rules-table.js      # ⚠️ 自动生成的规则表镜像，勿手改
│   └── mock.js             # 假模型（仅测试用，production 默认拒绝启动）
├── scripts/
│   └── sync-rules.mjs      # 生成/校验规则表镜像
├── test/
│   └── run.js              # 52 个用例，node test/run.js 直接跑
├── .env.example
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

---

## 三、接口文档

### `POST /api/analyze`

#### 请求（两种都支持）

**A. multipart/form-data**（推荐，前端用 `FormData` 直接传压缩后的图）

```js
const fd = new FormData()
fd.append('image', compressedBlob, 'photo.jpg')
fd.append('hasWarranty', '1')   // 可选：用户说还在保修期内
fetch('/api/analyze', { method: 'POST', body: fd })
```

字段名收 `image`（首选）、`file`、`photo`。
可选字段 `hasWarranty`（`1` / `true`），对应规格 S2「建议先留着」分支的触发条件之一。

**B. application/json**

```js
fetch('/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageBase64: 'data:image/jpeg;base64,...',
    hasWarranty: true   // 可选
  })
})
```

`imageBase64` 也接受不带 `data:` 前缀的裸 base64。
支持的格式：JPEG / PNG / WEBP（按**文件头**嗅探，不看后缀）。
体积：2KB – 8MB。

#### 成功响应（HTTP 200）

```json
{
  "ok": true,
  "verdict": "sell",
  "category": { "id": "down-jacket", "name": "羽绒服", "group": "服饰" },
  "condition": "八成新",
  "material": "鹅绒",
  "damage": "",
  "reason": "还能穿得出去，二手有明确买家。",
  "price": [78, 117],
  "wide": false,
  "channels": [
    { "name": "闲鱼", "desc": "个人对个人，适合单品挂价……" },
    { "name": "转转", "desc": "有官方验机服务的二手平台……" }
  ],
  "copywriting": "八成新鹅绒羽绒服，L 码……",
  "meta": {
    "visionMs": 3200,
    "writerMs": 1800,
    "model": "your-vision-model",
    "visionAttempts": 1,
    "writerAttempts": 1,
    "transport": "multipart",
    "imageBytes": 143210,
    "totalMs": 5100
  }
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `verdict` | **规则表** | `keep` / `sell` / `donate` / `recycle` / `unknown` |
| `category` | 模型识别 + 规则表校验 | 一定能在规则表里查到 |
| `condition` | 模型 | 一定是规则表成色枚举之一 |
| `material` / `damage` | 模型 | 可能为空串 |
| `reason` | 文本模型 | 不含价格与平台名 |
| `price` | **规则表** | `null` 表示不建议走二手 |
| `wide` | **规则表** | 区间跨度 > 4 倍时为 true，前端提示"以实际为准" |
| `channels` | **规则表**（名字）+ `lib/channels.js`（说明） | 最多 2 个 |
| `copywriting` | 文本模型 | 非 `sell` 分支为 `null` |
| `meta` | 服务端 | 耗时与调试信息，不含任何密钥 |

#### 识别失败（HTTP 200 + `verdict: "unknown"`）

```json
{
  "ok": true,
  "verdict": "unknown",
  "reason": "没认出来，请换个角度重拍",
  "category": null,
  "condition": null,
  "material": "",
  "price": null,
  "wide": false,
  "channels": [],
  "copywriting": null,
  "meta": { "visionMs": 2100, "rejected": "low_confidence" }
}
```

前端据此展示 E1「没认出来」页。**服务端不会给一个猜的答案。**
`meta.rejected` 的取值说明走了哪条拒答分支：
`model_not_recognized` / `low_confidence` / `category_not_in_table` / `decision_unknown`。

#### 失败响应

统一格式：`{ "ok": false, "code": "...", "message": "中文提示" }`
（非 production 环境额外带 `detail`，生产环境不返回）

| HTTP | code | 用户看到的提示 | 什么时候 |
|---|---|---|---|
| 400 | `BAD_REQUEST` | 请求格式不对，请重新试一次 | 兜底 |
| 400 | `NO_IMAGE` | 没有收到照片，请重新选一张 | 没传图 |
| 400 | `IMAGE_TOO_LARGE` | 这张图有点大，换一张试试 | > 8MB |
| 400 | `IMAGE_INVALID_FORMAT` | 支持 JPG、PNG 的照片 | 不是图 / 不支持的格式 |
| 400 | `IMAGE_TOO_SMALL` | 图片太小了，拍清楚一点 | < 2KB |
| 400 | `PAYLOAD_INVALID` | 请求格式不对，请重新试一次 | JSON / multipart 结构坏了 |
| 405 | `METHOD_NOT_ALLOWED` | 请用 POST 上传照片 | 用了 GET |
| 502 | `VISION_FAILED` | 这次没成功，重试一下就好 | 视觉模型挂了 / 连续 2 次 schema 不合格 |
| 502 | `TEXT_FAILED` | 这次没成功，重试一下就好 | 文本模型挂了 / 连续 2 次写了价格 |
| 504 | `TIMEOUT` | 这次没成功，网络好像不太稳定，重试一下 | 视觉 > 12s 或文本 > 8s |
| 500 | `CONFIG_MISSING` | 服务暂时不可用，请稍后再试 | 环境变量没配好 |
| 500 | `INTERNAL` | 服务出了点问题，稍后再试 | 未预期异常 |

前端的映射建议：`400/405` → **E3**（图片不合规，回 S0 换一张）；`502/504/500` → **E2**（网络失败，允许用同一张图重试）。

### `GET /api/health`

```json
{
  "ok": true,
  "service": "gai-liu-gai-zou-analyze",
  "time": "2026-11-14T10:00:00.000Z",
  "config": {
    "configured": true, "mock": false, "host": "api.deepseek.com",
    "models": { "vision": "...", "text": "..." },
    "timeouts": { "visionMs": 12000, "textMs": 8000, "budgetMs": 22000 }
  },
  "rules": { "loaded": true, "source": "source", "categories": 34, "selfCheck": { ... }, "total": 34 }
}
```

- 健康返回 200，不健康返回 503
- **不含密钥**，只报域名不到路径
- **不触发任何模型调用**，随便 ping 不花钱

---

## 四、部署到 Vercel

### 步骤

1. **准备一个 OpenAI 兼容的模型服务**
   需要：一个支持图片输入的视觉模型 + 一个文本模型。DeepSeek / 通义千问 / 硅基流动 / 火山方舟 / 智谱都可以。

2. **上传代码**
   把 `server/` 目录作为项目根目录推到一个 Git 仓库。
   > Vercel 构建时只包含项目根目录内的文件，所以**不要**把仓库根设成 `D:\清理`，
   > 那会把整个工作目录都传上去。根目录请设为 `server/`（或只推这个目录）。

3. **新建 Vercel 项目**，导入仓库，Framework Preset 选 **Other**。
   不需要构建命令，不需要输出目录。

4. **配环境变量**（Project → Settings → Environment Variables）
   至少三条：`API_KEY`、`VISION_MODEL`、`API_BASE_URL`。
   建议再加 `TEXT_MODEL`。完整清单见下节。

5. **Deploy**，然后访问 `https://<你的域名>/api/health` 确认 `ok: true`。

6. **设置每日探活**（规格 5.5 要求：评审期必须一直在线）
   - 免费方案：在 [cron-job.org](https://cron-job.org) 建一个每天一次的 GET，指向 `/api/health`
   - 或 GitHub Actions 定时 curl（一行 `curl -fsS https://<域名>/api/health`）

7. **收紧跨域**（可选但建议）
   H5 上线后把 `ALLOW_ORIGIN` 从 `*` 改成 H5 的域名。

### 环境变量清单

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `API_KEY` | ✅ | — | 模型服务商密钥 |
| `VISION_MODEL` | ✅ | — | 视觉模型名 |
| `API_BASE_URL` | ⬜ | `https://api.deepseek.com/v1` | OpenAI 兼容 base URL，**不带** `/chat/completions` |
| `TEXT_MODEL` | ⬜ | 复用 `VISION_MODEL` | 文本模型名 |
| `VISION_TIMEOUT_MS` | ⬜ | `12000` | 视觉超时 |
| `TEXT_TIMEOUT_MS` | ⬜ | `8000` | 文本超时 |
| `TOTAL_BUDGET_MS` | ⬜ | `22000` | 单请求总预算 |
| `MAX_IMAGE_BYTES` | ⬜ | `8388608` | 8MB |
| `MIN_IMAGE_BYTES` | ⬜ | `2048` | 2KB |
| `ALLOW_ORIGIN` | ⬜ | `*` | CORS 允许来源 |
| `JSON_MODE` | ⬜ | `1` | 要求模型返回 JSON 对象 |
| `TEMPERATURE` | ⬜ | `0.2` | 采样温度 |
| `LOW_CONFIDENCE_AS_UNKNOWN` | ⬜ | `1` | low 置信度一律判 unknown |
| `DEGRADE_ON_WRITER_FAILURE` | ⬜ | `0` | 文本模型失败时是否降级返回 200 |
| `MOCK_MODE` | ⬜ | `0` | **仅本地测试用**，production 下默认被拒绝 |

服务商 base URL 参考：

```
DeepSeek    https://api.deepseek.com/v1
通义千问    https://dashscope.aliyuncs.com/compatible-mode/v1
硅基流动    https://api.siliconflow.cn/v1
火山方舟    https://ark.cn-beijing.volces.com/api/v3
智谱        https://open.bigmodel.cn/api/paas/v4
```

---

## 五、规则表的引入方式（以及为什么这么做）

`decide()` 来自 `../该留该走-品类规则表.js`，**没有复制粘贴一份改**。
但这个文件在项目根目录**之外**，而 Vercel 的 serverless 函数只能引用函数目录及其子目录内的文件。
所以采用了「同源 + 镜像 + 哈希校验」的方案：

```
lib/rules.js 按顺序尝试：
  1. ../该留该走-品类规则表.js   ← 本地开发、测试、以及把整个仓库作为根目录部署时
  2. ./rules-table.js            ← 仅部署 server/ 目录时的镜像
```

`lib/rules-table.js` 由 `scripts/sync-rules.mjs` 从源文件**逐字节复制**生成，
文件头写入源文件的 SHA-256。`test/run.js` 的第一条用例就是校验这个哈希：

```
源文件改了但没重新生成镜像  →  测试直接失败，不可能带着过期规则上线
```

**改规则的正确姿势：**
```bash
# 1. 改 ../该留该走-品类规则表.js
# 2. 重新生成镜像
node scripts/sync-rules.mjs
# 3. 跑测试确认
node test/run.js
```

**为什么用 ESM 而不是 CJS：**
规则表原件用的是 `export const` / `export function`（ESM 语法），
把它改成 CJS 就等于改动了这份已经自测通过的文件。
所以 `package.json` 声明 `"type": "module"`，全项目统一 ESM，`import` 语句直接复用原件，一行都不用改。
Vercel 的 Node 20 运行时原生支持 ESM 的 `api/*.js`，无需转译。
`scripts/sync-rules.mjs` 用动态 `import()` 加载，也正是为了能同时适配两种路径。

---

## 六、本地运行与测试

### 只跑逻辑（不需要任何 Key）

```bash
cd server
node test/run.js
```

期望输出：`全部通过：52/52`

测试全部在**进程内**执行（直接调用 `api/analyze.js` 的 handler，用假 `req`/`res`），
不起 HTTP 服务器、不装任何依赖、不联网。

### 手动试一遍完整流程（假模型）

```bash
# Windows PowerShell
$env:MOCK_MODE="1"; $env:API_KEY="dummy"; $env:VISION_MODEL="mock-vision"; node test/run.js

# macOS / Linux
MOCK_MODE=1 API_KEY=dummy VISION_MODEL=mock-vision node test/run.js
```

想看某个具体场景的返回体：把 `MOCK_SCENARIO` 设成下面任意一个值，再用一段十几行的脚本
直接 `import` `api/analyze.js` 的 handler 传个假 `req`/`res` 即可（`test/run.js` 里的
`makeReq` / `makeRes` / `callAnalyze` 就是现成的模板，复制过来改一下场景名就行）。

`MOCK_SCENARIO` 可选值：
`normal` / `unknown` / `not-in-table` / `low-confidence` / `kettle` /
`schema-fail-once` / `schema-fail-always` / `not-json` / `category-name` /
`writer-schema-fail-once` / `writer-schema-fail-always` / `writer-error` /
`timeout` / `upstream-error` / `degrade`

### 用真实模型跑（需要 Key）

```bash
cp .env.example .env      # 填入真实值
npx vercel dev            # 起本地 serverless 环境
curl -F "image=@test.jpg" http://localhost:3000/api/analyze
```

> 注意：`vercel dev` 需要登录 Vercel 并联网，这个环境里没跑过。

---

## 七、测试覆盖了什么，没覆盖什么（重要，别跳过）

### ✅ 已验证（逻辑层，`node test/run.js` 52/52 通过）

| # | 验证内容 | 性质 |
|---|---|---|
| 1 | 规则表镜像与源文件哈希一致 | 防止两份规则分叉 |
| 2 | 规则表 selfCheck：34 品类，五种 verdict 都有 | 回归保护 |
| 3 | 品类匹配：id / 中文名 / 别名 / 带修饰词 / 完全不相干 | 健壮性 |
| 4 | 正常路径（multipart 与 JSON 两种上传） | 主流程 |
| 5 | **响应里的 price 与 `judge()` 纯函数结果完全相同** | 分工证据 |
| 6 | **渠道名全部来自规则表 CATEGORIES** | 分工证据 |
| 7 | **视觉 schema 里没有 price / channels / verdict 字段** | 分工证据 |
| 8 | **文本模型写了价格 → schema 判不合格** | 分工证据 |
| 9 | **文本模型写了平台名 → schema 判不合格** | 分工证据 |
| 10 | 视觉模型塞额外字段（price）→ 被拒 | 分工证据 |
| 11 | unknown：模型说认不出 / 品类不在表 / 置信度 low | 不给猜测结论 |
| 12 | 视觉段 schema 失败 → 自动重试 1 次 → 成功（attempts=2） | 重试机制 |
| 13 | 视觉段连续 2 次失败 → 502 `VISION_FAILED` | 失败兜底 |
| 14 | 文本段写价格被拒 → 重试成功；连续失败 → 502 `TEXT_FAILED` | 重试机制 |
| 15 | 视觉段不返回 → 504 `TIMEOUT`（且 < 3s 内返回） | 超时控制 |
| 16 | 上游 500 → 502 | 错误映射 |
| 17 | 400 各类参数错误（无图 / 超大 / 非图 / 过小 / 坏 JSON / 坏 Content-Type） | 入参校验 |
| 18 | 405 非 POST；OPTIONS 预检 204 + CORS 头 | 协议正确性 |
| 19 | **所有响应体里没有 API Key、没有 Bearer、没有上游地址** | 密钥不外泄 |
| 20 | 所有错误 message 都是 ≤40 字中文短句，不含堆栈 | 用户体验 |
| 21 | 源码里不存在硬编码密钥形态字符串 | 安全检查 |
| 22 | `.env.example` 里没有真 key | 安全检查 |
| 23 | 真实模式缺 `API_KEY` → 500 `CONFIG_MISSING`（而非 502） | 配置错误归类 |
| 24 | `/api/health` 返回 200 且不含密钥 | 探活 |
| 25 | 降级开关开/关两种行为 | 可选策略 |
| 26 | 输出里没有禁用词 | 文案规范 |
| 27 | `hasWarranty` 参数透传到决策层（电水壶：sell ↔ keep） | 参数连通性 |

### ❌ 未验证（必须在有 Key 的环境里补测）

这个环境里**没有可用的真实 API Key**（服务商账户存在但凭据缺失），所以下面这些**一次都没跑过**：

1. **真实模型调用**——`lib/llm.js` 的 HTTP 请求形状（`messages` 数组、`image_url` 多模态格式、`response_format: json_object`）只用假 fetch 验证过，
   **没有跟任何真实服务商对上过**。
2. **视觉模型实际认不认得出这 34 个品类**——识别准确率、成色判断质量，全部未知。
3. **不同服务商对多模态消息的格式差异**——有些服务商对 `image_url.detail` 字段敏感，
   有些要求 base64 直接放 `image` 字段。换服务商可能需要微调 `lib/vision.js` 里组装消息的那几行。
4. **`response_format: { type: 'json_object' }` 的兼容性**——主流 OpenAI 兼容接口都支持，
   但个别服务商可能不认，需要用环境变量 `JSON_MODE=0` 关掉（代码已支持）。
5. **真实网络下的耗时**——12s / 8s 的超时是否够用，需要实测。视觉模型处理大图可能超过 12s。
6. **Vercel 上的实际部署**——`vercel.json` 与 `maxDuration: 30` 没在真实部署里验证过。
7. **支付宝 WebView 里的实际表现**——CORS、上传、超时都需要真机验证。
8. **`vercel dev` 本地链路**——环境里没装 Vercel CLI，也没登录过。

**上线前的最小验收清单：**
```
[ ] 用真实 Key 跑通 /api/analyze，返回 verdict=sell
[ ] 用一张宠物照片测 unknown 分支
[ ] 在支付宝里扫码，真机走通拍照 → 结果
[ ] /api/health 返回 200，并配上每日探活
[ ] 把 ALLOW_ORIGIN 收紧成 H5 域名
[ ] 确认 Vercel 环境变量里没有 MOCK_MODE=1
```

---

## 八、关键设计决策与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 零依赖 | 手写 multipart 解析 + 手写 schema 校验 | 两个函数的项目引 express/ajv/busboy 不值得；冷启动更慢，评审也更难读懂 |
| 注入 fetch | `buildDeps()` 返回 `fetchImpl` | 让「模型不听话」这件事可以被自动化测试，不必依赖真实 Key 和网络 |
| 置信度只给三档 | `high/medium/low` | 不下发"92%"这种伪精确数字（规格 2.1 明确不要展示置信度） |
| low 一律判 unknown | 默认开启，可关 | 规格 E1 的硬要求：「绝对不要给一个猜的答案」 |
| 品类三级匹配 | id → 名称 → 别名 → 包含 | 模型常返回中文名或带修饰词，直接判 unknown 会把能认的都丢掉 |
| 成色非法时回落 `八成新` | 而不是判失败 | 成色只影响价格系数；为了一个用词错误整单失败不划算，且 `八成新` 是规则表的保守中位数 |
| 文本失败默认 502 | 而不是降级 | 宁可让用户点一次重试拿到完整结果，也不要给半成品。要降级就显式开 `DEGRADE_ON_WRITER_FAILURE=1` |
| 渠道说明走静态表 | `lib/channels.js` | 让模型写渠道说明等于又让它碰了一次渠道信息。静态表可核、可复现、不会编造机构地址 |
| 禁止模型写价格 | schema 级拦截 + 重试 | 这是作品的立论基础。写在 prompt 里是"请求"，写在 schema 里是"强制" |
| 规则表用镜像 + 哈希 | 不是复制粘贴 | Vercel 目录限制是硬约束；哈希校验让"两份规则分叉"变成不可能，而不是靠人记得同步 |
| 错误只回中文短句 | `detail` 仅非生产返回 | 用户看到的是能照着做的一句话，技术细节留在服务端日志 |

---

## 九、已知风险与未完成部分

1. **视觉模型的输出格式风险最高。**
   `lib/vision.js` 里组装的多模态消息是 OpenAI 标准形状，但真实服务商可能需要微调。
   **这是上线前第一件要打通的测试。**

2. **超时预算可能偏紧。**
   视觉 12s + 文本 8s = 20s，加上图的传输，逼近 Vercel 的函数上限。
   真实调用如果慢，用户会看到 504。建议实测后按 P95 调整。

3. **没有做请求频次限制。**
   公网可访问的付费接口，被刷会直接产生账单。
   建议在 Vercel 侧加 WAF / Rate Limit，或在代码里加一个基于 IP 的简易限流（本次未做，因为需要外部存储）。

4. **没有做图片内容审核。**
   用户可能上传违规图片。当前只校验格式和体积，不做内容判断。
   正式上线建议在视觉模型那一段顺带回一个 `safe` 字段（会多一次模型判断成本）。

5. **`damage` 字段对 `decide()` 不生效。**
   规则表 `decide()` 目前只吃 `condition`，不吃具体瑕疵描述。
   所以模型识别出的"袖口磨损"只写进了文案，没有影响价格。
   要让它影响价格，得在规则表侧加逻辑——**那是规则表的改动，不在本次范围内**。

6. **`lib/channels.js` 的说明文案未经真实核对。**
   写的是各渠道的通用性质（"个人对个人"、"有验机服务"），没有具体地址电话，
   但渠道政策会变，上线前建议人工过一遍。

7. **前端还没接这个接口。**
   `../该留该走-交互原型.html` 里的 `DATA` 是写死的示例，需要用真实接口替换。
   字段已经对齐（见 `DATA.sell` 与响应结构的对应关系）。

8. **没做长图导出、记录页相关的服务端能力**（那是纯前端 P1）。

---

## 十、和作品说明的对应关系

| 作品说明里写的 | 代码里在哪 |
|---|---|
| 「价格区间、渠道匹配……全部是确定性规则」 | `lib/rules.js` → `judge()`，无网络无随机 |
| 「模型给出的数字无法验证，所以不交给模型」 | `lib/schema.js` 的两段 schema 拦截 |
| 「单次识别共调用模型 2 次」 | `api/analyze.js` 里 `runVision` + `runWriter` 各一次 |
| 「失败重试上限 2 次」 | `lib/llm.js` 的 `maxAttempts = 2`（首次 + 重试 1 次） |
| 「识别不出就不给结论」 | `runVision` 返回 `resolved: null` 时直接出 unknown，不进第二段 |
| 「用户照片仅用于当次识别，不存储」 | 全程只在内存里传 Buffer，没有任何落盘或数据库 |
| 「价格一律标注非报价」 | `price` 与 `wide` 分离下发，文案交给前端（见规格 2.3 分支 B） |

> ⚠️ 作品说明里写的「60 个品类 / 30 家机构」和规则表实际的 **34 个品类** 对不上。
> 提交前**必须**把这些数字改成代码里真实的数量，评委交叉核对时会查这个。
