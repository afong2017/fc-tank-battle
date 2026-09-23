// @ts-check

(function () {
  const previous = window.TankPartnerAI;
  const MEMORY_KEY = "fc-tank-battle.partner-ai";
  const LEGACY_MEMORY_KEY = "fc-tank-battle.partner-ai.v2";
  const EXPERIENCE_KEY = "fc-tank-battle.ai-experience.v1";
  const FILE_URL = "/ai-memory";
  const EVENT_LIMIT = 2400;
  const MATCH_LIMIT = 512;
  const CORE_DATA_VERSION = 5;
  const POLICY_SAMPLE_SIZE = 20;
  const POLICY_TUNING_VERSION = 2;
  const POLICY_CONTEXT_LIMIT = 48;
  const POLICY_DEFAULTS = Object.freeze({ defend: 6.5, survive: 5, attack: 7, clear: 4 });
  const AUTONOMY_VERSION = 1;
  const AUTONOMY_STATE_LIMIT = 1024;
  const AUTONOMY_REPLAY_LIMIT = 1600;
  const AUTONOMY_TRACE_LIMIT = 48;
  const AUTONOMY_ACTION_LIMIT = 8;
  const AUTONOMY_MIN_CHAMPION_VISITS = 4;
  const AUTONOMY_GAMMA = 0.86;
  const AUTONOMY_ALPHA = 0.18;
  const ANALYTICS_VERSION = 3;
  const ANALYTICS_BUILD_LIMIT = 32;
  const TRACKED_MODE_EVENTS = new Set(["ally_death", "base_hit", "enemy_killed", "enemy_cross_midline"]);
  const MEMORY_SYNC_DELAY = 12000;
  const MEMORY_SYNC_RETRY_DELAY = 3000;
  const MATCH_HEARTBEAT_INTERVAL = 10000;
  const SYNC_EVENT_BATCH_SIZE = 120;
  const SYNC_MATCH_BATCH_SIZE = 24;
  const defaults = {
    weights: { defend: 5, survive: 5, attack: 5, clear: 5 },
    bestWeights: { defend: 5, survive: 5, attack: 5, clear: 5 },
    policy: { ...POLICY_DEFAULTS },
    policyByContext: {},
    policyTuning: {},
    lastPolicyDecision: null,
    highestStageCleared: 0,
    highestStageUpdatedAt: 0,
    highestStageResetAt: 0,
    games: 0,
    failures: {},
    patches: [],
    lastFailures: [],
    evolution: null,
    autonomy: null,
    lastScore: 0,
  };
  const WEIGHT_LIMITS = {
    defend: [0, 10],
    survive: [0, 10],
    attack: [0, 10],
    clear: [0, 10],
  };
  const handoff = previous?.createHandoff?.() || null;
  const sessionId = String(handoff?.sessionId || previous?.sessionId
    || globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const legacyInFlight = previous && !handoff
    ? Promise.resolve(previous.syncMemoryFileNow?.()).catch((error) => console.warn("Legacy AI memory sync failed", error))
    : Promise.resolve();
  let disposed = false;
  let syncTimer = null;
  let retryTimer = null;
  let syncRequest = null;
  let syncDirty = Boolean(handoff);
  let pendingEvents = Array.isArray(handoff?.pendingEvents) ? handoff.pendingEvents.slice() : [];
  let pendingMatches = Array.isArray(handoff?.pendingMatches) ? handoff.pendingMatches.slice() : [];
  let memory = normalizeMemory(handoff?.memory || previous?.readMemory?.() || readLocal(MEMORY_KEY) || readLocal(LEGACY_MEMORY_KEY) || defaults);
  let experience = normalizeExperience(handoff?.experience || previous?.readExperience?.() || readLocal(EXPERIENCE_KEY) || {});
  let training = normalizeTraining(handoff?.training || previous?.readTraining?.() || {});
  let autonomyRuntime = normalizeAutonomyRuntime(/** @type {any} */ (handoff)?.autonomyRuntime);
  let ownsCurrentMatch = Boolean(experience.currentMatch && (handoff?.ownsCurrentMatch || previous));
  let interruptionSentFor = null;
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
      const numeric = Number(value[key]);
      result[key] = Math.max(minimum, Math.min(maximum, Number.isFinite(numeric) ? numeric : fallback));
    }
    return result;
  }

  function normalizePolicy(value = {}) {
    const result = {};
    for (const key of ["defend", "survive", "attack", "clear"]) {
      const numeric = Number(value?.[key]);
      result[key] = Math.max(0, Math.min(10, Number.isFinite(numeric) ? numeric : POLICY_DEFAULTS[key]));
    }
    return result;
  }

  function normalizePolicySamples(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-POLICY_SAMPLE_SIZE).map((sample) => ({
      metric: Number(sample?.metric) || 0,
      scores: normalizeWeights(sample?.scores),
      win: sample?.win ? 1 : 0,
      baseHit: Math.max(0, Number(sample?.baseHit) || 0),
      deaths: Math.max(0, Number(sample?.deaths) || 0),
      stuck: Math.max(0, Number(sample?.stuck) || 0),
      kills: Math.max(0, Number(sample?.kills) || 0),
      crossings: Math.max(0, Number(sample?.crossings) || 0),
      duration: Math.max(0, Number(sample?.duration) || 0),
    }));
  }

  function normalizePolicyMaps(policyByContext = {}, policyTuning = {}) {
    const policyEntries = Object.entries(policyByContext || {}).slice(-POLICY_CONTEXT_LIMIT);
    const tuningEntries = Object.entries(policyTuning || {}).slice(-POLICY_CONTEXT_LIMIT);
    return {
      policies: Object.fromEntries(policyEntries.map(([key, policy]) => [String(key).slice(0, 32), normalizePolicy(policy)])),
      tuning: Object.fromEntries(tuningEntries.map(([key, state]) => {
        const compatible = Number(state?.version) === POLICY_TUNING_VERSION;
        return [String(key).slice(0, 32), {
          version: POLICY_TUNING_VERSION,
          phase: compatible && state?.phase === "evaluate" ? "evaluate" : "baseline",
          championPolicy: normalizePolicy(state?.championPolicy),
          candidatePolicy: compatible && state?.candidatePolicy ? normalizePolicy(state.candidatePolicy) : null,
          baselineMetric: compatible && Number.isFinite(Number(state?.baselineMetric)) ? Number(state.baselineMetric) : null,
          baselineSamples: compatible ? normalizePolicySamples(state?.baselineSamples) : [],
          candidateSamples: compatible ? normalizePolicySamples(state?.candidateSamples) : [],
          updatedAt: Math.max(0, Number(state?.updatedAt) || 0),
        }];
      })),
    };
  }

  function normalizeAutonomyAction(value = {}) {
    return {
      q: Math.max(-240, Math.min(240, Number(value?.q) || 0)),
      visits: Math.max(0, Math.floor(Number(value?.visits) || 0)),
      reward: Math.max(-240, Math.min(240, Number(value?.reward) || 0)),
      successes: Math.max(0, Math.floor(Number(value?.successes) || 0)),
      failures: Math.max(0, Math.floor(Number(value?.failures) || 0)),
      updatedAt: Math.max(0, Number(value?.updatedAt) || 0),
    };
  }

  function normalizeAutonomy(value = {}) {
    const states = {};
    const entries = Object.entries(value?.states || {})
      .sort((a, b) => (Number(a[1]?.updatedAt) || 0) - (Number(b[1]?.updatedAt) || 0))
      .slice(-AUTONOMY_STATE_LIMIT);
    for (const [rawStateKey, rawState] of entries) {
      const stateKey = String(rawStateKey).slice(0, 180);
      const actionEntries = Object.entries(rawState?.actions || {}).slice(-AUTONOMY_ACTION_LIMIT);
      states[stateKey] = {
        visits: Math.max(0, Math.floor(Number(rawState?.visits) || 0)),
        champion: rawState?.champion ? String(rawState.champion).slice(0, 64) : null,
        actions: Object.fromEntries(actionEntries.map(([key, action]) => [
          String(key).slice(0, 64),
          normalizeAutonomyAction(action),
        ])),
        updatedAt: Math.max(0, Number(rawState?.updatedAt) || 0),
      };
    }
    const replay = Array.isArray(value?.replay) ? value.replay.slice(-AUTONOMY_REPLAY_LIMIT).map((sample) => ({
      state: String(sample?.state || "").slice(0, 180),
      action: String(sample?.action || "").slice(0, 64),
      reward: Math.max(-240, Math.min(240, Number(sample?.reward) || 0)),
      nextState: sample?.nextState ? String(sample.nextState).slice(0, 180) : null,
      terminal: Boolean(sample?.terminal),
      priority: Math.max(0, Math.min(480, Number(sample?.priority) || 0)),
      stage: Math.max(1, Math.floor(Number(sample?.stage) || 1)),
      updatedAt: Math.max(0, Number(sample?.updatedAt) || 0),
    })).filter((sample) => sample.state && sample.action) : [];
    return {
      version: AUTONOMY_VERSION,
      generation: Math.max(0, Math.floor(Number(value?.generation) || 0)),
      decisions: Math.max(0, Math.floor(Number(value?.decisions) || 0)),
      updates: Math.max(0, Math.floor(Number(value?.updates) || 0)),
      replayUpdates: Math.max(0, Math.floor(Number(value?.replayUpdates) || 0)),
      promotions: Math.max(0, Math.floor(Number(value?.promotions) || 0)),
      rollbacks: Math.max(0, Math.floor(Number(value?.rollbacks) || 0)),
      states,
      replay,
      lastDecision: value?.lastDecision && typeof value.lastDecision === "object"
        ? { ...value.lastDecision }
        : null,
    };
  }

  function normalizeAutonomyRuntime(value = {}) {
    const pending = value?.pending && typeof value.pending === "object" ? value.pending : {};
    const traces = value?.traces && typeof value.traces === "object" ? value.traces : {};
    return {
      pending: { ...pending },
      traces: Object.fromEntries(Object.entries(traces).map(([player, trace]) => [
        player,
        Array.isArray(trace) ? trace.slice(-AUTONOMY_TRACE_LIMIT) : [],
      ])),
    };
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
    const hasPerformanceData = Number(value.coreDataVersion) >= 2;
    const policyMaps = normalizePolicyMaps(value.policyByContext, value.policyTuning);
    return {
      ...defaults,
      coreDataVersion: CORE_DATA_VERSION,
      // D/S/A/C are observed performance scores only. They never directly steer combat.
      weights: normalizeWeights(hasPerformanceData ? value.weights : defaults.weights),
      bestWeights: normalizeWeights(hasPerformanceData ? (value.bestWeights || value.weights) : defaults.bestWeights),
      policy: normalizePolicy(value.policy),
      policyByContext: policyMaps.policies,
      policyTuning: policyMaps.tuning,
      lastPolicyDecision: value.lastPolicyDecision && typeof value.lastPolicyDecision === "object"
        ? { ...value.lastPolicyDecision }
        : null,
      highestStageCleared: Math.max(0, Math.floor(Number(value.highestStageCleared) || 0)),
      highestStageUpdatedAt: Math.max(0, Number(value.highestStageUpdatedAt) || 0),
      highestStageResetAt: Math.max(0, Number(value.highestStageResetAt) || 0),
      games: Math.max(0, Math.floor(Number(value.games) || 0)),
      failures: cleanCounters(value.failures),
      patches: [],
      lastFailures: [],
      evolution: normalizeEvolution(value.evolution),
      autonomy: normalizeAutonomy(value.autonomy),
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
      sessionId,
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

  function applyCanonicalGames(value) {
    const games = Math.max(0, Math.floor(Number(value) || 0));
    if (!games && (training.games || experience.games || memory.games)) return;
    training.games = games;
    experience.games = games;
    memory.games = games;
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
    syncDirty = true;
    if (!serverMode() || syncTimer || syncRequest) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      postDelta();
    }, MEMORY_SYNC_DELAY);
  }

  function postDelta() {
    if (!serverMode()) return Promise.resolve();
    if (syncRequest) {
      syncDirty = true;
      return syncRequest;
    }
    // Accelerated shadow runs can produce more than the browser's 64 KiB
    // keepalive limit. Send bounded ordinary requests and drain the queue.
    const events = pendingEvents.slice(0, SYNC_EVENT_BATCH_SIZE);
    const matches = pendingMatches.slice(0, SYNC_MATCH_BATCH_SIZE);
    syncDirty = false;
    syncRequest = fetch(FILE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(deltaPayload(events, matches)),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`AI memory sync ${response.status}`);
      const saved = typeof response.json === "function" ? await response.json() : {};
      applyCanonicalGames(saved.canonicalGames);
      const sentEvents = new Set(events);
      const sentMatches = new Set(matches);
      pendingEvents = pendingEvents.filter((item) => !sentEvents.has(item));
      pendingMatches = pendingMatches.filter((item) => !sentMatches.has(item));
    }).catch((error) => {
      syncDirty = true;
      console.warn("AI memory sync failed", error);
    }).finally(() => { syncRequest = null; });
    syncRequest.finally(() => {
      if (!disposed && (syncDirty || pendingEvents.length || pendingMatches.length)) {
        scheduleSyncRetry(syncDirty ? MEMORY_SYNC_RETRY_DELAY : 0);
      }
    });
    return syncRequest;
  }

  function scheduleSyncRetry(delay = MEMORY_SYNC_RETRY_DELAY) {
    if (!serverMode() || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      postDelta();
    }, delay);
  }

  function syncMemoryFileNow() {
    saveLocal();
    syncDirty = true;
    if (!serverMode()) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    return postDelta();
  }

  async function restoreMemoryFile() {
    if (!serverMode()) return;
    try {
      const response = await fetch(`${FILE_URL}/runtime?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      memory = normalizeMemory(data.memory || memory);
      training = normalizeTraining(data.training || training);
      // A match may start while the restore request is in flight. Never replace
      // that live match with an older server snapshot.
      if (!ownsCurrentMatch && !pendingEvents.length && !pendingMatches.length) {
        experience = normalizeExperience(data.experience || experience);
      }
      // Legacy servers expose TRAIN GAMES as the completed-match counter;
      // experience.games used to count starts and can be much larger.
      applyCanonicalGames(data.canonicalGames ?? data.training?.games ?? data.experience?.games);
      localStorage.removeItem(MEMORY_KEY);
      localStorage.removeItem(EXPERIENCE_KEY);
    } catch (error) {
      console.warn("AI memory restore failed", error);
    }
  }

  function startMatch(meta = {}) {
    autonomyRuntime = normalizeAutonomyRuntime({});
    experience.currentMatch = {
      id: `${sessionId}-${Date.now()}-${experience.games + 1}`,
      sessionId,
      stage: Number(meta.stage) || 1,
      startedAt: Date.now(),
      events: 0,
      counters: {},
      modeCounters: {},
      build: currentBuild(),
      run: normalizeRunContext(meta.run),
    };
    ownsCurrentMatch = true;
    interruptionSentFor = null;
    syncMemoryFile();
  }

  function interruptMatch(meta = {}) {
    const match = experience.currentMatch;
    if (!match?.id || interruptionSentFor === match.id) return false;
    interruptionSentFor = match.id;
    const interruptedAt = Date.now();
    const payload = JSON.stringify({
      sessionId,
      stage: Math.max(1, Number(meta.stage) || Number(match.stage) || 1),
      duration: Math.max(0, Number(meta.duration) || 0),
      interruptedAt,
      match: {
        ...match,
        sessionId,
        run: normalizeRunContext(meta.run || match.run),
        counters: cleanCounters(match.counters),
        modeCounters: cleanModeCounters(match.modeCounters),
        lastActiveAt: interruptedAt,
      },
    });
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const sent = navigator.sendBeacon(`${FILE_URL}/interrupt`, new Blob([payload], { type: "application/json" }));
        if (sent) return true;
      }
      fetch(`${FILE_URL}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function recordExperience(type, detail = {}) {
    if (!type) return;
    const match = experience.currentMatch || {
      id: `${sessionId}-${Date.now()}-${experience.games}`, sessionId, stage: detail.stage || 1,
      events: 0, counters: {}, modeCounters: {}, build: currentBuild(), run: normalizeRunContext(detail.run),
    };
    match.events++;
    match.counters[type] = (match.counters[type] || 0) + 1;
    experience.counters[type] = (experience.counters[type] || 0) + 1;
    rewardAutonomyEvent(type, detail);
    if (type === "enemy_killed" && detail.crossWater) {
      match.counters.cross_water_kill = (match.counters.cross_water_kill || 0) + 1;
      experience.counters.cross_water_kill = (experience.counters.cross_water_kill || 0) + 1;
    }
    const mode = isCurrentMode(detail.mode) ? detail.mode : null;
    if (mode && TRACKED_MODE_EVENTS.has(type)) {
      match.modeCounters ||= {};
      match.modeCounters[type] ||= {};
      match.modeCounters[type][mode] = (match.modeCounters[type][mode] || 0) + 1;
    }
    experience.currentMatch = match;
    ownsCurrentMatch = true;
    const event = {
      matchId: match.id,
      run: normalizeRunContext(match.run),
      stage: detail.stage ?? match.stage,
      time: Math.round((Number(detail.time) || 0) * 10) / 10,
      type,
      player: detail.player || null,
      tank: compact(detail.tank),
      ally: compact(detail.ally),
      enemy: compact(detail.enemy),
      target: compact(detail.target),
      mode,
      reason: detail.reason || null,
      distance: Number.isFinite(detail.distance) ? Math.round(detail.distance) : null,
      bulletDir: detail.bulletDir || null,
      baseSource: detail.baseSource || null,
      crossWater: Boolean(detail.crossWater),
      waterTiles: Math.max(0, Math.floor(Number(detail.waterTiles) || 0)),
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

  function policyContextKey(stage = 1, run = runtimeRunContext()) {
    const context = normalizeRunContext(run);
    const runKey = context.mode === "TEST" ? `TEST-${context.speed}X` : "NORMAL";
    return `S${Math.max(1, Math.floor(Number(stage) || 1))}:${runKey}`;
  }

  function readPolicy(stage = 1, run = runtimeRunContext()) {
    const key = policyContextKey(stage, run);
    return normalizePolicy(memory.policyByContext?.[key] || memory.policy);
  }

  function averagePolicySamples(samples) {
    if (!samples.length) return {
      metric: 0,
      scores: normalizeWeights({}),
      winRate: 0,
      baseHitRate: 0,
      deaths: 0,
      stuck: 0,
      kills: 0,
      crossings: 0,
      duration: 0,
    };
    const totals = { defend: 0, survive: 0, attack: 0, clear: 0 };
    let metric = 0;
    const outcomes = { win: 0, baseHit: 0, deaths: 0, stuck: 0, kills: 0, crossings: 0, duration: 0 };
    for (const sample of samples) {
      metric += Number(sample.metric) || 0;
      for (const key of Object.keys(totals)) totals[key] += Number(sample.scores?.[key]) || 0;
      for (const key of Object.keys(outcomes)) outcomes[key] += Number(sample[key]) || 0;
    }
    return {
      metric: metric / samples.length,
      scores: Object.fromEntries(Object.keys(totals).map((key) => [key, totals[key] / samples.length])),
      winRate: outcomes.win / samples.length,
      baseHitRate: outcomes.baseHit / samples.length,
      deaths: outcomes.deaths / samples.length,
      stuck: outcomes.stuck / samples.length,
      kills: outcomes.kills / samples.length,
      crossings: outcomes.crossings / samples.length,
      duration: outcomes.duration / samples.length,
    };
  }

  function policySample(match, scores, result, duration) {
    const counters = match?.counters || {};
    const count = (key) => Math.max(0, Number(counters[key]) || 0);
    const metric = (result.win ? 60 : 0)
      + scores.defend * 4
      + scores.survive * 2
      + scores.attack * 1.5
      + scores.clear
      - Math.min(300, Math.max(0, duration)) * 0.03;
    return {
      metric: Math.round(metric * 100) / 100,
      scores,
      win: result.win ? 1 : 0,
      baseHit: count("base_hit") > 0 ? 1 : 0,
      deaths: count("ally_death"),
      stuck: count("ally_stuck") + count("route_clear_failed") + count("target_stale")
        + count("ai_route_loop") * 0.5,
      kills: count("enemy_killed"),
      crossings: count("enemy_cross_midline"),
      duration: Math.max(0, Number(duration) || 0),
    };
  }

  function evolvedPolicy(activePolicy, baseline) {
    const lossRate = 1 - baseline.winRate;
    const deltas = {
      defend: baseline.baseHitRate > 0
        ? Math.min(0.42, 0.12 + baseline.baseHitRate * 0.42 + Math.max(0, baseline.crossings - 5) * 0.012)
        : -0.06,
      survive: baseline.deaths > 1.5
        ? Math.min(0.3, 0.06 + (baseline.deaths - 1.5) * 0.06)
        : -0.04,
      attack: lossRate > 0.25 || baseline.kills < 14
        ? Math.min(0.32, 0.08 + lossRate * 0.16 + Math.max(0, 14 - baseline.kills) * 0.012)
        : -0.04,
      clear: baseline.stuck > 0
        ? Math.min(0.36, 0.08 + baseline.stuck * 0.08)
        : -0.05,
    };
    return normalizePolicy(Object.fromEntries(Object.keys(POLICY_DEFAULTS).map((name) => [
      name,
      activePolicy[name] + deltas[name],
    ])));
  }

  function policyCandidateAccepted(baseline, candidate) {
    const baseSafe = candidate.baseHitRate <= baseline.baseHitRate + 0.049;
    const mobilitySafe = candidate.stuck <= baseline.stuck + 0.15;
    const survivalSafe = candidate.deaths <= baseline.deaths + 0.35;
    const resultSafe = candidate.winRate + 0.051 >= baseline.winRate;
    const useful = candidate.metric >= baseline.metric - 0.25
      && (candidate.metric > baseline.metric + 0.2
        || candidate.winRate > baseline.winRate
        || candidate.baseHitRate < baseline.baseHitRate);
    return { accepted: baseSafe && mobilitySafe && survivalSafe && resultSafe && useful,
      safeguards: { baseSafe, mobilitySafe, survivalSafe, resultSafe, useful } };
  }

  function prunePolicyContexts() {
    for (const collection of [memory.policyByContext, memory.policyTuning]) {
      const keys = Object.keys(collection || {});
      while (keys.length > POLICY_CONTEXT_LIMIT) delete collection[keys.shift()];
    }
  }

  function tunePolicy(match, result, scores, stage, duration) {
    if (!match || !scores) return;
    const key = policyContextKey(stage, result.run || match.run);
    const activePolicy = readPolicy(stage, result.run || match.run);
    const state = memory.policyTuning[key] || {
      version: POLICY_TUNING_VERSION,
      phase: "baseline",
      championPolicy: activePolicy,
      candidatePolicy: null,
      baselineMetric: null,
      baselineSamples: [],
      candidateSamples: [],
      updatedAt: 0,
    };
    state.version = POLICY_TUNING_VERSION;
    const sample = policySample(match, scores, result, duration);

    if (state.phase === "evaluate" && state.candidatePolicy) {
      state.candidateSamples = normalizePolicySamples([...state.candidateSamples, sample]);
      if (state.candidateSamples.length >= POLICY_SAMPLE_SIZE) {
        const candidate = averagePolicySamples(state.candidateSamples);
        const baselineMetric = Number(state.baselineMetric) || 0;
        const verdict = policyCandidateAccepted({
          ...averagePolicySamples(state.baselineSamples),
          metric: baselineMetric,
        }, candidate);
        const accepted = verdict.accepted;
        const chosen = accepted ? state.candidatePolicy : state.championPolicy;
        memory.policyByContext[key] = normalizePolicy(chosen);
        memory.lastPolicyDecision = {
          context: key,
          status: accepted ? "ACCEPTED" : "ROLLED_BACK",
          baselineMetric: Math.round(baselineMetric * 100) / 100,
          candidateMetric: Math.round(candidate.metric * 100) / 100,
          safeguards: verdict.safeguards,
          samples: POLICY_SAMPLE_SIZE,
          updatedAt: Date.now(),
        };
        state.phase = "baseline";
        state.championPolicy = normalizePolicy(chosen);
        state.candidatePolicy = null;
        state.baselineMetric = null;
        state.baselineSamples = [];
        state.candidateSamples = [];
      }
    } else {
      state.phase = "baseline";
      state.championPolicy = activePolicy;
      state.baselineSamples = normalizePolicySamples([...state.baselineSamples, sample]);
      if (state.baselineSamples.length >= POLICY_SAMPLE_SIZE) {
        const baseline = averagePolicySamples(state.baselineSamples);
        const candidate = evolvedPolicy(activePolicy, baseline);
        state.phase = "evaluate";
        state.baselineMetric = baseline.metric;
        state.championPolicy = activePolicy;
        state.candidatePolicy = candidate;
        state.candidateSamples = [];
        memory.policyByContext[key] = candidate;
        memory.lastPolicyDecision = {
          context: key,
          status: "EVALUATING",
          baselineMetric: Math.round(baseline.metric * 100) / 100,
          samples: POLICY_SAMPLE_SIZE,
          updatedAt: Date.now(),
        };
      }
    }
    state.updatedAt = Date.now();
    memory.policyTuning[key] = state;
    prunePolicyContexts();
  }

  function autonomyState(stateKey, create = true) {
    const key = String(stateKey || "").slice(0, 180);
    if (!key) return null;
    let state = memory.autonomy.states[key];
    if (!state && create) {
      state = { visits: 0, champion: null, actions: {}, updatedAt: Date.now() };
      memory.autonomy.states[key] = state;
    }
    return state || null;
  }

  function autonomyAction(state, actionKey, create = true) {
    if (!state) return null;
    const key = String(actionKey || "").slice(0, 64);
    if (!key) return null;
    let action = state.actions[key];
    if (!action && create) {
      action = normalizeAutonomyAction({ updatedAt: Date.now() });
      state.actions[key] = action;
      const actionKeys = Object.keys(state.actions);
      if (actionKeys.length > AUTONOMY_ACTION_LIMIT) {
        const removable = actionKeys
          .filter((candidate) => candidate !== state.champion && candidate !== key)
          .sort((a, b) => state.actions[a].visits - state.actions[b].visits
            || state.actions[a].updatedAt - state.actions[b].updatedAt)[0];
        if (removable) delete state.actions[removable];
      }
    }
    return action || null;
  }

  function autonomyConservativeScore(action) {
    if (!action?.visits) return -Infinity;
    return action.q - 18 / Math.sqrt(action.visits);
  }

  function refreshAutonomyChampion(stateKey, state) {
    if (!state) return;
    const eligible = Object.entries(state.actions)
      .filter(([, action]) => action.visits >= AUTONOMY_MIN_CHAMPION_VISITS)
      .sort((a, b) => autonomyConservativeScore(b[1]) - autonomyConservativeScore(a[1]));
    if (!eligible.length) return;
    const [challengerKey, challenger] = eligible[0];
    const currentKey = state.champion;
    const current = currentKey ? state.actions[currentKey] : null;
    if (current && currentKey !== challengerKey
      && autonomyConservativeScore(challenger) < autonomyConservativeScore(current) + 3) return;
    if (currentKey === challengerKey) return;
    state.champion = challengerKey;
    memory.autonomy.generation++;
    const rolledBack = Boolean(current && current.q < 0 && challenger.q >= current.q);
    if (rolledBack) memory.autonomy.rollbacks++;
    else memory.autonomy.promotions++;
    memory.autonomy.lastDecision = {
      status: rolledBack ? "ROLLED_BACK" : "PROMOTED",
      state: stateKey,
      previous: currentKey || null,
      champion: challengerKey,
      score: Math.round(challenger.q * 100) / 100,
      visits: challenger.visits,
      updatedAt: Date.now(),
    };
  }

  function maxAutonomyQ(stateKey) {
    const state = autonomyState(stateKey, false);
    if (!state) return 0;
    const values = Object.values(state.actions).filter((action) => action.visits > 0).map((action) => action.q);
    return values.length ? Math.max(...values) : 0;
  }

  function trainAutonomyValue(stateKey, actionKey, target, rate = AUTONOMY_ALPHA) {
    const state = autonomyState(stateKey);
    const action = autonomyAction(state, actionKey);
    if (!state || !action) return 0;
    const boundedTarget = Math.max(-240, Math.min(240, Number(target) || 0));
    const error = boundedTarget - action.q;
    const adaptiveRate = Math.max(0.025, Math.min(rate, rate / Math.sqrt(Math.max(1, action.visits) / 5)));
    action.q = Math.max(-240, Math.min(240, action.q + error * adaptiveRate));
    action.reward = action.reward * 0.9 + boundedTarget * 0.1;
    if (boundedTarget > 8) action.successes++;
    else if (boundedTarget < -8) action.failures++;
    action.updatedAt = Date.now();
    state.updatedAt = action.updatedAt;
    memory.autonomy.updates++;
    refreshAutonomyChampion(stateKey, state);
    return Math.abs(error);
  }

  function addAutonomyReplay(sample) {
    if (!sample?.state || !sample?.action) return;
    memory.autonomy.replay.push({
      state: String(sample.state).slice(0, 180),
      action: String(sample.action).slice(0, 64),
      reward: Math.max(-240, Math.min(240, Number(sample.reward) || 0)),
      nextState: sample.nextState ? String(sample.nextState).slice(0, 180) : null,
      terminal: Boolean(sample.terminal),
      priority: Math.max(0.01, Math.min(480, Number(sample.priority) || 0.01)),
      stage: Math.max(1, Math.floor(Number(sample.stage) || 1)),
      updatedAt: Date.now(),
    });
    if (memory.autonomy.replay.length > AUTONOMY_REPLAY_LIMIT) {
      memory.autonomy.replay.splice(0, memory.autonomy.replay.length - AUTONOMY_REPLAY_LIMIT);
    }
  }

  function closeAutonomyTransition(previous, nextState = null, terminal = false) {
    if (!previous?.state || !previous?.action) return;
    const target = (Number(previous.reward) || 0)
      + (terminal || !nextState ? 0 : AUTONOMY_GAMMA * maxAutonomyQ(nextState));
    const priority = trainAutonomyValue(previous.state, previous.action, target);
    addAutonomyReplay({
      ...previous,
      reward: Number(previous.reward) || 0,
      nextState,
      terminal,
      priority,
    });
  }

  function evaluateAutonomyActions(stateKey, actionKeys = [], meta = {}) {
    const state = autonomyState(stateKey);
    const unique = [...new Set(actionKeys.map((key) => String(key || "").slice(0, 64)).filter(Boolean))];
    const biases = {};
    for (const key of unique) {
      const action = autonomyAction(state, key);
      const confidence = action?.visits ? 1 - Math.exp(-action.visits / 9) : 0;
      const championBonus = state?.champion === key ? 10 * confidence : 0;
      biases[key] = Math.max(-28, Math.min(28, (action?.q || 0) * 0.18 * confidence + championBonus));
    }
    const run = normalizeRunContext(experience.currentMatch?.run || runtimeRunContext());
    const visits = Math.max(0, Number(state?.visits) || 0);
    const baseExploration = run.mode === "TEST" ? 0.14 : 0.055;
    const explorationRate = Math.max(run.mode === "TEST" ? 0.035 : 0.012, baseExploration / Math.sqrt(1 + visits / 12));
    const canExplore = meta?.safeToExplore !== false && !meta?.urgent && unique.length > 1;
    const explore = canExplore && (meta?.forceExplore || Math.random() < explorationRate);
    let exploreKey = null;
    if (explore) {
      exploreKey = unique
        .filter((key) => key !== state?.champion)
        .sort((a, b) => (state?.actions[a]?.visits || 0) - (state?.actions[b]?.visits || 0)
          || (state?.actions[b]?.q || 0) - (state?.actions[a]?.q || 0))[0] || null;
      if (exploreKey) biases[exploreKey] = Math.min(28, (biases[exploreKey] || 0) + 18);
    }
    return {
      biases,
      champion: state?.champion || null,
      exploreKey,
      explorationRate,
      generation: memory.autonomy.generation,
    };
  }

  function observeAutonomyDecision(sample = {}) {
    const player = sample.player === "2P" ? "2P" : "1P";
    const stateKey = String(sample.stateKey || "").slice(0, 180);
    const actionKey = String(sample.actionKey || "").slice(0, 64);
    if (!stateKey || !actionKey) return null;
    const at = Math.max(0, Number(sample.time) || 0);
    const previous = autonomyRuntime.pending[player];
    if (previous && previous.state === stateKey && previous.action === actionKey && at - previous.time < 0.55) {
      return evaluateAutonomyActions(stateKey, [actionKey], { safeToExplore: false });
    }
    if (previous) closeAutonomyTransition(previous, stateKey, false);
    const state = autonomyState(stateKey);
    const action = autonomyAction(state, actionKey);
    state.visits++;
    state.updatedAt = Date.now();
    action.visits++;
    action.updatedAt = state.updatedAt;
    const transition = {
      player,
      state: stateKey,
      action: actionKey,
      reward: 0,
      time: at,
      stage: Math.max(1, Math.floor(Number(sample.stage) || 1)),
      explored: Boolean(sample.explored),
    };
    autonomyRuntime.pending[player] = transition;
    const trace = autonomyRuntime.traces[player] || [];
    trace.push({ state: stateKey, action: actionKey, time: at, stage: transition.stage });
    autonomyRuntime.traces[player] = trace.slice(-AUTONOMY_TRACE_LIMIT);
    memory.autonomy.decisions++;
    refreshAutonomyChampion(stateKey, state);
    return { generation: memory.autonomy.generation, q: action.q, visits: action.visits, champion: state.champion };
  }

  function autonomyPlayer(detail = {}) {
    if (detail.player === "1P" || detail.player === "2P") return detail.player;
    const kind = detail.tank?.kind || detail.ally?.kind;
    if (kind === "player2") return "2P";
    if (kind === "player") return "1P";
    return null;
  }

  function rewardAutonomyTrace(player, reward, terminal = false) {
    const pending = autonomyRuntime.pending[player];
    if (pending) pending.reward = Math.max(-240, Math.min(240, (Number(pending.reward) || 0) + reward));
    const trace = autonomyRuntime.traces[player] || [];
    const depth = terminal ? trace.length : Math.min(10, trace.length);
    const decay = terminal ? 0.94 : 0.72;
    for (let offset = 0; offset < depth; offset++) {
      const item = trace[trace.length - 1 - offset];
      const credit = reward * Math.pow(decay, offset);
      const state = autonomyState(item.state, false);
      const action = state?.actions?.[item.action];
      if (!action) continue;
      trainAutonomyValue(item.state, item.action, action.q + credit, terminal ? 0.08 : 0.1);
    }
  }

  function rewardAutonomyEvent(type, detail = {}) {
    const rewards = {
      enemy_killed: 34,
      freeze_collected: 20,
      base_shield_counter: 26,
      ally_death: -72,
      ally_stuck: -26,
      ai_route_loop: -22,
      defense_route_stall: -28,
      route_clear_failed: -22,
      target_stale: -16,
      enemy_cross_midline: -6,
      base_hit: -220,
    };
    const reward = Number(rewards[type]);
    if (!Number.isFinite(reward)) return;
    const owner = autonomyPlayer(detail);
    const global = type === "base_hit" || type === "enemy_cross_midline";
    if (global || !owner) {
      rewardAutonomyTrace("1P", reward);
      rewardAutonomyTrace("2P", reward);
    } else {
      rewardAutonomyTrace(owner, reward);
      if (type === "enemy_killed" || type === "base_shield_counter") {
        rewardAutonomyTrace(owner === "1P" ? "2P" : "1P", reward * 0.15);
      }
    }
  }

  function runAutonomyReplay(limit = 96) {
    const samples = memory.autonomy.replay.slice()
      .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, Math.floor(limit)));
    for (const sample of samples) {
      const target = sample.reward + (sample.terminal || !sample.nextState
        ? 0
        : AUTONOMY_GAMMA * maxAutonomyQ(sample.nextState));
      const priority = trainAutonomyValue(sample.state, sample.action, target, 0.07);
      sample.priority = priority * 0.92;
      memory.autonomy.replayUpdates++;
    }
  }

  function pruneAutonomyStates() {
    const entries = Object.entries(memory.autonomy.states);
    if (entries.length <= AUTONOMY_STATE_LIMIT) return;
    entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of entries.slice(0, entries.length - AUTONOMY_STATE_LIMIT)) delete memory.autonomy.states[key];
  }

  function finishAutonomyEpisode(result = {}) {
    const stage = Math.max(1, Math.floor(Number(result.stage) || 1));
    const reward = result.win ? 110 + Math.min(70, stage * 4) : -180;
    for (const player of ["1P", "2P"]) {
      rewardAutonomyTrace(player, reward, true);
      const pending = autonomyRuntime.pending[player];
      if (pending) closeAutonomyTransition(pending, null, true);
    }
    runAutonomyReplay(result.win ? 72 : 112);
    pruneAutonomyStates();
    autonomyRuntime = normalizeAutonomyRuntime({});
  }

  function updatePerformanceData(match, result) {
    if (!match) return null;
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
        - count("target_stale") * 0.6 - count("ai_route_loop") * 0.7),
    };
    const previous = normalizeWeights(memory.weights);
    const smoothing = 0.1;
    memory.weights = normalizeWeights(Object.fromEntries(Object.keys(scores).map((key) => [
      key,
      previous[key] * (1 - smoothing) + scores[key] * smoothing,
    ])));
    return scores;
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
    const scores = updatePerformanceData(match, result);
    tunePolicy(match, result, scores, stage, duration);
    finishAutonomyEpisode({ ...result, stage });
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
        const previousHighest = Math.max(0, Math.floor(Number(memory.highestStageCleared) || 0));
        if (stage > previousHighest) {
          memory.highestStageCleared = stage;
          memory.highestStageUpdatedAt = match.endedAt;
        }
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
      applyCanonicalGames(training.games + 1);
    }
    experience.currentMatch = null;
    ownsCurrentMatch = false;
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
    autonomyRuntime = normalizeAutonomyRuntime({});
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
    if (retryTimer) clearTimeout(retryTimer);
    syncTimer = null;
    retryTimer = null;
    clearInterval(heartbeatTimer);
  }

  function createHandoff() {
    return {
      memory,
      experience,
      training,
      autonomyRuntime,
      pendingEvents: pendingEvents.slice(),
      pendingMatches: pendingMatches.slice(),
      ownsCurrentMatch,
      sessionId,
      inFlight: syncRequest,
    };
  }

  const heartbeatTimer = setInterval(() => {
    if (!ownsCurrentMatch || !experience.currentMatch || disposed) return;
    experience.currentMatch.lastActiveAt = Date.now();
    syncMemoryFileNow();
  }, MATCH_HEARTBEAT_INTERVAL);

  const services = {
    createController() { throw new Error("AI CORE controller is not loaded"); },
    readMemory: () => memory,
    readPolicy,
    readAutonomy: () => memory.autonomy,
    evaluateAutonomyActions,
    observeAutonomyDecision,
    readExperience: () => experience,
    readExperienceDbStats,
    startMatch,
    recordExperience,
    finishMatch,
    interruptMatch,
    syncMemoryFile,
    syncMemoryFileNow,
    restoreMemoryFile,
    resetMemory,
    readTraining: () => training,
    addTrainingSeconds(seconds = 0) { training.seconds += Math.max(0, Number(seconds) || 0); },
    // Legacy game.js calls this before finishMatch. Completion is counted once
    // inside finishMatch and then authoritatively reconciled by SQLite.
    incrementTrainingGames() {},
    flushTraining,
    get sessionId() { return sessionId; },
    createHandoff,
    dispose,
    ready: previous
      ? Promise.resolve(handoff?.inFlight)
        .catch((error) => console.warn("Previous AI memory sync failed", error))
        .then(() => legacyInFlight)
        .then(() => syncMemoryFileNow())
        .catch((error) => console.warn("AI memory handoff failed", error))
      : restoreMemoryFile(),
  };
  window.TankPartnerAI = window.TankPartnerAIEngine?.enhance?.(services) || services;
})();
