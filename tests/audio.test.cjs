const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAudio(muted = false) {
  const voices = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect(other) { return other; }, disconnect() { this.disconnected = true; } });
  const context = {
    currentTime: 0, state: "running", destination: {},
    createBiquadFilter: () => ({ ...node(), frequency: param(), Q: param() }),
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createGain: () => ({ ...node(), gain: param() }),
    createOscillator() {
      const osc = { ...node(), frequency: param(), start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } };
      voices.push(osc);
      return osc;
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
  const sandbox = { audio: context, INTERNAL_TEST_MUTED: muted, window: {}, Map, Math };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("let soundOutput ="), source.indexOf("function rects("))
    + "\nnewAudio(); globalThis.sounds = sfx; globalThis.playTone = tone;", sandbox);
  return { context, voices, sandbox };
}

test("dense gunfire is rate limited and completed voices are disconnected", () => {
  const { context, voices, sandbox } = loadAudio();
  for (let i = 0; i < 100; i++) sandbox.sounds.fire();
  assert.equal(voices.length, 1);
  context.currentTime = 0.07;
  sandbox.sounds.fire();
  assert.equal(voices.length, 2);
  voices[0].onended();
  assert.equal(voices[0].disconnected, true);
  for (let i = 0; i < 100; i++) sandbox.playTone(440, 0.1);
  assert.equal(voices.length, 17);
});

test("pickup melody uses audio-clock scheduling and internal tests remain silent", () => {
  const { voices, sandbox } = loadAudio();
  sandbox.sounds.power();
  assert.deepEqual(voices.map((v) => v.startTime), [0, 0.085, 0.17, 0.255]);
  assert.ok(voices.every((v) => v.stopTime > v.startTime));
  const muted = loadAudio(true);
  for (const sound of Object.values(muted.sandbox.sounds)) sound();
  assert.equal(muted.voices.length, 0);
});
