const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture(beforeFinalMovement = false) {
  const sourcePath = process.env.AI_RECOVERY_SOURCE || path.join(__dirname, '../ai-core.js');
  let source = fs.readFileSync(sourcePath, 'utf8');
  const marker = '      name,\n      decide,';
  source = source.replace(/\r\n/g, '\n');
  assert.equal(source.split(marker).length, 2);
  source = source.replace(marker, `${marker}
      testStabilize: stabilizeMovement,
      testRecoveryRoute() { return loopRecoveryRoute; },
      testReleaseAim(context, value, now) { return releaseRejectedAim(context, context.tank, value, now, rejectedAim); },
      testSetAction(value) { decideRaw = () => value; },`);
  if (beforeFinalMovement) {
    const end = '      let movementDir = action?.moveDir || action?.dir;';
    assert.equal(source.split(end).length, 2);
    source = source.replace(end, `      return action;\n${end}`);
  }
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const engine = sandbox.window.TankPartnerAIEngine.enhance({});
  const tank = { x: 258, y: 578, w: 28, h: 28, dir: 'down', speed: 90, alive: true, cooldown: 0 };
  const enemy = { x: 258, y: 674, w: 28, h: 28, dir: 'down', speed: 0, alive: true, kind: 'basic' };
  const map = Array.from({ length: 24 }, () => Array(26).fill('.'));
  const ctx = {
    tank, enemies: [enemy], friends: [], bullets: [], bonuses: [], map, mapVersion: 0,
    cols: 26, rows: 24, gameTime: 1, freezeTime: 0, stage: 1,
    base: { x: 384, y: 704, w: 32, h: 32 },
    baseGuard: { x: 352, y: 672, w: 128, h: 96 },
    tileAt: (x, y) => map[y]?.[x] || 'S',
    canMove: () => true, canFire: () => true,
    canShoot: () => false, canDirectShoot: () => false, canPredictShoot: () => false,
  };
  return { ctx, tank, enemy, controller: engine.createController('1P') };
}

test('moving melee fire interrupts an active loop recovery route', () => {
  const { ctx, tank, enemy, controller } = fixture();
  let action;
  for (const [i, dir] of ['left', 'right', 'left', 'right'].entries()) {
    action = controller.testStabilize(ctx, tank,
      { dir, hold: false, fire: false, target: enemy, mode: 'core-contact-approach' }, 1 + i * 0.1);
  }
  assert.match(action.mode, /loop/);
  enemy.y = tank.y + 64;
  ctx.canDirectShoot = dir => dir === 'down';
  const fire = { dir: 'down', moveDir: 'down', hold: false, fire: true,
    target: enemy, mode: 'core-contact-fire' };
  assert.equal(controller.testStabilize(ctx, tank, fire, 1.4), fire);
  const resume = { dir: 'left', hold: false, fire: false, target: enemy, mode: 'core-contact-approach' };
  assert.equal(controller.testStabilize(ctx, tank, resume, 1.5), resume,
    'a completed recovery cannot resume its stale route after the shot');
});

test('a verified close shot interrupts a live recovery route before another detour', () => {
  const { ctx, tank, enemy, controller } = fixture();
  for (const [i, dir] of ['left', 'right', 'left', 'right'].entries()) {
    controller.testStabilize(ctx, tank,
      { dir, moveDir: dir, hold: false, fire: false, target: enemy,
        mode: 'core-contact-approach' }, 1 + i * 0.1);
  }
  enemy.y = tank.y + 64;
  ctx.canDirectShoot = (dir, target) => dir === 'down' && target === enemy;
  const action = controller.testStabilize(ctx, tank,
    { dir: 'left', moveDir: 'left', hold: false, fire: false, target: enemy,
      mode: 'core-global-defense-route' }, 1.4);
  assert.equal(action.mode, 'core-defense-loop-shot');
  assert.equal(action.fire, true);
  assert.equal(action.target, enemy);
});

test('reaching the loop recovery endpoint releases the old travel direction', () => {
  const { ctx, tank, enemy, controller } = fixture();
  for (const [i, dir] of ['left', 'right', 'left', 'right'].entries()) {
    controller.testStabilize(ctx, tank,
      { dir, hold: false, fire: false, target: enemy, mode: 'core-contact-approach' }, 1 + i * 0.1);
  }
  const route = controller.testRecoveryRoute();
  assert.ok(route.length > 1);
  tank.x = route.at(-1).x * 32 + 2;
  tank.y = route.at(-1).y * 32 + 2;
  const fresh = { dir: 'right', moveDir: 'right', hold: false, fire: false,
    target: enemy, mode: 'core-contact-approach' };
  assert.equal(controller.testStabilize(ctx, tank, fresh, 1.4), fresh);
  assert.equal(controller.testStabilize(ctx, tank, fresh, 1.5), fresh);
});

