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

test("point-blank target fires immediately despite a conflicting global assignment", () => {
  const engine = loadEngine();
  const defender = tank("player", 7, 10, "left");
  const close = enemy(8, 10);
  const distant = enemy(12, 20);
  const ctx = context(defender, [], [distant, close], openMap());
  ctx.meleeShot = (dir, target) => dir === "right" && target === close
    ? { type: "enemy", target: close } : null;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.mode, "core-melee-direct");
  assert.equal(action.dir, "right");
  assert.equal(action.fire, true);
  assert.equal(action.target, close);
});

test("point-blank repositioning keeps one committed direction across replans", () => {
  const engine = loadEngine();
  const defender = tank("player", 7, 10, "left");
  const close = enemy(8, 11);
  const ctx = context(defender, [], [close], openMap());
  ctx.meleeShot = () => null;
  const controller = engine.createController("1P");
  const first = controller.decide(ctx);
  ctx.gameTime += 0.1;
  const second = controller.decide(ctx);
  assert.equal(first.mode, "core-melee-route");
  assert.equal(second.mode, "core-melee-route");
  assert.equal(second.dir, first.dir);
});

test("unreachable freeze pickup does not invalidate global analysis every frame", () => {
  const engine = loadEngine();
  const defender = tank("player", 7, 10);
  const map = openMap();
  const bonus = { x: 10 * TILE + 2, y: 10 * TILE + 2, w: 28, h: 28, type: "freeze", dead: false };
  for (const [x, y] of [[9, 10], [11, 10], [10, 9], [10, 11]]) map[y][x] = "S";
  const ctx = context(defender, [], [], map, [bonus]);
  const first = engine.previewGlobalBattle(ctx, 10);
  assert.equal(first.pickupDuty, null);
  assert.equal(engine.previewGlobalBattle(ctx, 10.01), first);
  assert.notEqual(engine.previewGlobalBattle(ctx, 10.3), first);
  ctx.mapVersion++;
  map[10][9] = ".";
  const opened = engine.previewGlobalBattle(ctx, 10.31);
  assert.equal(opened.pickupDuty?.bonus, bonus);
});

test("a newly appeared freeze pickup immediately invalidates a cached analysis", () => {
  const engine = loadEngine();
  const defender = tank("player", 7, 10);
  const ctx = context(defender, [], [], openMap());
  const first = engine.previewGlobalBattle(ctx, 10);
  const bonus = { x: 8 * TILE + 2, y: 10 * TILE + 2, w: 28, h: 28, type: "freeze", dead: false };
  ctx.bonuses.push(bonus);
  const second = engine.previewGlobalBattle(ctx, 10.01);
  assert.notEqual(second, first);
  assert.equal(second.pickupDuty?.bonus, bonus);
});

test("global assignments refresh on ally death and respawn without waiting for the timer", () => {
  const engine = loadEngine();
  const p1 = tank("player", 8, 18);
  const p2 = tank("player2", 18, 18);
  const ctx = context(p1, [p2], [], openMap());
  const first = engine.previewGlobalBattle(ctx, 10);
  assert.equal(engine.previewGlobalBattle(ctx, 10.01), first);
  p2.alive = false;
  const dead = engine.previewGlobalBattle(ctx, 10.02);
  assert.notEqual(dead, first);
  assert.equal(dead.assignments.has(p2), false);
  const replacement = tank("player2", 18, 22);
  ctx.friends = [replacement];
  const respawn = engine.previewGlobalBattle(ctx, 10.03);
  assert.notEqual(respawn, dead);
  assert.equal(respawn.assignments.has(replacement), true);
});

test("two on-time defenders retain separate critical targets as their costs cross", () => {
  const engine = loadEngine();
  const p1 = tank("player", 11, 2);
  const p2 = tank("player2", 15, 2);
  const left = enemy(12, 2);
  const right = enemy(14, 2);
  left.dir = "up";
  right.dir = "up";
  const ctx = context(p1, [p2], [left, right], openMap());
  const first = engine.previewGlobalBattle(ctx, 1);
  assert.equal(first.assignments.get(p1).target, left);
  assert.equal(first.assignments.get(p2).target, right);
  p1.x = 15 * TILE + 2;
  p2.x = 10 * TILE + 2;
  ctx.gameTime = 1.4;
  const second = engine.previewGlobalBattle(ctx, 1.4);
  const leftThreat = second.threats.find((threat) => threat.enemy === left);
  const rightThreat = second.threats.find((threat) => threat.enemy === right);
  assert.ok(leftThreat.responseEtas.get(p1) <= leftThreat.responseDeadline);
  assert.ok(leftThreat.responseDeadline - leftThreat.responseEtas.get(p1) >= 0.8,
    `${leftThreat.responseDeadline}:${leftThreat.responseEtas.get(p1)}`);
  assert.ok(rightThreat.responseEtas.get(p2) <= rightThreat.responseDeadline);
  assert.equal(second.assignments.get(p1).target, left);
  assert.equal(second.assignments.get(p2).target, right);
});

test("critical ownership transfers when the original defender misses the deadline", () => {
  const engine = loadEngine();
  const p1 = tank("player", 11, 18);
  const p2 = tank("player2", 15, 18);
  const left = enemy(12, 15);
  const right = enemy(14, 15);
  const ctx = context(p1, [p2], [left, right], openMap());
  const first = engine.previewGlobalBattle(ctx, 1);
  assert.equal(first.assignments.get(p1).target, left);
  assert.equal(first.assignments.get(p2).target, right);
  p1.x = 14 * TILE + 2;
  p2.x = 12 * TILE + 2;
  ctx.gameTime = 1.4;
  const second = engine.previewGlobalBattle(ctx, 1.4);
  const leftThreat = second.threats.find((threat) => threat.enemy === left);
  assert.ok(leftThreat.responseEtas.get(p1) > leftThreat.responseDeadline);
  assert.ok(leftThreat.responseEtas.get(p2) <= leftThreat.responseDeadline);
  assert.equal(second.assignments.get(p2).target, left);
  assert.equal(second.assignments.get(p1).target, right);
});

test("new visible enemies invalidate global analysis but array replacement does not", () => {
  const engine = loadEngine();
  const p1 = tank("player", 8, 18);
  const ctx = context(p1, [], [], openMap());
  const first = engine.previewGlobalBattle(ctx, 10);
  const intruder = enemy(8, 16);
  ctx.enemies = [intruder];
  const second = engine.previewGlobalBattle(ctx, 10.01);
  assert.notEqual(second, first);
  assert.equal(second.assignments.get(p1).target, intruder);
  ctx.enemies = [...ctx.enemies];
  assert.equal(engine.previewGlobalBattle(ctx, 10.02), second);
  const reset = engine.previewGlobalBattle(ctx, 0);
  assert.notEqual(reset, second, "a restored simulation clock cannot reuse a future assignment");
  assert.equal(reset.analyzedAt, 0);
});

test("kill estimates distinguish remaining armor health and frozen versus moving targets", () => {
  const engine = loadEngine();
  const ally = tank("player", 8, 10);
  ally.fireDelay = 0.42;
  const basic = enemy(8, 5);
  const fast = enemy(8, 5, "fast");
  const armor = enemy(8, 5, "armor");
  armor.hp = 2;
  const eta = (target, freeze = 0) => engine.previewLethalShotEta(ally, target, 0, 310, freeze);
  assert.equal(eta(basic), 1);
  assert.equal(eta(fast), 1);
  assert.equal(eta(armor), 1.72);
  assert.equal(eta(armor, 2), 1.42);
  assert.equal(eta(armor, 0.5), 1.72);
  armor.hp = 1;
  assert.equal(eta(armor), 1);
  armor.hp = 4;
  assert.equal(eta(armor, 5), 2.26);
});

test("nearby freeze routes cross side boundaries without crossing protected bricks", () => {
  const engine = loadEngine();
  const ally = tank("player", 11, 10);
  const bonus = { x: 13 * TILE + 2, y: 10 * TILE + 2, w: 28, h: 28, type: "freeze" };
  const ctx = context(ally, [], [], openMap(), [bonus]);
  ctx.aiSideRole = "LEFT";
  const path = engine.previewFreezePath(ctx, ally, bonus);
  assert.equal(path.length, 3);
  assert.equal(path[path.length - 1].x, 13);
  ctx.map[10][12] = "S";
  ctx.mapVersion++;
  const detour = engine.previewFreezePath(ctx, ally, bonus);
  assert.ok(detour.length > 3);
  assert.ok(detour.every(cell => !(cell.x === 12 && cell.y === 10)));
});

test("a blocked firing position relocates instead of declaring the current cell reached", () => {
  const engine = loadEngine();
  const ally = tank("player", 8, 10);
  const map = openMap();
  map[10][9] = "S";
  const ctx = context(ally, [], [enemy(10, 10)], map);
  const goals = [{ x: 8, y: 10 }, { x: 10, y: 10 }];
  const route = engine.previewRelocationPath(ctx, goals);
  assert.ok(route.length > 3);
  assert.equal(route[route.length - 1].x, 10);
  assert.ok(route.every(cell => !(cell.x === 9 && cell.y === 10)));
  assert.equal(engine.previewRelocationPath(ctx, [goals[0]]).length, 0);
  for (const [x, y] of [[7, 10], [8, 9], [8, 11]]) map[y][x] = "S";
  assert.equal(engine.previewRelocationPath(ctx, goals).length, 0);
});

test("unseen layouts expose side and lower base entrances when the upper route is closed", () => {
  const engine = loadEngine();
  for (const [cols, rows, gx, gy] of [[26, 24, 11, 15], [18, 20, 3, 8], [30, 28, 19, 10]]) {
    const map = Array.from({ length: rows }, () => Array(cols).fill("."));
    const ctx = context(tank("player", 2, 2), [], [], map);
    ctx.cols = cols; ctx.rows = rows;
    ctx.baseGuard = { x: gx * TILE, y: gy * TILE, w: 4 * TILE, h: 3 * TILE };
    ctx.base = { x: (gx + 1) * TILE, y: (gy + 1) * TILE, w: TILE, h: TILE };
    for (let x = gx - 1; x <= gx + 4; x++) map[gy - 1][x] = "S";
    const goals = engine.previewMapEntryGoals(ctx);
    assert.ok(goals.some(g => g.x === gx - 1 && g.y === gy));
    assert.ok(goals.some(g => g.x === gx + 4 && g.y === gy));
    assert.ok(goals.some(g => g.y === gy + 3));
    assert.ok(goals.every(g => map[g.y][g.x] !== "S"));
  }
});

test("enemy base approach uses a nearby side opening even when the top is open", () => {
  const engine = loadEngine();
  const attacker = enemy(8, 23);
  const map = openMap();
  for (let y = 21; y <= 23; y++) {
    map[y][11] = "B";
    map[y][14] = "B";
  }
  map[23][12] = "B";
  map[23][13] = "B";
  const ctx = context(tank("player", 12, 18), [], [attacker], map);
  assert.equal(engine.previewBaseDefenseProfile(ctx, attacker).baseRoute.at(-1).y, 20,
    "intact guard walls must keep the established top approach");
  map[22][11] = ".";
  ctx.mapVersion++;
  const route = engine.previewBaseDefenseProfile(ctx, attacker).baseRoute;
  assert.ok(route.length >= 2);
  assert.deepEqual({ x: route.at(-1).x, y: route.at(-1).y }, { x: 10, y: 22 });
  assert.ok(engine.previewMapEntryGoals(ctx).every((cell) => cell.y === 20),
    "normal defender staging still uses the upper entrance");
});

test("whole-map base danger field follows reachable lanes and invalidates on terrain changes", () => {
  const engine = loadEngine();
  const map = openMap();
  const attacker = enemy(8, 10);
  const ctx = context(tank("player", 12, 18), [], [attacker], map);
  for (let y = 0; y < ctx.rows; y++) map[y][10] = "S";
  const sealed = engine.previewBaseDangerField(ctx, attacker.speed);
  assert.equal(sealed.distances.length, ctx.cols * ctx.rows);
  assert.equal(sealed.distances[10 * ctx.cols + 8], Infinity);
  assert.equal(engine.previewBaseDangerField(ctx, attacker.speed), sealed);
  map[10][10] = ".";
  ctx.mapVersion++;
  const opened = engine.previewBaseDangerField(ctx, attacker.speed);
  assert.notEqual(opened, sealed);
  assert.ok(Number.isFinite(opened.distances[10 * ctx.cols + 8]));
  assert.ok(Number.isFinite(engine.previewBaseDefenseProfile(ctx, attacker).fieldEta));
  const fast = engine.previewBaseDangerField(ctx, 105);
  assert.notEqual(fast, opened);
  assert.equal(engine.previewBaseDangerField(ctx, attacker.speed), opened);
});

test("whole-map danger advances distant threat ranking without changing urgent deadlines", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 18);
  const attacker = enemy(8, 6);
  const ctx = context(defender, [], [attacker], openMap());
  const responseEtas = new WeakMap([[defender, 6]]);
  const threat = {
    enemy: attacker, defenseTier: 3, dangerEta: 12, responseDeadline: 11,
    baseDistance: 400, crossed: false, fast: false, direct: null,
    responseEtas, fieldEta: 8,
  };
  const distant = engine.previewGlobalAssignmentCost(ctx, defender, threat);
  const nearerLane = engine.previewGlobalAssignmentCost(ctx, defender, { ...threat, fieldEta: 5 });
  assert.ok(nearerLane < distant);
  const urgent = { ...threat, defenseTier: 2 };
  assert.equal(engine.previewGlobalAssignmentCost(ctx, defender, urgent),
    engine.previewGlobalAssignmentCost(ctx, defender, { ...urgent, fieldEta: 5 }));
});

test("terrain learning keys transfer across stage numbers and react to cleared obstacles", () => {
  const engine = loadEngine();
  const ctx = context(tank("player", 8, 10), [], [], openMap());
  const open = engine.previewTerrainKey(ctx);
  ctx.stage = 35;
  assert.equal(engine.previewTerrainKey(ctx), open);
  ctx.map[10][9] = "S";
  const wall = engine.previewTerrainKey(ctx);
  assert.notEqual(wall, open);
  ctx.map[10][9] = "W";
  assert.notEqual(engine.previewTerrainKey(ctx), wall);
  ctx.map[10][9] = ".";
  assert.equal(engine.previewTerrainKey(ctx), open);
});

test("route following finishes tight corners without centering open turns", () => {
  const engine = loadEngine();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ally = tank("player", 10, 10);
    const ctx = context(ally, [], [], openMap());
    const route = [{ x: 10 - dx, y: 10 - dy }, { x: 10, y: 10 },
      { x: 10 + dy, y: 10 + dx }];
    ally.x -= dx * 10;
    ally.y -= dy * 10;
    assert.equal(engine.previewRejoinPath(ctx, route).length, 2, "open turns stay free");
    ctx.map[10 - dy + dx][10 - dx + dy] = "S";
    const early = engine.previewRejoinPath(ctx, route);
    assert.equal(early.length, 3, `${dx},${dy}: retain unfinished leg`);
    ally.x += dx * 10;
    ally.y += dy * 10;
    assert.equal(engine.previewRejoinPath(ctx, route).length, 2);
    ally.x += dx * 3;
    ally.y += dy * 3;
    assert.equal(engine.previewRejoinPath(ctx, route).length, 2, "never reverse after passing the waypoint");
  }
});

test("visible simulation preserves elapsed time at 20 FPS without changing physics steps", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  const start = source.indexOf("function simulationFrameElapsed(");
  const end = source.indexOf("function applyShadowClockSteps(", start);
  const steps = [];
  const sandbox = {
    lastTime: 0, document: { hidden: false }, requestAnimationFrame() {},
    refreshPad() {}, padJustPressed() { return false; }, pressed: { clear() {} },
    state: "playing", shadowTestLeaseHeld: true, INTERNAL_TEST_SPEED: 1,
    FIXED_DT: 1 / 60, updateAccumulator: 0, update(dt) { steps.push(dt); },
    SHADOW_TEST_MODE: false, INTERNAL_TEST_RENDER_INTERVAL_MS: 50,
    NORMAL_RENDER_INTERVAL_MS: 1000 / 60, lastDrawTime: 0, draw() {},
    padNow: [], padPrev: [],
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  for (let time = 50; time <= 1000; time += 50) sandbox.loop(time);
  assert.equal(steps.length, 60);
  assert.ok(steps.every((dt) => dt === 1 / 60));
  sandbox.loop(10000);
  assert.equal(steps.length, 60, "a suspended tab must not replay nine seconds");
});

test("final defense arbitration does not reuse a cached search posture", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  const start = source.indexOf("function advisorGlobalControlPlan(");
  const block = source.slice(start, source.indexOf("const proposals", start));
  assert.match(block, /const posture = advisorDefensePosture\(ctx, tank\)/);
  assert.doesNotMatch(block, /tacticalAdvisorPostures\.get/);
});

test("joint defense keeps the versatile ally available for the second deadline", () => {
  const engine = loadEngine();
  const result = engine.previewDefenseCoverage([
    [{ eta: 1, cost: 100 }, { eta: 2, cost: 200 }],
    [{ eta: 2, cost: 200 }, { eta: 8, cost: 800 }],
  ], [3, 3]);
  assert.deepEqual(Array.from(result.owners), [1, 0]);
  assert.equal(result.score[0], 0);
});

test("joint defense prioritizes reachable deadlines over a cheaper late pair", () => {
  const engine = loadEngine();
  const result = engine.previewDefenseCoverage([
    [{ eta: 1, cost: -10000 }, { eta: 2, cost: 50 }],
    [{ eta: 2, cost: 50 }, { eta: Infinity, cost: -10000 }],
  ], [3, 3]);
  assert.deepEqual(Array.from(result.owners), [1, 0]);
});

test("joint defense handles a lone defender and unreachable routes deterministically", () => {
  const engine = loadEngine();
  const result = engine.previewDefenseCoverage([[{ eta: Infinity, cost: 250000 }]], [2]);
  assert.deepEqual(Array.from(result.owners), [0]);
  assert.equal(result.score[0], 1);
  assert.equal(engine.previewDefenseCoverage([], []).owners.length, 0);
});

test("shot feedback never treats an unfired command as a miss", () => {
  const api = loadEngine();
  const tracker = api.createShotFeedbackTracker();
  const defender = tank("player", 8, 16);
  const foe = enemy(8, 10);
  const ctx = context(defender, [], [foe], openMap());
  tracker.observe(ctx);
  tracker.expect(ctx, { fire: true, dir: "up", target: foe });
  ctx.gameTime = 4;
  assert.equal(tracker.observe(ctx).length, 0);
});

test("shot feedback observes real projectiles once and waits for travel time", () => {
  const tracker = loadEngine().createShotFeedbackTracker();
  const defender = tank("player", 8, 16);
  const foe = enemy(8, 10);
  const ctx = context(defender, [], [foe], openMap());
  tracker.observe(ctx);
  tracker.expect(ctx, { fire: true, dir: "up", target: foe });
  ctx.gameTime += 0.016;
  ctx.bullets.push({ owner: defender, x: defender.x + 11, y: defender.y - 3, w: 6, h: 6, dir: "up", speed: 310 });
  const launched = tracker.observe(ctx);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].outcome, "launched");
  assert.equal(tracker.observe(ctx).length, 0);
  ctx.gameTime = launched[0].verifyAt - 0.01;
  assert.equal(tracker.observe(ctx).length, 0);
  ctx.gameTime += 0.02;
  assert.equal(tracker.observe(ctx)[0].outcome, "miss");
  assert.equal(tracker.observe(ctx).length, 0);
});

