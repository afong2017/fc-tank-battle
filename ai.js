(function () {
  const STORAGE_KEY = "fc-tank-battle.partner-ai.v1";
  const DEFAULT_WEIGHTS = {
    defend: 1.35,
    attack: 1.0,
    support: 0.75,
    dodge: 1.15,
  };

  function loadMemory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { weights: { ...DEFAULT_WEIGHTS }, games: 0 };
    } catch {
      return { weights: { ...DEFAULT_WEIGHTS }, games: 0 };
    }
  }

  function saveMemory(memory) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      // Storage can be disabled in private windows; AI still works without persistence.
    }
  }

  function dist(a, b) {
    const ax = a.x + (a.w || 0) / 2;
    const ay = a.y + (a.h || 0) / 2;
    const bx = b.x + (b.w || 0) / 2;
    const by = b.y + (b.h || 0) / 2;
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  function nearest(from, list) {
    let best = null;
    let bestDist = Infinity;
    for (const item of list) {
      const d = dist(from, item);
      if (d < bestDist) {
        best = item;
        bestDist = d;
      }
    }
    return best;
  }

  function directionTo(from, to) {
    const dx = to.x + (to.w || 0) / 2 - (from.x + from.w / 2);
    const dy = to.y + (to.h || 0) / 2 - (from.y + from.h / 2);
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
    return dy < 0 ? "up" : "down";
  }

  function alignedForShot(tank, target, tolerance) {
    const tx = tank.x + tank.w / 2;
    const ty = tank.y + tank.h / 2;
    const ex = target.x + (target.w || 0) / 2;
    const ey = target.y + (target.h || 0) / 2;
    return Math.abs(tx - ex) < tolerance || Math.abs(ty - ey) < tolerance;
  }

  function incomingBullet(tank, bullets) {
    return bullets.find((b) => {
      if (!b.enemy) return false;
      const dx = Math.abs((tank.x + tank.w / 2) - (b.x + b.w / 2));
      const dy = Math.abs((tank.y + tank.h / 2) - (b.y + b.h / 2));
      if ((b.dir === "up" || b.dir === "down") && dx < 18) return dy < 150;
      if ((b.dir === "left" || b.dir === "right") && dy < 18) return dx < 150;
      return false;
    });
  }

  function dodgeDir(bullet) {
    if (bullet.dir === "up" || bullet.dir === "down") return Math.random() > 0.5 ? "left" : "right";
    return Math.random() > 0.5 ? "up" : "down";
  }

  function enemyLineOfFire(tank, enemies) {
    return enemies.find((enemy) => {
      const dx = Math.abs((tank.x + tank.w / 2) - (enemy.x + enemy.w / 2));
      const dy = Math.abs((tank.y + tank.h / 2) - (enemy.y + enemy.h / 2));
      if ((enemy.dir === "up" || enemy.dir === "down") && dx < 18) return dy < 190;
      if ((enemy.dir === "left" || enemy.dir === "right") && dy < 18) return dx < 190;
      return false;
    });
  }

  function safeFlankDir(tank, threat, baseDir) {
    if (!threat) return baseDir;
    if (threat.dir === "up" || threat.dir === "down") {
      return tank.x < threat.x ? "left" : "right";
    }
    return tank.y < threat.y ? "up" : "down";
  }

  function createController(name) {
    const memory = loadMemory();
    let lastMode = "defend";
    let decisionClock = 0;
    let cached = { dir: "up", fire: false, mode: "defend" };

    function learn(event, amount = 1) {
      const reward = Math.max(-1, Math.min(1, amount));
      const weights = memory.weights;
      if (event === "kill") weights.attack += 0.05 * reward;
      if (event === "base-danger") weights.defend += 0.04 * reward;
      if (event === "ally-hit") weights.support += 0.04 * reward;
      if (event === "self-hit") weights.dodge += 0.05 * reward;
      for (const key of Object.keys(weights)) weights[key] = Math.max(0.35, Math.min(2.4, weights[key]));
      saveMemory(memory);
    }

    function decide(ctx, dt) {
      decisionClock -= dt;
      if (decisionClock > 0) return cached;

      const tank = ctx.tank;
      const enemy = nearest(tank, ctx.enemies);
      const ally = nearest(tank, ctx.friends);
      const baseThreat = nearest(ctx.base, ctx.enemies.filter((e) => dist(e, ctx.base) < 340));
      const bullet = incomingBullet(tank, ctx.bullets);
      const gunThreat = enemyLineOfFire(tank, ctx.enemies);
      const weights = memory.weights;

      const choices = [];
      if (bullet) choices.push({ mode: "dodge", target: bullet, score: weights.dodge + 1.1 });
      if (gunThreat) choices.push({ mode: "dodge", target: gunThreat, score: weights.dodge + 0.55 });
      if (baseThreat) choices.push({ mode: "defend", target: baseThreat, score: weights.defend + (340 - dist(baseThreat, ctx.base)) / 150 });
      if (ally && enemy) choices.push({ mode: "support", target: enemy, score: weights.support + Math.max(0, 180 - dist(ally, enemy)) / 220 });
      if (enemy) choices.push({ mode: "attack", target: enemy, score: weights.attack + Math.random() * 0.25 });
      choices.push({ mode: "defend", target: ctx.base, score: weights.defend * 0.65 });

      const choice = choices.sort((a, b) => b.score - a.score)[0] || { mode: "defend", target: ctx.base };
      let dir = choice.mode === "dodge" ? dodgeDir(choice.target) : directionTo(tank, choice.target);
      dir = safeFlankDir(tank, gunThreat, dir);
      let fire = Boolean(enemy && alignedForShot(tank, enemy, 14));

      if (choice.mode === "defend" && baseThreat) fire = fire || alignedForShot(tank, baseThreat, 18);
      if (choice.mode !== lastMode) decisionClock = 0.18;
      else decisionClock = 0.38 + Math.random() * 0.22;

      lastMode = choice.mode;
      cached = { dir, fire, mode: choice.mode };
      return cached;
    }

    return {
      name,
      decide,
      learn,
      memory,
    };
  }

  window.TankPartnerAI = { createController };
})();