test('loop recovery replans when its locked enemy moves to another cell', () => {
  const { ctx, tank, enemy, controller } = fixture();
  for (const [i, dir] of ['left', 'right', 'left', 'right'].entries()) {
    controller.testStabilize(ctx, tank,
      { dir, moveDir: dir, hold: false, fire: false, target: enemy,
        mode: 'core-contact-approach' }, 1 + i * 0.1);
  }
  const originalEndpoint = controller.testRecoveryRoute().at(-1);
  assert.ok(originalEndpoint);
  enemy.x += 32;
  controller.testStabilize(ctx, tank,
    { dir: 'left', moveDir: 'left', hold: false, fire: false, target: enemy,
      mode: 'core-contact-approach' }, 1.35);
  assert.equal(controller.testRecoveryRoute().at(-1).x, originalEndpoint.x,
    'one-cell movement keeps the current firing route stable');
  enemy.x += 4 * 32;
  ctx.gameTime = 1.4;
  controller.testStabilize(ctx, tank,
    { dir: 'left', moveDir: 'left', hold: false, fire: false, target: enemy,
      mode: 'core-contact-approach' }, 1.4);
  const updatedEndpoint = controller.testRecoveryRoute().at(-1);
  assert.ok(updatedEndpoint);
  assert.ok(controller.testRecoveryRoute().length > 1,
    `recovery must keep a usable route after target movement: ${JSON.stringify(updatedEndpoint)}`);
});

test('a clear frozen close shot finishes aiming instead of orbiting on the recovery route', () => {
  const { ctx, tank, enemy, controller } = fixture();
  for (const [i, dir] of ['left', 'right', 'left', 'right'].entries()) {
    controller.testStabilize(ctx, tank,
      { dir, hold: false, fire: false, target: enemy, mode: 'core-contact-approach' }, 1 + i * 0.1);
  }
  ctx.freezeTime = 4;
  enemy.x = tank.x + 64;
  enemy.y = tank.y;
  ctx.canDirectShoot = (dir, target) => dir === 'right' && target === enemy;
  const routeAction = { dir: 'left', moveDir: 'left', hold: false, fire: false,
    target: enemy, mode: 'core-global-defense-route' };
  ctx.freezeTime = 0.1;
  assert.notEqual(controller.testStabilize(ctx, tank, routeAction, 1.35).mode,
    'core-freeze-loop-aim', 'thaw before impact must not force stationary aiming');
  ctx.freezeTime = 4;
  const aim = controller.testStabilize(ctx, tank, routeAction, 1.4);
  assert.equal(aim.dir, 'right');
  assert.equal(aim.hold, true);
  assert.equal(aim.fire, false);
  tank.dir = 'right';
  tank.turnCooldown = 0.2;
  assert.equal(controller.testStabilize(ctx, tank, routeAction, 1.5).hold, true);
  tank.turnCooldown = 0;
  const shot = controller.testStabilize(ctx, tank, routeAction, 1.75);
  assert.equal(shot.fire, true);
  assert.equal(shot.dir, 'right');
});

test('steel-shot recovery replaces stale movement direction as well as barrel direction', () => {
  const { ctx, tank, enemy, controller } = fixture(true);
  ctx.map[19][8] = 'S';
  controller.testSetAction({ dir: 'down', moveDir: 'down', fire: true,
    hold: false, mode: 'core-contact-clear', target: enemy });
  const action = controller.decide(ctx);
  assert.equal(action.mode, 'core-steel-reposition');
  assert.equal(action.fire, false);
  assert.notEqual(action.dir, 'down');
  assert.equal(action.moveDir, action.dir);
});

test('reload and distant aiming do not cancel a committed escape', () => {
  for (const unavailable of ['reload', 'turn', 'distant']) {
    const { ctx, tank, enemy, controller } = fixture();
    for (const [i, dir] of ['left', 'right', 'left', 'right'].entries()) {
      controller.testStabilize(ctx, tank,
        { dir, hold: false, fire: false, target: enemy, mode: 'core-contact-approach' }, 1 + i * 0.1);
    }
    enemy.y = tank.y + (unavailable === 'distant' ? 128 : 64);
    ctx.canDirectShoot = () => true;
    ctx.canFire = () => unavailable !== 'reload';
    tank.turnCooldown = unavailable === 'turn' ? 0.2 : 0;
    const result = controller.testStabilize(ctx, tank,
      { dir: 'down', hold: false, fire: true, target: enemy, mode: 'core-contact-fire' }, 1.4);
    assert.equal(result.fire, false, unavailable);
    assert.match(result.mode, /loop/, unavailable);
  }
});

test('emergency movement commitment keeps movement and barrel commands coherent', () => {
  const { ctx, tank, enemy, controller } = fixture(true);
  enemy.x = 322; enemy.y = 578;
  tank.x = 194; tank.y = 578;
  const action = dir => ({ dir, moveDir: dir, fire: false, hold: false,
    mode: 'core-chase', target: enemy });
  controller.testSetAction(action('right'));
  controller.decide(ctx);
  ctx.gameTime += 0.05;
  controller.testSetAction(action('down'));
  const next = controller.decide(ctx);
  assert.equal(next.mode, 'core-chase');
  assert.equal(next.dir, 'down');
  assert.equal(next.moveDir, next.dir);
});

test('repeated rejected stationary aim turns without changing a valid first shot', () => {
  const { ctx, tank, enemy, controller } = fixture();
  const action = { dir: 'right', moveDir: 'right', fire: true, hold: true,
    mode: 'core-aim-turn', target: enemy };
  assert.equal(controller.testReleaseAim(ctx, action, 1), action);
  assert.equal(controller.testReleaseAim(ctx, action, 1.2), action);
  const recovered = controller.testReleaseAim(ctx, action, 1.36);
  assert.equal(recovered.fire, false);
  assert.equal(recovered.hold, true);
  assert.equal(recovered.dir, 'right');
  assert.equal(recovered.mode, 'core-aim-turn-recover');
  tank.x += 5;
  assert.equal(controller.testReleaseAim(ctx, action, 1.42), action);
  ctx.canShoot = () => true;
  assert.equal(controller.testReleaseAim(ctx, action, 1.9), action);
});
