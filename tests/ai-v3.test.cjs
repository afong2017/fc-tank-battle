const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function controller() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ai-v3.js"), "utf8"), sandbox);
  return sandbox.window.TankPartnerAIV3.createController("1P");
}
function hybrid(action) {
  const sandbox = { window: { TankPartnerAIEngine: { enhance: () => ({
    createController: () => ({ decide: () => action, learn: () => {} }),
  }) } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ai-v3.js"), "utf8"), sandbox);
  return sandbox.window.TankPartnerAIV3.enhance({}).createController("1P");
}
function baseEtaFor(map, enemy) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ai-v3.js"), "utf8"), sandbox);
  return sandbox.window.TankPartnerAIV3.inspectBaseEta({
    map, mapVersion: 1, rows: map.length, cols: map[0].length,
    base: { x: 4 * 32, y: 9 * 32, w: 32, h: 32 },
  }, enemy);
}
function tank(x, y, kind = "player") {
  return { x: x * 32 + 2, y: y * 32 + 2, w: 28, h: 28,
    alive: true, hp: 1, dir: "up", kind, speed: 105 };
}
function context(overrides = {}) {
  const map = Array.from({ length: 10 }, () => Array(10).fill("."));
  const own = tank(2, 7), enemy = tank(4, 4, "basic");
  return { tank: own, enemies: [enemy], friends: [], reservedTargets: [], bullets: [], bonuses: [],
    map, rows: 10, cols: 10, gameTime: 0, freezeTime: 0,
    base: { x: 4 * 32, y: 9 * 32, w: 32, h: 32 },
    baseGuard: { x: 3 * 32, y: 8 * 32, w: 3 * 32, h: 2 * 32 },
    canMove: () => true, canFire: () => false,
    canDirectShoot: () => false, canPredictShoot: () => false, ...overrides };
}

test("nearby freeze pickup preempts a shootable enemy", () => {
  const ctx = context({ bonuses: [{ x: 3 * 32 + 2, y: 7 * 32 + 2,
    w: 28, h: 28, type: "freeze" }], canFire: () => true,
  canDirectShoot: () => true });
  const action = controller().decide(ctx);
  assert.equal(action.mode, "core-v3-freeze-pickup");
  assert.equal(action.dir, "right");
  assert.equal(action.fire, false);
});

test("a shell catching up from behind triggers a sideways dodge", () => {
  const own = tank(4, 5);
  const ctx = context({ tank: own, enemies: [tank(4, 2, "basic")],
    bullets: [{ x: own.x, y: own.y + 64, w: 6, h: 6,
      dir: "up", speed: 230, enemy: true }],
    base: { x: 4 * 32, y: 9 * 32, w: 32, h: 32 } });
  const action = controller().decide(ctx);
  assert.equal(action.mode, "core-v3-evade");
  assert.ok(action.dir === "left" || action.dir === "right");
});

test("a stationary aim dodges a shell unless it is shielding the base", () => {
  const own = tank(4, 5), enemy = tank(4, 3, "basic");
  const shell = { x: own.x, y: own.y + 64, w: 6, h: 6,
    dir: "up", speed: 230, enemy: true };
  const ctx = context({ tank: own, enemies: [enemy], bullets: [shell],
    canDirectShoot: dir => dir === "up" });
  const action = controller().decide(ctx);
  assert.equal(action.mode, "core-v3-evade");
});

test("a defender stays in the path of an unobstructed shell headed for the base", () => {
  const own = tank(4, 5);
  const shell = { x: own.x, y: own.y - 64, w: 6, h: 6,
    dir: "down", speed: 230, enemy: true };
  const ctx = context({ tank: own, enemies: [tank(4, 2, "basic")], bullets: [shell] });
  assert.notEqual(controller().decide(ctx).mode, "core-v3-evade");
});

test("a reachable freeze pickup still outranks an incoming shell", () => {
  const own = tank(2, 5);
  const ctx = context({ tank: own,
    bonuses: [{ x: 3 * 32 + 2, y: 5 * 32 + 2, w: 28, h: 28, type: "freeze" }],
    bullets: [{ x: own.x - 64, y: own.y, w: 6, h: 6,
      dir: "right", speed: 230, enemy: true }] });
  assert.equal(controller().decide(ctx).mode, "core-v3-freeze-pickup");
});

test("an unreachable nearby freeze does not leave the defender unassigned", () => {
  const ctx = context({ tank: tank(2, 5), enemies: [tank(2, 2, "basic")],
    bonuses: [{ x: 4 * 32 + 2, y: 5 * 32 + 2, w: 28, h: 28, type: "freeze" }] });
  for (const [x, y] of [[4, 4], [4, 6], [3, 5], [5, 5]]) ctx.map[y][x] = "S";
  const action = controller().decide(ctx);
  assert.equal(action.target, ctx.enemies[0]);
  assert.notEqual(action.mode, "core-v3-intercept-patrol");
});

test("a defender checks the last visible base lane without targeting a hidden enemy", () => {
  const own = tank(2, 6), intruder = tank(4, 6, "basic");
  const far = tank(8, 1, "basic");
  const ctx = context({ tank: own, enemies: [intruder, far], gameTime: 1 });
  const ai = controller();
  ai.decide(ctx);
  ctx.map[7][4] = "F";
  intruder.y = 7 * 32 + 2;
  ctx.gameTime = 1.5;
  const action = ai.decide(ctx);
  assert.equal(action.mode, "core-v3-last-seen-defense");
  assert.equal(action.target, null);
  assert.equal(ctx.plannedRoute.at(-1).y, 6 * 32 + 16);
});

test("an opposite turn draws the actual intermediate movement before the attack route", () => {
  const own = tank(4, 7);
  own.dir = "down";
  const ctx = context({ tank: own, enemies: [tank(4, 1, "basic")] });
  const action = controller().decide(ctx);
  assert.equal(action.mode, "core-v3-attack-route");
  assert.equal(action.dir, "up");
  assert.ok(ctx.plannedRoute[1].x < ctx.plannedRoute[0].x);
  assert.equal(ctx.plannedRoute[1].y, ctx.plannedRoute[0].y);
});

test("a turn near the map edge never searches from an out-of-bounds cell", () => {
  const own = tank(2, 0);
  own.dir = "right";
  const ctx = context({ tank: own, enemies: [tank(0, 0, "basic")] });
  assert.doesNotThrow(() => controller().decide(ctx));
});

test("turn-aware recovery prefers the equal-length detour matching its heading", () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ai-v3.js"), "utf8"), sandbox);
  const own = tank(5, 5);
  own.dir = "right";
  const ctx = context({ tank: own });
  ctx.map[4][5] = "S";
  const route = sandbox.window.TankPartnerAIV3.inspectTurnRoute(ctx, own, { x: 5, y: 2 });
  assert.equal(route[1].x, 6);
  assert.equal(route[1].y, 5);
});

