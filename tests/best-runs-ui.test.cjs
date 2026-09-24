const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');

function setup(fetch) {
  class Element {
    constructor(id) { this.id = id; this.events = {}; this.children = []; this.attrs = {}; this.open = false; }
    addEventListener(name, cb) { this.events[name] = cb; }
    setAttribute(name, value) { this.attrs[name] = value; }
    replaceChildren() { this.children = []; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.close?.(); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
    createElement: tag => new Element(tag),
  };
  const window = new Element('window');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../best-runs-ui.js'), 'utf8'),
    { document, window, fetch, AbortController, setTimeout, clearTimeout, Intl, Date, console });
  return { get: id => document.getElementById(id), window };
}

test('best runs modal loads live records, changes tabs and restores opener focus', async () => {
  const row = { highestClearedStage: 20, lastStage: 21, achievedAt: 1785780731414, kills: 533, deaths: 84,
    finished: true, buildVersions: ['UNVERSIONED'] };
  let requested;
  const ui = setup(async url => { requested = url; return { ok: true, json: async () => ({ recordedAt: '2026-09-24T00:00:00Z',
    normal: Array(6).fill(row), test: [] }) }; });
  await ui.get('bestRunsOpen').events.click();
  assert.equal(requested, 'records/best-five-runs.json');
  assert.equal(ui.get('bestRunsDialog').open, true);
  assert.equal(ui.get('bestRunsResults').children[0].children.length, 5);
  assert.match(ui.get('bestRunsStatus').textContent, /实时记录/);
  const first = ui.get('bestRunsResults').children[0].children[0];
  assert.match(first.children[0].textContent, /通关 20 关/);
  assert.match(first.children[2].textContent, /第 21 关止步/);
  ui.get('bestRunsTest').events.click();
  assert.match(ui.get('bestRunsResults').textContent, /暂无/);
  assert.equal(ui.get('bestRunsTest').attrs['aria-selected'], 'true');
  let blocked = false;
  ui.window.events.keydown({ stopImmediatePropagation() { blocked = true; } });
  assert.equal(blocked, true);
  ui.get('bestRunsClose').events.click();
  assert.equal(ui.get('bestRunsOpen').focused, true);
  assert.equal(ui.get('bestRunsDialog').open, false);
});

test('best runs modal shows fetch failure and ignores a closed dialog response', async () => {
  const ui = setup(async () => ({ ok: false }));
  await ui.get('bestRunsOpen').events.click();
  assert.match(ui.get('bestRunsStatus').textContent, /读取失败/);
  let release;
  const pending = setup(() => new Promise(resolve => { release = resolve; }));
  const loading = pending.get('bestRunsOpen').events.click();
  pending.get('bestRunsClose').events.click();
  release({ ok: true, json: async () => ({ normal: [], test: [] }) });
  await loading;
  assert.equal(pending.get('bestRunsResults').children.length, 0);
});
