const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { instrument } = require("./safety-instrumentation.cjs");
const fixture = `
function brick(tile, b) { setTile(tile.x, tile.y, "."); }
function damageBase(bullet = null) { if (baseAlive) baseAlive = false; }
function impact(t, b) { b.dead = hitTank(t, b); }
`;
test("safety observers count ally violations without changing collision results", () => {
  const ctx = { testSafety: { protectedBrick: 0, baseHit: 0, friendlyHit: 0 },
    baseAlive: true, TILE: 32, baseRect: { x: 384, y: 704, w: 32, h: 32 },
    tileInBaseGuard: () => false, setTile() {}, hitTank(t) { t.hp--; return true; } };
  vm.createContext(ctx); vm.runInContext(instrument(fixture), ctx);
  const ally = { enemy: false };
  const enemy = { enemy: true };
  ctx.brick({ x: 12, y: 20 }, { owner: ally });
  ctx.brick({ x: 12, y: 20 }, { owner: ally,
    emergencyCollateral: { type: "tile", x: 12, y: 20 } });
  ctx.brick({ x: 12, y: 20 }, { owner: ally,
    emergencyCollateral: { type: "tile", x: 13, y: 20 } });
  ctx.brick({ x: 12, y: 20 }, { owner: enemy });
  ctx.brick({ x: 2, y: 2 }, { owner: ally });
  assert.equal(ctx.testSafety.protectedBrick, 2);
  const victim = { hp: 2, alive: true, enemy: false }, bullet = { owner: ally };
  ctx.impact(victim, bullet);
  assert.equal(victim.hp, 1); assert.equal(bullet.dead, true);
  assert.equal(ctx.testSafety.friendlyHit, 1);
  ctx.impact(victim, { owner: ally,
    emergencyCollateral: { type: "ally", target: victim } });
  assert.equal(victim.hp, 0); assert.equal(ctx.testSafety.friendlyHit, 1);
  ctx.impact(victim, { owner: ally,
    emergencyCollateral: { type: "ally", target: {} } });
  assert.equal(ctx.testSafety.friendlyHit, 2);
  ctx.damageBase({ owner: ally }); ctx.damageBase({ owner: ally });
  assert.equal(ctx.testSafety.baseHit, 1); assert.equal(ctx.baseAlive, false);
});
test("observer installation fails closed after source changes or duplicate markers", () => {
  assert.throws(() => instrument(fixture.replace('b.dead = hitTank(t, b);', '')));
  assert.throws(() => instrument(fixture + fixture));
});
