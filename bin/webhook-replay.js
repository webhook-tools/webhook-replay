#!/usr/bin/env node

const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");
const os = require("os");

function shouldPrintHintOnce() {
  const dir = path.join(os.homedir(), ".webhook-replay");
  const stamp = path.join(dir, "seen");
  try {
    if (fs.existsSync(stamp)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(Date.now()), "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

function readJsonFileSoft(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

function readJsonFile(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    console.error(`❌ Could not read payload file: ${p}`);
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`❌ Payload is not valid JSON: ${p}`);
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  }
}

function parseInlineJson(s) {
  try {
    return JSON.parse(String(s || ""));
  } catch (e) {
    console.error("❌ --payload-inline must be valid JSON");
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  }
}

function findNearestPackageJson(startDir) {
  let dir = startDir;
  for (let i = 0; i < 25; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) return pj;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function safeReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (_) {
    return "";
  }
}

function makeCtxForCall(observer, shared, callMeta) {
  // ctx is per-call, but can expose shared state intentionally
  return {
    shared, // optional shared state for advanced cases
    effect: (key) => observer.effect(key, callMeta),
    log: (msg) => observer.log(msg, callMeta),
  };
}

function detectContext({ cwd, handlerPath }) {
  const signals = [];

  const pj = findNearestPackageJson(cwd);
  if (pj) {
    const pkg = readJsonFileSoft(pj);
    if (pkg) {
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {}),
      };
      const depNames = Object.keys(deps).map((s) => s.toLowerCase());

      const hasStripe = depNames.includes("stripe") || depNames.includes("@stripe/stripe-js");
      const hasShopify =
        depNames.some((d) => d.includes("shopify")) ||
        depNames.includes("@shopify/shopify-api") ||
        depNames.includes("@shopify/shopify-app-express");
      const hasGithub =
        depNames.some((d) => d.includes("octokit")) || depNames.includes("@octokit/rest");

      if (hasStripe) signals.push("Stripe");
      if (hasShopify) signals.push("Shopify");
      if (hasGithub) signals.push("GitHub");
    }
  }

  const src = safeReadFile(handlerPath).toLowerCase();
  if (src) {
    if (src.includes("stripe") || src.includes("/webhooks/stripe") || src.includes("stripe-signature")) {
      if (!signals.includes("Stripe")) signals.push("Stripe");
    }
    if (src.includes("shopify") || src.includes("x-shopify")) {
      if (!signals.includes("Shopify")) signals.push("Shopify");
    }
    if (src.includes("github") || src.includes("x-hub-signature") || src.includes("x-github-event")) {
      if (!signals.includes("GitHub")) signals.push("GitHub");
    }
  }

  return signals;
}

function usageAndExit(code = 1) {
  console.log(`Usage:
  webhook-replay <path-to-handler.js> [options]
  webhook-replay debug <path-to-handler.js> [options]

Options:
  --payload <file.json>          Use a JSON payload file
  --payload-inline '<json>'      Provide payload inline as JSON string
  --runs <n>                     Number of deliveries (default: 7)
  --concurrency <n>              Concurrent deliveries (default: 3)
  --shuffle                      Shuffle delivery order (default: on)
  --no-shuffle                   Disable shuffle
  --seed <n>                     RNG seed for deterministic scheduling (default: Date.now)
  --jitter-ms <n>                Add 0..n ms delay before each call (default: 25)
  --timeout-ms <n>               Per-call timeout (default: 10000)
  --trace                        Print call-by-call trace (best for debugging)
  --no-hints                     Disable detection + hint output

Safety / CI:
  --allow-unsafe                 Exit 0 even if unsafe (explicit bypass)
  (or env WEBHOOK_REPLAY_ALLOW_UNSAFE=1)

Payload defaults:
  If no --payload or --payload-inline is given, webhook-replay searches for:
    ./payload.json
    ./webhook.json
    ./webhook.payload.json
    ./test/webhook.json
    ./fixtures/webhook.json
    ./fixtures/payload.json
    ./__fixtures__/webhook.json
    ./__fixtures__/payload.json
  If none exist, it uses: { "id": "evt_demo_123" }
`);
  process.exit(code);
}

