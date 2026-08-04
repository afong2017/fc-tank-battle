const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const TILE = 32;

function loadEngine() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8"), sandbox);
  return sandbox.window.TankPartnerAIEngine.enhance({
    readMemory: () => ({ weights: { defend: 5, survive: 5, attack: 5, clear: 5 } }),
    recordExperience() {},
    syncMemoryFile() {},
  });
}

function loadData(oldMemory = null) {
  const values = new Map();
  if (oldMemory) values.set("fc-tank-battle.partner-ai", JSON.stringify(oldMemory));
  const localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const sandbox = {
    window: {},
    localStorage,
    location: { protocol: "file:", hostname: "", search: "" },
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8"), sandbox);
  return sandbox.window.TankPartnerAI;
}

function tank(kind, cellX, cellY, dir = "up") {
  return {
    kind,
    x: cellX * TILE + 2,
    y: cellY * TILE + 2,
    w: 28,
    h: 28,
    dir,
    speed: 90,
    baseSpeed: 90,
    alive: true,
    cooldown: 0,
    turnCooldown: 0,
    invuln: 0,
    box() { return { x: this.x, y: this.y, w: this.w, h: this.h }; },
  };
}

function enemy(cellX, cellY, kind = "basic") {
  return { ...tank(kind, cellX, cellY, "down"), enemy: true, speed: 72, hp: 1 };
}

function context(subject, friends, enemies, map, bonuses = []) {
  const base = { x: 12 * TILE, y: 22 * TILE, w: TILE, h: TILE };
  return {
    tank: subject,
    friends,
    enemies,
    reservedTargets: friends.map((friend) => friend.attackTarget).filter(Boolean),
    weights: { defend: 5, survive: 5, attack: 5, clear: 5 },
    bullets: [],
    allyFireReports: [],
    bonuses,
    map,
    mapVersion: 0,
    rows: 24,
    cols: 26,
    stage: 1,
    gameTime: 1,
    freezeTime: 0,
    base,
    baseGuard: { x: 11 * TILE, y: 21 * TILE, w: 4 * TILE, h: 3 * TILE },
    tileAt(x, y) { return map[y]?.[x] || "S"; },
    canFire() { return subject.cooldown <= 0 && subject.alive; },
    canMove() { return true; },
    canShoot() { return false; },
    canPredictShoot() { return false; },
    canDirectShoot() { return false; },
  };
}

function openMap() {
  return Array.from({ length: 24 }, () => Array(26).fill("."));
}

test("both allies lock the final enemy", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 20);
  const p2 = tank("player2", 14, 20);
  const last = enemy(5, 5);
  const map = openMap();
  const a1 = engine.createController("1P").decide(context(p1, [p2], [last], map));
  p1.attackTarget = a1.lockedTarget;
  const a2 = engine.createController("2P").decide(context(p2, [p1], [last], map));
  assert.equal(a1.lockedTarget, last);
  assert.equal(a2.lockedTarget, last);
});

test("point-blank enemy temporarily overrides a distant mission", () => {
  const engine = loadEngine();
  const p1 = tank("player", 11, 18);
  const p2 = tank("player2", 15, 20);
  const distant = enemy(2, 4);
  const contact = enemy(12, 18);
  const action = engine.createController("1P").decide(context(p1, [p2], [distant, contact], openMap()));
  assert.equal(action.lockedTarget, contact);
});

test("close combat keeps its committed target when another enemy is only slightly nearer", () => {
  const engine = loadEngine();
  const controller = engine.createController("1P");
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 20, 20);
  const committed = enemy(10, 7);
  committed.y = p1.y - TILE * 2.9;
  const distractor = enemy(12, 10);
  distractor.x = p1.x + TILE * 2.6;
  const first = context(p1, [p2], [committed, distractor], openMap());
  first.globalDirective = { target: committed, commitUntil: 2, hardCommit: true };
  assert.equal(controller.decide(first).lockedTarget, committed);
  const second = context(p1, [p2], [committed, distractor], openMap());
  second.gameTime = 1.1;
  assert.equal(controller.decide(second).lockedTarget, committed);
});

