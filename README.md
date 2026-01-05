# webhook-replay

Replays webhook deliveries against a handler to simulate retries,
concurrency, and reordering.

## Usage

npx webhook-replay path/to/handler.js

The handler will be invoked multiple times using the same payload,
including concurrent executions.

## Declaring side effects

Handlers may declare external side effects using `ctx.effect(key)`.

The same key being observed more than once is treated as a failure.

Example:

module.exports = async function handler(payload, ctx) {
  ctx.effect(`stripe.charge:${payload.id}`);
};

## Output

If duplicate side effects are detected, the run fails:

❌ Failure detected

Duplicate side effects observed:
- stripe.charge:evt_demo_123: 7 executions

If no duplicates are observed, the run completes successfully.
