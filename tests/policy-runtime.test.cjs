const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { baselineSnapshot } = require("../tools/policy-release.cjs");
const ROOT = path.resolve(__dirname, "..");
test("runtime stages verified policies until next match and retains its current snapshot through hot handoff", async () => {
  const make = (id, defend, generation) => {
    const snapshot = JSON.parse(JSON.stringify(baselineSnapshot(ROOT))); snapshot.stages[1].defend = defend;
    return { id, generation, snapshot, bindings: { engineBundleHash: "ai", gameBundleHash: "game" } };
  };
  let release = make("first", 7, 1);
  const intervals = [];
  let failOutcome = true, posted = 0;
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sandbox = { window: { FCHotUpgradeVersion: { ai: { hash: "ai" }, game: { hash: "game" } } },
    console, localStorage: storage, location: { protocol: "http:", hostname: "127.0.0.1", search: "" },
    URLSearchParams, setTimeout: () => 1, clearTimeout() {}, setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
    async fetch(url) {
      if (url === "/ai-policy") return { ok: true, json: async () => ({ status: "ACTIVE", release }) };
      if (url === "/ai-policy/outcome") { posted++; return { ok: !failOutcome, json: async () => ({ recorded: true }) }; }
      return { ok: true, json: async () => ({}) };
    } };
  vm.createContext(sandbox);
  for (const file of ["ai-core.js", "ai-data.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox);
  let client = sandbox.window.TankPartnerAI;
  await client.ready; await client.refreshPolicyRelease();
  assert.equal(client.readPolicyRelease().activeId, null);
  client.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
  assert.equal(client.readPolicy(1).defend, 7);
  release = make("second", 8, 2);
  await client.refreshPolicyRelease();
  assert.equal(client.readPolicy(1).defend, 7);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8"), sandbox);
  client = sandbox.window.TankPartnerAI;
  await client.ready;
  assert.equal(client.readPolicy(1).defend, 7);
  await client.refreshPolicyRelease();
  client.finishMatch({ win: true, stage: 1, duration: 60 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.readPolicyRelease().pendingOutcomes, 1);
  failOutcome = false; intervals.at(-1)();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.readPolicyRelease().pendingOutcomes, 0);
  assert.ok(posted >= 2);
  client.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
  assert.equal(client.readPolicy(1).defend, 8);
  release = make("wrong-code", 9, 3); release.bindings.engineBundleHash = "different";
  await client.refreshPolicyRelease();
  client.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
  assert.equal(client.readPolicy(1).defend, 8);
});