test("an edge-overlap close shot fires when the real bullet corridor can hit", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "right");
  const p2 = tank("player2", 20, 20);
  const close = enemy(12, 10);
  close.y += 12;
  const ctx = context(p1, [p2], [close], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "right" && target === close;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.lockedTarget, close);
  assert.equal(action.dir, "right");
  assert.equal(action.fire, true);
});

test("an aligned close fighter advances and fires in the same action", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "right");
  const p2 = tank("player2", 20, 20);
  const close = enemy(12, 10);
  const ctx = context(p1, [p2], [close], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "right" && target === close;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.dir, "right");
  assert.equal(action.fire, true);
  assert.equal(action.hold, false);
});

test("a close fighter turns without entering a stationary aim hold", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 20, 20);
  const close = enemy(12, 10);
  const ctx = context(p1, [p2], [close], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "right" && target === close;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.dir, "right");
  assert.equal(action.hold, false);
});

test("an aligned incoming shell is counter-fired before dodge", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 20, 20);
  const shooter = enemy(10, 6);
  const shell = { owner: shooter, enemy: true, x: p1.x + 11, y: p1.y - 100, w: 6, h: 6, dir: "down", speed: 230 };
  const ctx = context(p1, [p2], [shooter], openMap());
  ctx.bullets = [shell];
  ctx.canDirectShoot = (dir, target) => dir === "up" && target === shooter;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.mode, "core-counter-fire");
  assert.equal(action.dir, "up");
  assert.equal(action.fire, true);
});

test("an incoming shell is dodged when no reliable counter lane exists", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 20, 20);
  const shooter = enemy(13, 6);
  const shell = { owner: shooter, enemy: true, x: p1.x + 11, y: p1.y - 50, w: 6, h: 6, dir: "down", speed: 230 };
  const ctx = context(p1, [p2], [shooter], openMap());
  ctx.bullets = [shell];
  const action = engine.createController("1P").decide(ctx);
  assert.match(action.mode, /^core-evade-bullet/);
  assert.equal(action.fire, false);
});

test("counter-fire safety accepts an enemy shell collision before the shooter", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /function counterBulletShotSafe\(tank, intendedDir\)/);
  assert.match(source, /\^core-counter-\(\?:fire\|aim\|fire-critical\)\$/);
});

test("an armor target keeps the second shot after the first shot is confirmed", () => {
  const engine = loadEngine();
  const controller = engine.createController("1P");
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 20, 20);
  const armor = enemy(10, 8, "armor");
  armor.hp = 2;
  const first = context(p1, [p2], [armor], openMap());
  first.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  const firstAction = controller.decide(first);
  assert.equal(firstAction.fire, true);
  assert.equal(firstAction.lockedTarget, armor);

  p1.cooldown = 0.5;
  const confirmed = context(p1, [p2], [armor], openMap());
  confirmed.gameTime = 1.05;
  confirmed.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  controller.decide(confirmed);

  p1.cooldown = 0;
  const distractor = enemy(11, 10);
  const second = context(p1, [p2], [armor, distractor], openMap());
  second.gameTime = 1.6;
  second.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  const secondAction = controller.decide(second);
  assert.equal(secondAction.mode, "core-armor-volley");
  assert.equal(secondAction.lockedTarget, armor);
  assert.equal(secondAction.fire, true);
});

test("game-side direct fire scans with the real six-pixel bullet corridor", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /const probe = \{ x: x - 3, y: y - 3, w: 6, h: 6 \}/);
  assert.match(source, /const firstEnemy = enemies\.find[\s\S]{0,140}return firstEnemy === target/);
});

test("all ordinary AI fire keeps the base and its guard bricks protected", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /const safe = !action \|\| aiShotSafe\(tank, action, dir\)/);
  assert.match(source, /if \(shotFacesBaseGuard\(tank, intendedDir\)\) \{\s*return guaranteedBaseFacingShot\(tank, intendedDir, action\.target\)/);
  assert.match(source, /function guaranteedBaseFacingShot[\s\S]{0,180}!firstHitIsTargetEnemy\(tank, dir, target\)/);
  assert.match(source, /hit\.type === "tile" && hit\.tile === "B" && !hit\.baseGuard/);
  assert.match(source, /hit\.type === "tile" && hit\.baseGuard && \(hit\.tile === "B" \|\| hit\.tile === "E"\)/);
});

