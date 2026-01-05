module.exports = async function handler(payload, ctx) {
  // declare an external side effect with a stable key
  ctx.effect(`stripe.charge:${payload.id}`);
};
