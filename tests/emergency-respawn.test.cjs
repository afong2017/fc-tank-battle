const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../game.js'), 'utf8');
const start = source.indexOf('function emergencyRespawnChoice(');
const end = source.indexOf('function maybeEmergencyRespawn(', start);
assert.ok(start >= 0 && end > start);
const sandbox = { TILE: 32, centerOf: item => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 }) };
vm.createContext(sandbox);
vm.runInContext(source.slice(start, end), sandbox);

function scenario() {
  const p1 = { kind: 'player', x: 8 * 32 + 2, y: 2 * 32 + 2,
    w: 28, h: 28, speed: 90, alive: true };
  const p2 = { kind: 'player2', x: 16 * 32 + 2, y: 2 * 32 + 2,
    w: 28, h: 28, speed: 90, alive: true };
  const enemy = { x: 12 * 32 + 2, y: 16 * 32 + 2, w: 28, h: 28,
    speed: 72, alive: true, directBaseShot: false };
  return { allies: [p1, p2], threats: [enemy],
    livesByKind: { player: 3, player2: 3 },
    autoByKind: { player: true, player2: true },
    base: { x: 12 * 32, y: 22 * 32, w: 64, h: 64 },
    freezeTime: 0, bonuses: [], now: 10, lastRespawnAt: -Infinity,
    spawnOpen: () => true };
}

test('only the nearer spawn-side AI may spend a life when it can beat a real base deadline', () => {
  const state = scenario();
  const choice = sandbox.emergencyRespawnChoice(state);
  assert.equal(choice?.tank, state.allies[0]);
  assert.equal(choice?.enemy, state.threats[0]);
  assert.ok(choice.improvement > 1.2);
  state.threats[0].directBaseShot = true;
  assert.equal(sandbox.emergencyRespawnChoice(state), null, 'an already-firing enemy is too late for respawn');
});

test('do not sacrifice a human, last life, nearby defender, or freeze collector', () => {
  const state = scenario();
  state.autoByKind.player = false;
  state.autoByKind.player2 = false;
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
  state.autoByKind.player = true;
  state.livesByKind.player = 1;
  state.livesByKind.player2 = 1;
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
  state.livesByKind.player = 3;
  state.allies[1].x = 13 * 32 + 2;
  state.allies[1].y = 19 * 32 + 2;
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
  state.allies[1].y = 2 * 32 + 2;
  state.allies[1].x = 16 * 32 + 2;
  state.bonuses.push({ type: 'freeze', x: state.allies[0].x, y: state.allies[0].y,
    w: 28, h: 28 });
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
  state.bonuses.length = 0;
  state.freezeTime = 2;
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
  state.freezeTime = 0;
  state.lastRespawnAt = 8;
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
  state.lastRespawnAt = -Infinity;
  state.routeEta = () => Infinity;
  assert.equal(sandbox.emergencyRespawnChoice(state), null);
});

test('a selected emergency return consumes one life, respawns once, and records its reason', () => {
  const state = scenario();
  const events = [];
  const runtime = { ...sandbox, TILE: 32, COLS: 26, ROWS: 24,
    player: state.allies[0], player2: state.allies[1],
    enemies: state.threats, baseRect: state.base, bonuses: [],
    lives: 3, lives2: 3, p1Deaths: 0, p2Deaths: 0,
    p1Auto: true, p2Human: false, freezeClock: 0, baseAlive: true,
    gameTime: 10, lastEmergencyRespawnAt: -Infinity,
    lastEmergencyRespawnCheckAt: -Infinity,
    enemyBaseFireDir: () => null, aiFirstHit: () => ({ type: 'none' }),
    blocked: () => false, makeTankAtSafeSpawn: (kind, x, y) => ({ kind, x, y, alive: true }),
    recordAiExperience(type, detail) { events.push({ type, detail }); } };
  vm.createContext(runtime);
  vm.runInContext(source.slice(source.indexOf('function emergencyRespawnRouteEta(', start),
    source.indexOf('function updateAlly(', end)), runtime);
  runtime.maybeEmergencyRespawn();
  assert.equal(state.allies[0].alive, false);
  assert.notEqual(runtime.player, state.allies[0]);
  assert.equal(runtime.player.invuln, 2.4);
  assert.equal(runtime.player.emergencyReturnTarget, state.threats[0]);
  assert.equal(runtime.player.emergencyReturnUntil, 13);
  assert.equal(runtime.lives, 2);
  assert.equal(runtime.p1Deaths, 1);
  assert.equal(events[0]?.type, 'base_emergency_respawn');
  runtime.gameTime += 0.3;
  runtime.maybeEmergencyRespawn();
  assert.equal(runtime.p1Deaths, 1);
});

test('emergency return requires a real passable route from the spawn', () => {
  let opening = false;
  const routeSandbox = { TILE: 32, COLS: 26, ROWS: 24,
    blocked(box) {
      return Math.floor(box.x / 32) === 9
        && (!opening || Math.floor(box.y / 32) !== 20);
    } };
  vm.createContext(routeSandbox);
  vm.runInContext(source.slice(source.indexOf('function emergencyRespawnRouteEta(', start), end), routeSandbox);
  const tank = scenario().allies[0];
  const spawn = { x: 8 * 32 + 16, y: 22 * 32 + 16 };
  const anchor = { x: 11 * 32 + 16, y: 20 * 32 + 16 };
  assert.equal(routeSandbox.emergencyRespawnRouteEta(tank, spawn, anchor), Infinity);
  opening = true;
  assert.ok(Number.isFinite(routeSandbox.emergencyRespawnRouteEta(tank, spawn, anchor)));
});