test("frozen nearby enemy overrides a farther committed mission", () => {
  const engine = loadEngine();
  const p1 = tank("player", 4, 4);
  const p2 = tank("player2", 20, 20, "left");
  const nearby = enemy(17, 20);
  const distant = enemy(20, 16);
  const ctx = context(p2, [p1], [distant, nearby], openMap());
  ctx.freezeTime = 5;
  ctx.globalDirective = { target: distant, commitUntil: 8, hardCommit: true };

  const action = engine.createController("2P").decide(ctx);

  assert.equal(action.lockedTarget, nearby);
  assert.match(action.mode, /^core-freeze-(?:contact|pointblank)/);
});

test("freeze pickup route aims at an ordinary blocking brick", () => {
  const engine = loadEngine();
  const p1 = tank("player", 5, 10, "up");
  const p2 = tank("player2", 20, 20);
  const map = openMap();
  map[10][6] = "B";
  const freeze = { type: "freeze", x: 7 * TILE + 8, y: 10 * TILE + 8, w: 16, h: 16, dead: false };
  const action = engine.createController("1P").decide(context(p1, [p2], [], map, [freeze]));
  assert.equal(action.mode, "core-freeze-pickup-clear-aim");
  assert.equal(action.dir, "right");
  assert.equal(action.hold, true);
});

test("held non-fire actions still invoke facing logic", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /if \(action\.fire\) fired = fireToward[\s\S]{0,160}else faceTankToward\(tank, action\.dir\)/);
  assert.match(source, /ai\?\.learn\("stuck", -0\.2\)/);
});

test("performance scores are isolated from staged combat policy tuning", () => {
  const dataSource = fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8");
  const gameSource = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  const coreSource = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(dataSource, /const POLICY_SAMPLE_SIZE = 20/);
  assert.match(dataSource, /status: accepted \? "ACCEPTED" : "ROLLED_BACK"/);
  assert.match(dataSource, /`S\$\{Math\.max[\s\S]{0,100}:\$\{runKey\}`/);
  assert.match(gameSource, /TankPartnerAI\?\.readPolicy\?\.\(stageIndex \+ 1, currentRunContext\(\)\)/);
  assert.doesNotMatch(gameSource, /ai\.memory\?\.weights/);
  assert.doesNotMatch(coreSource, /5 - performance/);
});

test("v2 scores migrate while policy tuning waits for a full isolated sample", () => {
  const api = loadData({
    coreDataVersion: 2,
    weights: { defend: 4.2, survive: 5.1, attack: 6.3, clear: 3.8 },
    bestWeights: { defend: 5, survive: 5, attack: 5, clear: 5 },
  });
  assert.equal(api.readMemory().coreDataVersion, 3);
  assert.equal(api.readMemory().weights.attack, 6.3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.readPolicy(1, { mode: "NORMAL", speed: 1 }))),
    { defend: 6.5, survive: 5, attack: 7, clear: 4 },
  );

  for (let game = 0; game < 20; game++) {
    api.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
    api.finishMatch({ win: false, stage: 1, duration: 120, run: { mode: "NORMAL", speed: 1 } });
  }
  const memory = api.readMemory();
  assert.equal(memory.lastPolicyDecision.status, "EVALUATING");
  assert.ok(memory.policyByContext["S1:NORMAL"]);
  assert.equal(memory.policyByContext["S1:TEST-4X"], undefined);
});

test("ally spacing never overrides pursuit movement", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.doesNotMatch(source, /formationSeparationDirection|core-formation-separate/);
});

test("nearby freeze pickup cannot be delayed by cached pursuit or combat wrappers", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /const pickupValid = state\?\.pickupDuty[\s\S]{0,180}: !freezeOpportunity/);
  assert.match(source, /bullet-intercept\|dodge\|evade\|avoid\|escape\|freeze-pickup/);
  assert.match(source, /if \(freeze && tileRange\(tank, freeze\) <= 3\)/);
  assert.match(source, /const crossingThreat = urgentFreezePickup \? null : crossingCandidate/);
  assert.doesNotMatch(source, /imminentPickupThreat/);
});