test("shot feedback distinguishes target movement and damage and ignores teammate shells", () => {
  for (const outcome of ["target-moved", "target-damaged"]) {
    const tracker = loadEngine().createShotFeedbackTracker();
    const defender = tank("player", 8, 16);
    const friend = tank("player2", 9, 16);
    const foe = enemy(8, 10, "armor");
    foe.hp = 2;
    const ctx = context(defender, [friend], [foe], openMap());
    tracker.observe(ctx);
    tracker.expect(ctx, { fire: true, dir: "up", target: foe });
    ctx.bullets.push({ owner: friend, dir: "up", x: 260, y: 480, w: 6, h: 6 });
    assert.equal(tracker.observe(ctx).length, 0);
    ctx.bullets.push({ owner: defender, dir: "up", x: 260, y: 480, w: 6, h: 6 });
    const launched = tracker.observe(ctx)[0];
    if (outcome === "target-damaged") foe.hp--;
    else foe.x += 16;
    ctx.gameTime = launched.verifyAt + 0.01;
    assert.equal(tracker.observe(ctx)[0].outcome, outcome);
  }
});

test("shot feedback resets on stage replacement and excludes clearing shots", () => {
  const tracker = loadEngine().createShotFeedbackTracker();
  const defender = tank("player", 8, 16);
  const foe = enemy(8, 10);
  const ctx = context(defender, [], [foe], openMap());
  tracker.observe(ctx);
  tracker.expect(ctx, { fire: true, dir: "up", target: foe, mode: "core-route-clear" });
  ctx.bullets.push({ owner: defender, dir: "up", x: 260, y: 480, w: 6, h: 6 });
  assert.equal(tracker.observe(ctx).length, 0);
  tracker.expect(ctx, { fire: true, dir: "up", target: foe });
  ctx.map = openMap();
  ctx.gameTime = 0;
  assert.equal(tracker.observe(ctx).length, 0);
});

test("seeded two-defender scenarios maximize deadline coverage", () => {
  const engine = loadEngine();
  let seed = 39127;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 200; i++) {
    const matrix = Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => ({ eta: random() * 12, cost: random() * 10000 })));
    const deadlines = [random() * 8, random() * 8];
    const expected = Math.min(
      Number(matrix[0][0].eta > deadlines[0]) + Number(matrix[1][1].eta > deadlines[1]),
      Number(matrix[1][0].eta > deadlines[0]) + Number(matrix[0][1].eta > deadlines[1]),
    );
    const result = engine.previewDefenseCoverage(matrix, deadlines);
    assert.equal(result.score[0], expected);
    assert.notEqual(result.owners[0], result.owners[1]);
  }
});

test("bullet forecast accounts for stopping at a steel wall", () => {
  const engine = loadEngine();
  const p = tank("player", 8, 10, "right");
  const ctx = context(p, [], [], openMap());
  ctx.map[10][9] = "S";
  ctx.bullets = [{ x: p.x + 11, y: p.y - 120, w: 6, h: 6, dir: "down", enemy: true, speed: 230 }];
  assert.ok(engine.previewMovementBulletThreat(ctx, "right", 0.8));
  ctx.map[10][9] = ".";
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8), null);
});

test("continuous bullet forecast catches immediate close contact", () => {
  const engine = loadEngine();
  const p = tank("player", 8, 10, "right");
  const ctx = context(p, [], [], openMap());
  ctx.bullets = [{ x: p.x + 11, y: p.y - 5, w: 6, h: 6, dir: "down", enemy: true, speed: 230 }];
  const threat = engine.previewMovementBulletThreat(ctx, "right", 0.8);
  assert.ok(threat && threat.eta < 0.06);
});

test("movement forecast includes teammate shells but never the tank's own shells", () => {
  const engine = loadEngine();
  const p = tank("player", 8, 10, "right");
  const ally = tank("player2", 9, 5, "down");
  const ctx = context(p, [ally], [], openMap());
  const bullet = { x: p.x + 50, y: p.y - 120, w: 6, h: 6,
    dir: "down", enemy: false, owner: ally, speed: 310 };
  ctx.bullets = [bullet];
  assert.ok(engine.previewMovementBulletThreat(ctx, "right", 0.8));
  bullet.owner = p;
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8), null);
  bullet.owner = ally;
  ally.alive = false;
  assert.ok(engine.previewMovementBulletThreat(ctx, "right", 0.8),
    "a fired shell survives its owner's destruction");
  bullet.dead = true;
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8), null);
});

test("ready ally fire announcements warn about crossing paths before launch", () => {
  const engine = loadEngine();
  const p = tank("player", 8, 10, "right");
  const ally = tank("player2", 9, 5, "down");
  const ctx = context(p, [ally], [], openMap());
  const report = { x: p.x + 50, y: p.y - 120, w: 6, h: 6,
    dir: "down", owner: ally, speed: 310, phase: "aim", ttl: 0.32 };
  ctx.allyFireReports = [report];
  assert.ok(engine.previewMovementBulletThreat(ctx, "right", 0.8));
  ally.cooldown = 0.2;
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8), null);
  ally.cooldown = 0;
  report.ttl = 0;
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8), null);
  report.ttl = 0.3;
  report.phase = "fire";
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8), null,
    "an old launch report cannot create a second shell at the muzzle");
});

test("shared projectile forecast chooses the earliest enemy or teammate collision", () => {
  const engine = loadEngine();
  const p = tank("player", 8, 10, "right");
  const ally = tank("player2", 9, 5, "down");
  const ctx = context(p, [ally], [], openMap());
  const friendly = { x: p.x + 50, y: p.y - 120, w: 6, h: 6,
    dir: "down", enemy: false, owner: ally, speed: 310 };
  const hostile = { x: p.x + 11, y: p.y - 5, w: 6, h: 6,
    dir: "down", enemy: true, speed: 230 };
  ctx.bullets = [friendly, hostile];
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8).bullet, hostile);
  ctx.bullets = [friendly];
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.8).bullet, friendly);
});

test("open return corridors avoid centering turns but steel corners still require alignment", () => {
  const engine = loadEngine();
  const p = tank("player", 8, 10, "down");
  p.x += 8;
  const ctx = context(p, [], [], openMap());
  const path = [{ x: 8, y: 10 }, { x: 8, y: 11 }];
  assert.equal(engine.previewRouteStep(ctx, path).aligning, false);
  ctx.map[11][9] = "S";
  assert.equal(engine.previewRouteStep(ctx, path).aligning, true);
});

test("a shell inside the demolished guard remains a threat to the bare base", () => {
  const engine = loadEngine();
  const p = tank("player", 10, 20);
  const ctx = context(p, [], [], openMap());
  const bullet = { x: ctx.base.x + 10, y: ctx.baseGuard.y + 10, w: 6, h: 6, dir: "down", speed: 230, enemy: true };
  const threat = engine.previewBaseProjectileThreat(ctx, bullet);
  assert.ok(threat);
  assert.equal(threat.exposedBase, true);
  assert.equal(threat.guard, ctx.base);
  assert.ok(threat.eta > 0);
});

test("intact brick or steel never counts as an exposed base firing lane", () => {
  const engine = loadEngine();
  const ctx = context(tank("player", 10, 20), [], [], openMap());
  const bullet = { x: ctx.base.x + 10, y: 19 * TILE, w: 6, h: 6, dir: "down", speed: 230, enemy: true };
  ctx.map[21][12] = "B";
  assert.equal(engine.previewBaseProjectileThreat(ctx, bullet)?.exposedBase, false);
  ctx.map[20][12] = "S";
  assert.equal(engine.previewBaseProjectileThreat(ctx, bullet), null);
});

test("rejoining a displaced route preserves its firing endpoint before fallback goals", () => {
  const engine = loadEngine();
  const ctx = context(tank("player", 7, 10), [], [], openMap());
  const route = [{ x: 8, y: 10 }, { x: 8, y: 11 }, { x: 8, y: 12 }];
  const restored = engine.previewRejoinPath(ctx, route, [{ x: 7, y: 10 }]);
  assert.equal(restored.at(-1).x, 8);
  assert.equal(restored.at(-1).y, 12);
  ctx.map[12][8] = "S";
  const fallback = engine.previewRejoinPath(ctx, route, [{ x: 7, y: 10 }]);
  assert.equal(fallback.at(-1).x, 7);
});

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

test("two advanced allies take separate top lanes and stop screening on breakthrough", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 5, "up");
  const p2 = tank("player2", 19, 7, "up");
  const map = openMap();
  const left = engine.previewTopScreen(context(p1, [p2], [], map));
  const right = engine.previewTopScreen(context(p2, [p1], [], map));
  assert.equal(left?.action.mode, "core-top-screen-fire");
  assert.equal(right?.action.mode, "core-top-screen-fire");
  assert.equal(engine.createController("1P").decide(context(p1, [p2], [], map)).mode,
    "core-top-screen-fire");
  assert.equal(engine.createController("2P").decide(context(p2, [p1], [], map)).mode,
    "core-top-screen-fire");
  assert.notEqual(Math.floor(p1.x / TILE), Math.floor(p2.x / TILE));
  assert.notEqual(Math.floor(p1.y / TILE), Math.floor(p2.y / TILE));
  const stacked1 = tank("player", 13, 5, "up");
  const stacked2 = tank("player2", 13, 7, "up");
  const separate1 = engine.previewTopScreen(context(stacked1, [stacked2], [], map));
  const separate2 = engine.previewTopScreen(context(stacked2, [stacked1], [], map));
  assert.equal(separate1?.action.mode, "core-top-screen-route");
  assert.equal(separate2?.action.mode, "core-top-screen-route");
  assert.ok(separate1.route.at(-1).x < stacked1.x / TILE);
  assert.ok(separate2.route.at(-1).x > stacked2.x / TILE);
  const breakthrough = enemy(12, 12);
  assert.equal(engine.previewTopScreen(context(p1, [p2], [breakthrough], map)), null);
  assert.equal(engine.previewTopScreen(context(p1, [p2], [enemy(12, 2)], map)), null,
    "an existing enemy must be hunted rather than screened past");
  map[3][7] = "S";
  assert.notEqual(engine.previewTopScreen(context(p1, [p2], [], map))?.action.mode,
    "core-top-screen-fire");
});

test("top screening never authorizes a blocked, downward or friendly-fire shot", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /if \(hit.type === "ally"\) return false;\s*if \(action.mode === "core-top-screen-fire"\)/);
  assert.match(source, /intendedDir === "up" && \(hit.type === "edge" \|\| hit.type === "none" \|\| hit.type === "enemy"\)/);
});

test("the final visible enemy is actively pursued instead of waiting at an intercept", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 20);
  const p2 = tank("player2", 14, 20);
  const last = enemy(5, 5);
  const ctx = context(p1, [p2], [last], openMap());
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.lockedTarget, last);
  assert.doesNotMatch(action.mode, /intercept|rear-recover|global-defense-hold/);
  assert.ok(action.fire || !action.hold, action.mode);
});

test("a distant final enemy does not make a pursuer reverse at a changing intercept cell", () => {
  const engine = loadEngine();
  const defender = tank("player", 10, 20, "up");
  const last = enemy(5, 5);
  const ctx = context(defender, [], [last], openMap());
  const controller = engine.createController("1P");
  const startDistance = Math.abs(defender.x - last.x) + Math.abs(defender.y - last.y);
  for (let step = 0; step < 26; step++) {
    ctx.gameTime = 1 + step * 0.1;
    const action = controller.decide(ctx);
    assert.equal(action.lockedTarget, last);
    assert.notEqual(action.moveDir || action.dir, "down", `${step}: ${action.mode}`);
    if (!action.hold) {
      const direction = action.moveDir || action.dir;
      defender.x += (direction === "right" ? 9 : direction === "left" ? -9 : 0);
      defender.y += (direction === "down" ? 9 : direction === "up" ? -9 : 0);
      defender.dir = action.dir;
    }
  }
  assert.ok(Math.abs(defender.x - last.x) + Math.abs(defender.y - last.y)
    < startDistance - TILE * 4);
});

test("two crossed-midline enemies are pursued without patrol-pressure routing", () => {
  const engine = loadEngine();
  const left = tank("player", 8, 17, "up");
  const right = tank("player2", 18, 17, "up");
  const leftEnemy = enemy(7, 14);
  const rightEnemy = enemy(19, 14);
  const map = openMap();
  const leftAction = engine.createController("1P").decide(context(left,
    [right], [leftEnemy, rightEnemy], map));
  left.attackTarget = leftAction.lockedTarget;
  const rightAction = engine.createController("2P").decide(context(right,
    [left], [leftEnemy, rightEnemy], map));
  for (const [action, subject] of [[leftAction, left], [rightAction, right]]) {
    assert.ok(action.lockedTarget?.alive, action.mode);
    assert.doesNotMatch(action.mode, /pressure|patrol|intercept-hold/, action.mode);
    assert.ok(action.fire || !action.hold, action.mode);
    if (!action.fire) {
      const direction = action.moveDir || action.dir;
      const before = Math.abs(subject.x - action.lockedTarget.x)
        + Math.abs(subject.y - action.lockedTarget.y);
      const nextX = subject.x + (direction === "right" ? 9 : direction === "left" ? -9 : 0);
      const nextY = subject.y + (direction === "down" ? 9 : direction === "up" ? -9 : 0);
      assert.ok(Math.abs(nextX - action.lockedTarget.x)
        + Math.abs(nextY - action.lockedTarget.y) <= before, action.mode);
    }
  }
  assert.notEqual(leftAction.lockedTarget, rightAction.lockedTarget);
});

test("display recognizes live global and advisor routes as lock lines", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  const start = source.indexOf("function isAttackRouteMode(");
  const end = source.indexOf("function drawTargetLink(", start);
  assert.ok(start >= 0 && end > start);
  const routeMode = vm.runInNewContext(`${source.slice(start, end)}\nisAttackRouteMode`);
  for (const mode of ["core-global-defense-route", "core-advisor-global-route",
    "core-defense-loop-route", "core-final-search-route"]) {
    assert.equal(routeMode(mode), true, mode);
  }
});

test("search cannot move or fire a frozen enemy and resumes after expiry", () => {
  const api = loadEngine();
  const defender = tank("player", 8, 16);
  const foe = enemy(8, 10);
  const ctx = context(defender, [], [foe], openMap());
  ctx.freezeTime = 0.2;
  const action = { enemy: foe, dir: "down", fire: true, hold: false };
  const frozen = api.previewSearchTransition(ctx, null, action, false);
  assert.equal(frozen.enemies[0].y, foe.y);
  assert.equal(frozen.swing, 0);
  assert.equal(frozen.freezeRemaining, 0);
  const thawed = api.previewSearchTransition(ctx, frozen, action, false);
  assert.ok(thawed.enemies[0].y > foe.y);
});

test("search respects reload and removes a destroyed target", () => {
  const api = loadEngine();
  const defender = tank("player", 8, 16, "up");
  const foe = enemy(8, 10);
  const ctx = context(defender, [], [foe], openMap());
  const action = { target: foe, dir: "up", fire: true, hold: true };
  defender.cooldown = 1;
  assert.equal(api.previewSearchTransition(ctx, null, action).swing, 0);
  defender.cooldown = 0;
  const hit = api.previewSearchTransition(ctx, null, action);
  assert.equal(hit.enemies.length, 0);
  assert.ok(hit.tank.cooldown > 0);
  assert.equal(api.previewSearchTransition(ctx, hit, action).swing, hit.swing);
});

test("search requires two hits for armor and does not reward turning before ready", () => {
  const api = loadEngine();
  const defender = tank("player", 8, 16, "right");
  const foe = enemy(8, 10, "armor");
  foe.hp = 2;
  const ctx = context(defender, [], [foe], openMap());
  const action = { target: foe, dir: "up", fire: true, hold: true };
  assert.equal(api.previewSearchTransition(ctx, null, action).swing, 0);
  defender.dir = "up";
  const hit = api.previewSearchTransition(ctx, null, action);
  assert.equal(hit.enemies[0].hp, 1);
});

test("search rejects steel grazing the projectile edge", () => {
  const api = loadEngine();
  const defender = tank("player", 8, 16);
  const foe = enemy(8, 10);
  defender.x = foe.x = 8 * TILE - 12;
  const map = openMap();
  map[13][7] = "S";
  const ctx = context(defender, [], [foe], map);
  const result = api.previewSearchTransition(ctx, null, { dir: "up", fire: true, hold: true, target: foe });
  assert.equal(result.swing, 0);
  assert.equal(result.enemies.length, 1);
});

test("search damages the first enemy on a ray rather than the locked rear enemy", () => {
  const api = loadEngine();
  const defender = tank("player", 8, 16);
  const near = enemy(8, 13);
  const far = enemy(8, 10, "armor");
  far.hp = 2;
  const ctx = context(defender, [], [near, far], openMap());
  const result = api.previewSearchTransition(ctx, null, { dir: "up", fire: true, hold: true, target: far });
  assert.equal(result.enemies.length, 1);
  assert.equal(result.enemies[0].source, far);
  assert.equal(result.enemies[0].hp, 2);
});

test("search does not reward shooting through a teammate", () => {
  const api = loadEngine();
  const defender = tank("player", 8, 16);
  const friend = tank("player2", 8, 13);
  const foe = enemy(8, 10);
  const ctx = context(defender, [friend], [foe], openMap());
  const result = api.previewSearchTransition(ctx, null, { dir: "up", fire: true, hold: true, target: foe });
  assert.ok(result.swing < 0);
  assert.equal(result.enemies[0].hp, 1);
});

test("a concealed final enemy triggers a last-known-position search without revealing its lock", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 20);
  const p2 = tank("player2", 14, 20);
  const last = enemy(8, 5);
  const map = openMap();
  engine.createController("1P").decide(context(p1, [p2], [last], map));

  last.y = 6 * TILE + 2;
  map[6][8] = "F";
  const hiddenContext = context(p2, [p1], [last], map);
  hiddenContext.gameTime = 1.5;
  hiddenContext.mapVersion = 1;
  const searchController = engine.createController("2P");
  const action = searchController.decide(hiddenContext);

  assert.match(action.mode, /^core-final-search/);
  assert.equal(action.hold, false);
  assert.equal(action.lockedTarget, null);

  const deltas = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  let searchAction = action;
  let sweptForest = false;
  const searchTrace = [];
  for (let step = 0; step < 30 && !sweptForest; step++) {
    const moveDir = searchAction.moveDir || searchAction.dir;
    if (!searchAction.hold && deltas[moveDir]) {
      p2.x += deltas[moveDir][0] * TILE;
      p2.y += deltas[moveDir][1] * TILE;
    }
    const searchContext = context(p2, [p1], [last], map);
    searchContext.gameTime = 1.6 + step * 0.1;
    searchContext.mapVersion = 1;
    searchAction = searchController.decide(searchContext);
    searchTrace.push(`${Math.round(p2.x / TILE)},${Math.round(p2.y / TILE)}:${searchAction.mode}:${searchAction.dir}`);
    assert.match(searchAction.mode, /^core-final-search/);
    assert.equal(searchAction.lockedTarget, null);
    sweptForest ||= searchAction.mode === "core-final-search-sweep" && searchAction.fire;
  }
  assert.equal(sweptForest, true, searchTrace.join(" | "));

  map[6][8] = ".";
  const revealedContext = context(p2, [p1], [last], map);
  revealedContext.gameTime = 2;
  revealedContext.mapVersion = 2;
  const revealed = searchController.decide(revealedContext);
  assert.equal(revealed.lockedTarget, last);
});

test("a fresh controller searches forest when the only living enemy is already concealed", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 19);
  const p2 = tank("player2", 17, 19);
  const last = enemy(8, 6);
  const map = openMap();
  map[6][8] = "F";
  const action = engine.createController("1P").decide(context(p1, [p2], [last], map));

  assert.match(action.mode, /^core-final-search/);
  assert.equal(action.lockedTarget, null);
});

test("base defense ranks credible firing routes before geometric distance", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /function baseDefenseProfile\(ctx, enemy\)/);
  assert.match(source, /const credibleEta = Math\.min\(routeEta, attackEta\)/);
  assert.match(source, /const mapPressure = threat\.defenseTier >= 3/);
  assert.match(source, /Number\.isFinite\(credibleEta\) \? credibleEta : geometricEta \+ 2\.5/);
  assert.match(source, /const defenseTier = direct\?\.target === "base" \? 0/);
  assert.match(source, /const impactMargin = \(direct\?\.target === "base" \? 0\.18/);
  assert.match(source, /const responseDeadline = Math\.max\(0, dangerEta - impactMargin\)/);
  assert.doesNotMatch(source, /dangerEta - killAllowance/);
});

