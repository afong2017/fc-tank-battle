const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function scenario() {
  let source = fs.readFileSync(process.env.AI_RESPONSE_SOURCE || path.join(__dirname, '../ai-core.js'), 'utf8').replace(/\r/g, '');
  const marker = '      name,\n      decide,';
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, marker + '\n      respond: incomingBulletAction,');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const tank = { x: 258, y: 322, w: 28, h: 28, dir: 'right', speed: 90, alive: true };
  const ally = { x: 258, y: 100, w: 28, h: 28, dir: 'down', alive: true };
  const bullet = { x: 269, y: 180, w: 6, h: 6, dir: 'down', speed: 310, owner: ally, enemy: false };
  const ctx = { tank, friends: [ally], enemies: [], bullets: [bullet], bonuses: [],
    base: { x: 384, y: 704, w: 32, h: 32 }, cols: 26, rows: 24,
    tileAt: () => '.', canMove: () => true, canFire: () => true };
  const controller = sandbox.window.TankPartnerAIEngine.enhance({}).createController('1P');
  return { tank, bullet, ctx, controller };
}

test('friendly projectile crossing response escapes a dangerous stationary position', () => {
  const { tank, bullet, ctx, controller } = scenario();
  const action = controller.respond(ctx, tank, bullet, 1, null, true);
  assert.ok(action);
  assert.equal(action.hold, false);
  assert.equal(action.fire, false, 'never counter-fire at the teammate');
  assert.ok(['left', 'right'].includes(action.dir));
});

test('friendly crossing can wait when no route is available and ignores own or dead shells', () => {
  const { tank, bullet, ctx, controller } = scenario();
  bullet.x += 50;
  ctx.canMove = () => false;
  const action = controller.respond(ctx, tank, bullet, 1, null, true);
  assert.equal(action.hold, true);
  bullet.owner = tank;
  assert.equal(controller.respond(ctx, tank, bullet, 1, null, true), null);
  bullet.owner = {};
  bullet.dead = true;
  assert.equal(controller.respond(ctx, tank, bullet, 1, null, true), null);
});
