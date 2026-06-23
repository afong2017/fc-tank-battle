// @ts-check

(function () {
  const STORAGE_KEY = "fc-tank-battle.partner-ai.v2";
  const EXPERIENCE_KEY = "fc-tank-battle.ai-experience.v1";
  const EXPERIENCE_DB_NAME = "fc-tank-battle-ai";
  const EXPERIENCE_DB_VERSION = 1;
  const EXPERIENCE_EVENT_LIMIT = 200000;
  const EXPERIENCE_JSON_EVENT_LIMIT = 2400;
  const DISTANCE_CACHE_LIMIT = 24;
  const FILE_SYNC_URL = "/ai-memory";
  let fileMemoryCache = null;
  let fileExperienceCache = null;
  let fileTrainingCache = { seconds: 0, games: 0 };
  let experienceDbPromise = null;
  let archivedLegacyEvents = false;
  let experienceArchiveWrites = 0;
  let distanceWorker = null;
  let distanceWorkerSeq = 0;
  const workerPendingKeys = new Set();
  const TILE = 32;
  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };
  const DEFAULT_WEIGHTS = {
    defend: 2.75,
    survive: 2.0,
    attack: 1.5,
    clear: 1.35,
  };
  const MIN_WEIGHT = 0.6;
  const MAX_LEARNED_WEIGHT = 5;
  const MAX_EFFECTIVE_WEIGHT = 3.9;
  const DEFAULT_MEMORY = {
    weights: { ...DEFAULT_WEIGHTS },
    bestWeights: { ...DEFAULT_WEIGHTS },
    bestScore: -Infinity,
    lastScore: 0,
    badRuns: 0,
    games: 0,
    failures: {},
    streaks: {},
    patches: [],
    stageStats: {},
    highestStageCleared: 0,
    tacticalMemory: null,
    review: null,
    autoTuning: null,
    lastFailures: [],
    evolution: null,
  };
  const DEFAULT_STRATEGY_GENES = {
    killConfirm: { value: 0.55, score: 0, trials: 0 },
    laneBlock: { value: 0.55, score: 0, trials: 0 },
    panicGuard: { value: 0.62, score: 0, trials: 0 },
    dodgeDiscipline: { value: 0.5, score: 0, trials: 0 },
    clearAggression: { value: 0.5, score: 0, trials: 0 },
    targetPatience: { value: 0.45, score: 0, trials: 0 },
  };
  const FAILURE_TO_WEIGHT = {
    base_hit: { defend: 0.16, attack: 0.05 },
    enemy_cross_midline: { defend: 0.08, attack: 0.04 },
    ally_death: { survive: 0.12, defend: 0.03 },
    dodge_failed: { survive: 0.16 },
    friendly_fire: { survive: 0.08, attack: -0.04 },
    ally_stuck: { clear: 0.14, survive: 0.04 },
    route_clear_failed: { clear: 0.18, attack: 0.03 },
    target_stale: { attack: 0.07, clear: 0.08 },
    enemy_killed: { attack: 0.025 },
  };
  const PATCH_RULES = {
    base_hit: "base_lockdown",
    enemy_cross_midline: "midline_lock",
    ally_stuck: "unstuck_clear",
    route_clear_failed: "unstuck_clear",
    target_stale: "unstuck_clear",
    dodge_failed: "dodge_focus",
    ally_death: "dodge_focus",
  };

  function normalizeWeights(weights = {}) {
    const normalized = { ...DEFAULT_WEIGHTS };
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      const value = Number(weights[key]);
      if (Number.isFinite(value)) normalized[key] = clamp(value, MIN_WEIGHT, MAX_LEARNED_WEIGHT);
    }
    return normalized;
  }

  function loadMemory() {
    if (canUseServerSync()) {
      return normalizeMemory(fileMemoryCache?.memory || DEFAULT_MEMORY);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      return normalizeMemory(saved);
    } catch {
      return { ...DEFAULT_MEMORY, weights: { ...DEFAULT_WEIGHTS }, bestWeights: { ...DEFAULT_WEIGHTS } };
    }
  }

  function normalizeMemory(saved = {}) {
    return {
      weights: normalizeWeights(saved.weights),
      bestWeights: normalizeWeights(saved.bestWeights || saved.weights),
      bestScore: saved.bestScore === null ? -Infinity : Number.isFinite(Number(saved.bestScore)) ? Number(saved.bestScore) : -Infinity,
      lastScore: Number.isFinite(Number(saved.lastScore)) ? Number(saved.lastScore) : 0,
      badRuns: Number(saved.badRuns) || 0,
      games: Number(saved.games) || 0,
      failures: saved.failures && typeof saved.failures === "object" ? saved.failures : {},
      streaks: saved.streaks && typeof saved.streaks === "object" ? saved.streaks : {},
      patches: Array.isArray(saved.patches) ? saved.patches.slice(0, 4) : [],
      stageStats: saved.stageStats && typeof saved.stageStats === "object" ? saved.stageStats : {},
      highestStageCleared: Math.max(0, Math.floor(Number(saved.highestStageCleared) || 0)),
      tacticalMemory: normalizeTacticalMemory(saved.tacticalMemory),
      review: normalizeReview(saved.review),
      autoTuning: normalizeAutoTuning(saved.autoTuning),
      lastFailures: Array.isArray(saved.lastFailures) ? saved.lastFailures.slice(0, 4) : [],
      evolution: normalizeEvolution(saved.evolution),
    };
  }

  function normalizeAutoTuning(saved = {}) {
    return {
      version: 1,
      sampleGames: Math.max(0, Math.floor(Number(saved.sampleGames) || 0)),
      midlineTriggerOffset: clamp(Number(saved.midlineTriggerOffset) || 0, 0, 4),
      frontGuardBias: clamp(Number(saved.frontGuardBias) || 0, 0, 1),
      meleePenalty: clamp(Number(saved.meleePenalty) || 0, 0, 1),
      dodgeBias: clamp(Number(saved.dodgeBias) || 0, 0, 1),
      targetPatienceScale: clamp(Number.isFinite(Number(saved.targetPatienceScale)) ? Number(saved.targetPatienceScale) : 1, 0.45, 1.25),
      summary: typeof saved.summary === "string" ? saved.summary.slice(0, 160) : "",
      updatedAt: Number(saved.updatedAt) || 0,
    };
  }

  function normalizeReview(saved = {}) {
    return {
      version: 1,
      summary: typeof saved.summary === "string" ? saved.summary.slice(0, 120) : "",
      directives: Array.isArray(saved.directives) ? saved.directives.slice(0, 6) : [],
      focusSide: saved.focusSide === "left" || saved.focusSide === "right" ? saved.focusSide : null,
      stage: Math.max(0, Math.floor(Number(saved.stage) || 0)),
      updatedAt: Number(saved.updatedAt) || 0,
    };
  }

  function normalizeTacticalMemory(saved = {}) {
    const cleanMap = (source, limit = 80) => {
      const cleanSource = /** @type {Record<string, any>} */ (source && typeof source === "object" ? source : {});
      const entries = Object.entries(cleanSource)
        .map(([key, value]) => /** @type {[string, {score: number, hits: number, stage: number, x: number, y: number, dir: any, updatedAt: number}]} */ ([key, {
          score: clamp(Number(value?.score) || 0, -200, 200),
          hits: Math.max(0, Math.floor(Number(value?.hits) || 0)),
          stage: Math.max(0, Math.floor(Number(value?.stage) || 0)),
          x: Math.max(0, Math.floor(Number(value?.x) || 0)),
          y: Math.max(0, Math.floor(Number(value?.y) || 0)),
          dir: value?.dir || null,
          updatedAt: Number(value?.updatedAt) || 0,
        }]))
        .filter(([, value]) => Math.abs(value.score) > 0.05 || value.hits > 0)
        .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score) || b[1].updatedAt - a[1].updatedAt)
        .slice(0, limit);
      return Object.fromEntries(entries);
    };
    return {
      version: 1,
      baseThreatZones: cleanMap(saved.baseThreatZones, 80),
      killZones: cleanMap(saved.killZones, 80),
      replayCases: cleanMap(saved.replayCases, 120),
    };
  }

  function normalizeEvolution(saved = {}) {
    const genes = {};
    const source = saved?.genes || {};
    for (const [name, defaults] of Object.entries(DEFAULT_STRATEGY_GENES)) {
      const gene = source[name] || {};
      genes[name] = {
        value: clamp(Number.isFinite(Number(gene.value)) ? Number(gene.value) : defaults.value, 0, 1),
        score: Number.isFinite(Number(gene.score)) ? Number(gene.score) : defaults.score,
        trials: Math.max(0, Math.floor(Number(gene.trials) || 0)),
      };
    }
    const active = typeof saved?.active === "string" ? saved.active : "base";
    const saturated = Object.values(genes).filter((gene) => gene.value > 0.93).length >= Object.keys(genes).length - 1
      && Object.values(genes).every((gene) => gene.score < -1.5 || gene.trials > 40);
    if (saturated) {
      for (const [name, defaults] of Object.entries(DEFAULT_STRATEGY_GENES)) {
        genes[name].value = clamp((genes[name].value + defaults.value) / 2, 0.12, 0.96);
      }
    }
    return {
      version: 1,
      generation: Math.max(0, Math.floor(Number(saved?.generation) || 0)),
      active,
      lastMutation: saved?.lastMutation || null,
      genes,
    };
  }

  function saveMemory(memory) {
    if (canUseServerSync()) {
      fileMemoryCache = { memory: normalizeMemory(memory), experience: loadExperience() };
      syncMemoryFile();
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      // AI keeps working if storage is unavailable.
    }
    syncMemoryFile();
  }

  function loadExperience() {
    if (canUseServerSync()) {
      return normalizeExperience(fileExperienceCache?.experience || {});
    }
    try {
      const saved = JSON.parse(localStorage.getItem(EXPERIENCE_KEY)) || {};
      archiveLegacyEvents(saved);
      return normalizeExperience(saved);
    } catch {
      return { version: 1, games: 0, events: [], counters: {}, currentMatch: null };
    }
  }

  function normalizeExperience(saved = {}) {
    return {
      version: 1,
      games: Number(saved.games) || 0,
      events: Array.isArray(saved.events) ? saved.events.slice(-EXPERIENCE_JSON_EVENT_LIMIT) : [],
      counters: saved.counters && typeof saved.counters === "object" ? saved.counters : {},
      currentMatch: saved.currentMatch || null,
    };
  }

  function saveExperience(data) {
    if (canUseServerSync()) {
      fileExperienceCache = { memory: loadMemory(), experience: normalizeExperience(data) };
      syncMemoryFile();
      return;
    }
    try {
      localStorage.setItem(EXPERIENCE_KEY, JSON.stringify(data));
    } catch {
      // Training data is useful, but gameplay should never depend on storage.
    }
    syncMemoryFile();
  }

  function openExperienceDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (experienceDbPromise) return experienceDbPromise;
    experienceDbPromise = new Promise((resolve) => {
      const request = indexedDB.open(EXPERIENCE_DB_NAME, EXPERIENCE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("events")) {
          const store = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
          store.createIndex("matchId", "matchId", { unique: false });
          store.createIndex("type", "type", { unique: false });
          store.createIndex("stage", "stage", { unique: false });
          store.createIndex("mode", "mode", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("matches")) {
          const store = db.createObjectStore("matches", { keyPath: "id" });
          store.createIndex("stage", "stage", { unique: false });
          store.createIndex("result", "result", { unique: false });
          store.createIndex("endedAt", "endedAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return experienceDbPromise;
  }

  function getDistanceWorker() {
    if (distanceWorker !== null) return distanceWorker;
    try {
      distanceWorker = new Worker("ai-worker.js");
      distanceWorker.onmessage = (event) => {
        const message = event.data || {};
        workerPendingKeys.delete(message.cacheKey);
        if (message.type !== "distance-result" || !message.cacheKey || !Array.isArray(message.distMap)) return;
        if (!window.__TankAIDistanceWorkerCache) window.__TankAIDistanceWorkerCache = new Map();
        window.__TankAIDistanceWorkerCache.set(message.cacheKey, message.distMap);
        if (window.__TankAIDistanceWorkerCache.size > DISTANCE_CACHE_LIMIT * 2) {
          const firstKey = window.__TankAIDistanceWorkerCache.keys().next().value;
          window.__TankAIDistanceWorkerCache.delete(firstKey);
        }
      };
      distanceWorker.onerror = () => {
        distanceWorker = false;
      };
    } catch {
      distanceWorker = false;
    }
    return distanceWorker || null;
  }

  function warmDistanceWorker(ctx, cacheKey, goals, allowBrickClear) {
    if (workerPendingKeys.has(cacheKey)) return;
    const workerCache = window.__TankAIDistanceWorkerCache;
    if (workerCache?.has(cacheKey)) return;
    const worker = getDistanceWorker();
    if (!worker) return;
    const map = Array.isArray(ctx.map) ? ctx.map.map((row) => Array.isArray(row) ? row.join("") : String(row)) : [];
    const goalCells = goals.map((goal) => cellOf(goal, ctx.cols, ctx.rows));
    workerPendingKeys.add(cacheKey);
    worker.postMessage({
      id: ++distanceWorkerSeq,
      type: "distance",
      cacheKey,
      payload: {
        map,
        cols: ctx.cols,
        rows: ctx.rows,
        goals: goalCells,
        allowBrickClear,
      },
    });
  }

  function writeExperienceEvent(event) {
    openExperienceDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction("events", "readwrite");
        tx.objectStore("events").add({ ...event, createdAt: Date.now() });
        experienceArchiveWrites += 1;
        if (experienceArchiveWrites % 120 === 0) pruneExperienceEvents();
      } catch {
        // IndexedDB is an archive only; AI decisions use the compact summary.
      }
    });
  }

  function pruneExperienceEvents() {
    openExperienceDb().then((db) => {
      if (!db) return;
      try {
        const countTx = db.transaction("events", "readonly");
        const countReq = countTx.objectStore("events").count();
        countTx.oncomplete = () => {
          const extra = (countReq.result || 0) - EXPERIENCE_EVENT_LIMIT;
          if (extra <= 0) return;
          const tx = db.transaction("events", "readwrite");
          const index = tx.objectStore("events").index("createdAt");
          let removed = 0;
          index.openCursor().onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor || removed >= extra) return;
            cursor.delete();
            removed += 1;
            cursor.continue();
          };
        };
      } catch {
        // Pruning is best-effort.
      }
    });
  }

  function writeMatchSummary(match) {
    if (!match?.id) return;
    openExperienceDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction("matches", "readwrite");
        tx.objectStore("matches").put({
          id: match.id,
          stage: match.stage,
          startedAt: match.startedAt || null,
          endedAt: match.endedAt || Date.now(),
          duration: match.duration || 0,
          result: match.result || "unknown",
          events: match.events || 0,
          counters: match.counters || {},
        });
      } catch {
        // Keep gameplay independent from analytics storage.
      }
    });
  }

  function archiveLegacyEvents(data) {
    if (archivedLegacyEvents || !Array.isArray(data?.events) || !data.events.length) return;
    archivedLegacyEvents = true;
    const events = data.events.slice(-EXPERIENCE_EVENT_LIMIT);
    openExperienceDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction("events", "readwrite");
        const store = tx.objectStore("events");
        const now = Date.now();
        events.forEach((event, index) => store.add({ ...event, legacy: true, createdAt: now - events.length + index }));
        tx.oncomplete = () => pruneExperienceEvents();
      } catch {
        // Legacy import is opportunistic.
      }
    });
  }

  function clearExperienceDb() {
    openExperienceDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(["events", "matches"], "readwrite");
        tx.objectStore("events").clear();
        tx.objectStore("matches").clear();
      } catch {
        // Reset should still complete if IndexedDB is unavailable.
      }
    });
  }

  function readExperienceDbStats() {
    return openExperienceDb().then((db) => new Promise((resolve) => {
      if (!db) {
        resolve({ available: false, events: 0, matches: 0 });
        return;
      }
      try {
        const tx = db.transaction(["events", "matches"], "readonly");
        const eventsReq = tx.objectStore("events").count();
        const matchesReq = tx.objectStore("matches").count();
        tx.oncomplete = () => resolve({ available: true, events: eventsReq.result || 0, matches: matchesReq.result || 0 });
        tx.onerror = () => resolve({ available: false, events: 0, matches: 0 });
      } catch {
        resolve({ available: false, events: 0, matches: 0 });
      }
    }));
  }

  function canUseServerSync() {
    return /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  }

  let syncTimer = null;
  let syncBusy = false;
  let syncDirty = false;
  let restoringFromFile = false;
  function syncMemoryFile() {
    if (!canUseServerSync() || restoringFromFile) return;
    syncDirty = true;
    if (syncTimer || syncBusy) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      if (syncBusy || !syncDirty) return;
      syncDirty = false;
      syncBusy = true;
      try {
        await fetch(FILE_SYNC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memory: loadMemory(),
            experience: loadExperience(),
            training: readTraining(),
          }),
        });
      } catch {
        // localStorage remains the fallback if the local server is unavailable.
      } finally {
        syncBusy = false;
        if (syncDirty) syncMemoryFile();
      }
    }, 500);
  }

  function syncMemoryFileNow() {
    if (!canUseServerSync() || restoringFromFile) return;
    const payload = JSON.stringify({
      memory: loadMemory(),
      experience: loadExperience(),
      training: readTraining(),
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(FILE_SYNC_URL, new Blob([payload], { type: "application/json" }));
        syncDirty = false;
        return;
      }
    } catch {}
    fetch(FILE_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
    syncDirty = false;
  }

  function flushTraining() {
    if (!canUseServerSync() || restoringFromFile) return;
    fetch(FILE_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory: loadMemory(),
        experience: loadExperience(),
        training: readTraining(),
      }),
    }).then(() => {
      syncDirty = false;
    }).catch(() => {});
  }

  async function restoreMemoryFile() {
    if (!canUseServerSync()) return;
    restoringFromFile = true;
    try {
      const response = await fetch(`${FILE_SYNC_URL}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      archiveLegacyEvents(data?.experience || {});
      fileMemoryCache = { memory: normalizeMemory(data?.memory || DEFAULT_MEMORY), experience: normalizeExperience(data?.experience || {}) };
      fileExperienceCache = fileMemoryCache;
      fileTrainingCache = normalizeTraining(data?.training || {});
      bootstrapTacticalMemoryFromExperience();
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(EXPERIENCE_KEY);
      window.FCGameHotAPI?.reloadAiControllers?.();
    } catch {
      // Browser storage remains authoritative until the file can be read.
    } finally {
      restoringFromFile = false;
    }
  }

  function bootstrapTacticalMemoryFromExperience() {
    const memory = loadMemory();
    const tactical = normalizeTacticalMemory(memory.tacticalMemory);
    if (Object.keys(tactical.baseThreatZones).length && Object.keys(tactical.killZones).length && Object.keys(tactical.replayCases).length) return;
    const data = loadExperience();
    const events = Array.isArray(data.events) ? data.events : [];
    if (!events.length) return;
    memory.tacticalMemory = tactical;
    learnTacticalMemory(memory, events, { stage: 0, win: false });
    saveMemory(memory);
  }

  function resetMemory() {
    const memory = { ...DEFAULT_MEMORY, weights: { ...DEFAULT_WEIGHTS }, bestWeights: { ...DEFAULT_WEIGHTS } };
    const experience = { version: 1, games: 0, events: [], counters: {}, currentMatch: null };
    const training = { seconds: 0, games: 0 };
    fileMemoryCache = { memory, experience };
    fileExperienceCache = fileMemoryCache;
    fileTrainingCache = training;
    clearExperienceDb();
    if (canUseServerSync()) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(EXPERIENCE_KEY);
      syncMemoryFile();
      window.FCGameHotAPI?.reloadAiControllers?.();
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    localStorage.setItem(EXPERIENCE_KEY, JSON.stringify(experience));
    syncMemoryFile();
    window.FCGameHotAPI?.reloadAiControllers?.();
  }

  function compactItem(item) {
    if (!item) return null;
    return {
      x: Math.round(item.x ?? 0),
      y: Math.round(item.y ?? 0),
      dir: item.dir || null,
      kind: item.kind || null,
      mode: item.mode || null,
    };
  }

  function normalizeTraining(saved = {}) {
    return {
      seconds: Math.max(0, Number(saved.seconds) || 0),
      games: Math.max(0, Math.floor(Number(saved.games) || 0)),
    };
  }

  function readTraining() {
    return normalizeTraining(fileTrainingCache);
  }

  function addTrainingSeconds(seconds = 0) {
    fileTrainingCache = normalizeTraining({
      ...fileTrainingCache,
      seconds: (fileTrainingCache.seconds || 0) + Math.max(0, Number(seconds) || 0),
    });
    syncMemoryFile();
  }

  function incrementTrainingGames() {
    fileTrainingCache = normalizeTraining({
      ...fileTrainingCache,
      games: (fileTrainingCache.games || 0) + 1,
    });
    syncMemoryFileNow();
  }

  function startMatchExperience(meta = {}) {
    const data = loadExperience();
    data.games += 1;
    data.currentMatch = {
      id: `${Date.now()}-${data.games}`,
      stage: meta.stage,
      startedAt: Date.now(),
      events: 0,
      counters: {},
    };
    saveExperience(data);
  }

  function recordExperience(type, detail = {}) {
    if (!type) return;
    const data = loadExperience();
    const match = data.currentMatch || { id: `${Date.now()}-${data.games || 0}`, events: 0, counters: {} };
    match.events = (match.events || 0) + 1;
    match.counters[type] = (match.counters[type] || 0) + 1;
    if (detail.reason && detail.reason !== type) match.counters[detail.reason] = (match.counters[detail.reason] || 0) + 1;
    if (detail.mode) match.counters[`mode:${detail.mode}`] = (match.counters[`mode:${detail.mode}`] || 0) + 1;
    data.counters[type] = (data.counters[type] || 0) + 1;
    if (detail.reason && detail.reason !== type) data.counters[detail.reason] = (data.counters[detail.reason] || 0) + 1;
    if (detail.mode) data.counters[`mode:${detail.mode}`] = (data.counters[`mode:${detail.mode}`] || 0) + 1;
    data.currentMatch = match;
    const event = {
      matchId: match.id,
      stage: detail.stage ?? match.stage,
      time: Math.round((detail.time || 0) * 10) / 10,
      type,
      enemy: compactItem(detail.enemy),
      tank: compactItem(detail.tank),
      ally: compactItem(detail.ally),
      target: compactItem(detail.target),
      routeLength: detail.routeLength ?? null,
      bulletDir: detail.bulletDir || null,
      distance: Number.isFinite(detail.distance) ? Math.round(detail.distance) : null,
      angle: detail.angle || null,
      mode: detail.mode || null,
      reason: detail.reason || null,
      clear: Boolean(detail.clear),
      misread: Boolean(detail.misread),
      timelyReturn: detail.timelyReturn ?? null,
      staleSeconds: detail.staleSeconds ? Math.round(detail.staleSeconds * 10) / 10 : null,
    };
    data.events.push(event);
    data.events = data.events.slice(-EXPERIENCE_JSON_EVENT_LIMIT);
    writeExperienceEvent(event);
    saveExperience(data);
  }

  function finishMatchExperience(result = {}) {
    const data = loadExperience();
    if (data.currentMatch) {
      data.currentMatch.result = result.win ? "win" : "lose";
      data.currentMatch.duration = Math.round((result.duration || 0) * 10) / 10;
      data.currentMatch.endedAt = Date.now();
    }
    writeMatchSummary(data.currentMatch);
    const matchEvents = data.currentMatch?.id ? data.events.filter((event) => event.matchId === data.currentMatch.id) : [];
    learnFromMatch(data.currentMatch, result, matchEvents, data.events);
    saveExperience(data);
  }

  function matchScore(match, result = {}) {
    const counters = match?.counters || {};
    const duration = Number(result.duration ?? match?.duration) || 0;
    return Math.round(
      duration * 2
      + (result.win ? 1000 : 0)
      + (counters.enemy_killed || 0) * 80
      - (counters.ally_death || 0) * 180
      - (counters.dodge_failed || 0) * 90
      - (counters.friendly_fire || 0) * 260
      - (counters.base_hit || 0) * 800
      - (counters.enemy_cross_midline || 0) * 80
      - (counters.ally_stuck || 0) * 120
      - (counters.route_clear_failed || 0) * 110
      - (counters.target_stale || 0) * 90
    );
  }

  function rankFailures(counters = {}) {
    return Object.keys(counters)
      .filter((key) => key !== "enemy_killed" && counters[key] > 0)
      .sort((a, b) => counters[b] - counters[a])
      .slice(0, 4);
  }

  function eventZoneKey(item, stage = 0) {
    if (!item) return null;
    const x = Math.max(0, Math.floor((Number(item.x) || 0) / TILE));
    const y = Math.max(0, Math.floor((Number(item.y) || 0) / TILE));
    return `${stage}:${x},${y}`;
  }

  function updateZone(map, key, item, stage, delta) {
    if (!key || !item) return;
    const zone = map[key] || { score: 0, hits: 0, stage, x: Math.floor((Number(item.x) || 0) / TILE), y: Math.floor((Number(item.y) || 0) / TILE), dir: item.dir || null, updatedAt: 0 };
    zone.score = clamp(zone.score * 0.92 + delta, -200, 200);
    zone.hits += 1;
    zone.stage = stage;
    zone.x = Math.max(0, Math.floor((Number(item.x) || 0) / TILE));
    zone.y = Math.max(0, Math.floor((Number(item.y) || 0) / TILE));
    zone.dir = item.dir || zone.dir || null;
    zone.updatedAt = Date.now();
    map[key] = zone;
  }

  function learnTacticalMemory(memory, events = [], result = {}) {
    memory.tacticalMemory = normalizeTacticalMemory(memory.tacticalMemory);
    for (const event of events || []) {
      const stage = Math.max(0, Math.floor(Number(event.stage) || Number(result.stage) || 0));
      const enemy = event.enemy || event.target;
      if (!enemy) continue;
      if (event.type === "base_hit") {
        updateZone(memory.tacticalMemory.baseThreatZones, eventZoneKey(enemy, stage), enemy, stage, 18);
      } else if (event.type === "enemy_cross_midline" && event.timelyReturn === false) {
        updateZone(memory.tacticalMemory.baseThreatZones, eventZoneKey(enemy, stage), enemy, stage, 7);
      } else if (event.type === "ally_death" && event.reason === "dodge_failed") {
        updateZone(memory.tacticalMemory.baseThreatZones, eventZoneKey(enemy, stage), enemy, stage, 5);
      } else if (event.type === "enemy_killed") {
        updateZone(memory.tacticalMemory.killZones, eventZoneKey(enemy, stage), enemy, stage, 9);
        if (event.tank) updateZone(memory.tacticalMemory.killZones, eventZoneKey(event.tank, stage), event.tank, stage, 3);
      }
      if (event.type === "base_hit" || event.type === "ally_death" || event.type === "enemy_killed") {
        const delta = event.type === "enemy_killed" ? 6 : 10;
        updateZone(memory.tacticalMemory.replayCases, eventZoneKey(enemy, stage), enemy, stage, delta);
      }
    }
    if (result.win) {
      for (const zone of Object.values(memory.tacticalMemory.baseThreatZones)) zone.score *= 0.96;
    }
    memory.tacticalMemory = normalizeTacticalMemory(memory.tacticalMemory);
  }

  function buildHumanReview(match, result = {}, events = []) {
    const counters = match?.counters || {};
    const baseHits = Number(counters.base_hit) || 0;
    const midline = Number(counters.enemy_cross_midline) || 0;
    const stuck = Number(counters.ally_stuck) || 0;
    const deaths = Number(counters.ally_death) || 0;
    const friendly = Number(counters.friendly_fire) || 0;
    const kills = Number(counters.enemy_killed) || 0;
    const lateBreaches = events.filter((event) => event.type === "enemy_cross_midline" && event.timelyReturn === false);
    const baseHitEvents = events.filter((event) => event.type === "base_hit");
    const leftPressure = events.filter((event) => {
      const enemy = event.enemy || event.target;
      return enemy && (event.type === "base_hit" || event.type === "enemy_cross_midline") && enemy.x < TILE * 13;
    }).length;
    const rightPressure = events.filter((event) => {
      const enemy = event.enemy || event.target;
      return enemy && (event.type === "base_hit" || event.type === "enemy_cross_midline") && enemy.x >= TILE * 13;
    }).length;
    const directives = [];
    if (baseHits > 0 || lateBreaches.length > 2) directives.push("LOCK_BASE_GATE");
    if (midline > 8) directives.push("EARLY_MIDLINE_INTERCEPT");
    if (stuck > 4) directives.push("AVOID_STALE_ROUTE");
    if (deaths > 3) directives.push("MELEE_SURVIVE_FIRST");
    if (friendly > 0) directives.push("CHECK_FRIENDLY_FIRE");
    if (kills >= 10 && baseHits === 0) directives.push("REUSE_KILL_POSITIONS");
    const focusSide = leftPressure > rightPressure + 2 ? "left" : rightPressure > leftPressure + 2 ? "right" : null;
    const summary = baseHits > 0
      ? `老巢被打${baseHits}次，优先封门和中线拦截`
      : result.win
        ? `本局通关，复用成功击杀站位`
        : `未通关，突破${midline}次，卡住${stuck}次`;
    return normalizeReview({
      summary,
      directives,
      focusSide,
      stage: Math.max(0, Math.floor(Number(match?.stage || result.stage) || 0)),
      updatedAt: Date.now(),
      baseHitCount: baseHitEvents.length,
    });
  }

  function recentMatchStats(events = [], limit = 20) {
    const groups = new Map();
    for (const event of events || []) {
      if (!event.matchId) continue;
      if (!groups.has(event.matchId)) groups.set(event.matchId, []);
      groups.get(event.matchId).push(event);
    }
    return Array.from(groups.values()).slice(-limit).map((items) => {
      const counters = {};
      for (const event of items) {
        counters[event.type] = (counters[event.type] || 0) + 1;
        if (event.reason) counters[event.reason] = (counters[event.reason] || 0) + 1;
        if (event.mode) counters[`mode:${event.mode}`] = (counters[`mode:${event.mode}`] || 0) + 1;
        if (event.type === "enemy_cross_midline" && event.timelyReturn === false) counters.late_midline = (counters.late_midline || 0) + 1;
      }
      return counters;
    });
  }

  function buildAutoTuning(previous = {}, recentEvents = [], currentCounters = {}) {
    const matches = recentMatchStats(recentEvents, 20);
    const totals = /** @type {Record<string, number>} */ ({ ...currentCounters });
    for (const counters of matches) {
      for (const [key, value] of Object.entries(counters)) totals[key] = (totals[key] || 0) + value;
    }
    const games = Math.max(1, matches.length + 1);
    const perGame = (key) => (Number(totals[key]) || 0) / games;
    const cross = perGame("enemy_cross_midline");
    const base = perGame("base_hit");
    const deaths = perGame("ally_death");
    const dodge = perGame("dodge_failed");
    const stale = perGame("target_stale");
    const stuck = perGame("ally_stuck");
    const melee = perGame("mode:close-melee") + perGame("mode:close-melee-fire") + perGame("mode:close-melee-dodge");
    const hardMidline = perGame("mode:hard-midline") + perGame("mode:hard-midline-fire") + perGame("mode:hard-midline-clear");
    const lateRate = (Number(totals.enemy_cross_midline) || 0) > 0 ? (Number(totals.late_midline) || 0) / Number(totals.enemy_cross_midline) : 0;
    const target = normalizeAutoTuning({
      sampleGames: games,
      midlineTriggerOffset: clamp((cross - 6) / 2.2 + lateRate * 1.8 + base * 0.5 - hardMidline * 0.08, 0, 4),
      frontGuardBias: clamp((cross - 7) / 7 + base * 0.35 + lateRate * 0.7, 0, 1),
      meleePenalty: clamp((melee - 8) / 16 + base * 0.22 + deaths * 0.05, 0, 1),
      dodgeBias: clamp(dodge / 2.6 + deaths / 5.5, 0, 1),
      targetPatienceScale: clamp(1 - stale / 9 - stuck / 16, 0.45, 1.25),
      summary: `AUTO 修正: 中线${cross.toFixed(1)}/局 老巢${base.toFixed(2)}/局 近战${melee.toFixed(1)}/局 躲避${dodge.toFixed(1)}/局`,
      updatedAt: Date.now(),
    });
    const old = normalizeAutoTuning(previous);
    const smooth = (key, keep = 0.55) => clamp(old[key] * keep + target[key] * (1 - keep), key === "targetPatienceScale" ? 0.45 : 0, key === "targetPatienceScale" ? 1.25 : key === "midlineTriggerOffset" ? 4 : 1);
    return normalizeAutoTuning({
      ...target,
      midlineTriggerOffset: smooth("midlineTriggerOffset", 0.5),
      frontGuardBias: smooth("frontGuardBias"),
      meleePenalty: smooth("meleePenalty"),
      dodgeBias: smooth("dodgeBias"),
      targetPatienceScale: smooth("targetPatienceScale", 0.5),
    });
  }

  function evolveStrategies(memory, counters = {}, result = {}, score = 0) {
    memory.evolution = normalizeEvolution(memory.evolution);
    const genes = memory.evolution.genes;
    const modeCount = (mode) => Number(counters[`mode:${mode}`]) || 0;
    const killMode = modeCount("kill-confirm") + modeCount("kill-confirm-fire") + modeCount("kill-confirm-clear");
    const killFire = modeCount("kill-confirm-fire") + modeCount("kill-confirm-clear");
    const laneMode = modeCount("base-lane-block") + modeCount("base-lane-fire") + modeCount("base-lane-clear");
    const laneFire = modeCount("base-lane-fire") + modeCount("base-lane-clear");
    const lockdownMode = modeCount("patch-base-lockdown") + modeCount("patch-base-lockdown-fire") + modeCount("patch-base-lockdown-clear");
    const lockdownFire = modeCount("patch-base-lockdown-fire") + modeCount("patch-base-lockdown-clear");
    const kills = Number(counters.enemy_killed) || 0;
    const baseHits = Number(counters.base_hit) || 0;
    const stuck = Number(counters.ally_stuck) || 0;
    const stale = Number(counters.target_stale) || 0;
    const deaths = Number(counters.ally_death) || 0;
    const dodges = Number(counters.dodge_failed) || 0;
    const midline = Number(counters.enemy_cross_midline) || 0;
    const performance = clamp(score / 1200, -2, 1.6)
      + (result.win ? 2 : 0)
      + kills * 0.08
      - baseHits * 1.15
      - deaths * 0.24
      - dodges * 0.14
      - stuck * 0.16
      - stale * 0.13
      - midline * 0.08;
    const pressure = {
      killConfirm: baseHits + stale * 0.35 + midline * 0.12,
      laneBlock: baseHits * 1.4 + midline * 0.18,
      panicGuard: baseHits * 1.2 + deaths * 0.25,
      dodgeDiscipline: dodges + deaths * 0.45,
      clearAggression: stuck + (counters.route_clear_failed || 0) * 1.1 + stale * 0.2,
      targetPatience: stale + stuck * 0.25,
    };
    const fireRatio = (fire, total) => total > 0 ? fire / total : 0;
    const killRatio = killMode > 0 ? kills / killMode : 0;
    const laneRatio = fireRatio(laneFire, laneMode);
    const killConfirmRatio = fireRatio(killFire, killMode);
    const rewards = {
      killConfirm: performance + killRatio * 1.8 + killConfirmRatio * 0.9 - baseHits * 0.7 - stale * 0.12 - (killMode > 5 && killConfirmRatio < 0.18 ? 1.3 : 0),
      laneBlock: performance + laneRatio * 1.1 - baseHits * 0.9 - (laneMode > 4 && laneRatio < 0.2 ? 1.2 : 0),
      panicGuard: performance - baseHits * 0.85 - deaths * 0.1 + (lockdownFire > 0 ? 0.35 : 0),
      dodgeDiscipline: performance - deaths * 0.22 - dodges * 0.18 + (deaths === 0 ? 0.35 : 0),
      clearAggression: performance - stuck * 0.14 - stale * 0.1 + ((counters.route_clear_failed || 0) === 0 ? 0.25 : -0.45),
      targetPatience: performance - stale * 0.28 - stuck * 0.1 + (kills > 8 ? 0.25 : 0),
    };
    for (const [name, gene] of Object.entries(genes)) {
      const reward = rewards[name] ?? performance;
      gene.score = gene.score * 0.82 + reward * 0.18;
      gene.trials += 1;
      const direction = reward > 0.15 ? 1 : reward < -0.45 ? -1 : 0;
      const mutation = direction * (0.012 + Math.min(0.03, Math.abs(reward) * 0.006));
      gene.value = clamp(gene.value + mutation, 0.12, 0.96);
    }
    if (baseHits > 0 && kills < 8) {
      genes.killConfirm.value = clamp(genes.killConfirm.value + (killConfirmRatio >= 0.2 ? 0.025 : -0.07), 0.12, 0.96);
      genes.panicGuard.value = clamp(genes.panicGuard.value + (deaths <= 1 ? 0.02 : -0.025), 0.12, 0.96);
      genes.laneBlock.value = clamp(genes.laneBlock.value - (laneRatio < 0.25 ? 0.07 : 0.02), 0.12, 0.96);
    }
    if (stuck + stale > 6) {
      genes.clearAggression.value = clamp(genes.clearAggression.value + ((counters.route_clear_failed || 0) > 0 ? 0.025 : -0.02), 0.12, 0.96);
      genes.targetPatience.value = clamp(genes.targetPatience.value - 0.08, 0.12, 0.96);
    }
    const active = Object.entries(genes).sort((a, b) => b[1].value + b[1].score * 0.05 - (a[1].value + a[1].score * 0.05))[0]?.[0] || "base";
    memory.evolution.active = active;
    memory.evolution.generation += 1;
    memory.evolution.lastMutation = {
      at: new Date().toISOString(),
      score,
      active,
      pressure,
      ratios: { killConfirmRatio, laneRatio, killRatio },
    };
  }

  function learnFromMatch(match, result = {}, events = [], recentEvents = []) {
    if (!match) return;
    const memory = loadMemory();
    const counters = match.counters || {};
    const score = matchScore(match, result);
    const failures = rankFailures(counters);
    memory.games += 1;
    memory.lastScore = score;
    memory.lastFailures = failures;
    for (const key of failures) memory.failures[key] = (memory.failures[key] || 0) + counters[key];
    const stageKey = String(match.stage || result.stage || 0);
    const stage = memory.stageStats[stageKey] || { games: 0, wins: 0, bestScore: -Infinity, avgScore: 0, failures: {} };
    stage.games += 1;
    if (result.win) stage.wins += 1;
    stage.bestScore = Math.max(stage.bestScore, score);
    stage.avgScore = Math.round(((stage.avgScore * (stage.games - 1)) + score) / stage.games);
    for (const key of failures) stage.failures[key] = (stage.failures[key] || 0) + counters[key];
    memory.stageStats[stageKey] = stage;
    if (result.win) {
      const clearedStage = Math.max(0, Math.floor(Number(match.stage || result.stage) || 0));
      memory.highestStageCleared = Math.max(Math.floor(Number(memory.highestStageCleared) || 0), clearedStage);
    }
    learnTacticalMemory(memory, events, { ...result, stage: Number(match.stage || result.stage) || 0 });
    memory.review = buildHumanReview(match, result, events);
    memory.autoTuning = buildAutoTuning(memory.autoTuning, recentEvents, counters);

    const activePatches = new Set();
    for (const key of Object.keys(PATCH_RULES)) {
      memory.streaks[key] = counters[key] ? (memory.streaks[key] || 0) + 1 : Math.max(0, (memory.streaks[key] || 0) - 1);
      if (memory.streaks[key] >= 2) activePatches.add(PATCH_RULES[key]);
    }
    memory.patches = Array.from(activePatches).slice(0, 4);

    const nextWeights = { ...memory.weights };
    for (const [event, changes] of Object.entries(FAILURE_TO_WEIGHT)) {
      const count = counters[event] || 0;
      if (!count) continue;
      for (const [key, delta] of Object.entries(changes)) {
        const direction = event === "enemy_killed" ? 1 : Math.min(2.2, count);
        nextWeights[key] = (nextWeights[key] ?? DEFAULT_WEIGHTS[key]) + delta * direction;
      }
    }
    if (!result.win && counters.base_hit) {
      nextWeights.attack += 0.04;
      nextWeights.clear = Math.max(1.05, nextWeights.clear - 0.03);
    }
    if (result.win && counters.ally_death === 0 && counters.base_hit === 0) {
      nextWeights.attack += 0.02;
      nextWeights.survive += 0.01;
    }
    memory.weights = normalizeWeights(nextWeights);
    evolveStrategies(memory, counters, result, score);

    if (score >= memory.bestScore) {
      memory.bestScore = score;
      memory.bestWeights = { ...memory.weights };
      memory.badRuns = 0;
    } else {
      memory.badRuns += 1;
      if (memory.badRuns >= 3 && Number.isFinite(memory.bestScore)) {
        memory.weights = normalizeWeights(memory.bestWeights);
        memory.badRuns = 0;
      }
    }
    saveMemory(memory);
  }

  function centerX(item) {
    return item.x + (item.w || 0) / 2;
  }

  function centerY(item) {
    return item.y + (item.h || 0) / 2;
  }

  function dist(a, b) {
    return Math.abs(centerX(a) - centerX(b)) + Math.abs(centerY(a) - centerY(b));
  }

  function cellDist(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function directionTo(from, to) {
    const dx = centerX(to) - centerX(from);
    const dy = centerY(to) - centerY(from);
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
    return dy < 0 ? "up" : "down";
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function styleWeight(ctx, key) {
    const value = ctx?.weights?.[key];
    if (!Number.isFinite(value)) return DEFAULT_WEIGHTS[key] ?? 1;
    if (value <= 3) return value;
    return Math.min(MAX_EFFECTIVE_WEIGHT, 3 + (value - 3) * 0.45);
  }

  function adaptiveProfile(memory = {}) {
    const games = Math.max(1, Number(memory.games) || 0);
    const failures = memory.failures || {};
    const evolution = normalizeEvolution(memory.evolution);
    const autoTuning = normalizeAutoTuning(memory.autoTuning);
    const gene = (name) => evolution.genes?.[name]?.value ?? DEFAULT_STRATEGY_GENES[name]?.value ?? 0.5;
    const perGame = (key) => (Number(failures[key]) || 0) / games;
    const profile = {
      basePressure: clamp(perGame("base_hit") / 0.42, 0, 1),
      midlinePressure: clamp(perGame("enemy_cross_midline") / 4.2, 0, 1),
      stuckPressure: clamp(perGame("ally_stuck") / 1.8, 0, 1),
      stalePressure: clamp(perGame("target_stale") / 0.9, 0, 1),
      dodgePressure: clamp(perGame("dodge_failed") / 1.8, 0, 1),
      autoTuning,
      genes: evolution.genes,
      activeGene: evolution.active,
    };
    profile.killConfirm = gene("killConfirm") > 0.5 || (profile.basePressure > 0.28 && (profile.stuckPressure > 0.35 || profile.stalePressure > 0.35 || profile.midlinePressure > 0.65));
    profile.laneBlockBias = gene("laneBlock");
    profile.panicGuardBias = gene("panicGuard");
    profile.dodgeDiscipline = clamp(gene("dodgeDiscipline") + autoTuning.dodgeBias * 0.35, 0, 1);
    profile.clearAggression = gene("clearAggression");
    profile.targetPatience = clamp(gene("targetPatience") * autoTuning.targetPatienceScale, 0.12, 0.96);
    profile.midlineTriggerOffset = autoTuning.midlineTriggerOffset;
    profile.frontGuardBias = autoTuning.frontGuardBias;
    profile.meleePenalty = autoTuning.meleePenalty;
    return profile;
  }

  function hasPatch(ctx, name) {
    return Array.isArray(ctx?.patches) && ctx.patches.includes(name);
  }

  function hasDirective(ctx, directive) {
    return Array.isArray(ctx?.review?.directives) && ctx.review.directives.includes(directive);
  }

  function cellOf(item, cols, rows) {
    return {
      x: clamp(Math.floor(centerX(item) / TILE), 0, cols - 1),
      y: clamp(Math.floor(centerY(item) / TILE), 0, rows - 1),
    };
  }

  function tacticalZoneScore(ctx, item, type = "baseThreatZones") {
    const memory = ctx?.tacticalMemory?.[type];
    if (!item || !memory) return 0;
    const cell = cellOf(item, ctx.cols || 26, ctx.rows || 24);
    const stage = Math.max(0, Math.floor(Number(ctx.stage) || 0));
    let best = 0;
    for (const zone of Object.values(memory)) {
      if (zone.stage && stage && zone.stage !== stage) continue;
      const d = Math.abs(cell.x - zone.x) + Math.abs(cell.y - zone.y);
      if (d > 3) continue;
      const score = (Number(zone.score) || 0) / (1 + d * 0.8);
      if (Math.abs(score) > Math.abs(best)) best = score;
    }
    return best;
  }

  function key(x, y, cols) {
    return y * cols + x;
  }

  function baseBlocked(ctx, x, y) {
    if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) return true;
    const bx1 = Math.floor((ctx.baseGuard?.x ?? ctx.base.x - TILE) / TILE);
    const by1 = Math.floor((ctx.baseGuard?.y ?? ctx.base.y - TILE) / TILE);
    const bx2 = bx1 + Math.floor((ctx.baseGuard?.w ?? TILE * 4) / TILE) - 1;
    const by2 = by1 + Math.floor((ctx.baseGuard?.h ?? TILE * 3) / TILE) - 1;
    const baseX1 = Math.floor(ctx.base.x / TILE);
    const baseY1 = Math.floor(ctx.base.y / TILE);
    const baseX2 = Math.floor((ctx.base.x + ctx.base.w - 1) / TILE);
    const baseY2 = Math.floor((ctx.base.y + ctx.base.h - 1) / TILE);
    const inGuard = x >= bx1 && x <= bx2 && y >= by1 && y <= by2;
    const inBase = x >= baseX1 && x <= baseX2 && y >= baseY1 && y <= baseY2;
    return inGuard || inBase;
  }

  function walkable(ctx, x, y) {
    if (x < 0 || y < 0 || x >= ctx.cols || y >= ctx.rows) return false;
    if (baseBlocked(ctx, x, y)) return false;
    const t = ctx.tileAt?.(x, y);
    return t === "." || t === "F";
  }

  function inForest(ctx, item) {
    if (!item) return false;
    const x1 = Math.floor(item.x / TILE);
    const y1 = Math.floor(item.y / TILE);
    const x2 = Math.floor((item.x + (item.w || 0) - 1) / TILE);
    const y2 = Math.floor((item.y + (item.h || 0) - 1) / TILE);
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        if (ctx.tileAt?.(x, y) === "F") return true;
      }
    }
    return false;
  }

  function visibleEnemy(ctx, enemy) {
    return enemy?.alive && !inForest(ctx, enemy);
  }

  function makeBox(tank, dir, pixels) {
    const d = DIRS[dir];
    return { x: tank.x + d.x * pixels, y: tank.y + d.y * pixels, w: tank.w, h: tank.h };
  }

  function canMove(ctx, dir) {
    if (!dir) return false;
    return ctx.canMove ? ctx.canMove(dir) : true;
  }

  function incomingBullet(tank, bullets) {
    let best = null;
    let bestRisk = 0;
    for (const b of bullets) {
      if (!b.enemy) continue;
      const dx = Math.abs(centerX(tank) - centerX(b));
      const dy = Math.abs(centerY(tank) - centerY(b));
      let risk = 0;
      if ((b.dir === "up" || b.dir === "down") && dx < 54) {
        const coming = b.dir === "up" ? centerY(b) > centerY(tank) : centerY(b) < centerY(tank);
        if (coming) risk = Math.max(0, 360 - dy) + Math.max(0, 54 - dx) * 4.8;
      }
      if ((b.dir === "left" || b.dir === "right") && dy < 54) {
        const coming = b.dir === "left" ? centerX(b) > centerX(tank) : centerX(b) < centerX(tank);
        if (coming) risk = Math.max(0, 360 - dx) + Math.max(0, 54 - dy) * 4.8;
      }
      if (risk > bestRisk) {
        best = b;
        bestRisk = risk;
      }
    }
    return best;
  }

  function incomingFriendlyBullet(tank, bullets) {
    let best = null;
    let bestRisk = 0;
    for (const b of bullets) {
      if (b.enemy || b.owner === tank) continue;
      const dx = Math.abs(centerX(tank) - centerX(b));
      const dy = Math.abs(centerY(tank) - centerY(b));
      let risk = 0;
      if ((b.dir === "up" || b.dir === "down") && dx < 48) {
        const coming = b.dir === "up" ? centerY(b) > centerY(tank) : centerY(b) < centerY(tank);
        if (coming) risk = Math.max(0, 300 - dy) + Math.max(0, 48 - dx) * 4.2;
      }
      if ((b.dir === "left" || b.dir === "right") && dy < 48) {
        const coming = b.dir === "left" ? centerX(b) > centerX(tank) : centerX(b) < centerX(tank);
        if (coming) risk = Math.max(0, 300 - dx) + Math.max(0, 48 - dy) * 4.2;
      }
      if (risk > bestRisk) {
        best = b;
        bestRisk = risk;
      }
    }
    return bestRisk > 70 ? best : null;
  }

  function incomingAllyRadio(tank, reports = []) {
    let best = null;
    let bestRisk = 0;
    for (const report of reports) {
      if (!report || report.ttl <= 0) continue;
      const pseudo = {
        x: report.x,
        y: report.y,
        w: report.w || 6,
        h: report.h || 6,
        dir: report.dir,
        speed: report.speed || 310,
        enemy: false,
      };
      const risk = allyRadioRisk(tank, [report]);
      if (risk > bestRisk) {
        best = pseudo;
        bestRisk = risk;
      }
    }
    return bestRisk > 5.5 ? best : null;
  }

  function bulletFutureBox(bullet, seconds) {
    const d = DIRS[bullet.dir] || { x: 0, y: 0 };
    const speed = bullet.speed || (bullet.enemy ? 230 : 310);
    return {
      x: bullet.x + d.x * speed * seconds,
      y: bullet.y + d.y * speed * seconds,
      w: bullet.w || 6,
      h: bullet.h || 6,
      dir: bullet.dir,
      enemy: bullet.enemy,
    };
  }

  function bulletLineRisk(box, bullet, includeFriendly = false) {
    if (!bullet?.enemy && !includeFriendly) return 0;
    const friendlyScale = bullet.enemy ? 1 : 0.72;
    const dx = Math.abs(centerX(box) - centerX(bullet));
    const dy = Math.abs(centerY(box) - centerY(bullet));
    let risk = 0;
    if ((bullet.dir === "up" || bullet.dir === "down") && dx < 46) {
      const coming = bullet.dir === "up" ? centerY(bullet) > centerY(box) : centerY(bullet) < centerY(box);
      if (coming) risk += (Math.max(0, 360 - dy) / 22 + Math.max(0, 46 - dx) / 4.2) * friendlyScale;
    }
    if ((bullet.dir === "left" || bullet.dir === "right") && dy < 46) {
      const coming = bullet.dir === "left" ? centerX(bullet) > centerX(box) : centerX(bullet) < centerX(box);
      if (coming) risk += (Math.max(0, 360 - dx) / 22 + Math.max(0, 46 - dy) / 4.2) * friendlyScale;
    }
    return risk;
  }

  function bulletRisk(box, bullets, includeFriendly = false) {
    let risk = 0;
    for (const b of bullets) {
      risk += bulletLineRisk(box, b, includeFriendly);
      for (const seconds of [0.18, 0.32, 0.48]) {
        const future = bulletFutureBox(b, seconds);
        const futureRisk = bulletLineRisk(box, future, includeFriendly);
        risk += futureRisk * (seconds === 0.18 ? 0.9 : seconds === 0.32 ? 0.58 : 0.34);
      }
    }
    return risk;
  }

  function allyRadioRisk(box, reports = []) {
    let risk = 0;
    for (const report of reports) {
      if (!report || report.ttl <= 0) continue;
      const base = {
        x: report.x,
        y: report.y,
        w: report.w || 6,
        h: report.h || 6,
        dir: report.dir,
        speed: report.speed || 310,
        enemy: false,
      };
      const phaseScale = report.phase === "aim" ? 1.35 : 1;
      risk += bulletLineRisk(box, base, true) * phaseScale;
      for (const seconds of [0.12, 0.24, 0.38]) {
        risk += bulletLineRisk(box, bulletFutureBox(base, seconds), true) * phaseScale * (seconds === 0.12 ? 1.1 : seconds === 0.24 ? 0.75 : 0.45);
      }
    }
    return risk;
  }

  function futureBulletRisk(tank, dir, bullets, includeFriendly = false) {
    const near = makeBox(tank, dir, 34);
    const far = makeBox(tank, dir, 62);
    const escape = makeBox(tank, dir, 92);
    return bulletRisk(near, bullets, includeFriendly) * 1.45
      + bulletRisk(far, bullets, includeFriendly) * 0.9
      + bulletRisk(escape, bullets, includeFriendly) * 0.45;
  }

  function movePathRisk(tank, dir, bullets, reports = []) {
    let risk = 0;
    for (const pixels of [14, 28, 42, 58, 76]) {
      const step = makeBox(tank, dir, pixels);
      risk += bulletRisk(step, bullets || [], true) * (pixels <= 28 ? 1.1 : 0.72);
      risk += allyRadioRisk(step, reports) * (pixels <= 28 ? 1.0 : 0.62);
    }
    return risk;
  }

  function enemyBulletCollisionRisk(box, bullet) {
    if (!bullet?.enemy) return 0;
    const dx = Math.abs(centerX(box) - centerX(bullet));
    const dy = Math.abs(centerY(box) - centerY(bullet));
    if ((bullet.dir === "up" || bullet.dir === "down") && dx < 28) {
      const coming = bullet.dir === "up" ? centerY(bullet) >= centerY(box) - 10 : centerY(bullet) <= centerY(box) + 10;
      if (coming) return Math.max(0, 280 - dy) / 8 + Math.max(0, 28 - dx) * 1.6;
    }
    if ((bullet.dir === "left" || bullet.dir === "right") && dy < 28) {
      const coming = bullet.dir === "left" ? centerX(bullet) >= centerX(box) - 10 : centerX(bullet) <= centerX(box) + 10;
      if (coming) return Math.max(0, 280 - dx) / 8 + Math.max(0, 28 - dy) * 1.6;
    }
    return 0;
  }

  function moveIntoEnemyBulletRisk(tank, dir, bullets = []) {
    if (!DIRS[dir]) return Infinity;
    let risk = 0;
    for (const pixels of [12, 24, 38, 54]) {
      const step = makeBox(tank, dir, pixels);
      for (const bullet of bullets || []) {
        risk += enemyBulletCollisionRisk(step, bullet);
        for (const seconds of [0.08, 0.16, 0.26]) {
          risk += enemyBulletCollisionRisk(step, bulletFutureBox(bullet, seconds)) * (seconds === 0.08 ? 1.2 : seconds === 0.16 ? 0.8 : 0.45);
        }
      }
    }
    return risk;
  }

  function isMoveIntoEnemyBullet(tank, dir, bullets = [], threshold = 10) {
    return moveIntoEnemyBulletRisk(tank, dir, bullets) >= threshold;
  }

  function routeBulletThreshold(mode) {
    if (mode === "bonus") return 18;
    if (mode === "intercept" || mode === "defend") return 14;
    return 9;
  }

  function threatLine(enemy, target, tolerance = 24) {
    const dx = centerX(target) - centerX(enemy);
    const dy = centerY(target) - centerY(enemy);
    if ((enemy.dir === "up" || enemy.dir === "down") && Math.abs(dx) < tolerance) {
      return enemy.dir === "up" ? dy < 0 : dy > 0;
    }
    if ((enemy.dir === "left" || enemy.dir === "right") && Math.abs(dy) < tolerance) {
      return enemy.dir === "left" ? dx < 0 : dx > 0;
    }
    return false;
  }

  function baseThreatScore(ctx, enemy) {
    const d = dist(enemy, ctx.base);
    const ex = centerX(enemy);
    const ey = centerY(enemy);
    const bx = centerX(ctx.base);
    const by = centerY(ctx.base);
    const lane = Math.abs(ex - bx);
    const nearFront = by - ey;
    let score = Math.max(0, 860 - d) / 36;
    score += Math.max(0, ey - by + 470) / 58;
    score += Math.max(0, 230 - lane) / 20;
    if (threatLine(enemy, ctx.base, 46)) score += 22;
    if (nearFront < TILE * 11 && Math.abs(ex - bx) < TILE * 8) score += 20;
    if (nearFront < TILE * 7 && Math.abs(ex - bx) < TILE * 10) score += 16;
    if (nearFront < TILE * 5) score += 14;
    if (ey > by - TILE * 7 && Math.abs(ex - bx) < TILE * 11) score += 12;
    if (enemy.dir === "down" && ey < by) score += 12;
    if ((enemy.dir === "left" || enemy.dir === "right") && Math.abs(ey - by) < TILE * 5) score += 9;
    const fieldMid = (ctx.rows || 24) * TILE * 0.5;
    const centerLane = lane < TILE * 5.6;
    const lowerCenterLane = ey > fieldMid - TILE * 2.8 && lane < TILE * 8.5;
    if (centerLane && ey > fieldMid - TILE * 5.5) score += 14;
    if (lowerCenterLane) score += 20 + Math.max(0, ey - (fieldMid - TILE * 2.8)) / 18;
    if (enemy.dir === "down" && lane < TILE * 9 && ey > fieldMid - TILE * 6.5) score += 16;
    score += Math.max(0, tacticalZoneScore(ctx, enemy, "baseThreatZones")) * 0.85;
    if (ey > (ctx.rows || 24) * TILE * 0.5) score += 18 + Math.max(0, by - ey) / 22;
    if (ey > by - TILE * 9 && Math.abs(ex - bx) < TILE * 9) score += 22;
    if (hasDirective(ctx, "LOCK_BASE_GATE") && ey > by - TILE * 10) score += 20;
    if (hasDirective(ctx, "EARLY_MIDLINE_INTERCEPT") && ey > (ctx.rows || 24) * TILE * 0.46) score += 18;
    return score;
  }

  function reservedTarget(ctx, enemy) {
    return ctx.reservedTargets?.some((target) => target?.alive && target === enemy);
  }

  function sideBoundary(ctx) {
    return (ctx.cols || 26) * TILE * 0.5;
  }

  function ownSide(ctx, item, name) {
    return name === "1P" ? centerX(item) < sideBoundary(ctx) : centerX(item) >= sideBoundary(ctx);
  }

  function ownSideEnemies(ctx, name) {
    return ctx.enemies.filter((enemy) => visibleEnemy(ctx, enemy) && ownSide(ctx, enemy, name));
  }

  function canCrossToHelp(ctx, name) {
    return ownSideEnemies(ctx, name).length === 0;
  }

  function criticalBaseThreat(ctx, enemy) {
    if (!visibleEnemy(ctx, enemy)) return false;
    const bx = centerX(ctx.base);
    const by = centerY(ctx.base);
    const ex = centerX(enemy);
    const ey = centerY(enemy);
    const dx = Math.abs(ex - bx);
    const dy = Math.abs(ey - by);
    const lowerHalf = ey >= (ctx.rows || 24) * TILE * 0.5;
    const lowerLane = lowerHalf && dx < TILE * 12;
    const nearBase = dy < TILE * 11 && dx < TILE * 13;
    const directLane = threatLine(enemy, ctx.base, 78) && ey > by - TILE * 15;
    const learnedUrgency = (ctx.adaptive?.basePressure || 0) * 4 + (ctx.adaptive?.midlinePressure || 0) * 3;
    return lowerLane || nearBase || directLane || baseThreatScore(ctx, enemy) > Math.max(8, 14 - learnedUrgency);
  }

  function eligibleSideTarget(ctx, enemy, name) {
    if (!visibleEnemy(ctx, enemy)) return false;
    if ((ctx.freezeTime || 0) > 0.05) return true;
    if (criticalBaseThreat(ctx, enemy)) return true;
    if ((ctx.enemies || []).filter((item) => visibleEnemy(ctx, item)).length < 3) return true;
    return ownSide(ctx, enemy, name) || canCrossToHelp(ctx, name);
  }

  function baseThreats(ctx) {
    const ranked = [];
    for (const enemy of ctx.enemies) {
      if (!visibleEnemy(ctx, enemy)) continue;
      const score = baseThreatScore(ctx, enemy);
      ranked.push({ enemy, score, rawScore: score });
    }
    if (ranked.length > 1) {
      for (const item of ranked) {
        if (reservedTarget(ctx, item.enemy) && item.rawScore < 34 && !criticalBaseThreat(ctx, item.enemy)) item.score -= 1000;
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  function closeBaseAndAllyThreat(ctx, enemy, tank) {
    const baseDistance = dist(enemy, ctx.base);
    const allies = [tank, ...(ctx.friends || [])].filter(Boolean);
    const nearestAlly = Math.min(...allies.map((ally) => dist(enemy, ally)));
    const lowerHalf = centerY(enemy) >= (ctx.rows || 24) * TILE * 0.5;
    return baseDistance < TILE * 12 && nearestAlly < TILE * 8.5 && lowerHalf;
  }

  function urgentBaseThreat(ctx) {
    const bx = centerX(ctx.base);
    const by = centerY(ctx.base);
    let best = null;
    let bestScore = -Infinity;
    for (const enemy of ctx.enemies) {
      if (!visibleEnemy(ctx, enemy)) continue;
      const ex = centerX(enemy);
      const ey = centerY(enemy);
      const dx = Math.abs(ex - bx);
      const dy = Math.abs(ey - by);
      const lowerApproach = ey > by - TILE * 12 && dx < TILE * 11;
      const basePocket = dy < TILE * 9.5 && dx < TILE * 12;
      const firingLane = threatLine(enemy, ctx.base, 68) && ey > by - TILE * 14;
      if (!lowerApproach && !basePocket && !firingLane) continue;
      const score = baseThreatScore(ctx, enemy) + Math.max(0, TILE * 10 - dx) / 7 + Math.max(0, TILE * 8 - dy) / 8;
      if (score > bestScore) {
        best = enemy;
        bestScore = score;
      }
    }
    return best;
  }

  function baseThreat(ctx) {
    const ranked = baseThreats(ctx);
    return ranked.length && ranked[0].score > 8 ? ranked[0].enemy : null;
  }

  function bestEnemy(ctx, tank, name) {
    let best = null;
    let bestScore = -Infinity;
    const defendWeight = styleWeight(ctx, "defend");
    const attackWeight = styleWeight(ctx, "attack");
    const surviveWeight = styleWeight(ctx, "survive");
    const clearWeight = styleWeight(ctx, "clear");
    const midline = (ctx.rows || 24) * TILE * 0.5;
    const hasLowerEnemy = ctx.enemies.some((enemy) => visibleEnemy(ctx, enemy) && centerY(enemy) >= midline);
    const ownEnemies = ownSideEnemies(ctx, name);
    const canHelpOtherSide = ownEnemies.length === 0;
    for (const enemy of ctx.enemies) {
      if (!visibleEnemy(ctx, enemy)) continue;
      if (!eligibleSideTarget(ctx, enemy, name)) continue;
      const personalDistance = dist(tank, enemy);
      const route = routeDistanceToTarget(ctx, tank, enemy);
      const baseScore = baseThreatScore(ctx, enemy);
      const learnedDanger = Math.max(0, tacticalZoneScore(ctx, enemy, "baseThreatZones"));
      const learnedKill = Math.max(0, tacticalZoneScore(ctx, enemy, "killZones"));
      const learnedCase = Math.max(0, tacticalZoneScore(ctx, enemy, "replayCases"));
      const upperHalf = centerY(enemy) < midline;
      const closeBaseAndAlly = closeBaseAndAllyThreat(ctx, enemy, tank);
      const closeRange = personalDistance < TILE * 5.5;
      const immediateRange = personalDistance < TILE * 3.2;
      const routeReachable = Number.isFinite(route);
      const inOwnSide = ownSide(ctx, enemy, name);
      let score = -personalDistance * (1.45 + (surviveWeight - 1) * 0.25);
      score += Number.isFinite(route)
        ? -route * (24 + attackWeight * 6 + clearWeight * 2) + Math.max(0, 42 - route) * (4.5 + attackWeight)
        : (ctx.enemies.length > 1 ? -900 : -180);
      if (closeRange) score += (TILE * 5.5 - personalDistance) * (14 + attackWeight * 2.4);
      if (immediateRange) score += 2200 + attackWeight * 260;
      if (routeReachable && route <= 8) score += (9 - route) * (95 + attackWeight * 16);
      if (ctx.canShoot?.(tank.dir, enemy)) score += (personalDistance < TILE * 8 ? 1200 : 560) + attackWeight * 150;
      if (inOwnSide) score += 2600;
      else if (canHelpOtherSide) score += 480;
      if (closeBaseAndAlly) score += 5000 * defendWeight;
      if (baseScore > 28) score += baseScore * (22 + defendWeight * 5);
      else score += baseScore * (5.5 + defendWeight);
      if (learnedDanger > 0) score += learnedDanger * (35 + defendWeight * 8);
      if (learnedKill > 0 && personalDistance < TILE * 10) score += learnedKill * (7 + attackWeight * 2);
      if (learnedCase > 0) score += learnedCase * (8 + defendWeight * 2);
      if (ctx.review?.focusSide === "left" && centerX(enemy) < sideBoundary(ctx)) score += 420;
      if (ctx.review?.focusSide === "right" && centerX(enemy) >= sideBoundary(ctx)) score += 420;
      if (hasDirective(ctx, "REUSE_KILL_POSITIONS") && learnedKill > 0) score += learnedKill * 12;
      if (hasLowerEnemy && upperHalf && baseScore < 28 && !closeRange) score -= 2200;
      if (!upperHalf) score += 900 + (attackWeight - 1) * 160;
      if (centerY(enemy) > midline && personalDistance < TILE * 9) score += 1500;
      if (centerY(enemy) > centerY(ctx.base) - TILE * 9 && Math.abs(centerX(enemy) - centerX(ctx.base)) < TILE * 10) score += 2600;
      if (centerY(enemy) > midline - TILE * (2.5 + (ctx.adaptive?.midlineTriggerOffset || 0)) && Math.abs(centerX(enemy) - centerX(ctx.base)) < TILE * 11) score += 1800 + baseScore * 18 + (ctx.adaptive?.frontGuardBias || 0) * 900;
      if (ctx.enemies.length < 3) score += Math.max(0, TILE * 10 - personalDistance) * 0.6;
      if (ctx.canShoot?.(tank.dir, enemy)) score += 12 + attackWeight * 2.5;
      if (threatLine(enemy, tank)) score += 7 + defendWeight * 1.2;
      if (ctx.friends?.some((ally) => threatLine(enemy, ally))) score += 3 + defendWeight * 0.5;
      if (ctx.staleTarget === enemy && baseScore < 24 && personalDistance > TILE * 3.2) score -= 1600;
      if (ctx.enemies.length > 1 && reservedTarget(ctx, enemy)) score -= 1000;
      if (score > bestScore) {
        best = enemy;
        bestScore = score;
      }
    }
    return best;
  }

  function immediateEnemy(ctx, tank, name) {
    return ctx.enemies
      .filter((enemy) => {
        if (!visibleEnemy(ctx, enemy) || !eligibleSideTarget(ctx, enemy, name)) return false;
        const personalRange = dist(tank, enemy) < TILE * 5.4;
        const baseMeleeRange = dist(tank, enemy) < TILE * 8.2 && dist(enemy, ctx.base) < TILE * 9.5 && centerY(enemy) > centerY(ctx.base) - TILE * 9;
        return personalRange || baseMeleeRange;
      })
      .map((enemy) => {
        const d = dist(tank, enemy);
        const route = routeDistanceToTarget(ctx, tank, enemy);
        let score = -d;
        if (ctx.canShoot?.(tank.dir, enemy)) score += 900;
        if (threatLine(enemy, tank, 42)) score += 420;
        if (dist(enemy, ctx.base) < TILE * 9.5) score += 900;
        score += baseThreatScore(ctx, enemy) * 22;
        if (Number.isFinite(route)) score += Math.max(0, 8 - route) * 80;
        return { enemy, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.enemy || null;
  }

  function routeDistanceToTarget(ctx, tank, target) {
    if (!ctx._routeDistanceCache) ctx._routeDistanceCache = new Map();
    const tankCell = cellOf(tank, ctx.cols, ctx.rows);
    const targetCell = cellOf(target, ctx.cols, ctx.rows);
    const cacheKey = `${tankCell.x},${tankCell.y}->${targetCell.x},${targetCell.y}`;
    if (ctx._routeDistanceCache.has(cacheKey)) return ctx._routeDistanceCache.get(cacheKey);
    const goals = attackGoals(ctx, target);
    const routeGoals = goals.length ? goals : approachGoals(ctx, target);
    if (!routeGoals.length) {
      ctx._routeDistanceCache.set(cacheKey, Infinity);
      return Infinity;
    }
    const distMap = buildWeightedDistance(ctx, routeGoals, true);
    const result = distMap[key(tankCell.x, tankCell.y, ctx.cols)];
    ctx._routeDistanceCache.set(cacheKey, result);
    return result;
  }

  function routeDistanceToPoint(ctx, tank, target, allowBrickClear = false) {
    if (!target) return Infinity;
    const distMap = buildWeightedDistance(ctx, [target], allowBrickClear);
    const here = cellOf(tank, ctx.cols, ctx.rows);
    return distMap[key(here.x, here.y, ctx.cols)];
  }

  function nearbyBonus(ctx, tank) {
    let best = null;
    let bestScore = -Infinity;
    const basePressure = (ctx.adaptive?.basePressure || 0) + (ctx.adaptive?.midlinePressure || 0);
    for (const bonus of ctx.bonuses || []) {
      if (bonus.dead || bonus.ttl <= 0) continue;
      const direct = dist(tank, bonus);
      if (direct > TILE * 8 && bonus.ttl > 2.2) continue;
      const route = routeDistanceToPoint(ctx, tank, bonus, false);
      if (!Number.isFinite(route) || route > 12) continue;
      const freezeValue = bonus.type === "freeze" ? 90 + basePressure * 65 : 0;
      const score = freezeValue + Math.max(0, TILE * 9 - direct) / 12 + Math.max(0, 7 - bonus.ttl) * 8 - route * 3;
      if (score > bestScore) {
        best = bonus;
        bestScore = score;
      }
    }
    return best;
  }

  function nearFreezeBonus(ctx, tank) {
    return (ctx.bonuses || [])
      .filter((bonus) => bonus.type === "freeze" && !bonus.dead && bonus.ttl > 0 && dist(tank, bonus) <= TILE * 5.2)
      .map((bonus) => {
        const route = routeDistanceToPoint(ctx, tank, bonus, false);
        return { bonus, route, direct: dist(tank, bonus) };
      })
      .filter((item) => (Number.isFinite(item.route) && item.route <= 7) || item.direct <= TILE * 2.2)
      .sort((a, b) => a.route - b.route || a.direct - b.direct)[0]?.bonus || null;
  }

  function freezeAssaultTarget(ctx, tank, name) {
    if ((ctx.freezeTime || 0) <= 0.05) return null;
    const visibleCount = (ctx.enemies || []).filter((enemy) => visibleEnemy(ctx, enemy)).length;
    return (ctx.enemies || [])
      .filter((enemy) => visibleEnemy(ctx, enemy) && eligibleSideTarget(ctx, enemy, name))
      .map((enemy) => {
        const nearBase = Math.max(0, TILE * 14 - dist(enemy, ctx.base)) / 8;
        const nearSelf = Math.max(0, TILE * 12 - dist(enemy, tank)) / 10;
        const route = routeDistanceToPoint(ctx, tank, enemy, true);
        const routeScore = Number.isFinite(route) ? route * 7 : 120;
        const reservedPenalty = visibleCount > 1 && reservedTarget(ctx, enemy) && !criticalBaseThreat(ctx, enemy) ? 1400 : 0;
        return { enemy, score: nearBase + nearSelf - routeScore + baseThreatScore(ctx, enemy) * 2.2 - reservedPenalty };
      })
      .sort((a, b) => b.score - a.score)[0]?.enemy || null;
  }

  function urgentFreezeBonus(ctx, tank) {
    const threat = urgentBaseThreat(ctx) || baseFireLaneThreat(ctx) || baseIntruder(ctx, tank.kind === "player" ? "1P" : "2P");
    const basePressure = Boolean(threat) || (ctx.adaptive?.basePressure || 0) > 0.35 || (ctx.adaptive?.midlinePressure || 0) > 0.45;
    const maxDirect = basePressure ? TILE * 8 : TILE * 5;
    const maxRoute = basePressure ? 12 : 8;
    return (ctx.bonuses || [])
      .filter((bonus) => bonus.type === "freeze" && !bonus.dead && bonus.ttl > 0 && dist(tank, bonus) <= maxDirect)
      .map((bonus) => {
        const route = routeDistanceToPoint(ctx, tank, bonus, false);
        const routeScore = Number.isFinite(route) ? route : Infinity;
        const threatBonus = basePressure ? 100 : 0;
        return { bonus, route, score: threatBonus - routeScore * 9 - dist(tank, bonus) / 18 + Math.max(0, bonus.ttl) * 2 };
      })
      .filter((item) => Number.isFinite(item.route) && item.route <= maxRoute)
      .sort((a, b) => b.score - a.score || a.route - b.route || dist(tank, a.bonus) - dist(tank, b.bonus))[0]?.bonus || null;
  }

  function scanBattlefield(ctx, tank, name) {
    const threats = baseThreats(ctx);
    const forced = visibleEnemy(ctx, ctx.forcedTarget) ? ctx.forcedTarget : null;
    const defendWeight = styleWeight(ctx, "defend");
    const learnedPressure = (ctx.adaptive?.basePressure || 0) * 3.2 + (ctx.adaptive?.midlinePressure || 0) * 2.2;
    const emergencyThreshold = Math.max(7.5, 16 - Math.min(5, (defendWeight - 1) * 2.6) - learnedPressure);
    const closeThreat = ctx.enemies
      .filter((enemy) => enemy.alive && eligibleSideTarget(ctx, enemy, name) && closeBaseAndAllyThreat(ctx, enemy, tank))
      .sort((a, b) => dist(a, tank) - dist(b, tank))[0];
    const urgent = forced || closeThreat || urgentBaseThreat(ctx);
    const eligibleThreat = threats.find((item) => eligibleSideTarget(ctx, item.enemy, name));
    const sideUrgent = urgent && eligibleSideTarget(ctx, urgent, name) ? urgent : null;
    const baseTarget = forced || sideUrgent || (eligibleThreat && (eligibleThreat.rawScore ?? eligibleThreat.score) > emergencyThreshold ? eligibleThreat.enemy : null);
    const closeCombatTarget = forced ? null : immediateEnemy(ctx, tank, name);
    const enemyTarget = forced || bestEnemy(ctx, tank, name);
    const radioBullet = incomingAllyRadio(tank, ctx.allyFireReports || []);
    const bullet = incomingBullet(tank, ctx.bullets || []) || incomingFriendlyBullet(tank, ctx.bullets || []) || radioBullet;
    const currentBulletRisk = bulletRisk(tank, ctx.bullets || [], true) + allyRadioRisk(tank, ctx.allyFireReports || []);
    return {
      threats,
      emergency: Boolean(urgent) || threats.some((item) => (item.rawScore ?? item.score) > emergencyThreshold),
      forced: Boolean(forced),
      baseTarget,
      enemyTarget,
      closeCombatTarget,
      bullet,
      bulletRisk: currentBulletRisk,
      baseShot: baseDangerClose(ctx, baseTarget) ? safeShotDir(ctx, tank, baseTarget) : shotDir(ctx, tank, baseTarget),
      enemyShot: shotDir(ctx, tank, enemyTarget),
      closeCombatShot: sideLaneShotTooEarly(ctx, tank, closeCombatTarget) ? null : shotDir(ctx, tank, closeCombatTarget),
      baseLineClear: attackLineClearDir(ctx, tank, baseTarget, true),
      enemyLineClear: attackLineClearDir(ctx, tank, enemyTarget, false),
      closeCombatLineClear: attackLineClearDir(ctx, tank, closeCombatTarget, false),
    };
  }

  function guardGoals(ctx, name) {
    const side = name === "1P" ? -1 : 1;
    const bx = Math.floor(centerX(ctx.base) / TILE);
    const by = Math.floor(ctx.base.y / TILE);
    const roleOffset = name === "1P" ? -4 : 4;
    const cells = [
      { x: bx + roleOffset, y: by - 3 },
      { x: bx + side * 5, y: by - 4 },
      { x: bx + side * 4, y: by - 5 },
      { x: bx + side * 3, y: by - 6 },
      { x: bx + side * 6, y: by - 4 },
      { x: bx + side * 5, y: by - 6 },
    ];
    const goals = cells.filter((c) => walkable(ctx, c.x, c.y));
    if (!goals.length) {
      for (let radius = 2; radius <= 7 && !goals.length; radius++) {
        for (let y = by - radius; y <= by - 1; y++) {
          for (let x = bx - radius; x <= bx + radius + 1; x++) {
            if (walkable(ctx, x, y)) goals.push({ x, y });
          }
        }
      }
    }
    goals.sort((a, b) => {
      const aScore = Math.abs(a.x - (bx + roleOffset)) + Math.abs(a.y - (by - 4));
      const bScore = Math.abs(b.x - (bx + roleOffset)) + Math.abs(b.y - (by - 4));
      return aScore - bScore;
    });
    return goals.slice(0, 8).map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function basePanicGoals(ctx, enemy, name) {
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const enemyCell = enemy ? cellOf(enemy, ctx.cols, ctx.rows) : baseCell;
    const side = name === "1P" ? -1 : 1;
    const laneX = clamp(enemyCell.x, baseCell.x - 5, baseCell.x + 6);
    const cells = [
      { x: baseCell.x, y: baseCell.y - 3 },
      { x: baseCell.x + 1, y: baseCell.y - 3 },
      { x: baseCell.x + side * 2, y: baseCell.y - 3 },
      { x: baseCell.x + side * 3, y: baseCell.y - 4 },
      { x: laneX, y: baseCell.y - 4 },
      { x: laneX, y: baseCell.y - 5 },
      { x: enemyCell.x, y: clamp(enemyCell.y - 1, 1, baseCell.y - 2) },
      { x: enemyCell.x, y: clamp(enemyCell.y + 1, 1, baseCell.y - 1) },
      { x: enemyCell.x + side, y: enemyCell.y },
      { x: enemyCell.x - side, y: enemyCell.y },
    ];
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .sort((a, b) => {
        const aLane = Math.abs(a.x - laneX) + Math.abs(a.y - (baseCell.y - 3)) * 0.7;
        const bLane = Math.abs(b.x - laneX) + Math.abs(b.y - (baseCell.y - 3)) * 0.7;
        if (aLane !== bLane) return aLane - bLane;
        return cellDist(a, baseCell) - cellDist(b, baseCell);
      })
      .slice(0, 12)
      .map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function tacticalMemoryGoals(ctx, enemy, name) {
    if (!enemy?.alive || !ctx.tacticalMemory) return [];
    const score = tacticalZoneScore(ctx, enemy, "baseThreatZones");
    if (score < 4) return [];
    const enemyCell = cellOf(enemy, ctx.cols, ctx.rows);
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const side = name === "1P" ? -1 : 1;
    const y = clamp(enemyCell.y + 1, 1, baseCell.y - 2);
    const cells = [
      { x: enemyCell.x, y },
      { x: enemyCell.x + side, y },
      { x: enemyCell.x - side, y },
      { x: clamp(enemyCell.x, baseCell.x - 5, baseCell.x + 6), y: clamp(enemyCell.y + 2, 1, baseCell.y - 2) },
      { x: baseCell.x + (name === "1P" ? -1 : 2), y: baseCell.y - 3 },
    ];
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .slice(0, 8)
      .map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function baseAnchorThreat(ctx) {
    const midline = (ctx.rows || 24) * TILE * 0.5;
    return (ctx.enemies || [])
      .filter((enemy) => visibleEnemy(ctx, enemy))
      .filter((enemy) => centerY(enemy) >= midline || dist(enemy, ctx.base) < TILE * 12 || threatLine(enemy, ctx.base, 90))
      .sort((a, b) => {
        const aScore = dist(a, ctx.base) - baseThreatScore(ctx, a) * 24;
        const bScore = dist(b, ctx.base) - baseThreatScore(ctx, b) * 24;
        return aScore - bScore;
      })[0] || null;
  }

  function baseAnchorGoals(ctx, enemy, name) {
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const enemyCell = enemy ? cellOf(enemy, ctx.cols, ctx.rows) : baseCell;
    const laneX = enemy ? clamp(enemyCell.x, baseCell.x - 4, baseCell.x + 5) : baseCell.x;
    const role = name === "1P"
      ? [
          { x: baseCell.x - 1, y: baseCell.y - 3 },
          { x: baseCell.x - 2, y: baseCell.y - 3 },
          { x: baseCell.x - 2, y: baseCell.y - 4 },
          { x: laneX <= baseCell.x ? laneX : baseCell.x - 1, y: baseCell.y - 4 },
          { x: laneX <= baseCell.x ? laneX : baseCell.x - 1, y: baseCell.y - 5 },
        ]
      : [
          { x: baseCell.x + 2, y: baseCell.y - 3 },
          { x: baseCell.x + 3, y: baseCell.y - 3 },
          { x: baseCell.x + 3, y: baseCell.y - 4 },
          { x: laneX >= baseCell.x ? laneX : baseCell.x + 2, y: baseCell.y - 4 },
          { x: laneX >= baseCell.x ? laneX : baseCell.x + 2, y: baseCell.y - 5 },
        ];
    const intercept = enemy ? [
      { x: laneX, y: clamp(enemyCell.y - 1, 1, baseCell.y - 2) },
      { x: laneX, y: clamp(enemyCell.y + 1, 1, baseCell.y - 1) },
    ] : [];
    return [...role, ...intercept]
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .sort((a, b) => {
        const aLane = Math.abs(a.x - laneX) + Math.abs(a.y - (baseCell.y - 3)) * 0.75;
        const bLane = Math.abs(b.x - laneX) + Math.abs(b.y - (baseCell.y - 3)) * 0.75;
        return aLane - bLane;
      })
      .map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function baseFireLaneThreat(ctx) {
    return (ctx.enemies || [])
      .filter((enemy) => {
        if (!visibleEnemy(ctx, enemy)) return false;
        if (!threatLine(enemy, ctx.base, 82)) return false;
        return dist(enemy, ctx.base) < TILE * 12 || centerY(enemy) > centerY(ctx.base) - TILE * 9;
      })
      .sort((a, b) => {
        const aScore = dist(a, ctx.base) - baseThreatScore(ctx, a) * 18;
        const bScore = dist(b, ctx.base) - baseThreatScore(ctx, b) * 18;
        return aScore - bScore;
      })[0] || null;
  }

  function baseFireLaneGoals(ctx, enemy, name) {
    if (!enemy) return [];
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const enemyCell = cellOf(enemy, ctx.cols, ctx.rows);
    const side = name === "1P" ? -1 : 1;
    const cells = [];
    if (enemy.dir === "down" || enemy.dir === "up") {
      const x = clamp(enemyCell.x, baseCell.x - 4, baseCell.x + 5);
      const start = Math.min(enemyCell.y + 1, baseCell.y - 1);
      const end = Math.max(enemyCell.y - 1, baseCell.y - 5);
      for (let y = start; y >= end; y--) {
        cells.push({ x, y }, { x: x + side, y }, { x: x - side, y });
      }
    } else {
      const y = clamp(enemyCell.y, baseCell.y - 5, baseCell.y - 1);
      const minX = Math.min(enemyCell.x, baseCell.x);
      const maxX = Math.max(enemyCell.x, baseCell.x + 1);
      for (let x = minX; x <= maxX; x++) {
        cells.push({ x, y }, { x, y: y - 1 }, { x, y: y + 1 });
      }
    }
    cells.push(
      { x: baseCell.x, y: baseCell.y - 2 },
      { x: baseCell.x + 1, y: baseCell.y - 2 },
      { x: baseCell.x + side * 2, y: baseCell.y - 2 },
      { x: enemyCell.x + side, y: enemyCell.y },
      { x: enemyCell.x - side, y: enemyCell.y },
    );
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .sort((a, b) => cellDist(a, enemyCell) - cellDist(b, enemyCell))
      .slice(0, 14)
      .map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function killConfirmThreat(ctx, tank, name) {
    const candidates = (ctx.enemies || [])
      .filter((enemy) => visibleEnemy(ctx, enemy) && eligibleSideTarget(ctx, enemy, name))
      .filter((enemy) => centerY(enemy) >= (ctx.rows || 24) * TILE * 0.42 || dist(enemy, ctx.base) < TILE * 12 || baseThreatScore(ctx, enemy) > 12);
    return candidates
      .map((enemy) => {
        const route = routeDistanceToTarget(ctx, tank, enemy);
        return {
          enemy,
          score: baseThreatScore(ctx, enemy) * -85 + dist(enemy, ctx.base) * 0.4 + dist(enemy, tank) * 0.7 + (Number.isFinite(route) ? route * 95 : 2600),
        };
      })
      .sort((a, b) => a.score - b.score)[0]?.enemy || null;
  }

  function killConfirmGoals(ctx, enemy, name) {
    if (!enemy) return [];
    const enemyCell = cellOf(enemy, ctx.cols, ctx.rows);
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const side = name === "1P" ? -1 : 1;
    const cells = [];
    for (let radius = 1; radius <= 5; radius++) {
      cells.push(
        { x: enemyCell.x + side * radius, y: enemyCell.y },
        { x: enemyCell.x - side * radius, y: enemyCell.y },
        { x: enemyCell.x, y: enemyCell.y - radius },
        { x: enemyCell.x, y: enemyCell.y + radius },
      );
      for (let offset = -1; offset <= 1; offset++) {
        cells.push(
          { x: enemyCell.x + side * radius, y: enemyCell.y + offset },
          { x: enemyCell.x - side * radius, y: enemyCell.y + offset },
          { x: enemyCell.x + offset, y: enemyCell.y - radius },
          { x: enemyCell.x + offset, y: enemyCell.y + radius },
        );
      }
    }
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .map((cell) => ({ cell, shot: firingProfile(ctx, cell, enemyCell) }))
      .filter((item) => item.shot.viable || cellDist(item.cell, enemyCell) <= 2)
      .sort((a, b) => {
        if (a.shot.rank !== b.shot.rank) return a.shot.rank - b.shot.rank;
        const aBaseLine = Math.abs(a.cell.x - baseCell.x) + Math.abs(a.cell.y - (baseCell.y - 3)) * 0.5;
        const bBaseLine = Math.abs(b.cell.x - baseCell.x) + Math.abs(b.cell.y - (baseCell.y - 3)) * 0.5;
        return cellDist(a.cell, enemyCell) - cellDist(b.cell, enemyCell) || aBaseLine - bBaseLine;
      })
      .slice(0, 18)
      .map((item) => ({ x: item.cell.x * TILE + 2, y: item.cell.y * TILE + 2, w: 28, h: 28 }));
  }

  function midlineBreachThreat(ctx) {
    const midline = (ctx.rows || 24) * TILE * 0.5;
    const baseX = centerX(ctx.base);
    const triggerOffset = 3.4 + (ctx.adaptive?.midlineTriggerOffset || 0) * 1.15;
    return ctx.enemies
      .filter((enemy) => {
        if (!visibleEnemy(ctx, enemy)) return false;
        const y = centerY(enemy);
        const x = centerX(enemy);
        const centralApproach = y >= midline - TILE * (triggerOffset + 1.4) && Math.abs(x - baseX) < TILE * 7.5;
        const preBreach = y >= midline - TILE * triggerOffset && Math.abs(x - baseX) < TILE * 12;
        return y >= midline || centralApproach || preBreach || baseThreatScore(ctx, enemy) > 16;
      })
      .sort((a, b) => {
        const aCenter = Math.max(0, TILE * 9 - Math.abs(centerX(a) - baseX)) * 1.8;
        const bCenter = Math.max(0, TILE * 9 - Math.abs(centerX(b) - baseX)) * 1.8;
        const aScore = baseThreatScore(ctx, a) * 20 + aCenter + Math.max(0, centerY(a) - (midline - TILE * 3.5)) - dist(a, ctx.base) * 0.32;
        const bScore = baseThreatScore(ctx, b) * 20 + bCenter + Math.max(0, centerY(b) - (midline - TILE * 3.5)) - dist(b, ctx.base) * 0.32;
        if (Math.abs(aScore - bScore) > 8) return bScore - aScore;
        return centerY(b) - centerY(a);
      })[0] || null;
  }

  function advancingPressureThreat(ctx, tank, name) {
    const fieldHeight = (ctx.rows || 24) * TILE;
    const midline = fieldHeight * 0.5;
    const baseX = centerX(ctx.base);
    const baseY = centerY(ctx.base);
    return (ctx.enemies || [])
      .filter((enemy) => {
        if (!visibleEnemy(ctx, enemy) || !eligibleSideTarget(ctx, enemy, name)) return false;
        const y = centerY(enemy);
        if (y < fieldHeight * 0.32 || y >= midline + TILE * 2.5) return false;
        const lanePressure = Math.abs(centerX(enemy) - baseX) < TILE * 11;
        const movingDown = enemy.dir === "down" || y > fieldHeight * 0.42;
        const basePressure = baseThreatScore(ctx, enemy) > 9 || dist(enemy, ctx.base) < TILE * 15;
        return (lanePressure && movingDown) || basePressure;
      })
      .map((enemy) => {
        const route = routeDistanceToTarget(ctx, tank, enemy);
        const routeCost = Number.isFinite(route) ? route * 42 : 900;
        const forwardProgress = Math.max(0, centerY(enemy) - fieldHeight * 0.32) / 4;
        const baseLane = Math.max(0, TILE * 11 - Math.abs(centerX(enemy) - baseX)) * 1.6;
        const baseAdvance = Math.max(0, TILE * 15 - Math.abs(baseY - centerY(enemy))) * 0.55;
        const shotBonus = ctx.canShoot?.(tank.dir, enemy) ? 850 : 0;
        return {
          enemy,
          score: baseThreatScore(ctx, enemy) * 18 + forwardProgress + baseLane + baseAdvance + shotBonus - routeCost,
        };
      })
      .sort((a, b) => b.score - a.score)[0]?.enemy || null;
  }

  function baseIntruder(ctx, name) {
    const midline = (ctx.rows || 24) * TILE * 0.5;
    return ctx.enemies
      .filter((enemy) => {
        if (!visibleEnemy(ctx, enemy) || centerY(enemy) < midline) return false;
        if (!eligibleSideTarget(ctx, enemy, name)) return false;
        return dist(enemy, ctx.base) < TILE * 10 || baseThreatScore(ctx, enemy) > 22;
      })
      .sort((a, b) => {
        const aScore = baseThreatScore(ctx, a) * 18 - dist(a, ctx.base);
        const bScore = baseThreatScore(ctx, b) * 18 - dist(b, ctx.base);
        return bScore - aScore;
      })[0] || null;
  }

  function endgameStalledThreat(ctx, tank, name) {
    const visible = (ctx.enemies || []).filter((enemy) => visibleEnemy(ctx, enemy));
    if (visible.length > 2) return null;
    const midline = (ctx.rows || 24) * TILE * 0.5;
    return visible
      .filter((enemy) => eligibleSideTarget(ctx, enemy, name))
      .filter((enemy) => centerY(enemy) >= midline || dist(enemy, ctx.base) < TILE * 13 || dist(enemy, tank) < TILE * 11)
      .map((enemy) => {
        const route = routeDistanceToTarget(ctx, tank, enemy);
        return {
          enemy,
          score: (Number.isFinite(route) ? route * 90 : 2400) + dist(enemy, tank) * 0.7 + dist(enemy, ctx.base) * 0.15,
        };
      })
      .sort((a, b) => a.score - b.score)[0]?.enemy || null;
  }

  function spawnPoint(ctx, name) {
    return {
      x: (name === "1P" ? 8 : 16) * TILE + 2,
      y: ((ctx.rows || 24) - 2) * TILE + 2,
      w: 28,
      h: 28,
    };
  }

  function spawnThreat(ctx, tank, name) {
    const spawn = spawnPoint(ctx, name);
    const lowerLine = ((ctx.rows || 24) - 7) * TILE;
    return ctx.enemies
      .filter((enemy) => {
        if (!visibleEnemy(ctx, enemy) || !eligibleSideTarget(ctx, enemy, name)) return false;
        const nearOwnSpawn = dist(enemy, spawn) < TILE * 8.5;
        const lowerOwnSide = centerY(enemy) > lowerLine && ownSide(ctx, enemy, name);
        const nearTankAndSpawn = dist(enemy, tank) < TILE * 10 && dist(tank, spawn) < TILE * 11;
        return nearOwnSpawn || lowerOwnSide || nearTankAndSpawn;
      })
      .map((enemy) => ({
        enemy,
        score: Math.max(0, TILE * 10 - dist(enemy, spawn)) * 5
          + Math.max(0, TILE * 9 - dist(enemy, tank)) * 2
          + baseThreatScore(ctx, enemy) * 12
          + (ctx.canShoot?.(tank.dir, enemy) ? 900 : 0),
      }))
      .sort((a, b) => b.score - a.score)[0]?.enemy || null;
  }

  function spawnAssaultGoals(ctx, tank, enemy, name) {
    if (!enemy?.alive) return [];
    const spawn = spawnPoint(ctx, name);
    const enemyCell = cellOf(enemy, ctx.cols, ctx.rows);
    const spawnCell = cellOf(spawn, ctx.cols, ctx.rows);
    const side = name === "1P" ? -1 : 1;
    const cells = [
      { x: enemyCell.x, y: enemyCell.y - 1 },
      { x: enemyCell.x, y: enemyCell.y + 1 },
      { x: enemyCell.x - 1, y: enemyCell.y },
      { x: enemyCell.x + 1, y: enemyCell.y },
      { x: enemyCell.x - side, y: enemyCell.y },
      { x: enemyCell.x + side, y: enemyCell.y },
      { x: spawnCell.x, y: spawnCell.y - 2 },
      { x: spawnCell.x + side, y: spawnCell.y - 2 },
      { x: spawnCell.x - side, y: spawnCell.y - 2 },
      { x: spawnCell.x, y: spawnCell.y - 3 },
    ];
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .map((cell) => {
        const box = { x: cell.x * TILE + 2, y: cell.y * TILE + 2, w: 28, h: 28 };
        const shot = firingProfile(ctx, cell, enemyCell);
        const route = routeDistanceToTarget(ctx, tank, box);
        const spawnValue = Math.max(0, TILE * 7 - dist(box, spawn)) * 0.4;
        const shootValue = shot.viable ? 420 - shot.rank * 60 : 0;
        return { box, score: (Number.isFinite(route) ? route * 38 : 1200) - shootValue - spawnValue + bulletRisk(box, ctx.bullets || []) * 70 };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, 10)
      .map((item) => item.box);
  }

  function midlineDefenseGoals(ctx, name) {
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const midY = Math.floor((ctx.rows || 24) * 0.5);
    const leftGate = baseCell.x - 3;
    const rightGate = baseCell.x + 4;
    const cells = name === "1P"
      ? [
          { x: leftGate, y: midY + 3 },
          { x: leftGate - 1, y: midY + 3 },
          { x: leftGate, y: midY + 4 },
          { x: baseCell.x - 4, y: baseCell.y - 6 },
          { x: baseCell.x - 5, y: baseCell.y - 5 },
          { x: baseCell.x - 3, y: baseCell.y - 7 },
          { x: baseCell.x - 2, y: baseCell.y - 5 },
        ]
      : [
          { x: rightGate, y: midY + 3 },
          { x: rightGate + 1, y: midY + 3 },
          { x: rightGate, y: midY + 4 },
          { x: baseCell.x + 4, y: baseCell.y - 6 },
          { x: baseCell.x + 5, y: baseCell.y - 5 },
          { x: baseCell.x + 3, y: baseCell.y - 7 },
          { x: baseCell.x + 2, y: baseCell.y - 5 },
        ];
    const goals = cells.filter((c) => walkable(ctx, c.x, c.y));
    return (goals.length ? goals : guardGoals(ctx, name).map((goal) => cellOf(goal, ctx.cols, ctx.rows)))
      .map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function defensiveLineCells(ctx, enemy, name) {
    const side = name === "1P" ? -1 : 1;
    const enemyCell = enemy ? cellOf(enemy, ctx.cols, ctx.rows) : null;
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const roleX = baseCell.x + (name === "1P" ? -2 : 3);
    const laneX = enemyCell ? clamp(enemyCell.x, baseCell.x - 6, baseCell.x + 7) : roleX;
    const rows = [baseCell.y - 6, baseCell.y - 5, baseCell.y - 4, baseCell.y - 7];
    const cells = [];
    for (const y of rows) {
      cells.push(
        { x: laneX, y },
        { x: laneX + side, y },
        { x: roleX, y },
        { x: baseCell.x, y },
        { x: baseCell.x + 1, y },
        { x: baseCell.x + side * 3, y },
      );
    }
    if (enemyCell) {
      const stopY = clamp(Math.floor((enemyCell.y + baseCell.y) / 2), 2, baseCell.y - 4);
      cells.push(
        { x: laneX, y: stopY },
        { x: laneX + side, y: stopY },
        { x: enemyCell.x, y: clamp(enemyCell.y + 1, 1, baseCell.y - 2) },
      );
    }
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .sort((a, b) => {
        const aLane = Math.abs(a.x - laneX);
        const bLane = Math.abs(b.x - laneX);
        if (aLane !== bLane) return aLane - bLane;
        const aRole = Math.abs(a.x - roleX);
        const bRole = Math.abs(b.x - roleX);
        if (aRole !== bRole) return aRole - bRole;
        return Math.abs(a.y - (baseCell.y - 5)) - Math.abs(b.y - (baseCell.y - 5));
      });
  }

  function interceptGoals(ctx, enemy, name) {
    if (!enemy) return guardGoals(ctx, name);
    const side = name === "1P" ? -1 : 1;
    const enemyCell = cellOf(enemy, ctx.cols, ctx.rows);
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const laneX = clamp(enemyCell.x, baseCell.x - 5, baseCell.x + 6);
    const stopY = clamp(Math.floor((enemyCell.y + baseCell.y) / 2), 2, baseCell.y - 3);
    const cells = [
      ...defensiveLineCells(ctx, enemy, name),
      ...attackGoals(ctx, enemy).map((goal) => cellOf(goal, ctx.cols, ctx.rows)),
      ...approachGoals(ctx, enemy).map((goal) => cellOf(goal, ctx.cols, ctx.rows)),
      { x: laneX, y: stopY },
      { x: laneX, y: baseCell.y - 4 },
      { x: enemyCell.x, y: clamp(enemyCell.y + 1, 1, baseCell.y - 1) },
      { x: enemyCell.x, y: clamp(enemyCell.y - 1, 1, baseCell.y - 1) },
      { x: enemyCell.x + side, y: enemyCell.y },
      { x: enemyCell.x - side, y: enemyCell.y },
      { x: baseCell.x + side * 2, y: baseCell.y - 4 },
      { x: baseCell.x + side * 4, y: baseCell.y - 5 },
      { x: enemyCell.x + side, y: enemyCell.y + 1 },
      { x: enemyCell.x - side, y: enemyCell.y + 1 },
    ];
    const goals = cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y));
    if (!goals.length) return guardGoals(ctx, name);
    goals.sort((a, b) => {
      const aLine = Math.abs(a.x - laneX) + Math.abs(a.y - (baseCell.y - 5)) * 0.65;
      const bLine = Math.abs(b.x - laneX) + Math.abs(b.y - (baseCell.y - 5)) * 0.65;
      if (aLine !== bLine) return aLine - bLine;
      return cellDist(a, baseCell) - cellDist(b, baseCell);
    });
    return goals.map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function attackGoals(ctx, target) {
    if (!target) return [];
    const cell = cellOf(target, ctx.cols, ctx.rows);
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const cells = [];
    for (let radius = 1; radius <= 8; radius++) {
      cells.push(
        { x: cell.x, y: cell.y - radius },
        { x: cell.x, y: cell.y + radius },
        { x: cell.x - radius, y: cell.y },
        { x: cell.x + radius, y: cell.y },
      );
      for (let offset = -radius; offset <= radius; offset++) {
        cells.push(
          { x: cell.x + offset, y: cell.y - radius },
          { x: cell.x + offset, y: cell.y + radius },
          { x: cell.x - radius, y: cell.y + offset },
          { x: cell.x + radius, y: cell.y + offset },
        );
      }
    }
    const ranked = cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .map((c) => ({ cell: c, shot: firingProfile(ctx, c, cell) }))
      .filter((item) => walkable(ctx, item.cell.x, item.cell.y) && item.shot.viable)
      .sort((a, b) => {
        if (a.shot.rank !== b.shot.rank) return a.shot.rank - b.shot.rank;
        const aTarget = cellDist(a.cell, cell);
        const bTarget = cellDist(b.cell, cell);
        if (aTarget !== bTarget) return aTarget - bTarget;
        return cellDist(a.cell, baseCell) - cellDist(b.cell, baseCell);
      });
    return ranked
      .slice(0, 24)
      .map((item) => ({ x: item.cell.x * TILE + 2, y: item.cell.y * TILE + 2, w: 28, h: 28 }));
  }

  function shootingPositionGoals(ctx, tank, target, name) {
    if (!target?.alive) return [];
    const targetCell = cellOf(target, ctx.cols, ctx.rows);
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const ownSidePenalty = (cell) => {
      if ((ctx.enemies || []).filter((enemy) => visibleEnemy(ctx, enemy)).length < 3) return 0;
      const leftRole = name === "1P";
      const boundary = Math.floor((ctx.cols || 26) / 2);
      return (leftRole && cell.x > boundary) || (!leftRole && cell.x < boundary) ? 18 : 0;
    };
    const cells = [];
    for (let radius = 2; radius <= 9; radius++) {
      cells.push(
        { x: targetCell.x, y: targetCell.y - radius },
        { x: targetCell.x, y: targetCell.y + radius },
        { x: targetCell.x - radius, y: targetCell.y },
        { x: targetCell.x + radius, y: targetCell.y },
      );
      cells.push(
        { x: targetCell.x - 1, y: targetCell.y - radius },
        { x: targetCell.x + 1, y: targetCell.y - radius },
        { x: targetCell.x - 1, y: targetCell.y + radius },
        { x: targetCell.x + 1, y: targetCell.y + radius },
        { x: targetCell.x - radius, y: targetCell.y - 1 },
        { x: targetCell.x - radius, y: targetCell.y + 1 },
        { x: targetCell.x + radius, y: targetCell.y - 1 },
        { x: targetCell.x + radius, y: targetCell.y + 1 },
      );
    }
    const rankedCells = cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .map((cell) => {
        const box = { x: cell.x * TILE + 2, y: cell.y * TILE + 2, w: 28, h: 28 };
        const shot = firingProfile(ctx, cell, targetCell);
        const risk = bulletRisk(box, ctx.bullets || []);
        const baseLine = Math.abs(cell.x - baseCell.x) + Math.abs(cell.y - (baseCell.y - 3)) * 0.55;
        const targetRange = cellDist(cell, targetCell);
        const nearBaseFireLane = dist(target, ctx.base) < TILE * 8.5 && (cell.x === baseCell.x || cell.x === baseCell.x + 1 || Math.abs(cell.x - baseCell.x) <= 2 && cell.y >= baseCell.y - 4);
        const preScore = shot.rank * 75 + risk * 95 + targetRange * 7 + baseLine * 1.8 + ownSidePenalty(cell) + (nearBaseFireLane ? 420 : 0);
        return { cell, box, shot, risk, preScore };
      })
      .filter((item) => item.shot.viable && item.risk < 10)
      .sort((a, b) => a.preScore - b.preScore)
      .slice(0, 24);
    if (!rankedCells.length) return [];
    const distMap = buildWeightedDistance(ctx, [tank], true);
    return rankedCells
      .map((item) => {
        const route = distMap[key(item.cell.x, item.cell.y, ctx.cols)];
        return { ...item, route, score: item.preScore + (Number.isFinite(route) ? route * 16 : 2000) };
      })
      .filter((item) => Number.isFinite(item.route) && item.route <= 18 && item.score < 1200)
      .sort((a, b) => a.score - b.score)
      .slice(0, 16)
      .map((item) => item.box);
  }

  function approachGoals(ctx, target) {
    if (!target) return [];
    const cell = cellOf(target, ctx.cols, ctx.rows);
    const baseCell = cellOf(ctx.base, ctx.cols, ctx.rows);
    const cells = [];
    for (let radius = 1; radius <= 9; radius++) {
      for (let offset = -radius; offset <= radius; offset++) {
        cells.push(
          { x: cell.x + offset, y: cell.y - radius },
          { x: cell.x + offset, y: cell.y + radius },
          { x: cell.x - radius, y: cell.y + offset },
          { x: cell.x + radius, y: cell.y + offset },
        );
      }
    }
    return cells
      .filter((c, i, list) => c && list.findIndex((other) => other.x === c.x && other.y === c.y) === i)
      .filter((c) => walkable(ctx, c.x, c.y))
      .sort((a, b) => {
        const aLine = a.x === cell.x || a.y === cell.y ? 0 : 1;
        const bLine = b.x === cell.x || b.y === cell.y ? 0 : 1;
        if (aLine !== bLine) return aLine - bLine;
        const aTarget = cellDist(a, cell);
        const bTarget = cellDist(b, cell);
        if (aTarget !== bTarget) return aTarget - bTarget;
        return cellDist(a, baseCell) - cellDist(b, baseCell);
      })
      .slice(0, 64)
      .map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
  }

  function firingProfile(ctx, goalCell, targetCell) {
    if (goalCell.x !== targetCell.x && goalCell.y !== targetCell.y) {
      return { viable: false, rank: 9 };
    }
    const dx = Math.sign(targetCell.x - goalCell.x);
    const dy = Math.sign(targetCell.y - goalCell.y);
    let x = goalCell.x + dx;
    let y = goalCell.y + dy;
    let clearableBricks = 0;
    while (x !== targetCell.x || y !== targetCell.y) {
      const t = ctx.tileAt?.(x, y);
      if (baseBlocked(ctx, x, y)) return { viable: false, rank: 9 };
      if (t === "S" || t === "W" || t === "E") return { viable: false, rank: 9 };
      if (t === "B" && nearBase(ctx, x, y)) return { viable: false, rank: 9 };
      if (t === "B") clearableBricks++;
      x += dx;
      y += dy;
    }
    if (clearableBricks === 0) return { viable: true, rank: 0 };
    if (clearableBricks <= 2) return { viable: true, rank: 1 + clearableBricks };
    return { viable: false, rank: 9 };
  }

  function buildDistance(ctx, goals) {
    const distMap = new Array(ctx.cols * ctx.rows).fill(Infinity);
    const queue = [];
    for (const goal of goals) {
      const c = cellOf(goal, ctx.cols, ctx.rows);
      const k = key(c.x, c.y, ctx.cols);
      distMap[k] = 0;
      queue.push(c);
    }
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      const next = distMap[key(c.x, c.y, ctx.cols)] + 1;
      for (const n of [
        { x: c.x + 1, y: c.y },
        { x: c.x - 1, y: c.y },
        { x: c.x, y: c.y + 1 },
        { x: c.x, y: c.y - 1 },
      ]) {
        if (!walkable(ctx, n.x, n.y)) continue;
        const nk = key(n.x, n.y, ctx.cols);
        if (next < distMap[nk]) {
          distMap[nk] = next;
          queue.push(n);
        }
      }
    }
    return distMap;
  }

  function routeTileCost(ctx, x, y, allowBrickClear) {
    if (baseBlocked(ctx, x, y)) return Infinity;
    if (walkable(ctx, x, y)) return 1;
    const t = ctx.tileAt?.(x, y);
    if (allowBrickClear && t === "B" && !nearBase(ctx, x, y)) return 1.05;
    return Infinity;
  }

  function steelAdjacencyCost(ctx, x, y) {
    let cost = 0;
    for (const n of [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    ]) {
      if (ctx.tileAt?.(n.x, n.y) === "S") cost += 0.45;
    }
    return cost;
  }

  function buildWeightedDistance(ctx, goals, allowBrickClear = false) {
    const normalizedGoals = compactGoals(ctx, goals, 40);
    const cacheKey = [
      allowBrickClear ? "C" : "N",
      ctx.mapVersion || 0,
      ...normalizedGoals.map((goal) => {
        const c = cellOf(goal, ctx.cols, ctx.rows);
        return `${c.x},${c.y}`;
      }),
    ].join("|");
    if (!ctx._distanceCache) ctx._distanceCache = new Map();
    if (ctx._distanceCache.has(cacheKey)) return ctx._distanceCache.get(cacheKey);
    const workerCache = window.__TankAIDistanceWorkerCache;
    if (workerCache?.has(cacheKey)) {
      const cached = workerCache.get(cacheKey);
      ctx._distanceCache.set(cacheKey, cached);
      return cached;
    }
    warmDistanceWorker(ctx, cacheKey, normalizedGoals, allowBrickClear);
    const distMap = new Array(ctx.cols * ctx.rows).fill(Infinity);
    const queue = [];
    for (const goal of normalizedGoals) {
      const c = cellOf(goal, ctx.cols, ctx.rows);
      const k = key(c.x, c.y, ctx.cols);
      distMap[k] = 0;
      queue.push(c);
    }
    while (queue.length) {
      let bestIndex = 0;
      let bestValue = distMap[key(queue[0].x, queue[0].y, ctx.cols)];
      for (let i = 1; i < queue.length; i++) {
        const value = distMap[key(queue[i].x, queue[i].y, ctx.cols)];
        if (value < bestValue) {
          bestValue = value;
          bestIndex = i;
        }
      }
      const c = queue.splice(bestIndex, 1)[0];
      const current = distMap[key(c.x, c.y, ctx.cols)];
      for (const n of [
        { x: c.x + 1, y: c.y },
        { x: c.x - 1, y: c.y },
        { x: c.x, y: c.y + 1 },
        { x: c.x, y: c.y - 1 },
      ]) {
        const cost = routeTileCost(ctx, n.x, n.y, allowBrickClear);
        if (!Number.isFinite(cost)) continue;
        const next = current + cost + steelAdjacencyCost(ctx, n.x, n.y);
        const nk = key(n.x, n.y, ctx.cols);
        if (next < distMap[nk]) {
          distMap[nk] = next;
          queue.push(n);
        }
      }
    }
    ctx._distanceCache.set(cacheKey, distMap);
    if (ctx._distanceCache.size > DISTANCE_CACHE_LIMIT) {
      const firstKey = ctx._distanceCache.keys().next().value;
      ctx._distanceCache.delete(firstKey);
    }
    return distMap;
  }

  function clearableBrickAhead(ctx, tank, dir) {
    const d = DIRS[dir];
    if (!d) return false;
    const perpendicular = dir === "up" || dir === "down"
      ? [{ x: -9, y: 0 }, { x: 0, y: 0 }, { x: 9, y: 0 }]
      : [{ x: 0, y: -9 }, { x: 0, y: 0 }, { x: 0, y: 9 }];
    for (let step = 14; step <= TILE * 2.2; step += 8) {
      for (const p of perpendicular) {
        const tx = Math.floor((centerX(tank) + d.x * step + p.x) / TILE);
        const ty = Math.floor((centerY(tank) + d.y * step + p.y) / TILE);
        const t = ctx.tileAt?.(tx, ty);
        if (nearBase(ctx, tx, ty)) return false;
        if (t === "B" && !nearBase(ctx, tx, ty)) return true;
        if (t === "S" || t === "W" || t === "E" || (t === "B" && nearBase(ctx, tx, ty))) return false;
      }
    }
    return false;
  }

  function dirBetween(from, to) {
    if (to.x > from.x) return "right";
    if (to.x < from.x) return "left";
    if (to.y > from.y) return "down";
    if (to.y < from.y) return "up";
    return null;
  }

  function alignmentDir(ctx, tank, dir, here) {
    if (!dir) return null;
    if (dir === "up" || dir === "down") {
      const alignedX = here.x * TILE + 2;
      if (Math.abs(tank.x - alignedX) > 2) return tank.x < alignedX ? "right" : "left";
    } else {
      const alignedY = here.y * TILE + 2;
      if (Math.abs(tank.y - alignedY) > 2) return tank.y < alignedY ? "down" : "up";
    }
    return null;
  }

  function routeStep(ctx, tank, distMap, allowBrickClear) {
    const here = cellOf(tank, ctx.cols, ctx.rows);
    const current = distMap[key(here.x, here.y, ctx.cols)];
    const reversePenalty = 1.55 + Math.max(0, styleWeight(ctx, "survive") - 1) * 0.2;
    const options = [];
    for (const n of [
      { x: here.x + 1, y: here.y },
      { x: here.x - 1, y: here.y },
      { x: here.x, y: here.y + 1 },
      { x: here.x, y: here.y - 1 },
    ]) {
      if (n.x < 0 || n.y < 0 || n.x >= ctx.cols || n.y >= ctx.rows) continue;
      const route = distMap[key(n.x, n.y, ctx.cols)];
      if (!Number.isFinite(route)) continue;
      const cost = routeTileCost(ctx, n.x, n.y, allowBrickClear);
      if (!Number.isFinite(cost)) continue;
      const dir = dirBetween(here, n);
      const needsClear = ctx.tileAt?.(n.x, n.y) === "B" && !nearBase(ctx, n.x, n.y);
      options.push({ cell: n, dir, route, needsClear });
    }
    options.sort((a, b) => {
      const ar = a.route - (a.dir === ctx.lastMoveDir ? 0.35 : 0) + (a.dir === OPPOSITE[ctx.lastMoveDir] ? reversePenalty : 0);
      const br = b.route - (b.dir === ctx.lastMoveDir ? 0.35 : 0) + (b.dir === OPPOSITE[ctx.lastMoveDir] ? reversePenalty : 0);
      return ar - br;
    });
    const best = options.find((option) => option.route < current || !Number.isFinite(current)) || options[0];
    return { here, step: best };
  }

  function routePoints(ctx, tank, distMap, firstDir = null) {
    const here = cellOf(tank, ctx.cols, ctx.rows);
    const first = firstDir && DIRS[firstDir]
      ? { x: clamp(here.x + DIRS[firstDir].x, 0, ctx.cols - 1), y: clamp(here.y + DIRS[firstDir].y, 0, ctx.rows - 1) }
      : here;
    let current = first;
    const points = [{ x: centerX(tank), y: centerY(tank) }];
    if (first.x !== here.x || first.y !== here.y) {
      points.push({ x: first.x * TILE + TILE / 2, y: first.y * TILE + TILE / 2 });
    }
    const seen = new Set([key(here.x, here.y, ctx.cols), key(current.x, current.y, ctx.cols)]);
    for (let i = 0; i < 80; i++) {
      const currentCost = distMap[key(current.x, current.y, ctx.cols)];
      if (!Number.isFinite(currentCost) || currentCost <= 0) break;
      let best = null;
      let bestCost = currentCost;
      for (const n of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        if (n.x < 0 || n.y < 0 || n.x >= ctx.cols || n.y >= ctx.rows) continue;
        const nk = key(n.x, n.y, ctx.cols);
        const cost = distMap[nk];
        if (Number.isFinite(cost) && cost < bestCost && !seen.has(nk)) {
          best = n;
          bestCost = cost;
        }
      }
      if (!best) break;
      current = best;
      seen.add(key(current.x, current.y, ctx.cols));
      points.push({ x: current.x * TILE + TILE / 2, y: current.y * TILE + TILE / 2 });
    }
    return points;
  }

  function routePointsFromCells(tank, cells) {
    const points = [{ x: centerX(tank), y: centerY(tank) }];
    for (const cell of cells.slice(1, 80)) {
      points.push({ x: cell.x * TILE + TILE / 2, y: cell.y * TILE + TILE / 2 });
    }
    return points;
  }

  function compactGoals(ctx, goals, limit = 36) {
    const seen = new Set();
    const compact = [];
    for (const goal of goals || []) {
      const cell = cellOf(goal, ctx.cols, ctx.rows);
      const k = key(cell.x, cell.y, ctx.cols);
      if (seen.has(k)) continue;
      seen.add(k);
      compact.push(goal);
      if (compact.length >= limit) break;
    }
    return compact;
  }

  function reconstructAStarPath(cameFrom, current, ctx) {
    const path = [current];
    let currentKey = key(current.x, current.y, ctx.cols);
    while (cameFrom[currentKey]) {
      current = cameFrom[currentKey];
      path.unshift(current);
      currentKey = key(current.x, current.y, ctx.cols);
    }
    return path;
  }

  function findAStarRoute(ctx, tank, goals, allowBrickClear) {
    const start = cellOf(tank, ctx.cols, ctx.rows);
    const goalCells = goals
      .map((goal) => cellOf(goal, ctx.cols, ctx.rows))
      .filter((cell, index, list) => list.findIndex((other) => other.x === cell.x && other.y === cell.y) === index)
      .filter((cell) => Number.isFinite(routeTileCost(ctx, cell.x, cell.y, allowBrickClear)));
    if (!goalCells.length) return null;
    const goalKeys = new Set(goalCells.map((cell) => key(cell.x, cell.y, ctx.cols)));
    const heuristic = (cell) => Math.min(...goalCells.map((goal) => cellDist(cell, goal)));
    const open = [start];
    const cameFrom = {};
    const gScore = new Array(ctx.cols * ctx.rows).fill(Infinity);
    const fScore = new Array(ctx.cols * ctx.rows).fill(Infinity);
    gScore[key(start.x, start.y, ctx.cols)] = 0;
    fScore[key(start.x, start.y, ctx.cols)] = heuristic(start);
    const closed = new Set();
    while (open.length) {
      let bestIndex = 0;
      let bestValue = fScore[key(open[0].x, open[0].y, ctx.cols)];
      for (let i = 1; i < open.length; i++) {
        const value = fScore[key(open[i].x, open[i].y, ctx.cols)];
        if (value < bestValue) {
          bestValue = value;
          bestIndex = i;
        }
      }
      const current = open.splice(bestIndex, 1)[0];
      const currentKey = key(current.x, current.y, ctx.cols);
      if (goalKeys.has(currentKey)) {
        const cells = reconstructAStarPath(cameFrom, current, ctx);
        const firstStep = cells[1] || cells[0];
        const dir = dirBetween(start, firstStep);
        const needsClear = Boolean(dir) && ctx.tileAt?.(firstStep.x, firstStep.y) === "B" && !nearBase(ctx, firstStep.x, firstStep.y);
        return { cells, dir, needsClear };
      }
      if (closed.has(currentKey)) continue;
      closed.add(currentKey);
      const neighbors = [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ];
      for (const next of neighbors) {
        const moveCost = routeTileCost(ctx, next.x, next.y, allowBrickClear);
        if (!Number.isFinite(moveCost)) continue;
        const dir = dirBetween(current, next);
        const reversePenalty = dir === OPPOSITE[ctx.lastMoveDir] ? 0.65 : 0;
        const straightBonus = dir === ctx.lastMoveDir ? -0.12 : 0;
        const tentative = gScore[currentKey] + moveCost + steelAdjacencyCost(ctx, next.x, next.y) + reversePenalty + straightBonus;
        const nextKey = key(next.x, next.y, ctx.cols);
        if (tentative >= gScore[nextKey]) continue;
        cameFrom[nextKey] = current;
        gScore[nextKey] = tentative;
        fScore[nextKey] = tentative + heuristic(next);
        if (!open.some((cell) => cell.x === next.x && cell.y === next.y)) open.push(next);
      }
    }
    return null;
  }

  function targetDirOrder(tank, target) {
    if (!target) return null;
    const tx = centerX(tank);
    const ty = centerY(tank);
    const targetX = centerX(target);
    const targetY = centerY(target);
    return Math.abs(targetX - tx) > Math.abs(targetY - ty)
      ? [targetX < tx ? "left" : "right", targetY < ty ? "up" : "down"]
      : [targetY < ty ? "up" : "down", targetX < tx ? "left" : "right"];
  }

  function routeDir(ctx, tank, goals, target, mode) {
    ctx.plannedRoute = null;
    goals = compactGoals(ctx, goals, mode === "attack" ? 34 : 28);
    if (!goals.length) return directionTo(tank, target || ctx.base);
    ctx.routeNeedsClear = false;
    ctx.routeFollowing = false;
    const defendWeight = styleWeight(ctx, "defend");
    const attackWeight = styleWeight(ctx, "attack");
    const clearWeight = styleWeight(ctx, "clear");
    const surviveWeight = styleWeight(ctx, "survive");
    const avoidStaleRoute = hasDirective(ctx, "AVOID_STALE_ROUTE");
      const learnedUnstuck = (ctx.adaptive?.stuckPressure || 0) > 0.45 || (ctx.adaptive?.stalePressure || 0) > 0.45 || (ctx.adaptive?.clearAggression || 0) > 0.72;
    const allowBrickClear = mode === "attack" || mode === "intercept" || mode === "defend" || hasPatch(ctx, "unstuck_clear") || learnedUnstuck;
    const bulletThreshold = routeBulletThreshold(mode);
    const aStarRoute = findAStarRoute(ctx, tank, goals, allowBrickClear);
    if (aStarRoute?.dir) {
      const align = alignmentDir(ctx, tank, aStarRoute.dir, aStarRoute.cells[0]);
      if (align && canMove(ctx, align) && !isMoveIntoEnemyBullet(tank, align, ctx.bullets || [], bulletThreshold)) {
        ctx.routeFollowing = true;
        ctx.plannedRoute = routePointsFromCells(tank, aStarRoute.cells);
        return align;
      }
      ctx.routeNeedsClear = aStarRoute.needsClear && clearableBrickAhead(ctx, tank, aStarRoute.dir);
      ctx.routeFollowing = true;
      if ((ctx.routeNeedsClear || canMove(ctx, aStarRoute.dir)) && !isMoveIntoEnemyBullet(tank, aStarRoute.dir, ctx.bullets || [], bulletThreshold)) {
        ctx.plannedRoute = routePointsFromCells(tank, aStarRoute.cells);
        return aStarRoute.dir;
      }
    }
    const distMap = buildWeightedDistance(ctx, goals, allowBrickClear);
    const here = cellOf(tank, ctx.cols, ctx.rows);
    const path = routeStep(ctx, tank, distMap, allowBrickClear);
    if (path.step) {
      const align = alignmentDir(ctx, tank, path.step.dir, path.here);
      if (align && canMove(ctx, align) && !isMoveIntoEnemyBullet(tank, align, ctx.bullets || [], bulletThreshold)) {
        ctx.plannedRoute = routePoints(ctx, tank, distMap, align);
        return align;
      }
      ctx.routeNeedsClear = path.step.needsClear && clearableBrickAhead(ctx, tank, path.step.dir);
      ctx.routeFollowing = true;
      if ((ctx.routeNeedsClear || canMove(ctx, path.step.dir)) && !isMoveIntoEnemyBullet(tank, path.step.dir, ctx.bullets || [], bulletThreshold)) {
        ctx.plannedRoute = routePoints(ctx, tank, distMap, path.step.dir);
        return path.step.dir;
      }
    }
    let best = null;
    let bestNeedsClear = false;
    let bestScore = -Infinity;
      for (const dir of Object.keys(DIRS)) {
        const d = DIRS[dir];
        const cell = { x: clamp(here.x + d.x, 0, ctx.cols - 1), y: clamp(here.y + d.y, 0, ctx.rows - 1) };
        const route = distMap[key(cell.x, cell.y, ctx.cols)];
        const needsClear = !canMove(ctx, dir) && clearableBrickAhead(ctx, tank, dir);
        if (!canMove(ctx, dir) && !needsClear) continue;
        const predicted = makeBox(tank, dir, 18);
        let score = Number.isFinite(route) ? -route * 2.4 : -80;
        if (needsClear) score += mode === "attack" || mode === "intercept" || mode === "defend" ? 5 + Math.min(1.8, clearWeight - 1) * 0.9 : 1.5;
        const pathRisk = movePathRisk(tank, dir, ctx.bullets || [], ctx.allyFireReports || []);
        const enemyCollisionRisk = moveIntoEnemyBulletRisk(tank, dir, ctx.bullets || []);
        const risk = bulletRisk(predicted, ctx.bullets, true) + allyRadioRisk(predicted, ctx.allyFireReports || []) + pathRisk * 0.55;
        const futureRisk = futureBulletRisk(predicted, dir, ctx.bullets || [], true) + allyRadioRisk(makeBox(predicted, dir, 48), ctx.allyFireReports || []);
        score -= risk * (5.2 + surviveWeight * 1.8);
        score -= futureRisk * (2.2 + surviveWeight * 0.9);
        if (pathRisk > 10 && mode !== "bonus") score -= 70;
        if (risk > 8 && mode !== "bonus") score -= 28;
        if (enemyCollisionRisk > 4 && mode !== "bonus") score -= enemyCollisionRisk * 26;
        if (enemyCollisionRisk > 10 && mode !== "bonus") score -= 900;
        if (target) score += Math.max(0, dist(tank, target) - dist(predicted, target)) * (0.04 + attackWeight * 0.01);
        if (dir === tank.dir) score += 0.5;
        if (dir === ctx.lastMoveDir) score += 1.6;
        if (dir === OPPOSITE[tank.dir]) score -= 1.2;
        if (dir === OPPOSITE[ctx.lastMoveDir]) score -= avoidStaleRoute ? 6.0 : 3.0;
        if (mode === "defend" && centerY(predicted) > centerY(ctx.base) - 160) score += 1.5 * defendWeight;
        if (mode === "intercept" && target) {
          score += Math.max(0, dist(tank, target) - dist(predicted, target)) * (0.06 + defendWeight * 0.01);
          if (centerY(target) < centerY(ctx.base) - TILE * 5 && centerY(predicted) > centerY(ctx.base) - 90) score -= 5;
        }
        if (mode === "attack" && target) {
          score += Math.max(0, 420 - dist(predicted, target)) / (82 - Math.min(12, (attackWeight - 1) * 6));
          if (dir === directionTo(tank, target)) score += 1.1 + (attackWeight - 1) * 0.35;
        }
        if (score > bestScore) {
          best = dir;
        bestNeedsClear = needsClear;
        bestScore = score;
      }
    }
    ctx.routeNeedsClear = bestNeedsClear;
    if (best) {
      ctx.plannedRoute = routePoints(ctx, tank, distMap, best);
      return best;
    }
    const fallback = directionTo(tank, target || ctx.base);
    const fallbackDir = canMove(ctx, fallback) && !isMoveIntoEnemyBullet(tank, fallback, ctx.bullets || [], 9)
      ? fallback
      : Object.keys(DIRS).find((dir) => canMove(ctx, dir) && !isMoveIntoEnemyBullet(tank, dir, ctx.bullets || [], 9)) || fallback;
    ctx.plannedRoute = routePoints(ctx, tank, distMap, fallbackDir);
    return fallbackDir;
  }

  function dodgeDir(ctx, tank, bullet) {
    const primary = bullet.dir === "up" || bullet.dir === "down"
      ? (centerX(tank) < centerX(bullet) ? "left" : "right")
      : (centerY(tank) < centerY(bullet) ? "up" : "down");
    const defendCritical = (ctx.adaptive?.basePressure || 0) > 0.45 || (ctx.adaptive?.midlinePressure || 0) > 0.65 || (ctx.adaptive?.dodgeDiscipline || 0) > 0.68;
    const options = [primary, OPPOSITE[primary], tank.dir, "up", "down", "left", "right"]
      .filter((dir, index, list) => dir && list.indexOf(dir) === index);
    let best = primary;
    let bestScore = -Infinity;
    const reports = ctx.allyFireReports || [];
    const currentRisk = bulletRisk(tank, ctx.bullets || [], true) + allyRadioRisk(tank, reports);
    for (const dir of options) {
      if (!canMove(ctx, dir)) continue;
      const predicted = makeBox(tank, dir, 34);
      const pathRisk = movePathRisk(tank, dir, ctx.bullets || [], reports);
      const risk = bulletRisk(predicted, ctx.bullets || [], true) + allyRadioRisk(predicted, reports) + pathRisk * 0.55;
      const futureRisk = futureBulletRisk(tank, dir, ctx.bullets || [], true) + allyRadioRisk(makeBox(tank, dir, 62), reports);
      const farRisk = bulletRisk(makeBox(tank, dir, 82), ctx.bullets || [], true) + allyRadioRisk(makeBox(tank, dir, 92), reports) * 0.8;
      let score = (currentRisk - risk) * 21 - futureRisk * 10.5 - farRisk * 3.2 - pathRisk * 4.5;
      if (dir === primary) score += 5;
      if (dir === tank.dir) score += 1.5;
      if (dir === ctx.lastMoveDir) score += 2.2;
      if (dir === OPPOSITE[ctx.lastMoveDir]) score -= 4.2;
      if (bullet.dir === "up" || bullet.dir === "down") {
        score += Math.abs(centerX(predicted) - centerX(bullet)) / 7;
      } else {
        score += Math.abs(centerY(predicted) - centerY(bullet)) / 7;
      }
      if (dist(predicted, ctx.base) > dist(tank, ctx.base) + TILE * 2 && (ctx.enemies.length > 2 || defendCritical)) score -= defendCritical ? 7.5 : 2.5;
      if (defendCritical && centerY(predicted) > centerY(ctx.base) - TILE * 6) score += 2.5 + (ctx.adaptive?.dodgeDiscipline || 0) * 2.2;
      if (pathRisk > 8) score -= 45;
      if (risk <= 0.1 && futureRisk <= 0.8 && farRisk <= 0.6 && pathRisk <= 0.8) score += 13;
      if (score > bestScore) {
        best = dir;
        bestScore = score;
      }
    }
    return best;
  }

  function shotDir(ctx, tank, target) {
    if (!target) return null;
    const dirs = [tank.dir, ...targetDirOrder(tank, target), "up", "down", "left", "right"]
      .filter((dir, index, list) => dir && list.indexOf(dir) === index);
    for (const dir of dirs) {
      if (alignedWithBase(ctx, target) ? certainHit(ctx, tank, dir, target) : ctx.canShoot?.(dir, target)) return dir;
    }
    return null;
  }

  function baseDangerClose(ctx, target) {
    return target?.alive && (dist(target, ctx.base) < TILE * 7 || baseThreatScore(ctx, target) > 24);
  }

  function safeShotDir(ctx, tank, target) {
    if (!target?.alive) return null;
    const dirs = [tank.dir, ...targetDirOrder(tank, target), "up", "down", "left", "right"]
      .filter((dir, index, list) => dir && list.indexOf(dir) === index);
    for (const dir of dirs) {
      if (certainHit(ctx, tank, dir, target)) return dir;
    }
    return null;
  }

  function longRangeShot(ctx, tank, name) {
    if (!ctx.canFire?.()) return null;
    const currentRisk = bulletRisk(tank, ctx.bullets || [], true) + allyRadioRisk(tank, ctx.allyFireReports || []);
    if (currentRisk > 4.8) return null;
    const candidates = [];
    for (const enemy of ctx.enemies || []) {
      if (!visibleEnemy(ctx, enemy) || !eligibleSideTarget(ctx, enemy, name)) continue;
      const distance = dist(tank, enemy);
      if (distance < TILE * 7) continue;
      const dirs = [tank.dir, ...targetDirOrder(tank, enemy)]
        .filter((dir, index, list) => dir && list.indexOf(dir) === index);
      for (const dir of dirs) {
        if (!ctx.canShoot?.(dir, enemy)) continue;
        const turnCost = dir === tank.dir ? 0 : 260;
        const baseValue = baseThreatScore(ctx, enemy) * 16;
        const laneValue = threatLine(enemy, ctx.base, TILE * 2.2) ? 480 : 0;
        const distanceValue = Math.min(520, distance * 0.55);
        const ownSideValue = ownSide(ctx, enemy, name) ? 240 : 0;
        if (dir !== tank.dir && baseThreatScore(ctx, enemy) < 12 && !threatLine(enemy, ctx.base, TILE * 2.2)) continue;
        candidates.push({
          enemy,
          dir,
          score: baseValue + laneValue + distanceValue + ownSideValue - turnCost,
        });
      }
    }
    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  }

  function panicShotDir(ctx, tank, target) {
    if (!target?.alive) return null;
    if (dist(target, ctx.base) > TILE * 8.5 && baseThreatScore(ctx, target) < 18) return null;
    const dirs = [tank.dir, ...targetDirOrder(tank, target), "up", "down", "left", "right"]
      .filter((dir, index, list) => dir && list.indexOf(dir) === index);
    for (const dir of dirs) {
      const d = DIRS[dir];
      if (!d) continue;
      const tx = centerX(tank);
      const ty = centerY(tank);
      const ex = centerX(target);
      const ey = centerY(target);
      if ((dir === "up" || dir === "down") && Math.abs(tx - ex) > 18) continue;
      if ((dir === "left" || dir === "right") && Math.abs(ty - ey) > 18) continue;
      if (dir === "up" && ey >= ty) continue;
      if (dir === "down" && ey <= ty) continue;
      if (dir === "left" && ex >= tx) continue;
      if (dir === "right" && ex <= tx) continue;
      let x = tx;
      let y = ty;
      for (let i = 0; i < 36; i++) {
        x += d.x * TILE * 0.22;
        y += d.y * TILE * 0.22;
        if (x < 0 || y < 0 || x >= ctx.cols * TILE || y >= ctx.rows * TILE) break;
        const probe = { x: x - 3, y: y - 3, w: 6, h: 6 };
        if ((ctx.friends || []).some((friend) => friend?.alive && overlaps(probe, friend))) break;
        if (overlaps(probe, ctx.base)) break;
        if (overlaps(probe, target)) return dir;
        const tileX = Math.floor(x / TILE);
        const tileY = Math.floor(y / TILE);
        const tile = ctx.tileAt?.(tileX, tileY);
        if (tile === "S" || tile === "W" || tile === "E") break;
        if (tile === "B" && nearBase(ctx, tileX, tileY)) break;
      }
    }
    return null;
  }

  function blindForestShotDir(ctx, tank) {
    if (!ctx.canFire?.()) return null;
    const dirs = [tank.dir, "up", "down", "left", "right"]
      .filter((dir, index, list) => dir && list.indexOf(dir) === index);
    for (const enemy of ctx.enemies || []) {
      if (!enemy?.alive || !inForest(ctx, enemy)) continue;
      if (dist(tank, enemy) > TILE * 8) continue;
      for (const dir of dirs) {
        const sameColumn = (dir === "up" || dir === "down") && Math.abs(centerX(tank) - centerX(enemy)) < 24;
        const sameRow = (dir === "left" || dir === "right") && Math.abs(centerY(tank) - centerY(enemy)) < 24;
        const ahead =
          (dir === "up" && centerY(enemy) < centerY(tank)) ||
          (dir === "down" && centerY(enemy) > centerY(tank)) ||
          (dir === "left" && centerX(enemy) < centerX(tank)) ||
          (dir === "right" && centerX(enemy) > centerX(tank));
        if (ahead && (sameColumn || sameRow) && ctx.canShoot?.(dir, enemy)) return dir;
      }
    }
    return null;
  }

  function bulletDistanceToTank(tank, bullet) {
    if (!bullet) return Infinity;
    return bullet.dir === "up" || bullet.dir === "down"
      ? Math.abs(centerY(tank) - centerY(bullet))
      : Math.abs(centerX(tank) - centerX(bullet));
  }

  function duelShotDir(ctx, tank, target, bullet) {
    if (!target?.alive || !ctx.canFire?.()) return null;
    const shot = shotDir(ctx, tank, target);
    if (!shot) return null;
    const sameVerticalLane = Math.abs(centerX(tank) - centerX(target)) < 18;
    const sameHorizontalLane = Math.abs(centerY(tank) - centerY(target)) < 18;
    const faceToFace =
      (sameVerticalLane && shot === "up" && target.dir === "down" && centerY(target) < centerY(tank)) ||
      (sameVerticalLane && shot === "down" && target.dir === "up" && centerY(target) > centerY(tank)) ||
      (sameHorizontalLane && shot === "left" && target.dir === "right" && centerX(target) < centerX(tank)) ||
      (sameHorizontalLane && shot === "right" && target.dir === "left" && centerX(target) > centerX(tank));
    if (!faceToFace) return null;
    const targetDistance = dist(tank, target);
    const incomingDistance = bulletDistanceToTank(tank, bullet);
    if (bullet && incomingDistance < Math.max(42, targetDistance * 0.58)) return null;
    if (bulletRisk(tank, ctx.bullets || [], true) + allyRadioRisk(tank, ctx.allyFireReports || []) > 7.5) return null;
    return shot;
  }

  function sideLaneShotTooEarly(ctx, tank, target, dir = null) {
    if (!target?.alive) return false;
    if (dist(tank, target) > TILE * 5.5) return false;
    const dx = Math.abs(centerX(tank) - centerX(target));
    const dy = Math.abs(centerY(tank) - centerY(target));
    const closeSideLane = dx > 18 && dx < TILE * 3.2 && dy > 8 && dy < TILE * 1.45;
    const closeVerticalLane = dy > 18 && dy < TILE * 3.2 && dx > 8 && dx < TILE * 1.45;
    if (dir === "left" || dir === "right") return closeSideLane && !certainHit(ctx, tank, dir, target);
    if (dir === "up" || dir === "down") return closeVerticalLane && !certainHit(ctx, tank, dir, target);
    return closeSideLane || closeVerticalLane;
  }

  function sideLaneAlignAction(ctx, tank, target) {
    if (!target?.alive || dist(tank, target) > TILE * 5.5) return null;
    const dx = Math.abs(centerX(tank) - centerX(target));
    const dy = Math.abs(centerY(tank) - centerY(target));
    const safeMove = (dir) => dir && canMove(ctx, dir) && !isMoveIntoEnemyBullet(tank, dir, ctx.bullets || [], 9);
    if (dx > 18 && dx < TILE * 3.2 && dy > 8 && dy < TILE * 1.45) {
      const dir = centerY(target) < centerY(tank) ? "up" : "down";
      if (safeMove(dir)) return { dir, fire: false, hold: false, mode: "close-melee-align", target };
    }
    if (dy > 18 && dy < TILE * 3.2 && dx > 8 && dx < TILE * 1.45) {
      const dir = centerX(target) < centerX(tank) ? "left" : "right";
      if (safeMove(dir)) return { dir, fire: false, hold: false, mode: "close-melee-align", target };
    }
    return null;
  }

  function closeCombatAction(ctx, tank, target, name) {
    if (!target?.alive) return null;
    const distance = dist(tank, target);
    const baseCritical = dist(target, ctx.base) < TILE * 9.5 || baseThreatScore(ctx, target) > 16;
    const meleePenalty = ctx.adaptive?.meleePenalty || 0;
    const nearEnough = distance < TILE * (5.8 - meleePenalty * 1.4) || (baseCritical && distance < TILE * (8.6 - meleePenalty * 0.8));
    if (!nearEnough) return null;

    const risk = bulletRisk(tank, ctx.bullets || [], true);
    const bullet = incomingBullet(tank, ctx.bullets || []) || incomingFriendlyBullet(tank, ctx.bullets || []);
    const surviveFirst = hasDirective(ctx, "MELEE_SURVIVE_FIRST") || (ctx.adaptive?.dodgePressure || 0) > 0.35;
    if (surviveFirst && bullet && risk > 2.4) {
      const dir = dodgeDir(ctx, tank, bullet);
      if (dir) return { dir, fire: false, hold: false, mode: "close-melee-dodge", target };
    }
    const certain = safeShotDir(ctx, tank, target);
    if (certain && ctx.canFire?.() && risk < 13) {
      return { dir: certain, fire: true, hold: true, mode: "close-melee-fire", target };
    }

    const duel = duelShotDir(ctx, tank, target, bullet);
    if (duel) {
      return { dir: duel, fire: true, hold: true, mode: "close-melee-duel", target };
    }

    if (bullet && risk > 4.5) {
      const dir = dodgeDir(ctx, tank, bullet);
      if (dir) return { dir, fire: false, hold: false, mode: "close-melee-dodge", target };
    }

    const align = sideLaneAlignAction(ctx, tank, target);
    if (align) return align;

    const shot = shotDir(ctx, tank, target);
    if (shot && !sideLaneShotTooEarly(ctx, tank, target, shot) && ctx.canFire?.() && risk < 6.6) {
      return { dir: shot, fire: true, hold: true, mode: "close-melee-fire", target };
    }

    const lineClear = attackLineClearDir(ctx, tank, target, baseCritical);
    if (lineClear && ctx.canFire?.() && !alignedWithBase(ctx, target)) {
      return { dir: lineClear, fire: true, hold: true, mode: "close-melee-clear", target };
    }
    const tacticalClear = tacticalClearDir(ctx, tank, target);
    if (tacticalClear && ctx.canFire?.()) {
      return { dir: tacticalClear, fire: true, hold: true, mode: "close-melee-clear", target };
    }

    const face = directionTo(tank, target);
    const goals = [
      ...shootingPositionGoals(ctx, tank, target, name),
      ...attackGoals(ctx, target).slice(0, 10),
      ...approachGoals(ctx, target).slice(0, 8),
      ...interceptGoals(ctx, target, name).slice(0, 6),
    ];
    const dir = routeDir(ctx, tank, goals, target, "attack");
    if (ctx.routeNeedsClear && ctx.canFire?.()) {
      return { dir, fire: true, hold: true, mode: "close-melee-clear", target };
    }
    if (!dir && face && canMove(ctx, face)) {
      return { dir: face, fire: false, hold: false, mode: "close-melee", target };
    }
    return { dir, fire: false, hold: false, mode: "close-melee", target };
  }

  function alignedWithBase(ctx, target) {
    if (!target?.alive) return false;
    return Math.abs(centerX(target) - centerX(ctx.base)) < 20 || Math.abs(centerY(target) - centerY(ctx.base)) < 20;
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function certainHit(ctx, tank, dir, target) {
    const d = DIRS[dir];
    if (!d || !target?.alive) return false;
    const tx = centerX(tank);
    const ty = centerY(tank);
    const ex = centerX(target);
    const ey = centerY(target);
    if ((dir === "up" || dir === "down") && Math.abs(tx - ex) > 8) return false;
    if ((dir === "left" || dir === "right") && Math.abs(ty - ey) > 8) return false;
    if (dir === "up" && ey >= ty) return false;
    if (dir === "down" && ey <= ty) return false;
    if (dir === "left" && ex >= tx) return false;
    if (dir === "right" && ex <= tx) return false;
    let x = tx;
    let y = ty;
    for (let i = 0; i < 42; i++) {
      x += d.x * TILE * 0.25;
      y += d.y * TILE * 0.25;
      if (x < 0 || y < 0 || x >= ctx.cols * TILE || y >= ctx.rows * TILE) return false;
      const probe = { x: x - 3, y: y - 3, w: 6, h: 6 };
      if (overlaps(probe, target)) return true;
      if ((ctx.friends || []).some((friend) => friend?.alive && overlaps(probe, friend))) return false;
      const tileX = Math.floor(x / TILE);
      const tileY = Math.floor(y / TILE);
      const tile = ctx.tileAt?.(tileX, tileY);
      if (tile === "B" || tile === "S" || tile === "W" || tile === "E" || nearBase(ctx, tileX, tileY)) return false;
    }
    return false;
  }

  function attackLineClearDir(ctx, tank, target, basePriority = false) {
    if (!target?.alive) return null;
    if (baseDangerClose(ctx, target)) return null;
    if (alignedWithBase(ctx, target)) return null;
    const targetIsClose = dist(tank, target) < TILE * 6.5;
    const targetNearBase = baseThreatScore(ctx, target) > 14 || dist(target, ctx.base) < TILE * 9;
    if (!basePriority && !targetIsClose && !targetNearBase) return null;
    const tx = centerX(tank);
    const ty = centerY(tank);
    const ex = centerX(target);
    const ey = centerY(target);
    let dir = null;
    if (Math.abs(tx - ex) < 20) dir = ey < ty ? "up" : "down";
    else if (Math.abs(ty - ey) < 20) dir = ex < tx ? "left" : "right";
    if (!dir) return null;
    const d = DIRS[dir];
    let x = tx;
    let y = ty;
    for (let i = 0; i < 30; i++) {
      x += d.x * TILE * 0.45;
      y += d.y * TILE * 0.45;
      if (x < 0 || y < 0 || x >= ctx.cols * TILE || y >= ctx.rows * TILE) return null;
      const probe = { x: x - 4, y: y - 4, w: 8, h: 8 };
      if (probe.x < target.x + target.w && probe.x + probe.w > target.x && probe.y < target.y + target.h && probe.y + probe.h > target.y) return null;
      const txCell = Math.floor(x / TILE);
      const tyCell = Math.floor(y / TILE);
      const tile = ctx.tileAt?.(txCell, tyCell);
      if (nearBase(ctx, txCell, tyCell)) return null;
      if (tile === "." || tile === "F") continue;
      if (tile === "B" && !nearBase(ctx, txCell, tyCell)) return dir;
      return null;
    }
    return null;
  }

  function tacticalClearDir(ctx, tank, target) {
    if (!target?.alive || alignedWithBase(ctx, target)) return null;
    const targetPressure = dist(target, ctx.base) < TILE * 11 || baseThreatScore(ctx, target) > 10 || dist(tank, target) < TILE * 8;
    if (!targetPressure) return null;
    const dirs = [tank.dir, ...targetDirOrder(tank, target), "up", "down", "left", "right"]
      .filter((dir, index, list) => dir && list.indexOf(dir) === index);
    let best = null;
    let bestScore = -Infinity;
    for (const dir of dirs) {
      const d = DIRS[dir];
      if (!d) continue;
      let x = centerX(tank);
      let y = centerY(tank);
      let brick = null;
      let blockedByBadTile = false;
      for (let i = 0; i < 18; i++) {
        x += d.x * TILE * 0.42;
        y += d.y * TILE * 0.42;
        if (x < 0 || y < 0 || x >= ctx.cols * TILE || y >= ctx.rows * TILE) {
          blockedByBadTile = true;
          break;
        }
        const probe = { x: x - 4, y: y - 4, w: 8, h: 8 };
        if ((ctx.friends || []).some((friend) => friend?.alive && overlaps(probe, friend))) {
          blockedByBadTile = true;
          break;
        }
        if (overlaps(probe, ctx.base)) {
          blockedByBadTile = true;
          break;
        }
        const tx = Math.floor(x / TILE);
        const ty = Math.floor(y / TILE);
        const tile = ctx.tileAt?.(tx, ty);
        if (nearBase(ctx, tx, ty)) {
          blockedByBadTile = true;
          break;
        }
        if (tile === "B") {
          brick = { x: tx, y: ty, distance: i };
          break;
        }
        if (tile === "S" || tile === "W" || tile === "E") {
          blockedByBadTile = true;
          break;
        }
      }
      if (!brick || blockedByBadTile) continue;
      const afterBox = {
        x: brick.x * TILE + d.x * TILE + 2,
        y: brick.y * TILE + d.y * TILE + 2,
        w: 28,
        h: 28,
      };
      const opensAttack = dist(afterBox, target) < dist(tank, target) || threatLine(afterBox, target, TILE * 1.6);
      const opensDefense = dist(afterBox, ctx.base) < dist(tank, ctx.base) + TILE * 2 && baseThreatScore(ctx, target) > 8;
      if (!opensAttack && !opensDefense) continue;
      const score = (opensDefense ? 45 : 0) + (opensAttack ? 30 : 0) - brick.distance * 2 + (dir === tank.dir ? 8 : 0);
      if (score > bestScore) {
        best = dir;
        bestScore = score;
      }
    }
    return best;
  }

  function nearBase(ctx, x, y) {
    return baseBlocked(ctx, x, y);
  }

  function createController(name) {
    const memory = loadMemory();
    let lastMode = "defend";
    let lastMoveDir = null;
    let lastTarget = null;
    let targetAge = 0;
    let targetWorkAge = 0;
    let directionLock = 0;
    let targetLock = 0;
    let thinkCooldown = 0;
    let lastAction = null;
    let lastUrgencyKey = "";

    function learn(event, amount = 1) {
      const weights = memory.weights;
      const reward = Math.max(-1, Math.min(1, amount));
      const effort = Math.abs(reward);
      if (event === "kill") {
        weights.attack += 0.03 * reward;
        weights.clear += 0.01 * reward;
      }
      if (event === "base-danger") {
        weights.defend += 0.04 * effort;
        weights.clear += 0.01 * effort;
      }
      if (event === "stuck" || event === "route-open") {
        weights.clear += 0.04 * effort;
        weights.survive += 0.02 * effort;
      }
      if (event === "self-hit" || event === "player-death" || event === "partner-death") {
        weights.survive += 0.04 * effort;
        weights.defend += 0.01 * effort;
      }
      for (const key of Object.keys(weights)) weights[key] = clamp(weights[key], MIN_WEIGHT, MAX_LEARNED_WEIGHT);
      saveMemory(memory);
    }

    function commit(ctx, action, dt = 0) {
      directionLock = Math.max(0, directionLock - dt);
      targetLock = Math.max(0, targetLock - dt);
      const actionBulletThreshold = /freeze-assault/.test(action.mode || "")
        ? 18
        : /midline|intercept|defend|base-anchor|base-assault/.test(action.mode || "") ? 14 : 9;
      if (action.dir && !action.fire && action.mode !== "dodge" && isMoveIntoEnemyBullet(ctx.tank, action.dir, ctx.bullets || [], actionBulletThreshold)) {
        const bullet = incomingBullet(ctx.tank, ctx.bullets || []);
        const escape = bullet ? dodgeDir(ctx, ctx.tank, bullet) : null;
        action = escape && !isMoveIntoEnemyBullet(ctx.tank, escape, ctx.bullets || [], actionBulletThreshold)
          ? { ...action, dir: escape, hold: false, mode: `${action.mode || "move"}-avoid-bullet` }
          : { ...action, dir: null, hold: true, mode: `${action.mode || "move"}-hold-bullet` };
      }
      const targetChanged = action.target && action.target !== lastTarget;
      if (targetChanged) {
        directionLock = 0;
        const closeCombatTarget = action.target && dist(ctx.tank, action.target) < TILE * 3.8;
        const priorityTarget = action.target && (closeCombatTarget || dist(ctx.tank, action.target) < TILE * 6.5 || baseThreatScore(ctx, action.target) > 14);
        targetLock = action.mode?.startsWith("base-intruder") || action.mode?.startsWith("spawn-defense") || action.mode?.startsWith("spawn-assault") || action.mode?.startsWith("target-execute") || /^(defend|defend-clear|base-assault|base-assault-clear)$/.test(action.mode || "")
          ? 2.1
          : closeCombatTarget ? 1.8 : priorityTarget ? 1.45 : /^(long-range-fire|freeze-assault|freeze-assault-fire|freeze-assault-clear|auto-midline|auto-midline-fire|auto-midline-clear|hard-midline|hard-midline-fire|hard-midline-clear|forward-intercept|forward-intercept-fire|forward-intercept-clear|attack|attack-clear|intercept|intercept-clear)$/.test(action.mode || "") ? 1.25 : 0.35;
      }
      if (action.dir && !action.hold) {
        const reversing = lastMoveDir && action.dir === OPPOSITE[lastMoveDir];
        if (reversing && directionLock > 0 && !ctx.routeFollowing && action.mode !== "dodge" && canMove(ctx, lastMoveDir)) {
          action = { ...action, dir: lastMoveDir };
        } else if (lastMoveDir && action.dir !== lastMoveDir) {
          directionLock = action.mode === "dodge" ? 0.28 : 0.6;
        }
        lastMoveDir = action.dir;
      }
      if (action.target) {
        if (action.target === lastTarget) {
          targetAge += dt;
          targetWorkAge = (action.fire || action.mode === "route-clear" || action.mode === "freeze-assault-clear" || action.mode === "auto-midline-clear" || action.mode === "hard-midline-clear" || action.mode === "attack-clear" || action.mode === "intercept-clear" || action.mode === "early-defend-clear" || action.mode === "base-assault-clear" || action.mode === "spawn-assault-clear" || action.mode === "target-execute-clear") ? 0 : targetWorkAge + dt;
        } else {
          targetAge = 0;
          targetWorkAge = 0;
        }
        if (!targetChanged && /^(long-range-fire|freeze-assault|freeze-assault-fire|freeze-assault-clear|auto-midline|auto-midline-fire|auto-midline-clear|hard-midline|hard-midline-fire|hard-midline-clear|forward-intercept|forward-intercept-fire|forward-intercept-clear|attack|attack-clear|intercept|intercept-clear|base-assault|base-assault-clear|defend|defend-clear|base-intruder-fire|base-intruder-clear|base-intruder-assault|spawn-defense|spawn-defense-fire|spawn-defense-clear|spawn-assault|spawn-assault-fire|spawn-assault-clear|target-execute|target-execute-fire|target-execute-clear)$/.test(action.mode || "")) {
          targetLock = Math.max(targetLock, baseThreatScore(ctx, action.target) > 16 ? 1.05 : 0.65);
        }
        lastTarget = action.target;
      } else {
        targetAge = 0;
        targetWorkAge = 0;
        targetLock = 0;
      }
      const urgent = action.mode?.includes("dodge") || action.mode?.includes("melee") || action.mode?.includes("fire") || action.mode?.includes("clear");
      thinkCooldown = urgent ? 0.045 : action.hold ? 0.06 : 0.11;
      lastAction = action;
      return action;
    }

    function emergencyDodgeAction(ctx, scan) {
      if (!scan.bullet) return null;
      const risk = scan.bulletRisk + movePathRisk(ctx.tank, ctx.tank.dir, ctx.bullets || [], ctx.allyFireReports || []) * 0.22;
      if (risk < 6.2) return null;
      const target = scan.baseTarget || scan.enemyTarget;
      const duel = risk < 8.2 ? duelShotDir(ctx, ctx.tank, target, scan.bullet) : null;
      if (duel && ctx.canFire?.()) return { dir: duel, fire: true, hold: true, mode: "duel-fire", target };
      const dir = dodgeDir(ctx, ctx.tank, scan.bullet);
      if (dir && canMove(ctx, dir) && !isMoveIntoEnemyBullet(ctx.tank, dir, ctx.bullets || [], risk > 10 ? 8 : 11)) {
        return { dir, fire: false, hold: false, mode: "emergency-dodge", target };
      }
      return { dir: null, fire: false, hold: true, mode: "emergency-dodge-hold", target };
    }

    function committedThreatTarget(ctx, scan) {
      if (!lastTarget?.alive || targetLock <= 0 || !eligibleSideTarget(ctx, lastTarget, name)) return null;
      if (scan.forced) return null;
      const tank = ctx.tank;
      const targetBaseScore = baseThreatScore(ctx, lastTarget);
      const close = dist(tank, lastTarget) < TILE * 6.8;
      const midline = centerY(lastTarget) > (ctx.rows || 24) * TILE * 0.5 - TILE * 3.5;
      const baseCritical = targetBaseScore > 14 || dist(lastTarget, ctx.base) < TILE * 10.5;
      if (!close && !midline && !baseCritical) return null;
      if (ctx.staleTarget === lastTarget && targetBaseScore < 18 && !close) return null;
      const currentBase = scan.baseTarget?.alive ? baseThreatScore(ctx, scan.baseTarget) : 0;
      if (scan.baseTarget && scan.baseTarget !== lastTarget && currentBase > targetBaseScore + 12 && dist(scan.baseTarget, ctx.base) < TILE * 8) return null;
      if (scan.bullet && scan.bulletRisk > (baseCritical ? 12.5 : 8.5)) return null;
      return lastTarget;
    }

    function decide(ctx, dt = 0) {
      ctx.cols = ctx.cols || 26;
      ctx.rows = ctx.rows || 24;
      ctx.lastMoveDir = lastMoveDir;
      ctx.adaptive = adaptiveProfile(memory);
      ctx.tacticalMemory = memory.tacticalMemory || normalizeTacticalMemory();
      ctx.review = normalizeReview(memory.review);
      const urgentKey = [
        Math.round((ctx.tank?.x || 0) / 16),
        Math.round((ctx.tank?.y || 0) / 16),
        Math.round((ctx.base?.x || 0) / 32),
        Math.round((ctx.base?.y || 0) / 32),
        (ctx.enemies || []).filter((enemy) => enemy?.alive && dist(enemy, ctx.base) < TILE * 10).length,
        (ctx.bullets || []).filter((bullet) => bullet?.enemy && dist(bullet, ctx.tank) < TILE * 6).length,
        ctx.mapVersion || 0,
      ].join("|");
      thinkCooldown = Math.max(0, thinkCooldown - dt);
      if (lastAction && thinkCooldown > 0 && urgentKey === lastUrgencyKey) {
        return lastAction;
      }
      lastUrgencyKey = urgentKey;
      const patience = ctx.adaptive.targetPatience ?? 0.45;
      const pressureCut = Math.max(ctx.adaptive.stuckPressure * 1.35, ctx.adaptive.stalePressure * 1.85, ctx.adaptive.midlinePressure * 1.1);
      const staleAgeLimit = 3.2 - pressureCut - (0.55 - patience) * 1.1;
      const staleWorkLimit = 2.35 - pressureCut * 0.82 - (0.55 - patience) * 0.9;
      const lastTargetCritical = lastTarget?.alive && (baseThreatScore(ctx, lastTarget) > 26 || dist(lastTarget, ctx.base) < TILE * 7.5);
      ctx.staleTarget = !lastTargetCritical && targetAge > Math.max(1.35, staleAgeLimit) && targetWorkAge > Math.max(0.85, staleWorkLimit) ? lastTarget : null;
      const patchedWeights = { ...memory.weights };
      if (memory.patches?.includes("base_lockdown")) {
        patchedWeights.defend += 0.22;
        patchedWeights.attack += 0.08;
      }
      if (memory.patches?.includes("midline_lock")) patchedWeights.defend += 0.16;
      if (memory.patches?.includes("unstuck_clear")) patchedWeights.clear += 0.18;
      if (memory.patches?.includes("dodge_focus")) patchedWeights.survive += 0.22;
      ctx.weights = normalizeWeights(patchedWeights);
      ctx.patches = memory.patches || [];
      const tank = ctx.tank;
      const scan = scanBattlefield(ctx, tank, name);
      const lockedTarget = lastTarget?.alive && targetLock > 0 && eligibleSideTarget(ctx, lastTarget, name) && !scan.emergency && !scan.baseTarget && !scan.forced ? lastTarget : null;
      if (lockedTarget && scan.enemyTarget !== lockedTarget) {
        scan.enemyTarget = lockedTarget;
        scan.enemyShot = shotDir(ctx, tank, lockedTarget);
      }
      const guard = guardGoals(ctx, name);
      const guardRange = dist(tank, ctx.base);
      const visibleBasePressure = scan.threats.some((item) => (item.rawScore ?? item.score) > 9);
      const closeFreeze = nearFreezeBonus(ctx, tank);
      const urgentFreeze = urgentFreezeBonus(ctx, tank);
      const bonus = !scan.emergency && !visibleBasePressure ? nearbyBonus(ctx, tank) : null;
      const intruder = baseIntruder(ctx, name);
      const anchorThreat = baseAnchorThreat(ctx);
      const laneThreat = baseFireLaneThreat(ctx);
      const spawnEnemy = spawnThreat(ctx, tank, name);
      const killThreat = ctx.adaptive.killConfirm ? (intruder || laneThreat || killConfirmThreat(ctx, tank, name)) : null;
      const endgameThreat = !scan.baseTarget && !intruder ? endgameStalledThreat(ctx, tank, name) : null;
      const midlineThreat = !intruder && !anchorThreat && !laneThreat ? midlineBreachThreat(ctx) : null;
      const advancingThreat = !intruder && !anchorThreat && !laneThreat ? advancingPressureThreat(ctx, tank, name) : null;
      const executeTarget = committedThreatTarget(ctx, scan);
      const emergencyDodge = emergencyDodgeAction(ctx, scan);
      if (emergencyDodge) {
        lastMode = emergencyDodge.mode;
        return commit(ctx, emergencyDodge, dt);
      }
      if (closeFreeze && scan.bulletRisk < 7.5) {
        const dir = routeDir(ctx, tank, [closeFreeze], closeFreeze, "bonus");
        lastMode = "near-freeze";
        return commit(ctx, { dir, fire: false, hold: false, mode: "near-freeze" }, dt);
      }

      const freezeTarget = freezeAssaultTarget(ctx, tank, name);
      if (freezeTarget) {
        const freezeBasePressure = baseThreatScore(ctx, freezeTarget) > 12 || dist(freezeTarget, ctx.base) < TILE * 12;
        const shot = (freezeBasePressure ? panicShotDir(ctx, tank, freezeTarget) : null) || safeShotDir(ctx, tank, freezeTarget) || shotDir(ctx, tank, freezeTarget);
        if (shot && ctx.canFire?.() && scan.bulletRisk < (freezeBasePressure ? 18 : 10.5)) {
          lastMode = "freeze-assault-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "freeze-assault-fire", target: freezeTarget }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, freezeTarget, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "freeze-assault-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "freeze-assault-clear", target: freezeTarget }, dt);
        }
        const tacticalClear = tacticalClearDir(ctx, tank, freezeTarget);
        if (tacticalClear && ctx.canFire?.() && freezeBasePressure) {
          lastMode = "freeze-assault-clear";
          return commit(ctx, { dir: tacticalClear, fire: true, hold: true, mode: "freeze-assault-clear", target: freezeTarget }, dt);
        }
        const goals = [
          ...(freezeBasePressure ? basePanicGoals(ctx, freezeTarget, name) : []),
          ...shootingPositionGoals(ctx, tank, freezeTarget, name),
          ...attackGoals(ctx, freezeTarget),
          ...approachGoals(ctx, freezeTarget),
          ...interceptGoals(ctx, freezeTarget, name),
        ];
        const dir = routeDir(ctx, tank, goals, freezeTarget, "attack");
        lastMode = "freeze-assault";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "freeze-assault-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "freeze-assault-clear", target: freezeTarget }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "freeze-assault", target: freezeTarget }, dt);
      }

      if (executeTarget && !freezeTarget) {
        const shot = safeShotDir(ctx, tank, executeTarget) || shotDir(ctx, tank, executeTarget);
        if (shot && ctx.canFire?.() && scan.bulletRisk < 10.5) {
          lastMode = "target-execute-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "target-execute-fire", target: executeTarget }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, executeTarget, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "target-execute-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "target-execute-clear", target: executeTarget }, dt);
        }
        const tacticalClear = tacticalClearDir(ctx, tank, executeTarget);
        if (tacticalClear && ctx.canFire?.()) {
          lastMode = "target-execute-clear";
          return commit(ctx, { dir: tacticalClear, fire: true, hold: true, mode: "target-execute-clear", target: executeTarget }, dt);
        }
        const goals = [
          ...shootingPositionGoals(ctx, tank, executeTarget, name),
          ...interceptGoals(ctx, executeTarget, name),
          ...attackGoals(ctx, executeTarget).slice(0, 16),
          ...approachGoals(ctx, executeTarget).slice(0, 12),
        ];
        const dir = routeDir(ctx, tank, goals, executeTarget, baseThreatScore(ctx, executeTarget) > 16 ? "intercept" : "attack");
        lastMode = "target-execute";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "target-execute-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "target-execute-clear", target: executeTarget }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "target-execute", target: executeTarget }, dt);
      }

      if (midlineThreat && (ctx.adaptive.frontGuardBias > 0.35 || ctx.adaptive.midlineTriggerOffset > 1.2)) {
        const shot = safeShotDir(ctx, tank, midlineThreat) || shotDir(ctx, tank, midlineThreat);
        if (shot && ctx.canFire?.() && scan.bulletRisk < 7.8) {
          lastMode = "auto-midline-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "auto-midline-fire", target: midlineThreat }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, midlineThreat, name), ...interceptGoals(ctx, midlineThreat, name), ...basePanicGoals(ctx, midlineThreat, name)];
        const dir = routeDir(ctx, tank, goals, midlineThreat, "intercept");
        lastMode = "auto-midline";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "auto-midline-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "auto-midline-clear", target: midlineThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "auto-midline", target: midlineThreat }, dt);
      }
      const meleeTarget = scan.closeCombatTarget || (anchorThreat && dist(tank, anchorThreat) < TILE * 8.6 ? anchorThreat : null);
      const meleeAction = closeCombatAction(ctx, tank, meleeTarget, name);
      if (meleeAction) {
        lastMode = meleeAction.mode;
        return commit(ctx, meleeAction, dt);
      }

      if (urgentFreeze) {
        const dir = routeDir(ctx, tank, [urgentFreeze], urgentFreeze, "bonus");
        lastMode = "urgent-freeze";
        return commit(ctx, { dir, fire: false, hold: false, mode: "urgent-freeze" }, dt);
      }

      if (midlineThreat) {
        const shot = safeShotDir(ctx, tank, midlineThreat) || shotDir(ctx, tank, midlineThreat);
        if (shot && ctx.canFire?.() && scan.bulletRisk < 6.8) {
          lastMode = "hard-midline-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "hard-midline-fire", target: midlineThreat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, midlineThreat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "hard-midline-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "hard-midline-clear", target: midlineThreat }, dt);
        }
        const tacticalClear = tacticalClearDir(ctx, tank, midlineThreat);
        if (tacticalClear && ctx.canFire?.()) {
          lastMode = "hard-midline-clear";
          return commit(ctx, { dir: tacticalClear, fire: true, hold: true, mode: "hard-midline-clear", target: midlineThreat }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, midlineThreat, name), ...basePanicGoals(ctx, midlineThreat, name), ...interceptGoals(ctx, midlineThreat, name), ...attackGoals(ctx, midlineThreat)];
        const dir = routeDir(ctx, tank, goals, midlineThreat, "intercept");
        lastMode = "hard-midline";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "hard-midline-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "hard-midline-clear", target: midlineThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "hard-midline", target: midlineThreat }, dt);
      }

      if (advancingThreat) {
        const shot = shotDir(ctx, tank, advancingThreat) || safeShotDir(ctx, tank, advancingThreat);
        if (shot && ctx.canFire?.() && scan.bulletRisk < 7.2) {
          lastMode = "forward-intercept-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "forward-intercept-fire", target: advancingThreat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, advancingThreat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "forward-intercept-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "forward-intercept-clear", target: advancingThreat }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, advancingThreat, name), ...interceptGoals(ctx, advancingThreat, name), ...attackGoals(ctx, advancingThreat), ...approachGoals(ctx, advancingThreat)];
        const dir = routeDir(ctx, tank, goals, advancingThreat, "intercept");
        lastMode = "forward-intercept";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "forward-intercept-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "forward-intercept-clear", target: advancingThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "forward-intercept", target: advancingThreat }, dt);
      }

      if (anchorThreat) {
        const shot = panicShotDir(ctx, tank, anchorThreat) || safeShotDir(ctx, tank, anchorThreat) || shotDir(ctx, tank, anchorThreat);
        if (shot && ctx.canFire?.()) {
          lastMode = "base-anchor-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "base-anchor-fire", target: anchorThreat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, anchorThreat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "base-anchor-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "base-anchor-clear", target: anchorThreat }, dt);
        }
        const tacticalClear = tacticalClearDir(ctx, tank, anchorThreat);
        if (tacticalClear && ctx.canFire?.()) {
          lastMode = "base-anchor-clear";
          return commit(ctx, { dir: tacticalClear, fire: true, hold: true, mode: "base-anchor-clear", target: anchorThreat }, dt);
        }
        const goals = [...tacticalMemoryGoals(ctx, anchorThreat, name), ...shootingPositionGoals(ctx, tank, anchorThreat, name), ...baseAnchorGoals(ctx, anchorThreat, name), ...basePanicGoals(ctx, anchorThreat, name), ...attackGoals(ctx, anchorThreat).slice(0, 8)];
        const dir = routeDir(ctx, tank, goals, anchorThreat, "defend");
        lastMode = "base-anchor";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "base-anchor-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "base-anchor-clear", target: anchorThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "base-anchor", target: anchorThreat }, dt);
      }

      if (killThreat) {
        const shot = panicShotDir(ctx, tank, killThreat) || shotDir(ctx, tank, killThreat) || safeShotDir(ctx, tank, killThreat);
        if (shot && ctx.canFire?.()) {
          lastMode = "kill-confirm-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "kill-confirm-fire", target: killThreat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, killThreat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "kill-confirm-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "kill-confirm-clear", target: killThreat }, dt);
        }
        const tacticalClear = tacticalClearDir(ctx, tank, killThreat);
        if (tacticalClear && ctx.canFire?.()) {
          lastMode = "kill-confirm-clear";
          return commit(ctx, { dir: tacticalClear, fire: true, hold: true, mode: "kill-confirm-clear", target: killThreat }, dt);
        }
        const goals = [...tacticalMemoryGoals(ctx, killThreat, name), ...shootingPositionGoals(ctx, tank, killThreat, name), ...killConfirmGoals(ctx, killThreat, name), ...baseFireLaneGoals(ctx, killThreat, name), ...basePanicGoals(ctx, killThreat, name), ...attackGoals(ctx, killThreat)];
        const dir = routeDir(ctx, tank, goals, killThreat, "attack");
        lastMode = "kill-confirm";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "kill-confirm-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "kill-confirm-clear", target: killThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "kill-confirm", target: killThreat }, dt);
      }

      if (laneThreat && (ctx.adaptive.laneBlockBias || 0) >= 0.22) {
        const shot = panicShotDir(ctx, tank, laneThreat) || safeShotDir(ctx, tank, laneThreat) || shotDir(ctx, tank, laneThreat);
        if (shot && ctx.canFire?.()) {
          lastMode = "base-lane-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "base-lane-fire", target: laneThreat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, laneThreat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "base-lane-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "base-lane-clear", target: laneThreat }, dt);
        }
        const tacticalClear = tacticalClearDir(ctx, tank, laneThreat);
        if (tacticalClear && ctx.canFire?.()) {
          lastMode = "base-lane-clear";
          return commit(ctx, { dir: tacticalClear, fire: true, hold: true, mode: "base-lane-clear", target: laneThreat }, dt);
        }
        const goals = [...tacticalMemoryGoals(ctx, laneThreat, name), ...shootingPositionGoals(ctx, tank, laneThreat, name), ...baseFireLaneGoals(ctx, laneThreat, name), ...basePanicGoals(ctx, laneThreat, name), ...attackGoals(ctx, laneThreat)];
        const dir = routeDir(ctx, tank, goals, laneThreat, "defend");
        lastMode = "base-lane-block";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "base-lane-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "base-lane-clear", target: laneThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "base-lane-block", target: laneThreat }, dt);
      }

      if (endgameThreat) {
        const shot = shotDir(ctx, tank, endgameThreat) || safeShotDir(ctx, tank, endgameThreat);
        if (shot && ctx.canFire?.() && bulletRisk(tank, ctx.bullets || []) < 11) {
          lastMode = "endgame-hunt-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "endgame-hunt-fire", target: endgameThreat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, endgameThreat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "endgame-hunt-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "endgame-hunt-clear", target: endgameThreat }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, endgameThreat, name), ...attackGoals(ctx, endgameThreat), ...approachGoals(ctx, endgameThreat), ...interceptGoals(ctx, endgameThreat, name)];
        const dir = routeDir(ctx, tank, goals, endgameThreat, "attack");
        lastMode = "endgame-hunt";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "endgame-hunt-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "endgame-hunt-clear", target: endgameThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "endgame-hunt", target: endgameThreat }, dt);
      }

      if (spawnEnemy) {
        const shot = safeShotDir(ctx, tank, spawnEnemy) || shotDir(ctx, tank, spawnEnemy);
        if (shot && ctx.canFire?.() && scan.bulletRisk < 9.5) {
          lastMode = "spawn-assault-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "spawn-assault-fire", target: spawnEnemy }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, spawnEnemy, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "spawn-assault-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "spawn-assault-clear", target: spawnEnemy }, dt);
        }
        const goals = [
          ...spawnAssaultGoals(ctx, tank, spawnEnemy, name),
          ...shootingPositionGoals(ctx, tank, spawnEnemy, name),
          ...attackGoals(ctx, spawnEnemy).slice(0, 12),
          ...approachGoals(ctx, spawnEnemy).slice(0, 14),
          ...interceptGoals(ctx, spawnEnemy, name).slice(0, 8),
        ];
        const dir = routeDir(ctx, tank, goals, spawnEnemy, "attack");
        lastMode = "spawn-assault";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "spawn-assault-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "spawn-assault-clear", target: spawnEnemy }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "spawn-assault", target: spawnEnemy }, dt);
      }

      if (hasPatch(ctx, "base_lockdown") && (scan.baseTarget || intruder)) {
        const threat = scan.baseTarget || intruder;
        const shot = panicShotDir(ctx, tank, threat) || (baseDangerClose(ctx, threat) ? safeShotDir(ctx, tank, threat) : shotDir(ctx, tank, threat));
        if (shot && ctx.canFire?.()) {
          lastMode = "patch-base-lockdown-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "patch-base-lockdown-fire", target: threat }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, threat, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "patch-base-lockdown-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "patch-base-lockdown-clear", target: threat }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, threat, name), ...basePanicGoals(ctx, threat, name), ...attackGoals(ctx, threat), ...approachGoals(ctx, threat), ...interceptGoals(ctx, threat, name)];
        const dir = routeDir(ctx, tank, goals, threat, "attack");
        lastMode = "patch-base-lockdown";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          return commit(ctx, { dir, fire: true, hold: true, mode: "patch-base-lockdown-clear", target: threat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "patch-base-lockdown", target: threat }, dt);
      }

      if (scan.closeCombatTarget) {
        if (scan.closeCombatShot && ctx.canFire?.()) {
          lastMode = "close-combat-fire";
          return commit(ctx, { dir: scan.closeCombatShot, fire: true, hold: true, mode: "close-combat-fire", target: scan.closeCombatTarget }, dt);
        }
        if (scan.closeCombatLineClear && ctx.canFire?.()) {
          lastMode = "close-combat-clear";
          return commit(ctx, { dir: scan.closeCombatLineClear, fire: true, hold: true, mode: "close-combat-clear", target: scan.closeCombatTarget }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, scan.closeCombatTarget, name), ...attackGoals(ctx, scan.closeCombatTarget)];
        const routeGoals = goals.length ? goals : approachGoals(ctx, scan.closeCombatTarget);
        const dir = routeDir(ctx, tank, routeGoals, scan.closeCombatTarget, "attack");
        lastMode = "close-combat";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "close-combat-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "close-combat-clear", target: scan.closeCombatTarget }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "close-combat", target: scan.closeCombatTarget }, dt);
      }

      if (intruder) {
        const shot = panicShotDir(ctx, tank, intruder) || (baseDangerClose(ctx, intruder) ? safeShotDir(ctx, tank, intruder) : shotDir(ctx, tank, intruder));
        if (shot && ctx.canFire?.()) {
          lastMode = "base-intruder-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "base-intruder-fire", target: intruder }, dt);
        }
        const lineClear = attackLineClearDir(ctx, tank, intruder, true);
        if (lineClear && ctx.canFire?.()) {
          lastMode = "base-intruder-clear";
          return commit(ctx, { dir: lineClear, fire: true, hold: true, mode: "base-intruder-clear", target: intruder }, dt);
        }
        const panic = [...tacticalMemoryGoals(ctx, intruder, name), ...basePanicGoals(ctx, intruder, name)];
        const attack = [...shootingPositionGoals(ctx, tank, intruder, name), ...attackGoals(ctx, intruder)];
        const approach = approachGoals(ctx, intruder);
        const intercept = interceptGoals(ctx, intruder, name);
        const dir = routeDir(ctx, tank, [...panic, ...attack, ...approach, ...intercept], intruder, "attack");
        lastMode = "base-intruder-assault";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "base-intruder-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "base-intruder-clear", target: intruder }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "base-intruder-assault", target: intruder }, dt);
      }

      const immediateShot = scan.baseShot || scan.enemyShot;
      if (scan.bullet && scan.bulletRisk >= 7.5) {
        const dir = dodgeDir(ctx, tank, scan.bullet);
        lastMode = "dodge";
        return commit(ctx, { dir, fire: false, hold: false, mode: "dodge" }, dt);
      }

      const longShot = longRangeShot(ctx, tank, name);
      if (longShot) {
        lastMode = "long-range-fire";
        return commit(ctx, { dir: longShot.dir, fire: true, hold: true, mode: "long-range-fire", target: longShot.enemy }, dt);
      }

      const duelShot = duelShotDir(ctx, tank, scan.baseTarget || scan.enemyTarget, scan.bullet);
      if (duelShot) {
        lastMode = "duel-fire";
        return commit(ctx, { dir: duelShot, fire: true, hold: true, mode: "duel-fire", target: scan.baseTarget || scan.enemyTarget }, dt);
      }

      if (scan.bullet && immediateShot && ctx.canFire?.() && scan.bulletRisk < 3.8) {
        lastMode = "fire-before-dodge";
        return commit(ctx, { dir: immediateShot, fire: true, hold: true, mode: "fire-before-dodge", target: scan.baseTarget || scan.enemyTarget }, dt);
      }

      const breachedThreat = midlineBreachThreat(ctx);
      if (breachedThreat && !scan.forced && (scan.baseTarget || ctx.adaptive.midlinePressure > 0.55 || baseThreatScore(ctx, breachedThreat) > 12)) {
        const shot = shotDir(ctx, tank, breachedThreat);
        if (shot && ctx.canFire?.() && scan.bulletRisk < 5.8) {
          lastMode = "midline-counter-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "midline-counter-fire", target: breachedThreat }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, breachedThreat, name), ...interceptGoals(ctx, breachedThreat, name), ...attackGoals(ctx, breachedThreat), ...approachGoals(ctx, breachedThreat)];
        const dir = routeDir(ctx, tank, goals, breachedThreat, "defend");
        lastMode = "midline-counter";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "midline-counter-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "midline-counter-clear", target: breachedThreat }, dt);
        }
        if (!scan.bullet || scan.bulletRisk < 8 || ctx.adaptive.dodgePressure > 0.82) {
          return commit(ctx, { dir, fire: false, hold: false, mode: "midline-counter", target: breachedThreat }, dt);
        }
      }

      if (scan.bullet) {
        const dir = dodgeDir(ctx, tank, scan.bullet);
        lastMode = "dodge";
        return commit(ctx, { dir, fire: false, hold: false, mode: "dodge" }, dt);
      }

      const blindShot = blindForestShotDir(ctx, tank);
      if (blindShot) {
        lastMode = "blind-forest-fire";
        return commit(ctx, { dir: blindShot, fire: true, hold: true, mode: "blind-forest-fire" }, dt);
      }

      if (breachedThreat && !scan.forced) {
        if ((scan.baseShot || scan.enemyShot) && ctx.canFire?.()) {
          const shot = scan.baseTarget ? scan.baseShot : scan.enemyShot;
          lastMode = "midline-defend-fire";
          return commit(ctx, { dir: shot, fire: true, hold: true, mode: "midline-defend-fire", target: scan.baseTarget || scan.enemyTarget || breachedThreat }, dt);
        }
        const goals = midlineDefenseGoals(ctx, name);
        const dir = routeDir(ctx, tank, goals, breachedThreat, "defend");
        lastMode = name === "1P" ? "midline-spawn-guard" : "midline-base-guard";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "midline-route-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "midline-route-clear", target: breachedThreat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: lastMode, target: breachedThreat }, dt);
      }

      const leadingThreat = scan.threats[0];
      if (!scan.emergency && leadingThreat && leadingThreat.rawScore > 10 && guardRange > TILE * 5.5) {
        const threat = leadingThreat.enemy;
        const goals = defensiveLineCells(ctx, threat, name).map((c) => ({ x: c.x * TILE + 2, y: c.y * TILE + 2, w: 28, h: 28 }));
        const dir = routeDir(ctx, tank, goals.length ? goals : guard, threat, "intercept");
        lastMode = "early-defend";
        if (ctx.routeNeedsClear) {
          lastMode = "early-defend-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "early-defend-clear", target: threat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "early-defend", target: threat }, dt);
      }

      if (scan.baseTarget || scan.emergency) {
        const threat = scan.baseTarget || scan.threats[0]?.enemy;
        const baseShot = panicShotDir(ctx, tank, threat) || (baseDangerClose(ctx, threat) ? safeShotDir(ctx, tank, threat) : scan.baseShot);
        if (baseShot && ctx.canFire?.()) {
          lastMode = "defend";
          return commit(ctx, { dir: baseShot, fire: true, hold: true, mode: "defend", target: threat }, dt);
        }
        if (!baseDangerClose(ctx, threat) && scan.baseLineClear && ctx.canFire?.()) {
          lastMode = "defend-clear";
          return commit(ctx, { dir: scan.baseLineClear, fire: true, hold: true, mode: "defend-clear", target: threat }, dt);
        }
        if (threat && (scan.forced || baseThreatScore(ctx, threat) > 18 || dist(threat, ctx.base) < TILE * 10)) {
          const panic = basePanicGoals(ctx, threat, name);
          const attack = [...shootingPositionGoals(ctx, tank, threat, name), ...attackGoals(ctx, threat)];
          const approach = approachGoals(ctx, threat);
          const intercept = interceptGoals(ctx, threat, name);
          const goals = [...panic, ...attack, ...approach, ...intercept];
          const dir = routeDir(ctx, tank, goals, threat, "attack");
          lastMode = "base-assault";
          if (ctx.routeNeedsClear && ctx.canFire?.()) {
            lastMode = "base-assault-clear";
            return commit(ctx, { dir, fire: true, hold: true, mode: "base-assault-clear", target: threat }, dt);
          }
          return commit(ctx, { dir, fire: false, hold: false, mode: "base-assault", target: threat }, dt);
        }
        const goals = interceptGoals(ctx, threat, name);
        const dir = routeDir(ctx, tank, goals, threat, "intercept");
        lastMode = "intercept";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "intercept-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "intercept-clear", target: threat }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "intercept", target: threat }, dt);
      }

      if (bonus) {
        const dir = routeDir(ctx, tank, [bonus], bonus, "bonus");
        lastMode = "bonus";
        return commit(ctx, { dir, fire: false, hold: false, mode: "bonus" }, dt);
      }

      if (scan.enemyShot && ctx.canFire?.()) {
        lastMode = "attack";
        return commit(ctx, { dir: scan.enemyShot, fire: true, hold: true, mode: "attack", target: scan.enemyTarget }, dt);
      }

      if (scan.enemyLineClear && ctx.canFire?.()) {
        lastMode = "attack-clear";
        return commit(ctx, { dir: scan.enemyLineClear, fire: true, hold: true, mode: "attack-clear", target: scan.enemyTarget }, dt);
      }

      if (scan.enemyTarget) {
        const huntMode = ctx.enemies.length < 3;
        const targetRoute = routeDistanceToTarget(ctx, tank, scan.enemyTarget);
        const targetThreat = baseThreatScore(ctx, scan.enemyTarget);
        const targetClose = dist(tank, scan.enemyTarget) < TILE * 9.5;
        const targetReachable = Number.isFinite(targetRoute) && targetRoute <= 18;
        const shouldPressTarget = huntMode || targetClose || targetReachable || targetThreat > 10;
        const targetInOwnSide = ownSide(ctx, scan.enemyTarget, name);
        const mayCrossSide = targetInOwnSide || canCrossToHelp(ctx, name);
        if (!mayCrossSide) {
          const dir = routeDir(ctx, tank, guard, ctx.base, "defend");
          lastMode = "hold-own-side";
          if (ctx.routeNeedsClear && ctx.canFire?.()) {
            lastMode = "route-clear";
            return commit(ctx, { dir, fire: true, hold: true, mode: "route-clear", target: scan.enemyTarget }, dt);
          }
          return commit(ctx, { dir, fire: false, hold: false, mode: "hold-own-side", target: scan.enemyTarget }, dt);
        }
        if (!shouldPressTarget && guardRange > TILE * 12 && dist(tank, scan.enemyTarget) > TILE * 8) {
          const dir = routeDir(ctx, tank, guard, ctx.base, "defend");
          lastMode = "return-guard";
          if (ctx.routeNeedsClear && ctx.canFire?.()) {
            lastMode = "route-clear";
            return commit(ctx, { dir, fire: true, hold: true, mode: "route-clear", target: scan.enemyTarget }, dt);
          }
          return commit(ctx, { dir, fire: false, hold: false, mode: "return-guard", target: scan.enemyTarget }, dt);
        }
        const goals = [...shootingPositionGoals(ctx, tank, scan.enemyTarget, name), ...attackGoals(ctx, scan.enemyTarget)];
        const routeGoals = goals.length ? goals : approachGoals(ctx, scan.enemyTarget);
        const dir = routeDir(ctx, tank, routeGoals.length ? routeGoals : approachGoals(ctx, scan.enemyTarget), scan.enemyTarget, "attack");
        lastMode = "attack";
        if (ctx.routeNeedsClear && ctx.canFire?.()) {
          lastMode = "attack-clear";
          return commit(ctx, { dir, fire: true, hold: true, mode: "attack-clear", target: scan.enemyTarget }, dt);
        }
        return commit(ctx, { dir, fire: false, hold: false, mode: "attack", target: scan.enemyTarget }, dt);
      }

      const dir = routeDir(ctx, tank, guard, ctx.base, "defend");
      lastMode = "guard";
      if (ctx.routeNeedsClear && ctx.canFire?.()) {
        lastMode = "route-clear";
        return commit(ctx, { dir, fire: true, hold: true, mode: "route-clear" }, dt);
      }
      return commit(ctx, { dir, fire: false, hold: false, mode: "guard" }, dt);
    }

    function snapshot() {
      const weights = normalizeWeights(memory.weights);
      const values = Object.values(weights).filter(Number.isFinite);
      const level = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      return { name, mode: lastMode, level, weights };
    }

    return { name, decide, learn, memory, snapshot, get mode() { return lastMode; } };
  }

  window.TankPartnerAI = {
    createController,
    readMemory: () => loadMemory(),
    readExperience: () => loadExperience(),
    readExperienceDbStats,
    startMatch: startMatchExperience,
    recordExperience,
    finishMatch: finishMatchExperience,
    syncMemoryFile,
    syncMemoryFileNow,
    restoreMemoryFile,
    resetMemory,
    readTraining,
    addTrainingSeconds,
    incrementTrainingGames,
    flushTraining,
  };
  restoreMemoryFile();
})();
