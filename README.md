# GlyphBridge

A vision bridge for **pure-text DeepSeek models** in the DeepSeek Harness (dsh).

GlyphBridge registers a **companion provider route** (`glyphbridge`) — a "visual twin" of an
existing text route. The twin advertises `inputModalities: ['text', 'image']`, so images are
admitted and reach it intact; it then transcribes each image into a compact text evidence block
and delegates the request to the real DeepSeek adapter, which never sees an image. A
`glyphbridge_read_image` tool covers the paths an image never enters through.

```
                        admission gate            dispatch
user pastes image ────────────────────► twin route ──────────────► evidence text ──► real adapter
                    reads inputModalities   glyphbridge              (OCR/layout/tables)   deepseek-*
```

Translations are memoized: a conversation is replayed whole on every turn, so without a memo the
same screenshot would reach the vision engine once per turn. See [Behaviour](#behaviour).

**New here?** Start with [使用说明.md](使用说明.md) — install, configure, use, FAQ.

The design rationale, the runtime facts it rests on, and the step-by-step build are in
[GlyphBridge 制作流程.md](<GlyphBridge 制作流程.md>). How it is proven — layers, assertions,
and the defect the suite caught — is in [检验流程.md](检验流程.md); the two re-runnable check
scripts live in `verify/`. Shipping it to other people (GitHub / npm / plugin market / offline
tarball) is covered in [发布指南.md](发布指南.md).

## Why a companion route, and not a hook

dsh rejects an image **before any plugin hook runs**. In
`@deepseek-ai/dsh-api-session-controller` `prompt()`:

```js
const current = this.agents.selectionFor(agent).current
const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
  throw new RemoteError('session/attachment-invalid', `Model "..." does not support image input.`,
    { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
}
```

The verdict is computed from `ctx.llm.resolveModelInfo()`, and the same fact is used again at
dispatch time to replace images with placeholders (`projectImagesForTextModel`). A provider route
whose adapter answers `resolveModel()` with `image` in `inputModalities` therefore passes both
gates — that is the entire mechanism GlyphBridge is built on. Verified on 0.2.0-rc.2; see
[Verification](#verification).

## Layout

| Path | Role |
|---|---|
| `src/dsh/index.ts` | plugin entry — `{ name, inject, apply }`, `inject = ['tools', 'llm']` |
| `src/dsh/config.ts` | schemastery `Config`: target route, two engine slots, memo, tool switch |
| `src/dsh/adapter.ts` | the twin adapter: capability mirroring, delegation, request rewrite |
| `src/dsh/pipeline.ts` | translation pipeline with the primary → fallback chain |
| `src/dsh/cache.ts` | bounded LRU memo keyed by image identity + engine-chain identity |
| `src/dsh/engines.ts` | OpenAI-compatible VLM client and generic OCR client |
| `src/dsh/evidence.ts` | evidence vocabulary and its single textual presentation |
| `src/dsh/tool.ts` | `glyphbridge_read_image` (path or URL), reusing the pipeline |
| `cordis.patch.yml` | the bundle layer that declares the entry and its defaults |

## Install

```bash
npm install        # or pnpm install
npm run build
```

Then register the package in a profile. The profile's package manager owns `dependencies`;
`dsh.profile.bundles` names the bundle that contributes the patch layer:

```bash
# installs the dependency and selects the bundle
dsh plugin --profile web add file:C:/path/to/dsh-glyphbridge
```

The Electron app owns the `desktop` profile, so it is installed the same way but only from a
shell (`dsh --profile desktop --dump-config` is refused for that profile):

```bash
dsh plugin --profile desktop add file:C:/path/to/dsh-glyphbridge
```

The command writes `dependencies` **and** appends the bundle to `dsh.profile.bundles`. A running
profile recomposes live (the plugin's tool and route appear without a restart); a startup-only
profile needs one.

The installed package is a **snapshot copy**, not a link — pnpm copies the `files` list into the
profile's `node_modules`, and neither `pnpm install --force` nor a repeat `add` refreshes it. After
rebuilding the plugin, reinstall it:

```bash
dsh plugin --profile desktop remove dsh-glyphbridge
dsh plugin --profile desktop add file:C:/path/to/dsh-glyphbridge
```

The bundle's `cordis.patch.yml` declares the entry with `insert` — a bare `id:` row can only
override an entry that already exists, so a bundle that introduces an entry must insert it.

## Configuration

Entries are **not deep-merged**: a later layer targeting `id: glyphbridge` replaces `config`
wholesale. No credential is ever written into configuration — `apiKeyEnv` names a variable, resolved
through the process environment and then the harness credential store.

```yaml
- id: glyphbridge
  name: dsh-glyphbridge
  config:
    targetProvider: deepseek-official      # or deepseek-account
    translate: auto                        # auto = defer to a target that sees images; always = translate anyway
    primary:
      kind: vlm                            # vlm = OpenAI-compatible /chat/completions
      baseUrl: https://api.example.com/v1  # empty baseUrl or model disables the slot
      model: qwen-vl-max
      apiKeyEnv: GLYPHBRIDGE_VLM_KEY       # variable NAME, never the key
      timeoutMs: 20000
    fallback:
      kind: ocr                            # ocr = POST { image, media_type, model }
      baseUrl: https://ocr.example.com/ocr
      model: pp-ocr-v4
      apiKeyEnv: GLYPHBRIDGE_OCR_KEY
      timeoutMs: 20000
    cache:
      enabled: true
      maxEntries: 64
    tool:
      enabled: true
      maxImageBytes: 16777216
```

`translate` decides what happens when the *target* model can see images itself:

| value | behaviour |
|---|---|
| `auto` (default) | native-vision back-off — the request is forwarded untouched, no engine call |
| `always` | translate anyway; the model receives structured evidence instead of pixels, even though it could have read the image |

A fresh install ships **both engine slots empty**: the route registers, admits images, and answers
them with an explicit "no engine configured" block instead of pretending to have vision. Fill in
`baseUrl` + `model` (+ `apiKeyEnv` when the endpoint needs a bearer token) to turn translation on.

### Engine contracts

`vlm` — `POST <baseUrl>/chat/completions` with an `image_url` data URL and a strict-JSON prompt;
the answer is parsed as `{ ocr, layout: [{ text, type, bbox }], tables: [{ title, format, body }] }`.
A non-JSON answer is accepted as plain OCR text with a note rather than failing the turn.

`ocr` — `POST <baseUrl>` with `{ image, media_type, model }`; the answer is normalized from
`{ ocr | text | result.text, layout | regions | lines, tables | table }`.

`apiKeyEnv` names a variable, never a value, and the name is resolved the way the rest of the
harness resolves it: the process environment first, then `ctx.credentials` — which layers the
environment, `$DSH_HOME/.credentials.yaml`, and `.env` files. A key the app already stores for its
own DeepSeek adapter therefore reaches this engine too, with no second copy of the secret.

DeepSeek's own endpoint accepts `image_url` blocks (verified here on `deepseek-flash`), so
`baseUrl: https://api.deepseek.com` with `model: deepseek-flash` is a working primary engine — the
bridge then transcribes the image with DeepSeek itself. Its OCR is good but not perfect: on the
test report it read `265` as `285`, so evidence is a *transcript*, not ground truth.

## Behaviour

1. **Admission.** The route reports `['text', 'image']` for every model it mirrors, so the
   admission gate admits images and the dispatch layer does not substitute placeholders.
2. **Native vision back-off** (`translate: auto`). Before translating, the adapter reads the *target*
   model's `inputModalities`. If the target already accepts images, the request is forwarded untouched
   and no engine call is made. `translate: always` opts out of this deference and translates anyway.
3. **Translation.** Each image block becomes one text block:
   ```
   [图片 #1 | 引擎: primary:qwen-vl-max]
   ## OCR 全文
   …
   ## 版面摘要
   - [title] (10,8,180,24): 季度营收
   ## 表格 1 — 营收表
   | 季度 | 营收 |
   ```
   The header names the slot that actually answered. Message identity is preserved; only content
   changes. Numbering follows message order, and images within one request are translated
   concurrently (up to 3) so a collage does not serialize its engine round trips.
4. **Fallback.** An unconfigured, failing, or timing-out primary falls through to the backup, and
   the failure is recorded in `## 引擎备注`. When every engine fails, the block says so
   explicitly instead of failing the turn — the model must answer, and must not invent contents.
5. **Memo.** Evidence is memoized per image identity + engine-chain identity, so a replayed
   conversation transcribes each screenshot once instead of once per turn; editing the engine
   slots changes the key, so stale text can never be served. A duplicate image inside one request
   is produced once and shared. Degraded records ("no engine answered") are deliberately **not**
   cached, so a recovered engine is retried on the next turn. A hit costs no attachment decode
   either: the identity is known before the bytes are read.
6. **Delegation.** The request is handed to `ctx.llm.stream({ provider: <target> })` — the
   harness's only supported path to an adapter — so authentication, retries, attribution headers,
   and wire format stay with the adapter built for them. `toolHistory` is cleared because the
   incoming request already carries the projected developer messages.

## Known deviations

- **Evidence text is not in the session log.** The harness invariant is "model-visible ⟺ logged".
  A VLM transcript cannot be derived from the log, so the rewrite is a request-only projection,
  unlike the deterministic placeholder projections the runtime performs itself. A fully invariant
  version would record an `image/describe` session event from a session-owning package and let the
  projection read it back; that is out of scope for a provider-side plugin.
- **No token-saving logic.** Nothing here truncates, summarizes, compresses, or budgets evidence;
  the full transcript is forwarded. The only caps are safety limits on read bytes and the memo's
  entry count.
- **The memo is process-local.** It does not survive a restart, and two processes transcribe
  independently.

## Verification

Probes live in `.probe/` (see [`.probe/README.md`](.probe/README.md)); they import the *shipped*
`@deepseek-ai/*` packages out of the desktop `app.asar`, so they run on the same runtime the
application runs.

| Probe | Result |
|---|---|
| `probe1-admission.mjs` | a text route is refused by the copied admission predicate; a route advertising `image` is admitted; placeholder projection hits only text routes |
| `probe2-integration.mjs` | A translation · B fallback on HTTP 500 · C fallback on timeout · D native-vision pass-through (0 VLM calls) · E degraded block · G second turn costs 0 engine calls · H duplicate image costs 1 engine call · F the tool |
| `probe3-delegation.mjs` | incomplete: the extraction does not include the account stack's third-party deps |
| `probe4-credentials.mjs` | the credential seam end to end: a faithful `ctx.credentials` service, the real DeepSeek endpoint, a real text image — the target adapter receives 0 image blocks and a full evidence block (OCR + layout + Markdown table); the second turn is a memo hit |

`verify/` holds two dependency-free checks that run straight against `lib/`:

```bash
node verify/cache-and-guards.mjs   # memo LRU / coalescing / degraded-not-cached, entry guards
node verify/engines.mjs            # vlm + ocr protocols, field tolerance, failure taxonomy
```

Both suites found a real defect in the OCR normalization (0.2.0): an undeclared `format` was always
labelled `markdown`, and a single-object `table`/`lines` or an object `bbox` was dropped. Fixed in
0.2.1 — the full record, with commands and outputs, is in [`检验流程.md`](检验流程.md).

## Requirements

- dsh `0.2.0-rc.2` (the capability contract this is built on is version-specific)
- a reachable OpenAI-compatible VLM endpoint or an OCR endpoint; the route works without one but
  cannot see
