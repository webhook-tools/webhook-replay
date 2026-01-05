module.exports = async function handler(payload, ctx) {
  // pretend the handler is idempotent by gating on an in-memory key (demo only)
  if (!ctx._seen) ctx._seen = new Set();
  const key = `stripe.charge:${payload.id}`;
  if (ctx._seen.has(key)) return;
  ctx._seen.add(key);

  ctx.effect(key);
};