test("a newly spawned nearby freeze interrupts pursuit on the next decision", () => {
  const engine = loadEngine();
  const controller = engine.createController("1P");
  const p1 = tank("player", 5, 10, "up");
  const p2 = tank("player2", 20, 20);
  const foe = enemy(5, 2);
  const map = openMap();
  controller.decide(context(p1, [p2], [foe], map));

  const freeze = { type: "freeze", x: 6 * TILE + 8, y: 10 * TILE + 8, w: 16, h: 16, dead: false };
  const next = context(p1, [p2], [foe], map, [freeze]);
  next.gameTime = 1.01;
  const action = controller.decide(next);
  assert.match(action.mode, /^core-freeze-pickup/);
});

test("loop recovery replans instead of committing another orbit", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.doesNotMatch(source, /orbitBreak|core-orbit-break/);
  assert.match(source, /stableRouteTarget = null;[\s\S]{0,180}interceptPlan = null/);
  assert.match(source, /const progressCandidates = candidates\.filter[\s\S]{0,120}item\.targetDistance < currentDistance - 0\.5/);
  assert.match(source, /core-route-loop-(?:replan|progress|escape)/);
  assert.doesNotMatch(source, /if \(!moving \|\| action\?\.fire \|\| tacticalInterrupt\)/);
  assert.match(source, /progressCandidates\[0\]\?\.dir \|\| candidates\.find/);
});

test("version display removes seconds without weakening version comparison", () => {
  const source = fs.readFileSync(path.join(ROOT, "hot-upgrade.js"), "utf8");
  assert.match(source, /updatedAtBeijing:[\s\S]{0,160}replace\(\/\(\\d\{2\}:\\d\{2\}\):\\d\{2\}/);
  assert.match(source, /hash \|\| a\?\.\[key\]\?\.version/);
  assert.match(source, /digits\.slice\(8, 10\)\}:\$\{digits\.slice\(10, 12\)/);
  assert.match(source, /label\.textContent = `\$\{info\.developer\} \$\{minuteVersion\}`/);
});

test("lost firing lanes reposition and intercept clocks do not reset every frame", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.doesNotMatch(source, /core-shot-lane-lost/);
  assert.match(source, /shotLaneRepositionPlan\(ctx, ctx\.tank, action\.target\)/);
  assert.match(source, /reposition \? "core-shot-lane-reposition" : "core-shot-lane-replan"/);
  assert.match(source, /const createdAt = samePlan \? Number\(interceptPlan\.createdAt\) \|\| now : now/);
  assert.match(source, /interceptPlan = \{ \.\.\.planned, createdAt \}/);
});

test("freeze claims stay committed and stale movement cannot pass the pickup", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /const priorPickup = state\?\.pickupDuty/);
  assert.match(source, /ctx\.bonuses \|\| \[\]\)\.includes\(state\.pickupDuty\.bonus\)/);
  assert.match(source, /let pickupDuty = committedPickup && \(!urgentPickup \|\| committedPickup\.routeLength <= 3\)/);
  assert.match(source, /freezePickupDir === freshDir && now < freezePickupDirUntil/);
});

test("opening coverage interrupts only a distant freeze pickup", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /const criticalCoverage = threats\.filter/);
  assert.match(source, /threat\.dangerEta <= 5\.8/);
  assert.match(source, /if \(pickupDuty\?\.routeLength > 3\)/);
  assert.match(source, /criticalCoverage\.includes\(collectorThreat\)\) pickupDuty = null/);
  assert.match(source, /coverageEmergencyEnemies\.has\(selected\?\.enemy\)/);
});

test("only one accelerated shadow tab may run simulation", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /const SHADOW_TEST_LEASE_KEY = "fc-tank-battle\.shadow-test-owner"/);
  assert.match(source, /if \(state === "playing" && shadowTestLeaseHeld\)/);
  assert.match(source, /state !== "playing" \|\| !shadowTestLeaseHeld/);
  assert.match(source, /setInterval\(refreshShadowTestLease, SHADOW_TEST_HEARTBEAT_MS\)/);
  assert.match(source, /window\.addEventListener\("pagehide", releaseShadowTestLease\)/);
});

