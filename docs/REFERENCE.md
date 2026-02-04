# webhook-replay

Replays webhook deliveries against a handler to simulate retries,
concurrency, and reordering — and to detect **duplicate external side effects**.

Think of webhook-replay as a stress test for idempotency: it deliberately
replays the same webhook in unsafe ways to reveal duplicate side effects.

Useful when building Stripe, Shopify, GitHub, or custom webhook handlers that must be idempotent.

---

## Non-goals

webhook-replay does not:
- run in production
- intercept live webhooks
- fix idempotency bugs automatically
- replace provider retry logic

It exists to *reveal* unsafe behavior, not hide it.

---

## Install

Quick try:

```bash
npx webhook-replay ./path/to/handler.js --payload ./payload.json
```

Recommended (CI / deterministic):

```bash
npm i -D webhook-replay
npx webhook-replay ./path/to/handler.js --payload ./payload.json
```

---

## Usage

```bash
npx webhook-replay path/to/handler.js
```

> If developing locally, run: `node bin/webhook-replay.js path/to/handler.js`

The handler will be invoked multiple times using the same payload,
including concurrent executions.

---

## Debug mode (Local Debugging Path)

When you suspect a webhook handler ran more than once…

npx webhook-replay debug ./path/to/handler.js --payload ./payload.json --trace

Or provide payload inline:

npx webhook-replay debug ./path/to/handler.js --payload-inline '{"id":"evt_123"}' --trace

It prints:
- how many times the handler ran
- which side effects repeated
- a minimal reproduction command
- call-by-call trace timing (with --trace)

---

## Options

- `--payload <file.json>`          Use a JSON payload file
- `--payload-inline '<json>'`      Provide payload inline as JSON string
- `--runs <n>`                     Deliveries (default: 7)
- `--concurrency <n>`              Concurrent deliveries (default: 3)
- `--shuffle` / `--no-shuffle`     Shuffle delivery order (default: on)
- `--seed <n>`                     Deterministic scheduling seed (default: Date.now)
- `--jitter-ms <n>`                Add 0..n ms delay before each call (default: 25)
- `--timeout-ms <n>`               Per-call timeout (default: 10000)
- `--trace`                        Print call-by-call trace
- `--no-hints`                     Disable detection + hint output

Safety / CI:
- `--allow-unsafe`                 Exit 0 even if unsafe
  (or env `WEBHOOK_REPLAY_ALLOW_UNSAFE=1`)

You can also disable hint output with `WEBHOOK_REPLAY_NO_HINTS=1`.

---

## Payload defaults

If no `--payload` or `--payload-inline` is provided, webhook-replay searches for:

- `./payload.json`
- `./webhook.json`
- `./webhook.payload.json`
- `./test/webhook.json`
- `./fixtures/webhook.json`
- `./fixtures/payload.json`
- `./__fixtures__/webhook.json`
- `./__fixtures__/payload.json`

If none exist, it uses `{ "id": "evt_demo_123" }`.

---

## Exit codes (CI-safe)

- `0` = safe (no handler errors and no duplicate side effects observed)
- `2` = unsafe (duplicate side effects and/or handler errors observed)
- `1` = tool error (bad input, failed to load handler, unexpected crash)

This is intentional: in CI, **unsafe should fail the build**.

---

## Declaring side effects

Handlers may declare external side effects using `ctx.effect(key)`.

The same key being observed more than once is treated as a failure.

Example:

```js
module.exports = async function handler(payload, ctx) {
  ctx.effect(`stripe.charge:${payload.id}`);
};
```

`ctx.effect()` does not perform the side effect — it declares that one occurred,
so webhook-replay can detect duplicates.

---

Supported handler exports:
- `module.exports = async function (payload, ctx) {}`
- `export default async function (payload, ctx) {}` (ESM)
- `export const handler = async (payload, ctx) => {}` (ESM)

---

### Shared state (advanced)

Each handler invocation receives an isolated `ctx`, but a deliberately shared
store is available at `ctx.shared`.

This allows modeling durable idempotency stores:

```js
const key = `charge:${payload.id}`;
if (ctx.shared.kv.get(key)) return;
ctx.shared.kv.set(key, true);
ctx.effect(key);
```

This shared store exists only for the duration of the replay run.

---

## Output

If handler errors occur and/or duplicate side effects are detected, the run fails:

❌ Failure detected

Duplicate side effects observed:
- stripe.charge:evt_demo_123: 7 executions

If no duplicates are observed, the run completes successfully.

On failure it prints a deterministic `Reproduction:` command.

---

## CI Failure Path (GitHub Actions)

Add a workflow that runs `webhook-replay` on every PR.
If unsafe, the job fails and the merge is blocked.

Example:

```yaml
name: webhook-replay
on:
  pull_request:
  push:
    branches: [ main ]

jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      # If installed in the repo (recommended for CI determinism):
      # - run: npm ci
      # - run: npm run ci:replay

      # Or run directly via npx (no install) once published:
      - run: npx webhook-replay ./examples/handler.js
```
