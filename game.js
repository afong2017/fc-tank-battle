// @ts-check

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("game"));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
const overlay = /** @type {HTMLElement} */ (document.getElementById("overlay"));
const ui = {
  score: document.getElementById("score"),
  score2: document.getElementById("score2"),
  stage: document.getElementById("stage"),
  version: document.getElementById("version"),
  time: document.getElementById("time"),
  trainTime: document.getElementById("trainTime"),
  trainGames: document.getElementById("trainGames"),
  aiEvolution: document.getElementById("aiEvolution"),
  aiWeights: document.getElementById("aiWeights"),
  hotUpgradeStatus: document.getElementById("hotUpgradeStatus"),
  aiVersionInfo: document.getElementById("aiVersionInfo"),
  lives: document.getElementById("lives"),
  p1Deaths: document.getElementById("p1Deaths"),
  p2Deaths: document.getElementById("p2Deaths"),
  enemy: document.getElementById("enemy"),
  enemyBar: document.getElementById("enemyBar"),
  killsTotal: document.getElementById("killsTotal"),
  pad: document.getElementById("pad"),
  p1mode: document.getElementById("p1mode"),
  p2mode: document.getElementById("p2mode"),
  p1LivesStart: /** @type {HTMLSelectElement} */ (document.getElementById("p1LivesStart")),
  p2LivesStart: /** @type {HTMLSelectElement} */ (document.getElementById("p2LivesStart")),
  autoUpgradeOption: document.getElementById("autoUpgradeOption"),
  autoUpgradeValue: document.getElementById("autoUpgradeValue"),
  aiTrainOption: document.getElementById("aiTrainOption"),
  aiTrainValue: document.getElementById("aiTrainValue"),
  hotUpgradeOption: document.getElementById("hotUpgradeOption"),
  hotUpgradeValue: document.getElementById("hotUpgradeValue"),
  stageOption: document.getElementById("stageOption"),
  stageSelectValue: document.getElementById("stageSelectValue"),
  stagePrev: document.getElementById("stagePrev"),
  stageNext: document.getElementById("stageNext"),
  startButton: document.getElementById("startButton"),
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
const P1_AUTO_SECONDS = 3;
const LIFE_MIN = 3;
const LIFE_MAX = 100;
const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.033;
const TRAINING_STATS_KEY = "fc-tank-battle.ai-training-stats.v2";
const OLD_TRAINING_STATS_KEY = "fc-tank-battle.ai-training-stats.v1";
const TRAINING_AUTO_ARMED_KEY = "fc-tank-battle.training-auto-armed";
const HOT_UPGRADE_KEY = "fc-tank-battle.hot-upgrade";
const ENEMY_BAR_SLOTS = 20;
const TANK_TURN_DELAY = 0.3;
const MAX_TANK_SPEED = {
  player: 105,
  player2: 105,
  basic: 72,
  fast: 105,
  armor: 58,
};

let audio;
let gamepadIndex = null;
let padNow = [];
let padPrev = [];
let padAxes = [0, 0];
let menuRepeat = {
  x: { dir: 0, wait: 0 },
  y: { dir: 0, wait: 0 },
};
let lastTime = 0;
let updateAccumulator = 0;
let moveFrameId = 0;
let state = "title";
let score = 0;
let score2 = 0;
let gameTime = 0;
let trainingStats = loadTrainingStats();
let lives = 3;
let lives2 = 3;
let p1Deaths = 0;
let p2Deaths = 0;
let killStats = { basic: 0, fast: 0, armor: 0 };
let stageIndex = 0;
let selectedStageIndex = 0;
let completedLoops = 0;
let gameVersion = 1;
let gameVersionLabel = "CODEX";
let lastAiVersionText = "";
let autoUpgradeEnabled = false;
let aiTrainingEnabled = true;
let hotUpgradeEnabled = true;
let enemiesLeft = 20;
let stageEnemyDefeated = 0;
let stageCompleted = false;
let lastEnemyMeterSlots = -1;
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
  enemy: "#7f8d78",
  fast: "#8f9d86",
  armor: "#6f7d6b",
  bullet: "#f5f0d0",
};

function populateLifeSelect(select) {
  if (!select) return;
  const selected = select.value || "Infinity";
  select.innerHTML = "";
  for (let value = LIFE_MIN; value <= LIFE_MAX; value++) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    select.appendChild(option);
  }
  const forever = document.createElement("option");
  forever.value = "Infinity";
  forever.textContent = "∞";
  select.appendChild(forever);
  select.value = selected === "Infinity" ? selected : String(clamp(Number(selected) || LIFE_MIN, LIFE_MIN, LIFE_MAX));
}

populateLifeSelect(ui.p1LivesStart);
populateLifeSelect(ui.p2LivesStart);

function loadTrainingStats() {
  if (/^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname)) {
    return { seconds: 0, games: 0 };
  }
  try {
    localStorage.removeItem(OLD_TRAINING_STATS_KEY);
    const saved = JSON.parse(localStorage.getItem(TRAINING_STATS_KEY)) || {};
    return {
      seconds: Math.max(0, Number(saved.seconds) || 0),
      games: Math.max(0, Math.floor(Number(saved.games) || 0)),
    };
  } catch {
    return { seconds: 0, games: 0 };
  }
}

function resetAiTrainingDisplay() {
  trainingStats = { seconds: 0, games: 0 };
  saveTrainingStats();
  window.TankPartnerAI?.resetMemory?.();
  updateUi();
}

function saveTrainingStats() {
  if (/^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname)) return;
  try {
    localStorage.setItem(TRAINING_STATS_KEY, JSON.stringify({
      seconds: trainingStats.seconds,
      games: trainingStats.games,
    }));
  } catch {
    // Training stats are optional; gameplay continues if storage is blocked.
  }
}

function formatTrainingTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function aiEvolutionSnapshot() {
  const memory = window.TankPartnerAI?.readMemory?.();
  const keys = ["defend", "survive", "attack", "clear"];
  const sourceWeights = /** @type {Record<string, unknown>} */ (memory?.weights || {});
  const weights = Object.fromEntries(keys.map((key) => [key, Number.isFinite(Number(sourceWeights[key])) ? Number(sourceWeights[key]) : 0]));
  const values = Object.values(weights).filter(Number.isFinite);
  const level = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return { level, weights, memory };
}

function formatAiWeight(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function aiShortCode(value, fallback = "OK") {
  const text = String(value || fallback).toUpperCase();
  const map = {
    BASE_LOCKDOWN: "BASE LOCK",
    MIDLINE_LOCK: "MID LOCK",
    UNSTUCK_CLEAR: "UNSTUCK",
    DODGE_FOCUS: "DODGE",
    BASE_HIT: "BASE HIT",
    ALLY_STUCK: "STUCK",
    ROUTE_CLEAR_FAILED: "ROUTE",
    TARGET_STALE: "STALE",
    ALLY_DEATH: "DEATH",
    ENEMY_CROSS_MIDLINE: "MIDLINE",
    DODGE_FAILED: "DODGE FAIL",
    FRIENDLY_FIRE: "FRIEND HIT",
    KILLCONFIRM: "KILL",
    LANEBLOCK: "LANE",
    PANICGUARD: "GUARD",
    DODGEDISCIPLINE: "DODGE",
    CLEARAGGRESSION: "CLEAR",
    TARGETPATIENCE: "LOCK",
    BASE: "BASE",
  };
  return map[text] || text.replace(/_/g, " ");
}

function mirrorRow(left) {
  const half = (left + ".............").slice(0, COLS / 2);
  return half + half.split("").reverse().join("");
}

function putSegment(row, start, segment) {
  const cells = row.split("");
  for (let i = 0; i < segment.length; i++) {
    const x = start + i;
    if (x >= 0 && x < COLS) cells[x] = segment[i];
  }
  return cells.join("");
}

function addCenterDefense(rows, variant) {
  const commonPattern = [
    [2, 10, "B....B"],
    [3, 12, "BB"],
    [4, 11, "BSSB"],
    [5, 12, "SS"],
    [6, 10, "WW..WW"],
    [7, 10, "BB..BB"],
    [8, 11, "BBBB"],
    [9, 11, "SSSS"],
    [10, 12, "BB"],
    [11, 10, "BB..BB"],
    [12, 9, "BB....BB"],
    [13, 11, "WWWW"],
    [14, 11, "BSSB"],
    [15, 10, "BBBBBB"],
    [16, 9, "BSS..SSB"],
    [17, 11, "FFFF"],
    [18, 10, "BBBBBB"],
    [19, 10, "SS..SS"],
    [20, 10, "BB..BB"],
  ];
  const patterns = [
    [
      [3, 10, "BB..BB"],
      [5, 11, "SSSS"],
      [8, 9, "BB....BB"],
      [10, 10, "WW..WW"],
      [12, 11, "BBBB"],
      [15, 10, "FF..FF"],
      [17, 11, "SSSS"],
      [19, 9, "BB......BB"],
    ],
    [
      [3, 11, "BBBB"],
      [6, 9, "WW....WW"],
      [8, 10, "SS..SS"],
      [11, 11, "FFFF"],
      [13, 10, "BB..BB"],
      [15, 9, "SS......SS"],
      [18, 11, "BBBB"],
      [20, 10, "BB..BB"],
    ],
    [
      [4, 9, "SS......SS"],
      [6, 11, "BBBB"],
      [9, 10, "FF..FF"],
      [11, 9, "WW......WW"],
      [13, 11, "SSSS"],
      [16, 10, "BBBBBB"],
      [18, 9, "BB......BB"],
      [20, 11, "BB.."],
    ],
  ];
  const guarded = rows.slice();
  for (const [y, x, segment] of commonPattern) {
    guarded[y] = putSegment(guarded[y], x, segment);
  }
  for (const [y, x, segment] of patterns[variant % patterns.length]) {
    guarded[y] = putSegment(guarded[y], x, segment);
  }
  return guarded;
}

let generatedStageCount = 0;

function makeStage(leftRows) {
  const variant = generatedStageCount;
  generatedStageCount = variant + 1;
  return addCenterDefense(leftRows.map(mirrorRow), variant);
}

const stages = [
  makeStage([
    ".............",
    "...B..B..B..",
    "...B..B..B..",
    "....WW...BB.",
    "....WW...B..",
    "..BBBB..SS..",
    ".....FF.....",
    "..SS..BBBB.F",
    "......B.....",
    "BBB...B..SS.",
    "......B..WW.",
    "..FF..BBB.W.",
    "..FF........",
    "......B..BBB",
    "BBB...B..SS.",
    "......B.....",
    "..SS..BBBB..",
    ".....FFFF...",
    "....BBBB....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "..BBBB..SS..",
    "..B..B......",
    "..B..B..WWWW",
    "........W...",
    "BBBBBB..W.SS",
    "........W...",
    "..SS....WWWW",
    "......FF....",
    "BBBB..FF..BB",
    "......FF..B.",
    "..WWWW...SS.",
    "..W..W..BBBB",
    "..WWWW......",
    "........SS..",
    "..BBBB...FF.",
    "..B..B..SS.F",
    "..B..B...FF.",
    "......BBBB..",
    "..SS........",
    "...........BB",
    "....BBBB...BE",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "BBBB....BBBB.",
    "B..B....B..B.",
    "B..B..SSB..B.",
    "......SS.....",
    "..WWWW....WW.",
    "..W......FF..",
    "..W..BBBBFF..",
    ".....B.......",
    "SS...B..SS...",
    ".....B..WW...",
    "..BBBB..WW..B",
    "..B.........B",
    "..B..FFFF...B",
    "..B..F..F...B",
    ".....F..F....",
    "..SS.BBBB.SS.",
    "......BB.....",
    "....BBBB....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "..SS....SS..",
    "..SS.BB.SS..",
    ".....BB.....",
    "BBBB....BBBB",
    "B..B.WW.B..B",
    "B..B.WW.B..B",
    "....FFFF....",
    "..BBBBBBBB..",
    "..B......B..",
    "....SSSS....",
    "WW..S..S..WW",
    "WW........WW",
    "....BBBB....",
    "BB..B..B..BB",
    "....B..B....",
    "..SS....SS..",
    "......FF....",
    "....BBBB....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "....BBBB....",
    "..SSB..BSS..",
    "....B..B....",
    "WWWW....WWWW",
    "W......FF..W",
    "W..BBBBFF..W",
    "......B.....",
    "BBBB..B..BBB",
    "......B.....",
    "..SS..B..SS.",
    "..WW.....WW.",
    "..WW.BBB.WW.",
    ".....B.B....",
    "BBBB.B.B.BBB",
    ".....B.B....",
    "..FF.....FF.",
    "..FF..SS.FF.",
    "....BBBB....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "..B..B..B..B",
    "..B..B..B..B",
    "..B..SS..B..",
    "..B......B..",
    "SSB.BBBB.BSS",
    ".....WW.....",
    "FFFF.WW.FFFF",
    ".....WW.....",
    "BBB..BB..BBB",
    "..B......B..",
    "..B..SS..B..",
    "..B..SS..B..",
    "BBB......BBB",
    "....FFFF....",
    "..SS....SS..",
    "....BBBB....",
    "....B..B....",
    "..BBBBBB....",
    "..B.........",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "SSSS....SSSS.",
    "S..S....S..S.",
    "....BBBB.....",
    "....B..B.....",
    "WW..B..B..WW.",
    "WW........WW.",
    "..FFFFFFFF...",
    "..F......F...",
    "BBB..SS..BBB.",
    "..B..SS..B...",
    "..B......B...",
    "..BBBBBBBB...",
    ".......WW....",
    "BBBB...WW.BBB",
    "B..B......B..",
    "B..B..SS..B..",
    "......SS.....",
    "....BBBB....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "BBBBBBBB....",
    "B......B....",
    "B.SS...B.WW.",
    "B.SS...B.WW.",
    "B....FFB....",
    "BBBB.FFBBBB.",
    ".....FF.....",
    "..WW....WW..",
    "..WW.SS.WW..",
    ".....SS.....",
    "BBBB....BBBB",
    "B..B....B..B",
    "B..B.FF.B..B",
    "....FF......",
    "..SS....SS..",
    "....BBBB....",
    "..BBBBBB....",
    "..B.........",
    "..B.........",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "...WW....WW.",
    "...WW....WW.",
    "BBBB..SS..BB",
    "B..B..SS..B.",
    "B..B......B.",
    "....FFFFFF..",
    "SS..F....FSS",
    "....F....F..",
    "BBBBF.BB.FBB",
    "....F.BB.F..",
    "..WWF....FWW",
    "..WWFFFFFFWW",
    "............",
    "BBBB....BBBB",
    "B..B.SS.B..B",
    "B..B....B..B",
    "....BBBB....",
    "....B..B....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "BB..SS..SS..",
    "BB..SS..SS..",
    "..WW....WW..",
    "..WW.BB.WW..",
    ".....BB.....",
    "FFFF....FFFF",
    "F..F.BB.F..F",
    "F..F.BB.F..F",
    "....BBBB....",
    "..SS....SS..",
    "..SS.WW.SS..",
    ".....WW.....",
    "BBBB....BBBB",
    "B..B....B..B",
    "B..B.FF.B..B",
    "....FF......",
    "....BBBB....",
    "..BBBBBB....",
    "..B.........",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "S.S.S.S.S.S.",
    ".............",
    "BBBBBBBBBBBB",
    "B..........B",
    "B.WW....WW.B",
    "B.WW.SS.WW.B",
    "B....SS....B",
    "B.FFFFFF...B",
    "B.F....F...B",
    "B.F.BB.F...B",
    "B.F.BB.F...B",
    "B.F....F...B",
    "B.FFFFFF...B",
    "B....SS....B",
    "B....SS....B",
    "BBBB....BBBB",
    "....BBBB....",
    "....B..B....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
  makeStage([
    ".............",
    "BBBB..SS..BB",
    "B..B..SS..B.",
    "B..B......B.",
    "B..B.WWWW.B.",
    "....W..W....",
    "SS..W..W..SS",
    "....WWWW....",
    "FFFF....FFFF",
    "F..F.BB.F..F",
    "F..F.BB.F..F",
    "....BBBB....",
    "..WW....WW..",
    "..WW.SS.WW..",
    ".....SS.....",
    "BBBB....BBBB",
    "B..B.FF.B..B",
    "B..B.FF.B..B",
    "....BBBB....",
    "....B.......",
    "..B.B.......",
    "...........BB",
    "...........BE",
    "...........BE",
  ]),
];

function shiftRow(row, amount) {
  const a = ((amount % COLS) + COLS) % COLS;
  return row.slice(a) + row.slice(0, a);
}

function mutateStage(stage, variant) {
  const rows = stage.map((row, y) => {
    if (y >= 21) return row;
    let next = row;
    if (variant % 2 === 1) next = next.replace(/\./g, (c, i) => (i % 11 === y % 5 ? "B" : c));
    if (variant % 3 === 0) next = next.replace(/F/g, "B").replace(/W/g, "F");
    if (variant % 4 === 0) next = next.replace(/B/g, (c, i) => (i % 5 === 0 ? "S" : c));
    if (variant % 5 === 0 && y > 2 && y < 18) next = shiftRow(next, variant % 7 - 3);
    return next.replace(/E/g, ".");
  });
  return addCenterDefense(rows, variant);
}

function buildThirtyFiveStages() {
  const base = stages.slice();
  let variant = 1;
  while (stages.length < 35) {
    stages.push(mutateStage(base[stages.length % base.length], variant));
    variant++;
  }
}

buildThirtyFiveStages();

function createEmptyStage() {
  return Array.from({ length: ROWS }, () => ".".repeat(COLS).split(""));
}

function stageToRows(grid) {
  return grid.map((row) => row.join(""));
}

function paint(grid, x, y, w, h, tile) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx >= 0 && xx < COLS && yy >= 0 && yy < ROWS) grid[yy][xx] = tile;
    }
  }
}

