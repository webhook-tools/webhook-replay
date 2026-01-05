#!/usr/bin/env node

const path = require("path");

function usageAndExit(code = 1) {
  console.log("Usage: webhook-replay <path-to-handler.js>");
  process.exit(code);
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") usageAndExit(0);

  const handlerPath = path.resolve(process.cwd(), arg);

  let mod;
  try {
    mod = require(handlerPath);
  } catch (e) {
    console.error(`❌ Could not load handler: ${handlerPath}`);
    console.error(e.message || e);
    process.exit(1);
  }

  const handler = typeof mod === "function" ? mod : mod && mod.default;
  if (typeof handler !== "function") {
    console.error("❌ Handler module must export a function (module.exports = async function ...)");
    process.exit(1);
  }

  // Minimal replay plan (v0.1.0 shape)
  const payload = { id: "evt_demo_123" };
  const runs = 7;
  const concurrency = 3;

  const calls = [];
  let ok = 0;
  let failed = 0;

  const ctx = {
    logs: [],
    effects: new Map(), // key -> count

    log: (msg) => ctx.logs.push(msg),

    effect: (key) => {
      const k = String(key || "");
      const next = (ctx.effects.get(k) || 0) + 1;
      ctx.effects.set(k, next);
      ctx.logs.push(`effect(${k})`);
    },
  };

  console.log("webhook-replay");
  console.log(`Handler: ${handlerPath}`);
  console.log(`Runs: ${runs} (concurrency=${concurrency})`);
  console.log("");

  // Run some sequentially
  for (let i = 0; i < runs - concurrency; i++) {
    try {
      await handler(payload, ctx);
      ok++;
    } catch (e) {
      failed++;
    }
  }

  // Run some concurrently
  for (let i = 0; i < concurrency; i++) {
    calls.push(
      Promise.resolve()
        .then(() => handler(payload, ctx))
        .then(() => (ok++))
        .catch(() => (failed++))
    );
  }

  await Promise.all(calls);

  // Detect duplicate side effects (v0.1.0)
  const dupes = [];
  for (const [k, count] of ctx.effects.entries()) {
    if (count > 1) dupes.push({ key: k, count });
  }

  if (failed > 0 || dupes.length > 0) {
    console.log("❌ Failure detected");

    if (failed > 0) {
      console.log(`Handler errors: ${failed}/${runs}`);
    }

    if (dupes.length > 0) {
      console.log("");
      console.log("Duplicate side effects observed:");
      for (const d of dupes) {
        console.log(`- ${d.key}: ${d.count} executions`);
      }
    }

    process.exit(2);
  }

  console.log("✅ Completed");

  console.log(`Handler executions: ${ok}/${runs}`);
  if (ctx.logs.length) {
    console.log("");
    console.log("Observed side-effect logs:");
    for (const line of ctx.logs) console.log(`- ${line}`);
  }
}

main().catch((e) => {
  console.error("❌ Unexpected error");
  console.error(e);
  process.exit(1);
});