test("hidden shadow simulation uses a worker clock instead of a page timer", () => {
  const gameSource = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(ROOT, "ai-worker.js"), "utf8");
  assert.match(gameSource, /shadowClockWorker = new Worker\("ai-worker\.js"\)/);
  assert.match(gameSource, /type: "clock-start"/);
  assert.match(gameSource, /applyShadowClockSteps\(event\.data\.steps\)/);
  assert.doesNotMatch(gameSource, /hiddenTimer|runHiddenStep/);
  assert.match(workerSource, /\(Atomics\)\.waitAsync/);
  assert.match(workerSource, /type: "clock-tick"/);
});

test("hidden normal AI training shares the deterministic worker clock at 1x", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /function backgroundSimulationEnabled\(\) \{\s*return SHADOW_TEST_MODE \|\| aiTrainingEnabled;/);
  assert.match(source, /document\.hidden && backgroundSimulationEnabled\(\) && shadowTestLeaseHeld/);
  assert.match(source, /payload: \{ speed: INTERNAL_TEST_SPEED, fixedDt: FIXED_DT, intervalMs: 50 \}/);
});

test("shadow rendering is reduced while AI cadence stays deterministic", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /const INTERNAL_TEST_RENDER_INTERVAL_MS = 200/);
  assert.match(source, /const AI_DECISION_INTERVAL = 1 \/ 30/);
  assert.match(source, /tank\.aiDecisionClock = Math\.max\(0,/);
  assert.match(source, /tank\.aiCachedAction = action/);
  assert.match(source, /tank\.aiDecisionClock = AI_DECISION_INTERVAL/);
});

test("distance worker accelerates ranking without replacing exact pursuit paths", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /distanceWorker = new Worker\("ai-worker\.js"\)/);
  assert.match(source, /const workerResult = requestWorkerDistanceField\(ctx, goals\)/);
  assert.match(source, /else if \(workerResult\.available\)/);
  assert.match(source, /else \{\s*const path = findPath\(ctx, tankCell, goals\)/);
  assert.match(source, /const replannedRoute = findPath\(ctx, current, goals\)/);
});

test("friendly-fire avoidance does not dereference an absent escape plan", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.doesNotMatch(source, /forced\?\.dir === dodge \? forced\.moveScale/);
  assert.equal((source.match(/forced && forced\.dir === dodge \? forced\.moveScale : 1/g) || []).length, 2);
});

test("lower-stage wins cannot overwrite the best-stage record time", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8");
  assert.match(source, /const previousHighest = Math\.max/);
  assert.match(source, /if \(stage > previousHighest\) \{/);
  assert.match(source, /memory\.highestStageUpdatedAt = match\.endedAt/);
  assert.doesNotMatch(source, /memory\.highestStageCleared = Math\.max\(memory\.highestStageCleared, stage\)/);
});

test("hot upgrades hand off active matches and drain pending telemetry", () => {
  const dataSource = fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8");
  const upgradeSource = fs.readFileSync(path.join(ROOT, "hot-upgrade.js"), "utf8");
  assert.match(dataSource, /previous\?\.createHandoff\?\.\(\)/);
  assert.match(dataSource, /previous\.syncMemoryFileNow\?\.\(\)/);
  assert.match(dataSource, /pendingEvents: pendingEvents\.slice\(\)/);
  assert.match(dataSource, /ownsCurrentMatch/);
  assert.match(dataSource, /MATCH_HEARTBEAT_INTERVAL = 10000/);
  assert.match(dataSource, /SYNC_EVENT_BATCH_SIZE = 120/);
  assert.match(dataSource, /pendingEvents\.slice\(0, SYNC_EVENT_BATCH_SIZE\)/);
  assert.match(dataSource, /navigator\.sendBeacon\(`\$\{FILE_URL\}\/interrupt`/);
  assert.match(dataSource, /fetch\(`\$\{FILE_URL\}\/interrupt`[\s\S]{0,220}keepalive:\s*true/);
  assert.match(dataSource, /scheduleSyncRetry\(syncDirty \? MEMORY_SYNC_RETRY_DELAY : 0\)/);
  assert.match(upgradeSource, /await window\.TankPartnerAI\?\.ready/);
});

test("an in-flight sync survives a live data-module replacement", async () => {
  const values = new Map();
  const posts = [];
  let releaseFirstPost;
  const firstPost = new Promise((resolve) => { releaseFirstPost = resolve; });
  const sandbox = {
    window: {},
    localStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
    location: { protocol: "http:", hostname: "127.0.0.1", search: "" },
    URLSearchParams,
    console,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    fetch(url, options = {}) {
      if (options.method === "POST") {
        posts.push(JSON.parse(options.body));
        if (posts.length === 1) return firstPost;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ memory: {}, training: {}, experience: {} }),
      });
    },
  };
  vm.createContext(sandbox);
  const coreSource = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  const dataSource = fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8");
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(dataSource, sandbox);
  await sandbox.window.TankPartnerAI.ready;
  sandbox.window.TankPartnerAI.startMatch({ stage: 3 });
  sandbox.window.TankPartnerAI.recordExperience("enemy_killed", { stage: 3 });
  sandbox.window.TankPartnerAI.syncMemoryFileNow();
  sandbox.window.TankPartnerAI.recordExperience("ally_death", { stage: 3 });

  vm.runInContext(dataSource, sandbox);
  releaseFirstPost({ ok: true });
  await sandbox.window.TankPartnerAI.ready;

  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].experience.events.map((event) => event.type), ["enemy_killed"]);
  assert.deepEqual(posts[1].experience.events.map((event) => event.type), ["enemy_killed", "ally_death"]);
  assert.equal(posts[1].experience.currentMatch.stage, 3);
});