function paintMirror(grid, x, y, w, h, tile) {
  paint(grid, x, y, w, h, tile);
  paint(grid, COLS - x - w, y, w, h, tile);
}

function paintLine(grid, x1, y1, x2, y2, tile) {
  if (x1 === x2) {
    const a = Math.min(y1, y2);
    const b = Math.max(y1, y2);
    for (let y = a; y <= b; y++) paint(grid, x1, y, 1, 1, tile);
  } else if (y1 === y2) {
    const a = Math.min(x1, x2);
    const b = Math.max(x1, x2);
    for (let x = a; x <= b; x++) paint(grid, x, y1, 1, 1, tile);
  }
}

function clearCriticalZones(grid) {
  paint(grid, 0, 0, 2, 2, ".");
  paint(grid, 12, 0, 2, 2, ".");
  paint(grid, 24, 0, 2, 2, ".");
  paint(grid, 7, 21, 4, 3, ".");
  paint(grid, 15, 21, 4, 3, ".");
}

function paintBase(grid) {
  paint(grid, 11, 21, 4, 1, "B");
  paint(grid, 11, 22, 1, 2, "B");
  paint(grid, 14, 22, 1, 2, "B");
  paint(grid, 12, 22, 2, 2, "E");
}

function addClassicColumns(grid, seed) {
  const columns = [2, 5, 8, 17, 20, 23];
  for (const x of columns) {
    for (let y = 3; y <= 17; y += 4) {
      if ((x + y + seed) % 3 !== 0) paint(grid, x, y, 1, 3, "B");
    }
  }
  paintMirror(grid, 4, 2, 2, 2, "B");
  paintMirror(grid, 7, 8, 2, 3, "B");
  paintMirror(grid, 3, 15, 3, 2, "B");
}

function addFortress(grid, seed) {
  paintMirror(grid, 3, 3, 4, 1, "B");
  paintMirror(grid, 3, 4, 1, 4, "B");
  paintMirror(grid, 5, 6, 2, 2, seed % 2 ? "S" : "B");
  paint(grid, 9, 5, 3, 1, "B");
  paint(grid, 14, 5, 3, 1, "B");
  paint(grid, 9, 13, 3, 1, "B");
  paint(grid, 14, 13, 3, 1, "B");
  paint(grid, 10, 6, 1, 3, "B");
  paint(grid, 15, 6, 1, 3, "B");
  paint(grid, 10, 11, 1, 2, "B");
  paint(grid, 15, 11, 1, 2, "B");
  paint(grid, 12, 8, 2, 2, "S");
}

function addRiver(grid, seed) {
  const y = 5 + (seed % 4) * 2;
  paint(grid, 4, y, 18, 2, "W");
  paint(grid, 11, y - 1, 4, 4, ".");
  paintMirror(grid, 2, y + 3, 4, 1, "B");
  paintMirror(grid, 6, y + 5, 2, 3, "S");
  paint(grid, 11, 15, 4, 2, "W");
}

function addForestScreen(grid, seed) {
  paintMirror(grid, 1, 6, 5, 2, "F");
  paintMirror(grid, 4, 11, 4, 3, "F");
  paint(grid, 10, 3 + (seed % 3), 2, 2, "F");
  paint(grid, 14, 3 + (seed % 3), 2, 2, "F");
  paint(grid, 9, 17, 3, 1, "F");
  paint(grid, 14, 17, 3, 1, "F");
}

function addSteelGates(grid, seed) {
  paint(grid, 11, 2, 4, 1, "S");
  paint(grid, 11, 6, 4, 1, seed % 2 ? "B" : "S");
  paint(grid, 11, 10, 4, 1, "S");
  paint(grid, 11, 14, 4, 1, seed % 3 ? "B" : "S");
  paintMirror(grid, 6, 4, 2, 2, "S");
  paintMirror(grid, 7, 16, 2, 2, "S");
}

function addMazeBands(grid, seed) {
  for (let y = 3; y <= 18; y += 3) {
    const leftGap = 4 + ((seed + y) % 5);
    paint(grid, 1, y, 24, 1, "B");
    paint(grid, leftGap, y, 3, 1, ".");
    paint(grid, COLS - leftGap - 3, y, 3, 1, ".");
  }
  paintMirror(grid, 3, 5, 2, 5, "B");
  paintMirror(grid, 8, 9, 1, 6, "S");
}

function addCenterDefenseFc(grid, seed) {
  const common = [
    [10, 3, 2, 1, "B"],
    [14, 3, 2, 1, "B"],
    [11, 6, 4, 1, seed % 2 ? "B" : "S"],
    [9, 9, 3, 1, "B"],
    [14, 9, 3, 1, "B"],
    [11, 12, 4, 1, seed % 3 ? "F" : "W"],
    [10, 15, 2, 1, "B"],
    [14, 15, 2, 1, "B"],
    [11, 18, 4, 1, "B"],
  ];
  for (const [x, y, w, h, tile] of common) paint(grid, x, y, w, h, tile);
  const recipes = [
    [[12, 5, 2, 1, "S"], [10, 10, 2, 1, "B"], [14, 10, 2, 1, "B"], [12, 16, 2, 2, "F"]],
    [[10, 4, 2, 2, "B"], [14, 4, 2, 2, "B"], [11, 11, 4, 1, "W"], [9, 17, 3, 1, "B"], [14, 17, 3, 1, "B"]],
    [[11, 4, 4, 1, "S"], [12, 8, 2, 2, "B"], [10, 13, 2, 1, "F"], [14, 13, 2, 1, "F"], [11, 17, 4, 1, "B"]],
    [[9, 5, 3, 1, "B"], [14, 5, 3, 1, "B"], [11, 9, 4, 1, "S"], [12, 14, 2, 2, "W"], [10, 18, 6, 1, "B"]],
    [[12, 4, 2, 3, "S"], [9, 9, 3, 1, "B"], [14, 9, 3, 1, "B"], [11, 13, 4, 1, "B"], [12, 17, 2, 2, "F"]],
  ];
  for (const [x, y, w, h, tile] of recipes[seed % recipes.length]) paint(grid, x, y, w, h, tile);
}

function protectBaseApproach(grid, seed) {
  paint(grid, 9, 19, 3, 1, seed % 2 ? "B" : "S");
  paint(grid, 14, 19, 3, 1, seed % 2 ? "B" : "S");
  paint(grid, 8, 20, 3, 1, "B");
  paint(grid, 15, 20, 3, 1, "B");
  paint(grid, 10, 21, 1, 3, "B");
  paint(grid, 15, 21, 1, 3, "B");
}

function openStageOneChokePoints(grid, seed) {
  if (seed !== 0) return;
  paint(grid, 8, 16, 2, 2, ".");
  paint(grid, 16, 16, 2, 2, ".");
  paint(grid, 11, 16, 4, 1, ".");
  paint(grid, 11, 17, 1, 1, ".");
  paint(grid, 14, 17, 1, 1, ".");
}

function makeFcStyleStage(seed) {
  const grid = createEmptyStage();
  const palette = seed % 7;
  if (palette === 0) addClassicColumns(grid, seed);
  if (palette === 1) addFortress(grid, seed);
  if (palette === 2) addRiver(grid, seed);
  if (palette === 3) addMazeBands(grid, seed);
  if (palette === 4) {
    addClassicColumns(grid, seed);
    addForestScreen(grid, seed);
  }
  if (palette === 5) {
    addRiver(grid, seed);
    addSteelGates(grid, seed);
  }
  if (palette === 6) {
    addFortress(grid, seed);
    addForestScreen(grid, seed);
  }
  if (seed % 3 === 0) addSteelGates(grid, seed);
  if (seed % 4 === 1) addForestScreen(grid, seed);
  addCenterDefenseFc(grid, seed);
  protectBaseApproach(grid, seed);
  openStageOneChokePoints(grid, seed);
  clearCriticalZones(grid);
  paintBase(grid);
  return stageToRows(grid);
}

function redrawStagesFcStyle() {
  stages.length = 0;
  for (let i = 0; i < 35; i++) stages.push(makeFcStyleStage(i));
}

redrawStagesFcStyle();

