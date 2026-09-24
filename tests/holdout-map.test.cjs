const test = require("node:test");
const assert = require("node:assert/strict");
const { transformMap } = require("./holdout-map.cjs");
test("holdout transforms are deterministic, preserve spawn/base and never mutate input", () => {
  const map = Array.from({ length: 24 }, () => Array(26).fill("."));
  map[3][4] = "S"; map[4][4] = "B"; map[22][12] = "E"; map[21][12] = "B";
  const original = JSON.stringify(map);
  for (const variant of ["mirror-upper", "open-even", "open-odd"]) {
    const changed = transformMap(map, variant);
    assert.deepEqual(changed, transformMap(map, variant));
    assert.deepEqual(changed[0], map[0]);
    assert.deepEqual(changed.slice(18), map.slice(18));
    assert.notDeepEqual(changed, map);
  }
  assert.equal(JSON.stringify(map), original);
  assert.throws(() => transformMap(map, "unknown"));
});
