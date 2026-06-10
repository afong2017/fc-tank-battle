const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const ui = {
  score: document.getElementById("score"),
  stage: document.getElementById("stage"),
  lives: document.getElementById("lives"),
  enemy: document.getElementById("enemy"),
  pad: document.getElementById("pad"),
  p1mode: document.getElementById("p1mode"),
  p2mode: document.getElementById("p2mode"),
  p1LivesStart: document.getElementById("p1LivesStart"),
  p2LivesStart: document.getElementById("p2LivesStart"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayPrompt: document.getElementById("overlayPrompt"),
  overlayHelp: document.getElementById("overlayHelp"),
};

const TILE = 32;
const COLS = 26;
const ROWS = 24;
const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const KEYS = new Set();
const pressed = new Set();
const P1_AUTO_SECONDS = 10;

let audio;
let gamepadIndex = null;
let padNow = [];
let padPrev = [];
let lastTime = 0;
let state = "title";
let score = 0;
let lives = 3;
let lives2 = 3;
let stageIndex = 0;
let enemiesLeft = 20;
let spawnClock = 0;
let freezeClock = 0;
let shake = 0;

const colors = {
  brick: "#b65c35",
  brickDark: "#703324",
  steel: "#9da0a0",
  steelDark: "#565a5f",
  water: "#2454b6",
  forest: "#236b35",
  ice: "#a9e1dc",
  player: "#d7c25b",
  player2: "#6db6d8",
  enemy: "#70a65d",
  fast: "#c75647",
  armor: "#7e87cc",
  bullet: "#f5f0d0",
};

const stages = [
  [
    "..........................",
    "..B..B..B..SS..B..B..B....",
    "..B..B..B......B..B..B....",
    "....WW....BBBB....WW......",
    "....WW....B..B....WW......",
    "..BBBB..SS....SS..BBBB....",
    "...........FF.............",
    "..SS..BBBB.FF.BBBB..SS....",
    "......B..........B........",
    "BBBB..B..SS..SS..B..BBBB..",
    "......B....WW....B........",
    "..FF..BBBB.WW.BBBB..FF....",
    "..FF................FF....",
    "......B..BBBBBB..B........",
    "BBBB..B....SS....B..BBBB..",
    "......B..........B........",
    "..SS..BBBB....BBBB..SS....",
    "..........FFFF............",
    "....BBBB..........BBBB....",
    "....B................B....",
    "..B.B................B.B..",
    "...........BBBB...........",
    "...........BEEB...........",
    "...........BEEB...........",
  ],
  [
    "..........................",
    "..BBBB..SS....SS..BBBB....",
    "..B..B............B..B....",
    "..B..B..WWWWWWWW..B..B....",
    "........W......W..........",
    "BBBBBB..W.SS.SS.W..BBBBBB.",
    "........W......W..........",
    "..SS....WWWWWWWW....SS....",
    "......FF........FF........",
    "BBBB..FF..BBBB..FF..BBBB..",
    "......FF..B..B..FF........",
    "..WWWW......SS......WWWW..",
    "..W..W..BBBB..BBBB..W..W..",
    "..WWWW............WWWW....",
    "........SS....SS..........",
    "..BBBB......FF......BBBB..",
    "..B..B..SS..FF..SS..B..B..",
    "..B..B......FF......B..B..",
    "......BBBB......BBBB......",
    "..SS................SS....",
    "...........BBBB...........",
    "....BBBB...BEEB..BBBB.....",
    "...........BEEB...........",
    "...........BEEB...........",
  ],
];

let map = [];
let player;
let player2;
let enemies = [];
let bullets = [];
let particles = [];
let bonuses = [];
let baseAlive = true;
const baseRect = { x: 12 * TILE, y: 22 * TILE, w: 2 * TILE, h: 2 * TILE };
const ai1 = window.TankPartnerAI?.createController("1P");
const ai2 = window.TankPartnerAI?.createController("2P");
let p1Idle = 0;
let p1Auto = false;
let p2Human = false;
let baseDangerClock = 0;
let hiddenTimer = null;

function newAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audio = audio || new AudioContext();
  return audio;
}

function tone(freq, duration, type = "square", gain = 0.08, slide = 1) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  const now = audio.currentTime;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), now + duration);
  amp.gain.setValueAtTime(gain, now);
  amp.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration);
}