test("steel between tank and enemy is never fired through", () => {
  const ctx = context();
  ctx.tank = tank(2, 5);
  ctx.enemies = [tank(6, 5, "basic")];
  ctx.map[5][4] = "S";
  const action = controller().decide(ctx);
  assert.equal(action.fire, false);
  assert.notEqual(action.mode, "core-v3-clear");
  assert.ok(Array.isArray(ctx.plannedRoute));
  assert.ok(ctx.plannedRoute.every(point =>
    !(Math.floor(point.x / 32) === 4 && Math.floor(point.y / 32) === 5)));
});

test("water blocks the tank but not its firing lane", () => {
  const ctx = context();
  ctx.tank = tank(2, 5);
  ctx.enemies = [tank(6, 5, "basic")];
  ctx.map[5][4] = "W";
  const action = controller().decide(ctx);
  assert.ok(ctx.plannedRoute?.length > 1);
  assert.ok(ctx.plannedRoute.every(point =>
    !(Math.floor(point.x / 32) === 4 && Math.floor(point.y / 32) === 5)));
  assert.equal(action.target, ctx.enemies[0]);
});

test("an already aimed guaranteed shot is taken immediately", () => {
  const ctx = context({ canFire: () => true,
    canDirectShoot: dir => dir === "up" });
  const action = controller().decide(ctx);
  assert.equal(action.fire, true);
  assert.equal(action.dir, "up");
  assert.equal(action.target, ctx.enemies[0]);
});

