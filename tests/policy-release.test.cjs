const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ReleaseStore, bindings, baselineSnapshot, hash, api } = require("../tools/policy-release.cjs");
const ROOT = path.resolve(__dirname, "..");
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tank-release-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseline = baselineSnapshot(ROOT);
  const raw = JSON.parse(JSON.stringify(baseline)); raw.stages[1].defend += 0.25;
  const candidate = api(ROOT).validatePolicySnapshot(raw);
  const bound = bindings(ROOT);
  const evidence = [];
  for (let stage = 1; stage <= 38; stage++) for (let seed = 0; seed < 10; seed++) {
    for (const version of ["baseline", "candidate"]) evidence.push({
      version, coreHash: bound.coreHash, physicsHash: bound.physicsHash, evaluatorHash: bound.evaluatorHash,
      policyHash: hash(version === "baseline" ? baseline : candidate),
      mapHash: hash(`synthetic-fixture-${stage}`), startingStage: Math.min(stage, 35), seed,
      suite: stage <= 35 ? "campaign" : "holdout", result: "win",
      time: version === "baseline" ? 60 : 59, deaths: 0, loops: 0, stalls: 0, safetyViolations: 0,
    });
  }
  return { store: new ReleaseStore(ROOT, directory), baseline, candidate, bound, evidence };
}
test("release publication binds snapshots and evidence atomically and supports rollback", t => {
  const x = setup(t);
  assert.throws(() => x.store.publish(x.baseline, x.candidate, [], x.bound), /rejected/);
  const forged = structuredClone(x.evidence); forged[1].policyHash = hash("wrong");
  assert.throws(() => x.store.publish(x.baseline, x.candidate, forged, x.bound), /snapshot/);
  assert.equal(x.store.current().status, "BASELINE");
  const released = x.store.publish(x.baseline, x.candidate, x.evidence, x.bound);
  assert.equal(released.generation, 1);
  assert.equal(x.store.current().release.policyHash, hash(x.candidate));
  assert.throws(() => x.store.publish(x.baseline, x.candidate, x.evidence, x.bound), /Champion changed/);
  assert.equal(x.store.rollback("fixture").changed, true);
  assert.equal(x.store.current().release.policyHash, hash(x.baseline));
  assert.equal(x.store.rollback().changed, false);
});
test("live outcomes deduplicate, ignore stale releases and roll back unsafe policies", t => {
  const x = setup(t); const active = x.store.publish(x.baseline, x.candidate, x.evidence, x.bound);
  const sample = { releaseId: active.id, matchId: "fixture-1", stage: 1, result: "win", runMode: "NORMAL", unsafe: 0 };
  assert.equal(x.store.recordOutcome(sample).recorded, true);
  assert.equal(x.store.recordOutcome(sample).reason, "duplicate");
  assert.equal(x.store.recordOutcome({ ...sample, releaseId: "old" }).reason, "stale-release");
  assert.throws(() => x.store.recordOutcome({ ...sample, runMode: "TEST" }), /Invalid/);
  assert.equal(x.store.recordOutcome({ ...sample, matchId: "fixture-2", unsafe: 1 }).changed, true);
  assert.equal(x.store.current().release.policyHash, hash(x.baseline));
});
test("sustained live regression triggers conservative automatic rollback", t => {
  const x = setup(t); const active = x.store.publish(x.baseline, x.candidate, x.evidence, x.bound);
  let result;
  for (let i = 0; i < 30; i++) result = x.store.recordOutcome({ releaseId: active.id,
    matchId: `loss-${i}`, stage: 1, result: "lose", runMode: "NORMAL", unsafe: 0 });
  assert.equal(result.changed, true);
  assert.equal(x.store.current().release.policyHash, hash(x.baseline));
});
test("snapshot normalization is immutable, deterministic and rejects invalid weights", () => {
  const runtime = api(ROOT), baseline = baselineSnapshot(ROOT);
  const raw = JSON.parse(JSON.stringify(baseline)); raw.stages[1].defend = Infinity;
  assert.throws(() => runtime.validatePolicySnapshot(raw));
  assert.ok(Object.isFrozen(baseline.stages[1]));
  assert.equal(hash(baseline), hash(runtime.validatePolicySnapshot(baseline)));
});