test("an opposite-side base defender follows the global terminal route to the correct flank", () => {
  const engine = loadEngine();
  const map = openMap();
  for (let y = 21; y <= 23; y++) {
    for (let x = 11; x <= 14; x++) map[y][x] = "B";
  }
  for (let y = 22; y <= 23; y++) {
    for (let x = 12; x <= 13; x++) map[y][x] = "E";
  }
  const intruder = enemy(10, 22);
  const defender = tank("player2", 16, 22, "down");
  const controller = engine.createController("2P");
  const firstContext = context(defender, [], [intruder], map);
  firstContext.gameTime = 20;
  const first = controller.decide(firstContext);

  assert.match(first.mode, /^core-(?:base-corridor|global-defense|terminal-base-melee)/);
  assert.equal(first.dir, "up");
  assert.equal(first.lockedTarget, intruder);

  const deltas = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  let action = first;
  let reachedLeftSide = false;
  for (let step = 0; step < 12; step++) {
    assert.notEqual(action.dir, "right", `${step}:${action.mode}`);
    const delta = deltas[action.moveDir || action.dir];
    if (!action.hold && delta) {
      defender.x += delta[0] * TILE;
      defender.y += delta[1] * TILE;
    }
    intruder.y = (step % 2 ? 21 : 22) * TILE + 2;
    const movedContext = context(defender, [], [intruder], map);
    movedContext.gameTime = 20.1 + step * 0.1;
    action = controller.decide(movedContext);
    reachedLeftSide = Math.floor((defender.x + defender.w / 2) / TILE) <= 10;
    if (reachedLeftSide) break;
    assert.equal(action.lockedTarget, intruder);
  }
  assert.equal(reachedLeftSide, true, `${action.mode}:${action.dir}`);
});

test("left and right global terminal routes are symmetric for an overhead defender", () => {
  const engine = loadEngine();
  const leftIntruder = enemy(10, 22);
  const rightIntruder = enemy(15, 22);

  const left = engine.createController("1P").decide(context(
    tank("player", 13, 18, "up"), [], [leftIntruder], openMap(),
  ));
  assert.match(left.mode, /^core-(?:base-corridor|global-defense|terminal-base-melee)/);
  assert.notEqual(left.dir, "right");

  const right = engine.createController("1P").decide(context(
    tank("player", 13, 18, "up"), [], [rightIntruder], openMap(),
  ));
  assert.match(right.mode, /^core-(?:base-corridor|global-defense|terminal-base-melee)/);
  assert.notEqual(right.dir, "left");
});

test("a safe firing lane interrupts global defense movement immediately", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 20, "left");
  const intruder = enemy(10, 20);
  intruder.speed = 0;
  intruder.baseSpeed = 0;
  const ctx = context(defender, [], [intruder], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === intruder;
  const action = engine.createController("2P").decide(ctx);

  assert.equal(action.lockedTarget, intruder);
  assert.match(action.mode, /^core-(?:(?:base-corridor|advisor-base|defense-contract)-fire|base-lane-safe-fire)$/);
  assert.equal(action.dir, "left");
  assert.equal(action.fire, true);
});

test("a verified predictive lane also interrupts global defense movement", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 20, "left");
  const intruder = enemy(10, 20);
  intruder.dir = "left";
  const ctx = context(defender, [], [intruder], openMap());
  ctx.canPredictShoot = (dir, target) => dir === "left" && target === intruder;
  const action = engine.createController("2P").decide(ctx);

  assert.equal(action.lockedTarget, intruder);
  assert.match(action.mode, /^core-(?:base-corridor|advisor-base|defense-contract)-fire$/);
  assert.equal(action.fire, true);
});

test("a fast lower-field threat starts the global defense route before the last six cells", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 20, "up");
  const fast = enemy(10, 16, "fast");
  fast.speed = 105;
  fast.baseSpeed = 105;
  fast.dir = "down";
  const action = engine.createController("2P").decide(context(defender, [], [fast], openMap()));

  assert.equal(action.lockedTarget, fast);
  assert.match(action.mode, /^core-(?:base-corridor|global-defense|terminal-base-melee)/);
  assert.notEqual(action.dir, "right");
});

test("the fastest reachable ally may cross its side boundary for an urgent defense", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 18, "up");
  const p2 = tank("player2", 24, 10, "down");
  const urgent = enemy(13, 14, "fast");
  urgent.speed = 105;
  const decoy = enemy(4, 4);
  const map = openMap();
  const c1 = context(p1, [p2], [decoy, urgent], map);
  const a1 = engine.createController("1P").decide(c1);
  p1.attackTarget = a1.lockedTarget;
  const c2 = context(p2, [p1], [decoy, urgent], map);
  c2.gameTime = 1.01;
  const a2 = engine.createController("2P").decide(c2);
  assert.equal(a1.lockedTarget, urgent);
  assert.notEqual(a2.lockedTarget, urgent);
});

test("the closest responder owns the nearer breakthrough before a farther lane", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 19, "up");
  const p2 = tank("player2", 17, 19, "up");
  const nearBreakthrough = enemy(2, 18);
  const fartherBreakthrough = enemy(2, 14);
  const map = openMap();
  const a1 = engine.createController("1P").decide(
    context(p1, [p2], [nearBreakthrough, fartherBreakthrough], map),
  );
  p1.attackTarget = a1.lockedTarget;
  const c2 = context(p2, [p1], [nearBreakthrough, fartherBreakthrough], map);
  c2.gameTime = 1.01;
  const a2 = engine.createController("2P").decide(c2);

  assert.equal(a1.lockedTarget, nearBreakthrough, `1P=${a1.mode} 2P=${a2.mode}`);
  assert.equal(a2.lockedTarget, fartherBreakthrough, `1P=${a1.mode} 2P=${a2.mode}`);
});

test("a newly nearer breakthrough replaces an obsolete hard assignment", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 19, "up");
  const p2 = tank("player2", 17, 19, "up");
  const firstThreat = enemy(2, 18);
  const secondThreat = enemy(2, 14);
  const map = openMap();
  const controller1 = engine.createController("1P");
  const controller2 = engine.createController("2P");

  const first1 = controller1.decide(context(p1, [p2], [firstThreat, secondThreat], map));
  p1.attackTarget = first1.lockedTarget;
  const initial2 = context(p2, [p1], [firstThreat, secondThreat], map);
  initial2.gameTime = 1.01;
  const first2 = controller2.decide(initial2);
  p2.attackTarget = first2.lockedTarget;
  assert.equal(first1.lockedTarget, firstThreat);
  assert.equal(first2.lockedTarget, secondThreat);

  firstThreat.y = 14 * TILE + 2;
  secondThreat.y = 18 * TILE + 2;
  const updated1 = context(p1, [p2], [firstThreat, secondThreat], map);
  updated1.gameTime = 1.5;
  updated1.mapVersion = 1;
  const next1 = controller1.decide(updated1);
  p1.attackTarget = next1.lockedTarget;
  const updated2 = context(p2, [p1], [firstThreat, secondThreat], map);
  updated2.gameTime = 1.51;
  updated2.mapVersion = 1;
  const next2 = controller2.decide(updated2);

  assert.equal(next1.lockedTarget, secondThreat, `1P=${next1.mode} 2P=${next2.mode}`);
  assert.equal(next2.lockedTarget, firstThreat, `1P=${next1.mode} 2P=${next2.mode}`);
});

test("a living near-base assignment cannot be displaced by an easier distant kill", () => {
  const engine = loadEngine();
  const near = { enemy: enemy(11, 18), crossed: true,
    baseDistance: TILE * 4.5, dangerEta: 1.6 };
  const distant = { enemy: enemy(24, 12), crossed: true,
    baseDistance: TILE * 18, dangerEta: 2.5 };
  assert.equal(engine.previewNearBaseCommit(near, distant), true);
  const direct = { ...distant, direct: { target: "base", eta: 0.8 } };
  assert.equal(engine.previewNearBaseCommit(near, direct), false);
  assert.equal(engine.previewNearBaseCommit(near, {
    ...distant, baseDistance: TILE * 5.5,
  }), false);
  near.enemy.alive = false;
  assert.equal(engine.previewNearBaseCommit(near, distant), false);
});

test("a terminal base threat overrides a living but less urgent hard target", () => {
  const engine = loadEngine();
  const defender = tank("player", 7, 19, "up");
  const committed = enemy(3, 18);
  const terminal = enemy(20, 10, "fast");
  terminal.speed = 105;
  const controller = engine.createController("1P");
  const map = openMap();

  const firstContext = context(defender, [], [committed, terminal], map);
  firstContext.gameTime = 10;
  const first = controller.decide(firstContext);
  assert.equal(first.lockedTarget, committed);

  terminal.x = 12 * TILE + 2;
  terminal.y = 20 * TILE + 2;
  terminal.dir = "down";
  const emergencyContext = context(defender, [], [committed, terminal], map);
  emergencyContext.gameTime = 10.15;
  emergencyContext.mapVersion = 1;
  const emergency = controller.decide(emergencyContext);

  assert.equal(emergency.lockedTarget, terminal, emergency.mode);
});

test("the tactical advisor owns every final live action", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "up");
  const threat = enemy(8, 8, "fast");
  threat.speed = 105;
  const controller = engine.createController("1P");
  const action = controller.decide(context(subject, [], [threat], openMap()));

  assert.equal(action.lockedTarget, threat);
  assert.equal(action.advisor?.shadow, false);
  assert.equal(action.advisor?.globalControl, true);
  assert.equal(typeof action.advisor?.score, "number");
  assert.equal(typeof action.advisor?.reason, "string");
  assert.equal(action.advisor?.applied, true);
  assert.notEqual(action.advisor?.participation, "shadow");
  assert.ok(action.advisor?.evaluated >= 4);
  assert.ok(action.advisor?.evaluated <= 8);
  const stats = engine.advisorStats();
  assert.equal(stats.runs, 1);
  assert.equal(stats.cacheHits, 0);
  assert.equal(typeof stats.lastScore, "number");
  assert.ok(stats.applied >= 1);
  assert.match(action.mode, /^core-/);
});

test("the tactical advisor uses bounded iterative search with reusable positions", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "up");
  const threat = enemy(8, 8, "fast");
  threat.speed = 105;
  const ctx = context(subject, [], [threat], openMap());
  const baseline = {
    dir: "up",
    moveDir: "up",
    fire: false,
    hold: false,
    mode: "core-chase",
    target: threat,
  };

  const first = engine.previewAdvisorSearch(ctx, baseline, threat);
  assert.ok(first.depth >= 1 && first.depth <= 3);
  assert.ok(first.nodes > 0 && first.nodes <= 112);
  assert.ok(first.evaluated >= 4 && first.evaluated <= 8);
  assert.equal(typeof first.ttHits, "number");
  assert.equal(typeof first.cutoffs, "number");

  const second = engine.previewAdvisorSearch(ctx, baseline, threat);
  assert.ok(second.ttHits > 0, `expected a transposition hit, got ${JSON.stringify(second)}`);
  assert.ok(second.nodes <= 112);
  assert.ok(second.depth >= first.depth);
});

test("the iterative advisor never proposes a root move rejected by the live collision map", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "left");
  const threat = enemy(5, 18);
  const map = openMap();
  map[18][7] = "S";
  const ctx = context(subject, [], [threat], map);
  ctx.canMove = (dir) => dir !== "left";
  const baseline = {
    dir: "up",
    moveDir: "up",
    fire: false,
    hold: false,
    mode: "core-dynamic-detour",
    target: threat,
  };

  const advice = engine.previewAdvisorSearch(ctx, baseline, threat);
  assert.notEqual(advice.dir, "left");
});

test("the tactical advisor is throttled and reuses identical position searches", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "up");
  const threat = enemy(8, 8, "fast");
  threat.speed = 105;
  const controller = engine.createController("1P");
  const map = openMap();

  const firstContext = context(subject, [], [threat], map);
  firstContext.gameTime = 5;
  controller.decide(firstContext);
  const firstStats = controller.snapshot().advisor;
  assert.equal(firstStats.runs, 1);

  const throttledContext = context(subject, [], [threat], map);
  throttledContext.gameTime = 5.05;
  controller.decide(throttledContext);
  const throttledStats = controller.snapshot().advisor;
  assert.equal(throttledStats.runs, 1);
  assert.equal(throttledStats.cacheHits, 0);

  threat.x -= TILE;
  const movingContext = context(subject, [], [threat], map);
  movingContext.gameTime = 5.1;
  controller.decide(movingContext);
  assert.equal(controller.snapshot().advisor.runs, 1);
  threat.x += TILE;

  const cachedContext = context(subject, [], [threat], map);
  cachedContext.gameTime = 5.4;
  controller.decide(cachedContext);
  const cachedStats = controller.snapshot().advisor;
  assert.equal(cachedStats.runs, 1);
  assert.equal(cachedStats.cacheHits, 1);
  assert.equal(engine.advisorStats().runs, 1);
  assert.equal(engine.advisorStats().cacheHits, 1);

  threat.x += TILE;
  const changedContext = context(subject, [], [threat], map);
  changedContext.gameTime = 5.8;
  controller.decide(changedContext);
  const changedStats = controller.snapshot().advisor;
  assert.equal(changedStats.runs, 2);
});

test("global advisor only corrects a clearly wrong safe pursuit direction", () => {
  const engine = loadEngine();
  const subject = tank("player", 15, 16, "down");
  const threat = enemy(5, 5);
  const ctx = context(subject, [], [threat], openMap());
  const baseline = {
    dir: "down",
    moveDir: "down",
    fire: false,
    hold: false,
    mode: "core-chase",
    target: threat,
  };
  const advice = {
    differs: true,
    tag: "move",
    dir: "up",
    fire: false,
    hold: false,
    bulletRisk: 0,
    scoreGain: 2,
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(engine.previewAdvisorPhaseOne(ctx, baseline, threat, advice))),
    { allowed: true, reason: "safe-route" },
  );

  ctx.freezeTime = 2;
  assert.equal(engine.previewAdvisorPhaseOne(ctx, baseline, threat, advice).reason, "freeze-protected");
  ctx.freezeTime = 0;
  ctx.bullets = [{
    x: subject.x + 11,
    y: subject.y - TILE * 2,
    w: 6,
    h: 6,
    dir: "down",
    speed: 180,
    enemy: true,
    dead: false,
  }];
  assert.equal(engine.previewAdvisorPhaseOne(ctx, baseline, threat, advice).reason, "bullet-protected");
  ctx.bullets = [];
  const nearby = enemy(15, 14);
  ctx.enemies = [nearby];
  assert.equal(engine.previewAdvisorPhaseOne(ctx, baseline, nearby, advice).reason, "close-combat-protected");

  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /advisorGlobalControlPlan\(/);
  assert.match(source, /mode: "core-advisor-global-route"/);
});

test("global control advances only while another ally preserves rear coverage", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 8, "up");
  const rear = tank("player2", 16, 18, "up");
  const ctx = context(subject, [rear], [enemy(8, 2)], openMap());
  ctx.globalThreats = [];
  ctx.globalDirective = null;
  assert.equal(engine.previewAdvisorDefensePosture(ctx).safeToAdvance, true);

  ctx.map[19].fill("S");
  ctx.mapVersion = 1;
  assert.equal(engine.previewAdvisorDefensePosture(ctx).rearGuardExists, false);
  assert.equal(engine.previewAdvisorDefensePosture(ctx).safeToAdvance, false);
  ctx.map[19].fill(".");
  ctx.mapVersion = 2;

  rear.y = 8 * TILE + 2;
  assert.equal(engine.previewAdvisorDefensePosture(ctx).safeToAdvance, false);

  const baseline = {
    dir: "up",
    moveDir: "up",
    fire: false,
    hold: false,
    mode: "core-chase",
    target: ctx.enemies[0],
  };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, ctx.enemies[0], {
    differs: true,
    dir: "up",
    fire: false,
    hold: false,
    bulletRisk: 0,
    scoreGain: 10,
  });
  assert.notEqual(plan.action.moveDir || plan.action.dir, "up");
  assert.match(plan.action.mode, /^core-global-rear/);
});

test("active frozen pursuit is not replaced by rear recovery", () => {
  const engine = loadEngine();
  const subject = tank("player2", 16, 8, "up");
  const rear = tank("player", 8, 8, "up");
  const threat = enemy(16, 2);
  const ctx = context(subject, [rear], [threat], openMap());
  ctx.freezeTime = 3;
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false,
    mode: "core-freeze-assault", target: threat };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, threat);
  assert.equal(plan.action.mode, "core-freeze-assault");
  assert.equal(plan.action.dir, "up");
  assert.equal(plan.action.hold, false);

  ctx.freezeTime = 0;
  const normal = engine.previewAdvisorGlobalControl(ctx, baseline, threat);
  assert.match(normal.action.mode, /^core-global-rear/);
});

test("advisor cache identity follows ally coverage and assignment changes", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 8, "up");
  const rear = tank("player2", 16, 18, "up");
  const threat = enemy(8, 3);
  const ctx = context(subject, [rear], [threat], openMap());
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false, mode: "core-chase", target: threat };
  const first = engine.previewAdvisorKey(ctx, baseline, threat);

  rear.x += TILE;
  const moved = engine.previewAdvisorKey(ctx, baseline, threat);
  assert.notEqual(moved, first);

  ctx.globalDirective = {
    target: threat,
    threat: { enemy: threat, defenseTier: 1, responseDeadline: 1.2, dangerEta: 1.4 },
  };
  assert.notEqual(engine.previewAdvisorKey(ctx, baseline, threat), moved);
});

test("global control produces a reliable return route when defense margin is unsafe", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 8, "up");
  const intruder = enemy(8, 18, "fast");
  intruder.speed = 105;
  const ctx = context(subject, [], [intruder], openMap());
  const threat = {
    enemy: intruder,
    direct: null,
    crossed: true,
    defenseTier: 2,
    dangerEta: 3,
    responseDeadline: 2.5,
    baseDistance: TILE * 4,
  };
  ctx.globalThreats = [threat];
  ctx.globalDirective = {
    target: intruder,
    threat,
    intercept: {
      path: [
        { x: 8, y: 8 },
        { x: 8, y: 9 },
        { x: 8, y: 10 },
      ],
    },
  };
  const baseline = {
    dir: "up",
    moveDir: "up",
    fire: false,
    hold: false,
    mode: "core-chase",
    target: intruder,
  };
  const posture = engine.previewAdvisorDefensePosture(ctx);
  const plan = engine.previewAdvisorReliableReturn(ctx, baseline);

  assert.equal(posture.urgent, true);
  assert.equal(posture.safeToAdvance, false);
  assert.equal(plan?.enemy, intruder);
  assert.equal(plan?.action?.dir, "down");
  assert.match(plan?.action?.mode || "", /^core-global-defense/);
});

test("distant counter aiming cannot suppress an urgent assigned return", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 8, "up");
  const intruder = enemy(8, 18, "fast");
  const distant = enemy(8, 2);
  const ctx = context(subject, [], [intruder, distant], openMap());
  const threat = { enemy: intruder, crossed: true, defenseTier: 2,
    dangerEta: 3, responseDeadline: 2.5, baseDistance: TILE * 4 };
  ctx.globalThreats = [threat];
  ctx.globalDirective = { target: intruder, threat, intercept: {
    path: [{ x: 8, y: 8 }, { x: 8, y: 9 }, { x: 8, y: 10 }],
  } };
  for (const mode of ["core-counter-aim"]) {
    const baseline = { dir: "up", fire: false, hold: true, mode, target: distant };
    const plan = engine.previewAdvisorReliableReturn(ctx, baseline);
    assert.equal(plan?.enemy, intruder, mode);
    assert.equal(plan?.action?.dir, "down", mode);
    assert.equal(engine.previewAdvisorReliableReturn(ctx, { ...baseline, target: intruder }), null);
  }
  for (const mode of ["core-evade-bullet", "core-base-shield", "core-freeze-pickup", "core-armor-volley", "core-terminal-base-melee-reload"]) {
    assert.equal(engine.previewAdvisorReliableReturn(ctx, { mode, target: distant }), null, mode);
  }
});