const sfx = {
  fire: () => tone(760, 0.06, "square", 0.06, 0.55),
  hit: () => tone(120, 0.12, "sawtooth", 0.09, 0.6),
  boom: () => {
    tone(80, 0.18, "sawtooth", 0.1, 0.45);
    setTimeout(() => tone(48, 0.14, "square", 0.08, 0.7), 55);
  },
  start: () => {
    tone(440, 0.08, "square", 0.06, 1.4);
    setTimeout(() => tone(660, 0.1, "square", 0.06, 1.2), 90);
  },
  power: () => {
    tone(320, 0.08, "triangle", 0.07, 1.8);
    setTimeout(() => tone(520, 0.1, "triangle", 0.07, 1.3), 80);
  },
};

function rects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function tileAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return "S";
  if (!map[ty]) return "S";
  return map[ty][tx];
}

function setTile(tx, ty, value) {
  if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return;
  map[ty][tx] = value;
}

function solidTiles(box, tank = false) {
  const tiles = [];
  const x1 = Math.floor(box.x / TILE);
  const y1 = Math.floor(box.y / TILE);
  const x2 = Math.floor((box.x + box.w - 1) / TILE);
  const y2 = Math.floor((box.y + box.h - 1) / TILE);
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const t = tileAt(x, y);
      if (t === "B" || t === "S" || t === "E" || (tank && t === "W")) {
        tiles.push({ x, y, t, box: { x: x * TILE, y: y * TILE, w: TILE, h: TILE } });
      }
    }
  }
  return tiles;
}

function blocked(box, self) {
  if (box.x < 0 || box.y < 0 || box.x + box.w > canvas.width || box.y + box.h > canvas.height) return true;
  if (solidTiles(box, true).length) return true;
  const tanks = [player, player2, ...enemies].filter(Boolean).filter((t) => t !== self && t.alive);
  return tanks.some((tank) => rects(box, tank.box()));
}

function makeTank(kind, x, y) {
  const enemy = kind !== "player" && kind !== "player2";
  const stats = {
    player: { speed: 126, hp: 1, fireDelay: 0.55, color: colors.player },
    player2: { speed: 122, hp: 1, fireDelay: 0.58, color: colors.player2 },
    basic: { speed: 72, hp: 1, fireDelay: 1.3, color: colors.enemy },
    fast: { speed: 105, hp: 1, fireDelay: 0.95, color: colors.fast },
    armor: { speed: 58, hp: 3, fireDelay: 1.55, color: colors.armor },
  }[kind];
  return {
    kind,
    enemy,
    x,
    y,
    w: 28,
    h: 28,
    dir: enemy ? "down" : "up",
    speed: stats.speed,
    hp: stats.hp,
    color: stats.color,
    fireDelay: stats.fireDelay,
    maxBullets: enemy ? 1 : 1,
    alive: true,
    cooldown: enemy ? Math.random() : 0,
    ai: 0,
    invuln: enemy ? 0 : 1.8,
    box() {
      return { x: this.x, y: this.y, w: this.w, h: this.h };
    },
  };
}

function loadStage() {
  map = stages[stageIndex].map((row) => row.split(""));
  enemies = [];
  bullets = [];
  particles = [];
  bonuses = [];
  enemiesLeft = 20 + stageIndex * 4;
  spawnClock = 0.2;
  freezeClock = 0;
  baseAlive = true;
  p1Idle = 0;
  p1Auto = false;
  p2Human = false;
  player = makeTank("player", 8 * TILE + 2, 22 * TILE + 2);
  player2 = makeTank("player2", 16 * TILE + 2, 22 * TILE + 2);
  updateUi();
}

function updateUi() {
  ui.score.textContent = String(score).padStart(6, "0");
  ui.stage.textContent = String(stageIndex + 1).padStart(2, "0");
  ui.lives.textContent = `${formatLives(lives)}/${formatLives(lives2)}`;
  ui.enemy.textContent = String(enemiesLeft + enemies.length).padStart(2, "0");
  ui.p1mode.textContent = p1Auto ? "AI" : "人工";
  ui.p2mode.textContent = p2Human ? "人工" : "AI";
}

function formatLives(value) {
  return value === Infinity ? "∞" : String(value).padStart(2, "0");
}

function readLifeSetting(select, fallback = 3) {
  if (!select) return fallback;
  return select.value === "Infinity" ? Infinity : Math.max(3, Number(select.value) || fallback);
}

