const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { plan, runBatch } = require("./batch-evaluate.cjs");
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tank-batch-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, jobs: plan(), fingerprint: "fixed", checkFingerprint: () => "fixed",
    execute: job => ({ version: job.version, seed: job.seed, startingStage: job.stage, variant: job.variant }) };
}
test("batch evaluation resumes completed jobs and refuses stale source fingerprints", t => {
  const options = setup(t);
  assert.equal(runBatch({ ...options, maxJobs: 1 }).completed, 1);
  const resumed = runBatch(options);
  assert.equal(resumed.executed, 1); assert.equal(resumed.complete, true);
  assert.equal(resumed.gate.eligible, false);
  assert.equal(runBatch(options).executed, 0);
  assert.throws(() => runBatch({ ...options, fingerprint: "changed" }), /Checkpoint/);
});
test("failed or mismatched jobs cannot be marked complete and concurrent runners are denied", t => {
  const options = setup(t);
  assert.throws(() => runBatch({ ...options, execute() { throw new Error("worker failed"); } }), /worker failed/);
  assert.throws(() => runBatch({ ...options, execute: () => ({}) }), /mismatch/);
  assert.throws(() => runBatch({ ...options, checkFingerprint: () => "changed" }), /Sources changed/);
  fs.writeFileSync(path.join(options.directory, "running.lock"), "busy");
  assert.throws(() => runBatch(options), /EEXIST/);
});
