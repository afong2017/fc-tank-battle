const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("V3 attack actions keep their planned route visible", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
  const start = source.indexOf("function isAttackRouteMode(");
  const end = source.indexOf("function drawTargetLink(", start);
  assert.ok(start >= 0 && end > start);
  const isAttackRouteMode = vm.runInNewContext(`${source.slice(start, end)}\nisAttackRouteMode`);
  for (const mode of ["core-v3-attack-route", "core-v3-attack-aim", "core-v3-contact-step",
    "core-v3-detour", "core-v3-replan"]) {
    assert.equal(isAttackRouteMode(mode), true, mode);
  }
  assert.equal(isAttackRouteMode("core-v3-freeze-pickup"), false);
  assert.equal(isAttackRouteMode("core-v3-search"), false);
});

test("lock display uses only the active AI target and its own route", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
  const start = source.indexOf("function drawTargetLink(");
  const end = source.indexOf("function drawTargetLinks(", start);
  assert.doesNotMatch(source, /drawTargetMarker|strokeRect\(Math\.round\(target\.x\)/);
  const strokes = [];
  const ctx = {
    save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {},
    lineTo(x, y) { strokes.push([x, y]); },
    stroke() {},
  };
  const sandbox = {
    ctx, TILE: 32, performance: { now: () => 0 },
    visibleEnemyForAlly: (enemy) => Boolean(enemy?.alive),
    centerOf: (tank) => ({ x: tank.x + tank.w / 2, y: tank.y + tank.h / 2 }),
    lineBlockedForAttackRoute: () => false,
    aiFirstHit: () => ({ type: "enemy", target }),
    isAttackRouteMode: () => true,
  };
  vm.createContext(sandbox);
  const { drawTargetLink } = vm.runInContext(
    `${source.slice(start, end)}\n({ drawTargetLink })`, sandbox);
  const target = { alive: true, x: 160, y: 96, w: 28, h: 28 };
  const tank = { alive: true, x: 16, y: 16, w: 28, h: 28,
    lockedBaseTarget: target, attackTarget: null };
  drawTargetLink(tank, "cyan", true);
  assert.equal(strokes.length, 0, "a guessed fallback target must not be drawn");

  tank.attackTarget = target;
  tank.attackRouteTarget = target;
  tank.attackRouteMode = "core-v3-attack-route";
  tank.attackRoute = [{ x: 30, y: 30 }, { x: 62, y: 30 }, { x: 62, y: 110 }, { x: 174, y: 110 }];
  drawTargetLink(tank, "cyan", true);
  assert.ok(strokes.some(([x, y]) => x === 62 && y === 110));

  strokes.length = 0;
  tank.attackRouteTarget = { ...target };
  drawTargetLink(tank, "cyan", true);
  assert.equal(strokes.length, 0, "another target's route must not be reused");

  strokes.length = 0;
  tank.attackRoute = null;
  tank.aiCachedAction = { target, dir: "right", fire: true };
  drawTargetLink(tank, "cyan", true);
  assert.ok(strokes.some(([x]) => x === target.x), "a verified direct shot reaches the target edge");

  strokes.length = 0;
  tank.aiCachedAction = { target, dir: "right", fire: false, mode: "core-v3-contact-aim" };
  drawTargetLink(tank, "cyan", true);
  assert.ok(strokes.some(([x]) => x === target.x), "a verified aim shows the same direct lane");

  const drawn = strokes.length;
  drawTargetLink(tank, "cyan", false);
  assert.equal(strokes.length, drawn, "manual tanks must not show an AI lock");
});
