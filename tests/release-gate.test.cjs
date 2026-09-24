const test = require("node:test");
const assert = require("node:assert/strict");
const { assess } = require("./release-gate.cjs");
const hash = n => n.toString(16).padStart(64, "0");
function evidence() {
  const rows = [];
  for (let stage = 1; stage <= 38; stage++) for (let seed = 0; seed < 10; seed++) {
    for (const version of ["baseline", "candidate"]) rows.push({
      version, coreHash: hash(version === "baseline" ? 100 : 101), physicsHash: hash(102),
      mapHash: hash(stage), startingStage: Math.min(stage, 35), seed,
      suite: stage <= 35 ? "campaign" : "holdout", result: "win",
      time: version === "baseline" ? 60 : 59, deaths: 0, loops: 0, stalls: 0, safetyViolations: 0,
    });
  }
  return rows;
}
test("release gate requires paired complete campaign and independent map evidence", () => {
  assert.equal(assess(evidence()).eligible, true);
  assert.equal(assess([]).eligible, false);
  assert.equal(assess(evidence().slice(0, 2)).eligible, false);
  assert.equal(assess(evidence().slice(1)).reason, "unpaired-result");
});
test("release gate rejects regressions, invalid numbers, mixed physics and duplicate evidence", () => {
  for (const patch of [{ deaths: 1 }, { loops: 1 }, { stalls: 1 }, { safetyViolations: 1 },
    { result: "lose" }, { result: "timeout" }, { time: NaN }, { time: 61 }, { physicsHash: hash(999) }]) {
    const rows = evidence(); Object.assign(rows[1], patch);
    assert.equal(assess(rows).eligible, false, JSON.stringify(patch));
  }
  const rows = evidence(); rows.push(rows[0]);
  assert.equal(assess(rows).reason, "duplicate-result");
});
test("unchanged results cannot claim evolution and reused holdout maps cannot qualify", () => {
  const rows = evidence(); rows.forEach(row => row.time = 60);
  assert.equal(assess(rows).reason, "insufficient-improvement");
  const reused = evidence(); reused.filter(row => row.suite === "holdout").forEach(row => row.mapHash = hash(row.seed + 1));
  assert.equal(assess(reused).eligible, false);
});
