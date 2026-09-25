const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

test('near-base melee routes around steel instead of repeatedly steering into it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ai-core.js'), 'utf8');
  const marker = '      name,\n      decide,';
  assert.equal(source.split(marker).length, 2);
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(marker, marker + '\n      previewContactCombatPlan: contactCombatPlan,'), sandbox);
  const engine = sandbox.window.TankPartnerAIEngine.enhance({});
  const map = Array.from({ length: 24 }, () => Array(26).fill('.'));
  map[20][12] = 'S';
  map[20][13] = 'S';
  for (const x of [11, 12, 13, 14]) map[21][x] = 'B';
  map[22][12] = 'E';
  const tank = { x: 14 * 32 + 2, y: 20 * 32 + 2, w: 28, h: 28, dir: 'left', speed: 90, alive: true };
  const enemy = { x: 10 * 32 + 2, y: 20 * 32 + 2, w: 28, h: 28, dir: 'down', speed: 72, alive: true, hp: 1 };
  const ctx = { tank, enemies: [enemy], friends: [], bullets: [], map, cols: 26, rows: 24,
    base: { x: 12 * 32, y: 22 * 32, w: 32, h: 32 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 4 * 32, h: 3 * 32 },
    tileAt: (x, y) => map[y]?.[x] ?? 'S', canMove: () => true,
    canFire: () => true, canDirectShoot: () => false, canPredictShoot: () => false };
  const controller = engine.createController('1P');
  const plan = controller.previewContactCombatPlan(ctx, tank, enemy);
  assert.equal(plan.enemy, enemy);
  assert.equal(plan.shot, null);
  assert.equal(plan.approach, 'up');
  ctx.gameTime = 1;
  const action = controller.decide(ctx);
  assert.equal(action.hold, false, `${action.mode}: do not wait beside the base`);
  assert.equal(action.dir, 'up', `${action.mode}: route toward the open firing flank`);
  tank.y -= 32;
  tank.dir = 'up';
  ctx.gameTime += 0.4;
  const next = controller.decide(ctx);
  assert.equal(next.hold, false, `${next.mode}: keep advancing around the barrier`);
  assert.equal(next.dir, 'left', `${next.mode}: follow the flank after clearing steel`);
});

test('a rejected point-blank shot is not repeated as if the game could fire it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ai-core.js'), 'utf8');
  const marker = '      name,\n      decide,';
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(source.replace(marker, marker + '\n      previewContactCombatPlan: contactCombatPlan,'), sandbox);
  const engine = sandbox.window.TankPartnerAIEngine.enhance({});
  const map = Array.from({ length: 24 }, () => Array(26).fill('.'));
  const tank = { x: 12 * 32 + 2, y: 19 * 32 + 2, w: 28, h: 28, dir: 'down', speed: 90, alive: true };
  const enemy = { x: 12 * 32 + 2, y: 20 * 32 + 2, w: 28, h: 28, dir: 'down', speed: 72, alive: true };
  const ctx = { tank, enemies: [enemy], friends: [], bullets: [], map, cols: 26, rows: 24,
    base: { x: 12 * 32, y: 22 * 32, w: 32, h: 32 },
    baseGuard: { x: 11 * 32, y: 21 * 32, w: 4 * 32, h: 3 * 32 },
    tileAt: (x, y) => map[y]?.[x] ?? 'S', canMove: () => true,
    canFire: () => true, canDirectShoot: () => false, canPredictShoot: () => false };
  const plan = engine.createController('1P').previewContactCombatPlan(ctx, tank, enemy);
  assert.equal(plan.shot, null);
  assert.ok(plan.approach, 'reposition instead of endlessly requesting a rejected shot');
});
