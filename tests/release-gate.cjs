const fs = require("node:fs");

// This gate evaluates paired evidence only. It never installs a policy.
function assess(rows) {
  const reject = (reason) => ({ eligible: false, reason });
  if (!Array.isArray(rows) || !rows.length) return reject("missing-evidence");
  const pairs = new Map();
  const hashes = new Map();
  let physics = null;
  const metrics = ["time", "deaths", "loops", "stalls", "safetyViolations"];
  for (const row of rows) {
    if (!row || !["baseline", "candidate"].includes(row.version)
      || !/^[a-f0-9]{64}$/.test(row.coreHash || "")
      || !/^[a-f0-9]{64}$/.test(row.physicsHash || "")
      || !/^[a-f0-9]{64}$/.test(row.mapHash || "")
      || !Number.isInteger(row.seed) || row.seed < 0
      || !Number.isInteger(row.startingStage) || row.startingStage < 1 || row.startingStage > 35
      || !["campaign", "holdout"].includes(row.suite)
      || !["win", "lose"].includes(row.result)
      || !metrics.every(key => Number.isFinite(row[key]) && row[key] >= 0)) return reject("invalid-or-incomplete-evidence");
    if (physics && physics !== row.physicsHash) return reject("physics-mismatch");
    physics = row.physicsHash;
    if (hashes.has(row.version) && hashes.get(row.version) !== row.coreHash) return reject("mixed-core-versions");
    hashes.set(row.version, row.coreHash);
    const key = `${row.suite}:${row.startingStage}:${row.mapHash}:${row.seed}`;
    const pair = pairs.get(key) || {};
    if (pair[row.version]) return reject("duplicate-result");
    pair[row.version] = row;
    pairs.set(key, pair);
  }
  const coverage = new Map();
  const holdoutMaps = new Set();
  const campaignMaps = new Set();
  let improved = 0;
  let holdouts = 0;
  for (const { baseline: a, candidate: b } of pairs.values()) {
    if (!a || !b) return reject("unpaired-result");
    if (b.safetyViolations > 0) return reject("safety-violation");
    if (a.result === "win" && b.result !== "win") return reject("lost-baseline-win");
    const resourceMetrics = ["deaths", "loops", "stalls"];
    if (resourceMetrics.some(key => b[key] > a[key])) return reject("metric-regression");
    // A quick defeat is not an efficiency improvement.
    if (a.result === "win" && b.result === "win" && b.time > a.time + 1 / 60) return reject("slower-win");
    if ((a.result === "lose" && b.result === "win")
      || (a.result === "win" && b.result === "win" && b.time < a.time - 1 / 60)
      || (a.result === b.result && resourceMetrics.some(key => b[key] < a[key]))) improved++;
    if (a.suite === "campaign") {
      coverage.set(a.startingStage, (coverage.get(a.startingStage) || 0) + 1);
      campaignMaps.add(a.mapHash);
    } else {
      holdouts++;
      holdoutMaps.add(a.mapHash);
    }
  }
  if (coverage.size !== 35 || [...coverage.values()].some(count => count < 10)) return reject("insufficient-stage-coverage");
  if (holdouts < 30 || holdoutMaps.size < 3 || [...holdoutMaps].some(hash => campaignMaps.has(hash))) return reject("insufficient-independent-maps");
  if (improved < 7) return reject("insufficient-improvement");
  return { eligible: true, reason: "paired-gate-passed-not-published", pairs: pairs.size, improved };
}

module.exports = { assess };
if (require.main === module) {
  try {
    const report = assess(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.eligible ? 0 : 1;
  } catch {
    console.error("Invalid evidence file; publication denied.");
    process.exitCode = 1;
  }
}
