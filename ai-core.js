// @ts-check

(function () {
  const TILE = 32;
  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const DIR_NAMES = /** @type {const} */ (["up", "down", "left", "right"]);
  const LOCAL_HUNT_RANGE = TILE * 5;
  const MELEE_COMMIT_SECONDS = 0.65;
  const COMBAT_POLICY = Object.freeze({ defend: 6.5, survive: 5, attack: 7, clear: 4 });
  const directBaseShotCaches = new WeakMap();
  const baseDirectFireGoalCaches = new WeakMap();
  const baseThreatPathCaches = new WeakMap();
  const interceptEnemyPathCaches = new WeakMap();
  const baseProjectileInterceptCaches = new WeakMap();
  const breakthroughAssignments = new WeakMap();
  const globalBattleStates = new WeakMap();
  const enemyLastSightings = new WeakMap();
  const forestCellCaches = new WeakMap();
  const freezePathCaches = new WeakMap();
  const workerDistanceCache = new Map();
  const workerDistancePending = new Set();
  let distanceWorker = null;
  let distanceWorkerDisabledUntil = 0;
  let distanceRequestId = 0;

  const center = (item) => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
  const manhattan = (a, b) => Math.abs(center(a).x - center(b).x) + Math.abs(center(a).y - center(b).y);
  const cellOf = (item) => ({ x: Math.floor(center(item).x / TILE), y: Math.floor(center(item).y / TILE) });
  const bodyGap = (a, b) => {
    const gapX = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
    const gapY = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
    return Math.max(gapX, gapY);
  };
  const tileRange = (a, b) => {
    const ac = cellOf(a);
    const bc = cellOf(b);
    return Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y));
  };
  const keyOf = (x, y) => `${x},${y}`;
  const opposite = (dir) => ({ up: "down", down: "up", left: "right", right: "left" })[dir] || null;
  const isInvulnerable = (tank) => Number(tank?.invuln) > 0;

  function distanceFieldKey(ctx, goals) {
    const goalKey = goals.map((goal) => `${goal.x},${goal.y}`).sort().join(";");
    return `${Number(ctx.stage) || 1}:${Number(ctx.mapVersion) || 0}:${goalKey}`;
  }

  function ensureDistanceWorker() {
    if (typeof Worker === "undefined" || Date.now() < distanceWorkerDisabledUntil) return null;
    if (distanceWorker) return distanceWorker;
    try {
      distanceWorker = new Worker("ai-worker.js");
      distanceWorker.onmessage = (event) => {
        const message = event.data || {};
        if (!message.cacheKey) return;
        workerDistancePending.delete(message.cacheKey);
        if (message.type !== "distance-result" || !Array.isArray(message.distMap)) return;
        workerDistanceCache.set(message.cacheKey, message.distMap);
        if (workerDistanceCache.size > 128) workerDistanceCache.delete(workerDistanceCache.keys().next().value);
      };
      distanceWorker.onerror = () => {
        distanceWorker?.terminate();
        distanceWorker = null;
        workerDistancePending.clear();
        distanceWorkerDisabledUntil = Date.now() + 5000;
      };
    } catch {
      distanceWorker = null;
      distanceWorkerDisabledUntil = Date.now() + 5000;
    }
    return distanceWorker;
  }

  function requestWorkerDistanceField(ctx, goals) {
    const worker = ensureDistanceWorker();
    if (!worker) return { available: false, field: null };
    const cacheKey = distanceFieldKey(ctx, goals);
    const cached = workerDistanceCache.get(cacheKey);
    if (cached) return { available: true, field: cached };
    if (!workerDistancePending.has(cacheKey)) {
      workerDistancePending.add(cacheKey);
      const guard = ctx.baseGuard;
      try {
        worker.postMessage({
          id: ++distanceRequestId,
          type: "distance",
          cacheKey,
          payload: {
            map: ctx.map,
            cols: ctx.cols,
            rows: ctx.rows,
            goals,
            allowBrickClear: true,
            baseGuard: guard ? {
              left: Math.floor(guard.x / TILE),
              top: Math.floor(guard.y / TILE),
              right: Math.ceil((guard.x + guard.w) / TILE) - 1,
              bottom: Math.ceil((guard.y + guard.h) / TILE) - 1,
            } : null,
          },
        });
      } catch {
        workerDistancePending.delete(cacheKey);
        distanceWorker?.terminate();
        distanceWorker = null;
        distanceWorkerDisabledUntil = Date.now() + 5000;
        return { available: false, field: null };
      }
    }
    return { available: true, field: null };
  }

  function policyWeight(ctx, key) {
    const baseline = Number(COMBAT_POLICY[key]) || 5;
    const policy = Number(ctx?.weights?.[key]);
    return Number.isFinite(policy) ? Math.max(0, Math.min(10, policy)) : baseline;
  }

  function crossedMidline(ctx, enemy) {
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    return Boolean(enemy?.alive) && center(enemy).y >= fieldHeight / 2;
  }

  function crossedDefenseThird(ctx, enemy) {
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    return Boolean(enemy?.alive) && center(enemy).y >= fieldHeight / 3;
  }

  function inForest(ctx, tank) {
    const c = cellOf(tank);
    return ctx.tileAt?.(c.x, c.y) === "F";
  }

  function allVisibleEnemies(ctx) {
    const visible = (ctx.enemies || []).filter((enemy) => enemy?.alive && !inForest(ctx, enemy));
    for (const enemy of visible) {
      enemyLastSightings.set(enemy, {
        x: Number(enemy.x) || 0,
        y: Number(enemy.y) || 0,
        cell: cellOf(enemy),
        seenAt: Number(ctx.gameTime) || 0,
      });
    }
    return visible;
  }

  function concealedFinalEnemy(ctx) {
    const living = (ctx.enemies || []).filter((enemy) => enemy?.alive);
    return living.length === 1 && inForest(ctx, living[0]) ? living[0] : null;
  }

  function forestSearchCells(ctx) {
    const key = ctx.map;
    const mapVersion = Number(ctx.mapVersion || 0);
    const cached = key && forestCellCaches.get(key);
    if (cached?.mapVersion === mapVersion) return cached.cells;
    const cells = [];
    for (let y = 0; y < Number(ctx.rows || 24); y++) {
      for (let x = 0; x < Number(ctx.cols || 26); x++) {
        if ((ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x]) === "F") cells.push({ x, y });
      }
    }
    if (key) forestCellCaches.set(key, { mapVersion, cells });
    return cells;
  }

  function visibleEnemies(ctx) {
    const allowed = ctx.aiEnemyPool instanceof Set ? ctx.aiEnemyPool : null;
    return allVisibleEnemies(ctx).filter((enemy) => !allowed || allowed.has(enemy));
  }

  function fastApproachThreat(ctx, enemy) {
    if (!enemy?.alive || enemy.kind !== "fast" || !ctx.base) return false;
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    const depth = center(enemy).y;
    const baseDistance = manhattan(enemy, ctx.base);
    const dangerEta = Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy));
    return Boolean(directBaseShotThreat(ctx, enemy))
      || crossedMidline(ctx, enemy)
      || baseDistance <= TILE * 10
      || dangerEta <= 6.2
      || (depth >= fieldHeight * 0.34 && (enemy.dir === "down" || dangerEta <= 7.5));
  }

  function targetPriority(ctx, tank, enemy) {
    const baseDistance = manhattan(enemy, ctx.base);
    const tankDistance = manhattan(enemy, tank);
    const baseEta = baseThreatEta(ctx, enemy);
    const baseLineEta = baseLineThreatEta(ctx, enemy);
    const dangerEta = Math.min(baseEta, baseLineEta);
    const defendWeight = policyWeight(ctx, "defend");
    const basePriorityRange = TILE * Math.max(6, Math.min(14, 5 + defendWeight * 0.45));
    const crossed = crossedMidline(ctx, enemy);
    const directBaseShot = directBaseShotThreat(ctx, enemy);
    const fastApproach = fastApproachThreat(ctx, enemy);
    const verticalRush = verticalRushThreat(ctx, enemy);
    const tier = directBaseShot ? -1 : crossed || fastApproach || verticalRush || baseDistance <= basePriorityRange || dangerEta <= 4.2 ? 0 : tankDistance <= LOCAL_HUNT_RANGE ? 1 : 2;
    const stageOne = Number(ctx.stage) === 1;
    const fieldWidth = Math.max(TILE * 3, Number(ctx.cols || 26) * TILE);
    const laneOf = (item) => Math.max(0, Math.min(2, Math.floor(center(item).x / (fieldWidth / 3))));
    const enemyLane = laneOf(enemy);
    const tankLane = laneOf(tank);
    const laneMismatch = enemyLane === tankLane ? 0 : TILE * 1.4;
    const centerDanger = enemyLane === 1 ? TILE * 1.8 : 0;
    const responseScore = tier === 0
      ? dangerEta * TILE * 2 + tankDistance * 0.12 + (stageOne ? laneMismatch - centerDanger : 0)
        - (fastApproach ? TILE * 1.75 : 0) - (verticalRush ? TILE * 2.25 : 0)
      : baseDistance + tankDistance * 0.18 + (stageOne ? laneMismatch - centerDanger : 0);
    return { enemy, tier, crossed, fastApproach, verticalRush, directBaseShot, baseDistance, baseEta: dangerEta, baseLineEta, tankDistance, responseScore };
  }

  function baseThreatEta(ctx, enemy) {
    const speed = Math.max(45, Number(enemy?.speed) || 72);
    const enemyCenter = center(enemy);
    const baseCenter = center(ctx.base);
    const firingOffset = TILE * 1.15;
    const verticalApproach = Math.abs(enemyCenter.x - baseCenter.x)
      + Math.max(0, Math.abs(enemyCenter.y - baseCenter.y) - firingOffset);
    const horizontalApproach = Math.abs(enemyCenter.y - baseCenter.y)
      + Math.max(0, Math.abs(enemyCenter.x - baseCenter.x) - firingOffset);
    const approachDistance = Math.min(verticalApproach, horizontalApproach);
    const movingTowardBase = enemyCenter.y < baseCenter.y && enemy.dir === "down";
    const fastPressure = enemy.kind === "fast" ? 0.22 : 0;
    return Math.max(0, approachDistance / speed - (movingTowardBase ? 0.45 : 0) - fastPressure);
  }

  function baseLineThreatEta(ctx, enemy) {
    if (!enemy?.alive || !ctx.base) return Infinity;
    const enemyCenter = center(enemy);
    const baseCenter = center(ctx.base);
    const xAligned = Math.abs(enemyCenter.x - baseCenter.x) <= Math.max(18, (ctx.base.w || TILE * 2) / 2 - 4);
    const yAligned = Math.abs(enemyCenter.y - baseCenter.y) <= Math.max(18, (ctx.base.h || TILE * 2) / 2 - 4);
    let dir = null;
    let distance = Infinity;
    if (xAligned) {
      dir = enemyCenter.y < baseCenter.y ? "down" : "up";
      distance = Math.abs(baseCenter.y - enemyCenter.y);
    } else if (yAligned) {
      dir = enemyCenter.x < baseCenter.x ? "right" : "left";
      distance = Math.abs(baseCenter.x - enemyCenter.x);
    }
    if (!dir || distance <= TILE * 0.5) return dir ? 0 : Infinity;
    const d = DIRS[dir];
    const visited = new Set();
    let bricks = 0;
    for (let offset = TILE * 0.55; offset < distance - TILE * 0.35; offset += TILE * 0.45) {
      const x = Math.floor((enemyCenter.x + d.x * offset) / TILE);
      const y = Math.floor((enemyCenter.y + d.y * offset) / TILE);
      const key = keyOf(x, y);
      if (visited.has(key)) continue;
      visited.add(key);
      const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
      if (tile === "S") return Infinity;
      if (tile === "B") bricks++;
    }
    const turnDelay = enemy.dir === dir ? 0 : enemy.dir === opposite(dir) ? 0.6 : 0.3;
    return distance / 310 + bricks * 0.55 + turnDelay;
  }

  function directBaseShotThreat(ctx, enemy) {
    if (!enemy?.alive || !ctx.base) return null;
    let cache = directBaseShotCaches.get(ctx);
    if (!cache) {
      cache = new Map();
      directBaseShotCaches.set(ctx, cache);
    }
    if (cache.has(enemy)) return cache.get(enemy);
    const start = center(enemy);
    const maxDistance = Math.max(Number(ctx.cols || 26), Number(ctx.rows || 24)) * TILE;
    const candidates = [];
    for (const dir of DIR_NAMES) {
      const d = DIRS[dir];
      const visited = new Set();
      for (let distance = TILE * 0.55; distance <= maxDistance; distance += 4) {
        const px = start.x + d.x * distance;
        const py = start.y + d.y * distance;
        const insideBase = px >= ctx.base.x && px <= ctx.base.x + ctx.base.w
          && py >= ctx.base.y && py <= ctx.base.y + ctx.base.h;
        const x = Math.floor(px / TILE);
        const y = Math.floor(py / TILE);
        const key = keyOf(x, y);
        if (visited.has(key) && !insideBase) continue;
        visited.add(key);
        const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
        const protectedBrick = tile === "B" && isGuardCell(ctx, x, y);
        if (insideBase || tile === "E" || protectedBrick) {
          const turnDelay = enemy.dir === dir ? 0 : enemy.dir === opposite(dir) ? 0.6 : 0.3;
          candidates.push({ dir, distance, eta: distance / 310 + turnDelay, target: insideBase || tile === "E" ? "base" : "guard" });
          break;
        }
        if (tile === "B" || tile === "S" || tile === "E") break;
      }
    }
    const result = candidates.sort((a, b) => a.eta - b.eta || a.distance - b.distance)[0] || null;
    cache.set(enemy, result);
    return result;
  }

  function isBaseEmergency(ctx, enemy) {
    return Boolean(enemy?.alive) && (
      directBaseShotThreat(ctx, enemy)
      || crossedMidline(ctx, enemy)
      || manhattan(enemy, ctx.base) <= TILE * 6
      || baseThreatEta(ctx, enemy) <= 4.2
      || baseLineThreatEta(ctx, enemy) <= 3.2
    );
  }

  function isBaseIntruder(ctx, enemy) {
    return Boolean(enemy?.alive) && (
      directBaseShotThreat(ctx, enemy)
      || manhattan(enemy, ctx.base) <= TILE * 6
      || baseLineThreatEta(ctx, enemy) <= 2.4
    );
  }

  function mortalBaseThreat(ctx, enemy) {
    if (!enemy?.alive || !ctx.base) return null;
    const direct = directBaseShotThreat(ctx, enemy);
    const baseDistance = manhattan(enemy, ctx.base);
    const eta = Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy));
    const fast = enemy.kind === "fast";
    const mortal = Boolean(direct)
      || baseDistance <= TILE * (fast ? 5.5 : 3.25)
      || eta <= (fast ? 2.4 : 1.25);
    if (!mortal) return null;
    const share = Boolean(direct && direct.eta <= 1.25)
      || baseDistance <= TILE * (fast ? 3.75 : 2.7)
      || eta <= 0.9;
    return { enemy, direct, baseDistance, eta, fast, share };
  }

  function rankedMortalBaseThreats(ctx) {
    return visibleEnemies(ctx).map((enemy) => mortalBaseThreat(ctx, enemy)).filter(Boolean)
      .sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
        || Number(b.share) - Number(a.share)
        || a.eta - b.eta
        || a.baseDistance - b.baseDistance
        || Number(b.fast) - Number(a.fast));
  }

  function isFastLastLine(ctx, enemy) {
    const threat = mortalBaseThreat(ctx, enemy);
    return Boolean(threat?.fast && (threat.share || threat.baseDistance <= TILE * 4));
  }

  function lastLineThreat(ctx, tank = null) {
    const reserved = new Set((ctx.reservedTargets || []).filter((item) => item?.alive));
    return visibleEnemies(ctx).map((enemy) => ({
      enemy,
      directBaseShot: directBaseShotThreat(ctx, enemy),
      crossed: crossedMidline(ctx, enemy),
      baseDistance: manhattan(enemy, ctx.base),
      baseEta: baseThreatEta(ctx, enemy),
      baseLineEta: baseLineThreatEta(ctx, enemy),
    })).map((item) => ({ ...item, dangerEta: Math.min(item.baseEta, item.baseLineEta) }))
      .filter((item) => item.directBaseShot || item.crossed || item.baseDistance <= TILE * 4.5 || item.dangerEta <= 2.6)
      .sort((a, b) => Number(Boolean(b.directBaseShot)) - Number(Boolean(a.directBaseShot))
        || a.dangerEta - b.dangerEta
        || a.baseDistance - b.baseDistance
        || Number(b.crossed) - Number(a.crossed))
      .find((item, _index, ranked) => !reserved.has(item.enemy)
        || ranked.length === 1
      || (tank && manhattan(tank, item.enemy) <= TILE * 2.2))?.enemy || null;
  }

  function assignedBaseThreat(ctx, tank, preferredTarget = null, excludedTarget = null) {
    const visible = visibleEnemies(ctx);
    const candidates = excludedTarget?.alive && visible.length > 1
      ? visible.filter((enemy) => enemy !== excludedTarget)
      : visible;
    const threats = candidates.map((enemy) => ({
      enemy,
      directBaseShot: directBaseShotThreat(ctx, enemy),
      crossed: crossedMidline(ctx, enemy),
      baseDistance: manhattan(enemy, ctx.base),
      dangerEta: Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy)),
    })).sort((a, b) => Number(Boolean(b.directBaseShot)) - Number(Boolean(a.directBaseShot))
        || a.dangerEta - b.dangerEta
        || a.baseDistance - b.baseDistance
        || center(a.enemy).x - center(b.enemy).x)
      .slice(0, 2);
    if (!threats.length) return null;
    const preferredThreat = threats.find((item) => item.enemy === preferredTarget);
    const directThreatExists = threats.some((item) => item.directBaseShot);
    const friendTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
    const reservedTargets = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
    if (preferredThreat && !friendTargets.has(preferredTarget)
      && (!directThreatExists || preferredThreat.directBaseShot)) return preferredTarget;
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive)
      .sort((a, b) => Number(a.kind === "player2") - Number(b.kind === "player2"));
    if (threats.length === 1 || allies.length < 2) return threats[0].enemy;
    const travel = (ally, threat) => (manhattan(ally, threat.enemy) + sideAssignmentPenalty(ctx, ally, threat.enemy))
      / Math.max(45, Number(ally.speed) || 90);
    const directCost = travel(allies[0], threats[0]) + travel(allies[1], threats[1]);
    const crossedCost = travel(allies[0], threats[1]) + travel(allies[1], threats[0]);
    const crossed = crossedCost + 0.08 < directCost;
    const index = allies.indexOf(tank);
    if (index < 0 || index > 1) return threats[0].enemy;
    const selectedIndex = crossed ? 1 - index : index;
    const selected = threats[selectedIndex].enemy;
    const alternate = threats[1 - selectedIndex]?.enemy;
    if ((friendTargets.has(selected) || reservedTargets.has(selected))
      && alternate && !friendTargets.has(alternate) && !reservedTargets.has(alternate)) return alternate;
    return selected;
  }

  function assignedRankedThreat(ctx, tank, ranked, shareSingle = false) {
    if (!ranked.length) return null;
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive)
      .sort((a, b) => Number(a.kind === "player2") - Number(b.kind === "player2"));
    if (allies.length < 2) return ranked[0].enemy;
    if (ranked.length === 1) {
      if (shareSingle) return ranked[0].enemy;
      return allies.slice().sort((a, b) => manhattan(a, ranked[0].enemy) - manhattan(b, ranked[0].enemy)
        || Number(a.kind === "player") - Number(b.kind === "player"))[0] === tank
        ? ranked[0].enemy
        : null;
    }
    const threats = ranked.slice(0, 2);
    const assignmentCost = (ally, threat) => manhattan(ally, threat.enemy)
      + sideAssignmentPenalty(ctx, ally, threat.enemy);
    const directCost = assignmentCost(allies[0], threats[0]) + assignmentCost(allies[1], threats[1]);
    const crossedCost = assignmentCost(allies[0], threats[1]) + assignmentCost(allies[1], threats[0]);
    const allyIndex = allies.indexOf(tank);
    if (allyIndex < 0 || allyIndex > 1) return threats[0].enemy;
    return threats[crossedCost + TILE * 0.25 < directCost ? 1 - allyIndex : allyIndex].enemy;
  }

  function sideAssignmentPenalty(ctx, tank, enemy) {
    if (!tank?.alive || !enemy?.alive || !ctx.base) return 0;
    const baseX = center(ctx.base).x;
    const enemyX = center(enemy).x;
    const ownsLeft = tank.kind === "player";
    const ownsRight = tank.kind === "player2";
    if (!ownsLeft && !ownsRight) return 0;
    const ownSide = ownsLeft ? enemyX < baseX : enemyX >= baseX;
    return ownSide ? 0 : TILE * 40;
  }

  function onAssignedSide(ctx, tank, enemy) {
    if (!tank?.alive || !enemy?.alive || !ctx.base) return true;
    const baseX = center(ctx.base).x;
    if (tank.kind === "player") return center(enemy).x < baseX;
    if (tank.kind === "player2") return center(enemy).x >= baseX;
    return true;
  }

  function sideEligibleThreats(ctx, ally, threats) {
    const own = threats.filter((threat) => onAssignedSide(ctx, ally, threat.enemy));
    const urgent = threats.filter((threat) => Number(threat.defenseTier) <= 2);
    if (!own.length) return threats;
    return [...new Set([...urgent, ...own])];
  }

  function sideEnemyPool(ctx, tank, assignedTarget = null) {
    const enemies = allVisibleEnemies(ctx);
    const own = enemies.filter((enemy) => onAssignedSide(ctx, tank, enemy));
    if (!own.length) return new Set(enemies);
    const terminalAssist = assignedTarget?.alive && !onAssignedSide(ctx, tank, assignedTarget)
      && directBaseShotThreat(ctx, assignedTarget)?.target === "base"
      && directBaseShotThreat(ctx, assignedTarget).eta <= 1.1;
    return new Set(terminalAssist ? [...own, assignedTarget] : own);
  }

  function sideMovementAllowed(ctx, tank, dir) {
    const role = ctx.aiSideRole;
    const delta = DIRS[dir];
    if ((role !== "LEFT" && role !== "RIGHT") || !delta) return true;
    const boundary = center(ctx.base).x;
    const currentX = center(tank).x;
    const nextX = currentX + delta.x * 4;
    const deviation = (x) => role === "LEFT" ? Math.max(0, x - boundary) : Math.max(0, boundary - x);
    if (deviation(currentX) <= 0) return deviation(nextX) <= 0;
    return deviation(nextX) <= deviation(currentX);
  }

  function assignedSideLaneTarget(ctx, tank, preferredTarget = null) {
    const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
    const friendTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
    const ranked = visibleEnemies(ctx).filter((enemy) => onAssignedSide(ctx, tank, enemy)).map((enemy) => {
      const priority = targetPriority(ctx, tank, enemy);
      return {
        ...priority,
        reserved: reserved.has(enemy) || friendTargets.has(enemy),
        preferred: enemy === preferredTarget,
      };
    }).sort((a, b) => a.tier - b.tier
      || Number(a.reserved) - Number(b.reserved)
      || Number(b.preferred) - Number(a.preferred)
      || Number(b.crossed) - Number(a.crossed)
      || a.baseEta - b.baseEta
      || a.baseDistance - b.baseDistance
      || a.tankDistance - b.tankDistance);
    return ranked[0]?.enemy || null;
  }

  function assignedDirectBaseAttacker(ctx, tank) {
    const projectileOwners = (ctx.bullets || []).map((bullet) => {
      const projectile = baseProjectileThreat(ctx, bullet, 4.2);
      return projectile && bullet.owner?.alive ? { enemy: bullet.owner, projectile } : null;
    }).filter(Boolean);
    const candidates = [...new Set([
      ...visibleEnemies(ctx),
      ...projectileOwners.map((item) => item.enemy),
    ])];
    const ranked = candidates.map((enemy) => {
      const direct = directBaseShotThreat(ctx, enemy);
      const projectile = projectileOwners.filter((item) => item.enemy === enemy)
        .sort((a, b) => a.projectile.eta - b.projectile.eta)[0]?.projectile || null;
      return direct || projectile ? {
        enemy,
        direct: direct || { eta: projectile.eta, distance: projectile.distance, dir: opposite(projectile.bullet.dir), target: "projectile" },
        projectile,
        baseDistance: manhattan(enemy, ctx.base),
        tankDistance: manhattan(enemy, tank),
      } : null;
    }).filter(Boolean).sort((a, b) => a.direct.eta - b.direct.eta
      || a.baseDistance - b.baseDistance
      || a.tankDistance - b.tankDistance);
    const primary = ranked[0];
    if (primary && (primary.direct.eta <= 2.4
      || primary.baseDistance <= TILE * 6
      || crossedMidline(ctx, primary.enemy))) return primary.enemy;
    return assignedRankedThreat(ctx, tank, ranked, ranked.length === 1);
  }

  function assignedCentralApproachThreat(ctx, tank) {
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    const baseCenter = center(ctx.base);
    const ranked = visibleEnemies(ctx).filter((enemy) => !crossedMidline(ctx, enemy)
      && !directBaseShotThreat(ctx, enemy)).map((enemy) => {
        const enemyCenter = center(enemy);
        const dangerEta = Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy));
        const central = Math.abs(enemyCenter.x - baseCenter.x) <= TILE * 3.25;
        const verticalRush = verticalRushThreat(ctx, enemy);
        const advanced = enemyCenter.y >= fieldHeight * (verticalRush ? 0.14 : 0.27);
        const pressing = enemy.dir === "down" || dangerEta <= 7.2 || Boolean(verticalRush);
        return (central || verticalRush) && advanced && pressing ? {
          enemy,
          verticalRush,
          dangerEta,
          depth: enemyCenter.y,
          baseDistance: manhattan(enemy, ctx.base),
          tankDistance: manhattan(enemy, tank),
        } : null;
      }).filter(Boolean).sort((a, b) => Number(Boolean(b.verticalRush)) - Number(Boolean(a.verticalRush))
        || (a.verticalRush?.eta ?? Infinity) - (b.verticalRush?.eta ?? Infinity)
        || a.dangerEta - b.dangerEta
        || b.depth - a.depth
        || a.baseDistance - b.baseDistance
        || a.tankDistance - b.tankDistance);
    return assignedRankedThreat(ctx, tank, ranked, false);
  }

  function assignedFastApproachThreat(ctx, tank) {
    const ranked = visibleEnemies(ctx).filter((enemy) => enemy.kind === "fast" && fastApproachThreat(ctx, enemy))
      .map((enemy) => ({
        enemy,
        direct: directBaseShotThreat(ctx, enemy),
        crossed: crossedMidline(ctx, enemy),
        dangerEta: Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy)),
        baseDistance: manhattan(enemy, ctx.base),
        tankDistance: manhattan(tank, enemy),
        depth: center(enemy).y,
      })).sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
        || Number(b.crossed) - Number(a.crossed)
        || a.dangerEta - b.dangerEta
        || b.depth - a.depth
        || a.baseDistance - b.baseDistance
        || a.tankDistance - b.tankDistance);
    return assignedRankedThreat(ctx, tank, ranked, false);
  }

  function nearestImmediateEnemy(ctx, tank) {
    return visibleEnemies(ctx).map((enemy) => ({ enemy, distance: manhattan(tank, enemy) }))
      .filter((item) => item.distance <= TILE * 3.5)
      .sort((a, b) => a.distance - b.distance)[0]?.enemy || null;
  }

  function nearestLocalBreakthrough(ctx, tank, preferredTarget = null) {
    const ranked = visibleEnemies(ctx).map((enemy) => ({
      enemy,
      distance: manhattan(tank, enemy),
      intruder: isBaseIntruder(ctx, enemy),
      emergency: isBaseEmergency(ctx, enemy),
      crossed: crossedMidline(ctx, enemy),
      direct: directBaseShotThreat(ctx, enemy),
      baseDistance: manhattan(enemy, ctx.base),
      baseEta: Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy)),
    })).filter((item) => item.distance <= TILE * 3.5 && (item.intruder || item.crossed))
      .sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
        || a.baseEta - b.baseEta
        || a.baseDistance - b.baseDistance
        || a.distance - b.distance);
    const pointBlank = ranked.find((item) => item.distance <= TILE * 2.05);
    if (pointBlank) return pointBlank.enemy;
    const assigned = assignedRankedThreat(ctx, tank, ranked, false);
    if (!assigned) return null;
    const assignedThreat = ranked.find((item) => item.enemy === assigned);
    const preferred = ranked.find((item) => item.enemy === preferredTarget) || null;
    if (preferred?.enemy === assigned && (!assignedThreat
      || (preferred.baseEta <= assignedThreat.baseEta + 0.45
        && preferred.distance <= assignedThreat.distance + TILE * 0.75))) return preferred.enemy;
    return assigned;
  }

  function chooseTarget(ctx, tank, routeCostFor = null) {
    const enemies = visibleEnemies(ctx);
    if (!enemies.length) return null;
    const finalThreat = lastLineThreat(ctx, tank);
    if (finalThreat) return finalThreat;
    const immediate = nearestImmediateEnemy(ctx, tank);
    if (immediate) return immediate;
    const reserved = new Set((ctx.reservedTargets || []).filter((item) => item?.alive));
    const ownSideThreatExists = enemies.some((enemy) => onAssignedSide(ctx, tank, enemy));
    const ranked = enemies.map((enemy) => {
      const priority = targetPriority(ctx, tank, enemy);
      const routeCost = Number(ctx.stage) === 1 && routeCostFor ? routeCostFor(enemy) : 0;
      const sideMismatch = ownSideThreatExists && !onAssignedSide(ctx, tank, enemy);
      return { ...priority, routeCost, sideMismatch, effectiveScore: priority.responseScore + routeCost * TILE * 0.9 };
    }).sort((a, b) =>
      a.tier - b.tier
      || Number(a.sideMismatch) - Number(b.sideMismatch)
      || Number(b.crossed) - Number(a.crossed)
      || (a.tier === 0 ? a.baseEta - b.baseEta : 0)
      || (a.tier === 0 ? a.baseDistance - b.baseDistance : 0)
      || (a.tier === 1 ? a.tankDistance - b.tankDistance : a.baseDistance - b.baseDistance)
      || (Number(ctx.stage) === 1 ? a.effectiveScore - b.effectiveScore : 0)
      || a.baseEta - b.baseEta
      || a.tankDistance - b.tankDistance);
    const bestTier = ranked[0].tier;
    const sameTier = ranked.filter((item) => item.tier === bestTier);
    const critical = sameTier[0];
    if (critical?.tier === 0 && (critical.baseEta <= 2.8 || critical.baseDistance <= TILE * 3)
      && (!reserved.has(critical.enemy) || enemies.length === 1 || manhattan(tank, critical.enemy) <= TILE * 2.2)) {
      return critical.enemy;
    }
    return sameTier.find(({ enemy }) => !reserved.has(enemy))?.enemy || sameTier[0].enemy;
  }

  function isGuardCell(ctx, x, y) {
    const guard = ctx.baseGuard;
    if (!guard) return false;
    const px = x * TILE + TILE / 2;
    const py = y * TILE + TILE / 2;
    return px >= guard.x && px < guard.x + guard.w && py >= guard.y && py < guard.y + guard.h;
  }

  function allyRoutePenalty(ctx, x, y) {
    if (ctx.ignoreAllyRoutes) return 0;
    let penalty = 0;
    for (const ally of ctx.friends || []) {
      if (!ally?.alive) continue;
      const occupied = cellOf(ally);
      if (occupied.x === x && occupied.y === y) penalty = Math.max(penalty, 7);
      const route = Array.isArray(ally.attackRoute) ? ally.attackRoute : [];
      const reservedIndex = route.slice(1, 3).findIndex((cell) => cell.x === x && cell.y === y);
      if (reservedIndex >= 0) penalty = Math.max(penalty, reservedIndex === 0 ? 4.5 : 2.5);
    }
    return penalty;
  }

  function sideRoutePenalty(ctx, x) {
    const role = ctx.aiSideRole;
    if (role !== "LEFT" && role !== "RIGHT") return 0;
    const boundary = center(ctx.base).x;
    const cellX = x * TILE + TILE / 2;
    const offSide = role === "LEFT" ? cellX >= boundary : cellX < boundary;
    if (!offSide) return 0;
    const tankX = center(ctx.tank).x;
    const tankOffSide = role === "LEFT" ? tankX >= boundary : tankX < boundary;
    if (!tankOffSide) return Infinity;
    return 40 + Math.abs(cellX - boundary) / TILE * 8;
  }

  function tileCost(ctx, x, y) {
    if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) return Infinity;
    if (ctx.aiAvoidCell?.x === x && ctx.aiAvoidCell?.y === y) return Infinity;
    const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
    // Base guard cells are a hard exclusion zone; no pursuit mode may route through them.
    if (isGuardCell(ctx, x, y)) return Infinity;
    const boundaryPenalty = sideRoutePenalty(ctx, x);
    if (!Number.isFinite(boundaryPenalty)) return Infinity;
    const coordinationPenalty = allyRoutePenalty(ctx, x, y);
    if (tile === "." || tile === "F") return 1 + coordinationPenalty + boundaryPenalty;
    // Ordinary brick remains almost as cheap as open ground so a shorter attack
    // route clears it instead of wasting time on a long detour.
    if (tile === "B") {
      const clearWeight = policyWeight(ctx, "clear");
      return 1.01 + Math.max(0, 10 - clearWeight) * 0.04 + coordinationPenalty + boundaryPenalty;
    }
    return Infinity;
  }

  function reconstruct(nodes, current) {
    const cells = [];
    while (current) {
      cells.push({ x: current.x, y: current.y });
      current = nodes.get(current.parent);
    }
    return cells.reverse();
  }

  function findPath(ctx, start, goals) {
    const goalKeys = new Set(goals.map((goal) => keyOf(goal.x, goal.y)));
    if (!goalKeys.size) return [];
    const heuristic = (x, y) => Math.min(...goals.map((goal) => Math.abs(goal.x - x) + Math.abs(goal.y - y)));
    const nodes = new Map();
    const open = [];
    const startKey = keyOf(start.x, start.y);
    nodes.set(startKey, { x: start.x, y: start.y, g: 0, f: heuristic(start.x, start.y), parent: null });
    open.push(startKey);
    let visits = 0;
    while (open.length && visits++ < 1300) {
      open.sort((a, b) => nodes.get(a).f - nodes.get(b).f);
      const currentKey = open.shift();
      const current = nodes.get(currentKey);
      if (goalKeys.has(currentKey)) return reconstruct(nodes, current);
      for (const dir of DIR_NAMES) {
        const d = DIRS[dir];
        const x = current.x + d.x;
        const y = current.y + d.y;
        const cost = tileCost(ctx, x, y);
        if (!Number.isFinite(cost)) continue;
        const nextKey = keyOf(x, y);
        const turnCost = current.moveDir && current.moveDir !== dir ? 0.35 : 0;
        const g = current.g + cost + turnCost;
        const known = nodes.get(nextKey);
        if (known && known.g <= g) continue;
        nodes.set(nextKey, { x, y, g, f: g + heuristic(x, y), parent: currentKey, moveDir: dir });
        if (!open.includes(nextKey)) open.push(nextKey);
      }
    }
    return [];
  }

  function attackGoals(ctx, target) {
    const c = cellOf(target);
    const goals = [];
    const attackWeight = policyWeight(ctx, "attack");
    const searchRange = Math.max(9, Math.min(26, Math.round(8 + attackWeight * 0.9)));
    for (const dir of DIR_NAMES) {
      const d = DIRS[dir];
      for (let distance = 1; distance <= searchRange; distance++) {
        const x = c.x + d.x * distance;
        const y = c.y + d.y * distance;
        const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
        // Water blocks tanks but not shells. Keep scanning to discover firing
        // positions on the opposite bank; the route finder will still go around.
        if (tile === "W") continue;
        const cost = tileCost(ctx, x, y);
        if (!Number.isFinite(cost)) break;
        // Ordinary brick is part of the attack corridor: plan through it and
        // let the movement loop destroy it. Steel and base guard still stop it.
        if (cost === 1) goals.push({ x, y });
      }
    }
    return goals;
  }

  function defensiveBand(ctx, tank) {
    const rows = Math.max(12, Number(ctx.rows || 24));
    const middleRole = tank?.kind === "player";
    const minRow = Math.max(6, Math.ceil(rows * (middleRole ? 0.46 : 0.58)));
    const maxRow = Math.max(minRow + 2, Math.min(rows - 4, Math.floor(rows * (middleRole ? 0.66 : 0.78))));
    const preferredRow = Math.max(minRow, Math.min(maxRow, Math.floor(rows * (middleRole ? 0.55 : 0.68))));
    return { minRow, maxRow, preferredRow };
  }

  function verticalDefenseGoals(ctx, tank, target) {
    if (!target?.alive) return [];
    const targetCell = cellOf(target);
    const band = defensiveBand(ctx, tank);
    const maxRow = targetPressingBase(ctx, target)
      ? Math.max(band.maxRow, Math.max(band.minRow + 2, Number(ctx.rows || 24) - 5))
      : band.maxRow;
    return attackGoals(ctx, target).filter((goal) =>
      goal.x === targetCell.x && goal.y >= band.minRow && goal.y <= maxRow);
  }

  function pursuitGoals(ctx, target) {
    const c = cellOf(target);
    return DIR_NAMES.map((dir) => ({
      x: c.x + DIRS[dir].x,
      y: c.y + DIRS[dir].y,
    })).filter((cell) => Number.isFinite(tileCost(ctx, cell.x, cell.y)));
  }

  function baseEntryGoals(ctx) {
    const guard = ctx.baseGuard;
    if (!guard) return [];
    const top = Math.max(0, Math.floor(guard.y / TILE) - 1);
    const left = Math.max(0, Math.floor(guard.x / TILE) - 1);
    const right = Math.min(ctx.cols - 1, Math.floor((guard.x + guard.w - 1) / TILE) + 1);
    const goals = [];
    for (let x = left; x <= right; x++) {
      if (Number.isFinite(tileCost(ctx, x, top))) goals.push({ x, y: top });
    }
    return goals;
  }

  function baseEmergencyFlankGoals(ctx, target) {
    const guard = ctx.baseGuard;
    if (!guard || !target) return [];
    const targetCell = cellOf(target);
    const left = Math.max(0, Math.floor(guard.x / TILE) - 1);
    const right = Math.min(ctx.cols - 1, Math.floor((guard.x + guard.w - 1) / TILE) + 1);
    const guardCenterX = (guard.x + guard.w / 2) / TILE;
    const preferredX = targetCell.x < guardCenterX ? left : right;
    const fallbackX = preferredX === left ? right : left;
    const preferred = { x: preferredX, y: targetCell.y };
    if (Number.isFinite(tileCost(ctx, preferred.x, preferred.y))) return [preferred];
    const fallback = { x: fallbackX, y: targetCell.y };
    return Number.isFinite(tileCost(ctx, fallback.x, fallback.y)) ? [fallback] : [];
  }

  function baseShieldGeometry(ctx, target, firingCell, shotDir) {
    if (!ctx.base || !target || !firingCell || !DIRS[shotDir]) {
      return { shieldSide: false, baseDistance: Infinity, shieldDepth: -Infinity, shotTowardBase: Infinity };
    }
    const baseCenter = center(ctx.base);
    const targetCenter = center(target);
    const firingCenter = {
      x: firingCell.x * TILE + TILE / 2,
      y: firingCell.y * TILE + TILE / 2,
    };
    const targetToBase = {
      x: baseCenter.x - targetCenter.x,
      y: baseCenter.y - targetCenter.y,
    };
    const targetToFiring = {
      x: firingCenter.x - targetCenter.x,
      y: firingCenter.y - targetCenter.y,
    };
    const baseVectorLength = Math.max(1, Math.hypot(targetToBase.x, targetToBase.y));
    const shieldDepth = (targetToFiring.x * targetToBase.x + targetToFiring.y * targetToBase.y)
      / baseVectorLength;
    const baseDistance = Math.abs(firingCenter.x - baseCenter.x) + Math.abs(firingCenter.y - baseCenter.y);
    const targetBaseDistance = Math.abs(targetCenter.x - baseCenter.x) + Math.abs(targetCenter.y - baseCenter.y);
    const shot = DIRS[shotDir];
    const shotTowardBase = shot.x * (baseCenter.x - firingCenter.x)
      + shot.y * (baseCenter.y - firingCenter.y);
    const shieldSide = shieldDepth >= TILE * 0.4
      && baseDistance + TILE * 0.2 < targetBaseDistance
      && shotTowardBase <= TILE * 0.1;
    return { shieldSide, baseDistance, shieldDepth, shotTowardBase };
  }

  function baseEmergencyMeleeGoals(ctx, target) {
    if (!target?.alive || !ctx.base) return [];
    const targetCell = cellOf(target);
    const fallback = [];
    for (let distance = 1; distance <= 2; distance++) {
      const candidates = DIR_NAMES.map((offsetDir) => {
        const offset = DIRS[offsetDir];
        const cell = {
          x: targetCell.x + offset.x * distance,
          y: targetCell.y + offset.y * distance,
        };
        if (tileCost(ctx, cell.x, cell.y) !== 1) return null;
        const shotDir = opposite(offsetDir);
        const firingTank = {
          x: cell.x * TILE + 2,
          y: cell.y * TILE + 2,
          w: 28,
          h: 28,
          alive: true,
          dir: shotDir,
        };
        if (steelBlocksShot(ctx, firingTank, target, shotDir)
          || firstShotObstacle(ctx, firingTank, shotDir, target)) return null;
        const shield = baseShieldGeometry(ctx, target, cell, shotDir);
        return {
          ...cell,
          ...shield,
        };
      }).filter(Boolean);
      const shielding = candidates.filter((candidate) => candidate.shieldSide);
      if (shielding.length) {
        return shielding.sort((a, b) => b.shieldDepth - a.shieldDepth || a.baseDistance - b.baseDistance)
          .map(({ x, y }) => ({ x, y }));
      }
      fallback.push(...candidates);
    }
    return fallback.sort((a, b) => a.shotTowardBase - b.shotTowardBase
      || b.shieldDepth - a.shieldDepth
      || a.baseDistance - b.baseDistance)
      .map(({ x, y }) => ({ x, y }));
  }

  function pathTravelTime(path, speed, initialDir, ctx = null) {
    if (path.length < 2) return 0;
    let turnDelay = 0;
    let clearDelay = 0;
    const countedBricks = new Set();
    let previous = initialDir;
    for (let i = 1; i < path.length; i++) {
      const dir = routeDirection([path[i - 1], path[i]]);
      if (dir && previous && dir !== previous) turnDelay += turnTime(previous, dir);
      previous = dir || previous;
      if (ctx) {
        const cell = path[i];
        const tile = ctx.tileAt?.(cell.x, cell.y) ?? ctx.map?.[cell.y]?.[cell.x];
        const key = keyOf(cell.x, cell.y);
        if (tile === "B" && !countedBricks.has(key)) {
          countedBricks.add(key);
          clearDelay += 0.55;
        }
      }
    }
    return (path.length - 1) * TILE / Math.max(45, Number(speed) || 72) + turnDelay + clearDelay;
  }

  function baseDirectFireGoals(ctx) {
    const cacheOwner = ctx.map || ctx;
    const cached = baseDirectFireGoalCaches.get(cacheOwner);
    const mapVersion = Number(ctx.mapVersion || 0);
    if (cached?.mapVersion === mapVersion) return cached.goals;
    const goals = [];
    for (let y = 0; y < ctx.rows; y++) {
      for (let x = 0; x < ctx.cols; x++) {
        if (!Number.isFinite(tileCost(ctx, x, y))) continue;
        const probe = { x: x * TILE + 2, y: y * TILE + 2, w: 28, h: 28, alive: true, dir: "down" };
        const shot = directBaseShotThreat(ctx, probe);
        if (!shot) continue;
        goals.push({
          x,
          y,
          shotDir: shot.dir,
          flightEta: shot.distance / 310,
        });
      }
    }
    baseDirectFireGoalCaches.set(cacheOwner, { mapVersion, goals });
    return goals;
  }

  function estimatedDirectBaseAttackEta(ctx, enemy) {
    if (!enemy?.alive || !ctx.base) return Infinity;
    const directEta = directBaseShotThreat(ctx, enemy)?.eta ?? Infinity;
    const goals = baseDirectFireGoals(ctx);
    if (!goals.length) return directEta;
    const route = findPath({ ...ctx, ignoreAllyRoutes: true }, cellOf(enemy), goals);
    if (!route.length) return directEta;
    const firingCell = route[route.length - 1];
    const firingGoal = goals.find((goal) => goal.x === firingCell.x && goal.y === firingCell.y);
    if (!firingGoal) return directEta;
    const arrivalDir = route.length > 1
      ? routeDirection(route.slice(-2)) || enemy.dir
      : enemy.dir;
    const routeEta = pathTravelTime(route, enemy.speed, enemy.dir, ctx);
    const firingEta = routeEta
      + turnTime(arrivalDir, firingGoal.shotDir)
      + firingGoal.flightEta;
    return Math.min(directEta, firingEta);
  }

  function enemyBaseRoute(ctx, enemy) {
    if (!enemy?.alive) return [];
    const enemyStart = cellOf(enemy);
    const key = `${Number(ctx.mapVersion || 0)}:${enemyStart.x},${enemyStart.y}`;
    let cached = interceptEnemyPathCaches.get(enemy);
    if (!cached || cached.key !== key) {
      cached = {
        key,
        path: findPath({ ...ctx, ignoreAllyRoutes: true }, enemyStart, baseEntryGoals(ctx)),
      };
      interceptEnemyPathCaches.set(enemy, cached);
    }
    return cached.path;
  }

  function verticalRushThreat(ctx, enemy) {
    if (!enemy?.alive || !ctx.base) return null;
    const route = enemyBaseRoute(ctx, enemy);
    if (route.length < 4) return null;
    let downward = 0;
    let horizontal = 0;
    let backward = 0;
    for (let index = 1; index < route.length; index++) {
      const dx = route[index].x - route[index - 1].x;
      const dy = route[index].y - route[index - 1].y;
      if (dy > 0) downward++;
      else if (dy < 0) backward++;
      if (dx) horizontal++;
    }
    const steps = route.length - 1;
    const verticalShare = downward / Math.max(1, steps);
    const eta = pathTravelTime(route, enemy.speed, enemy.dir, ctx);
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    const enteredMap = center(enemy).y >= fieldHeight * 0.14;
    const fastLane = verticalShare >= 0.68
      && backward === 0
      && horizontal <= Math.max(3, Math.floor(steps * 0.32))
      && eta <= 11.5
      && (enteredMap || eta <= 9.5);
    return fastLane ? { route, eta, verticalShare, horizontal } : null;
  }

  function projectedTargetDistance(tank, target, dir, step = TILE * 0.45) {
    const d = DIRS[dir];
    if (!d || !target) return Infinity;
    return manhattan({ ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step }, target);
  }

  function targetClosingIn(ctx, tank, target) {
    const movement = DIRS[target?.dir];
    if (!movement || !target?.alive) return false;
    const step = Math.max(TILE * 0.5, (Number(target.speed || target.baseSpeed) || 72) * 0.35);
    const projected = { ...target, x: target.x + movement.x * step, y: target.y + movement.y * step };
    const closingTank = manhattan(projected, tank) + 3 < manhattan(target, tank);
    const closingBase = ctx.base && manhattan(projected, ctx.base) + 3 < manhattan(target, ctx.base);
    return Boolean(closingTank || closingBase);
  }

  function targetPressingBase(ctx, target) {
    if (!target?.alive || !ctx.base) return false;
    if (directBaseShotThreat(ctx, target) || crossedMidline(ctx, target)) return true;
    const targetCenter = center(target);
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    const movement = DIRS[target.dir];
    const currentDistance = manhattan(target, ctx.base);
    const step = Math.max(TILE * 0.75, (Number(target.speed || target.baseSpeed) || 72) * 0.6);
    const projected = movement
      ? { ...target, x: target.x + movement.x * step, y: target.y + movement.y * step }
      : target;
    const projectedDistance = manhattan(projected, ctx.base);
    const dangerEta = Math.min(baseThreatEta(ctx, target), baseLineThreatEta(ctx, target));
    const advanced = targetCenter.y >= fieldHeight * 0.18;
    const closingBase = projectedDistance + TILE * 0.2 < currentDistance;
    return Boolean(verticalRushThreat(ctx, target))
      || fastApproachThreat(ctx, target)
      || (advanced && (closingBase || dangerEta <= 7.2));
  }

  function buildInterceptPlan(ctx, tank, enemy) {
    const enemyPath = enemyBaseRoute(ctx, enemy);
    if (enemyPath.length < 3) return null;
    const start = cellOf(tank);
    const probes = [];
    const band = defensiveBand(ctx, tank);
    const pressingBase = targetPressingBase(ctx, enemy);
    const interceptMaxRow = pressingBase
      ? Math.max(band.maxRow, Math.max(band.minRow + 2, Number(ctx.rows || 24) - 5))
      : band.maxRow;
    for (let i = 2; i < Math.min(enemyPath.length, 20); i++) {
      const enemyCell = enemyPath[i];
      const enemyEta = pathTravelTime(enemyPath.slice(0, i + 1), enemy.speed, enemy.dir, ctx);
      for (const offsetDir of DIR_NAMES) {
          const offset = DIRS[offsetDir];
          const shotDir = opposite(offsetDir);
          for (let distance = 2; distance <= 5; distance++) {
            const cell = { x: enemyCell.x + offset.x * distance, y: enemyCell.y + offset.y * distance };
            if (cell.y < band.minRow || cell.y > interceptMaxRow) continue;
            if (tileCost(ctx, cell.x, cell.y) !== 1) continue;
          const firingTank = { x: cell.x * TILE + 2, y: cell.y * TILE + 2, w: 28, h: 28, alive: true, dir: shotDir };
          const predictedEnemy = { x: enemyCell.x * TILE + 2, y: enemyCell.y * TILE + 2, w: 28, h: 28, alive: true };
          if (steelBlocksShot(ctx, firingTank, predictedEnemy, shotDir)
            || firstShotObstacle(ctx, firingTank, shotDir, predictedEnemy)) continue;
          const optimisticSteps = Math.abs(cell.x - start.x) + Math.abs(cell.y - start.y);
          const optimisticAllyEta = optimisticSteps * TILE / Math.max(45, Number(tank.speed) || 90);
          const flightEta = distance * TILE / 310;
          if (optimisticAllyEta + 0.3 > enemyEta - flightEta) continue;
          const shield = baseShieldGeometry(ctx, predictedEnemy, cell, shotDir);
          probes.push({
            cell,
            enemyCell,
            shotDir,
            enemyEta,
            flightEta,
            optimisticAllyEta,
            verticalShot: shotDir === "up" || shotDir === "down",
            ...shield,
          });
        }
      }
    }
    const ordered = probes.sort((a, b) => Number(b.shieldSide) - Number(a.shieldSide)
      || Number(b.verticalShot) - Number(a.verticalShot)
      || a.enemyEta - b.enemyEta
      || a.optimisticAllyEta - b.optimisticAllyEta
      || b.shieldDepth - a.shieldDepth
      || b.flightEta - a.flightEta);
    const shielded = ordered.filter((probe) => probe.shieldSide);
    if (pressingBase && !shielded.length) return null;
    const ranked = (pressingBase ? shielded : ordered).slice(0, 16);
    let goals = [...new Map(ranked.map((probe) => [keyOf(probe.cell.x, probe.cell.y), probe.cell])).values()];
    for (let attempt = 0; attempt < 4 && goals.length; attempt++) {
      const allyPath = findPath(ctx, start, goals);
      if (!allyPath.length) break;
      const cell = allyPath[allyPath.length - 1];
      const cellKey = keyOf(cell.x, cell.y);
      const arrivalDir = allyPath.length > 1 ? routeDirection(allyPath.slice(-2)) || tank.dir : tank.dir;
      const allyEta = pathTravelTime(allyPath, tank.speed, tank.dir, ctx);
      const candidates = ranked.filter((probe) => keyOf(probe.cell.x, probe.cell.y) === cellKey).map((probe) => {
        const readyEta = allyEta + turnTime(arrivalDir, probe.shotDir);
        const launchEta = probe.enemyEta - probe.flightEta;
        if (readyEta > launchEta + 0.12) return null;
        return {
          ...probe,
          path: allyPath,
          allyEta,
          launchEta,
          margin: launchEta - readyEta,
        };
      }).filter(Boolean).sort((a, b) => a.enemyEta - b.enemyEta
        || b.margin - a.margin
        || b.flightEta - a.flightEta);
      if (candidates[0]) return candidates[0];
      goals = goals.filter((goal) => keyOf(goal.x, goal.y) !== cellKey);
    }
    return null;
  }

  function globalInterceptPlan(ctx, tank, enemy) {
    if (!enemy?.alive || crossedMidline(ctx, enemy)) return null;
    const enemyPath = enemyBaseRoute(ctx, enemy);
    if (enemyPath.length < 3) return null;
    const start = cellOf(tank);
    const probes = [];
    for (let index = 2; index < Math.min(enemyPath.length, 18); index++) {
      const enemyCell = enemyPath[index];
      const enemyEta = pathTravelTime(enemyPath.slice(0, index + 1), enemy.speed, enemy.dir, ctx);
      for (const offsetDir of DIR_NAMES) {
        const offset = DIRS[offsetDir];
        const shotDir = opposite(offsetDir);
        for (let distance = 2; distance <= 5; distance++) {
          const cell = { x: enemyCell.x + offset.x * distance, y: enemyCell.y + offset.y * distance };
          if (tileCost(ctx, cell.x, cell.y) !== 1) continue;
          const firingTank = { x: cell.x * TILE + 2, y: cell.y * TILE + 2, w: 28, h: 28, alive: true, dir: shotDir };
          const predictedEnemy = { x: enemyCell.x * TILE + 2, y: enemyCell.y * TILE + 2, w: 28, h: 28, alive: true };
          if (steelBlocksShot(ctx, firingTank, predictedEnemy, shotDir)
            || firstShotObstacle(ctx, firingTank, shotDir, predictedEnemy)) continue;
          const optimisticSteps = Math.abs(cell.x - start.x) + Math.abs(cell.y - start.y);
          const optimisticAllyEta = optimisticSteps * TILE / Math.max(45, Number(tank.speed) || 90);
          const flightEta = distance * TILE / 310;
          if (optimisticAllyEta + 0.25 > enemyEta - flightEta) continue;
          const shield = baseShieldGeometry(ctx, predictedEnemy, cell, shotDir);
          probes.push({
            cell,
            enemyCell,
            shotDir,
            enemyEta,
            flightEta,
            optimisticAllyEta,
            sidePenalty: sideAssignmentPenalty(ctx, tank, predictedEnemy),
            ...shield,
          });
        }
      }
    }
    const ranked = probes.sort((a, b) => Number(b.shieldSide) - Number(a.shieldSide)
      || a.sidePenalty - b.sidePenalty
      || a.enemyEta - b.enemyEta
      || a.optimisticAllyEta - b.optimisticAllyEta).slice(0, 24);
    let goals = [...new Map(ranked.map((probe) => [keyOf(probe.cell.x, probe.cell.y), probe.cell])).values()];
    for (let attempt = 0; attempt < 5 && goals.length; attempt++) {
      const path = findPath(ctx, start, goals);
      if (!path.length) break;
      const cell = path[path.length - 1];
      const cellKey = keyOf(cell.x, cell.y);
      const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || tank.dir : tank.dir;
      const allyEta = pathTravelTime(path, tank.speed, tank.dir, ctx);
      const candidates = ranked.filter((probe) => keyOf(probe.cell.x, probe.cell.y) === cellKey)
        .map((probe) => {
          const readyEta = allyEta + turnTime(arrivalDir, probe.shotDir);
          const launchEta = probe.enemyEta - probe.flightEta;
          return readyEta <= launchEta + 0.15
            ? { ...probe, path, allyEta, launchEta, margin: launchEta - readyEta }
            : null;
        }).filter(Boolean).sort((a, b) => Number(b.shieldSide) - Number(a.shieldSide)
          || b.margin - a.margin
          || a.enemyEta - b.enemyEta);
      if (candidates[0]) return candidates[0];
      goals = goals.filter((goal) => keyOf(goal.x, goal.y) !== cellKey);
    }
    return null;
  }

  function globalEmergencyShieldPlan(ctx, tank, enemy) {
    if (!enemy?.alive) return null;
    const enemyPath = enemyBaseRoute(ctx, enemy);
    const start = cellOf(tank);
    const candidates = [];
    for (let index = 1; index < Math.min(enemyPath.length, 9); index++) {
      const enemyCell = enemyPath[index];
      const predictedEnemy = {
        ...enemy,
        x: enemyCell.x * TILE + 2,
        y: enemyCell.y * TILE + 2,
      };
      const goals = baseEmergencyMeleeGoals(ctx, predictedEnemy);
      if (!goals.length) continue;
      const path = findPath(ctx, start, goals);
      if (!path.length) continue;
      const enemyEta = pathTravelTime(enemyPath.slice(0, index + 1), enemy.speed, enemy.dir, ctx);
      const allyEta = pathTravelTime(path, tank.speed, tank.dir, ctx);
      const cell = path[path.length - 1];
      const dx = enemyCell.x - cell.x;
      const dy = enemyCell.y - cell.y;
      const shotDir = Math.abs(dx) >= Math.abs(dy)
        ? (dx < 0 ? "left" : "right")
        : (dy < 0 ? "up" : "down");
      const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || tank.dir : tank.dir;
      const shotDistance = (Math.abs(dx) + Math.abs(dy)) * TILE;
      const launchEta = enemyEta - shotDistance / 310;
      const readyEta = allyEta + turnTime(arrivalDir, shotDir);
      if (readyEta + 0.08 > launchEta) continue;
      const shield = baseShieldGeometry(ctx, predictedEnemy, cell, shotDir);
      candidates.push({ path, cell, enemyCell, shotDir, allyEta, enemyEta, launchEta, readyEta, margin: launchEta - readyEta, shield });
    }
    const predicted = candidates.sort((a, b) => Number(b.shield.shieldSide) - Number(a.shield.shieldSide)
      || b.margin - a.margin
      || a.enemyEta - b.enemyEta
      || a.allyEta - b.allyEta)[0];
    const fallbackGoals = baseEmergencyMeleeGoals(ctx, enemy);
    const path = predicted?.path || findPath(ctx, start, fallbackGoals);
    if (!path.length) return null;
    const cell = predicted?.cell || path[path.length - 1];
    const enemyCell = predicted?.enemyCell || cellOf(enemy);
    const dx = enemyCell.x - cell.x;
    const dy = enemyCell.y - cell.y;
    const shotDir = predicted?.shotDir || (Math.abs(dx) >= Math.abs(dy)
      ? (dx < 0 ? "left" : "right")
      : (dy < 0 ? "up" : "down"));
    return {
      cell,
      enemyCell,
      shotDir,
      path,
      allyEta: predicted?.allyEta ?? pathTravelTime(path, tank.speed, tank.dir, ctx),
      enemyEta: predicted?.enemyEta ?? 0,
      emergencyShield: true,
    };
  }

  function reliableDefensePlan(ctx, tank, threat) {
    if (!tank?.alive || !threat?.enemy?.alive || threat.defenseTier > 3) return null;
    const enemy = threat.enemy;
    if (!threat.crossed) {
      const early = globalInterceptPlan(ctx, tank, enemy) || buildInterceptPlan(ctx, tank, enemy);
      if (early?.path?.length) return { ...early, defensePlan: "EARLY_INTERCEPT" };
    }
    const shield = globalEmergencyShieldPlan(ctx, tank, enemy);
    return shield?.path?.length
      ? { ...shield, emergencyShield: true, defensePlan: "BASE_SIDE_FALLBACK" }
      : null;
  }

  function baseDefenseProfile(ctx, enemy) {
    const direct = directBaseShotThreat(ctx, enemy);
    const enemyCell = cellOf(enemy);
    const pathKey = `${Number(ctx.mapVersion || 0)}:${enemyCell.x},${enemyCell.y}:${enemy.dir}:${Number(enemy.speed) || 72}`;
    let pathMetrics = baseThreatPathCaches.get(enemy);
    if (!pathMetrics || pathMetrics.key !== pathKey) {
      const baseRoute = enemyBaseRoute(ctx, enemy);
      pathMetrics = {
        key: pathKey,
        baseRoute,
        routeEta: baseRoute.length
          ? pathTravelTime(baseRoute, enemy.speed, enemy.dir, ctx)
          : Infinity,
        attackEta: estimatedDirectBaseAttackEta(ctx, enemy),
      };
      baseThreatPathCaches.set(enemy, pathMetrics);
    }
    const { baseRoute, routeEta, attackEta } = pathMetrics;
    const geometricEta = baseThreatEta(ctx, enemy);
    const credibleEta = Math.min(routeEta, attackEta);
    const dangerEta = direct
      ? Math.min(direct.eta, credibleEta)
      : Number.isFinite(credibleEta) ? credibleEta : geometricEta + 2.5;
    const baseDistance = manhattan(enemy, ctx.base);
    const crossed = crossedMidline(ctx, enemy);
    const fast = enemy.kind === "fast";
    const defenseTier = direct?.target === "base" ? 0
      : direct?.target === "guard" || dangerEta <= 2.8 || baseDistance <= TILE * 3.5 ? 1
        : crossed || dangerEta <= 6.2 || (fast && dangerEta <= 7.5) ? 2
          : dangerEta <= 10 ? 3 : 4;
    // response ETA now ends at the final lethal hit, so the deadline only
    // reserves a small impact margin instead of subtracting an estimated kill.
    const impactMargin = direct?.target === "base" ? 0.18 : fast ? 0.3 : 0.22;
    const responseDeadline = Math.max(0, dangerEta - impactMargin);
    return {
      direct,
      baseRoute,
      routeEta,
      attackEta,
      geometricEta,
      dangerEta,
      baseDistance,
      crossed,
      fast,
      defenseTier,
      responseDeadline,
    };
  }

  function globalThreatRecord(ctx, enemy) {
    const profile = baseDefenseProfile(ctx, enemy);
    return {
      enemy,
      ...profile,
      deepPressure: crossedDefenseThird(ctx, enemy),
      fast: enemy.kind === "fast" && (fastApproachThreat(ctx, enemy) || profile.dangerEta <= 9.5),
      vertical: verticalRushThreat(ctx, enemy),
      depth: center(enemy).y,
    };
  }

  function planningContextForAlly(ctx, ally) {
    const allies = [ctx.tank, ...(ctx.friends || [])].filter((item, index, items) =>
      item?.alive && items.indexOf(item) === index);
    return {
      ...ctx,
      tank: ally,
      friends: allies.filter((item) => item !== ally),
      aiSideRole: null,
      canMove: undefined,
      canDirectShoot: undefined,
      canShoot: undefined,
      canPredictShoot: undefined,
      canFire: undefined,
    };
  }

  function geometricCurrentShot(ctx, tank, target) {
    if (!tank?.alive || !target?.alive) return null;
    const from = center(tank);
    const to = center(target);
    const targetWidth = Number(target.w) || 28;
    const targetHeight = Number(target.h) || 28;
    return DIR_NAMES.find((dir) => {
      const d = DIRS[dir];
      const axial = (to.x - from.x) * d.x + (to.y - from.y) * d.y;
      if (axial <= 0) return false;
      const lateral = dir === "up" || dir === "down"
        ? Math.abs(to.x - from.x)
        : Math.abs(to.y - from.y);
      const halfTarget = (dir === "up" || dir === "down" ? targetWidth : targetHeight) / 2;
      return lateral <= halfTarget + 3
        && !steelBlocksShot(ctx, tank, target, dir)
        && !firstShotObstacle(ctx, tank, dir, target);
    }) || null;
  }

  function lethalShotEta(tank, enemy, aimReadyEta, shotDistance) {
    const reloadReadyEta = Math.max(0, Number(tank?.cooldown) || 0);
    const firstLaunchEta = Math.max(Math.max(0, aimReadyEta), reloadReadyEta);
    const hits = Math.max(1, Math.ceil(Number(enemy?.hp || enemy?.life) || 1));
    const fireDelay = Math.max(0.3, Number(tank?.fireDelay) || 0.45);
    // A durable moving target may leave the first firing line. One real 90
    // degree turn is reserved for reacquisition instead of pretending every
    // remaining shell can be launched from the original aim solution.
    const reacquireAllowance = hits > 1 && Number(enemy?.speed) > 0 ? 0.3 : 0;
    return firstLaunchEta
      + (hits - 1) * fireDelay
      + reacquireAllowance
      + Math.max(0, shotDistance) / 310;
  }

  function plannedDefenseKillEta(ctx, ally, threat) {
    const enemy = threat?.enemy;
    if (!ally?.alive || !enemy?.alive) return Infinity;
    const directDir = geometricCurrentShot(ctx, ally, enemy);
    if (directDir) {
      return lethalShotEta(
        ally,
        enemy,
        turnTime(ally.dir, directDir),
        manhattan(ally, enemy),
      );
    }
    const plan = reliableDefensePlan(ctx, ally, threat);
    if (!plan?.path?.length || !plan.shotDir) return Infinity;
    const path = plan.path;
    const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || ally.dir : ally.dir;
    const movementEta = pathTravelTime(path, ally.speed, ally.dir, ctx);
    const firingCell = plan.cell || path[path.length - 1];
    const enemyCell = plan.enemyCell || cellOf(enemy);
    const shotDistance = (Math.abs(firingCell.x - enemyCell.x)
      + Math.abs(firingCell.y - enemyCell.y)) * TILE;
    return lethalShotEta(
      ally,
      enemy,
      movementEta + turnTime(arrivalDir, plan.shotDir),
      shotDistance,
    );
  }

  function defenderResponseEta(ctx, ally, threat) {
    if (!ally?.alive || !threat?.enemy?.alive) return Infinity;
    if (!threat.responseEtas) threat.responseEtas = new WeakMap();
    const cached = threat.responseEtas.get(ally);
    if (Number.isFinite(cached)) return cached;
    const planningCtx = planningContextForAlly(ctx, ally);
    const eta = plannedDefenseKillEta(planningCtx, ally, threat);
    threat.responseEtas.set(ally, eta);
    return eta;
  }

  function globalAssignmentCost(ctx, ally, threat) {
    const localDistance = manhattan(ally, threat.enemy);
    const responseEta = defenderResponseEta(ctx, ally, threat);
    const directRank = threat.direct ? -120000 - Math.max(0, 3 - threat.direct.eta) * 8000 : 0;
    const crossedRank = threat.crossed ? -60000 : 0;
    const fastRank = threat.fast ? -15000 : 0;
    const verticalRank = threat.vertical ? -12000 : 0;
    const finiteEta = Number.isFinite(threat.dangerEta) ? Math.min(30, threat.dangerEta) : 30;
    const ownSideExists = allVisibleEnemies(ctx).some((enemy) => onAssignedSide(ctx, ally, enemy));
    const sidePenalty = ownSideExists && threat.defenseTier > 2
      ? (threat.direct || threat.crossed
        ? sideAssignmentPenalty(ctx, ally, threat.enemy) * 0.75
        : sideAssignmentPenalty(ctx, ally, threat.enemy) * 4)
      : 0;
    const latePenalty = Number.isFinite(responseEta)
      ? Math.max(0, responseEta - threat.responseDeadline) * 50000
      : 250000;
    return directRank + crossedRank + fastRank + verticalRank
      + finiteEta * 520
      + threat.baseDistance * 1.4
      + localDistance * 0.72
      + Math.min(30, responseEta) * 1800
      + latePenalty
      + sidePenalty;
  }

  function analyzeGlobalBattle(ctx, now) {
    // game.js replaces the enemies array every frame after filtering dead tanks.
    // The map object is stable for the whole stage, while mapVersion tracks tile
    // mutations, so it is the correct shared identity for both ally controllers.
    const key = ctx.map || ctx.enemies;
    let state = globalBattleStates.get(key);
    const mapVersion = Number(ctx.mapVersion || 0);
    const stage = Number(ctx.stage || 1);
    const livingEnemies = allVisibleEnemies(ctx);
    const assignmentsValid = state && [...state.assignments.entries()].every(([ally, assignment]) => {
      if (assignment.target && (!assignment.target.alive || inForest(ctx, assignment.target))) return false;
      const ownSideExists = livingEnemies.some((enemy) => onAssignedSide(ctx, ally, enemy));
      const urgentAssist = Number(assignment.threat?.defenseTier) <= 2;
      return !ownSideExists || !assignment.target || onAssignedSide(ctx, ally, assignment.target) || urgentAssist;
    });
    const freezeOpportunity = (ctx.bonuses || []).some((bonus) =>
      !bonus?.dead && bonus.type === "freeze"
        && [ctx.tank, ...(ctx.friends || [])].some((ally) => ally?.alive && tileRange(ally, bonus) <= 8));
    // Reassign the collector on the scheduled global analysis. Running multiple
    // A* searches here on every 60 Hz controller decision defeated the cache.
    const pickupValid = state?.pickupDuty
      ? Boolean(state.pickupDuty.collector?.alive && !state.pickupDuty.bonus?.dead
        && (ctx.bonuses || []).includes(state.pickupDuty.bonus))
      : !freezeOpportunity;
    if (state && state.mapVersion === mapVersion && state.stage === stage
      && now < state.nextAnalysis && assignmentsValid && pickupValid) return state;

    const allies = [ctx.tank, ...(ctx.friends || [])].filter((ally) => ally?.alive)
      .sort((a, b) => Number(a.kind === "player2") - Number(b.kind === "player2"));
    const threats = livingEnemies.map((enemy) => globalThreatRecord(ctx, enemy));
    const pickupCandidates = [];
    const seenBonuses = new Set();
    for (const ally of allies) {
      const bonus = nearbyFreeze(ctx, ally);
      if (!bonus || seenBonuses.has(bonus)) continue;
      seenBonuses.add(bonus);
      const collector = freezeCollector(ctx, ally, bonus);
      if (!collector?.alive) continue;
      const path = freezePath(ctx, collector, bonus);
      if (!path.length) continue;
      pickupCandidates.push({
        bonus,
        collector,
        routeLength: Math.max(0, path.length - 1),
        distance: manhattan(collector, bonus),
      });
    }
    // Freeze affects every enemy, so collecting two at once only wastes the
    // second pickup. Keep the existing claim until collection or expiry; a
    // changing distance score must not redirect the collector past its bonus.
    const rankedPickupCandidates = pickupCandidates.sort((a, b) =>
      a.routeLength - b.routeLength
        || a.distance - b.distance);
    const priorPickup = state?.pickupDuty;
    let committedPickup = null;
    if (priorPickup?.collector?.alive && !priorPickup.bonus?.dead
      && (ctx.bonuses || []).includes(priorPickup.bonus)) {
      const committedPath = freezePath(ctx, priorPickup.collector, priorPickup.bonus);
      if (committedPath.length) {
        committedPickup = {
          bonus: priorPickup.bonus,
          collector: priorPickup.collector,
          routeLength: Math.max(0, committedPath.length - 1),
          distance: manhattan(priorPickup.collector, priorPickup.bonus),
        };
      }
    }
    const urgentPickup = rankedPickupCandidates.find((candidate) => candidate.routeLength <= 3) || null;
    let pickupDuty = committedPickup && (!urgentPickup || committedPickup.routeLength <= 3)
      ? committedPickup
      : urgentPickup || committedPickup || rankedPickupCandidates[0] || null;
    const previous = state?.assignments || new Map();
    const desired = new Map();
    if (allies.length && threats.length) {
      // A 0.45 s shared-defense window is too late around the protected base:
      // the assisting tank cannot turn, route around the guard bricks and fire
      // before impact. Keep split assignments normally, but converge while
      // there is still enough time to form a close firing lane.
      const terminalThreats = threats.filter((threat) =>
        (threat.direct?.target === "base" && threat.direct.eta <= 1.1)
        || (threat.crossed && threat.baseDistance <= TILE * 2.75 && threat.dangerEta <= 1.45))
        .sort((a, b) => (a.direct?.eta ?? a.dangerEta) - (b.direct?.eta ?? b.dangerEta)
          || a.baseDistance - b.baseDistance);
      const finalEnemy = threats.length === 1 ? threats[0] : null;
      const sharedTerminal = terminalThreats.length === 1 ? terminalThreats[0] : null;
      if (finalEnemy || sharedTerminal) {
        // With only one enemy alive there is no assignment conflict to avoid:
        // both allies keep chasing it until the kill is confirmed.
        const shared = finalEnemy || sharedTerminal;
        for (const ally of allies) desired.set(ally, shared);
      } else if (allies.length === 1) {
        for (const ally of allies) {
          desired.set(ally, sideEligibleThreats(ctx, ally, threats).slice().sort((a, b) =>
            globalAssignmentCost(ctx, ally, a) - globalAssignmentCost(ctx, ally, b))[0]);
        }
      } else {
        const firstOptions = [null, ...sideEligibleThreats(ctx, allies[0], threats)];
        const secondOptions = [null, ...sideEligibleThreats(ctx, allies[1], threats)];
        let best = null;
        for (const first of firstOptions) {
          for (const second of secondOptions) {
            if (first && first === second) continue;
            const assignedCount = Number(Boolean(first)) + Number(Boolean(second));
            const cost = (first ? globalAssignmentCost(ctx, allies[0], first) : 0)
              + (second ? globalAssignmentCost(ctx, allies[1], second) : 0);
            if (!best || assignedCount > best.assignedCount
              || (assignedCount === best.assignedCount && cost < best.cost)) {
              best = { first, second, assignedCount, cost };
            }
          }
        }
        if (best) {
          desired.set(allies[0], best.first);
          desired.set(allies[1], best.second);
        }
      }
    }

    // The collector temporarily leaves combat; its partner keeps its own-side
    // assignment instead of being redirected across the map to a global target.

    const committedOwners = new Map();
    for (const ally of allies) {
      const prior = previous.get(ally);
      const priorThreat = prior?.target?.alive
        ? threats.find((threat) => threat.enemy === prior.target)
        : null;
      if (!prior?.hardCommit || !priorThreat) continue;
      const ownSideExists = threats.some((threat) => onAssignedSide(ctx, ally, threat.enemy));
      if (ownSideExists && !onAssignedSide(ctx, ally, priorThreat.enemy)
        && priorThreat.defenseTier > 2) continue;
      const existing = committedOwners.get(priorThreat.enemy);
      if (!existing || globalAssignmentCost(ctx, ally, priorThreat)
        < globalAssignmentCost(ctx, existing, priorThreat)) {
        committedOwners.set(priorThreat.enemy, ally);
      }
    }
    for (const [enemy, owner] of committedOwners) {
      const threat = threats.find((item) => item.enemy === enemy);
      if (!threat) continue;
      const terminalShared = threat.direct?.target === "base" && threat.direct.eta <= 1.1;
      const finalEnemyShared = threats.length === 1;
      desired.set(owner, threat);
      if (terminalShared || finalEnemyShared) continue;
      for (const ally of allies) {
        if (ally === owner || desired.get(ally)?.enemy !== enemy) continue;
        const committedEnemies = new Set(committedOwners.keys());
        const alternative = sideEligibleThreats(ctx, ally, threats)
          .filter((candidate) => !committedEnemies.has(candidate.enemy))
          .sort((a, b) => globalAssignmentCost(ctx, ally, a) - globalAssignmentCost(ctx, ally, b))[0] || null;
        desired.set(ally, alternative);
      }
    }

    // A pair can only actively chase two enemies, so audit the opening coverage
    // independently from side ownership and target commitment. The two enemies
    // with the shortest credible route to a base shot must be covered before a
    // shallow target or a distant pickup is allowed to consume an ally.
    const coverageRank = (threat) => {
      const directEta = threat.direct?.target === "base" ? threat.direct.eta : Infinity;
      const eta = Math.min(directEta, threat.dangerEta);
      return (threat.direct?.target === "base" ? -100000 : 0)
        + (threat.crossed ? -50000 : 0)
        + (threat.deepPressure ? -18000 : 0)
        + (threat.fast ? -9000 : 0)
        + (threat.vertical ? -7000 : 0)
        + (Number.isFinite(eta) ? eta * 1000 : 60000)
        + threat.baseDistance;
    };
    const criticalCoverage = threats.filter((threat) =>
      threat.direct?.target === "base"
        || threat.crossed
        || threat.dangerEta <= 5.8
        || ((threat.fast || threat.vertical || threat.deepPressure) && threat.dangerEta <= 7.2))
      .sort((a, b) => coverageRank(a) - coverageRank(b))
      .slice(0, allies.length);
    const protectedCoverage = new Set();
    const coverageEmergencyEnemies = new Set();
    for (const threat of criticalCoverage) {
      const sharedCoverage = threats.length === 1
        || (threat.direct?.target === "base" && threat.direct.eta <= 1.1
          && allies.every((ally) => desired.get(ally)?.enemy === threat.enemy));
      if (sharedCoverage) {
        for (const ally of allies) protectedCoverage.add(ally);
        continue;
      }
      const currentOwner = allies.find((ally) => desired.get(ally)?.enemy === threat.enemy);
      const owner = allies.filter((ally) => !protectedCoverage.has(ally))
        .sort((a, b) => globalAssignmentCost(ctx, a, threat) - globalAssignmentCost(ctx, b, threat))[0];
      if (!owner) continue;
      if (owner !== currentOwner) {
        const displaced = desired.get(owner) || null;
        desired.set(owner, threat);
        if (currentOwner && !protectedCoverage.has(currentOwner)) {
          desired.set(currentOwner, displaced?.enemy === threat.enemy ? null : displaced);
        }
      }
      if (previous.get(owner)?.target !== threat.enemy) coverageEmergencyEnemies.add(threat.enemy);
      protectedCoverage.add(owner);
    }
    // Three tiles remains an unconditional pickup. Beyond that range, the only
    // tank covering one of the fastest base approaches may not leave its lane.
    if (pickupDuty?.routeLength > 3) {
      const collectorThreat = desired.get(pickupDuty.collector);
      if (collectorThreat && criticalCoverage.includes(collectorThreat)) pickupDuty = null;
    }

    const assignments = new Map();
    const priorOwners = new Map();
    for (const ally of allies) {
      const priorTarget = previous.get(ally)?.target;
      if (!priorTarget?.alive) continue;
      if (!priorOwners.has(priorTarget)) priorOwners.set(priorTarget, []);
      priorOwners.get(priorTarget).push(ally);
    }
    const duplicateKeepers = new Map();
    if (threats.length > 1) {
      for (const [priorTarget, owners] of priorOwners) {
        if (owners.length < 2) continue;
        const priorThreat = threats.find((threat) => threat.enemy === priorTarget);
        if (!priorThreat) continue;
        const terminalShared = priorThreat?.direct?.target === "base" && priorThreat.direct.eta <= 1.1;
        if (terminalShared) continue;
        const desiredKeeper = owners.find((ally) => desired.get(ally)?.enemy === priorTarget);
        const keeper = desiredKeeper || owners.slice().sort((a, b) =>
          globalAssignmentCost(ctx, a, priorThreat) - globalAssignmentCost(ctx, b, priorThreat))[0];
        duplicateKeepers.set(priorTarget, keeper);
      }
    }
    for (const ally of allies) {
      let selected = desired.get(ally) || null;
      const prior = previous.get(ally);
      const pickupCover = Boolean(pickupDuty && ally !== pickupDuty.collector);
      const duplicateKeeper = prior?.target ? duplicateKeepers.get(prior.target) : null;
      const reassignedOwner = prior?.target
        ? allies.find((candidate) => desired.get(candidate)?.enemy === prior.target)
        : null;
      const releaseDuplicate = Boolean(
        (duplicateKeeper && duplicateKeeper !== ally)
        || (reassignedOwner && reassignedOwner !== ally),
      );
      const ownSideExists = threats.some((threat) => onAssignedSide(ctx, ally, threat.enemy));
      const priorOffSide = Boolean(prior?.target?.alive && ownSideExists
        && !onAssignedSide(ctx, ally, prior.target));
      const hardCommitted = Boolean(prior?.hardCommit && prior.target?.alive
        && !releaseDuplicate && !priorOffSide);
      if (hardCommitted) {
        // Once this ally owns a living enemy, scoring changes must not make it
        // abandon the chase. Movement may still pause for shell evasion or a
        // freeze pickup, but target ownership lasts until the enemy is destroyed.
        const committedThreat = threats.find((threat) => threat.enemy === prior.target);
        const emergencyOverride = selected?.enemy !== prior.target && Boolean(
          (selected?.defenseTier <= 2
            && (!committedThreat
              || selected.defenseTier < committedThreat.defenseTier
              || selected.responseDeadline + 0.5 < committedThreat.responseDeadline))
          ||
          (coverageEmergencyEnemies.has(selected?.enemy)
            && (!committedThreat
              || coverageRank(selected) + 350 < coverageRank(committedThreat)
              || defenderResponseEta(ctx, ally, selected) + 0.35
                < defenderResponseEta(ctx, ally, committedThreat)))
          ||
          (selected?.direct?.target === "base" && selected.direct.eta <= 2.2
            && (!committedThreat?.direct || selected.direct.eta + 0.25 < committedThreat.direct.eta))
          || (selected?.crossed && !committedThreat?.crossed
            && selected.dangerEta + 0.75 < (committedThreat?.dangerEta ?? Infinity))
          || (selected && committedThreat && selected.dangerEta + 1.5 < committedThreat.dangerEta)
        );
        if (committedThreat && !emergencyOverride) selected = committedThreat;
      } else if (!releaseDuplicate && !pickupCover && !priorOffSide
        && prior?.target?.alive && selected?.enemy !== prior.target && now < prior.commitUntil) {
        const priorThreat = threats.find((threat) => threat.enemy === prior.target);
        const emergencyUpgrade = selected && priorThreat && (
          (selected.direct && !priorThreat.direct)
          || (selected.crossed && !priorThreat.crossed)
          || globalAssignmentCost(ctx, ally, selected) + 9000 < globalAssignmentCost(ctx, ally, priorThreat)
        );
        if (!emergencyUpgrade && priorThreat) selected = priorThreat;
      }
      if ((ctx.freezeTime || 0) > 0) {
        const nearbyFrozenThreat = threats
          .filter((threat) => manhattan(ally, threat.enemy) <= TILE * 3.5)
          .sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
            || Number(b.crossed) - Number(a.crossed)
            || manhattan(ally, a.enemy) - manhattan(ally, b.enemy))[0] || null;
        const terminalElsewhere = selected?.enemy !== nearbyFrozenThreat?.enemy
          && selected?.direct?.target === "base"
          && selected.direct.eta <= 1.1;
        if (nearbyFrozenThreat && !terminalElsewhere) selected = nearbyFrozenThreat;
      }
      const target = selected?.enemy || null;
      const unchanged = prior?.target === target;
      // Target ownership is a life-cycle commitment. Re-scoring may update the
      // intercept route, but it must not swap a living enemy between decisions;
      // otherwise close combat repeatedly resets aim, movement and shot timing.
      const hardCommit = Boolean(target);
      const commitUntil = unchanged
        ? Math.max(prior.commitUntil, now + 0.45)
        : now + (selected?.direct || selected?.crossed ? 1.15 : 1.65);
      const intercept = target && selected
        ? reliableDefensePlan(planningContextForAlly(ctx, ally), ally, selected)
        : null;
      assignments.set(ally, {
        target,
        threat: selected,
        intercept,
        role: ally.kind === "player" ? "LEFT" : ally.kind === "player2" ? "RIGHT" : "SUPPORT",
        emergency: Boolean(selected?.direct || selected?.crossed || selected?.dangerEta <= 3.2),
        commitUntil,
        hardCommit,
        pickup: ally === pickupDuty?.collector ? pickupDuty.bonus : null,
        pickupCollector: pickupDuty?.collector || null,
        pickupReserved: pickupDuty?.bonus || null,
      });
    }
    state = {
      mapVersion,
      stage,
      analyzedAt: now,
      nextAnalysis: now + (threats.some((threat) => threat.direct || threat.crossed) ? 0.12 : 0.28),
      threats,
      assignments,
      pickupDuty,
    };
    globalBattleStates.set(key, state);
    return state;
  }

  function closeCombatGoals(ctx, tank, target) {
    const t = cellOf(tank);
    const e = cellOf(target);
    const goals = [];
    for (let offset = -2; offset <= 2; offset++) {
      const row = { x: e.x + offset, y: e.y };
      const column = { x: e.x, y: e.y + offset };
      if ((row.x !== e.x || row.y !== e.y) && tileCost(ctx, row.x, row.y) === 1) goals.push(row);
      if ((column.x !== e.x || column.y !== e.y) && tileCost(ctx, column.x, column.y) === 1) goals.push(column);
    }
    return goals.sort((a, b) => (Math.abs(a.x - t.x) + Math.abs(a.y - t.y)) - (Math.abs(b.x - t.x) + Math.abs(b.y - t.y)));
  }

  function routeDirection(path) {
    if (path.length < 2) return null;
    const a = path[0];
    const b = path[1];
    if (b.x > a.x) return "right";
    if (b.x < a.x) return "left";
    if (b.y > a.y) return "down";
    return "up";
  }

  function routeStep(ctx, tank, path, alignmentTolerance = 1.5, target = null, preventRetreat = false) {
    const dir = routeDirection(path);
    if (!dir || path.length < 2) return { dir: null, routeDir: null, aligning: false };
    const tankCenter = center(tank);
    const lane = path[0];
    const laneX = lane.x * TILE + TILE / 2;
    const laneY = lane.y * TILE + TILE / 2;
    const horizontal = dir === "left" || dir === "right";
    const offset = horizontal ? tankCenter.y - laneY : tankCenter.x - laneX;
    const lateralSize = horizontal ? Number(tank.h || 28) : Number(tank.w || 28);
    const physicalTolerance = Math.max(0.5, (TILE - lateralSize) / 2 - 0.5);
    const safeTolerance = Math.min(alignmentTolerance, physicalTolerance);
    if (Math.abs(offset) > safeTolerance) {
      const correction = horizontal
        ? (offset < 0 ? "down" : "up")
        : (offset < 0 ? "right" : "left");
      if (preventRetreat && target?.alive && ctx.canMove?.(dir)) {
        const currentDistance = manhattan(tank, target);
        const correctionDistance = projectedTargetDistance(tank, target, correction);
        const routeDistance = projectedTargetDistance(tank, target, dir);
        if (correctionDistance > currentDistance + 0.5 && routeDistance + 1 < correctionDistance) {
          return { dir, routeDir: dir, aligning: false };
        }
      }
      // Moving toward the center of the current passable cell reduces overlap
      // with one wall at a time. The game collision step remains authoritative;
      // a long canMove probe would incorrectly reject these small corrections.
      return { dir: correction, routeDir: dir, aligning: true };
    }
    return { dir, routeDir: dir, aligning: false };
  }

  function recoveryDirection(ctx, tank, target, preferredGoals = []) {
    const t = center(tank);
    const e = center(target);
    const horizontal = e.x < t.x ? "left" : "right";
    const vertical = e.y < t.y ? "up" : "down";
    const preferred = Math.abs(e.x - t.x) >= Math.abs(e.y - t.y)
      ? [horizontal, vertical]
      : [vertical, horizontal];
    const candidates = [...preferred, ...DIR_NAMES.filter((dir) => !preferred.includes(dir) && dir !== opposite(tank.dir))];
    const urgent = isBaseEmergency(ctx, target);
    const currentDistance = manhattan(tank, target);
    const step = Math.max(8, Math.min(TILE * 0.55, (tank.speed || tank.baseSpeed || 90) * 0.14));
    const ranked = candidates.filter((dir) => ctx.canMove?.(dir)).map((dir) => {
      const d = DIRS[dir];
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      const targetDistance = manhattan(next, target);
      const goalDistance = preferredGoals.length
        ? Math.min(...preferredGoals.map((goal) => Math.abs(center(next).x - (goal.x * TILE + TILE / 2)) + Math.abs(center(next).y - (goal.y * TILE + TILE / 2))))
        : targetDistance;
      return {
        dir,
        targetDistance,
        score: goalDistance + targetDistance * 0.35 + projectileRisk(ctx, next) * 3 + (dir === tank.dir ? 0 : TILE * 0.3),
      };
    });
    const safe = urgent
      ? ranked.filter((item) => item.targetDistance <= currentDistance + TILE * 0.35)
      : ranked;
    return safe.sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function shotLaneRepositionPlan(ctx, tank, target) {
    if (!target?.alive) return null;
    const goals = [...attackGoals(ctx, target), ...pursuitGoals(ctx, target)];
    const path = findPath(ctx, cellOf(tank), goals);
    const step = routeStep(ctx, tank, path, 1.5, target, false);
    const dir = step.dir || recoveryDirection(ctx, tank, target, goals);
    return dir ? { dir, path } : null;
  }

  function publishRoute(ctx, tank, path) {
    const first = center(tank);
    ctx.plannedRoute = [first, ...path.slice(1).map((cell) => ({ x: cell.x * TILE + TILE / 2, y: cell.y * TILE + TILE / 2 }))];
  }

  function steelBlocksShot(ctx, tank, target, dir) {
    const d = DIRS[dir];
    if (!d || !tank || !target) return true;
    const from = center(tank);
    const to = center(target);
    const distance = Math.abs((to.x - from.x) * d.x + (to.y - from.y) * d.y);
    const lateral = { x: -d.y, y: d.x };
    for (let travel = 14; travel < distance - 12; travel += 4) {
      for (const offset of [-8, 0, 8]) {
        const x = from.x + d.x * travel + lateral.x * offset;
        const y = from.y + d.y * travel + lateral.y * offset;
        if ((ctx.tileAt?.(Math.floor(x / TILE), Math.floor(y / TILE))
          ?? ctx.map?.[Math.floor(y / TILE)]?.[Math.floor(x / TILE)]) === "S") return true;
      }
    }
    return false;
  }

  function firstShotObstacle(ctx, tank, dir, target = null) {
    const d = DIRS[dir];
    if (!d || !tank) return null;
    const tankCenter = center(tank);
    const bulletSize = 6;
    const spawnOffset = 16;
    const startX = tankCenter.x - bulletSize / 2 + d.x * spawnOffset;
    const startY = tankCenter.y - bulletSize / 2 + d.y * spawnOffset;
    const targetBox = target?.box ? target.box() : target;
    const targetCenter = targetBox ? center(targetBox) : null;
    const axialDistance = targetCenter
      ? Math.abs((targetCenter.x - tankCenter.x) * d.x + (targetCenter.y - tankCenter.y) * d.y)
      : Math.max(Number(ctx.cols || 26), Number(ctx.rows || 26)) * TILE;
    const targetHalf = targetBox
      ? (dir === "up" || dir === "down" ? targetBox.h : targetBox.w) / 2
      : 0;
    const maxTravel = Math.max(0, axialDistance - spawnOffset - targetHalf);
    const visited = new Set();
    for (let travel = 0; travel <= maxTravel; travel += 2) {
      const x = startX + d.x * travel;
      const y = startY + d.y * travel;
      const x1 = Math.floor(x / TILE);
      const y1 = Math.floor(y / TILE);
      const x2 = Math.floor((x + bulletSize - 0.01) / TILE);
      const y2 = Math.floor((y + bulletSize - 0.01) / TILE);
      for (let ty = y1; ty <= y2; ty++) {
        for (let tx = x1; tx <= x2; tx++) {
          const key = keyOf(tx, ty);
          if (visited.has(key)) continue;
          visited.add(key);
          const tile = ctx.tileAt?.(tx, ty) ?? ctx.map?.[ty]?.[tx];
          if (tile === "S" || tile === "B" || tile === "E") {
            return { tile, x: tx, y: ty, baseGuard: isGuardCell(ctx, tx, ty) };
          }
        }
      }
    }
    return null;
  }

  function blockedShotRecovery(ctx, tank, target, shotDir, obstacle) {
    const verticalShot = shotDir === "up" || shotDir === "down";
    const tankCenter = center(tank);
    const obstacleCenter = { x: obstacle.x * TILE + TILE / 2, y: obstacle.y * TILE + TILE / 2 };
    const away = verticalShot
      ? (obstacleCenter.x <= tankCenter.x ? "right" : "left")
      : (obstacleCenter.y <= tankCenter.y ? "down" : "up");
    const lateral = verticalShot ? [away, opposite(away)] : [away, opposite(away)];
    const candidates = [...lateral, opposite(shotDir)].filter((dir, index, items) =>
      dir && items.indexOf(dir) === index && ctx.canMove?.(dir));
    const step = Math.max(8, Math.min(14, (Number(tank.speed) || 90) * 0.1));
    return candidates.map((dir) => {
      const delta = DIRS[dir];
      const next = { ...tank, x: tank.x + delta.x * step, y: tank.y + delta.y * step };
      const nextCenter = center(next);
      const clearance = verticalShot
        ? Math.abs(nextCenter.x - obstacleCenter.x)
        : Math.abs(nextCenter.y - obstacleCenter.y);
      return {
        dir,
        score: (target ? manhattan(next, target) * 0.2 : 0)
          - clearance * 2
          + (dir === away ? -20 : 0)
          + (dir === tank.dir ? 0 : 4),
      };
    }).sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function directShot(ctx, tank, target) {
    for (const dir of DIR_NAMES) {
      if (steelBlocksShot(ctx, tank, target, dir)) continue;
      const aimReady = tank.dir === dir && (Number(tank.turnCooldown) || 0) <= 0;
      // Once the barrel is settled, trust the game's current bullet collision
      // result. Predictive aiming can reject a valid edge hit as the target moves.
      if (aimReady
        ? (ctx.canDirectShoot?.(dir, target) || ctx.canShoot?.(dir, target))
        : timedPredictiveLane(ctx, tank, target, dir)) return dir;
    }
    return null;
  }

  function predictiveShot(ctx, tank, target) {
    for (const dir of DIR_NAMES) {
      if (timedPredictiveLane(ctx, tank, target, dir)) return dir;
    }
    return null;
  }

  function timedPredictiveLane(ctx, tank, target, dir) {
    const shotDir = DIRS[dir];
    if (!shotDir || !target?.alive || !ctx.canPredictShoot?.(dir, target)
      || steelBlocksShot(ctx, tank, target, dir)) return false;
    const shooter = center(tank);
    const targetNow = center(target);
    const targetDir = DIRS[target.dir] || { x: 0, y: 0 };
    const targetSpeed = Math.max(0, Number(target.speed || target.baseSpeed) || 0);
    const turnDelay = tank.dir === dir
      ? Math.max(0, Number(tank.turnCooldown) || 0)
      : Math.max(turnTime(tank.dir, dir), Number(tank.turnCooldown) || 0);
    const axialNow = (targetNow.x - shooter.x) * shotDir.x + (targetNow.y - shooter.y) * shotDir.y;
    const axialVelocity = (targetDir.x * shotDir.x + targetDir.y * shotDir.y) * targetSpeed;
    const closingSpeed = 310 - axialVelocity;
    if (axialNow <= 0 || closingSpeed <= 1) return false;

    // The bullet starts after the turret finishes turning. Solve the intercept
    // against the moving target instead of truncating prediction at 0.78 s.
    const interceptTime = (axialNow + 310 * turnDelay) / closingSpeed;
    if (!Number.isFinite(interceptTime) || interceptTime < turnDelay || interceptTime > 2.4) return false;
    const projectedX = targetNow.x + targetDir.x * targetSpeed * interceptTime;
    const projectedY = targetNow.y + targetDir.y * targetSpeed * interceptTime;
    const lateral = dir === "up" || dir === "down"
      ? Math.abs(projectedX - shooter.x)
      : Math.abs(projectedY - shooter.y);
    const targetSize = dir === "up" || dir === "down" ? Number(target.w) || 28 : Number(target.h) || 28;
    const sameDirectionPursuit = target.dir === dir;
    const tolerance = sameDirectionPursuit
      ? Math.max(12, targetSize / 2 + 2)
      : Math.max(7, targetSize / 2 - (targetSpeed > 100 ? 5 : 3));
    return lateral <= tolerance;
  }

  function currentPositionShot(ctx, tank, target) {
    for (const dir of DIR_NAMES) {
      if (ctx.canDirectShoot?.(dir, target) && !steelBlocksShot(ctx, tank, target, dir)) return dir;
    }
    return null;
  }

  function canHitFromDirection(ctx, tank, target, dir) {
    if (!dir || !target?.alive || steelBlocksShot(ctx, tank, target, dir)) return false;
    if ((ctx.freezeTime || 0) > 0) return preciseFrozenShot(ctx, tank, target) === dir;
    const targetSpeed = Math.max(0, Number(target.speed || target.baseSpeed) || 0);
    const directNow = currentPositionShot(ctx, tank, target) === dir;
    const contactRange = manhattan(tank, target) <= TILE * 2.2;
    return (directNow && (contactRange || targetSpeed <= 0))
      || timedPredictiveLane(ctx, tank, target, dir);
  }

  function mobileFireAllowed(ctx, tank, target, dir) {
    const d = DIRS[dir];
    if (!d || !tank?.alive || !target?.alive || !ctx.canMove?.(dir)) return false;
    const t = center(tank);
    const e = center(target);
    const axial = (e.x - t.x) * d.x + (e.y - t.y) * d.y;
    const lateral = dir === "up" || dir === "down" ? Math.abs(e.x - t.x) : Math.abs(e.y - t.y);
    const exactContactLane = manhattan(tank, target) <= TILE * 2.2
      && tank.dir === dir
      && Boolean(ctx.canDirectShoot?.(dir, target));
    const minimumDistance = exactContactLane
      ? TILE * 0.55
      : (ctx.freezeTime || 0) > 0
        ? TILE * 3.25
        : isBaseIntruder(ctx, target) ? TILE * 1.9 : TILE * 2.4;
    if (axial <= minimumDistance || lateral > TILE * 0.72) return false;
    if (movementBulletThreat(ctx, tank, dir, 0.9)) return false;
    const step = Math.max(8, Math.min(16, (Number(tank.speed) || 90) * 0.14));
    const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
    if (projectileRisk(ctx, next) > TILE * 8) return false;
    const nextCenter = center(next);
    const allyTooClose = (ctx.friends || []).some((ally) => ally?.alive
      && Math.abs(center(ally).x - nextCenter.x) < TILE * 0.9
      && Math.abs(center(ally).y - nextCenter.y) < TILE * 0.9);
    return !allyTooClose;
  }

  function preciseFrozenShot(ctx, tank, target) {
    // Frozen targets do not need an extra center-line tolerance after the real
    // collision probe has already confirmed that the current shot will hit.
    return currentPositionShot(ctx, tank, target);
  }

  function frozenCloseAlignmentDirection(ctx, tank, target) {
    if ((ctx.freezeTime || 0) <= 0 || !target?.alive) return null;
    const tankCenter = center(tank);
    const targetCenter = center(target);
    const currentAlignment = Math.min(
      Math.abs(tankCenter.x - targetCenter.x),
      Math.abs(tankCenter.y - targetCenter.y),
    );
    const step = Math.max(7, Math.min(11, (Number(tank.speed) || 90) * 0.09));
    return DIR_NAMES.filter((dir) => ctx.canMove?.(dir)).map((dir) => {
      const d = DIRS[dir];
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      const nextCenter = center(next);
      const alignment = Math.min(
        Math.abs(nextCenter.x - targetCenter.x),
        Math.abs(nextCenter.y - targetCenter.y),
      );
      const distance = manhattan(next, target);
      return {
        dir,
        alignment,
        score: alignment * 5 + distance * 0.08 + projectileRisk(ctx, next) * 2
          + (dir === tank.dir ? 0 : 2),
      };
    }).filter((item) => item.alignment + 0.5 < currentAlignment)
      .sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function freezeCoverPlan(ctx, tank, preferredTarget) {
    const remaining = Math.max(0, Number(ctx.freezeTime) || 0);
    if (remaining <= 0 || remaining > 2.4) return null;
    return visibleEnemies(ctx).map((enemy) => {
      const distance = manhattan(tank, enemy);
      const dir = distance >= TILE * 4 ? preciseFrozenShot(ctx, tank, enemy) : null;
      const travelTime = distance / 310;
      const coverWindow = Math.min(2.4, travelTime + 0.55);
      const priority = targetPriority(ctx, tank, enemy);
      return { enemy, dir, distance, coverWindow, priority };
    }).filter((item) => item.dir && remaining <= item.coverWindow)
      .sort((a, b) =>
        Number(b.enemy === preferredTarget) - Number(a.enemy === preferredTarget)
        || a.priority.tier - b.priority.tier
        || a.priority.baseEta - b.priority.baseEta
        || b.distance - a.distance)[0] || null;
  }

  function movementDirectionDuringTurn(tank, desiredDir) {
    if (!DIRS[desiredDir]) return null;
    if (tank.dir === desiredDir || (Number(tank.turnCooldown) || 0) > 0) return tank.dir;
    if (opposite(tank.dir) !== desiredDir) return desiredDir;
    if ((tank.dir === "up" || tank.dir === "down") && (desiredDir === "up" || desiredDir === "down")) return "left";
    if ((tank.dir === "left" || tank.dir === "right") && (desiredDir === "left" || desiredDir === "right")) return "up";
    return desiredDir;
  }

  function movingAimAction(ctx, tank, dir, aimMode, target) {
    const movementDir = movementDirectionDuringTurn(tank, dir);
    const keepMoving = Boolean(movementDir && ctx.canMove?.(movementDir)
      && !movementBulletThreat(ctx, tank, movementDir, 0.65));
    // A held non-fire action does not call the game's facing logic. Requesting a
    // safe shot turns first; moveTank already preserves the current track direction
    // during that turn, so applying another 18% scale here incorrectly slows allies.
    return { dir, moveDir: movementDir, moveScale: 1, fire: !keepMoving, hold: !keepMoving, mode: aimMode, target };
  }

  function aimedFireAction(ctx, tank, dir, fireMode, target, mobile = false) {
    if (tank.dir !== dir || (tank.turnCooldown || 0) > 0) {
      const aimMode = /pointblank/.test(fireMode)
        ? fireMode.replace(/-fire$/, "-aim")
        : "core-aim-turn";
      return movingAimAction(ctx, tank, dir, aimMode, target);
    }
    if (!ctx.canFire?.()) {
      const reloadAdvance = mobileFireAllowed(ctx, tank, target, dir);
      return {
        dir,
        fire: false,
        hold: !reloadAdvance,
        mode: reloadAdvance ? "core-contact-reload-move" : "core-aim-reload",
        target,
      };
    }
    const movingFire = mobileFireAllowed(ctx, tank, target, dir);
    const moveWhileFiring = (mobile || movingFire) && movingFire;
    return { dir, fire: true, hold: !moveWhileFiring, mode: fireMode, target };
  }

  function sameDirectionPursuitAction(ctx, tank, target) {
    const dir = tank?.dir;
    const movement = DIRS[dir];
    if (!movement || !target?.alive || target.dir !== dir || !ctx.canMove?.(dir)) return null;
    const tankCenter = center(tank);
    const targetCenter = center(target);
    const axial = (targetCenter.x - tankCenter.x) * movement.x
      + (targetCenter.y - tankCenter.y) * movement.y;
    const lateral = dir === "up" || dir === "down"
      ? Math.abs(targetCenter.x - tankCenter.x)
      : Math.abs(targetCenter.y - tankCenter.y);
    const laneSize = dir === "up" || dir === "down"
      ? Number(target.w) || 28
      : Number(target.h) || 28;
    if (axial <= TILE * 1.8 || lateral > Math.max(20, laneSize / 2 + 7)) return null;
    if (movementBulletThreat(ctx, tank, dir, 0.9)) return null;
    const shot = currentPositionShot(ctx, tank, target) === dir
      || directShot(ctx, tank, target) === dir
      || predictiveShot(ctx, tank, target) === dir;
    return {
      dir,
      moveScale: 1,
      fire: Boolean(shot && ctx.canFire?.()),
      hold: false,
      mode: shot && ctx.canFire?.() ? "core-same-direction-chase-fire" : "core-same-direction-chase",
      target,
    };
  }

  function exactFrozenFireAction(ctx, tank, dir, fireMode, target, mobile = false) {
    const exactDir = preciseFrozenShot(ctx, tank, target);
    if (exactDir === dir) return aimedFireAction(ctx, tank, dir, fireMode, target, mobile);
    if (exactDir) return movingAimAction(ctx, tank, exactDir, "core-freeze-exact-aim", target);
    const reposition = frozenCloseAlignmentDirection(ctx, tank, target)
      || freezeRecoveryDirection(ctx, tank, target, verticalDefenseGoals(ctx, tank, target));
    return reposition
      ? { dir: reposition, fire: false, hold: false, mode: "core-freeze-exact-reposition", target }
      : { dir: tank.dir, fire: false, hold: true, mode: "core-freeze-exact-hold", target };
  }

  function activeFreezeReloadAction(ctx, tank, dir, target, reloadMode) {
    const action = aimedFireAction(ctx, tank, dir, reloadMode, target, true);
    if (!action.hold) return { ...action, mode: reloadMode };
    if (tank.dir !== dir || (Number(tank.turnCooldown) || 0) > 0) return action;
    const reposition = freezeRecoveryDirection(ctx, tank, target, [
      ...closeCombatGoals(ctx, tank, target),
      ...pursuitGoals(ctx, target),
    ]);
    return reposition
      ? { dir: reposition, fire: false, hold: false, mode: "core-freeze-reload-reposition", target }
      : { ...action, mode: reloadMode };
  }

  function freezeShotGoals(ctx, target) {
    const c = cellOf(target);
    const goals = [];
    for (const dir of DIR_NAMES) {
      const d = DIRS[dir];
      const brickKeys = [];
      for (let distance = 1; distance <= 18; distance++) {
        const x = c.x + d.x * distance;
        const y = c.y + d.y * distance;
        if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) break;
        const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
        if (tile === "S" || tile === "E" || (tile === "B" && isGuardCell(ctx, x, y))) break;
        if (tile === "W") continue;
        if (tile === "B") brickKeys.push(keyOf(x, y));
        if (!Number.isFinite(tileCost(ctx, x, y))) break;
        const firingTank = { x: x * TILE + 2, y: y * TILE + 2, w: 28, h: 28 };
        const shotDir = opposite(dir);
        if (steelBlocksShot(ctx, firingTank, target, shotDir)) continue;
        goals.push({
          x,
          y,
          shotDir,
          shotDistance: distance * TILE,
          brickKeys: [...brickKeys],
        });
      }
    }
    return goals;
  }

  function turnTime(from, to) {
    if (!from || !to || from === to) return 0;
    return opposite(from) === to ? 0.6 : 0.3;
  }

  function freezeAttackPlan(ctx, tank, blockedTargets = new Set(), failedTarget = null, failedCell = null, preferredTarget = null, missedCells = new Map(), now = 0) {
    const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
    const enemies = visibleEnemies(ctx);
    const plans = enemies.map((enemy) => {
      const tankCell = cellOf(tank);
      const missedForEnemy = missedCells.get(enemy);
      const missedHere = (missedForEnemy?.get(keyOf(tankCell.x, tankCell.y)) || 0) > now;
      const failedHere = missedHere || (enemy === failedTarget && failedCell?.x === tankCell.x && failedCell?.y === tankCell.y);
      const shot = failedHere ? null : preciseFrozenShot(ctx, tank, enemy);
      const durability = Math.max(1, Number(enemy.hp || enemy.life) || 1);
      const priority = targetPriority(ctx, tank, enemy);
      if (shot) {
        const finishTime = manhattan(tank, enemy) / 310 + Math.max(0, durability - 1) * 0.42;
        return { enemy, shot, path: [tankCell], finishTime, priority, fitsFreeze: finishTime <= Number(ctx.freezeTime || 0), preferred: enemy === preferredTarget };
      }
      const candidates = freezeShotGoals(ctx, enemy).filter((goal) =>
        (goal.x !== tankCell.x || goal.y !== tankCell.y)
        && ((missedForEnemy?.get(keyOf(goal.x, goal.y)) || 0) <= now)
        && (enemy !== failedTarget || goal.x !== failedCell?.x || goal.y !== failedCell?.y))
        .sort((a, b) => {
          const standOffA = a.shotDistance < TILE * 2 ? 7 : a.shotDistance > TILE * 7 ? 1.2 : 0;
          const standOffB = b.shotDistance < TILE * 2 ? 7 : b.shotDistance > TILE * 7 ? 1.2 : 0;
          const optimisticA = Math.abs(a.x - tankCell.x) + Math.abs(a.y - tankCell.y) + a.brickKeys.length * 2.2 + a.shotDistance / TILE * 0.18 + standOffA;
          const optimisticB = Math.abs(b.x - tankCell.x) + Math.abs(b.y - tankCell.y) + b.brickKeys.length * 2.2 + b.shotDistance / TILE * 0.18 + standOffB;
          return optimisticA - optimisticB;
        }).slice(0, 6).map((goal) => {
          const path = findPath(ctx, tankCell, [goal]);
          if (!path.length) return null;
          const routeBricks = path.filter((cell) => (ctx.tileAt?.(cell.x, cell.y) ?? ctx.map?.[cell.y]?.[cell.x]) === "B")
            .map((cell) => keyOf(cell.x, cell.y));
          const bricks = new Set([...goal.brickKeys, ...routeBricks]).size;
          const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) : tank.dir;
          const finishTime = pathTravelTime(path, tank.speed, tank.dir)
            + bricks * 0.62
            + turnTime(arrivalDir, goal.shotDir)
            + goal.shotDistance / 310
            + Math.max(0, durability - 1) * 0.42;
          const collisionPenalty = goal.shotDistance < TILE * 2 ? 1.15 : 0;
          return { goal, path, finishTime, collisionPenalty };
        }).filter(Boolean).sort((a, b) =>
          (a.finishTime + a.collisionPenalty) - (b.finishTime + b.collisionPenalty));
      const best = candidates[0];
      return {
        enemy,
        shot: null,
        path: best?.path || [],
        goal: best?.goal || null,
        finishTime: best?.finishTime ?? Infinity,
        priority,
        fitsFreeze: Boolean(best && best.finishTime <= Number(ctx.freezeTime || 0)),
        preferred: enemy === preferredTarget,
      };
    }).filter((plan) => Number.isFinite(plan.finishTime)).sort((a, b) =>
      a.priority.tier - b.priority.tier
      || Number(b.fitsFreeze) - Number(a.fitsFreeze)
      || (Math.abs(a.finishTime - b.finishTime) <= 0.75 ? Number(b.preferred) - Number(a.preferred) : 0)
      || a.finishTime - b.finishTime);
    const preferredPlan = plans.find((plan) => plan.enemy === preferredTarget);
    if (preferredPlan && !blockedTargets.has(preferredPlan.enemy)
      && (!reserved.has(preferredPlan.enemy) || isBaseEmergency(ctx, preferredPlan.enemy))) return preferredPlan;
    const splitPlans = plans.filter((plan) => !reserved.has(plan.enemy));
    const pool = splitPlans.length ? splitPlans : plans;
    const available = pool.filter((plan) => !blockedTargets.has(plan.enemy));
    return available[0] || pool[0] || null;
  }

  function freezePursuitPlan(ctx, tank, preferredTarget) {
    const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
    const enemies = visibleEnemies(ctx);
    const plans = enemies.map((enemy) => {
      const tankCell = cellOf(tank);
      const stagingGoals = freezeShotGoals(ctx, enemy)
        .filter((goal) => goal.shotDistance >= TILE * 2 && goal.shotDistance <= TILE * 6)
        .filter((goal) => goal.x !== tankCell.x || goal.y !== tankCell.y)
        .map(({ x, y }) => ({ x, y }));
      const fallbackGoals = [...closeCombatGoals(ctx, tank, enemy), ...pursuitGoals(ctx, enemy)];
      const stagingPath = stagingGoals.length ? findPath(ctx, tankCell, stagingGoals) : [];
      const path = stagingPath.length > 1 ? stagingPath : findPath(ctx, tankCell, fallbackGoals);
      const goals = stagingPath.length ? stagingGoals : fallbackGoals;
      const priority = targetPriority(ctx, tank, enemy);
      return {
        enemy,
        goals,
        path,
        priority,
        preferred: enemy === preferredTarget,
        reserved: reserved.has(enemy),
      };
    }).sort((a, b) => Number(a.reserved) - Number(b.reserved)
      || a.priority.tier - b.priority.tier
      || a.priority.baseEta - b.priority.baseEta
      || (a.path.length || 1000) - (b.path.length || 1000)
      || Number(b.preferred) - Number(a.preferred));
    const preferredPlan = plans.find((plan) => plan.enemy === preferredTarget && plan.path.length > 0);
    if (preferredPlan && (!preferredPlan.reserved || isBaseEmergency(ctx, preferredPlan.enemy))) return preferredPlan;
    return plans.find((plan) => plan.path.length > 0) || plans[0] || null;
  }

  function freezeRecoveryDirection(ctx, tank, enemy, goals = []) {
    const directed = recoveryDirection(ctx, tank, enemy, goals);
    if (directed) return directed;
    return DIR_NAMES.filter((dir) => ctx.canMove?.(dir)).map((dir) => {
      const d = DIRS[dir];
      const step = Math.max(8, Math.min(16, (tank.speed || tank.baseSpeed || 90) * 0.14));
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      return {
        dir,
        score: manhattan(next, enemy) + projectileRisk(ctx, next) * 2 + (dir === tank.dir ? 0 : 8),
      };
    }).sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function stuckEscapeDirection(ctx, tank, enemy, blockedDir) {
    const perpendicular = blockedDir === "up" || blockedDir === "down"
      ? ["left", "right"]
      : ["up", "down"];
    const candidates = [...perpendicular, opposite(blockedDir), ...DIR_NAMES]
      .filter((dir, index, items) => dir && dir !== blockedDir && items.indexOf(dir) === index && ctx.canMove?.(dir));
    const step = Math.max(10, Math.min(18, (Number(tank.speed) || 90) * 0.16));
    const activeTarget = enemy && enemy.alive !== false && !enemy.dead;
    return candidates.map((dir) => {
      const d = DIRS[dir];
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      return {
        dir,
        score: projectileRisk(ctx, next) * 3
          + (activeTarget ? manhattan(next, enemy) * 0.18 : 0)
          + (perpendicular.includes(dir) ? -18 : 0)
          + (dir === tank.dir ? 0 : 4),
      };
    }).sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function routeBrickDirection(ctx, tank, enemy) {
    if (!enemy?.alive) return null;
    const t = center(tank);
    const e = center(enemy);
    const horizontal = e.x < t.x ? "left" : "right";
    const vertical = e.y < t.y ? "up" : "down";
    const preferred = Math.abs(e.x - t.x) >= Math.abs(e.y - t.y)
      ? [horizontal, vertical]
      : [vertical, horizontal];
    return preferred.find((dir) => {
      const obstacle = firstShotObstacle(ctx, tank, dir, enemy);
      return obstacle?.tile === "B" && !obstacle.baseGuard;
    }) || null;
  }

  function anyEnemyShot(ctx, tank, lockedTarget) {
    return visibleEnemies(ctx).filter((enemy) => enemy !== lockedTarget).map((enemy) => {
      const direct = directShot(ctx, tank, enemy);
      const predicted = direct ? null : predictiveShot(ctx, tank, enemy);
      return { enemy, dir: direct || predicted, predicted: !direct && Boolean(predicted), distance: manhattan(tank, enemy) };
    }).filter((item) => item.dir)
      .sort((a, b) => Number(a.predicted) - Number(b.predicted) || a.distance - b.distance)[0] || null;
  }

  function closeRangeShot(ctx, tank, preferredTarget) {
    return visibleEnemies(ctx).map((enemy) => {
      const distance = manhattan(tank, enemy);
      if (distance > TILE * 4.5) return null;
      const direct = directShot(ctx, tank, enemy);
      const predicted = direct ? null : predictiveShot(ctx, tank, enemy);
      return {
        enemy,
        dir: direct || predicted,
        predicted: !direct && Boolean(predicted),
        distance,
        preferred: enemy === preferredTarget,
        baseEmergency: isBaseEmergency(ctx, enemy),
      };
    }).filter((item) => item?.dir)
      .sort((a, b) =>
        Number(b.baseEmergency) - Number(a.baseEmergency)
        || Number(a.predicted) - Number(b.predicted)
        || Number(b.preferred) - Number(a.preferred)
      || a.distance - b.distance)[0] || null;
  }

  function directionFacesBaseZone(ctx, tank, dir) {
    const guard = ctx.baseGuard || ctx.base;
    if (!guard) return false;
    const t = center(tank);
    const horizontalLane = t.y >= guard.y - 4 && t.y <= guard.y + guard.h + 4;
    const verticalLane = t.x >= guard.x - 4 && t.x <= guard.x + guard.w + 4;
    if (dir === "down") return verticalLane && t.y < guard.y + guard.h;
    if (dir === "up") return verticalLane && t.y > guard.y;
    if (dir === "right") return horizontalLane && t.x < guard.x + guard.w;
    if (dir === "left") return horizontalLane && t.x > guard.x;
    return false;
  }

  function pointBlankShot(ctx, tank, enemy, distance) {
    if (distance > TILE * 2.2 && bodyGap(tank, enemy) > TILE * 0.45) return null;
    const t = center(tank);
    const e = center(enemy);
    const dx = e.x - t.x;
    const dy = e.y - t.y;
    const horizontal = dx < 0 ? "left" : "right";
    const vertical = dy < 0 ? "up" : "down";
    const candidates = Math.abs(dx) >= Math.abs(dy) ? [horizontal, vertical] : [vertical, horizontal];
    return candidates.find((dir) => {
      const lateral = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
      const targetSize = dir === "up" || dir === "down" ? enemy.w || 28 : enemy.h || 28;
      const guaranteedLane = lateral <= Math.max(8, targetSize / 2 + 2);
      if (!guaranteedLane) return false;
      if (directionFacesBaseZone(ctx, tank, dir) && lateral > Math.max(6, targetSize / 2 - 3)) return false;
      return !steelBlocksShot(ctx, tank, enemy, dir) && !firstShotObstacle(ctx, tank, dir, enemy);
    }) || null;
  }

  function contactCombatPlan(ctx, tank, preferredTarget) {
    const enemies = visibleEnemies(ctx);
    const frozen = (ctx.freezeTime || 0) > 0;
    const localBreaches = enemies.filter((enemy) => manhattan(tank, enemy) <= TILE * 3.5
      && (isBaseIntruder(ctx, enemy) || crossedMidline(ctx, enemy)));
    const pointBlankEnemies = enemies.filter((enemy) =>
      manhattan(tank, enemy) <= TILE * 2.2 || bodyGap(tank, enemy) <= TILE * 0.45);
    const nearbyCombatEnemies = enemies.filter((enemy) => manhattan(tank, enemy) <= TILE * 3.5);
    const committedEnemies = frozen
      ? enemies
      : [...new Set([
          ...localBreaches,
          ...pointBlankEnemies,
          ...nearbyCombatEnemies,
          ...(preferredTarget?.alive && enemies.includes(preferredTarget) ? [preferredTarget] : []),
        ])];
    if (!committedEnemies.length) committedEnemies.push(...enemies);
    const contact = committedEnemies.map((enemy) => ({
      enemy,
      distance: manhattan(tank, enemy),
      bodyDistance: bodyGap(tank, enemy),
      baseIntruder: isBaseIntruder(ctx, enemy),
      emergency: isBaseEmergency(ctx, enemy),
      terminalBaseAttack: directBaseShotThreat(ctx, enemy)?.target === "base",
      localBreach: localBreaches.includes(enemy),
      pointBlankContact: pointBlankEnemies.includes(enemy),
      nearbyCombat: nearbyCombatEnemies.includes(enemy),
      preferred: enemy === preferredTarget,
    })).filter((item) => item.distance <= (item.baseIntruder
      ? TILE * (isFastLastLine(ctx, item.enemy) ? 4.25 : 4)
      : item.localBreach ? TILE * 3.5
      : (ctx.freezeTime || 0) > 0 ? TILE * 4.75 : TILE * 3.5))
      .sort((a, b) => Number(b.terminalBaseAttack) - Number(a.terminalBaseAttack)
        || Number(b.pointBlankContact) - Number(a.pointBlankContact)
        || (a.pointBlankContact && b.pointBlankContact ? a.bodyDistance - b.bodyDistance : 0)
        || Number(b.preferred) - Number(a.preferred)
        || Number(b.baseIntruder) - Number(a.baseIntruder)
        || Number(b.localBreach) - Number(a.localBreach)
        || Number(b.nearbyCombat) - Number(a.nearbyCombat)
        || Number(b.emergency) - Number(a.emergency)
        || a.bodyDistance - b.bodyDistance
        || a.distance - b.distance)[0];
    if (!contact) return null;
    const direct = frozen
      ? preciseFrozenShot(ctx, tank, contact.enemy)
      : currentPositionShot(ctx, tank, contact.enemy) || directShot(ctx, tank, contact.enemy);
    // The game-side predictor already requires a guaranteed enemy-first hit
    // whenever the barrel faces the base guard. Do not disable that safe shot
    // just because an intruder is still a few tiles away.
    const predicted = frozen || direct ? null : predictiveShot(ctx, tank, contact.enemy);
    if (direct || predicted) {
      return { ...contact, shot: direct || predicted, predicted: !direct && Boolean(predicted), approach: null };
    }
    const pointBlank = frozen ? null : pointBlankShot(ctx, tank, contact.enemy, contact.distance);
    if (pointBlank) {
      return { ...contact, shot: pointBlank, predicted: false, pointBlank: true, approach: null };
    }
    const frozenAlignment = frozenCloseAlignmentDirection(ctx, tank, contact.enemy);
    if (frozenAlignment) {
      return { ...contact, shot: null, predicted: false, approach: frozenAlignment, frozenAlignment: true, breakaway: false };
    }
    const tankCenter = center(tank);
    const enemyCenter = center(contact.enemy);
    const step = contact.pointBlankContact
      ? 16
      : Math.max(8, Math.min(14, (Number(tank.speed) || 90) * 0.1));
    const currentDistance = contact.distance;
    const crowded = currentDistance <= TILE * 1.6;
    const horizontalContact = Math.abs(enemyCenter.x - tankCenter.x) >= Math.abs(enemyCenter.y - tankCenter.y);
    const towardDir = horizontalContact
      ? (enemyCenter.x < tankCenter.x ? "left" : "right")
      : (enemyCenter.y < tankCenter.y ? "up" : "down");
    const lateralDirs = horizontalContact ? new Set(["up", "down"]) : new Set(["left", "right"]);
    // Frozen enemies are immovable obstacles. Start creating a firing lane
    // before reaching their collision box instead of reacting after contact.
    const frozenClose = (ctx.freezeTime || 0) > 0 && currentDistance <= TILE * 4.75;
    const jammed = crowded || frozenClose || !ctx.canMove?.(towardDir);
    const candidates = DIR_NAMES.filter((dir) => ctx.canMove?.(dir)).map((dir) => {
      const d = DIRS[dir];
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      const nextCenter = center(next);
      const distance = manhattan(next, contact.enemy);
      const rowOffset = Math.abs(nextCenter.y - enemyCenter.y);
      const columnOffset = Math.abs(nextCenter.x - enemyCenter.x);
      const alignment = Math.min(rowOffset, columnOffset);
      const currentAlignment = Math.min(
        Math.abs(tankCenter.y - enemyCenter.y),
        Math.abs(tankCenter.x - enemyCenter.x),
      );
      const alignmentGain = currentAlignment - alignment;
      const opensShot = currentPositionShot(ctx, next, contact.enemy)
        || pointBlankShot(ctx, next, contact.enemy, distance);
      return {
        dir,
        distance,
        opensShot: Boolean(opensShot),
        score: distance + alignment * 1.4 + projectileRisk(ctx, next) * 2.2
          - alignmentGain * (contact.pointBlankContact ? 5 : 2)
          - (opensShot ? (contact.baseIntruder ? 170 : 110) : 0)
          + (dir === tank.dir ? 0 : 5)
          + (jammed && lateralDirs.has(dir) ? -46 : 0)
          + (jammed && dir === opposite(towardDir) ? -10 : 0)
          + (jammed && dir === towardDir ? 48 : 0),
      };
    }).filter((item) => item.distance <= currentDistance + (jammed ? TILE * 0.85 : 6))
      .sort((a, b) => a.score - b.score);
    return { ...contact, shot: null, predicted: false, approach: candidates[0]?.dir || null, breakaway: jammed };
  }

  function advanceSafetyThreats(ctx) {
    const warningLine = Math.max(TILE * 8, Number(ctx.rows || 24) * TILE * 0.4);
    return visibleEnemies(ctx).map((enemy) => {
      const direct = directBaseShotThreat(ctx, enemy);
      const baseDistance = manhattan(enemy, ctx.base);
      const dangerEta = Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy));
      const depth = center(enemy).y;
      const fastApproach = fastApproachThreat(ctx, enemy);
      const verticalRush = verticalRushThreat(ctx, enemy);
      return { enemy, direct, fastApproach, verticalRush, baseDistance, dangerEta, depth };
    }).filter((item) => item.direct
      || item.fastApproach
      || item.verticalRush
      || item.depth >= warningLine
      || item.baseDistance <= TILE * 11
      || item.dangerEta <= 6.8)
      .sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
        || Number(Boolean(b.verticalRush)) - Number(Boolean(a.verticalRush))
        || (a.verticalRush?.eta ?? Infinity) - (b.verticalRush?.eta ?? Infinity)
        || Number(b.fastApproach) - Number(a.fastApproach)
        || a.dangerEta - b.dangerEta
        || b.depth - a.depth
        || a.baseDistance - b.baseDistance);
  }

  function assignedAdvanceSafetyThreat(ctx, tank, threats) {
    if (!threats.length) return null;
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive)
      .sort((a, b) => Number(a.kind === "player2") - Number(b.kind === "player2"));
    const ranked = threats.slice(0, Math.min(2, allies.length));
    const travel = (ally, threat) => manhattan(ally, threat.enemy)
      + sideAssignmentPenalty(ctx, ally, threat.enemy);
    if (allies.length === 1) return ranked[0]?.enemy || null;
    if (ranked.length === 1) {
      if (ranked[0].direct) return ranked[0].enemy;
      const responder = allies.slice().sort((a, b) => travel(a, ranked[0]) - travel(b, ranked[0])
        || Number(a.kind === "player") - Number(b.kind === "player"))[0];
      return responder === tank ? ranked[0].enemy : null;
    }
    const directCost = travel(allies[0], ranked[0]) + travel(allies[1], ranked[1]);
    const crossedCost = travel(allies[0], ranked[1]) + travel(allies[1], ranked[0]);
    const allyIndex = allies.indexOf(tank);
    if (allyIndex < 0 || allyIndex > 1) return null;
    return ranked[crossedCost < directCost ? 1 - allyIndex : allyIndex]?.enemy || null;
  }

  function upperThirdSuppressionShot(ctx, tank, preferredTarget) {
    if (!tank?.alive || !ctx.canFire?.() || (ctx.freezeTime || 0) > 0) return null;
    const upperLimit = Math.max(TILE * 6, Number(ctx.rows || 24) * TILE / 3);
    const reserved = new Set([
      ...(ctx.reservedTargets || []),
      ...(ctx.friends || []).map((ally) => ally?.attackTarget),
    ].filter((enemy) => enemy?.alive));
    const candidates = visibleEnemies(ctx)
      .filter((enemy) => center(enemy).y <= upperLimit && manhattan(tank, enemy) >= TILE * 5)
      .map((enemy) => {
        const direct = directShot(ctx, tank, enemy);
        const predicted = direct ? null : predictiveShot(ctx, tank, enemy);
        const tankCenter = center(tank);
        const enemyCenter = center(enemy);
        const coverageDir = enemyCenter.y < tankCenter.y ? "up" : "down";
        const coverageObstacle = firstShotObstacle(ctx, tank, coverageDir, enemy);
        const coverageBlocked = directionFacesBaseZone(ctx, tank, coverageDir)
          || coverageObstacle?.tile === "S"
          || coverageObstacle?.tile === "E"
          || Boolean(coverageObstacle?.baseGuard);
        const coverage = !direct && !predicted && !coverageBlocked ? coverageDir : null;
        return {
          enemy,
          dir: direct || predicted || coverage,
          predicted: !direct && Boolean(predicted),
          coverage: Boolean(coverage),
          distance: manhattan(tank, enemy),
          reserved: reserved.has(enemy),
          preferred: enemy === preferredTarget,
        };
      }).filter((item) => item.dir);
    const unreservedExists = candidates.some((item) => !item.reserved);
    return candidates.sort((a, b) =>
      Number(unreservedExists && a.reserved) - Number(unreservedExists && b.reserved)
      || Number(a.coverage) - Number(b.coverage)
      || Number(a.predicted) - Number(b.predicted)
      || Number(b.preferred) - Number(a.preferred)
      || a.distance - b.distance)[0] || null;
  }

  function bulletThreat(ctx, tank, bullet, horizon = 3) {
    const t = center(tank);
    const b = center(bullet);
    const vertical = bullet.dir === "up" || bullet.dir === "down";
    const lateral = vertical ? Math.abs(b.x - t.x) : Math.abs(b.y - t.y);
    const collisionWidth = vertical ? (tank.w || 28) / 2 : (tank.h || 28) / 2;
    if (lateral > collisionWidth + (bullet.w || 6) / 2 + 7) return null;
    const forward = bullet.dir === "up" ? b.y - t.y
      : bullet.dir === "down" ? t.y - b.y
      : bullet.dir === "left" ? b.x - t.x
      : t.x - b.x;
    if (forward < -collisionWidth) return null;
    const eta = Math.max(0, forward) / Math.max(120, Number(bullet.speed) || 230);
    if (eta > horizon) return null;
    const direction = DIRS[bullet.dir];
    if (!direction) return null;
    for (let distance = 8; distance < Math.max(8, forward - collisionWidth); distance += 8) {
      const x = b.x + direction.x * distance;
      const y = b.y + direction.y * distance;
      const tile = ctx.tileAt?.(Math.floor(x / TILE), Math.floor(y / TILE));
      if (tile === "B" || tile === "S" || tile === "E") return null;
    }
    return { eta, lateral, forward };
  }

  function incomingBullet(ctx, tank) {
    if (isInvulnerable(tank)) return null;
    const surviveWeight = policyWeight(ctx, "survive");
    const horizon = Math.max(2.2, Math.min(3.4, 2.1 + surviveWeight * 0.16));
    return (ctx.bullets || []).filter((bullet) => bullet?.enemy && !bullet.dead).map((bullet) => ({
      bullet,
      threat: bulletThreat(ctx, tank, bullet, horizon),
    })).filter((item) => item.threat)
      .sort((a, b) => a.threat.eta - b.threat.eta || a.threat.lateral - b.threat.lateral)[0]?.bullet || null;
  }

  function counterBulletLane(ctx, tank, dir) {
    return Boolean(DIRS[dir] && (ctx.bullets || []).some((bullet) => {
      if (!bullet?.enemy || bullet.dead || opposite(bullet.dir) !== dir) return false;
      const threat = bulletThreat(ctx, tank, bullet, 3.4);
      return Boolean(threat && threat.lateral <= Math.max(6, (Number(bullet.w) || 6)));
    }));
  }

  function incomingFriendlyBullet(ctx, tank) {
    if (isInvulnerable(tank)) return null;
    return (ctx.bullets || []).filter((bullet) =>
      bullet && !bullet.enemy && !bullet.dead && bullet.owner && bullet.owner !== tank
    ).map((bullet) => ({
      bullet,
      threat: allyFireBlockedByEnemy(ctx, tank, bullet) ? null : bulletThreat(ctx, tank, bullet, 3),
    })).filter((item) => item.threat)
      .sort((a, b) => a.threat.eta - b.threat.eta || a.threat.lateral - b.threat.lateral)[0]?.bullet || null;
  }

  function incomingAllyFire(ctx, tank) {
    if (isInvulnerable(tank)) return null;
    return (ctx.allyFireReports || []).map((report) => ({
      report,
      threat: allyFireBlockedByEnemy(ctx, tank, report) ? null : bulletThreat(ctx, tank, {
        x: report.x,
        y: report.y,
        w: report.w || 6,
        h: report.h || 6,
        dir: report.dir,
        speed: report.speed || 310,
      }, 2.4),
    })).filter((item) => item.threat)
      .sort((a, b) => a.threat.eta - b.threat.eta || a.threat.lateral - b.threat.lateral)[0]?.report || null;
  }

  function allyFireBlockedByEnemy(ctx, tank, report) {
    const d = DIRS[report.dir];
    if (!d) return false;
    const origin = { x: Number(report.x) + (Number(report.w) || 6) / 2, y: Number(report.y) + (Number(report.h) || 6) / 2 };
    const tankCenter = center(tank);
    const tankForward = (tankCenter.x - origin.x) * d.x + (tankCenter.y - origin.y) * d.y;
    if (tankForward <= 0) return false;
    return visibleEnemies(ctx).some((enemy) => {
      const enemyCenter = center(enemy);
      const forward = (enemyCenter.x - origin.x) * d.x + (enemyCenter.y - origin.y) * d.y;
      const lateral = d.x === 0 ? Math.abs(enemyCenter.x - origin.x) : Math.abs(enemyCenter.y - origin.y);
      const halfWidth = d.x === 0 ? (enemy.w || 28) / 2 : (enemy.h || 28) / 2;
      return forward > 0 && forward < tankForward && lateral <= halfWidth + 5;
    });
  }

  function baseShieldBullet(ctx, tank) {
    const guard = ctx.baseGuard || ctx.base;
    if (!guard) return null;
    const guardCenter = center(guard);
    return (ctx.bullets || []).filter((bullet) => bullet?.enemy && !bullet.dead).map((bullet) => {
      const threat = bulletThreat(ctx, tank, bullet, 8);
      if (!threat) return null;
      const bulletCenter = center(bullet);
      const vertical = bullet.dir === "up" || bullet.dir === "down";
      const inGuardLane = vertical
        ? bulletCenter.x >= guard.x - 5 && bulletCenter.x <= guard.x + guard.w + 5
        : bulletCenter.y >= guard.y - 5 && bulletCenter.y <= guard.y + guard.h + 5;
      const headingToGuard = bullet.dir === "up" ? bulletCenter.y > guardCenter.y
        : bullet.dir === "down" ? bulletCenter.y < guardCenter.y
          : bullet.dir === "left" ? bulletCenter.x > guardCenter.x
            : bulletCenter.x < guardCenter.x;
      const guardForward = vertical
        ? Math.abs(guardCenter.y - bulletCenter.y)
        : Math.abs(guardCenter.x - bulletCenter.x);
      if (!inGuardLane || !headingToGuard || threat.forward + TILE * 0.35 >= guardForward) return null;
      return { bullet, threat };
    }).filter(Boolean)
      .sort((a, b) => a.threat.eta - b.threat.eta || a.threat.lateral - b.threat.lateral)[0]?.bullet || null;
  }

  function baseProjectileThreat(ctx, bullet, horizon = 4.2) {
    const guard = ctx.baseGuard || ctx.base;
    const direction = DIRS[bullet?.dir];
    if (!guard || !bullet?.enemy || bullet.dead || !direction) return null;
    const bulletCenter = center(bullet);
    const vertical = direction.x === 0;
    const lanePadding = Math.max(5, (vertical ? Number(bullet.w) : Number(bullet.h)) || 6);
    const inGuardLane = vertical
      ? bulletCenter.x >= guard.x - lanePadding && bulletCenter.x <= guard.x + guard.w + lanePadding
      : bulletCenter.y >= guard.y - lanePadding && bulletCenter.y <= guard.y + guard.h + lanePadding;
    if (!inGuardLane) return null;
    const distance = bullet.dir === "down" ? guard.y - bulletCenter.y
      : bullet.dir === "up" ? bulletCenter.y - (guard.y + guard.h)
      : bullet.dir === "right" ? guard.x - bulletCenter.x
      : bulletCenter.x - (guard.x + guard.w);
    if (distance < -TILE * 0.2) return null;
    const speed = Math.max(120, Number(bullet.speed) || 230);
    const eta = Math.max(0, distance) / speed;
    if (eta > horizon) return null;
    for (let travel = 6; travel < Math.max(6, distance - 3); travel += 6) {
      const x = bulletCenter.x + direction.x * travel;
      const y = bulletCenter.y + direction.y * travel;
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      const tile = ctx.tileAt?.(tx, ty) ?? ctx.map?.[ty]?.[tx] ?? "S";
      if (tile === "S") return null;
      if (tile === "B" && !isGuardCell(ctx, tx, ty)) return null;
      if (tile === "E" || (tile === "B" && isGuardCell(ctx, tx, ty))) break;
    }
    return { bullet, eta, distance: Math.max(0, distance), guard };
  }

  function baseProjectileInterceptPlan(ctx, tank, projectile) {
    const bullet = projectile?.bullet;
    const direction = DIRS[bullet?.dir];
    if (!tank?.alive || !direction || projectile.distance <= TILE * 0.8) return null;
    const bulletCenter = center(bullet);
    let tankPlans = baseProjectileInterceptCaches.get(bullet);
    if (!tankPlans) {
      tankPlans = new WeakMap();
      baseProjectileInterceptCaches.set(bullet, tankPlans);
    }
    const tankCell = cellOf(tank);
    const bulletCell = cellOf(bullet);
    const cacheKey = `${Number(ctx.mapVersion || 0)}:${tankCell.x},${tankCell.y}:${bulletCell.x},${bulletCell.y}`;
    const cached = tankPlans.get(tank);
    if (cached?.key === cacheKey) return cached.plan;
    const speed = Math.max(120, Number(bullet.speed) || 230);
    const candidates = [];
    const seen = new Set();
    for (let travel = TILE * 0.8; travel < projectile.distance - TILE * 0.35; travel += TILE * 0.65) {
      const cell = {
        x: Math.floor((bulletCenter.x + direction.x * travel) / TILE),
        y: Math.floor((bulletCenter.y + direction.y * travel) / TILE),
      };
      const cellKey = keyOf(cell.x, cell.y);
      if (seen.has(cellKey) || tileCost(ctx, cell.x, cell.y) !== 1) continue;
      seen.add(cellKey);
      const cellCenter = { x: cell.x * TILE + TILE / 2, y: cell.y * TILE + TILE / 2 };
      const bulletTravel = (cellCenter.x - bulletCenter.x) * direction.x
        + (cellCenter.y - bulletCenter.y) * direction.y;
      if (bulletTravel <= TILE * 0.25) continue;
      const bulletEta = bulletTravel / speed;
      const optimisticEta = manhattan(tank, { x: cell.x * TILE + 2, y: cell.y * TILE + 2, w: 28, h: 28 })
        / Math.max(45, Number(tank.speed || tank.baseSpeed) || 90);
      if (optimisticEta + 0.12 >= bulletEta) continue;
      candidates.push({ cell, bulletEta, optimisticEta });
    }
    const result = candidates.sort((a, b) => a.optimisticEta - b.optimisticEta || b.bulletEta - a.bulletEta)
      .slice(0, 6).map((candidate) => {
        const path = findPath(ctx, tankCell, [candidate.cell]);
        if (path.length < 2 || path.some((cell, index) => index > 0
          && (ctx.tileAt?.(cell.x, cell.y) ?? ctx.map?.[cell.y]?.[cell.x]) === "B")) return null;
        const arrivalDir = routeDirection(path.slice(-2)) || tank.dir;
        const counterDir = opposite(bullet.dir);
        const allyEta = pathTravelTime(path, tank.speed, tank.dir, ctx) + turnTime(arrivalDir, counterDir);
        if (allyEta + 0.08 >= candidate.bulletEta) return null;
        return {
          ...candidate,
          path,
          allyEta,
          margin: candidate.bulletEta - allyEta,
          counterDir,
          bullet,
        };
      }).filter(Boolean).sort((a, b) => b.margin - a.margin || a.allyEta - b.allyEta)[0] || null;
    tankPlans.set(tank, { key: cacheKey, plan: result });
    return result;
  }

  function assignedBaseProjectileIntercept(ctx, tank) {
    const projectile = (ctx.bullets || []).map((bullet) => baseProjectileThreat(ctx, bullet, 4.2))
      .filter(Boolean).sort((a, b) => a.eta - b.eta)[0] || null;
    if (!projectile) return null;
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive);
    const plans = allies.map((ally) => ({ ally, plan: baseProjectileInterceptPlan(ctx, ally, projectile) }))
      .filter((item) => item.plan)
      .sort((a, b) => a.plan.allyEta - b.plan.allyEta || b.plan.margin - a.plan.margin
        || Number(a.ally.kind === "player2") - Number(b.ally.kind === "player2"));
    return plans[0]?.ally === tank ? plans[0].plan : null;
  }

  function clearMuzzleLane(ctx, enemy, tank) {
    const from = cellOf(enemy);
    const to = cellOf(tank);
    const vertical = enemy.dir === "up" || enemy.dir === "down";
    const dx = vertical ? 0 : Math.sign(to.x - from.x);
    const dy = vertical ? Math.sign(to.y - from.y) : 0;
    let x = from.x + dx;
    let y = from.y + dy;
    const steps = vertical ? Math.abs(to.y - from.y) : Math.abs(to.x - from.x);
    for (let step = 1; step < steps; step++) {
      const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
      if (tile === "B" || tile === "S" || tile === "E") return false;
      x += dx;
      y += dy;
    }
    return true;
  }

  function aimingEnemy(ctx, tank) {
    if (isInvulnerable(tank)) return null;
    if ((ctx.freezeTime || 0) > 0) return null;
    const t = center(tank);
    return visibleEnemies(ctx).map((enemy) => {
      const e = center(enemy);
      const vertical = enemy.dir === "up" || enemy.dir === "down";
      const aligned = vertical ? Math.abs(e.x - t.x) < 22 : Math.abs(e.y - t.y) < 22;
      const facing = enemy.dir === "up" ? e.y > t.y
        : enemy.dir === "down" ? e.y < t.y
          : enemy.dir === "left" ? e.x > t.x
            : e.x < t.x;
      return { enemy, distance: Math.abs(e.x - t.x) + Math.abs(e.y - t.y), danger: aligned && facing };
    }).filter((item) => item.danger && item.distance <= TILE * 8 && clearMuzzleLane(ctx, item.enemy, tank))
      .sort((a, b) => a.distance - b.distance)[0]?.enemy || null;
  }

  function dodgeDirection(ctx, tank, bullet, target) {
    if (!bullet) return null;
    const currentThreat = bulletThreat(ctx, tank, bullet, 3.4);
    const options = bullet.dir === "up" || bullet.dir === "down" ? ["left", "right"] : ["up", "down"];
    return options.filter((dir) => {
      const actualDir = movementDirectionDuringTurn(tank, dir);
      if (actualDir === dir) {
        return ctx.canMove?.(dir) && !movementBulletThreat(ctx, tank, dir, 1.15);
      }
      // Start a lateral turn when there is enough time to finish it. During the
      // turn the game keeps the old movement direction, so reject only when that
      // short transition itself intersects the shell.
      const turnDelay = Math.max(turnTime(tank.dir, dir), Number(tank.turnCooldown) || 0);
      if (!currentThreat || currentThreat.eta <= turnDelay + 0.16 || !ctx.canMove?.(dir)) return false;
      const transitionThreat = movementBulletThreat(ctx, tank, actualDir, Math.min(0.7, turnDelay + 0.08));
      return !transitionThreat || transitionThreat.eta > turnDelay + 0.04;
    }).sort((a, b) => {
      const score = (dir) => {
        const d = DIRS[dir];
        const travel = Math.max(TILE * 0.65, Math.min(TILE * 1.15, (tank.speed || tank.baseSpeed || 90) * 0.34));
        const next = { ...tank, x: tank.x + d.x * travel, y: tank.y + d.y * travel };
        const far = { ...tank, x: tank.x + d.x * travel * 1.65, y: tank.y + d.y * travel * 1.65 };
        const originalThreat = bulletThreat(ctx, tank, bullet, 3.4);
        const residual = bulletThreat(ctx, next, bullet, 1.6);
        const turnDelay = dir === tank.dir ? 0 : Math.max(0.3, Number(tank.turnCooldown) || 0);
        const tooLate = originalThreat && turnDelay + 0.08 >= originalThreat.eta ? TILE * 80 : 0;
        const muzzleRisk = aimingEnemy(ctx, next) ? TILE * 18 : 0;
        return projectileRisk(ctx, next) * 5
          + projectileRisk(ctx, far) * 2
          + (residual ? TILE * 55 / (0.1 + residual.eta) : 0)
          + tooLate
          + muzzleRisk
          + (target ? manhattan(next, target) * 0.06 : 0);
      };
      return score(a) - score(b);
    })[0] || null;
  }

  function bulletLineRetreat(ctx, tank, bullet) {
    if (!bullet?.enemy) return null;
    const threat = bulletThreat(ctx, tank, bullet, 3.4);
    if (!threat) return null;
    const turnDelay = tank.dir === bullet.dir
      ? Math.max(0, Number(tank.turnCooldown) || 0)
      : Math.max(turnTime(tank.dir, bullet.dir), Number(tank.turnCooldown) || 0);
    if (threat.eta <= turnDelay + 0.14) return null;
    if (!ctx.canMove?.(bullet.dir)) return null;
    return movementBulletThreat(ctx, tank, bullet.dir, 0.9) ? null : bullet.dir;
  }

  function lastChanceBulletEscape(ctx, tank, bullet) {
    const currentThreat = bulletThreat(ctx, tank, bullet, 3.4);
    if (!currentThreat) return null;
    const horizon = Math.max(0.75, Math.min(1.5, currentThreat.eta + 0.7));
    const bulletCenter = center(bullet);
    const vertical = bullet.dir === "up" || bullet.dir === "down";
    return DIR_NAMES.map((dir) => {
      const actualDir = movementDirectionDuringTurn(tank, dir);
      if (actualDir !== dir || !ctx.canMove?.(actualDir)) return null;
      const movement = DIRS[actualDir];
      const travel = Math.max(8, Math.min(TILE * 1.25, (Number(tank.speed || tank.baseSpeed) || 90) * 0.34));
      const projected = {
        ...tank,
        x: tank.x + movement.x * travel,
        y: tank.y + movement.y * travel,
      };
      const crossing = movementBulletThreat(ctx, tank, dir, horizon);
      const survivalEta = crossing?.eta ?? horizon + 0.8;
      if (survivalEta <= currentThreat.eta + 0.05) return null;
      const projectedCenter = center(projected);
      const clearance = vertical
        ? Math.abs(projectedCenter.x - bulletCenter.x)
        : Math.abs(projectedCenter.y - bulletCenter.y);
      return {
        dir,
        score: survivalEta * 120 + clearance * 2
          + (actualDir === bullet.dir ? 18 : 0)
          - (actualDir === opposite(bullet.dir) ? 35 : 0)
          - turnTime(tank.dir, dir) * 20,
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score)[0]?.dir || null;
  }

  function forcedBulletEscapePlan(ctx, tank, bullet, target) {
    const currentThreat = bulletThreat(ctx, tank, bullet, 3.4);
    if (!currentThreat) return null;
    const bulletCenter = center(bullet);
    const vertical = bullet.dir === "up" || bullet.dir === "down";
    const preferred = vertical ? ["left", "right", bullet.dir, opposite(bullet.dir)]
      : ["up", "down", bullet.dir, opposite(bullet.dir)];
    const horizon = Math.max(0.9, Math.min(1.8, currentThreat.eta + 1.05));
    const candidates = [...new Set(preferred)].map((dir) => {
      const actualDir = movementDirectionDuringTurn(tank, dir);
      if (actualDir !== dir || !ctx.canMove?.(actualDir)) return null;
      const movement = DIRS[actualDir];
      const travel = Math.max(10, Math.min(TILE * 1.4, (Number(tank.speed || tank.baseSpeed) || 90) * 0.42));
      const projected = { ...tank, x: tank.x + movement.x * travel, y: tank.y + movement.y * travel };
      const collision = movementBulletThreat(ctx, tank, dir, horizon);
      const projectedCenter = center(projected);
      const clearance = vertical
        ? Math.abs(projectedCenter.x - bulletCenter.x)
        : Math.abs(projectedCenter.y - bulletCenter.y);
      const collisionEta = collision?.eta ?? horizon + 1;
      const lateral = vertical ? actualDir === "left" || actualDir === "right" : actualDir === "up" || actualDir === "down";
      return {
        dir,
        actualDir,
        collisionEta,
        safe: !collision,
        moveScale: actualDir === dir ? 1 : 0.18,
        score: collisionEta * 1000
          + clearance * 3
          + (lateral ? 220 : 0)
          + (actualDir === bullet.dir ? 80 : 0)
          - (actualDir === opposite(bullet.dir) ? 180 : 0)
          - projectileRisk(ctx, projected) * 0.08
          - (target ? manhattan(projected, target) * 0.015 : 0),
      };
    }).filter(Boolean);
    const safeCandidates = candidates.filter((item) => item.safe);
    const pool = safeCandidates.length ? safeCandidates : candidates;
    return pool
      .sort((a, b) => Number(b.safe) - Number(a.safe)
        || b.collisionEta - a.collisionEta
        || b.score - a.score)[0] || null;
  }

  function projectileRisk(ctx, tank) {
    if (isInvulnerable(tank)) return 0;
    const t = center(tank);
    let risk = 0;
    for (const bullet of (ctx.bullets || []).filter((item) => item?.enemy && !item.dead)) {
      const threat = bulletThreat(ctx, tank, bullet, 3.4);
      if (threat) risk += Math.max(8, 420 / (0.12 + threat.eta) + (28 - Math.min(28, threat.lateral)) * 5);
    }
    for (const report of (ctx.allyFireReports || [])) {
      const vertical = report.dir === "up" || report.dir === "down";
      const offset = vertical ? Math.abs(report.tankX - t.x) : Math.abs(report.tankY - t.y);
      const approaching = report.dir === "up" ? report.tankY > t.y : report.dir === "down" ? report.tankY < t.y : report.dir === "left" ? report.tankX > t.x : report.tankX < t.x;
      if (approaching && offset < 30) risk += TILE * 6;
    }
    return risk;
  }

  function bulletBlockedDistance(ctx, bullet, maxTravel) {
    const direction = DIRS[bullet?.dir];
    if (!direction || maxTravel <= 0) return Infinity;
    const start = center(bullet);
    for (let distance = 6; distance <= maxTravel; distance += 6) {
      const x = start.x + direction.x * distance;
      const y = start.y + direction.y * distance;
      const tile = ctx.tileAt?.(Math.floor(x / TILE), Math.floor(y / TILE));
      if (tile === "B" || tile === "S" || tile === "E") return distance;
    }
    return Infinity;
  }

  function movementBulletThreat(ctx, tank, dir, horizon = 0.9) {
    if (isInvulnerable(tank)) return null;
    const actualDir = movementDirectionDuringTurn(tank, dir);
    const movement = DIRS[actualDir];
    if (!movement || !tank?.alive) return null;
    const tankStart = center(tank);
    const tankSpeed = Math.max(45, Number(tank.speed || tank.baseSpeed) || 90);
    const tankHalfW = (Number(tank.w) || 28) / 2;
    const tankHalfH = (Number(tank.h) || 28) / 2;
    let earliest = null;
    for (const bullet of (ctx.bullets || []).filter((item) => item?.enemy && !item.dead)) {
      const bulletDirection = DIRS[bullet.dir];
      if (!bulletDirection) continue;
      const bulletStart = center(bullet);
      const bulletSpeed = Math.max(120, Number(bullet.speed) || 230);
      const bulletHalfW = (Number(bullet.w) || 6) / 2;
      const bulletHalfH = (Number(bullet.h) || 6) / 2;
      const blockedAt = bulletBlockedDistance(ctx, bullet, bulletSpeed * horizon);
      for (let time = 0.06; time <= horizon + 0.001; time += 0.06) {
        const bulletTravel = bulletSpeed * time;
        if (bulletTravel >= blockedAt) break;
        const tankTravel = Math.min(TILE * 2, tankSpeed * time);
        const tankX = tankStart.x + movement.x * tankTravel;
        const tankY = tankStart.y + movement.y * tankTravel;
        const bulletX = bulletStart.x + bulletDirection.x * bulletTravel;
        const bulletY = bulletStart.y + bulletDirection.y * bulletTravel;
        const hitX = Math.abs(tankX - bulletX) <= tankHalfW + bulletHalfW + 3;
        const hitY = Math.abs(tankY - bulletY) <= tankHalfH + bulletHalfH + 3;
        if (hitX && hitY) {
          if (!earliest || time < earliest.eta) earliest = { bullet, eta: time };
          break;
        }
      }
    }
    return earliest;
  }

  function predictiveDetourDirection(ctx, tank, target) {
    const tankCenter = center(tank);
    return DIR_NAMES.map((dir) => {
      const actualDir = movementDirectionDuringTurn(tank, dir);
      if (actualDir !== dir || !ctx.canMove?.(dir) || movementBulletThreat(ctx, tank, dir, 1.05)) return null;
      const vector = DIRS[dir];
      const travel = Math.max(8, Math.min(TILE, (Number(tank.speed || tank.baseSpeed) || 90) * 0.28));
      const projected = { ...tank, x: tank.x + vector.x * travel, y: tank.y + vector.y * travel };
      return {
        dir,
        score: projectileRisk(ctx, projected) * 4
          + (target ? manhattan(projected, target) : 0)
          + (dir === opposite(tank.dir) ? TILE * 1.25 : 0)
          + (dir === tank.dir ? -TILE * 0.2 : 0)
          + Math.abs(center(projected).x - tankCenter.x) * 0.01,
      };
    }).filter(Boolean).sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function closeApproachDirection(ctx, tank, target) {
    const t = center(tank);
    const e = center(target);
    return DIR_NAMES.filter((dir) => ctx.canMove?.(dir)).map((dir) => {
      const d = DIRS[dir];
      const x = t.x + d.x * TILE;
      const y = t.y + d.y * TILE;
      const dx = Math.abs(e.x - x);
      const dy = Math.abs(e.y - y);
      return { dir, score: Math.min(dx, dy) * 2.4 + dx + dy };
    }).sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function nearbyFreeze(ctx, tank) {
    const candidates = (ctx.bonuses || []).filter((bonus) =>
      !bonus.dead && bonus.type === "freeze"
        && tileRange(tank, bonus) <= 8
    ).sort((a, b) => tileRange(tank, a) - tileRange(tank, b)
      || manhattan(tank, a) - manhattan(tank, b));
    if (!candidates.length) return null;

    // Freeze is the highest strategic priority. Pick the nearest reachable one
    // immediately; the partner keeps fighting while the collector is en route.
    return candidates.find((bonus) => freezePath(ctx, tank, bonus).length) || null;
  }

  function freezeCollector(ctx, tank, bonus) {
    if (!bonus || bonus.dead) return null;
    const order = (ally) => ally.kind === "player" ? 0 : ally.kind === "player2" ? 1 : 2;
    const candidates = [tank, ...(ctx.friends || [])].filter((ally) =>
      ally?.alive && tileRange(ally, bonus) <= 8).map((ally) => {
        const path = freezePath(ctx, ally, bonus);
        return {
          ally,
          routeLength: path.length ? Math.max(0, path.length - 1) : Infinity,
        distance: manhattan(ally, bonus),
      };
    }).filter((item) => Number.isFinite(item.routeLength));
    const collector = candidates.sort((a, b) =>
      a.routeLength - b.routeLength
        || a.distance - b.distance
        || order(a.ally) - order(b.ally))[0]?.ally || null;
    return collector;
  }

  function freezePath(ctx, tank, freeze) {
    const freezeCell = cellOf(freeze);
    const tankCell = cellOf(tank);
    let tankCaches = freezePathCaches.get(freeze);
    if (!tankCaches) {
      tankCaches = new WeakMap();
      freezePathCaches.set(freeze, tankCaches);
    }
    const cacheKey = `${Number(ctx.mapVersion || 0)}:${tankCell.x},${tankCell.y}:${freezeCell.x},${freezeCell.y}`;
    const cached = tankCaches.get(tank);
    if (cached?.key === cacheKey) return cached.path;
    const pathCtx = { ...ctx, aiAvoidCell: null, ignoreAllyRoutes: true };
    const direct = findPath(pathCtx, cellOf(tank), [freezeCell]);
    if (direct.length) {
      tankCaches.set(tank, { key: cacheKey, path: direct });
      return direct;
    }
    const entrances = DIR_NAMES.map((dir) => ({
      x: freezeCell.x + DIRS[dir].x,
      y: freezeCell.y + DIRS[dir].y,
    })).filter((cell) => tileCost(pathCtx, cell.x, cell.y) === 1);
    const path = findPath(pathCtx, tankCell, entrances);
    tankCaches.set(tank, { key: cacheKey, path });
    return path;
  }

  function freezePickupPlan(ctx, tank, freeze) {
    return { path: freezePath(ctx, tank, freeze), collect: true };
  }

  function freezeDirectDirection(ctx, tank, freeze) {
    const t = center(tank);
    const f = center(freeze);
    const dx = f.x - t.x;
    const dy = f.y - t.y;
    if (Math.abs(dx) + Math.abs(dy) < 4) return null;
    const preferred = Math.abs(dx) >= Math.abs(dy)
      ? [dx < 0 ? "left" : "right", dy < 0 ? "up" : "down"]
      : [dy < 0 ? "up" : "down", dx < 0 ? "left" : "right"];
    return preferred.find((dir) => ctx.canMove?.(dir)) || null;
  }

  function createCoreController(name, services) {
    let target = null;
    let missionTarget = null;
    let mode = "core-init";
    let failures = 0;
    let lastErrorAt = -Infinity;
    let tacticalState = "CHASE";
    let stateUntil = 0;
    let targetLockUntil = 0;
    let evadeDir = null;
    let clearCellKey = null;
    let avoidBrick = null;
    let lastDecisionTime = 0;
    let closeLockUntil = 0;
    let closeFireDir = null;
    let closeFireUntil = 0;
    let contactActionTarget = null;
    let contactAimDir = null;
    let contactAimUntil = 0;
    let contactMoveDir = null;
    let contactMoveUntil = 0;
    let emergencyAimTarget = null;
    let emergencyAimDir = null;
    let emergencyAimUntil = 0;
    let emergencyMoveTarget = null;
    let emergencyMoveDir = null;
    let emergencyMoveUntil = 0;
    let freezeBurstTarget = null;
    let freezeBurstShots = 0;
    let armorVolleyTarget = null;
    let armorVolleyShots = 0;
    let pendingArmorShot = null;
    let freezeCommittedTarget = null;
    let freezePickupBonus = null;
    let freezePickupDir = null;
    let freezePickupDirUntil = 0;
    let pendingFreezeShots = [];
    const freezeBlockedTargets = new Set();
    const freezeMissedCells = new Map();
    let failedFreezeTarget = null;
    let failedFreezeCell = null;
    let failedFreezeUntil = 0;
    let freezePlanCache = null;
    let freezePlanCacheKey = "";
    let freezePlanCacheUntil = 0;
    const targetRouteCosts = new Map();
    let targetRouteMapVersion = -1;
    let interceptTarget = null;
    let interceptPlan = null;
    let interceptPlanUntil = 0;
    let interceptPlanMapVersion = -1;
    let stableRouteTarget = null;
    let stableRoute = [];
    let stableRouteUntil = 0;
    let stableRouteMapVersion = -1;
    let displayRouteTarget = null;
    let displayRoute = [];
    let displayRouteUntil = 0;
    let displayRouteMapVersion = -1;
    let baseMeleeRouteTarget = null;
    let blockedRouteCellKey = null;
    let blockedRouteHits = 0;
    let lastMoveDir = null;
    let stuckBlockedDir = null;
    let stuckEscapeUntil = 0;
    let targetStuckCount = 0;
    let globalRouteRecoveryUntil = 0;
    let movementTurns = [];
    let lastMovementDecisionDir = null;
    let movementTurnTarget = null;
    let breakthroughCommitTarget = null;
    let patrolPressureTarget = null;
    let patrolPressureUntil = 0;
    let finalSearchEnemy = null;
    let finalSearchWaypoint = null;
    let finalSearchMapVersion = -1;
    let finalSearchStep = 0;
    let wasFrozen = false;
    const recordedShieldBullets = new WeakSet();

    function setTarget(next, lockUntil = null, force = false, commitMission = false) {
      const changed = target !== next;
      if (commitMission) missionTarget = next?.alive ? next : null;
      if (changed && missionTarget?.alive && next !== missionTarget && !commitMission && !force) return false;
      if (changed && target?.alive && !force) return false;
      if (changed) {
        target = next;
        targetStuckCount = 0;
        closeFireDir = null;
        closeFireUntil = 0;
        contactActionTarget = null;
        contactAimDir = null;
        contactAimUntil = 0;
        contactMoveDir = null;
        contactMoveUntil = 0;
        emergencyAimTarget = null;
        emergencyAimDir = null;
        emergencyAimUntil = 0;
        emergencyMoveTarget = null;
        emergencyMoveDir = null;
        emergencyMoveUntil = 0;
        patrolPressureTarget = null;
        patrolPressureUntil = 0;
        stableRouteTarget = null;
        stableRoute = [];
        stableRouteUntil = 0;
        displayRouteTarget = null;
        displayRoute = [];
        displayRouteUntil = 0;
        displayRouteMapVersion = -1;
        baseMeleeRouteTarget = null;
        blockedRouteCellKey = null;
        blockedRouteHits = 0;
        freezePlanCache = null;
        freezePlanCacheKey = "";
        freezePlanCacheUntil = 0;
      }
      if (Number.isFinite(lockUntil)) {
        targetLockUntil = changed ? lockUntil : Math.max(targetLockUntil, lockUntil);
      }
      return true;
    }

    function resetFreezeCombatState(now) {
      pendingFreezeShots = [];
      freezeBlockedTargets.clear();
      freezeMissedCells.clear();
      failedFreezeTarget = null;
      failedFreezeCell = null;
      failedFreezeUntil = 0;
      freezePlanCache = null;
      freezePlanCacheKey = "";
      freezePlanCacheUntil = 0;
      freezeBurstTarget = null;
      freezeBurstShots = 0;
      freezeCommittedTarget = null;
      contactActionTarget = null;
      contactAimDir = null;
      contactAimUntil = 0;
      contactMoveDir = null;
      contactMoveUntil = 0;
      emergencyAimTarget = null;
      emergencyAimDir = null;
      emergencyAimUntil = 0;
      emergencyMoveTarget = null;
      emergencyMoveDir = null;
      emergencyMoveUntil = 0;
      interceptTarget = null;
      interceptPlan = null;
      interceptPlanUntil = now;
      interceptPlanMapVersion = -1;
      stableRouteTarget = null;
      stableRoute = [];
      stableRouteUntil = 0;
      displayRouteTarget = null;
      displayRoute = [];
      displayRouteUntil = 0;
      displayRouteMapVersion = -1;
      targetLockUntil = 0;
      closeLockUntil = 0;
      tacticalState = "CHASE";
      stateUntil = now;
      setTarget(null, null, true);
    }

    function updateArmorVolley(tank, now) {
      if (pendingArmorShot) {
        const fired = pendingArmorShot.target?.alive
          && Number(tank.cooldown || 0) > pendingArmorShot.cooldownBefore + 0.05;
        if (fired) {
          if (armorVolleyTarget !== pendingArmorShot.target) {
            armorVolleyTarget = pendingArmorShot.target;
            armorVolleyShots = 0;
          }
          armorVolleyShots++;
          if (armorVolleyShots >= 2) {
            armorVolleyTarget = null;
            armorVolleyShots = 0;
          }
          pendingArmorShot = null;
        } else if (now >= pendingArmorShot.expiresAt) {
          pendingArmorShot = null;
        }
      }
      if (!armorVolleyTarget?.alive || armorVolleyTarget.kind !== "armor") {
        armorVolleyTarget = null;
        armorVolleyShots = 0;
      }
    }

    function keepArmorVolley(ctx, tank, action) {
      if (!armorVolleyTarget?.alive || armorVolleyShots !== 1
        || action?.target === armorVolleyTarget) return action;
      const tacticalInterrupt = /base-shield|bullet-intercept|dodge|evade|avoid|escape|freeze-pickup/.test(action?.mode || "");
      const emergencyInterrupt = action?.target?.alive
        && (directBaseShotThreat(ctx, action.target) || isBaseEmergency(ctx, action.target));
      if (tacticalInterrupt || emergencyInterrupt) return action;
      const shotDir = currentPositionShot(ctx, tank, armorVolleyTarget)
        || predictiveShot(ctx, tank, armorVolleyTarget);
      if (shotDir) {
        mode = "core-armor-volley";
        return aimedFireAction(ctx, tank, shotDir, mode, armorVolleyTarget, true);
      }
      if (action?.fire) {
        mode = "core-armor-volley-reacquire";
        return { ...action, fire: false, mode, target: armorVolleyTarget };
      }
      return action;
    }

    function stabilizeMovement(ctx, tank, action, now) {
      const movementDir = action?.moveDir || action?.dir;
      const moving = movementDir && !action?.hold;
      const tacticalInterrupt = /base-shield|bullet-intercept|counter|dodge|evade|avoid-friendly|avoid-ally|escape|freeze-pickup/.test(action?.mode || "");
      const activeTarget = action?.target?.alive ? action.target : target?.alive ? target : null;
      if (!moving || tacticalInterrupt) {
        if (tacticalInterrupt) movementTurns = [];
        return action;
      }

      if (movementTurnTarget !== activeTarget) {
        movementTurnTarget = activeTarget;
        movementTurns = [];
      }

      if (movementDir !== lastMovementDecisionDir) {
        movementTurns.push({
          dir: movementDir,
          time: now,
          x: center(tank).x,
          y: center(tank).y,
          target: activeTarget,
        });
        movementTurns = movementTurns.filter((entry) => now - entry.time <= 1.6).slice(-7);
        lastMovementDecisionDir = movementDir;
      }
      const recent = movementTurns.filter((entry) => entry.target === activeTarget);
      const lastFour = recent.slice(-4);
      const alternating = lastFour.length === 4
        && lastFour[0].dir === lastFour[2].dir
        && lastFour[1].dir === lastFour[3].dir
        && opposite(lastFour[0].dir) === lastFour[1].dir;
      const lastFive = recent.slice(-5);
      const loop = lastFive.length === 5
        && lastFive[0].dir === lastFive[4].dir
        && new Set(lastFive.map((entry) => entry.dir)).size >= 3;
      const pattern = alternating ? lastFour : loop ? lastFive : null;
      if (!pattern) return action;
      const displacement = Math.abs(center(tank).x - pattern[0].x) + Math.abs(center(tank).y - pattern[0].y);
      if (displacement > TILE * 1.4) return action;

      const pickupTarget = /freeze-pickup/.test(action.mode || "") && freezePickupBonus && !freezePickupBonus.dead
        ? freezePickupBonus
        : null;
      const assignedIntercept = ctx.globalDirective?.target === activeTarget
        ? ctx.globalDirective.intercept
        : null;
      const interceptEndpoint = assignedIntercept?.path?.at(-1) || null;
      const interceptGoal = interceptEndpoint ? {
        x: interceptEndpoint.x * TILE + 2,
        y: interceptEndpoint.y * TILE + 2,
        w: 28,
        h: 28,
      } : null;
      const movementGoal = pickupTarget || interceptGoal || activeTarget;
      const currentDistance = movementGoal ? manhattan(tank, movementGoal) : Infinity;
      const candidates = DIR_NAMES.filter((dir) => ctx.canMove?.(dir)
        && !movementBulletThreat(ctx, tank, dir, 0.9)).map((dir) => {
        const d = DIRS[dir];
        const step = Math.max(10, Math.min(18, (Number(tank.speed) || 90) * 0.16));
        const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
        const targetDistance = movementGoal ? manhattan(next, movementGoal) : 0;
        return {
          dir,
          targetDistance,
          score: targetDistance
            + projectileRisk(ctx, next) * 3
            + (dir === tank.dir ? -TILE * 0.2 : 0)
            + (dir === opposite(tank.dir) ? TILE * 0.5 : 0),
        };
      }).sort((a, b) => a.score - b.score);
      const progressCandidates = candidates.filter((item) => !movementGoal
        || item.targetDistance < currentDistance - 0.5);

      if (interceptEndpoint) {
        const replanned = findPath(ctx, cellOf(tank), [interceptEndpoint]);
        const replanStep = routeStep(ctx, tank, replanned, 1.5, activeTarget, false);
        if (replanStep.dir && ctx.canMove?.(replanStep.dir)
          && !movementBulletThreat(ctx, tank, replanStep.dir, 0.9)) {
          interceptTarget = activeTarget;
          interceptPlan = { ...assignedIntercept, path: replanned, createdAt: now };
          interceptPlanUntil = Math.max(now + 0.35, Number(ctx.globalDirective?.commitUntil) || 0);
          stableRouteTarget = activeTarget;
          stableRouteMapVersion = Number(ctx.mapVersion || 0);
          stableRoute = replanned;
          stableRouteUntil = Math.max(now + 0.45, Number(ctx.globalDirective?.commitUntil) || 0);
          movementTurns = [];
          lastMovementDecisionDir = replanStep.dir;
          mode = "core-intercept-loop-replan";
          return {
            ...action,
            dir: replanStep.dir,
            moveDir: replanStep.dir,
            fire: false,
            hold: false,
            mode,
          };
        }
      }

      stableRouteTarget = null;
      stableRoute = [];
      stableRouteUntil = 0;
      if (!interceptEndpoint) {
        interceptTarget = null;
        interceptPlan = null;
        interceptPlanUntil = now;
      }
      movementTurns = [];
      const progressDir = progressCandidates[0]?.dir || candidates.find((item) => (
        item.dir !== opposite(lastMovementDecisionDir || tank.dir)
      ))?.dir || candidates[0]?.dir || null;
      if (!progressDir) {
        mode = "core-route-loop-replan";
        return { ...action, dir: tank.dir, moveDir: tank.dir, fire: false, hold: true, mode };
      }
      lastMovementDecisionDir = progressDir;
      mode = progressCandidates.length ? "core-route-loop-progress" : "core-route-loop-escape";
      return { ...action, dir: progressDir, moveDir: progressDir, fire: false, hold: false, mode };
    }

    function rememberFreezeMiss(enemy, cell, now) {
      if (!enemy?.alive || !cell) return;
      let cells = freezeMissedCells.get(enemy);
      if (!cells) {
        cells = new Map();
        freezeMissedCells.set(enemy, cells);
      }
      cells.set(keyOf(cell.x, cell.y), now + 2.2);
    }

    function freezeMissedHere(enemy, tank, now) {
      const cell = cellOf(tank);
      return (freezeMissedCells.get(enemy)?.get(keyOf(cell.x, cell.y)) || 0) > now;
    }

    function updateFreezeShotFeedback(now) {
      const dueShots = pendingFreezeShots.filter((item) => now >= item.verifyAt);
      for (const pending of dueShots) {
        if (pending.target?.alive && Number(pending.target.hp) >= pending.hpBefore) {
          failedFreezeTarget = pending.target;
          failedFreezeCell = pending.cell;
          failedFreezeUntil = now + 0.8;
          rememberFreezeMiss(pending.target, pending.cell, now);
          if (pending.target !== target) freezeBlockedTargets.add(pending.target);
        }
      }
      pendingFreezeShots = pendingFreezeShots.filter((item) => now < item.verifyAt && item.target?.alive).slice(-12);
      for (const [enemy, cells] of freezeMissedCells) {
        if (!enemy?.alive) {
          freezeMissedCells.delete(enemy);
          continue;
        }
        for (const [cellKey, expiry] of cells) {
          if (expiry <= now) cells.delete(cellKey);
        }
        if (!cells.size) {
          freezeMissedCells.delete(enemy);
          freezeBlockedTargets.delete(enemy);
        }
      }
      if (now >= failedFreezeUntil) {
        if (failedFreezeTarget) freezeBlockedTargets.delete(failedFreezeTarget);
        failedFreezeTarget = null;
        failedFreezeCell = null;
      }
    }

    function trackFreezeShot(ctx, tank, enemy, now) {
      if (!enemy?.alive || !ctx.canFire?.()) return;
      const shotCell = cellOf(tank);
      if (pendingFreezeShots.some((item) => item.target === enemy
        && item.cell.x === shotCell.x && item.cell.y === shotCell.y && item.verifyAt > now)) return;
      pendingFreezeShots.push({
        target: enemy,
        hpBefore: Number(enemy.hp) || 1,
        cell: shotCell,
        verifyAt: now + Math.max(0.18, manhattan(tank, enemy) / 310 + 0.12),
      });
    }

    function stableContactCombatPlan(ctx, tank, now) {
      const fresh = contactCombatPlan(ctx, tank, target);
      if (!fresh) {
        contactActionTarget = null;
        contactAimDir = null;
        contactAimUntil = 0;
        contactMoveDir = null;
        contactMoveUntil = 0;
        return null;
      }
      if (contactActionTarget !== fresh.enemy) {
        contactActionTarget = fresh.enemy;
        contactAimDir = null;
        contactAimUntil = 0;
        contactMoveDir = null;
        contactMoveUntil = 0;
      }
      if (contactAimDir && now < contactAimUntil
        && ((fresh.pointBlank && contactAimDir === fresh.shot)
          || canHitFromDirection(ctx, tank, fresh.enemy, contactAimDir))) {
        return {
          ...fresh,
          shot: contactAimDir,
          approach: null,
          aimOnly: tank.dir !== contactAimDir || (tank.turnCooldown || 0) > 0,
        };
      }
      if (fresh.shot) {
        contactAimDir = fresh.shot;
        contactAimUntil = now + turnTime(tank.dir, fresh.shot)
          + (fresh.pointBlankContact ? 0.08 : fresh.baseIntruder ? 0.12 : 0.24);
        contactMoveDir = null;
        contactMoveUntil = 0;
        return { ...fresh, aimOnly: false };
      }
      contactAimDir = null;
      contactAimUntil = 0;
      if (contactMoveDir && now < contactMoveUntil && ctx.canMove?.(contactMoveDir)) {
        const currentDistance = manhattan(tank, fresh.enemy);
        const committedDistance = projectedTargetDistance(tank, fresh.enemy, contactMoveDir);
        const freshDistance = projectedTargetDistance(tank, fresh.enemy, fresh.approach);
        const committedMovesAway = fresh.approach && fresh.approach !== contactMoveDir
          && committedDistance > currentDistance + 4
          && committedDistance > freshDistance + 4;
        if (!committedMovesAway) {
          return { ...fresh, shot: null, approach: contactMoveDir, aimOnly: false, committedMove: true };
        }
      }
      contactMoveDir = fresh.approach;
      contactMoveUntil = fresh.approach
        ? now + Math.max(
            fresh.pointBlankContact ? 0.14 : fresh.baseIntruder ? 0.16 : (ctx.freezeTime || 0) > 0 ? 0.42 : 0.3,
            turnTime(tank.dir, fresh.approach) + 0.1,
          )
        : 0;
      return { ...fresh, aimOnly: false };
    }

    function stableEmergencyAim(ctx, tank, now, enemy, freshDir) {
      if (!enemy?.alive || !isBaseEmergency(ctx, enemy)) {
        emergencyAimTarget = null;
        emergencyAimDir = null;
        emergencyAimUntil = 0;
        return null;
      }
      if (emergencyAimTarget !== enemy) {
        emergencyAimTarget = enemy;
        emergencyAimDir = null;
        emergencyAimUntil = 0;
      }
      if (emergencyAimDir && now < emergencyAimUntil
        && canHitFromDirection(ctx, tank, enemy, emergencyAimDir)) {
        return {
          dir: emergencyAimDir,
          aimOnly: tank.dir !== emergencyAimDir || (tank.turnCooldown || 0) > 0,
        };
      }
      if (!freshDir) {
        emergencyAimDir = null;
        emergencyAimUntil = 0;
        return null;
      }
      emergencyAimDir = freshDir;
      emergencyAimUntil = now + turnTime(tank.dir, freshDir) + 0.24;
      return { dir: freshDir, aimOnly: false };
    }

    function finalEnemySearchAction(ctx, tank, enemy, now) {
      if (!enemy?.alive || !inForest(ctx, enemy)) return null;
      const sighting = enemyLastSightings.get(enemy) || null;
      const sightCell = sighting?.cell || null;
      const current = cellOf(tank);
      const mapVersion = Number(ctx.mapVersion || 0);
      const searchCells = forestSearchCells(ctx).filter((cell) =>
        (!sightCell || Math.abs(cell.x - sightCell.x) + Math.abs(cell.y - sightCell.y) <= 6)
          && Number.isFinite(tileCost(ctx, cell.x, cell.y)));
      if (!searchCells.length && sightCell && Number.isFinite(tileCost(ctx, sightCell.x, sightCell.y))) {
        searchCells.push({ ...sightCell });
      }
      if (!searchCells.length) return null;
      searchCells.sort((a, b) => {
        const origin = sightCell || current;
        return (Math.abs(a.x - origin.x) + Math.abs(a.y - origin.y))
          - (Math.abs(b.x - origin.x) + Math.abs(b.y - origin.y))
          || a.y - b.y
          || a.x - b.x;
      });
      const waypointReached = finalSearchWaypoint
        && current.x === finalSearchWaypoint.x && current.y === finalSearchWaypoint.y;
      const waypointValid = finalSearchWaypoint && searchCells.some((cell) =>
        cell.x === finalSearchWaypoint.x && cell.y === finalSearchWaypoint.y);
      if (finalSearchEnemy !== enemy || finalSearchMapVersion !== mapVersion || !waypointValid || waypointReached) {
        if (finalSearchEnemy !== enemy || finalSearchMapVersion !== mapVersion) finalSearchStep = 0;
        const allyOffset = name === "2P" ? Math.floor(searchCells.length / 2) : 0;
        finalSearchWaypoint = searchCells[(allyOffset + finalSearchStep * 3) % searchCells.length];
        finalSearchStep++;
        finalSearchEnemy = enemy;
        finalSearchMapVersion = mapVersion;
      }
      const path = finalSearchWaypoint ? findPath(ctx, current, [finalSearchWaypoint]) : [];
      const route = routeStep(ctx, tank, path, 1.5, null, false);
      if (path.length) publishRoute(ctx, tank, path);

      const nearSearchArea = inForest(ctx, tank) || Boolean(sightCell
        && Math.abs(current.x - sightCell.x) + Math.abs(current.y - sightCell.y) <= 3);
      const phase = Math.floor(now / 0.35) + (name === "2P" ? 2 : 0);
      const sweepOrder = DIR_NAMES.map((_, index) => DIR_NAMES[(phase + index) % DIR_NAMES.length]);
      const startsInForest = (ctx.tileAt?.(current.x, current.y) ?? ctx.map?.[current.y]?.[current.x]) === "F";
      const sweepDir = nearSearchArea && ctx.canFire?.()
        ? sweepOrder.find((dir) => {
          const d = DIRS[dir];
          const from = center(tank);
          const allyInLane = (ctx.friends || []).some((ally) => {
            if (!ally?.alive) return false;
            const to = center(ally);
            const axial = (to.x - from.x) * d.x + (to.y - from.y) * d.y;
            const lateral = Math.abs((to.x - from.x) * -d.y + (to.y - from.y) * d.x);
            return axial > 0 && axial <= TILE * 7 && lateral < TILE * 0.65;
          });
          const sweepProbe = {
            x: tank.x + d.x * TILE * 5,
            y: tank.y + d.y * TILE * 5,
            w: tank.w,
            h: tank.h,
          };
          if (allyInLane || firstShotObstacle(ctx, tank, dir, sweepProbe)) return false;
          if (startsInForest) return true;
          for (let distance = 1; distance <= 5; distance++) {
            const x = current.x + d.x * distance;
            const y = current.y + d.y * distance;
            if ((ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x]) === "F") return true;
          }
          return false;
        })
        : null;
      if (sweepDir) {
        return {
          dir: sweepDir,
          moveDir: route.dir || undefined,
          fire: true,
          hold: !route.dir,
          mode: "core-final-search-sweep",
          target: null,
        };
      }
      if (route.dir) {
        return {
          dir: route.dir,
          fire: false,
          hold: false,
          mode: route.aligning ? "core-final-search-align" : "core-final-search",
          target: null,
        };
      }
      const explore = DIR_NAMES[(phase + finalSearchStep) % DIR_NAMES.length];
      if (ctx.canMove?.(explore)) {
        return { dir: explore, fire: false, hold: false, mode: "core-final-search-explore", target: null };
      }
      return { dir: tank.dir, fire: false, hold: true, mode: "core-final-search-replan", target: null };
    }

    function shouldSwitchTarget(ctx, tank, next, now) {
      if (!next?.alive || next === target) return false;
      const visible = visibleEnemies(ctx);
      if (!target?.alive || !visible.includes(target)) return true;
      const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
      const friendTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
      const duplicate = (reserved.has(target) || friendTargets.has(target))
        && manhattan(tank, target) > TILE * 2.2;
      const currentPriority = targetPriority(ctx, tank, target);
      const nextPriority = targetPriority(ctx, tank, next);
      const currentContact = currentPriority.tankDistance <= TILE * 2.2;
      const nextContact = nextPriority.tankDistance <= TILE * 2.2;
      if (nextPriority.directBaseShot && !currentPriority.directBaseShot) return true;
      if (nextPriority.directBaseShot && currentPriority.directBaseShot
        && nextPriority.directBaseShot.eta + 0.25 < currentPriority.directBaseShot.eta) return true;
      if (nextPriority.fastApproach && !currentPriority.fastApproach
        && nextPriority.baseEta + 0.45 < currentPriority.baseEta) return true;
      if (nextPriority.verticalRush && !currentPriority.verticalRush) return true;
      if (nextPriority.verticalRush && currentPriority.verticalRush
        && nextPriority.verticalRush.eta + 0.65 < currentPriority.verticalRush.eta) return true;
      if (nextContact && !currentContact
        && (nextPriority.tier <= currentPriority.tier || !isBaseEmergency(ctx, target))) return true;
      if (nextPriority.crossed && !currentPriority.crossed) return true;
      if (nextPriority.crossed && currentPriority.crossed
        && (nextPriority.baseEta + 0.45 < currentPriority.baseEta
          || nextPriority.baseDistance + TILE * 0.75 < currentPriority.baseDistance)) return true;
      if (nextPriority.tier < currentPriority.tier) return true;
      if (nextPriority.tier === 0 && currentPriority.tier === 0
        && (nextPriority.baseEta + 0.55 < currentPriority.baseEta
          || (nextPriority.baseDistance + TILE * 1.5 < currentPriority.baseDistance
            && nextPriority.baseEta <= currentPriority.baseEta + 0.2))) return true;
      if (duplicate && visible.length > 1) return true;
      if (now < targetLockUntil) return false;
      if (nextPriority.tier !== currentPriority.tier) return false;
      if (nextPriority.tier === 0) {
        return nextPriority.baseEta + 0.75 < currentPriority.baseEta
          || nextPriority.baseDistance + TILE * 1.75 < currentPriority.baseDistance;
      }
      if (nextPriority.tier === 1) return nextPriority.tankDistance + TILE * 1.75 < currentPriority.tankDistance;
      return nextPriority.baseDistance + TILE * 2.5 < currentPriority.baseDistance;
    }

    function assignedBreakthroughTarget(ctx, tank) {
      const defenders = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive);
      const defenderOrder = (ally) => ally.kind === "player" ? 0 : ally.kind === "player2" ? 1 : 2;
      const defenderName = (ally) => ally.kind === "player" ? "1P" : ally.kind === "player2" ? "2P" : null;
      return visibleEnemies(ctx).filter((enemy) => crossedMidline(ctx, enemy))
        .filter((enemy) => {
          const owner = breakthroughAssignments.get(enemy);
          if (owner && !defenders.some((ally) => defenderName(ally) === owner)) {
            breakthroughAssignments.delete(enemy);
          }
          const activeOwner = breakthroughAssignments.get(enemy);
          if (activeOwner) return activeOwner === name;
          return defenders.slice().sort((a, b) =>
            manhattan(a, enemy) - manhattan(b, enemy)
            || defenderOrder(a) - defenderOrder(b))[0] === tank;
        })
        .map((enemy) => ({
          enemy,
          attackEta: estimatedDirectBaseAttackEta(ctx, enemy),
          baseDistance: manhattan(enemy, ctx.base),
          tankDistance: manhattan(tank, enemy),
        })).sort((a, b) =>
          a.attackEta - b.attackEta
          || a.baseDistance - b.baseDistance
          || a.tankDistance - b.tankDistance)[0]?.enemy || null;
    }

    function retainTargetUntilDestroyed(ctx, tank, now) {
      const directBaseAttacker = assignedDirectBaseAttacker(ctx, tank);
      if (directBaseAttacker?.alive) {
        if (target !== directBaseAttacker) setTarget(directBaseAttacker, now + 2.2, true);
        targetLockUntil = Math.max(targetLockUntil, now + 2.2);
        closeLockUntil = Math.max(closeLockUntil, now + 0.9);
        return true;
      }
      const fastApproach = assignedFastApproachThreat(ctx, tank);
      if (fastApproach?.alive) {
        if (target !== fastApproach) setTarget(fastApproach, now + 1.5, true);
        targetLockUntil = Math.max(targetLockUntil, now + 1.5);
        closeLockUntil = Math.max(closeLockUntil, now + 0.7);
        return true;
      }
      const localBreakthrough = nearestLocalBreakthrough(ctx, tank, breakthroughCommitTarget || target);
      if (localBreakthrough?.alive) {
        breakthroughCommitTarget = localBreakthrough;
        if (target !== localBreakthrough) setTarget(localBreakthrough, now + 1.2, true);
        targetLockUntil = Math.max(targetLockUntil, now + 1.2);
        closeLockUntil = Math.max(closeLockUntil, now + 0.75);
        return true;
      }
      const targetOwner = target?.alive && crossedMidline(ctx, target)
        ? breakthroughAssignments.get(target)
        : null;
      if (targetOwner && targetOwner !== name) setTarget(null, null, true);

      const breakthrough = assignedBreakthroughTarget(ctx, tank);
      if (breakthrough) {
        const committedStillUrgent = breakthroughCommitTarget?.alive
          && (crossedMidline(ctx, breakthroughCommitTarget) || isBaseEmergency(ctx, breakthroughCommitTarget));
        const shouldReplaceCommit = !committedStillUrgent
          || breakthrough === breakthroughCommitTarget
          || shouldSwitchTarget(ctx, tank, breakthrough, now);
        if (!shouldReplaceCommit && breakthroughCommitTarget?.alive) {
          if (target !== breakthroughCommitTarget) setTarget(breakthroughCommitTarget, now + 0.8, true);
          targetLockUntil = Math.max(targetLockUntil, now + 0.8);
          return true;
        }
        breakthroughCommitTarget = breakthrough;
        breakthroughAssignments.set(breakthrough, name);
        setTarget(breakthrough, now + 1.1, true);
        closeLockUntil = now + 0.55;
        return true;
      }

      if (breakthroughCommitTarget?.alive
        && (crossedMidline(ctx, breakthroughCommitTarget) || isBaseEmergency(ctx, breakthroughCommitTarget))) {
        if (target !== breakthroughCommitTarget) setTarget(breakthroughCommitTarget, now + 0.8, true);
        targetLockUntil = Math.max(targetLockUntil, now + 0.8);
        closeLockUntil = Math.max(closeLockUntil, now + 0.55);
        return true;
      }
      breakthroughCommitTarget = null;

      const centralApproach = assignedCentralApproachThreat(ctx, tank);
      if (centralApproach?.alive) {
        if (target === centralApproach || !target?.alive || shouldSwitchTarget(ctx, tank, centralApproach, now)) {
          if (target !== centralApproach) setTarget(centralApproach, now + 0.9, true);
          targetLockUntil = Math.max(targetLockUntil, now + 0.9);
          closeLockUntil = Math.max(closeLockUntil, now + 0.55);
          return true;
        }
      }

      if (target?.alive) return false;

      if (target) setTarget(null, null, true);
      const visible = visibleEnemies(ctx);
      const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
      for (const ally of ctx.friends || []) {
        if (ally?.attackTarget?.alive) reserved.add(ally.attackTarget);
      }
      const ranked = visible.map((enemy) => ({
        enemy,
        arrivalEta: estimatedDirectBaseAttackEta(ctx, enemy),
        baseDistance: manhattan(enemy, ctx.base),
        tankDistance: manhattan(tank, enemy),
      })).sort((a, b) =>
        a.arrivalEta - b.arrivalEta
        || a.baseDistance - b.baseDistance
        || a.tankDistance - b.tankDistance);
      const next = ranked.find(({ enemy }) => !reserved.has(enemy))?.enemy
        || ranked[0]?.enemy
        || null;
      if (next) {
        setTarget(next, now + 2, true);
        closeLockUntil = now + 0.8;
      }
      return true;
    }

    function selectStableTarget(ctx, tank, now) {
      // Route recovery may replace a path, never the combat mission.
      const directive = ctx.globalDirective || null;
      if (directive) {
        const assigned = directive.target?.alive ? directive.target : null;
        if (missionTarget !== assigned) {
          setTarget(assigned, directive.commitUntil, true, true);
        } else if (!target?.alive && assigned) {
          setTarget(assigned, directive.commitUntil, true);
        }
        if (assigned) {
          targetLockUntil = Math.max(targetLockUntil, directive.commitUntil || now + 0.8);
          closeLockUntil = Math.max(closeLockUntil, now + (directive.emergency ? 0.8 : 0.45));
          if (crossedMidline(ctx, assigned)) {
            breakthroughCommitTarget = assigned;
            breakthroughAssignments.set(assigned, name);
          } else if (breakthroughCommitTarget !== assigned) {
            breakthroughCommitTarget = null;
          }
        }
        const tacticalCandidates = allVisibleEnemies(ctx).map((enemy) => ({
          enemy,
          distance: manhattan(tank, enemy),
          direct: directBaseShotThreat(ctx, enemy),
          emergency: isBaseEmergency(ctx, enemy),
        // The global planner already assigns every non-contact base threat
        // using both allies' lethal ETAs. Re-adding all urgent enemies here
        // made both controllers steal the same target and left another lane
        // uncovered. Only physical contact may override an assignment locally.
        })).filter((item) => item.enemy === assigned || item.distance <= TILE * 2.2)
          .sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
            || Number(b.emergency) - Number(a.emergency)
            || (a.direct?.eta ?? Infinity) - (b.direct?.eta ?? Infinity)
            || a.distance - b.distance);
        const tactical = tacticalCandidates[0]?.enemy || null;
        if (tactical && tactical !== target) {
          setTarget(tactical, now + (tacticalCandidates[0].direct ? 1.1 : 0.65), true);
        } else if (target?.alive && target !== assigned) {
          const stillTactical = tacticalCandidates.some((item) => item.enemy === target);
          if (!stillTactical) setTarget(assigned, directive.commitUntil, true);
        }
        return;
      }
      if (retainTargetUntilDestroyed(ctx, tank, now)) return;
      const visible = visibleEnemies(ctx);
      const reserved = new Set((ctx.reservedTargets || []).filter((item) => item?.alive));
      const friendTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
      const mortalThreats = rankedMortalBaseThreats(ctx);
      const sharedThreat = mortalThreats.find((item) => item.share);
      const forcedThreat = ctx.forcedTarget?.alive && visible.includes(ctx.forcedTarget)
        ? mortalBaseThreat(ctx, ctx.forcedTarget)
        : null;
      const emergencyThreat = sharedThreat || forcedThreat || mortalThreats[0] || null;
      if (emergencyThreat && emergencyThreat.enemy !== target) {
        const currentThreat = mortalBaseThreat(ctx, target);
        const directUpgrade = emergencyThreat.direct && (
          !currentThreat?.direct
          || emergencyThreat.direct.eta + 0.35 < currentThreat.direct.eta
        );
        const terminalUpgrade = emergencyThreat.share && !currentThreat?.share;
        const overwhelmingUpgrade = currentThreat
          && emergencyThreat.baseDistance + TILE * 1.5 < currentThreat.baseDistance
          && emergencyThreat.eta + 0.6 < currentThreat.eta;
        const clearlyMoreUrgent = !currentThreat
          || directUpgrade
          || terminalUpgrade
          || overwhelmingUpgrade;
        if (clearlyMoreUrgent) {
          setTarget(emergencyThreat.enemy, now + (emergencyThreat.share ? 0.8 : 1.1), true);
          closeLockUntil = now + 0.8;
          return;
        }
      }
      if (target?.alive) {
        const targetVisible = visible.includes(target);
        const currentMortal = mortalBaseThreat(ctx, target);
        const duplicate = visible.length > 1 && (reserved.has(target) || friendTargets.has(target))
          && manhattan(tank, target) > TILE * 2.2
          && !currentMortal?.share
          && !currentMortal?.direct;
        if (!targetVisible || duplicate) {
          setTarget(null, null, true);
          targetLockUntil = 0;
          closeLockUntil = 0;
        }
      }
      const sideLaneTarget = assignedSideLaneTarget(ctx, tank, target);
      const currentOffSide = target?.alive && !onAssignedSide(ctx, tank, target);
      const currentCanHandOff = currentOffSide
        && !isBaseEmergency(ctx, target)
        && manhattan(tank, target) > TILE * 2.2;
      if (sideLaneTarget?.alive && (!target?.alive || currentCanHandOff)) {
        setTarget(sideLaneTarget, now + 1.25, true);
        closeLockUntil = Math.max(closeLockUntil, now + 0.65);
        return;
      }
      const assignedThreat = assignedBaseThreat(ctx, tank, target, null);
      const assignedDirectThreat = assignedThreat && directBaseShotThreat(ctx, assignedThreat);
      if (assignedDirectThreat) {
        if (assignedThreat !== target) setTarget(assignedThreat, now + 1.8, true);
        else targetLockUntil = Math.max(targetLockUntil, now + 1.1);
        closeLockUntil = Math.max(closeLockUntil, now + 0.9);
        return;
      }
      const contactThreat = visible.map((enemy) => ({ enemy, distance: manhattan(tank, enemy) }))
        .filter((item) => item.distance <= TILE * 2.2)
        .sort((a, b) => a.distance - b.distance)[0]?.enemy || null;
      if (contactThreat) {
        if (contactThreat !== target && shouldSwitchTarget(ctx, tank, contactThreat, now)) {
          setTarget(contactThreat, now + 0.9, true);
        } else if (contactThreat === target) {
          targetLockUntil = Math.max(targetLockUntil, now + 0.45);
        }
        closeLockUntil = Math.max(closeLockUntil, now + 0.9);
        return;
      }
      const duplicateTarget = target?.alive && reserved.has(target) && visible.length > 1
        && target !== assignedThreat && manhattan(tank, target) > TILE * 2.2;
      if (duplicateTarget) {
        setTarget(null, null, true);
        targetLockUntil = 0;
        closeLockUntil = 0;
      }
      const finalThreat = assignedThreat || lastLineThreat(ctx, tank);
      if (finalThreat) {
        const currentStillCritical = target?.alive && isBaseEmergency(ctx, target);
        const currentReserved = currentStillCritical && reserved.has(target);
        const currentPriority = currentStillCritical ? targetPriority(ctx, tank, target) : null;
        const nextPriority = targetPriority(ctx, tank, finalThreat);
        const assignmentUpgrade = assignedThreat && finalThreat === assignedThreat && target !== assignedThreat;
        const directUpgrade = nextPriority.directBaseShot && !currentPriority?.directBaseShot;
        const crossedUpgrade = nextPriority.crossed && !currentPriority?.crossed;
        const deeperCrossedUpgrade = nextPriority.crossed && currentPriority?.crossed
          && nextPriority.baseDistance + TILE * 1.25 < currentPriority.baseDistance;
        const urgentUpgrade = currentPriority && (
          assignmentUpgrade
          || directUpgrade
          || crossedUpgrade
          || deeperCrossedUpgrade
          || nextPriority.baseEta + 1.4 < currentPriority.baseEta
          || nextPriority.baseDistance + TILE * 3.5 < currentPriority.baseDistance
        );
        if (finalThreat === target) {
          targetLockUntil = Math.max(targetLockUntil, now + 0.85);
          closeLockUntil = Math.max(closeLockUntil, now + 0.65);
        } else if (currentStillCritical && !currentReserved && !urgentUpgrade) {
          targetLockUntil = Math.max(targetLockUntil, now + 0.9);
          closeLockUntil = Math.max(closeLockUntil, now + 0.65);
        } else if (urgentUpgrade || !(currentStillCritical && now < targetLockUntil)) {
          setTarget(finalThreat, now + 1.6, true);
          closeLockUntil = now + 1.2;
        }
        return;
      }
      const immediate = nearestImmediateEnemy(ctx, tank);
      if (immediate) {
        const currentVisible = target?.alive && visibleEnemies(ctx).includes(target);
        const currentDistance = currentVisible ? manhattan(tank, target) : Infinity;
        const immediateDistance = manhattan(tank, immediate);
        const currentCritical = currentVisible && isBaseEmergency(ctx, target);
        const immediateCritical = isBaseEmergency(ctx, immediate);
        const keepCurrent = immediate !== target
          && currentVisible
          && currentDistance <= TILE * 3.8
          && now < closeLockUntil
          && (!immediateCritical || currentCritical)
          && immediateDistance + TILE * 0.75 >= currentDistance;
        if (keepCurrent) return;
        if (immediate === target || shouldSwitchTarget(ctx, tank, immediate, now)) {
          if (immediate !== target) setTarget(immediate, now + 0.8, true);
          else targetLockUntil = Math.max(targetLockUntil, now + 0.8);
          closeLockUntil = now + 0.8;
        }
        return;
      }
      const forcedTarget = ctx.forcedTarget?.alive && visible.includes(ctx.forcedTarget)
        && (!reserved.has(ctx.forcedTarget) || visible.length === 1)
        ? ctx.forcedTarget
        : null;
      if (forcedTarget && forcedTarget !== target && shouldSwitchTarget(ctx, tank, forcedTarget, now)) {
        setTarget(forcedTarget, now + 0.9, true);
        closeLockUntil = now + 0.9;
        return;
      }
      if (targetRouteMapVersion !== Number(ctx.mapVersion || 0)) {
        targetRouteCosts.clear();
        targetRouteMapVersion = Number(ctx.mapVersion || 0);
      }
      const tankCell = cellOf(tank);
      const routeCostFor = (enemy) => {
        if (directShot(ctx, tank, enemy)) return 0;
        const enemyCell = cellOf(enemy);
        const cacheKey = `${tankCell.x},${tankCell.y}:${enemyCell.x},${enemyCell.y}`;
        if (targetRouteCosts.has(cacheKey)) return targetRouteCosts.get(cacheKey);
        const goals = pursuitGoals(ctx, enemy);
        const workerResult = requestWorkerDistanceField(ctx, goals);
        const fieldCost = workerResult.field?.[tankCell.y * ctx.cols + tankCell.x];
        let cost;
        let cacheCost = true;
        if (Number.isFinite(fieldCost)) {
          cost = fieldCost;
        } else if (workerResult.available) {
          cacheCost = false;
          cost = goals.length
            ? Math.min(...goals.map((goal) => Math.abs(goal.x - tankCell.x) + Math.abs(goal.y - tankCell.y)))
            : 1000;
        } else {
          const path = findPath(ctx, tankCell, goals);
          cost = path.length ? path.length - 1 : 1000;
        }
        if (cacheCost) targetRouteCosts.set(cacheKey, cost);
        if (targetRouteCosts.size > 96) targetRouteCosts.delete(targetRouteCosts.keys().next().value);
        return cost;
      };
      const candidate = chooseTarget(ctx, tank, routeCostFor);
      if (candidate?.alive && manhattan(candidate, ctx.base) <= TILE * 4 && candidate !== target
        && (!target?.alive || shouldSwitchTarget(ctx, tank, candidate, now))) {
        setTarget(candidate, now + 1.5, true);
        closeLockUntil = now + 1.2;
        return;
      }
      if (target?.alive && manhattan(tank, target) <= TILE * 4.5) {
        closeLockUntil = now + 0.8;
        return;
      }
      if (target?.alive && directShot(ctx, tank, target)) {
        targetLockUntil = now + 0.4;
        return;
      }
      if (target?.alive && now < closeLockUntil) return;
      if (!target?.alive || !candidate) {
        setTarget(candidate, now + 0.9);
        return;
      }
      if (candidate === target) return;
      const candidatePriority = targetPriority(ctx, tank, candidate);
      const currentPriority = targetPriority(ctx, tank, target);
      const higherTier = candidatePriority.tier < currentPriority.tier;
      const clearlyCloser = candidatePriority.tier === currentPriority.tier
        && (candidatePriority.tier === 1
          ? candidatePriority.tankDistance + TILE * 1.75 < currentPriority.tankDistance
          : candidatePriority.tier === 0
            ? candidatePriority.baseEta + 1.1 < currentPriority.baseEta
            : candidatePriority.baseDistance + TILE * 2 < currentPriority.baseDistance);
      const currentUnreachable = now >= targetLockUntil
        && routeCostFor(target) >= 1000
        && routeCostFor(candidate) < 1000;
      if (higherTier || clearlyCloser || currentUnreachable) {
        setTarget(candidate, now + 1.1, true);
      }
    }

    function stablePath(ctx, tank, goals, now, routeCommit = 0) {
      const current = cellOf(tank);
      const mapVersion = Number(ctx.mapVersion || 0);
      const goalKeys = new Set(goals.map((goal) => keyOf(goal.x, goal.y)));
      const cachedEndpoint = stableRoute.at(-1);
      const cachedEndpointValid = Boolean(cachedEndpoint && goalKeys.has(keyOf(cachedEndpoint.x, cachedEndpoint.y)));
      const cachedRouteValid = stableRoute.every((cell, index) =>
        index === 0 || Number.isFinite(tileCost(ctx, cell.x, cell.y)));
      const cachedIndex = stableRoute.findIndex((cell) => cell.x === current.x && cell.y === current.y);
      const cachedTail = stableRouteTarget === target && stableRouteMapVersion === mapVersion
        && cachedRouteValid && cachedEndpointValid && cachedIndex >= 0
        ? stableRoute.slice(cachedIndex)
        : [];
      if (stableRouteTarget === target && stableRouteMapVersion === mapVersion
        && now < stableRouteUntil && cachedRouteValid && cachedEndpointValid) {
        if (cachedTail.length) return cachedTail;
      }
      stableRouteTarget = target;
      stableRouteMapVersion = mapVersion;
      stableRouteUntil = now + (routeCommit > 0
        ? routeCommit
        : target && manhattan(tank, target) <= TILE * 6 ? 0.22 : 0.32);
      const replannedRoute = findPath(ctx, current, goals);
      stableRoute = replannedRoute.length ? replannedRoute : cachedTail;
      if (!replannedRoute.length && cachedTail.length > 1) stableRouteUntil = now + 0.12;
      return stableRoute;
    }

    function publishActionRoute(ctx, tank, actionTarget, now) {
      if (!actionTarget?.alive || ctx.plannedRoute?.length) return;
      const current = cellOf(tank);
      if (currentPositionShot(ctx, tank, actionTarget)) {
        publishRoute(ctx, tank, [current]);
        return;
      }
      const mapVersion = Number(ctx.mapVersion || 0);
      const cachedIndex = displayRoute.findIndex((cell) => cell.x === current.x && cell.y === current.y);
      const cachedTail = displayRouteTarget === actionTarget && displayRouteMapVersion === mapVersion && cachedIndex >= 0
        ? displayRoute.slice(cachedIndex)
        : [];
      if (cachedTail.length && now < displayRouteUntil) {
        publishRoute(ctx, tank, cachedTail);
        return;
      }
      const stableIndex = stableRouteTarget === actionTarget
        ? stableRoute.findIndex((cell) => cell.x === current.x && cell.y === current.y)
        : -1;
      const stableTail = stableIndex >= 0 ? stableRoute.slice(stableIndex) : [];
      const plannedFreezeRoute = freezePlanCache?.enemy === actionTarget && freezePlanCache.path?.length
        ? freezePlanCache.path
        : [];
      const goals = (ctx.freezeTime || 0) > 0
        ? freezeShotGoals(ctx, actionTarget).map(({ x, y }) => ({ x, y }))
        : [...attackGoals(ctx, actionTarget), ...pursuitGoals(ctx, actionTarget)];
      const route = plannedFreezeRoute.length
        ? plannedFreezeRoute
        : stableTail.length ? stableTail : findPath(ctx, current, goals);
      displayRouteTarget = actionTarget;
      displayRouteMapVersion = mapVersion;
      displayRoute = route;
      displayRouteUntil = now + 0.28;
      if (route.length) publishRoute(ctx, tank, route);
    }

    function breakthroughPursuitAction(ctx, tank, now) {
      const enemy = breakthroughCommitTarget?.alive && crossedMidline(ctx, breakthroughCommitTarget)
        ? breakthroughCommitTarget
        : null;
      if (!enemy || target !== enemy) return null;
      targetLockUntil = Math.max(targetLockUntil, now + 1.8);
      closeLockUntil = Math.max(closeLockUntil, now + 0.8);

      const distance = manhattan(tank, enemy);
      const shot = currentPositionShot(ctx, tank, enemy)
        || directShot(ctx, tank, enemy)
        || pointBlankShot(ctx, tank, enemy, distance);
      if (shot) {
        tacticalState = "ENGAGE";
        stateUntil = now + 0.4;
        mode = ctx.canFire?.() ? "core-breakthrough-fire" : "core-breakthrough-reload";
        publishRoute(ctx, tank, [cellOf(tank)]);
        return aimedFireAction(ctx, tank, shot, mode, enemy, true);
      }

      if (distance <= TILE * 3.5) {
        const contact = contactCombatPlan(ctx, tank, enemy);
        if (contact?.shot) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.32;
          mode = ctx.canFire?.() ? "core-breakthrough-contact-fire" : "core-breakthrough-contact-reload";
          publishRoute(ctx, tank, [cellOf(tank)]);
          return aimedFireAction(ctx, tank, contact.shot, mode, enemy, true);
        }
        if (contact?.approach) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.28;
          mode = "core-breakthrough-contact-approach";
          return { dir: contact.approach, moveScale: 1, fire: false, hold: false, mode, target: enemy };
        }
      }

      const goals = [
        ...baseEmergencyMeleeGoals(ctx, enemy),
        ...closeCombatGoals(ctx, tank, enemy),
        ...pursuitGoals(ctx, enemy),
      ];
      const current = cellOf(tank);
      const globalPath = ctx.globalDirective?.target === enemy && ctx.globalDirective.intercept?.emergencyShield
        ? ctx.globalDirective.intercept.path || []
        : [];
      const globalIndex = globalPath.findIndex((cell) => cell.x === current.x && cell.y === current.y);
      const committedPath = globalIndex >= 0 ? globalPath.slice(globalIndex) : [];
      const path = committedPath.length
        ? committedPath
        : stablePath(ctx, tank, goals, now, isBaseIntruder(ctx, enemy) ? 0.22 : 0.42);
      publishRoute(ctx, tank, path);
      const step = routeStep(ctx, tank, path, 3.5, enemy, true);
      if (step.dir) {
        const next = path[1];
        const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
        if (!step.aligning && nextTile === "B") {
          mode = "core-breakthrough-clear";
          return aimedFireAction(ctx, tank, step.dir, mode, enemy);
        }
        if (step.aligning) {
          mode = "core-breakthrough-align";
          return { dir: step.dir, fire: false, hold: false, mode, target: enemy };
        }
        if (ctx.canMove?.(step.dir)) {
          tacticalState = "CHASE";
          stateUntil = now + 0.45;
          mode = "core-breakthrough-chase";
          return { dir: step.dir, moveScale: 1, fire: false, hold: false, mode, target: enemy };
        }
      }

      stableRouteTarget = null;
      stableRoute = [];
      stableRouteUntil = 0;
      const brickDir = routeBrickDirection(ctx, tank, enemy);
      if (brickDir) {
        mode = "core-breakthrough-clear";
        return aimedFireAction(ctx, tank, brickDir, mode, enemy);
      }
      const recovery = recoveryDirection(ctx, tank, enemy, goals);
      const enemyCenter = center(enemy);
      const baseCenter = center(ctx.base);
      const shieldPoint = {
        x: enemyCenter.x * 0.58 + baseCenter.x * 0.42,
        y: enemyCenter.y * 0.58 + baseCenter.y * 0.42,
      };
      const localShieldDir = recovery || DIR_NAMES.filter((dir) => ctx.canMove?.(dir)).map((dir) => {
        const d = DIRS[dir];
        const stepDistance = Math.max(8, Math.min(14, (Number(tank.speed) || 90) * 0.12));
        const next = { ...tank, x: tank.x + d.x * stepDistance, y: tank.y + d.y * stepDistance };
        const nextCenter = center(next);
        return {
          dir,
          score: Math.abs(nextCenter.x - shieldPoint.x) + Math.abs(nextCenter.y - shieldPoint.y)
            + manhattan(next, enemy) * 0.28
            + projectileRisk(ctx, next) * 2.5
            + (dir === opposite(tank.dir) ? TILE * 0.45 : 0),
        };
      }).sort((a, b) => a.score - b.score)[0]?.dir || null;
      mode = localShieldDir ? "core-breakthrough-recover" : "core-breakthrough-replan";
      return { dir: localShieldDir || tank.dir, fire: false, hold: !localShieldDir, mode, target: enemy };
    }

    function terminalBaseDefenseAction(ctx, tank, now) {
      const candidates = (ctx.globalThreats || []).filter((item) => item.enemy?.alive
        && item.defenseTier <= 1
        && manhattan(tank, item.enemy) <= TILE * 4.5)
        .sort((a, b) => a.defenseTier - b.defenseTier
          || a.responseDeadline - b.responseDeadline
          || manhattan(tank, a.enemy) - manhattan(tank, b.enemy));
      if (!candidates.length) return null;
      const assignedTarget = ctx.globalDirective?.target?.alive
        ? ctx.globalDirective.target
        : null;
      const assignedIntruder = candidates.find((item) => item.enemy === assignedTarget) || null;
      const pointBlankIntruder = candidates.filter((item) =>
        manhattan(tank, item.enemy) <= TILE * 2.2 || bodyGap(tank, item.enemy) <= TILE * 0.45)[0] || null;
      const terminalBaseThreats = candidates.filter((item) =>
        item.direct?.target === "base" && item.direct.eta <= 1.1);
      const sharedTerminal = terminalBaseThreats.length === 1 ? terminalBaseThreats[0] : null;
      const teammateTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget)
        .filter((enemy) => enemy?.alive));
      const reservedTargets = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
      const unclaimedIntruder = candidates.find((item) =>
        !teammateTargets.has(item.enemy) && !reservedTargets.has(item.enemy)) || null;
      const intruder = pointBlankIntruder || sharedTerminal || assignedIntruder || unclaimedIntruder;
      if (!intruder) return null;
      if (target !== intruder.enemy) setTarget(intruder.enemy, now + 1.4, true);
      targetLockUntil = Math.max(targetLockUntil, now + 1.4);
      closeLockUntil = Math.max(closeLockUntil, now + 0.8);
      const contact = stableContactCombatPlan(ctx, tank, now);
      if (contact?.shot) {
        tacticalState = "ENGAGE";
        stateUntil = now + 0.24;
        mode = ctx.canFire?.() ? "core-terminal-base-melee-fire" : "core-terminal-base-melee-reload";
        return aimedFireAction(ctx, tank, contact.shot, mode, intruder.enemy, true);
      }
      if (contact?.approach) {
        tacticalState = "ENGAGE";
        stateUntil = now + 0.2;
        mode = "core-terminal-base-melee-approach";
        return {
          dir: contact.approach,
          moveDir: contact.approach,
          moveScale: 1,
          fire: false,
          hold: false,
          mode,
          target: intruder.enemy,
        };
      }
      return null;
    }

    function incomingBulletAction(ctx, tank, bullet, now, preferredTarget, crossingOnly = false) {
      if (!bullet?.enemy || bullet.dead) return null;
      const threat = bulletThreat(ctx, tank, bullet, 3.4);
      // A route-crossing warning does not mean the stationary tank is in danger.
      // Cancel that movement instead of inventing another direction into the shot.
      if (crossingOnly && !threat) {
        const targetShot = preferredTarget?.alive ? directShot(ctx, tank, preferredTarget) : null;
        if (targetShot && ctx.canFire?.()) {
          tacticalState = "ENGAGE";
          evadeDir = null;
          stateUntil = now + 0.16;
          mode = "core-predictive-counter-fire";
          return aimedFireAction(ctx, tank, targetShot, mode, preferredTarget, true);
        }
        const detour = predictiveDetourDirection(ctx, tank, preferredTarget);
        if (detour) {
          tacticalState = "EVADE";
          evadeDir = detour;
          stateUntil = now + 0.2;
          mode = "core-predictive-bullet-detour";
          return { dir: detour, fire: false, hold: false, mode, target: preferredTarget };
        }
        tacticalState = "EVADE";
        evadeDir = null;
        stateUntil = now + 0.06;
        mode = "core-predictive-bullet-yield";
        return { dir: tank.dir, fire: false, hold: true, mode, target: preferredTarget };
      }
      // When the same shell also threatens the stationary tank, this is no
      // longer merely a route-crossing warning. Run the full counter/dodge
      // chain so close shells can be shot down or escaped normally.
      crossingOnly = false;
      const shooter = bullet.owner?.alive ? bullet.owner : null;
      const shooterShot = shooter ? directShot(ctx, tank, shooter) : null;
      const counterDir = shooterShot === opposite(bullet.dir) ? shooterShot : null;
      const counterTurnDelay = counterDir
        ? (tank.dir === counterDir
          ? Math.max(0, Number(tank.turnCooldown) || 0)
          : Math.max(turnTime(tank.dir, counterDir), Number(tank.turnCooldown) || 0))
        : Infinity;
      const canCounterInTime = Boolean(threat && counterDir && ctx.canFire?.()
        && threat.eta >= counterTurnDelay + 0.12);
      const criticalCounter = Boolean(!crossingOnly && threat && counterDir && ctx.canFire?.()
        && tank.dir === counterDir && (Number(tank.turnCooldown) || 0) <= 0);

      if (!crossingOnly && canCounterInTime) {
        tacticalState = "ENGAGE";
        evadeDir = null;
        stateUntil = now + Math.max(0.32, Math.min(0.55, threat.eta * 0.45));
        mode = tank.dir === counterDir && (Number(tank.turnCooldown) || 0) <= 0
          ? "core-counter-fire"
          : "core-counter-aim";
        return { dir: counterDir, fire: true, hold: true, mode, target: shooter };
      }

      if (criticalCounter) {
        tacticalState = "ENGAGE";
        evadeDir = null;
        stateUntil = now + Math.max(0.18, Math.min(0.32, (threat?.eta || 0.2) + 0.08));
        mode = "core-counter-fire-critical";
        return { dir: counterDir, fire: true, hold: true, mode, target: shooter };
      }

      if (tacticalState === "EVADE" && evadeDir && now < stateUntil
        && ctx.canMove?.(evadeDir) && !movementBulletThreat(ctx, tank, evadeDir, 1.05)) {
        mode = crossingOnly ? "core-predictive-bullet-dodge" : "core-evade-bullet";
        return { dir: evadeDir, fire: false, hold: false, mode, target: preferredTarget };
      }

      const dodge = dodgeDirection(ctx, tank, bullet, preferredTarget);
      if (dodge) {
        tacticalState = "EVADE";
        evadeDir = dodge;
        stateUntil = now + Math.max(0.34, Math.min(0.56, (threat?.eta || 0.8) * 0.42));
        mode = crossingOnly ? "core-predictive-bullet-dodge" : "core-evade-bullet";
        return { dir: dodge, fire: false, hold: false, mode, target: preferredTarget };
      }

      const retreat = crossingOnly ? null : bulletLineRetreat(ctx, tank, bullet);
      if (retreat) {
        tacticalState = "EVADE";
        evadeDir = retreat;
        stateUntil = now + Math.max(0.34, Math.min(0.56, (threat?.eta || 0.8) * 0.42));
        mode = "core-evade-bullet-retreat";
        return { dir: retreat, fire: false, hold: false, mode, target: preferredTarget };
      }

      const lastChance = crossingOnly ? null : lastChanceBulletEscape(ctx, tank, bullet);
      if (lastChance) {
        tacticalState = "EVADE";
        evadeDir = lastChance;
        stateUntil = now + 0.2;
        mode = "core-evade-bullet-last-chance";
        return { dir: lastChance, fire: false, hold: false, mode, target: preferredTarget };
      }


      const forcedEscape = forcedBulletEscapePlan(ctx, tank, bullet, preferredTarget);
      if (forcedEscape) {
        tacticalState = "EVADE";
        evadeDir = forcedEscape.dir;
        stateUntil = now + 0.24;
        mode = crossingOnly ? "core-predictive-bullet-forced" : "core-evade-bullet-forced";
        return {
          dir: forcedEscape.dir,
          moveScale: forcedEscape.moveScale,
          fire: false,
          hold: false,
          mode,
          target: preferredTarget,
        };
      }

      return null;
    }

    function freezePickupAction(ctx, tank, freeze, now, combatTarget) {
      if (!freeze || freeze.dead) return null;
      if (now < stuckEscapeUntil && stuckBlockedDir) {
        const escape = stuckEscapeDirection(ctx, tank, freeze, stuckBlockedDir);
        if (escape) {
          freezePickupDir = escape;
          freezePickupDirUntil = now + 0.55;
          mode = "core-freeze-pickup-unstick";
          return { dir: escape, fire: false, hold: false, mode, target: combatTarget };
        }
      }
      if (freezePickupBonus !== freeze) {
        freezePickupBonus = freeze;
        freezePickupDir = null;
        freezePickupDirUntil = 0;
      }
      const pickup = freezePickupPlan(ctx, tank, freeze);
      const path = pickup.path;
      const step = routeStep(ctx, tank, path);
      const freshDir = step.dir || (pickup.collect ? freezeDirectDirection(ctx, tank, freeze) : null);
      const committedUsable = freezePickupDir && freezePickupDir === freshDir && now < freezePickupDirUntil
        && ctx.canMove?.(freezePickupDir);
      const dir = committedUsable ? freezePickupDir : freshDir;
      if (dir && dir !== freezePickupDir) {
        freezePickupDir = dir;
        freezePickupDirUntil = now + Math.max(0.16, turnTime(tank.dir, dir) + 0.12);
      } else if (dir) {
        freezePickupDirUntil = Math.max(freezePickupDirUntil, now + 0.08);
      }
      publishRoute(ctx, tank, path);
      const nextCell = path[1] || null;
      const nextTile = nextCell
        ? (ctx.tileAt?.(nextCell.x, nextCell.y) ?? ctx.map?.[nextCell.y]?.[nextCell.x])
        : null;
      if (!step.aligning && step.routeDir && nextTile === "B"
        && !isGuardCell(ctx, nextCell.x, nextCell.y)) {
        const ready = tank.dir === step.routeDir
          && (Number(tank.turnCooldown) || 0) <= 0
          && Boolean(ctx.canFire?.());
        mode = ready ? "core-freeze-pickup-clear" : "core-freeze-pickup-clear-aim";
        return { dir: step.routeDir, fire: ready, hold: true, mode, target: null };
      }
      if (dir) {
        mode = step.aligning && dir === freshDir ? "core-freeze-pickup-align" : "core-freeze-pickup";
        return { dir, fire: false, hold: false, mode, target: combatTarget };
      }
      if (pickup.collect) {
        mode = "core-freeze-pickup-wait";
        return { dir: tank.dir, fire: false, hold: true, mode, target: combatTarget };
      }
      ctx.aiAvoidCell = { ...cellOf(freeze), until: now + 0.35 };
      return null;
    }

    function decideRaw(ctx) {
      try {
        const tank = ctx?.tank;
        if (!tank?.alive) return { fire: false, hold: false, mode: "core-idle", target: null };
        const now = ctx.gameTime || 0;
        updateArmorVolley(tank, now);
        if (missionTarget && !missionTarget.alive) missionTarget = null;
        lastDecisionTime = now;
        if (avoidBrick && now < avoidBrick.until) ctx.aiAvoidCell = avoidBrick;
        else avoidBrick = null;
        const freezeRemaining = Math.max(0, Number(ctx.freezeTime) || 0);
        if (wasFrozen && freezeRemaining <= 0) resetFreezeCombatState(now);
        wasFrozen = freezeRemaining > 0;
        const hiddenFinalEnemy = concealedFinalEnemy(ctx);
        if (hiddenFinalEnemy && (target === hiddenFinalEnemy || missionTarget === hiddenFinalEnemy)) {
          setTarget(null, now, true, true);
        }
        const globalState = analyzeGlobalBattle(ctx, now);
        ctx.globalDirective = globalState.assignments.get(tank) || null;
        ctx.globalThreats = globalState.threats;
        const immediateLocalEnemies = allVisibleEnemies(ctx).filter((enemy) =>
          manhattan(tank, enemy) <= TILE * 2.2 || bodyGap(tank, enemy) <= TILE * 0.45);
        const emergencyEnemies = allVisibleEnemies(ctx).filter((enemy) =>
          directBaseShotThreat(ctx, enemy)?.target === "base" || isBaseEmergency(ctx, enemy));
        const assignedEnemies = ctx.globalDirective
          ? (ctx.globalDirective.target?.alive ? [ctx.globalDirective.target] : [])
          : [...sideEnemyPool(ctx, tank, target)];
        ctx.aiEnemyPool = new Set([...assignedEnemies, ...immediateLocalEnemies, ...emergencyEnemies]);
        const ownSideEnemies = allVisibleEnemies(ctx).filter((enemy) => onAssignedSide(ctx, tank, enemy));
        const assignedOffSideEmergency = ctx.globalDirective?.target?.alive
          && !onAssignedSide(ctx, tank, ctx.globalDirective.target)
          && ctx.globalDirective.emergency;
        const collectingFreeze = Boolean(ctx.globalDirective?.pickup);
        const localOffSideContact = immediateLocalEnemies.some((enemy) => !onAssignedSide(ctx, tank, enemy));
        ctx.aiSideRole = ownSideEnemies.length && !assignedOffSideEmergency
          && !collectingFreeze && !localOffSideContact
          ? (tank.kind === "player" ? "LEFT" : tank.kind === "player2" ? "RIGHT" : null)
          : null;
        if (ctx.aiSideRole && typeof ctx.canMove === "function") {
          const canMoveInGame = ctx.canMove;
          ctx.canMove = (dir) => canMoveInGame(dir) && sideMovementAllowed(ctx, tank, dir);
        }
        selectStableTarget(ctx, tank, now);
        const coordinatedPickup = ctx.globalDirective
          && Object.prototype.hasOwnProperty.call(ctx.globalDirective, "pickup");
        const nearbyFreezeBonus = coordinatedPickup
          ? ctx.globalDirective.pickup
          : nearbyFreeze(ctx, tank);
        const assignedFreezeCollector = coordinatedPickup
          ? (nearbyFreezeBonus ? tank : null)
          : nearbyFreezeBonus ? freezeCollector(ctx, tank, nearbyFreezeBonus) : null;
        const collectNearbyFreeze = assignedFreezeCollector === tank;
        const freeze = collectNearbyFreeze ? nearbyFreezeBonus : null;
        // A tank already between an enemy shell and the base must remain in the
        // lane. Counter-fire when possible, but never dodge away and expose the
        // base to a projectile it can absorb.
        const shieldBullet = baseShieldBullet(ctx, tank);
        if (shieldBullet) {
          const shooter = shieldBullet.owner?.alive ? shieldBullet.owner : target;
          if (shooter?.alive) setTarget(shooter, now + 0.45);
          const counterDir = opposite(shieldBullet.dir) || tank.dir;
          const ready = tank.dir === counterDir && (tank.turnCooldown || 0) <= 0 && Boolean(ctx.canFire?.());
          tacticalState = "ENGAGE";
          stateUntil = now + 0.45;
          mode = ready ? "core-base-shield-fire" : "core-base-shield-aim";
          if (!recordedShieldBullets.has(shieldBullet)) {
            recordedShieldBullets.add(shieldBullet);
            services?.recordExperience?.("base_shield_counter", {
              stage: ctx.stage,
              time: now,
              tank,
              enemy: shooter?.alive ? shooter : null,
              target: shooter?.alive ? shooter : target,
              mode,
              reason: "protect-base",
              bulletDir: shieldBullet.dir,
              distance: manhattan(tank, shieldBullet),
            });
          }
          return { dir: counterDir, fire: true, hold: true, mode, target: shooter?.alive ? shooter : target };
        }
        const enemyBullet = incomingBullet(ctx, tank);
        // Within three tiles collection is absolute priority. The base-shield
        // branch above is the only exception because leaving that lane loses
        // the base immediately.
        if (freeze && tileRange(tank, freeze) <= 3) {
          const pickupAction = freezePickupAction(ctx, tank, freeze, now, target);
          if (pickupAction) return pickupAction;
        }
        // Personal survival interrupts pickup movement for only the duration of
        // an actual incoming shell. The freeze remains claimed and collection
        // resumes immediately afterward.
        if (enemyBullet) {
          const response = incomingBulletAction(ctx, tank, enemyBullet, now, target);
          if (response) return response;
          const forced = forcedBulletEscapePlan(ctx, tank, enemyBullet, target);
          if (forced) {
            mode = "core-evade-bullet-forced";
            return {
              dir: forced.dir,
              moveScale: forced.moveScale,
              fire: false,
              hold: false,
              mode,
              target,
            };
          }
          mode = "core-evade-bullet-trapped";
          return { dir: tank.dir, fire: false, hold: false, mode, target };
        }
        // Team fire is communicated before pickup/attack planning. A collector
        // may yield for the brief collision window, then immediately resumes the
        // freeze route without losing its mission or pickup claim.
        const friendlyBullet = incomingFriendlyBullet(ctx, tank);
        if (friendlyBullet) {
          const forced = forcedBulletEscapePlan(ctx, tank, friendlyBullet, target);
          const dodge = dodgeDirection(ctx, tank, friendlyBullet, target)
            || lastChanceBulletEscape(ctx, tank, friendlyBullet)
            || forced?.dir;
          mode = dodge ? "core-avoid-friendly-bullet" : "core-avoid-friendly-bullet-hold";
          return {
            dir: dodge || tank.dir,
            moveScale: forced && forced.dir === dodge ? forced.moveScale : 1,
            fire: false,
            hold: !dodge,
            mode,
            target,
          };
        }
        const allyFire = incomingAllyFire(ctx, tank);
        if (allyFire) {
          const forced = forcedBulletEscapePlan(ctx, tank, allyFire, target);
          const dodge = dodgeDirection(ctx, tank, allyFire, target)
            || lastChanceBulletEscape(ctx, tank, allyFire)
            || forced?.dir;
          mode = dodge ? "core-avoid-ally-fire" : "core-avoid-ally-fire-hold";
          return {
            dir: dodge || tank.dir,
            moveScale: forced && forced.dir === dodge ? forced.moveScale : 1,
            fire: false,
            hold: !dodge,
            mode,
            target,
          };
        }
        if (freeze) {
          const pickupAction = freezePickupAction(ctx, tank, freeze, now, target);
          if (pickupAction) return pickupAction;
        } else {
          freezePickupBonus = null;
          freezePickupDir = null;
          freezePickupDirUntil = 0;
        }
        const reservedFreezeBonus = ctx.globalDirective?.pickupReserved || nearbyFreezeBonus;
        const reservedFreezeCollector = ctx.globalDirective?.pickupCollector || assignedFreezeCollector;
        if (freezeRemaining <= 0 && reservedFreezeBonus && reservedFreezeCollector?.alive
          && reservedFreezeCollector !== tank) {
          const reservedCell = cellOf(reservedFreezeBonus);
          ctx.aiAvoidCell = { ...reservedCell, until: now + 0.45 };
        }
        const baseProjectilePlan = assignedBaseProjectileIntercept(ctx, tank);
        if (baseProjectilePlan) {
          const shooter = baseProjectilePlan.bullet.owner?.alive ? baseProjectilePlan.bullet.owner : null;
          if (shooter) setTarget(shooter, now + 1.2, true);
          publishRoute(ctx, tank, baseProjectilePlan.path);
          const step = routeStep(ctx, tank, baseProjectilePlan.path, 2, shooter || target, true);
          if (step.dir) {
            tacticalState = "EVADE";
            stateUntil = now + 0.42;
            mode = step.aligning ? "core-base-bullet-intercept-align" : "core-base-bullet-intercept";
            return { dir: step.dir, fire: false, hold: false, mode, target: shooter || target };
          }
          mode = "core-base-shield-aim";
          return {
            dir: baseProjectilePlan.counterDir || tank.dir,
            fire: true,
            hold: true,
            mode,
            target: shooter || target,
          };
        }
        if (freezeRemaining <= 0) {
          const terminalDefense = terminalBaseDefenseAction(ctx, tank, now);
          if (terminalDefense) return terminalDefense;
        }
        if (hiddenFinalEnemy) {
          const searchAction = finalEnemySearchAction(ctx, tank, hiddenFinalEnemy, now);
          if (searchAction) return searchAction;
        } else {
          finalSearchEnemy = null;
          finalSearchWaypoint = null;
          finalSearchMapVersion = -1;
          finalSearchStep = 0;
        }
        if ((ctx.freezeTime || 0) <= 0 && pendingFreezeShots.length) {
          pendingFreezeShots = [];
          freezeBlockedTargets.clear();
          failedFreezeTarget = null;
          failedFreezeCell = null;
          freezePlanCache = null;
          freezePlanCacheKey = "";
          freezePlanCacheUntil = 0;
          freezeCommittedTarget = null;
        }
        if ((ctx.freezeTime || 0) > 0) {
          updateFreezeShotFeedback(now);
          const frozenEnemies = visibleEnemies(ctx);
          const activeMission = missionTarget?.alive && frozenEnemies.includes(missionTarget)
            ? missionTarget
            : null;
          if (activeMission) {
            freezeCommittedTarget = activeMission;
            freezeBlockedTargets.delete(activeMission);
          }
          if (!freezeCommittedTarget?.alive || !frozenEnemies.includes(freezeCommittedTarget)) {
            freezeCommittedTarget = null;
          }
          const directBaseThreat = frozenEnemies
            .filter((enemy) => directBaseShotThreat(ctx, enemy))
            .sort((a, b) => baseLineThreatEta(ctx, a) - baseLineThreatEta(ctx, b)
              || manhattan(a, ctx.base) - manhattan(b, ctx.base))[0] || null;
          if (!activeMission && directBaseThreat
            && (!freezeCommittedTarget || !directBaseShotThreat(ctx, freezeCommittedTarget))) {
            freezeCommittedTarget = directBaseThreat;
          }
          if (!freezeCommittedTarget) {
            const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
            freezeCommittedTarget = target?.alive && frozenEnemies.includes(target) && !reserved.has(target)
              ? target
              : assignedBaseThreat(ctx, tank, target)
                || frozenEnemies.find((enemy) => !reserved.has(enemy))
                || frozenEnemies[0]
                || null;
          }
          if (freezeCommittedTarget) {
            setTarget(freezeCommittedTarget, now + Math.max(0.65, Number(ctx.freezeTime) || 0), true);
          }
          const freezeContact = stableContactCombatPlan(ctx, tank, now);
          if (freezeContact?.shot) {
            const contactOverride = Boolean(freezeContact.localBreach || freezeContact.pointBlankContact || freezeContact.nearbyCombat);
            if (contactOverride) freezeCommittedTarget = freezeContact.enemy;
            setTarget(freezeContact.enemy, now + 0.35, contactOverride, contactOverride);
            publishRoute(ctx, tank, [cellOf(tank)]);
            if (freezeMissedHere(freezeContact.enemy, tank, now)) {
              const reposition = stuckEscapeDirection(ctx, tank, freezeContact.enemy, freezeContact.shot)
                || freezeRecoveryDirection(ctx, tank, freezeContact.enemy, verticalDefenseGoals(ctx, tank, freezeContact.enemy));
              if (reposition) {
                mode = "core-freeze-miss-reposition";
                return { dir: reposition, fire: false, hold: false, mode, target: freezeContact.enemy };
              }
            }
            if (freezeContact.aimOnly) {
              mode = freezeContact.pointBlank
                ? "core-freeze-pointblank-aim"
                : freezeContact.baseIntruder ? "core-freeze-base-melee-aim" : "core-freeze-contact-commit-aim";
              return movingAimAction(ctx, tank, freezeContact.shot, mode, freezeContact.enemy);
            }
            mode = freezeContact.pointBlank
              ? "core-freeze-pointblank-fire"
              : freezeContact.baseIntruder ? "core-freeze-base-melee-fire" : "core-freeze-contact-fire";
            const mobileContact = freezeContact.distance > TILE * 3.25 && ctx.canMove?.(freezeContact.shot);
            if (tank.dir === freezeContact.shot && (Number(tank.turnCooldown) || 0) <= 0
              && preciseFrozenShot(ctx, tank, freezeContact.enemy) === freezeContact.shot) {
              trackFreezeShot(ctx, tank, freezeContact.enemy, now);
            }
            return exactFrozenFireAction(ctx, tank, freezeContact.shot, mode, freezeContact.enemy, mobileContact);
          }
          if (freezeContact?.enemy) {
            if (freezeContact.localBreach || freezeContact.pointBlankContact || freezeContact.nearbyCombat) {
              freezeCommittedTarget = freezeContact.enemy;
              setTarget(freezeContact.enemy, now + 0.35, true, true);
            }
            const brickDir = routeBrickDirection(ctx, tank, freezeContact.enemy);
            if (brickDir) {
              mode = freezeContact.baseIntruder ? "core-freeze-base-melee-clear" : "core-freeze-contact-clear";
              return aimedFireAction(ctx, tank, brickDir, mode, freezeContact.enemy);
            }
          }
          if (now < stuckEscapeUntil && stuckBlockedDir) {
            const escape = stuckEscapeDirection(ctx, tank, freezeContact?.enemy || target, stuckBlockedDir);
            if (escape) {
              mode = "core-freeze-stuck-escape";
              return { dir: escape, fire: false, hold: false, mode, target: freezeContact?.enemy || target };
            }
          } else if (now >= stuckEscapeUntil) {
            stuckBlockedDir = null;
          }
          if (freezeContact?.approach) {
            const contactOverride = Boolean(freezeContact.localBreach || freezeContact.pointBlankContact || freezeContact.nearbyCombat);
            if (contactOverride) freezeCommittedTarget = freezeContact.enemy;
            setTarget(freezeContact.enemy, now + 0.35, contactOverride, contactOverride);
            mode = freezeContact.frozenAlignment
              ? "core-freeze-contact-align"
              : freezeContact.baseIntruder
              ? "core-freeze-base-melee-approach"
              : freezeContact.breakaway ? "core-freeze-contact-breakaway" : "core-freeze-contact-approach";
            return { dir: freezeContact.approach, fire: false, hold: false, mode, target: freezeContact.enemy };
          }
          const cover = freezeCoverPlan(ctx, tank, target);
          if (cover && (!target?.alive || cover.enemy === target)) {
            setTarget(cover.enemy, now + Math.max(0.2, Number(ctx.freezeTime) || 0));
            publishRoute(ctx, tank, [cellOf(tank)]);
            if (tank.dir !== cover.dir || (tank.turnCooldown || 0) > 0) {
              mode = "core-freeze-cover-aim";
              return movingAimAction(ctx, tank, cover.dir, mode, cover.enemy);
            }
            const ready = Boolean(ctx.canFire?.());
            mode = ready ? "core-freeze-cover-fire" : "core-freeze-cover-reload";
            if (ready && preciseFrozenShot(ctx, tank, cover.enemy) === cover.dir) {
              trackFreezeShot(ctx, tank, cover.enemy, now);
            }
            return ready
              ? exactFrozenFireAction(ctx, tank, cover.dir, mode, cover.enemy, true)
              : activeFreezeReloadAction(ctx, tank, cover.dir, cover.enemy, mode);
          }
          const freezeCell = cellOf(tank);
          const freezePlanKey = [
            freezeCell.x,
            freezeCell.y,
            Number(ctx.mapVersion || 0),
            Math.ceil(Number(ctx.freezeTime || 0) * 5),
            freezeBlockedTargets.size,
            freezeMissedCells.size,
            failedFreezeCell?.x ?? -1,
            failedFreezeCell?.y ?? -1,
            ...visibleEnemies(ctx).flatMap((enemy) => [cellOf(enemy).x, cellOf(enemy).y, Number(enemy.hp) || 1]),
            ...(ctx.reservedTargets || []).filter((enemy) => enemy?.alive).flatMap((enemy) => [cellOf(enemy).x, cellOf(enemy).y]),
          ].join(":");
          let plan = freezePlanCacheKey === freezePlanKey && now < freezePlanCacheUntil && freezePlanCache?.enemy?.alive
            ? freezePlanCache
            : freezeAttackPlan(ctx, tank, freezeBlockedTargets, failedFreezeTarget, failedFreezeCell, freezeCommittedTarget, freezeMissedCells, now);
          if (activeMission && plan?.enemy !== activeMission) plan = null;
          if (freezePlanCacheKey !== freezePlanKey || now >= freezePlanCacheUntil) {
            freezePlanCache = plan;
            freezePlanCacheKey = freezePlanKey;
            freezePlanCacheUntil = now + 0.16;
          }
          if (plan) {
            if (!activeMission) freezeCommittedTarget = plan.enemy;
            setTarget(plan.enemy, now + Math.max(0.65, Number(ctx.freezeTime) || 0), true);
            if (freezeBurstTarget !== plan.enemy) {
              freezeBurstTarget = plan.enemy;
              freezeBurstShots = 0;
            }
            publishRoute(ctx, tank, plan.path);
            if (plan.shot) {
              const exactShot = preciseFrozenShot(ctx, tank, plan.enemy);
              if (exactShot !== plan.shot) {
                mode = exactShot ? "core-freeze-exact-aim" : "core-freeze-exact-reposition";
                return exactFrozenFireAction(ctx, tank, plan.shot, mode, plan.enemy, true);
              }
              const aimSettled = tank.dir === plan.shot && (tank.turnCooldown || 0) <= 0;
              if (!aimSettled) {
                mode = "core-freeze-aim";
                return movingAimAction(ctx, tank, plan.shot, mode, plan.enemy);
              }
              const shotReady = Boolean(ctx.canFire?.());
              if (!shotReady) {
                mode = "core-freeze-reload-advance";
                return activeFreezeReloadAction(ctx, tank, plan.shot, plan.enemy, mode);
              }
              if (shotReady) {
                freezeBurstShots++;
                trackFreezeShot(ctx, tank, plan.enemy, now);
              }
              const burstSize = plan.enemy.kind === "armor" ? 2 : 1;
              if (shotReady && freezeBurstShots >= burstSize) {
                freezeBurstTarget = null;
                freezeBurstShots = 0;
              }
              mode = "core-freeze-direct-fire";
              return exactFrozenFireAction(ctx, tank, plan.shot, mode, plan.enemy, true);
            }
            const step = routeStep(ctx, tank, plan.path);
            const dir = step.dir;
            if (dir) {
              const next = plan.path[1];
              const nextTile = ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x];
              if (!step.aligning && nextTile === "B") {
                mode = "core-freeze-clear";
                return aimedFireAction(ctx, tank, dir, mode, plan.enemy);
              }
              mode = step.aligning ? "core-freeze-align" : "core-freeze-assault";
              return { dir, fire: false, hold: false, mode, target: plan.enemy };
            }
            if (plan.goal?.brickKeys?.length && plan.goal.shotDir) {
              mode = "core-freeze-clear";
              return aimedFireAction(ctx, tank, plan.goal.shotDir, mode, plan.enemy);
            }
            const fallbackGoals = [...closeCombatGoals(ctx, tank, plan.enemy), ...pursuitGoals(ctx, plan.enemy)];
            const approach = closeApproachDirection(ctx, tank, plan.enemy)
              || freezeRecoveryDirection(ctx, tank, plan.enemy, fallbackGoals);
            mode = approach ? "core-freeze-assault-recover" : "core-freeze-blocked";
            return { dir: approach || tank.dir, fire: false, hold: !approach, mode, target: plan.enemy };
          }
          const pursuit = freezePursuitPlan(ctx, tank, activeMission || freezeCommittedTarget);
          if (pursuit) {
            if (!activeMission) freezeCommittedTarget = pursuit.enemy;
            setTarget(pursuit.enemy, now + Math.max(0.55, Number(ctx.freezeTime) || 0), true);
            publishRoute(ctx, tank, pursuit.path);
            const step = routeStep(ctx, tank, pursuit.path);
            if (step.dir) {
              const next = pursuit.path[1];
              const nextTile = ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x];
              if (!step.aligning && nextTile === "B") {
                mode = "core-freeze-clear";
                return aimedFireAction(ctx, tank, step.dir, mode, pursuit.enemy);
              }
              mode = step.aligning ? "core-freeze-pursuit-align" : "core-freeze-pursuit";
              return { dir: step.dir, fire: false, hold: false, mode, target: pursuit.enemy };
            }
            const recovery = freezeRecoveryDirection(ctx, tank, pursuit.enemy, pursuit.goals);
            if (recovery) {
              mode = "core-freeze-pursuit-recover";
              return { dir: recovery, fire: false, hold: false, mode, target: pursuit.enemy };
            }
          }
          const fallbackEnemy = target?.alive
            ? target
            : visibleEnemies(ctx).sort((a, b) => manhattan(a, ctx.base) - manhattan(b, ctx.base))[0];
          const brickDir = routeBrickDirection(ctx, tank, fallbackEnemy);
          if (brickDir) {
            mode = "core-freeze-route-clear";
            return aimedFireAction(ctx, tank, brickDir, mode, fallbackEnemy);
          }
          const fallbackMove = fallbackEnemy && freezeRecoveryDirection(ctx, tank, fallbackEnemy, pursuit?.goals || []);
          if (fallbackMove) {
            mode = "core-freeze-forced-pursuit";
            return { dir: fallbackMove, fire: false, hold: false, mode, target: fallbackEnemy };
          }
          mode = visibleEnemies(ctx).length ? "core-freeze-blocked" : "core-freeze-scan";
          return { dir: tank.dir, fire: false, hold: true, mode, target };
        }
        const contactPlan = stableContactCombatPlan(ctx, tank, now);
        if (contactPlan?.shot) {
          setTarget(contactPlan.enemy, now + MELEE_COMMIT_SECONDS, Boolean(contactPlan.localBreach || contactPlan.pointBlankContact || contactPlan.nearbyCombat));
          closeLockUntil = now + MELEE_COMMIT_SECONDS;
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          const fastLastLine = isFastLastLine(ctx, contactPlan.enemy);
          if (contactPlan.aimOnly) {
            mode = fastLastLine
              ? "core-contact-fast-lastline-aim"
              : contactPlan.baseIntruder ? "core-base-melee-aim" : "core-contact-commit-aim";
            if (fastLastLine || contactPlan.baseIntruder) {
              return { dir: contactPlan.shot, fire: true, hold: true, mode, target: contactPlan.enemy };
            }
            return movingAimAction(ctx, tank, contactPlan.shot, mode, contactPlan.enemy);
          }
          mode = fastLastLine
            ? "core-contact-fast-lastline-fire"
            : contactPlan.baseIntruder
            ? "core-base-melee-fire"
            : contactPlan.predicted ? "core-contact-predict-fire" : "core-contact-fire";
          return aimedFireAction(ctx, tank, contactPlan.shot, mode, contactPlan.enemy, true);
        }
        if (contactPlan?.enemy) {
          if (contactPlan.localBreach || contactPlan.pointBlankContact || contactPlan.nearbyCombat) setTarget(contactPlan.enemy, now + MELEE_COMMIT_SECONDS, true);
          const brickDir = routeBrickDirection(ctx, tank, contactPlan.enemy);
          if (brickDir) {
            mode = contactPlan.baseIntruder && isFastLastLine(ctx, contactPlan.enemy)
              ? "core-contact-fast-lastline-clear"
              : contactPlan.baseIntruder ? "core-base-melee-clear" : "core-contact-clear";
            return aimedFireAction(ctx, tank, brickDir, mode, contactPlan.enemy);
          }
        }
        if (now < stuckEscapeUntil && stuckBlockedDir) {
          const escape = stuckEscapeDirection(ctx, tank, contactPlan?.enemy || target, stuckBlockedDir);
          if (escape) {
            mode = "core-stuck-escape";
            return { dir: escape, fire: false, hold: false, mode, target: contactPlan?.enemy || target };
          }
        } else if (now >= stuckEscapeUntil) {
          stuckBlockedDir = null;
        }
        if (contactPlan?.approach) {
          setTarget(contactPlan.enemy, now + MELEE_COMMIT_SECONDS, Boolean(contactPlan.localBreach || contactPlan.pointBlankContact || contactPlan.nearbyCombat));
          closeLockUntil = now + MELEE_COMMIT_SECONDS;
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          mode = isFastLastLine(ctx, contactPlan.enemy)
            ? "core-contact-fast-lastline-approach"
            : contactPlan.baseIntruder ? "core-base-melee-approach" : "core-contact-approach";
          return { dir: contactPlan.approach, fire: false, hold: false, mode, target: contactPlan.enemy };
        }
        const breakthroughAction = breakthroughPursuitAction(ctx, tank, now);
        if (breakthroughAction) return breakthroughAction;
        const sameDirectionPursuit = sameDirectionPursuitAction(ctx, tank, target);
        if (sameDirectionPursuit) {
          tacticalState = "CHASE";
          stateUntil = now + 0.3;
          mode = sameDirectionPursuit.mode;
          return sameDirectionPursuit;
        }
        const closeOpportunity = closeRangeShot(ctx, tank, target);
        if (closeOpportunity && closeOpportunity.enemy !== target
          && !ctx.globalDirective?.target
          && shouldSwitchTarget(ctx, tank, closeOpportunity.enemy, now)) {
          setTarget(closeOpportunity.enemy, now + 0.65, true);
          closeLockUntil = now + 0.65;
        }
        const finalEnemy = visibleEnemies(ctx).length === 1;
        const advanceThreats = advanceSafetyThreats(ctx);
        const assignedSafetyThreat = assignedAdvanceSafetyThreat(ctx, tank, advanceThreats);
        const baseAdvanceSafe = advanceThreats.length === 0;
        if (!baseAdvanceSafe) {
          if (!ctx.globalDirective?.target
            && !breakthroughCommitTarget?.alive && assignedSafetyThreat?.alive && target !== assignedSafetyThreat) {
            setTarget(assignedSafetyThreat, now + 1.2, true);
            closeLockUntil = Math.max(closeLockUntil, now + 0.65);
          }
        }
        const baseEmergency = target && isBaseEmergency(ctx, target);
        const fastLastLine = target && isFastLastLine(ctx, target);
        const exactShot = target && currentPositionShot(ctx, tank, target);
        const shot = exactShot || (target && directShot(ctx, tank, target));
        const predictedShot = target && !shot ? predictiveShot(ctx, tank, target) : null;
        const closeTarget = target && manhattan(tank, target) <= TILE * 4.5;
        const freshPatrolPressure = Boolean(target?.alive && targetPressingBase(ctx, target));
        if (freshPatrolPressure) {
          patrolPressureTarget = target;
          patrolPressureUntil = now + 1.15;
        } else if (!patrolPressureTarget?.alive || target !== patrolPressureTarget || now >= patrolPressureUntil) {
          patrolPressureTarget = null;
          patrolPressureUntil = 0;
        }
        const patrolPressure = Boolean(target?.alive
          && target === patrolPressureTarget
          && now < patrolPressureUntil);
        const emergencyAim = baseEmergency
          ? stableEmergencyAim(ctx, tank, now, target, shot || predictedShot)
          : stableEmergencyAim(ctx, tank, now, null, null);
        const retainedCloseFireDir = closeFireDir && now < closeFireUntil
          && canHitFromDirection(ctx, tank, target, closeFireDir)
          ? closeFireDir
          : null;
        const closeShotDir = emergencyAim?.dir || retainedCloseFireDir || shot || predictedShot;
        const bullet = incomingBullet(ctx, tank);
        const muzzleThreat = bullet || baseEmergency ? null : aimingEnemy(ctx, tank);
        const incoming = bullet || muzzleThreat;
        if (baseEmergency && emergencyAim?.dir) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.45;
          if (emergencyAim.aimOnly) {
            mode = fastLastLine ? "core-contact-fast-lastline-aim" : "core-base-contact-commit-aim";
            return { dir: emergencyAim.dir, fire: true, hold: true, mode, target };
          }
          mode = fastLastLine
            ? (ctx.canFire?.() ? "core-contact-fast-lastline-fire" : "core-contact-fast-lastline-reload")
            : ctx.canFire?.() ? "core-base-contact-fire" : "core-base-contact-reload";
          return aimedFireAction(ctx, tank, emergencyAim.dir, mode, target);
        }
        if (closeTarget && closeShotDir && (ctx.canFire?.() || !incoming)) {
          if (closeFireDir !== closeShotDir || now >= closeFireUntil) {
            closeFireDir = closeShotDir;
            closeFireUntil = now + 0.3;
          }
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          const ready = Boolean(ctx.canFire?.());
          mode = ready ? (shot ? "core-close-fire" : "core-predict-fire") : "core-close-aim";
          return aimedFireAction(ctx, tank, closeFireDir, mode, target);
        }
        const upperSweep = baseAdvanceSafe && !baseEmergency && !closeTarget && !patrolPressure
          ? upperThirdSuppressionShot(ctx, tank, target)
          : null;
        if (upperSweep) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.3;
          mode = upperSweep.coverage
            ? "core-upper-sweep-cover"
            : upperSweep.predicted ? "core-upper-sweep-predict" : "core-upper-sweep-fire";
          return aimedFireAction(ctx, tank, upperSweep.dir, mode, upperSweep.enemy, true);
        }
        if (shot && shot === tank.dir && (ctx.canFire?.() || !incoming)) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          mode = ctx.canFire?.() ? "core-attack-fire" : "core-aim-wait";
          return aimedFireAction(ctx, tank, shot, mode, target);
        }
        if (incoming) {
          const shooter = bullet?.owner?.alive ? bullet.owner : muzzleThreat;
          const shooterShot = shooter?.alive ? directShot(ctx, tank, shooter) : null;
          const counterDir = bullet
            ? (shooterShot === opposite(bullet.dir) ? shooterShot : null)
            : shooter && manhattan(tank, shooter) <= TILE * 3.5 ? shooterShot : null;
          if (counterDir && ctx.canFire?.()) {
            tacticalState = "ENGAGE";
            stateUntil = now + 0.35;
            mode = "core-counter-fire";
            return aimedFireAction(ctx, tank, counterDir, mode, shooter);
          }
          if (tacticalState === "EVADE" && evadeDir && now < stateUntil && ctx.canMove?.(evadeDir)) {
            mode = bullet ? "core-evade-bullet" : "core-evade-muzzle";
            return { dir: evadeDir, fire: false, hold: false, mode, target };
          }
          const dodge = dodgeDirection(ctx, tank, incoming, target);
          if (dodge) {
            tacticalState = "EVADE";
            evadeDir = dodge;
            stateUntil = now + (bullet ? 0.32 : 0.26);
            mode = bullet ? "core-evade-bullet" : "core-evade-muzzle";
            return { dir: dodge, fire: false, hold: false, mode, target };
          }
          const retreat = bullet ? bulletLineRetreat(ctx, tank, bullet) : null;
          if (retreat) {
            tacticalState = "EVADE";
            evadeDir = retreat;
            stateUntil = now + 0.32;
            mode = "core-evade-bullet-retreat";
            return { dir: retreat, fire: false, hold: false, mode, target };
          }
        } else if (tacticalState === "EVADE") {
          stateUntil = now;
          evadeDir = null;
        }
        const freeShot = target?.alive ? null : anyEnemyShot(ctx, tank, target);
        if (!baseEmergency && !closeTarget && !shot && !predictedShot && freeShot && ctx.canFire?.()) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.3;
          mode = freeShot.predicted ? "core-predict-fire" : "core-opportunity-fire";
          return aimedFireAction(ctx, tank, freeShot.dir, mode, freeShot.enemy);
        }
        const contactCombat = target && manhattan(tank, target) <= TILE * 2.2;
        if (contactCombat && shot) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.45;
          if (ctx.canFire?.()) {
            mode = "core-contact-fire";
            return aimedFireAction(ctx, tank, shot, mode, target);
          }
          mode = "core-contact-aim";
          return { dir: shot, fire: false, hold: true, mode, target };
        }
        if (!target) {
          mode = "core-scan";
          return { dir: tank.dir, fire: false, hold: true, mode, target: null };
        }
        if (predictedShot && ctx.canFire?.()) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.3;
          mode = "core-predict-fire";
          return aimedFireAction(ctx, tank, predictedShot, mode, target);
        }
        if (!baseEmergency && !shot && !closeTarget) {
          const opportunity = visibleEnemies(ctx)
            .map((enemy) => ({ enemy, dir: directShot(ctx, tank, enemy), distance: manhattan(tank, enemy) }))
            .filter((item) => item.dir)
            .sort((a, b) => a.distance - b.distance)[0];
          if (opportunity) {
            tacticalState = "ENGAGE";
            stateUntil = now + 0.35;
            if (ctx.canFire?.()) {
              mode = "core-opportunity-fire";
              return aimedFireAction(ctx, tank, opportunity.dir, mode, opportunity.enemy);
            }
            mode = "core-opportunity-aim";
            return { dir: opportunity.dir, fire: false, hold: true, mode, target: opportunity.enemy };
          }
        }
        if (shot) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.45;
          mode = ctx.canFire?.()
            ? ((ctx.freezeTime || 0) > 0 ? "core-freeze-assault-fire" : "core-attack-fire")
            : "core-aim-wait";
          return aimedFireAction(ctx, tank, shot, mode, target);
        }
        const closeCombat = manhattan(tank, target) <= TILE * 6;
        const closingIn = targetClosingIn(ctx, tank, target);
        const baseMeleeEmergency = isBaseIntruder(ctx, target)
          && (crossedMidline(ctx, target) || manhattan(target, ctx.base) <= TILE * 6);
        const nextState = closeCombat ? "ENGAGE" : "CHASE";
        if (tacticalState !== nextState && now >= stateUntil) {
          tacticalState = nextState;
          stateUntil = now + 0.45;
        }
        const assignedDefensePlan = ctx.globalDirective?.target === target
          && Boolean(ctx.globalDirective.intercept?.path?.length);
        const interceptEligible = !closeCombat && !baseMeleeEmergency
          && (assignedDefensePlan
            || (!crossedMidline(ctx, target) && (patrolPressure || !finalEnemy)));
        if (!interceptEligible) {
          interceptTarget = null;
          interceptPlan = null;
          interceptPlanUntil = now;
        } else if (assignedDefensePlan) {
          const planned = ctx.globalDirective.intercept;
          const samePlan = interceptTarget === target && interceptPlan
            && interceptPlan.cell?.x === planned.cell?.x
            && interceptPlan.cell?.y === planned.cell?.y
            && interceptPlan.shotDir === planned.shotDir
            && interceptPlanMapVersion === Number(ctx.mapVersion || 0);
          const createdAt = samePlan ? Number(interceptPlan.createdAt) || now : now;
          interceptTarget = target;
          interceptPlan = { ...planned, createdAt };
          interceptPlanMapVersion = Number(ctx.mapVersion || 0);
          interceptPlanUntil = Math.max(now + 0.32, Number(ctx.globalDirective.commitUntil) || 0);
          stableRouteTarget = target;
          stableRouteMapVersion = Number(ctx.mapVersion || 0);
          stableRoute = planned.path;
          stableRouteUntil = Math.max(now + 0.65, Number(ctx.globalDirective.commitUntil) || 0);
        } else if (interceptTarget !== target || now >= interceptPlanUntil || interceptPlanMapVersion !== Number(ctx.mapVersion || 0)) {
          interceptTarget = target;
          const freshIntercept = buildInterceptPlan(ctx, tank, target);
          interceptPlan = freshIntercept ? { ...freshIntercept, createdAt: now } : null;
          interceptPlanMapVersion = Number(ctx.mapVersion || 0);
          if (freshIntercept?.path?.length) {
            stableRouteTarget = target;
            stableRouteMapVersion = Number(ctx.mapVersion || 0);
            stableRoute = freshIntercept.path;
            stableRouteUntil = now + 0.42;
          }
          interceptPlanUntil = now + (patrolPressure ? 0.78 : 0.42);
        }
        const currentInterceptCell = cellOf(tank);
        if (interceptPlan && currentInterceptCell.x === interceptPlan.cell.x && currentInterceptCell.y === interceptPlan.cell.y) {
          const elapsed = Math.max(0, now - Number(interceptPlan.createdAt || now));
          const launchRemaining = interceptPlan.launchEta - elapsed;
          const interceptShot = currentPositionShot(ctx, tank, target) || predictiveShot(ctx, tank, target);
          if (interceptShot === interceptPlan.shotDir) {
            tacticalState = "ENGAGE";
            stateUntil = now + 0.4;
            mode = ctx.canFire?.() ? "core-intercept-fire" : "core-intercept-reload";
            return aimedFireAction(ctx, tank, interceptPlan.shotDir, mode, target);
          }
          if (launchRemaining >= -0.18) {
            mode = tank.dir === interceptPlan.shotDir && (tank.turnCooldown || 0) <= 0
              ? "core-intercept-hold"
              : "core-intercept-aim";
            return {
              dir: interceptPlan.shotDir,
              fire: false,
              hold: tank.dir === interceptPlan.shotDir,
              mode,
              target,
            };
          }
          interceptPlan = null;
          interceptPlanUntil = now + 0.08;
        }
        if (baseMeleeEmergency && baseMeleeRouteTarget !== target) {
          baseMeleeRouteTarget = target;
          stableRouteTarget = null;
          stableRoute = [];
          stableRouteUntil = 0;
        } else if (!baseMeleeEmergency) {
          baseMeleeRouteTarget = null;
        }
        const firingGoals = attackGoals(ctx, target);
        const pursuit = pursuitGoals(ctx, target);
        const emergencyMelee = baseMeleeEmergency ? baseEmergencyMeleeGoals(ctx, target) : [];
        const emergencyFlanks = baseEmergency ? baseEmergencyFlankGoals(ctx, target) : [];
        const fallbackGoals = finalEnemy
          ? [...closeCombatGoals(ctx, tank, target), ...pursuit]
          : baseMeleeEmergency && emergencyFlanks.length
          ? [...emergencyFlanks, ...closeCombatGoals(ctx, tank, target), ...pursuit]
          : closeCombat
          ? [...closeCombatGoals(ctx, tank, target), ...pursuit]
          : closingIn
          ? pursuit
          : [...firingGoals, ...pursuit];
        let goals = interceptPlan && !closeCombat
          ? [interceptPlan.cell]
          : emergencyMelee.length
          ? emergencyMelee
          : fallbackGoals;
        const routeCommit = patrolPressure ? 0.68 : 0;
        let path = stablePath(ctx, tank, goals, now, routeCommit);
        if (!path.length && emergencyMelee.length) {
          goals = fallbackGoals;
          stableRouteTarget = null;
          stableRoute = [];
          stableRouteUntil = 0;
          path = stablePath(ctx, tank, goals, now, routeCommit);
        }
        publishRoute(ctx, tank, path);
        const preventRetreat = finalEnemy || baseEmergency || closeCombat || (closingIn && !patrolPressure);
        const step = routeStep(ctx, tank, path, baseEmergency ? 4 : 1.5, target, preventRetreat);
        const dir = step.dir;
        if (!dir) {
          const brickDir = routeBrickDirection(ctx, tank, target);
          if (brickDir) {
            mode = "core-attack-clear";
            return aimedFireAction(ctx, tank, brickDir, mode, target);
          }
          const recovery = recoveryDirection(ctx, tank, target, emergencyFlanks);
          if (recovery) {
            mode = "core-attack-recover";
            return { dir: recovery, fire: false, hold: false, mode, target };
          }
          mode = "core-replan";
          return { dir: tank.dir, fire: false, hold: true, mode, target };
        }
        const next = path[1];
        const nextTile = ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x];
        if (!step.aligning && nextTile === "B") {
          const clearKey = keyOf(next.x, next.y);
          if (clearCellKey !== clearKey) {
            clearCellKey = clearKey;
          }
          mode = "core-attack-clear";
          return { dir, fire: Boolean(ctx.canFire?.()), hold: true, mode, target };
        }
        if (step.aligning) {
          clearCellKey = null;
          mode = "core-path-align";
          return { dir, fire: false, hold: false, mode, target };
        }
        if (!ctx.canMove?.(dir)) {
          const blockingBrickDir = routeBrickDirection(ctx, tank, target);
          if (blockingBrickDir) {
            avoidBrick = null;
            mode = "core-route-brick-clear";
            return aimedFireAction(ctx, tank, blockingBrickDir, mode, target);
          }
          const blockedKey = keyOf(next.x, next.y);
          blockedRouteHits = blockedRouteCellKey === blockedKey ? blockedRouteHits + 1 : 1;
          blockedRouteCellKey = blockedKey;
          avoidBrick = {
            x: next.x,
            y: next.y,
            until: now + Math.min(1.2, 0.4 + blockedRouteHits * 0.16),
          };
          ctx.aiAvoidCell = avoidBrick;
          stableRoute = [];
          stableRouteUntil = 0;
          const detourPath = findPath(ctx, cellOf(tank), goals);
          const detourStep = routeStep(ctx, tank, detourPath, baseEmergency ? 4 : 1.5, target, preventRetreat);
          if (detourStep.dir) {
            const detourNext = detourPath[1];
            const detourTile = ctx.tileAt?.(detourNext.x, detourNext.y) ?? ctx.map?.[detourNext.y]?.[detourNext.x];
            publishRoute(ctx, tank, detourPath);
            if (!detourStep.aligning && detourTile === "B") {
              mode = "core-dynamic-detour-clear";
              return aimedFireAction(ctx, tank, detourStep.dir, mode, target);
            }
            if (detourStep.aligning || ctx.canMove?.(detourStep.dir)) {
              mode = detourStep.aligning ? "core-dynamic-detour-align" : "core-dynamic-detour";
              return { dir: detourStep.dir, fire: false, hold: false, mode, target };
            }
          }
          const recovery = recoveryDirection(ctx, tank, target, emergencyFlanks);
          mode = "core-path-blocked";
          return { dir: recovery || tank.dir, fire: false, hold: !recovery, mode, target };
        }
        blockedRouteCellKey = null;
        blockedRouteHits = 0;
        clearCellKey = null;
        mode = fastLastLine
          ? "core-chase-fast-lastline-route"
          : interceptPlan && !closeCombat
          ? (patrolPressure ? "core-intercept-pressure-route" : "core-intercept-route")
          : patrolPressure
          ? "core-intercept-pressure-screen-route"
          : (ctx.freezeTime || 0) > 0 ? "core-freeze-assault" : tacticalState === "ENGAGE" ? "core-engage" : "core-chase";
        return { dir, fire: false, hold: false, mode, target };
      } catch (error) {
        failures++;
        mode = "core-error-replan";
        const now = Number(ctx?.gameTime) || 0;
        if (now - lastErrorAt >= 1) {
          lastErrorAt = now;
          console.error(`AI ${name} decision failed`, error);
          services?.recordExperience?.("ai_decision_error", {
            stage: ctx?.stage,
            time: now,
            tank: ctx?.tank,
            target,
            mode,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        return { dir: ctx?.tank?.dir, fire: false, hold: true, mode, target };
      }
    }

    function decide(ctx, _dt = 0) {
      /** @type {any} */
      let action = decideRaw(ctx);
      action = keepArmorVolley(ctx, ctx.tank, action);
      const validPointBlankShot = action?.fire && action.target?.alive && action.dir
        && /pointblank/.test(action.mode || "")
        && pointBlankShot(ctx, ctx.tank, action.target, manhattan(ctx.tank, action.target)) === action.dir;
      const validEmergencyContactShot = action?.fire && action.target?.alive && action.dir
        && /base-melee|base-contact|fast-lastline/.test(action.mode || "")
        && manhattan(ctx.tank, action.target) <= TILE * 4.25
        && currentPositionShot(ctx, ctx.tank, action.target) === action.dir;
      const validCounterShot = action?.fire && action.dir
        && /^core-counter-/.test(action.mode || "")
        && counterBulletLane(ctx, ctx.tank, action.dir);
      if (action?.fire && action.target?.alive && action.dir
        && !/clear|sweep/.test(action.mode || "")
        && !validPointBlankShot
        && !validEmergencyContactShot
        && !validCounterShot
        && !canHitFromDirection(ctx, ctx.tank, action.target, action.dir)) {
        const correctedDir = directShot(ctx, ctx.tank, action.target)
          || predictiveShot(ctx, ctx.tank, action.target);
        const reposition = correctedDir ? null : shotLaneRepositionPlan(ctx, ctx.tank, action.target);
        if (reposition?.path?.length) publishRoute(ctx, ctx.tank, reposition.path);
        if (!correctedDir) {
          stableRouteTarget = null;
          stableRoute = [];
          stableRouteUntil = 0;
        }
        mode = correctedDir
          ? "core-aim-reacquire"
          : reposition ? "core-shot-lane-reposition" : "core-shot-lane-replan";
        action = {
          ...action,
          dir: correctedDir || reposition?.dir || ctx.tank.dir,
          moveDir: correctedDir ? action.moveDir : reposition?.dir || action.moveDir,
          fire: false,
          hold: correctedDir ? correctedDir === ctx.tank.dir : !reposition,
          mode,
        };
      }
      if (action?.fire && ctx?.tank?.alive && action.dir) {
        const d = DIRS[action.dir];
        const searchSweepProbe = action.mode === "core-final-search-sweep" && d
          ? {
            x: ctx.tank.x + d.x * TILE * 5,
            y: ctx.tank.y + d.y * TILE * 5,
            w: ctx.tank.w,
            h: ctx.tank.h,
          }
          : action.target;
        const obstacle = firstShotObstacle(ctx, ctx.tank, action.dir, searchSweepProbe);
        const hardBlocked = obstacle && (obstacle.tile !== "B" || obstacle.baseGuard);
        if (hardBlocked) {
          const recovery = blockedShotRecovery(ctx, ctx.tank, action.target, action.dir, obstacle);
          mode = obstacle.tile === "S" ? "core-steel-reposition" : "core-hard-block-reposition";
          action = {
            ...action,
            dir: recovery || ctx.tank.dir,
            fire: false,
            hold: !recovery,
            mode,
          };
        }
      }
      const now = Number(ctx?.gameTime) || 0;
      const tacticalCorrection = /align|recover|blocked|detour|dodge|evade|avoid|escape|aim-turn/.test(action?.mode || "");
      const urgentMove = action?.target?.alive
        && isBaseEmergency(ctx, action.target)
        && action.dir
        && !action.fire
        && !action.hold
        && action.mode !== "core-freeze"
        && action.mode !== "core-freeze-align"
        && !tacticalCorrection;
      if (urgentMove) {
        const terminalBaseThreat = Boolean(directBaseShotThreat(ctx, action.target))
          || manhattan(action.target, ctx.base) <= TILE * 4
          || baseLineThreatEta(ctx, action.target) <= 1.2;
        const currentDistance = manhattan(ctx.tank, action.target);
        const committedDistance = projectedTargetDistance(ctx.tank, action.target, emergencyMoveDir);
        const freshDistance = projectedTargetDistance(ctx.tank, action.target, action.dir);
        const committedMovesAway = committedDistance > currentDistance + 2
          && committedDistance > freshDistance + 2;
        if (emergencyMoveTarget === action.target
          && emergencyMoveDir
          && now < emergencyMoveUntil
          && emergencyMoveDir !== action.dir
          && !terminalBaseThreat
          && !committedMovesAway
          && ctx.canMove?.(emergencyMoveDir)) {
          mode = "core-base-move-commit";
          action = { ...action, dir: emergencyMoveDir, mode };
        } else {
          emergencyMoveTarget = action.target;
          emergencyMoveDir = action.dir;
          emergencyMoveUntil = now + (terminalBaseThreat ? 0.1 : 0.36);
        }
      } else if (action?.fire || !action?.target?.alive || !isBaseEmergency(ctx, action.target)) {
        emergencyMoveTarget = null;
        emergencyMoveDir = null;
        emergencyMoveUntil = 0;
      }
      action = stabilizeMovement(ctx, ctx.tank, action, now);
      let movementDir = action?.moveDir || action?.dir;
      const moving = movementDir && !action.hold;
      const urgentFreezePickup = /freeze-pickup/.test(action?.mode || "")
        && freezePickupBonus && !freezePickupBonus.dead
        && tileRange(ctx.tank, freezePickupBonus) <= 3;
      const protectedProjectileAction = action?.mode === "core-base-shield-fire"
        || action?.mode === "core-counter-fire"
        || action?.mode === "core-evade-bullet-last-chance";
      const crossingCandidate = moving && !protectedProjectileAction
        ? movementBulletThreat(ctx, ctx?.tank, movementDir, 0.9)
        : null;
      const crossingThreat = urgentFreezePickup ? null : crossingCandidate;
      if (crossingThreat) {
        const response = incomingBulletAction(
          ctx,
          ctx.tank,
          crossingThreat.bullet,
          now,
          action.target,
          true,
        );
        mode = response ? response.mode : "core-predictive-bullet-yield";
        action = response || {
          ...action,
          dir: ctx.tank.dir,
          moveDir: ctx.tank.dir,
          moveScale: 1,
          fire: false,
          hold: true,
          mode: "core-predictive-bullet-yield",
        };
        emergencyMoveDir = null;
        emergencyMoveUntil = 0;
        movementDir = action?.moveDir || action?.dir;
      }
      if (movementDir && !action.hold) lastMoveDir = movementDir;
      if (action?.fire && action.target?.alive && action.target.kind === "armor"
        && !/clear|sweep|base-shield/.test(action.mode || "")
        && action.dir === ctx.tank.dir && (Number(ctx.tank.turnCooldown) || 0) <= 0
        && Boolean(ctx.canFire?.())
        && canHitFromDirection(ctx, ctx.tank, action.target, action.dir)) {
        pendingArmorShot = {
          target: action.target,
          cooldownBefore: Number(ctx.tank.cooldown) || 0,
          expiresAt: now + 0.12,
        };
      }
      const lockedTarget = action?.target?.alive
        ? action.target
        : target?.alive ? target : missionTarget?.alive ? missionTarget : null;
      publishActionRoute(ctx, ctx.tank, lockedTarget, now);
      return { ...action, lockedTarget };
    }

    return {
      name,
      decide,
      learn(event, _amount = 1) {
          if (event === "stuck") {
            targetStuckCount++;
            globalRouteRecoveryUntil = Math.max(globalRouteRecoveryUntil, lastDecisionTime + 0.9);
            targetLockUntil = 0;
            tacticalState = "CHASE";
            stateUntil = lastDecisionTime + 2;
            clearCellKey = null;
            stuckBlockedDir = lastMoveDir;
            stuckEscapeUntil = lastDecisionTime + 0.9;
            stableRouteTarget = null;
            stableRoute = [];
            stableRouteUntil = 0;
            freezePlanCache = null;
            freezePlanCacheKey = "";
            freezePlanCacheUntil = 0;
        }
        if (name !== "1P") return;
        const memory = services?.readMemory?.();
        if (!memory) return;
        memory.lastLearnEvent = event;
        memory.lastLearnAt = Date.now();
        services?.syncMemoryFile?.();
      },
      snapshot: () => ({
        name,
        engine: "AI-CORE",
        mode,
        failures,
        target: target?.kind || null,
        targetRef: target?.alive ? target : null,
        missionTargetRef: missionTarget?.alive ? missionTarget : null,
        targetLockUntil,
        closeLockUntil,
        tacticalState,
        stateUntil,
      }),
      restore(snapshot) {
        if (!snapshot || snapshot.name !== name) return false;
        target = snapshot.targetRef?.alive ? snapshot.targetRef : null;
        missionTarget = snapshot.missionTargetRef?.alive ? snapshot.missionTargetRef : null;
        targetLockUntil = Math.max(0, Number(snapshot.targetLockUntil) || 0);
        closeLockUntil = Math.max(0, Number(snapshot.closeLockUntil) || 0);
        tacticalState = typeof snapshot.tacticalState === "string" ? snapshot.tacticalState : "CHASE";
        stateUntil = Math.max(0, Number(snapshot.stateUntil) || 0);
        mode = typeof snapshot.mode === "string" ? snapshot.mode : "core-replan";
        return true;
      },
      get memory() { return services?.readMemory?.() || {}; },
      get mode() { return mode; },
    };
  }

  function enhance(services) {
    if (!services || services.__engine === "AI-CORE") return services;
    return {
      ...services,
      __engine: "AI-CORE",
      engineVersion: "CORE",
      createController(name) {
        return createCoreController(name, services);
      },
    };
  }

  window.TankPartnerAIEngine = { version: "CORE", enhance };
  if (window.TankPartnerAI) window.TankPartnerAI = enhance(window.TankPartnerAI);
})();