let map = [];
let mapVersion = 0;
let player;
let player2;
let enemies = [];
let bullets = [];
let allyFireReports = [];
let particles = [];
let bonuses = [];
let baseAlive = true;
const baseRect = { x: 12 * TILE, y: 22 * TILE, w: 2 * TILE, h: 2 * TILE };
let ai1 = null;
let ai2 = null;
let p1Idle = 0;
let p1Auto = false;
let p2Human = false;
let baseDangerClock = 0;
let midlineBreakClock = 0;
let hiddenTimer = null;
let trainingRestartTimer = null;
let trainingAutoArmed = sessionStorage.getItem(TRAINING_AUTO_ARMED_KEY) === "1";
let pendingGameUpgrade = false;
let trainingSaveClock = 0;
let menuField = 0;
let stageNumberBuffer = "";
let stageNumberClock = 0;

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
    tone(523, 0.055, "square", 0.055, 1.06);
    setTimeout(() => tone(784, 0.055, "square", 0.055, 1.06), 58);
    setTimeout(() => tone(1047, 0.09, "square", 0.05, 0.92), 116);
    setTimeout(() => tone(1568, 0.035, "square", 0.025, 0.88), 168);
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
  if (map[ty]?.[tx] === value) return;
  map[ty][tx] = value;
  mapVersion++;
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
  const difficulty = difficultyRank();
  const stats = {
    player: { speed: 105, hp: 1, fireDelay: 0.42, color: colors.player },
    player2: { speed: 105, hp: 1, fireDelay: 0.45, color: colors.player2 },
    basic: { speed: 72, hp: 1, fireDelay: 1.3, color: colors.enemy },
    fast: { speed: 105, hp: 1, fireDelay: 1.3, color: colors.fast },
    armor: { speed: 58, hp: 2, fireDelay: 1.55, color: colors.armor },
  }[kind];
  return {
    kind,
    enemy,
    x,
    y,
    w: 28,
    h: 28,
    dir: enemy ? "down" : "up",
    baseSpeed: stats.speed,
    maxSpeed: MAX_TANK_SPEED[kind] || stats.speed,
    speed: Math.min(stats.speed, MAX_TANK_SPEED[kind] || stats.speed),
    hp: enemy && kind === "armor" ? stats.hp + Math.min(3, Math.floor(difficulty / 5)) : stats.hp,
    color: stats.color,
    fireDelay: enemy ? Math.max(0.58, stats.fireDelay * (1 - Math.min(0.38, difficulty * 0.018))) : stats.fireDelay,
    maxBullets: enemy ? 1 : 2,
    alive: true,
    cooldown: enemy ? Math.random() : 0,
    ai: 0,
    stuck: 0,
    lastX: x,
    lastY: y,
    avoidDir: null,
    attackTarget: null,
    attackRoute: null,
    attackRouteTarget: null,
    attackRouteMode: null,
    lockedBaseTarget: null,
    escapeDir: null,
    escapeTime: 0,
    snapCooldown: 0,
    turnCooldown: 0,
    moveFrameId: -1,
    moveFrameDistance: 0,
    invuln: enemy ? 0 : 1.8,
    box() {
      return { x: this.x, y: this.y, w: this.w, h: this.h };
    },
  };
}

function loadStage() {
  updateAccumulator = 0;
  map = stages[stageIndex].map((row) => row.split(""));
  mapVersion++;
  enemies = [];
  bullets = [];
  particles = [];
  bonuses = [];
  enemiesLeft = Math.min(35, 20 + Math.floor(difficultyRank() * 0.55));
  stageEnemyDefeated = 0;
  stageCompleted = false;
  spawnClock = 0.2;
  freezeClock = 0;
  baseAlive = true;
  p1Idle = 0;
  p1Auto = false;
  p2Human = false;
  ai1 = window.TankPartnerAI?.createController("1P");
  ai2 = window.TankPartnerAI?.createController("2P");
  player = makeTank("player", 8 * TILE + 2, 22 * TILE + 2);
  player2 = makeTank("player2", 16 * TILE + 2, 22 * TILE + 2);
  updateUi();
}

function refreshStagePreview() {
  if (!(state === "title" || state === "over")) return;
  const preview = stages[selectedStageIndex];
  if (!preview) return;
  map = preview.map((row) => row.split(""));
  enemies = [];
  bullets = [];
  particles = [];
  bonuses = [];
  freezeClock = 0;
  shake = 0;
  baseAlive = true;
  player = makeTank("player", 8 * TILE + 2, 22 * TILE + 2);
  player2 = makeTank("player2", 16 * TILE + 2, 22 * TILE + 2);
  player.invuln = 0;
  player2.invuln = 0;
  ui.stage.textContent = String(selectedStageIndex + 1).padStart(2, "0");
  if (ui.version) ui.version.textContent = gameVersionLabel;
  stageEnemyDefeated = 0;
  updateEnemyMeter();
}

function updateEnemyMeter() {
  const remainingSlots = clamp(ENEMY_BAR_SLOTS - stageEnemyDefeated, 0, ENEMY_BAR_SLOTS);
  if (remainingSlots === lastEnemyMeterSlots) return;
  lastEnemyMeterSlots = remainingSlots;
  if (ui.enemy) ui.enemy.textContent = `${String(remainingSlots).padStart(2, "0")}/${ENEMY_BAR_SLOTS}`;
  if (!ui.enemyBar) return;
  ui.enemyBar.innerHTML = "";
  for (let i = 0; i < ENEMY_BAR_SLOTS; i++) {
    const cell = document.createElement("i");
    if (i < remainingSlots) cell.className = "active";
    ui.enemyBar.appendChild(cell);
  }
}

function updateUi() {
  ui.score.textContent = String(score).padStart(6, "0");
  if (ui.score2) ui.score2.textContent = String(score2).padStart(6, "0");
  ui.stage.textContent = String(stageIndex + 1).padStart(2, "0");
  if (ui.version) ui.version.textContent = gameVersionLabel;
  if (ui.aiVersionInfo) {
    const text = ui.aiVersionInfo.textContent || "";
    const bestStage = Math.max(0, Math.floor(Number(window.TankPartnerAI?.readMemory?.()?.highestStageCleared) || 0));
    const bestText = `      AI最高通关关卡 ${String(bestStage).padStart(2, "0")}`;
    const nextText = text.includes("AI最高通关关卡 ")
      ? text.replace(/\s+AI最高通关关卡 \d+$/, bestText)
      : `${text}${bestText}`.trim();
    if (nextText !== lastAiVersionText) {
      ui.aiVersionInfo.textContent = nextText;
      lastAiVersionText = nextText;
    }
  }
  ui.time.textContent = formatTime(gameTime);
  const aiEvolution = aiEvolutionSnapshot();
  const aiTrainingStats = window.TankPartnerAI?.readTraining?.() || trainingStats;
  if (ui.trainTime) ui.trainTime.textContent = formatTrainingTime(aiTrainingStats.seconds);
  if (ui.trainGames) ui.trainGames.textContent = String(Math.max(0, Math.floor(Number(aiTrainingStats.games) || 0))).padStart(4, "0");
  if (ui.aiEvolution) ui.aiEvolution.textContent = `LV ${formatAiWeight(aiEvolution.level)}`;
  if (ui.aiWeights) {
    const w = aiEvolution.weights;
    const memory = /** @type {Record<string, any>} */ (aiEvolution.memory || {});
    const flaw = Array.isArray(memory.lastFailures) && memory.lastFailures.length ? aiShortCode(memory.lastFailures[0], "OK") : "OK";
    const patch = Array.isArray(memory.patches) && memory.patches.length ? aiShortCode(memory.patches[0], "BASE") : "BASE";
    const evo = /** @type {Record<string, any>} */ (memory.evolution || {});
    const evoText = `E${Math.max(0, Math.floor(Number(evo.generation) || 0))}`;
    const geneText = aiShortCode(evo.active || "BASE", "BASE");
    const scoreText = Number.isFinite(Number(memory.lastScore)) ? ` P${Math.round(Number(memory.lastScore))}` : "";
    ui.aiWeights.innerHTML = `<span class="ai-param">D${formatAiWeight(w.defend)}</span><span class="ai-param">S${formatAiWeight(w.survive)}</span><span class="ai-param">A${formatAiWeight(w.attack)}</span><span class="ai-param">C${formatAiWeight(w.clear)}</span><span>${evoText}</span><span>${geneText}</span><span>${patch}</span><span>${flaw}</span><span>${scoreText.trim()}</span>`;
  }
  ui.lives.textContent = `${formatLives(lives)}/${formatLives(lives2)}`;
  ui.p1Deaths.textContent = String(p1Deaths).padStart(2, "0");
  ui.p2Deaths.textContent = String(p2Deaths).padStart(2, "0");
  updateEnemyMeter();
  ui.killsTotal.textContent = String(killStats.basic + killStats.fast + killStats.armor).padStart(2, "0");
  ui.p1mode.textContent = p1Auto ? "AI" : "人工";
  ui.p2mode.textContent = p2Human ? "人工" : "AI";
}

function updateStartOverlayText() {
  ui.overlayTitle.textContent = "FC TANK BATTLE";
  ui.overlayPrompt.textContent = aiTrainingEnabled && trainingAutoArmed ? "AI TRAIN 自动开始游戏" : "摇杆左右选菜单，上下调整，A 确认下一项，Start 开始";
  ui.overlayHelp.textContent = "1P 方向键/WASD + Space，2P IJKL + U；无人操作会由 AI 托管";
  ui.stageSelectValue.textContent = `${String(selectedStageIndex + 1).padStart(2, "0")} / ${stages.length}`;
  if (ui.autoUpgradeValue) ui.autoUpgradeValue.textContent = autoUpgradeEnabled ? "ON" : "OFF";
  if (ui.aiTrainValue) ui.aiTrainValue.textContent = aiTrainingEnabled ? "ON" : "OFF";
  if (ui.hotUpgradeValue) ui.hotUpgradeValue.textContent = hotUpgradeEnabled ? "ON" : "OFF";
  [ui.stageOption, ui.p1LivesStart?.parentElement, ui.p2LivesStart?.parentElement, ui.autoUpgradeOption, ui.aiTrainOption, ui.hotUpgradeOption, ui.startButton].forEach((el, i) => {
    el?.classList.toggle("active", i === menuField);
  });
  refreshStagePreview();
  scheduleTrainingAutoStart();
}

function scheduleTrainingAutoStart(delay = 1600) {
  if (trainingRestartTimer) {
    clearTimeout(trainingRestartTimer);
    trainingRestartTimer = null;
  }
  if (!trainingAutoArmed || !aiTrainingEnabled || !(state === "title" || state === "over")) return;
  trainingRestartTimer = setTimeout(() => {
    trainingRestartTimer = null;
    if ((state === "title" || state === "over") && aiTrainingEnabled) startGame();
  }, delay);
}

function selectNextStage() {
  selectedStageIndex = (selectedStageIndex + 1) % stages.length;
  updateStartOverlayText();
  sfx.hit();
}

function openStageMenu() {
  if (trainingRestartTimer) {
    clearTimeout(trainingRestartTimer);
    trainingRestartTimer = null;
  }
  selectedStageIndex = stageIndex % stages.length;
  state = "title";
  overlay.classList.remove("hidden");
  updateStartOverlayText();
}

function moveMenuField(delta) {
  menuField = (menuField + delta + 7) % 7;
  updateStartOverlayText();
  sfx.hit();
}

function setMenuField(index) {
  menuField = clamp(index, 0, 6);
  updateStartOverlayText();
}

function adjustLifeSelect(select, delta) {
  const current = readLifeSetting(select);
  let next;
  if (current === Infinity) {
    next = delta < 0 ? LIFE_MAX : LIFE_MIN;
  } else {
    next = current + delta;
    if (next > LIFE_MAX) next = Infinity;
    if (next < LIFE_MIN) next = Infinity;
  }
  select.value = next === Infinity ? "Infinity" : String(next);
}

function applyTrainingLifeDefaults() {
  if (!aiTrainingEnabled) return;
  if (ui.p1LivesStart) ui.p1LivesStart.value = "Infinity";
  if (ui.p2LivesStart) ui.p2LivesStart.value = "Infinity";
}

function adjustMenuValue(delta) {
  if (menuField === 0) {
    selectedStageIndex = (selectedStageIndex + delta + stages.length) % stages.length;
  } else if (menuField === 1) {
    adjustLifeSelect(ui.p1LivesStart, delta);
  } else if (menuField === 2) {
    adjustLifeSelect(ui.p2LivesStart, delta);
  } else if (menuField === 3) {
    autoUpgradeEnabled = !autoUpgradeEnabled;
  } else if (menuField === 4) {
    aiTrainingEnabled = !aiTrainingEnabled;
    applyTrainingLifeDefaults();
  } else if (menuField === 5) {
    hotUpgradeEnabled = !hotUpgradeEnabled;
    window.FCHotUpgrade?.setEnabled?.(hotUpgradeEnabled);
  }
  updateStartOverlayText();
  sfx.hit();
}

function confirmMenuField() {
  menuRepeat.x = { dir: 0, wait: 0 };
  menuRepeat.y = { dir: 0, wait: 0 };
  if (menuField < 6) {
    moveMenuField(1);
  } else {
    startGame();
  }
}

function clickAutoUpgradeOption() {
  if (menuField === 3) {
    autoUpgradeEnabled = !autoUpgradeEnabled;
    updateStartOverlayText();
    sfx.hit();
  } else {
    setMenuField(3);
  }
}

function clickAiTrainOption() {
  if (menuField === 4) {
    aiTrainingEnabled = !aiTrainingEnabled;
    applyTrainingLifeDefaults();
    updateStartOverlayText();
    sfx.hit();
  } else {
    setMenuField(4);
  }
}

function clickHotUpgradeOption() {
  if (menuField === 5) {
    hotUpgradeEnabled = !hotUpgradeEnabled;
    window.FCHotUpgrade?.setEnabled?.(hotUpgradeEnabled);
    updateStartOverlayText();
    sfx.hit();
  } else {
    setMenuField(5);
  }
}

function setSelectedStage(index) {
  selectedStageIndex = (index + stages.length) % stages.length;
  updateStartOverlayText();
  sfx.hit();
}

function appendStageDigit(digit) {
  stageNumberClock = 1.15;
  stageNumberBuffer = (stageNumberBuffer + digit).slice(-2);
  const stageNumber = clamp(Number(stageNumberBuffer) || 1, 1, stages.length);
  setSelectedStage(stageNumber - 1);
}

