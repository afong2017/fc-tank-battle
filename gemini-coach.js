// @ts-check

(function () {
  const REQUEST_INTERVAL_MS = 7000;
  const RETRY_INTERVAL_MS = 30000;
  const REQUEST_TIMEOUT_MS = 11000;
  let advice = null;
  let status = "CHECK";
  let model = "";
  let busy = false;
  let nextRequestAt = 0;

  function statusLabel() {
    return `${status}${model ? ` ${model.replace(/^gemini-/i, "")}` : ""}`;
  }

  function renderStatus() {
    const element = document.getElementById("geminiStatus");
    if (element) element.textContent = `GEMINI ${statusLabel()}`;
  }

  function current() {
    if (!advice || advice.expiresAt <= Date.now()) return null;
    return advice;
  }

  async function checkConfiguration() {
    if (!/^https?:$/.test(location.protocol)) {
      status = "OFF";
      return;
    }
    try {
      const response = await fetch("/gemini-coach/status", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json();
      model = result.model || model;
      status = result.configured ? "READY" : "OFF";
    } catch {
      status = "ERR";
    } finally {
      renderStatus();
    }
  }

  async function tick(snapshot) {
    if (!/^https?:$/.test(location.protocol) || busy || Date.now() < nextRequestAt) return;
    busy = true;
    const requestedAt = Date.now();
    status = "THINK";
    renderStatus();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/gemini-coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json();
      const ttl = Math.max(2, Math.min(8, Number(result.advice?.ttlSeconds) || 4));
      const receivedAt = Date.now();
      advice = {
        ...result.advice,
        model: result.model || "Gemini",
        requestedAt,
        receivedAt,
        latencyMs: receivedAt - requestedAt,
        expiresAt: receivedAt + ttl * 1000,
      };
      model = result.model || model;
      status = "LIVE";
      renderStatus();
      nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    } catch (error) {
      status = String(error?.message || error) === "503" ? "OFF" : "ERR";
      renderStatus();
      nextRequestAt = Date.now() + RETRY_INTERVAL_MS;
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  }

  window.FCGeminiCoach = {
    tick,
    current,
    statusLabel,
  };

  checkConfiguration();
})();
