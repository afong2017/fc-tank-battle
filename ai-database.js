// @ts-check

const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 1;
const EVENT_LIMIT = 200000;
const MATCH_LIMIT = 20000;
const RUNTIME_EVENT_LIMIT = 2400;
const RUNTIME_MATCH_LIMIT = 512;

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parse(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(String(value)); } catch { return fallback; }
}

function eventId(event) {
  return crypto.createHash("sha1").update(json(event, {})).digest("hex");
}

function enemyKind(event) {
  if (event?.enemy?.kind) return String(event.enemy.kind);
  const match = String(event?.baseSource || "").match(/^enemy:(.+)$/);
  return match ? match[1] : "unknown";
}

function emptyBucket() {
  return { games: 0, wins: 0, losses: 0, durationTotal: 0, counters: {}, stages: {}, modeCounters: {}, baseHitByEnemy: {} };
}

function addCount(target, key, value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  if (count) target[key] = (target[key] || 0) + count;
}

class AiDatabase {
  constructor(file, legacyFile) {
    this.file = file;
    this.legacyFile = legacyFile;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.createSchema();
    this.migrateLegacy();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        stage INTEGER NOT NULL,
        result TEXT NOT NULL,
        duration REAL NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        counters_json TEXT NOT NULL,
        mode_counters_json TEXT NOT NULL,
        build_id TEXT NOT NULL,
        build_version TEXT NOT NULL,
        build_developer TEXT NOT NULL,
        build_model TEXT NOT NULL,
        build_updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        stage INTEGER NOT NULL,
        type TEXT NOT NULL,
        mode TEXT,
        enemy_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_matches_ended ON matches(ended_at);
      CREATE INDEX IF NOT EXISTS idx_matches_build ON matches(build_version, ended_at);
      CREATE INDEX IF NOT EXISTS idx_matches_stage_result ON matches(stage, result);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id);
      CREATE INDEX IF NOT EXISTS idx_events_type_kind ON events(type, enemy_kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_type_mode ON events(type, mode, created_at);
    `);
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  setState(key, value, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO state(key, value_json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(key, json(value), now);
  }

  getState(key, fallback = null) {
    return parse(this.db.prepare("SELECT value_json FROM state WHERE key = ?").get(key)?.value_json, fallback);
  }

  migrateLegacy() {
    if (this.getMeta("legacy_imported") || !fs.existsSync(this.legacyFile)) return;
    const data = parse(fs.readFileSync(this.legacyFile, "utf8").replace(/^\uFEFF/, ""), null);
    if (data) this.write(data);
    this.setMeta("legacy_imported", new Date().toISOString());
  }

  insertMatch(match) {
    if (!match?.id) return;
    const build = match.build || {};
    this.db.prepare(`
      INSERT INTO matches(
        id, stage, result, duration, started_at, ended_at, event_count, counters_json, mode_counters_json,
        build_id, build_version, build_developer, build_model, build_updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        stage=excluded.stage, result=excluded.result, duration=excluded.duration, started_at=excluded.started_at,
        ended_at=excluded.ended_at, event_count=excluded.event_count, counters_json=excluded.counters_json,
        mode_counters_json=excluded.mode_counters_json, build_id=excluded.build_id,
        build_version=excluded.build_version, build_developer=excluded.build_developer,
        build_model=excluded.build_model, build_updated_at=excluded.build_updated_at
    `).run(
      String(match.id), Math.max(1, Number(match.stage) || 1), String(match.result || "lose"),
      Math.max(0, Number(match.duration) || 0), Math.max(0, Number(match.startedAt) || 0),
      Math.max(0, Number(match.endedAt) || 0), Math.max(0, Number(match.events) || 0),
      json(match.counters, {}), json(match.modeCounters, {}), String(build.id || "LEGACY"),
      String(build.version || "LEGACY"), String(build.developer || "UNKNOWN"),
      String(build.model || "UNKNOWN"), String(build.updatedAtBeijing || "UNKNOWN"),
    );
  }

  insertEvent(event) {
    if (!event?.matchId || !event?.type) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO events(id, match_id, stage, type, mode, enemy_kind, created_at, data_json)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId(event), String(event.matchId), Math.max(1, Number(event.stage) || 1), String(event.type),
      event.mode ? String(event.mode) : null, enemyKind(event), Math.max(0, Number(event.createdAt) || Date.now()), json(event, {}),
    );
  }

  write(data) {
    const now = Date.now();
    const experience = data?.experience || null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (data?.memory !== undefined) this.setState("memory", data.memory, now);
      if (data?.training !== undefined) this.setState("training", data.training, now);
      if (experience) {
        this.setState("experience_meta", {
          version: Math.max(3, Number(experience.version) || 3),
          games: Math.max(0, Number(experience.games) || 0),
          counters: experience.counters || {},
          currentMatch: experience.currentMatch || null,
        }, now);
        for (const match of Array.isArray(experience.matches) ? experience.matches : []) this.insertMatch(match);
        for (const event of Array.isArray(experience.events) ? experience.events : []) this.insertEvent(event);
      }
      this.setMeta("updated_at", new Date(now).toISOString());
      this.prune();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { updatedAt: this.getMeta("updated_at") };
  }

  prune() {
    this.db.prepare(`DELETE FROM events WHERE id IN (
      SELECT id FROM events ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`).run(EVENT_LIMIT);
    this.db.prepare(`DELETE FROM matches WHERE id IN (
      SELECT id FROM matches ORDER BY ended_at DESC LIMIT -1 OFFSET ?
    )`).run(MATCH_LIMIT);
  }

  rowToMatch(row) {
    return {
      id: row.id,
      stage: row.stage,
      result: row.result,
      duration: row.duration,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      events: row.event_count,
      counters: parse(row.counters_json, {}),
      modeCounters: parse(row.mode_counters_json, {}),
      build: {
        id: row.build_id,
        version: row.build_version,
        developer: row.build_developer,
        model: row.build_model,
        updatedAtBeijing: row.build_updated_at,
      },
    };
  }

  read(runtime = false) {
    const meta = this.getState("experience_meta", { version: 3, games: 0, counters: {}, currentMatch: null });
    const matches = runtime ? [] : this.db.prepare("SELECT * FROM matches ORDER BY ended_at DESC LIMIT ?").all(RUNTIME_MATCH_LIMIT).reverse().map((row) => this.rowToMatch(row));
    const events = runtime ? [] : this.db.prepare("SELECT data_json FROM events ORDER BY created_at DESC LIMIT ?").all(RUNTIME_EVENT_LIMIT).reverse().map((row) => parse(row.data_json, {}));
    return {
      version: 2,
      updatedAt: this.getMeta("updated_at"),
      memory: this.getState("memory", null),
      training: this.getState("training", null),
      experience: {
        ...meta,
        events,
        matches,
        analytics: this.readAnalytics(),
      },
    };
  }

  populateBucket(bucket, matchRows, eventRows) {
    for (const row of matchRows) {
      const win = row.result === "win";
      bucket.games++;
      bucket[win ? "wins" : "losses"]++;
      bucket.durationTotal = Math.round((bucket.durationTotal + Number(row.duration || 0)) * 10) / 10;
      const counters = parse(row.counters_json, {});
      for (const [key, value] of Object.entries(counters)) addCount(bucket.counters, key, value);
      const stageKey = String(row.stage);
      const stage = bucket.stages[stageKey] || { games: 0, wins: 0, losses: 0, durationTotal: 0 };
      stage.games++;
      stage[win ? "wins" : "losses"]++;
      stage.durationTotal = Math.round((stage.durationTotal + Number(row.duration || 0)) * 10) / 10;
      bucket.stages[stageKey] = stage;
    }
    for (const row of eventRows) {
      if (row.type === "base_hit") addCount(bucket.baseHitByEnemy, row.enemy_kind || "unknown", 1);
      if (row.mode && ["ally_death", "base_hit", "enemy_killed", "enemy_cross_midline"].includes(row.type)) {
        bucket.modeCounters[row.type] ||= {};
        addCount(bucket.modeCounters[row.type], row.mode, 1);
      }
    }
    return bucket;
  }

  readAnalytics() {
    const total = emptyBucket();
    const builds = new Map();
    const buildRows = this.db.prepare(`
      SELECT build_id, MIN(build_version) build_version, MIN(build_developer) build_developer,
        MIN(build_model) build_model, MIN(build_updated_at) build_updated_at,
        MIN(started_at) first_started_at, MAX(ended_at) last_ended_at,
        COUNT(*) games, SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN result='win' THEN 0 ELSE 1 END) losses, SUM(duration) duration_total
      FROM matches GROUP BY build_id ORDER BY first_started_at
    `).all();
    for (const row of buildRows) {
      const bucket = {
        id: row.build_id,
        version: row.build_version,
        developer: row.build_developer,
        model: row.build_model,
        updatedAtBeijing: row.build_updated_at,
        firstStartedAt: row.first_started_at,
        lastEndedAt: row.last_ended_at,
        ...emptyBucket(),
      };
      bucket.games = Number(row.games) || 0;
      bucket.wins = Number(row.wins) || 0;
      bucket.losses = Number(row.losses) || 0;
      bucket.durationTotal = Math.round((Number(row.duration_total) || 0) * 10) / 10;
      total.games += bucket.games;
      total.wins += bucket.wins;
      total.losses += bucket.losses;
      total.durationTotal = Math.round((total.durationTotal + bucket.durationTotal) * 10) / 10;
      builds.set(row.build_id, bucket);
    }
    const stageRows = this.db.prepare(`
      SELECT build_id, stage, COUNT(*) games,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN result='win' THEN 0 ELSE 1 END) losses, SUM(duration) duration_total
      FROM matches GROUP BY build_id, stage
    `).all();
    for (const row of stageRows) {
      const stage = {
        games: Number(row.games) || 0,
        wins: Number(row.wins) || 0,
        losses: Number(row.losses) || 0,
        durationTotal: Math.round((Number(row.duration_total) || 0) * 10) / 10,
      };
      const key = String(row.stage);
      builds.get(row.build_id).stages[key] = stage;
      const combined = total.stages[key] || { games: 0, wins: 0, losses: 0, durationTotal: 0 };
      combined.games += stage.games;
      combined.wins += stage.wins;
      combined.losses += stage.losses;
      combined.durationTotal = Math.round((combined.durationTotal + stage.durationTotal) * 10) / 10;
      total.stages[key] = combined;
    }
    const counterRows = this.db.prepare(`
      SELECT m.build_id build_id, j.key counter_key, SUM(CAST(j.value AS INTEGER)) count
      FROM matches m, json_each(m.counters_json) j GROUP BY m.build_id, j.key
    `).all();
    for (const row of counterRows) {
      addCount(builds.get(row.build_id).counters, row.counter_key, row.count);
      addCount(total.counters, row.counter_key, row.count);
    }
    const eventRows = this.db.prepare(`
      SELECT m.build_id build_id, e.type type, e.mode mode, e.enemy_kind enemy_kind, COUNT(*) count
      FROM events e JOIN matches m ON m.id=e.match_id
      WHERE e.type IN ('ally_death','base_hit','enemy_killed','enemy_cross_midline')
      GROUP BY m.build_id, e.type, e.mode, e.enemy_kind
    `).all();
    for (const row of eventRows) {
      const bucket = builds.get(row.build_id);
      const type = String(row.type);
      const mode = row.mode ? String(row.mode) : null;
      if (row.type === "base_hit") {
        addCount(bucket.baseHitByEnemy, String(row.enemy_kind || "unknown"), row.count);
        addCount(total.baseHitByEnemy, String(row.enemy_kind || "unknown"), row.count);
      }
      if (mode) {
        bucket.modeCounters[type] ||= {};
        total.modeCounters[type] ||= {};
        addCount(bucket.modeCounters[type], mode, row.count);
        addCount(total.modeCounters[type], mode, row.count);
      }
    }
    return { version: 2, generatedAt: Date.now(), total, builds: Array.from(builds.values()).slice(-32) };
  }

  compare(cutoff) {
    const afterRows = this.db.prepare("SELECT * FROM matches WHERE ended_at >= ? ORDER BY ended_at").all(cutoff);
    const count = Math.min(afterRows.length, 500);
    const after = afterRows.slice(0, count);
    const before = this.db.prepare("SELECT * FROM matches WHERE ended_at < ? ORDER BY ended_at DESC LIMIT ?").all(cutoff, count).reverse();
    const summarize = (rows) => {
      if (!rows.length) return emptyBucket();
      const ids = new Set(rows.map((row) => row.id));
      const start = Math.min(...rows.map((row) => row.started_at));
      const end = Math.max(...rows.map((row) => row.ended_at));
      const events = this.db.prepare("SELECT match_id, type, mode, enemy_kind FROM events WHERE created_at BETWEEN ? AND ?").all(start, end)
        .filter((event) => ids.has(event.match_id));
      return this.populateBucket(emptyBucket(), rows, events);
    };
    return { cutoff, sampleGames: count, before: summarize(before), after: summarize(after) };
  }

  stats() {
    const files = [this.file, `${this.file}-wal`, `${this.file}-shm`];
    return {
      available: true,
      engine: "sqlite",
      schemaVersion: SCHEMA_VERSION,
      events: Number(this.db.prepare("SELECT COUNT(*) count FROM events").get().count),
      matches: Number(this.db.prepare("SELECT COUNT(*) count FROM matches").get().count),
      eventLimit: EVENT_LIMIT,
      matchLimit: MATCH_LIMIT,
      fileBytes: files.reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0),
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { AiDatabase };
