const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { runBatch } = require("../tests/batch-evaluate.cjs");
const { ReleaseStore, bindings, baselineSnapshot, api, hash, writeAtomic } = require("./policy-release.cjs");
const ROOT = path.resolve(__dirname, "..");
function readBaseline(root, store) {
  const current = store.current();
  if (current.status === "ACTIVE") return current.release.snapshot;
  if (current.status === "INCOMPATIBLE") throw new Error("Existing release requires code compatibility review");
  let memory = {};
  if (fs.existsSync(path.join(root, "ai-memory.db"))) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(root, "ai-memory.db"), { readOnly: true });
    try { memory = JSON.parse(db.prepare("SELECT value_json FROM state WHERE key='memory'").get()?.value_json || "{}"); }
    finally { db.close(); }
  }
  return baselineSnapshot(root, memory);
}
function mutate(snapshot, attempt) {
  const candidate = JSON.parse(JSON.stringify(snapshot));
  const key = ["defend", "survive", "attack", "clear"][Math.floor(attempt / 2) % 4];
  const sign = attempt % 2 === 0 ? 1 : -1;
  const step = [0.25, 0.1, 0.5][Math.floor(attempt / 8) % 3];
  for (const weights of Object.values(candidate.stages)) weights[key] = Math.max(0, Math.min(10, Math.round((weights[key] + sign * step) * 100) / 100));
  return candidate;
}
function jobsFor(phase, nonce, smoke) {
  const jobs = [];
  const seed = i => (Math.imul(nonce ^ 0x9e3779b9, 1664525) + i * 7919) >>> 0;
  const add = (stage, seed, variant) => {
    for (const version of ["baseline", "candidate"]) jobs.push({ stage, seed, variant, version, seconds: smoke ? 1 : 180 });
  };
  if (phase === "screen") {
    for (const stage of (smoke ? [4] : [1, 4, 6])) add(stage, (nonce + stage) >>> 0, "campaign");
  } else {
    for (let stage = 1; stage <= 35; stage++) for (let i = 0; i < 10; i++) add(stage, seed(i), "campaign");
    for (let layout = 0; layout < 3; layout++) for (let i = 10; i < 20; i++)
      add(layout + 1, seed(i), `generated-${seed(layout + 100)}`);
  }
  return jobs;
}
function screenPass(rows) {
  if (!rows.length || rows.length % 2) return false;
  for (let i = 0; i < rows.length; i += 2) {
    const a = rows[i], b = rows[i + 1];
    if (!a || !b || a.version !== "baseline" || b.version !== "candidate"
      || a.seed !== b.seed || a.mapHash !== b.mapHash || a.startingStage !== b.startingStage
      || !["win", "lose"].includes(a.result) || !["win", "lose"].includes(b.result)
      || b.safetyViolations !== 0 || (a.result === "win" && b.result !== "win")
      || ["deaths", "loops", "stalls"].some(key => b[key] > a[key])
      || (a.result === "win" && b.result === "win" && b.time > a.time + 1 / 60)) return false;
  }
  return true;
}
function runStep({ root = ROOT, directory, maxJobs = 2, smoke = false, execute = null }) {
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error("Invalid job budget");
  directory ||= path.join(root, "test-results", smoke ? "evolution-smoke" : "evolution");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, "pipeline.lock");
  const fd = fs.openSync(lock, "wx");
  try {
    const store = new ReleaseStore(root);
    const stateFile = path.join(directory, "state.json");
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { attempt: 0, trial: null };
    const currentBindings = bindings(root);
    if (!state.trial || ["REJECTED", "PUBLISHED"].includes(state.trial.status)) {
      const baseline = readBaseline(root, store);
      const candidate = api(root).validatePolicySnapshot(mutate(baseline, state.attempt));
      const nonce = crypto.randomBytes(4).readUInt32LE();
      const folder = path.join(directory, `trial-${state.attempt}-${nonce}`);
      writeAtomic(path.join(folder, "baseline.json"), baseline);
      writeAtomic(path.join(folder, "candidate.json"), candidate);
      state.trial = { status: "SCREENING", folder, nonce, bindings: currentBindings,
        baselineHash: hash(baseline), candidateHash: hash(candidate), smoke };
      state.attempt++;
      writeAtomic(stateFile, state);
    }
    const trial = state.trial;
    if (trial.smoke !== smoke || hash(trial.bindings) !== hash(currentBindings)) throw new Error("Trial code changed; retain evidence and start a new directory");
    const baselineFile = path.join(trial.folder, "baseline.json"), candidateFile = path.join(trial.folder, "candidate.json");
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")), candidate = JSON.parse(fs.readFileSync(candidateFile, "utf8"));
    if (hash(baseline) !== trial.baselineHash || hash(candidate) !== trial.candidateHash) throw new Error("Snapshot changed during trial");
    const active = store.current().release;
    const evidenceFile = path.join(trial.folder, "validate/evidence.json");
    if (trial.status === "VALIDATING" && active?.policyHash === trial.candidateHash && fs.existsSync(evidenceFile)
      && active.evidenceHash === hash(JSON.parse(fs.readFileSync(evidenceFile, "utf8")))) {
      trial.status = "PUBLISHED"; trial.releaseId = active.id;
      writeAtomic(stateFile, state);
      return { attempt: state.attempt, status: trial.status, folder: trial.folder,
        report: { ...trial.lastReport, executed: 0, complete: true } };
    }
    if (hash(readBaseline(root, store)) !== trial.baselineHash) throw new Error("Production baseline changed during trial");
    const phase = trial.status === "SCREENING" ? "screen" : "validate";
    const fingerprint = () => hash([bindings(root), fs.readFileSync(baselineFile, "utf8"), fs.readFileSync(candidateFile, "utf8")]);
    const report = runBatch({ directory: path.join(trial.folder, phase), jobs: jobsFor(phase, trial.nonce, smoke),
      fingerprint: fingerprint(), checkFingerprint: fingerprint, maxJobs,
      execute: execute || (job => JSON.parse(execFileSync(process.execPath, [path.join(root, "tests/evaluate-ai.cjs"),
        String(job.seconds), String(job.seed), job.version, String(job.stage), job.variant], {
        cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 4e6,
        env: { ...process.env, AI_BASELINE_FILE: path.join(root, "ai-core.js"),
          AI_BASELINE_POLICY_FILE: baselineFile, AI_CANDIDATE_POLICY_FILE: candidateFile },
      }).trim())) });
    if (report.complete) {
      const rows = JSON.parse(fs.readFileSync(path.join(trial.folder, phase, "evidence.json"), "utf8"));
      if (phase === "screen") trial.status = !smoke && screenPass(rows) ? "VALIDATING" : "REJECTED";
      else {
        const training = JSON.parse(fs.readFileSync(path.join(trial.folder, "screen/evidence.json"), "utf8"));
        const trainingMaps = new Set(training.map(row => row.mapHash));
        const holdoutClean = rows.filter(row => row.suite === "holdout").every(row => !trainingMaps.has(row.mapHash));
        if (report.gate.eligible && holdoutClean && !smoke) {
          const release = store.publish(baseline, candidate, rows, trial.bindings);
          trial.status = "PUBLISHED"; trial.releaseId = release.id;
        } else trial.status = "REJECTED";
      }
    }
    trial.lastReport = report;
    writeAtomic(stateFile, state);
    return { attempt: state.attempt, status: trial.status, folder: trial.folder, report };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function runEvolution(options) {
  let remaining = options.maxJobs;
  const results = [];
  while (remaining > 0) {
    const result = runStep({ ...options, maxJobs: remaining });
    results.push(result);
    remaining -= result.report.executed;
    if (result.status === "PUBLISHED" || options.smoke || !result.report.executed) break;
  }
  return { executed: options.maxJobs - remaining, results };
}
module.exports = { mutate, jobsFor, screenPass, runStep, runEvolution };
if (require.main === module) {
  try {
    const jobIndex = process.argv.indexOf("--jobs");
    const maxJobs = jobIndex >= 0 ? Number(process.argv[jobIndex + 1]) : 2;
    console.log(JSON.stringify(runEvolution({ maxJobs, smoke: process.argv.includes("--smoke"),
      directory: process.env.AI_EVOLUTION_DIRECTORY }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