function parseArgs(argv) {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) usageAndExit(0);

  let mode = "run";
  let i = 0;
  if (argv[0] === "debug") {
    mode = "debug";
    i++;
  }

  const handlerArg = argv[i];
  if (!handlerArg) usageAndExit(1);
  i++;

  const opts = {
    mode,
    handlerArg,
    payloadPath: null,
    payloadInline: null,
    runs: 7,
    concurrency: 3,
    trace: false,
    noHints: false,
    allowUnsafe: false,

    // scheduling realism
    shuffle: true,
    seed: null, // default in main()
    jitterMs: 25,

    // safety
    timeoutMs: 10_000,
  };

  while (i < argv.length) {
    const a = argv[i];

    if (a === "--payload") {
      opts.payloadPath = argv[i + 1];
      if (!opts.payloadPath) usageAndExit(1);
      i += 2;
      continue;
    }

    if (a === "--payload-inline") {
      opts.payloadInline = argv[i + 1];
      if (opts.payloadInline == null) usageAndExit(1);
      i += 2;
      continue;
    }

    if (a === "--runs") {
      opts.runs = Number(argv[i + 1] || "0");
      if (!Number.isFinite(opts.runs) || opts.runs <= 0) usageAndExit(1);
      i += 2;
      continue;
    }

    if (a === "--concurrency") {
      opts.concurrency = Number(argv[i + 1]);
      if (!Number.isFinite(opts.concurrency) || opts.concurrency <= 0) usageAndExit(1);
      i += 2;
      continue;
    }

    if (a === "--trace") {
      opts.trace = true;
      i++;
      continue;
    }

    if (a === "--no-hints") {
      opts.noHints = true;
      i++;
      continue;
    }

    if (a === "--allow-unsafe") {
      opts.allowUnsafe = true;
      i++;
      continue;
    }

    if (a === "--shuffle") {
      opts.shuffle = true;
      i++;
      continue;
    }

    if (a === "--no-shuffle") {
      opts.shuffle = false;
      i++;
      continue;
    }

    if (a === "--seed") {
      opts.seed = Number(argv[i + 1]);
      if (!Number.isFinite(opts.seed)) usageAndExit(1);
      i += 2;
      continue;
    }

    if (a === "--jitter-ms") {
      opts.jitterMs = Number(argv[i + 1]);
      if (!Number.isFinite(opts.jitterMs) || opts.jitterMs < 0) usageAndExit(1);
      i += 2;
      continue;
    }

    if (a === "--timeout-ms") {
      opts.timeoutMs = Number(argv[i + 1]);
      if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) usageAndExit(1);
      i += 2;
      continue;
    }

    console.error(`❌ Unknown arg: ${a}`);
    usageAndExit(1);
  }

  if (process.env.WEBHOOK_REPLAY_ALLOW_UNSAFE === "1" || process.env.WEBHOOK_REPLAY_ALLOW_UNSAFE === "true") {
    opts.allowUnsafe = true;
  }
  if (process.env.WEBHOOK_REPLAY_NO_HINTS === "1" || process.env.WEBHOOK_REPLAY_NO_HINTS === "true") {
    opts.noHints = true;
  }

  if (opts.payloadPath && opts.payloadInline != null) {
    console.error("❌ Use only one of --payload or --payload-inline");
    process.exit(1);
  }

  if (opts.concurrency > opts.runs) opts.concurrency = opts.runs;

  return opts;
}

