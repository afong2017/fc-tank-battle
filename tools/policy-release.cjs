const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { assess } = require("../tests/release-gate.cjs");
const { instrument } = require("../tests/safety-instrumentation.cjs");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
function api(root) {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "ai-core.js"), "utf8"), sandbox);
  return sandbox.window.TankPartnerAIEngine;
}
function bundle(root, files) {
  const digest = crypto.createHash("sha1");
  for (const file of files) digest.update(file).update(crypto.createHash("sha1").update(fs.readFileSync(path.join(root, file))).digest("hex"));
  return digest.digest("hex");
}
function bindings(root) {
  const read = name => fs.readFileSync(path.join(root, name), "utf8");
  return {
    coreHash: hash(read("ai-core.js")), gameHash: hash(read("game.js")), dataHash: hash(read("ai-data.js")),
    engineBundleHash: bundle(root, ["ai-core.js", "ai-data.js"]),
    gameBundleHash: bundle(root, ["game.js", "index.html", "style.css", "hot-upgrade.js", "ai-worker.js"]),
    physicsHash: hash(instrument(read("game.js"))),
    evaluatorHash: hash(["tests/evaluate-ai.cjs", "tests/safety-instrumentation.cjs", "tests/holdout-map.cjs", "tests/release-gate.cjs"]
      .map(file => [file, read(file)])),
  };
}
function baselineSnapshot(root, memory = {}) {
  const defaults = { defend: 6.5, survive: 5, attack: 7, clear: 4 };
  const stages = {};
  for (let stage = 1; stage <= 35; stage++) {
    const raw = memory.policyByContext?.[`S${stage}:NORMAL`] || memory.policy || defaults;
    stages[stage] = Object.fromEntries(Object.keys(defaults).map(key => [key,
      Math.max(0, Math.min(10, Number.isFinite(Number(raw[key])) ? Number(raw[key]) : defaults[key]))]));
  }
  return api(root).validatePolicySnapshot({ schema: 1, stages, biases: {} });
}
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w");
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
class ReleaseStore {
  constructor(root, directory = path.join(root, "policy-releases")) {
    this.root = root; this.directory = directory; this.file = path.join(directory, "registry.json");
  }
  read() {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { schema: 1, generation: 0, active: null, previous: null, history: [], outcomes: [] };
  }
  locked(work) {
    fs.mkdirSync(this.directory, { recursive: true });
    const lock = path.join(this.directory, "writer.lock");
    const fd = fs.openSync(lock, "wx");
    try { return work(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  current() {
    const ledger = this.read();
    if (!ledger.active) return { status: "BASELINE", generation: ledger.generation, release: null };
    if (hash(ledger.active.bindings) !== hash(bindings(this.root))) return { status: "INCOMPATIBLE", generation: ledger.generation, release: null };
    const snapshot = api(this.root).validatePolicySnapshot(ledger.active.snapshot);
    if (hash(snapshot) !== ledger.active.policyHash) throw new Error("Release snapshot integrity failure");
    return { status: "ACTIVE", generation: ledger.generation, release: { ...ledger.active, snapshot } };
  }
  publish(baseline, candidate, evidence, expectedBindings) {
    const runtime = api(this.root);
    baseline = runtime.validatePolicySnapshot(baseline);
    candidate = runtime.validatePolicySnapshot(candidate);
    const currentBindings = bindings(this.root);
    if (hash(expectedBindings) !== hash(currentBindings)) throw new Error("Validation belongs to different code");
    const baselineHash = hash(baseline), candidateHash = hash(candidate);
    if (baselineHash === candidateHash) throw new Error("No policy change");
    for (const row of evidence) {
      if (row.policyHash !== (row.version === "baseline" ? baselineHash : candidateHash)
        || row.coreHash !== currentBindings.coreHash || row.physicsHash !== currentBindings.physicsHash
        || row.evaluatorHash !== currentBindings.evaluatorHash) throw new Error("Evidence does not match policy/code snapshot");
    }
    const gate = assess(evidence);
    if (!gate.eligible) throw new Error(`Candidate rejected: ${gate.reason}`);
    return this.locked(() => {
      const ledger = this.read();
      if (ledger.active && ledger.active.policyHash !== baselineHash) throw new Error("Champion changed during validation");
      if (hash(bindings(this.root)) !== hash(currentBindings)) throw new Error("Code changed during publication");
      const generation = ledger.generation + 1;
      const evidenceHash = hash(evidence);
      const active = { id: hash([candidateHash, evidenceHash, currentBindings, generation]), generation,
        policyHash: candidateHash, snapshot: candidate, bindings: currentBindings, evidenceHash, publishedAt: Date.now() };
      const previous = ledger.active || { id: `baseline-${baselineHash}`, generation: 0,
        policyHash: baselineHash, snapshot: baseline, bindings: currentBindings };
      const archive = path.join(this.directory, `evidence-${evidenceHash}.json`);
      writeAtomic(archive, evidence);
      const baselineRates = {};
      for (const row of evidence.filter(row => row.version === "baseline" && row.suite === "campaign")) {
        const count = baselineRates[row.startingStage] ||= { games: 0, wins: 0 };
        count.games++; count.wins += Number(row.result === "win");
      }
      active.baselineRates = baselineRates;
      writeAtomic(this.file, { ...ledger, generation, active, previous, outcomes: [],
        history: [...ledger.history, { type: "PUBLISHED", id: active.id, time: Date.now() }].slice(-100) });
      return active;
    });
  }
  rollback(reason = "manual") {
    return this.locked(() => this.rollbackLocked(this.read(), reason));
  }
  rollbackLocked(ledger, reason) {
    if (!ledger.previous) return { changed: false };
    const rejected = ledger.active?.id;
    const active = ledger.previous;
    writeAtomic(this.file, { ...ledger, active, previous: null, outcomes: [],
      history: [...ledger.history, { type: "ROLLED_BACK", id: rejected, restored: active.id, reason, time: Date.now() }].slice(-100) });
    return { changed: true, restored: active.id };
  }
  recordOutcome(sample) {
    if (!sample || sample.runMode !== "NORMAL" || typeof sample.matchId !== "string" || sample.matchId.length > 200
      || !sample.matchId || !Number.isInteger(sample.stage) || sample.stage < 1 || sample.stage > 35
      || !["win", "lose"].includes(sample.result) || !Number.isInteger(sample.unsafe) || sample.unsafe < 0)
      throw new Error("Invalid policy outcome");
    return this.locked(() => {
      const ledger = this.read();
      if (!ledger.active || sample.releaseId !== ledger.active.id) return { recorded: false, reason: "stale-release" };
      if (ledger.outcomes.some(item => item.matchId === sample.matchId)) return { recorded: false, reason: "duplicate" };
      ledger.outcomes = [...ledger.outcomes, sample].slice(-1000);
      if (sample.unsafe > 0) return this.rollbackLocked(ledger, "live-safety-violation");
      const stageRows = ledger.outcomes.filter(row => row.stage === sample.stage).slice(-100);
      const baseline = ledger.active.baselineRates?.[sample.stage];
      if (baseline && stageRows.length >= 30) {
        const live = wilson(stageRows.filter(row => row.result === "win").length, stageRows.length);
        const previous = wilson(baseline.wins, baseline.games);
        if (live.upper < previous.lower) return this.rollbackLocked(ledger, "live-win-rate-regression");
      }
      writeAtomic(this.file, ledger);
      return { recorded: true };
    });
  }
}
function wilson(wins, n) {
  const z = 1.96, p = wins / n, denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return { lower: center - radius, upper: center + radius };
}
module.exports = { hash, api, bindings, baselineSnapshot, ReleaseStore, writeAtomic };
