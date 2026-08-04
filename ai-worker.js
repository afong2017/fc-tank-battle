(function () {
  let shadowClockToken = 0;
  let shadowClockSleeper = null;
  const TILE_COST = {
    ".": 1,
    "F": 1,
    "B": 1.15,
  };

  function key(x, y, cols) {
    return y * cols + x;
  }

  function inBaseGuard(x, y, baseGuard) {
    const guard = baseGuard || { left: 11, top: 21, right: 14, bottom: 23 };
    return x >= guard.left && x <= guard.right && y >= guard.top && y <= guard.bottom;
  }

  function tileAt(map, x, y, cols, rows) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return "S";
    return map[y]?.[x] || "S";
  }

  function routeCost(map, x, y, cols, rows, allowBrickClear, baseGuard) {
    if (inBaseGuard(x, y, baseGuard)) return Infinity;
    const tile = tileAt(map, x, y, cols, rows);
    if (tile === "." || tile === "F") return TILE_COST[tile];
    if (allowBrickClear && tile === "B" && !inBaseGuard(x, y, baseGuard)) {
      const neighbors = [
        tileAt(map, x + 1, y, cols, rows),
        tileAt(map, x - 1, y, cols, rows),
        tileAt(map, x, y + 1, cols, rows),
        tileAt(map, x, y - 1, cols, rows),
      ].filter((value) => value === "B").length;
      return TILE_COST.B + Math.max(0, neighbors - 1) * 0.75;
    }
    return Infinity;
  }

  function steelCost(map, x, y, cols, rows) {
    let cost = 0;
    const neighbors = [
      [x + 1, y, 1.55],
      [x - 1, y, 1.55],
      [x, y + 1, 1.55],
      [x, y - 1, 1.55],
      [x + 1, y + 1, 0.55],
      [x - 1, y + 1, 0.55],
      [x + 1, y - 1, 0.55],
      [x - 1, y - 1, 0.55],
    ];
    for (const [nx, ny, penalty] of neighbors) {
      if (tileAt(map, nx, ny, cols, rows) === "S") cost += penalty;
    }
    return cost;
  }

  function buildDistance({ map, cols, rows, goals, allowBrickClear, baseGuard }) {
    const distMap = new Array(cols * rows).fill(Infinity);
    const queue = [];
    for (const goal of goals || []) {
      if (!goal) continue;
      const x = Math.max(0, Math.min(cols - 1, goal.x | 0));
      const y = Math.max(0, Math.min(rows - 1, goal.y | 0));
      if (!Number.isFinite(routeCost(map, x, y, cols, rows, allowBrickClear, baseGuard))) continue;
      const k = key(x, y, cols);
      distMap[k] = 0;
      queue.push({ x, y });
    }
    while (queue.length) {
      let bestIndex = 0;
      let bestValue = distMap[key(queue[0].x, queue[0].y, cols)];
      for (let i = 1; i < queue.length; i++) {
        const value = distMap[key(queue[i].x, queue[i].y, cols)];
        if (value < bestValue) {
          bestValue = value;
          bestIndex = i;
        }
      }
      const current = queue.splice(bestIndex, 1)[0];
      const currentCost = distMap[key(current.x, current.y, cols)];
      const neighbors = [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ];
      for (const next of neighbors) {
        const moveCost = routeCost(map, next.x, next.y, cols, rows, allowBrickClear, baseGuard);
        if (!Number.isFinite(moveCost)) continue;
        const nk = key(next.x, next.y, cols);
        const total = currentCost + moveCost + steelCost(map, next.x, next.y, cols, rows);
        if (total < distMap[nk]) {
          distMap[nk] = total;
          queue.push(next);
        }
      }
    }
    return distMap;
  }

  function clockSleep(milliseconds) {
    const waitAsync = /** @type {any} */ (Atomics).waitAsync;
    if (typeof SharedArrayBuffer !== "undefined" && typeof waitAsync === "function") {
      shadowClockSleeper ||= new Int32Array(new SharedArrayBuffer(4));
      return Promise.resolve(waitAsync(shadowClockSleeper, 0, 0, milliseconds).value);
    }
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function runShadowClock(token, payload = {}) {
    const speed = Math.max(1, Math.min(8, Number(payload.speed) || 1));
    const fixedDt = Math.max(1 / 240, Math.min(1 / 20, Number(payload.fixedDt) || 1 / 60));
    const intervalMs = Math.max(25, Math.min(200, Number(payload.intervalMs) || 50));
    let carry = 0;
    let previous = performance.now();
    while (token === shadowClockToken) {
      await clockSleep(intervalMs);
      if (token !== shadowClockToken) return;
      const now = performance.now();
      const elapsedMs = Math.max(1, Math.min(1000, now - previous));
      previous = now;
      carry += elapsedMs / 1000 * speed / fixedDt;
      const steps = Math.floor(carry);
      carry -= steps;
      if (steps > 0) self.postMessage({ type: "clock-tick", token, steps, elapsedMs });
    }
  }

  self.onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "clock-start") {
      const token = ++shadowClockToken;
      runShadowClock(token, message.payload).catch((error) => {
        self.postMessage({ type: "clock-error", error: error?.message || "shadow clock failed" });
      });
      return;
    }
    if (message.type === "clock-stop") {
      shadowClockToken++;
      return;
    }
    if (message.type !== "distance") return;
    try {
      self.postMessage({
        id: message.id,
        type: "distance-result",
        cacheKey: message.cacheKey,
        distMap: buildDistance(message.payload || {}),
      });
    } catch (error) {
      self.postMessage({
        id: message.id,
        type: "distance-error",
        cacheKey: message.cacheKey,
        error: error?.message || "worker distance failed",
      });
    }
  };
})();