async function loadHandler(handlerPathAbs, cacheBust) {
  let mod;

  try {
    mod = require(handlerPathAbs);
  } catch (e) {
    const isEsm =
      e && (e.code === "ERR_REQUIRE_ESM" || String(e.message || "").includes("ERR_REQUIRE_ESM"));

    if (!isEsm) {
      console.error(`❌ Could not load handler: ${handlerPathAbs}`);
      console.error(e && e.message ? e.message : e);
      process.exit(1);
    }

    try {
      const url = pathToFileURL(handlerPathAbs);
      if (cacheBust != null) url.search = `?seed=${cacheBust}`;
      mod = await import(url.href);

    } catch (e2) {
      console.error(`❌ Could not load handler (ESM import failed): ${handlerPathAbs}`);
      console.error(e2 && e2.message ? e2.message : e2);
      process.exit(1);
    }
  }

  if (typeof mod === "function") return mod;
  if (mod && typeof mod.default === "function") return mod.default;
  if (mod && typeof mod.handler === "function") return mod.handler;

  console.error("❌ Handler module must export a function.");
  console.error("   Supported forms:");
  console.error("   - module.exports = async function (payload, ctx) {}");
  console.error("   - export default async function (payload, ctx) {}");
  console.error("   - export const handler = async (payload, ctx) => {}");
  process.exit(1);
}

