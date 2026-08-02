// @ts-check

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AiDatabase } = require("./ai-database");

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
  model: "gpt-5.6-sol / medium",
};
const GAME_FILES = ["game.js", "index.html", "style.css", "hot-upgrade.js", "ai-worker.js"];
const AI_FILES = ["ai-core.js", "ai-data.js"];
const AI_MEMORY_FILE = path.join(ROOT, "ai-memory.json");
const AI_DATABASE_FILE = path.join(ROOT, "ai-memory.db");
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
  const ai = { ...bundleInfo(AI_FILES), file: "ai-data.js", ...AI_META };
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

const aiDatabase = new AiDatabase(AI_DATABASE_FILE, AI_MEMORY_FILE);

function sanitizeAiData(data) {
  if (!data?.experience) return data;
  const cleanCounters = (counters) => Object.fromEntries(Object.entries(counters || {}).filter(([key]) => !/gemini/i.test(key)));
  const cleanEvent = (event) => {
    const { coachRole, coachLane, coachRule, coachLatencyMs, ...clean } = event || {};
    return clean;
  };
  return {
    ...data,
    experience: {
      ...data.experience,
      events: Array.isArray(data.experience.events)
        ? data.experience.events.filter((event) => event?.type !== "gemini_advice").map(cleanEvent)
        : [],
      counters: cleanCounters(data.experience.counters),
      currentMatch: data.experience.currentMatch ? {
        ...data.experience.currentMatch,
        counters: cleanCounters(data.experience.currentMatch.counters),
      } : null,
    },
  };
}

function writeAiMemory(data) {
  data = sanitizeAiData(data);
  const existing = {
    memory: aiDatabase.getState("memory", {}),
    training: aiDatabase.getState("training", {}),
  };
  const trainingGeneration = Number(existing?.training?.generation) || 0;
  const incomingTrainingGeneration = Number(data?.training?.generation) || 0;
  if (trainingGeneration && data?.training && incomingTrainingGeneration !== trainingGeneration) {
    data = { ...data, training: existing.training };
  }
  const resetAt = Number(existing?.memory?.highestStageResetAt) || 0;
  const incomingStageAt = Number(data?.memory?.highestStageUpdatedAt) || 0;
  if (resetAt && data?.memory && incomingStageAt <= resetAt) {
    data = {
      ...data,
      memory: {
        ...data.memory,
        highestStageCleared: Math.max(0, Math.floor(Number(existing.memory.highestStageCleared) || 0)),
        highestStageResetAt: resetAt,
      },
    };
  }
  return aiDatabase.write(data);
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
        if (pathname === "/ai-memory/runtime") {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(aiDatabase.read(true)));
          return;
        }
        if (pathname === "/ai-memory/analytics") {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({
            updatedAt: aiDatabase.getMeta("updated_at"),
            analytics: aiDatabase.readAnalytics(),
            currentMatch: aiDatabase.getState("experience_meta", {})?.currentMatch || null,
          }));
          return;
        }
        if (pathname === "/ai-memory/compare") {
          const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
          const cutoff = Math.max(0, Number(requestUrl.searchParams.get("cutoff")) || 0);
          if (!cutoff) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "cutoff timestamp is required" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(aiDatabase.compare(cutoff)));
          return;
        }
        if (pathname === "/ai-memory/stats") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(aiDatabase.stats()));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(aiDatabase.read(false)));
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

module.exports = { server, aiDatabase };