function startGame() {
  newAudio();
  audio.resume();
  score = 0;
  lives = readLifeSetting(ui.p1LivesStart);
  lives2 = readLifeSetting(ui.p2LivesStart);
  stageIndex = 0;
  state = "playing";
  overlay.classList.add("hidden");
  loadStage();
  sfx.start();
}

function fire(tank, aiControlled = false) {
  if (tank.cooldown > 0 || !tank.alive) return;
  if (!tank.enemy && bullets.filter((b) => b.owner === tank).length >= tank.maxBullets) return;
  const d = DIRS[tank.dir];
  bullets.push({
    owner: tank,
    enemy: tank.enemy,
    x: tank.x + tank.w / 2 - 3 + d.x * 16,
    y: tank.y + tank.h / 2 - 3 + d.y * 16,
    w: 6,
    h: 6,
    dir: tank.dir,
    speed: tank.enemy ? 230 : 310,
    aiControlled,
  });
  tank.cooldown = tank.fireDelay;
  sfx.fire();
}

function moveTank(tank, dir, dt) {
  if (!DIRS[dir]) return;
  tank.dir = dir;
  const d = DIRS[dir];
  const step = tank.speed * dt;
  const next = { x: tank.x + d.x * step, y: tank.y + d.y * step, w: tank.w, h: tank.h };
  if (!blocked(next, tank)) {
    tank.x = next.x;
    tank.y = next.y;
    return;
  }
  const snap = 4;
  if (dir === "up" || dir === "down") {
    const grid = Math.round(tank.x / TILE) * TILE + 2;
    const aligned = { x: clamp(grid, tank.x - snap, tank.x + snap), y: tank.y, w: tank.w, h: tank.h };
    if (!blocked(aligned, tank)) tank.x = aligned.x;
  } else {
    const grid = Math.round(tank.y / TILE) * TILE + 2;
    const aligned = { x: tank.x, y: clamp(grid, tank.y - snap, tank.y + snap), w: tank.w, h: tank.h };
    if (!blocked(aligned, tank)) tank.y = aligned.y;
  }
}

function inputDir() {
  let pad = navigator.getGamepads?.()[gamepadIndex ?? 0];
  if (pad && pad.connected) {
    ui.pad.textContent = "XBOX";
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    if (Math.abs(ax) > 0.35 || Math.abs(ay) > 0.35) {
      return Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? "left" : "right") : ay < 0 ? "up" : "down";
    }
    if (pad.buttons[12]?.pressed) return "up";
    if (pad.buttons[13]?.pressed) return "down";
    if (pad.buttons[14]?.pressed) return "left";
    if (pad.buttons[15]?.pressed) return "right";
  } else {
    ui.pad.textContent = "键盘";
  }
  if (KEYS.has("ArrowUp") || KEYS.has("KeyW")) return "up";
  if (KEYS.has("ArrowDown") || KEYS.has("KeyS")) return "down";
  if (KEYS.has("ArrowLeft") || KEYS.has("KeyA")) return "left";
  if (KEYS.has("ArrowRight") || KEYS.has("KeyD")) return "right";
  return null;
}

function p1InputActive() {
  const pad = navigator.getGamepads?.()[gamepadIndex ?? 0];
  const padMove = pad?.connected && (Math.abs(pad.axes[0] || 0) > 0.35 || Math.abs(pad.axes[1] || 0) > 0.35);
  return padMove || padPressed(0) || padPressed(5) || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "Space"].some((key) => KEYS.has(key));
}

function p2InputDir() {
  if (KEYS.has("KeyI")) return "up";
  if (KEYS.has("KeyK")) return "down";
  if (KEYS.has("KeyJ")) return "left";
  if (KEYS.has("KeyL")) return "right";
  return null;
}

function p2InputActive() {
  return ["KeyI", "KeyK", "KeyJ", "KeyL", "KeyU"].some((key) => KEYS.has(key));
}

function padPressed(button) {
  return Boolean(padNow[button]);
}

function padJustPressed(button) {
  return Boolean(padNow[button] && !padPrev[button]);
}

function refreshPad() {
  const pad = navigator.getGamepads?.()[gamepadIndex ?? 0];
  if (!pad?.connected) {
    padNow = [];
    return;
  }
  padNow = pad.buttons.map((button) => button.pressed);
}

