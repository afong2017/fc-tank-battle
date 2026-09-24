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
  const tacticalAdvisorCache = new Map();
  const tacticalAdvisorPostures = new WeakMap();
  const advisorRearCoverageCaches = new WeakMap();
  const advisorTranspositionTable = new Map();
  let advisorSearchWorldKey = "";
  const advisorCorrectionHistory = new Map();
  const ADVISOR_CADENCE = 0.25;
  const ADVISOR_EMERGENCY_CADENCE = 0.1;
  const ADVISOR_BUDGET_MS = 2;
  const ADVISOR_MAX_DEPTH = 3;
  const ADVISOR_NODE_LIMIT = 112;
  const ADVISOR_SEARCH_STEP = 0.28;
  const ADVISOR_FUTURE_WEIGHT = 0.42;
  const ADVISOR_PHASE_ONE_SCORE_GAIN = 1.5;
  const ADVISOR_PHASE_ONE_COMMIT = 0.3;
  const tacticalAdvisorTelemetry = {
    runs: 0,
    cacheHits: 0,
    disagreements: 0,
    applied: 0,
    blocked: 0,
    nodes: 0,
    ttHits: 0,
    cutoffs: 0,
    depth: 1,
    lastScore: 0,
    lastReason: "no-candidate",
    lastParticipation: "global-control",
  };
  let distanceWorker = null;
  let distanceWorkerDisabledUntil = 0;
  let distanceRequestId = 0;
  let advisorDisplayUpdatedAt = 0;
  let refreshAiVersionDisplay = () => {};

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

  function policyBias(ctx, key) {
    return policyWeight(ctx, key) - (Number(COMBAT_POLICY[key]) || 5);
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
        const protectedBrick = tile === "B" && isProtectedDefenseBrick(ctx, x, y);
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

  function isProtectedDefenseBrick(ctx, x, y) {
    const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x];
    if (tile !== "B") return false;
    if (isGuardCell(ctx, x, y)) return true;
    if (!ctx.base) return false;
    const baseLeft = Math.floor(ctx.base.x / TILE);
    const baseRight = Math.floor((ctx.base.x + ctx.base.w - 1) / TILE);
    const baseTop = Math.floor(ctx.base.y / TILE);
    return y >= baseTop - 4 && y < baseTop
      && x >= baseLeft - 4 && x <= baseRight + 4;
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
    // Keep the lower center screen intact. Once an enemy destroys a brick,
    // this predicate becomes false and the opened cell is immediately usable.
    if (tile === "B" && isProtectedDefenseBrick(ctx, x, y)) return Infinity;
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
    const heuristics = new Map();
    const heuristic = (x, y) => {
      const key = keyOf(x, y);
      if (heuristics.has(key)) return heuristics.get(key);
      let best = Infinity;
      for (const goal of goals) best = Math.min(best, Math.abs(goal.x - x) + Math.abs(goal.y - y));
      heuristics.set(key, best);
      return best;
    };
    const nodes = new Map();
    const open = [];
    let sequence = 0;
    const before = (a, b) => a.node.f < b.node.f || (a.node.f === b.node.f && a.sequence < b.sequence);
    const push = (key, node) => {
      const entry = { key, node, sequence: sequence++ };
      let index = open.length;
      open.push(entry);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!before(entry, open[parent])) break;
        open[index] = open[parent];
        index = parent;
      }
      open[index] = entry;
    };
    const pop = () => {
      const first = open[0];
      const last = open.pop();
      if (open.length) {
        let index = 0;
        while (index * 2 + 1 < open.length) {
          let child = index * 2 + 1;
          if (child + 1 < open.length && before(open[child + 1], open[child])) child++;
          if (!before(open[child], last)) break;
          open[index] = open[child];
          index = child;
        }
        open[index] = last;
      }
      return first;
    };
    const startKey = keyOf(start.x, start.y);
    nodes.set(startKey, { x: start.x, y: start.y, g: 0, f: heuristic(start.x, start.y), parent: null });
    push(startKey, nodes.get(startKey));
    let visits = 0;
    while (open.length && visits < 1300) {
      const entry = pop();
      const currentKey = entry.key;
      const current = entry.node;
      // Improved nodes leave stale heap entries; these are not search visits.
      if (nodes.get(currentKey) !== current) continue;
      visits++;
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
        push(nextKey, nodes.get(nextKey));
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
    const bottom = Math.min(ctx.rows - 1, Math.floor((guard.y + guard.h - 1) / TILE) + 1);
    const goals = [];
    for (let x = left; x <= right; x++) {
      if (Number.isFinite(tileCost(ctx, x, top))) goals.push({ x, y: top });
    }
    // Preserve proven interception positions; expand when terrain closes them.
    if (goals.length) return goals;
    for (let y = top + 1; y <= bottom; y++) {
      for (const x of [left, right]) {
        if (Number.isFinite(tileCost(ctx, x, y))) goals.push({ x, y });
      }
    }
    if (bottom > top) {
      for (let x = left + 1; x < right; x++) {
        if (Number.isFinite(tileCost(ctx, x, bottom))) goals.push({ x, y: bottom });
      }
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

  function baseEmergencyCorridor(ctx, tank, target, committedSide = null, earlyFastThreat = false) {
    const guard = ctx.baseGuard;
    if (!guard || !tank?.alive || !target?.alive
      || (!earlyFastThreat && !isBaseIntruder(ctx, target))) return null;
    const left = Math.max(0, Math.floor(guard.x / TILE) - 1);
    const right = Math.min(ctx.cols - 1, Math.floor((guard.x + guard.w - 1) / TILE) + 1);
    const top = Math.max(0, Math.floor(guard.y / TILE) - 1);
    const guardCenterX = guard.x + guard.w / 2;
    const targetCenterX = center(target).x;
    const side = committedSide || (targetCenterX < guardCenterX ? "LEFT" : "RIGHT");
    const current = cellOf(tank);
    const reachedSide = side === "LEFT" ? current.x <= left : current.x >= right;
    if (reachedSide) return { side, anchor: null, path: [] };
    const anchor = { x: side === "LEFT" ? left : right, y: top };
    const path = Number.isFinite(tileCost(ctx, anchor.x, anchor.y))
      ? findPath(ctx, current, [anchor])
      : [];
    return { side, anchor, path };
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

  function defenderRouteTravelTime(tank, path, ctx = null) {
    if (!tank?.alive || !Array.isArray(path) || path.length < 2) return 0;
    const speed = Math.max(45, Number(tank.speed || tank.baseSpeed) || 90);
    const firstDir = routeDirection(path.slice(0, 2)) || tank.dir;
    const lane = path[0];
    const tankCenter = center(tank);
    const horizontal = firstDir === "left" || firstDir === "right";
    const laneCenter = (horizontal ? lane.y : lane.x) * TILE + TILE / 2;
    const offset = (horizontal ? tankCenter.y : tankCenter.x) - laneCenter;
    const alignmentDistance = Math.max(0, Math.abs(offset) - 1.5);
    const correctionDir = horizontal
      ? (offset < 0 ? "down" : "up")
      : (offset < 0 ? "right" : "left");
    const directTurn = turnTime(tank.dir, firstDir);
    const alignmentEta = alignmentDistance > 0
      ? turnTime(tank.dir, correctionDir)
        + alignmentDistance / (speed * 0.35)
        + turnTime(correctionDir, firstDir)
      : directTurn;
    const activeTurn = Math.max(0, Number(tank.turnCooldown) || 0);
    const executionReserve = 0.1;
    return pathTravelTime(path, speed, tank.dir, ctx)
      + Math.max(0, alignmentEta - directTurn)
      + activeTurn
      + executionReserve;
  }

  function baseDirectFireGoals(ctx) {
    // Shared terrain analysis must not inherit one ally's assigned side or detour.
    ctx = { ...ctx, aiSideRole: null, aiAvoidCell: null, ignoreAllyRoutes: true };
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
    const route = findPath({ ...ctx, aiSideRole: null, aiAvoidCell: null, ignoreAllyRoutes: true }, cellOf(enemy), goals);
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
        path: findPath({ ...ctx, aiSideRole: null, aiAvoidCell: null, ignoreAllyRoutes: true }, enemyStart,
          baseEntryGoals({ ...ctx, aiSideRole: null, aiAvoidCell: null, ignoreAllyRoutes: true })),
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

  function selectReliableInterceptProbe(ctx, tank, enemy, probes, deadline, requireShield = true, reservedCells = new Set()) {
    if (!tank?.alive || !enemy?.alive || !probes.length) return null;
    const start = cellOf(tank);
    const safeDeadline = Number.isFinite(deadline) ? Math.max(0, deadline) : Infinity;
    const hp = Math.max(1, Math.ceil(Number(enemy.hp || enemy.life) || 1));
    const fireDelay = Math.max(0.3, Number(tank.fireDelay) || 0.45);
    const finishDelay = Math.max(0, hp - 1) * fireDelay + (hp > 1 && Number(enemy.speed) > 0 ? 0.3 : 0);
    const preliminary = probes.filter((probe) => !requireShield || probe.shieldSide)
      .sort((a, b) => Number(b.shieldSide) - Number(a.shieldSide)
        || (b.enemyEta - b.flightEta - b.optimisticAllyEta)
          - (a.enemyEta - a.flightEta - a.optimisticAllyEta)
        || a.distance - b.distance
        || a.enemyEta - b.enemyEta)
      .slice(0, 18);
    const verified = [];
    for (const probe of preliminary) {
      const path = findPath(ctx, start, [probe.cell]);
      if (!path.length) continue;
      const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || tank.dir : tank.dir;
      const allyEta = defenderRouteTravelTime(tank, path, ctx);
      const readyEta = allyEta + turnTime(arrivalDir, probe.shotDir);
      const launchEta = probe.enemyEta - probe.flightEta;
      const margin = launchEta - readyEta;
      const killEta = probe.enemyEta + finishDelay;
      const deadlineSpare = safeDeadline - killEta;
      if (margin < (enemy.kind === "fast" ? 0.18 : 0.1)) continue;
      if (Number.isFinite(safeDeadline) && deadlineSpare < 0.08) continue;
      let brickCount = 0;
      for (const cell of path.slice(1)) {
        const tile = ctx.tileAt?.(cell.x, cell.y) ?? ctx.map?.[cell.y]?.[cell.x];
        if (tile === "B") brickCount++;
      }
      verified.push({
        ...probe,
        path,
        allyEta,
        readyEta,
        launchEta,
        margin,
        killEta,
        deadlineSpare,
        brickCount,
        reserved: reservedCells.has(keyOf(probe.cell.x, probe.cell.y)),
        reliability: deadlineSpare * 6 + margin * 4 - brickCount * 2.5 - probe.distance * 0.18,
      });
    }
    return verified.sort((a, b) => Number(a.reserved) - Number(b.reserved)
      || Number(b.shieldSide) - Number(a.shieldSide)
      || a.brickCount - b.brickCount
      || b.reliability - a.reliability
      || b.deadlineSpare - a.deadlineSpare
      || b.margin - a.margin
      || a.allyEta - b.allyEta)[0] || null;
  }

  function buildInterceptPlan(ctx, tank, enemy, threat = null, reservedCells = new Set()) {
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
            distance,
            enemyEta,
            flightEta,
            optimisticAllyEta,
            verticalShot: shotDir === "up" || shotDir === "down",
            ...shield,
          });
        }
      }
    }
    const routeDeadline = pathTravelTime(enemyPath, enemy.speed, enemy.dir, ctx) - 0.25;
    const deadline = Number.isFinite(Number(threat?.responseDeadline))
      ? Number(threat.responseDeadline)
      : routeDeadline;
    return selectReliableInterceptProbe(ctx, tank, enemy, probes, deadline, pressingBase || Boolean(threat), reservedCells);
  }

  function globalInterceptPlan(ctx, tank, enemy, threat = null, reservedCells = new Set()) {
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
            distance,
            enemyEta,
            flightEta,
            optimisticAllyEta,
            sidePenalty: sideAssignmentPenalty(ctx, tank, predictedEnemy),
            ...shield,
          });
        }
      }
    }
    const routeDeadline = pathTravelTime(enemyPath, enemy.speed, enemy.dir, ctx) - 0.25;
    const deadline = Number.isFinite(Number(threat?.responseDeadline))
      ? Number(threat.responseDeadline)
      : routeDeadline;
    return selectReliableInterceptProbe(ctx, tank, enemy, probes, deadline, true, reservedCells);
  }

  function globalEmergencyShieldPlan(ctx, tank, enemy, reservedCells = new Set()) {
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
      const allyEta = defenderRouteTravelTime(tank, path, ctx);
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
      candidates.push({
        path,
        cell,
        enemyCell,
        shotDir,
        allyEta,
        enemyEta,
        launchEta,
        readyEta,
        margin: launchEta - readyEta,
        reserved: reservedCells.has(keyOf(cell.x, cell.y)),
        shield,
      });
    }
    const predicted = candidates.sort((a, b) => Number(a.reserved) - Number(b.reserved)
      || Number(b.shield.shieldSide) - Number(a.shield.shieldSide)
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
      allyEta: predicted?.allyEta ?? defenderRouteTravelTime(tank, path, ctx),
      enemyEta: predicted?.enemyEta ?? 0,
      emergencyShield: true,
    };
  }

  function reliableDefensePlan(ctx, tank, threat, reservedCells = new Set()) {
    if (!tank?.alive || !threat?.enemy?.alive || threat.defenseTier > 3) return null;
    const enemy = threat.enemy;
    if (!threat.crossed) {
      const early = globalInterceptPlan(ctx, tank, enemy, threat, reservedCells)
        || buildInterceptPlan(ctx, tank, enemy, threat, reservedCells);
      if (early?.path?.length) return { ...early, defensePlan: "EARLY_INTERCEPT" };
    }
    const shield = globalEmergencyShieldPlan(ctx, tank, enemy, reservedCells);
    return shield?.path?.length
      ? { ...shield, emergencyShield: true, defensePlan: "BASE_SIDE_FALLBACK" }
      : null;
  }

  function cachedReliableDefensePlan(ctx, tank, threat) {
    if (!tank?.alive || !threat?.enemy?.alive) return null;
    threat.defensePlans ||= new WeakMap();
    if (threat.defensePlans.has(tank)) return threat.defensePlans.get(tank);
    const plan = reliableDefensePlan(ctx, tank, threat);
    threat.defensePlans.set(tank, plan);
    return plan;
  }

  function refreshCommittedInterceptPlan(ctx, tank, enemy, plan) {
    if (!tank?.alive || !enemy?.alive || !plan?.cell || !plan?.enemyCell || !plan.shieldSide) return null;
    if (tileCost(ctx, plan.cell.x, plan.cell.y) !== 1) return null;
    const enemyPath = enemyBaseRoute(ctx, enemy);
    const enemyIndex = enemyPath.findIndex((cell, index) => index > 0
      && cell.x === plan.enemyCell.x && cell.y === plan.enemyCell.y);
    if (enemyIndex < 1) return null;
    const path = findPath(ctx, cellOf(tank), [plan.cell]);
    if (!path.length) return null;
    const predictedEnemy = {
      ...enemy,
      x: plan.enemyCell.x * TILE + 2,
      y: plan.enemyCell.y * TILE + 2,
    };
    const firingTank = {
      ...tank,
      x: plan.cell.x * TILE + 2,
      y: plan.cell.y * TILE + 2,
      dir: plan.shotDir,
    };
    if (steelBlocksShot(ctx, firingTank, predictedEnemy, plan.shotDir)
      || firstShotObstacle(ctx, firingTank, plan.shotDir, predictedEnemy)) return null;
    const enemyEta = pathTravelTime(enemyPath.slice(0, enemyIndex + 1), enemy.speed, enemy.dir, ctx);
    const flightEta = (Math.abs(plan.cell.x - plan.enemyCell.x)
      + Math.abs(plan.cell.y - plan.enemyCell.y)) * TILE / 310;
    const allyEta = defenderRouteTravelTime(tank, path, ctx);
    const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || tank.dir : tank.dir;
    const readyEta = allyEta + turnTime(arrivalDir, plan.shotDir);
    const launchEta = enemyEta - flightEta;
    const margin = launchEta - readyEta;
    const hp = Math.max(1, Math.ceil(Number(enemy.hp || enemy.life) || 1));
    const finishDelay = Math.max(0, hp - 1) * Math.max(0.3, Number(tank.fireDelay) || 0.45)
      + (hp > 1 && Number(enemy.speed) > 0 ? 0.3 : 0);
    const routeDeadline = pathTravelTime(enemyPath, enemy.speed, enemy.dir, ctx) - 0.25;
    const deadlineSpare = routeDeadline - (enemyEta + finishDelay);
    if (margin < (enemy.kind === "fast" ? 0.16 : 0.08) || deadlineSpare < 0.05) return null;
    return {
      ...plan,
      path,
      allyEta,
      readyEta,
      enemyEta,
      flightEta,
      launchEta,
      margin,
      deadlineSpare,
    };
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
    const defendBias = policyBias(ctx, "defend");
    const earlyWarning = Math.max(-0.5, Math.min(1.1, defendBias * 0.22));
    const defenseTier = direct?.target === "base" ? 0
      : direct?.target === "guard" || dangerEta <= 2.8 + earlyWarning
        || baseDistance <= TILE * (3.5 + earlyWarning * 0.25) ? 1
        : crossed || dangerEta <= 6.2 + earlyWarning || (fast && dangerEta <= 7.5 + earlyWarning) ? 2
          : dangerEta <= 10 + earlyWarning ? 3 : 4;
    // response ETA now ends at the final lethal hit, so the deadline only
    // reserves a small impact margin instead of subtracting an estimated kill.
    const learnedMargin = Math.max(-0.08, Math.min(0.32, defendBias * 0.055));
    const impactMargin = (direct?.target === "base" ? 0.18 : fast ? 0.3 : 0.22) + learnedMargin;
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

  function lethalShotEta(tank, enemy, aimReadyEta, shotDistance, freezeTime = 0) {
    const reloadReadyEta = Math.max(0, Number(tank?.cooldown) || 0);
    const firstLaunchEta = Math.max(Math.max(0, aimReadyEta), reloadReadyEta);
    const hits = Math.max(1, Math.ceil(Number(enemy?.hp || enemy?.life) || 1));
    const fireDelay = Math.max(0.3, Number(tank?.fireDelay) || 0.45);
    // A durable moving target may leave the first firing line. One real 90
    // degree turn is reserved for reacquisition instead of pretending every
    // remaining shell can be launched from the original aim solution.
    const stationaryKillEta = firstLaunchEta
      + (hits - 1) * fireDelay
      + Math.max(0, shotDistance) / 310;
    const reacquireAllowance = hits > 1 && Number(enemy?.speed) > 0
      && freezeTime < stationaryKillEta ? 0.3 : 0;
    return stationaryKillEta + reacquireAllowance;
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
        ctx.freezeTime,
      );
    }
    const plan = cachedReliableDefensePlan(ctx, ally, threat);
    if (!plan?.path?.length || !plan.shotDir) return Infinity;
    const path = plan.path;
    const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || ally.dir : ally.dir;
    const movementEta = defenderRouteTravelTime(ally, path, ctx);
    const firingCell = plan.cell || path[path.length - 1];
    const enemyCell = plan.enemyCell || cellOf(enemy);
    const shotDistance = (Math.abs(firingCell.x - enemyCell.x)
      + Math.abs(firingCell.y - enemyCell.y)) * TILE;
    return lethalShotEta(
      ally,
      enemy,
      movementEta + turnTime(arrivalDir, plan.shotDir),
      shotDistance,
      ctx.freezeTime,
    );
  }

  function defenderResponseEta(ctx, ally, threat) {
    if (!ally?.alive || !threat?.enemy?.alive) return Infinity;
    if (!threat.responseEtas) threat.responseEtas = new WeakMap();
    if (threat.responseEtas.has(ally)) return threat.responseEtas.get(ally);
    const planningCtx = planningContextForAlly(ctx, ally);
    const eta = plannedDefenseKillEta(planningCtx, ally, threat);
    threat.responseEtas.set(ally, eta);
    return eta;
  }

  function globalAssignmentCost(ctx, ally, threat) {
    const localDistance = manhattan(ally, threat.enemy);
    const responseEta = defenderResponseEta(ctx, ally, threat);
    const directRank = threat.direct?.target === "base"
      ? -120000 - Math.max(0, 3 - threat.direct.eta) * 8000
      : threat.direct?.target === "guard"
        ? -65000 - Math.max(0, 3 - threat.direct.eta) * 6000
        : 0;
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
    const defendGain = Math.max(0.75, Math.min(1.35, 1 + policyBias(ctx, "defend") * 0.07));
    const attackGain = Math.max(0.82, Math.min(1.25, 1 + policyBias(ctx, "attack") * 0.045));
    const latePenalty = Number.isFinite(responseEta)
      ? Math.max(0, responseEta - threat.responseDeadline) * 50000 * defendGain
      : 250000;
    return directRank + crossedRank + fastRank + verticalRank
      + finiteEta * 520
      + threat.baseDistance * 1.4
      + localDistance * 0.72 * attackGain
      + Math.min(30, responseEta) * 1800 * defendGain
      + latePenalty
      + sidePenalty;
  }

  // Compare whole-team deadline coverage, not a sequence of greedy selections.
  function solveDefenseCoverage(matrix, deadlines) {
    let best = null;
    const visit = (index, owners, used, missed, lateness, cost) => {
      if (index === deadlines.length) {
        const score = [missed, lateness, cost];
        const better = !best || score.some((value, i) =>
          value < best.score[i] && score.slice(0, i).every((v, j) => v === best.score[j]));
        if (better) best = { owners: owners.slice(), score };
        return;
      }
      for (let ally = 0; ally < matrix.length; ally++) {
        if (used.has(ally)) continue;
        const entry = matrix[ally][index];
        const late = Number.isFinite(entry.eta) ? Math.max(0, entry.eta - deadlines[index]) : 60;
        used.add(ally);
        owners.push(ally);
        visit(index + 1, owners, used, missed + Number(late > 0),
          lateness + late, cost + entry.cost);
        owners.pop();
        used.delete(ally);
      }
    };
    visit(0, [], new Set(), 0, 0, 0);
    return best;
  }

  function terminalDefenseThreat(threat) {
    if (!threat?.enemy?.alive) return false;
    if (threat.direct?.target === "base" && threat.direct.eta <= 1.25) return true;
    if (threat.direct?.target === "guard" && threat.direct.eta <= 1.8) return true;
    if (Number(threat.dangerEta) <= 2.8) return true;
    return threat.baseDistance <= TILE * 4.5 && Number(threat.dangerEta) <= 3.8;
  }

  function canShareTerminalThreat(threat, threats) {
    if (threat?.direct?.target !== "base" || threat.direct.eta > 1.1) return false;
    return !(threats || []).some((other) => other !== threat
      && (terminalDefenseThreat(other) || Number(other.dangerEta) <= 4));
  }

  function defenseMissionPhase(threat, plan = null) {
    if (!threat?.enemy?.alive) return "IDLE";
    const terminal = threat.direct?.target === "base"
      || threat.direct?.target === "guard"
      || Number(threat.dangerEta) <= 3.6
      || Number(threat.baseDistance) <= TILE * 5;
    if (terminal) return "TERMINAL";
    return plan?.path?.length ? "INTERCEPT" : "PURSUIT";
  }

  function terminalEngagementPlan(ctx, ally, threat, reservedCells = new Set()) {
    const enemy = threat?.enemy;
    if (!ally?.alive || !enemy?.alive) return null;
    const enemyCell = cellOf(enemy);
    const unique = new Map();
    for (const cell of [
      ...baseEmergencyMeleeGoals(ctx, enemy),
      ...baseEmergencyFlankGoals(ctx, enemy),
      ...closeCombatGoals(ctx, ally, enemy),
    ]) {
      unique.set(keyOf(cell.x, cell.y), cell);
    }
    const candidates = [];
    for (const cell of unique.values()) {
      if (tileCost(ctx, cell.x, cell.y) !== 1) continue;
      const dx = enemyCell.x - cell.x;
      const dy = enemyCell.y - cell.y;
      if (dx !== 0 && dy !== 0) continue;
      const shotDir = dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down";
      if (!shotDir) continue;
      const firingTank = {
        ...ally,
        x: cell.x * TILE + 2,
        y: cell.y * TILE + 2,
        dir: shotDir,
      };
      if (steelBlocksShot(ctx, firingTank, enemy, shotDir)
        || firstShotObstacle(ctx, firingTank, shotDir, enemy)) continue;
      const path = findPath({ ...ctx, aiSideRole: null }, cellOf(ally), [cell]);
      if (!path.length) continue;
      const arrivalDir = path.length > 1 ? routeDirection(path.slice(-2)) || ally.dir : ally.dir;
      const movementEta = defenderRouteTravelTime(ally, path, ctx);
      const readyEta = movementEta + turnTime(arrivalDir, shotDir);
      const killEta = lethalShotEta(ally, enemy, readyEta, manhattan(firingTank, enemy), ctx.freezeTime);
      const shield = baseShieldGeometry(ctx, enemy, cell, shotDir);
      const reserved = reservedCells.has(keyOf(cell.x, cell.y));
      candidates.push({
        cell,
        enemyCell,
        shotDir,
        path,
        allyEta: movementEta,
        readyEta,
        killEta,
        deadlineSpare: Number(threat.responseDeadline) - killEta,
        terminal: true,
        reserved,
        ...shield,
      });
    }
    return candidates.sort((a, b) => Number(a.reserved) - Number(b.reserved)
      || Number(b.shieldSide) - Number(a.shieldSide)
      || Number(b.deadlineSpare >= 0) - Number(a.deadlineSpare >= 0)
      || b.deadlineSpare - a.deadlineSpare
      || a.killEta - b.killEta
      || b.shieldDepth - a.shieldDepth)[0] || null;
  }

  function buildDefenseMission(ctx, ally, threat, reservedCells = new Set()) {
    if (!ally?.alive || !threat?.enemy?.alive) {
      return { phase: "IDLE", target: null, plan: null, deadline: Infinity, responseEta: Infinity };
    }
    const preliminaryPhase = defenseMissionPhase(threat);
    const plan = preliminaryPhase === "TERMINAL"
      ? terminalEngagementPlan(ctx, ally, threat, reservedCells)
      : reservedCells.size
        ? reliableDefensePlan(ctx, ally, threat, reservedCells)
        : cachedReliableDefensePlan(ctx, ally, threat);
    const phase = defenseMissionPhase(threat, plan);
    return {
      phase,
      target: threat.enemy,
      plan,
      goal: plan?.cell || null,
      shotDir: plan?.shotDir || null,
      deadline: Number(threat.responseDeadline),
      responseEta: phase === "TERMINAL" && plan
        ? plan.killEta
        : defenderResponseEta(ctx, ally, threat),
      terminal: phase === "TERMINAL",
    };
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
    const allies = [ctx.tank, ...(ctx.friends || [])].filter((ally) => ally?.alive)
      .sort((a, b) => Number(a.kind === "player2") - Number(b.kind === "player2"));
    const rosterValid = state && state.assignments.size === allies.length
      && allies.every((ally) => state.assignments.has(ally))
      && state.threats.length === livingEnemies.length
      && state.threats.every((threat) => livingEnemies.includes(threat.enemy));
    const assignmentsValid = state && [...state.assignments.entries()].every(([ally, assignment]) => {
      if (assignment.target && (!assignment.target.alive || inForest(ctx, assignment.target))) return false;
      const ownSideExists = livingEnemies.some((enemy) => onAssignedSide(ctx, ally, enemy));
      const urgentAssist = Number(assignment.threat?.defenseTier) <= 2;
      return !ownSideExists || !assignment.target || onAssignedSide(ctx, ally, assignment.target) || urgentAssist;
    });
    const freezeOpportunities = (ctx.bonuses || []).filter((bonus) =>
      !bonus?.dead && bonus.type === "freeze"
        && [ctx.tank, ...(ctx.friends || [])].some((ally) => ally?.alive && tileRange(ally, bonus) <= 8));
    // Reassign the collector on the scheduled global analysis. Running multiple
    // A* searches here on every 60 Hz controller decision defeated the cache.
    const pickupValid = state?.pickupDuty
      ? Boolean(state.pickupDuty.collector?.alive && !state.pickupDuty.bonus?.dead
        && (ctx.bonuses || []).includes(state.pickupDuty.bonus))
      : Boolean(state && freezeOpportunities.length === state.freezeOpportunities?.length
        && freezeOpportunities.every((bonus, index) => bonus === state.freezeOpportunities[index]));
    if (state && state.mapVersion === mapVersion && state.stage === stage
      && now >= state.analyzedAt && now < state.nextAnalysis
      && rosterValid && assignmentsValid && pickupValid) return state;

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
      const terminalThreats = threats.filter(terminalDefenseThreat)
        .sort((a, b) => (a.direct?.eta ?? a.dangerEta) - (b.direct?.eta ?? b.dangerEta)
          || a.baseDistance - b.baseDistance);
      const finalEnemy = threats.length === 1 ? threats[0] : null;
      const sharedTerminal = terminalThreats.length === 1
        && canShareTerminalThreat(terminalThreats[0], threats)
        ? terminalThreats[0]
        : null;
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
      const terminalShared = canShareTerminalThreat(threat, threats);
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
    const coverageMatrix = allies.map((ally) => criticalCoverage.map((threat) => ({
      eta: defenderResponseEta(ctx, ally, threat),
      cost: globalAssignmentCost(ctx, ally, threat)
        + (previous.get(ally)?.target === threat.enemy ? -350 : 0),
    })));
    const jointCoverage = solveDefenseCoverage(coverageMatrix,
      criticalCoverage.map((threat) => threat.responseDeadline));
    const greedyUsed = new Set();
    const greedyOwners = criticalCoverage.map((threat) => {
      const owner = Array.from(allies.keys()).filter((i) => !greedyUsed.has(i))
        .sort((a, b) => globalAssignmentCost(ctx, allies[a], threat)
          - globalAssignmentCost(ctx, allies[b], threat))[0];
      greedyUsed.add(owner);
      return owner;
    });
    const greedyMissed = criticalCoverage.reduce((count, threat, index) =>
      count + Number(coverageMatrix[greedyOwners[index]][index].eta > threat.responseDeadline), 0);
    const useJointCoverage = criticalCoverage.length > 1
      && jointCoverage && jointCoverage.score[0] < greedyMissed
      && coverageMatrix[jointCoverage.owners[0]][0].eta
        <= coverageMatrix[greedyOwners[0]][0].eta + 0.35;
    const previousMissed = criticalCoverage.reduce((count, threat) => {
      const owner = allies.find((ally) => previous.get(ally)?.target === threat.enemy);
      return count + Number(!owner || defenderResponseEta(ctx, owner, threat) > threat.responseDeadline);
    }, 0);
    const rescuesDeadline = useJointCoverage && allies.length > 1 && previous.size > 0
      && jointCoverage && jointCoverage.score[0] < previousMissed;
    for (const threat of criticalCoverage) {
      const sharedCoverage = threats.length === 1
        || (threat.direct?.target === "base" && threat.direct.eta <= 1.1
          && allies.every((ally) => desired.get(ally)?.enemy === threat.enemy));
      if (sharedCoverage) {
        for (const ally of allies) protectedCoverage.add(ally);
        continue;
      }
      const currentOwner = allies.find((ally) => desired.get(ally)?.enemy === threat.enemy);
      const owner = useJointCoverage
        ? allies[jointCoverage.owners[criticalCoverage.indexOf(threat)]]
        : allies.filter((ally) => !protectedCoverage.has(ally))
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
    const missionReservations = new Map();
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
        const terminalShared = canShareTerminalThreat(priorThreat, threats);
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
      if (hardCommitted && !(rescuesDeadline && protectedCoverage.has(ally))) {
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
      } else if (!(rescuesDeadline && protectedCoverage.has(ally)) && !releaseDuplicate && !pickupCover && !priorOffSide
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
      const planningCtx = planningContextForAlly(ctx, ally);
      const reservedCells = target
        ? missionReservations.get(target) || new Set()
        : new Set();
      const mission = target && selected
        ? buildDefenseMission(planningCtx, ally, selected, reservedCells)
        : buildDefenseMission(planningCtx, ally, null, reservedCells);
      if (target && mission.plan?.cell) {
        reservedCells.add(keyOf(mission.plan.cell.x, mission.plan.cell.y));
        missionReservations.set(target, reservedCells);
      }
      const intercept = mission.phase === "INTERCEPT" ? mission.plan : null;
      assignments.set(ally, {
        target,
        threat: selected,
        intercept,
        mission,
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
      freezeOpportunities,
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
      // An open corridor does not require grid-center alignment. Check the full
      // next leg with the tank's footprint before spending a turn on centering.
      if (ctx.canMove?.(dir)) {
        const next = path[1];
        const remaining = horizontal
          ? Math.abs(next.x * TILE + TILE / 2 - tankCenter.x)
          : Math.abs(next.y * TILE + TILE / 2 - tankCenter.y);
        let clear = true;
        for (let travel = 0; travel <= remaining + 4; travel += 4) {
          const distance = Math.min(travel, remaining);
          if (!advisorSearchRectPassable(ctx, tank,
            tank.x + DIRS[dir].x * distance, tank.y + DIRS[dir].y * distance)) { clear = false; break; }
          if (distance === remaining) break;
        }
        if (clear) return { dir, routeDir: dir, aligning: false };
      }
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

  function defenseRouteProgressMetric(tank, path, target = null) {
    if (!tank?.alive || !Array.isArray(path) || !path.length) {
      return target?.alive ? manhattan(tank, target) : Infinity;
    }
    const current = cellOf(tank);
    const index = path.findIndex((cell) => cell.x === current.x && cell.y === current.y);
    if (index < 0) {
      const endpoint = path[path.length - 1];
      return (path.length - 1) * TILE
        + Math.abs(center(tank).x - (endpoint.x * TILE + TILE / 2))
        + Math.abs(center(tank).y - (endpoint.y * TILE + TILE / 2));
    }
    const next = path[index + 1];
    if (!next) return 0;
    const remaining = Math.max(0, path.length - index - 2) * TILE;
    return remaining
      + Math.abs(center(tank).x - (next.x * TILE + TILE / 2))
      + Math.abs(center(tank).y - (next.y * TILE + TILE / 2));
  }

  function movementLoopPattern(entries, currentPoint, currentDistance) {
    const recent = Array.isArray(entries) ? entries.slice(-6) : [];
    if (recent.length < 4) return null;
    const lastFour = recent.slice(-4);
    const alternating = lastFour[0].dir === lastFour[2].dir
      && lastFour[1].dir === lastFour[3].dir
      && opposite(lastFour[0].dir) === lastFour[1].dir;
    const lastFive = recent.slice(-5);
    const closedLoop = lastFive.length === 5
      && lastFive[0].dir === lastFive[4].dir
      && new Set(lastFive.map((entry) => entry.dir)).size >= 3;
    const turnWindow = recent.slice(-Math.min(5, recent.length));
    const first = turnWindow[0];
    const displacement = Math.abs(Number(currentPoint?.x) - Number(first?.x))
      + Math.abs(Number(currentPoint?.y) - Number(first?.y));
    const initialDistance = Number(first?.distance);
    const progress = Number.isFinite(initialDistance) && Number.isFinite(currentDistance)
      ? initialDistance - currentDistance
      : 0;
    const rapidStalledTurns = turnWindow.length >= 4
      && Number(turnWindow.at(-1)?.time) - Number(first?.time) <= 1.25
      && new Set(turnWindow.map((entry) => entry.dir)).size >= 3
      && displacement <= TILE * 1.4
      && progress < TILE * 0.4;
    const returningWithoutProgress = !(displacement > TILE * 1.5 && progress >= TILE);
    if (alternating && returningWithoutProgress) return { entries: lastFour, reason: "opposite-alternation" };
    if (closedLoop && returningWithoutProgress) return { entries: lastFive, reason: "closed-turn-loop" };
    if (rapidStalledTurns) return { entries: turnWindow, reason: "stalled-turn-cycle" };
    return null;
  }

  function capAlignmentMove(action, tank = null) {
    if (!action || action.fire || action.hold || !DIRS[action.moveDir || action.dir]
      || !/-align$/.test(String(action.mode || ""))) return action;
    const requested = Number(action.moveScale);
    const scale = Number.isFinite(requested) && requested > 0 ? requested : 1;
    const dir = action.moveDir || action.dir;
    const turning = tank && (tank.dir !== dir || (Number(tank.turnCooldown) || 0) > 0);
    return {
      ...action,
      moveScale: Math.min(scale, 0.35),
      hold: Boolean(turning),
    };
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
            return { tile, x: tx, y: ty, baseGuard: isProtectedDefenseBrick(ctx, tx, ty) };
          }
        }
      }
    }
    return null;
  }

  function preventGuardShot(ctx, action) {
    if (!action?.fire || !action.dir) return action;
    const obstacle = firstShotObstacle(ctx, ctx.tank, action.dir);
    if (obstacle?.tile !== "E" && !obstacle?.baseGuard) return action;
    return { ...action, fire: false, mode: "core-guard-shot-blocked" };
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

  function frozenContactApproachAction(tank, contact) {
    const t = center(tank);
    const e = center(contact.enemy);
    const dir = contact.approach;
    const remaining = dir === "left" || dir === "right"
      ? Math.abs(e.x - t.x) : Math.abs(e.y - t.y);
    // Keep the final cell conservative; use full-speed travel only after facing
    // the approach direction, well outside that final correction interval.
    const fineAlign = contact.frozenAlignment && (remaining <= TILE || tank.dir !== dir);
    const mode = fineAlign ? "core-freeze-contact-align"
      : contact.baseIntruder ? "core-freeze-base-melee-approach"
      : contact.breakaway ? "core-freeze-contact-breakaway" : "core-freeze-contact-approach";
    return { dir, moveScale: 1, fire: false, hold: false, mode, target: contact.enemy };
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
    const urgentTarget = Boolean(target?.alive && isBaseEmergency(ctx, target));
    const makesUrgentProgress = !urgentTarget || (movementDir
      && projectedTargetDistance(tank, target, movementDir) < manhattan(tank, target) - 0.5);
    const keepMoving = Boolean(movementDir && ctx.canMove?.(movementDir)
      && makesUrgentProgress
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
        if (tile === "S" || tile === "E" || (tile === "B" && isProtectedDefenseBrick(ctx, x, y))) break;
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
    let guard = ctx.baseGuard || ctx.base;
    const direction = DIRS[bullet?.dir];
    if (!guard || !bullet?.enemy || bullet.dead || !direction) return null;
    const bulletCenter = center(bullet);
    const vertical = direction.x === 0;
    let exposedBase = false;
    const base = ctx.base;
    if (base) {
      const distanceToBase = bullet.dir === "down" ? base.y - bulletCenter.y
        : bullet.dir === "up" ? bulletCenter.y - (base.y + base.h)
          : bullet.dir === "right" ? base.x - bulletCenter.x : bulletCenter.x - (base.x + base.w);
      const half = (vertical ? Number(bullet.w) : Number(bullet.h)) / 2 || 3;
      const crossesBase = vertical
        ? bulletCenter.x + half > base.x && bulletCenter.x - half < base.x + base.w
        : bulletCenter.y + half > base.y && bulletCenter.y - half < base.y + base.h;
      exposedBase = crossesBase && distanceToBase >= 0;
      for (let travel = 0; exposedBase && travel < distanceToBase; travel += 4) {
        for (const offset of [-half + 0.01, 0, half - 0.01]) {
          const x = bulletCenter.x + direction.x * travel + (vertical ? offset : 0);
          const y = bulletCenter.y + direction.y * travel + (vertical ? 0 : offset);
          const tile = ctx.tileAt?.(Math.floor(x / TILE), Math.floor(y / TILE))
            ?? ctx.map?.[Math.floor(y / TILE)]?.[Math.floor(x / TILE)] ?? "S";
          if (tile === "B" || tile === "S" || tile === "E") { exposedBase = false; break; }
        }
      }
      if (exposedBase) guard = base;
    }
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
      if (tile === "B" && !isProtectedDefenseBrick(ctx, tx, ty)) return null;
      if (tile === "E" || (tile === "B" && isProtectedDefenseBrick(ctx, tx, ty))) break;
    }
    return { bullet, eta, distance: Math.max(0, distance), guard, exposedBase };
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
    const cacheKey = `${Number(ctx.mapVersion || 0)}:${tankCell.x},${tankCell.y}:${bulletCell.x},${bulletCell.y}`
      + `:${tank.x},${tank.y},${tank.dir},${tank.turnCooldown},${tank.speed}:${bullet.x},${bullet.y},${bullet.dir},${bullet.speed}:${projectile.distance}`;
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
        const counterDir = opposite(bullet.dir);
        // Body interception does not require the cannon to turn after arrival.
        const allyEta = defenderRouteTravelTime(tank, path, ctx);
        if (allyEta + 0.08 >= candidate.bulletEta) return null;
        return {
          ...candidate,
          path,
          allyEta,
          margin: candidate.bulletEta - allyEta,
          counterDir,
          bullet,
          exposedBase: projectile.exposedBase,
        };
      }).filter(Boolean).sort((a, b) => b.margin - a.margin || a.allyEta - b.allyEta)[0] || null;
    tankPlans.set(tank, { key: cacheKey, plan: result });
    return result;
  }

  function assignedBaseProjectileIntercept(ctx, tank) {
    const interceptCtx = {
      ...ctx,
      aiSideRole: null,
      aiAvoidCell: null,
      ignoreAllyRoutes: true,
    };
    const projectile = (ctx.bullets || []).map((bullet) => baseProjectileThreat(interceptCtx, bullet, 4.2))
      .filter(Boolean).sort((a, b) => a.eta - b.eta)[0] || null;
    if (!projectile) return null;
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive);
    const plans = allies.map((ally) => ({
      ally,
      plan: baseProjectileInterceptPlan({ ...interceptCtx, tank: ally }, ally, projectile),
    }))
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

  const movementForecastCaches = new WeakMap();
  function movementProjectiles(ctx, tank) {
    const projectiles = (ctx.bullets || []).filter((bullet) => bullet && !bullet.dead
      && (bullet.enemy || (bullet.owner && bullet.owner !== tank)));
    const announced = new Set();
    // Reports are newest-last. Actual shells use their current positions, never
    // the stale muzzle position from a previous "fire" announcement.
    for (const report of [...(ctx.allyFireReports || [])].reverse()) {
      const owner = report?.owner;
      if (!owner || owner === tank || !owner.alive || report.ttl <= 0
        || report.phase !== "aim" || announced.has(owner)) continue;
      announced.add(owner);
      if (owner.dir !== report.dir || (Number(owner.cooldown) || 0) > 0) continue;
      projectiles.push({ ...report, enemy: false, announced: true });
    }
    return projectiles;
  }

  function movementBulletThreat(ctx, tank, dir, horizon = 0.9) {
    const cache = movementForecastCaches.get(ctx);
    if (!cache || tank !== ctx.tank) return calculateMovementBulletThreat(ctx, tank, dir, horizon);
    const key = `${dir}:${horizon}:${tank.x}:${tank.y}:${tank.dir}:${tank.turnCooldown}`;
    if (!cache.has(key)) cache.set(key, calculateMovementBulletThreat(ctx, tank, dir, horizon));
    return cache.get(key);
  }

  function calculateMovementBulletThreat(ctx, tank, dir, horizon = 0.9) {
    if (isInvulnerable(tank)) return null;
    const hostileBullets = movementProjectiles(ctx, tank);
    if (!hostileBullets.length) return null;
    const actualDir = movementDirectionDuringTurn(tank, dir);
    const movement = DIRS[actualDir];
    if (!movement || !tank?.alive) return null;
    const tankStart = center(tank);
    const tankSpeed = Math.max(45, Number(tank.speed || tank.baseSpeed) || 90);
    const tankHalfW = (Number(tank.w) || 28) / 2;
    const tankHalfH = (Number(tank.h) || 28) / 2;
    let travelLimit = 0;
    const maxTravel = tankSpeed * horizon;
    const blockers = [...(ctx.friends || []), ...(ctx.enemies || [])].filter((other) => other?.alive && other !== tank);
    for (let distance = 2; distance <= maxTravel + 2; distance += 2) {
      const travel = Math.min(distance, maxTravel);
      const probe = { ...tank, x: tank.x + movement.x * travel, y: tank.y + movement.y * travel };
      if (!advisorSearchRectPassable(ctx, tank, probe.x, probe.y)
        || blockers.some((other) => probe.x < other.x + other.w && probe.x + probe.w > other.x
          && probe.y < other.y + other.h && probe.y + probe.h > other.y)) break;
      travelLimit = travel;
      if (travel === maxTravel) break;
    }
    const stopTime = travelLimit / tankSpeed;
    let earliest = null;
    for (const bullet of hostileBullets) {
      const bulletDirection = DIRS[bullet.dir];
      if (!bulletDirection) continue;
      const bulletStart = center(bullet);
      const bulletSpeed = Math.max(120, Number(bullet.speed) || 230);
      const bulletHalfW = (Number(bullet.w) || 6) / 2;
      const bulletHalfH = (Number(bullet.h) || 6) / 2;
      const blockedAt = bulletBlockedDistance(ctx, bullet, bulletSpeed * horizon);
      const end = Math.min(horizon, blockedAt / bulletSpeed);
      // Swept AABB: intersect relative motion, first moving and then blocked.
      for (const [start, finish, speed] of [[0, Math.min(stopTime, end), tankSpeed], [stopTime, end, 0]]) {
        if (finish <= start) continue;
        let enter = 0;
        let exit = finish - start;
        for (const axis of ["x", "y"]) {
          const half = axis === "x" ? tankHalfW + bulletHalfW + 3 : tankHalfH + bulletHalfH + 3;
          const offset = tankStart[axis] + movement[axis] * Math.min(travelLimit, tankSpeed * start)
            - bulletStart[axis] - bulletDirection[axis] * bulletSpeed * start;
          const velocity = movement[axis] * speed - bulletDirection[axis] * bulletSpeed;
          if (Math.abs(velocity) < 1e-9) {
            if (Math.abs(offset) > half) { exit = -1; break; }
          } else {
            const a = (-half - offset) / velocity;
            const b = (half - offset) / velocity;
            enter = Math.max(enter, Math.min(a, b));
            exit = Math.min(exit, Math.max(a, b));
          }
        }
        if (enter <= exit && start + enter < end) {
          const eta = start + enter;
          if (!earliest || eta < earliest.eta) earliest = { bullet, eta };
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
    const pathCtx = { ...ctx, tank, aiSideRole: null, aiAvoidCell: null, ignoreAllyRoutes: true };
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

  function tacticalAdvisorKey(ctx, tank, lockedTarget, baseline) {
    const quantize = (value) => Math.round(Number(value || 0) / (TILE / 2));
    const itemKey = (item) => `${quantize(item.x)},${quantize(item.y)},${item.dir || ""},${item.kind || ""}`
      + `,${Math.max(0, Math.round(Number(item.hp) || 0))},${Math.round(Number(item.speed) || 0)}`;
    const enemies = visibleEnemies(ctx).slice().sort((a, b) =>
      manhattan(a, ctx.base) - manhattan(b, ctx.base)).slice(0, 8).map(itemKey).join(";");
    const bullets = (ctx.bullets || []).filter((bullet) => bullet?.enemy && !bullet.dead)
      .slice(0, 8).map(itemKey).join(";");
    const friends = (ctx.friends || []).filter((friend) => friend?.alive)
      .slice().sort((a, b) => itemKey(a).localeCompare(itemKey(b))).slice(0, 2).map(itemKey).join(";");
    const directive = ctx.globalDirective;
    const directiveKey = directive?.target?.alive
      ? `${itemKey(directive.target)},${Number(directive.threat?.defenseTier ?? 9)}`
        + `,${Math.round((Number(directive.threat?.responseDeadline) || 0) * 10)}`
        + `,${Math.round((Number(directive.threat?.dangerEta) || 0) * 10)}`
      : "none";
    const pickupKey = directive?.pickup && !directive.pickup.dead ? itemKey(directive.pickup) : "none";
    return `${Number(ctx.stage) || 1}:${Number(ctx.mapVersion) || 0}:${itemKey(tank)}`
      + `:${advisorCandidateSignature({
        dir: baseline?.moveDir || baseline?.dir || tank.dir,
        fire: Boolean(baseline?.fire),
        hold: Boolean(baseline?.hold),
      })}:${ctx.canFire?.() ? 1 : 0}:${Math.round((Number(tank.turnCooldown) || 0) * 10)}`
      + `:${lockedTarget?.alive ? itemKey(lockedTarget) : "none"}:${enemies}:${bullets}`
      + `:${friends}:${directiveKey}:${pickupKey}:freeze=${Number(ctx.freezeTime) || 0}`;
  }

  function advisorCandidateSignature(candidate) {
    return `${candidate.dir || ""}:${candidate.fire ? 1 : 0}:${candidate.hold ? 1 : 0}`;
  }

  function autonomyDistanceBucket(distance) {
    if (distance <= TILE * 2.2) return "contact";
    if (distance <= TILE * 5) return "near";
    if (distance <= TILE * 10) return "mid";
    return "far";
  }

  function autonomyTerrainKey(ctx, tank) {
    const cell = cellOf(tank);
    let exits = 0;
    let walls = 0;
    let water = 0;
    let bricks = 0;
    const terrainCtx = { ...ctx, aiSideRole: null, aiAvoidCell: null, ignoreAllyRoutes: true };
    for (const dir of DIR_NAMES) {
      const d = DIRS[dir];
      if (Number.isFinite(tileCost(terrainCtx, cell.x + d.x, cell.y + d.y))) exits++;
    }
    for (let y = cell.y - 2; y <= cell.y + 2; y++) {
      for (let x = cell.x - 2; x <= cell.x + 2; x++) {
        const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
        if (tile === "S" || tile === "E") walls++;
        else if (tile === "W") water++;
        else if (tile === "B") bricks++;
      }
    }
    const bucket = (count) => count === 0 ? 0 : count < 6 ? 1 : 2;
    return `T2-X${exits}-S${bucket(walls)}-W${bucket(water)}-B${bucket(bricks)}`;
  }

  function autonomyStateKey(ctx, tank, target, posture = advisorDefensePosture(ctx, tank)) {
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    const fieldWidth = Math.max(TILE * 3, Number(ctx.cols || 26) * TILE);
    const tankCenter = center(tank);
    const targetCenter = target?.alive ? center(target) : tankCenter;
    const dx = targetCenter.x - tankCenter.x;
    const dy = targetCenter.y - tankCenter.y;
    const axis = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "L" : "R") : (dy < 0 ? "U" : "D");
    const aligned = target?.alive && (Math.abs(dx) <= 22 || Math.abs(dy) <= 22) ? "A" : "N";
    const targetDistance = target?.alive ? pointDistance(tankCenter, targetCenter) : Infinity;
    const baseDistance = target?.alive ? pointDistance(targetCenter, center(ctx.base)) : Infinity;
    const directBase = target?.alive && directBaseShotThreat(ctx, target);
    const threat = directBase ? "direct"
      : baseDistance <= TILE * 5 ? "terminal"
        : posture.urgent ? "urgent"
          : target?.alive && crossedMidline(ctx, target) ? "crossed" : "advance";
    const bullets = (ctx.bullets || []).filter((bullet) => bullet?.enemy && !bullet.dead);
    const bulletDistance = bullets.length
      ? Math.min(...bullets.map((bullet) => pointDistance(tankCenter, center(bullet))))
      : Infinity;
    const bullet = bulletDistance <= TILE * 2.5 ? "B2" : bulletDistance <= TILE * 6 ? "B1" : "B0";
    const freezeNearby = (ctx.bonuses || []).some((bonus) => bonus?.type === "freeze" && !bonus.dead
      && pointDistance(tankCenter, center(bonus)) <= TILE * 3.2);
    const freeze = Number(ctx.freezeTime) > 0 ? "F1" : freezeNearby ? "FP" : "F0";
    const zone = tankCenter.y >= fieldHeight * 0.67 ? "rear" : tankCenter.y >= fieldHeight * 0.34 ? "mid" : "front";
    const side = tankCenter.x < fieldWidth / 2 ? "left" : "right";
    const vector = DIRS[tank.dir] || { x: 0, y: 0 };
    const frontCell = {
      x: Math.floor((tankCenter.x + vector.x * TILE) / TILE),
      y: Math.floor((tankCenter.y + vector.y * TILE) / TILE),
    };
    const frontTile = ctx.tileAt?.(frontCell.x, frontCell.y) || ".";
    const obstacle = frontTile === "S" || frontTile === "W" ? "hard" : frontTile === "B" ? "brick" : "open";
    const enemyCount = visibleEnemies(ctx).length;
    const enemies = enemyCount <= 1 ? "E1" : enemyCount <= 3 ? "E2-3" : "E4+";
    const mission = String(ctx.globalDirective?.mission?.phase || (posture.urgent ? "URGENT" : "IDLE")).slice(0, 10);
    return [autonomyTerrainKey(ctx, tank), threat, zone, side, enemies, mission, axis, aligned,
      autonomyDistanceBucket(targetDistance), bullet, freeze, obstacle].join("|");
  }

  function autonomyActionKey(tank, target, candidate = {}) {
    const dir = candidate.moveDir || candidate.dir || tank.dir;
    const moving = !candidate.hold && Boolean(DIRS[dir]);
    let progress = "hold";
    if (moving && target?.alive) {
      const before = pointDistance(center(tank), center(target));
      const vector = DIRS[dir];
      const after = pointDistance({ x: center(tank).x + vector.x * 16, y: center(tank).y + vector.y * 16 }, center(target));
      progress = after < before - 1 ? "toward" : after > before + 1 ? "away" : "lateral";
    } else if (moving) {
      progress = dir;
    }
    const turn = tank.dir === dir ? 0 : opposite(tank.dir) === dir ? 2 : 1;
    const verb = candidate.fire ? (moving ? "move-fire" : "fire") : moving ? "move" : "hold";
    return `${verb}:${progress}:T${turn}`;
  }

  function projectedCenter(item, seconds, dir = item?.dir, speed = item?.speed) {
    const origin = center(item);
    const vector = DIRS[dir] || { x: 0, y: 0 };
    const distance = Math.max(0, Number(speed) || 0) * seconds;
    return { x: origin.x + vector.x * distance, y: origin.y + vector.y * distance };
  }

  function pointDistance(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function advisorThreatRank(ctx, tank, enemy) {
    const direct = directBaseShotThreat(ctx, enemy);
    const dangerEta = Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy));
    return (direct ? -100000 : 0)
      + dangerEta * 180
      + manhattan(enemy, ctx.base) * 1.8
      + manhattan(enemy, tank) * 0.25
      - (enemy.kind === "fast" ? 260 : 0);
  }

  function advisorRearCoverageEta(ctx, ally, defenseGoals) {
    const current = cellOf(ally);
    const key = `${Number(ctx.stage) || 1}:${Number(ctx.mapVersion) || 0}`
      + `:${current.x},${current.y}:${ally.dir || ""}:${Math.round(Number(ally.speed) || 0)}`
      + `:${defenseGoals.map((goal) => keyOf(goal.x, goal.y)).join(";")}`;
    const cached = advisorRearCoverageCaches.get(ally);
    if (cached?.key === key) return cached.eta;
    const route = findPath({ ...ctx, ignoreAllyRoutes: true }, current, defenseGoals);
    const eta = route.length ? defenderRouteTravelTime(ally, route, ctx) : Infinity;
    advisorRearCoverageCaches.set(ally, { key, eta });
    return eta;
  }

  function advisorDefensePosture(ctx, tank) {
    const threats = ctx.globalThreats || [];
    const assigned = ctx.globalDirective?.threat?.enemy?.alive
      ? ctx.globalDirective.threat
      : threats.slice().sort((a, b) => a.defenseTier - b.defenseTier
        || a.responseDeadline - b.responseDeadline
        || a.baseDistance - b.baseDistance)[0] || null;
    const responseEta = assigned
      ? defenderResponseEta(planningContextForAlly(ctx, tank), tank, assigned)
      : Infinity;
    const deadline = Number(assigned?.responseDeadline);
    const margin = Number.isFinite(responseEta) && Number.isFinite(deadline)
      ? deadline - responseEta
      : assigned ? -Infinity : Infinity;
    const defendBias = policyBias(ctx, "defend");
    const urgencyMargin = Math.max(1.05, Math.min(2.05, 1.4 + defendBias * 0.11));
    const urgent = Boolean(assigned && (
      assigned.direct
      || assigned.crossed
      || assigned.defenseTier <= 2
      || margin <= urgencyMargin
    ));
    const earliestDanger = threats.reduce((best, threat) =>
      Math.min(best, Number.isFinite(threat.dangerEta) ? threat.dangerEta : Infinity), Infinity);
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive);
    const defenseGoals = baseEntryGoals({ ...ctx, aiSideRole: null, ignoreAllyRoutes: true });
    const rearGuard = allies.find((ally) => {
      if (ally === tank || center(ally).y < fieldHeight * 0.52) return false;
      const allyCtx = planningContextForAlly(ctx, ally);
      if (assigned) {
        const eta = defenderResponseEta(allyCtx, ally, assigned);
        const reserve = Math.max(0.35, Math.min(0.8, 0.5 + defendBias * 0.045));
        return Number.isFinite(eta) && eta <= Math.max(0, deadline - reserve);
      }
      if (!defenseGoals.length) return false;
      return advisorRearCoverageEta(allyCtx, ally, defenseGoals) <= 4.5;
    }) || null;
    const rearGuardExists = Boolean(rearGuard);
    const tankAdvanced = center(tank).y < fieldHeight * 0.46;
    const safeToAdvance = !urgent
      && earliestDanger > Math.max(6.8, Math.min(8.8, 7.5 + defendBias * 0.22))
      && (rearGuardExists || !tankAdvanced);
    return {
      assigned,
      responseEta,
      deadline,
      margin,
      urgent,
      earliestDanger,
      safeToAdvance,
      tankAdvanced,
      rearGuardExists,
      rearGuard,
    };
  }

  function advisorCandidates(ctx, tank, baseline, lockedTarget) {
    const candidates = [{
      dir: baseline?.moveDir || baseline?.dir || tank.dir,
      fire: Boolean(baseline?.fire),
      hold: Boolean(baseline?.hold),
      tag: "baseline",
    }];
    const ranked = visibleEnemies(ctx).slice().sort((a, b) =>
      advisorThreatRank(ctx, tank, a) - advisorThreatRank(ctx, tank, b)).slice(0, 3);
    if (lockedTarget?.alive && !ranked.includes(lockedTarget)) ranked.unshift(lockedTarget);
    for (const enemy of ranked) {
      const shotDir = currentPositionShot(ctx, tank, enemy)
        || directShot(ctx, tank, enemy)
        || predictiveShot(ctx, tank, enemy);
      if (!shotDir) continue;
      candidates.push({
        dir: shotDir,
        fire: Boolean(ctx.canFire?.()),
        hold: false,
        tag: "fire",
        target: enemy,
      });
    }
    for (const dir of DIR_NAMES) {
      if (ctx.canMove?.(dir) === false) continue;
      candidates.push({ dir, fire: false, hold: false, tag: "move" });
    }
    const unique = new Map();
    for (const candidate of candidates) {
      const key = advisorCandidateSignature(candidate);
      if (!unique.has(key) || candidate.tag === "fire") unique.set(key, candidate);
    }
    return [...unique.values()].slice(0, 8);
  }

  function scoreAdvisorCandidate(ctx, tank, candidate, lockedTarget, posture = advisorDefensePosture(ctx, tank)) {
    const horizons = [0.35, 0.8, 1.25];
    const moving = !candidate.hold && DIRS[candidate.dir];
    const speed = moving ? Math.max(0, Number(tank.speed || tank.baseSpeed) || 0) : 0;
    const tankStart = center(tank);
    const target = candidate.target?.alive ? candidate.target : lockedTarget?.alive ? lockedTarget : null;
    const dangerous = visibleEnemies(ctx).slice().sort((a, b) =>
      advisorThreatRank(ctx, tank, a) - advisorThreatRank(ctx, tank, b))[0] || target;
    let score = candidate.tag === "baseline" ? 4 : 0;
    let bulletRisk = 0;
    let interceptGain = 0;
    if (candidate.dir !== tank.dir) score -= turnTime(tank.dir, candidate.dir) * 20;
    if (candidate.hold && dangerous) score -= 18;
    if (candidate.hold && posture.urgent) score -= 110;
    if (candidate.fire && candidate.target?.alive) {
      score += 145;
      if (directBaseShotThreat(ctx, candidate.target)) score += 120;
      if (candidate.target.kind === "fast") score += 35;
    }
    const crossing = moving ? movementBulletThreat(ctx, tank, candidate.dir, 1.4) : null;
    if (crossing) {
      bulletRisk += 520;
      score -= 520;
    }
    for (const horizon of horizons) {
      const tankFuture = projectedCenter(tank, horizon, candidate.dir, speed);
      if (target) {
        const targetFuture = projectedCenter(target, horizon);
        const startDistance = pointDistance(tankStart, center(target));
        const futureDistance = pointDistance(tankFuture, targetFuture);
        const gain = startDistance - futureDistance;
        interceptGain += gain;
        score += gain * (isBaseEmergency(ctx, target) ? 0.16 : 0.09);
      }
      if (dangerous) {
        const enemyFuture = projectedCenter(dangerous, horizon);
        const baseCenter = center(ctx.base);
        const enemyBaseDistance = pointDistance(enemyFuture, baseCenter);
        const tankEnemyDistance = pointDistance(tankFuture, enemyFuture);
        if (enemyBaseDistance <= TILE * 6) score -= enemyBaseDistance <= TILE * 3 ? 32 : 12;
        if (enemyBaseDistance <= TILE * 6 && tankEnemyDistance <= TILE * 4.5) score += 28;
      }
      for (const bullet of (ctx.bullets || [])) {
        if (!bullet?.enemy || bullet.dead) continue;
        const bulletFuture = projectedCenter(bullet, horizon, bullet.dir, bullet.speed || 180);
        const distance = pointDistance(tankFuture, bulletFuture);
        if (distance > TILE * 1.15) continue;
        const penalty = distance <= TILE * 0.55 ? 170 : 70;
        bulletRisk += penalty;
        score -= penalty;
      }
    }
    if (moving && target) {
      const direction = DIRS[candidate.dir];
      const targetCenter = center(target);
      const toward = direction.x * (targetCenter.x - tankStart.x)
        + direction.y * (targetCenter.y - tankStart.y);
      if (toward < -TILE * 0.25) score -= isBaseEmergency(ctx, target) ? 95 : 38;
    }
    if (moving && candidate.dir === "up") {
      score += posture.safeToAdvance ? 24 : -180;
      if (posture.tankAdvanced && !posture.rearGuardExists) score -= 140;
    } else if (moving && candidate.dir === "down") {
      if (posture.urgent) score += 130;
      else if (posture.safeToAdvance) score -= 14;
    }
    return { score, bulletRisk, interceptGain };
  }

  function advisorSearchClock() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function advisorSearchEntity(item) {
    return {
      source: item,
      x: Number(item?.x) || 0,
      y: Number(item?.y) || 0,
      w: Number(item?.w) || 28,
      h: Number(item?.h) || 28,
      dir: item?.dir || "up",
      speed: Math.max(0, Number(item?.speed || item?.baseSpeed) || 0),
      hp: Math.max(1, Number(item?.hp || item?.life) || 1),
      kind: item?.kind || "basic",
      cooldown: Math.max(0, Number(item?.cooldown) || 0),
    };
  }

  function advisorSearchRectPassable(ctx, entity, x, y) {
    const inset = 2;
    const corners = [
      [x + inset, y + inset],
      [x + entity.w - inset, y + inset],
      [x + inset, y + entity.h - inset],
      [x + entity.w - inset, y + entity.h - inset],
    ];
    for (const [px, py] of corners) {
      const cellX = Math.floor(px / TILE);
      const cellY = Math.floor(py / TILE);
      if (cellX < 0 || cellY < 0 || cellX >= ctx.cols || cellY >= ctx.rows) return false;
      const tile = ctx.tileAt?.(cellX, cellY) ?? ctx.map?.[cellY]?.[cellX] ?? "S";
      if (tile !== "." && tile !== "F") return false;
      if (isGuardCell(ctx, cellX, cellY)) return false;
    }
    return true;
  }

  function advisorAdvanceEntity(ctx, entity, dir, seconds, hold = false) {
    const next = { ...entity, dir: dir || entity.dir };
    if (hold || !DIRS[dir]) return next;
    const moveSeconds = Math.max(0, seconds - turnTime(entity.dir, dir));
    if (moveSeconds <= 0) return next;
    const vector = DIRS[dir];
    const distance = Math.min(TILE * 0.95, entity.speed * moveSeconds);
    const steps = Math.max(1, Math.ceil(distance / 6));
    for (let step = 1; step <= steps; step++) {
      const travel = distance * step / steps;
      const x = entity.x + vector.x * travel;
      const y = entity.y + vector.y * travel;
      if (!advisorSearchRectPassable(ctx, entity, x, y)) break;
      next.x = x;
      next.y = y;
    }
    return next;
  }

  function advisorSearchLineClear(ctx, from, to, dir) {
    const vector = DIRS[dir];
    if (!vector) return false;
    const a = center(from);
    const b = center(to);
    const axial = (b.x - a.x) * vector.x + (b.y - a.y) * vector.y;
    const lateral = dir === "up" || dir === "down" ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
    const vertical = dir === "up" || dir === "down";
    if (axial <= 0 || lateral >= (vertical ? to.w : to.h) / 2 + 3) return false;
    // Sweep the actual six-pixel projectile from its muzzle to first target contact.
    const end = Math.max(16, axial - (vertical ? to.h : to.w) / 2 - 3);
    const sx = a.x + vector.x * 16;
    const sy = a.y + vector.y * 16;
    const ex = a.x + vector.x * end;
    const ey = a.y + vector.y * end;
    const left = Math.floor((Math.min(sx, ex) - 3) / TILE);
    const right = Math.ceil((Math.max(sx, ex) + 3) / TILE) - 1;
    const top = Math.floor((Math.min(sy, ey) - 3) / TILE);
    const bottom = Math.ceil((Math.max(sy, ey) + 3) / TILE) - 1;
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
      if (tile === "S" || tile === "B" || tile === "E") return false;
    }
    return true;
  }

  function advisorSearchShotDirection(ctx, from, to) {
    const a = center(from);
    const b = center(to);
    const ordered = Math.abs(b.x - a.x) <= Math.abs(b.y - a.y)
      ? [b.y < a.y ? "up" : "down", b.x < a.x ? "left" : "right"]
      : [b.x < a.x ? "left" : "right", b.y < a.y ? "up" : "down"];
    return ordered.find((dir) => advisorSearchLineClear(ctx, from, to, dir)) || null;
  }

  function createAdvisorSearchState(ctx, tank, lockedTarget) {
    const enemies = visibleEnemies(ctx).slice().sort((a, b) =>
      advisorThreatRank(ctx, tank, a) - advisorThreatRank(ctx, tank, b)).slice(0, 4);
    if (lockedTarget?.alive && !enemies.includes(lockedTarget)) enemies.unshift(lockedTarget);
    return {
      tank: advisorSearchEntity(tank),
      enemies: enemies.slice(0, 4).map(advisorSearchEntity),
      swing: 0,
      freezeRemaining: Math.max(0, Number(ctx.freezeTime) || 0),
    };
  }

  function advisorSearchEnemyDanger(ctx, state, enemy) {
    const baseDistance = pointDistance(center(enemy), center(ctx.base));
    const direct = advisorSearchShotDirection(ctx, enemy, ctx.base);
    const tankDistance = pointDistance(center(enemy), center(state.tank));
    return baseDistance + tankDistance * 0.12 - (direct ? TILE * 10 : 0)
      - (enemy.kind === "fast" ? TILE * 1.8 : 0);
  }

  function advisorSearchStaticScore(ctx, state, targetSource) {
    const baseCenter = center(ctx.base);
    const tankCenter = center(state.tank);
    let score = Number(state.swing) || 0;
    let target = state.enemies.find((enemy) => enemy.source === targetSource) || null;
    if (!target) target = state.enemies.slice().sort((a, b) =>
      advisorSearchEnemyDanger(ctx, state, a) - advisorSearchEnemyDanger(ctx, state, b))[0] || null;
    for (const enemy of state.enemies) {
      const enemyCenter = center(enemy);
      const baseDistance = pointDistance(enemyCenter, baseCenter);
      const tankDistance = pointDistance(enemyCenter, tankCenter);
      score += Math.min(18, baseDistance / TILE) * 6;
      if (baseDistance <= TILE * 6) score -= (TILE * 6 - baseDistance) * 0.34;
      const baseShot = advisorSearchShotDirection(ctx, enemy, ctx.base);
      if (baseShot) score -= baseDistance <= TILE * 5 ? 260 : 150;
      if (baseDistance <= TILE * 5 && tankDistance <= TILE * 4.5) score += 34;
      if (enemy.kind === "fast" && baseDistance <= TILE * 9) score -= 28;
    }
    if (target) {
      const targetDistance = pointDistance(tankCenter, center(target));
      score -= targetDistance * 0.075;
      const shot = advisorSearchShotDirection(ctx, state.tank, target);
      if (shot) score += targetDistance <= TILE * 3 ? 130 : 75;
    }
    for (const bullet of (ctx.bullets || [])) {
      if (!bullet?.enemy || bullet.dead) continue;
      const direction = DIRS[bullet.dir];
      if (!direction) continue;
      const bulletCenter = center(bullet);
      const toTankX = tankCenter.x - bulletCenter.x;
      const toTankY = tankCenter.y - bulletCenter.y;
      const axial = toTankX * direction.x + toTankY * direction.y;
      const lateral = bullet.dir === "up" || bullet.dir === "down" ? Math.abs(toTankX) : Math.abs(toTankY);
      if (axial > 0 && axial <= TILE * 5 && lateral <= 20) score -= 190 - axial * 0.55;
    }
    return score;
  }

  function advisorSearchStateKey(ctx, state, depth, maximizing) {
    const item = (entity) => `${entity.x},${entity.y},${entity.dir},${entity.hp},${entity.cooldown}`;
    return `${Number(ctx.stage) || 1}:${Number(ctx.mapVersion) || 0}:${depth}:${maximizing ? 1 : 0}`
      + `:${item(state.tank)}:${state.enemies.map(item).join(";")}:${state.swing}:${state.freezeRemaining}`;
  }

  function advisorSearchOwnActions(ctx, state, targetSource) {
    const target = state.enemies.find((enemy) => enemy.source === targetSource)
      || state.enemies.slice().sort((a, b) => advisorSearchEnemyDanger(ctx, state, a) - advisorSearchEnemyDanger(ctx, state, b))[0];
    const actions = [];
    if (target) {
      const shot = advisorSearchShotDirection(ctx, state.tank, target);
      if (shot) actions.push({ dir: shot, fire: true, hold: false, target: target.source, order: 10000 });
    }
    for (const dir of [state.tank.dir, ...DIR_NAMES]) {
      if (!DIRS[dir]) continue;
      const moved = advisorAdvanceEntity(ctx, state.tank, dir, ADVISOR_SEARCH_STEP);
      const progress = target
        ? pointDistance(center(state.tank), center(target)) - pointDistance(center(moved), center(target))
        : 0;
      actions.push({ dir, fire: false, hold: false, order: progress * 6 - turnTime(state.tank.dir, dir) * 20 });
    }
    const unique = new Map();
    for (const action of actions) {
      const key = advisorCandidateSignature(action);
      if (!unique.has(key) || action.fire) unique.set(key, action);
    }
    return [...unique.values()].sort((a, b) => b.order - a.order).slice(0, 6);
  }

  function advisorSearchEnemyActions(ctx, state) {
    if (state.freezeRemaining > 0) return [{ enemy: null, dir: null, fire: false, hold: true }];
    const ranked = state.enemies.slice().sort((a, b) =>
      advisorSearchEnemyDanger(ctx, state, a) - advisorSearchEnemyDanger(ctx, state, b));
    const enemy = ranked[0];
    if (!enemy) return [];
    const e = center(enemy);
    const base = center(ctx.base);
    const tank = center(state.tank);
    const towardBase = Math.abs(base.y - e.y) >= Math.abs(base.x - e.x)
      ? [base.y < e.y ? "up" : "down", base.x < e.x ? "left" : "right"]
      : [base.x < e.x ? "left" : "right", base.y < e.y ? "up" : "down"];
    const towardTank = Math.abs(tank.y - e.y) >= Math.abs(tank.x - e.x)
      ? (tank.y < e.y ? "up" : "down")
      : (tank.x < e.x ? "left" : "right");
    const actions = [];
    const baseShot = advisorSearchShotDirection(ctx, enemy, ctx.base);
    if (baseShot) actions.push({ enemy: enemy.source, dir: baseShot, fire: true, hold: false, order: -10000 });
    const tankShot = advisorSearchShotDirection(ctx, enemy, state.tank);
    if (tankShot) actions.push({ enemy: enemy.source, dir: tankShot, fire: true, hold: false, order: -9000 });
    for (const dir of [enemy.dir, ...towardBase, towardTank]) {
      actions.push({ enemy: enemy.source, dir, fire: false, hold: false, order: turnTime(enemy.dir, dir) * 10 });
    }
    const unique = new Map();
    for (const action of actions) {
      const key = `${action.enemy === enemy.source ? 1 : 0}:${advisorCandidateSignature(action)}`;
      if (!unique.has(key) || action.fire) unique.set(key, action);
    }
    return [...unique.values()].sort((a, b) => a.order - b.order).slice(0, 4);
  }

  function advisorSearchApply(ctx, state, action, maximizing) {
    const next = {
      tank: { ...state.tank },
      enemies: state.enemies.map((enemy) => ({ ...enemy })),
      swing: Number(state.swing) || 0,
      freezeRemaining: Math.max(0, Number(state.freezeRemaining) || 0),
    };
    if (maximizing) {
      next.tank = advisorAdvanceEntity(ctx, next.tank, action.dir, ADVISOR_SEARCH_STEP, action.hold);
      if (action.fire && state.tank.cooldown <= 0
        && turnTime(state.tank.dir, action.dir) <= ADVISOR_SEARCH_STEP) {
        const target = [...next.enemies, ...(ctx.friends || []).filter((friend) => friend.alive)]
          .filter((entity) => advisorSearchLineClear(ctx, next.tank, entity, action.dir))
          .sort((a, b) => pointDistance(center(next.tank), center(a))
            - pointDistance(center(next.tank), center(b)))[0];
        if (target && !next.enemies.includes(target)) {
          next.swing -= 220;
          next.tank.cooldown = 0.6;
          return next;
        }
        if (target && advisorSearchLineClear(ctx, next.tank, target, action.dir)) {
          next.swing += target.kind === "armor" ? 115 : 165;
          target.hp--;
          if (target.hp <= 0) next.enemies = next.enemies.filter((enemy) => enemy !== target);
          next.tank.cooldown = 0.6;
        }
      }
      return next;
    }
    next.tank.cooldown = Math.max(0, next.tank.cooldown - ADVISOR_SEARCH_STEP);
    for (const enemy of next.enemies) enemy.cooldown = Math.max(0, enemy.cooldown - ADVISOR_SEARCH_STEP);
    if (next.freezeRemaining > 0) {
      next.freezeRemaining = Math.max(0, next.freezeRemaining - ADVISOR_SEARCH_STEP);
      return next;
    }
    const index = next.enemies.findIndex((enemy) => enemy.source === action.enemy);
    if (index < 0) return next;
    next.enemies[index] = advisorAdvanceEntity(ctx, next.enemies[index], action.dir, ADVISOR_SEARCH_STEP, action.hold);
    if (action.fire && state.enemies[index].cooldown <= 0
      && turnTime(state.enemies[index].dir, action.dir) <= ADVISOR_SEARCH_STEP) {
      next.enemies[index].cooldown = 0.6;
      if (advisorSearchLineClear(ctx, next.enemies[index], ctx.base, action.dir)) next.swing -= 280;
      else if (advisorSearchLineClear(ctx, next.enemies[index], next.tank, action.dir)) next.swing -= 155;
    }
    return next;
  }

  function advisorSearchBudgetExceeded(search) {
    if (search.nodes >= ADVISOR_NODE_LIMIT) return true;
    return search.nodes >= 24 && advisorSearchClock() - search.startedAt >= ADVISOR_BUDGET_MS;
  }

  function advisorAlphaBeta(ctx, state, targetSource, depth, maximizing, alpha, beta, search) {
    search.nodes++;
    if (depth <= 0 || advisorSearchBudgetExceeded(search)) {
      if (advisorSearchBudgetExceeded(search)) search.aborted = true;
      return advisorSearchStaticScore(ctx, state, targetSource);
    }
    const key = advisorSearchStateKey(ctx, state, depth, maximizing)
      + `:target=${(ctx.enemies || []).indexOf(targetSource)}`;
    const alphaOriginal = alpha;
    const betaOriginal = beta;
    const cached = advisorTranspositionTable.get(key);
    if (cached) {
      search.ttHits++;
      if (cached.bound === "exact") return cached.value;
      if (cached.bound === "lower") alpha = Math.max(alpha, cached.value);
      if (cached.bound === "upper") beta = Math.min(beta, cached.value);
      if (alpha >= beta) return cached.value;
    }
    const actions = maximizing
      ? advisorSearchOwnActions(ctx, state, targetSource)
      : advisorSearchEnemyActions(ctx, state);
    if (!actions.length) return advisorSearchStaticScore(ctx, state, targetSource);
    let value = maximizing ? -Infinity : Infinity;
    let cutoff = false;
    for (const action of actions) {
      const next = advisorSearchApply(ctx, state, action, maximizing);
      const child = advisorAlphaBeta(ctx, next, targetSource, depth - 1, !maximizing, alpha, beta, search);
      if (maximizing) {
        value = Math.max(value, child);
        alpha = Math.max(alpha, value);
      } else {
        value = Math.min(value, child);
        beta = Math.min(beta, value);
      }
      if (beta <= alpha || advisorSearchBudgetExceeded(search)) {
        cutoff = beta <= alpha;
        if (cutoff) search.cutoffs++;
        if (advisorSearchBudgetExceeded(search)) search.aborted = true;
        break;
      }
    }
    if (!search.aborted && Number.isFinite(value)) {
      const bound = value <= alphaOriginal ? "upper" : value >= betaOriginal ? "lower" : "exact";
      advisorTranspositionTable.set(key, { value, bound });
      if (advisorTranspositionTable.size > 768) {
        advisorTranspositionTable.delete(advisorTranspositionTable.keys().next().value);
      }
    }
    return Number.isFinite(value) ? value : advisorSearchStaticScore(ctx, state, targetSource);
  }

  function advisorCorrectionKey(ctx, tank, candidate, lockedTarget, posture) {
    const tankCenter = center(tank);
    const targetCenter = center(candidate.target?.alive ? candidate.target : lockedTarget?.alive ? lockedTarget : tank);
    const dx = Math.max(-4, Math.min(4, Math.round((targetCenter.x - tankCenter.x) / TILE)));
    const dy = Math.max(-4, Math.min(4, Math.round((targetCenter.y - tankCenter.y) / TILE)));
    return `${Number(ctx.stage) || 1}:${tank.dir}:${candidate.dir || ""}:${candidate.fire ? 1 : 0}`
      + `:${dx},${dy}:${posture.urgent ? 1 : 0}`;
  }

  function searchTacticalAdvice(ctx, tank, baseline, lockedTarget, services = null) {
    // Position values depend on live bullets, terrain, freeze, and the assigned target.
    // Reuse transpositions within this search, never across unrelated world snapshots.
    const worldKey = tacticalAdvisorKey(ctx, tank, lockedTarget, baseline)
      + JSON.stringify([ctx.map, ctx.base, (ctx.bullets || []).map((b) => [b.x, b.y, b.dir, b.dead]),
        [tank, ...visibleEnemies(ctx)].map((t) => [t.x, t.y, t.hp, t.cooldown])]);
    if (worldKey !== advisorSearchWorldKey) advisorTranspositionTable.clear();
    advisorSearchWorldKey = worldKey;
    const startedAt = advisorSearchClock();
    const posture = advisorDefensePosture(ctx, tank);
    const candidates = advisorCandidates(ctx, tank, baseline, lockedTarget);
    const baselineCandidate = {
      dir: baseline?.moveDir || baseline?.dir || tank.dir,
      fire: Boolean(baseline?.fire),
      hold: Boolean(baseline?.hold),
      tag: "baseline",
    };
    const initialState = createAdvisorSearchState(ctx, tank, lockedTarget);
    const initialStatic = advisorSearchStaticScore(ctx, initialState, lockedTarget);
    const autonomyKey = autonomyStateKey(ctx, tank, lockedTarget, posture);
    const actionKeys = candidates.map((candidate) => autonomyActionKey(tank, candidate.target?.alive ? candidate.target : lockedTarget, candidate));
    const autonomy = services?.evaluateAutonomyActions?.(autonomyKey, actionKeys, {
      urgent: posture.urgent,
      safeToExplore: !posture.urgent
        && !(ctx.bullets || []).some((bullet) => bulletThreat(ctx, tank, bullet, 2.4))
        && !(ctx.bonuses || []).some((bonus) => bonus?.type === "freeze" && !bonus.dead && tileRange(tank, bonus) <= 3),
      stage: ctx.stage,
      time: ctx.gameTime,
    }) || { biases: {}, champion: null, exploreKey: null, generation: 0 };
    const roots = candidates.map((candidate) => {
      const metrics = scoreAdvisorCandidate(ctx, tank, candidate, lockedTarget, posture);
      const correctionKey = advisorCorrectionKey(ctx, tank, candidate, lockedTarget, posture);
      const correction = Number(advisorCorrectionHistory.get(correctionKey)) || 0;
      const actionKey = autonomyActionKey(tank, candidate.target?.alive ? candidate.target : lockedTarget, candidate);
      const evolutionBias = Number(autonomy.biases?.[actionKey]) || 0;
      const immediateScore = metrics.score + correction + evolutionBias;
      return { ...candidate, ...metrics, immediateScore, score: immediateScore, correctionKey, actionKey, evolutionBias };
    });
    let completed = roots;
    let completedDepth = 1;
    const search = { startedAt, nodes: 0, ttHits: 0, cutoffs: 0, aborted: false };
    for (let depth = 2; depth <= ADVISOR_MAX_DEPTH; depth++) {
      search.aborted = false;
      const ordered = completed.slice().sort((a, b) => b.score - a.score);
      const iteration = [];
      for (const root of ordered) {
        const next = advisorSearchApply(ctx, initialState, root, true);
        const future = advisorAlphaBeta(ctx, next, root.target || lockedTarget, depth - 1, false, -Infinity, Infinity, search);
        iteration.push({ ...root, score: root.immediateScore + ADVISOR_FUTURE_WEIGHT * (future - initialStatic) });
        if (search.aborted) break;
      }
      if (search.aborted || iteration.length !== roots.length) break;
      completed = iteration;
      completedDepth = depth;
    }
    const best = completed.slice().sort((a, b) => b.score - a.score)[0] || null;
    const evaluated = roots.length;
    const baselineSignature = advisorCandidateSignature({
      dir: baseline?.moveDir || baseline?.dir || tank.dir,
      fire: Boolean(baseline?.fire),
      hold: Boolean(baseline?.hold),
    });
    const baselineResult = completed.find((candidate) => advisorCandidateSignature(candidate) === baselineSignature)
      || { ...baselineCandidate, ...scoreAdvisorCandidate(ctx, tank, baselineCandidate, lockedTarget, posture) };
    const bestSignature = advisorCandidateSignature(best || {});
    const reason = !best ? "no-candidate"
      : best.bulletRisk > 0 ? "bullet-risk"
        : best.fire ? "fire-window"
          : best.interceptGain > TILE * 0.4 ? "intercept-gain"
            : best.tag === "baseline" ? "baseline-best" : "position-gain";
    const result = {
      shadow: false,
      globalControl: true,
      dir: best?.dir || baseline?.dir || tank.dir,
      fire: Boolean(best?.fire),
      hold: Boolean(best?.hold),
      tag: best?.tag || "none",
      score: Number((best?.score || 0).toFixed(2)),
      scoreGain: Number(((best?.score || 0) - (Number(baselineResult.score) || 0)).toFixed(2)),
      bulletRisk: Number(best?.bulletRisk || 0),
      interceptGain: Number(best?.interceptGain || 0),
      reason,
      differs: bestSignature !== baselineSignature,
      evaluated,
      depth: completedDepth,
      nodes: search.nodes,
      ttHits: search.ttHits,
      cutoffs: search.cutoffs,
      budgetMs: ADVISOR_BUDGET_MS,
      autonomyState: autonomyKey,
      autonomyAction: best?.actionKey || autonomyActionKey(tank, lockedTarget, best || baselineCandidate),
      autonomyBias: Number((best?.evolutionBias || 0).toFixed(2)),
      autonomyChampion: autonomy.champion || null,
      autonomyExplored: Boolean(autonomy.exploreKey && best?.actionKey === autonomy.exploreKey),
      autonomyGeneration: Number(autonomy.generation) || 0,
    };
    if (best?.correctionKey && completedDepth > 1) {
      const previous = Number(advisorCorrectionHistory.get(best.correctionKey)) || 0;
      const searchDelta = Math.max(-30, Math.min(30, best.score - best.immediateScore));
      advisorCorrectionHistory.set(best.correctionKey, Math.max(-24, Math.min(24, previous * 0.86 + searchDelta * 0.14)));
      if (advisorCorrectionHistory.size > 256) {
        advisorCorrectionHistory.delete(advisorCorrectionHistory.keys().next().value);
      }
    }
    tacticalAdvisorPostures.set(result, posture);
    return result;
  }

  function updateTacticalAdvisor(ctx, tank, baseline, lockedTarget, now, state, services, name) {
    const autonomyMemory = services?.readMemory?.()?.autonomy;
    const autonomyRevision = `${Number(autonomyMemory?.generation) || 0}.${Math.floor((Number(autonomyMemory?.updates) || 0) / 8)}`;
    const key = `${tacticalAdvisorKey(ctx, tank, lockedTarget, baseline)}:L${autonomyRevision}`;
    const emergency = Boolean(lockedTarget?.alive && isBaseEmergency(ctx, lockedTarget))
      || Boolean((ctx.bullets || []).some((bullet) => bulletThreat(ctx, tank, bullet, 2.4)));
    const emergencyTransition = emergency && !state.emergency;
    state.emergency = emergency;
    if (now < state.nextAt && state.result && !emergencyTransition) return state.result;
    state.key = key;
    state.nextAt = now + (emergency ? ADVISOR_EMERGENCY_CADENCE : ADVISOR_CADENCE);
    const cached = tacticalAdvisorCache.get(key);
    if (cached) {
      state.cacheHits++;
      tacticalAdvisorTelemetry.cacheHits++;
      tacticalAdvisorTelemetry.lastScore = cached.score;
      tacticalAdvisorTelemetry.lastReason = cached.reason;
      state.result = cached;
      const displayNow = Date.now();
      if (displayNow - advisorDisplayUpdatedAt >= 500) {
        advisorDisplayUpdatedAt = displayNow;
        refreshAiVersionDisplay();
      }
      return cached;
    }
    const result = searchTacticalAdvice(ctx, tank, baseline, lockedTarget, services);
    state.runs++;
    tacticalAdvisorTelemetry.runs++;
    tacticalAdvisorTelemetry.nodes += Number(result.nodes) || 0;
    tacticalAdvisorTelemetry.ttHits += Number(result.ttHits) || 0;
    tacticalAdvisorTelemetry.cutoffs += Number(result.cutoffs) || 0;
    tacticalAdvisorTelemetry.depth = Math.max(1, Number(result.depth) || 1);
    tacticalAdvisorTelemetry.lastScore = result.score;
    tacticalAdvisorTelemetry.lastReason = result.reason;
    if (result.differs) {
      state.disagreements++;
      tacticalAdvisorTelemetry.disagreements++;
    }
    state.result = result;
    tacticalAdvisorCache.set(key, result);
    if (tacticalAdvisorCache.size > 256) tacticalAdvisorCache.delete(tacticalAdvisorCache.keys().next().value);
    if (result.differs && now - state.lastRecordedAt >= 2) {
      state.lastRecordedAt = now;
      services?.recordExperience?.("ai_global_decision", {
        stage: ctx.stage,
        time: now,
        player: name,
        liveMode: baseline?.mode,
        liveDir: baseline?.moveDir || baseline?.dir,
        adviceDir: result.dir,
        adviceFire: result.fire,
        reason: result.reason,
        score: result.score,
      });
    }
    const displayNow = Date.now();
    if (displayNow - advisorDisplayUpdatedAt >= 500) {
      advisorDisplayUpdatedAt = displayNow;
      refreshAiVersionDisplay();
    }
    return result;
  }

  function advisorPhaseOneProgress(ctx, tank, lockedTarget, dir) {
    if (!lockedTarget?.alive || !DIRS[dir]) return -Infinity;
    const vector = DIRS[dir];
    const step = Math.max(8, Math.min(TILE / 2, (Number(tank.speed || tank.baseSpeed) || 90) * 0.16));
    const next = { ...tank, x: tank.x + vector.x * step, y: tank.y + vector.y * step };
    const intercept = ctx.globalDirective?.target === lockedTarget ? ctx.globalDirective?.intercept : null;
    const endpoint = intercept?.path?.at?.(-1);
    const goal = endpoint
      ? { x: endpoint.x * TILE + 2, y: endpoint.y * TILE + 2, w: 28, h: 28 }
      : lockedTarget;
    return manhattan(tank, goal) - manhattan(next, goal);
  }

  function advisorPhaseOneBlockReason(ctx, tank, baseline, lockedTarget, advice) {
    if (!advice?.differs || advice.tag !== "move" || advice.fire || advice.hold) return "not-safe-move";
    if (!lockedTarget?.alive || !DIRS[advice.dir]) return "no-live-target";
    if (baseline?.fire || baseline?.hold || !DIRS[baseline?.moveDir || baseline?.dir]) return "live-action-protected";
    if ((Number(ctx.freezeTime) || 0) > 0) return "freeze-protected";
    const liveMode = String(baseline?.mode || "");
    const allowedMode = /core-(?:chase|same-direction-chase|breakthrough-(?:chase|recover|replan)|dynamic-detour|intercept-(?:route|pressure-route|pressure-screen-route)|path-align|replan|shot-lane-(?:reposition|replan)|steel-reposition)/.test(liveMode);
    if (!allowedMode) return "mode-protected";
    if (visibleEnemies(ctx).some((enemy) => bodyGap(tank, enemy) <= TILE * 2)) return "close-combat-protected";
    if (visibleEnemies(ctx).some((enemy) => directBaseShotThreat(ctx, enemy) || isBaseEmergency(ctx, enemy))) return "base-emergency-protected";
    if ((ctx.bullets || []).some((bullet) => bullet?.enemy && !bullet.dead && bulletThreat(ctx, tank, bullet, 2.4))) return "bullet-protected";
    if (ctx.canMove?.(advice.dir) === false || movementBulletThreat(ctx, tank, advice.dir, 1.4)) return "unsafe-route";
    if ((Number(advice.bulletRisk) || 0) > 0) return "projected-bullet-risk";
    if ((Number(advice.scoreGain) || 0) < ADVISOR_PHASE_ONE_SCORE_GAIN) return "weak-gain";
    const adviceProgress = advisorPhaseOneProgress(ctx, tank, lockedTarget, advice.dir);
    const liveProgress = advisorPhaseOneProgress(ctx, tank, lockedTarget, baseline?.moveDir || baseline?.dir);
    if (adviceProgress < 4 || adviceProgress < liveProgress + 4) return "no-route-progress";
    return "";
  }

  function advisorBaseDefenseTarget(ctx, tank, lockedTarget) {
    const visible = visibleEnemies(ctx);
    const candidates = visible.filter((enemy) => isBaseIntruder(ctx, enemy)).map((enemy) => {
      const threat = (ctx.globalThreats || []).find((item) => item.enemy === enemy) || null;
      const direct = directBaseShotThreat(ctx, enemy);
      return {
        enemy,
        direct,
        defenseTier: Number(threat?.defenseTier ?? (direct?.target === "base" ? 0 : 2)),
        deadline: Number(threat?.responseDeadline ?? Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy))),
        baseDistance: manhattan(enemy, ctx.base),
      };
    }).sort((a, b) => Number(b.direct?.target === "base") - Number(a.direct?.target === "base")
      || a.defenseTier - b.defenseTier
      || a.deadline - b.deadline
      || a.baseDistance - b.baseDistance
      || manhattan(tank, a.enemy) - manhattan(tank, b.enemy));
    if (!candidates.length) return null;
    const terminal = candidates.filter((item) => (item.direct?.target === "base" && item.direct.eta <= 1.1)
      || item.baseDistance <= TILE * 3.25);
    const assigned = ctx.globalDirective?.target?.alive
      ? candidates.find((item) => item.enemy === ctx.globalDirective.target)
      : null;
    if (terminal.length) {
      const lead = terminal[0];
      return terminal.find((item) => item === assigned
        && item.defenseTier === lead.defenseTier
        && Boolean(item.direct?.target === "base") === Boolean(lead.direct?.target === "base"))?.enemy
        || lead.enemy;
    }
    if (assigned) return assigned.enemy;
    const committed = lockedTarget?.alive ? candidates.find((item) => item.enemy === lockedTarget) : null;
    return committed?.enemy || null;
  }

  function advisorBaseDefensePlan(ctx, tank, baseline, lockedTarget, now, state) {
    const protectedMode = /freeze-pickup|base-shield|bullet|counter|dodge|evade|avoid|yield/.test(String(baseline?.mode || ""));
    if (protectedMode) return null;
    if ((ctx.bullets || []).some((bullet) => bullet?.enemy && !bullet.dead && bulletThreat(ctx, tank, bullet, 2.4))) return null;
    const enemy = advisorBaseDefenseTarget(ctx, tank, lockedTarget);
    if (!enemy?.alive) return null;
    if (baseline?.fire && baseline?.target === enemy) return null;
    const defenseCtx = {
      ...ctx,
      aiSideRole: null,
      ignoreAllyRoutes: false,
      canMove: ctx.advisorCanMove || ctx.canMove,
    };
    const direct = (Number(ctx.freezeTime) || 0) > 0
      ? preciseFrozenShot(defenseCtx, tank, enemy)
      : currentPositionShot(defenseCtx, tank, enemy);
    if (direct) {
      const fireAction = aimedFireAction(defenseCtx, tank, direct, "core-advisor-base-fire", enemy, true);
      return {
        enemy,
        action: {
          ...fireAction,
          mode: fireAction.fire ? "core-advisor-base-fire" : "core-advisor-base-aim",
        },
        reason: "base-melee-shot",
      };
    }
    if (baseline?.target === enemy
      && /core-(?:base-corridor-(?:route|align)|terminal-base-melee-(?:approach|reload))/.test(String(baseline.mode || ""))) {
      return null;
    }
    if (manhattan(tank, enemy) <= TILE * 4.25) {
      const contact = contactCombatPlan(defenseCtx, tank, enemy);
      if (contact?.enemy === enemy && contact.shot) {
        const safeShot = defenseCtx.canDirectShoot?.(contact.shot, enemy)
          || (!directionFacesBaseZone(defenseCtx, tank, contact.shot)
            && canHitFromDirection(defenseCtx, tank, enemy, contact.shot));
        if (safeShot) {
          const fireAction = aimedFireAction(defenseCtx, tank, contact.shot, "core-advisor-base-melee-fire", enemy, true);
          return {
            enemy,
            action: {
              ...fireAction,
              mode: fireAction.fire ? "core-advisor-base-melee-fire" : "core-advisor-base-melee-aim",
            },
            reason: "base-contact-shot",
          };
        }
      }
      if (contact?.enemy === enemy && contact.approach
        && defenseCtx.canMove?.(contact.approach)
        && !movementBulletThreat(defenseCtx, tank, contact.approach, 1.2)) {
        return {
          enemy,
          action: {
            dir: contact.approach,
            moveDir: contact.approach,
            moveScale: 1,
            fire: false,
            hold: false,
            mode: "core-advisor-base-melee-approach",
            target: enemy,
          },
          reason: "base-contact-approach",
        };
      }
    }
    const goals = [
      ...baseEmergencyMeleeGoals(defenseCtx, enemy),
      ...closeCombatGoals(defenseCtx, tank, enemy),
    ];
    const routeKey = `${Number(ctx.mapVersion) || 0}:${cellOf(enemy).x},${cellOf(enemy).y}`;
    const current = cellOf(tank);
    const cachedIndex = state.baseRouteKey === routeKey
      ? (state.baseRoute || []).findIndex((cell) => cell.x === current.x && cell.y === current.y)
      : -1;
    let path = cachedIndex >= 0 && now < state.baseRouteUntil
      ? state.baseRoute.slice(cachedIndex)
      : [];
    if (!path.length) {
      path = findPath(defenseCtx, current, goals);
      state.baseRoute = path;
      state.baseRouteKey = routeKey;
      state.baseRouteUntil = now + 0.18;
    }
    const step = routeStep(defenseCtx, tank, path, 3.5, enemy, false);
    if (!step.dir || movementBulletThreat(defenseCtx, tank, step.dir, 1.2)) return null;
    const next = path[1] || null;
    const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
    if (!step.aligning && nextTile === "B" && next && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
      return {
        enemy,
        action: aimedFireAction(defenseCtx, tank, step.dir, "core-advisor-base-clear", enemy),
        reason: "base-route-clear",
      };
    }
    if (nextTile === "S" || nextTile === "E" || (next && isProtectedDefenseBrick(ctx, next.x, next.y))) return null;
    // Alignment corrections are deliberately small. A full-tile canMove probe
    // can reject them next to steel even though the real movement step is valid.
    if (!step.aligning && !defenseCtx.canMove?.(step.dir)) return null;
    return {
      enemy,
      action: {
        dir: step.dir,
        moveDir: step.dir,
        moveScale: 1,
        fire: false,
        hold: false,
        mode: step.aligning ? "core-advisor-base-align" : "core-advisor-base-route",
        target: enemy,
      },
      reason: step.aligning ? "base-route-align" : "base-route",
    };
  }

  function advisorCriticalCategory(mode) {
    const value = String(mode || "");
    if (/base-shield|base-bullet-intercept/.test(value)) return "base-shield";
    if (/freeze-pickup/.test(value)) return "freeze-control";
    if (/counter|bullet-(?:dodge|forced|yield|detour)|evade-bullet/.test(value)) return "bullet-defense";
    return "";
  }

  function advisorFreezeTarget(ctx, tank) {
    const directive = ctx.globalDirective;
    if (directive && Object.prototype.hasOwnProperty.call(directive, "pickup")) {
      const assigned = directive.pickup;
      return assigned && !assigned.dead ? assigned : null;
    }
    const freeze = nearbyFreeze(ctx, tank);
    return freeze && freezeCollector(ctx, tank, freeze) === tank ? freeze : null;
  }

  function advisorFreezePickupPlan(ctx, tank, freeze) {
    const pickup = freezePickupPlan(ctx, tank, freeze);
    const step = routeStep(ctx, tank, pickup.path);
    const dir = step.dir || (pickup.collect ? freezeDirectDirection(ctx, tank, freeze) : null);
    const next = pickup.path[1] || null;
    const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
    if (!step.aligning && step.routeDir && nextTile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
      const ready = tank.dir === step.routeDir
        && (Number(tank.turnCooldown) || 0) <= 0
        && Boolean(ctx.canFire?.());
      return {
        dir: step.routeDir,
        fire: ready,
        hold: true,
        mode: ready ? "core-freeze-pickup-clear" : "core-freeze-pickup-clear-aim",
        target: null,
      };
    }
    if (dir && ctx.canMove?.(dir)) {
      return {
        dir,
        moveDir: dir,
        moveScale: 1,
        fire: false,
        hold: false,
        mode: step.aligning ? "core-freeze-pickup-align" : "core-freeze-pickup",
        target: null,
      };
    }
    if (pickup.collect) {
      return {
        dir: tank.dir,
        fire: false,
        hold: true,
        mode: "core-freeze-pickup-wait",
        target: null,
      };
    }
    return null;
  }

  function advisorBulletDefensePlan(ctx, tank, bullet, lockedTarget) {
    const threat = bulletThreat(ctx, tank, bullet, 3.4);
    if (!threat) return null;
    const shooter = bullet.owner?.alive ? bullet.owner : null;
    const shooterShot = shooter ? directShot(ctx, tank, shooter) : null;
    const counterDir = shooterShot === opposite(bullet.dir) ? shooterShot : null;
    const counterDelay = counterDir
      ? (tank.dir === counterDir
        ? Math.max(0, Number(tank.turnCooldown) || 0)
        : Math.max(turnTime(tank.dir, counterDir), Number(tank.turnCooldown) || 0))
      : Infinity;
    if (counterDir && ctx.canFire?.() && threat.eta >= counterDelay + 0.12) {
      return {
        dir: counterDir,
        fire: true,
        hold: true,
        mode: tank.dir === counterDir && (Number(tank.turnCooldown) || 0) <= 0
          ? "core-counter-fire"
          : "core-counter-aim",
        target: shooter || lockedTarget,
      };
    }
    const forced = forcedBulletEscapePlan(ctx, tank, bullet, lockedTarget);
    const dodge = dodgeDirection(ctx, tank, bullet, lockedTarget)
      || bulletLineRetreat(ctx, tank, bullet)
      || lastChanceBulletEscape(ctx, tank, bullet)
      || forced?.dir;
    if (!dodge) return null;
    let moveScale = 1;
    if (forced && forced.dir === dodge) moveScale = forced.moveScale;
    return {
      dir: dodge,
      moveDir: dodge,
      moveScale,
      fire: false,
      hold: false,
      mode: "core-evade-bullet",
      target: lockedTarget,
    };
  }

  function advisorBaseShieldPlan(ctx, tank, lockedTarget) {
    const shieldBullet = baseShieldBullet(ctx, tank);
    if (shieldBullet) {
      const shooter = shieldBullet.owner?.alive ? shieldBullet.owner : lockedTarget;
      const counterDir = opposite(shieldBullet.dir) || tank.dir;
      const ready = tank.dir === counterDir
        && (Number(tank.turnCooldown) || 0) <= 0
        && Boolean(ctx.canFire?.());
      return {
        subject: shieldBullet,
        target: shooter?.alive ? shooter : lockedTarget,
        action: {
          dir: counterDir,
          fire: true,
          hold: true,
          mode: ready ? "core-base-shield-fire" : "core-base-shield-aim",
          target: shooter?.alive ? shooter : lockedTarget,
        },
        reason: "shield-lane",
      };
    }
    return null;
  }

  function advisorBaseProjectilePlan(ctx, tank, lockedTarget) {
    const intercept = assignedBaseProjectileIntercept(ctx, tank);
    if (!intercept) return null;
    const shooter = intercept.bullet.owner?.alive ? intercept.bullet.owner : lockedTarget;
    const step = routeStep(ctx, tank, intercept.path, 2, shooter, true);
    if (step.dir) {
      return {
        subject: intercept.bullet,
        exposedBase: intercept.exposedBase,
        target: shooter,
        action: {
          dir: step.dir,
          moveDir: step.dir,
          moveScale: 1,
          fire: false,
          hold: false,
          mode: step.aligning ? "core-base-bullet-intercept-align" : "core-base-bullet-intercept",
          target: shooter,
        },
        reason: "intercept-lane",
      };
    }
    return {
      subject: intercept.bullet,
      exposedBase: intercept.exposedBase,
      target: shooter,
      action: {
        dir: intercept.counterDir || tank.dir,
        fire: true,
        hold: true,
        mode: "core-base-shield-aim",
        target: shooter,
      },
      reason: "intercept-counter",
    };
  }

  function advisorCriticalPlan(ctx, tank, baseline, lockedTarget) {
    const baselineCategory = advisorCriticalCategory(baseline?.mode);
    const confirmed = (category, subject) => ({
      category,
      subject: subject || baseline?.target || lockedTarget || tank,
      target: baseline?.target?.alive ? baseline.target : lockedTarget,
      action: baseline,
      reason: "confirmed",
    });

    const shield = advisorBaseShieldPlan(ctx, tank, lockedTarget);
    if (shield) return { ...shield, category: "base-shield" };
    if (baselineCategory === "base-shield") {
      return confirmed("base-shield", incomingBullet(ctx, tank));
    }

    const fatalIntercept = advisorBaseProjectilePlan(ctx, tank, lockedTarget);
    if (fatalIntercept?.exposedBase) return { ...fatalIntercept, category: "base-shield" };

    const freeze = advisorFreezeTarget(ctx, tank);
    if (freeze && tileRange(tank, freeze) <= 3) {
      if (baselineCategory === "freeze-control") {
        return confirmed("freeze-control", freeze);
      }
      const action = advisorFreezePickupPlan(ctx, tank, freeze);
      if (action) return {
        category: "freeze-control",
        subject: freeze,
        target: lockedTarget,
        action,
        reason: "nearby-pickup",
      };
    }
    if (baselineCategory === "freeze-control") {
      return confirmed("freeze-control", freeze);
    }

    const bullet = incomingBullet(ctx, tank);
    if (bullet) {
      if (baselineCategory === "bullet-defense") {
        return confirmed("bullet-defense", bullet);
      }
      const action = advisorBulletDefensePlan(ctx, tank, bullet, lockedTarget);
      if (action) return {
        category: "bullet-defense",
        subject: bullet,
        target: action.target?.alive ? action.target : lockedTarget,
        action,
        reason: "incoming-shell",
      };
    }
    if (baselineCategory === "bullet-defense") {
      return confirmed("bullet-defense", null);
    }

    if (baselineCategory) {
      return {
        category: baselineCategory,
        subject: baseline?.target || lockedTarget || tank,
        target: baseline?.target?.alive ? baseline.target : lockedTarget,
        action: baseline,
        reason: "confirmed",
      };
    }

    if (freeze) {
      const action = advisorFreezePickupPlan(ctx, tank, freeze);
      if (action) return {
        category: "freeze-control",
        subject: freeze,
        target: lockedTarget,
        action,
        reason: "pickup-route",
      };
    }

    return fatalIntercept ? { ...fatalIntercept, category: "base-shield" } : null;
  }

  function recordAdvisorFullControl(ctx, tank, action, lockedTarget, now, state, services, name, reason) {
    const subject = lockedTarget?.alive ? lockedTarget : tank;
    const key = `full-control:${cellOf(tank).x},${cellOf(tank).y}:${cellOf(subject).x},${cellOf(subject).y}`
      + `:${action?.mode || "idle"}:${action?.moveDir || action?.dir || "hold"}:${action?.fire ? 1 : 0}`;
    tacticalAdvisorTelemetry.lastReason = "full-control";
    tacticalAdvisorTelemetry.lastParticipation = "full-control";
    if (state.lastAppliedKey === key && now - state.lastAppliedAt < 1.2) {
      refreshAiVersionDisplay();
      return;
    }
    state.lastAppliedKey = key;
    state.lastAppliedAt = now;
    state.applied++;
    tacticalAdvisorTelemetry.applied++;
    refreshAiVersionDisplay();
    services?.recordExperience?.("ai_advisor_applied", {
      stage: ctx.stage,
      time: now,
      player: name,
      tank,
      target: lockedTarget?.alive ? lockedTarget : null,
      mode: action?.mode || "core-idle",
      reason: `full-control:${reason || "confirmed"}`,
      distance: Math.round(manhattan(tank, subject)),
    });
  }

  function observeAutonomousControl(ctx, tank, action, lockedTarget, now, services, name, advisor) {
    if (!services?.observeAutonomyDecision || !tank?.alive) return null;
    const posture = advisorDefensePosture(ctx, tank);
    const stateKey = autonomyStateKey(ctx, tank, lockedTarget, posture);
    const actionKey = autonomyActionKey(tank, lockedTarget, action);
    return services.observeAutonomyDecision({
      player: name,
      stateKey,
      actionKey,
      stage: ctx.stage,
      time: now,
      urgent: posture.urgent,
      explored: Boolean(advisor?.autonomyExplored && advisor?.autonomyAction === actionKey),
      mode: action?.mode || "core-idle",
    });
  }

  function applyAdvisorGlobalRoute(ctx, tank, baseline, lockedTarget, advice, now, state) {
    const blockReason = advisorPhaseOneBlockReason(ctx, tank, baseline, lockedTarget, advice);
    const firstEvaluation = state.lastParticipationAdvice !== advice;
    state.lastParticipationAdvice = advice;
    if (blockReason) {
      if (firstEvaluation) {
        state.blocked++;
        tacticalAdvisorTelemetry.blocked++;
        tacticalAdvisorTelemetry.lastParticipation = blockReason;
      }
      return baseline;
    }
    if (state.appliedDir !== advice.dir || state.appliedTarget !== lockedTarget || now >= state.appliedUntil) {
      state.appliedDir = advice.dir;
      state.appliedTarget = lockedTarget;
      state.appliedUntil = now + ADVISOR_PHASE_ONE_COMMIT;
    }
    return {
      ...baseline,
      dir: advice.dir,
      moveDir: advice.dir,
      fire: false,
      hold: false,
      mode: "core-advisor-global-route",
      target: lockedTarget,
    };
  }

  function advisorCurrentPath(ctx, tank, path, fallbackGoals = []) {
    const current = cellOf(tank);
    const route = Array.isArray(path) ? path : [];
    const currentIndex = route.findIndex((cell) => cell.x === current.x && cell.y === current.y);
    if (currentIndex >= 0) {
      let startIndex = currentIndex;
      if (currentIndex > 0) {
        const previous = route[currentIndex - 1];
        const waypoint = route[currentIndex];
        const dx = waypoint.x - previous.x;
        const dy = waypoint.y - previous.y;
        const c = center(tank);
        const remainingLeg = (waypoint.x * TILE + TILE / 2 - c.x) * dx
          + (waypoint.y * TILE + TILE / 2 - c.y) * dy;
        // Entering the waypoint's cell is not the same as reaching its turn point.
        const next = route[currentIndex + 1];
        const turnX = next ? next.x - waypoint.x : 0;
        const turnY = next ? next.y - waypoint.y : 0;
        const tightCorner = Math.abs(turnX) + Math.abs(turnY) === 1
          && dx * turnX + dy * turnY === 0
          && !advisorSearchRectPassable(ctx, tank, tank.x + turnX * TILE / 2, tank.y + turnY * TILE / 2);
        if (Math.abs(dx) + Math.abs(dy) === 1 && remainingLeg > 1.5 && tightCorner) startIndex--;
      }
      const remaining = route.slice(startIndex);
      if (remaining.slice(1).every((cell) => Number.isFinite(tileCost(ctx, cell.x, cell.y)))) {
        return remaining;
      }
    }
    const endpoint = route[route.length - 1];
    if (endpoint) {
      const restored = findPath({ ...ctx, aiSideRole: null }, current, [endpoint]);
      if (restored.length) return restored;
    }
    const goals = fallbackGoals.length ? fallbackGoals : endpoint ? [endpoint] : [];
    if (!goals.length) return [];
    return findPath({ ...ctx, aiSideRole: null }, current, goals);
  }

  function advisorDefenseFallbackGoals(ctx, enemy) {
    const unique = new Map();
    for (const cell of [
      ...baseEmergencyMeleeGoals(ctx, enemy),
      ...baseEmergencyFlankGoals(ctx, enemy),
      ...baseEntryGoals(ctx),
    ]) {
      unique.set(keyOf(cell.x, cell.y), cell);
    }
    return [...unique.values()];
  }

  function advisorDefenseHold(enemy, reason = "defense-replan") {
    return {
      action: {
        dir: null,
        moveDir: null,
        fire: false,
        hold: true,
        mode: "core-global-defense-hold",
        target: enemy,
      },
      enemy,
      reason,
    };
  }

  function findRelocationPath(ctx, tank, goals) {
    const current = cellOf(tank);
    // The caller has already ruled out a usable shot at the current position.
    return findPath(ctx, current, goals.filter((goal) =>
      goal.x !== current.x || goal.y !== current.y));
  }

  function terminalBaseContactDirection(ctx, tank, enemy) {
    if (!tank?.alive || !enemy?.alive || !ctx.base) return null;
    const direct = directBaseShotThreat(ctx, enemy);
    const terminal = direct?.target === "base"
      || manhattan(enemy, ctx.base) <= TILE * 4.5
      || baseThreatEta(ctx, enemy) <= 2.2;
    if (!terminal || manhattan(tank, enemy) > TILE * 4.25) return null;
    const tankCenter = center(tank);
    const enemyCenter = center(enemy);
    const horizontal = enemyCenter.x < tankCenter.x ? "left" : "right";
    const vertical = enemyCenter.y < tankCenter.y ? "up" : "down";
    const preferred = Math.abs(enemyCenter.x - tankCenter.x) >= Math.abs(enemyCenter.y - tankCenter.y)
      ? [horizontal, vertical]
      : [vertical, horizontal];
    const currentDistance = manhattan(tank, enemy);
    return preferred.find((dir) => ctx.canMove?.(dir)
      && projectedTargetDistance(tank, enemy, dir) < currentDistance - 0.5) || null;
  }

  function advisorTerminalContactAction(ctx, tank, enemy) {
    const dir = terminalBaseContactDirection(ctx, tank, enemy);
    if (!dir) return null;
    return {
      dir,
      moveDir: dir,
      moveScale: 1,
      fire: false,
      hold: false,
      mode: "core-global-defense-contact",
      target: enemy,
    };
  }

  function advisorReliableReturnPlan(ctx, tank, baseline) {
    const posture = advisorDefensePosture(ctx, tank);
    const threat = posture.assigned;
    if (!posture.urgent || !threat?.enemy?.alive) return null;
    const enemy = threat.enemy;
    const liveMode = String(baseline?.mode || "");
    const immediateSafety = /terminal-base-melee-(?:fire|reload)|armor-volley|freeze-|base-shield|base-bullet|bullet|dodge|evade/.test(liveMode);
    const committedCombat = baseline?.target === enemy
      && /counter/.test(liveMode);
    const protectedAction = immediateSafety || committedCombat;
    if (protectedAction || (Number(ctx.freezeTime) || 0) > 0) return null;
    if (baseline?.target === enemy && (
      baseline?.fire
      || /^core-(?:close|contact|pointblank)/.test(liveMode)
    )) return null;
    if (baseline?.fire && baseline?.target === enemy) return null;
    const defenseCtx = {
      ...ctx,
      tank,
      aiSideRole: null,
      ignoreAllyRoutes: false,
      canMove: ctx.advisorCanMove || ctx.canMove,
    };
    const shot = currentPositionShot(defenseCtx, tank, enemy);
    if (shot) {
      return {
        action: aimedFireAction(defenseCtx, tank, shot, "core-global-defense-fire", enemy, true),
        enemy,
        reason: "defense-shot",
      };
    }
    const missionPlan = ctx.globalDirective?.target === enemy
      ? ctx.globalDirective?.mission?.plan
      : null;
    const plan = missionPlan?.path?.length
      ? missionPlan
      : ctx.globalDirective?.target === enemy && ctx.globalDirective?.intercept?.path?.length
      ? ctx.globalDirective.intercept
      : cachedReliableDefensePlan(planningContextForAlly(defenseCtx, tank), tank, threat);
    const fallbackGoals = advisorDefenseFallbackGoals(defenseCtx, enemy);
    let path = advisorCurrentPath(defenseCtx, tank, plan?.path, fallbackGoals);
    if (path.length < 2 && fallbackGoals.length) {
      path = findRelocationPath(defenseCtx, tank, fallbackGoals);
    }
    if (path.length < 2) {
      const contactAction = advisorTerminalContactAction(defenseCtx, tank, enemy);
      if (contactAction) {
        return {
          action: contactAction,
          enemy,
          reason: "defense-contact",
        };
      }
      const brickDir = routeBrickDirection(defenseCtx, tank, enemy);
      if (brickDir) {
        return {
          action: aimedFireAction(defenseCtx, tank, brickDir, "core-global-defense-clear", enemy),
          enemy,
          reason: "defense-clear-escape",
        };
      }
      const fallbackDir = recoveryDirection(defenseCtx, tank, enemy, fallbackGoals);
      if (!fallbackDir || movementBulletThreat(defenseCtx, tank, fallbackDir, 1.15)) {
        return advisorDefenseHold(enemy, "defense-no-route");
      }
      return {
        action: {
          dir: fallbackDir,
          moveDir: fallbackDir,
          moveScale: 1,
          fire: false,
          hold: false,
          mode: "core-global-defense-recover",
          target: enemy,
        },
        enemy,
        reason: "defense-recover",
      };
    }
    const step = routeStep(defenseCtx, tank, path, 3.5, enemy, false);
    const next = path[1] || null;
    const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
    if (!step.dir || movementBulletThreat(defenseCtx, tank, step.dir, 1.15)) {
      const contactAction = advisorTerminalContactAction(defenseCtx, tank, enemy);
      if (contactAction) {
        return {
          action: contactAction,
          enemy,
          reason: "defense-contact-blocked",
        };
      }
      return advisorDefenseHold(enemy, "defense-step-blocked");
    }
    if (!step.aligning && nextTile === "B" && next && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
      return {
        action: aimedFireAction(defenseCtx, tank, step.dir, "core-global-defense-clear", enemy),
        enemy,
        reason: "defense-clear",
      };
    }
    if (nextTile === "S" || nextTile === "E" || (next && isProtectedDefenseBrick(ctx, next.x, next.y))) {
      return advisorDefenseHold(enemy, "defense-guard-blocked");
    }
    if (!step.aligning && !defenseCtx.canMove?.(step.dir)) {
      const fallbackDir = recoveryDirection(defenseCtx, tank, enemy, fallbackGoals);
      if (fallbackDir && !movementBulletThreat(defenseCtx, tank, fallbackDir, 1.15)) {
        return {
          action: {
            dir: fallbackDir,
            moveDir: fallbackDir,
            moveScale: 1,
            fire: false,
            hold: false,
            mode: "core-global-defense-recover",
            target: enemy,
          },
          enemy,
          reason: "defense-step-recover",
        };
      }
      return advisorDefenseHold(enemy, "defense-step-blocked");
    }
    return {
      action: {
        dir: step.dir,
        moveDir: step.dir,
        moveScale: 1,
        fire: false,
        hold: false,
        mode: step.aligning ? "core-global-defense-align" : "core-global-defense-route",
        target: enemy,
      },
      enemy,
      reason: posture.margin <= 0 ? "defense-late" : "defense-margin",
    };
  }

  function advisorRearRecoveryPlan(ctx, tank, lockedTarget, posture) {
    if (!posture.tankAdvanced || posture.safeToAdvance || posture.urgent) return null;
    const routeCtx = {
      ...ctx,
      tank,
      aiSideRole: null,
      ignoreAllyRoutes: false,
      canMove: ctx.advisorCanMove || ctx.canMove,
    };
    const goals = baseEntryGoals(routeCtx);
    const path = findPath(routeCtx, cellOf(tank), goals);
    const target = lockedTarget?.alive ? lockedTarget : ctx.base;
    if (path.length >= 2) {
      const step = routeStep(routeCtx, tank, path, 3.5, target, false);
      const next = path[1];
      const tile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
      if (step.dir && !movementBulletThreat(routeCtx, tank, step.dir, 1.15)) {
        if (!step.aligning && tile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
          return {
            action: aimedFireAction(routeCtx, tank, step.dir, "core-global-rear-clear", target),
            reason: "rear-clear",
          };
        }
        if (step.aligning || routeCtx.canMove?.(step.dir)) return {
          action: {
            dir: step.dir,
            moveDir: step.dir,
            moveScale: 1,
            fire: false,
            hold: false,
            mode: step.aligning ? "core-global-rear-align" : "core-global-rear-recover",
            target: lockedTarget,
          },
          reason: "rear-coverage",
        };
      }
    }
    const fallbackDir = target ? recoveryDirection(routeCtx, tank, target, goals) : null;
    if (fallbackDir && fallbackDir !== "up"
      && !movementBulletThreat(routeCtx, tank, fallbackDir, 1.15)) {
      return {
        action: {
          dir: fallbackDir,
          moveDir: fallbackDir,
          moveScale: 1,
          fire: false,
          hold: false,
          mode: "core-global-rear-recover",
          target: lockedTarget,
        },
        reason: "rear-fallback",
      };
    }
    return {
      action: {
        dir: null,
        moveDir: null,
        fire: false,
        hold: true,
        mode: "core-global-rear-hold",
        target: lockedTarget,
      },
      reason: "rear-replan",
    };
  }

  function advisorProposalPriority(proposal) {
    if (proposal.kind === "critical") {
      return proposal.category === "base-shield" ? 1000
        : proposal.category === "freeze-control" ? 970 : 950;
    }
    if (proposal.kind === "base-defense") return 880;
    if (proposal.kind === "reliable-return") return 840;
    if (proposal.kind === "combat") return 620;
    if (proposal.kind === "rear-recovery") return 520;
    return 200;
  }

  function advisorActionMoves(action) {
    return Boolean(action && !action.hold && DIRS[action.moveDir || action.dir]);
  }

  function advisorProtectedAction(action) {
    return /base-corridor|terminal-base|armor-volley|freeze-|base-shield|base-bullet|counter|bullet|dodge|evade|intercept|pointblank|close|contact|aim|route-loop/
      .test(String(action?.mode || ""));
  }

  function advisorProposalAllowed(proposal, posture) {
    const action = proposal.action;
    if (!action) return false;
    if (proposal.kind === "critical" || proposal.kind === "base-defense"
      || advisorProtectedAction(action)) return true;
    if (posture.urgent) {
      if (proposal.kind === "reliable-return") return true;
      return Boolean(action.fire && action.target === posture.assigned?.enemy);
    }
    const dir = action.moveDir || action.dir;
    if (advisorActionMoves(action) && dir === "up"
      && posture.tankAdvanced && !posture.safeToAdvance) return false;
    return true;
  }

  function advisorEmergencyPursuitPlan(ctx, tank, enemy, baseline) {
    if (!enemy?.alive) return null;
    const emergencyCtx = {
      ...ctx,
      tank,
      aiSideRole: null,
      ignoreAllyRoutes: false,
      canMove: ctx.advisorCanMove || ctx.canMove,
    };
    const shot = currentPositionShot(emergencyCtx, tank, enemy)
      || directShot(emergencyCtx, tank, enemy)
      || predictiveShot(emergencyCtx, tank, enemy)
      || pointBlankShot(emergencyCtx, tank, enemy, manhattan(tank, enemy));
    if (shot) {
      return {
        action: aimedFireAction(emergencyCtx, tank, shot, "core-global-emergency-fire", enemy, true),
        reason: "emergency-shot",
      };
    }
    const goals = [
      ...baseEmergencyMeleeGoals(emergencyCtx, enemy),
      ...closeCombatGoals(emergencyCtx, tank, enemy),
      ...pursuitGoals(emergencyCtx, enemy),
    ];
    const path = findRelocationPath(emergencyCtx, tank, goals);
    if (path.length >= 2) {
      const step = routeStep(emergencyCtx, tank, path, 3.5, enemy, false);
      const next = path[1];
      const tile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
      if (step.dir && !step.aligning && tile === "B"
        && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
        return {
          action: aimedFireAction(emergencyCtx, tank, step.dir, "core-global-emergency-clear", enemy),
          reason: "emergency-clear",
        };
      }
      if (step.dir && (step.aligning || emergencyCtx.canMove?.(step.dir))
        && !movementBulletThreat(emergencyCtx, tank, step.dir, 1.1)) {
        return {
          action: {
            dir: step.dir,
            moveDir: step.dir,
            moveScale: 1,
            fire: false,
            hold: false,
            mode: step.aligning ? "core-global-emergency-align" : "core-global-emergency-route",
            target: enemy,
          },
          reason: "emergency-route",
        };
      }
    }
    const brickDir = routeBrickDirection(emergencyCtx, tank, enemy);
    if (brickDir) {
      return {
        action: aimedFireAction(emergencyCtx, tank, brickDir, "core-global-emergency-clear", enemy),
        reason: "emergency-clear-escape",
      };
    }
    const recovery = recoveryDirection(emergencyCtx, tank, enemy, goals);
    if (recovery && !movementBulletThreat(emergencyCtx, tank, recovery, 1.1)) {
      return {
        action: {
          dir: recovery,
          moveDir: recovery,
          moveScale: 1,
          fire: false,
          hold: false,
          mode: "core-global-emergency-recover",
          target: enemy,
        },
        reason: "emergency-recover",
      };
    }
    const baselineDir = baseline?.moveDir || baseline?.dir;
    if (!baseline?.hold && DIRS[baselineDir] && emergencyCtx.canMove?.(baselineDir)
      && projectedTargetDistance(tank, enemy, baselineDir) <= manhattan(tank, enemy)
      && !movementBulletThreat(emergencyCtx, tank, baselineDir, 1.1)) {
      return { action: baseline, reason: "emergency-live-progress" };
    }
    return null;
  }

  function advisorGlobalControlPlan(ctx, tank, baseline, lockedTarget, advice, now, state) {
    // Search advice may be cached; defense arbitration must use the live threat state.
    const posture = advisorDefensePosture(ctx, tank);
    const proposals = [];
    const critical = advisorCriticalPlan(ctx, tank, baseline, lockedTarget);
    if (critical) {
      proposals.push({
        kind: "critical",
        category: critical.category,
        action: critical.action,
        lockedTarget: critical.target?.alive ? critical.target : lockedTarget,
        retarget: null,
        reason: critical.reason || "critical",
      });
    }

    const defense = advisorBaseDefensePlan(ctx, tank, baseline, lockedTarget, now, state);
    const planned = /** @type {any} */ (defense?.action);
    const changesDefense = Boolean(defense && (
      defense.enemy !== lockedTarget
      || (planned?.moveDir || planned?.dir) !== (baseline?.moveDir || baseline?.dir)
      || Boolean(planned?.fire) !== Boolean(baseline?.fire)
      || Boolean(planned?.hold) !== Boolean(baseline?.hold)
    ));
    if (defense && changesDefense) {
      proposals.push({
        kind: "base-defense",
        action: defense.action,
        lockedTarget: defense.enemy,
        retarget: defense.enemy,
        reason: defense.reason || "base-defense",
      });
    }

    const reliableReturn = advisorReliableReturnPlan(ctx, tank, baseline);
    if (reliableReturn) {
      proposals.push({
        kind: "reliable-return",
        action: reliableReturn.action,
        lockedTarget: reliableReturn.enemy,
        retarget: reliableReturn.enemy,
        reason: reliableReturn.reason,
      });
    }

    const rearRecovery = advisorRearRecoveryPlan(ctx, tank, lockedTarget, posture);
    if (rearRecovery) {
      proposals.push({
        kind: "rear-recovery",
        action: rearRecovery.action,
        lockedTarget,
        retarget: null,
        reason: rearRecovery.reason,
      });
    }

    const routed = applyAdvisorGlobalRoute(ctx, tank, baseline, lockedTarget, advice, now, state);
    const routedCombat = Boolean(routed.fire)
      || /aim|close|contact|pointblank|armor-volley/.test(String(routed.mode || ""));
    proposals.push({
      kind: routedCombat ? "combat" : "route",
      action: routed,
      lockedTarget,
      retarget: null,
      reason: routed.mode === "core-advisor-global-route" ? "route-correction" : "confirmed",
    });

    const selected = proposals.filter((proposal) => advisorProposalAllowed(proposal, posture))
      .sort((a, b) => advisorProposalPriority(b) - advisorProposalPriority(a))[0];
    if (selected) return selected;
    const emergencyTarget = posture.assigned?.enemy?.alive ? posture.assigned.enemy : null;
    const emergency = posture.urgent
      ? advisorEmergencyPursuitPlan(ctx, tank, emergencyTarget, baseline)
      : null;
    if (emergency) {
      return {
        kind: "emergency-fallback",
        action: emergency.action,
        lockedTarget: emergencyTarget,
        retarget: emergencyTarget,
        reason: emergency.reason,
      };
    }
    return {
      kind: "failsafe",
      action: {
        dir: null,
        moveDir: null,
        fire: false,
        hold: true,
        mode: posture.urgent ? "core-global-defense-hold" : "core-global-replan",
        target: posture.assigned?.enemy?.alive ? posture.assigned.enemy : lockedTarget,
      },
      lockedTarget: posture.assigned?.enemy?.alive ? posture.assigned.enemy : lockedTarget,
      retarget: posture.assigned?.enemy?.alive ? posture.assigned.enemy : null,
      reason: posture.urgent ? "defense-failsafe" : "global-failsafe",
    };
  }

  function createShotFeedbackTracker() {
    let intent = null;
    let pending = [];
    let seen = new WeakSet();
    let map = null;
    let lastTime = -Infinity;
    return {
      observe(ctx) {
        const now = Number(ctx.gameTime) || 0;
        if (map !== ctx.map || now < lastTime) {
          intent = null;
          pending = [];
          seen = new WeakSet();
          map = ctx.map;
        }
        lastTime = now;
        const events = [];
        for (const bullet of ctx.bullets || []) {
          if (bullet.owner !== ctx.tank || seen.has(bullet)) continue;
          seen.add(bullet);
          if (!intent || now - intent.time > 0.2 || bullet.dir !== intent.dir) continue;
          const shot = { ...intent, bullet,
            verifyAt: now + manhattan(bullet, intent.target) / Math.max(1, Number(bullet.speed) || 310) + 0.15 };
          pending.push(shot);
          events.push({ ...shot, outcome: "launched" });
        }
        pending = pending.filter((shot) => {
          if (!shot.target.alive || Number(shot.target.hp) < shot.hpBefore) {
            // Damage confirms progress, not ownership: another shell may have hit.
            events.push({ ...shot, outcome: "target-damaged" });
            return false;
          }
          if (now < shot.verifyAt) return true;
          const stationary = Math.abs(shot.target.x - shot.targetX) + Math.abs(shot.target.y - shot.targetY) <= 4;
          events.push({ ...shot, outcome: stationary ? "miss" : "target-moved" });
          return false;
        }).slice(-24);
        return events;
      },
      expect(ctx, action) {
        intent = action?.fire && action.target?.alive && !/clear|sweep|shield|counter/.test(action.mode || "")
          ? { target: action.target, hpBefore: Number(action.target.hp) || 1,
            targetX: action.target.x, targetY: action.target.y, cell: cellOf(ctx.tank),
            time: Number(ctx.gameTime) || 0, dir: action.dir, frozen: (ctx.freezeTime || 0) > 0 }
          : null;
      },
    };
  }

  function createCoreController(name, services) {
    const shotFeedback = createShotFeedbackTracker();
    let missedShotRecovery = null;
    let previousStationaryMiss = null;
    let target = null;
    let missionTarget = null;
    let mode = "core-init";
    let failures = 0;
    const advisorState = {
      nextAt: 0,
      result: null,
      runs: 0,
      cacheHits: 0,
      disagreements: 0,
      applied: 0,
      blocked: 0,
      lastRecordedAt: -Infinity,
      lastParticipationAdvice: null,
      appliedDir: null,
      appliedTarget: null,
      appliedUntil: 0,
      lastAppliedKey: "",
      lastAppliedAt: -Infinity,
      baseRoute: [],
      baseRouteKey: "",
      baseRouteUntil: 0,
    };
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
    let loopRecoveryTarget = null;
    let loopRecoveryRoute = [];
    let loopRecoveryGoals = [];
    let loopRecoveryUntil = 0;
    let loopRecoveryMapVersion = -1;
    let loopRecoveryFallbackDir = null;
    let breakthroughCommitTarget = null;
    let patrolPressureTarget = null;
    let patrolPressureUntil = 0;
    let finalSearchEnemy = null;
    let finalSearchWaypoint = null;
    let finalSearchMapVersion = -1;
    let finalSearchStep = 0;
    let baseCorridorTarget = null;
    let baseCorridorSide = null;
    let defenseProgressTarget = null;
    let defenseProgressPhase = "IDLE";
    let defenseProgressMetric = Infinity;
    let defenseProgressAt = 0;
    let defenseProgressPoint = null;
    let defenseRecoveryDir = null;
    let defenseRecoveryUntil = 0;
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
        loopRecoveryTarget = null;
        loopRecoveryRoute = [];
        loopRecoveryGoals = [];
        loopRecoveryUntil = 0;
        loopRecoveryMapVersion = -1;
        loopRecoveryFallbackDir = null;
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
      // A usable firing opportunity ends detour recovery, including moving fire.
      // Otherwise the old route can suppress every shot until its timer expires.
      if (action?.fire && action.target?.alive && action.dir === tank.dir
        && manhattan(tank, action.target) <= TILE * 2.2
        && (tank.turnCooldown || 0) <= 0 && ctx.canFire?.()
        && currentPositionShot(ctx, tank, action.target) === action.dir) {
        movementTurns = [];
        loopRecoveryTarget = null;
        loopRecoveryRoute = [];
        loopRecoveryGoals = [];
        loopRecoveryUntil = 0;
        loopRecoveryFallbackDir = null;
        return action;
      }
      const movementDir = action?.moveDir || action?.dir;
      const moving = movementDir && !action?.hold;
      const tacticalInterrupt = /base-shield|bullet-intercept|counter|dodge|evade|avoid-friendly|avoid-ally|escape|freeze-pickup/.test(action?.mode || "");
      const activeTarget = action?.target?.alive ? action.target : target?.alive ? target : null;
      if (!moving || tacticalInterrupt) {
        if (tacticalInterrupt) movementTurns = [];
        return action;
      }

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

      if (loopRecoveryTarget === activeTarget && now < loopRecoveryUntil) {
        const immediateShot = activeTarget?.alive
          && manhattan(tank, activeTarget) <= TILE * 2.2
          && tank.dir === currentPositionShot(ctx, tank, activeTarget)
          && (tank.turnCooldown || 0) <= 0 && ctx.canFire?.();
        if (immediateShot) {
          movementTurns = [];
          loopRecoveryTarget = null;
          loopRecoveryRoute = [];
          loopRecoveryGoals = [];
          loopRecoveryUntil = 0;
          loopRecoveryFallbackDir = null;
          return aimedFireAction(ctx, tank, tank.dir, "core-defense-loop-shot", activeTarget, true);
        }
        if (loopRecoveryMapVersion !== Number(ctx.mapVersion || 0)) {
          loopRecoveryRoute = loopRecoveryGoals.length
            ? findPath(ctx, cellOf(tank), loopRecoveryGoals)
            : [];
          loopRecoveryMapVersion = Number(ctx.mapVersion || 0);
        } else if (loopRecoveryRoute.length) {
          loopRecoveryRoute = advisorCurrentPath(ctx, tank, loopRecoveryRoute, loopRecoveryGoals);
        }
        const committedStep = routeStep(ctx, tank, loopRecoveryRoute, 1.5, activeTarget, false);
        const committedDir = committedStep.dir || loopRecoveryFallbackDir;
        const next = loopRecoveryRoute[1] || null;
        const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
        if (committedStep.routeDir && !committedStep.aligning && nextTile === "B"
          && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
          mode = "core-route-loop-clear";
          return aimedFireAction(ctx, tank, committedStep.routeDir, mode, activeTarget);
        }
        const canCommit = committedDir
          && (committedStep.aligning || ctx.canMove?.(committedDir))
          && !movementBulletThreat(ctx, tank, committedDir, 0.9);
        if (canCommit) {
          lastMovementDecisionDir = committedDir;
          mode = committedStep.aligning ? "core-route-loop-align" : "core-route-loop-commit";
          return {
            ...action,
            dir: committedDir,
            moveDir: committedDir,
            moveScale: committedStep.aligning ? 0.35 : 1,
            fire: false,
            hold: false,
            mode,
          };
        }
        loopRecoveryUntil = 0;
        loopRecoveryRoute = [];
        loopRecoveryGoals = [];
        loopRecoveryFallbackDir = null;
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
          distance: currentDistance,
          target: activeTarget,
        });
        movementTurns = movementTurns.filter((entry) => now - entry.time <= 1.6).slice(-7);
        lastMovementDecisionDir = movementDir;
      }
      const recent = movementTurns.filter((entry) => entry.target === activeTarget);
      const loopPattern = movementLoopPattern(recent, center(tank), currentDistance);
      if (!loopPattern) return action;
      const pattern = loopPattern.entries;
      const displacement = Math.abs(center(tank).x - pattern[0].x) + Math.abs(center(tank).y - pattern[0].y);
      if (displacement > TILE * 1.4) return action;
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

      loopRecoveryTarget = activeTarget;
      loopRecoveryGoals = interceptEndpoint
        ? [interceptEndpoint]
        : activeTarget?.alive
          ? [...closeCombatGoals(ctx, tank, activeTarget), ...pursuitGoals(ctx, activeTarget)]
          : [];
      loopRecoveryRoute = loopRecoveryGoals.length
        ? findPath(ctx, cellOf(tank), loopRecoveryGoals)
        : [];
      loopRecoveryUntil = now + 0.9;
      loopRecoveryMapVersion = Number(ctx.mapVersion || 0);
      services?.recordExperience?.("ai_route_loop", {
        stage: ctx.stage,
        time: now,
        player: name,
        tank,
        target: activeTarget,
        mode: action?.mode,
        reason: loopPattern.reason,
        distance: Number.isFinite(currentDistance) ? Math.round(currentDistance) : null,
      });

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
      const recoveryStep = routeStep(ctx, tank, loopRecoveryRoute, 1.5, activeTarget, false);
      const routedDir = recoveryStep.dir
        && (recoveryStep.aligning || ctx.canMove?.(recoveryStep.dir))
        && !movementBulletThreat(ctx, tank, recoveryStep.dir, 0.9)
        ? recoveryStep.dir
        : null;
      const progressDir = routedDir || progressCandidates[0]?.dir || candidates.find((item) => (
        item.dir !== opposite(lastMovementDecisionDir || tank.dir)
      ))?.dir || candidates[0]?.dir || null;
      if (!progressDir) {
        mode = "core-route-loop-replan";
        return { ...action, dir: tank.dir, moveDir: tank.dir, fire: false, hold: true, mode };
      }
      loopRecoveryFallbackDir = progressDir;
      lastMovementDecisionDir = progressDir;
      mode = recoveryStep.aligning
        ? "core-route-loop-align"
        : progressCandidates.length ? "core-route-loop-commit" : "core-route-loop-escape";
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
        if (!step.aligning && nextTile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
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
      const mission = ctx.globalDirective?.mission;
      const missionTarget = mission?.phase === "TERMINAL" && mission.target?.alive
        ? mission.target
        : null;
      const candidates = (ctx.globalThreats || []).filter((item) => item.enemy?.alive
        && (item.enemy === missionTarget
          || (item.defenseTier <= 1 && manhattan(tank, item.enemy) <= TILE * 4.5)))
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
      const missionPlan = missionTarget === intruder.enemy ? mission?.plan : null;
      const fallbackGoals = [
        ...baseEmergencyMeleeGoals(ctx, intruder.enemy),
        ...baseEmergencyFlankGoals(ctx, intruder.enemy),
      ];
      const route = advisorCurrentPath(ctx, tank, missionPlan?.path, fallbackGoals);
      if (route.length >= 2) {
        publishRoute(ctx, tank, route);
        const step = routeStep(ctx, tank, route, 2.5, intruder.enemy, true);
        const next = route[1];
        const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
        if (step.dir && !step.aligning && nextTile === "B"
          && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
          mode = "core-terminal-base-melee-clear";
          return aimedFireAction(ctx, tank, step.dir, mode, intruder.enemy);
        }
        if (step.dir && (step.aligning || ctx.canMove?.(step.dir))) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.24;
          mode = step.aligning
            ? "core-terminal-base-melee-align"
            : "core-terminal-base-melee-route";
          return {
            dir: step.dir,
            moveDir: step.dir,
            moveScale: 1,
            fire: false,
            hold: false,
            mode,
            target: intruder.enemy,
          };
        }
      }
      const recovery = recoveryDirection(ctx, tank, intruder.enemy, fallbackGoals);
      if (recovery) {
        mode = "core-terminal-base-melee-recover";
        return {
          dir: recovery,
          moveDir: recovery,
          moveScale: 1,
          fire: false,
          hold: false,
          mode,
          target: intruder.enemy,
        };
      }
      return null;
    }

    function baseCorridorDefenseAction(ctx, tank, enemy, now, earlyFastThreat = false) {
      if (!enemy?.alive || (!earlyFastThreat && !isBaseIntruder(ctx, enemy))) {
        baseCorridorTarget = null;
        baseCorridorSide = null;
        return null;
      }
      const enemyDistance = manhattan(tank, enemy);
      // Early fast interception yields once mobile combat can take over. A
      // true base intruder only yields after the defender reaches its flank;
      // distance alone is misleading when the base wall separates both tanks.
      if (earlyFastThreat && enemyDistance <= LOCAL_HUNT_RANGE) {
        baseCorridorTarget = null;
        baseCorridorSide = null;
        return null;
      }
      if (baseCorridorTarget !== enemy) {
        baseCorridorTarget = enemy;
        baseCorridorSide = null;
      }
      const corridor = baseEmergencyCorridor(ctx, tank, enemy, baseCorridorSide, earlyFastThreat);
      if (!corridor) return null;
      baseCorridorSide = corridor.side;
      if (!corridor.path.length) {
        baseCorridorTarget = null;
        baseCorridorSide = null;
        return null;
      }
      const immediateShot = currentPositionShot(ctx, tank, enemy)
        || directShot(ctx, tank, enemy)
        || predictiveShot(ctx, tank, enemy)
        || pointBlankShot(ctx, tank, enemy, manhattan(tank, enemy));
      if (immediateShot) {
        setTarget(enemy, now + 1.2, true);
        targetLockUntil = Math.max(targetLockUntil, now + 1.2);
        closeLockUntil = Math.max(closeLockUntil, now + 0.65);
        tacticalState = "ENGAGE";
        stateUntil = now + 0.35;
        mode = ctx.canFire?.() ? "core-base-corridor-fire" : "core-base-corridor-reload";
        publishRoute(ctx, tank, [cellOf(tank)]);
        return aimedFireAction(ctx, tank, immediateShot, mode, enemy, true);
      }
      setTarget(enemy, now + 1.2, true);
      targetLockUntil = Math.max(targetLockUntil, now + 1.2);
      publishRoute(ctx, tank, corridor.path);
      const step = routeStep(ctx, tank, corridor.path, 3.5, enemy, false);
      if (!step.dir) return null;
      const next = corridor.path[1] || null;
      const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
      if (!step.aligning && nextTile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
        mode = "core-base-corridor-clear";
        return aimedFireAction(ctx, tank, step.dir, mode, enemy);
      }
      tacticalState = "CHASE";
      stateUntil = now + 0.45;
      mode = step.aligning ? "core-base-corridor-align" : "core-base-corridor-route";
      return { dir: step.dir, moveScale: 1, fire: false, hold: false, mode, target: enemy };
    }

    function incomingBulletAction(ctx, tank, bullet, now, preferredTarget, crossingOnly = false) {
      if (!bullet || bullet.dead) return null;
      const threat = bulletThreat(ctx, tank, bullet, 3.4);
      if (!bullet.enemy) {
        if (!bullet.owner || bullet.owner === tank) return null;
        // A crossing warning may stop movement only when staying is safe.
        // Never turn a teammate's live incoming shell into an idle command.
        const forced = threat ? forcedBulletEscapePlan(ctx, tank, bullet, preferredTarget) : null;
        const dodge = threat
          ? dodgeDirection(ctx, tank, bullet, preferredTarget)
            || lastChanceBulletEscape(ctx, tank, bullet) || forced?.dir
          : predictiveDetourDirection(ctx, tank, preferredTarget);
        tacticalState = "EVADE";
        evadeDir = dodge || null;
        stateUntil = now + 0.12;
        mode = dodge ? "core-avoid-friendly-bullet" : "core-avoid-friendly-bullet-hold";
        return { dir: dodge || tank.dir, moveDir: dodge || tank.dir,
          fire: false, hold: !dodge, moveScale: 1, mode, target: preferredTarget };
      }
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
        && !isProtectedDefenseBrick(ctx, nextCell.x, nextCell.y)) {
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
        if (typeof ctx.canMove === "function") ctx.advisorCanMove = ctx.canMove;
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
        const assignedThreat = ctx.globalDirective?.threat;
        const defenseMission = ctx.globalDirective?.mission;
        const terminalMission = defenseMission?.phase === "TERMINAL"
          && defenseMission.target?.alive;
        if (freezeRemaining <= 0 && terminalMission) {
          const terminalDefense = terminalBaseDefenseAction(ctx, tank, now);
          if (terminalDefense) return terminalDefense;
        }
        const earlyFastCorridor = Boolean(assignedThreat?.fast
          && assignedThreat.defenseTier <= 2
          && assignedThreat.dangerEta <= 7.5);
        const assignedBaseIntruder = ctx.globalDirective?.target?.alive
          && !terminalMission
          && ((assignedThreat?.defenseTier <= 1 && isBaseIntruder(ctx, ctx.globalDirective.target))
            || earlyFastCorridor)
          ? ctx.globalDirective.target
          : null;
        if (assignedBaseIntruder) {
          const corridorDefense = baseCorridorDefenseAction(
            ctx,
            tank,
            assignedBaseIntruder,
            now,
            earlyFastCorridor,
          );
          if (corridorDefense) return corridorDefense;
        } else if (!baseCorridorTarget?.alive) {
          baseCorridorTarget = null;
          baseCorridorSide = null;
        }
        if (freezeRemaining <= 0 && !terminalMission) {
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
            const approachAction = frozenContactApproachAction(tank, freezeContact);
            mode = approachAction.mode;
            return approachAction;
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
              if (!step.aligning && nextTile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
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
              if (!step.aligning && nextTile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
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
          const committed = interceptTarget === target && interceptPlan
            && now < interceptPlanUntil
            && interceptPlanMapVersion === Number(ctx.mapVersion || 0)
            ? refreshCommittedInterceptPlan(ctx, tank, target, interceptPlan)
            : null;
          const committedCreatedAt = Number(interceptPlan?.createdAt) || now;
          const committedElapsed = Math.max(0, now - committedCreatedAt);
          const selectedPlan = committed
            ? { ...committed, launchEta: committed.launchEta + committedElapsed }
            : planned;
          const samePlan = interceptTarget === target && interceptPlan
            && interceptPlan.cell?.x === planned.cell?.x
            && interceptPlan.cell?.y === planned.cell?.y
            && interceptPlan.shotDir === planned.shotDir
            && interceptPlanMapVersion === Number(ctx.mapVersion || 0);
          const createdAt = committed || samePlan ? committedCreatedAt : now;
          interceptTarget = target;
          interceptPlan = { ...selectedPlan, createdAt };
          interceptPlanMapVersion = Number(ctx.mapVersion || 0);
          interceptPlanUntil = Math.max(now + 0.32, Number(ctx.globalDirective.commitUntil) || 0);
          stableRouteTarget = target;
          stableRouteMapVersion = Number(ctx.mapVersion || 0);
          stableRoute = selectedPlan.path;
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
        if (!step.aligning && nextTile === "B" && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
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
            if (!detourStep.aligning && detourTile === "B"
              && !isProtectedDefenseBrick(ctx, detourNext.x, detourNext.y)) {
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

    function enforceDefenseMissionProgress(ctx, action, now) {
      const directive = ctx.globalDirective;
      const mission = directive?.mission;
      const enemy = mission?.target?.alive ? mission.target : null;
      const urgent = Boolean(enemy && directive?.threat
        && (mission.phase === "TERMINAL"
          || mission.phase === "INTERCEPT"
          || directive.threat.defenseTier <= 2));
      if (!urgent) {
        defenseProgressTarget = null;
        defenseProgressPhase = "IDLE";
        defenseProgressMetric = Infinity;
        defenseRecoveryDir = null;
        defenseRecoveryUntil = 0;
        return action;
      }
      const liveShot = currentPositionShot(ctx, ctx.tank, enemy)
        || directShot(ctx, ctx.tank, enemy)
        || predictiveShot(ctx, ctx.tank, enemy);
      if (action?.fire && action.target === enemy) {
        defenseProgressAt = now;
        defenseProgressMetric = 0;
        return action;
      }
      const routeMode = /(?:base-corridor|global-defense|global-rear|advisor-base|terminal-base-melee|intercept)-(?:route|align|approach|recover|clear)/.test(String(action?.mode || ""));
      if (!routeMode || action?.target !== enemy) return action;
      if (liveShot) {
        defenseProgressAt = now;
        defenseProgressMetric = 0;
        return aimedFireAction(ctx, ctx.tank, liveShot, "core-defense-contract-fire", enemy, true);
      }
      const route = mission.plan?.path || [];
      const metric = defenseRouteProgressMetric(ctx.tank, route, enemy);
      const physicalPoint = center(ctx.tank);
      if (defenseProgressTarget !== enemy || defenseProgressPhase !== mission.phase) {
        defenseProgressTarget = enemy;
        defenseProgressPhase = mission.phase;
        defenseProgressMetric = metric;
        defenseProgressAt = now;
        defenseProgressPoint = physicalPoint;
        defenseRecoveryDir = null;
        defenseRecoveryUntil = 0;
        return action;
      }
      if (metric + 3 < defenseProgressMetric
        || !defenseProgressPoint || pointDistance(physicalPoint, defenseProgressPoint) >= 8) {
        defenseProgressMetric = metric;
        defenseProgressPoint = physicalPoint;
        defenseProgressAt = now;
        defenseRecoveryDir = null;
        defenseRecoveryUntil = 0;
        return action;
      }
      if (defenseRecoveryDir && now < defenseRecoveryUntil
        && (ctx.advisorCanMove || ctx.canMove)?.(defenseRecoveryDir)) {
        return {
          dir: defenseRecoveryDir,
          moveDir: defenseRecoveryDir,
          moveScale: 1,
          fire: false,
          hold: false,
          mode: "core-defense-contract-recover",
          target: enemy,
        };
      }
      const clearTimeout = /clear/.test(String(action?.mode || "")) ? 1.2 : 0.82;
      if (now - defenseProgressAt < clearTimeout) return action;

      const current = cellOf(ctx.tank);
      const failedIndex = route.findIndex((cell) => cell.x === current.x && cell.y === current.y);
      const failedCell = failedIndex >= 0 ? route[failedIndex + 1] : route[1];
      if (failedCell && !isProtectedDefenseBrick(ctx, failedCell.x, failedCell.y)) {
        ctx.aiAvoidCell = { ...failedCell, until: now + 0.9 };
      }
      stableRouteTarget = null;
      stableRoute = [];
      stableRouteUntil = 0;
      interceptTarget = null;
      interceptPlan = null;
      interceptPlanUntil = now;
      baseCorridorTarget = null;
      baseCorridorSide = null;

      const failedGoalKey = mission.goal ? keyOf(mission.goal.x, mission.goal.y) : "";
      const fallbackGoals = [
        ...baseEmergencyMeleeGoals(ctx, enemy),
        ...baseEmergencyFlankGoals(ctx, enemy),
        ...closeCombatGoals(ctx, ctx.tank, enemy),
      ].filter((cell, index, cells) => keyOf(cell.x, cell.y) !== failedGoalKey
        && cells.findIndex((item) => item.x === cell.x && item.y === cell.y) === index);
      const routeCtx = {
        ...ctx,
        tank: ctx.tank,
        aiSideRole: null,
        canMove: ctx.advisorCanMove || ctx.canMove,
      };
      const alternate = findPath(routeCtx, current, fallbackGoals);
      const step = routeStep(routeCtx, ctx.tank, alternate, 2.5, enemy, true);
      const next = alternate[1];
      const nextTile = next ? (ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x]) : null;
      let recovery = step.dir && (step.aligning || routeCtx.canMove?.(step.dir)) ? step.dir : null;
      if (!recovery) recovery = recoveryDirection(routeCtx, ctx.tank, enemy, fallbackGoals);
      defenseProgressMetric = Infinity;
      defenseProgressAt = now;
      defenseRecoveryDir = recovery;
      defenseRecoveryUntil = recovery ? now + 0.48 : now;
      services?.recordExperience?.("defense_route_stall", {
        stage: ctx.stage,
        time: now,
        tank: ctx.tank,
        enemy,
        target: enemy,
        mode: action?.mode,
        reason: `${mission.phase.toLowerCase()}-no-progress`,
      });
      if (recovery && !step.aligning && nextTile === "B" && next
        && !isProtectedDefenseBrick(ctx, next.x, next.y)) {
        return aimedFireAction(ctx, ctx.tank, recovery, "core-defense-contract-clear", enemy);
      }
      if (recovery) {
        return {
          dir: recovery,
          moveDir: recovery,
          moveScale: 1,
          fire: false,
          hold: false,
          mode: "core-defense-contract-recover",
          target: enemy,
        };
      }
      const contact = advisorTerminalContactAction(routeCtx, ctx.tank, enemy);
      return contact || action;
    }

    function decide(ctx, _dt = 0) {
      // Geometry is fixed during one decision; never carry forecasts to another frame.
      movementForecastCaches.set(ctx, new Map());
      for (const feedback of shotFeedback.observe(ctx)) {
        if (feedback.outcome === "miss") {
          const repeated = previousStationaryMiss?.target === feedback.target
            && previousStationaryMiss.cell.x === feedback.cell.x
            && previousStationaryMiss.cell.y === feedback.cell.y
            && (Number(ctx.gameTime) || 0) - previousStationaryMiss.time <= 2.5;
          previousStationaryMiss = { ...feedback, time: Number(ctx.gameTime) || 0 };
          if (repeated) {
            if (feedback.frozen && (ctx.freezeTime || 0) > 0) pendingFreezeShots.push(feedback);
            missedShotRecovery = { ...feedback, until: (Number(ctx.gameTime) || 0) + 0.6 };
            stableRouteUntil = 0;
            freezePlanCacheUntil = 0;
          }
        } else if (feedback.outcome === "target-damaged" || feedback.outcome === "target-moved") {
          if (previousStationaryMiss?.target === feedback.target) previousStationaryMiss = null;
          if (missedShotRecovery?.target === feedback.target) missedShotRecovery = null;
        }
        if (feedback.outcome !== "launched") services?.recordExperience?.("ai_shot_feedback", {
          player: name, stage: ctx.stage, time: ctx.gameTime, tank: ctx.tank,
          target: feedback.target, reason: feedback.outcome,
        });
      }
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
            moveDir: recovery || ctx.tank.dir,
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
          && (!action.moveDir || action.moveDir === emergencyMoveDir)
          && !terminalBaseThreat
          && !committedMovesAway
          && ctx.canMove?.(emergencyMoveDir)) {
          mode = "core-base-move-commit";
          action = { ...action, dir: emergencyMoveDir, moveDir: emergencyMoveDir, mode };
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
      let lockedTarget = action?.target?.alive
        ? action.target
        : target?.alive ? target : missionTarget?.alive ? missionTarget : null;
      const advisor = updateTacticalAdvisor(
        ctx,
        ctx.tank,
        action,
        lockedTarget,
        now,
        advisorState,
        services,
        name,
      );
      const globalPlan = advisorGlobalControlPlan(
        ctx,
        ctx.tank,
        action,
        lockedTarget,
        advisor,
        now,
        advisorState,
      );
      if (globalPlan.retarget?.alive) {
        if (target !== globalPlan.retarget) setTarget(globalPlan.retarget, now + 1.4, true, true);
        targetLockUntil = Math.max(targetLockUntil, now + 1.4);
        closeLockUntil = Math.max(closeLockUntil, now + 0.8);
      }
      action = globalPlan.action;
      lockedTarget = globalPlan.lockedTarget;
      if (missedShotRecovery && now < missedShotRecovery.until
        && action.target === missedShotRecovery.target && action.target?.alive
        && !/freeze-pickup|shield|counter|dodge|evade|clear/.test(action.mode || "")
        && cellOf(ctx.tank).x === missedShotRecovery.cell.x
        && cellOf(ctx.tank).y === missedShotRecovery.cell.y) {
        const recoveryCtx = { ...ctx, aiAvoidCell: missedShotRecovery.cell };
        const recovery = shotLaneRepositionPlan(recoveryCtx, ctx.tank, action.target);
        if (recovery?.dir && ctx.canMove?.(recovery.dir)
          && !movementBulletThreat(ctx, ctx.tank, recovery.dir, 0.9)) {
          action = { ...action, dir: recovery.dir, moveDir: recovery.dir,
            fire: false, hold: false, mode: "core-shot-feedback-reposition" };
          publishRoute(ctx, ctx.tank, recovery.path);
        }
      }
      action = enforceDefenseMissionProgress(ctx, action, now);
      action = capAlignmentMove(action, ctx.tank);
      action = stabilizeMovement(ctx, ctx.tank, action, now);
      if (action?.target?.alive) lockedTarget = action.target;
      action = capAlignmentMove(action, ctx.tank);
      action = preventGuardShot(ctx, action);
      const autonomyObservation = observeAutonomousControl(
        ctx,
        ctx.tank,
        action,
        lockedTarget,
        now,
        services,
        name,
        advisor,
      );
      recordAdvisorFullControl(
        ctx,
        ctx.tank,
        action,
        lockedTarget,
        now,
        advisorState,
        services,
        name,
        globalPlan.reason,
      );
      const advisorParticipation = "full-control";
      const finalMoveDir = action?.moveDir || action?.dir;
      if (finalMoveDir && !action?.hold) lastMoveDir = finalMoveDir;
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
      publishActionRoute(ctx, ctx.tank, lockedTarget, now);
      shotFeedback.expect(ctx, action);
      return {
        ...action,
        lockedTarget,
        advisor: {
          ...advisor,
          shadow: false,
          globalControl: true,
          applied: Boolean(advisorParticipation),
          participation: advisorParticipation || "full-control",
          autonomy: autonomyObservation,
        },
      };
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
            defenseProgressMetric = Infinity;
            defenseProgressAt = lastDecisionTime;
            defenseRecoveryDir = null;
            defenseRecoveryUntil = 0;
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
        advisor: {
          runs: advisorState.runs,
          cacheHits: advisorState.cacheHits,
          disagreements: advisorState.disagreements,
          applied: advisorState.applied,
          blocked: advisorState.blocked,
          lastReason: advisorState.result?.reason || null,
          depth: advisorState.result?.depth || 1,
          nodes: advisorState.result?.nodes || 0,
          ttHits: advisorState.result?.ttHits || 0,
          cutoffs: advisorState.result?.cutoffs || 0,
        },
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
      advisorStats() {
        return { ...tacticalAdvisorTelemetry };
      },
      previewAdvisorPhaseOne(ctx, baseline, lockedTarget, advice) {
        const reason = advisorPhaseOneBlockReason(ctx, ctx?.tank, baseline, lockedTarget, advice);
        return { allowed: !reason, reason: reason || "safe-route" };
      },
      previewMovementLoop(entries, currentPoint, currentDistance) {
        const result = movementLoopPattern(entries, currentPoint, currentDistance);
        return result ? { detected: true, reason: result.reason } : { detected: false, reason: "" };
      },
      previewMovementBulletThreat(ctx, dir, horizon = 0.9) {
        return movementBulletThreat(ctx, ctx.tank, dir, horizon);
      },
      previewRouteStep(ctx, path) {
        return routeStep(ctx, ctx.tank, path);
      },
      previewBaseProjectileThreat(ctx, bullet) {
        return baseProjectileThreat(ctx, bullet);
      },
      previewRejoinPath(ctx, path, goals) {
        return advisorCurrentPath(ctx, ctx.tank, path, goals);
      },
      previewAlignmentMove(action, tank = null) {
        return capAlignmentMove(action, tank);
      },
      previewAdvisorBaseDefense(ctx, baseline, lockedTarget, now = Number(ctx?.gameTime) || 0) {
        return advisorBaseDefensePlan(ctx, ctx?.tank, baseline, lockedTarget, now, {
          baseRoute: [],
          baseRouteKey: "",
          baseRouteUntil: 0,
        });
      },
      previewAdvisorCritical(ctx, baseline, lockedTarget) {
        return advisorCriticalPlan(ctx, ctx?.tank, baseline, lockedTarget);
      },
      previewAdvisorDefensePosture(ctx) {
        return advisorDefensePosture(ctx, ctx?.tank);
      },
      previewBaseDefenseProfile(ctx, enemy) {
        return baseDefenseProfile(ctx, enemy);
      },
      previewReliableIntercept(ctx, tank, enemy) {
        const threat = { enemy, ...baseDefenseProfile(ctx, enemy) };
        return reliableDefensePlan(planningContextForAlly(ctx, tank), tank, threat);
      },
      previewRefreshIntercept(ctx, tank, enemy, plan) {
        return refreshCommittedInterceptPlan(planningContextForAlly(ctx, tank), tank, enemy, plan);
      },
      previewDefenderRouteEta(tank, path, ctx = null) {
        return defenderRouteTravelTime(tank, path, ctx);
      },
      previewTerminalShare(threat, threats) {
        return canShareTerminalThreat(threat, threats);
      },
      previewDefenseMission(ctx, tank, enemy, reservedCells = []) {
        const threat = { enemy, ...baseDefenseProfile(ctx, enemy) };
        return buildDefenseMission(
          planningContextForAlly(ctx, tank),
          tank,
          threat,
          new Set(reservedCells),
        );
      },
      previewGlobalBattle(ctx, now = Number(ctx?.gameTime) || 0) {
        return analyzeGlobalBattle(ctx, now);
      },
      previewDefenseCoverage(matrix, deadlines) {
        return solveDefenseCoverage(matrix, deadlines);
      },
      previewMapEntryGoals(ctx) {
        return baseEntryGoals(ctx);
      },
      previewTerrainKey(ctx) {
        return autonomyTerrainKey(ctx, ctx.tank);
      },
      previewLethalShotEta(tank, enemy, aimReadyEta, distance, freezeTime = 0) {
        return lethalShotEta(tank, enemy, aimReadyEta, distance, freezeTime);
      },
      previewFreezePath(ctx, tank, bonus) {
        return freezePath(ctx, tank, bonus);
      },
      createShotFeedbackTracker,
      previewDefenseRouteMetric(tank, path, target = null) {
        return defenseRouteProgressMetric(tank, path, target);
      },
      previewProtectedDefenseBrick(ctx, x, y) {
        return isProtectedDefenseBrick(ctx, x, y);
      },
      previewGuardFireGate(ctx, action) {
        return preventGuardShot(ctx, action);
      },
      previewAdvisorReliableReturn(ctx, baseline) {
        return advisorReliableReturnPlan(ctx, ctx?.tank, baseline);
      },
      previewTerminalContact(ctx, enemy) {
        return advisorTerminalContactAction(ctx, ctx?.tank, enemy);
      },
      previewRelocationPath(ctx, goals) {
        return findRelocationPath(ctx, ctx.tank, goals);
      },
      previewAdvisorKey(ctx, baseline, lockedTarget) {
        return tacticalAdvisorKey(ctx, ctx?.tank, lockedTarget, baseline);
      },
      previewAdvisorSearch(ctx, baseline, lockedTarget) {
        return searchTacticalAdvice(ctx, ctx?.tank, baseline, lockedTarget, services);
      },
      previewSearchTransition(ctx, state, action, ownTurn = true) {
        return advisorSearchApply(ctx, state || createAdvisorSearchState(ctx, ctx.tank, null), action, ownTurn);
      },
      previewAutonomyState(ctx, lockedTarget = null) {
        const target = lockedTarget?.alive ? lockedTarget : ctx?.globalDirective?.target || null;
        return autonomyStateKey(ctx, ctx?.tank, target, advisorDefensePosture(ctx, ctx?.tank));
      },
      previewAutonomyAction(tank, target, action) {
        return autonomyActionKey(tank, target, action);
      },
      previewAdvisorGlobalControl(ctx, baseline, lockedTarget, advice = {}) {
        return advisorGlobalControlPlan(
          ctx,
          ctx?.tank,
          baseline,
          lockedTarget,
          advice,
          Number(ctx?.gameTime) || 0,
          {
            baseRoute: [],
            baseRouteKey: "",
            baseRouteUntil: 0,
            lastParticipationAdvice: null,
            blocked: 0,
            appliedDir: null,
            appliedTarget: null,
            appliedUntil: 0,
          },
        );
      },
      createController(name) {
        return createCoreController(name, services);
      },
    };
  }

  function installAiVersionDisplay() {
    if (typeof document === "undefined") return;
    const label = document.getElementById("aiUpdatedInfo");
    if (!label) return;
    const host = /** @type {any} */ (window);
    const panel = label.closest(".ai-version-panel");
    const playfield = label.closest(".playfield");
    label.style.display = "grid";
    label.style.alignContent = "center";
    label.style.gap = "2px";
    label.style.lineHeight = "1";
    if (panel instanceof HTMLElement) panel.style.minHeight = "38px";
    if (playfield instanceof HTMLElement) playfield.style.gridTemplateRows = "auto auto 38px";
    host.__fcAiVersionObserver?.disconnect?.();
    const reasonLabels = {
      "no-candidate": "等待分析",
      "bullet-risk": "弹道风险",
      "fire-window": "射击机会",
      "intercept-gain": "截击增益",
      "baseline-best": "原决策最优",
      "position-gain": "位置增益",
      "full-control": "全局接管",
    };
    const compactAdvisorCount = (value) => {
      const count = Math.max(0, Math.floor(Number(value) || 0));
      if (count < 1000) return String(count);
      if (count < 1000000) return `${Number((count / 1000).toFixed(count < 10000 ? 1 : 0))}K`;
      return `${Number((count / 1000000).toFixed(1))}M`;
    };
    const render = () => {
      const info = host.FCHotUpgradeVersion?.ai;
      const digits = String(info?.version || info?.hash || "").replace(/\D/g, "");
      if (digits.length < 12) return;
      const versionLabel = `${digits.slice(4, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
      const updatedAt = String(info?.updatedAtBeijing || "UNKNOWN")
        .replace(/(\d{2}:\d{2}):\d{2}(?=\s*(?:CST)?$)/i, "$1")
        .replace(/\s+CST$/i, "");
      const stats = tacticalAdvisorTelemetry;
      const score = Math.round(Number(stats.lastScore) || 0);
      const reason = reasonLabels[stats.lastReason] || "等待分析";
      const timeText = `AI ${updatedAt}`;
      const advisorText = `全局控制 R${compactAdvisorCount(stats.runs)} P${compactAdvisorCount(stats.applied)} C${compactAdvisorCount(stats.cacheHits)} D${compactAdvisorCount(stats.disagreements)} S${score} ${reason}`;
      let timeLine = /** @type {HTMLElement | null} */ (label.querySelector(".ai-update-time"));
      let advisorLine = /** @type {HTMLElement | null} */ (label.querySelector(".ai-advisor-data"));
      if (!timeLine || !advisorLine) {
        timeLine = document.createElement("span");
        timeLine.className = "ai-update-time";
        timeLine.style.color = "var(--ink)";
        timeLine.style.fontSize = "10px";
        advisorLine = document.createElement("span");
        advisorLine.className = "ai-advisor-data";
        advisorLine.style.color = "#66d26e";
        advisorLine.style.fontSize = "13px";
        label.replaceChildren(timeLine, advisorLine);
      }
      if (timeLine.textContent !== timeText) timeLine.textContent = timeText;
      if (advisorLine.textContent !== advisorText) advisorLine.textContent = advisorText;
      label.title = `AI版本 ${versionLabel}，更新时间 ${updatedAt}。全局控制：分析 ${stats.runs}，最终裁决 ${stats.applied}，安全拒绝 ${stats.blocked}，缓存命中 ${stats.cacheHits}，决策分歧 ${stats.disagreements}，最近评分 ${score}，原因 ${stats.lastReason}，控制状态 ${stats.lastParticipation}`;
    };
    refreshAiVersionDisplay = render;
    render();
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(render);
      observer.observe(label, { childList: true, characterData: true, subtree: true });
      host.__fcAiVersionObserver = observer;
    }
    if (typeof setTimeout !== "undefined") setTimeout(render, 0);
  }

  function validatePolicySnapshot(value) {
    if (!value || value.schema !== 1 || !value.stages || !value.biases) throw new Error("Invalid policy snapshot");
    const stages = {};
    for (let stage = 1; stage <= 35; stage++) {
      const weights = value.stages[stage];
      if (!weights) throw new Error("Incomplete policy stages");
      stages[stage] = {};
      for (const key of ["defend", "survive", "attack", "clear"]) {
        if (!Number.isFinite(weights[key]) || weights[key] < 0 || weights[key] > 10) throw new Error("Invalid policy weight");
        stages[stage][key] = weights[key];
      }
      Object.freeze(stages[stage]);
    }
    const biases = Object.create(null);
    const entries = Object.entries(value.biases);
    if (entries.length > 1024) throw new Error("Policy state limit exceeded");
    for (const [state, raw] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      if (!state.startsWith("T2-") || state.length > 180 || !raw || typeof raw !== "object") throw new Error("Invalid policy state");
      const actions = Object.entries(raw);
      if (actions.length > 8) throw new Error("Policy action limit exceeded");
      biases[state] = Object.create(null);
      for (const [key, score] of actions.sort(([a], [b]) => a.localeCompare(b))) {
        if (!key || key.length > 64 || !Number.isFinite(score) || Math.abs(Number(score)) > 28) throw new Error("Invalid policy bias");
        biases[state][key] = score;
      }
      Object.freeze(biases[state]);
    }
    return Object.freeze({ schema: 1, stages: Object.freeze(stages), biases: Object.freeze(biases) });
  }

  function evaluatePolicySnapshot(snapshot, state, keys, generation = 0) {
    return {
      biases: Object.fromEntries(keys.map((key) => [key, snapshot?.biases?.[state]?.[key] || 0])),
      champion: null, exploreKey: null, explorationRate: 0, generation,
    };
  }

  window.TankPartnerAIEngine = { version: "CORE", enhance, validatePolicySnapshot, evaluatePolicySnapshot };
  if (window.TankPartnerAI) window.TankPartnerAI = enhance(window.TankPartnerAI);
  installAiVersionDisplay();
})();
