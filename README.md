# webhook-replay

Replays webhook deliveries against a handler to simulate retries,
concurrency, and reordering.

## Usage

npx webhook-replay path/to/handler.js

> After publishing to npm. Until then: `node bin/webhook-replay.js path/to/handler.js`

The handler will be invoked multiple times using the same payload,
including concurrent executions.

---

## Debug mode (Local Debugging Path)

When you suspect “why did this run twice?”, use:

webhook-replay debug ./path/to/handler.js --payload ./payload.json --trace

Or provide payload inline:

webhook-replay debug ./path/to/handler.js --payload-inline '{"id":"evt_123"}' --trace

It prints:
- how many times the handler ran
- which side effects repeated
- a minimal reproduction command
- call-by-call trace timing (with --trace)

---

## Exit codes (CI-safe)

- `0` = safe (no duplicate side effects observed)
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

---

## Output

If duplicate side effects are detected, the run fails:

❌ Failure detected

Duplicate side effects observed:
- stripe.charge:evt_demo_123: 7 executions

If no duplicates are observed, the run completes successfully.

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