test("urgent global defense holds for a fresh replan instead of resuming a wrong chase", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 8, "up");
  const intruder = enemy(8, 18, "fast");
  const map = Array.from({ length: 24 }, () => Array(26).fill("S"));
  map[8][8] = ".";
  map[18][8] = ".";
  const ctx = context(subject, [], [intruder], map);
  ctx.canMove = () => false;
  const threat = {
    enemy: intruder,
    crossed: true,
    defenseTier: 1,
    dangerEta: 1.5,
    responseDeadline: 1,
    baseDistance: TILE * 4,
  };
  ctx.globalThreats = [threat];
  ctx.globalDirective = { target: intruder, threat, intercept: null };
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false, mode: "core-chase", target: intruder };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, intruder, {
    differs: false,
    dir: "up",
    fire: false,
    hold: false,
    bulletRisk: 0,
    scoreGain: 0,
  });

  assert.equal(plan.action.mode, "core-global-defense-hold");
  assert.equal(plan.action.hold, true);
  assert.notEqual(plan.action.moveDir || plan.action.dir, "up");
});

test("urgent return clears an ordinary route brick instead of waiting forever", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 8, "down");
  const intruder = enemy(8, 18, "fast");
  const map = openMap();
  map[9][8] = "B";
  const ctx = context(subject, [], [intruder], map);
  ctx.canMove = (dir) => dir !== "down";
  const threat = {
    enemy: intruder,
    crossed: true,
    defenseTier: 1,
    dangerEta: 2,
    responseDeadline: 1,
    baseDistance: TILE * 4,
  };
  ctx.globalThreats = [threat];
  ctx.globalDirective = {
    target: intruder,
    threat,
    intercept: { path: [{ x: 8, y: 8 }, { x: 8, y: 9 }, { x: 8, y: 10 }] },
  };
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false, mode: "core-chase", target: intruder };
  const plan = engine.previewAdvisorReliableReturn(ctx, baseline);

  assert.equal(plan.reason, "defense-clear");
  assert.equal(plan.action.dir, "down");
  assert.equal(plan.action.fire, true);
  assert.notEqual(plan.action.mode, "core-global-defense-hold");
});

test("the lower center defense screen is never classified as a clearable brick", () => {
  const engine = loadEngine();
  const subject = tank("player", 12, 20, "up");
  const map = openMap();
  map[18][12] = "B";
  map[20][8] = "B";
  map[18][7] = "B";
  const ctx = context(subject, [], [enemy(12, 14)], map);

  assert.equal(engine.previewProtectedDefenseBrick(ctx, 12, 18), true);
  assert.equal(engine.previewProtectedDefenseBrick(ctx, 8, 20), true);
  assert.equal(engine.previewProtectedDefenseBrick(ctx, 7, 18), false);
  map[18][12] = ".";
  assert.equal(engine.previewProtectedDefenseBrick(ctx, 12, 18), false);
});

test("urgent pursuit replans around an intact center defense brick", () => {
  const engine = loadEngine();
  const subject = tank("player", 12, 17, "down");
  const intruder = enemy(12, 20, "fast");
  const map = openMap();
  map[18][12] = "B";
  const ctx = context(subject, [], [intruder], map);
  const threat = {
    enemy: intruder,
    crossed: true,
    defenseTier: 1,
    dangerEta: 1.8,
    responseDeadline: 1,
    baseDistance: TILE * 2,
  };
  ctx.globalThreats = [threat];
  ctx.globalDirective = {
    target: intruder,
    threat,
    intercept: { path: [{ x: 12, y: 17 }, { x: 12, y: 18 }, { x: 12, y: 19 }] },
  };
  const baseline = {
    dir: "down",
    moveDir: "down",
    fire: false,
    hold: false,
    mode: "core-breakthrough-chase",
    target: intruder,
  };
  const plan = engine.previewAdvisorReliableReturn(ctx, baseline);

  assert.notEqual(plan?.reason, "defense-clear");
  assert.notEqual(plan?.action?.mode, "core-global-defense-hold");
  assert.notEqual(plan?.action?.dir, "down");
});

test("an urgent breakthrough remains actionable instead of falling into the global failsafe", () => {
  const engine = loadEngine();
  const subject = tank("player", 7, 12, "down");
  const intruder = enemy(10, 18, "fast");
  const ctx = context(subject, [], [intruder], openMap());
  const threat = {
    enemy: intruder,
    crossed: true,
    defenseTier: 1,
    dangerEta: 2.2,
    responseDeadline: 1.4,
    baseDistance: TILE * 4,
  };
  ctx.globalThreats = [threat];
  ctx.globalDirective = { target: intruder, threat, intercept: null };
  const baseline = {
    dir: "right",
    moveDir: "right",
    fire: false,
    hold: false,
    mode: "core-breakthrough-chase",
    target: intruder,
  };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, intruder, {
    differs: false,
    dir: "right",
    fire: false,
    hold: false,
    bulletRisk: 0,
    scoreGain: 0,
  });

  assert.notEqual(plan.reason, "defense-failsafe");
  assert.equal(plan.action.hold, false);
  assert.match(plan.action.mode, /^core-(?:global-(?:defense|emergency)|advisor-base)/);
});

test("reliable return resumes a stale route from the tank current cell", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 9, "up");
  const intruder = enemy(8, 18, "fast");
  const ctx = context(subject, [], [intruder], openMap());
  const threat = {
    enemy: intruder,
    crossed: true,
    defenseTier: 1,
    dangerEta: 2,
    responseDeadline: 1.2,
    baseDistance: TILE * 4,
  };
  ctx.globalThreats = [threat];
  ctx.globalDirective = {
    target: intruder,
    threat,
    intercept: {
      path: [
        { x: 8, y: 8 },
        { x: 9, y: 8 },
        { x: 9, y: 9 },
        { x: 8, y: 9 },
        { x: 8, y: 10 },
      ],
    },
  };
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false, mode: "core-chase", target: intruder };
  const first = engine.previewAdvisorReliableReturn(ctx, baseline);
  assert.equal(first.action.dir, "down");

  subject.y += TILE;
  ctx.gameTime += 0.1;
  const second = engine.previewAdvisorReliableReturn(ctx, baseline);
  assert.notEqual(second.action.dir, "right");
  assert.match(second.action.mode, /^core-global-defense/);
});

test("advisor retargets a base intruder and uses only verified close fire", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 16, "up");
  const stale = enemy(3, 8, "armor");
  const intruder = enemy(14, 22);
  intruder.dir = "left";
  const ctx = context(subject, [], [stale, intruder], openMap());
  const baseline = {
    dir: "left",
    moveDir: "left",
    fire: false,
    hold: false,
    mode: "core-breakthrough-chase",
    target: stale,
  };
  ctx.aiSideRole = "LEFT";
  ctx.canMove = () => false;
  ctx.advisorCanMove = () => true;
  const routePlan = engine.previewAdvisorBaseDefense(ctx, baseline, stale);
  assert.equal(routePlan?.enemy, intruder);
  assert.equal(routePlan?.action?.target, intruder);
  assert.match(routePlan?.action?.mode || "", /^core-advisor-base-(?:route|align)$/);

  subject.x = 14 * TILE + 2;
  subject.y = 20 * TILE + 2;
  subject.dir = "down";
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  const firePlan = engine.previewAdvisorBaseDefense(ctx, baseline, stale, 2);
  assert.equal(firePlan?.enemy, intruder);
  assert.equal(firePlan?.action?.fire, true);
  assert.equal(firePlan?.action?.mode, "core-advisor-base-fire");

  ctx.canDirectShoot = () => false;
  const guardedPlan = engine.previewAdvisorBaseDefense(ctx, baseline, stale, 3);
  assert.notEqual(guardedPlan?.action?.fire, true);
  ctx.bullets = [{
    x: subject.x + 11,
    y: subject.y - TILE * 2,
    w: 6,
    h: 6,
    dir: "down",
    speed: 180,
    enemy: true,
    dead: false,
  }];
  assert.equal(engine.previewAdvisorBaseDefense(ctx, baseline, stale, 3.5), null);
  ctx.bullets = [];
  ctx.freezeTime = 2;
  const frozenPlan = engine.previewAdvisorBaseDefense(ctx, baseline, stale, 4);
  assert.equal(frozenPlan?.enemy, intruder);
  assert.notEqual(frozenPlan?.action?.fire, true);
  assert.match(frozenPlan?.action?.mode || "", /^core-advisor-base-/);
});

test("base defense respects separate assignments when two enemies enter the nest", () => {
  const engine = loadEngine();
  const p1 = tank("player", 9, 19, "down");
  const p2 = tank("player2", 17, 19, "down");
  const left = enemy(10, 22);
  const right = enemy(15, 22);
  const map = openMap();
  for (const [ally, teammate, assigned] of [[p1, p2, left], [p2, p1, right]]) {
    const ctx = context(ally, [teammate], [left, right], map);
    ctx.globalDirective = { target: assigned };
    const baseline = { dir: "up", moveDir: "up", fire: false, hold: false,
      mode: "core-chase", target: assigned };
    const plan = engine.previewAdvisorBaseDefense(ctx, baseline, assigned);
    assert.equal(plan?.enemy, assigned);
    assert.equal(plan?.action?.target, assigned);
  }
});

test("imminent direct fire at the base overrides a different local assignment", () => {
  const engine = loadEngine();
  const defender = tank("player2", 17, 19, "down");
  const assigned = enemy(15, 22);
  assigned.dir = "left";
  const shooter = enemy(12, 21);
  shooter.dir = "down";
  const map = openMap();
  map[22][14] = "S";
  const ctx = context(defender, [], [assigned, shooter], map);
  ctx.globalDirective = { target: assigned };
  const baseline = { dir: "left", moveDir: "left", fire: false, hold: false,
    mode: "core-chase", target: assigned };
  assert.equal(engine.previewAdvisorBaseDefense(ctx, baseline, assigned)?.enemy, shooter);
});

test("a covered base shooter does not pull both defenders off separate terminal targets", () => {
  const engine = loadEngine();
  const p1 = tank("player", 12, 18, "down");
  const p2 = tank("player2", 17, 19, "left");
  const shooter = enemy(12, 21);
  const assigned = enemy(15, 22);
  const map = openMap();
  map[22][14] = "S";
  const ctx = context(p2, [p1], [shooter, assigned], map);
  const shooterThreat = { enemy: shooter, defenseTier: 0, responseDeadline: 2,
    responseEtas: new WeakMap([[p1, 0.5]]) };
  const assignedThreat = { enemy: assigned, defenseTier: 1, responseDeadline: 2 };
  ctx.globalThreats = [shooterThreat, assignedThreat];
  ctx.globalDirective = { target: assigned };
  ctx.globalAssignments = new Map([[p1, { target: shooter }], [p2, { target: assigned }]]);
  const baseline = { dir: "left", moveDir: "left", fire: false, hold: false,
    mode: "core-chase", target: assigned };
  assert.equal(engine.previewAdvisorBaseDefense(ctx, baseline, assigned)?.enemy, assigned);
  shooterThreat.responseEtas.set(p1, 1.8);
  assert.equal(engine.previewAdvisorBaseDefense(ctx, baseline, assigned)?.enemy, shooter);
  shooterThreat.responseEtas.set(p1, 3);
  assert.equal(engine.previewAdvisorBaseDefense(ctx, baseline, assigned)?.enemy, shooter);
});

test("final firing gate rejects a shot whose first obstacle is a guard brick", () => {
  const engine = loadEngine();
  const defender = tank("player", 10, 20, "right");
  const map = openMap();
  map[20][11] = "B";
  const ctx = context(defender, [], [], map);
  const action = { dir: "right", fire: true, hold: true, mode: "core-attack-fire" };
  const guarded = engine.previewGuardFireGate(ctx, action);
  assert.equal(guarded.fire, false);
  assert.equal(guarded.mode, "core-guard-shot-blocked");
  map[20][11] = ".";
  assert.equal(engine.previewGuardFireGate(ctx, action), action);
});

test("a verified enemy-first shot is not cancelled by a guard brick behind the enemy", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 18, "down");
  const intruder = enemy(12, 20);
  const map = openMap();
  map[21][12] = "B";
  const ctx = context(defender, [], [intruder], map);
  const action = { dir: "down", fire: true, hold: true,
    mode: "core-base-lane-safe-fire", target: intruder };
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  assert.equal(engine.previewGuardFireGate(ctx, action), action);
  ctx.canDirectShoot = () => false;
  assert.equal(engine.previewGuardFireGate(ctx, action).fire, false);
  assert.equal(map[21][12], "B");
});

test("near the guard a confirmed hit fires without moving out of its safe lane", () => {
  const engine = loadEngine();
  const defender = tank("player2", 12, 19, "down");
  const intruder = enemy(12, 20);
  const map = openMap();
  map[21][12] = "B";
  const ctx = context(defender, [], [intruder], map);
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  ctx.canShoot = ctx.canDirectShoot;
  const action = engine.createController("2P").decide(ctx);
  assert.equal(action.target, intruder);
  assert.equal(action.dir, "down");
  assert.equal(action.fire, true, action.mode);
  assert.equal(action.hold, true, "a moving shot may no longer hit before the guard brick");
  assert.equal(map[21][12], "B");
});

test("near-guard defense does not plan a long base-facing shot it cannot safely fire", () => {
  const engine = loadEngine();
  const defender = tank("player2", 8, 21, "right");
  const intruder = enemy(11, 21);
  const map = openMap();
  map[21][12] = "B";
  map[22][12] = "E";
  const ctx = context(defender, [], [intruder], map);
  const mission = engine.previewDefenseMission(ctx, defender, intruder);
  assert.equal(mission.phase, "TERMINAL");
  assert.ok(mission.plan?.path?.length > 1);
  assert.notDeepEqual([mission.plan.cell.x, mission.plan.cell.y], [9, 21],
    "two tiles away facing the guarded base is not a usable shooting position");
  assert.notEqual(map[21][12], ".");
});

test("the final AI obstacle check keeps an explicitly safe emergency collateral shot", () => {
  const engine = loadEngine();
  const defender = tank("player2", 11, 19, "down");
  const intruder = enemy(11, 22);
  const map = openMap();
  map[21][11] = "B";
  const ctx = context(defender, [], [intruder], map);
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  ctx.canShoot = ctx.canDirectShoot;
  ctx.canEmergencyCollateralShot = ctx.canDirectShoot;
  const action = engine.createController("2P").decide(ctx);
  assert.equal(action.target, intruder);
  assert.equal(action.fire, true, action.mode);
  assert.equal(action.dir, "down");
});

test("an emergency collateral shot is not cancelled merely because a guard brick is first", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 18, "down");
  const intruder = enemy(12, 20);
  const map = openMap();
  map[19][12] = "B";
  const ctx = context(defender, [], [intruder], map);
  const action = { dir: "down", fire: true, hold: true,
    mode: "core-base-melee-fire", target: intruder };
  ctx.canEmergencyCollateralShot = (dir, target) => dir === "down" && target === intruder;
  assert.equal(engine.previewGuardFireGate(ctx, action), action);
  ctx.canEmergencyCollateralShot = () => false;
  assert.equal(engine.previewGuardFireGate(ctx, action).fire, false);
});

test("a live base emergency may clear its first guard brick toward the intruder", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 18, "down");
  const intruder = enemy(12, 20);
  const map = openMap();
  map[19][12] = "B";
  const ctx = context(defender, [], [intruder], map);
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  ctx.canEmergencyCollateralShot = (dir, target) => dir === "down" && target === intruder;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.target, intruder);
  assert.equal(action.dir, "down");
  assert.equal(action.fire, true, action.mode);
});

test("safe base-facing fire interrupts a different lock but nearby freeze still wins", () => {
  const engine = loadEngine();
  const defender = tank("player2", 12, 18, "down");
  const intruder = enemy(12, 20);
  const distant = enemy(4, 5);
  const map = openMap();
  map[21][12] = "B";
  const ctx = context(defender, [], [intruder, distant], map);
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  ctx.canShoot = ctx.canDirectShoot;
  const baseline = { dir: "left", moveDir: "left", fire: false,
    hold: false, mode: "core-chase", target: distant };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, distant);
  assert.equal(plan.kind, "base-lane-shot");
  assert.equal(plan.action.target, intruder);
  assert.equal(plan.action.dir, "down");
  assert.equal(plan.action.fire, true);
  assert.equal(plan.action.hold, true);
  const freeze = { x: defender.x + TILE, y: defender.y, w: 28, h: 28,
    type: "freeze", dead: false };
  ctx.bonuses = [freeze];
  const pickupPlan = engine.previewAdvisorGlobalControl(ctx, baseline, distant);
  assert.equal(pickupPlan.kind, "critical");
  assert.equal(pickupPlan.category, "freeze-control");
});

test("a verified close enemy interrupts a farther defense route outside the base zone", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "left");
  const nearby = enemy(14, 10);
  const ctx = context(defender, [], [nearby], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: nearby };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, nearby);
  assert.equal(plan.action.target, nearby);
  assert.equal(plan.action.dir, "left");
  assert.equal(plan.action.fire, true);
  assert.equal(plan.action.hold, false);
});

test("a nearby shot does not interrupt a closing turn or fire through a blocked lane", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "up");
  const nearby = enemy(14, 10);
  const map = openMap();
  const ctx = context(defender, [], [nearby], map);
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "left", moveDir: "left", fire: false,
    hold: false, mode: "core-global-defense-route", target: nearby };
  const aim = engine.previewAdvisorGlobalControl(ctx, baseline, nearby);
  assert.notEqual(aim.kind, "near-lane-shot");
  defender.dir = "left";
  map[10][15] = "S";
  const blocked = engine.previewAdvisorGlobalControl(ctx, baseline, nearby);
  assert.notEqual(blocked.kind, "near-lane-shot");
  assert.equal(blocked.action.fire, false);
});

test("a confirmed locked shot stops a route that moves away before turning", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "up");
  const nearby = enemy(14, 10);
  const ctx = context(defender, [], [nearby], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "right", moveDir: "right", fire: false,
    hold: false, mode: "core-global-defense-route", target: nearby };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, nearby);
  assert.equal(plan.kind, "near-lane-shot");
  assert.equal(plan.action.dir, "left");
  assert.equal(plan.action.fire, false);
  assert.equal(plan.action.hold, true);
});

test("an aligned point-blank hit may interrupt a farther nonurgent target", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "left");
  const nearby = enemy(15, 10);
  const assigned = enemy(7, 17);
  const ctx = context(defender, [], [assigned, nearby], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: assigned };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, assigned);
  assert.equal(plan.kind, "near-lane-shot");
  assert.equal(plan.action.target, nearby);
  assert.equal(plan.action.fire, true);
});

test("a different two-tile target does not steal a committed defense route", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "left");
  const nearby = enemy(14, 10);
  const assigned = enemy(7, 17);
  const ctx = context(defender, [], [assigned, nearby], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: assigned };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, assigned);
  assert.notEqual(plan.kind, "near-lane-shot");
});

test("a verified nearby shot fires without stealing the return-defense lock", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "left");
  const assigned = enemy(7, 17);
  const nearby = enemy(14, 10);
  const ctx = context(defender, [], [assigned, nearby], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: assigned };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, assigned);
  assert.equal(plan.kind, "opportunity-shot");
  assert.equal(plan.action.target, nearby);
  assert.equal(plan.action.fire, true);
  assert.equal(plan.lockedTarget, assigned);
  assert.equal(plan.retarget, null);
  defender.cooldown = 0.2;
  assert.notEqual(engine.previewAdvisorGlobalControl(ctx, baseline, assigned).kind, "opportunity-shot");
});

test("a nearby shot never fires through steel while returning", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 10, "left");
  const assigned = enemy(7, 17);
  const nearby = enemy(14, 10);
  const map = openMap();
  map[10][15] = "S";
  const ctx = context(defender, [], [assigned, nearby], map);
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === nearby;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: assigned };
  assert.notEqual(engine.previewAdvisorGlobalControl(ctx, baseline, assigned).kind, "opportunity-shot");
});