function resolveDefaultPayloadFile(cwd) {
  const candidates = [
    "payload.json",
    "webhook.json",
    "webhook.payload.json",
    path.join("test", "webhook.json"),
    path.join("fixtures", "webhook.json"),
    path.join("fixtures", "payload.json"),
    path.join("__fixtures__", "webhook.json"),
    path.join("__fixtures__", "payload.json"),
  ];

  for (const rel of candidates) {
    const abs = path.resolve(cwd, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch (_) {
      // ignore races / permission issues
    }
  }
  return null;
}

function resolvePayload(opts, cwd) {
  if (opts.payloadInline != null) {
    return { payload: parseInlineJson(opts.payloadInline), payloadSource: "inline" };
  }

  if (opts.payloadPath) {
    const abs = path.resolve(cwd, opts.payloadPath);
    return { payload: readJsonFile(abs), payloadSource: abs };
  }

  const found = resolveDefaultPayloadFile(cwd);
  if (found) {
    return { payload: readJsonFile(found), payloadSource: found };
  }

  return { payload: { id: "evt_demo_123" }, payloadSource: "default" };
}

// deterministic PRNG (mulberry32)
function makeRng(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, timeoutMs, label = "handler") {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  // default seed here so it prints and is reproducible
  if (opts.seed == null) opts.seed = Date.now();

  const handlerPath = path.resolve(cwd, opts.handlerArg);
  const handler = await loadHandler(handlerPath, opts.seed);

  const { payload, payloadSource } = resolvePayload(opts, cwd);

  const runs = opts.runs;
  const concurrency = opts.concurrency;
  const rand = makeRng(opts.seed);

  if (!opts.noHints && shouldPrintHintOnce()) {
    const signals = detectContext({ cwd, handlerPath });
    if (signals.length) {
      console.log(`Detected webhook context: ${signals.join(", ")}`);
    }

    const payloadHint = opts.payloadInline != null
      ? ` --payload-inline '${String(opts.payloadInline).replace(/'/g, "\\'")}'`
      : opts.payloadPath
        ? ` --payload ${opts.payloadPath}`
        : " --payload ./payload.json";

    console.log(`Hint: webhook-replay debug ${opts.handlerArg}${payloadHint} --trace`);
    console.log("");
  }

  console.log("webhook-replay");
  console.log(`Handler: ${handlerPath}`);
  console.log(`Mode: ${opts.mode}`);
  console.log(`Runs: ${runs} (concurrency=${concurrency})`);
  console.log(`Seed: ${opts.seed}`);
  console.log(`Shuffle: ${opts.shuffle ? "on" : "off"}`);
  console.log(`Jitter: ${opts.jitterMs}ms`);
  console.log(`Timeout: ${opts.timeoutMs}ms`);
  console.log(`Payload: ${payloadSource}`);
  console.log("");

  // shared observer (global)
  const observer = {
    logs: [],
    effects: new Map(), // key -> count
    effect: (key, meta) => {
      const k = String(key || "").trim();
      if (!k) throw new Error("ctx.effect(key) requires a non-empty key");
      const next = (observer.effects.get(k) || 0) + 1;
      observer.effects.set(k, next);
      observer.logs.push(`effect(${k})${meta ? ` @${meta}` : ""}`);
    },
    log: (msg, meta) => {
      observer.logs.push(`${String(msg)}${meta ? ` @${meta}` : ""}`);
    },
  };

  // explicit shared state (only if a handler intentionally uses it)
  const shared = {
    _demo: true,
    kv: new Map(),
  };

  const jobs = Array.from({ length: runs }, (_, idx) => ({ idx: idx + 1 }));
  if (opts.shuffle) shuffleInPlace(jobs, rand);

  function traceLine(s) {
    if (opts.trace) console.log(s);
  }

  let ok = 0;
  let failed = 0;

  async function runOne(job, callNum, workerId) {
    const callMeta = `call#${callNum} (delivery=${job.idx}, worker=${workerId})`;

    // optional jitter
    if (opts.jitterMs > 0) {
      const d = Math.floor(rand() * (opts.jitterMs + 1)); // 0..jitterMs
      if (d > 0) await sleep(d);
    }

    const ctx = makeCtxForCall(observer, shared, callMeta);

    const t0 = Date.now();
    traceLine(`[${callMeta}] start @ ${t0}`);

    try {
      await withTimeout(Promise.resolve().then(() => handler(payload, ctx)), opts.timeoutMs, "handler");
      ok++;
      const t1 = Date.now();
      traceLine(`[${callMeta}] ok    @ ${t1} (+${t1 - t0}ms)`);
    } catch (e) {
      failed++;
      const t1 = Date.now();
      const msg = (e && (e.message || String(e))) || "error";
      traceLine(`[${callMeta}] fail  @ ${t1} (+${t1 - t0}ms) ${msg}`);
    }
  }

  let cursor = 0;

  async function worker(workerId) {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const callNum = i + 1;
      await runOne(jobs[i], callNum, workerId);
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker(w + 1));
  }

  await Promise.all(workers);

  // Detect duplicate side effects
  const dupes = [];
  for (const [k, count] of observer.effects.entries()) {
    if (count > 1) dupes.push({ key: k, count });
  }

  const unsafe = failed > 0 || dupes.length > 0;

  if (unsafe) {
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

    console.log("");

    const payloadRepro =
      opts.payloadInline != null
        ? `--payload-inline '${String(opts.payloadInline).replace(/'/g, "\\'")}'`
        : opts.payloadPath
          ? `--payload ${opts.payloadPath}`
          : (payloadSource !== "default" && payloadSource !== "inline")
            ? `--payload ${payloadSource}`
            : "";

    const reproParts = [
      "webhook-replay",
      opts.mode === "debug" ? "debug" : "",
      opts.handlerArg,
      payloadRepro,
      `--runs ${opts.runs}`,
      `--concurrency ${opts.concurrency}`,
      opts.shuffle ? "--shuffle" : "--no-shuffle",
      `--seed ${opts.seed}`,
      `--jitter-ms ${opts.jitterMs}`,
      `--timeout-ms ${opts.timeoutMs}`,
      "--trace",
    ].filter(Boolean);

    console.log(`Reproduction: ${reproParts.join(" ")}`);


    if (opts.mode === "debug") {
      console.log("");
      console.log(`Handler ran: ${ok + failed} times`);
      console.log(`Side effects observed: ${observer.effects.size}`);
    }

    if (opts.allowUnsafe) {
      console.log("");
      console.log("⚠️  allow-unsafe enabled: exiting 0 despite failure");
      process.exit(0);
    }

    // UNSAFE MUST EXIT 2
    process.exit(2);
  }

  // SAFE path exits 0
  console.log("✅ Completed");

  if (opts.mode === "debug") {
    console.log("");
    console.log(`Handler ran: ${ok + failed} times`);
    console.log(`Side effects observed: ${observer.effects.size}`);
  }

  console.log(`Handler executions: ${ok}/${runs}`);

  if (observer.logs.length) {
    console.log("");
    console.log("Observed side-effect logs:");
    for (const line of observer.logs) console.log(`- ${line}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Unexpected error");
  console.error(e);
  process.exit(1);
});
