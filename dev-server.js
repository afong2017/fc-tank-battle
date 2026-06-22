// @ts-check

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const MAX_JSON_BODY_BYTES = 25 * 1024 * 1024;
const AI_META = {
  developer: "CODEX",
  model: "GPT-5.5",
};
const GAME_FILES = ["game.js", "index.html", "style.css", "hot-upgrade.js", "ai-worker.js"];
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
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...data,
  };
  fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

const server = http.createServer(async (req, res) => {
  try {
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
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error.stack || String(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`FC Tank Battle dev server: http://127.0.0.1:${PORT}`);
});
