function transformMap(map, variant) {
  const generated = /^generated-(\d{1,10})$/.exec(variant);
  if (!generated && !["mirror-upper", "open-even", "open-odd"].includes(variant)) throw new Error("Unknown holdout variant");
  if (!Array.isArray(map) || map.length < 20 || map.some(row => !Array.isArray(row) || row.length !== map[0].length)) throw new Error("Invalid map");
  const result = map.map(row => row.slice());
  let randomState = generated ? Number(generated[1]) >>> 0 : 0;
  const random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
  // Spawn rows and the entire lower base area retain their physical rules.
  for (let y = 1; y < Math.min(18, map.length - 6); y++) {
    if (generated) {
      for (let x = 0; x < result[y].length; x++) {
        const value = random();
        result[y][x] = x % 4 === 0 || y % 4 === 0 ? "."
          : value < 0.12 ? "S" : value < 0.28 ? "B" : value < 0.34 ? "W" : value < 0.42 ? "F" : ".";
      }
    } else if (variant === "mirror-upper") result[y].reverse();
    else for (let x = 0; x < result[y].length; x++) {
      if ((x + y) % 2 === (variant === "open-even" ? 0 : 1)
        && ["B", "S"].includes(result[y][x])) result[y][x] = ".";
    }
  }
  return result;
}
module.exports = { transformMap };
