const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load() {
  let source = fs.readFileSync(path.join(__dirname, '../ai-core.js'), 'utf8');
  const marker = '  function frozenContactApproachAction(';
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, `  window.probe = { frozenContactApproachAction, capAlignmentMove, movingAimAction, timedPredictiveLane };\n${marker}`);
  const sandbox = { window: {}, console };
  vm.runInNewContext(source, sandbox);
  return sandbox.window.probe;
}

test('aligned frozen approach stays full speed outside the final cell, in all four directions', () => {
  const { frozenContactApproachAction, capAlignmentMove } = load();
  for (const [dir, dx, dy] of [['right', 64, 64], ['left', -64, 64], ['down', 64, 64], ['up', 64, -64]]) {
    const tank = { x: 320, y: 320, w: 28, h: 28, dir, turnCooldown: 0.2 };
    const enemy = { x: tank.x + dx, y: tank.y + dy, w: 28, h: 28, alive: true };
    const action = capAlignmentMove(frozenContactApproachAction(tank,
      { enemy, approach: dir, frozenAlignment: true }), tank);
    assert.equal(action.moveScale, 1, dir);
    assert.equal(action.hold, false, dir);
    assert.equal(action.fire, false, 'do not shoot before a verified lane');
  }
});

test('final frozen correction retains slow alignment and does not alter generic route alignment', () => {
  const { frozenContactApproachAction, capAlignmentMove } = load();
  const tank = { x: 320, y: 320, w: 28, h: 28, dir: 'right', turnCooldown: 0 };
  const enemy = { x: 324, y: 384, w: 28, h: 28, alive: true };
  const action = capAlignmentMove(frozenContactApproachAction(tank,
    { enemy, approach: 'right', frozenAlignment: true }), tank);
  assert.equal(action.moveScale, 0.35);
  assert.equal(action.hold, false);
  const route = capAlignmentMove({ dir: 'up', fire: false, hold: false, mode: 'core-freeze-align' }, tank);
  assert.equal(route.moveScale, 0.35);
  assert.equal(route.hold, true, 'tight route turns still wait rather than clipping a wall');
});

test('stationary frozen aim turns without requesting an unsafe shot', () => {
  const { movingAimAction } = load();
  const tank = { x: 320, y: 320, w: 28, h: 28, dir: 'up', turnCooldown: 0 };
  const target = { x: 400, y: 320, w: 28, h: 28, alive: true };
  const ctx = {
    freezeTime: 4,
    base: { x: 384, y: 704, w: 32, h: 32 },
    canMove: () => false,
    canDirectShoot: () => false,
    tileAt: () => '.',
  };
  const action = movingAimAction(ctx, tank, 'right', 'core-freeze-aim', target);
  assert.equal(action.hold, true);
  assert.equal(action.dir, 'right');
  assert.equal(action.fire, false);
  const game = fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8');
  assert.match(game, /if \(action\.fire\) fired = fireToward\(tank, action\.dir, true, action\);\s*else faceTankToward\(tank, action\.dir\);/);
});

test('verified frozen shot keeps the existing fast turn-and-fire request', () => {
  const { movingAimAction } = load();
  const tank = { x: 320, y: 320, w: 28, h: 28, dir: 'up', turnCooldown: 0 };
  const target = { x: 400, y: 320, w: 28, h: 28, alive: true };
  const ctx = {
    freezeTime: 4,
    base: { x: 384, y: 704, w: 32, h: 32 },
    canMove: () => false,
    canDirectShoot: (dir, enemy) => dir === 'right' && enemy === target,
    tileAt: () => '.',
  };
  const action = movingAimAction(ctx, tank, 'right', 'core-freeze-aim', target);
  assert.equal(action.hold, true);
  assert.equal(action.fire, true);
});

test('frozen prediction uses the stationary lane until thaw and then only the remaining travel time', () => {
  const { timedPredictiveLane } = load();
  const tank = { x: 320, y: 320, w: 28, h: 28, dir: 'right', turnCooldown: 0 };
  const target = { x: 448, y: 320, w: 28, h: 28, dir: 'down', speed: 72, alive: true };
  const ctx = { freezeTime: 2, canPredictShoot: () => true, tileAt: () => '.' };
  assert.equal(timedPredictiveLane(ctx, tank, target, 'right'), true,
    'a frozen enemy on the ray remains hittable');
  target.y = 288;
  assert.equal(timedPredictiveLane(ctx, tank, target, 'right'), false,
    'a frozen enemy cannot move into an empty ray');
  target.y = 304;
  ctx.freezeTime = 0.2;
  assert.equal(timedPredictiveLane(ctx, tank, target, 'right'), true,
    'only motion after thaw contributes to lead');
  target.y = 320;
  ctx.freezeTime = 0.05;
  assert.equal(timedPredictiveLane(ctx, tank, target, 'right'), false,
    'do not assume the enemy remains frozen through impact');
  ctx.freezeTime = 2;
  ctx.tileAt = (x, y) => x === 12 && y === 10 ? 'S' : '.';
  assert.equal(timedPredictiveLane(ctx, tank, target, 'right'), false);
});
