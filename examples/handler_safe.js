module.exports = async function handler(payload, ctx) {
  // Demo only: emulate a durable idempotency store using ctx.shared.kv (explicitly shared)
  const key = `stripe.charge:${payload.id}`;

  if (ctx.shared.kv.get(key)) return;
  ctx.shared.kv.set(key, true);

  ctx.effect(key);
};
