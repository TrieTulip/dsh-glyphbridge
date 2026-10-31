# GlyphBridge 制作流程

> 把一个**只能看文本**的 DeepSeek 模型，变成一个**能收到图片**的模型。
> 主通路是"伴生 provider 路由"（视觉孪生），兜底是一个读图工具。
> 本文记录这个插件从零到装进 DSH 的完整过程，包括每一步的判断依据、验证方式和踩过的坑。
> 检验方法与实测记录单独成篇：[`检验流程.md`](检验流程.md)。

- 目标运行环境：DeepSeek Harness `0.2.0-rc.2`（桌面打包版，只有 `app.asar`，没有源码仓库）
- 成品包名：`dsh-glyphbridge`，版本 `0.4.0`
- 示例安装位置：`$DSH_HOME/profiles/desktop`（桌面应用）与 `$DSH_HOME/profiles/web`（`dsh web`）

---

## 0. 成品长什么样

```
                         准入检查               派发
用户粘贴图片 ────────────────────► 孪生路由 ──────────────► 证据文本 ──► 真实 DeepSeek 适配器
                    读 inputModalities  glyphbridge        （OCR/版面/表格）      deepseek-*
```

```
dsh-GlyphBridge/
├── src/dsh/
│   ├── index.ts      插件入口 { name, inject, apply }
│   ├── config.ts     schemastery 配置：目标路由 + 两个引擎槽 + 缓存 + 工具开关
│   ├── adapter.ts    孪生适配器：能力镜像、请求改写、委托
│   ├── pipeline.ts   转译管线：primary → fallback 链
│   ├── cache.ts      证据缓存：LRU + 同键合并
│   ├── engines.ts    VLM / OCR 两种引擎协议
│   ├── evidence.ts   证据词汇表 + 唯一文本呈现
│   └── tool.ts       glyphbridge_read_image 工具
├── cordis.patch.yml  bundle 补丁层（声明插件条目与默认值）
├── lib/              tsc 产物（插件真正加载的是这里）
├── .probe/           对真实运行时跑的三支验证探针
├── verify/           可独立复跑的缓存与引擎协议检验脚本
├── GlyphBridge 制作流程.md   本文（怎么做的）
├── 检验流程.md        检验方法与实测记录（怎么证明它是对的）
├── package.json      含 dsh.bundle.patch 声明
└── tsconfig.json
```

最小可用面：`package.json`（`dsh.bundle.patch` 指向补丁层）+ `cordis.patch.yml` + `lib/`。

---

## 1. 需求与约束

| 约束 | 对设计的影响 |
|---|---|
| 主通路必须是"伴生 provider 路由（视觉孪生）" | 不能只写一个工具；必须注册一条 provider 路由，让图片先被**准入** |
| 工具是兜底 | 工具与路由共用同一条转译管线和同一份证据格式，否则两条路会长歪 |
| 目标模型是纯文本 DeepSeek | 真实适配器永远不能收到 image block |
| 不许截断 / 摘要 / 压缩证据 | 管线里没有任何 token 预算逻辑，只有读取字节的安全上限 |
| 不许伪造 | 引擎失败时给模型一段"无法转译，请勿猜测"的显式说明，而不是让整轮失败或编内容 |
| 凭证不落配置 | 配置里只写环境变量名（`apiKeyEnv`），值只从启动环境读 |

---

## 2. 第一步：先弄清"图片为什么进不来"

这是整个项目的分水岭。**如果先写工具，会撞墙；必须先找到拒绝发生的位置。**

### 2.1 两个关卡

从打包版的 `app.asar` 里把 `@deepseek-ai/*` 读出来（见第 3 节），在
`@deepseek-ai/dsh-api-session-controller` 的 `prompt()` 里找到第一道关卡：

```js
const current = this.agents.selectionFor(agent).current
const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
  throw new RemoteError('session/attachment-invalid',
    `Model "..." does not support image input.`,
    { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
}
```

它在**任何插件钩子之前**执行：`llm/stream` 中间件、工具、会话事件全都还没轮到。所以在纯文本
`deepseek-*` 路由上，无论插件多早介入，图片都进不到模型调用里。

第二道关卡在 `@deepseek-ai/dsh-llm` 的 `adapterStream()`：

```js
if (modelInfo.inputModalities !== undefined
    && !modelInfo.inputModalities.includes('image')
    && projectedMessages.some((message) => contentHasImage(message.content))) {
  projectedMessages = projectImagesForTextModel(projectedMessages)   // 图片 → 占位符文本
}
```

同一个事实（`inputModalities`）被**用了两次**。

### 2.2 结论

