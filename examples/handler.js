module.exports = async function handler(payload, ctx) {
  // simulate a side effect
  ctx.log(`chargeCustomer(${payload.id})`);
};