test("a clear flank shot near the base interrupts defense routing after aiming", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 20, "up");
  const intruder = enemy(13, 20);
  const ctx = context(defender, [], [intruder], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === intruder;
  ctx.canShoot = ctx.canDirectShoot;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: intruder };
  const aim = engine.previewAdvisorGlobalControl(ctx, baseline, intruder);
  assert.equal(aim.kind, "base-lane-shot");
  assert.equal(aim.action.dir, "left");
  assert.equal(aim.action.fire, false);
  assert.equal(aim.action.hold, true);
  defender.dir = "left";
  const fire = engine.previewAdvisorGlobalControl(ctx, baseline, intruder);
  assert.equal(fire.kind, "base-lane-shot");
  assert.equal(fire.action.fire, true);
  assert.equal(fire.action.target, intruder);
});

test("a guard brick or rejected direct hit never becomes a forced base-side shot", () => {
  const engine = loadEngine();
  const defender = tank("player2", 13, 20, "down");
  const intruder = enemy(13, 22);
  const map = openMap();
  map[21][13] = "B";
  const ctx = context(defender, [], [intruder], map);
  ctx.canDirectShoot = (dir) => dir === "down";
  ctx.canShoot = ctx.canDirectShoot;
  const baseline = { dir: "right", moveDir: "right", fire: false,
    hold: false, mode: "core-global-defense-route", target: intruder };
  assert.notEqual(engine.previewAdvisorGlobalControl(ctx, baseline, intruder).kind, "base-lane-shot");
  map[21][13] = ".";
  ctx.canDirectShoot = () => false;
  assert.notEqual(engine.previewAdvisorGlobalControl(ctx, baseline, intruder).kind, "base-lane-shot");
});

test("a confirmed flank hit beside guard bricks fires despite pessimistic motion prediction", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 20, "left");
  const intruder = enemy(14, 20);
  intruder.dir = "down";
  const map = openMap();
  map[21][14] = "B";
  const ctx = context(defender, [], [intruder], map);
  ctx.canDirectShoot = (dir, target) => dir === "left" && target === intruder;
  ctx.canShoot = () => false;
  const baseline = { dir: "down", moveDir: "down", fire: false,
    hold: false, mode: "core-global-defense-route", target: intruder };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, intruder);
  assert.equal(plan.kind, "base-lane-shot");
  assert.equal(plan.action.fire, true);
  assert.equal(plan.action.target, intruder);
  assert.equal(map[21][14], "B");
});

test("a cleared guard opening is traversable while intact protection remains closed", () => {
  const engine = loadEngine();
  const defender = tank("player2", 10, 21, "right");
  const map = Array.from({ length: 24 }, () => Array(26).fill("S"));
  for (let x = 10; x <= 15; x++) map[21][x] = ".";
  map[22][12] = "E";
  const ctx = context(defender, [], [], map);
  const goals = [{ x: 15, y: 21 }];
  assert.deepEqual(Array.from(engine.previewRelocationPath(ctx, goals), (cell) => cell.x),
    [10, 11, 12, 13, 14, 15]);
  map[21][12] = "B";
  assert.equal(engine.previewRelocationPath(ctx, goals).length, 0);
  map[21][12] = "E";
  assert.equal(engine.previewRelocationPath(ctx, goals).length, 0);
});

test("2P changes position instead of waiting after a protected brick blocks close fire", () => {
  const engine = loadEngine();
  const defender = tank("player2", 10, 21, "right");
  const intruder = enemy(13, 21);
  const map = openMap();
  map[21][11] = "B";
  map[22][12] = "E";
  const ctx = context(defender, [], [intruder], map);
  const action = { dir: "right", fire: true, hold: true,
    mode: "core-attack-fire", target: intruder };
  const revised = engine.previewGuardFireGate(ctx, action);
  assert.equal(revised.mode, "core-guard-shot-reposition");
  assert.equal(revised.fire, false);
  assert.equal(revised.hold, false);
  assert.notEqual(revised.moveDir, "right");
  assert.ok(ctx.plannedRoute?.length > 1);
  assert.equal(map[21][11], "B");
});

test("2P replans an obsolete intercept when an intruder reaches the base", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 18, "right");
  const intruder = enemy(14, 21);
  const ctx = context(defender, [], [intruder], openMap());
  const threat = { enemy: intruder, crossed: true, defenseTier: 1,
    dangerEta: 1, responseDeadline: 1, baseDistance: TILE * 3 };
  ctx.globalThreats = [threat];
  ctx.globalDirective = { target: intruder, threat, mission: { plan: {
    path: [{ x: 16, y: 18 }, { x: 17, y: 18 }, { x: 18, y: 18 }],
  } } };
  const plan = engine.previewAdvisorReliableReturn(ctx, {
    dir: "right", moveDir: "right", fire: false, hold: false,
    mode: "core-chase", target: intruder,
  });
  assert.ok(plan);
  assert.notDeepEqual(plan.route?.at(-1), { x: 18, y: 18 });
  assert.ok(Math.abs(plan.route.at(-1).x - 14) + Math.abs(plan.route.at(-1).y - 21) <= 2);
  assert.equal(plan.action.target, intruder);
});

test("a late base defender does not follow a route that moves away from the intruder", () => {
  const engine = loadEngine();
  const defender = tank("player2", 15, 20, "down");
  const intruder = enemy(12, 19);
  const ctx = context(defender, [], [intruder], openMap());
  const threat = { enemy: intruder, crossed: true, defenseTier: 1,
    dangerEta: 0.4, responseDeadline: 0.1, baseDistance: TILE * 3 };
  ctx.globalThreats = [threat];
  ctx.globalDirective = { target: intruder, threat, mission: { plan: {
    path: [{ x: 15, y: 20 }, { x: 15, y: 21 }, { x: 14, y: 21 }],
  } } };
  const plan = engine.previewAdvisorReliableReturn(ctx, {
    dir: "down", moveDir: "down", fire: false, hold: false,
    mode: "core-global-defense-route", target: intruder,
  });
  assert.ok(plan);
  assert.notEqual(plan.action.moveDir, "down", plan.action.mode);
  assert.equal(plan.action.target, intruder);
});

test("an ally beside a sealed lower-center screen approaches the base side instead of holding", () => {
  const engine = loadEngine();
  const defender = tank("player", 9, 18, "right");
  const intruder = enemy(12, 19, "fast");
  const map = openMap();
  for (let x = 10; x <= 15; x++) map[18][x] = "B";
  for (const x of [10, 11, 14, 15]) {
    map[19][x] = "S";
    map[20][x] = "B";
  }
  for (let x = 11; x <= 14; x++) map[21][x] = "B";
  map[22][12] = "E";
  const ctx = context(defender, [], [intruder], map);
  const threat = { enemy: intruder, crossed: true, defenseTier: 1,
    dangerEta: 1, responseDeadline: 1, baseDistance: TILE * 3 };
  ctx.globalThreats = [threat];
  ctx.globalDirective = { target: intruder, threat };
  const plan = engine.previewAdvisorReliableReturn(ctx, {
    dir: "right", moveDir: "right", fire: false, hold: false,
    mode: "core-chase", target: intruder,
  });
  assert.ok(plan?.route?.length > 1);
  assert.equal(plan.action.moveDir, "down");
  assert.equal(plan.action.hold, false);
  assert.ok(plan.route.every((cell) => map[cell.y][cell.x] !== "S"
    && !engine.previewProtectedDefenseBrick(ctx, cell.x, cell.y)));
});

test("a moving ally avoids entering a ready enemy's unobstructed firing lane", () => {
  const engine = loadEngine();
  const defender = tank("player2", 7, 5, "right");
  const shooter = enemy(8, 3);
  const ctx = context(defender, [], [shooter], openMap());
  const action = { dir: "right", moveDir: "right", fire: false, hold: false,
    mode: "core-chase", target: shooter };
  const revised = engine.previewEnemyMuzzleMoveGate(ctx, action);
  assert.equal(revised.mode, "core-muzzle-lane-detour");
  assert.equal(revised.dir, "up");
  assert.equal(revised.fire, false);
  assert.equal(revised.hold, false);
});

test("a distant muzzle lane cannot interrupt pursuit before the ally reaches it", () => {
  const engine = loadEngine();
  const defender = tank("player2", 5, 5, "right");
  const shooter = enemy(8, 3);
  const ctx = context(defender, [], [shooter], openMap());
  const action = { dir: "right", moveDir: "right", fire: false, hold: false,
    mode: "core-chase", target: shooter };
  assert.equal(engine.previewEnemyMuzzleMoveGate(ctx, action), action);
});

test("cover, reload and freeze make a projected enemy firing lane safe to cross", () => {
  const engine = loadEngine();
  const defender = tank("player", 7, 5, "right");
  const shooter = enemy(8, 3);
  const map = openMap();
  const ctx = context(defender, [], [shooter], map);
  const action = { dir: "right", moveDir: "right", fire: false, hold: false,
    mode: "core-chase", target: shooter };
  map[4][8] = "S";
  assert.equal(engine.previewEnemyMuzzleMoveGate(ctx, action), action);
  map[4][8] = ".";
  shooter.cooldown = 1.2;
  assert.equal(engine.previewEnemyMuzzleMoveGate(ctx, action), action);
  shooter.cooldown = 0;
  ctx.freezeTime = 2;
  assert.equal(engine.previewEnemyMuzzleMoveGate(ctx, action), action);
});

test("an ally already on a firing lane may keep its verified lethal shot", () => {
  const engine = loadEngine();
  const defender = tank("player", 5, 5, "right");
  const shooter = enemy(8, 5);
  shooter.dir = "left";
  shooter.cooldown = 0.45;
  const ctx = context(defender, [], [shooter], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "right" && target === shooter;
  const action = { dir: "right", moveDir: "right", fire: true, hold: false,
    mode: "core-contact-fire", target: shooter };
  assert.equal(engine.previewEnemyMuzzleMoveGate(ctx, action), action);
});

test("urgent defense assignment uses route response time and can interrupt a weaker commitment", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /function defenderResponseEta\(ctx, ally, threat\)/);
  assert.match(source, /function plannedDefenseKillEta\(ctx, ally, threat\)/);
  assert.match(source, /movementEta \+ turnTime\(arrivalDir, plan\.shotDir\)/);
  assert.match(source, /Math\.max\(Math\.max\(0, aimReadyEta\), reloadReadyEta\)/);
  assert.match(source, /\(hits - 1\) \* fireDelay/);
  assert.match(source, /Math\.max\(0, responseEta - threat\.responseDeadline\) \* 50000/);
  assert.match(source, /selected\?\.defenseTier <= 2[\s\S]{0,220}selected\.responseDeadline \+ 0\.5 < committedThreat\.responseDeadline/);
});

test("global defense planning isolates each ally from the active game callback context", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /function planningContextForAlly\(ctx, ally\)/);
  assert.match(source, /friends: allies\.filter\(\(item\) => item !== ally\)/);
  assert.match(source, /canDirectShoot: undefined/);
  assert.match(source, /const directDir = geometricCurrentShot\(ctx, ally, enemy\)/);
  assert.match(source, /plannedDefenseKillEta\(planningCtx, ally, threat\)/);
  assert.doesNotMatch(source, /const directDir = currentPositionShot\(ctx, ally, threat\.enemy\)/);
  assert.match(source, /const planningCtx = planningContextForAlly\(ctx, ally\)/);
  assert.match(source, /buildDefenseMission\(planningCtx, ally, selected, reservedCells\)/);
});

test("a steel-blocked ally does not steal an urgent assignment from a clear responder", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 20, "up");
  const p2 = tank("player2", 14, 14, "left");
  const urgent = enemy(10, 14, "fast");
  urgent.speed = 105;
  const decoy = enemy(3, 4);
  const map = openMap();
  for (let x = 0; x <= 12; x++) map[18][x] = "S";
  const c1 = context(p1, [p2], [decoy, urgent], map);
  const a1 = engine.createController("1P").decide(c1);
  p1.attackTarget = a1.lockedTarget;
  const c2 = context(p2, [p1], [decoy, urgent], map);
  c2.gameTime = 1.01;
  const a2 = engine.createController("2P").decide(c2);
  assert.equal(a2.lockedTarget, urgent, `1P=${a1.mode} 2P=${a2.mode}`);
  assert.notEqual(a1.lockedTarget, urgent, `1P=${a1.mode} 2P=${a2.mode}`);
});

test("defense assignment includes reload time and every required armor hit", () => {
  const engine = loadEngine();
  const p1 = tank("player", 12, 4, "down");
  const p2 = tank("player2", 19, 9, "left");
  p1.cooldown = 4;
  p1.fireDelay = 0.42;
  p2.cooldown = 0;
  p2.fireDelay = 0.45;
  const armor = enemy(12, 9, "armor");
  armor.hp = 4;
  armor.speed = 58;
  const decoy = enemy(3, 4);
  const map = openMap();
  const c1 = context(p1, [p2], [armor, decoy], map);
  const a1 = engine.createController("1P").decide(c1);
  p1.attackTarget = a1.lockedTarget;
  const c2 = context(p2, [p1], [armor, decoy], map);
  c2.gameTime = 1.01;
  const a2 = engine.createController("2P").decide(c2);
  assert.equal(a2.lockedTarget, armor, `1P=${a1.mode} 2P=${a2.mode}`);
  assert.notEqual(a1.lockedTarget, armor, `1P=${a1.mode} 2P=${a2.mode}`);
});

test("closing enemies keep an early intercept plan with a base-side fallback", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /function reliableDefensePlan\(ctx, tank, threat, reservedCells = new Set\(\)\)/);
  assert.match(source, /globalInterceptPlan\(ctx, tank, enemy, threat, reservedCells\)[\s\S]{0,80}buildInterceptPlan\(ctx, tank, enemy, threat, reservedCells\)/);
  assert.match(source, /selectReliableInterceptProbe\(/);
  assert.match(source, /defensePlan: "EARLY_INTERCEPT"/);
  assert.match(source, /defensePlan: "BASE_SIDE_FALLBACK"/);
  assert.match(source, /const assignedDefensePlan = ctx\.globalDirective\?\.target === target/);
  assert.doesNotMatch(source, /!closingIn\)\)/);
});

test("a reliable intercept is reachable, base-side, and finishes before the defense deadline", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 18, "up");
  defender.fireDelay = 0.45;
  const attacker = enemy(6, 4, "fast");
  attacker.speed = 105;
  const ctx = context(defender, [], [attacker], openMap());

  const plan = engine.previewReliableIntercept(ctx, defender, attacker);
  assert.ok(plan?.path?.length >= 2, JSON.stringify(plan));
  assert.equal(plan.defensePlan, "EARLY_INTERCEPT");
  assert.equal(plan.shieldSide, true);
  assert.ok(plan.margin >= 0.18, JSON.stringify(plan));
  assert.ok(plan.deadlineSpare >= 0.08, JSON.stringify(plan));
  assert.equal(plan.brickCount, 0);
  assert.equal(plan.path.at(-1).x, plan.cell.x);
  assert.equal(plan.path.at(-1).y, plan.cell.y);

  const nextCell = plan.path[1];
  defender.x = nextCell.x * TILE + 2;
  defender.y = nextCell.y * TILE + 2;
  const committed = engine.previewRefreshIntercept(ctx, defender, attacker, plan);
  assert.ok(committed?.path?.length, JSON.stringify(committed));
  assert.equal(committed.cell.x, plan.cell.x);
  assert.equal(committed.cell.y, plan.cell.y);
  assert.ok(committed.margin >= plan.margin - 0.05);
});

test("near-base flank planning keeps both passable sides available", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 18);
  const intruder = enemy(12, 20);
  const ctx = context(defender, [], [intruder], openMap());
  const goals = engine.previewFlankGoals(ctx, intruder);
  assert.deepEqual(Array.from(goals, (goal) => goal.x), [10, 15]);
  ctx.map[20][10] = "S";
  assert.deepEqual(Array.from(engine.previewFlankGoals(ctx, intruder), (goal) => goal.x), [15]);
});

test("reachable side interception survives higher-ranked blocked vertical probes", () => {
  const engine = loadEngine();
  const defender = tank("player", 8, 16, "right");
  const attacker = enemy(8, 9);
  const map = openMap();
  for (let y = 0; y < 18; y++) map[y][12] = "S";
  const ctx = context(defender, [], [attacker], map);
  const vertical = Array.from({ length: 18 }, (_, y) => ({
    cell: { x: 12, y }, enemyCell: { x: 12, y: Math.max(0, y - 2) },
    shotDir: "up", shieldSide: true, enemyEta: 10,
    flightEta: 0.1, optimisticAllyEta: 0, distance: 2,
  }));
  const side = { cell: { x: 10, y: 16 }, enemyCell: { x: 8, y: 16 },
    shotDir: "left", shieldSide: true, enemyEta: 5,
    flightEta: 0.2, optimisticAllyEta: 1, distance: 2 };
  const plan = engine.previewInterceptProbes(ctx, defender, attacker,
    [...vertical, side], 15);
  assert.equal(plan?.shotDir, "left");
  assert.deepEqual([plan.cell.x, plan.cell.y], [10, 16]);
  assert.ok(plan.path.length > 1);
});

test("a direct base shooter becomes a terminal mission instead of an early intercept", () => {
  const engine = loadEngine();
  const defender = tank("player", 9, 18, "up");
  const intruder = enemy(12, 20);
  intruder.dir = "down";
  const ctx = context(defender, [], [intruder], openMap());
  const mission = engine.previewDefenseMission(ctx, defender, intruder);

  assert.equal(mission.phase, "TERMINAL");
  assert.equal(mission.target, intruder);
  assert.ok(mission.plan?.path?.length, JSON.stringify(mission));
  assert.equal(mission.plan?.terminal, true);
});

test("terminal defense favors an on-time kill, but shields when every shot is late", () => {
  const engine = loadEngine();
  const onTime = { reserved: false, deadlineSpare: 0.1, shieldSide: false, killEta: 1,
    shieldDepth: 0 };
  const lateShield = { reserved: false, deadlineSpare: -0.1, shieldSide: true, killEta: 1.2,
    shieldDepth: 32 };
  const lateOpen = { reserved: false, deadlineSpare: -0.05, shieldSide: false, killEta: 1.15,
    shieldDepth: 0 };
  assert.deepEqual(Array.from(engine.previewTerminalCandidateOrder([lateShield, onTime])),
    [onTime, lateShield]);
  assert.deepEqual(Array.from(engine.previewTerminalCandidateOrder([lateOpen, lateShield])),
    [lateShield, lateOpen]);
});

test("two defenders sharing one terminal threat receive different firing cells", () => {
  const engine = loadEngine();
  const p1 = tank("player", 9, 18, "up");
  const p2 = tank("player2", 16, 18, "up");
  const intruder = enemy(12, 20);
  intruder.dir = "down";
  const ctx = context(p1, [p2], [intruder], openMap());
  const state = engine.previewGlobalBattle(ctx, 10);
  const first = state.assignments.get(p1)?.mission;
  const second = state.assignments.get(p2)?.mission;

  assert.equal(first?.phase, "TERMINAL");
  assert.equal(second?.phase, "TERMINAL");
  assert.ok(first?.goal && second?.goal);
  assert.notEqual(`${first.goal.x},${first.goal.y}`, `${second.goal.x},${second.goal.y}`);
});

test("separate base intruders do not send both defenders to one firing cell", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 18, "up");
  const p2 = tank("player2", 15, 18, "up");
  const left = enemy(11, 20);
  const right = enemy(14, 20);
  const ctx = context(p1, [p2], [left, right], openMap());
  const state = engine.previewGlobalBattle(ctx, 10);
  const first = state.assignments.get(p1)?.mission;
  const second = state.assignments.get(p2)?.mission;
  assert.notEqual(first?.target, second?.target);
  assert.ok(first?.goal && second?.goal);
  assert.notEqual(`${first.goal.x},${first.goal.y}`, `${second.goal.x},${second.goal.y}`);
});