test("normal and shadow sessions keep independent active and interrupted matches", () => {
  const { AiDatabase } = require(path.join(ROOT, "ai-database.js"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fc-tank-db-"));
  const database = new AiDatabase(path.join(directory, "memory.db"));
  const match = (id, mode, speed) => ({
    id,
    sessionId: `${mode}-session`,
    stage: 1,
    startedAt: 100,
    lastActiveAt: 200,
    events: 0,
    counters: {},
    modeCounters: {},
    run: { mode, speed, muted: mode === "TEST" },
  });
  try {
    database.write({ sessionId: "normal-session", experience: { version: 3, games: 1, counters: {}, currentMatch: match("normal-1", "NORMAL", 1), events: [], matches: [] } });
    database.write({ sessionId: "test-session", experience: { version: 3, games: 1, counters: {}, currentMatch: match("test-1", "TEST", 4), events: [], matches: [] } });
    assert.equal(database.activeMatches().filter((item) => item.status === "active").length, 2);

    database.interruptMatch({ sessionId: "test-session", duration: 18.1, match: match("test-1", "TEST", 4) });
    const interrupted = database.activeMatches().find((item) => item.id === "test-1");
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.duration, 18.1);

    database.write({ sessionId: "normal-session", experience: { version: 3, games: 1, counters: {}, currentMatch: null, events: [], matches: [{ ...match("normal-1", "NORMAL", 1), result: "win", duration: 30, endedAt: 300 }] } });
    assert.equal(database.activeMatches().some((item) => item.id === "normal-1"), false);
    assert.equal(database.activeMatches().some((item) => item.id === "test-1"), true);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite is the single completed-game counter and ignores duplicate match uploads", () => {
  const { AiDatabase } = require(path.join(ROOT, "ai-database.js"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fc-tank-count-"));
  const database = new AiDatabase(path.join(directory, "memory.db"));
  const completed = {
    id: "completed-1", stage: 1, result: "win", duration: 30,
    startedAt: 100, endedAt: 200, events: 0, counters: {}, modeCounters: {},
    run: { mode: "NORMAL", speed: 1, muted: false },
  };
  try {
    database.write({
      memory: { games: 99 }, training: { games: 99, seconds: 10 },
      experience: { version: 3, games: 99, counters: {}, events: [], matches: [completed] },
    });
    database.write({
      memory: { games: 1 }, training: { games: 1, seconds: 11 },
      experience: { version: 3, games: 1, counters: {}, events: [], matches: [completed] },
    });
    const restored = database.read(true);
    assert.equal(restored.canonicalGames, 1);
    assert.equal(restored.training.games, 1);
    assert.equal(restored.memory.games, 1);
    assert.equal(restored.experience.games, 1);
    assert.equal(database.stats().matchLimit, 100000);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
