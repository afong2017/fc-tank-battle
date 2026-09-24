const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRuns, liveReport } = require('../tools/best-runs.cjs');
const row = (session, n, stage, result = 'win', mode = 'NORMAL') => ({
  id: `${session}-${n * 1000}-${n}`, stage, result, started_at: n * 1000,
  ended_at: n * 1000 + 500, run_mode: mode, test_speed: mode === 'TEST' ? 4 : 1,
  counters_json: '{"ally_death":1,"enemy_killed":20}', build_version: 'v1',
});

test('best runs merge successive wins and never count a lost stage as cleared', () => {
  const result = buildRuns([row('a', 3, 3, 'lose'), row('a', 1, 1), row('a', 2, 2)]);
  assert.equal(result.normal.length, 1);
  assert.equal(result.normal[0].highestClearedStage, 2);
  assert.equal(result.normal[0].deaths, 3);
  assert.equal(result.normal[0].finished, true);
});

test('sessions, restarts, tests and incomplete old history remain distinct', () => {
  const rows = [row('a', 1, 1), row('b', 2, 1), row('a', 3, 2), row('a', 4, 1),
    row('test', 5, 1, 'win', 'TEST'), row('partial', 6, 20),
    { ...row('old', 7, 30), id: '7000-7' }];
  const result = buildRuns([...rows, rows[0]]);
  assert.equal(result.normal.length, 3);
  assert.equal(result.normal[0].highestClearedStage, 2);
  assert.equal(result.test.length, 1);
  assert.equal(result.incompleteHistory.length, 2);
});

test('leaderboard holds at most five independent runs and breaks on missing stages', () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(`s${i}`, i + 1, 1));
  rows.push(row('s0', 9, 3));
  const result = buildRuns(rows);
  assert.equal(result.normal.length, 5);
  assert.equal(result.incompleteHistory[0].startStage, 3);
});

test('live leaderboard reads newly completed stages instead of a saved snapshot', () => {
  const rows = [row('fresh', 1, 1), row('fresh', 2, 2), row('fresh', 3, 3, 'lose')];
  const db = { prepare() { return { all() { return rows; } }; } };
  const first = liveReport(db);
  assert.equal(first.normal[0].highestClearedStage, 2);
  assert.equal(first.normal[0].lastStage, 3);
  rows.push(row('next', 4, 1));
  assert.equal(liveReport(db).matchesExamined, 4);
});