function rumble(strong = 0.45, weak = 0.25, duration = 120) {
  const pad = navigator.getGamepads?.()[gamepadIndex ?? 0];
  if (!pad?.connected) return;
  if (pad.vibrationActuator?.playEffect) {
    pad.vibrationActuator.playEffect("dual-rumble", {
      duration,
      strongMagnitude: strong,
      weakMagnitude: weak,
    }).catch(() => {});
    return;
  }
  const actuator = pad.hapticActuators?.[0];
  if (actuator?.pulse) actuator.pulse(strong, duration).catch(() => {});
}

function hitRumble() {
  rumble(0.22, 0.12, 70);
}

function teachAis(event, amount = 1) {
  ai1?.learn(event, amount);
  ai2?.learn(event, amount);
}

function spawnEnemy(dt) {
  if (enemiesLeft <= 0 || enemies.length >= 4) return;
  spawnClock -= dt;
  if (spawnClock > 0) return;
  const points = [
    { x: 0 * TILE + 2, y: 0 * TILE + 2 },
    { x: 12 * TILE + 2, y: 0 * TILE + 2 },
    { x: 24 * TILE + 2, y: 0 * TILE + 2 },
  ];
  const point = points[Math.floor(Math.random() * points.length)];
  const roll = Math.random();
  const kind = roll > 0.82 ? "armor" : roll > 0.55 ? "fast" : "basic";
  const tank = makeTank(kind, point.x, point.y);
  if (!blocked(tank.box(), tank)) {
    enemies.push(tank);
    enemiesLeft--;
    burst(point.x + 14, point.y + 14, "#f5f0d0", 12);
  }
  spawnClock = 1.8;
}

function enemyAi(tank, dt) {
  tank.ai -= dt;
  const targetBase = { x: 12.5 * TILE, y: 21 * TILE };
  const livingPlayers = [player, player2].filter((t) => t?.alive);
  const targetPlayer = livingPlayers.sort((a, b) => {
    const da = Math.abs(a.x - tank.x) + Math.abs(a.y - tank.y);
    const db = Math.abs(b.x - tank.x) + Math.abs(b.y - tank.y);
    return da - db;
  })[0];
  if (tank.ai <= 0) {
    const chase = Math.random() > 0.32;
    if (chase) {
      const dx = (targetPlayer?.alive ? targetPlayer.x : targetBase.x) - tank.x;
      const dy = (targetPlayer?.alive ? targetPlayer.y : targetBase.y) - tank.y;
      tank.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
    } else {
      tank.dir = ["up", "down", "left", "right"][Math.floor(Math.random() * 4)];
    }
    tank.ai = 0.55 + Math.random() * 1.2;
  }
  moveTank(tank, tank.dir, dt);
  if (Math.random() < dt * 0.72) fire(tank);
}

function hitTank(tank, bullet) {
  if (tank.invuln > 0) return false;
  tank.hp -= 1;
  burst(bullet.x, bullet.y, "#f5f0d0", 8);
  if (tank.hp > 0) {
    sfx.hit();
    hitRumble();
    return true;
  }
  tank.alive = false;
  sfx.boom();
  hitRumble();
  burst(tank.x + 14, tank.y + 14, tank.color, 28);
  if (tank.enemy) {
    score += tank.kind === "armor" ? 400 : tank.kind === "fast" ? 200 : 100;
    teachAis("kill", 1);
    if (Math.random() > 0.84) bonuses.push({ x: tank.x, y: tank.y, w: 28, h: 28, type: Math.random() > 0.5 ? "star" : "freeze", ttl: 7 });
  } else {
    teachAis(tank.kind === "player" ? "ally-hit" : "self-hit", -1);
    if (tank.kind === "player") {
      if (lives !== Infinity) lives--;
      if (lives >= 0) {
        player = makeTank("player", 8 * TILE + 2, 22 * TILE + 2);
        player.invuln = 2.4;
      } else if (!player2?.alive) {
        endGame(false);
      }
    } else {
      if (lives2 !== Infinity) lives2--;
      if (lives2 >= 0) {
        player2 = makeTank("player2", 16 * TILE + 2, 22 * TILE + 2);
        player2.invuln = 2.4;
      } else if (!player?.alive) {
        endGame(false);
      }
    }
  }
  return true;
}

