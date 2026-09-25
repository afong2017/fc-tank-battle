const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
  let source = fs.readFileSync(process.env.AI_PURSUIT_SOURCE || path.join(__dirname, '../ai-core.js'), 'utf8');
  const marker = '  function aimedFireAction(';
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, `  window.probe = { aimedFireAction, directShot, timedPredictiveLane };\n${marker}`);
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const tank = { x: 258, y: 322, w: 28, h: 28, dir: 'down', speed: 90,
    alive: true, turnCooldown: 0.28, cooldown: 0 };
  const enemy = { x: 258, y: 450, w: 28, h: 28, dir: 'down', speed: 72, alive: true };
  const ctx = { tank, enemies: [enemy], friends: [], bullets: [], freezeTime: 0,
    rows: 24, cols: 26, base: { x: 384, y: 704, w: 32, h: 32 },
    tileAt: () => '.', canMove: () => false, canFire: () => tank.cooldown <= 0,
    canDirectShoot: dir => dir === 'down', canShoot: () => false,
    canPredictShoot: dir => dir === 'down' };
  return { ...sandbox.window.probe, tank, enemy, ctx };
}

test('blocked pursuit does not bypass aim handling during turn cooldown', () => {
  const { aimedFireAction, tank, enemy, ctx } = fixture();
  ctx.canMove = () => true;
  ctx.canDirectShoot = () => false;
  const action = aimedFireAction(ctx, tank, 'down', 'core-contact-fire', enemy, true);
  assert.equal(action.mode, 'core-aim-turn');
  assert.equal(action.fire, false);
});

test('crossing targets keep their existing turn and interception handling', () => {
  const { aimedFireAction, tank, enemy, ctx } = fixture();
  enemy.dir = 'right';
  ctx.canMove = () => true;
  const action = aimedFireAction(ctx, tank, 'down', 'core-contact-fire', enemy, true);
  assert.equal(action.mode, 'core-aim-turn');
  assert.equal(action.fire, false);
});

test('game facing contract permits aligned fire but prevents a second immediate turn', () => {
  const source = fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8');
  const start = source.indexOf('function fireToward(');
  const end = source.indexOf('function tankSpeedCap(', start);
  assert.ok(start >= 0 && end > start);
  let shots = 0;
  const sandbox = { DIRS: { up: {}, down: {}, left: {}, right: {} },
    TANK_TURN_DELAY: 0.3, aiShotSafe: () => true,
    oppositeDir: d => ({ up: 'down', down: 'up', left: 'right', right: 'left' })[d],
    fire: () => { shots++; return true; } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);
  const tank = { dir: 'down', turnCooldown: 0.28 };
  assert.equal(sandbox.fireToward(tank, 'down'), true);
  assert.equal(sandbox.fireToward(tank, 'left'), false);
  assert.equal(shots, 1);
});
