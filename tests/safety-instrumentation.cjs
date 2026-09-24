function instrument(source) {
  const once = (needle, replacement) => {
    if (source.split(needle).length !== 2) throw new Error(`Safety observer mismatch: ${needle}`);
    source = source.replace(needle, replacement);
  };
  once('setTile(tile.x, tile.y, ".");', `
        if (b.owner && !b.owner.enemy && (tileInBaseGuard(tile.x, tile.y)
          || (tile.y >= Math.floor(baseRect.y / TILE) - 4 && tile.y < Math.floor(baseRect.y / TILE)
            && tile.x >= Math.floor(baseRect.x / TILE) - 4
            && tile.x <= Math.floor((baseRect.x + baseRect.w - 1) / TILE) + 4))) {
          testSafety.protectedBrick++;
        }
        setTile(tile.x, tile.y, ".");`);
  once('function damageBase(bullet = null) {', `function damageBase(bullet = null) {
    if (baseAlive && bullet?.owner && !bullet.owner.enemy) testSafety.baseHit++;`);
  once('b.dead = hitTank(t, b);', `
        const safetyHpBefore = t.hp;
        const safetyAliveBefore = t.alive;
        b.dead = hitTank(t, b);
        if (b.owner && !b.owner.enemy && !t.enemy
          && (t.hp < safetyHpBefore || (safetyAliveBefore && !t.alive))) testSafety.friendlyHit++;`);
  return source;
}
module.exports = { instrument };