function damageBase() {
  if (!baseAlive) return;
  baseAlive = false;
  for (let y = 22; y <= 23; y++) {
    for (let x = 12; x <= 13; x++) if (tileAt(x, y) === "E") setTile(x, y, ".");
  }
  burst(baseRect.x + baseRect.w / 2, baseRect.y + baseRect.h / 2, colors.gold, 56);
  sfx.boom();
  teachAis("base-danger", -1);
  endGame(false);
}

function tileInBaseGuard(x, y) {
  return x >= 11 && x <= 14 && y >= 21 && y <= 23;
}

function aiShotSafe(tank) {
  const d = DIRS[tank.dir];
  let x = tank.x + tank.w / 2;
  let y = tank.y + tank.h / 2;
  for (let i = 0; i < 28; i++) {
    x += d.x * TILE * 0.5;
    y += d.y * TILE * 0.5;
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return true;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = tileAt(tx, ty);
    if (tileInBaseGuard(tx, ty) && (t === "B" || t === "E")) return false;
    if (t === "S" || t === "B" || t === "E" || t === "W") return true;
    if ([player, player2].some((ally) => ally?.alive && ally !== tank && rects({ x: x - 8, y: y - 8, w: 16, h: 16 }, ally.box()))) return false;
    if (enemies.some((enemy) => enemy.alive && rects({ x: x - 3, y: y - 3, w: 6, h: 6 }, enemy.box()))) return true;
  }
  return true;
}

function updateBullets(dt) {
  for (const b of bullets) {
    const d = DIRS[b.dir];
    b.x += d.x * b.speed * dt;
    b.y += d.y * b.speed * dt;
    const box = { x: b.x, y: b.y, w: b.w, h: b.h };
    if (box.x < 0 || box.y < 0 || box.x > canvas.width || box.y > canvas.height) b.dead = true;
    for (const tile of solidTiles(box)) {
      b.dead = true;
      if (tile.t === "B") setTile(tile.x, tile.y, ".");
      if (tile.t === "E") damageBase();
      burst(b.x, b.y, tile.t === "S" ? colors.steel : tile.t === "E" ? colors.gold : colors.brick, 8);
      sfx.hit();
      break;
    }
    for (const other of bullets) {
      if (other !== b && other.enemy !== b.enemy && rects(box, other)) {
        b.dead = true;
        other.dead = true;
        burst(b.x, b.y, colors.bullet, 6);
      }
    }
    const targets = b.enemy ? [player, player2] : enemies;
    for (const t of targets) {
      if (t?.alive && rects(box, t.box())) {
        b.dead = hitTank(t, b);
        break;
      }
    }
  }
  bullets = bullets.filter((b) => !b.dead);
}

function burst(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 30 + Math.random() * 140;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.3 + Math.random() * 0.35, color });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
}

function collectBonuses(dt) {
  for (const b of bonuses) {
    b.ttl -= dt;
    const collector = [player, player2].find((tank) => tank?.alive && rects(tank.box(), b));
    if (collector) {
      b.dead = true;
      score += 500;
      if (b.type === "star") {
        collector.fireDelay = 0.32;
        collector.maxBullets = 2;
        collector.speed = 146;
      } else {
        freezeClock = 5;
      }
      sfx.power();
    }
  }
  bonuses = bonuses.filter((b) => !b.dead && b.ttl > 0);
}

function endGame(win) {
  state = "over";
  overlay.classList.remove("hidden");
  ui.overlayTitle.textContent = win ? "STAGE CLEAR" : "GAME OVER";
  ui.overlayPrompt.textContent = "按 Enter / Xbox Start 重新开始";
  ui.overlayHelp.textContent = `得分 ${String(score).padStart(6, "0")}`;
}

function nextStage() {
  stageIndex = (stageIndex + 1) % stages.length;
  loadStage();
  sfx.start();
}

function aiContext(tank) {
  return {
    tank,
    enemies,
    friends: [player, player2].filter((t) => t?.alive && t !== tank),
    bullets,
    base: { ...baseRect },
  };
}

function updateAlly(tank, dt, ai, humanDir, humanFire, autoControlled) {
  if (!tank?.alive) return;
  if (autoControlled && ai) {
    const action = ai.decide(aiContext(tank), dt);
    if (action.dir) moveTank(tank, action.dir, dt);
    if (action.fire && aiShotSafe(tank)) fire(tank, true);
  } else {
    if (humanDir) moveTank(tank, humanDir, dt);
    if (humanFire) fire(tank);
  }
  tank.cooldown = Math.max(0, tank.cooldown - dt);
  tank.invuln = Math.max(0, tank.invuln - dt);
}

