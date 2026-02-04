# webhook-replay

**Detect unsafe webhook handlers by replaying the same webhook multiple times.**

`webhook-replay` is a **retry-safety test** for webhook handlers.

It deliberately replays the **same webhook payload** under retries, concurrency, and reordering to answer one question:

> **Is this webhook handler safe if the provider retries it?**

If duplicate external side effects are detected, the handler is **UNSAFE**.

This is how teams discover:
- duplicate charges
- duplicated credits
- repeated emails
- corrupted state

**before it happens in production.**

---

## What problem this solves (plain language)

Webhook providers (Stripe, Shopify, GitHub, etc.) **retry deliveries by design**.

Retries are normal.  
Duplicate side effects are not.

Most webhook handlers accidentally assume:

> “This webhook will only run once.”

That assumption is wrong.

`webhook-replay` makes retries **visible and reproducible**.

---

## What webhook-replay is

- A **local / CI test**
- A **diagnostic**
- A **binary safety check**

It answers:

> **SAFE or UNSAFE under retry**

---

## What webhook-replay is not

`webhook-replay` does **not**:
- run in production
- intercept live webhooks
- block deliveries
- fix idempotency bugs automatically
- replace provider retry logic

It exists to **reveal unsafe behavior**, not hide it.

---

## Install

Quick test (no install):

```bash
npx webhook-replay ./path/to/handler.js --payload ./payload.json
```

Recommended (CI / deterministic):

```bash
npm install -D webhook-replay
npx webhook-replay ./path/to/handler.js --payload ./payload.json
```

---

## Basic usage

```bash
npx webhook-replay ./path/to/handler.js
```

What happens:

- The same webhook payload is delivered multiple times
- Some deliveries run concurrently
- Delivery order may be shuffled
- External side effects are observed

If the same side effect occurs more than once, the run **fails**.

---

## Debug mode (incident reproduction)

Use this when you suspect:
- a webhook ran more than once
- a customer was charged twice
- credits or entitlements duplicated

```bash
npx webhook-replay debug ./path/to/handler.js --payload ./payload.json --trace
```

Or provide the payload inline:

```bash
npx webhook-replay debug ./path/to/handler.js \
  --payload-inline '{"id":"evt_123"}' \
  --trace
```

Debug mode prints:
- number of handler executions
- duplicate side effects detected
- deterministic reproduction command
- per-call timing (with `--trace`)

---

## Declaring side effects (required for detection)

Handlers **declare** external side effects using `ctx.effect(key)`.

The same key observed more than once is treated as **UNSAFE**.

Example:

```js
module.exports = async function handler(payload, ctx) {
  ctx.effect(`stripe.charge:${payload.id}`);
};
```

`ctx.effect()` does **not** perform the side effect.  
It declares that one occurred so duplicates can be detected.

---

## Supported handler exports

- `module.exports = async function (payload, ctx) {}`
- `export default async function (payload, ctx) {}` (ESM)
- `export const handler = async (payload, ctx) => {}` (ESM)

---

## Shared state (advanced)

Each replay invocation receives an isolated `ctx`.

A deliberately shared store is available at `ctx.shared` to model
durable idempotency state.

Example:

```js
const key = `charge:${payload.id}`;

if (ctx.shared.kv.get(key)) return;

ctx.shared.kv.set(key, true);
ctx.effect(key);
```

The shared store exists **only for the duration of the replay run**.

---

## Exit codes (CI-safe by design)

- `0` → **SAFE**  
  No handler errors. No duplicate side effects detected.

- `2` → **UNSAFE**  
  Duplicate side effects and/or handler errors detected.

- `1` → Tool error  
  Bad input, failed to load handler, unexpected crash.

If the exit code is `2`, the webhook handler is **UNSAFE under retry**.

> In CI, **UNSAFE should fail the build**.

You can override this with `--allow-unsafe`  
(or `WEBHOOK_REPLAY_ALLOW_UNSAFE=1`).

---

## Output (example)

On failure:

```
❌ UNSAFE UNDER RETRY

Duplicate side effects detected:
- stripe.charge:evt_demo_123 (7 executions)

Retrying webhooks is normal.
This handler is not safe under retry.

Reproduction:
npx webhook-replay ./handler.js --payload ./payload.json --seed 913472
```

On success:

```
✅ SAFE UNDER RETRY
No duplicate side effects detected.
```

---

## CI example (GitHub Actions)

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

      # Recommended for CI determinism:
      # - run: npm ci
      # - run: npm run replay

      # Or via npx:
      - run: npx webhook-replay ./examples/handler.js
```

If the handler is **UNSAFE**, the job fails and the merge is blocked.

---

## Why this exists

Retries are unavoidable.  
Duplicate side effects are not.

`webhook-replay` makes retry bugs **provable**, **reproducible**, and **fail-fast**.

---

## What to do if this reports UNSAFE

You have exactly two options:

1. Write perfect idempotency logic everywhere and never make a mistake  
2. Enforce single-delivery before the webhook reaches your code  

Retries are unavoidable.  
Duplicate side effects are optional.

`webhook-replay` tells you **which reality you are currently in**.
