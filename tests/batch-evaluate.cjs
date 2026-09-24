const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { assess } = require("./release-gate.cjs");
const ROOT = path.resolve(__dirname, "..");
const digest = data => createHash("sha256").update(data).digest("hex");
function plan(full = false) {
  const jobs = [];
  const seeds = full ? Array.from({ length: 10 }, (_, i) => 42 + i * 7919) : [42];
  const stages = full ? Array.from({ length: 35 }, (_, i) => i + 1) : [4];
  const add = (stage, seed, variant) => {
    for (const version of ["baseline", "candidate"]) jobs.push({ stage, seed, variant, version, seconds: full ? 180 : 1 });
  };
  for (const stage of stages) for (const seed of seeds) add(stage, seed, "campaign");
  if (full) for (const variant of ["mirror-upper", "open-even", "open-odd"])
    for (const seed of seeds) add(4, seed, variant);
  return jobs;
}
function atomicJson(file, data) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
}
function runBatch({ directory, jobs, fingerprint, checkFingerprint, execute, maxJobs = 2 }) {
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error("Invalid job budget");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, "running.lock");
  const fd = fs.openSync(lock, "wx");
  try {
    fs.writeFileSync(fd, String(process.pid));
    const checkpoint = path.join(directory, "checkpoint.json");
    const identity = digest(JSON.stringify({ jobs, fingerprint }));
    const state = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, "utf8"))
      : { identity, results: [] };
    if (state.identity !== identity || !Array.isArray(state.results) || state.results.length > jobs.length)
      throw new Error("Checkpoint does not match this code and test plan");
    let executed = 0;
    while (state.results.length < jobs.length && executed < maxJobs) {
      if (checkFingerprint() !== fingerprint) throw new Error("Sources changed; refusing mixed evidence");
      const job = jobs[state.results.length];
      const result = execute(job);
      if (checkFingerprint() !== fingerprint) throw new Error("Sources changed during evaluation");
      if (result.version !== job.version || result.seed !== job.seed
        || result.startingStage !== job.stage || result.variant !== job.variant) throw new Error("Result/job mismatch");
      state.results.push(result);
      atomicJson(checkpoint, state);
      executed++;
    }
    atomicJson(path.join(directory, "evidence.json"), state.results);
    const report = { completed: state.results.length, total: jobs.length, executed,
      complete: state.results.length === jobs.length, gate: assess(state.results) };
    atomicJson(path.join(directory, "report.json"), report);
    return report;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
module.exports = { plan, runBatch };
if (require.main === module) {
  const full = process.argv.includes("--full");
  const directory = process.env.AI_RESULT_DIRECTORY ? path.resolve(process.env.AI_RESULT_DIRECTORY)
    : path.resolve(ROOT, "test-results", full ? "campaign" : "smoke");
  const files = ["game.js", "ai-core.js", "tests/evaluate-ai.cjs", "tests/safety-instrumentation.cjs", "tests/holdout-map.cjs", "tests/release-gate.cjs", "tests/batch-evaluate.cjs"];
  const baseline = () => process.env.AI_BASELINE_FILE
    ? fs.readFileSync(process.env.AI_BASELINE_FILE)
    : execFileSync("git", ["show", "HEAD:ai-core.js"], { cwd: ROOT, maxBuffer: 4e6 });
  const fingerprint = () => digest(JSON.stringify([...files.map(file => digest(fs.readFileSync(path.join(ROOT, file)))), digest(baseline()),
    ...["AI_BASELINE_POLICY_FILE", "AI_CANDIDATE_POLICY_FILE"].map(key => process.env[key] ? digest(fs.readFileSync(process.env[key])) : null)]));
  try {
    const report = runBatch({ directory, jobs: plan(full), fingerprint: fingerprint(), checkFingerprint: fingerprint,
      maxJobs: Number(process.env.AI_MAX_JOBS || 2),
      execute(job) {
        const stdout = execFileSync(process.execPath, [path.join(__dirname, "evaluate-ai.cjs"),
          String(job.seconds), String(job.seed), job.version, String(job.stage), job.variant],
        { cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 4e6 });
        return JSON.parse(stdout.trim());
      } });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