function update(dt) {
  if (state !== "playing") return;
  if (p1InputActive()) {
    p1Idle = 0;
    p1Auto = false;
  } else {
    p1Idle += dt;
    if (p1Idle >= P1_AUTO_SECONDS) p1Auto = true;
  }
  p2Human = p2InputActive();
  updateAlly(player, dt, ai1, inputDir(), KEYS.has("Space") || padPressed(0) || padPressed(5), p1Auto);
  updateAlly(player2, dt, ai2, p2InputDir(), KEYS.has("KeyU"), !p2Human);
  spawnEnemy(dt);
  baseDangerClock -= dt;
  if (baseDangerClock <= 0 && enemies.some((enemy) => Math.abs(enemy.x - baseRect.x) + Math.abs(enemy.y - baseRect.y) < 340)) {
    teachAis("base-danger", 0.45);
    baseDangerClock = 2;
  }
  freezeClock = Math.max(0, freezeClock - dt);
  if (freezeClock <= 0) {
    for (const e of enemies) {
      e.cooldown = Math.max(0, e.cooldown - dt);
      enemyAi(e, dt);
    }
  }
  updateBullets(dt);
  updateParticles(dt);
  collectBonuses(dt);
  enemies = enemies.filter((e) => e.alive);
  shake = Math.max(0, shake - dt);
  if (baseAlive && enemiesLeft <= 0 && enemies.length === 0) nextStage();
  updateUi();
}

function drawTile(t, x, y) {
  const px = x * TILE;
  const py = y * TILE;
  if (t === "B") {
    ctx.fillStyle = colors.brick;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = colors.brickDark;
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(px, py + i * 8 + 6, TILE, 2);
      ctx.fillRect(px + (i % 2 ? 16 : 0), py + i * 8, 2, 8);
    }
  } else if (t === "S") {
    ctx.fillStyle = colors.steel;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = colors.steelDark;
    ctx.fillRect(px + 4, py + 4, 24, 24);
    ctx.fillStyle = colors.steel;
    ctx.fillRect(px + 9, py + 9, 14, 14);
  } else if (t === "W") {
    ctx.fillStyle = colors.water;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = "#6fb6e8";
    ctx.fillRect(px + 4, py + 8, 12, 3);
    ctx.fillRect(px + 15, py + 20, 12, 3);
  } else if (t === "F") {
    ctx.fillStyle = colors.forest;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = "#3f9d4a";
    ctx.fillRect(px + 5, py + 5, 7, 7);
    ctx.fillRect(px + 18, py + 8, 8, 8);
    ctx.fillRect(px + 9, py + 20, 10, 7);
  }
}

function drawBase() {
  const x = baseRect.x;
  const y = baseRect.y;
  if (!baseAlive) {
    ctx.fillStyle = "#4b4037";
    ctx.fillRect(x + 5, y + 30, 54, 23);
    ctx.fillStyle = "#1c1a18";
    ctx.fillRect(x + 10, y + 36, 12, 8);
    ctx.fillRect(x + 30, y + 31, 15, 13);
    ctx.fillRect(x + 47, y + 41, 10, 8);
    ctx.fillStyle = "#8b392e";
    ctx.fillRect(x + 18, y + 26, 8, 8);
    ctx.fillRect(x + 39, y + 24, 7, 7);
    return;
  }

  ctx.fillStyle = "#b98b4a";
  ctx.fillRect(x + 14, y + 26, 36, 30);
  ctx.fillStyle = "#f0d48a";
  ctx.fillRect(x + 22, y + 12, 20, 42);
  ctx.fillRect(x + 10, y + 26, 44, 12);
  ctx.fillStyle = "#7a4b28";
  ctx.fillRect(x + 22, y + 22, 20, 7);
  ctx.fillRect(x + 27, y + 32, 10, 18);
  ctx.fillStyle = "#101014";
  ctx.fillRect(x + 15, y + 17, 9, 7);
  ctx.fillRect(x + 40, y + 17, 9, 7);
  ctx.fillStyle = colors.gold;
  ctx.fillRect(x + 28, y + 7, 8, 10);
}