> 只要有一条 provider 路由，它的适配器在 `resolveModel()` 里回答
> `inputModalities: ['text', 'image']`，两道关卡就都会放行；图片会完整送到这条路由的
> `stream()` 里。至于背后的真实模型看不看得见图片，运行时不管——这正是桥的位置。

这就是"伴生 provider 路由"的机制来源，也是为什么必须走这条路。

### 2.3 用探针把结论钉死

`probe1-admission.mjs` 把上面那段准入判定**逐字复制**到真实 `LlmRuntime` 上跑：

| 路由能力 | 准入结果 |
|---|---|
| `['text']` | 拒绝（等价 `MODEL_DOES_NOT_SUPPORT_IMAGES`） |
| `['text','image']` | 通过，且派发时图片不被替换成占位符 |

先有这条结论，再动代码。**这个项目的所有设计都是从这一条事实推出来的。**

---

## 3. 第二步：在只有打包版的机器上建立开发环境

本机没有 dsh 源码仓库，只有：

```
%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar     ← 运行时全部代码
%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\      ← node / pnpm / dsh CLI
```

### 3.1 读运行时源码

`app.asar` PowerShell 读不了（要 Node 的 asar 支持）。`.probe/` 里放了四个零依赖读取器：

| 脚本 | 用途 |
|---|---|
| `asar-ls.cjs <asar> [filter]` | 列出归档内文件（看包里有什么） |
| `asar-cat.cjs <asar> <path>` | 打印单个文件（读运行时真实实现） |
| `asar-extract.cjs <asar> <out> [prefix]` | 按前缀整目录解包 |
| `asar-extract-closure.cjs <asar> <out> <pkg...>` | **只**解出若干包的运行时依赖闭包 |

最后一个是关键：整棵 `@deepseek-ai` 树有 3664 个文件 / 236 MB，而探针只需要 4 个根包，
按 `dependencies` + `peerDependencies` 求闭包后是 **33 个包 / 9.3 MB**，几十秒解完：

```powershell
node .probe/asar-extract-closure.cjs "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" .probe `
  "@deepseek-ai/cordis" "@deepseek-ai/dsh-llm" "@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-system-prompt"
