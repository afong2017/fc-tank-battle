const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function decision(firstEta, deadline, missed = 0) {
  const source = fs.readFileSync(path.join(__dirname, '../ai-core.js'), 'utf8');
  const start = source.indexOf('    const useJointCoverage =');
  const end = source.indexOf('    const previousMissed =', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}; useJointCoverage`, {
    criticalCoverage: [{ responseDeadline: deadline }, { responseDeadline: 3 }],
    jointCoverage: { owners: [1, 0], score: [missed] },
    greedyMissed: 1,
    greedyOwners: [0, 1],
    coverageMatrix: [[{ eta: 1 }, { eta: 2 }], [{ eta: firstEta }, { eta: 8 }]],
  });
}

test('runtime accepts both on-time defenders even if the primary response is slower', {
  todo: 'Gate relaxation regresses real-physics defense; see DEFENSE-COVERAGE-VALIDATION.md.',
}, () => {
  assert.equal(decision(2, 3), true);
});

test('runtime does not sacrifice an on-time primary threat to rescue another', () => {
  assert.equal(decision(4, 3), false);
  assert.equal(decision(2.5, 3), false, 'keep reserve for a full reversal');
});

test('runtime preserves assignments when joint coverage saves no deadline', () => {
  assert.equal(decision(2, 3, 1), false);
});
