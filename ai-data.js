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
  const ANALYTICS_VERSION = 3;
  const ANALYTICS_BUILD_LIMIT = 32;
  const TRACKED_MODE_EVENTS = new Set(["ally_death", "base_hit", "enemy_killed", "enemy_cross_midline"]);
  const MEMORY_SYNC_DELAY = 12000;
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
  let syncRequest = null;
  let pendingEvents = [];
  let pendingMatches = [];
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

  function cleanModeCounters(value = {}) {
    const result = {};
    for (const [type, modes] of Object.entries(value || {})) {
      if (!TRACKED_MODE_EVENTS.has(type) || !modes || typeof modes !== "object") continue;
      result[type] = Object.fromEntries(Object.entries(modes)
        .filter(([mode, count]) => isCurrentMode(mode) && Number(count) > 0)
        .map(([mode, count]) => [mode, Math.max(0, Math.floor(Number(count) || 0))]));
    }
    return result;
  }

  function normalizeRunContext(value = {}) {
    const speed = Math.max(1, Math.min(8, Number(value?.speed) || 1));
    return {
      mode: value?.mode === "TEST" || speed > 1 ? "TEST" : "NORMAL",
      speed,
      muted: Boolean(value?.muted),
    };
  }

  function runtimeRunContext() {
    const params = new URLSearchParams(location.search);
    const speed = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname)
      ? Math.max(1, Math.min(8, Number(params.get("testSpeed")) || 1))
      : 1;
    return normalizeRunContext({
      mode: speed > 1 ? "TEST" : "NORMAL",
      speed,
      muted: params.get("testMute") === "1",
    });
  }

  function emptyAnalyticsBucket() {
    return { games: 0, wins: 0, losses: 0, durationTotal: 0, counters: {}, stages: {}, modeCounters: {}, baseHitByEnemy: {}, runModes: {} };
  }

  function normalizeAnalyticsBucket(value = {}) {
    const bucket = emptyAnalyticsBucket();
    bucket.games = Math.max(0, Math.floor(Number(value.games) || 0));
    bucket.wins = Math.max(0, Math.floor(Number(value.wins) || 0));
    bucket.losses = Math.max(0, Math.floor(Number(value.losses) || 0));
    bucket.durationTotal = Math.max(0, Number(value.durationTotal) || 0);
    bucket.counters = cleanCounters(value.counters);
    bucket.modeCounters = cleanModeCounters(value.modeCounters);
    bucket.runModes = Object.fromEntries(Object.entries(value.runModes || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([mode, count]) => [String(mode).slice(0, 16), Math.max(0, Math.floor(Number(count) || 0))]));
    bucket.baseHitByEnemy = Object.fromEntries(Object.entries(value.baseHitByEnemy || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([kind, count]) => [String(kind).slice(0, 16), Math.max(0, Math.floor(Number(count) || 0))]));
    for (const [stage, stats] of Object.entries(value.stages || {})) {
      const stageNumber = Math.max(1, Math.floor(Number(stage) || 1));
      bucket.stages[String(stageNumber)] = {
        games: Math.max(0, Math.floor(Number(stats?.games) || 0)),
        wins: Math.max(0, Math.floor(Number(stats?.wins) || 0)),
        losses: Math.max(0, Math.floor(Number(stats?.losses) || 0)),
        durationTotal: Math.max(0, Number(stats?.durationTotal) || 0),
      };
    }
    return bucket;
  }

  function addMatchToBucket(bucket, match) {
    const win = match?.result === "win";
    const stageKey = String(Math.max(1, Math.floor(Number(match?.stage) || 1)));
    const duration = Math.max(0, Number(match?.duration) || 0);
    bucket.games++;
    bucket[win ? "wins" : "losses"]++;
    bucket.durationTotal = Math.round((bucket.durationTotal + duration) * 10) / 10;
    const run = normalizeRunContext(match?.run);
    const runLabel = run.mode === "TEST" ? `TEST ${run.speed}X` : "NORMAL";
    bucket.runModes[runLabel] = (bucket.runModes[runLabel] || 0) + 1;
    const stage = bucket.stages[stageKey] || { games: 0, wins: 0, losses: 0, durationTotal: 0 };
    stage.games++;
    stage[win ? "wins" : "losses"]++;
    stage.durationTotal = Math.round((stage.durationTotal + duration) * 10) / 10;
    bucket.stages[stageKey] = stage;
    for (const [key, count] of Object.entries(cleanCounters(match?.counters))) {
      bucket.counters[key] = (bucket.counters[key] || 0) + Math.max(0, Math.floor(Number(count) || 0));
    }
    for (const [type, modes] of Object.entries(cleanModeCounters(match?.modeCounters))) {
      const target = bucket.modeCounters[type] || {};
      for (const [mode, count] of Object.entries(modes)) target[mode] = (target[mode] || 0) + count;
      bucket.modeCounters[type] = target;
    }
  }

  function currentBuild() {
    const info = window.FCHotUpgradeVersion?.ai || {};
    const version = String(info.version || "UNVERSIONED").slice(0, 32);
    return {
      id: String(info.hash || version).slice(0, 64),
      version,
      developer: String(info.developer || "CODEX").slice(0, 24),
      model: String(info.model || "UNKNOWN").slice(0, 48),
      updatedAtBeijing: String(info.updatedAtBeijing || "UNKNOWN").slice(0, 40),
    };
  }

  function rebuildAnalytics(matches) {
    const analytics = { version: ANALYTICS_VERSION, generatedAt: Date.now(), total: emptyAnalyticsBucket(), builds: [] };
    if (!matches.length) return analytics;
    const legacy = {
      id: "LEGACY",
      version: "LEGACY",
      developer: "UNKNOWN",
      model: "UNKNOWN",
      updatedAtBeijing: "UNKNOWN",
      firstStartedAt: 0,
      lastEndedAt: 0,
      ...emptyAnalyticsBucket(),
    };
    for (const match of matches) {
      addMatchToBucket(analytics.total, match);
      addMatchToBucket(legacy, match);
    }
    legacy.firstStartedAt = Number(matches[0]?.startedAt) || 0;
    legacy.lastEndedAt = Number(matches[matches.length - 1]?.endedAt) || 0;
    analytics.builds.push(legacy);
    return analytics;
  }

  function normalizeAnalytics(value, matches) {
    if (Number(value?.version) !== ANALYTICS_VERSION || !Array.isArray(value?.builds)) return rebuildAnalytics(matches);
    return {
      version: ANALYTICS_VERSION,
      generatedAt: Math.max(0, Number(value.generatedAt) || 0),
      total: normalizeAnalyticsBucket(value.total),
      builds: value.builds.slice(-ANALYTICS_BUILD_LIMIT).map((build) => ({
        id: String(build?.id || "UNKNOWN").slice(0, 64),
        version: String(build?.version || "UNKNOWN").slice(0, 32),
        developer: String(build?.developer || "UNKNOWN").slice(0, 24),
        model: String(build?.model || "UNKNOWN").slice(0, 48),
        updatedAtBeijing: String(build?.updatedAtBeijing || "UNKNOWN").slice(0, 40),
        firstStartedAt: Math.max(0, Number(build?.firstStartedAt) || 0),
        lastEndedAt: Math.max(0, Number(build?.lastEndedAt) || 0),
        ...normalizeAnalyticsBucket(build),
      })),
    };
  }

  function indexFinishedMatch(match) {
    const build = match.build || currentBuild();
    experience.analytics.generatedAt = Date.now();
    addMatchToBucket(experience.analytics.total, match);
    let bucket = experience.analytics.builds.find((item) => item.id === build.id);
    if (!bucket) {
      bucket = { ...build, ...emptyAnalyticsBucket(), firstStartedAt: Number(match.startedAt) || Date.now(), lastEndedAt: 0 };
      experience.analytics.builds.push(bucket);
      experience.analytics.builds = experience.analytics.builds.slice(-ANALYTICS_BUILD_LIMIT);
    }
    bucket.lastEndedAt = Number(match.endedAt) || Date.now();
    addMatchToBucket(bucket, match);
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
    const matches = Array.isArray(value.matches) ? value.matches.slice(-MATCH_LIMIT).map((match) => ({
      ...match,
      run: normalizeRunContext(match?.run),
      counters: cleanCounters(match?.counters),
      modeCounters: cleanModeCounters(match?.modeCounters),
    })) : [];
    return {
      version: 3,
      games: Math.max(0, Math.floor(Number(value.games) || 0)),
      events: cleanEvents(value.events),
      matches,
      counters: cleanCounters(value.counters),
      analytics: normalizeAnalytics(value.analytics, matches),
      currentMatch: value.currentMatch ? {
        ...value.currentMatch,
        run: normalizeRunContext(value.currentMatch.run || runtimeRunContext()),
        counters: cleanCounters(value.currentMatch.counters),
        modeCounters: cleanModeCounters(value.currentMatch.modeCounters),
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

  function deltaPayload(events, matches) {
    return {
      delta: true,
      memory,
      training,
      experience: {
        version: experience.version,
        games: experience.games,
        counters: experience.counters,
        currentMatch: experience.currentMatch,
        events,
        matches,
      },
    };
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
      postDelta();
    }, MEMORY_SYNC_DELAY);
  }

  function postDelta() {
    if (!serverMode() || syncRequest) return syncRequest;
    const events = pendingEvents.slice();
    const matches = pendingMatches.slice();
    syncRequest = fetch(FILE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(deltaPayload(events, matches)),
    }).then((response) => {
      if (!response.ok) throw new Error(`AI memory sync ${response.status}`);
      const sentEvents = new Set(events);
      const sentMatches = new Set(matches);
      pendingEvents = pendingEvents.filter((item) => !sentEvents.has(item));
      pendingMatches = pendingMatches.filter((item) => !sentMatches.has(item));
    }).catch(() => {}).finally(() => { syncRequest = null; });
    return syncRequest;
  }

  function syncMemoryFileNow() {
    saveLocal();
    if (!serverMode()) return;
    postDelta();
  }

  async function restoreMemoryFile() {
    if (!serverMode()) return;
    try {
      const response = await fetch(`${FILE_URL}/runtime?v=${Date.now()}`, { cache: "no-store" });
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
      modeCounters: {},
      build: currentBuild(),
      run: normalizeRunContext(meta.run),
    };
    syncMemoryFile();
  }

  function recordExperience(type, detail = {}) {
    if (!type) return;
    const match = experience.currentMatch || {
      id: `${Date.now()}-${experience.games}`, stage: detail.stage || 1, events: 0, counters: {}, modeCounters: {}, build: currentBuild(), run: normalizeRunContext(detail.run),
    };
    match.events++;
    match.counters[type] = (match.counters[type] || 0) + 1;
    experience.counters[type] = (experience.counters[type] || 0) + 1;
    const mode = isCurrentMode(detail.mode) ? detail.mode : null;
    if (mode && TRACKED_MODE_EVENTS.has(type)) {
      match.modeCounters ||= {};
      match.modeCounters[type] ||= {};
      match.modeCounters[type][mode] = (match.modeCounters[type][mode] || 0) + 1;
    }
    experience.currentMatch = match;
    const event = {
      matchId: match.id,
      run: normalizeRunContext(match.run),
      stage: detail.stage ?? match.stage,
      time: Math.round((Number(detail.time) || 0) * 10) / 10,
      type,
      tank: compact(detail.tank),
      ally: compact(detail.ally),
      enemy: compact(detail.enemy),
      target: compact(detail.target),
      mode,
      reason: detail.reason || null,
      distance: Number.isFinite(detail.distance) ? Math.round(detail.distance) : null,
      bulletDir: detail.bulletDir || null,
      baseSource: detail.baseSource || null,
      baseTimeline: type === "base_hit" ? compactBaseTimeline(detail.baseTimeline) : null,
      historySamples: type === "base_hit" ? Math.max(0, Math.floor(Number(detail.historySamples) || 0)) : null,
      historySeconds: type === "base_hit" ? Math.round((Number(detail.historySeconds) || 0) * 10) / 10 : null,
      createdAt: Date.now(),
    };
    experience.events.push(event);
    pendingEvents.push(event);
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
      const summary = {
        id: match.id,
        stage,
        result: match.result,
        duration: match.duration,
        startedAt: match.startedAt,
        endedAt: match.endedAt,
        events: match.events,
        counters: cleanCounters(match.counters),
        modeCounters: cleanModeCounters(match.modeCounters),
        build: match.build || currentBuild(),
        run: normalizeRunContext(result.run || match.run),
      };
      indexFinishedMatch(summary);
      experience.matches.push(summary);
      pendingMatches.push(summary);
      experience.matches = experience.matches.slice(-MATCH_LIMIT);
    }
    memory.games = Math.max(Number(memory.games) || 0, experience.games);
    experience.currentMatch = null;
    syncMemoryFileNow();
  }

  function readExperienceDbStats() {
    return Promise.resolve({
      available: true,
      events: experience.events.length,
      matches: experience.games,
      indexedMatches: experience.analytics.total.games,
      builds: experience.analytics.builds.length,
    });
  }

  function resetMemory() {
    memory = normalizeMemory(defaults);
    experience = normalizeExperience({});
    training = normalizeTraining({});
    pendingEvents = [];
    pendingMatches = [];
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
