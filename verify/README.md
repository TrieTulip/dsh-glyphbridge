# Re-runnable checks

Three dependency-free scripts. They import the built plugin from `../lib/`, so run them
**after `npm run build`**, from the repository root:

```bash
node verify/cache-and-guards.mjs
node verify/engines.mjs
```

| Script | What it checks | Cost |
|---|---|---|
| `cache-and-guards.mjs` | the evidence memo's four rules (LRU recency, hard cap, in-flight coalescing, degraded records never cached, disabled = always produce) and the two entry guards (self-delegation, empty `targetProvider`) | local, instant |
| `engines.mjs` | both wire protocols (`vlm` / `ocr`), the field-name tolerance, the failure taxonomy (HTTP status, timeout, missing credential, cancellation), and that a credential resolved from the seam reaches the `Authorization` header | local mock HTTP server, instant |
| `deepseek-image-probe.mjs` | sends one image to a real OpenAI-compatible endpoint and prints the raw answer, **without** involving the plugin. Useful to answer "can this endpoint see images at all?" | one real API call |

The third one needs a credential in the environment; it reads the key from
`$DEEPSEEK_API_KEY` (or the value you pass) and never prints it:

```bash
# the harness stores keys in $DSH_HOME/.credentials.yaml, not in the shell environment
export DEEPSEEK_API_KEY=$(sed -n 's/^  DEEPSEEK_API_KEY: //p' "$DSH_HOME/.credentials.yaml")
node verify/deepseek-image-probe.mjs verify/sample-text.png "这张图里写了什么？"
```

`sample-text.png` is a 900×420 report image rendered with Pillow (title, a five-row table,
a footer), used by the engine checks and by `.probe/probe4-credentials.mjs`.
`not-an-image.txt` is the negative fixture for media-type sniffing.

For the end-to-end checks against the *shipped* runtime (`app.asar`), see
[`../.probe/README.md`](../.probe/README.md).