test("two pressured flanks keep one defender per side even with two left intruders", () => {
  for (const [leftY, secondY, rightY] of [
    [20, 19, 19], [21, 20, 18], [20, 20, 16], [20, 19, 13],
  ]) {
    const engine = loadEngine();
    const p1 = tank("player", 10, 17, "up");
    const p2 = tank("player2", 16, 17, "up");
    const leftNear = enemy(10, leftY, "fast");
    const leftSecond = enemy(11, secondY);
    const right = enemy(17, rightY, "fast");
    const ctx = context(p1, [p2], [leftNear, leftSecond, right], openMap());
    const state = engine.previewGlobalBattle(ctx, 10);
    assert.equal(state.assignments.get(p1)?.target, leftNear);
    assert.equal(state.assignments.get(p2)?.target, right,
      `y=${leftY},${secondY},${rightY} 2P=${state.assignments.get(p2)?.target?.x}`);
  }
});

test("a right-lane intruder gets coverage after both defenders drift left", () => {
  for (const p2X of [8, 12]) {
    for (const rightY of [15, 19]) {
      const engine = loadEngine();
      const p1 = tank("player", 8, 16, "up");
      const p2 = tank("player2", p2X, 16, "up");
      const leftNear = enemy(9, 19, "fast");
      const leftSecond = enemy(10, 18);
      const right = enemy(18, rightY, "fast");
      const ctx = context(p1, [p2], [leftNear, leftSecond, right], openMap());
      const state = engine.previewGlobalBattle(ctx, 10);
      assert.ok([state.assignments.get(p1)?.target, state.assignments.get(p2)?.target].includes(right),
        `p2X=${p2X} rightY=${rightY} 1P=${state.assignments.get(p1)?.target?.x} 2P=${state.assignments.get(p2)?.target?.x}`);
    }
  }
});

test("new right-lane pressure releases the right defender's left-side commitment", () => {
  const engine = loadEngine();
  const p1 = tank("player", 8, 17, "up");
  const p2 = tank("player2", 12, 17, "up");
  const leftNear = enemy(9, 20, "fast");
  const leftSecond = enemy(10, 18);
  const right = enemy(17, 18, "fast");
  const map = openMap();
  const ctx = context(p1, [p2], [leftNear, leftSecond], map);
  const initial = engine.previewGlobalBattle(ctx, 10);
  assert.ok(initial.assignments.get(p2)?.target);
  ctx.enemies.push(right);
  const updated = engine.previewGlobalBattle(ctx, 10.01);
  assert.equal(updated.assignments.get(p1)?.target, leftNear);
  assert.equal(updated.assignments.get(p2)?.target, right);
});

test("a new enemy beside the base interrupts a distant committed assignment", () => {
  for (const [x, y] of [[10, 20], [9, 19], [10, 18], [15, 19], [16, 20]]) {
    const engine = loadEngine();
    const p1 = tank("player", 7, 14, "up");
    const p2 = tank("player2", 18, 14, "up");
    for (const farY of [7, 15]) {
      const leftFar = enemy(5, farY);
      const rightFar = enemy(20, farY);
      const ctx = context(p1, [p2], [leftFar, rightFar], openMap());
      const first = engine.previewGlobalBattle(ctx, 10);
      assert.equal(first.assignments.get(p1)?.target, leftFar);
      assert.equal(first.assignments.get(p2)?.target, rightFar);

      const intruder = enemy(x, y);
      ctx.enemies.push(intruder);
      const updated = engine.previewGlobalBattle(ctx, 10.01);
      assert.ok([updated.assignments.get(p1)?.target, updated.assignments.get(p2)?.target].includes(intruder),
        `one defender must immediately take the enemy at ${x},${y} beside the base; farY=${farY}`);
    }
  }
});

test("base-perimeter intruder takes priority over two committed guard-brick attackers", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 15, "up");
  const p2 = tank("player2", 18, 15, "up");
  const map = openMap();
  map[21][11] = "B";
  map[21][14] = "B";
  const left = enemy(11, 16);
  const right = enemy(14, 16);
  const ctx = context(p1, [p2], [left, right], map);
  const initial = engine.previewGlobalBattle(ctx, 10);
  assert.ok(initial.assignments.get(p1)?.target);
  assert.ok(initial.assignments.get(p2)?.target);

  const intruder = enemy(9, 20);
  ctx.enemies.push(intruder);
  const updated = engine.previewGlobalBattle(ctx, 10.01);
  assert.ok([updated.assignments.get(p1)?.target, updated.assignments.get(p2)?.target].includes(intruder),
    `near-base target was omitted: ${updated.threats.map((threat) =>
      `${threat.enemy.x / TILE}:${threat.defenseTier}/${threat.dangerEta.toFixed(1)}`).join(" ")}`);
});

test("a clear firing lane to a base guard brick gets a defender before the shot", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 11, "up");
  const p2 = tank("player2", 18, 16, "up");
  const map = openMap();
  map[21][11] = "B";
  const guardShooter = enemy(11, 8);
  const leftPressure = enemy(5, 16);
  const rightPressure = enemy(18, 16);
  const ctx = context(p1, [p2], [leftPressure, rightPressure], map);
  engine.previewGlobalBattle(ctx, 10);

  ctx.enemies.push(guardShooter);
  const state = engine.previewGlobalBattle(ctx, 10.01);
  assert.equal(state.threats.find((threat) => threat.enemy === guardShooter)?.direct?.target, "guard");
  assert.ok([...state.assignments.values()].some((assignment) => assignment.target === guardShooter),
    "an enemy with a clear shot at the guard brick must not be omitted");
  const defender = [...state.assignments.entries()].find(([, assignment]) => assignment.target === guardShooter);
  assert.equal(defender?.[0], p1, "the nearer left defender should cover the guard firing lane");
  assert.ok(defender?.[1].mission?.plan?.path?.length,
    "guard defense needs an actionable intercept route, not only a target label");
  assert.equal(defender?.[1].mission?.plan?.shieldSide, true,
    "the intercept should put the defender between the shooter and the guarded base");
  assert.ok(defender[1].mission.plan.allyEta < state.threats.find((threat) =>
    threat.enemy === guardShooter).direct.eta,
  "the defender should reach the shield lane before the enemy projectile reaches the brick");
  ctx.gameTime = 10.01;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.lockedTarget, guardShooter);
  assert.ok(action.fire || !action.hold,
    `guard defense must fire or move toward its intercept, not idle: ${action.mode}`);
});

test("side guard-brick lanes keep separate left and right intercept missions", () => {
  const engine = loadEngine();
  const p1 = tank("player", 8, 18, "down");
  const p2 = tank("player2", 17, 18, "down");
  const map = openMap();
  map[21][11] = "B";
  map[21][14] = "B";
  const left = enemy(8, 21);
  left.dir = "right";
  const right = enemy(17, 21);
  right.dir = "left";
  const ctx = context(p1, [p2], [left, right], map);
  const state = engine.previewGlobalBattle(ctx, 10);
  assert.equal(state.threats.find((threat) => threat.enemy === left)?.direct?.target, "guard");
  assert.equal(state.threats.find((threat) => threat.enemy === right)?.direct?.target, "guard");
  assert.equal(state.assignments.get(p1)?.target, left);
  assert.equal(state.assignments.get(p2)?.target, right);
  assert.equal(state.assignments.get(p1)?.mission?.plan?.shieldSide, true);
  assert.equal(state.assignments.get(p2)?.mission?.plan?.shieldSide, true);
});

test("a lone defender takes the guard shooter over a farther base approach", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 11, "up");
  const map = openMap();
  map[21][11] = "B";
  const guardShooter = enemy(11, 8);
  const approach = enemy(5, 16);
  const ctx = context(p1, [], [guardShooter, approach], map);
  assert.equal(engine.previewGlobalBattle(ctx, 10).assignments.get(p1)?.target, guardShooter);
});

test("a defender drops a distant guard shooter when an enemy passes behind it", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 14, "up");
  const p2 = tank("player2", 18, 14, "up");
  const map = openMap();
  map[21][11] = "B";
  const farGuardShooter = enemy(11, 7);
  const rightTarget = enemy(20, 7);
  const ctx = context(p1, [p2], [farGuardShooter, rightTarget], map);
  const first = engine.previewGlobalBattle(ctx, 10);
  assert.equal(first.assignments.get(p1)?.target, farGuardShooter);

  const intruder = enemy(9, 16);
  ctx.enemies.push(intruder);
  const updated = engine.previewGlobalBattle(ctx, 10.01);
  assert.equal(updated.assignments.get(p1)?.target, intruder,
    "1P should turn back for the enemy that has passed its position");
  assert.equal(updated.assignments.get(p2)?.target, rightTarget);
  ctx.gameTime = 10.01;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.lockedTarget, intruder,
    "the live controller must follow the return assignment instead of its old distant lock");
  assert.ok(action.target !== farGuardShooter || (action.fire && !action.hold),
    "a distant shot must not delay the return route");
  assert.ok(action.fire || !action.hold,
    `the defender must start firing or returning immediately: ${action.mode}`);
});

test("2P turns back for a right-lane bypass without stealing 1P's target", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 14, "up");
  const p2 = tank("player2", 15, 14, "up");
  const map = openMap();
  map[21][14] = "B";
  const leftTarget = enemy(5, 7);
  const farGuardShooter = enemy(14, 7);
  const ctx = context(p2, [p1], [leftTarget, farGuardShooter], map);
  const first = engine.previewGlobalBattle(ctx, 10);
  assert.equal(first.assignments.get(p2)?.target, farGuardShooter);

  const intruder = enemy(16, 16);
  ctx.enemies.push(intruder);
  const updated = engine.previewGlobalBattle(ctx, 10.01);
  assert.equal(updated.assignments.get(p2)?.target, intruder);
  assert.equal(updated.assignments.get(p1)?.target, leftTarget);
  ctx.gameTime = 10.01;
  const action = engine.createController("2P").decide(ctx);
  assert.equal(action.lockedTarget, intruder);
  assert.ok(action.fire || !action.hold,
    `2P must start firing or returning immediately: ${action.mode}`);
});

test("a top-screen overlap is not mistaken for an urgent base breakthrough", () => {
  const engine = loadEngine();
  const p1 = tank("player", 9, 3, "up");
  const candidate = enemy(9, 4);
  const ctx = context(p1, [], [candidate], openMap());
  const threat = engine.previewGlobalBattle(ctx, 10).threats[0];
  assert.equal(threat.bypassed, false);
});

test("mission separation yields only to a reachable near-equal on-time firing cell", () => {
  const engine = loadEngine();
  const primary = { plan: { cell: { x: 12, y: 17 }, killEta: 1.2 } };
  const alternate = { plan: { cell: { x: 14, y: 17 }, killEta: 1.4 } };
  const occupied = ["12,17"];
  assert.equal(engine.previewMissionSeparation(primary, alternate, occupied, 2.2), alternate);
  assert.equal(engine.previewMissionSeparation(primary, alternate, occupied, 2), primary,
    "do not trade an urgent base deadline for spacing");
  assert.equal(engine.previewMissionSeparation(primary,
    { plan: { cell: { x: 14, y: 17 }, killEta: 1.6 } }, occupied, 3), primary,
  "do not send a defender on a slower detour");
  assert.equal(engine.previewMissionSeparation(primary, alternate, ["14,17"], 3), primary);
});

test("two defenders sharing the final distant enemy reserve different intercept cells", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 18, "up");
  const p2 = tank("player2", 16, 18, "up");
  const last = enemy(6, 4, "fast");
  last.speed = 105;
  const ctx = context(p1, [p2], [last], openMap());
  const state = engine.previewGlobalBattle(ctx, 20);
  const first = state.assignments.get(p1)?.mission;
  const second = state.assignments.get(p2)?.mission;

  assert.equal(first?.phase, "INTERCEPT");
  assert.equal(second?.phase, "INTERCEPT");
  assert.ok(first?.goal && second?.goal);
  assert.notEqual(`${first.goal.x},${first.goal.y}`, `${second.goal.x},${second.goal.y}`);
});

test("defense route progress uses real sub-tile movement rather than only cell changes", () => {
  const engine = loadEngine();
  const defender = tank("player", 5, 5, "down");
  const route = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 5, y: 7 }];
  const before = engine.previewDefenseRouteMetric(defender, route);
  defender.y += 12;
  const after = engine.previewDefenseRouteMetric(defender, route);
  assert.ok(after < before - 8, `${before}:${after}`);
});

test("entering the final route cell does not falsely finish physical alignment", () => {
  const engine = loadEngine();
  const defender = tank("player", 5, 5, "down");
  const route = [{ x: 5, y: 4 }, { x: 5, y: 5 }];
  defender.y -= 10;
  const before = engine.previewDefenseRouteMetric(defender, route);
  assert.ok(before >= 10);
  defender.y += 10;
  assert.ok(engine.previewDefenseRouteMetric(defender, route) < before);
});

test("a defense route that makes no physical progress is replaced within one second", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 18, "up");
  const intruder = enemy(10, 22);
  const controller = engine.createController("2P");
  let action = null;
  for (const time of [10, 10.3, 10.6, 10.95]) {
    const ctx = context(defender, [], [intruder], openMap());
    ctx.gameTime = time;
    action = controller.decide(ctx);
  }
  assert.match(action?.mode || "", /^core-defense-contract-(?:recover|clear)$/);
  assert.equal(action?.hold, false);
  assert.equal(action?.lockedTarget, intruder);
});

test("physical detour progress does not trigger emergency route recovery", () => {
  const engine = loadEngine();
  const defender = tank("player2", 16, 18, "up");
  const intruder = enemy(10, 22);
  const controller = engine.createController("2P");
  for (const time of [10, 10.3, 10.6, 10.95]) {
    defender.y -= 12;
    const ctx = context(defender, [], [intruder], openMap());
    ctx.gameTime = time;
    const action = controller.decide(ctx);
    assert.doesNotMatch(action?.mode || "", /^core-defense-contract-(?:recover|clear)$/);
    assert.equal(action?.lockedTarget, intruder);
  }
});

test("terminal defense executes before the legacy base corridor", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  const terminal = source.indexOf("if (freezeRemaining <= 0 && terminalMission)");
  const corridor = source.indexOf("if (assignedBaseIntruder)", terminal);
  assert.ok(terminal >= 0 && corridor > terminal);
  assert.match(source, /mission\.phase === "TERMINAL"[\s\S]{0,220}mission\.phase === "INTERCEPT"/);
  assert.match(source, /defense_route_stall/);
});

test("a nearby base intruder enters immediate mobile melee", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 19, "right");
  const p2 = tank("player2", 20, 8);
  const intruder = enemy(12, 19);
  const decoy = enemy(20, 3);
  const ctx = context(p1, [p2], [intruder, decoy], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "right" && target === intruder;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.lockedTarget, intruder);
  assert.equal(action.mode, "core-terminal-base-melee-fire");
  assert.equal(action.fire, true);
  assert.equal(action.hold, false);
});

test("near-base terminal combat preserves separate ally assignments", () => {
  const engine = loadEngine();
  const p1 = tank("player", 7, 19, "right");
  const p2 = tank("player2", 18, 19, "left");
  const left = enemy(11, 19);
  const right = enemy(14, 19);
  const decoy = enemy(2, 3);
  const map = openMap();
  const a1 = engine.createController("1P").decide(context(p1, [p2], [left, right, decoy], map));
  p1.attackTarget = a1.lockedTarget;
  const second = context(p2, [p1], [left, right, decoy], map);
  second.gameTime = 1.01;
  const a2 = engine.createController("2P").decide(second);
  assert.notEqual(a1.lockedTarget, a2.lockedTarget,
    `1P=${a1.lockedTarget?.x}/${a1.mode} 2P=${a2.lockedTarget?.x}/${a2.mode}`);
  assert.deepEqual(new Set([a1.lockedTarget, a2.lockedTarget]), new Set([left, right]));
});

test("three simultaneous lower-lane intruders keep distinct defender targets", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 17, "up");
  const p2 = tank("player2", 15, 17, "left");
  const basic = enemy(10, 21);
  const armor = enemy(11, 20, "armor");
  armor.hp = 2;
  const fast = enemy(17, 19, "fast");
  const map = openMap();
  const first = engine.createController("1P").decide(context(p1, [p2], [basic, armor, fast], map));
  p1.attackTarget = first.lockedTarget;
  const secondCtx = context(p2, [p1], [basic, armor, fast], map);
  secondCtx.gameTime = 1.01;
  const second = engine.createController("2P").decide(secondCtx);
  assert.notEqual(first.lockedTarget, second.lockedTarget,
    `1P=${first.mode}:${first.lockedTarget?.kind} 2P=${second.mode}:${second.lockedTarget?.kind}`);
});

test("lower-lane assignments stay separate as three enemies advance", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 17);
  const p2 = tank("player2", 15, 17);
  const basic = enemy(10, 21);
  const armor = enemy(11, 20, "armor");
  armor.hp = 2;
  const fast = enemy(17, 19, "fast");
  fast.speed = 105;
  const distant = enemy(8, 1, "fast");
  const map = openMap();
  const c1 = engine.createController("1P");
  const c2 = engine.createController("2P");
  for (const [time, positions] of [
    [295, [[349, 567], [483, 564], [324, 684], [360, 641], [545, 590], [273, 37]]],
    [295.5, [[319, 543], [462, 531], [324, 711], [368, 641], [545, 630], [284, 81]]],
    [296, [[298, 576], [430, 554], [324, 730], [397, 642], [545, 685], [273, 125]]],
  ]) {
    for (const [item, point] of [p1, p2, basic, armor, fast, distant].map((item, i) => [item, positions[i]])) {
      [item.x, item.y] = point;
    }
    const ctx1 = context(p1, [p2], [basic, armor, fast, distant], map);
    ctx1.gameTime = time;
    const a1 = c1.decide(ctx1);
    p1.attackTarget = a1.lockedTarget;
    const ctx2 = context(p2, [p1], [basic, armor, fast, distant], map);
    ctx2.gameTime = time + 0.01;
    const a2 = c2.decide(ctx2);
    p2.attackTarget = a2.lockedTarget;
    assert.notEqual(a1.lockedTarget, a2.lockedTarget,
      `${time}: 1P=${a1.mode}:${a1.lockedTarget?.kind}/${ctx1.globalDirective?.target?.kind}`
      + ` 2P=${a2.mode}:${a2.lockedTarget?.kind}/${ctx2.globalDirective?.target?.kind}`);
  }
});

test("a unique base-side intruder receives both defenders before its final shot", () => {
  const engine = loadEngine();
  const p1 = tank("player", 8, 18, "down");
  const p2 = tank("player2", 17, 18, "down");
  const intruder = enemy(10, 22);
  const distant = enemy(2, 2);
  const map = openMap();
  const a1 = engine.createController("1P").decide(context(p1, [p2], [intruder, distant], map));
  p1.attackTarget = a1.lockedTarget;
  const second = context(p2, [p1], [intruder, distant], map);
  second.gameTime = 1.01;
  const a2 = engine.createController("2P").decide(second);

  assert.equal(a1.lockedTarget, intruder, `1P=${a1.mode}`);
  assert.equal(a2.lockedTarget, intruder, `2P=${a2.mode}`);
});

test("terminal base arbitration only shares a unique immediate base shooter", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  const terminalBody = source.slice(
    source.indexOf("function terminalBaseDefenseAction"),
    source.indexOf("function incomingBulletAction"),
  );
  assert.match(terminalBody, /const assignedIntruder = candidates\.find/);
  assert.match(terminalBody, /const sharedTerminal = terminalBaseThreats\.length === 1/);
  assert.match(terminalBody, /const unclaimedIntruder = candidates\.find/);
  assert.match(terminalBody, /pointBlankIntruder \|\| sharedTerminal \|\| assignedIntruder \|\| unclaimedIntruder/);
});

test("terminal base melee stays behind pickup, dodge, and projectile shielding", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /function terminalBaseDefenseAction\(ctx, tank, now\)/);
  assert.match(source, /ctx\.globalThreats \|\| \[\][\s\S]{0,120}item\.defenseTier <= 1/);
  const pickupIndex = source.indexOf("if (freeze && tileRange(tank, freeze) <= 3)");
  const bulletIndex = source.indexOf("if (enemyBullet)", pickupIndex);
  const shieldIndex = source.indexOf("if (baseProjectilePlan)", bulletIndex);
  const meleeIndex = source.indexOf("terminalBaseDefenseAction(ctx, tank, now)", shieldIndex);
  assert.ok(pickupIndex >= 0 && pickupIndex < bulletIndex && bulletIndex < shieldIndex && shieldIndex < meleeIndex);
});