test("base guard brick is not a traversable clearing cell", () => {
  const ctx = context();
  ctx.map[8][3] = "B";
  const action = controller().decide(ctx);
  assert.notEqual(action.mode, "core-v3-clear");
  assert.ok(!ctx.plannedRoute || ctx.plannedRoute.every(point =>
    !(Math.floor(point.x / 32) === 3 && Math.floor(point.y / 32) === 8)));
});

test("wider base-front brick zone is never selected for clearing", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  map[19][9] = "B";
  const ctx = context({ map, rows: 24, cols: 26,
    tank: tank(9, 20), enemies: [tank(9, 16, "basic")],
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    canFire: () => true });
  const action = controller().decide(ctx);
  assert.notEqual(action.mode, "core-v3-clear");
  assert.ok(!ctx.plannedRoute || ctx.plannedRoute.every(point =>
    !(Math.floor(point.x / 32) === 9 && Math.floor(point.y / 32) === 19)));
});

test("two allies jointly take separate left and right threats", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  const left = tank(8, 20), right = tank(17, 20, "player2");
  const leftEnemy = tank(7, 15, "basic"), rightEnemy = tank(18, 15, "fast");
  const shared = { map, rows: 24, cols: 26, stage: 1, mapVersion: 0, gameTime: 4,
    enemies: [leftEnemy, rightEnemy], bonuses: [], bullets: [], freezeTime: 0,
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    canMove: () => true, canFire: () => false, canDirectShoot: () => false,
    canPredictShoot: () => false };
  const first = controller().decide({ ...shared, tank: left, friends: [right] });
  const second = controller().decide({ ...shared, tank: right, friends: [left] });
  assert.equal(first.lockedTarget, leftEnemy);
  assert.equal(second.lockedTarget, rightEnemy);
});

test("a steel-separated nearby ally is not assigned the urgent base intruder", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  map[20][10] = "S";
  const left = tank(9, 20), right = tank(12, 18, "player2");
  const intruder = tank(11, 20, "fast"), upper = tank(8, 8, "basic");
  const shared = { map, rows: 24, cols: 26, stage: 3, mapVersion: 1, gameTime: 20,
    enemies: [intruder, upper], bonuses: [], bullets: [], freezeTime: 0,
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    canMove: () => true, canFire: () => false, canDirectShoot: () => false,
    canPredictShoot: () => false };
  const first = controller().decide({ ...shared, tank: left, friends: [right] });
  const second = controller().decide({ ...shared, tank: right, friends: [left] });
  assert.equal(second.lockedTarget, intruder);
  assert.notEqual(first.lockedTarget, intruder);
});

test("one visible enemy keeps both available allies assigned", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  const left = tank(8, 20), right = tank(17, 20, "player2");
  const enemy = tank(7, 15, "basic");
  const shared = { map, rows: 24, cols: 26, stage: 1, mapVersion: 0, gameTime: 4,
    enemies: [enemy], bonuses: [], bullets: [], freezeTime: 0,
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    canMove: () => true, canFire: () => false, canDirectShoot: () => false,
    canPredictShoot: () => false };
  const first = controller().decide({ ...shared, tank: left, friends: [right] });
  const second = controller().decide({ ...shared, tank: right, friends: [left] });
  assert.equal(first.lockedTarget, enemy);
  assert.equal(second.lockedTarget, enemy);
});

test("point-blank shot at a nearby enemy bypasses distant mission", () => {
  const own = tank(2, 5);
  own.dir = "right";
  const near = tank(3, 5, "basic"), far = tank(7, 2, "fast");
  const ctx = context({ tank: own, enemies: [far, near], canFire: () => true,
    canDirectShoot: (dir, target) => dir === "right" && target === near });
  const action = controller().decide(ctx);
  assert.equal(action.mode, "core-v3-contact-fire");
  assert.equal(action.fire, true);
  assert.equal(action.target, near);
});

test("V3 point-blank shot uses the shared first-impact melee gate", () => {
  const own = tank(2, 5);
  own.dir = "up";
  const near = tank(3, 5, "basic");
  const ctx = context({ tank: own, enemies: [near], canFire: () => true,
    meleeShot: (dir, target) => dir === "right" && target === near
      ? { type: "enemy", target: near } : null });
  const action = controller().decide(ctx);
  assert.equal(action.mode, "core-melee-direct");
  assert.equal(action.dir, "right");
  assert.equal(action.fire, true);
  assert.equal(action.target, near);
});

