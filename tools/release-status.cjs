const path = require("node:path");
const { ReleaseStore } = require("./policy-release.cjs");
const store = new ReleaseStore(path.resolve(__dirname, ".."));
try {
  if (process.argv.includes("--rollback")) console.log(JSON.stringify(store.rollback("operator-request"), null, 2));
  else { const current = store.current(); console.log(JSON.stringify({ status: current.status,
    generation: current.generation, activeId: current.release?.id || null, activeGeneration: current.release?.generation || 0 }, null, 2)); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
