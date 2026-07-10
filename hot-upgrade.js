// @ts-check

(function () {
  const DEFAULT_VERSION = {
    ai: {
      version: "20260710130402",
      file: "ai.js",
      developer: "CODEX",
      model: "GPT-5.5",
      updatedAtBeijing: "2026-07-10 13:04:02 CST",
    },
    game: { version: "20260710130402", file: "game.js" },
    pollSeconds: 5,
  };

  const state = {
    version: null,
    enabled: true,
    booted: false,
    booting: false,
    fallbackBooted: false,
    checking: false,
    pendingGame: null,
  };
  const VERSION_TIMEOUT_MS = 2500;

  function withVersion(file, version) {
    const mark = encodeURIComponent(version || Date.now());
    return `${file}${file.includes("?") ? "&" : "?"}v=${mark}`;
  }

  function setStatus(status) {
    window.FCGameHotAPI?.setHotUpgradeStatus?.(status);
  }

  function publishVersion(version = state.version) {
    if (version) window.FCHotUpgradeVersion = version;
  }

  function setAiVersionInfo(version = state.version) {
    window.FCGameHotAPI?.setAiVersionInfo?.(version?.ai || DEFAULT_VERSION.ai);
  }

  function setGameVersionInfo(version = state.version) {
    window.FCGameHotAPI?.setGameVersionInfo?.({
      developer: version?.ai?.developer || DEFAULT_VERSION.ai.developer,
      ...(version?.game || DEFAULT_VERSION.game),
    });
  }

  function renderVersion(version = state.version) {
    publishVersion(version);
    setAiVersionInfo(version);
    setGameVersionInfo(version);
  }

  function isServerMode() {
    return /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  }

  function loadScript(file, version, id) {
    return new Promise((resolve, reject) => {
      const old = document.getElementById(id);
      if (old && id.endsWith("-next")) old.remove();
      const script = document.createElement("script");
      script.id = id;
      script.src = withVersion(file, version);
      script.async = false;
      script.onload = () => resolve(script);
      script.onerror = () => reject(new Error(`Cannot load ${file}`));
      document.body.appendChild(script);
    });
  }

  async function readVersion() {
    if (!isServerMode()) return { ...DEFAULT_VERSION, offline: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);
    try {
      const response = await fetch(withVersion("/version", Date.now()), { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`version ${response.status}`);
      return { ...DEFAULT_VERSION, ...(await response.json()) };
    } finally {
      clearTimeout(timer);
    }
  }

  function sameVersion(a, b, key) {
    return String(a?.[key]?.hash || a?.[key]?.version || "") === String(b?.[key]?.hash || b?.[key]?.version || "");
  }

  async function applyAiUpgrade(next) {
    setStatus("AI FILE");
    await loadScript(next.ai.file || "ai.js", next.ai.version || next.ai.hash, "fc-hot-ai-next");
    window.FCGameHotAPI?.reloadAiControllers?.();
    state.version = {
      ...state.version,
      ai: next.ai,
      game: state.version?.game || DEFAULT_VERSION.game,
    };
    renderVersion(state.version);
    setStatus("AI UP");
  }

  function applyGameUpgrade(next) {
    state.pendingGame = next;
    renderVersion(next);
    setStatus(window.FCGameHotAPI?.canApplyGameUpgrade?.() === false ? "GAME WAIT" : "GAME NEW");
    window.FCGameHotAPI?.setPendingGameUpgrade?.(true);
    sessionStorage.setItem("fc-tank-battle.hot-upgrade", JSON.stringify({
      at: Date.now(),
      game: next.game?.version || next.game?.hash,
      ai: next.ai?.version || next.ai?.hash,
      pending: true,
    }));
  }

  async function checkNow() {
    if (state.checking || !state.booted) return;
    if (!state.enabled || window.FCGameHotAPI?.isHotUpgradeEnabled?.() === false) {
      setStatus("OFF");
      return;
    }
    state.checking = true;
    setStatus(isServerMode() ? "CHECK" : "LOCAL");
    try {
      const next = await readVersion();
      if (next.offline || !state.version) {
        renderVersion(next);
        setStatus("LOCAL");
        return;
      }
      renderVersion(next);
      if (state.pendingGame) {
        if (sameVersion(state.pendingGame, next, "game") && sameVersion(state.version, next, "game")) {
          state.pendingGame = null;
          window.FCGameHotAPI?.setPendingGameUpgrade?.(false);
        } else if (!sameVersion(state.version, next, "ai")) {
          await applyAiUpgrade(next);
        }
        renderVersion(state.pendingGame);
        setStatus(state.pendingGame ? (window.FCGameHotAPI?.canApplyGameUpgrade?.() === false ? "GAME WAIT" : "GAME NEW") : "READY");
        return;
      }
      if (!sameVersion(state.version, next, "game")) {
        applyGameUpgrade(next);
        return;
      }
      if (!sameVersion(state.version, next, "ai")) {
        await applyAiUpgrade(next);
        return;
      }
      state.version = next;
      setStatus("READY");
    } catch (error) {
      console.error(error);
      setStatus(isServerMode() ? "LOAD ERR" : "LOCAL");
    } finally {
      state.checking = false;
    }
  }

  async function boot() {
    if (state.booting || state.booted) return;
    state.booting = true;
    try {
      state.version = await readVersion();
      publishVersion(state.version);
      if (!window.TankPartnerAI) {
        await loadScript(state.version.ai.file || "ai.js", state.version.ai.version || state.version.ai.hash, "fc-hot-ai");
      }
      if (!window.FCGameHotAPI) {
        await loadScript(state.version.game.file || "game.js", state.version.game.version || state.version.game.hash, "fc-hot-game");
      }
      state.booted = true;
      renderVersion(state.version);
      setStatus(isServerMode() ? "READY" : "LOCAL");
    } finally {
      state.booting = false;
    }
  }

  async function bootFallback() {
    if (state.fallbackBooted || state.booted || window.FCGameHotAPI) return;
    state.fallbackBooted = true;
    state.version = { ...DEFAULT_VERSION, offline: true };
    publishVersion(state.version);
    await loadScript(DEFAULT_VERSION.ai.file, Date.now(), "fc-hot-ai");
    await loadScript(DEFAULT_VERSION.game.file, Date.now(), "fc-hot-game");
    state.booted = true;
    renderVersion(state.version);
    setStatus("LOCAL");
  }

  window.FCHotUpgrade = {
    checkNow,
    applyPendingGameUpgrade() {
      if (!state.pendingGame) return false;
      renderVersion(state.pendingGame);
      setStatus("GAME NEW");
      window.FCGameHotAPI?.setPendingGameUpgrade?.(true);
      return true;
    },
    setEnabled(value) {
      state.enabled = Boolean(value);
      window.FCGameHotAPI?.setHotUpgradeEnabled?.(state.enabled);
      setStatus(state.enabled ? (isServerMode() ? "READY" : "LOCAL") : "OFF");
    },
    current: () => ({ ...state.version }),
  };

  window.addEventListener("focus", () => {
    checkNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkNow();
  });

  boot().catch((error) => {
    console.error(error);
    setStatus(isServerMode() ? "LOAD ERR" : "LOCAL");
    bootFallback().catch((fallbackError) => {
      console.error(fallbackError);
      setStatus("LOAD ERR");
    });
  }).finally(() => {
    setInterval(checkNow, Math.max(3, Number(state.version?.pollSeconds) || 5) * 1000);
  });
})();