function formatLives(value) {
  return value === Infinity ? "∞" : String(Math.max(0, value)).padStart(2, "0");
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function readLifeSetting(select, fallback = 3) {
  if (!select) return fallback;
  return select.value === "Infinity" ? Infinity : clamp(Number(select.value) || fallback, LIFE_MIN, LIFE_MAX);
}

function startGame() {
  if (trainingRestartTimer) {
    clearTimeout(trainingRestartTimer);
    trainingRestartTimer = null;
  }
  newAudio();
  audio.resume();
  score = 0;
  score2 = 0;
  gameTime = 0;
  trainingAutoArmed = true;
  sessionStorage.setItem(TRAINING_AUTO_ARMED_KEY, "1");
  p1Deaths = 0;
  p2Deaths = 0;
  killStats = { basic: 0, fast: 0, armor: 0 };
  lives = readLifeSetting(ui.p1LivesStart);
  lives2 = readLifeSetting(ui.p2LivesStart);
  stageIndex = selectedStageIndex;
  completedLoops = 0;
  gameVersion = 1;
  state = "playing";
  overlay.classList.add("hidden");
  window.TankPartnerAI?.startMatch?.({ stage: stageIndex + 1 });
  loadStage();
  sfx.start();
}

function fire(tank, aiControlled = false) {
  if (tank.cooldown > 0 || !tank.alive) return false;
  if (!aiControlled && !tank.enemy && bullets.filter((b) => b.owner === tank).length >= tank.maxBullets) return false;
  const d = DIRS[tank.dir];
  const bullet = {
    owner: tank,
    enemy: tank.enemy,
    x: tank.x + tank.w / 2 - 3 + d.x * 16,
    y: tank.y + tank.h / 2 - 3 + d.y * 16,
    w: 6,
    h: 6,
    dir: tank.dir,
    speed: tank.enemy ? 230 : 310,
    aiControlled,
  };
  bullets.push(bullet);
  if (aiControlled && !tank.enemy) broadcastAllyFire(tank, tank.dir, "fire");
  tank.cooldown = tank.fireDelay;
  sfx.fire();
  return true;
}

function broadcastAllyFire(tank, dir = tank.dir, phase = "aim") {
  if (!tank?.alive || tank.enemy || !DIRS[dir]) return;
  const d = DIRS[dir];
  allyFireReports.push({
    owner: tank,
    ownerKind: tank.kind,
    x: tank.x + tank.w / 2 - 3 + d.x * 16,
    y: tank.y + tank.h / 2 - 3 + d.y * 16,
    w: 6,
    h: 6,
    dir,
    speed: 310,
    enemy: false,
    phase,
    ttl: phase === "aim" ? 0.32 : 0.8,
    tankX: tank.x,
    tankY: tank.y,
    tankDir: tank.dir,
  });
  allyFireReports = allyFireReports.filter((report) => report.ttl > 0).slice(-12);
}

function fireToward(tank, dir, aiControlled = false, action = null) {
  if (!DIRS[dir]) return false;
  if (!faceTankToward(tank, dir)) return false;
  const safe = !action || aiShotSafe(tank, action);
  const fired = safe ? fire(tank, aiControlled) : false;
  return fired;
}

function perpendicularTurnDir(current, desired) {
  if ((current === "up" || current === "down") && (desired === "up" || desired === "down")) return "left";
  if ((current === "left" || current === "right") && (desired === "left" || desired === "right")) return "up";
  return desired;
}

function faceTankToward(tank, desiredDir) {
  if (!DIRS[desiredDir]) return false;
  if (tank.dir === desiredDir) return true;
  if ((tank.turnCooldown || 0) > 0) return false;
  const nextDir = oppositeDir(tank.dir) === desiredDir
    ? perpendicularTurnDir(tank.dir, desiredDir)
    : desiredDir;
  tank.dir = nextDir;
  tank.turnCooldown = TANK_TURN_DELAY;
  return false;
}

function tankSpeedCap(tank) {
  return Math.min(tank.speed || tank.baseSpeed || 0, tank.maxSpeed || tank.baseSpeed || tank.speed || 0);
}

function clampTankMotion(tank, beforeX, beforeY, dt) {
  if (!tank?.alive) return;
  const dx = tank.x - beforeX;
  const dy = tank.y - beforeY;
  const moved = Math.hypot(dx, dy);
  const limit = tankSpeedCap(tank) * Math.max(0, Math.min(dt, 0.033)) + 0.25;
  if (moved <= limit || moved <= 0.01) return;
  const scale = limit / moved;
  const next = { x: beforeX + dx * scale, y: beforeY + dy * scale, w: tank.w, h: tank.h };
  if (!blocked(next, tank)) {
    tank.x = next.x;
    tank.y = next.y;
    return;
  }
  tank.x = beforeX;
  tank.y = beforeY;
}

function moveTank(tank, dir, dt) {
  if (!DIRS[dir]) return false;
  tank.snapCooldown = Math.max(0, (tank.snapCooldown || 0) - dt);
  if (!faceTankToward(tank, dir)) return false;
  const d = DIRS[dir];
  const speed = tankSpeedCap(tank);
  const budgetDt = Math.max(0, Math.min(dt, 0.033));
  if (tank.moveFrameId !== moveFrameId) {
    tank.moveFrameId = moveFrameId;
    tank.moveFrameDistance = 0;
  }
  const frameBudget = speed * budgetDt;
  const remaining = Math.max(0, frameBudget - (tank.moveFrameDistance || 0));
  if (remaining <= 0.01) return false;
  const step = remaining;
  const next = { x: tank.x + d.x * step, y: tank.y + d.y * step, w: tank.w, h: tank.h };
  if (!blocked(next, tank)) {
    tank.x = next.x;
    tank.y = next.y;
    tank.moveFrameDistance += step;
    return true;
  }
  if (tank.snapCooldown > 0 || dir !== tank.dir) return false;
  const snap = Math.min(4, step);
  if (dir === "up" || dir === "down") {
    const grid = Math.round(tank.x / TILE) * TILE + 2;
    const aligned = { x: clamp(grid, tank.x - snap, tank.x + snap), y: tank.y, w: tank.w, h: tank.h };
    const delta = Math.abs(aligned.x - tank.x);
    if (!blocked(aligned, tank) && delta > 1.2) {
      tank.x = aligned.x;
      tank.moveFrameDistance += delta;
      tank.snapCooldown = 0.16;
      return true;
    }
  } else {
    const grid = Math.round(tank.y / TILE) * TILE + 2;
    const aligned = { x: tank.x, y: clamp(grid, tank.y - snap, tank.y + snap), w: tank.w, h: tank.h };
    const delta = Math.abs(aligned.y - tank.y);
    if (!blocked(aligned, tank) && delta > 1.2) {
      tank.y = aligned.y;
      tank.moveFrameDistance += delta;
      tank.snapCooldown = 0.16;
      return true;
    }
  }
  return false;
}

function padInputDir() {
  if (padNow.length) {
    ui.pad.textContent = "XBOX";
    const ax = padAxes[0] || 0;
    const ay = padAxes[1] || 0;
    if (Math.abs(ax) > 0.35 || Math.abs(ay) > 0.35) {
      return Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? "left" : "right") : ay < 0 ? "up" : "down";
    }
    if (padNow[12]) return "up";
    if (padNow[13]) return "down";
    if (padNow[14]) return "left";
    if (padNow[15]) return "right";
  } else {
    ui.pad.textContent = "键盘";
  }
  return null;
}

function p1KeyboardDir() {
  if (KEYS.has("ArrowUp") || KEYS.has("KeyW")) return "up";
  if (KEYS.has("ArrowDown") || KEYS.has("KeyS")) return "down";
  if (KEYS.has("ArrowLeft") || KEYS.has("KeyA")) return "left";
  if (KEYS.has("ArrowRight") || KEYS.has("KeyD")) return "right";
  return null;
}

function p1HumanInputActive(usePad = true) {
  return Boolean((usePad && (padInputDir() || padPressed(0) || padPressed(5)))
    || p1KeyboardDir()
    || KEYS.has("Space"));
}

function p1PadAssigned() {
  return !(lives === 0 && lives2 !== 0);
}

function p2PadAssigned() {
  return lives === 0 && lives2 !== 0;
}

function p1InputActive() {
  return p1HumanInputActive(p1PadAssigned());
}

function p2InputDir() {
  if (KEYS.has("KeyI")) return "up";
  if (KEYS.has("KeyK")) return "down";
  if (KEYS.has("KeyJ")) return "left";
  if (KEYS.has("KeyL")) return "right";
  return null;
}

function p2InputActive() {
  return ["KeyI", "KeyK", "KeyJ", "KeyL", "KeyU"].some((key) => KEYS.has(key))
    || (p2PadAssigned() && Boolean(padInputDir() || padPressed(0) || padPressed(5)));
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
    padAxes = [0, 0];
    menuRepeat.x = { dir: 0, wait: 0 };
    menuRepeat.y = { dir: 0, wait: 0 };
    return;
  }
  padNow = pad.buttons.map((button) => button.pressed);
  padAxes = [pad.axes[0] || 0, pad.axes[1] || 0];
}

function repeatAxis(axis, dir, dt, firstDelay, repeatDelay) {
  const state = menuRepeat[axis];
  if (dir === 0) {
    state.dir = 0;
    state.wait = 0;
    return 0;
  }
  if (dir !== state.dir) {
    state.dir = dir;
    state.wait = firstDelay;
    return dir;
  }
  state.wait -= dt;
  if (state.wait <= 0) {
    state.wait += repeatDelay;
    return dir;
  }
  return 0;
}

