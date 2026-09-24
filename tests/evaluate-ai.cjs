// Isolated, bounded comparison using game.js physics; never writes training data.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
const { instrument } = require("./safety-instrumentation.cjs");
const { transformMap } = require("./holdout-map.cjs");
const { bindings } = require("../tools/policy-release.cjs");
const variant = process.argv[6] || "campaign";
if (!/^generated-\d{1,10}$/.test(variant) && !["campaign", "mirror-upper", "open-even", "open-odd"].includes(variant)) throw new Error("Unknown map suite");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const limit = Math.max(1, Math.min(180, Number(process.argv[2]) || 60));
const seeds = (process.argv[3] || "42,731").split(",").map(Number);
const stage = Math.max(1, Math.min(35, Math.floor(Number(process.argv[5]) || 1)));
const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
const observedSource = instrument(source);
const versions = {
  baseline: process.env.AI_BASELINE_FILE
    ? fs.readFileSync(process.env.AI_BASELINE_FILE, "utf8")
    : process.env.AI_BASELINE_POLICY_FILE ? fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8")
      : execFileSync("git", ["show", "HEAD:ai-core.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 4e6 }),
  candidate: fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8"),
};
function evaluate(core, seed, version) {
  let rng = seed >>> 0;
  const math = Object.create(Math);
  math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
  const noop = () => {};
  const elements = new Map();
  const drawing = new Proxy({}, { get: () => noop, set: () => true });
  function element() {
    return {
      value: "Infinity", textContent: "", innerHTML: "", style: {}, dataset: {}, width: 832, height: 768,
      options: [], children: [], classList: { add: noop, remove: noop, toggle: noop },
      addEventListener: noop, setAttribute: noop, appendChild: noop, append: noop,
      replaceChildren: noop, querySelectorAll: () => [], querySelector: () => null,
      getContext: () => drawing, closest: () => null,
    };
  }
  const storage = () => {
    const values = new Map();
    return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
  };
  const events = {};
  const testSafety = { protectedBrick: 0, baseHit: 0, friendlyHit: 0 };
  let result = null;
  const services = {
    readMemory: () => ({ weights: { defend: 5, survive: 5, attack: 5, clear: 5 } }),
    recordExperience: (type) => { events[type] = (events[type] || 0) + 1; },
    syncMemoryFile: noop,
    finishMatch: (data) => { result = data; },
  };
  const sandbox = {
    window: { addEventListener: noop }, console, Math: math, testSafety,
    localStorage: storage(), sessionStorage: storage(),
    location: { hostname: "127.0.0.1", protocol: "file:", search: "?testMute=1" },
    navigator: { getGamepads: () => [] }, URLSearchParams,
    // Deterministic search uses its node bound instead of machine-dependent time.
    performance: { now: () => 0 },
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    requestAnimationFrame: noop, HTMLElement: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext(core, sandbox);
  const policyFile = process.env[version === "baseline" ? "AI_BASELINE_POLICY_FILE" : "AI_CANDIDATE_POLICY_FILE"];
  const snapshot = policyFile ? sandbox.window.TankPartnerAIEngine.validatePolicySnapshot(JSON.parse(fs.readFileSync(policyFile, "utf8"))) : null;
  if (snapshot) {
    services.readPolicy = stage => snapshot.stages[stage];
    services.evaluateAutonomyActions = (state, keys) => sandbox.window.TankPartnerAIEngine.evaluatePolicySnapshot(snapshot, state, keys);
  }
  sandbox.window.TankPartnerAI = sandbox.window.TankPartnerAIEngine.enhance(services);
  sandbox.document = {
    hidden: false, addEventListener: noop, createElement: element,
    querySelectorAll: () => [],
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
  };
  vm.runInContext(observedSource.replace(/bootGame\(\);\s*$/, ""), sandbox);
  vm.runInContext(`lives = Infinity; lives2 = Infinity; aiTrainingEnabled = false; stageIndex = ${stage - 1}; state = 'playing'; loadStage();`, sandbox);
  if (variant !== "campaign") {
    sandbox.testMap = transformMap(vm.runInContext("map", sandbox), variant);
    vm.runInContext("map = testMap; mapVersion++;", sandbox);
    delete sandbox.testMap;
  }
  const mapHash = hash(vm.runInContext("JSON.stringify(map)", sandbox));
  const started = Date.now();
  for (let frame = 0; frame < limit * 60 && !result; frame++) {
    vm.runInContext("update(FIXED_DT)", sandbox);
  }
  return { seed, startingStage: stage, result: result ? (result.win ? "win" : "lose") : "timeout",
    ...vm.runInContext("({time:gameTime, stage:stageIndex+1, deaths:p1Deaths+p2Deaths, kills:killStats.basic+killStats.fast+killStats.armor})", sandbox),
    events, elapsedMs: Date.now() - started,
    coreHash: hash(core), physicsHash: hash(observedSource), mapHash,
    policyHash: snapshot ? hash(JSON.stringify(snapshot)) : null,
    evaluatorHash: bindings(ROOT).evaluatorHash,
    suite: variant === "campaign" ? "campaign" : "holdout", variant,
    loops: events.ai_route_loop || 0, stalls: events.defense_route_stall || 0,
    safety: testSafety,
    safetyViolations: Object.values(testSafety).reduce((sum, count) => sum + count, 0) };
}
for (const seed of seeds) for (const [version, core] of Object.entries(versions)
  .filter(([version]) => !process.argv[4] || version === process.argv[4])) {
  console.log(JSON.stringify({ version, ...evaluate(core, seed, version) }));
}
