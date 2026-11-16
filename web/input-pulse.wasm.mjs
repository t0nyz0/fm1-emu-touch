// Real firmware regression for the compatibility tap gate. No browser, speaker,
// AudioContext, downloaded test fixture or host audio device is created here.
import assert from 'node:assert/strict';
import vm from 'node:vm';

export async function verifyInputPulse({ wasm, firmware, workletSource }) {
  const bytes = value => new Uint8Array(value).buffer;
  async function boot() {
    let Processor;
    const messages = [];
    const context = vm.createContext({ WebAssembly, Float32Array, Uint8Array, Uint16Array, Uint32Array,
      DataView, ArrayBuffer, performance, sampleRate: 44100,
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
      registerProcessor(_name, cls) { Processor = cls; } });
    vm.runInContext(workletSource, context);
    const p = new Processor();
    await p.port.onmessage({ data: { type: 'boot', seq: 1, mhz: 100,
      wasm: bytes(wasm), package: bytes(firmware), sectors: new ArrayBuffer(0) } });
    assert.ok(p.x, `pulse check boot failed: ${JSON.stringify(messages.at(-1))}`);
    const calls = [];
    const x = p.x;
    // Observe actual calls at the unchanged WASM boundary, without changing
    // firmware time, samples, key force or the AudioWorklet's render schedule.
    p.x = { ...x, fm1_key(id, down) { calls.push({ id, down, atMs: x.fm1_ms() }); return x.fm1_key(id, down); } };
    const out = [[new Float32Array(128), new Float32Array(128)]];
    function renderUntil(deadline, samples = null) {
      let sum = 0, peak = 0, frames = 0, calls = 0;
      while (p.x.fm1_ms() < deadline) {
        assert.ok(++calls <= 10000, 'pulse check emulated clock stalled');
        p.process([], out);
        assert.ok(p.x, `pulse check render failed: ${JSON.stringify(messages.at(-1))}`);
        for (const value of out[0][0]) {
          sum += value * value; peak = Math.max(peak, Math.abs(value)); frames++;
          if (samples) samples.push(value);
        }
      }
      return { rms: frames ? Math.sqrt(sum / frames) : 0, peak, frames };
    }
    renderUntil(p.x.fm1_ms() + 3000);
    const quiet = renderUntil(p.x.fm1_ms() + 500);
    const key = (down, minHoldMs) => p.port.onmessage({ data: { type: 'key', id: 21, down,
      ...(minHoldMs ? { minHoldMs } : {}) } });
    return { p, calls, quiet, key, renderUntil };
  }
  const results = [], waveforms = {};
  for (const name of ['immediate', 'guarded', 'reference-20ms', 'forced-cancel']) {
    const h = await boot();
    const start = h.p.x.fm1_ms(), samples = [];
    await h.key(true, name === 'guarded' || name === 'forced-cancel' ? 20 : 0);
    if (name === 'reference-20ms') h.renderUntil(start + 20, samples);
    await h.key(false);
    if (name === 'forced-cancel') await h.p.port.onmessage({ data: { type: 'flush-key-releases' } });
    h.renderUntil(start + 500, samples);
    let peak = 0;
    const all = samples.reduce((sum, value) => { peak = Math.max(peak, Math.abs(value)); return sum + value * value; }, 0);
    const result = { name, quiet: h.quiet.rms, rms: Math.sqrt(all / samples.length), peak,
      keyCalls: h.calls, pending: h.p.keyPulses.size };
    results.push(result); waveforms[name] = samples;
  }
  const byName = Object.fromEntries(results.map(row => [row.name, row]));
  assert.ok(byName.guarded.rms > 10 * byName.guarded.quiet + 0.001, 'guarded collapsed tap must sound in Felucca');
  assert.equal(byName.immediate.rms, 0, 'unmarked same-cycle input must retain existing behavior');
  assert.equal(byName['forced-cancel'].rms, 0, 'forced cleanup must cancel a pending short pulse');
  for (const row of results) {
    assert.equal(row.pending, 0, `${row.name}: note guard must not remain pending`);
    assert.equal(row.keyCalls.length, 2, `${row.name}: exactly one real down and one real up`);
    assert.deepEqual(row.keyCalls.map(call => [call.id, call.down]), [[21, 1], [21, 0]]);
  }
  const guarded = byName.guarded.keyCalls;
  assert.ok(guarded[1].atMs - guarded[0].atMs >= 20, 'guard must last twenty emulated milliseconds');
  const actual = waveforms.guarded, expected = waveforms['reference-20ms'];
  assert.equal(actual.length, expected.length, 'guarded and reference renders must have equal lengths');
  let maxSampleDifference = 0;
  for (let i = 0; i < actual.length; i++) maxSampleDifference = Math.max(maxSampleDifference, Math.abs(actual[i] - expected[i]));
  assert.equal(maxSampleDifference, 0, 'deferred collapsed tap must match every reference audio sample');
  return { note: 21, minHoldMs: 20, sampleRate: 44100,
    waveformMatchesReference: true, physicalInput: false, audioDeviceUsed: false, results };
}