test("advisor takes authority over a shell lane that protects the base", () => {
  const engine = loadEngine();
  const defender = tank("player", 12, 19, "up");
  const shooter = enemy(12, 10);
  const shell = {
    x: defender.x + 11,
    y: 15 * TILE + 13,
    w: 6,
    h: 6,
    dir: "down",
    speed: 230,
    enemy: true,
    dead: false,
    owner: shooter,
  };
  const freeze = { type: "freeze", x: 13 * TILE + 8, y: 19 * TILE + 8, w: 16, h: 16, dead: false };
  const ctx = context(defender, [], [shooter], openMap(), [freeze]);
  ctx.bullets = [shell];
  const action = engine.createController("1P").decide(ctx);

  assert.match(action.mode, /base-shield/);
  assert.equal(action.hold, true);
  assert.equal(action.advisor.participation, "full-control");
});

test("advisor keeps a three-tile freeze ahead of an ordinary personal dodge", () => {
  const engine = loadEngine();
  const defender = tank("player", 6, 10, "up");
  const shooter = enemy(6, 5);
  const shell = {
    x: defender.x + 11,
    y: defender.y - 45,
    w: 6,
    h: 6,
    dir: "down",
    speed: 230,
    enemy: true,
    dead: false,
    owner: shooter,
  };
  const freeze = { type: "freeze", x: 7 * TILE + 8, y: 10 * TILE + 8, w: 16, h: 16, dead: false };
  const ctx = context(defender, [], [shooter], openMap(), [freeze]);
  ctx.bullets = [shell];
  const action = engine.createController("1P").decide(ctx);

  assert.match(action.mode, /^core-freeze-pickup/);
  assert.equal(action.advisor.participation, "full-control");
});

test("a base-bound shell remains an intercept mission after its shooter dies", () => {
  const engine = loadEngine();
  const defender = tank("player", 11, 15, "right");
  const decoy = enemy(2, 2);
  const deadShooter = enemy(12, 5);
  deadShooter.alive = false;
  const shell = {
    x: 12 * TILE + 13,
    y: 8 * TILE + 13,
    w: 6,
    h: 6,
    dir: "down",
    speed: 230,
    enemy: true,
    dead: false,
    owner: deadShooter,
  };
  const ctx = context(defender, [], [decoy], openMap());
  ctx.bullets = [shell];
  const action = engine.createController("1P").decide(ctx);

  assert.match(action.mode, /^core-base-bullet-intercept/);
  assert.notEqual(action.lockedTarget, deadShooter);
  assert.equal(action.advisor.participation, "full-control");
});

test("base threat paths and firing goals are cached outside the per-frame context", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /const baseThreatPathCaches = new WeakMap\(\)/);
  assert.match(source, /const cacheOwner = ctx\.map \|\| ctx/);
  assert.match(source, /const pathKey = `\$\{Number\(ctx\.mapVersion \|\| 0\)\}:\$\{enemyCell\.x\},\$\{enemyCell\.y\}:\$\{enemy\.dir\}/);
  assert.match(source, /ctx\.globalThreats = globalState\.threats/);
  const terminalBody = source.slice(
    source.indexOf("function terminalBaseDefenseAction"),
    source.indexOf("function incomingBulletAction"),
  );
  assert.doesNotMatch(terminalBody, /baseDefenseProfile\(/);
});

test("repeated near-base decisions reuse the shared threat analysis", () => {
  const engine = loadEngine();
  const controller = engine.createController("1P");
  const p1 = tank("player", 10, 19, "right");
  const p2 = tank("player2", 15, 19, "left");
  const enemies = Array.from({ length: 8 }, (_, index) => enemy(3 + index * 2, 16 + index % 3, index % 3 === 0 ? "fast" : "basic"));
  const map = openMap();
  let firstReads = 0;
  const first = context(p1, [p2], enemies, map);
  first.tileAt = (x, y) => { firstReads++; return map[y]?.[x] || "S"; };
  controller.decide(first);

  let secondReads = 0;
  const second = context(p1, [p2], enemies, map);
  second.gameTime = 1.01;
  second.tileAt = (x, y) => { secondReads++; return map[y]?.[x] || "S"; };
  controller.decide(second);
  assert.ok(firstReads > 100);
  assert.ok(secondReads < firstReads * 0.35, `expected cached reads, got ${secondReads}/${firstReads}`);
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
  const committed = enemy(10, 13);
  committed.y = p1.y + TILE * 2.9;
  const distractor = enemy(8, 10);
  distractor.x = p1.x - TILE * 2.6;
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

test("a same-direction tail chase fires immediately on a predictive lane", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 14, "up");
  const p2 = tank("player2", 20, 20);
  const fleeing = enemy(10, 10, "fast");
  fleeing.dir = "up";
  fleeing.x += 12;
  const ctx = context(p1, [p2], [fleeing], openMap());
  ctx.canDirectShoot = () => false;
  ctx.canShoot = () => false;
  ctx.canPredictShoot = (dir, target) => dir === "up" && target === fleeing;
  const action = engine.createController("1P").decide(ctx);
  assert.equal(action.lockedTarget, fleeing);
  assert.match(action.mode, /^core-(?:same-direction-chase|defense-contract)-fire$/);
  assert.equal(action.dir, "up");
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
  assert.equal(action.advisor.participation, "full-control");
});

test("a verified projectile counter lets the tank resume pursuit instead of dodging", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "up");
  const shooter = enemy(10, 6);
  const incoming = { owner: shooter, enemy: true, x: p1.x + 11, y: p1.y - 100,
    w: 6, h: 6, dir: "down", speed: 230 };
  const counter = { owner: p1, enemy: false, x: p1.x + 11, y: p1.y - 32,
    w: 6, h: 6, dir: "up", speed: 310 };
  const ctx = context(p1, [], [shooter], openMap());
  ctx.bullets = [incoming, counter];

  assert.equal(engine.previewCounterInterception(ctx, incoming), true);
  assert.equal(engine.previewMovementBulletThreat(ctx, "up"), null);
  const action = engine.createController("1P").decide(ctx);
  assert.doesNotMatch(action.mode, /evade|dodge|counter|bullet/);
  assert.equal(action.lockedTarget, shooter);
});

test("a near-miss or already occupied counter lane still requires bullet defense", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "up");
  const shooter = enemy(10, 6);
  const incoming = { owner: shooter, enemy: true, x: p1.x + 11, y: p1.y - 65,
    w: 6, h: 6, dir: "down", speed: 230 };
  const counter = { owner: p1, enemy: false, x: p1.x + 11, y: p1.y - 32,
    w: 6, h: 6, dir: "up", speed: 310 };
  const ctx = context(p1, [], [shooter], openMap());
  ctx.bullets = [incoming, { ...counter, x: counter.x + 7 }];
  assert.equal(engine.previewCounterInterception(ctx, incoming), false);
  assert.ok(engine.previewMovementBulletThreat(ctx, "up"));

  ctx.bullets = [incoming, counter, { ...incoming, y: incoming.y - 14 }];
  assert.equal(engine.previewCounterInterception(ctx, ctx.bullets[2]), false,
    "one friendly shell cannot guarantee interception of two incoming shells");
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
  assert.equal(action.advisor.participation, "full-control");
});

test("expiring invulnerability does not hide a shell arriving afterward", () => {
  const engine = loadEngine();
  const p1 = tank("player", 10, 10, "up");
  p1.invuln = 0.12;
  const shooter = enemy(13, 6);
  const shell = { owner: shooter, enemy: true, x: p1.x + 11, y: p1.y - 100,
    w: 6, h: 6, dir: "down", speed: 230 };
  const ctx = context(p1, [], [shooter], openMap());
  ctx.bullets = [shell];
  const action = engine.createController("1P").decide(ctx);
  assert.match(action.mode, /^core-evade-bullet/);
  assert.equal(action.hold, false);
});

test("movement forecast compares collision time to remaining invulnerability", () => {
  const engine = loadEngine();
  const p1 = tank("player", 8, 10, "right");
  p1.invuln = 0.15;
  const shell = { enemy: true, x: p1.x + 50, y: p1.y - 120,
    w: 6, h: 6, dir: "down", speed: 230 };
  const ctx = context(p1, [], [], openMap());
  ctx.bullets = [shell];
  assert.ok(engine.previewMovementBulletThreat(ctx, "right", 0.9));
  p1.invuln = 1.1;
  assert.equal(engine.previewMovementBulletThreat(ctx, "right", 0.9), null);
});

test("counter-fire safety accepts an enemy shell collision before the shooter", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /function counterBulletShotSafe\(tank, intendedDir\)/);
  assert.match(source, /\^core-counter-\(\?:fire\|aim\|fire-critical\)\$/);
});

test("an armor target stays committed until two actual hits, even after missed shots", () => {
  const engine = loadEngine();
  const controller = engine.createController("1P");
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 20, 20);
  const armor = enemy(10, 8, "armor");
  armor.hp = 4;
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

  p1.cooldown = 0.5;
  const afterMiss = context(p1, [p2], [armor, distractor], openMap());
  afterMiss.gameTime = 1.65;
  afterMiss.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  assert.equal(controller.decide(afterMiss).lockedTarget, armor);

  p1.cooldown = 0;
  p1.aiArmorHitEvents = [armor];
  armor.hp = 3;
  const afterFirstHit = context(p1, [p2], [armor, distractor], openMap());
  afterFirstHit.gameTime = 2.2;
  afterFirstHit.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  assert.equal(controller.decide(afterFirstHit).lockedTarget, armor);

  p1.aiArmorHitEvents = [armor];
  armor.hp = 2;
  const afterSecondHit = context(p1, [p2], [armor, distractor], openMap());
  afterSecondHit.gameTime = 2.3;
  afterSecondHit.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  const released = controller.decide(afterSecondHit);
  assert.equal(p1.aiArmorHitEvents.length, 0);
  assert.notEqual(released.mode, "core-armor-volley");
});

test("an imminent fast base threat interrupts armor volley reacquisition", () => {
  const engine = loadEngine();
  const controller = engine.createController("1P");
  const p1 = tank("player", 10, 10, "up");
  const p2 = tank("player2", 23, 8);
  const armor = enemy(10, 8, "armor");
  armor.hp = 4;
  const first = context(p1, [p2], [armor], openMap());
  first.canDirectShoot = (dir, target) => dir === "up" && target === armor;
  assert.equal(controller.decide(first).target, armor);
  p1.cooldown = 0.5;
  const confirmed = context(p1, [p2], [armor], first.map);
  confirmed.gameTime = 1.05;
  confirmed.canDirectShoot = first.canDirectShoot;
  controller.decide(confirmed);

  p1.cooldown = 0;
  const fast = enemy(12, 19, "fast");
  fast.dir = "down";
  const urgent = context(p1, [p2], [armor, fast], first.map);
  urgent.gameTime = 1.6;
  urgent.canDirectShoot = first.canDirectShoot;
  const action = controller.decide(urgent);
  assert.equal(action.lockedTarget, fast, action.mode);
  assert.equal(action.target, fast, action.mode);
  assert.notEqual(action.mode, "core-armor-volley-reacquire");
});

test("two defenders split a fast base approach and a second near-base intruder", () => {
  const engine = loadEngine();
  const p1 = tank("player", 12, 16, "down");
  const p2 = tank("player2", 15, 20, "left");
  const fast = enemy(12, 18, "fast");
  const basic = enemy(13, 20);
  basic.dir = "up";
  const armor = enemy(21, 17, "armor");
  const map = openMap();
  const first = engine.createController("1P").decide(context(p1, [p2], [armor, fast, basic], map));
  p1.attackTarget = first.lockedTarget;
  const secondCtx = context(p2, [p1], [armor, fast, basic], map);
  secondCtx.gameTime = 1.01;
  const second = engine.createController("2P").decide(secondCtx);
  assert.equal(first.lockedTarget, fast, first.mode);
  assert.equal(second.lockedTarget, basic, second.mode);
});

test("closer defender rescues a fast tank at the base when its assigned owner cannot arrive", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8")
    .replace("  function isFastLastLine(ctx, enemy) {",
      "  window.previewCriticalDefenseOverride = criticalDefenseOverride;\n  function isFastLastLine(ctx, enemy) {");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const p1 = tank("player", 8, 15);
  const p2 = tank("player2", 17, 19);
  const fast = enemy(12, 19, "fast");
  fast.speed = 105;
  const armor = enemy(19, 7, "armor");
  const ctx = context(p2, [p1], [fast, armor], openMap());
  const fastRecord = {
    enemy: fast,
    responseDeadline: 0.4,
    responseEtas: new WeakMap([[p1, 3.2], [p2, 1.6]]),
  };
  ctx.globalThreats = [fastRecord];
  const assignments = new Map([[p1, { target: fast }], [p2, { target: armor }]]);
  assert.equal(sandbox.window.previewCriticalDefenseOverride(ctx, p2, assignments)?.enemy, fast);

  const freeze = { type: "freeze", x: p2.x + TILE, y: p2.y, w: 16, h: 16, dead: false };
  ctx.bonuses = [freeze];
  assert.equal(sandbox.window.previewCriticalDefenseOverride(ctx, p2, assignments), null,
    "a nearby freeze pickup remains higher priority");

  const engine = loadEngine();
  p1.attackTarget = fast;
  p2.attackTarget = armor;
  const live = context(p2, [p1], [fast, armor], openMap());
  const action = engine.createController("2P").decide(live);
  assert.equal(action.lockedTarget, fast, action.mode);
});

test("equal-threat assignments favor fast tanks without outranking a direct base shot", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8")
    .replace("  function planningContextForAlly(ctx, ally) {",
      "  window.previewGlobalAssignmentCost = globalAssignmentCost;\n  function planningContextForAlly(ctx, ally) {");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const defender = tank("player", 9, 13);
  const basic = enemy(8, 5);
  const fast = enemy(8, 5, "fast");
  const ctx = context(defender, [], [basic, fast], openMap());
  const threat = (target) => ({
    enemy: target,
    fast: false,
    crossed: false,
    bypassed: false,
    vertical: false,
    defenseTier: 3,
    dangerEta: 10,
    responseDeadline: 8,
    baseDistance: 450,
    responseEtas: new WeakMap([[defender, 4]]),
  });
  const basicThreat = threat(basic);
  const fastThreat = threat(fast);
  const cost = sandbox.window.previewGlobalAssignmentCost;
  assert.ok(cost(ctx, defender, fastThreat) < cost(ctx, defender, basicThreat));
  basicThreat.direct = { target: "base", eta: 2 };
  assert.ok(cost(ctx, defender, basicThreat) < cost(ctx, defender, fastThreat));
});

test("game records only real armor damage for the firing ally", () => {
  const source = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
  assert.match(source, /if \(tank\.invuln > 0\) return false;\s*tank\.hp -= 1;\s*if \(tank\.enemy && tank\.kind === "armor"/);
  assert.match(source, /hits\.push\(tank\)/);
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
  assert.equal(action.advisor.participation, "full-control");
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

test("v2 scores migrate while normal games cannot tune the production policy", () => {
  const api = loadData({
    coreDataVersion: 2,
    weights: { defend: 4.2, survive: 5.1, attack: 6.3, clear: 3.8 },
    bestWeights: { defend: 5, survive: 5, attack: 5, clear: 5 },
  });
  assert.equal(api.readMemory().coreDataVersion, 5);
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
  assert.notEqual(memory.lastPolicyDecision?.status, "EVALUATING");
  assert.equal(memory.policyByContext["S1:NORMAL"], undefined);
  assert.equal(memory.policyByContext["S1:TEST-4X"], undefined);
});

test("a regressive evolved policy is rolled back when base safety gets worse", () => {
  const api = loadData();
  const run = { mode: "TEST", speed: 4 };
  for (let game = 0; game < 20; game++) {
    api.startMatch({ stage: 1, run });
    for (let kill = 0; kill < 20; kill++) api.recordExperience("enemy_killed", { stage: 1, mode: "core-chase" });
    api.finishMatch({ win: true, stage: 1, duration: 90, run });
  }
  const champion = JSON.parse(JSON.stringify(api.readMemory().policyTuning["S1:TEST-4X"].championPolicy));
  assert.equal(api.readMemory().lastPolicyDecision.status, "EVALUATING");

  for (let game = 0; game < 20; game++) {
    api.startMatch({ stage: 1, run });
    api.recordExperience("base_hit", { stage: 1, mode: "core-global-defense-route" });
    api.finishMatch({ win: false, stage: 1, duration: 70, run });
  }
  const memory = api.readMemory();
  assert.equal(memory.lastPolicyDecision.status, "ROLLED_BACK");
  assert.equal(memory.lastPolicyDecision.safeguards.baseSafe, false);
  assert.deepEqual(JSON.parse(JSON.stringify(memory.policyByContext["S1:TEST-4X"])), champion);
});

test("autonomous evolution turns combat rewards into persistent action value", () => {
  const api = loadData();
  api.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
  api.observeAutonomyDecision({ player: "1P", stateKey: "S1|safe", actionKey: "move:toward:T0", stage: 1, time: 1 });
  api.recordExperience("enemy_killed", { player: "1P", tank: { kind: "player" }, stage: 1 });
  api.observeAutonomyDecision({ player: "1P", stateKey: "S1|safe-next", actionKey: "fire:toward:T0", stage: 1, time: 2 });

  const learned = api.readMemory().autonomy.states["S1|safe"].actions["move:toward:T0"];
  assert.ok(learned.q > 0, `expected positive learned value, got ${learned.q}`);
  assert.ok(api.readMemory().autonomy.replay.length > 0);
  assert.ok(api.readMemory().autonomy.updates > 0);
});

test("base destruction strongly penalizes both allies' recent autonomous decisions", () => {
  const api = loadData();
  api.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
  api.observeAutonomyDecision({ player: "1P", stateKey: "S1|rear-left", actionKey: "move:away:T1", stage: 1, time: 1 });
  api.observeAutonomyDecision({ player: "2P", stateKey: "S1|rear-right", actionKey: "hold:hold:T0", stage: 1, time: 1 });
  api.recordExperience("base_hit", { stage: 1, mode: "core-global-defense-route" });

  const memory = api.readMemory().autonomy;
  assert.ok(memory.states["S1|rear-left"].actions["move:away:T1"].q < 0);
  assert.ok(memory.states["S1|rear-right"].actions["hold:hold:T0"].q < 0);
});

test("local reward evidence nominates candidates without publishing a generation", () => {
  const api = loadData();
  api.startMatch({ stage: 1, run: { mode: "NORMAL", speed: 1 } });
  for (let step = 1; step <= 5; step++) {
    api.observeAutonomyDecision({ player: "1P", stateKey: "S1|intercept", actionKey: "move:toward:T0", stage: 1, time: step });
    api.recordExperience("enemy_killed", { player: "1P", tank: { kind: "player" }, stage: 1 });
  }
  const state = api.readMemory().autonomy.states["S1|intercept"];
  assert.equal(state.champion, "move:toward:T0");
  assert.equal(api.readMemory().autonomy.generation, 0);
  assert.equal(api.readMemory().autonomy.lastDecision.status, "CANDIDATE_ONLY");
});

test("restored candidate values cannot bias normal games and remain usable in tests", () => {
  const api = loadData({
    coreDataVersion: 5,
    autonomy: {
      version: 1,
      generation: 7,
      states: {
        "S1|terminal": {
          visits: 12,
          champion: "fire:toward:T0",
          actions: {
            "fire:toward:T0": { q: 80, visits: 12, reward: 60, successes: 8, failures: 1 },
            "move:away:T1": { q: -40, visits: 8, reward: -30, successes: 1, failures: 6 },
          },
        },
      },
    },
  });
  const restored = api.readAutonomy();
  const evaluation = api.evaluateAutonomyActions(
    "S1|terminal",
    ["fire:toward:T0", "move:away:T1"],
    { urgent: true, forceExplore: true },
  );
  assert.equal(restored.generation, 7);
  assert.equal(evaluation.champion, null);
  assert.equal(evaluation.exploreKey, null, "urgent defense must never explore");
  assert.equal(evaluation.biases["fire:toward:T0"], 0);
  assert.equal(evaluation.biases["move:away:T1"], 0);
  const forced = api.evaluateAutonomyActions("S1|terminal", ["fire:toward:T0", "move:away:T1"],
    { urgent: false, safeToExplore: true, forceExplore: true });
  assert.equal(forced.exploreKey, null);
  assert.equal(forced.explorationRate, 0);
  assert.equal(forced.biases["fire:toward:T0"], 0);
  api.startMatch({ stage: 1, run: { mode: "TEST", speed: 4 } });
  const candidate = api.evaluateAutonomyActions("S1|terminal", ["fire:toward:T0", "move:away:T1"], { urgent: true });
  assert.ok(candidate.biases["fire:toward:T0"] > candidate.biases["move:away:T1"]);
  assert.equal(candidate.exploreKey, null);
});

test("hot-upgrade handoff carries unfinished autonomous eligibility traces", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-data.js"), "utf8");
  assert.match(source, /autonomyRuntime = normalizeAutonomyRuntime\(\/\*\* @type \{any\} \*\/ \(handoff\)\?\.autonomyRuntime\)/);
  assert.match(source, /function createHandoff\(\)[\s\S]{0,180}autonomyRuntime/);
  assert.match(source, /finishAutonomyEpisode\(\{ \.\.\.result, stage \}\)/);
});

test("autonomous state and action keys generalize positions into tactical buckets", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "up");
  const threat = enemy(8, 13, "fast");
  const ctx = context(subject, [], [threat], openMap());
  const stateKey = engine.previewAutonomyState(ctx, threat);
  const actionKey = engine.previewAutonomyAction(subject, threat, { dir: "up", fire: true, hold: false });
  assert.match(stateKey, /^T2-X\d-S\d-W\d-B\d\|/);
  assert.match(stateKey, /\|near\||\|mid\|/);
  assert.equal(actionKey, "move-fire:toward:T0");
});

test("legacy policy trials are discarded before constrained evolution starts", () => {
  const api = loadData({
    coreDataVersion: 4,
    policyByContext: { "S1:NORMAL": { defend: 7.2, survive: 5.5, attack: 7.4, clear: 4.2 } },
    policyTuning: {
      "S1:NORMAL": {
        phase: "evaluate",
        championPolicy: { defend: 7, survive: 5, attack: 7, clear: 4 },
        candidatePolicy: { defend: 8, survive: 6, attack: 8, clear: 5 },
        baselineMetric: 100,
        baselineSamples: [{ metric: 100, scores: { defend: 8, survive: 8, attack: 8, clear: 8 } }],
        candidateSamples: [{ metric: 110, scores: { defend: 9, survive: 9, attack: 9, clear: 9 } }],
      },
    },
  });
  const state = api.readMemory().policyTuning["S1:NORMAL"];
  assert.equal(state.version, 2);
  assert.equal(state.phase, "baseline");
  assert.equal(state.candidatePolicy, null);
  assert.deepEqual(JSON.parse(JSON.stringify(state.baselineSamples)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(state.candidateSamples)), []);
  assert.equal(api.readPolicy(1, { mode: "NORMAL", speed: 1 }).defend, 7.2);
});

test("learned defense weight expands the early warning window", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "up");
  const threat = enemy(8, 8, "fast");
  const low = context(subject, [], [threat], openMap());
  low.weights.defend = 3;
  const high = context(subject, [], [threat], low.map);
  high.weights.defend = 10;
  const lowProfile = engine.previewBaseDefenseProfile(low, threat);
  const highProfile = engine.previewBaseDefenseProfile(high, threat);

  assert.ok(highProfile.responseDeadline < lowProfile.responseDeadline);
  assert.ok(highProfile.defenseTier <= lowProfile.defenseTier);
});

test("base defense clears an ordinary route brick without abandoning the threat", () => {
  const engine = loadEngine();
  const subject = tank("player", 12, 10, "down");
  const intruder = enemy(12, 18, "fast");
  const map = openMap();
  map[11][12] = "B";
  const ctx = context(subject, [], [intruder], map);
  ctx.canMove = (dir) => dir !== "down";
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false, mode: "core-chase", target: intruder };
  const plan = engine.previewAdvisorBaseDefense(ctx, baseline, intruder, 5);

  assert.equal(plan?.enemy, intruder);
  assert.equal(plan?.reason, "base-route-clear");
  assert.equal(plan?.action?.dir, "down");
  assert.equal(plan?.action?.fire, true);
});

test("an emergency aim turn never continues moving away from the base threat", () => {
  const engine = loadEngine();
  const subject = tank("player", 12, 17, "up");
  const intruder = enemy(12, 20, "fast");
  const ctx = context(subject, [], [intruder], openMap());
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  const baseline = { dir: "up", moveDir: "up", fire: false, hold: false, mode: "core-chase", target: intruder };
  const plan = engine.previewAdvisorBaseDefense(ctx, baseline, intruder, 5);

  assert.equal(plan?.enemy, intruder);
  assert.equal(plan?.action?.dir, "down");
  assert.notEqual(plan?.action?.moveDir, "up");
  assert.equal(plan?.action?.hold, true);
});

test("global base defense remains active during a freeze", () => {
  const engine = loadEngine();
  const subject = tank("player2", 12, 17, "up");
  const intruder = enemy(12, 20, "armor");
  intruder.hp = 2;
  const ctx = context(subject, [], [intruder], openMap());
  ctx.freezeTime = 4;
  ctx.canDirectShoot = (dir, target) => dir === "down" && target === intruder;
  const baseline = { dir: "left", moveDir: "left", fire: false, hold: false, mode: "core-freeze-contact-align", target: intruder };
  const plan = engine.previewAdvisorBaseDefense(ctx, baseline, intruder, 5);

  assert.equal(plan?.enemy, intruder);
  assert.equal(plan?.action?.dir, "down");
  assert.match(plan?.action?.mode || "", /^core-advisor-base-/);
});

test("ally spacing never overrides pursuit movement", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.doesNotMatch(source, /formationSeparationDirection|core-formation-separate/);
});

test("nearby freeze pickup cannot be delayed by cached pursuit or combat wrappers", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /freezeOpportunities\.every\(\(bonus, index\) => bonus === state\.freezeOpportunities\[index\]\)/);
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
  assert.match(source, /if \(!interceptEndpoint\) \{\s*interceptTarget = null;\s*interceptPlan = null/);
  assert.match(source, /const progressCandidates = candidates\.filter[\s\S]{0,120}item\.targetDistance < currentDistance - 0\.5/);
  assert.match(source, /core-route-loop-(?:replan|commit|escape)/);
  assert.doesNotMatch(source, /if \(!moving \|\| action\?\.fire \|\| tacticalInterrupt\)/);
  assert.match(source, /progressCandidates\[0\]\?\.dir \|\| candidates\.find/);
});

test("loop recovery detects a tight four-direction cycle without false triggering on progress", () => {
  const engine = loadEngine();
  const stalled = [
    { dir: "up", time: 1, x: 100, y: 100, distance: 320 },
    { dir: "right", time: 1.2, x: 102, y: 98, distance: 318 },
    { dir: "down", time: 1.4, x: 104, y: 100, distance: 319 },
    { dir: "left", time: 1.6, x: 102, y: 102, distance: 317 },
  ];
  const detected = engine.previewMovementLoop(stalled, { x: 100, y: 100 }, 316);
  assert.equal(detected.detected, true);
  assert.equal(detected.reason, "stalled-turn-cycle");
  const progressing = engine.previewMovementLoop(stalled, { x: 100, y: 100 }, 260);
  assert.equal(progressing.detected, false);
  assert.equal(progressing.reason, "");
});

test("alternating turn commands do not interrupt a route making physical progress", () => {
  const engine = loadEngine();
  const history = [
    { dir: "left", time: 1, x: 100, y: 100, distance: 320 },
    { dir: "right", time: 1.3, x: 92, y: 130, distance: 295 },
    { dir: "left", time: 1.6, x: 110, y: 160, distance: 265 },
    { dir: "right", time: 1.9, x: 100, y: 185, distance: 235 },
  ];
  assert.equal(engine.previewMovementLoop(history, { x: 100, y: 185 }, 235).detected, false);
  assert.equal(engine.previewMovementLoop(history, { x: 100, y: 100 }, 320).detected, true);
});

test("a five-turn detour is not a closed loop unless it returns without progress", () => {
  const engine = loadEngine();
  const history = ["up", "right", "down", "left", "up"].map((dir, i) => ({
    dir, time: 1 + i * 0.2, x: 100 + i * 16, y: 100, distance: 320 - i * 16,
  }));
  assert.equal(engine.previewMovementLoop(history, { x: 164, y: 100 }, 256).detected, false);
  assert.equal(engine.previewMovementLoop(history, { x: 100, y: 100 }, 320).detected, true);
});

test("global advisor preserves a committed loop escape route", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "right");
  const foe = enemy(8, 5);
  const ctx = context(subject, [], [foe], openMap());
  const baseline = {
    dir: "right",
    moveDir: "right",
    fire: false,
    hold: false,
    mode: "core-route-loop-commit",
    target: foe,
  };
  const advice = { differs: true, tag: "move", dir: "left", fire: false, hold: false, scoreGain: 200 };
  const plan = engine.previewAdvisorGlobalControl(ctx, baseline, foe, advice);
  assert.equal(plan.action.mode, "core-route-loop-commit");
  assert.equal(plan.action.moveDir, "right");
});

test("loop stabilization runs after the global advisor selects the executed action", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  const globalAction = source.indexOf("action = globalPlan.action;");
  const stabilization = source.indexOf("action = stabilizeMovement(ctx, ctx.tank, action, now);");
  const advisorRecord = source.indexOf("recordAdvisorFullControl(", globalAction);
  assert.ok(globalAction >= 0);
  assert.ok(stabilization > globalAction);
  assert.ok(advisorRecord > stabilization);
});

test("route alignment is movement-limited so it cannot overshoot and reverse", () => {
  const engine = loadEngine();
  const subject = tank("player", 8, 18, "left");
  const aligned = engine.previewAlignmentMove({
    dir: "left",
    moveDir: "left",
    moveScale: 1,
    fire: false,
    hold: false,
    mode: "core-path-align",
  }, subject);
  assert.equal(aligned.moveScale, 0.35);
  assert.equal(aligned.hold, false);
  const reversing = engine.previewAlignmentMove({
    dir: "right",
    moveDir: "right",
    moveScale: 1,
    fire: false,
    hold: false,
    mode: "core-path-align",
  }, subject);
  assert.equal(reversing.moveScale, 0.35);
  assert.equal(reversing.hold, true);
  const chase = engine.previewAlignmentMove({
    dir: "left",
    moveDir: "left",
    moveScale: 1,
    fire: false,
    hold: false,
    mode: "core-chase",
  }, subject);
  assert.equal(chase.moveScale, 1);
});

test("defense ETA includes real lane alignment instead of assuming full-speed arrival", () => {
  const engine = loadEngine();
  const alignedTank = tank("player", 8, 18, "up");
  const offsetTank = { ...alignedTank, x: alignedTank.x + 11 };
  const path = [{ x: 8, y: 18 }, { x: 8, y: 17 }, { x: 8, y: 16 }];
  const alignedEta = engine.previewDefenderRouteEta(alignedTank, path);
  const offsetEta = engine.previewDefenderRouteEta(offsetTank, path);
  assert.ok(offsetEta > alignedEta + 0.5);
});

test("two urgent base approaches stay split instead of sharing one direct shooter", () => {
  const engine = loadEngine();
  const direct = {
    enemy: { alive: true },
    direct: { target: "base", eta: 0.8 },
    dangerEta: 0.8,
    baseDistance: TILE * 2,
  };
  const second = {
    enemy: { alive: true },
    direct: null,
    dangerEta: 2.2,
    baseDistance: TILE * 3,
  };
  assert.equal(engine.previewTerminalShare(direct, [direct]), true);
  assert.equal(engine.previewTerminalShare(direct, [direct, second]), false);
});

test("a defender with no firing cell closes contact instead of holding beside the base", () => {
  const engine = loadEngine();
  const subject = tank("player", 12, 18, "right");
  const intruder = enemy(12, 20, "basic");
  intruder.dir = "down";
  const ctx = context(subject, [], [intruder], openMap());
  ctx.canMove = (dir) => dir === "down";
  const action = engine.previewTerminalContact(ctx, intruder);
  assert.equal(action?.mode, "core-global-defense-contact");
  assert.equal(action?.moveDir, "down");
  assert.equal(action?.hold, false);
});

test("loop recovery preserves an assigned intercept endpoint", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /const movementGoal = pickupTarget \|\| interceptGoal \|\| activeTarget/);
  assert.match(source, /const replanned = findPath\(ctx, cellOf\(tank\), \[interceptEndpoint\]\)/);
  assert.match(source, /interceptPlan = \{ \.\.\.assignedIntercept, path: replanned, createdAt: now \}/);
  assert.match(source, /mode = "core-intercept-loop-replan"/);
});

test("version display removes seconds without weakening version comparison", () => {
  const source = fs.readFileSync(path.join(ROOT, "hot-upgrade.js"), "utf8");
  const aiSource = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.match(source, /updatedAtBeijing:[\s\S]{0,160}replace\(\/\(\\d\{2\}:\\d\{2\}\):\\d\{2\}/);
  assert.match(aiSource, /function installAiVersionDisplay\(\)/);
  assert.match(aiSource, /const timeText = `AI \$\{updatedAt\}`/);
  assert.match(aiSource, /const advisorText = `全局控制 R\$\{compactAdvisorCount\(stats\.runs\)\} P\$\{compactAdvisorCount\(stats\.applied\)\}/);
  assert.match(aiSource, /function installAiVersionDisplay[\s\S]{0,1200}compactAdvisorCount/);
  assert.match(aiSource, /全局控制 R\$\{compactAdvisorCount\(stats\.runs\)\} P\$\{compactAdvisorCount\(stats\.applied\)\} C\$\{compactAdvisorCount\(stats\.cacheHits\)\} D/);
  assert.match(aiSource, /"bullet-risk": "弹道风险"/);
  assert.match(aiSource, /"fire-window": "射击机会"/);
  assert.match(aiSource, /"intercept-gain": "截击增益"/);
  assert.match(aiSource, /"baseline-best": "原决策最优"/);
  assert.match(aiSource, /"position-gain": "位置增益"/);
  assert.match(aiSource, /全局控制：分析/);
  assert.match(aiSource, /new MutationObserver\(render\)/);
  assert.match(source, /hash \|\| a\?\.\[key\]\?\.version/);
  assert.match(source, /digits\.slice\(8, 10\)\}:\$\{digits\.slice\(10, 12\)/);
  assert.match(source, /label\.textContent = `\$\{info\.developer\} \$\{minuteVersion\}`/);
});