```

### 3.2 类型从哪来

运行时契约用手读，**编译期类型**用 npm 上同版本的声明文件：

```json
"devDependencies": {
  "@deepseek-ai/cordis": "4.0.4",
  "@deepseek-ai/dsh-attachment": "0.2.0-rc.2",
  "@deepseek-ai/dsh-llm": "0.2.0-rc.2",
  "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
  "@deepseek-ai/schemastery": "3.18.4",
  "typescript": "^5.7.2"
}
```

`@deepseek-ai/*` 一律放 `peerDependencies`（宿主提供），只在 `devDependencies` 里放一份用来
类型检查。这是 dsh 插件的通用姿态：**插件不携带运行时，只声明它要求宿主提供什么。**

```jsonc
"peerDependencies": {
  "@deepseek-ai/cordis": ">=4.0.0 <5",
  "@deepseek-ai/dsh-llm": ">=0.2.0-rc.2",
  "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2",
  "@deepseek-ai/schemastery": ">=3.18.0 <4"
}
```

### 3.3 构建

`tsconfig.json` 面向 NodeNext + ES2022，`src/` → `lib/`，同时出 `.d.ts`：

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc -p tsconfig.json
```

`package.json` 的入口必须指到产物，并声明这是一个 bundle：

```jsonc
"main": "lib/dsh/index.js",
"types": "lib/dsh/index.d.ts",
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

---

## 4. 第三步：架构定稿

```
                ┌───────────────────────── adapter.ts ─────────────────────────┐
图片 block ────►│ resolveModel → ['text','image']（放行）                       │
                │ stream()                                                     │
                │   ├─ 目标模型本来就支持图片？→ 原样转发，不调视觉引擎          │
                │   ├─ 请求里没有图片？→ 原样转发                               │
                │   └─ 否则 translate()：每个 image block → 一个 text block     │
                │         └─ attachments.readImageRequest() 取字节              │
                └───────────────┬──────────────────────────────────────────────┘
                                ▼
                      pipeline.ts（唯一转译入口，带缓存）
                         ├─ cache.ts   LRU：图片身份 + 引擎链身份
                         ├─ engines.ts primary：失败/超时/未配置 ↓
                         └─ engines.ts fallback
                                ▼
                      evidence.ts  formatEvidence()  ←── 工具 tool.ts 也走这里
                                ▼
        ctx.llm.stream({ provider: targetProvider })   ← 唯一受支持的委托入口
                                ▼
                       真实 DeepSeek 适配器（只看到文本）
```

**一条管线、两种表面**：路由改写和 `glyphbridge_read_image` 都调用同一个
`VisionPipeline.describe()`，都用 `formatEvidence()` 渲染。它们不可能长得不一样。

---

## 5. 第四步：逐模块实现

### 5.1 `config.ts` —— 配置即契约

schemastery 声明，加载器在 `apply()` 之前解析，所以这里的默认值就是用户什么都没写时看到的值：

```ts
export const Config = z.object({
  targetProvider: z.string().default('deepseek-official'),
  primary: Engine.default({ kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20_000 }),
  fallback: Engine.default({ kind: 'vlm', baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20_000 }),
  cache: z.object({ enabled: z.boolean().default(true), maxEntries: z.number().step(1).min(0).default(64) })
          .default({ enabled: true, maxEntries: 64 }),
  tool: z.object({ enabled: z.boolean().default(true), maxImageBytes: z.number().step(1).min(1).default(16 << 20) })
          .default({ enabled: true, maxImageBytes: 16 << 20 }),
})
```

要点：

- **两个引擎槽默认都是空的**。空槽 = 未配置，不是错误。新装上的插件只注册路由、不假装有视觉。
- `apiKeyEnv` 是**变量名**，不是密钥。配置里永远没有秘密。
- `kind` 只有两种取值：`vlm`（OpenAI 兼容 `/chat/completions`）和 `ocr`（自定义 OCR POST）。

### 5.2 `evidence.ts` —— 先定"证据"的形状

模型能看见的只有文本，所以证据的格式就是接口。三部分：

```ts
export interface Evidence {
  ocr: string                                // 全文（阅读顺序）
  regions: readonly EvidenceRegion[]         // 版面区域，带 bbox
  tables: readonly EvidenceTable[]           // 表格（markdown / html）
  engine: string                             // 真正产出它的引擎（slot:model）
  notes: readonly string[]                   // 降级、解析告警等
}
```

呈现只有一处实现，首行是模型和其它代码都能依赖的契约：

```
[图片 #1 | 引擎: primary:qwen-vl-max]
## OCR 全文
…
## 版面摘要
- [title] (10,8,180,24): 季度营收
## 表格 1 — 营收表
| 季度 | 营收 |
## 引擎备注
- 已降级：primary:dead-vlm 失败（HTTP 500）；本条由 fallback:backup-vlm 产出
```

空的部分不出现（没有表格就不产生空标题），首行的 `engine` **一定是真正出结果的那个槽**——
不能把 fallback 的产出标成 primary，模型的后续推理依赖于这个归属。

### 5.3 `engines.ts` —— 两种线上协议，一个归一化出口

- `vlm`：`POST <baseUrl>/chat/completions`，`image_url` 用 data URL，`temperature: 0`，
  提示词是"严格 JSON：`{ocr, layout[], tables[]}`"。
- `ocr`：`POST <baseUrl>`，body `{ image: base64, media_type, model }`。

两个细节值得写下来：

1. **非 JSON 也要能活**。VLM 没按格式回答时，把整段文本当 OCR 采纳并加一条 note，而不是让这一轮
   失败——用户要的是答案，不是格式洁癖。
2. **归一化要宽容**。`{ ocr | text | result.text }`、`{ layout | regions | lines }`、
   `{ tables | table }` 都认，字段名不同不至于让证据变空。容器既可以是数组也可以是**单个对象**；
   `bbox` 既可以是 `[x,y,w,h]` 也可以是 `{x,y,width,height}`；表格没声明 `format` 时，按正文来自
   `html` 还是 `markdown` 字段**推断**，而不是一律默认 markdown。
   （这三条宽容度是 0.2.1 检验时补上的，见 [`检验流程.md`](检验流程.md) 第 10 节。）

每次尝试有独立的超时，与请求取消信号合并：

```ts
const timeout = AbortSignal.timeout(engine.timeoutMs)
const signal = outer === undefined ? timeout : AbortSignal.any([outer, timeout])
```

**密钥怎么读**（0.3.0）。`apiKeyEnv` 只写变量名；解析按 DSH 自己的顺序来：先 `process.env`，
再 `ctx.credentials.resolve()` —— 后者本身叠加了环境变量、`$DSH_HOME/.credentials.yaml` 和
`.env`。这一条是必须的：应用把用户的 DeepSeek 密钥存在 `.credentials.yaml` 里，**进程环境里并没有**。
插件只读 `process.env` 的话，用户就得把同一个密钥再抄一份到环境变量，而且会得到
"environment variable … is empty" 这种看起来像配置错误、实际是读取路径不对的提示。

```ts
async function resolveSecret(ctx, name) {
  const fromEnvironment = envSecret(name)          // 环境变量优先
  if (fromEnvironment !== undefined) return fromEnvironment
  const hit = await ctx.get('credentials')?.resolve(name)   // 再问凭据 seam
  return hit?.value?.trim() || undefined
}
```

解析不到时，错误信息**点名凭据、不带值**，并且不会发出任何请求。

### 5.4 `pipeline.ts` —— 降级链

`primary` 失败/超时/未配置 → `fallback`；两者都失败 → 一段**显式的降级证据**（不是抛异常）：

```
[图片 #1 | 引擎: none]
## OCR 全文
(该引擎未返回可读文字)
## 引擎备注
- 所有视觉引擎均失败：primary:x → HTTP 500；fallback:y → 请求失败: timeout。
  图片内容无法转译，请勿猜测其中文字。
```

这一轮仍然要给出回答，模型必须知道自己**没有**看到图，因此不能编。三个不变量：

- 成功于 fallback 时，前面所有失败都进 `notes`，首行写 fallback。
- 完全重复的槽位会被去重（同一个 endpoint+model+key 不会试两遍）。
- 管线永不抛"引擎失败"，只可能被 `signal` 的取消打断。

### 5.5 `cache.ts` —— 会话回放导致的核心开销（v0.2.0 优化）

**问题**：每一轮对话，agent 都会把**完整历史**重新送给模型。伴生路由为了放行图片，历史里的
image block 会原样重现——于是同一张截图在每一轮都会被再送去转译一次。一个 20 轮的对话就是
20 次 VLM 调用，全是重复劳动（还叠加延迟与费用）。

**做法**：`EvidenceCache`，三条规则：

| 规则 | 原因 |
|---|---|
| 键 = 引擎链身份 + 图片身份 | 改了 `primary/fallback` 必然换键，不会拿到旧引擎的文本 |
| 图片身份优先用 `attachmentId`，否则用字节的 sha256 | attachment 是内容寻址的，键可以在**读字节之前**算出来 → 命中时连解码都省了；文件路径可能变，退回内容摘要 |
| 只缓存真正有内容的记录 | "所有引擎都失败"是**这一次**的事实，缓存它等于把一次故障永久写进后续每一轮 |

另外两条工程细节：

- **同键在途合并**：同一请求里出现两张相同的图，只产生一次引擎调用，两个 block 共享结果。
- **有界 LRU**：`maxEntries`（默认 64）满了淘汰最久未用的一条，命中会刷新顺序。

对外只暴露一个方法：

```ts
async remember(key, produce): Promise<{ evidence, cached }>   // 同一 key 至多跑一次
```

管线把它包在 `describe()` 里，于是**路由改写和工具自动共享同一份缓存**。

### 5.6 `adapter.ts` —— 孪生适配器

**(1) 能力镜像**：`image` 叠加在目标路由声明的能力上。

```ts
function withImage(modalities) {
  const base = modalities === undefined ? ['text'] : [...modalities]
  return base.includes('image') ? base : [...base, 'image']
}
```

`listModels()` 把目标路由的模型目录整体镜像过来（GUI 选择器里就会出现这些模型）；
`resolveModel()` 镜像单个模型的上下文窗口、默认 maxTokens、reasoning 等元数据。目标路由还没挂载时
返回空目录而不是抛错——**不要用一个假的能力错误盖住真问题**。

**(2) 原样转发优先**（"原生视觉退让"）：转译前先看目标模型的 `inputModalities`，如果它本来就
吃图片，直接转发，一次 VLM 调用都不发。将来 DeepSeek 出多模态模型，这个插件自动退化成透明代理。

但这带来一个反直觉的结果：**DeepSeek 现在（2026）本身就是多模态**，所以在 `auto` 模式下切到
`glyphbridge` 路由，图片仍然原样送达模型，插件什么也不做。这不是 bug，是"只在需要时介入"的代价。
想要"图片一律先变证据、再交给模型"，用 0.4.0 的开关：

```yaml
translate: always    # auto（默认）= 目标能看图就退让；always = 一律转译
```

`always` 的价值在于证据本身：可缓存（回放不重转译）、可引用（模型能逐字引用表格）、可审计
（会话里留下的是文本）。

**(3) 请求改写保身份**：只换 `content` 里的 image block，`role`、消息顺序、其它 block 一律不动。
图片编号按消息顺序（不是完成顺序），同一请求内最多 3 张并发转译：

```ts
await mapConcurrent(jobs, TRANSLATION_CONCURRENCY, async (job) => {
  const text = await this.describeBlock(job.ref, job.index, job.offloaded, signal)
  job.content[job.slot] = { type: 'text', text }
})
```

**(4) 委托**：不自己发 HTTP，交给运行时唯一的受支持入口。

```ts
ctx.llm.stream({ ...options, provider: this.targetProvider, messages, toolHistory: undefined })
```

- 认证、重试、归因头、线格式全部留在为它而写的适配器里。
- `toolHistory` 必须清空：进来的请求里已经由运行时投影过 developer 消息，再传一次会被追加两遍。

**(5) 不把失败变成空回合**：单张图失败 → 该 block 变成"读取失败，请勿猜测"的文本；
请求取消 → 产出 `aborted` 结束块；其它异常 → `finish{kind:'error'}`，而不是让流挂死。

### 5.7 `tool.ts` —— 兜底

`glyphbridge_read_image({ path | url })`：

- 图片从没进过会话时（模型被告知了一个路径、文档里有个 URL、想重跑一次转译）用它。
- 复用同一条管线和同一份缓存，输出与路由内联产生的**完全同一个证据块**。
- `sniffMediaType()` 同时看魔数和 Content-Type，只放行 PNG/JPEG/WebP/GIF。
- 读盘走 `fs.resolve()` + `fs.readBytes(target, signal, maxBytes)`，不自己拼接路径。

### 5.8 `index.ts` —— 入口

```ts
export const name = 'glyphbridge'
export const inject = ['tools', 'llm']       // 硬依赖：没有这两样，这个插件无事可做
export const PROVIDER = 'glyphbridge'

export function apply(ctx, config) {
  if (config.targetProvider.trim() === PROVIDER)
    throw new Error('targetProvider 不能是伴生路由自身，否则委托形成自环')
  const pipeline = new VisionPipeline(ctx, config)
  ctx.llm.registerAdapter([PROVIDER], new GlyphBridgeAdapter({ ctx, config, pipeline }))
  if (config.tool.enabled) registerReadImageTool(ctx, { pipeline, config })
}
```

所有注册都是这条插件纤维的**可逆副作用**：卸载即撤掉路由和工具，纯文本路由立刻回到原来的行为。

### 5.9 `cordis.patch.yml` —— 补丁层

```yaml
- insert:
    - id: glyphbridge
      name: dsh-glyphbridge
      config:
        targetProvider: deepseek-official
        primary: { kind: vlm, baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20000 }
        fallback: { kind: vlm, baseUrl: '', model: '', apiKeyEnv: '', timeoutMs: 20000 }
        cache:    { enabled: true, maxEntries: 64 }
        tool:     { enabled: true, maxImageBytes: 16777216 }
```

两个必须记住的补丁语义：

- **新条目必须 `insert`**。裸 `- id: x / name: y` 只能覆盖**已存在**的条目，否则报
  `patch: entry "x" not found`（且常常只是静默 warn 后继续，很坑）。
- **条目不做深合并**。后续任何一层只要命中 `id: glyphbridge`，它的 `config` 就是**整体替换**。
  想改一个字段，要么整块搬过去，要么别碰。

---

## 6. 第五步：构建与类型检查

```bash
npm run typecheck   # 0 error
npm run build       # lib/dsh/*.js + *.d.ts
```

`lib/` 是插件真正被加载的东西，源码改了不重新构建等于没改。

---

## 7. 第六步：验证（三级）

### 7.1 准入层

`probe1-admission.mjs`：纯文本路由被拒、声明 `image` 的路由放行、占位符投影只落在文本路由上。

### 7.2 集成层（最重要）

`probe2-integration.mjs` 在**真实的** `LlmRuntime` / `ToolRuntime` / `system-prompt` 上挂载编译产物，
配一个本地 mock VLM 服务器和一个 mock 目标适配器，然后看**目标适配器到底收到了什么**：

| 场景 | 断言 | 结果 |
|---|---|---|
| A 纯文本目标 + 截图 | 转发给目标的 block 里 `image == 0`，文本是证据块 | ✅ |
| B primary 返回 HTTP 500 | 由 fallback 产出，`## 引擎备注` 记录降级 | ✅ |
| C primary 超时 | 由 fallback 产出 | ✅ |
| D 目标本身支持图片 | 原样转发，VLM 调用数 **0** | ✅ |
| E 没配任何引擎 | 显式降级块，不抛错、不编内容 | ✅ |
| G 同一张图第二轮 | 第二轮引擎调用 **0** 次，证据逐字一致 | ✅ |
| H 一次请求里同一张图出现两次 | 引擎调用 **1** 次，两个 block 都正确编号 | ✅ |
| F 工具 | `glyphbridge_read_image` 产出同一个证据块 | ✅ |

这就是"直接安装前先跑通"的门槛。**探针必须从 `.probe/` 目录里跑**：它用
`pathToFileURL('./node_modules/...')` 相对 `process.cwd()` 解析那份冻结的插件副本，这样插件和
运行时共享同一棵模块树（否则 `LlmAdapter` 的两份拷贝会让 `instanceof` 语义失真）。

### 7.3 安装后

装完的真实证据：本会话中 `glyphbridge_read_image` 的工具 schema **当场出现在工具列表里**
（`apply()` 里 `registerAdapter` 在工具注册之前执行，所以工具出现 ⟹ 路由也注册成功）——
说明 profile 被热重组、插件已在真实 GUI 里跑起来，不需要重启。

刷新快照的那次 `remove` + `add` 之后同样如此。判断"插件在不在"的三个入口，从强到弱：

1. 工具列表里有没有 `glyphbridge_read_image`；
2. 模型选择器里有没有 `GlyphBridge · …` 这一组镜像模型（`listModels()` 的产物）；
3. 启动输出里有没有 `伴生路由 "glyphbridge" 已注册，委托至 "deepseek-official"`。

前两条都看不到时，重启一次应用即可排除"重组期间换了包"的偶发情况。

---

## 8. 第七步：安装

### 8.1 命令

```powershell
# 当前 GUI 使用的 profile（Electron 应用独占，只能在 shell 里装）
dsh plugin --profile desktop add "file:C:/path/to/dsh-glyphbridge"

# 命令行 web profile 同理
dsh plugin --profile web add "file:C:/path/to/dsh-glyphbridge"
```

实际输出（节选）：

```
dependencies:
+ dsh-glyphbridge file:C:/path/to/dsh-glyphbridge
Done in 473ms using pnpm v11.7.0
```

### 8.2 它改了什么

`~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-glyphbridge": "file:C:/path/to/dsh-glyphbridge",
    "dshmarket": "^1.73.5"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket", "dsh-glyphbridge"
  ] } }
}
```

两件事缺一不可：

1. `dependencies` 里有这个包（文件要能被解析到）；
2. `dsh.profile.bundles` 里被**选中**（它的 `cordis.patch.yml` 才会作为补丁层参与组合）。

`dsh plugin add` 与 `dsh plugin remove` 都会同步维护 `bundles`（移除时把条目一起摘掉，重新 `add` 时
自动追加到末尾）。手工改 `package.json` 时这两处必须自己对齐，否则要么装了不生效、要么启动时
`skipping profile bundle`。

**装进去的是一份快照，不是链接。** pnpm 把目录里 `files` 声明的文件（`lib/`、`cordis.patch.yml`、
`package.json`、`README.md`）复制进 `node_modules/dsh-glyphbridge`。因此：

> 改完工作区源码并 `npm run build` 之后，**必须重装一次**才会生效。实测 `pnpm install --force`
> 与 `pnpm add` 都会认为 `file:` 依赖"已经是最新"而拒绝刷新，只有移除再装才行：
>
> ```powershell
> dsh plugin --profile desktop remove dsh-glyphbridge
> dsh plugin --profile desktop add "file:C:/path/to/dsh-glyphbridge"
> ```
>
> 验证快照是否真的更新：`Select-String` 一下
> `node_modules/dsh-glyphbridge/package.json` 的 `version`，或比对 `lib/dsh/index.js` 的哈希。

### 8.3 装到哪个 profile

| profile | 谁在用 | 能否 dump 组合结果 |
|---|---|---|
| `desktop` | 桌面应用（当前 GUI @ `127.0.0.1:19387`） | ❌ `dsh --profile desktop --dump-config` 被拒：该 profile 由 Electron 独占 |
| `web` | `dsh web` 命令行 | ✅ 可 dump |

同一个插件可以同时装进多个 profile：每个 profile 有自己的 `node_modules` 与组合结果。

### 8.4 启用视觉引擎

新装的插件**两个引擎槽都是空的**：路由在、准入放行、但转译时会明确告诉你"没有配置可用的视觉引擎"。
这是有意的——宁可不看，也不假装看见。

配置写进 profile 的 `cordis.patch.yml`（整块覆盖 `config`）：

```yaml
- id: glyphbridge
  name: dsh-glyphbridge
  config:
    targetProvider: deepseek-official
    translate: always                        # auto = 目标能看图就退让；always = 一律转译
    primary:
      kind: vlm
      baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1   # 任意 OpenAI 兼容端点
      model: qwen-vl-max
      apiKeyEnv: GLYPHBRIDGE_VLM_KEY        # 只写变量名
      timeoutMs: 20000
    fallback:
      kind: ocr
      baseUrl: http://127.0.0.1:8866/ocr    # 自建 PaddleOCR / RapidOCR 服务
      model: pp-ocr-v4
      apiKeyEnv: ''
      timeoutMs: 20000
    cache: { enabled: true, maxEntries: 64 }
    tool:  { enabled: true, maxImageBytes: 16777216 }
```

密钥只进环境变量或凭据 seam（`GLYPHBRIDGE_VLM_KEY=sk-...` 或 `.credentials.yaml`），永远不进配置文件、
不进日志。

> **DeepSeek 自己就能当视觉引擎**（实测，2026-10-31）：`api.deepseek.com` 接受 `image_url` 块，
> `deepseek-flash` 能准确描述照片、能读出表格结构。所以最省事的配置是直接用它，不需要额外申请
> 视觉服务：
>
> ```yaml
> primary:
>   kind: vlm
>   baseUrl: https://api.deepseek.com
>   model: deepseek-flash
>   apiKeyEnv: DEEPSEEK_API_KEY     # 应用已经存在 .credentials.yaml 里，插件会自己解析
>   timeoutMs: 60000                # 推理型模型读一张图约 20–30 秒，别沿用 20 秒
> ```
>
> 代价：它仍然是一个**推理模型**，一次转译要 20–30 秒；OCR 不是 100% 准确（测试里把 `265`
> 读成了 `285`），所以证据是"转写"而不是"事实"。要更快/更准就换成专用 OCR 服务。


**改完配置要等 10–15 秒**。profile 补丁层是被热加载的，但实测有十秒量级延迟，改完立刻发图仍然是
旧配置。判断生效没有的最快方式：对一张图调用一次 `glyphbridge_read_image`，看返回的是

- `没有配置可用的视觉引擎（…均为空）` → 旧配置；
- `[图片 #1 | 引擎: primary:<你的模型>] …` → 新配置已生效（哪怕引擎连不上，也会给出带
  `## 引擎备注` 的降级证据块，而不是抛异常）。

这正是检验里做过的实证：临时把 `primary.baseUrl` 指到 `http://127.0.0.1:9/v1`，等待后工具返回
`所有视觉引擎均失败：… 请求失败: fetch failed。图片内容无法转译，请勿猜测其中文字。`，
改回空值后又恢复原状。详见 [`检验流程.md`](检验流程.md) 第 8.3 节。

---

## 9. 踩过的坑（都是这次真实遇到的）

| 现象 | 原因 | 处理 |
|---|---|---|
| `EPERM: open ...\profiles\desktop\package.json.lock` | DSH 文件沙箱是 `workspace-write`，`~/.dsh` 在工作区外 | 安装命令需要 `danger-full-access` 一次性授权 |
| 改完 `cordis.patch.yml` 立刻发图，行为没变 | profile 补丁层热加载有 10–15 秒延迟 | 等十几秒再试；用工具的返回形态判断是否已生效（见 8.4） |
| `patch: entry "glyphbridge" not found` | 补丁层用了裸 `- id:` 行去声明**新**条目 | 改成 `- insert: [...]` |
| 改了 `cordis.patch.yml` 里一个字段，别的字段全丢 | 条目 `config` 是整体替换、不深合并 | 整块复制过去再改 |
| 配置里写了 API key | 设计上只允许变量名 | 用 `apiKeyEnv` + 环境变量 |
| `dsh --profile desktop --dump-config` 报 "managed exclusively by the Electron application" | 桌面 profile 由应用独占 | 用 `dsh plugin --profile desktop ...` 做包管理；组合结果只能靠实际挂载观察 |
| 探针 `ERR_MODULE_NOT_FOUND ...\node_modules\dsh-glyphbridge` | `pathToFileURL('./node_modules/...')` 相对 `cwd` 解析 | 在 `.probe/` 目录里运行 |
| 探针里 `config.cache` 为 `undefined` 崩掉 | 探针用 `ctx.plugin()` 直接挂载，**不会**走 schemastery 默认值 | 探针里显式传完整 config；真实加载器会自动补默认值 |
| `pnpm add` 输出 `Packages: +2 -13` | pnpm 顺手清理了 profile 里不在 manifest 上的孤儿包 | 正常行为；被清掉的 `dsh-plugin-autoevo` 本来就不在依赖里 |
| 改了源码、重新 build，线上行为却没变 | `file:` 依赖被 pnpm 复制成**快照**，`install --force` 也不刷新 | `remove` 再 `add`（见 8.2） |
| 重装插件后行为**仍然**没变 | 插件管理器文档写明：**替换包要重启进程**才能加载新的 JS 模块，热加载只重跑配置、模块被缓存 | 换版本后重启应用；只想换配置不用重启 |
| 插件报 `environment variable DEEPSEEK_API_KEY is empty`，但应用明明有 key | 密钥存在 `$DSH_HOME/.credentials.yaml`，由 `ctx.credentials` 供给，**`process.env` 里没有** | 0.3.0 起按 `process.env` → `ctx.credentials.resolve()` 解析，应用存过的 key 直接用 |
| 包里有没有第二份 `@deepseek-ai/dsh-llm`？ | 运行时是**双锚点解析**：bundle 名先在本体安装（`app.asar`）里找，再找 profile 目录；`node_modules` 里的 pnpm 包优先。宿主会把安装自带的包供给 Node 的 ESM/CJS 解析器 | 所以运行时只有**一份** `dsh-llm`，没有双拷贝问题；反过来说，插件**不能**依赖自己的 `node_modules`——peer 依赖必须由宿主提供，真正的第三方依赖要写进 `dependencies`（本插件运行时零第三方依赖） |

---

## 10. 这一版做了什么优化（0.1.0 → 0.3.0）

| 优化 | 收益 |
|---|---|
| **证据缓存**（`cache.ts`） | 会话回放不再重复转译：第 N 轮对历史图片的引擎调用降为 0（探针 G） |
| 缓存键含**引擎链身份** | 改配置不会命中旧引擎的证据，杜绝"张冠李戴" |
| 命中时**不读附件字节** | 省掉一次解码/缩放，而不只是省一次网络往返 |
| **只缓存有效结果** | 引擎恢复后下一轮会重试，故障不会被永久固化 |
| 同键**在途合并** | 一次请求里重复的图只花一次引擎调用（探针 H） |
| 多图**并发转译**（≤3） | 拼图/多图轮次的等待从"求和"变成"取最大"，且不炸端点 |
| 缓存**有界 LRU** | 长会话不会无限吃内存 |
| `targetProvider === 'glyphbridge'` 启动即拒 | 自环配置在 `apply()` 就暴露，而不是等第一次请求才炸 |
| 小型清理 | `asBbox` 重复调用、digest 重复计算、`ReturnType<getter>` 类型误用 |
| **0.2.1 修缺陷**（检验中发现） | 表格 `format` 改为从正文来源推断；`table`/`lines` 接受单对象；`bbox` 接受 `{x,y,width,height}`。详见 [`检验流程.md`](检验流程.md) 第 10 节 |
| **0.3.0 凭据 seam** | `apiKeyEnv` 改为 `process.env` → `ctx.credentials.resolve()` 两级解析。应用已存在 `.credentials.yaml` 里的 DeepSeek key 直接可用，不需要再抄一份到环境变量。错误信息由"环境变量为空"改为"凭据 X 未配置"，并禁止发出未鉴权的请求 |

---

## 11. 已知取舍与后续方向

| 取舍 | 说明 |
|---|---|
| 证据文本不在会话日志里 | 运行时的不变式是"模型可见 ⟺ 已落日志"。VLM 转写结果无法从日志重建，所以它是**仅请求期**的投影。彻底解法是由会话归属的包写一条 `image/describe` 事件、投影时读回——provider 侧插件做不到 |
| 不做任何 token 优化 | 按要求不截断/不摘要。唯一的上限是读取字节数和缓存条数 |
| 缓存是进程内的 | 重启丢失；两个进程各转译各自的 |
| 引擎精度决定证据质量 | 用 DeepSeek 当视觉引擎时，OCR 会偶发读错单个数字（`265`→`285`），且一张报表图约 24 秒。证据是"转写"，不是"事实" |
| 版本绑定 | 依赖的是 `0.2.0-rc.2` 的能力契约；升级 dsh 后要重跑 `.probe/probe2-integration.mjs` 与 `probe4-credentials.mjs` |

后续可做：会话级持久化证据（把转译结果写进 session 事件的 `image/describe`）、按图片类型选择引擎
（截图 → OCR，图表 → VLM）、把引擎配额/重试策略提升到配置层。

---

## 12. 一页速查

```powershell
# 构建
npm run typecheck; npm run build

# 验证（先解包依赖闭包，见 .probe/README.md）
cd .probe; node probe2-integration.mjs

# 安装（首次）
dsh plugin --profile desktop add "file:C:/path/to/dsh-glyphbridge"

# 重装（改了源码或版本之后：pnpm 不会刷新 file: 快照，必须移除再装）
dsh plugin --profile desktop remove dsh-glyphbridge
dsh plugin --profile desktop add "file:C:/path/to/dsh-glyphbridge"

# 看装了什么
dsh plugin --profile desktop list --depth 0

# 启用视觉：编辑 ~/.dsh/profiles/desktop/cordis.patch.yml，给 id: glyphbridge 填 primary.baseUrl/model/apiKeyEnv
```

装好后的行为，一句话总结：

> **图片能进来了；有引擎就转成证据，没引擎就明说看不见，永远不让模型猜。**
