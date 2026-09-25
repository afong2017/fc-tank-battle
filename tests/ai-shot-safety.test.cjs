const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function gameShotFixture() {
  const source = fs.readFileSync(path.join(root, "game.js"), "utf8");
  const start = source.indexOf("function aiShotThreatensProtectedArea(");
  const end = source.indexOf("function guaranteedBaseFacingShot(", start);
  const safeStart = source.indexOf("function aiShotSafe(");
  const safeEnd = source.indexOf("function aiCanHitCurrentTarget(", safeStart);
  assert.ok(start >= 0 && end > start && safeStart >= 0 && safeEnd > safeStart);
  const enemy = { alive: true };
  const sandbox = {
    TILE: 32,
    DIRS: { up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
      left: { x: -1, y: 0 }, right: { x: 1, y: 0 } },
    canvas: { width: 832, height: 768 },
    baseRect: { x: 384, y: 704, w: 64, h: 64 },
    player: null,
    player2: null,
    tileAt(x, y) { return x === 11 && y === 21 ? "B" : "."; },
    rects(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x
        && a.y < b.y + b.h && a.y + a.h > b.y;
    },
    allyInShotCorridor: () => false,
    aiFirstHit: () => ({ type: "enemy", target: enemy }),
    shotFacesBaseGuard: () => false,
    aiCanHitTarget: () => true,
    guaranteedBaseFacingShot: (tank, dir, target) => target === enemy && dir === "down" && sandbox.guaranteed,
    centerOf: item => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 }),
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + source.slice(safeStart, safeEnd), sandbox);
  return { sandbox, enemy };
}

test("AI cannot fire down a base lane even when an enemy currently blocks the shell", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 12 * 32 + 2, y: 12 * 32 + 2, w: 28, h: 28, alive: true };
  sandbox.player = shooter;
  assert.equal(sandbox.aiShotThreatensProtectedArea(shooter, "down"), true);
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-attack-fire" }, "down"), false);
  assert.equal(sandbox.aiShotThreatensProtectedArea(shooter, "up"), false);
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-attack-fire" }, "up"), true);
});

test("a verified point-blank enemy-first shot may stop before the protected base", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 12 * 32 + 2, y: 19 * 32 + 2, w: 28, h: 28, alive: true };
  sandbox.player = shooter;
  sandbox.guaranteed = true;
  sandbox.shotFacesBaseGuard = () => true;
  assert.equal(sandbox.aiShotThreatensProtectedArea(shooter, "down", enemy), false);
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-base-melee-fire" }, "down"), true);
  sandbox.guaranteed = false;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-base-melee-fire" }, "down"), false);
  sandbox.guaranteed = true;
  sandbox.allyInShotCorridor = () => true;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-base-melee-fire" }, "down"), false);
});

test("the real base-facing guarantee accepts only a centered nearby enemy", () => {
  const { sandbox, enemy } = gameShotFixture();
  const source = fs.readFileSync(path.join(root, "game.js"), "utf8");
  const start = source.indexOf("function guaranteedBaseFacingShot(");
  const end = source.indexOf("function allyInShotCorridor(", start);
  assert.ok(start >= 0 && end > start);
  sandbox.freezeClock = 0;
  sandbox.firstHitIsTargetEnemy = (tank, dir, target) => target === enemy;
  vm.runInContext(source.slice(start, end), sandbox);
  const shooter = { x: 12 * 32 + 2, y: 19 * 32 + 2, w: 28, h: 28, alive: true };
  Object.assign(enemy, { x: 12 * 32 + 2, y: 20 * 32 + 2, w: 28, h: 28, dir: "down", speed: 72 });
  assert.equal(sandbox.guaranteedBaseFacingShot(shooter, "down", enemy), true);
  enemy.x += 16;
  assert.equal(sandbox.guaranteedBaseFacingShot(shooter, "down", enemy), false);
  enemy.x -= 16;
  sandbox.allyInShotCorridor = () => true;
  assert.equal(sandbox.guaranteedBaseFacingShot(shooter, "down", enemy), false);
  assert.equal(sandbox.guaranteedBaseFacingShot(shooter, "down", enemy, true), true);
});

test("a base emergency permits brick or teammate sacrifice but never a direct base hit", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 12 * 32 + 2, y: 18 * 32 + 2, w: 28, h: 28, alive: true };
  Object.assign(enemy, { enemy: true, x: 12 * 32 + 2, y: 20 * 32 + 2,
    w: 28, h: 28, dir: "down", speed: 72 });
  sandbox.player = shooter;
  sandbox.aiFirstHit = () => ({ type: "tile", tile: "B", baseGuard: true });
  assert.equal(sandbox.emergencyCollateralShot(shooter, "down", enemy), true);
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-contact-fire" }, "down"), true);
  sandbox.aiFirstHit = () => ({ type: "tile", tile: "E", baseGuard: true });
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-contact-fire" }, "down"), false);
  sandbox.aiFirstHit = () => ({ type: "ally" });
  sandbox.guaranteed = true;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-contact-fire" }, "down"), true);
  sandbox.guaranteed = false;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-contact-fire" }, "down"), false);
  enemy.x += 40;
  sandbox.aiFirstHit = () => ({ type: "tile", tile: "B", baseGuard: true });
  assert.equal(sandbox.emergencyCollateralShot(shooter, "down", enemy), false);
});