test("point-blank clearing never fires into a base guard brick", () => {
  const own = tank(2, 5), near = tank(3, 5, "basic");
  const ctx = context({ tank: own, enemies: [near], canFire: () => true,
    meleeShot: () => ({ type: "tile", tile: "B", baseGuard: true }) });
  const action = controller().decide(ctx);
  assert.notEqual(action.mode, "core-melee-clear");
  assert.equal(action.fire, false);
});

test("point-blank clearing also preserves the wider base-front brick zone", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  const own = tank(9, 19), near = tank(10, 19, "basic");
  const ctx = context({ map, rows: 24, cols: 26, tank: own, enemies: [near],
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    meleeShot: () => ({ type: "tile", tile: "B", x: 10, y: 19, baseGuard: false }) });
  const action = controller().decide(ctx);
  assert.notEqual(action.mode, "core-melee-clear");
});

test("a bullet grazing a protected brick is vetoed even if its center ray misses", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  map[18][13] = "B";
  const own = tank(11, 18), enemy = tank(12, 19, "fast");
  own.y = 593;
  own.dir = "right";
  enemy.y = 609.25;
  const ctx = context({ map, rows: 24, cols: 26, tank: own, enemies: [enemy],
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    canFire: () => true, canDirectShoot: dir => dir === "right",
    meleeShot: dir => dir === "right" ? { type: "enemy", target: enemy } : null });
  assert.equal(controller().decide(ctx).fire, false);
});

test("a moving near-edge target cannot lure a shot into the protected brick behind it", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  map[18][13] = "B";
  const own = tank(10, 18), near = tank(11, 18, "fast");
  own.dir = "right";
  near.y += 10;
  const ctx = context({ map, rows: 24, cols: 26, tank: own, enemies: [near],
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 128, h: 96 },
    canFire: () => true, canDirectShoot: dir => dir === "right" });
  assert.equal(controller().decide(ctx).fire, false);
  ctx.freezeTime = 3;
  assert.equal(controller().decide(ctx).fire, true);
});

test("a moving enemy leaving the lane during a turn is not blindly aimed at", () => {
  const own = tank(2, 5), enemy = tank(3, 5, "fast");
  enemy.dir = "down";
  const ctx = context({ tank: own, enemies: [enemy], canDirectShoot: dir => dir === "right" });
  const action = controller().decide(ctx);
  assert.ok(!action.mode.endsWith("-aim"));
});

test("base deadline follows a clear firing lane through water, but not steel", () => {
  const open = Array.from({ length: 10 }, () => Array(10).fill("."));
  const enemy = tank(4, 3, "fast");
  const openEta = baseEtaFor(open, enemy);
  const water = open.map(row => [...row]);
  water[6][4] = "W";
  const steel = open.map(row => [...row]);
  steel[6][4] = "S";
  assert.ok(openEta < 2, `open lane should be urgent: ${openEta}`);
  assert.equal(baseEtaFor(water, enemy), openEta);
  assert.ok(baseEtaFor(steel, enemy) > openEta + 0.5);
});

test("bricks on a base firing lane add clearance time", () => {
  const open = Array.from({ length: 10 }, () => Array(10).fill("."));
  const blocked = open.map(row => [...row]);
  blocked[6][4] = "B";
  const enemy = tank(4, 3, "basic");
  assert.ok(baseEtaFor(blocked, enemy) > baseEtaFor(open, enemy) + 0.5);
});

test("hybrid keeps an active core movement decision", () => {
  const action = { dir: "up", hold: false, fire: false, mode: "core-defense-route" };
  const ctx = context({ canFire: () => true, canDirectShoot: () => true });
  ctx.tank = tank(4, 5);
  assert.equal(hybrid(action).decide(ctx), action);
});

test("hybrid fires only to recover a safe point-blank idle", () => {
  const action = { dir: "up", hold: true, fire: false, mode: "core-replan" };
  const ctx = context({ canFire: () => true, canDirectShoot: () => true });
  ctx.tank = tank(4, 5);
  const decided = hybrid(action).decide(ctx);
  assert.equal(decided.fire, true);
  assert.equal(decided.target, ctx.enemies[0]);
});
