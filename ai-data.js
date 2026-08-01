// @ts-check

(function () {
  const previous = window.TankPartnerAI;
  const MEMORY_KEY = "fc-tank-battle.partner-ai";
  const LEGACY_MEMORY_KEY = "fc-tank-battle.partner-ai.v2";
  const EXPERIENCE_KEY = "fc-tank-battle.ai-experience.v1";
  const FILE_URL = "/ai-memory";
  const EVENT_LIMIT = 2400;
  const MATCH_LIMIT = 512;
  const CORE_DATA_VERSION = 2;
  const defaults = {
    weights: { defend: 5, survive: 5, attack: 5, clear: 5 },
    bestWeights: { defend: 5, survive: 5, attack: 5, clear: 5 },
    highestStageCleared: 0,
    highestStageUpdatedAt: 0,
    highestStageResetAt: 0,
    games: 0,
    failures: {},
    patches: [],
    lastFailures: [],
    evolution: null,
    lastScore: 0,
  };
  const WEIGHT_LIMITS = {
    defend: [0, 10],
    survive: [0, 10],
    attack: [0, 10],
    clear: [0, 10],
  };
  let disposed = false;
  let syncTimer = null;
  let memory = normalizeMemory(previous?.readMemory?.() || readLocal(MEMORY_KEY) || readLocal(LEGACY_MEMORY_KEY) || defaults);
  let experience = normalizeExperience(previous?.readExperience?.() || readLocal(EXPERIENCE_KEY) || {});
  let training = normalizeTraining(previous?.readTraining?.() || {});
  previous?.dispose?.();
  localStorage.removeItem(LEGACY_MEMORY_KEY);

  function readLocal(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
  }

  function normalizeWeights(value = {}) {
    const result = {};
    for (const key of ["defend", "survive", "attack", "clear"]) {
      const fallback = defaults.weights[key];
      const [minimum, maximum] = WEIGHT_LIMITS[key];
      result[key] = Math.max(minimum, Math.min(maximum, Number(value[key]) || fallback));
    }
    return result;
  }

  function normalizeEvolution(value = {}) {
    return {
      generation: Math.max(0, Math.floor(Number(value?.generation) || 0)),
      active: String(value?.active || "BASE").slice(0, 24),
      matches: Math.max(0, Math.floor(Number(value?.matches) || 0)),
      wins: Math.max(0, Math.floor(Number(value?.wins) || 0)),
      losses: Math.max(0, Math.floor(Number(value?.losses) || 0)),
      score: Number(value?.score) || 0,
      bestScore: Number(value?.bestScore) || 0,
      stageBest: value?.stageBest && typeof value.stageBest === "object" ? value.stageBest : {},
    };
  }

  function isCurrentMode(value) {
    return typeof value === "string" && (value.startsWith("core-") || value === "freeze-active");
  }

  function cleanCounters(value = {}) {
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !key.startsWith("mode:") || isCurrentMode(key.slice(5))));
  }

  function cleanEvents(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((event) =>
      !String(event?.type || "").startsWith("mode:") || isCurrentMode(String(event.type).slice(5)))
      .map((event) => ({
        ...event,
        mode: event?.mode && !isCurrentMode(event.mode) ? null : event?.mode || null,
      }))
      .slice(-EVENT_LIMIT);
  }

  function normalizeMemory(value = {}) {
    const currentCoreData = Number(value.coreDataVersion) === CORE_DATA_VERSION;
    return {
      ...defaults,
      coreDataVersion: CORE_DATA_VERSION,
      weights: normalizeWeights(currentCoreData ? value.weights : defaults.weights),
      bestWeights: normalizeWeights(currentCoreData ? (value.bestWeights || value.weights) : defaults.bestWeights),
      highestStageCleared: Math.max(0, Math.floor(Number(value.highestStageCleared) || 0)),
      highestStageUpdatedAt: Math.max(0, Number(value.highestStageUpdatedAt) || 0),
      highestStageResetAt: Math.max(0, Number(value.highestStageResetAt) || 0),
      games: Math.max(0, Math.floor(Number(value.games) || 0)),
      failures: cleanCounters(value.failures),
      patches: [],
      lastFailures: [],
      evolution: normalizeEvolution(value.evolution),
      lastScore: Number(value.lastScore) || 0,
    };
  }

  function normalizeExperience(value = {}) {
    return {
      version: 2,
      games: Math.max(0, Math.floor(Number(value.games) || 0)),
      events: cleanEvents(value.events),
      matches: Array.isArray(value.matches) ? value.matches.slice(-MATCH_LIMIT) : [],
      counters: cleanCounters(value.counters),
      currentMatch: value.currentMatch ? {
        ...value.currentMatch,
        counters: cleanCounters(value.currentMatch.counters),
      } : null,
    };
  }

  function normalizeTraining(value = {}) {
    return {
      seconds: Math.max(0, Number(value.seconds) || 0),
      games: Math.max(0, Math.floor(Number(value.games) || 0)),
      generation: Math.max(0, Math.floor(Number(value.generation) || 0)),
    };
  }

  function serverMode() {
    return !disposed && /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  }

  function compact(item) {
    if (!item) return null;
    return { x: Math.round(item.x || 0), y: Math.round(item.y || 0), dir: item.dir || null, kind: item.kind || null };
  }

  function compactBaseTimeline(value) {
    if (!Array.isArray(value)) return null;
    const compactTank = (tank) => tank ? {
      ...compact(tank),
      mode: tank.mode || null,
      target: compact(tank.target),
    } : null;
    return value.slice(-21).map((snapshot) => ({
      time: Math.round((Number(snapshot?.time) || 0) * 10) / 10,
      freeze: Math.round((Number(snapshot?.freeze) || 0) * 10) / 10,
      p1: compactTank(snapshot?.p1),
      p2: compactTank(snapshot?.p2),
      enemies: Array.isArray(snapshot?.enemies) ? snapshot.enemies.slice(0, 8).map((enemy) => ({ ...compact(enemy), hp: Number(enemy?.hp) || 1 })) : [],
      bullets: Array.isArray(snapshot?.bullets) ? snapshot.bullets.slice(0, 24).map((bullet) => ({
        x: Math.round(Number(bullet?.x) || 0),
        y: Math.round(Number(bullet?.y) || 0),
        dir: bullet?.dir || null,
        side: String(bullet?.side || "unknown").slice(0, 16),
      })) : [],
    }));
  }

  function payload() {
    return { memory, experience, training };
  }

  function saveLocal() {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
      if (serverMode()) localStorage.removeItem(EXPERIENCE_KEY);
      else localStorage.setItem(EXPERIENCE_KEY, JSON.stringify(experience));
    } catch {}
  }

  function syncMemoryFile() {
    saveLocal();
    if (!serverMode() || syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      fetch(FILE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      }).catch(() => {});
    }, 4000);
  }

  function syncMemoryFileNow() {
    saveLocal();
    if (!serverMode()) return;
    const body = JSON.stringify(payload());
    try {
      if (navigator.sendBeacon?.(FILE_URL, new Blob([body], { type: "application/json" }))) return;
    } catch {}
    fetch(FILE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }

  async function restoreMemoryFile() {
    if (!serverMode()) return;
    try {
      const response = await fetch(`${FILE_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      memory = normalizeMemory(data.memory || memory);
      experience = normalizeExperience(data.experience || experience);
      training = normalizeTraining(data.training || training);
      localStorage.removeItem(MEMORY_KEY);
      localStorage.removeItem(EXPERIENCE_KEY);
    } catch {}
  }

  function startMatch(meta = {}) {
    experience.games++;
    experience.currentMatch = {
      id: `${Date.now()}-${experience.games}`,
      stage: Number(meta.stage) || 1,
      startedAt: Date.now(),
      events: 0,
      counters: {},
    };
    syncMemoryFile();
  }

  function recordExperience(type, detail = {}) {
    if (!type) return;
    const match = experience.currentMatch || { id: `${Date.now()}-${experience.games}`, stage: detail.stage || 1, events: 0, counters: {} };
    match.events++;
    match.counters[type] = (match.counters[type] || 0) + 1;
    experience.counters[type] = (experience.counters[type] || 0) + 1;
    experience.currentMatch = match;
    experience.events.push({
      matchId: match.id,
      stage: detail.stage ?? match.stage,
      time: Math.round((Number(detail.time) || 0) * 10) / 10,
      type,
      tank: compact(detail.tank),
      ally: compact(detail.ally),
      enemy: compact(detail.enemy),
      target: compact(detail.target),
      mode: detail.mode || null,
      reason: detail.reason || null,
      distance: Number.isFinite(detail.distance) ? Math.round(detail.distance) : null,
      bulletDir: detail.bulletDir || null,
      baseSource: detail.baseSource || null,
      baseTimeline: type === "base_hit" ? compactBaseTimeline(detail.baseTimeline) : null,
      historySamples: type === "base_hit" ? Math.max(0, Math.floor(Number(detail.historySamples) || 0)) : null,
      historySeconds: type === "base_hit" ? Math.round((Number(detail.historySeconds) || 0) * 10) / 10 : null,
      createdAt: Date.now(),
    });
    experience.events = experience.events.slice(-EVENT_LIMIT);
    syncMemoryFile();
  }

  function updatePerformanceData(match, result) {
    const counters = match?.counters || {};
    const count = (key) => Math.max(0, Number(counters[key]) || 0);
    const clamp = (value) => Math.max(0, Math.min(10, value));
    const scores = {
      defend: clamp(10 - count("base_hit") * 6 - Math.max(0, count("enemy_cross_midline") - 2) * 0.45
        + count("base_shield_counter") * 0.35),
      survive: clamp(10 - count("ally_death") * 1.75 - count("dodge_failed") * 1.25
        - count("friendly_fire") * 0.5),
      attack: clamp(count("enemy_killed") * 0.5 + (result.win ? 1 : 0)),
      clear: clamp(10 - count("ally_stuck") * 1.1 - count("route_clear_failed") * 2
        - count("target_stale") * 0.6),
    };
    const previous = normalizeWeights(memory.weights);
    const smoothing = 0.25;
    memory.weights = normalizeWeights(Object.fromEntries(Object.keys(scores).map((key) => [
      key,
      previous[key] * (1 - smoothing) + scores[key] * smoothing,
    ])));
  }

  function finishMatch(result = {}) {
    const match = experience.currentMatch;
    const stage = Math.max(1, Math.floor(Number(result.stage) || match?.stage || 1));
    const duration = Math.max(0, Number(result.duration) || 0);
    const evolution = normalizeEvolution(memory.evolution);
    evolution.matches++;
    if (result.win) evolution.wins++;
    else evolution.losses++;
    const resultScore = result.win ? stage * 100 + Math.max(0, 180 - duration) : -100 - stage * 15;
    evolution.score = evolution.matches <= 1 ? resultScore : evolution.score * 0.88 + resultScore * 0.12;
    evolution.bestScore = Math.max(evolution.bestScore, evolution.score);
    memory.lastScore = Math.round(resultScore);
    updatePerformanceData(match, result);
    if (result.win) {
      const stageKey = String(stage);
      const previousBest = evolution.stageBest[stageKey];
      if (!previousBest || duration + 0.5 < Number(previousBest.duration)) {
        evolution.generation++;
        evolution.active = `S${stage}-FAST`;
        evolution.stageBest[stageKey] = { duration: Math.round(duration * 10) / 10, updatedAt: Date.now() };
        memory.bestWeights = normalizeWeights(memory.weights);
      }
    }
    memory.evolution = evolution;
    if (match) {
      match.result = result.win ? "win" : "lose";
      match.duration = Math.round((Number(result.duration) || 0) * 10) / 10;
      match.endedAt = Date.now();
      if (result.win) {
        memory.highestStageCleared = Math.max(memory.highestStageCleared, stage);
        memory.highestStageUpdatedAt = Date.now();
      }
      experience.matches.push({
        id: match.id,
        stage,
        result: match.result,
        duration: match.duration,
        startedAt: match.startedAt,
        endedAt: match.endedAt,
        events: match.events,
        counters: cleanCounters(match.counters),
      });
      experience.matches = experience.matches.slice(-MATCH_LIMIT);
    }
    memory.games = Math.max(Number(memory.games) || 0, experience.games);
    experience.currentMatch = null;
    syncMemoryFileNow();
  }

  function readExperienceDbStats() {
    return Promise.resolve({ available: false, events: experience.events.length, matches: experience.games });
  }

  function resetMemory() {
    memory = normalizeMemory(defaults);
    experience = normalizeExperience({});
    training = normalizeTraining({});
    syncMemoryFileNow();
  }

  function flushTraining() {
    if (!serverMode()) return;
    fetch(`${FILE_URL}/training`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ training }),
    }).catch(() => {});
  }

  function dispose() {
    disposed = true;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
  }

  const services = {
    createController() { throw new Error("AI CORE controller is not loaded"); },
    readMemory: () => memory,
    readExperience: () => experience,
    readExperienceDbStats,
    startMatch,
    recordExperience,
    finishMatch,
    syncMemoryFile,
    syncMemoryFileNow,
    restoreMemoryFile,
    resetMemory,
    readTraining: () => training,
    addTrainingSeconds(seconds = 0) { training.seconds += Math.max(0, Number(seconds) || 0); },
    incrementTrainingGames() { training.games++; syncMemoryFileNow(); },
    flushTraining,
    dispose,
    ready: restoreMemoryFile(),
  };
  window.TankPartnerAI = window.TankPartnerAIEngine?.enhance?.(services) || services;
})();
