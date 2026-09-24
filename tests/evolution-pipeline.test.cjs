const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runStep, runEvolution, jobsFor, mutate } = require("../tools/evolve.cjs");
const { baselineSnapshot, bindings, hash, ReleaseStore } = require("../tools/policy-release.cjs");
const ROOT = path.resolve(__dirname, "..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tank-pipeline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ["game.js", "ai-core.js", "ai-data.js", "index.html", "style.css", "hot-upgrade.js", "ai-worker.js",
    "tests/evaluate-ai.cjs", "tests/safety-instrumentation.cjs", "tests/holdout-map.cjs", "tests/release-gate.cjs"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}
const timeout = job => ({ version: job.version, seed: job.seed, startingStage: job.stage,
  variant: job.variant, result: "timeout" });
test("evolution snapshots resume but smoke cannot publish and code changes stop validation", t => {
  const root = fixture(t), options = { root, smoke: true, maxJobs: 1, execute: timeout };
  const first = runStep(options);
  assert.equal(first.status, "SCREENING");
  assert.equal(runStep(options).status, "REJECTED");
  assert.equal(fs.existsSync(path.join(root, "policy-releases/registry.json")), false);
  const third = runStep(options);
  fs.appendFileSync(path.join(root, "ai-data.js"), "\n// fixture drift\n");
  assert.throws(() => runStep(options), /code changed/);
  assert.ok(third.attempt > first.attempt);
});
test("bounded automation advances rejected candidates without changing production", t => {
  const root = fixture(t);
  const result = runEvolution({ root, smoke: false, maxJobs: 8, execute: timeout });
  assert.equal(result.executed, 8);
  assert.equal(result.results[0].status, "REJECTED");
  assert.equal(result.results[1].status, "SCREENING");
  assert.equal(fs.existsSync(path.join(root, "policy-releases/registry.json")), false);
});
test("validation seeds exclude screening seeds and mutations leave the champion immutable", () => {
  const baseline = baselineSnapshot(ROOT), original = JSON.stringify(baseline);
  const candidate = mutate(baseline, 0);
  assert.equal(JSON.stringify(baseline), original);
  assert.notEqual(candidate.stages[1].defend, baseline.stages[1].defend);
  const screen = jobsFor("screen", 777, false), validation = jobsFor("validate", 777, false);
  assert.equal(validation.length, 760);
  assert.ok(validation.every(job => !screen.some(training => training.seed === job.seed)));
  assert.equal(new Set(validation.filter(job => job.variant !== "campaign").map(job => job.variant)).size, 3);
});

test("synthetic end-to-end fixture publishes only after all 766 jobs and recovers publication handoff", t => {
  const root = fixture(t);
  const directory = path.join(root, "fixture-evolution");
  const bound = bindings(root);
  const execute = job => {
    const trial = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).trial;
    return { version: job.version, startingStage: job.stage, seed: job.seed, variant: job.variant,
      suite: job.variant === "campaign" ? "campaign" : "holdout", result: "win",
      time: job.version === "candidate" ? 59 : 60, deaths: 0, loops: 0, stalls: 0, safetyViolations: 0,
      policyHash: job.version === "candidate" ? trial.candidateHash : trial.baselineHash,
      coreHash: bound.coreHash, physicsHash: bound.physicsHash, evaluatorHash: bound.evaluatorHash,
      mapHash: hash([job.stage, job.variant]) };
  };
  const result = runEvolution({ root, directory, maxJobs: 766, execute });
  assert.equal(result.executed, 766);
  assert.equal(result.results.at(-1).status, "PUBLISHED");
  assert.equal(new ReleaseStore(root).current().generation, 1);
  const stateFile = path.join(directory, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.trial.status = "VALIDATING";
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const recovered = runStep({ root, directory, maxJobs: 1, execute });
  assert.equal(recovered.status, "PUBLISHED");
  assert.equal(recovered.report.executed, 0);
  assert.equal(new ReleaseStore(root).current().generation, 1);
});
