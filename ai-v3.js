// Independent tactical controller. The game remains the authority for movement and shot safety.
(function () {
  const SIZE = 32;
  const baseFieldCache = new WeakMap();
  const teamPlans = new WeakMap();
  const lastSeenByMap = new WeakMap();
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const ORDER = ["up", "left", "right", "down"];
  const center = t => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
  const cell = t => ({ x: Math.floor((t.x + t.w / 2) / SIZE), y: Math.floor((t.y + t.h / 2) / SIZE) });
  const key = p => `${p.x},${p.y}`;
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const tile = (ctx, x, y) => ctx.map?.[y]?.[x] || "S";
  const guard = (ctx, x, y) => {
    const b = ctx.baseGuard;
    const core = Boolean(b && x * SIZE < b.x + b.w && (x + 1) * SIZE > b.x
      && y * SIZE < b.y + b.h && (y + 1) * SIZE > b.y);
    const baseX = Math.floor(ctx.base.x / SIZE), baseY = Math.floor(ctx.base.y / SIZE);
    const baseRight = Math.ceil((ctx.base.x + ctx.base.w) / SIZE) - 1;
    return core || (y >= baseY - 4 && y < baseY
      && x >= baseX - 4 && x <= baseRight + 4);
  };
  const passCost = (ctx, x, y) => {
    if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) return Infinity;
    const t = tile(ctx, x, y);
    if (t === "S" || t === "W" || t === "E") return Infinity;
    if (t === "B") return guard(ctx, x, y) ? Infinity : 5.5;
    return 1;
  };
  const hidden = (ctx, enemy) => {
    const a = Math.floor(enemy.x / SIZE), b = Math.floor((enemy.x + enemy.w - 1) / SIZE);
    const c = Math.floor(enemy.y / SIZE), d = Math.floor((enemy.y + enemy.h - 1) / SIZE);
    for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) if (tile(ctx, x, y) === "F") return true;
    return false;
  };
  function field(ctx, start) {
    const cost = Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(Infinity));
    const previous = new Map();
    const queue = [{ ...start, cost: 0 }];
    cost[start.y][start.x] = 0;
    while (queue.length) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].cost < queue[best].cost) best = i;
      const current = queue.splice(best, 1)[0];
      if (current.cost !== cost[current.y][current.x]) continue;
      for (const dir of ORDER) {
        const [dx, dy] = DIRS[dir];
        const x = current.x + dx, y = current.y + dy;
        const step = passCost(ctx, x, y);
        if (!Number.isFinite(step)) continue;
        const value = current.cost + step;
        if (value >= cost[y][x]) continue;
        cost[y][x] = value;
        previous.set(key({ x, y }), { x: current.x, y: current.y });
        queue.push({ x, y, cost: value });
      }
    }
    return { cost, previous, start };
  }
  function route(fieldResult, goal) {
    if (!Number.isFinite(fieldResult.cost[goal.y]?.[goal.x])) return [];
    const result = [goal];
    for (let i = 0; i < 900 && key(result[0]) !== key(fieldResult.start); i++) {
      const prev = fieldResult.previous.get(key(result[0]));
      if (!prev) return [];
      result.unshift(prev);
    }
    return key(result[0]) === key(fieldResult.start) ? result : [];
  }
  function turnRoute(ctx, tank, goal) {
    const start = cell(tank);
    if (start.x === goal.x && start.y === goal.y) return [start];
    if (!Number.isFinite(passCost(ctx, goal.x, goal.y))) return [];
    const headings = ["up", "right", "down", "left"];
    const index = (x, y, heading) => ((y * ctx.cols + x) * 4 + heading);
    const startHeading = Math.max(0, headings.indexOf(tank.dir));
    const origin = index(start.x, start.y, startHeading);
    const cost = new Float64Array(ctx.cols * ctx.rows * 4).fill(Infinity);
    const previous = new Int32Array(cost.length).fill(-1);
    const heap = [];
    const push = item => {
      heap.push(item);
      for (let i = heap.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (heap[parent].score <= heap[i].score) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const pop = () => {
      const first = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0;;) {
          const left = i * 2 + 1, right = left + 1;
          if (left >= heap.length) break;
          const child = right < heap.length && heap[right].score < heap[left].score ? right : left;
          if (heap[i].score <= heap[child].score) break;
          [heap[i], heap[child]] = [heap[child], heap[i]];
          i = child;
        }
      }
      return first;
    };
    const heuristic = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
    const turnCost = Math.min(105, tank.speed || 105) * 0.3 / SIZE;
    cost[origin] = 0;
    push({ state: origin, x: start.x, y: start.y, heading: startHeading,
      cost: 0, score: heuristic(start.x, start.y) });
    while (heap.length) {
      const current = pop();
      if (current.cost !== cost[current.state]) continue;
      if (current.x === goal.x && current.y === goal.y) {
        const result = [];
        for (let state = current.state; state >= 0; state = previous[state]) {
          const cellIndex = Math.floor(state / 4);
          result.push({ x: cellIndex % ctx.cols, y: Math.floor(cellIndex / ctx.cols) });
        }
        return result.reverse();
      }
      for (let heading = 0; heading < 4; heading++) {
        const [dx, dy] = DIRS[headings[heading]];
        const x = current.x + dx, y = current.y + dy;
        const terrainCost = passCost(ctx, x, y);
        if (!Number.isFinite(terrainCost)) continue;
        const difference = Math.abs(heading - current.heading);
        const turns = Math.min(difference, 4 - difference);
        const wait = current.state === origin && turns ?
          Math.max(0, tank.turnCooldown || 0) * Math.min(105, tank.speed || 105) / SIZE : 0;
        const nextCost = current.cost + terrainCost + turns * turnCost + wait;
        const state = index(x, y, heading);
        if (nextCost >= cost[state]) continue;
        cost[state] = nextCost;
        previous[state] = current.state;
        push({ state, x, y, heading, cost: nextCost, score: nextCost + heuristic(x, y) });
      }
    }
    return [];
  }
  function firstObstacle(ctx, from, to) {
    const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
    if (dx && dy) return "diagonal";
    if (!dx && !dy) return null;
    for (let x = from.x + dx, y = from.y + dy; x !== to.x || y !== to.y; x += dx, y += dy) {
      const t = tile(ctx, x, y);
      if (t === "S" || t === "E" || t === "B") return t;
    }
    return null;
  }
  function shotGoals(ctx, enemy, travel) {
    const e = cell(enemy);
    const goals = [];
    for (const dir of ORDER) {
      const [dx, dy] = DIRS[dir];
      for (let n = 1; n <= 11; n++) {
        const x = e.x + dx * n, y = e.y + dy * n;
        if (!Number.isFinite(passCost(ctx, x, y))) break;
        if (firstObstacle(ctx, { x, y }, e)) break;
        const cost = travel.cost[y][x];
        if (!Number.isFinite(cost)) continue;
        const own = center({ x: x * SIZE + 2, y: y * SIZE + 2, w: 28, h: 28 });
        const base = center(ctx.base);
        // Nearby base shots are valuable, but don't park in front of the eagle.
        const baseRisk = distance(own, base) < SIZE * 2.5 ? 2 : 0;
        const overextend = e.y < ctx.rows * 0.5 ? Math.max(0, ctx.rows * 0.58 - y) * 3 : 0;
        goals.push({ x, y, cost: cost + n * 0.1 + baseRisk + overextend, shotDir: ORDER.find(d =>
          x + DIRS[d][0] * n === e.x && y + DIRS[d][1] * n === e.y) });
      }
    }
    return goals.sort((a, b) => a.cost - b.cost);
  }
  function interceptPosition(ctx, enemy) {
    const p = cell(enemy);
    if (p.y >= ctx.rows * 0.57) return null;
    let x = p.x, y = p.y;
    const stop = Math.min(ctx.rows - 5, Math.max(13, p.y + 7));
    for (let i = 0; i < 14 && y < stop; i++) {
      const below = tile(ctx, x, y + 1);
      if (below !== "S" && below !== "W" && below !== "E") { y++; continue; }
      const toward = x < 12 ? 1 : -1;
      if (passCost(ctx, x + toward, y) < Infinity) x += toward;
      else if (passCost(ctx, x - toward, y) < Infinity) x -= toward;
      else break;
    }
    return y > p.y + 2 ? { x: x * SIZE + 2, y: y * SIZE + 2, w: enemy.w, h: enemy.h } : null;
  }
  function baseField(ctx) {
    const cached = baseFieldCache.get(ctx.map);
    if (cached && cached.version === ctx.mapVersion) return cached.cost;
    const cost = Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(Infinity));
    const queue = [];
    const x0 = Math.floor(ctx.base.x / SIZE), y0 = Math.floor(ctx.base.y / SIZE);
    const x1 = Math.ceil((ctx.base.x + ctx.base.w) / SIZE) - 1;
    const y1 = Math.ceil((ctx.base.y + ctx.base.h) / SIZE) - 1;
    const seedRay = (x, y, dx, dy) => {
      let bricks = 0;
      for (let steps = 1; x >= 0 && x < ctx.cols && y >= 0 && y < ctx.rows;
        steps++, x += dx, y += dy) {
        const terrain = tile(ctx, x, y);
        if (terrain === "S" || terrain === "E") break;
        if (terrain === "B") bricks++;
        if (terrain === "W" || terrain === "B") continue;
        const value = bricks * 2.8 + steps * 0.27;
        if (value >= cost[y][x]) continue;
        cost[y][x] = value;
        queue.push({ x, y, cost: value });
      }
    };
    for (let x = x0; x <= x1; x++) {
      seedRay(x, y0 - 1, 0, -1);
      seedRay(x, y1 + 1, 0, 1);
    }
    for (let y = y0; y <= y1; y++) {
      seedRay(x0 - 1, y, -1, 0);
      seedRay(x1 + 1, y, 1, 0);
    }
    while (queue.length) {
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].cost < queue[best].cost) best = i;
      const current = queue.splice(best, 1)[0];
      if (current.cost !== cost[current.y][current.x]) continue;
      for (const dir of ORDER) {
        const [dx, dy] = DIRS[dir];
        const x = current.x + dx, y = current.y + dy;
        if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) continue;
        const t = tile(ctx, x, y);
        if (t === "S" || t === "W" || t === "E") continue;
        const value = current.cost + (t === "B" ? 2.8 : 1);
        if (value >= cost[y][x]) continue;
        cost[y][x] = value;
        queue.push({ x, y, cost: value });
      }
    }
    baseFieldCache.set(ctx.map, { version: ctx.mapVersion, cost });
    return cost;
  }
  function baseEta(ctx, enemy) {
    const p = cell(enemy);
    const tiles = baseField(ctx)[p.y]?.[p.x];
    const estimate = Number.isFinite(tiles) ? tiles : distance(center(enemy), center(ctx.base)) / SIZE * 1.8;
    return estimate * SIZE / Math.max(45, enemy.speed || 72) + 0.5;
  }
  function threat(ctx, enemy) {
    const e = center(enemy), b = center(ctx.base);
    const direct = Math.abs(e.x - b.x) < SIZE * 0.7 || Math.abs(e.y - b.y) < SIZE * 0.7;
    const approaching = enemy.dir === "down" && e.y < b.y;
    const eta = baseEta(ctx, enemy);
    return 50 / (2 + eta) + (direct ? 2 : 0) + (approaching ? 1 : 0)
      + (enemy.kind === "fast" ? 1 : 0) + (e.y > ctx.rows * SIZE * 0.5 ? 1 : 0);
  }
  function teamAssignment(ctx) {
    const now = Number(ctx.gameTime) || 0;
    const allies = [ctx.tank, ...(ctx.friends || [])].filter(t => t?.alive)
      .sort((a, b) => Number(a.kind === "player2") - Number(b.kind === "player2"));
    const enemies = (ctx.enemies || []).filter(e => e.alive && !hidden(ctx, e));
    const prior = teamPlans.get(ctx.map);
    if (prior && prior.mapVersion === ctx.mapVersion && prior.stage === ctx.stage
      && now >= prior.at && now - prior.at < 0.18
      && prior.allies.length === allies.length && allies.every((ally, i) => ally === prior.allies[i])
      && prior.enemies.length === enemies.length && enemies.every((enemy, i) => enemy === prior.enemies[i])) {
      return prior.assignments;
    }
    const fields = allies.map(ally => field(ctx, cell(ally)));
    const nearbyFreeze = (ctx.bonuses || []).filter(b => b.type === "freeze" && !b.dead)
      .flatMap(b => allies.map((ally, index) => ({ index,
        distance: distance(center(ally), center(b)), reachable: route(fields[index], cell(b)).length > 0 })))
      .filter(item => item.distance <= SIZE * 5 && item.reachable)
      .sort((a, b) => a.distance - b.distance)[0];
    const deadlines = enemies.map(enemy => baseEta(ctx, enemy) + Math.max(0, Number(ctx.freezeTime) || 0));
    const killTimes = allies.map((ally, index) => enemies.map(enemy => {
      const goals = shotGoals(ctx, enemy, fields[index]);
      const routeTiles = goals[0]?.cost;
      const own = center(ally), foe = center(enemy);
      const aligned = Math.abs(own.x - foe.x) <= enemy.w / 2 + 3
        || Math.abs(own.y - foe.y) <= enemy.h / 2 + 3;
      const pointBlank = distance(own, foe) < SIZE * 2.2 && aligned
        && firstObstacle(ctx, cell(ally), cell(enemy)) === null;
      const travelSeconds = Number.isFinite(routeTiles)
        ? routeTiles * SIZE / Math.max(40, ally.speed || 105) : Infinity;
      return Math.min(travelSeconds, pointBlank ? 0.55 : Infinity) + 0.3
        + Math.max(0, (enemy.hp || 1) - 1) * (ally.fireDelay || 0.45);
    }));
    const options = [-1, ...enemies.map((_, index) => index)];
    let best = null;
    for (const first of nearbyFreeze?.index === 0 ? [-1] : options)
      for (const second of allies.length > 1
        ? nearbyFreeze?.index === 1 ? [-1] : options : [-1]) {
      if (first >= 0 && first === second && enemies.length > 1) continue;
      const selections = allies.length > 1 ? [first, second] : [first];
      let score = 0;
      for (let e = 0; e < enemies.length; e++) {
        const assigned = selections.map((selection, a) => selection === e ? killTimes[a][e] : Infinity);
        const eta = Math.min(...assigned);
        const deadline = deadlines[e];
        const urgency = deadline < 3 ? 8 : deadline < 7 ? 4 : 1;
        score += !Number.isFinite(eta) ? 36 * urgency
          : Math.max(0, eta - deadline + 0.5) * 16 * urgency + eta * 0.35;
        if (deadline < 5) {
          const fastest = Math.min(...killTimes.map(times => times[e]));
          if (Number.isFinite(fastest) && Number.isFinite(eta)) {
            score += Math.max(0, eta - fastest - 0.15) * (deadline < 3 ? 170 : 85);
          }
        }
      }
      selections.forEach((selection, a) => {
        if (selection < 0) {
          if (nearbyFreeze?.index !== a && enemies.length) {
            const reachable = killTimes[a].some(Number.isFinite);
            score += reachable ? (enemies.length > 1 ? 65 : 24) : 0;
          }
          return;
        }
        const enemy = enemies[selection], ally = allies[a];
        const ownSide = ally.kind === "player"
          ? center(enemy).x < ctx.cols * SIZE / 2
          : center(enemy).x >= ctx.cols * SIZE / 2;
        const ownSideEnemy = enemies.some(other => ally.kind === "player"
          ? center(other).x < ctx.cols * SIZE / 2 : center(other).x >= ctx.cols * SIZE / 2);
        if (!ownSide && ownSideEnemy && deadlines[selection] >= 3) score += 32;
        if (!ownSide && deadlines[selection] >= 7) score += 8;
        const committed = prior?.assignments.get(ally);
        const committedIndex = enemies.indexOf(committed);
        if (committedIndex >= 0 && committed !== enemy
          && center(committed).y >= ctx.rows * SIZE * 0.7
          && Number.isFinite(killTimes[a][committedIndex])
          && deadlines[committedIndex] < 4
          && deadlines[selection] >= deadlines[committedIndex] - 0.7) score += 180;
        if (committed?.alive && committed !== enemy && deadlines[selection] >= 3) score += 9;
        if (!Number.isFinite(killTimes[a][selection])) score += 200;
      });
      if (first >= 0 && first === second) score += 8;
      if (!best || score < best.score) best = { selections, score };
    }
    const assignments = new Map(allies.map((ally, index) => [ally,
      enemies[best?.selections[index]] || null]));
    teamPlans.set(ctx.map, { at: now, mapVersion: ctx.mapVersion, stage: ctx.stage,
      allies, enemies, assignments });
    return assignments;
  }
  function bulletDanger(ctx, proposed, hold = false) {
    const tank = ctx.tank, own = center(tank);
    const [mx, my] = DIRS[proposed] || [0, 0];
    const speed = hold ? 0 : Math.min(105, tank.speed || 105);
    const canOccupy = (x, y) => {
      const halfX = tank.w / 2, halfY = tank.h / 2;
      for (const px of [x - halfX, x + halfX]) for (const py of [y - halfY, y + halfY]) {
        const t = tile(ctx, Math.floor(px / SIZE), Math.floor(py / SIZE));
        if (t === "S" || t === "B" || t === "W" || t === "E") return false;
      }
      return true;
    };
    let danger = 0;
    for (const bullet of ctx.bullets || []) {
      if (!bullet.enemy || bullet.dead) continue;
      const [dx, dy] = DIRS[bullet.dir] || [0, 0];
      const b = center(bullet);
      if (!dx && !dy) continue;
      const bulletSpeed = bullet.speed || 230;
      let position = own;
      for (let step = 0; step <= 18; step++) {
        const time = step * 0.05;
        const bx = b.x + dx * bulletSpeed * time;
        const by = b.y + dy * bulletSpeed * time;
        const obstacle = tile(ctx, Math.floor(bx / SIZE), Math.floor(by / SIZE));
        if (obstacle === "S" || obstacle === "B" || obstacle === "E") break;
        const next = { x: own.x + mx * speed * time, y: own.y + my * speed * time };
        if (canOccupy(next.x, next.y)) position = next;
        if (Math.abs(bx - position.x) <= tank.w / 2 + (bullet.w || 6) / 2 + 4
          && Math.abs(by - position.y) <= tank.h / 2 + (bullet.h || 6) / 2 + 4) {
          danger = Math.max(danger, 1 + (0.9 - time) * 6);
          break;
        }
      }
    }
    return danger;
  }
  function unsafeGuardShot(ctx, dir, enemy) {
    if (!enemy?.alive || !DIRS[dir]) return false;
    const own = center(ctx.tank), target = center(enemy);
    const [dx, dy] = DIRS[dir];
    const ahead = (target.x - own.x) * dx + (target.y - own.y) * dy;
    if (ahead <= 0) return false;
    const protectedBrickBehind = [-4, 0, 4].some(offset => {
      for (let step = 16; step < Math.max(ctx.cols, ctx.rows) * SIZE; step += 8) {
        const x = Math.floor((own.x + dx * step - dy * offset) / SIZE);
        const y = Math.floor((own.y + dy * step + dx * offset) / SIZE);
        if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) break;
        const terrain = tile(ctx, x, y);
        if (terrain === "S" || terrain === "E") break;
        if (terrain === "B") return guard(ctx, x, y);
      }
      return false;
    });
    if (!protectedBrickBehind) return false;
    const half = (dx ? enemy.h : enemy.w) / 2;
    const lateral = Math.abs((target.x - own.x) * dy - (target.y - own.y) * dx);
    const flight = Math.max(0, ahead - half) / 310;
    const drift = ctx.freezeTime > 0 ? 0 : (enemy.speed || 72) * flight;
    return lateral + drift > half - 4;
  }
  function shieldsBase(ctx) {
    const own = center(ctx.tank), base = center(ctx.base);
    return (ctx.bullets || []).some(bullet => {
      if (!bullet.enemy || bullet.dead) return false;
      const [dx, dy] = DIRS[bullet.dir] || [0, 0];
      const source = center(bullet);
      const toTank = (own.x - source.x) * dx + (own.y - source.y) * dy;
      const toBase = (base.x - own.x) * dx + (base.y - own.y) * dy;
      const lateral = Math.abs((base.x - source.x) * dy - (base.y - source.y) * dx);
      const tankLateral = Math.abs((own.x - source.x) * dy - (own.y - source.y) * dx);
      return toTank > 0 && toTank < SIZE * 5 && toBase > 0
        && lateral < SIZE * 0.6 && tankLateral < SIZE * 0.6
        && !firstObstacle(ctx, cell(bullet), cell(ctx.base));
    });
  }
  function avoidBulletAction(ctx, action) {
    if (!action || action.mode === "core-v3-freeze-pickup" || shieldsBase(ctx)) return action;
    const current = bulletDanger(ctx, action.dir || ctx.tank.dir, Boolean(action.hold));
    if (current < 2) return action;
    const alternatives = ORDER.filter(dir => ctx.canMove?.(dir))
      .map(dir => ({ dir, danger: bulletDanger(ctx, dir) }))
      .sort((a, b) => a.danger - b.danger);
    const safer = alternatives[0];
    if (!safer || safer.danger + 0.7 >= current) return action;
    ctx.plannedRoute = null;
    return { dir: safer.dir, hold: false, fire: false, mode: "core-v3-evade",
      target: action.target || null, lockedTarget: action.lockedTarget || action.target || null };
  }
  function routeAction(ctx, path, target, mode) {
    const tank = ctx.tank;
    if (path.length < 2) return null;
    const next = path[1];
    const current = center(tank);
    let dir = next.x > path[0].x ? "right" : next.x < path[0].x ? "left"
      : next.y > path[0].y ? "down" : "up";
    // Finish the current grid lane before turning; a 28px body cannot cut corners.
    if ((dir === "up" || dir === "down") && Math.abs(current.x - (path[0].x * SIZE + 16)) > 2.5) {
      dir = current.x < path[0].x * SIZE + 16 ? "right" : "left";
    } else if ((dir === "left" || dir === "right") && Math.abs(current.y - (path[0].y * SIZE + 16)) > 2.5) {
      dir = current.y < path[0].y * SIZE + 16 ? "down" : "up";
    }
    const opposite = DIRS[tank.dir] && DIRS[dir]
      && DIRS[tank.dir][0] === -DIRS[dir][0]
      && DIRS[tank.dir][1] === -DIRS[dir][1];
    const movementDir = tank.dir === dir || tank.turnCooldown > 0 ? tank.dir
      : opposite ? (dir === "up" || dir === "down" ? "left" : "up") : dir;
    ctx.plannedRoute = [current, ...path.slice(1).map(p => ({ x: p.x * SIZE + 16, y: p.y * SIZE + 16 }))];
    if (movementDir !== dir && DIRS[movementDir]) {
      const lead = Math.min(SIZE - 2, Math.min(105, tank.speed || 105)
        * Math.max(0.03, tank.turnCooldown || 0.3));
      const [dx, dy] = DIRS[movementDir];
      const turningPoint = { x: current.x + dx * lead, y: current.y + dy * lead };
      const turningCell = { x: Math.floor(turningPoint.x / SIZE), y: Math.floor(turningPoint.y / SIZE) };
      const canTurnThrough = ctx.canMove?.(movementDir)
        && Number.isFinite(passCost(ctx, turningCell.x, turningCell.y));
      const finish = canTurnThrough ? route(field(ctx, turningCell), path[path.length - 1]) : [];
      ctx.plannedRoute = canTurnThrough && finish.length
        ? [current, turningPoint, ...finish.slice(1).map(p => ({ x: p.x * SIZE + 16, y: p.y * SIZE + 16 }))]
        : null;
    }
    if (dir === (next.x > path[0].x ? "right" : next.x < path[0].x ? "left"
      : next.y > path[0].y ? "down" : "up") && tile(ctx, next.x, next.y) === "B") {
      return { dir, hold: true, fire: Boolean(ctx.canFire?.() && tank.dir === dir),
        mode: "core-v3-clear", target, lockedTarget: target };
    }
    if (ctx.canMove?.(dir)) return { dir, hold: false, fire: false,
      mode, target, lockedTarget: target };
    // Dynamic tank blockage: try an unoccupied adjacent cell, then replan next tick.
    const alternate = ORDER.find(d => ctx.canMove?.(d)
      && Number.isFinite(ctx.__v3Field?.cost[path[0].y + DIRS[d][1]]?.[path[0].x + DIRS[d][0]])
      && ctx.__v3Field.cost[path[0].y + DIRS[d][1]][path[0].x + DIRS[d][0]] <=
        ctx.__v3Field.cost[next.y][next.x] + 2);
    if (alternate) {
      const [dx, dy] = DIRS[alternate];
      ctx.plannedRoute = [current, { x: current.x + dx * SIZE, y: current.y + dy * SIZE }];
      return { dir: alternate, hold: false, fire: false, mode: "core-v3-detour",
        target, lockedTarget: target };
    }
    ctx.plannedRoute = null;
    return { dir: tank.dir, hold: true, fire: false,
      mode: "core-v3-blocked", target, lockedTarget: target };
  }
  function turnWillHoldLane(ctx, tank, dir, enemy) {
    if (ctx.freezeTime > 0 || tank.dir === dir) return true;
    const own = center(tank), current = center(enemy);
    const [mx, my] = DIRS[enemy.dir] || [0, 0];
    const future = { x: current.x + mx * (enemy.speed || 72) * 0.3,
      y: current.y + my * (enemy.speed || 72) * 0.3 };
    const [dx, dy] = DIRS[dir];
    const along = (future.x - own.x) * dx + (future.y - own.y) * dy;
    const lateral = Math.abs((future.x - own.x) * dy - (future.y - own.y) * dx);
    return along > 4 && lateral <= 19;
  }
  function contactAction(ctx, enemies, assignment) {
    const tank = ctx.tank, own = center(tank);
    const assigned = assignment.get(tank);
    const nearby = enemies.filter(enemy => distance(own, center(enemy)) <= SIZE * 3.25)
      .sort((a, b) => distance(own, center(a)) - distance(own, center(b))
        || baseEta(ctx, a) - baseEta(ctx, b));
    if (!nearby.length) return null;
    const shotOrder = [...nearby].sort((a, b) =>
      Number(b === assigned) - Number(a === assigned)
      || baseEta(ctx, a) - baseEta(ctx, b));
    for (const enemy of shotOrder) {
      if (!ctx.canFire?.()) break;
      if (!unsafeGuardShot(ctx, tank.dir, enemy)
        && (ctx.canDirectShoot?.(tank.dir, enemy)
          || (ctx.freezeTime <= 0 && ctx.canShoot?.(tank.dir, enemy)))) {
        return { dir: tank.dir, hold: true, fire: true, mode: "core-v3-contact-fire",
          target: enemy, lockedTarget: enemy };
      }
    }
    for (const enemy of nearby) {
      if (distance(own, center(enemy)) > SIZE * 2.25) continue;
      for (const dir of [tank.dir, ...ORDER.filter(d => d !== tank.dir)]) {
        if (unsafeGuardShot(ctx, dir, enemy)
          || (!ctx.canDirectShoot?.(dir, enemy)
            && !(ctx.freezeTime <= 0 && ctx.canPredictShoot?.(dir, enemy)))) continue;
        if (!turnWillHoldLane(ctx, tank, dir, enemy)) continue;
        return { dir, hold: true, fire: false, mode: "core-v3-contact-aim",
          target: enemy, lockedTarget: enemy };
      }
    }
    const enemy = nearby[0];
    if (distance(own, center(enemy)) > SIZE * 2.4) return null;
    if (assigned && assigned !== enemy
      && (ctx.friends || []).some(friend => assignment.get(friend) === enemy)) return null;
    const toward = center(enemy);
    const currentGap = Math.min(Math.abs(own.x - toward.x), Math.abs(own.y - toward.y));
    const reposition = ORDER.filter(dir => ctx.canMove?.(dir)).map(dir => {
      const [dx, dy] = DIRS[dir];
      const next = { x: own.x + dx * 25, y: own.y + dy * 25 };
      const laneGap = Math.min(Math.abs(next.x - toward.x), Math.abs(next.y - toward.y));
      const separation = distance(next, toward);
      return { dir, score: laneGap * 2.5 + separation * 0.08
        + bulletDanger(ctx, dir) * 20 + (dir === tank.dir ? -2 : 0) };
    }).sort((a, b) => a.score - b.score)[0];
    if (!reposition || reposition.score > currentGap * 2.5 + distance(own, toward) * 0.08 + 2) return null;
    const [dx, dy] = DIRS[reposition.dir];
    ctx.plannedRoute = [own, { x: own.x + dx * 25, y: own.y + dy * 25 }];
    return { dir: reposition.dir, hold: false, fire: false, mode: "core-v3-contact-step",
      target: enemy, lockedTarget: enemy };
  }
  function createController(name) {
    let waitingCell = null, waitingSince = 0;
    let meleeTarget = null;
    function plan(ctx) {
      const tank = ctx.tank;
      if (!tank?.alive) return { hold: true, fire: false, mode: "core-v3-dead" };
      const closeEnemies = (ctx.enemies || []).filter(enemy => enemy.alive && !hidden(ctx, enemy)
        && distance(center(tank), center(enemy)) <= SIZE * 2.5);
      if (!closeEnemies.includes(meleeTarget)) meleeTarget = closeEnemies.sort((a, b) =>
        distance(center(tank), center(a)) - distance(center(tank), center(b)))[0] || null;
      if (meleeTarget && ctx.meleeShot) {
        const shots = [meleeTarget, ...closeEnemies.filter(enemy => enemy !== meleeTarget)]
          .flatMap(enemy => [tank.dir, ...ORDER.filter(dir => dir !== tank.dir)]
            .map(dir => ({ enemy, dir, hit: ctx.meleeShot(dir, enemy) })))
          .filter(shot => shot.hit && !unsafeGuardShot(ctx, shot.dir, shot.enemy)
            && !(shot.hit.type === "tile"
              && (shot.hit.baseGuard || guard(ctx, shot.hit.x, shot.hit.y))))
          .sort((a, b) => Number(b.hit.type === "enemy") - Number(a.hit.type === "enemy")
            || Number(a.dir !== tank.dir) - Number(b.dir !== tank.dir));
        if (shots.length) {
          const shot = shots[0];
          meleeTarget = shot.hit.type === "enemy" ? shot.hit.target : shot.enemy;
          return { dir: shot.dir, fire: true, hold: true,
            mode: shot.hit.type === "tile" ? "core-melee-clear" : "core-melee-direct",
            target: meleeTarget, lockedTarget: meleeTarget };
        }
      }
      const ownCell = cell(tank);
      const travel = field(ctx, ownCell);
      ctx.__v3Field = travel;
      const enemies = (ctx.enemies || []).filter(e => e.alive && !hidden(ctx, e));
      let lastSeen = lastSeenByMap.get(ctx.map);
      if (!lastSeen || lastSeen.stage !== ctx.stage) {
        lastSeen = { stage: ctx.stage, positions: new Map() };
        lastSeenByMap.set(ctx.map, lastSeen);
      }
      const now = Number(ctx.gameTime) || 0;
      for (const enemy of enemies) lastSeen.positions.set(enemy, {
        point: center(enemy), eta: baseEta(ctx, enemy), at: now,
      });
      for (const enemy of lastSeen.positions.keys()) {
        if (!enemy.alive || now - lastSeen.positions.get(enemy).at > 2) {
          lastSeen.positions.delete(enemy);
        }
      }
      const freeze = (ctx.bonuses || []).filter(b => b.type === "freeze" && !b.dead
        && distance(center(b), center(tank)) <= SIZE * 5).sort((a, b) =>
        distance(center(a), center(tank)) - distance(center(b), center(tank)))[0];
      let pickup = null;
      if (freeze && (!ctx.friends?.length || distance(center(tank), center(freeze)) <=
        Math.min(...ctx.friends.map(f => distance(center(f), center(freeze)))) + SIZE * 0.4)) {
        const goal = cell(freeze), path = route(travel, goal);
        if (path.length > 1) pickup = routeAction(ctx, path, null, "core-v3-freeze-pickup");
      }
      if (pickup) return pickup;
      // A disappearing enemy is not targetable in grass, but its last visible
      // approach to the base still warrants one defender checking that lane.
      const visibleEta = Math.min(Infinity, ...enemies.map(enemy => baseEta(ctx, enemy)));
      const lost = [...lastSeen.positions].filter(([enemy, seen]) =>
        !enemies.includes(enemy) && seen.eta < 3.5 && seen.eta + 0.5 < visibleEta)
        .sort((a, b) => a[1].eta - b[1].eta)[0];
      if (lost) {
        const goal = { x: Math.floor(lost[1].point.x / SIZE),
          y: Math.floor(lost[1].point.y / SIZE) };
        const path = route(travel, goal);
        const ownCost = travel.cost[goal.y]?.[goal.x] ?? Infinity;
        const friendCost = Math.min(Infinity, ...(ctx.friends || []).filter(friend => friend.alive)
          .map(friend => field(ctx, cell(friend)).cost[goal.y]?.[goal.x] ?? Infinity));
        if (path.length > 1 && ownCost <= friendCost + 0.01) {
          const investigate = routeAction(ctx, path, null, "core-v3-last-seen-defense");
          if (investigate) return investigate;
        }
      }
      const assignment = teamAssignment(ctx);
      const close = contactAction(ctx, enemies, assignment);
      if (close) return close;
      const candidates = enemies.map(enemy => {
        const goals = shotGoals(ctx, enemy, travel);
        const projected = interceptPosition(ctx, enemy);
        const intercepts = projected ? shotGoals(ctx, projected, travel) : [];
        const useful = goal => goal.x !== ownCell.x || goal.y !== ownCell.y
          || ctx.canShoot?.(goal.shotDir, enemy);
        const intercept = intercepts.find(goal => goal.y >= ctx.rows * 0.48 && useful(goal));
        const nearestReal = goals.find(useful);
        const nearest = intercept && (!nearestReal || intercept.cost <= nearestReal.cost + 7)
          ? intercept : nearestReal;
        const immediate = distance(center(enemy), center(tank)) < SIZE * 2.5;
        const reserved = (ctx.reservedTargets || []).includes(enemy);
        const ownSide = (tank.kind === "player" && center(enemy).x < ctx.cols * SIZE / 2)
          || (tank.kind === "player2" && center(enemy).x >= ctx.cols * SIZE / 2);
        const emergency = baseEta(ctx, enemy) < 3.5;
        const ownSidePresent = enemies.some(other => other !== enemy
          && ((tank.kind === "player" && center(other).x < ctx.cols * SIZE / 2)
            || (tank.kind === "player2" && center(other).x >= ctx.cols * SIZE / 2)));
        const tier = emergency ? 5 : immediate ? 4
          : center(enemy).y >= ctx.rows * SIZE * 0.5 ? 3 : 1;
        return { enemy, goals, nearest, immediate, emergency, ownSide, tier,
          score: tier * 100 + threat(ctx, enemy) * 2.5 - (nearest?.cost || 80) * 0.7
          + (ownSide ? 12 : ownSidePresent && !emergency ? -85 : -8)
          - (reserved && enemies.length > 1 && !emergency ? 24 : 0) };
      }).sort((a, b) => b.score - a.score);
      const assignedTarget = assignment.get(tank);
      let choice = candidates.find(c => c.enemy === assignedTarget) || null;
      if (!choice) choice = candidates.find(c => c.immediate)
        || candidates.find(c => c.nearest) || null;
      if (choice && !choice.ownSide && choice.tier === 1 && ctx.friends?.length) {
        const friend = ctx.friends[0];
        const friendDistance = distance(center(friend), center(choice.enemy));
        const ownDistance = distance(center(tank), center(choice.enemy));
        if (friendDistance + SIZE * 2 < ownDistance) {
          const anchor = { x: tank.kind === "player" ? 8 : 17, y: Math.min(ctx.rows - 5, 16) };
          const path = route(travel, anchor);
          const hold = path.length > 1 ? routeAction(ctx, path, choice.enemy, "core-v3-intercept-patrol") : null;
          if (hold) return hold;
        }
      }
      if (!choice) {
        const anchor = { x: tank.kind === "player" ? 8 : 17, y: Math.min(ctx.rows - 5, 16) };
        const patrol = enemies.length ? routeAction(ctx, route(travel, anchor), null,
          "core-v3-intercept-patrol") : null;
        return patrol || { dir: tank.dir, hold: true, fire: false, mode: "core-v3-search" };
      }
      const target = choice.enemy;
      if (!waitingCell || waitingCell !== key(ownCell)) {
        waitingCell = key(ownCell);
        waitingSince = Number(ctx.gameTime) || 0;
      }
      // The game validates the first projectile impact and base safety once more.
      const shotTargets = [choice, ...candidates.filter(c => c !== choice && c.immediate)]
        .map(c => c.enemy);
      for (const shotTarget of shotTargets) for (const dir of [tank.dir, ...ORDER.filter(d => d !== tank.dir)]) {
        const precise = ctx.canDirectShoot?.(dir, shotTarget);
        const moving = ctx.canPredictShoot?.(dir, shotTarget);
        if ((!precise && !moving) || unsafeGuardShot(ctx, dir, shotTarget)) continue;
        if (tank.dir === dir && ctx.canFire?.()) {
          return { dir, fire: true, hold: false, mode: precise ? "core-v3-attack-fire" : "core-predict-fire",
            target: shotTarget, lockedTarget: shotTarget };
        }
        if (shotTarget === target && precise && turnWillHoldLane(ctx, tank, dir, target)) return { dir, fire: false, hold: true,
          mode: "core-v3-attack-aim", target, lockedTarget: target };
      }
      const alternateGoal = choice.goals.find(goal => (goal.x !== ownCell.x || goal.y !== ownCell.y)
        && (waitingSince + 0.8 < (Number(ctx.gameTime) || 0) || !choice.nearest));
      const goal = alternateGoal && (!choice.nearest || key(choice.nearest) === key(ownCell))
        ? alternateGoal : choice.nearest;
      const path = goal ? (tank.stuck > 0.4
        ? turnRoute(ctx, tank, goal) : route(travel, goal)) : [];
      let action = routeAction(ctx, path, target, "core-v3-attack-route");
      if (!action && choice.immediate) {
        const enemyPoint = center(target), own = center(tank);
        const preferences = Math.abs(enemyPoint.x - own.x) >= Math.abs(enemyPoint.y - own.y)
          ? [enemyPoint.x < own.x ? "left" : "right", enemyPoint.y < own.y ? "up" : "down"]
          : [enemyPoint.y < own.y ? "up" : "down", enemyPoint.x < own.x ? "left" : "right"];
        const dir = preferences.find(d => ctx.canMove?.(d));
        if (dir) action = { dir, hold: false, fire: false, mode: "core-v3-contact",
          target, lockedTarget: target };
      }
      if (!action) return { dir: tank.dir, hold: true, fire: false,
        mode: "core-v3-replan", target, lockedTarget: target };
      return action;
    }
    function decide(ctx) {
      return avoidBulletAction(ctx, plan(ctx));
    }
    return { decide, learn: () => {}, snapshot: () => ({ engine: "v3", target: null }), restore: () => false,
      get mode() { return `core-v3-${name}`; } };
  }
  /** @type {any} */ (window).TankPartnerAIV3 = { createController,
    inspectBaseEta: baseEta,
    inspectTurnRoute: turnRoute,
    enhance(services) {
    const core = window.TankPartnerAIEngine?.enhance(services);
    if (!core?.createController) {
      return { ...services, createController, __engine: "AI-V3", engineVersion: "V3" };
    }
    return { ...core, __engine: "AI-V3", engineVersion: "V3",
      createController(name) {
        const tactician = core.createController(name);
        return { ...tactician, decide(ctx, dt) {
          const action = tactician.decide(ctx, dt);
          if (!action?.hold || action.fire || !/(?:replan|search|scan|wait|idle|blocked)/i.test(action.mode || "")) {
            return action;
          }
          if ((ctx.bonuses || []).some(b => b.type === "freeze" && !b.dead
            && distance(center(ctx.tank), center(b)) <= SIZE * 5)) return action;
          const enemies = (ctx.enemies || []).filter(e => e.alive && !hidden(ctx, e));
          const nearby = enemies.filter(e => distance(center(ctx.tank), center(e)) <= SIZE * 2.3);
          if (!nearby.length || !ctx.canFire?.()) return action;
          for (const enemy of nearby) {
            if (ctx.canDirectShoot?.(ctx.tank.dir, enemy)) {
              return { dir: ctx.tank.dir, hold: true, fire: true,
                mode: "core-v3-contact-fire", target: enemy,
                lockedTarget: action?.target || enemy };
            }
          }
          return action;
        } };
      } };
  } };
})();