function menuPadStep(dt) {
  const x = padNow[15] ? 1 : padNow[14] ? -1 : Math.abs(padAxes[0]) > 0.55 ? Math.sign(padAxes[0]) : 0;
  const y = padNow[13] ? 1 : padNow[12] ? -1 : Math.abs(padAxes[1]) > 0.55 ? Math.sign(padAxes[1]) : 0;
  return {
    x: repeatAxis("x", x, dt, 0.32, 0.16),
    y: repeatAxis("y", y, dt, 0.34, 0.075),
  };
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

function routeLengthOf(tank) {
  return Array.isArray(tank?.attackRoute) ? tank.attackRoute.length : null;
}

function recordAiExperience(type, detail = {}) {
  window.TankPartnerAI?.recordExperience?.(type, {
    stage: stageIndex + 1,
    time: gameTime,
    ...detail,
  });
}

function randomEnemySpawnPoint(kind) {
  const candidates = [];
  for (let i = 0; i < 18; i++) {
    candidates.push({ x: Math.floor(Math.random() * (COLS - 1)) * TILE + 2, y: 0 * TILE + 2 });
  }
  for (const x of [0, 12, 24]) candidates.push({ x: x * TILE + 2, y: 0 * TILE + 2 });
  for (const point of candidates) {
    const tank = makeTank(kind, point.x, point.y);
    if (!blocked(tank.box(), tank)) return point;
  }
  return null;
}

function spawnEnemy(dt) {
  const difficulty = difficultyRank();
  if (enemiesLeft <= 0 || enemies.length >= Math.min(6, 4 + Math.floor(difficulty / 8))) return;
  spawnClock -= dt;
  if (spawnClock > 0) return;
  const roll = Math.random();
  const armorChance = Math.min(0.36, 0.16 + difficulty * 0.008);
  const fastChance = Math.min(0.44, 0.25 + difficulty * 0.007);
  const kind = roll > 1 - armorChance ? "armor" : roll > 1 - armorChance - fastChance ? "fast" : "basic";
  const point = randomEnemySpawnPoint(kind);
  if (!point) {
    spawnClock = 0.25;
    return;
  }
  const tank = makeTank(kind, point.x, point.y);
  if (!blocked(tank.box(), tank)) {
    enemies.push(tank);
    enemiesLeft--;
    burst(point.x + 14, point.y + 14, "#f5f0d0", 12);
  }
  spawnClock = Math.max(0.72, 1.8 - difficulty * 0.025);
}

function enemyCanAdvance(tank, dir, step = 18) {
  if (!DIRS[dir]) return false;
  const d = DIRS[dir];
  const next = { x: tank.x + d.x * step, y: tank.y + d.y * step, w: tank.w, h: tank.h };
  return !blocked(next, tank);
}

function enemyAdvanceDir(tank, target) {
  const dx = target.x - tank.x;
  const dy = target.y - tank.y;
  const axes = Math.abs(dx) > Math.abs(dy)
    ? [dx < 0 ? "left" : "right", dy < 0 ? "up" : "down"]
    : [dy < 0 ? "up" : "down", dx < 0 ? "left" : "right"];
  const fallback = ["down", "left", "right", "up"];
  const options = [...axes, ...fallback.filter((dir) => !axes.includes(dir))];
  let bestDir = tank.dir || "down";
  let bestScore = -Infinity;
  for (const dir of options) {
    if (tank.avoidDir && dir === tank.avoidDir) continue;
    if (!enemyCanAdvance(tank, dir)) continue;
    const d = DIRS[dir];
    const next = { x: tank.x + d.x * 18, y: tank.y + d.y * 18, w: tank.w, h: tank.h };
    const distScore = -((Math.abs((target.x - next.x)) + Math.abs((target.y - next.y))) / 140);
    const laneScore = dir === "down" ? 1.5 : 0;
    const baseBias = dir === tank.dir ? 0.35 : 0;
    const turnCost = dir === tank.dir ? 0.1 : 0.25;
    const score = distScore + laneScore + baseBias - turnCost;
    if (score > bestScore) {
      bestScore = score;
      bestDir = dir;
    }
  }
  return bestDir;
}

function enemyFallbackDir(tank, preferred = []) {
  const order = [...preferred, "down", "left", "right", "up"].filter((dir, i, list) => dir && list.indexOf(dir) === i);
  return order.find((dir) => dir !== tank.avoidDir && enemyCanAdvance(tank, dir, 12))
    || order.find((dir) => enemyCanAdvance(tank, dir, 12))
    || tank.dir;
}

function enemyBaseFireDir(tank) {
  const tx = tank.x + tank.w / 2;
  const ty = tank.y + tank.h / 2;
  const bx = baseRect.x + baseRect.w / 2;
  const by = baseRect.y + baseRect.h / 2;
  const dx = bx - tx;
  const dy = by - ty;
  if (Math.abs(dx) < 18 && dy > 0) return "down";
  if (Math.abs(dx) < 18 && dy < 0) return "up";
  if (Math.abs(dy) < 18 && Math.abs(dx) < TILE * 7) return dx < 0 ? "left" : "right";
  return null;
}

function enemyCanAutoFire(tank) {
  if (tank.cooldown > 0) return false;
  return enemyShotSafe(tank);
}

function enemyShotSafe(tank) {
  const hit = aiFirstHit(tank, tank.dir);
  if (hit.type === "enemy" && hit.target?.enemy) return false;
  return true;
}

function enemyFireTowardBase(tank) {
  const dir = enemyBaseFireDir(tank);
  if (!dir || tank.cooldown > 0) return false;
  if (!faceTankToward(tank, dir)) return false;
  const safe = enemyShotSafe(tank);
  const fired = safe ? fire(tank) : false;
  return fired;
}

function enemyAi(tank, dt) {
  tank.ai -= dt;
  const beforeX = tank.x;
  const beforeY = tank.y;
  const targetBase = { x: 12.5 * TILE, y: 21 * TILE };
  const baseThreatLine = Math.abs((tank.x + tank.w / 2) - (targetBase.x + 16));
  const baseThreatDepth = targetBase.y - tank.y;
  const nearBaseZone = baseThreatDepth < 170 && Math.abs((tank.x + tank.w / 2) - (targetBase.x + 16)) < 150;
  const recentMove = Math.abs(tank.x - tank.lastX) + Math.abs(tank.y - tank.lastY);
  if (recentMove < 0.45) tank.stuck += dt;
  else tank.stuck = Math.max(0, tank.stuck - dt * 2);
  tank.lastX = tank.x;
  tank.lastY = tank.y;

  // [改进] 检测友方子弹威胁，主动躲避
  let dodgeBullet = null;
  let dodgeBulletRisk = 0;
  for (const b of bullets) {
    if (b.enemy || b.owner === tank) continue;
    const dx = Math.abs((tank.x + tank.w / 2) - (b.x + (b.w || 4) / 2));
    const dy = Math.abs((tank.y + tank.h / 2) - (b.y + (b.h || 4) / 2));
    let risk = 0;
    if ((b.dir === "up" || b.dir === "down") && dx < 30) {
      const coming = b.dir === "up" ? (b.y + (b.h || 4) / 2) > (tank.y + tank.h / 2) : (b.y + (b.h || 4) / 2) < (tank.y + tank.h / 2);
      if (coming) risk = Math.max(0, 250 - dy) + Math.max(0, 30 - dx) * 3;
    }
    if ((b.dir === "left" || b.dir === "right") && dy < 30) {
      const coming = b.dir === "left" ? (b.x + (b.w || 4) / 2) > (tank.x + tank.w / 2) : (b.x + (b.w || 4) / 2) < (tank.x + tank.w / 2);
      if (coming) risk = Math.max(0, 250 - dx) + Math.max(0, 30 - dy) * 3;
    }
    if (risk > dodgeBulletRisk) {
      dodgeBullet = b;
      dodgeBulletRisk = risk;
    }
  }

  let desiredDir = tank.dir;

  if (nearBaseZone && enemyFireTowardBase(tank)) {
    tank.ai = Math.min(tank.ai, 0.12);
    return;
  }

  // [改进] 子弹躲避优先级最高
  if (dodgeBullet && dodgeBulletRisk > (nearBaseZone ? 74 : 40)) {
    const primary = dodgeBullet.dir === "up" || dodgeBullet.dir === "down"
      ? (tank.x + tank.w / 2 < dodgeBullet.x + (dodgeBullet.w || 4) / 2 ? "left" : "right")
      : (tank.y + tank.h / 2 < dodgeBullet.y + (dodgeBullet.h || 4) / 2 ? "up" : "down");
    const options = [primary, primary === "left" ? "right" : "left", primary === "up" ? "down" : "up", tank.dir];
    for (const dir of options) {
      if (dir !== tank.avoidDir && enemyCanAdvance(tank, dir, 14)) {
        desiredDir = dir;
        tank.ai = 0.15;
        break;
      }
    }
  } else if (tank.stuck > 0.45) {
    tank.avoidDir = tank.dir;
    const horizontal = tank.x > targetBase.x ? "left" : "right";
    desiredDir = enemyFallbackDir(tank, [horizontal, "down", horizontal === "left" ? "right" : "left"]);
    tank.ai = 0.12;
    tank.stuck = 0;
  } else if (tank.ai <= 0) {
    const towardBase = enemyAdvanceDir(tank, targetBase);

    // [改进] 随机横向穿插移动，使敌人更难被瞄准
    const lateralBias = !nearBaseZone && Math.random() < 0.25
      ? (Math.random() < 0.5 ? "left" : "right")
      : null;

    if (baseThreatDepth > 96) {
      if (lateralBias && enemyCanAdvance(tank, lateralBias)) {
        desiredDir = lateralBias;
      } else {
        desiredDir = enemyCanAdvance(tank, "down") ? "down" : towardBase;
      }
    } else if (baseThreatLine > 28 && Math.abs(tank.x - targetBase.x) > 18) {
      const horizontal = tank.x > targetBase.x ? "left" : "right";
      desiredDir = enemyCanAdvance(tank, horizontal) ? horizontal : (enemyCanAdvance(tank, "down") ? "down" : towardBase);
    } else if (baseThreatDepth < 140 && baseThreatLine < 110) {
      desiredDir = enemyBaseFireDir(tank) || towardBase;
    } else if (tank.y < targetBase.y - 18) {
      desiredDir = enemyCanAdvance(tank, "down") ? "down" : towardBase;
    } else {
      desiredDir = towardBase;
    }
    if (!enemyCanAdvance(tank, desiredDir)) {
      const horizontal = tank.x > targetBase.x ? "left" : "right";
      const alt = enemyFallbackDir(tank, [horizontal, "down", horizontal === "left" ? "right" : "left"]);
      if (alt) desiredDir = alt;
    }
    // [改进] 缩短决策间隔
    tank.ai = 0.25 + Math.random() * 0.3;
  }
  const movedThisFrame = moveTank(tank, desiredDir, dt);
  clampTankMotion(tank, beforeX, beforeY, dt);
  if (Math.abs(tank.x - tank.lastX) + Math.abs(tank.y - tank.lastY) > 2) tank.avoidDir = null;
  if (nearBaseZone && enemyFireTowardBase(tank)) return;
  if (enemyCanAutoFire(tank)) fire(tank);
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
    stageEnemyDefeated = clamp(stageEnemyDefeated + 1, 0, ENEMY_BAR_SLOTS);
    const playerKill = !bullet.owner?.enemy;
    if (playerKill) {
      const killer = bullet.owner;
      const targetCenter = centerOf(tank);
      const killerCenter = killer ? centerOf(killer) : targetCenter;
      recordAiExperience("enemy_killed", {
        tank: killer,
        enemy: tank,
        target: killer?.attackTarget,
        routeLength: routeLengthOf(killer),
        distance: Math.abs(targetCenter.x - killerCenter.x) + Math.abs(targetCenter.y - killerCenter.y),
        angle: bullet.dir,
        clear: Boolean(bullet.aiControlled && killer?.attackRouteMode?.includes("clear")),
        mode: killer?.attackRouteMode || null,
      });
      const points = tank.kind === "armor" ? 400 : tank.kind === "fast" ? 200 : 100;
      if (bullet.owner?.kind === "player2") score2 += points;
      else score += points;
      if (killStats[tank.kind] !== undefined) killStats[tank.kind]++;
      teachAis("kill", 1);
      if (Math.random() > 0.84) bonuses.push({ x: tank.x, y: tank.y, w: 28, h: 28, type: "freeze", ttl: 7 });
    }
  } else {
    recordAiExperience("ally_death", {
      tank,
      enemy: bullet.owner?.enemy ? bullet.owner : null,
      target: tank.attackTarget,
      routeLength: routeLengthOf(tank),
      bulletDir: bullet.dir,
      reason: bullet.owner?.enemy ? "dodge_failed" : "friendly_fire",
      mode: tank.attackRouteMode || null,
    });
    teachAis(tank.kind === "player" ? "ally-hit" : "self-hit", -1);
    if (tank.kind === "player") {
      p1Deaths++;
      teachAis("player-death", -0.9);
      if (lives !== Infinity) lives = Math.max(0, lives - 1);
      if (lives === Infinity || lives > 0) {
        player = makeTank("player", 8 * TILE + 2, 22 * TILE + 2);
        player.invuln = 2.4;
      } else if (!player2?.alive) {
        endGame(false);
      }
    } else {
      p2Deaths++;
      teachAis("partner-death", -0.9);
      if (lives2 !== Infinity) lives2 = Math.max(0, lives2 - 1);
      if (lives2 === Infinity || lives2 > 0) {
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
  const nearestEnemy = enemies
    .filter((enemy) => enemy.alive)
    .sort((a, b) => Math.abs(a.x - baseRect.x) + Math.abs(a.y - baseRect.y) - (Math.abs(b.x - baseRect.x) + Math.abs(b.y - baseRect.y)))[0] || null;
  const nearestAlly = [player, player2]
    .filter((tank) => tank?.alive)
    .sort((a, b) => Math.abs(a.x - baseRect.x) + Math.abs(a.y - baseRect.y) - (Math.abs(b.x - baseRect.x) + Math.abs(b.y - baseRect.y)))[0] || null;
  recordAiExperience("base_hit", {
    enemy: nearestEnemy,
    ally: nearestAlly,
    target: nearestAlly?.attackTarget,
    routeLength: routeLengthOf(nearestAlly),
    misread: nearestAlly?.attackTarget !== nearestEnemy,
    mode: nearestAlly?.attackRouteMode || null,
  });
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

function aiFirstHit(tank, dir = tank.dir) {
  const d = DIRS[dir];
  if (!d) return { type: "none" };
  let x = tank.x + tank.w / 2;
  let y = tank.y + tank.h / 2;
  for (let i = 0; i < 28; i++) {
    x += d.x * TILE * 0.5;
    y += d.y * TILE * 0.5;
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return { type: "edge" };
    const probe = { x: x - 4, y: y - 4, w: 8, h: 8 };
    const ally = [player, player2].find((allyTank) => allyTank?.alive && allyTank !== tank && rects(probe, allyTank.box()));
    if (ally) return { type: "ally", target: ally };
    const enemy = enemies.find((enemyTank) => enemyTank.alive && enemyTank !== tank && rects(probe, enemyTank.box()));
    if (enemy) return { type: "enemy", target: enemy };
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = tileAt(tx, ty);
    if (t === "S" || t === "B" || t === "E" || t === "W") return { type: "tile", tile: t, x: tx, y: ty, baseGuard: tileInBaseGuard(tx, ty) };
  }
  return { type: "none" };
}

function shotFacesBaseGuard(tank, dir = tank.dir) {
  const d = DIRS[dir];
  if (!d) return false;
  let x = tank.x + tank.w / 2;
  let y = tank.y + tank.h / 2;
  for (let i = 0; i < 46; i++) {
    x += d.x * TILE * 0.38;
    y += d.y * TILE * 0.38;
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    const probe = { x: x - 4, y: y - 4, w: 8, h: 8 };
    if (rects(probe, baseRect)) return true;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tileInBaseGuard(tx, ty)) return true;
    const t = tileAt(tx, ty);
    if (t === "S" || t === "W") return false;
  }
  return false;
}

function firstHitIsTargetEnemy(tank, dir, target) {
  if (!target?.alive) return false;
  const hit = aiFirstHit(tank, dir);
  return hit.type === "enemy" && hit.target === target;
}

function predictedAllyBoxes(ally) {
  const box = ally.box();
  const d = DIRS[ally.dir] || { x: 0, y: 0 };
  const lead = Math.min(34, (ally.speed || ally.baseSpeed || 90) * 0.28);
  return [
    box,
    { x: box.x + d.x * lead, y: box.y + d.y * lead, w: box.w, h: box.h },
  ];
}

function allyInShotCorridor(tank, dir = tank.dir) {
  const d = DIRS[dir];
  if (!d) return true;
  let x = tank.x + tank.w / 2 + d.x * 18;
  let y = tank.y + tank.h / 2 + d.y * 18;
  for (let i = 0; i < 42; i++) {
    x += d.x * 10;
    y += d.y * 10;
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    const probe = dir === "up" || dir === "down"
      ? { x: x - 15, y: y - 6, w: 30, h: 12 }
      : { x: x - 6, y: y - 15, w: 12, h: 30 };
    const ally = [player, player2].find((allyTank) => {
      if (!allyTank?.alive || allyTank === tank) return false;
      return predictedAllyBoxes(allyTank).some((box) => rects(probe, box));
    });
    if (ally) return true;
    const enemy = enemies.find((enemyTank) => enemyTank.alive && enemyTank !== tank && rects(probe, enemyTank.box()));
    if (enemy) return false;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = tileAt(tx, ty);
    if (t === "S" || t === "B" || t === "E" || t === "W") return false;
  }
  return false;
}

function predictedTargetBox(tank, dir, target) {
  const box = target.box ? target.box() : target;
  const d = DIRS[dir];
  const targetDir = DIRS[target.dir] || { x: 0, y: 0 };
  const bulletSpeed = tank.enemy ? 230 : 310;
  const distance = Math.abs((box.x + box.w / 2) - (tank.x + tank.w / 2)) + Math.abs((box.y + box.h / 2) - (tank.y + tank.h / 2));
  const leadTime = clamp(distance / bulletSpeed, 0.08, 0.42);
  const targetSpeed = target.speed || 90;
  const leadScale = d && (Math.abs(d.x) !== Math.abs(targetDir.x) || Math.abs(d.y) !== Math.abs(targetDir.y)) ? 0.72 : 0.45;
  return {
    x: box.x + targetDir.x * targetSpeed * leadTime * leadScale,
    y: box.y + targetDir.y * targetSpeed * leadTime * leadScale,
    w: box.w,
    h: box.h,
  };
}

function sweptTargetBox(tank, dir, target) {
  const current = target.box ? target.box() : target;
  const predicted = predictedTargetBox(tank, dir, target);
  const x = Math.min(current.x, predicted.x);
  const y = Math.min(current.y, predicted.y);
  const right = Math.max(current.x + current.w, predicted.x + predicted.w);
  const bottom = Math.max(current.y + current.h, predicted.y + predicted.h);
  return { x, y, w: right - x, h: bottom - y };
}


function aiShotSafe(tank, action = {}) {
  if (allyInShotCorridor(tank, tank.dir)) return false;
  const hit = aiFirstHit(tank, tank.dir);
  if (hit.type === "ally") return false;
  if (shotFacesBaseGuard(tank, tank.dir)) {
    return firstHitIsTargetEnemy(tank, tank.dir, action.target);
  }
  if (action.target?.alive && (action.mode === "attack" || action.mode === "defend" || action.mode?.includes("duel"))) {
    return (hit.type === "enemy" && hit.target === action.target) || aiCanHitTarget(tank, tank.dir, action.target);
  }
  if (action.mode?.includes("clear")) {
    return hit.type === "tile" && hit.tile === "B" && !hit.baseGuard;
  }
  if (hit.type === "tile" && hit.baseGuard && (hit.tile === "B" || hit.tile === "E")) return false;
  return hit.type === "enemy";
}

function aiCanHitTarget(tank, dir, target) {
  const d = DIRS[dir];
  if (!d || !target?.alive) return false;
  if (allyInShotCorridor(tank, dir)) return false;
  const tankCenterX = tank.x + tank.w / 2;
  const tankCenterY = tank.y + tank.h / 2;
  const directBox = target.box ? target.box() : target;
  const directCenterX = directBox.x + directBox.w / 2;
  const directCenterY = directBox.y + directBox.h / 2;
  const predictedBox = predictedTargetBox(tank, dir, target);
  const predictedCenterX = predictedBox.x + predictedBox.w / 2;
  const predictedCenterY = predictedBox.y + predictedBox.h / 2;
  const lateralOffset = dir === "up" || dir === "down"
    ? Math.abs(tankCenterX - predictedCenterX)
    : Math.abs(tankCenterY - predictedCenterY);
  const directOffset = dir === "up" || dir === "down"
    ? Math.abs(tankCenterX - directCenterX)
    : Math.abs(tankCenterY - directCenterY);
  const tolerance = target.speed > 100 ? 14 : 12;
  if (lateralOffset > tolerance && directOffset > tolerance * 0.85) return false;
  const targetBox = predictedBox;
  let x = tank.x + tank.w / 2;
  let y = tank.y + tank.h / 2;
  for (let i = 0; i < 34; i++) {
    x += d.x * TILE * 0.45;
    y += d.y * TILE * 0.45;
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
    const probe = { x: x - 4, y: y - 4, w: 8, h: 8 };
    if (rects(probe, targetBox)) return true;
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = tileAt(tx, ty);
    if (tileInBaseGuard(tx, ty) && (t === "B" || t === "E")) return false;
    if (t === "S" || t === "B" || t === "E" || t === "W") return false;
    if ([player, player2].some((ally) => ally?.alive && ally !== tank && rects(probe, ally.box()))) return false;
  }
  return false;
}

function dirTowardTarget(tank, target) {
  if (!target?.alive) return null;
  const dx = target.x + target.w / 2 - (tank.x + tank.w / 2);
  const dy = target.y + target.h / 2 - (tank.y + tank.h / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

function oppositeDir(dir) {
  return dir === "up" ? "down" : dir === "down" ? "up" : dir === "left" ? "right" : dir === "right" ? "left" : null;
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
      if (tile.t === "B") {
        if (!tileInBaseGuard(tile.x, tile.y)) {
          teachAis("route-open", 0.1);
          if (!b.owner?.enemy) {
            if (b.owner?.kind === "player2") score2 += 5;
            else score += 5;
          }
        }
        setTile(tile.x, tile.y, ".");
      }
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
    const targets = [...enemies, player, player2].filter((tank) => tank?.alive && tank !== b.owner);
    for (const t of targets) {
      if (rects(box, t.box())) {
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
      if (collector.kind === "player2") score2 += 500;
      else score += 500;
      if (b.type === "freeze") freezeClock = 5;
      sfx.power();
    }
  }
  bonuses = bonuses.filter((b) => !b.dead && b.ttl > 0);
}

function endGame(win) {
  state = "over";
  if (aiTrainingEnabled) {
    trainingStats.games++;
    window.TankPartnerAI?.incrementTrainingGames?.();
    window.TankPartnerAI?.syncMemoryFileNow?.();
  }
  saveTrainingStats();
  window.TankPartnerAI?.finishMatch?.({ win, duration: gameTime, stage: stageIndex + 1 });
  overlay.classList.remove("hidden");
  ui.overlayTitle.textContent = win ? "STAGE CLEAR" : "GAME OVER";
  ui.overlayPrompt.textContent = aiTrainingEnabled ? "AI TRAIN 自动开始下一局" : "按 Enter / Xbox Start 重新开始";
  ui.overlayHelp.textContent = `1P ${String(score).padStart(6, "0")}  2P ${String(score2).padStart(6, "0")}`;
  if (pendingGameUpgrade) {
    window.FCHotUpgrade?.checkNow?.();
  }
  scheduleTrainingAutoStart(1800);
}

function nextStage() {
  if (stageCompleted) return;
  stageCompleted = true;
  if (aiTrainingEnabled) {
    trainingStats.games++;
    window.TankPartnerAI?.incrementTrainingGames?.();
    saveTrainingStats();
  }
  window.TankPartnerAI?.finishMatch?.({ win: true, duration: gameTime, stage: stageIndex + 1 });
  window.TankPartnerAI?.syncMemoryFileNow?.();
  stageIndex++;
  if (autoUpgradeEnabled) gameVersion++;
  if (stageIndex >= stages.length) {
    stageIndex = 0;
    completedLoops++;
  }
  window.TankPartnerAI?.startMatch?.({ stage: stageIndex + 1 });
  loadStage();
  sfx.start();
  updateUi();
}

function difficultyRank() {
  return autoUpgradeEnabled ? Math.max(0, gameVersion - 1) : 0;
}

function aiContext(tank, reservedTargets = [], weights = null) {
  return {
    tank,
    enemies,
    friends: [player, player2].filter((t) => t?.alive && t !== tank),
    reservedTargets,
    weights,
    forcedTarget: visibleEnemyForAlly(tank.lockedBaseTarget) ? tank.lockedBaseTarget : null,
    bullets,
    allyFireReports: allyFireReports.filter((report) => report.owner !== tank && report.ttl > 0),
    bonuses,
    map,
    mapVersion,
    rows: ROWS,
    cols: COLS,
    stage: stageIndex + 1,
    gameTime,
    freezeTime: freezeClock,
    base: { ...baseRect },
    baseGuard: { x: 11 * TILE, y: 21 * TILE, w: 4 * TILE, h: 3 * TILE },
    tileAt,
    canFire() {
      if (tank.cooldown > 0 || !tank.alive) return false;
      return true;
    },
    canShoot(dir, target) {
      return aiCanHitTarget(tank, dir, target);
    },
    canMove(dir) {
      const d = DIRS[dir];
      if (!d) return false;
      const step = Math.max(6, Math.min(12, (tank.speed || tank.baseSpeed || 90) * 0.08));
      const next = { x: tank.x + d.x * step, y: tank.y + d.y * step, w: tank.w, h: tank.h };
      return !blocked(next, tank);
    },
  };
}

function centerOf(item) {
  return { x: item.x + item.w / 2, y: item.y + item.h / 2 };
}

function tankInForest(tank) {
  if (!tank) return false;
  const x1 = Math.floor(tank.x / TILE);
  const y1 = Math.floor(tank.y / TILE);
  const x2 = Math.floor((tank.x + tank.w - 1) / TILE);
  const y2 = Math.floor((tank.y + tank.h - 1) / TILE);
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      if (tileAt(x, y) === "F") return true;
    }
  }
  return false;
}

function visibleEnemyForAlly(enemy) {
  return enemy?.alive && !tankInForest(enemy);
}

function allyOwnSide(tank, item) {
  if (!tank || !item) return true;
  const boundary = canvas.width * 0.5;
  return tank.kind === "player" ? centerOf(item).x < boundary : centerOf(item).x >= boundary;
}

function allyCanCrossSide(tank) {
  return !enemies.some((enemy) => visibleEnemyForAlly(enemy) && allyOwnSide(tank, enemy));
}

function allyEligibleSideTarget(tank, enemy) {
  return visibleEnemyForAlly(enemy);
}

function attackTargetFor(tank, reservedTargets = []) {
  if (!tank?.alive || !enemies.length) return null;
  if (visibleEnemyForAlly(tank.lockedBaseTarget)) return tank.lockedBaseTarget;
  const baseCenter = centerOf(baseRect);
  const midline = canvas.height * 0.5;
  const hasLowerEnemy = enemies.some((enemy) => visibleEnemyForAlly(enemy) && centerOf(enemy).y >= midline);
  const canCrossSide = allyCanCrossSide(tank);
  const ranked = enemies
    .filter((enemy) => allyEligibleSideTarget(tank, enemy))
    .map((enemy) => {
      const e = centerOf(enemy);
      const t = centerOf(tank);
      const baseDistance = Math.abs(e.x - baseCenter.x) + Math.abs(e.y - baseCenter.y);
      const tankDistance = Math.abs(e.x - t.x) + Math.abs(e.y - t.y);
      const nearestAllyDistance = [player, player2]
        .filter((ally) => ally?.alive)
        .map((ally) => {
          const a = centerOf(ally);
          return Math.abs(e.x - a.x) + Math.abs(e.y - a.y);
        })
        .sort((a, b) => a - b)[0] ?? Infinity;
      const baseLane = Math.max(0, 180 - Math.abs(e.x - baseCenter.x));
      const closingBase = enemy.dir === "down" && e.y < baseCenter.y ? 90 : 0;
      const nearBaseEmergency = baseDistance < 320 && baseLane > 45 ? 760 : 0;
      const closeBaseAndAlly = baseDistance < TILE * 8.5 && nearestAllyDistance < TILE * 5.5 && e.y >= midline ? 5000 : 0;
      const attackingTank = ((enemy.dir === "left" || enemy.dir === "right") && Math.abs(e.y - t.y) < 34)
        || ((enemy.dir === "up" || enemy.dir === "down") && Math.abs(e.x - t.x) < 34)
        ? 120 : 0;
      const closeRange = tankDistance < TILE * 5.5;
      const immediateRange = tankDistance < TILE * 3.2;
      const closeEnemyBonus = closeRange ? (TILE * 5.5 - tankDistance) * 10 : 0;
      const immediateEnemyBonus = immediateRange ? 1300 : 0;
      const sideScore = allyOwnSide(tank, enemy) ? 2600 : canCrossSide ? 480 : -4200;
      const upperHalfPenalty = hasLowerEnemy && e.y < midline && nearBaseEmergency <= 0 && !closeRange ? 2200 : 0;
      const lowerHalfBonus = e.y >= midline ? 520 : 0;
      return { enemy, score: closeBaseAndAlly + nearBaseEmergency * 1.4 + closingBase * 1.4 + attackingTank + closeEnemyBonus + immediateEnemyBonus + sideScore + lowerHalfBonus - upperHalfPenalty - tankDistance * 1.45 - baseDistance * 0.3 };
    })
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked.length === 1) return ranked[0].enemy;
  return ranked.find((item) => !reservedTargets.some((target) => target?.alive && target === item.enemy))?.enemy || ranked[0].enemy;
}

function isBaseLockThreat(enemy) {
  if (!visibleEnemyForAlly(enemy)) return false;
  const e = centerOf(enemy);
  const b = centerOf(baseRect);
  const dx = Math.abs(e.x - b.x);
  const dy = Math.abs(e.y - b.y);
  const lowerApproach = e.y > b.y - TILE * 12 && dx < TILE * 9.5;
  const basePocket = dy < TILE * 8.5 && dx < TILE * 11;
  const firingLane = e.y > b.y - TILE * 14 && dx < TILE * 2.8;
  const lowerHalf = e.y > canvas.height * 0.48 && dx < TILE * 11.5;
  const movingTowardBase = enemy.dir === "down" && e.y < b.y && dx < TILE * 12;
  return lowerApproach || basePocket || firingLane || lowerHalf || movingTowardBase;
}

function baseLockTargetFor(tank) {
  if (visibleEnemyForAlly(tank?.lockedBaseTarget) && allyEligibleSideTarget(tank, tank.lockedBaseTarget)) return tank.lockedBaseTarget;
  const baseCenter = centerOf(baseRect);
  return enemies
    .filter((enemy) => allyEligibleSideTarget(tank, enemy) && isBaseLockThreat(enemy))
    .map((enemy) => {
      const e = centerOf(enemy);
      const tankDistance = tank ? Math.abs(e.x - centerOf(tank).x) + Math.abs(e.y - centerOf(tank).y) : 0;
      const baseDistance = Math.abs(e.x - baseCenter.x) + Math.abs(e.y - baseCenter.y);
      const lane = Math.abs(e.x - baseCenter.x);
      const lowerBonus = e.y > canvas.height * 0.58 ? -280 : 0;
      const laneBonus = lane < TILE * 4 ? -180 : 0;
      return { enemy, score: baseDistance * 1.45 + lane * 1.45 + tankDistance * 0.28 + lowerBonus + laneBonus };
    })
    .sort((a, b) => a.score - b.score)[0]?.enemy || null;
}

function targetReserved(target, reservedTargets) {
  if (!visibleEnemyForAlly(target)) return false;
  if (isBaseLockThreat(target)) return false;
  return reservedTargets.some((reserved) => reserved?.alive && reserved === target);
}

function canTankMoveDir(tank, dir, step = 20) {
  const d = DIRS[dir];
  if (!d) return false;
  const next = { x: tank.x + d.x * step, y: tank.y + d.y * step, w: tank.w, h: tank.h };
  return !blocked(next, tank);
}

function nearbyObstaclePressure(box) {
  const center = centerOf(box);
  let pressure = 0;
  const minX = Math.max(0, Math.floor((box.x - TILE * 1.5) / TILE));
  const maxX = Math.min(COLS - 1, Math.floor((box.x + box.w + TILE * 1.5) / TILE));
  const minY = Math.max(0, Math.floor((box.y - TILE * 1.5) / TILE));
  const maxY = Math.min(ROWS - 1, Math.floor((box.y + box.h + TILE * 1.5) / TILE));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = tileAt(x, y);
      if (t !== "S" && t !== "B" && t !== "E" && t !== "W") continue;
      const tileCenter = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
      const d = Math.abs(center.x - tileCenter.x) + Math.abs(center.y - tileCenter.y);
      pressure += (t === "S" ? 3 : 1.6) * Math.max(0, 96 - d);
    }
  }
  return pressure;
}

