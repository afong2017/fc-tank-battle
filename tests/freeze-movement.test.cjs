const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function load() {
  let source = fs.readFileSync(path.join(__dirname, '../ai-core.js'), 'utf8');
  const marker = '  function frozenContactApproachAction(';
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, `  window.probe = { frozenContactApproachAction, capAlignmentMove };\n${marker}`);
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
