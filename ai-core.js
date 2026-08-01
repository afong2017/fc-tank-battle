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
  const COMBAT_POLICY = Object.freeze({ defend: 6.5, survive: 5, attack: 7, clear: 4 });
  const directBaseShotCaches = new WeakMap();
  const baseDirectFireGoalCaches = new WeakMap();
  const interceptEnemyPathCaches = new WeakMap();
  const breakthroughAssignments = new WeakMap();

  const center = (item) => ({ x: item.x + item.w / 2, y: item.y + item.h / 2 });
  const manhattan = (a, b) => Math.abs(center(a).x - center(b).x) + Math.abs(center(a).y - center(b).y);
  const cellOf = (item) => ({ x: Math.floor(center(item).x / TILE), y: Math.floor(center(item).y / TILE) });
  const keyOf = (x, y) => `${x},${y}`;
  const opposite = (dir) => ({ up: "down", down: "up", left: "right", right: "left" })[dir] || null;

  function crossedMidline(ctx, enemy) {
    const fieldHeight = Math.max(TILE * 3, Number(ctx.rows || 24) * TILE);
    return Boolean(enemy?.alive) && center(enemy).y >= fieldHeight / 2;
  }

  function inForest(ctx, tank) {
    const c = cellOf(tank);
    return ctx.tileAt?.(c.x, c.y) === "F";
  }

  function visibleEnemies(ctx) {
    return (ctx.enemies || []).filter((enemy) => enemy?.alive && !inForest(ctx, enemy));
  }

  function targetPriority(ctx, tank, enemy) {
    const baseDistance = manhattan(enemy, ctx.base);
    const tankDistance = manhattan(enemy, tank);
    const baseEta = baseThreatEta(ctx, enemy);
    const baseLineEta = baseLineThreatEta(ctx, enemy);
    const dangerEta = Math.min(baseEta, baseLineEta);
    const defendWeight = COMBAT_POLICY.defend;
    const basePriorityRange = TILE * Math.max(6, Math.min(14, 5 + defendWeight * 0.45));
    const crossed = crossedMidline(ctx, enemy);
    const directBaseShot = directBaseShotThreat(ctx, enemy);
    const tier = directBaseShot ? -1 : crossed || baseDistance <= basePriorityRange || dangerEta <= 4.2 ? 0 : tankDistance <= LOCAL_HUNT_RANGE ? 1 : 2;
    const stageOne = Number(ctx.stage) === 1;
    const fieldWidth = Math.max(TILE * 3, Number(ctx.cols || 26) * TILE);
    const laneOf = (item) => Math.max(0, Math.min(2, Math.floor(center(item).x / (fieldWidth / 3))));
    const enemyLane = laneOf(enemy);
    const tankLane = laneOf(tank);
    const laneMismatch = enemyLane === tankLane ? 0 : TILE * 1.4;
    const centerDanger = enemyLane === 1 ? TILE * 1.8 : 0;
    const responseScore = tier === 0
      ? dangerEta * TILE * 2 + tankDistance * 0.12 + (stageOne ? laneMismatch - centerDanger : 0)
      : baseDistance + tankDistance * 0.18 + (stageOne ? laneMismatch - centerDanger : 0);
    return { enemy, tier, crossed, directBaseShot, baseDistance, baseEta: dangerEta, baseLineEta, tankDistance, responseScore };
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
      if (tile === "S" || tile === "W") return Infinity;
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
        if (tile === "B" || tile === "S" || tile === "W" || tile === "E") break;
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
      || baseDistance <= TILE * (fast ? 4 : 3.25)
      || eta <= (fast ? 1.65 : 1.25);
    if (!mortal) return null;
    const share = Boolean(direct && direct.eta <= 1.25)
      || baseDistance <= TILE * (fast ? 3.25 : 2.7)
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
        || Number(b.crossed) - Number(a.crossed)
        || a.baseDistance - b.baseDistance
        || a.dangerEta - b.dangerEta)
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
        || a.baseDistance - b.baseDistance
        || a.dangerEta - b.dangerEta
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
    const travel = (ally, threat) => manhattan(ally, threat.enemy) / Math.max(45, Number(ally.speed) || 90);
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
    const directCost = manhattan(allies[0], threats[0].enemy) + manhattan(allies[1], threats[1].enemy);
    const crossedCost = manhattan(allies[0], threats[1].enemy) + manhattan(allies[1], threats[0].enemy);
    const allyIndex = allies.indexOf(tank);
    if (allyIndex < 0 || allyIndex > 1) return threats[0].enemy;
    return threats[crossedCost + TILE * 0.25 < directCost ? 1 - allyIndex : allyIndex].enemy;
  }

  function assignedDirectBaseAttacker(ctx, tank) {
    const ranked = visibleEnemies(ctx).map((enemy) => {
      const direct = directBaseShotThreat(ctx, enemy);
      return direct ? {
        enemy,
        direct,
        baseDistance: manhattan(enemy, ctx.base),
        tankDistance: manhattan(enemy, tank),
      } : null;
    }).filter(Boolean).sort((a, b) => a.direct.eta - b.direct.eta
      || a.baseDistance - b.baseDistance
      || a.tankDistance - b.tankDistance);
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
        const advanced = enemyCenter.y >= fieldHeight * 0.27;
        const pressing = enemy.dir === "down" || dangerEta <= 7.2;
        return central && advanced && pressing ? {
          enemy,
          dangerEta,
          depth: enemyCenter.y,
          baseDistance: manhattan(enemy, ctx.base),
          tankDistance: manhattan(enemy, tank),
        } : null;
      }).filter(Boolean).sort((a, b) => a.dangerEta - b.dangerEta
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

  function chooseTarget(ctx, tank, routeCostFor = null) {
    const enemies = visibleEnemies(ctx);
    if (!enemies.length) return null;
    const finalThreat = lastLineThreat(ctx, tank);
    if (finalThreat) return finalThreat;
    const immediate = nearestImmediateEnemy(ctx, tank);
    if (immediate) return immediate;
    const reserved = new Set((ctx.reservedTargets || []).filter((item) => item?.alive));
    const ranked = enemies.map((enemy) => {
      const priority = targetPriority(ctx, tank, enemy);
      const routeCost = Number(ctx.stage) === 1 && routeCostFor ? routeCostFor(enemy) : 0;
      return { ...priority, routeCost, effectiveScore: priority.responseScore + routeCost * TILE * 0.9 };
    }).sort((a, b) =>
      a.tier - b.tier
      || Number(b.crossed) - Number(a.crossed)
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

  function tileCost(ctx, x, y, allowBaseGuardClear = false) {
    if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) return Infinity;
    if (ctx.aiAvoidCell?.x === x && ctx.aiAvoidCell?.y === y) return Infinity;
    const tile = ctx.tileAt?.(x, y) ?? ctx.map?.[y]?.[x] ?? "S";
    if (tile === "." || tile === "F") return 1;
    if (isGuardCell(ctx, x, y) && (tile !== "B" || !allowBaseGuardClear)) return Infinity;
    if (tile === "B") {
      const clearWeight = COMBAT_POLICY.clear;
      return Math.max(1.02, Math.min(1.18, 1.18 - clearWeight * 0.008));
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

  function findPath(ctx, start, goals, allowBaseGuardClear = false) {
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
        const cost = tileCost(ctx, x, y, allowBaseGuardClear);
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
    const attackWeight = COMBAT_POLICY.attack;
    const searchRange = Math.max(9, Math.min(26, Math.round(8 + attackWeight * 0.9)));
    for (const dir of DIR_NAMES) {
      const d = DIRS[dir];
      for (let distance = 1; distance <= searchRange; distance++) {
        const x = c.x + d.x * distance;
        const y = c.y + d.y * distance;
        const cost = tileCost(ctx, x, y);
        if (!Number.isFinite(cost)) break;
        // Ordinary brick is part of the attack corridor: plan through it and
        // let the movement loop destroy it. Steel and base guard still stop it.
        if (cost === 1) goals.push({ x, y });
      }
    }
    return goals;
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
    const cached = baseDirectFireGoalCaches.get(ctx);
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
    baseDirectFireGoalCaches.set(ctx, { mapVersion, goals });
    return goals;
  }

  function estimatedDirectBaseAttackEta(ctx, enemy) {
    if (!enemy?.alive || !ctx.base) return Infinity;
    const directEta = directBaseShotThreat(ctx, enemy)?.eta ?? Infinity;
    const goals = baseDirectFireGoals(ctx);
    if (!goals.length) return directEta;
    const route = findPath(ctx, cellOf(enemy), goals);
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

  function projectedTargetDistance(tank, target, dir, step = TILE * 0.45) {
    const d = DIRS[dir];
    if (!d || !target) return Infinity;
    return manhattan({ ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step }, target);
  }

  function buildInterceptPlan(ctx, tank, enemy) {
    const enemyStart = cellOf(enemy);
    const enemyPathKey = `${Number(ctx.mapVersion || 0)}:${enemyStart.x},${enemyStart.y}`;
    let enemyPathCache = interceptEnemyPathCaches.get(enemy);
    if (!enemyPathCache || enemyPathCache.key !== enemyPathKey) {
      enemyPathCache = { key: enemyPathKey, path: findPath(ctx, enemyStart, baseEntryGoals(ctx)) };
      interceptEnemyPathCaches.set(enemy, enemyPathCache);
    }
    const enemyPath = enemyPathCache.path;
    if (enemyPath.length < 3) return null;
    const start = cellOf(tank);
    const probes = [];
    for (let i = 2; i < Math.min(enemyPath.length, 14); i++) {
      const enemyCell = enemyPath[i];
      const enemyEta = pathTravelTime(enemyPath.slice(0, i + 1), enemy.speed, enemy.dir, ctx);
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
          if (optimisticAllyEta + 0.3 > enemyEta - flightEta) continue;
          probes.push({
            cell,
            enemyCell,
            shotDir,
            enemyEta,
            flightEta,
            optimisticAllyEta,
          });
        }
      }
    }
    const ranked = probes.sort((a, b) => a.enemyEta - b.enemyEta
      || a.optimisticAllyEta - b.optimisticAllyEta
      || b.flightEta - a.flightEta).slice(0, 12);
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

  function routeStep(ctx, tank, path, alignmentTolerance = 1.5) {
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
          if (tile === "S" || tile === "B" || tile === "E" || tile === "W") {
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
      if (aimReady ? ctx.canShoot?.(dir, target) : timedPredictiveLane(ctx, tank, target, dir)) return dir;
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
    let interceptTime = turnDelay;
    for (let iteration = 0; iteration < 3; iteration++) {
      const horizon = Math.min(0.78, interceptTime);
      const projectedX = targetNow.x + targetDir.x * targetSpeed * horizon;
      const projectedY = targetNow.y + targetDir.y * targetSpeed * horizon;
      const axial = (projectedX - shooter.x) * shotDir.x + (projectedY - shooter.y) * shotDir.y;
      if (axial <= 0) return false;
      interceptTime = turnDelay + axial / 310;
    }
    const horizon = Math.min(0.78, interceptTime);
    const projectedX = targetNow.x + targetDir.x * targetSpeed * horizon;
    const projectedY = targetNow.y + targetDir.y * targetSpeed * horizon;
    const lateral = dir === "up" || dir === "down"
      ? Math.abs(projectedX - shooter.x)
      : Math.abs(projectedY - shooter.y);
    const targetSize = dir === "up" || dir === "down" ? Number(target.w) || 28 : Number(target.h) || 28;
    const sameDirectionPursuit = tank.dir === dir && target.dir === dir;
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
    const minimumDistance = (ctx.freezeTime || 0) > 0
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
    const dir = currentPositionShot(ctx, tank, target);
    if (!dir) return null;
    const tankCenter = center(tank);
    const targetCenter = center(target);
    const lateralOffset = dir === "up" || dir === "down"
      ? Math.abs(tankCenter.x - targetCenter.x)
      : Math.abs(tankCenter.y - targetCenter.y);
    const targetSize = dir === "up" || dir === "down" ? target.w || 28 : target.h || 28;
    const safeHalfWidth = Math.max(7, targetSize / 2 - 3);
    return lateralOffset <= safeHalfWidth ? dir : null;
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

  function aimedFireAction(ctx, tank, dir, fireMode, target, mobile = false) {
    if (tank.dir !== dir || (tank.turnCooldown || 0) > 0) {
      return { dir, fire: false, hold: tank.dir === dir, mode: "core-aim-turn", target };
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
        if (tile === "S" || tile === "W" || tile === "E" || (tile === "B" && isGuardCell(ctx, x, y))) break;
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

  function freezeAttackPlan(ctx, tank, blockedTargets = new Set(), failedTarget = null, failedCell = null, preferredTarget = null) {
    const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
    const plans = visibleEnemies(ctx).map((enemy) => {
      const tankCell = cellOf(tank);
      const failedHere = enemy === failedTarget && failedCell?.x === tankCell.x && failedCell?.y === tankCell.y;
      const shot = failedHere ? null : preciseFrozenShot(ctx, tank, enemy);
      const durability = Math.max(1, Number(enemy.hp || enemy.life) || 1);
      const priority = targetPriority(ctx, tank, enemy);
      if (shot) {
        const finishTime = manhattan(tank, enemy) / 310 + Math.max(0, durability - 1) * 0.42;
        return { enemy, shot, path: [tankCell], finishTime, priority, fitsFreeze: finishTime <= Number(ctx.freezeTime || 0), preferred: enemy === preferredTarget };
      }
      const candidates = freezeShotGoals(ctx, enemy).filter((goal) =>
        enemy !== failedTarget || goal.x !== failedCell?.x || goal.y !== failedCell?.y)
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
    const splitPlans = plans.filter((plan) => !reserved.has(plan.enemy));
    const pool = splitPlans.length ? splitPlans : plans;
    const available = pool.filter((plan) => !blockedTargets.has(plan.enemy));
    return available[0] || pool[0] || null;
  }

  function freezePursuitPlan(ctx, tank, preferredTarget) {
    const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
    const plans = visibleEnemies(ctx).map((enemy) => {
      const stagingGoals = freezeShotGoals(ctx, enemy)
        .filter((goal) => goal.shotDistance >= TILE * 2 && goal.shotDistance <= TILE * 6)
        .map(({ x, y }) => ({ x, y }));
      const fallbackGoals = [...closeCombatGoals(ctx, tank, enemy), ...pursuitGoals(ctx, enemy)];
      const stagingPath = stagingGoals.length ? findPath(ctx, cellOf(tank), stagingGoals) : [];
      const path = stagingPath.length ? stagingPath : findPath(ctx, cellOf(tank), fallbackGoals);
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
    return candidates.map((dir) => {
      const d = DIRS[dir];
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      return {
        dir,
        score: projectileRisk(ctx, next) * 3
          + (enemy?.alive ? manhattan(next, enemy) * 0.18 : 0)
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
    const urgent = isBaseIntruder(ctx, enemy);
    if (((ctx.freezeTime || 0) <= 0 && !urgent) || distance > TILE * 2.05) return null;
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
      const guaranteedLane = lateral <= Math.max(6, targetSize / 2 - 4);
      if (!guaranteedLane) return false;
      if (directionFacesBaseZone(ctx, tank, dir) && lateral > Math.max(5, targetSize / 2 - 5)) return false;
      return !steelBlocksShot(ctx, tank, enemy, dir) && !firstShotObstacle(ctx, tank, dir, enemy);
    }) || null;
  }

  function contactCombatPlan(ctx, tank, preferredTarget) {
    const enemies = visibleEnemies(ctx);
    const frozen = (ctx.freezeTime || 0) > 0;
    const committedEnemies = frozen
      ? enemies
      : preferredTarget?.alive && enemies.includes(preferredTarget)
      ? [preferredTarget]
      : enemies;
    const contact = committedEnemies.map((enemy) => ({
      enemy,
      distance: manhattan(tank, enemy),
      baseIntruder: isBaseIntruder(ctx, enemy),
      emergency: isBaseEmergency(ctx, enemy),
      preferred: enemy === preferredTarget,
    })).filter((item) => item.distance <= (item.baseIntruder
      ? TILE * (isFastLastLine(ctx, item.enemy) ? 3.4 : 3.15)
      : (ctx.freezeTime || 0) > 0 ? TILE * 4.75 : TILE * 2.7))
      .sort((a, b) => Number(b.baseIntruder) - Number(a.baseIntruder)
        || Number(b.emergency) - Number(a.emergency)
        || a.distance - b.distance
        || Number(b.preferred) - Number(a.preferred))[0];
    if (!contact) return null;
    const direct = frozen
      ? preciseFrozenShot(ctx, tank, contact.enemy)
      : currentPositionShot(ctx, tank, contact.enemy) || directShot(ctx, tank, contact.enemy);
    const predicted = frozen || direct ? null : predictiveShot(ctx, tank, contact.enemy);
    if (direct || predicted) {
      return { ...contact, shot: direct || predicted, predicted: !direct && Boolean(predicted), approach: null };
    }
    const pointBlank = pointBlankShot(ctx, tank, contact.enemy, contact.distance);
    if (pointBlank) {
      return { ...contact, shot: pointBlank, predicted: false, pointBlank: true, approach: null };
    }
    const frozenAlignment = frozenCloseAlignmentDirection(ctx, tank, contact.enemy);
    if (frozenAlignment) {
      return { ...contact, shot: null, predicted: false, approach: frozenAlignment, frozenAlignment: true, breakaway: false };
    }
    const tankCenter = center(tank);
    const enemyCenter = center(contact.enemy);
    const step = Math.max(8, Math.min(14, (Number(tank.speed) || 90) * 0.1));
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
      return {
        dir,
        distance,
        score: distance + alignment * 1.4 + projectileRisk(ctx, next) * 2.2
          + (dir === tank.dir ? 0 : 5)
          + (jammed && lateralDirs.has(dir) ? -46 : 0)
          + (jammed && dir === opposite(towardDir) ? -10 : 0)
          + (jammed && dir === towardDir ? 48 : 0),
      };
    }).filter((item) => item.distance <= currentDistance + (jammed ? TILE * 0.85 : 6))
      .sort((a, b) => a.score - b.score);
    return { ...contact, shot: null, predicted: false, approach: candidates[0]?.dir || null, breakaway: jammed };
  }

  function topSuppressor(ctx, tank) {
    const allies = [tank, ...(ctx.friends || [])].filter((ally) => ally?.alive);
    const selected = allies.find((ally) => ally.kind === "player")
      || allies.find((ally) => ally.kind === "player2")
      || null;
    return selected === tank;
  }

  function advanceSafetyThreats(ctx) {
    const warningLine = Math.max(TILE * 8, Number(ctx.rows || 24) * TILE * 0.4);
    return visibleEnemies(ctx).map((enemy) => {
      const direct = directBaseShotThreat(ctx, enemy);
      const baseDistance = manhattan(enemy, ctx.base);
      const dangerEta = Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy));
      const depth = center(enemy).y;
      return { enemy, direct, baseDistance, dangerEta, depth };
    }).filter((item) => item.direct
      || item.depth >= warningLine
      || item.baseDistance <= TILE * 11
      || item.dangerEta <= 6.8)
      .sort((a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct))
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
      + (ally.kind === "player" ? TILE * 0.75 : 0);
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

  function topSuppressionShot(ctx, tank) {
    return visibleEnemies(ctx).filter((enemy) => center(enemy).y <= TILE * 10).map((enemy) => {
      const direct = directShot(ctx, tank, enemy);
      const predicted = direct ? null : predictiveShot(ctx, tank, enemy);
      return { enemy, dir: direct || predicted, predicted: !direct && Boolean(predicted), distance: manhattan(tank, enemy) };
    }).filter((item) => item.dir)
      .sort((a, b) => Number(a.predicted) - Number(b.predicted) || a.distance - b.distance)[0] || null;
  }

  function rearScreenRole(ctx, tank) {
    const enemies = visibleEnemies(ctx);
    if (enemies.length < 2) return false;
    const topLimit = TILE * 11;
    const tankAtTop = center(tank).y <= topLimit;
    const friendAtTop = (ctx.friends || []).some((ally) => ally?.alive && center(ally).y <= topLimit);
    if (!tankAtTop && !friendAtTop) return false;
    if (!tankAtTop && friendAtTop) return true;
    if (tankAtTop && friendAtTop) return tank.kind === "player2";
    return false;
  }

  function rearBreakthroughTarget(ctx, tank) {
    const reserved = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
    const threats = visibleEnemies(ctx).filter((enemy) => center(enemy).y > TILE * 7).map((enemy) => ({
      enemy,
      eta: Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy)),
      baseDistance: manhattan(enemy, ctx.base),
      tankDistance: manhattan(tank, enemy),
      depth: center(enemy).y,
    })).sort((a, b) => a.eta - b.eta
      || b.depth - a.depth
      || a.baseDistance - b.baseDistance
      || a.tankDistance - b.tankDistance);
    return threats.find(({ enemy }) => !reserved.has(enemy))?.enemy || threats[0]?.enemy || null;
  }

  function rearScreenPath(ctx, tank) {
    const current = cellOf(tank);
    const width = Math.max(TILE * 3, Number(ctx.cols || 26) * TILE);
    const laneCenters = [Math.floor(ctx.cols / 6), Math.floor(ctx.cols / 2), Math.floor(ctx.cols * 5 / 6)];
    const laneThreat = visibleEnemies(ctx).map((enemy) => {
      const lane = Math.max(0, Math.min(2, Math.floor(center(enemy).x / (width / 3))));
      return {
        enemy,
        lane,
        eta: Math.min(baseThreatEta(ctx, enemy), baseLineThreatEta(ctx, enemy)),
        depth: center(enemy).y,
      };
    }).sort((a, b) => a.eta - b.eta || b.depth - a.depth)[0];
    const preferredX = laneThreat ? laneCenters[laneThreat.lane] : (tank.kind === "player" ? 8 : 17);
    const screenY = Math.min(ctx.rows - 4, 13);
    const goals = [0, -1, 1, -2, 2].map((offset) => ({ x: preferredX + offset, y: screenY }))
      .filter((cell) => tileCost(ctx, cell.x, cell.y) === 1);
    return findPath(ctx, current, goals);
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
    const surviveWeight = COMBAT_POLICY.survive;
    const horizon = Math.max(2.2, Math.min(3.4, 2.1 + surviveWeight * 0.16));
    return (ctx.bullets || []).filter((bullet) => bullet?.enemy && !bullet.dead).map((bullet) => ({
      bullet,
      threat: bulletThreat(ctx, tank, bullet, horizon),
    })).filter((item) => item.threat)
      .sort((a, b) => a.threat.eta - b.threat.eta || a.threat.lateral - b.threat.lateral)[0]?.bullet || null;
  }

  function incomingFriendlyBullet(ctx, tank) {
    return (ctx.bullets || []).filter((bullet) =>
      bullet && !bullet.enemy && !bullet.dead && bullet.owner && bullet.owner !== tank
    ).map((bullet) => ({
      bullet,
      threat: allyFireBlockedByEnemy(ctx, tank, bullet) ? null : bulletThreat(ctx, tank, bullet, 3),
    })).filter((item) => item.threat)
      .sort((a, b) => a.threat.eta - b.threat.eta || a.threat.lateral - b.threat.lateral)[0]?.bullet || null;
  }

  function incomingAllyFire(ctx, tank) {
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
      if (tile === "B" || tile === "S" || tile === "E" || tile === "W") return false;
      x += dx;
      y += dy;
    }
    return true;
  }

  function aimingEnemy(ctx, tank) {
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
    const options = bullet.dir === "up" || bullet.dir === "down" ? ["left", "right"] : ["up", "down"];
    return options.filter((dir) => ctx.canMove?.(dir)
      && !movementBulletThreat(ctx, tank, dir, 1.15)).sort((a, b) => {
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

  function projectileRisk(ctx, tank) {
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
      if (tile === "B" || tile === "S" || tile === "E" || tile === "W") return distance;
    }
    return Infinity;
  }

  function movementBulletThreat(ctx, tank, dir, horizon = 0.9) {
    const movement = DIRS[dir];
    if (!movement || !tank?.alive) return null;
    const tankStart = center(tank);
    const tankSpeed = Math.max(45, Number(tank.speed || tank.baseSpeed) || 90);
    const turnDelay = dir === tank.dir ? Math.max(0, Number(tank.turnCooldown) || 0) : turnTime(tank.dir, dir);
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
        const moveTime = Math.max(0, time - turnDelay);
        const tankTravel = Math.min(TILE * 2, tankSpeed * moveTime);
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

  function formationSeparationDirection(ctx, tank, target) {
    const tankCenter = center(tank);
    const friend = (ctx.friends || []).filter((ally) => ally?.alive).map((ally) => {
      const allyCenter = center(ally);
      return {
        ally,
        dx: Math.abs(allyCenter.x - tankCenter.x),
        dy: Math.abs(allyCenter.y - tankCenter.y),
        distance: manhattan(tank, ally),
      };
    }).filter((item) => item.distance <= TILE * 3.5 && (item.dx < 30 || item.dy < 30))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!friend) return null;
    const friendTarget = friend.ally.attackTarget?.alive ? friend.ally.attackTarget : null;
    const urgency = (owner, assigned) => assigned
      ? manhattan(assigned, ctx.base) * 0.7 + manhattan(owner, assigned) * 0.3
      : Infinity;
    const mine = urgency(tank, target);
    const theirs = urgency(friend.ally, friendTarget);
    if (!Number.isFinite(mine) && !Number.isFinite(theirs) && tank.kind === "player") return null;
    if (mine + TILE < theirs) return null;
    if (Math.abs(mine - theirs) <= TILE && tank.kind === "player") return null;
    const candidates = [];
    if (friend.dx < 30) candidates.push("left", "right");
    if (friend.dy < 30) candidates.push("up", "down");
    return [...new Set(candidates)].filter((dir) => ctx.canMove?.(dir)).map((dir) => {
      const d = DIRS[dir];
      const next = { ...tank, x: tank.x + d.x * TILE, y: tank.y + d.y * TILE };
      return {
        dir,
        score: projectileRisk(ctx, next) * 4
          + (target ? manhattan(next, target) * 0.12 : 0)
          - manhattan(next, friend.ally) * 0.8,
      };
    }).sort((a, b) => a.score - b.score)[0]?.dir || null;
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
    return (ctx.bonuses || []).filter((bonus) => !bonus.dead && bonus.type === "freeze" && manhattan(tank, bonus) <= TILE * 5).sort((a, b) => manhattan(tank, a) - manhattan(tank, b))[0] || null;
  }

  function freezePath(ctx, tank, freeze) {
    const freezeCell = cellOf(freeze);
    const pathCtx = { ...ctx, aiAvoidCell: null };
    const direct = findPath(pathCtx, cellOf(tank), [freezeCell]);
    if (direct.length) return direct;
    const entrances = DIR_NAMES.map((dir) => ({
      x: freezeCell.x + DIRS[dir].x,
      y: freezeCell.y + DIRS[dir].y,
    })).filter((cell) => tileCost(pathCtx, cell.x, cell.y) === 1);
    return findPath(pathCtx, cellOf(tank), entrances);
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

  function movementTouchesBonus(tank, dir, bonus, horizon = 0.55) {
    const movement = DIRS[dir];
    if (!movement || !bonus || bonus.dead) return false;
    const start = center(tank);
    const target = center(bonus);
    const speed = Math.max(45, Number(tank.speed || tank.baseSpeed) || 90);
    const delay = dir === tank.dir ? Math.max(0, Number(tank.turnCooldown) || 0) : turnTime(tank.dir, dir);
    const overlapX = (Number(tank.w) || 28) / 2 + (Number(bonus.w) || 28) / 2 + 1;
    const overlapY = (Number(tank.h) || 28) / 2 + (Number(bonus.h) || 28) / 2 + 1;
    for (let time = 0.06; time <= horizon + 0.001; time += 0.06) {
      const travel = speed * Math.max(0, time - delay);
      const x = start.x + movement.x * travel;
      const y = start.y + movement.y * travel;
      if (Math.abs(x - target.x) <= overlapX && Math.abs(y - target.y) <= overlapY) return true;
    }
    return false;
  }

  function deferredFreezeAvoidDirection(ctx, tank, bonus, target, blockedDir) {
    return DIR_NAMES.filter((dir) => dir !== blockedDir && ctx.canMove?.(dir)
      && !movementTouchesBonus(tank, dir, bonus)
      && !movementBulletThreat(ctx, tank, dir, 0.7)).map((dir) => {
      const d = DIRS[dir];
      const step = Math.max(8, Math.min(16, (Number(tank.speed) || 90) * 0.14));
      const next = { ...tank, x: tank.x + d.x * step, y: tank.y + d.y * step };
      return {
        dir,
        score: projectileRisk(ctx, next) * 4
          + (target?.alive ? manhattan(next, target) * 0.1 : 0)
          + (dir === opposite(blockedDir) ? 3 : 0),
      };
    }).sort((a, b) => a.score - b.score)[0]?.dir || null;
  }

  function createCoreController(name, services) {
    let target = null;
    let mode = "core-init";
    let failures = 0;
    let alignDir = null;
    let alignUntil = 0;
    let tacticalState = "CHASE";
    let stateUntil = 0;
    let targetLockUntil = 0;
    let evadeDir = null;
    let clearCellKey = null;
    let clearStartedAt = 0;
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
    let pendingFreezeShots = [];
    const freezeBlockedTargets = new Set();
    let failedFreezeTarget = null;
    let failedFreezeCell = null;
    let failedFreezeUntil = 0;
    let freezePlanCache = null;
    let freezePlanCacheKey = "";
    let freezePlanCacheUntil = 0;
    let deferredFreeze = null;
    let deferredFreezeReadyAt = 0;
    let topSweepDir = name === "1P" ? "right" : "left";
    let baseSafeSince = null;
    let baseSafetyStage = 0;
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
    let stableRouteAllowsBaseGuardClear = false;
    let blockedRouteCellKey = null;
    let blockedRouteHits = 0;
    let lastMoveDir = null;
    let stuckBlockedDir = null;
    let stuckEscapeUntil = 0;
    let targetStuckCount = 0;
    let targetReleaseRequested = false;
    let releasedTarget = null;
    let releasedTargetUntil = 0;
    let breakthroughCommitTarget = null;
    let wasFrozen = false;
    const recordedShieldBullets = new WeakSet();

    function setTarget(next, lockUntil = null, force = false) {
      const changed = target !== next;
      if (changed && target?.alive && !force && !targetReleaseRequested) return false;
      if (changed) {
        target = next;
        targetStuckCount = 0;
        targetReleaseRequested = false;
        alignDir = null;
        alignUntil = 0;
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
        stableRouteTarget = null;
        stableRoute = [];
        stableRouteUntil = 0;
        stableRouteAllowsBaseGuardClear = false;
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
      failedFreezeTarget = null;
      failedFreezeCell = null;
      failedFreezeUntil = 0;
      freezePlanCache = null;
      freezePlanCacheKey = "";
      freezePlanCacheUntil = 0;
      freezeBurstTarget = null;
      freezeBurstShots = 0;
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
      targetLockUntil = 0;
      closeLockUntil = 0;
      tacticalState = "CHASE";
      stateUntil = now;
      setTarget(null, null, true);
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
        contactAimUntil = now + turnTime(tank.dir, fresh.shot) + (fresh.baseIntruder ? 0.34 : 0.24);
        contactMoveDir = null;
        contactMoveUntil = 0;
        return { ...fresh, aimOnly: false };
      }
      contactAimDir = null;
      contactAimUntil = 0;
      if (contactMoveDir && now < contactMoveUntil && ctx.canMove?.(contactMoveDir)) {
        return { ...fresh, shot: null, approach: contactMoveDir, aimOnly: false, committedMove: true };
      }
      contactMoveDir = fresh.approach;
      contactMoveUntil = fresh.approach
        ? now + (fresh.baseIntruder ? 0.22 : (ctx.freezeTime || 0) > 0 ? 0.42 : 0.3)
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

    function shouldSwitchTarget(ctx, tank, next, now) {
      if (!next?.alive || next === target) return false;
      const visible = visibleEnemies(ctx);
      if (!target?.alive || !visible.includes(target)) return true;
      const reserved = new Set((ctx.reservedTargets || []).filter((enemy) => enemy?.alive));
      const friendTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
      const duplicate = (reserved.has(target) || friendTargets.has(target))
        && manhattan(tank, target) > TILE * 2.2;
      if (!targetReleaseRequested && !duplicate) return false;
      if (duplicate && visible.length > 1) return true;
      const currentPriority = targetPriority(ctx, tank, target);
      const nextPriority = targetPriority(ctx, tank, next);
      const currentContact = currentPriority.tankDistance <= TILE * 2.2;
      const nextContact = nextPriority.tankDistance <= TILE * 2.2;
      if (nextPriority.directBaseShot && !currentPriority.directBaseShot) return true;
      if (nextPriority.directBaseShot && currentPriority.directBaseShot
        && nextPriority.directBaseShot.eta + 0.25 < currentPriority.directBaseShot.eta) return true;
      if (nextContact && !currentContact) return true;
      if (nextPriority.crossed && !currentPriority.crossed) return true;
      if (nextPriority.crossed && currentPriority.crossed
        && nextPriority.baseDistance + TILE * 1.25 < currentPriority.baseDistance) return true;
      if (nextPriority.tier < currentPriority.tier
        && (nextPriority.tier === 0 || now >= targetLockUntil)) return true;
      if (nextPriority.tier === 0 && currentPriority.tier === 0
        && (nextPriority.baseEta + 1.8 < currentPriority.baseEta
          || nextPriority.baseDistance + TILE * 4 < currentPriority.baseDistance)) return true;
      if (now < targetLockUntil) return false;
      if (nextPriority.tier !== currentPriority.tier) return false;
      if (nextPriority.tier === 0) {
        return nextPriority.baseEta + 1.1 < currentPriority.baseEta
          || nextPriority.baseDistance + TILE * 2.5 < currentPriority.baseDistance;
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
        targetReleaseRequested = false;
        targetLockUntil = Math.max(targetLockUntil, now + 2.2);
        closeLockUntil = Math.max(closeLockUntil, now + 0.9);
        return true;
      }
      if (breakthroughCommitTarget?.alive) {
        if (target !== breakthroughCommitTarget) setTarget(breakthroughCommitTarget, now + 2, true);
        targetReleaseRequested = false;
        targetLockUntil = Math.max(targetLockUntil, now + 2);
        closeLockUntil = Math.max(closeLockUntil, now + 0.8);
        return true;
      }
      breakthroughCommitTarget = null;

      const targetOwner = target?.alive && crossedMidline(ctx, target)
        ? breakthroughAssignments.get(target)
        : null;
      if (targetOwner && targetOwner !== name) setTarget(null, null, true);

      const breakthrough = assignedBreakthroughTarget(ctx, tank);
      if (breakthrough) {
        breakthroughCommitTarget = breakthrough;
        breakthroughAssignments.set(breakthrough, name);
        setTarget(breakthrough, now + 2, true);
        targetReleaseRequested = false;
        releasedTarget = null;
        releasedTargetUntil = 0;
        closeLockUntil = now + 0.8;
        return true;
      }

      const centralApproach = assignedCentralApproachThreat(ctx, tank);
      if (centralApproach?.alive) {
        if (target !== centralApproach) setTarget(centralApproach, now + 1.8, true);
        targetReleaseRequested = false;
        targetLockUntil = Math.max(targetLockUntil, now + 1.8);
        closeLockUntil = Math.max(closeLockUntil, now + 0.8);
        return true;
      }

      if (target?.alive) {
        targetReleaseRequested = false;
        releasedTarget = null;
        releasedTargetUntil = 0;
        targetLockUntil = Math.max(targetLockUntil, now + 2);
        closeLockUntil = Math.max(closeLockUntil, now + 0.8);
        return true;
      }

      if (target) setTarget(null, null, true);
      targetReleaseRequested = false;
      releasedTarget = null;
      releasedTargetUntil = 0;

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
      if (retainTargetUntilDestroyed(ctx, tank, now)) return;
      const visible = visibleEnemies(ctx);
      const reserved = new Set((ctx.reservedTargets || []).filter((item) => item?.alive));
      const friendTargets = new Set((ctx.friends || []).map((ally) => ally?.attackTarget).filter((enemy) => enemy?.alive));
      if (now >= releasedTargetUntil || !releasedTarget?.alive) releasedTarget = null;
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
        if (!targetVisible || duplicate || targetReleaseRequested) {
          if (targetReleaseRequested) {
            releasedTarget = target;
            releasedTargetUntil = now + 2.5;
          }
          setTarget(null, null, true);
          targetLockUntil = 0;
          closeLockUntil = 0;
        } else {
          targetLockUntil = Math.max(targetLockUntil, now + 1.2);
          closeLockUntil = Math.max(closeLockUntil, now + 0.8);
          return;
        }
      }
      const assignedThreat = assignedBaseThreat(ctx, tank, target, releasedTarget);
      const assignedDirectThreat = assignedThreat && directBaseShotThreat(ctx, assignedThreat);
      if (assignedDirectThreat) {
        if (assignedThreat !== target) setTarget(assignedThreat, now + 1.8);
        else targetLockUntil = Math.max(targetLockUntil, now + 1.1);
        closeLockUntil = Math.max(closeLockUntil, now + 0.9);
        return;
      }
      const contactThreat = visible.map((enemy) => ({ enemy, distance: manhattan(tank, enemy) }))
        .filter((item) => item.distance <= TILE * 2.2)
        .sort((a, b) => a.distance - b.distance)[0]?.enemy || null;
      if (contactThreat) {
        if (contactThreat !== target && shouldSwitchTarget(ctx, tank, contactThreat, now)) {
          setTarget(contactThreat, now + 0.9);
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
          setTarget(finalThreat, now + 1.6);
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
          setTarget(immediate, now + 0.8);
          closeLockUntil = now + 0.8;
        }
        return;
      }
      const forcedTarget = ctx.forcedTarget?.alive && visible.includes(ctx.forcedTarget)
        && (!reserved.has(ctx.forcedTarget) || visible.length === 1)
        ? ctx.forcedTarget
        : null;
      if (forcedTarget && forcedTarget !== target && shouldSwitchTarget(ctx, tank, forcedTarget, now)) {
        setTarget(forcedTarget, now + 0.9);
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
        const path = findPath(ctx, tankCell, pursuitGoals(ctx, enemy));
        const cost = path.length ? path.length - 1 : 1000;
        targetRouteCosts.set(cacheKey, cost);
        if (targetRouteCosts.size > 96) targetRouteCosts.delete(targetRouteCosts.keys().next().value);
        return cost;
      };
      const candidate = chooseTarget(ctx, tank, routeCostFor);
      if (candidate?.alive && manhattan(candidate, ctx.base) <= TILE * 4 && candidate !== target
        && (!target?.alive || shouldSwitchTarget(ctx, tank, candidate, now))) {
        setTarget(candidate, now + 1.5);
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
        setTarget(candidate, now + 1.1);
      }
    }

    function stablePath(ctx, tank, goals, now, allowBaseGuardClear = false) {
      const current = cellOf(tank);
      const mapVersion = Number(ctx.mapVersion || 0);
      const cachedRouteValid = stableRoute.every((cell, index) =>
        index === 0 || Number.isFinite(tileCost(ctx, cell.x, cell.y, allowBaseGuardClear)));
      const cachedIndex = stableRoute.findIndex((cell) => cell.x === current.x && cell.y === current.y);
      const cachedTail = stableRouteTarget === target && stableRouteMapVersion === mapVersion
        && stableRouteAllowsBaseGuardClear === allowBaseGuardClear && cachedRouteValid && cachedIndex >= 0
        ? stableRoute.slice(cachedIndex)
        : [];
      if (stableRouteTarget === target && stableRouteMapVersion === mapVersion
        && stableRouteAllowsBaseGuardClear === allowBaseGuardClear && now < stableRouteUntil && cachedRouteValid) {
        if (cachedTail.length) return cachedTail;
      }
      stableRouteTarget = target;
      stableRouteMapVersion = mapVersion;
      stableRouteAllowsBaseGuardClear = allowBaseGuardClear;
      stableRouteUntil = now + (target && manhattan(tank, target) <= TILE * 6 ? 0.22 : 0.32);
      const replannedRoute = findPath(ctx, current, goals, allowBaseGuardClear);
      stableRoute = replannedRoute.length ? replannedRoute : cachedTail;
      if (!replannedRoute.length && cachedTail.length > 1) stableRouteUntil = now + 0.12;
      return stableRoute;
    }

    function decideRaw(ctx, dt = 0) {
      try {
        const tank = ctx?.tank;
        if (!tank?.alive) return { fire: false, hold: false, mode: "core-idle", target: null };
        const now = ctx.gameTime || 0;
        lastDecisionTime = now;
        if (avoidBrick && now < avoidBrick.until) ctx.aiAvoidCell = avoidBrick;
        else avoidBrick = null;
        const freezeRemaining = Math.max(0, Number(ctx.freezeTime) || 0);
        if (wasFrozen && freezeRemaining <= 0) resetFreezeCombatState(now);
        wasFrozen = freezeRemaining > 0;
        selectStableTarget(ctx, tank, now);
        const nearbyFreezeBonus = nearbyFreeze(ctx, tank);
        if (deferredFreeze?.dead || !(ctx.bonuses || []).includes(deferredFreeze)) {
          deferredFreeze = null;
          deferredFreezeReadyAt = 0;
        }
        if (freezeRemaining > 0 && nearbyFreezeBonus) {
          if (deferredFreeze !== nearbyFreezeBonus) {
            deferredFreeze = nearbyFreezeBonus;
            freezePlanCache = null;
            freezePlanCacheKey = "";
            freezePlanCacheUntil = 0;
            stableRouteTarget = null;
            stableRoute = [];
            stableRouteUntil = 0;
          }
          deferredFreezeReadyAt = Math.max(deferredFreezeReadyAt, now + freezeRemaining);
        }
        if (freezeRemaining > 0 && deferredFreeze && !deferredFreeze.dead) {
          const avoidCell = cellOf(deferredFreeze);
          ctx.aiAvoidCell = { ...avoidCell, until: deferredFreezeReadyAt };
        }
        const freeze = freezeRemaining <= 0 && !breakthroughCommitTarget?.alive
          ? (deferredFreeze && now + 0.08 >= deferredFreezeReadyAt ? deferredFreeze : nearbyFreezeBonus)
          : null;
        if (freeze) {
          const path = freezePath(ctx, tank, freeze);
          const step = routeStep(ctx, tank, path);
          const dir = step.dir || freezeDirectDirection(ctx, tank, freeze);
          publishRoute(ctx, tank, path);
          const deferred = freeze === deferredFreeze;
          mode = step.aligning ? "core-freeze-align" : deferred ? "core-freeze-deferred" : "core-freeze";
          return { dir: dir || tank.dir, fire: false, hold: !dir, mode, target };
        }
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
        const friendlyBullet = incomingFriendlyBullet(ctx, tank);
        if (friendlyBullet) {
          const dodge = dodgeDirection(ctx, tank, friendlyBullet, target);
          mode = dodge ? "core-avoid-friendly-bullet" : "core-avoid-friendly-bullet-hold";
          return { dir: dodge || tank.dir, fire: false, hold: !dodge, mode, target };
        }
        const allyFire = incomingAllyFire(ctx, tank);
        if (allyFire) {
          const dodge = dodgeDirection(ctx, tank, allyFire, target);
          mode = dodge ? "core-avoid-ally-fire" : "core-avoid-ally-fire-hold";
          return { dir: dodge || tank.dir, fire: false, hold: !dodge, mode, target };
        }
        if ((ctx.freezeTime || 0) <= 0 && pendingFreezeShots.length) {
          pendingFreezeShots = [];
          freezeBlockedTargets.clear();
          failedFreezeTarget = null;
          failedFreezeCell = null;
          freezePlanCache = null;
          freezePlanCacheKey = "";
          freezePlanCacheUntil = 0;
        }
        if ((ctx.freezeTime || 0) > 0) {
          const freezeContact = stableContactCombatPlan(ctx, tank, now);
          if (freezeContact?.shot) {
            setTarget(freezeContact.enemy, now + 0.35);
            if (freezeContact.aimOnly) {
              mode = freezeContact.pointBlank
                ? "core-freeze-pointblank-aim"
                : freezeContact.baseIntruder ? "core-freeze-base-melee-aim" : "core-freeze-contact-commit-aim";
              return {
                dir: freezeContact.shot,
                fire: false,
                hold: tank.dir === freezeContact.shot,
                mode,
                target: freezeContact.enemy,
              };
            }
            mode = freezeContact.pointBlank
              ? "core-freeze-pointblank-fire"
              : freezeContact.baseIntruder ? "core-freeze-base-melee-fire" : "core-freeze-contact-fire";
            const mobileContact = freezeContact.distance > TILE * 3.25 && ctx.canMove?.(freezeContact.shot);
            return aimedFireAction(ctx, tank, freezeContact.shot, mode, freezeContact.enemy, mobileContact);
          }
          if (freezeContact?.baseIntruder) {
            const brickDir = routeBrickDirection(ctx, tank, freezeContact.enemy);
            if (brickDir) {
              mode = "core-freeze-base-melee-clear";
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
            setTarget(freezeContact.enemy, now + 0.35);
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
            if (tank.dir !== cover.dir || (tank.turnCooldown || 0) > 0) {
              mode = "core-freeze-cover-aim";
              return { dir: cover.dir, fire: false, hold: false, mode, target: cover.enemy };
            }
            const ready = Boolean(ctx.canFire?.());
            mode = ready ? "core-freeze-cover-fire" : "core-freeze-cover-reload";
            return { dir: cover.dir, fire: ready, hold: true, mode, target: cover.enemy };
          }
          const dueShots = pendingFreezeShots.filter((item) => now >= item.verifyAt);
          for (const pending of dueShots) {
            if (pending.target?.alive && Number(pending.target.hp) >= pending.hpBefore) {
              failedFreezeTarget = pending.target;
              failedFreezeCell = pending.cell;
              failedFreezeUntil = now + 0.55;
              if (pending.target !== target) freezeBlockedTargets.add(pending.target);
            }
          }
          pendingFreezeShots = pendingFreezeShots.filter((item) => now < item.verifyAt && item.target?.alive).slice(-12);
          for (const pending of dueShots) {
            if (pending.target !== failedFreezeTarget && !pendingFreezeShots.some((item) => item.target === pending.target)) {
              freezeBlockedTargets.delete(pending.target);
            }
          }
          if (now >= failedFreezeUntil) {
            if (failedFreezeTarget) freezeBlockedTargets.delete(failedFreezeTarget);
            failedFreezeTarget = null;
            failedFreezeCell = null;
          }
          const freezeCell = cellOf(tank);
          const freezePlanKey = [
            freezeCell.x,
            freezeCell.y,
            Number(ctx.mapVersion || 0),
            Math.ceil(Number(ctx.freezeTime || 0) * 5),
            freezeBlockedTargets.size,
            failedFreezeCell?.x ?? -1,
            failedFreezeCell?.y ?? -1,
            ...visibleEnemies(ctx).flatMap((enemy) => [cellOf(enemy).x, cellOf(enemy).y, Number(enemy.hp) || 1]),
            ...(ctx.reservedTargets || []).filter((enemy) => enemy?.alive).flatMap((enemy) => [cellOf(enemy).x, cellOf(enemy).y]),
          ].join(":");
          const plan = freezePlanCacheKey === freezePlanKey && now < freezePlanCacheUntil && freezePlanCache?.enemy?.alive
            ? freezePlanCache
            : freezeAttackPlan(ctx, tank, freezeBlockedTargets, failedFreezeTarget, failedFreezeCell, target);
          if (freezePlanCacheKey !== freezePlanKey || now >= freezePlanCacheUntil) {
            freezePlanCache = plan;
            freezePlanCacheKey = freezePlanKey;
            freezePlanCacheUntil = now + 0.16;
          }
          if (plan) {
            setTarget(plan.enemy, now + 0.6);
            if (freezeBurstTarget !== plan.enemy) {
              freezeBurstTarget = plan.enemy;
              freezeBurstShots = 0;
            }
            if (plan.shot) {
              const aimSettled = tank.dir === plan.shot && (tank.turnCooldown || 0) <= 0;
              if (!aimSettled) {
                mode = "core-freeze-aim";
                return { dir: plan.shot, fire: false, hold: false, mode, target: plan.enemy };
              }
              const shotReady = Boolean(ctx.canFire?.());
              if (!shotReady) {
                mode = "core-freeze-aim";
                return { dir: plan.shot, fire: false, hold: true, mode, target: plan.enemy };
              }
              if (shotReady) {
                freezeBurstShots++;
                pendingFreezeShots.push({
                  target: plan.enemy,
                  hpBefore: Number(plan.enemy.hp) || 1,
                  cell: cellOf(tank),
                  verifyAt: now + Math.max(0.18, manhattan(tank, plan.enemy) / 310 + 0.12),
                });
              }
              const burstSize = plan.enemy.kind === "armor" ? 2 : 1;
              if (shotReady && freezeBurstShots >= burstSize) {
                if (plan.enemy !== target) freezeBlockedTargets.add(plan.enemy);
                freezeBurstTarget = null;
                freezeBurstShots = 0;
              }
              mode = "core-freeze-direct-fire";
              return aimedFireAction(ctx, tank, plan.shot, mode, plan.enemy, true);
            }
            publishRoute(ctx, tank, plan.path);
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
          const pursuit = freezePursuitPlan(ctx, tank, target);
          if (pursuit) {
            setTarget(pursuit.enemy, now + 0.45);
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
          setTarget(contactPlan.enemy, now + 0.45);
          closeLockUntil = now + 0.45;
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          const fastLastLine = isFastLastLine(ctx, contactPlan.enemy);
          if (contactPlan.aimOnly) {
            mode = fastLastLine
              ? "core-contact-fast-lastline-aim"
              : contactPlan.baseIntruder ? "core-base-melee-aim" : "core-contact-commit-aim";
            return {
              dir: contactPlan.shot,
              fire: false,
              hold: tank.dir === contactPlan.shot,
              mode,
              target: contactPlan.enemy,
            };
          }
          mode = fastLastLine
            ? "core-contact-fast-lastline-fire"
            : contactPlan.baseIntruder
            ? "core-base-melee-fire"
            : contactPlan.predicted ? "core-contact-predict-fire" : "core-contact-fire";
          return aimedFireAction(ctx, tank, contactPlan.shot, mode, contactPlan.enemy);
        }
        if (contactPlan?.baseIntruder) {
          const brickDir = routeBrickDirection(ctx, tank, contactPlan.enemy);
          if (brickDir) {
            mode = isFastLastLine(ctx, contactPlan.enemy)
              ? "core-contact-fast-lastline-clear"
              : "core-base-melee-clear";
            return aimedFireAction(ctx, tank, brickDir, mode, contactPlan.enemy);
          }
        }
        if (contactPlan?.approach) {
          setTarget(contactPlan.enemy, now + 0.45);
          closeLockUntil = now + 0.45;
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          mode = isFastLastLine(ctx, contactPlan.enemy)
            ? "core-contact-fast-lastline-approach"
            : contactPlan.baseIntruder ? "core-base-melee-approach" : "core-contact-approach";
          return { dir: contactPlan.approach, fire: false, hold: false, mode, target: contactPlan.enemy };
        }
        const rearRole = rearScreenRole(ctx, tank);
        const rearThreat = rearRole ? rearBreakthroughTarget(ctx, tank) : null;
        if (rearThreat && (rearThreat === target || shouldSwitchTarget(ctx, tank, rearThreat, now))) {
          setTarget(rearThreat, now + 0.9);
        }
        const closeOpportunity = closeRangeShot(ctx, tank, target);
        if (closeOpportunity && closeOpportunity.enemy !== target
          && shouldSwitchTarget(ctx, tank, closeOpportunity.enemy, now)) {
          setTarget(closeOpportunity.enemy, now + 0.65);
          closeLockUntil = now + 0.65;
        }
        const topRole = topSuppressor(ctx, tank);
        const currentStage = Math.max(1, Number(ctx.stage) || 1);
        if (baseSafetyStage !== currentStage) {
          baseSafetyStage = currentStage;
          baseSafeSince = null;
        }
        const advanceThreats = advanceSafetyThreats(ctx);
        const assignedSafetyThreat = assignedAdvanceSafetyThreat(ctx, tank, advanceThreats);
        const baseAdvanceSafe = advanceThreats.length === 0;
        if (!baseAdvanceSafe) {
          baseSafeSince = null;
          if (!breakthroughCommitTarget?.alive && assignedSafetyThreat?.alive && target !== assignedSafetyThreat) {
            setTarget(assignedSafetyThreat, now + 1.2, true);
            closeLockUntil = Math.max(closeLockUntil, now + 0.65);
          }
        } else if (topRole && baseSafeSince === null) {
          baseSafeSince = now;
        }
        const baseEmergency = target && isBaseEmergency(ctx, target);
        const fastLastLine = target && isFastLastLine(ctx, target);
        const exactShot = target && currentPositionShot(ctx, tank, target);
        const shot = exactShot || (target && directShot(ctx, tank, target));
        const predictedShot = target && !shot ? predictiveShot(ctx, tank, target) : null;
        const closeTarget = target && manhattan(tank, target) <= TILE * 4.5;
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
        if (!closeTarget && !baseEmergency && !incomingBullet(ctx, tank)) {
          const separate = formationSeparationDirection(ctx, tank, target);
          if (separate) {
            mode = "core-formation-separate";
            return { dir: separate, fire: false, hold: false, mode, target };
          }
        }
        if (baseEmergency && emergencyAim?.dir) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.45;
          if (emergencyAim.aimOnly) {
            mode = fastLastLine ? "core-contact-fast-lastline-aim" : "core-base-contact-commit-aim";
            return {
              dir: emergencyAim.dir,
              fire: false,
              hold: tank.dir === emergencyAim.dir,
              mode,
              target,
            };
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
        if (shot && shot === tank.dir && (ctx.canFire?.() || !incoming)) {
          tacticalState = "ENGAGE";
          stateUntil = now + 0.35;
          mode = ctx.canFire?.() ? "core-attack-fire" : "core-aim-wait";
          return aimedFireAction(ctx, tank, shot, mode, target);
        }
        if (incoming) {
          const shooter = bullet?.owner?.alive ? bullet.owner : muzzleThreat;
          const counterWindow = bullet
            ? manhattan(tank, bullet) <= TILE * 3.4
            : shooter && manhattan(tank, shooter) <= TILE * 3.5;
          const counterDir = shooter && counterWindow
            ? directShot(ctx, tank, shooter)
            : null;
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
        } else if (tacticalState === "EVADE") {
          stateUntil = now;
          evadeDir = null;
        }
        if (!target?.alive && rearRole && !rearThreat) {
          setTarget(null);
          const screenPath = rearScreenPath(ctx, tank);
          publishRoute(ctx, tank, screenPath);
          const screenStep = routeStep(ctx, tank, screenPath);
          if (screenStep.dir && !screenStep.aligning) {
            const next = screenPath[1];
            const nextTile = ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x];
            if (nextTile === "B") {
              mode = "core-rear-screen-clear";
              return { dir: screenStep.dir, fire: Boolean(ctx.canFire?.()), hold: true, mode, target: null };
            }
          }
          if (screenStep.dir) {
            mode = screenStep.aligning ? "core-rear-screen-align" : "core-rear-screen-route";
            return { dir: screenStep.dir, fire: false, hold: false, mode, target: null };
          }
          mode = "core-rear-screen-hold";
          return { dir: tank.dir, fire: false, hold: true, mode, target: null };
        }
        const middleBandY = center(tank).y;
        const outsideMiddleBand = middleBandY < TILE * 9.5 || middleBandY > TILE * 15;
        if (!breakthroughCommitTarget?.alive && !topRole && outsideMiddleBand
          && (!assignedSafetyThreat?.alive || assignedSafetyThreat !== target)) {
          const screenPath = rearScreenPath(ctx, tank);
          publishRoute(ctx, tank, screenPath);
          const screenStep = routeStep(ctx, tank, screenPath);
          if (screenStep.dir && !screenStep.aligning) {
            const next = screenPath[1];
            const nextTile = ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x];
            if (nextTile === "B") {
              mode = "core-middle-screen-clear";
              return aimedFireAction(ctx, tank, screenStep.dir, mode, target);
            }
          }
          if (screenStep.dir) {
            mode = screenStep.aligning ? "core-middle-screen-align" : "core-middle-screen-route";
            return { dir: screenStep.dir, fire: false, hold: false, mode, target };
          }
          mode = "core-middle-screen-hold";
          return { dir: tank.dir, fire: false, hold: true, mode, target };
        }
        if (!breakthroughCommitTarget?.alive && topRole && baseAdvanceSafe) {
          const suppressionShot = topSuppressionShot(ctx, tank);
          if (suppressionShot) {
            setTarget(suppressionShot.enemy, now + 0.35);
            mode = suppressionShot.predicted ? "core-top-suppress-predict" : "core-top-suppress-fire";
            return aimedFireAction(ctx, tank, suppressionShot.dir, mode, suppressionShot.enemy);
          }
          const currentCell = cellOf(tank);
          if (currentCell.x <= 1) topSweepDir = "right";
          if (currentCell.x >= ctx.cols - 2) topSweepDir = "left";
          const safeDuration = Math.max(0, now - Number(baseSafeSince ?? now));
          const advanceRow = safeDuration < 2.5 ? 10 : safeDuration < 6 ? 8 : 6;
          let sweepGoal = { x: topSweepDir === "left" ? 1 : ctx.cols - 2, y: Math.max(1, Math.min(advanceRow, currentCell.y)) };
          let sweepPath = findPath(ctx, currentCell, [sweepGoal]);
          if (!sweepPath.length) {
            topSweepDir = topSweepDir === "left" ? "right" : "left";
            sweepGoal = { x: topSweepDir === "left" ? 1 : ctx.cols - 2, y: Math.max(1, Math.min(advanceRow, currentCell.y)) };
            sweepPath = findPath(ctx, currentCell, [sweepGoal]);
          }
          publishRoute(ctx, tank, sweepPath);
          const sweepStep = routeStep(ctx, tank, sweepPath);
          if (sweepStep.dir && !sweepStep.aligning) {
            const next = sweepPath[1];
            const nextTile = ctx.tileAt?.(next.x, next.y) ?? ctx.map?.[next.y]?.[next.x];
            if (nextTile === "B") {
              mode = "core-top-suppress-clear";
              return aimedFireAction(ctx, tank, sweepStep.dir, mode, target);
            }
          }
          if (sweepStep.dir) {
            mode = sweepStep.aligning ? "core-top-suppress-align" : "core-top-suppress-sweep";
            return { dir: sweepStep.dir, fire: false, hold: false, mode, target };
          }
          mode = "core-top-suppress-hold";
          return { dir: tank.dir, fire: false, hold: true, mode, target };
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
        const nextState = closeCombat ? "ENGAGE" : "CHASE";
        if (tacticalState !== nextState && now >= stateUntil) {
          tacticalState = nextState;
          stateUntil = now + 0.45;
        }
        const interceptEligible = !isBaseIntruder(ctx, target) && !closeCombat;
        if (!interceptEligible) {
          interceptTarget = null;
          interceptPlan = null;
          interceptPlanUntil = now;
        } else if (interceptTarget !== target || now >= interceptPlanUntil || interceptPlanMapVersion !== Number(ctx.mapVersion || 0)) {
          interceptTarget = target;
          const freshIntercept = buildInterceptPlan(ctx, tank, target);
          interceptPlan = freshIntercept ? { ...freshIntercept, createdAt: now } : null;
          interceptPlanMapVersion = Number(ctx.mapVersion || 0);
          if (freshIntercept?.path?.length) {
            stableRouteTarget = target;
            stableRouteMapVersion = Number(ctx.mapVersion || 0);
            stableRouteAllowsBaseGuardClear = false;
            stableRoute = freshIntercept.path;
            stableRouteUntil = now + 0.42;
          }
          interceptPlanUntil = now + 0.42;
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
        const firingGoals = attackGoals(ctx, target);
        const pursuit = pursuitGoals(ctx, target);
        const emergencyFlanks = baseEmergency ? baseEmergencyFlankGoals(ctx, target) : [];
        const goals = interceptPlan && !closeCombat
          ? [interceptPlan.cell]
          : baseEmergency && emergencyFlanks.length
            ? [...emergencyFlanks, ...closeCombatGoals(ctx, tank, target), ...pursuit]
          : closeCombat
          ? [...closeCombatGoals(ctx, tank, target), ...pursuit]
          : [...firingGoals, ...pursuit];
        const path = stablePath(ctx, tank, goals, now, false);
        publishRoute(ctx, tank, path);
        const step = routeStep(ctx, tank, path, baseEmergency ? 4 : 1.5);
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
            clearStartedAt = now;
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
          const detourPath = findPath(ctx, cellOf(tank), goals, false);
          const detourStep = routeStep(ctx, tank, detourPath, baseEmergency ? 4 : 1.5);
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
          ? "core-intercept-route"
          : (ctx.freezeTime || 0) > 0 ? "core-freeze-assault" : tacticalState === "ENGAGE" ? "core-engage" : "core-chase";
        return { dir, fire: false, hold: false, mode, target };
      } catch (error) {
        failures++;
        mode = "core-error-replan";
        return { dir: ctx?.tank?.dir, fire: false, hold: true, mode, target };
      }
    }

    function decide(ctx, dt = 0) {
      let action = decideRaw(ctx, dt);
      if (action?.fire && ctx?.tank?.alive && action.dir) {
        const obstacle = firstShotObstacle(ctx, ctx.tank, action.dir, action.target);
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
      const tacticalCorrection = /align|recover|blocked|detour|dodge|evade|avoid|escape/.test(action?.mode || "");
      const urgentMove = action?.target?.alive
        && isBaseEmergency(ctx, action.target)
        && action.dir
        && !action.fire
        && !action.hold
        && action.mode !== "core-freeze"
        && action.mode !== "core-freeze-align"
        && !tacticalCorrection;
      if (urgentMove) {
        const currentDistance = manhattan(ctx.tank, action.target);
        const committedDistance = projectedTargetDistance(ctx.tank, action.target, emergencyMoveDir);
        const freshDistance = projectedTargetDistance(ctx.tank, action.target, action.dir);
        const committedMovesAway = committedDistance > currentDistance + 2
          && committedDistance > freshDistance + 2;
        if (emergencyMoveTarget === action.target
          && emergencyMoveDir
          && now < emergencyMoveUntil
          && emergencyMoveDir !== action.dir
          && !committedMovesAway
          && ctx.canMove?.(emergencyMoveDir)) {
          mode = "core-base-move-commit";
          action = { ...action, dir: emergencyMoveDir, mode };
        } else {
          emergencyMoveTarget = action.target;
          emergencyMoveDir = action.dir;
          emergencyMoveUntil = now + 0.36;
        }
      } else if (action?.fire || !action?.target?.alive || !isBaseEmergency(ctx, action.target)) {
        emergencyMoveTarget = null;
        emergencyMoveDir = null;
        emergencyMoveUntil = 0;
      }
      const moving = action?.dir && !action.hold;
      const protectedCounter = action?.mode === "core-base-shield-fire" || action?.mode === "core-counter-fire";
      const crossingThreat = moving && !protectedCounter
        ? movementBulletThreat(ctx, ctx?.tank, action.dir, 0.9)
        : null;
      if (crossingThreat) {
        const dodge = dodgeDirection(ctx, ctx.tank, crossingThreat.bullet, action.target);
        mode = dodge ? "core-predictive-bullet-dodge" : "core-predictive-bullet-hold";
        action = {
          ...action,
          dir: dodge || ctx.tank.dir,
          fire: false,
          hold: !dodge,
          mode,
        };
        emergencyMoveDir = null;
        emergencyMoveUntil = 0;
      }
      const deferringFreeze = Number(ctx?.freezeTime) > 0 && deferredFreeze && !deferredFreeze.dead;
      if (deferringFreeze && action?.dir && !action.hold
        && movementTouchesBonus(ctx.tank, action.dir, deferredFreeze)) {
        const avoid = deferredFreezeAvoidDirection(ctx, ctx.tank, deferredFreeze, action.target, action.dir);
        mode = avoid ? "core-freeze-deferred-avoid" : "core-freeze-deferred-wait";
        action = {
          ...action,
          dir: avoid || ctx.tank.dir,
          fire: false,
          hold: !avoid,
          mode,
        };
        emergencyMoveDir = null;
        emergencyMoveUntil = 0;
      }
      if (action?.dir && !action.hold) lastMoveDir = action.dir;
      return action;
    }

    return {
      name,
      decide,
      learn(event, amount = 1) {
          if (event === "stuck") {
            targetStuckCount++;
            if (targetStuckCount >= 3) targetReleaseRequested = true;
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
      snapshot: () => ({ name, engine: "AI-CORE", mode, failures, target: target?.kind || null }),
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
