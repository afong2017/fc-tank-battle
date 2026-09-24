const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function buildRuns(rows) {
  const sessions = new Map();
  const runs = [];
  const seen = new Set();
  for (const row of [...rows].sort((a, b) => a.started_at - b.started_at || a.ended_at - b.ended_at || a.id.localeCompare(b.id))) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (!['win', 'lose'].includes(row.result)) continue;
    const match = String(row.id).match(/^(.+)-\d+-\d+$/);
    const session = match?.[1] || `unverified:${row.id}`;
    const mode = row.run_mode === 'TEST' || Number(row.test_speed) > 1 ? 'TEST' : 'NORMAL';
    const key = `${session}:${mode}:${Number(row.test_speed) || 1}`;
    let run = sessions.get(key);
    const follows = run && !run.finished && row.stage === run.lastStage + 1
      && row.started_at >= run.lastEndedAt;
    if (!follows) {
      run = { id: row.id, session, mode, speed: Number(row.test_speed) || 1,
        startStage: row.stage, highestClearedStage: 0, clearedStages: 0,
        deaths: 0, kills: 0, startedAt: row.started_at, lastEndedAt: row.ended_at,
        lastStage: row.stage, finished: false, sessionVerified: Boolean(match),
        buildVersions: [], matchIds: [] };
      sessions.set(key, run);
      runs.push(run);
    }
    let counts = {};
    try { counts = JSON.parse(row.counters_json || '{}'); } catch {}
    run.deaths += Math.max(0, Number(counts.ally_death) || 0);
    run.kills += Math.max(0, Number(counts.enemy_killed) || 0);
    run.lastStage = row.stage;
    run.lastEndedAt = row.ended_at;
    run.matchIds.push(row.id);
    if (!run.buildVersions.includes(row.build_version)) run.buildVersions.push(row.build_version);
    if (row.result === 'win') {
      run.highestClearedStage = Math.max(run.highestClearedStage, row.stage);
      run.clearedStages++;
      run.achievedAt = row.ended_at;
    } else run.finished = true;
  }
  const ranked = runs.filter(run => run.clearedStages > 0).sort((a, b) =>
    b.highestClearedStage - a.highestClearedStage
    || b.clearedStages - a.clearedStages || b.achievedAt - a.achievedAt
    || a.id.localeCompare(b.id));
  return {
    normal: ranked.filter(r => r.mode === 'NORMAL' && r.sessionVerified && r.startStage === 1).slice(0, 5),
    test: ranked.filter(r => r.mode === 'TEST' && r.sessionVerified && r.startStage === 1).slice(0, 5),
    incompleteHistory: ranked.filter(r => !r.sessionVerified || r.startStage !== 1).slice(0, 5),
  };
}

function liveReport(db) {
  const rows = db.prepare(`SELECT id, stage, result, started_at, ended_at, counters_json,
    build_version, run_mode, test_speed FROM matches ORDER BY started_at, ended_at, id`).all();
  return { recordedAt: new Date().toISOString(), source: 'ai-memory.db',
    matchesExamined: rows.length, ...buildRuns(rows) };
}

function snapshot(root) {
  const db = new DatabaseSync(path.join(root, 'ai-memory.db'), { readOnly: true });
  let report;
  try { report = liveReport(db); } finally { db.close(); }
  const output = path.join(root, 'records');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'best-five-runs.json'), JSON.stringify(report, null, 2) + '\n');
  const time = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
  const lines = ['# 最佳五次闯关记录', '', `记录时间（北京时间）：${time(Date.now())}`, '',
    '按最高已通关关卡、连续通关数、达成时间倒序排列。同一次连续闯关只占一条。',
    '只认胜利关卡；到达后失败的关卡不计入通关。正常游戏与测试分开。',
    '本文件是历史快照；运行 `node tools/best-runs.cjs` 可重新生成。', '',
    '阵亡和击毁数包含这次闯关最后失败一关；未结束的记录仅统计已完成关卡。', ''];
  for (const [key, title] of [['normal', '正常游戏：从第一关连续闯关'],
    ['test', '测试模式：从第一关连续闯关'], ['incompleteHistory', '会话缺失或中途开始：单列参考，不计入正式榜']]) {
    lines.push(`## ${title}`, '', '| 排名 | 最高通关 | 连续通关数 | 起始关 | 阵亡 | 击毁 | 达成时间（北京时间） |',
      '| --- | --- | --- | --- | --- | --- | --- |');
    report[key].forEach((r, i) => lines.push(`| ${i + 1} | ${r.highestClearedStage} | ${r.clearedStages} | ${r.startStage} | ${r.deaths} | ${r.kills} | ${time(r.achievedAt)} |`));
    lines.push('');
  }
  fs.writeFileSync(path.join(output, 'best-five-runs.md'), lines.join('\n'));
  return report;
}

if (require.main === module) {
  const result = snapshot(path.resolve(__dirname, '..'));
  console.log(JSON.stringify(result, null, 2));
}
module.exports = { buildRuns, liveReport, snapshot };
