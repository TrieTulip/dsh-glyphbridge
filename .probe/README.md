# Verification scratch area

These are the probes used to verify GlyphBridge against the installed DeepSeek Harness
(`0.2.0-rc.2` desktop payload), not part of the plugin. Safe to delete.

The probes import the shipped `@deepseek-ai/*` packages by extracting them out of the
harness's `app.asar`, so they need that extraction first. Only the closure of the packages the
probes actually mount is extracted (33 packages, ~9 MB) instead of the whole shipped tree
(~236 MB):

```powershell
# one-time: extract the runtime closure next to the probes
node asar-extract-closure.cjs "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" . `
  "@deepseek-ai/cordis" "@deepseek-ai/dsh-llm" "@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-system-prompt"

# and a frozen copy of the built plugin that resolves against that same tree
mkdir node_modules/dsh-glyphbridge
cp -r ../lib node_modules/dsh-glyphbridge/lib
cp ../package.json ../cordis.patch.yml node_modules/dsh-glyphbridge/
```

Run the probes **from this directory** — they resolve the frozen copy through `process.cwd()`,
so the plugin and the runtime share one module tree:

```powershell
cd .probe
node probe2-integration.mjs
```

| File | What it proves |
|---|---|
| `probe1-admission.mjs` | the `MODEL_DOES_NOT_SUPPORT_IMAGES` predicate on the real `LlmRuntime`: a text route is rejected, a route advertising `image` is admitted, and dispatch-time placeholder projection only hits text routes |
| `probe2-integration.mjs` | the compiled plugin on the real `LlmRuntime`/`ToolRuntime` with a mock VLM server: translation (A), fallback on HTTP failure (B) and timeout (C), native-vision pass-through (D), degraded block (E), memo across turns (G) and within one request (H), and the tool (F) |
| `probe3-delegation.mjs` | attempted real-adapter delegation through the shipped account stack; requires third-party deps (`chokidar`, …) that this extraction does not include |
| `probe4-credentials.mjs` | the credential seam end to end: mounts a `credentials` service shaped like `dsh-credentials-local` (value read from `$DSH_HOME/.credentials.yaml`), points the primary engine at the real `https://api.deepseek.com`, and prints the evidence the target adapter received for `../verify/sample-text.png`. Costs one real API call (~17–25 s) |

> `dsh web` boot transcripts are not committed: each one printed a live session token
> (`?token=…`) for the local web UI.

`asar-ls.cjs`, `asar-cat.cjs`, `asar-extract.cjs` and `asar-extract-closure.cjs` are
dependency-free readers for Electron `asar` archives — `cat` and `ls` are for reading the
runtime's own source while designing against it, which is the only way to see the contracts of
a packaged-only harness.