function drawTank(t) {
  if (!t.alive) return;
  if (t.invuln > 0 && Math.floor(performance.now() / 90) % 2 === 0) return;
  const x = Math.round(t.x);
  const y = Math.round(t.y);
  ctx.fillStyle = "#111";
  ctx.fillRect(x, y + 2, 7, 24);
  ctx.fillRect(x + 21, y + 2, 7, 24);
  ctx.fillStyle = t.color;
  ctx.fillRect(x + 5, y + 4, 18, 20);
  ctx.fillStyle = "#2a2920";
  ctx.fillRect(x + 9, y + 8, 10, 12);
  ctx.fillStyle = t.color;
  const cx = x + 14;
  const cy = y + 14;
  if (t.dir === "up") ctx.fillRect(cx - 3, y - 4, 6, 16);
  if (t.dir === "down") ctx.fillRect(cx - 3, y + 16, 6, 16);
  if (t.dir === "left") ctx.fillRect(x - 4, cy - 3, 16, 6);
  if (t.dir === "right") ctx.fillRect(x + 16, cy - 3, 16, 6);
}

function draw() {
  ctx.save();
  ctx.fillStyle = "#080808";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (shake > 0) ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const t = map[y]?.[x];
      if (t !== "F" && t !== "E") drawTile(t, x, y);
    }
  }
  drawBase();
  for (const b of bonuses) {
    ctx.fillStyle = b.type === "star" ? colors.gold : colors.ice;
    ctx.fillRect(b.x + 2, b.y + 2, 24, 24);
    ctx.fillStyle = "#101014";
    ctx.fillRect(b.x + 12, b.y + 6, 4, 16);
    ctx.fillRect(b.x + 6, b.y + 12, 16, 4);
  }
  drawTank(player);
  drawTank(player2);
  enemies.forEach(drawTank);
  ctx.fillStyle = colors.bullet;
  bullets.forEach((b) => ctx.fillRect(Math.round(b.x), Math.round(b.y), b.w, b.h));
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) if (map[y]?.[x] === "F") drawTile("F", x, y);
  }
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life * 3, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 4, 4);
  }
  ctx.globalAlpha = 1;
  if (freezeClock > 0) {
    ctx.fillStyle = "rgba(120, 210, 230, 0.13)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

function loop(time) {
  const dt = Math.min(0.033, (time - lastTime) / 1000 || 0);
  lastTime = time;
  if (document.hidden) {
    requestAnimationFrame(loop);
    return;
  }
  refreshPad();
  if ((state === "title" || state === "over") && (padJustPressed(9) || padJustPressed(0))) startGame();
  if (state === "playing" && padJustPressed(9)) state = "paused";
  else if (state === "paused" && padJustPressed(9)) state = "playing";
  pressed.clear();
  update(dt);
  draw();
  padPrev = padNow.slice();
  requestAnimationFrame(loop);
}

function runHiddenStep() {
  if (!document.hidden || state !== "playing") return;
  refreshPad();
  update(0.1);
  padPrev = padNow.slice();
}

function syncBackgroundLoop() {
  if (document.hidden) {
    if (!hiddenTimer) hiddenTimer = setInterval(runHiddenStep, 100);
  } else {
    if (hiddenTimer) {
      clearInterval(hiddenTimer);
      hiddenTimer = null;
    }
    lastTime = performance.now();
    draw();
  }
}

function titleStartRequested(e) {
  return e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space";
}

window.addEventListener("keydown", (e) => {
  if (!KEYS.has(e.code)) pressed.add(e.code);
  KEYS.add(e.code);
  if ((state === "title" || state === "over") && titleStartRequested(e)) {
    ui.overlayTitle.textContent = "FC TANK BATTLE";
    ui.overlayPrompt.textContent = "按 Enter / Xbox Start 开始";
    ui.overlayHelp.textContent = "1P 方向键/WASD + Space，2P IJKL + U；无人操作会由 AI 托管";
    startGame();
  }
  if (e.code === "KeyP" && (state === "playing" || state === "paused")) state = state === "playing" ? "paused" : "playing";
  if (state === "paused" && titleStartRequested(e)) state = "playing";
});

window.addEventListener("keyup", (e) => KEYS.delete(e.code));
window.addEventListener("gamepadconnected", (e) => {
  gamepadIndex = e.gamepad.index;
  ui.pad.textContent = "XBOX";
});
window.addEventListener("gamepaddisconnected", () => {
  gamepadIndex = null;
  ui.pad.textContent = "键盘";
});
document.addEventListener("visibilitychange", syncBackgroundLoop);

loadStage();
draw();
requestAnimationFrame(loop);