function allyUnstuckDir(tank, preferredDir) {
  let best = null;
  let bestScore = -Infinity;
  const currentPressure = nearbyObstaclePressure(tank.box());
  for (const dir of ["up", "down", "left", "right"]) {
    if (!canTankMoveDir(tank, dir, 26)) continue;
    const d = DIRS[dir];
    const next = { x: tank.x + d.x * 28, y: tank.y + d.y * 28, w: tank.w, h: tank.h };
    let score = currentPressure - nearbyObstaclePressure(next);
    if (tank.attackTarget?.alive) {
      if (!visibleEnemyForAlly(tank.attackTarget)) continue;
      const now = Math.abs(tank.x - tank.attackTarget.x) + Math.abs(tank.y - tank.attackTarget.y);
      const later = Math.abs(next.x - tank.attackTarget.x) + Math.abs(next.y - tank.attackTarget.y);
      score += (now - later) * 0.35;
    }
    if (dir === preferredDir) score += 4;
    if (dir === tank.dir) score += 2;
    if (dir === tank.avoidDir) score -= 8;
    if (score > bestScore) {
      best = dir;
      bestScore = score;
    }
  }
  return best;
}

function updateAlly(tank, dt, ai, humanDir, humanFire, autoControlled, reservedTargets = []) {
  if (!tank?.alive) return;
  tank.lockedBaseTarget = baseLockTargetFor(tank);
  const beforeX = tank.x;
  const beforeY = tank.y;
  let action = null;
  if (autoControlled && tank.escapeTime > 0 && tank.escapeDir) {
    moveTank(tank, tank.escapeDir, dt);
    tank.escapeTime = Math.max(0, tank.escapeTime - dt);
  } else if (autoControlled && ai) {
    const freezeAssault = freezeClock > 0.05;
    const effectiveReservedTargets = reservedTargets;
    const context = aiContext(tank, effectiveReservedTargets, ai.memory?.weights || null);
    action = ai.decide(context, dt);
    const actionTarget = action.target?.alive && allyEligibleSideTarget(tank, action.target) ? action.target : null;
    tank.attackTarget = tank.lockedBaseTarget || actionTarget || attackTargetFor(tank, []);
    const attackRouteAction = actionTarget?.alive && isAttackRouteMode(action.mode);
    tank.attackRoute = attackRouteAction ? (context.plannedRoute || null) : null;
    tank.attackRouteTarget = attackRouteAction ? actionTarget : null;
    tank.attackRouteMode = attackRouteAction ? action.mode : null;
    if (action.fire && actionTarget?.alive && action.mode?.includes("clear")) {
      const toward = dirTowardTarget(tank, actionTarget);
      if (action.dir === oppositeDir(toward) && !aiCanHitTarget(tank, action.dir, actionTarget)) {
        action = { ...action, fire: false, hold: false };
      }
    }
    let fired = false;
    if (action.fire) broadcastAllyFire(tank, action.dir || tank.dir, "aim");
    if (action.dir && action.hold) {
      fired = action.fire ? fireToward(tank, action.dir, true, action) : false;
    } else if (action.dir) {
      moveTank(tank, action.dir, dt);
    }
    if (!fired && action.fire && !action.hold) {
      const shotDir = action.dir || tank.dir;
      fireToward(tank, shotDir, true, action);
    }
  } else {
    tank.attackTarget = tank.lockedBaseTarget || attackTargetFor(tank, reservedTargets);
    tank.attackRoute = null;
    tank.attackRouteTarget = null;
    tank.attackRouteMode = null;
    const moved = humanDir ? moveTank(tank, humanDir, dt) : false;
    if (humanFire) fireToward(tank, moved ? tank.dir : (humanDir || tank.dir));
  }
  clampTankMotion(tank, beforeX, beforeY, dt);
  if (autoControlled) {
    const moved = Math.abs(tank.x - beforeX) + Math.abs(tank.y - beforeY);
    if (moved < 0.2 && action?.dir && !action.hold) tank.stuck += dt;
    else tank.stuck = Math.max(0, tank.stuck - dt * 2);
    if (tank.stuck > 0.55) {
      teachAis("stuck", -0.2);
      recordAiExperience("ally_stuck", {
        tank,
        target: tank.attackTarget,
        routeLength: routeLengthOf(tank),
        staleSeconds: tank.stuck,
        reason: action?.mode?.includes("clear") ? "route_clear_failed" : "target_stale",
        mode: action?.mode || tank.attackRouteMode || null,
      });
      const escapeDir = allyUnstuckDir(tank, action?.dir || tank.dir);
      if (escapeDir) {
        tank.escapeDir = escapeDir;
        tank.escapeTime = 0.62;
        tank.avoidDir = action?.dir || tank.dir;
      }
      tank.stuck = 0;
    }
    if (tank.escapeTime <= 0) tank.escapeDir = null;
  }
  tank.cooldown = Math.max(0, tank.cooldown - dt);
  tank.invuln = Math.max(0, tank.invuln - dt);
}

