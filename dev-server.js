// @ts-check

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;

function loadLocalEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();
const PORT = Number(process.env.PORT) || 8080;
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
const AI_META = {
  developer: "CODEX",
  model: "GPT-5.5",
};
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const GAME_FILES = ["game.js", "index.html", "style.css", "hot-upgrade.js", "ai-worker.js", "gemini-coach.js"];
const AI_MEMORY_FILE = path.join(ROOT, "ai-memory.json");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = decoded === "/" ? "/index.html" : decoded;
  const target = path.normalize(path.join(ROOT, clean));
  return target.startsWith(ROOT) ? target : null;
}

function fileInfo(name) {
  const file = path.join(ROOT, name);
  const stat = fs.statSync(file);
  const content = fs.readFileSync(file);
  const updatedAtBeijing = stat.mtime.toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).replace(/\//g, "-");
  return {
    version: updatedAtBeijing.replace(/\D/g, ""),
    file: name,
    hash: crypto.createHash("sha1").update(content).digest("hex"),
    updatedAtBeijing: updatedAtBeijing + " CST",
  };
}

function bundleInfo(names) {
  const infos = names.map(fileInfo);
  const latest = infos.reduce((best, info) => info.version > best.version ? info : best, infos[0]);
  const hash = crypto.createHash("sha1");
  for (const info of infos) {
    hash.update(info.file);
    hash.update(info.hash);
  }
  return {
    ...latest,
    file: "game.js",
    files: infos.map((info) => info.file),
    hash: hash.digest("hex"),
  };
}

function versionPayload() {
  const ai = { ...fileInfo("ai.js"), ...AI_META };
  const game = bundleInfo(GAME_FILES);
  return JSON.stringify({ ai, game, pollSeconds: 5 });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readAiMemory() {
  if (!fs.existsSync(AI_MEMORY_FILE)) return { version: 1, memory: null, experience: null };
  return JSON.parse(fs.readFileSync(AI_MEMORY_FILE, "utf8").replace(/^\uFEFF/, ""));
}

function writeAiMemory(data) {
  let existing = {};
  try {
    existing = readAiMemory();
  } catch {}
  const payload = {
    ...existing,
    version: 1,
    updatedAt: new Date().toISOString(),
    ...data,
  };
  fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

const COACH_SCHEMA = {
  type: "object",
  properties: {
    p1Role: { type: "string", enum: ["intercept", "hunt", "survive"] },
    p2Role: { type: "string", enum: ["intercept", "hunt", "survive"] },
    focusLane: { type: "string", enum: ["left", "center", "right", "none"] },
    targetRule: { type: "string", enum: ["fastest-base", "nearest-base", "nearest-self"] },
    urgency: { type: "number", minimum: 0, maximum: 1 },
    ttlSeconds: { type: "number", minimum: 2, maximum: 8 },
    reason: { type: "string" },
  },
  required: ["p1Role", "p2Role", "focusLane", "targetRule", "urgency", "ttlSeconds", "reason"],
  additionalProperties: false,
};

function normalizeCoachAdvice(value = {}) {
  const role = (value) => ["intercept", "hunt", "survive"].includes(value) ? value : "intercept";
  const focusLane = ["left", "center", "right", "none"].includes(value.focusLane) ? value.focusLane : "center";
  const targetRule = ["fastest-base", "nearest-base", "nearest-self"].includes(value.targetRule) ? value.targetRule : "fastest-base";
  return {
    p1Role: role(value.p1Role),
    p2Role: role(value.p2Role),
    focusLane,
    targetRule,
    urgency: Math.max(0, Math.min(1, Number(value.urgency) || 0)),
    ttlSeconds: Math.max(2, Math.min(8, Number(value.ttlSeconds) || 4)),
    reason: String(value.reason || "").slice(0, 120),
  };
}

async function requestGeminiCoach(snapshot) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("GEMINI_API_KEY is not configured"), { statusCode: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: `You are the strategic coach for a Battle City style game. Analyze the compact battlefield snapshot. Give short-lived strategic hints only. Local AI handles movement, aiming, collision, and bullet safety. Split normal targets between P1 and P2, prioritize enemies likely to reach the base first, and never recommend waiting. Snapshot: ${JSON.stringify(snapshot)}`,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: COACH_SCHEMA,
        },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw Object.assign(new Error(`Gemini ${response.status}: ${detail}`), { statusCode: 502 });
    }
    const payload = await response.json();
    const interactionText = payload.steps
      ?.flatMap((step) => Array.isArray(step.content) ? step.content : [])
      .map((part) => part.text || "")
      .join("");
    const text = payload.output_text || interactionText || payload.outputs?.map((item) => item.text || item.content?.text || "").join("") || "";
    if (!text) throw Object.assign(new Error("Gemini returned no structured text"), { statusCode: 502 });
    return normalizeCoachAdvice(JSON.parse(text));
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = req.url.split("?")[0];
    if (req.url.startsWith("/version")) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(versionPayload());
      return;
    }

    if (req.url.startsWith("/ai-memory")) {
      if (req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(readAiMemory()));
        return;
      }
      if (req.method === "POST") {
        const data = await readJsonBody(req);
        if (pathname === "/ai-memory/training" && !data?.training) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "training is required" }));
          return;
        }
        const saved = writeAiMemory(data);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, updatedAt: saved.updatedAt }));
        return;
      }
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    if (pathname === "/gemini-coach/status") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ configured: Boolean(process.env.GEMINI_API_KEY), model: GEMINI_MODEL }));
      return;
    }

    if (pathname === "/gemini-coach") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method not allowed");
        return;
      }
      const snapshot = await readJsonBody(req);
      const advice = await requestGeminiCoach(snapshot);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, model: GEMINI_MODEL, advice }));
      return;
    }

    const target = safePath(req.url);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    res.writeHead(error.statusCode || 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error.stack || String(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`FC Tank Battle dev server: http://127.0.0.1:${PORT}`);
});
