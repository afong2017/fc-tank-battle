// Read-only historical selection and deterministic, isolated V3 comparison.
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const database = new DatabaseSync(path.join(root, "ai-memory.db"), { readOnly: true });
const failed = database.prepare(`
  SELECT stage, COUNT(*) AS losses FROM matches
  WHERE result = 'lose' AND run_mode = 'NORMAL'
  GROUP BY stage ORDER BY losses DESC LIMIT 4
`).all();
database.close();
const stages = [...new Set([...failed.map(row => row.stage), 12])];
const seeds = process.argv.includes("--full") ? [42, 731] : [42];
const seconds = process.argv.includes("--full") ? 90 : 45;
const cases = [];
for (const stage of stages) for (const seed of seeds) {
  const env = { ...process.env,
    AI_BASELINE_FILE: path.join(root, "ai-core.js"),
    AI_CANDIDATE_V3_FILE: path.join(root, "ai-v3.js") };
  const output = execFileSync(process.execPath,
    [path.join(__dirname, "evaluate-ai.cjs"), String(seconds), String(seed), "", String(stage), "campaign"],
    { cwd: root, env, encoding: "utf8", timeout: 180000, maxBuffer: 4e6 });
  const [baseline, candidate] = output.trim().split(/\r?\n/).map(JSON.parse);
  cases.push({ stage, seed, baseline, candidate });
  console.log(`stage ${stage} seed ${seed}: CORE ${baseline.result}/${baseline.kills} kills/${baseline.deaths} deaths; `
    + `V3 ${candidate.result}/${candidate.kills} kills/${candidate.deaths} deaths`);
}
const regression = cases.some(({ baseline, candidate }) =>
  (baseline.result !== "lose" && candidate.result === "lose")
  || candidate.safetyViolations > baseline.safetyViolations
  || candidate.kills + 2 < baseline.kills);
const report = {
  selectedFromNormalModeLosses: failed,
  seconds, seeds, stages, accepted: !regression,
  cases: cases.map(({ stage, seed, baseline, candidate }) => ({ stage, seed,
    baseline: { result: baseline.result, kills: baseline.kills, deaths: baseline.deaths,
      safetyViolations: baseline.safetyViolations, controllerHash: baseline.controllerHash },
    candidate: { result: candidate.result, kills: candidate.kills, deaths: candidate.deaths,
      safetyViolations: candidate.safetyViolations, controllerHash: candidate.controllerHash } }))
};
fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
fs.writeFileSync(path.join(root, "test-results", "v3-comparison.json"), JSON.stringify(report, null, 2));
console.log(report.accepted ? "V3 passes this bounded gate" : "V3 rejected: regression on failure-heavy stages");
if (regression) process.exitCode = 1;