function update(dt) {
  if (state !== "playing") return;
  moveFrameId++;
  gameTime += dt;
  allyFireReports.forEach((report) => {
    report.ttl -= dt;
  });
  allyFireReports = allyFireReports.filter((report) => report.ttl > 0 && report.owner?.alive);
  for (const tank of [player, player2, ...enemies]) {
    if (tank?.alive) tank.turnCooldown = Math.max(0, (tank.turnCooldown || 0) - dt);
  }
  if (aiTrainingEnabled) {
    trainingStats.seconds += dt;
    window.TankPartnerAI?.addTrainingSeconds?.(dt);
    trainingSaveClock += dt;
    if (trainingSaveClock >= 5) {
      trainingSaveClock = 0;
      saveTrainingStats();
      window.TankPartnerAI?.flushTraining?.();
    }
  }
  const padDir = padInputDir();
  const padFire = padPressed(0) || padPressed(5);
  const p1Pad = p1PadAssigned();
  const p2Pad = p2PadAssigned();
  if (p1InputActive()) {
    p1Idle = 0;
    p1Auto = false;
  } else {
    p1Idle += dt;
    if (p1Idle >= P1_AUTO_SECONDS) p1Auto = true;
  }
  p2Human = p2InputActive();
  const p1Dir = p1KeyboardDir() || (p1Pad ? padDir : null);
  const p2Dir = p2InputDir() || (p2Pad ? padDir : null);
  const p1Fire = KEYS.has("Space") || (p1Pad && padFire);
  const p2Fire = KEYS.has("KeyU") || (p2Pad && padFire);
  updateAlly(player, dt, ai1, p1Dir, p1Fire, p1Auto);
  updateAlly(player2, dt, ai2, p2Dir, p2Fire, !p2Human, [player?.attackTarget]);
  spawnEnemy(dt);
  baseDangerClock -= dt;
  if (baseDangerClock <= 0 && enemies.some((enemy) => Math.abs(enemy.x - baseRect.x) + Math.abs(enemy.y - baseRect.y) < 340)) {
    teachAis("base-danger", 0.45);
    baseDangerClock = 2;
  }
  midlineBreakClock -= dt;
  if (midlineBreakClock <= 0) {
    const midline = canvas.height * 0.5;
    const breached = enemies
      .filter((enemy) => visibleEnemyForAlly(enemy) && centerOf(enemy).y >= midline)
      .sort((a, b) => Math.abs(a.x - baseRect.x) + Math.abs(a.y - baseRect.y) - (Math.abs(b.x - baseRect.x) + Math.abs(b.y - baseRect.y)))[0];
    if (breached) {
      const nearestAlly = [player, player2]
        .filter((tank) => tank?.alive)
        .sort((a, b) => Math.abs(a.x - breached.x) + Math.abs(a.y - breached.y) - (Math.abs(b.x - breached.x) + Math.abs(b.y - breached.y)))[0] || null;
      recordAiExperience("enemy_cross_midline", {
        enemy: breached,
        ally: nearestAlly,
        target: nearestAlly?.attackTarget,
        routeLength: routeLengthOf(nearestAlly),
        timelyReturn: Boolean(nearestAlly?.attackTarget === breached || nearestAlly?.lockedBaseTarget === breached),
        mode: nearestAlly?.attackRouteMode || null,
      });
      midlineBreakClock = 2.5;
    }
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
  if (!t?.alive) return;
  if (t.invuln > 0 && Math.floor(performance.now() / 90) % 2 === 0) return;
  const x = Math.round(t.x);
  const y = Math.round(t.y);
  const isPlayer = t.kind === "player";
  const isPlayer2 = t.kind === "player2";
  const cx = x + 14;
  const cy = y + 14;
  const trim = isPlayer ? "#fff6b8" : isPlayer2 ? "#d9fbff" : t.kind === "fast" ? "#dce8c7" : t.kind === "armor" ? "#c5d0bd" : "#d6e4c3";
  const dark = isPlayer ? "#746325" : isPlayer2 ? "#275b78" : t.kind === "fast" ? "#3f4b3a" : t.kind === "armor" ? "#2f3a2d" : "#34412f";
  const track = t.kind === "armor" ? "#171823" : "#101014";
  const bodyInset = t.kind === "armor" ? 4 : t.kind === "fast" ? 7 : 5;
  const bodyWidth = 28 - bodyInset * 2;
  ctx.fillStyle = track;
  ctx.fillRect(x, y + 2, 7, 24);
  ctx.fillRect(x + 21, y + 2, 7, 24);
  ctx.fillStyle = "#3a3a36";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(x + 1, y + 4 + i * 5, 5, 2);
    ctx.fillRect(x + 22, y + 4 + i * 5, 5, 2);
  }
  ctx.fillStyle = t.color;
  ctx.fillRect(x + bodyInset, y + 4, bodyWidth, 20);
  ctx.fillStyle = dark;
  ctx.fillRect(x + bodyInset + 2, y + 8, Math.max(6, bodyWidth - 4), 12);
  ctx.fillStyle = trim;
  ctx.fillRect(x + bodyInset + 3, y + 5, Math.max(4, bodyWidth - 6), 3);

  if (isPlayer || isPlayer2) {
    ctx.fillStyle = trim;
    ctx.fillRect(x + 9, y + 10, 10, 8);
    ctx.fillStyle = dark;
    ctx.fillRect(x + 12, y + 12, 4, 4);
    ctx.fillStyle = isPlayer ? "#f4dc63" : "#84d8ff";
    ctx.fillRect(x + 6, y + 6, 3, 5);
    ctx.fillRect(x + 19, y + 6, 3, 5);
    ctx.fillRect(x + 7, y + 20, 14, 2);
  } else if (t.kind === "fast") {
    ctx.fillStyle = "#dce8c7";
    ctx.fillRect(x + 10, y + 7, 8, 3);
    ctx.fillRect(x + 12, y + 17, 4, 4);
    ctx.fillStyle = "#263024";
    ctx.fillRect(x + 8, y + 11, 12, 4);
    ctx.fillStyle = "#eff7d4";
    ctx.fillRect(x + 13, y + 8, 2, 2);
  } else if (t.kind === "armor") {
    ctx.fillStyle = "#c5d0bd";
    ctx.fillRect(x + 7, y + 6, 14, 4);
    ctx.fillRect(x + 6, y + 18, 16, 3);
    ctx.fillStyle = "#263024";
    ctx.fillRect(x + 9, y + 10, 10, 8);
    ctx.fillStyle = "#e3ecd2";
    ctx.fillRect(x + 12, y + 12, 4, 4);
    ctx.fillRect(x + 5, y + 11, 3, 6);
    ctx.fillRect(x + 20, y + 11, 3, 6);
  } else {
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(x + 9, y + 6, 10, 3);
    ctx.fillRect(x + 11, y + 10, 6, 6);
    ctx.fillStyle = "#e6f0a8";
    ctx.fillRect(x + 13, y + 7, 2, 2);
    ctx.fillRect(x + 8, y + 19, 12, 2);
  }

  const barrelColor = isPlayer || isPlayer2 ? trim : t.kind === "armor" ? "#b8c4af" : t.kind === "fast" ? "#d4e1bd" : t.color;
  ctx.fillStyle = barrelColor;
  if (t.dir === "up") ctx.fillRect(cx - 3, y - 4, 6, 16);
  if (t.dir === "down") ctx.fillRect(cx - 3, y + 16, 6, 16);
  if (t.dir === "left") ctx.fillRect(x - 4, cy - 3, 16, 6);
  if (t.dir === "right") ctx.fillRect(x + 16, cy - 3, 16, 6);
  ctx.fillStyle = "#f8f6dd";
  if (isPlayer || isPlayer2) ctx.fillRect(x + 13, y + 13, 2, 2);
}

