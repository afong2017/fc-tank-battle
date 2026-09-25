const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { AiDatabase } = require("../ai-database.js");

const root = path.join(__dirname, "..");
const game = fs.readFileSync(path.join(root, "game.js"), "utf8");

test("base history keeps the last 15 seconds at quarter-second resolution", () => {
  const start = game.indexOf("function captureBaseHistory() {");
  const end = game.indexOf("function damageBase(", start);
  const sandbox = { baseHistory: [], gameTime: 0, freezeClock: 0,
    player: null, player2: null, enemies: [], bullets: [],
    compactBaseHistoryTank: () => null };
  vm.createContext(sandbox);
  vm.runInContext(game.slice(start, end), sandbox);
  for (let tick = 0; tick <= 64; tick++) {
    sandbox.gameTime = tick * 0.25;
    sandbox.captureBaseHistory();
  }
  assert.equal(sandbox.baseHistory.length, 61);
  assert.equal(sandbox.baseHistory[0].time, 1);
  assert.equal(sandbox.baseHistory.at(-1).time, 16);
  assert.match(game, /baseHistoryClock = 0\.25;\s*captureBaseHistory\(\)/);
});

test("base snapshots retain fire intent, cooldowns, and the recent shot result", () => {
  const start = game.indexOf("function compactBaseHistoryTank(");
  const end = game.indexOf("function captureBaseHistory()", start);
  const sandbox = { gameTime: 12 };
  vm.createContext(sandbox);
  vm.runInContext(game.slice(start, end), sandbox);
  const tank = { alive: true, kind: "player", x: 100, y: 200, dir: "up",
    aiCachedAction: { fire: true }, cooldown: 0.12, turnCooldown: 0.2,
    lastAiShot: { time: 11.8, dir: "up", result: "unsafe" } };
  const snapshot = sandbox.compactBaseHistoryTank(tank);
  assert.equal(snapshot.fireRequested, true);
  assert.equal(snapshot.fireCooldown, 0.12);
  assert.equal(snapshot.turnCooldown, 0.2);
  assert.equal(snapshot.shot.result, "unsafe");
  sandbox.gameTime = 12.6;
  assert.equal(sandbox.compactBaseHistoryTank(tank).shot, null);
});

test("fire requests distinguish a safety rejection from a real shot", () => {
  const start = game.indexOf("function fireToward(");
  const end = game.indexOf("function perpendicularTurnDir(", start);
  const sandbox = {
    DIRS: { up: { x: 0, y: -1 } }, gameTime: 5,
    aiShotSafe: () => false, faceTankToward: () => true,
    emergencyCollateralShot: () => false, aiMeleeShot: () => null,
    fire: () => true, bullets: [], aiFirstHit: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(game.slice(start, end), sandbox);
  const tank = { enemy: false, dir: "up" };
  assert.equal(sandbox.fireToward(tank, "up", true, { target: {} }), false);
  assert.equal(tank.lastAiShot.result, "unsafe");
  sandbox.aiShotSafe = () => true;
  assert.equal(sandbox.fireToward(tank, "up", true, { target: {} }), true);
  assert.equal(tank.lastAiShot.result, "fired");
});

test("V3 persists a base-hit timeline and links it to the failed stage", () => {
  const start = game.indexOf("const v3AI = {");
  const end = game.indexOf("function resetAiTrainingDisplay()", start);
  const saved = new Map();
  const sandbox = {
    window: { TankPartnerAIV3: {} },
    localStorage: { setItem: (key, value) => saved.set(key, value) },
    V3_TEST_MATCHES_KEY: "matches", v3TestMatches: [],
    v3BaseFailures: [], v3CurrentBaseFailureId: null,
    stageEnemyDefeated: 14, killStats: { basic: 5, fast: 5, armor: 4 },
    p1Deaths: 1, p2Deaths: 0,
    currentRunContext: () => ({ mode: "NORMAL", speed: 1 }),
    saveV3BaseFailures: () => {}, syncV3BaseFailure: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(game.slice(start, end) + "\nglobalThis.adapter = v3AI;", sandbox);
  const timeline = Array.from({ length: 61 }, (_, index) => ({ time: index * 0.25 }));
  sandbox.adapter.recordExperience("enemy_killed", { stage: 3 });
  assert.equal(sandbox.v3BaseFailures.length, 0);
  sandbox.adapter.recordExperience("base_hit", {
    stage: 3, time: 224.5, reason: "enemy:fast", baseTimeline: timeline,
  });
  sandbox.adapter.finishMatch({ stage: 3, win: false, duration: 224.5 });
  assert.equal(sandbox.v3BaseFailures.length, 1);
  assert.equal(sandbox.v3BaseFailures[0].baseTimeline.length, 61);
  assert.equal(sandbox.v3BaseFailures[0].run.mode, "NORMAL");
  assert.equal(JSON.parse(saved.get("matches"))[0].baseFailureId, sandbox.v3BaseFailures[0].id);
});

test("SQLite stores V3 base failures separately and idempotently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tank-v3-base-"));
  const database = new AiDatabase(path.join(directory, "memory.db"));
  try {
    const failure = { id: "v3-1234567890-abc", at: 1234567890, stage: 3,
      time: 224.5, reason: "enemy:fast", baseTimeline: [{ time: 209.5 }, { time: 224.5 }] };
    database.saveV3BaseFailure(failure);
    database.saveV3BaseFailure(failure);
    const stored = database.readV3BaseFailures();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].baseTimeline.length, 2);
    assert.equal(database.stats().events, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