test("point-blank fire bypasses ordinary ally corridor veto but never the base", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 8 * 32 + 2, y: 10 * 32 + 2, w: 28, h: 28, alive: true };
  Object.assign(enemy, { enemy: true, x: 9 * 32 + 2, y: shooter.y, w: 28, h: 28 });
  sandbox.player = shooter;
  sandbox.allyCanEnterShotCorridor = () => true;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-direct" }, "right"), true);
  sandbox.shotFacesBaseGuard = () => true;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-direct" }, "right"), false);
  sandbox.guaranteed = true;
  sandbox.guaranteedBaseFacingShot = () => sandbox.guaranteed;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-direct" }, "right"), true);
});

test("point-blank fire clears a blocking brick but not steel or the base", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 8 * 32 + 2, y: 10 * 32 + 2, w: 28, h: 28, alive: true };
  Object.assign(enemy, { enemy: true, x: 10 * 32 + 2, y: shooter.y, w: 28, h: 28 });
  sandbox.player = shooter;
  sandbox.aiFirstHit = () => ({ type: "tile", tile: "B", x: 9, y: 10, baseGuard: true });
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-clear" }, "right"), true);
  sandbox.aiFirstHit = () => ({ type: "tile", tile: "S", x: 9, y: 10 });
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-clear" }, "right"), false);
  sandbox.aiFirstHit = () => ({ type: "tile", tile: "E", x: 9, y: 10 });
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-clear" }, "right"), false);
});

test("point-blank teammate collateral is allowed away from the base, but not into it", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 8 * 32 + 2, y: 10 * 32 + 2, w: 28, h: 28, alive: true };
  Object.assign(enemy, { enemy: true, x: 10 * 32 + 2, y: shooter.y, w: 28, h: 28 });
  sandbox.player = shooter;
  sandbox.aiFirstHit = () => ({ type: "ally", target: {} });
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-direct" }, "right"), true);
  sandbox.shotFacesBaseGuard = () => true;
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-melee-direct" }, "right"), false);
});

test("AI withholds a shot if a moving teammate can enter its flight corridor", () => {
  const { sandbox, enemy } = gameShotFixture();
  const shooter = { x: 2 * 32 + 2, y: 8 * 32 + 2, w: 28, h: 28, alive: true };
  const teammate = { x: 8 * 32 + 2, y: 10 * 32 + 2, w: 28, h: 28, speed: 90,
    motionDir: "up", motionSpeed: 90, alive: true };
  sandbox.player = shooter;
  sandbox.player2 = teammate;
  assert.equal(sandbox.allyCanEnterShotCorridor(shooter, "right"), true);
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-opportunistic-fire" }, "right"), false);
  teammate.motionDir = "down";
  assert.equal(sandbox.allyCanEnterShotCorridor(shooter, "right"), false);
  teammate.motionDir = "up";
  teammate.y = 13 * 32 + 2;
  assert.equal(sandbox.allyCanEnterShotCorridor(shooter, "right"), false);
  assert.equal(sandbox.aiShotSafe(shooter, { target: enemy, mode: "core-opportunistic-fire" }, "right"), true);
});

test("a friendly shell remains dangerous after the enemy ahead of it disappears", () => {
  let source = fs.readFileSync(path.join(root, "ai-core.js"), "utf8");
  source = source.replace("  function incomingFriendlyBullet(ctx, tank) {",
    "  window.probeIncomingFriendlyBullet = incomingFriendlyBullet;\n  function incomingFriendlyBullet(ctx, tank) {");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const owner = { alive: true };
  const tank = { x: 300, y: 300, w: 28, h: 28, alive: true, invuln: 0 };
  const enemy = { x: 200, y: 300, w: 28, h: 28, alive: true };
  const bullet = { x: 100, y: 311, w: 6, h: 6, dir: "right", speed: 310,
    owner, enemy: false, dead: false };
  const ctx = { bullets: [bullet], enemies: [enemy], tileAt: () => "." };
  assert.equal(sandbox.window.probeIncomingFriendlyBullet(ctx, tank), bullet);
  enemy.alive = false;
  assert.equal(sandbox.window.probeIncomingFriendlyBullet(ctx, tank), bullet);
});