function steelBlocksLineAt(x, y) {
  return tileAt(Math.floor(x / TILE), Math.floor(y / TILE)) === "S";
}

function lineBlockedBySteel(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  if (distance < 1) return false;
  for (let step = 4; step <= distance; step += 4) {
    const ratio = Math.min(1, step / distance);
    if (steelBlocksLineAt(from.x + dx * ratio, from.y + dy * ratio)) return true;
  }
  return false;
}

function appendIfSteelClear(points, point) {
  const from = points[points.length - 1];
  if (lineBlockedBySteel(from, point)) return false;
  points.push(point);
  return true;
}

function appendTargetConnector(points, targetPoint) {
  const last = points[points.length - 1];
  const sameColumn = Math.abs(last.x - targetPoint.x) <= TILE * 0.55;
  const sameRow = Math.abs(last.y - targetPoint.y) <= TILE * 0.55;
  if (sameColumn) return appendIfSteelClear(points, { x: last.x, y: targetPoint.y });
  if (sameRow) return appendIfSteelClear(points, { x: targetPoint.x, y: last.y });
  const horizontalFirst = Math.abs(last.x - targetPoint.x) > Math.abs(last.y - targetPoint.y);
  const first = horizontalFirst ? { x: targetPoint.x, y: last.y } : { x: last.x, y: targetPoint.y };
  const second = { x: targetPoint.x, y: targetPoint.y };
  if (lineBlockedBySteel(last, first) || lineBlockedBySteel(first, second)) return false;
  points.push(first, second);
  return true;
}

function isAttackRouteMode(mode = "") {
  return /^(attack|attack-clear|long-range-fire|forward-intercept|forward-intercept-fire|forward-intercept-clear|freeze-assault|freeze-assault-fire|freeze-assault-clear|base-nearest-hunt|base-nearest-hunt-fire|base-nearest-hunt-clear|chase-break|chase-break-fire|chase-break-clear|target-execute|target-execute-fire|target-execute-clear|base-assault|base-assault-clear|base-anchor|base-anchor-fire|base-anchor-clear|close-melee|close-melee-fire|close-melee-duel|close-melee-dodge|close-melee-clear|kill-confirm|kill-confirm-fire|kill-confirm-clear|base-lane-block|base-lane-fire|base-lane-clear|base-intruder|base-intruder-fire|base-intruder-clear|base-intruder-assault|patch-base-lockdown|patch-base-lockdown-fire|patch-base-lockdown-clear)$/.test(mode || "");
}

function drawTargetLink(tank, color, reservedTargets = []) {
  const lockedTarget = visibleEnemyForAlly(tank?.lockedBaseTarget) ? tank.lockedBaseTarget : null;
  const currentTarget = visibleEnemyForAlly(tank?.attackTarget) ? tank.attackTarget : null;
  const target = lockedTarget || currentTarget || attackTargetFor(tank, []);
  if (!tank?.alive || !visibleEnemyForAlly(target)) return;
  const route = tank.attackRouteTarget === target && isAttackRouteMode(tank.attackRouteMode) && tank.attackRoute?.length
    ? tank.attackRoute
    : [];
  const a = centerOf(tank);
  const b = centerOf(target);
  const points = [{ x: a.x, y: a.y }];
  for (const point of route.slice(1)) {
    const prev = points[points.length - 1];
    if (Math.abs(prev.x - point.x) < 1 && Math.abs(prev.y - point.y) < 1) continue;
    points.push({ x: point.x, y: point.y });
  }
  appendTargetConnector(points, b);
  if (points.length < 2) {
    const horizontalFirst = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
    const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    if (!lineBlockedBySteel(a, corner) && !lineBlockedBySteel(corner, b)) points.push(corner, b);
    else if (!lineBlockedBySteel(a, b)) points.push(b);
  }
  if (points.length < 2) return target;
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([9, 7]);
  ctx.lineDashOffset = -Math.floor(performance.now() / 80) % 16;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(Math.round(point.x), Math.round(point.y));
    else {
      const prev = points[index - 1];
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      const px = Math.round(prev.x);
      const py = Math.round(prev.y);
      if (px !== x && py !== y) ctx.lineTo(x, py);
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(b.x) - 3, Math.round(b.y) - 3, 6, 6);
  ctx.restore();
  return target;
}

function drawTargetLinks() {
  const p1Target = drawTargetLink(player, "rgba(255, 232, 96, 0.9)");
  drawTargetLink(player2, "rgba(92, 215, 255, 0.9)", [p1Target]);
}

function drawFreezeBonus(b) {
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  ctx.fillStyle = "#12314a";
  ctx.fillRect(x + 2, y + 2, 24, 24);
  ctx.fillStyle = "#d8fbff";
  ctx.fillRect(x + 5, y + 5, 18, 18);
  ctx.fillStyle = colors.ice;
  ctx.fillRect(x + 7, y + 7, 14, 14);
  ctx.fillStyle = "#14445d";
  ctx.fillRect(x + 13, y + 6, 2, 16);
  ctx.fillRect(x + 6, y + 13, 16, 2);
  ctx.fillRect(x + 9, y + 9, 3, 3);
  ctx.fillRect(x + 16, y + 9, 3, 3);
  ctx.fillRect(x + 9, y + 16, 3, 3);
  ctx.fillRect(x + 16, y + 16, 3, 3);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + 13, y + 13, 2, 2);
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
    if (b.type === "freeze") drawFreezeBonus(b);
  }
  drawTargetLinks();
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
  const frameDt = Math.min(MAX_FRAME_DT, (time - lastTime) / 1000 || 0);
  lastTime = time;
  if (document.hidden) {
    requestAnimationFrame(loop);
    return;
  }
  refreshPad();
  if (padJustPressed(8)) {
    if (state === "title" || state === "over") selectNextStage();
    else openStageMenu();
  }
  if (state === "title" || state === "over") {
    stageNumberClock = Math.max(0, stageNumberClock - frameDt);
    if (stageNumberClock === 0) stageNumberBuffer = "";
    const menuStep = menuPadStep(frameDt);
    if (menuStep.x) moveMenuField(menuStep.x);
    if (menuStep.y) adjustMenuValue(-menuStep.y);
  }
  if ((state === "title" || state === "over") && padJustPressed(0)) confirmMenuField();
  if ((state === "title" || state === "over") && padJustPressed(9)) startGame();
  if (state === "playing" && padJustPressed(9)) state = "paused";
  else if (state === "paused" && padJustPressed(9)) state = "playing";
  pressed.clear();
  updateAccumulator = 0;
  update(frameDt);
  draw();
  padPrev = padNow.slice();
  requestAnimationFrame(loop);
}

function runHiddenStep() {
  if (!document.hidden || state !== "playing") return;
  refreshPad();
  for (let i = 0; i < 6; i++) update(FIXED_DT);
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
    updateAccumulator = 0;
    draw();
  }
}

function titleStartRequested(e) {
  return e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space";
}

window.addEventListener("keydown", (e) => {
  if (!KEYS.has(e.code)) pressed.add(e.code);
  KEYS.add(e.code);
  if (e.code === "Backspace") {
    if (state === "title" || state === "over") selectNextStage();
    else openStageMenu();
    return;
  }
  if (state === "title" || state === "over") {
    if (e.code === "ArrowLeft") {
      e.preventDefault();
      adjustMenuValue(-1);
    }
    if (e.code === "ArrowRight") {
      e.preventDefault();
      adjustMenuValue(1);
    }
    if (e.code === "ArrowUp") {
      e.preventDefault();
      moveMenuField(-1);
    }
    if (e.code === "ArrowDown") {
      e.preventDefault();
      moveMenuField(1);
    }
    if (e.code === "PageUp") {
      e.preventDefault();
      setSelectedStage(selectedStageIndex - 5);
    }
    if (e.code === "PageDown") {
      e.preventDefault();
      setSelectedStage(selectedStageIndex + 5);
    }
    if (/^Digit\d$/.test(e.code) || /^Numpad\d$/.test(e.code)) {
      e.preventDefault();
      appendStageDigit(e.code.replace(/\D/g, ""));
    }
  }
  if ((state === "title" || state === "over") && titleStartRequested(e)) {
    updateStartOverlayText();
    startGame();
  }
  if (e.code === "KeyP" && (state === "playing" || state === "paused")) state = state === "playing" ? "paused" : "playing";
  if (state === "paused" && titleStartRequested(e)) state = "playing";
});

window.addEventListener("keyup", (e) => KEYS.delete(e.code));
ui.stageOption?.addEventListener("click", () => setMenuField(0));
ui.p1LivesStart?.parentElement?.addEventListener("click", () => setMenuField(1));
ui.p2LivesStart?.parentElement?.addEventListener("click", () => setMenuField(2));
ui.autoUpgradeOption?.addEventListener("click", clickAutoUpgradeOption);
ui.aiTrainOption?.addEventListener("click", clickAiTrainOption);
ui.hotUpgradeOption?.addEventListener("click", clickHotUpgradeOption);
ui.stagePrev?.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuField(0);
  setSelectedStage(selectedStageIndex - 1);
});
ui.stageNext?.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuField(0);
  setSelectedStage(selectedStageIndex + 1);
});
ui.stageSelectValue?.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuField(0);
});
ui.stageSelectValue?.addEventListener("dblclick", () => startGame());
ui.startButton?.addEventListener("click", () => startGame());
ui.p1LivesStart?.addEventListener("change", updateStartOverlayText);
ui.p2LivesStart?.addEventListener("change", updateStartOverlayText);
overlay.addEventListener(
  "wheel",
  (e) => {
    if (!(state === "title" || state === "over")) return;
    e.preventDefault();
    adjustMenuValue(e.deltaY > 0 ? 1 : -1);
  },
  { passive: false }
);
window.addEventListener("gamepadconnected", (e) => {
  gamepadIndex = e.gamepad.index;
  ui.pad.textContent = "XBOX";
});
window.addEventListener("gamepaddisconnected", () => {
  gamepadIndex = null;
  ui.pad.textContent = "键盘";
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) window.TankPartnerAI?.syncMemoryFileNow?.();
  syncBackgroundLoop();
});
window.addEventListener("pagehide", () => window.TankPartnerAI?.syncMemoryFileNow?.());

window.FCGameHotAPI = {
  isHotUpgradeEnabled: () => hotUpgradeEnabled,
  setHotUpgradeEnabled(value) {
    hotUpgradeEnabled = Boolean(value);
    updateStartOverlayText();
  },
  reloadAiControllers() {
    ai1 = window.TankPartnerAI?.createController("1P");
    ai2 = window.TankPartnerAI?.createController("2P");
    updateUi();
  },
  setHotUpgradeStatus(status) {
    if (ui.hotUpgradeStatus) ui.hotUpgradeStatus.textContent = status || "READY";
  },
  canApplyGameUpgrade() {
    return state !== "playing";
  },
  setPendingGameUpgrade(value) {
    pendingGameUpgrade = Boolean(value);
  },
  /**
   * @param {{developer?: string, model?: string, updatedAtBeijing?: string, updatedAt?: string}=} info
   */
  setAiVersionInfo(info = {}) {
    if (!ui.aiVersionInfo) return;
    const developer = info?.developer || "CODEX";
    const model = info?.model || "GPT-5.5";
    const updatedAt = info?.updatedAtBeijing || info?.updatedAt || "UNKNOWN";
    const bestStage = Math.max(0, Math.floor(Number(window.TankPartnerAI?.readMemory?.()?.highestStageCleared) || 0));
    lastAiVersionText = `${developer} / ${model} / AI ${updatedAt}      AI最高通关关卡 ${String(bestStage).padStart(2, "0")}`;
    ui.aiVersionInfo.textContent = lastAiVersionText;
  },
  /**
   * @param {{developer?: string, version?: string, hash?: string}=} info
   */
  setGameVersionInfo(info = {}) {
    const developer = info?.developer || "CODEX";
    const rawVersion = String(info?.version || info?.hash || "").replace(/\D/g, "");
    const compactVersion = rawVersion.length >= 12 ? rawVersion.slice(4, 12) : rawVersion.slice(0, 8);
    gameVersionLabel = compactVersion ? `${developer} ${compactVersion}` : developer;
    if (ui.version) ui.version.textContent = gameVersionLabel;
  },
  resetAiTrainingDisplay,
};

if (window.FCHotUpgradeVersion) {
  window.FCGameHotAPI.setAiVersionInfo(window.FCHotUpgradeVersion.ai);
  window.FCGameHotAPI.setGameVersionInfo({
    developer: window.FCHotUpgradeVersion.ai?.developer || "CODEX",
    ...(window.FCHotUpgradeVersion.game || {}),
  });
}

async function bootGame() {
  await window.TankPartnerAI?.restoreMemoryFile?.();
  const hotInfo = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(HOT_UPGRADE_KEY) || "null");
    } catch {
      return null;
    }
  })();
  if (hotInfo?.game && aiTrainingEnabled) {
    trainingAutoArmed = true;
    sessionStorage.setItem(TRAINING_AUTO_ARMED_KEY, "1");
    sessionStorage.removeItem(HOT_UPGRADE_KEY);
  }
  loadStage();
  updateStartOverlayText();
  draw();
  requestAnimationFrame(loop);
}

bootGame();