test("lost firing lanes reposition and intercept clocks do not reset every frame", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai-core.js"), "utf8");
  assert.doesNotMatch(source, /core-shot-lane-lost/);
  assert.match(source, /shotLaneRepositionPlan\(ctx, ctx\.tank, action\.target\)/);
  assert.match(source, /reposition \? "core-shot-lane-reposition" : "core-shot-lane-replan"/);
  assert.match(source, /const createdAt = committed \|\| samePlan \? committedCreatedAt : now/);
  assert.match(source, /interceptPlan = \{ \.\.\.selectedPlan, createdAt \}/);
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
  assert.match(source, /const rankedCritical = threats\.filter/);
  assert.match(source, /const criticalCoverage = rankedCritical\.slice/);
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

test("concurrent sessions cannot overwrite newer contextual evolution samples", () => {
  const { AiDatabase } = require(path.join(ROOT, "ai-database.js"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fc-tank-policy-db-"));
  const database = new AiDatabase(path.join(directory, "memory.db"));
  const tuning = (updatedAt, samples) => ({
    version: 2,
    phase: "baseline",
    championPolicy: { defend: 7, survive: 5, attack: 7, clear: 4 },
    candidatePolicy: null,
    baselineMetric: null,
    baselineSamples: samples,
    candidateSamples: [],
    updatedAt,
  });
  try {
    database.write({ memory: {
      policyByContext: { "S1:TEST-4X": { defend: 7.1, survive: 5, attack: 7, clear: 4 } },
      policyTuning: { "S1:TEST-4X": tuning(200, [{ id: "test-1", win: 1 }]) },
    } });
    database.write({ memory: {
      policyByContext: { "S1:TEST-4X": { defend: 6.5, survive: 5, attack: 7, clear: 4 } },
      policyTuning: { "S1:TEST-4X": tuning(100, []) },
    } });
    let stored = database.getState("memory", {});
    assert.equal(stored.policyTuning["S1:TEST-4X"].updatedAt, 200);
    assert.equal(stored.policyTuning["S1:TEST-4X"].baselineSamples.length, 1);
    assert.equal(stored.policyByContext["S1:TEST-4X"].defend, 7.1);

    database.write({ memory: {
      policyByContext: { "S1:TEST-4X": { defend: 7.3, survive: 5.1, attack: 7.2, clear: 4 } },
      policyTuning: { "S1:TEST-4X": tuning(300, [{ id: "test-1", win: 1 }, { id: "test-2", win: 0 }]) },
    } });
    stored = database.getState("memory", {});
    assert.equal(stored.policyTuning["S1:TEST-4X"].updatedAt, 300);
    assert.equal(stored.policyTuning["S1:TEST-4X"].baselineSamples.length, 2);
    assert.equal(stored.policyByContext["S1:TEST-4X"].defend, 7.3);

    database.write({ training: { seconds: 1200, games: 1, generation: 8 } });
    database.write({ training: { seconds: 900, games: 1, generation: 6 } });
    const training = database.getState("training", {});
    assert.equal(training.seconds, 1200);
    assert.equal(training.generation, 8);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("normal and shadow sessions merge autonomous state values instead of overwriting them", () => {
  const { AiDatabase } = require(path.join(ROOT, "ai-database.js"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fc-tank-autonomy-db-"));
  const database = new AiDatabase(path.join(directory, "memory.db"));
  const learnedState = (q, visits, updatedAt, action = "move:toward:T0") => ({
    visits,
    champion: action,
    actions: { [action]: { q, visits, reward: q, successes: Math.max(0, visits - 1), failures: 1, updatedAt } },
    updatedAt,
  });
  try {
    database.write({ memory: { autonomy: {
      version: 1,
      generation: 5,
      decisions: 40,
      updates: 50,
      states: {
        "S1|shared": learnedState(80, 10, 1000),
        "S1|normal-only": learnedState(30, 4, 1000),
      },
      replay: [{ state: "S1|shared", action: "move:toward:T0", reward: 20, updatedAt: 1000 }],
    } } });
    database.write({ memory: { autonomy: {
      version: 1,
      generation: 6,
      decisions: 35,
      updates: 60,
      states: {
        "S1|shared": learnedState(20, 10, 1005),
        "S1|shadow-only": learnedState(45, 5, 1005, "fire:toward:T0"),
      },
      replay: [{ state: "S1|shadow-only", action: "fire:toward:T0", reward: 30, updatedAt: 1005 }],
    } } });
    const autonomy = database.getState("memory", {}).autonomy;
    assert.equal(autonomy.generation, 6);
    assert.ok(autonomy.states["S1|normal-only"]);
    assert.ok(autonomy.states["S1|shadow-only"]);
    assert.equal(autonomy.states["S1|shared"].actions["move:toward:T0"].q, 50);
    assert.equal(autonomy.replay.length, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent autonomous learning remains bounded after state-table merging", () => {
  const { mergeConcurrentAutonomy } = require(path.join(ROOT, "ai-database.js"));
  const states = Object.fromEntries(Array.from({ length: 1100 }, (_, index) => [
    `state-${index}`,
    { visits: index % 9, actions: {}, updatedAt: 1000 + index },
  ]));
  const merged = mergeConcurrentAutonomy({ states: {} }, { states, replay: [] });
  assert.equal(Object.keys(merged.states).length, 1024);
  assert.ok(merged.states["state-1099"]);
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
