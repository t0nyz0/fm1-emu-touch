// Page lifecycle regression tests with deterministic DOM, storage and audio boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as persistence from './persistence.js';
import * as tryout from './tryout.js';
import * as gestureInput from './gesture-input.js';
import * as captureInput from './input-capture.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(text = '', value = '') {
    this.text = this.textContent = text; this.value = String(value); this.options = []; this.listeners = {};
    this.dataset = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {}, toggle() {} };
    this.parentElement = this; this.tagName = 'DIV'; this.captures = new Set();
  }
  add(e, at = this.options.length) { e.optionOwner = this; this.options.splice(at, 0, e); }
  remove() { if (this.optionOwner) this.optionOwner.options.splice(this.optionOwner.options.indexOf(this), 1); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append() {} replaceChildren() {} setAttribute() {} blur() {} click() {}
  hasAttribute() { return false; }
  querySelector() { return new Element(); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 }; }
  getContext() { return {}; }
  setPointerCapture(id) { if (this.captureError) throw new Error('inactive pointer'); this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); this.listeners.lostpointercapture?.({ pointerId: id }); }
  dispatch(type, fields = {}) {
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...fields };
    this.listeners[type]?.(event);
    return event;
  }
}
function storage() {
  return { records: new Map(), entries: new Map(), writes: [], fail: false,
    async entry(key) { return this.load(this.entries.get(key)); },
    async load(hash) { return structuredClone(this.records.get(hash) || null); },
    async get() { return null; },
    async remember(hash, entry) { this.entries.set(entry, hash); },
    async list() { return structuredClone([...this.records.values()]); },
    async save(record, entry) {
      if (this.fail) throw new Error('quota exceeded');
      assert.equal(record.revision, this.records.get(record.hash)?.revision || 0, 'stale write');
      const revision = record.revision + 1;
      this.records.set(record.hash, structuredClone({ ...record, revision }));
      this.entries.set(entry, record.hash); this.writes.push({ entry, record: structuredClone(record) });
      return revision;
    } };
}
async function page(disk = storage(), initialSearch = '', selected = '', manualBootTimeout = false, extra = {}) {
  let bootTimer;
  const elements = new Map(), windowListeners = {}, documentListeners = {};
  const document = { documentElement: new Element(),
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); }, querySelector() { return new Element(); },
    addEventListener(type, fn) { documentListeners[type] = fn; } };
  if (extra.board === 1) document.documentElement.dataset.device = 'smk37';
  const cat = { default: 'a', firmwares: ['a', 'b'].map(id => ({ id, name: id, version: '1',
    package: `https://example.test/${id}.fwsc`, author: 'test', license: 'MIT', about: '' })) };
  let audio;
  class AudioContext {
    constructor() { this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; }
    async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
  }
  class AudioWorkletNode {
    constructor() {
      audio = this; this.messages = []; this.board = extra.board || 0;
      this.port = { postMessage: message => {
        this.messages.push(message);
        queueMicrotask(() => {
          if (message.type === 'boot') {
            if (this.hangBoot) return;
            this.seq = message.seq;
            this.base = new Uint8Array(persistence.FLASH_SIZE).fill(170);
            this.flash = this.base.slice();
            const packed = new Uint8Array(message.sectors), view = new DataView(packed.buffer);
            for (let o = 0; o < packed.length; o += 4100) this.flash.set(packed.subarray(o + 4, o + 4100), view.getUint32(o, true));
            if (message.syx) this.flash.set(new Uint8Array(message.syx), 0x90000);
            this.port.onmessage({ data: { type: 'booted', seq: this.seq, base: this.base, flash: this.flash.slice(), board: this.board } });
          } else if (message.type === 'snapshot') {
            this.port.onmessage({ data: { type: 'snapshot', seq: this.seq, request: message.request, flash: this.flash.slice() } });
          }
        });
      } };
    }
    connect() {} disconnect() {}
  }
  const local = new Map(selected ? [['fm1.fw', selected]] : []);
  const location = { search: initialSearch, origin: 'http://localhost', pathname: '/', href: `http://localhost/${initialSearch}` };
  const environment = {
    setTimeout(fn, ms) { if (manualBootTimeout && ms === 30000) { bootTimer = fn; return 'boot-timer'; } return setTimeout(fn, ms); },
    clearTimeout(id) { if (id !== 'boot-timer') clearTimeout(id); },
    document, location, history: { replaceState(_a, _b, url) { location.search = url; } },
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) },
    ResizeObserver: class { observe() {} }, scrollY: 0, Option: Element, navigator: {}, HTMLSelectElement: class extends Element {},
    fetch: async url => ({ json: async () => url === 'smk37/firmwares.json' ? { firmwares: [] } : cat,
      arrayBuffer: async () => new ArrayBuffer(0) }),
    WebAssembly: { instantiate: async () => ({ instance: { exports: { panel_board() {}, panel_width: () => 100, panel_height: () => 100, panel_theme_count: () => 1, panel_theme_name: () => 0, panel_theme() {}, panel_hit: () => -1, panel_hit_y: () => 0.5, panel_enc_id: i => i, panel_slide: (_i, y) => y,
      memory: { buffer: new ArrayBuffer(256) }, ...extra.panelExports } } }) },
    requestAnimationFrame() {}, addEventListener(type, fn) { windowListeners[type] = fn; }, AudioContext, AudioWorkletNode,
    matchMedia: () => ({ matches: false }), confirm: () => true,
    fetchPackage: async f => ({ bytes: new Uint8Array(960).fill(f.id === 'a' ? 1 : 2), url: f.package }),
    hubNewcomers: async () => [], hubCardUrl: id => `https://thefirmwarehub.com/#fw-${id}`,
    GestureEvent: class {}, ...persistence, ...tryout, ...gestureInput, ...captureInput, SaveStore: class { constructor() { return disk; } }, ...extra };
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const run = new Function(...Object.keys(environment), `return (async () => { ${source}\nreturn {
    startAudio, boot, flushRunning, setLatency, get running() { return running; },
    setFirmware(id) { fw = byId.get(id); fwSel.value = id; }, setBank(bytes) { bank = bytes; },
    get fw() { return fw; }, perf, setMhz(c) { mhz = c; }, get bootSeq() { return bootSeq; }, midiMessage
  }; })()`);
  const api = await run(...Object.values(environment));
  const dispatch = (listeners, type, fields) => {
    const event = { type, target: new Element(), preventDefault() { this.defaultPrevented = true; }, ...fields };
    listeners[type]?.(event); return event;
  };
  return { api, disk, elements, location, document, expireBoot: () => bootTimer(), get audio() { return audio; },
    fireWindow: (type, fields = {}) => dispatch(windowListeners, type, fields),
    fireDocument: (type, fields = {}) => dispatch(documentListeners, type, fields) };

}
test('firmware switch, clock reboot and audio-context replacement retain the latest flash', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.audio.flash[0x74000] = 19;
  p.api.setFirmware('b'); await p.api.boot();
  assert.equal(p.disk.writes.find(w => w.entry === 'fm1.a' && w.record.sectors.length).record.sectors[0].data[0], 19);
  p.api.setFirmware('a'); await p.api.boot();
  assert.equal(p.audio.flash[0x74000], 19);
  p.audio.flash[0x74001] = 20;
  await p.api.boot(); assert.equal(p.audio.flash[0x74001], 20);
  await p.api.setLatency('playback'); assert.equal(p.audio.flash[0x74001], 20);
});
test('DX7 seed is consumed once; later edits to imported voices survive a reboot', async () => {
  const p = await page(); await p.api.startAudio();
  p.api.setBank(new Uint8Array([13, 14])); await p.api.boot();
  assert.equal(p.audio.flash[0x90000], 13);
  p.audio.flash[0x90000] = 27;
  await p.api.boot();
  assert.equal(p.audio.messages.at(-1).syx, null);
  assert.equal(p.audio.flash[0x90000], 27);
});
test('backup import replaces the same running hash without a stale revision and restores local selection', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  const record = { ...p.api.running.record, sectors: [{ at: 0x74000, data: new Uint8Array(4096).fill(53) }] };
  const input = p.elements.get('import-save');
  input.files = [{ size: 1000, text: async () => persistence.exportSave(record) }];
  await input.listeners.change(); await settle();
  assert.equal(p.audio.flash[0x74000], 53);
  assert.equal(p.elements.get('save-status').textContent, 'Saved in this browser');
  const reloaded = await page(p.disk, '?fw=local', 'local');
  assert.equal(reloaded.api.fw.id, 'local');
  await reloaded.api.startAudio(); await reloaded.api.boot();
  assert.equal(reloaded.audio.flash[0x74000], 53);
});
test('failed storage retains changes in memory across a reboot and exposes an error', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.disk.fail = true; p.audio.flash[0x74000] = 83;
  await p.api.boot(); await settle();
  assert.equal(p.audio.flash[0x74000], 83);
  assert.match(p.elements.get('save-status').textContent, /quota exceeded/);
});

test('reset removes only the selected firmware differences', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot();
  p.audio.flash[0x74000] = 10;
  p.api.setFirmware('b'); await p.api.boot();
  p.audio.flash[0x74000] = 11;
  p.api.setFirmware('a'); await p.api.boot();
  await p.api.boot({ reset: true });
  assert.equal(p.audio.flash[0x74000], 170);
  p.api.setFirmware('b'); await p.api.boot();
  assert.equal(p.audio.flash[0x74000], 11);
});

test('opening an unchanged second tab does not invalidate the first tab revision', async () => {
  const disk = storage();
  const first = await page(disk); await first.api.startAudio(); await first.api.boot(); await settle();
  const count = disk.writes.length;
  const second = await page(disk); await second.api.startAudio(); await second.api.boot(); await settle();
  assert.equal(disk.writes.length, count);
  first.audio.flash[0x74000] = 91;
  await first.api.flushRunning();
  assert.equal(disk.writes.at(-1).record.sectors[0].data[0], 91);
});
test('a render failure clears the running session and another firmware boots immediately', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  p.audio.port.onmessage({ data: { type: 'error', seq: p.audio.seq, fatal: true, message: 'render: trap' } });
  assert.equal(p.api.running, null);
  p.api.setFirmware('b'); assert.equal(await p.api.boot(), true);
  assert.equal(p.audio.messages.filter(m => m.type === 'snapshot').length, 0);
  assert.equal(p.api.running.record.name, 'b');
});

test('saved firmware library recovers earlier local files after importing another backup', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot();
  p.audio.flash[0x74000] = 29; await p.api.flushRunning();
  const firstHash = p.api.running.record.hash;
  p.api.setFirmware('b'); await p.api.boot();
  await p.elements.get('browse-saves').listeners.click();
  const select = p.elements.get('saved-versions');
  assert.equal(select.options.length, 2);
  select.value = firstHash;
  await p.elements.get('open-saved-version').listeners.click();
  assert.equal(p.api.running.record.hash, firstHash);
  assert.equal(p.audio.flash[0x74000], 29);
  await settle();
  const reloaded = await page(p.disk, '?fw=local', 'local');
  await reloaded.api.startAudio(); await reloaded.api.boot();
  assert.equal(reloaded.audio.flash[0x74000], 29);
});

test('a boot timeout cancels the machine and the next firmware selection recovers', async () => {
  const p = await page(storage(), '', '', true);
  await p.api.startAudio(); await p.api.boot(); await settle();
  p.audio.hangBoot = true;
  const sent = p.audio.messages.length;
  const booting = p.api.boot();
  // the hung boot's timer is set as it posts its boot message: until then, the timer is the last boot's
  while (!p.audio.messages.slice(sent).some(m => m.type === 'boot')) await settle();
  p.expireBoot();
  assert.equal(await booting, false);
  assert.equal(p.api.running, null);
  assert.ok(p.audio.messages.some(m => m.type === 'cancel-boot'));
  p.audio.hangBoot = false; p.api.setFirmware('b');
  assert.equal(await p.api.boot(), true);
});

test('the status line and the report give the emulation speed and the JIT; idle firmwares get no lower clock', async () => {
  const p = await page(); await p.api.startAudio(); await p.api.boot(); await settle();
  const jit = { regions: 812, failed: 1, error: 'CompileError: x', compileMs: 40, compileMaxMs: 1.5 };
  // a second's worth of quanta: 345 of them, 2.9 ms of audio each; 400 ms busy for 1000 ms emulated
  p.audio.port.onmessage({ data: { type: 'frame', seq: p.api.bootSeq, lcd: null, leds: new Float32Array(41), ms: 5000,
    short: 3, halted: false, jit, playing: true, busy: 400, worst: 2.5, emulated: 1000, idle: 830, quanta: 345, frames: 128 } });
  const status = p.elements.get('status').textContent;
  assert.match(status, /2\.5x real time · load 40%/);
  assert.doesNotMatch(status, /instructions/);
  const report = p.api.perf.report();
  assert.match(report, /^speed \(emulated time per time spent emulating, last 1 s\): 2\.50x real time$/m);
  assert.match(report, /^jit: 812 regions compiled, 1 failed \(CompileError: x\) · compiling took 40 ms, the longest 1\.5 ms$/m);
  assert.match(report, /idle skipped: 83% of the time/);
  assert.match(report, /worst quantum since the audio started 2\.5 ms/);
  assert.doesNotMatch(report, /instructions/);
  // M-VAVE's firmware (83% idle at 240 MHz): its work is the same at 60 MHz, so no lower clock
  p.api.setMhz(240);
  assert.equal(p.api.perf.lowerClock(1.3), null);
  // a community firmware (10% idle): a lower clock helps, the highest that brings the load to ~80%
  p.api.perf.idleShare = 0.1;
  assert.equal(p.api.perf.lowerClock(1.2), 120);
  assert.equal(p.api.perf.lowerClock(0.9), 160);
  // too slow even at 60 MHz: still the lowest, it needs much less there
  assert.equal(p.api.perf.lowerClock(3), 60);
  p.api.setMhz(80);
  assert.equal(p.api.perf.lowerClock(1.2), null);    // (60 MHz would save only ~13%)
});

test("a try-out boots with its sectors and script from this origin, starts by itself and saves nothing", async () => {
  const disk = storage(), fetched = [], told = [];
  const sector = new Uint8Array(4100); new DataView(sector.buffer).setUint32(0, 0x96000, true); sector.fill(7, 4);
  const files = { 'http://localhost/dock/tryit/m.flash': sector, 'http://localhost/dock/tryit/m.txt': '1500:mf07d4842f7\n' };
  const fetch = async (url, init) => {
    fetched.push([url, init]);
    if (url in files) return { ok: true, arrayBuffer: async () => files[url].buffer, text: async () => files[url] };
    return { json: async () => url === 'smk37/firmwares.json' ? { firmwares: [] } : { default: 'a', firmwares: ['a', 'b'].map(id => ({ id, name: id, version: '1', package: `https://example.test/${id}.fwsc`, author: 't', license: 'MIT', about: '' })) },
      arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const window = { parent: { postMessage(m, origin) { told.push([m.state, origin]); } } };
  const p = await page(disk, '?fw=b&flash=/dock/tryit/m.flash&script=../dock/tryit/m.txt', '', false, { fetch, window });
  while (!p.api.running) await settle();
  await settle();
  const boot = p.audio.messages.find(m => m.type === 'boot');
  assert.equal(new TextDecoder().decode(boot.script), '1500:mf07d4842f7');
  assert.equal(new DataView(boot.sectors).getUint32(0, true), 0x96000);
  assert.equal(p.audio.flash[0x96000], 7);
  assert.equal(p.api.fw.id, 'b');
  assert.ok(fetched.filter(([u]) => u in files).every(([, init]) => init.redirect === 'error' && init.credentials === 'same-origin'));
  // nothing stored, the flash kept for an export; the embedding page (this origin only) hears how it goes
  p.audio.flash[0x96001] = 9; await p.api.flushRunning();
  assert.equal(disk.writes.length, 0);
  assert.equal(p.api.running.record.sectors.find(s => s.at === 0x96000).data[1], 9);
  assert.match(p.elements.get('save-status').textContent, /try-out: not saved/);
  assert.deepEqual(told.slice(0, 2), [['loading', 'http://localhost'], ['booting', 'http://localhost']]);
  p.audio.port.onmessage({ data: { type: 'frame', seq: p.api.bootSeq, lcd: null, leds: new Float32Array(41), ms: 2100,
    short: 0, halted: false, jit: null, playing: true, busy: 1, worst: 1, emulated: 1, idle: 0, quanta: 1, frames: 128 } });
  assert.deepEqual(told.at(-1), ['playing', 'http://localhost']);
  // another firmware ends the try-out: its own saved flash again, and saved
  p.api.setFirmware('a'); p.elements.get('fw').listeners.change(); await p.api.boot(); await settle();
  assert.doesNotMatch(p.location.search, /flash|script/);
  p.api.setFirmware('b'); await p.api.boot(); await settle();
  assert.notEqual(p.audio.flash[0x96000], 7);
  assert.ok(disk.writes.length > 0);
});

test('a try-out from another site is refused: nothing fetched, nothing started', async () => {
  const fetched = [];
  const base = await page();
  const fetch = async (url) => { fetched.push(url); return { json: async () => (url === 'smk37/firmwares.json' ? { firmwares: [] } : { default: 'a', firmwares: [{ id: 'a', name: 'a', version: '1', package: 'https://example.test/a.fwsc', author: 't', license: 'MIT', about: '' }] }), arrayBuffer: async () => new ArrayBuffer(0) }; };
  for (const q of ['?flash=https://evil.test/m.flash', '?script=//evil.test/m.txt', '?flash=data:,x']) {
    const p = await page(storage(), q, '', false, { fetch });
    await settle();
    assert.equal(p.audio, base.audio, q);          // (no audio graph made: nothing started)
    assert.match(p.elements.get('status').textContent, /^try-out: only files from http:\/\/localhost/, q);
  }
  assert.ok(fetched.every(u => !/evil|data:/.test(u)));
});

test("the Hub's newcomers come last, marked as not yet run here, and ?fw= picks one", async () => {
  const c = { id: 'c', name: 'Newcomer', version: '2', package: 'https://thefirmwarehub.com/fw/c-2.fwsc', hub: 'c',
    author: 't', license: 'GPL-3.0', about: 'new', untested: true };
  const p = await page(storage(), '?fw=c', '', false, { hubNewcomers: async () => [c] });
  assert.equal(p.api.fw.id, 'c');
  assert.equal(p.api.fw.untested, true);
  // the selector's plain options are the catalog's; the newcomer is in its group, not among them
  assert.deepEqual(p.elements.get('fw').options.map(o => o.value), ['a', 'b']);
  // a Hub that did not answer: the page as before
  const q = await page(storage(), '?fw=c', '', false, { hubNewcomers: async () => [] });
  assert.equal(q.api.fw.id, 'a', 'the default');
});
test('?package= plays a package from a link, named by &name=, and a reload fetches the link again', async () => {
  const fetched = [];
  const fetchPackage = async f => { fetched.push(f.package); return { bytes: new Uint8Array(960).fill(f.package.length % 250), url: f.package }; };
  const url = 'https://mutant.cloud/dl/fomajam/fomajam-1.0.fwsc';
  const p = await page(storage(), `?package=${encodeURIComponent(url)}&name=Fomajam`, '', false, { fetchPackage });
  assert.equal(p.api.fw.id, 'link');
  assert.equal(p.api.fw.name, 'Fomajam');
  assert.equal(p.elements.get('fw').options[0].value, 'link');
  assert.match(p.location.search, /package=/);
  await p.api.startAudio(); await p.api.boot(); await settle();
  assert.deepEqual(fetched, [url]);
  // another link on the same browser: its own package, not the last link's kept one
  const other = 'https://example.test/other.fwsc';
  const q = await page(p.disk, `?package=${encodeURIComponent(other)}`, '', false, { fetchPackage });
  assert.equal(q.api.fw.name, 'other');
  await q.api.startAudio(); await q.api.boot();
  assert.deepEqual(fetched, [url, other]);
  // not https: ignored, the page as without it
  const r = await page(storage(), '?package=http%3A%2F%2Fexample.test%2Fx.fwsc');
  assert.equal(r.api.fw.id, 'a');
});

// Dispatch the page's real registered handlers; the small hit map isolates input ownership
// from the Rust panel geometry. CSS / physical Safari gesture arbitration needs hardware QA.
async function inputPage(board = 0, extra = {}) {
  const p = await page(storage(), extra.initialSearch || '', '', false, { ...extra, board, panelExports: {
    panel_hit: (x, y) => {
      if (y >= 50 && y < 90 && x >= 0 && x < 40) return (board ? 112 : 121) + Math.floor(x / 20);
      if (y >= 30 && y < 50) return board ? 153 : 112; // transport/control button, never a note
      if (y >= 10 && y < 30) {
        if (x < 20) return board ? 200 : 0;
        if (x < 40) return board ? 400 : 1;
        if (x < 60) return board ? 300 : 7;
      }
      return -1;
    }, panel_slide: (_i, y) => Math.round(y * 10),
  } });
  await p.api.startAudio(); await p.api.boot(); await settle();
  p.audio.messages.length = 0;
  p.panel = p.elements.get('panel');
  p.pointer = (type, id, x = 10, y = 60, fields = {}) => p.panel.dispatch(type,
    { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: 1, ...fields });
  p.key = (type, key = 'a', code = 'KeyA', fields = {}) => p.fireWindow(type, { key, code, repeat: false, ...fields });
  p.keys = () => p.audio.messages.filter(m => m.type === 'key').map(m => [m.id, m.down]);
  return p;
}

test('screen contacts and computer keys share note ownership in either release order', async () => {
  const p = await inputPage();
  p.pointer('pointerdown', 1); p.pointer('pointerdown', 2, 30); p.key('keydown');
  p.key('keyup');
  assert.deepEqual(p.keys(), [[21, true], [22, true]], 'keyboard release must retain the touched key');
  p.pointer('pointerup', 1); p.pointer('pointercancel', 2);
  assert.deepEqual(p.keys(), [[21, true], [22, true], [21, false], [22, false]]);
  p.audio.messages.length = 0;
  p.key('keydown'); p.pointer('pointerdown', 3); p.pointer('pointerup', 3);
  assert.deepEqual(p.keys(), [[21, true]], 'touch release must retain the computer key');
  p.key('keyup', 'A');
  assert.deepEqual(p.keys(), [[21, true], [21, false]], 'physical key identity survives a shift change');
});

test('glissando releases outside the keybed and reenters while another finger holds a chord', async () => {
  const p = await inputPage();
  p.pointer('pointerdown', 1); p.pointer('pointerdown', 2, 30);
  p.pointer('pointermove', 1, 30); p.pointer('pointermove', 1, 90, 90);
  assert.deepEqual(p.keys(), [[21, true], [22, true], [21, false]], 'second finger retains the shared note');
  p.pointer('pointerup', 2);
  assert.deepEqual(p.keys().at(-1), [22, false], 'finger outside keys holds no note');
  p.pointer('pointermove', 1, 10, 60);
  assert.deepEqual(p.keys().at(-1), [21, true]);
  p.pointer('lostpointercapture', 1); p.pointer('pointerup', 1);
  assert.deepEqual(p.keys().slice(-2), [[21, true], [21, false]], 'capture loss and up release once');
});

test('pads share touch and keyboard ownership; pitch cancellation springs back', async () => {
  const p = await inputPage(1);
  p.pointer('pointerdown', 1, 10, 20); p.pointer('pointerdown', 2, 10, 20); p.key('keydown', '1', 'Digit1');
  p.pointer('pointerup', 1); p.key('keyup', '1', 'Digit1');
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'analog' && m.idx === 0).map(m => m.value), [700]);
  p.pointer('pointercancel', 2);
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'analog' && m.idx === 0).map(m => m.value), [700, 0]);
  p.pointer('pointerdown', 3, 30, 20); p.pointer('pointermove', 3, 30, 25); p.pointer('pointercancel', 3);
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'analog' && m.idx === 20).map(m => m.value), [200, 250, 535]);
});

test('independent screen knobs retain separate drag accumulators and reject secondary mouse buttons', async () => {
  const p = await inputPage();
  p.pointer('pointerdown', 1, 10, 20); p.pointer('pointerdown', 2, 30, 20, { isPrimary: false });
  p.pointer('pointermove', 1, 10, 8); p.pointer('pointermove', 2, 30, 44);
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'enc').map(m => [m.enc, m.clicks]), [[0, 1], [1, -1], [1, -1]]);
  p.pointer('pointerdown', 3, 10, 60, { pointerType: 'mouse', button: 2, buttons: 2 });
  assert.deepEqual(p.keys(), []);
  assert.equal(p.panel.dispatch('contextmenu').defaultPrevented, true);
});

test('capture failure has window release fallback and duplicate pointer ids never leak holds', async () => {
  const p = await inputPage();
  p.panel.captureError = true;
  assert.doesNotThrow(() => p.pointer('pointerdown', 1));
  p.fireWindow('pointerup', { pointerId: 1 });
  assert.deepEqual(p.keys(), [[21, true], [21, false]]);
  p.panel.captureError = false; p.audio.messages.length = 0;
  p.pointer('pointerdown', 2); p.pointer('pointerdown', 2, 30); p.pointer('pointerup', 2);
  assert.deepEqual(p.keys(), [[21, true], [21, false], [22, true], [22, false]]);
  assert.equal(p.panel.captures.size, 0);
});

test('blur, hiding, page exit and firmware reboot release local contacts and captured pointers', async () => {
  for (const reason of ['blur', 'visibilitychange', 'pagehide', 'boot']) {
    const p = await inputPage(1);
    p.pointer('pointerdown', 1); p.key('keydown'); p.pointer('pointerdown', 2, 10, 20); p.pointer('pointerdown', 3, 30, 20);
    if (reason === 'visibilitychange') { p.document.visibilityState = 'hidden'; p.fireDocument(reason); }
    else if (reason === 'boot') await p.api.boot();
    else p.fireWindow(reason);
    assert.deepEqual(p.keys(), [[12, true], [12, false]], reason);
    assert.equal(p.panel.captures.size, 0, reason);
    assert.ok(p.audio.messages.some(m => m.type === 'analog' && m.idx === 0 && m.value === 0), reason);
    assert.ok(p.audio.messages.some(m => m.type === 'analog' && m.idx === 20 && m.value === 535), reason);
    p.audio.messages.length = 0;
    p.pointer('pointerup', 1); p.key('keyup'); p.pointer('pointermove', 3, 30, 25);
    assert.deepEqual(p.audio.messages, [], 'stale input after lifecycle reset is ignored');
    await settle();
  }
});

test('SMK MIDI notes retain ownership across local touch and keyboard release', async () => {
  const p = await inputPage(1), target = { id: 'keyboard' };
  p.api.midiMessage({ target, data: [0x90, 60, 100] });
  p.pointer('pointerdown', 1); p.key('keydown'); p.pointer('pointerup', 1); p.key('keyup');
  assert.deepEqual(p.keys(), [[12, true]]);
  p.fireWindow('blur');
  assert.deepEqual(p.keys(), [[12, true]], 'background MIDI stays playable');
  p.api.midiMessage({ target, data: [0x80, 60, 0] });
  assert.deepEqual(p.keys(), [[12, true], [12, false]]);
});

test('SMK MIDI owners follow physical channels across channel selector changes', async () => {
  const p = await inputPage(1), target = { id: 'keyboard' };
  p.api.midiMessage({ target, data: [0x90, 60, 100] });
  const channel = p.elements.get('midich');
  channel.value = '2'; channel.listeners.change();
  p.api.midiMessage({ target, data: [0x80, 60, 0] });
  assert.deepEqual(p.keys(), [[12, true], [12, false]]);
});

test('deselected and disconnected SMK MIDI inputs release only their own held notes', async () => {
  const input = { id: 'keyboard', name: 'Keyboard', state: 'connected' };
  const access = { inputs: new Map([[input.id, input]]) };
  const p = await inputPage(1, { navigator: { requestMIDIAccess: async () => access } });
  const select = p.elements.get('midi');
  select.value = '*'; select.listeners.change(); await settle();
  input.onmidimessage({ target: input, data: [0x90, 60, 100] });
  p.pointer('pointerdown', 1);
  select.value = ''; select.listeners.change();
  assert.equal(input.onmidimessage, null);
  assert.deepEqual(p.keys(), [[12, true]], 'deselecting MIDI retains the touched key');
  p.pointer('pointerup', 1);
  assert.deepEqual(p.keys().at(-1), [12, false]);
  select.value = '*'; select.listeners.change(); await settle();
  input.onmidimessage({ target: input, data: [0x90, 60, 100] });
  access.inputs.delete(input.id); access.onstatechange();
  assert.deepEqual(p.keys().slice(-2), [[12, true], [12, false]], 'disconnection releases its MIDI note');
});

test('input during a pending firmware boot cannot leave invisible held controls', async () => {
  const p = await inputPage();
  p.audio.hangBoot = true;
  const sent = p.audio.messages.length, booting = p.api.boot();
  while (!p.audio.messages.slice(sent).some(m => m.type === 'boot')) await settle();
  p.pointer('pointerdown', 1); p.key('keydown');
  const keys = p.keys(), captures = p.panel.captures.size;
  p.audio.hangBoot = false;
  p.audio.port.onmessage({ data: { type: 'booted', seq: p.api.bootSeq, base: p.audio.base, flash: p.audio.flash.slice(), board: 0 } });
  await booting;
  assert.deepEqual(keys, []);
  assert.equal(captures, 0);
  p.audio.messages.length = 0;
  p.pointer('pointerup', 1); p.key('keyup');
  assert.deepEqual(p.audio.messages, []);
});


// Direct-port integration tests: these events are synthetic and prove ownership,
// not that any particular browser supplies independent physical screen contacts.
const wheel = (p, x, dy, fields = {}) => p.panel.dispatch('wheel', {
  clientX: x, clientY: 20, deltaX: 0, deltaY: dy, deltaMode: 0, ...fields,
});
function enableEstimates(p) {
  const toggle = p.elements.get('touch-estimates');
  toggle.checked = true; toggle.dispatch('change');
}
function gesture(p, type, fields = {}) {
  return p.fireDocument(type, { target: p.panel, isTrusted: true, cancelable: true,
    clientX: 20, clientY: 60, scale: 1, rotation: 0, ...fields });
}
function estimateClock() {
  let time = 0, serial = 0;
  const timers = new Map();
  return {
    factory: options => gestureInput.createSafariPairEstimator({ ...options,
      now: () => time, setTimer: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: time + ms }); return id; },
      clearTimer: id => timers.delete(id),
    }),
    advance(ms) { time += ms; for (const [id, t] of [...timers]) if (t.at <= time) { timers.delete(id); t.fn(); } },
  };
}
async function estimatedPage() {
  const clock = estimateClock();
  const p = await inputPage(0, { createSafariPairEstimator: clock.factory });
  enableEstimates(p);
  return { ...p, clock };
}
function beginPair(p) {
  p.pointer('pointerdown', 1, 10, 60, { isTrusted: true, pointerType: 'mouse' });
  return gesture(p, 'gesturestart');
}
test('wheel uses normalized units and encoder residuals stay with their own knobs', async () => {
  const p = await inputPage();
  wheel(p, 10, -24); wheel(p, 30, -24);
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'enc'), []);
  wheel(p, 10, -16);
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'enc').map(m => [m.enc, m.clicks]), [[0, 1]]);
  wheel(p, 30, -1, { deltaMode: 1 });
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'enc').map(m => [m.enc, m.clicks]), [[0, 1], [1, 1]]);
  wheel(p, 10, -1, { deltaMode: 2 });
  assert.equal(p.audio.messages.filter(m => m.type === 'enc').at(-1).clicks, 2);
});
test('browser zoom and malformed wheel input cannot alter synth parameters', async () => {
  const p = await inputPage();
  for (const fields of [{ ctrlKey: true }, { metaKey: true }, { deltaY: NaN }, { deltaMode: 8 }]) {
    assert.notEqual(wheel(p, 10, -100, fields).defaultPrevented, true);
  }
  assert.deepEqual(p.audio.messages, []);
});
test('wheel residual is cleared by firmware reset', async () => {
  const p = await inputPage(); wheel(p, 10, -24);
  await p.api.boot(); p.audio.messages.length = 0;
  wheel(p, 10, -24);
  assert.deepEqual(p.audio.messages.filter(m => m.type === 'enc'), []);
});
test('experimental Safari pair transfers first note and preserves independent keyboard ownership', async () => {
  const p = await estimatedPage();
  assert.equal(beginPair(p).defaultPrevented, true);
  assert.deepEqual(p.keys(), [[21, true], [22, true]], 'first note is transferred without a retrigger');
  p.key('keydown');
  gesture(p, 'gestureend');
  assert.deepEqual(p.keys(), [[21, true], [22, true], [22, false]]);
  p.key('keyup'); assert.deepEqual(p.keys().at(-1), [21, false]);
  p.audio.messages.length = 0;
  gesture(p, 'gesturechange', { scale: 2 });
  p.pointer('pointerdown', 8, 10, 60, { isTrusted: true, pointerType: 'mouse' });
  assert.deepEqual(p.audio.messages, [], 'late gesture and compatibility pointers stay locked out until re-arm');
});
test('stationary estimated chord ends after silence and cannot revive without re-arm', async () => {
  const p = await estimatedPage(); beginPair(p);
  p.clock.advance(501);
  assert.deepEqual(p.keys(), [[21, true], [22, true], [21, false], [22, false]]);
  p.audio.messages.length = 0;
  gesture(p, 'gesturechange'); assert.deepEqual(p.audio.messages, []);
  p.elements.get('touch-rearm').dispatch('click');
  beginPair(p); assert.deepEqual(p.keys(), [[21, true], [22, true]]);
  p.clock.advance(501);
});
test('estimates cannot operate transport, knobs, pads or out-of-panel keys', async () => {
  const p = await estimatedPage();
  beginPair(p);
  gesture(p, 'gesturechange', { clientY: 20 }); // both estimates over knobs
  gesture(p, 'gesturechange', { clientY: 40 }); // both estimates over transport controls
  gesture(p, 'gesturechange', { clientX: 90 }); // one beyond the panel, one beyond its keys
  assert.deepEqual(p.keys(), [[21, true], [22, true], [21, false], [22, false]]);
  assert.deepEqual(p.audio.messages.filter(m => ['enc', 'pot', 'analog'].includes(m.type)), []);
  gesture(p, 'gestureend');
});
test('model owners reconcile without retriggering when estimated endpoints swap keys', async () => {
  const p = await estimatedPage(); beginPair(p);
  gesture(p, 'gesturechange', { rotation: 180 });
  assert.deepEqual(p.keys(), [[21, true], [22, true]]);
  gesture(p, 'gestureend');
});
test('experimental trials end on lifecycle changes and preserve off-by-default controls', async () => {
  for (const why of ['blur', 'resize', 'scroll', 'visibilitychange', 'pagehide', 'boot', 'disabled']) {
    const p = await estimatedPage(); beginPair(p);
    if (why === 'boot') await p.api.boot();
    else if (why === 'disabled') { const t = p.elements.get('touch-estimates'); t.checked = false; t.dispatch('change'); }
    else if (why === 'visibilitychange') { p.document.visibilityState = 'hidden'; p.fireDocument(why); }
    else p.fireWindow(why);
    assert.equal(p.keys().filter(([, on]) => on).length, 2, why);
    assert.equal(p.keys().filter(([, on]) => !on).length, 2, why);
    p.audio.messages.length = 0;
    gesture(p, 'gesturechange'); assert.deepEqual(p.keys(), [], why);
  }
  const p = await inputPage();
  gesture(p, 'gesturestart');
  p.pointer('pointerdown', 1); p.pointer('pointerup', 1);
  assert.deepEqual(p.keys(), [[21, true], [21, false]]);
});


test('anchor expiry and invalid calibration release the original pointer owner', async () => {
  for (const invalid of [false, true]) {
    const p = await estimatedPage();
    p.pointer('pointerdown', 1, 10, 60, { isTrusted: true, pointerType: 'mouse' });
    if (invalid) gesture(p, 'gesturestart', { scale: NaN });
    else p.clock.advance(10001);
    assert.deepEqual(p.keys(), [[21, true], [21, false]]);
    assert.equal(p.panel.captures.size, 0);
    p.audio.messages.length = 0;
    gesture(p, 'gesturechange'); assert.deepEqual(p.audio.messages, []);
  }
});
test('a canvas-target gesture outside the panel or under an overlay terminates the trial', async () => {
  for (const overlay of [false, true]) {
    const p = await estimatedPage(); beginPair(p);
    if (overlay) p.document.elementFromPoint = () => new Element();
    gesture(p, 'gesturechange', overlay ? {} : { clientX: 120 });
    assert.deepEqual(p.keys(), [[21, true], [22, true], [21, false], [22, false]]);
    p.audio.messages.length = 0;
    if (overlay) p.document.elementFromPoint = () => p.panel;
    gesture(p, 'gesturechange'); assert.deepEqual(p.audio.messages, []);
  }
});
test('Space on the Release button is a browser activation, not synth PLAY', async () => {
  const p = await estimatedPage(); beginPair(p);
  const button = p.elements.get('touch-release'); button.tagName = 'BUTTON';
  assert.notEqual(p.key('keydown', ' ', 'Space', { target: button }).defaultPrevented, true);
  assert.deepEqual(p.keys(), [[21, true], [22, true]]);
  button.dispatch('click'); // the browser's normal keyboard button activation
  assert.deepEqual(p.keys(), [[21, true], [22, true], [21, false], [22, false]]);
  p.key('keyup', ' ', 'Space', { target: button });
});
test('focus loss before calibration requires an explicit re-arm', async () => {
  const p = await estimatedPage(); p.fireWindow('blur');
  p.pointer('pointerdown', 1, 10, 60, { isTrusted: true, pointerType: 'mouse' });
  gesture(p, 'gesturestart');
  assert.deepEqual(p.keys(), []);
});


test('a browser without Safari GestureEvent cannot enable the trial or lock out normal controls', async () => {
  const clock = estimateClock();
  const p = await inputPage(0, { GestureEvent: undefined, createSafariPairEstimator: clock.factory });
  const toggle = p.elements.get('touch-estimates');
  assert.equal(toggle.disabled, true);
  assert.match(p.elements.get('touch-status').textContent, /unavailable in this browser/);
  // Attempting to enable via stale/programmatic UI must not arm any timer.
  enableEstimates(p);
  assert.equal(toggle.checked, false);
  p.elements.get('touch-rearm').dispatch('click');
  p.pointer('pointerdown', 1); p.pointer('pointerup', 1);
  clock.advance(10001);
  p.pointer('pointerdown', 2); p.pointer('pointerup', 2);
  assert.deepEqual(p.keys(), [[21, true], [21, false], [21, true], [21, false]]);
  wheel(p, 10, -40);
  assert.equal(p.audio.messages.filter(m => m.type === 'enc').at(-1).clicks, 1);
  await p.api.boot(); p.audio.messages.length = 0;
  p.pointer('pointerdown', 3); p.pointer('pointerup', 3);
  assert.deepEqual(p.keys(), [[21, true], [21, false]], 'boot does not inherit an unsupported-trial lockout');
});

function screenMode(p, enabled = true) {
  const toggle = p.elements.get('screen-compat');
  toggle.checked = enabled; toggle.dispatch('change');
}
const secondary = (p, type, id = 0, x = 10, y = 60, fields = {}) => p.pointer(type, id, x, y,
  { pointerType: 'mouse', button: type === 'pointermove' ? -1 : 2, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 2, ...fields });

test('secondary mouse notes remain rejected by default; opt-in holds use their own button mask', async () => {
  const p = await inputPage();
  secondary(p, 'pointerdown'); secondary(p, 'pointermove', 0, 30); secondary(p, 'pointerup', 0, 30);
  assert.deepEqual(p.keys(), []);
  screenMode(p);
  secondary(p, 'pointerdown'); secondary(p, 'pointermove', 0, 30); secondary(p, 'pointerup', 0, 30);
  assert.deepEqual(p.keys(), [[21, true], [21, false], [22, true], [22, false]]);
  assert.equal(p.panel.captures.size, 0);
  p.audio.messages.length = 0;
  secondary(p, 'pointerdown'); secondary(p, 'pointermove', 0, 10, 60, { buttons: 1 });
  assert.deepEqual(p.keys(), [[21, true], [21, false]], 'a primary button cannot sustain a secondary owner');
  secondary(p, 'pointermove', 0, 30);
  assert.deepEqual(p.keys(), [[21, true], [21, false]], 'moves do not acquire new notes');
});

test('secondary compatibility input is piano-only on both boards and cannot acquire from outside', async () => {
  for (const board of [0, 1]) {
    const p = await inputPage(board); screenMode(p);
    for (const [x, y] of [[10, 20], [30, 20], [50, 20], [10, 40], [90, 95]]) {
      secondary(p, 'pointerdown', 0, x, y);
      secondary(p, 'pointermove', 0, 10, 60);
      secondary(p, 'pointerup');
    }
    p.panel.dispatch('wheel', { clientX: 10, clientY: 60, deltaY: -100, deltaMode: 0 });
    assert.deepEqual(p.audio.messages, [], 'no pads, transport, knobs, faders or notes may be triggered from rejected starts');
    assert.equal(p.panel.captures.size, 0);
  }
});

test('screen mode changes release panel/model owners while preserving keyboard and MIDI holds', async () => {
  const p = await inputPage(1); screenMode(p);
  const input = { id: 'keyboard' };
  p.api.midiMessage({ target: input, data: [0x90, 60, 100] });
  p.key('keydown'); secondary(p, 'pointerdown');
  screenMode(p, false);
  assert.deepEqual(p.keys(), [[12, true]]);
  secondary(p, 'pointerup'); p.key('keyup');
  assert.deepEqual(p.keys(), [[12, true]], 'MIDI retains its independent note');
  p.api.midiMessage({ target: input, data: [0x80, 60, 0] });
  assert.deepEqual(p.keys(), [[12, true], [12, false]]);
  const q = await estimatedPage(); beginPair(q); q.key('keydown');
  screenMode(q);
  assert.deepEqual(q.keys(), [[21, true], [22, true], [22, false]], 'changing modes releases estimates but preserves the keyboard owner');
  assert.equal(q.elements.get('touch-estimates').checked, false);
  gesture(q, 'gesturechange');
  q.key('keyup'); assert.deepEqual(q.keys().at(-1), [21, false]);
  enableEstimates(q);
  assert.equal(q.elements.get('screen-compat').checked, false, 'enabling the Safari trial disables screen compatibility');
  q.audio.messages.length = 0;
  secondary(q, 'pointerdown'); secondary(q, 'pointerup');
  assert.deepEqual(q.keys(), []);
});

test('compatibility owners release on cancellation, focus/page lifecycle and firmware replacement', async () => {
  for (const why of ['pointercancel', 'lostpointercapture', 'blur', 'visibilitychange', 'pagehide', 'boot']) {
    const p = await inputPage(); screenMode(p); secondary(p, 'pointerdown');
    if (why === 'boot') await p.api.boot();
    else if (why === 'visibilitychange') { p.document.visibilityState = 'hidden'; p.fireDocument(why); }
    else if (why === 'pointercancel' || why === 'lostpointercapture') secondary(p, why);
    else p.fireWindow(why);
    assert.deepEqual(p.keys(), [[21, true], [21, false]], why);
    assert.equal(p.panel.captures.size, 0, why);
    p.audio.messages.length = 0;
    secondary(p, 'pointermove'); secondary(p, 'pointerup');
    assert.deepEqual(p.keys(), [], 'late moves and releases never acquire notes');
  }
});

test('screen=1 explicitly enables compatibility and opens its help; primary controls stay normal', async () => {
  const p = await inputPage(0, { initialSearch: '?screen=1', GestureEvent: undefined });
  assert.equal(p.elements.get('screen-compat').checked, true);
  assert.equal(p.elements.get('screen-input-help').open, true);
  secondary(p, 'pointerdown'); secondary(p, 'pointerup');
  p.pointer('pointerdown', 1, 30, 60, { pointerType: 'mouse', button: 0, buttons: 1 });
  p.pointer('pointerup', 1, 30, 60, { pointerType: 'mouse', button: 0, buttons: 0 });
  assert.deepEqual(p.keys(), [[21, true], [21, false], [22, true], [22, false]]);
});

test('explicit capture preserves discrete input and records rejected input before filtering', async () => {
  const p = await inputPage(); screenMode(p);
  p.elements.get('screen-capture-start').dispatch('click');
  for (let i = 0; i < 10; i++) { secondary(p, 'pointerdown'); secondary(p, 'pointerup'); }
  secondary(p, 'pointerdown', 0, 10, 20);
  p.panel.dispatch('wheel', { clientX: 10, clientY: 20, deltaY: 10, deltaMode: 0, ctrlKey: true });
  p.elements.get('screen-capture-stop').dispatch('click');
  const report = JSON.parse(p.elements.get('screen-input-report').textContent);
  assert.equal(report.firstDiscrete.length, 16);
  assert.equal(report.lastDiscrete.length, 16);
  assert.equal(report.lastDiscrete.at(-1).reason, 'secondary-note-only');
  assert.equal(report.wheel.last.type, 'wheel');
  assert.equal(report.wheel.last.reason, 'wheel-rejected');
  assert.ok(report.firstDiscrete.every(e => Number.isFinite(e.timeMs) && (e.dtMs === null || e.dtMs >= 0)));
  assert.ok(report.firstDiscrete.every(e => !('pointerId' in e) && !('key' in e)));
  assert.equal(report.lastDiscrete.at(-1).button, 2);
  assert.equal(report.lastDiscrete.at(-1).buttons, 2);
  assert.equal(report.keyOutput.down, 10);
  assert.equal(report.keyOutput.up, 10);
});

test('report copying requires the explicit button and degrades to selectable local text', async () => {
  let copied = null;
  const p = await inputPage(0, { navigator: { clipboard: { writeText: async text => { copied = text; } } } });
  screenMode(p); p.elements.get('screen-capture-start').dispatch('click');
  secondary(p, 'pointerdown'); secondary(p, 'pointerup');
  p.elements.get('screen-capture-stop').dispatch('click');
  assert.equal(copied, null);
  await p.elements.get('screen-report-copy').listeners.click();
  assert.match(copied, /secondary-note-accepted/);
  const q = await inputPage(); screenMode(q);
  await q.elements.get('screen-report-copy').listeners.click();
  assert.match(q.elements.get('screen-input-status').textContent, /Select and copy/);
});


test('capture is explicit and passive, preserves the first press through wheel floods and freezes after Stop', async () => {
  const p = await inputPage(); screenMode(p);
  secondary(p, 'pointerdown'); secondary(p, 'pointerup');
  assert.equal(JSON.parse(p.elements.get('screen-input-report').textContent).state, 'idle');
  p.elements.get('screen-capture-start').dispatch('click');
  const press = p.pointer('pointerdown', 0, 10, 60, { pointerType: 'mouse', button: 2, buttons: 2, timeStamp: 12 });
  p.pointer('pointerup', 0, 10, 60, { pointerType: 'mouse', button: 2, buttons: 0, timeStamp: 42 });
  for (let i = 0; i < 150; i++) p.panel.dispatch('wheel', { clientX: 90, clientY: 95, deltaX: 0, deltaY: i / 10, deltaMode: 0, ctrlKey: false, timeStamp: 50 + i });
  const click = p.panel.dispatch('click', { clientX: 10, clientY: 60, button: 0, buttons: 0 });
  assert.notEqual(click.defaultPrevented, true, 'new observation listeners never prevent input');
  p.elements.get('screen-capture-stop').dispatch('click');
  const frozen = p.elements.get('screen-input-report').textContent;
  const report = JSON.parse(frozen);
  assert.equal(report.counts.wheel, 150);
  assert.equal(report.firstDiscrete[0].type, 'pointerdown');
  assert.equal(report.firstDiscrete[1].type, 'pointerup');
  assert.equal(report.firstDiscrete[1].eventTimeStamp - report.firstDiscrete[0].eventTimeStamp, 30);
  assert.equal(report.wheel.last.panelHit, -1);
  assert.equal(report.wheel.last.canvasX, 90);
  assert.equal(report.wheel.last.canvasY, 95);
  assert.equal(report.initialMapping.panelWidth, 100);
  assert.equal(report.stopMapping.panelHeight, 100);
  assert.equal(report.stopContext.audioState, 'running');
  assert.equal(report.stopReason, 'manual-stop');
  p.panel.dispatch('wheel', { clientX: 10, clientY: 20, deltaY: 4 });
  p.panel.dispatch('mousemove', { clientX: 20, clientY: 50 });
  await settle();
  assert.equal(p.elements.get('screen-input-report').textContent, frozen, 'queued rendering and later input cannot alter a stopped report');
});

test('capture only observes canvas targets and stops on mode/lifecycle changes without changing note ownership', async () => {
  for (const reason of ['blur', 'visibilitychange', 'pagehide', 'boot', 'mode']) {
    const p = await inputPage(); screenMode(p); p.elements.get('screen-capture-start').dispatch('click');
    p.panel.dispatch('mousedown', { target: new Element(), button: 0, buttons: 1, clientX: 10, clientY: 60 });
    p.panel.dispatch('pointerrawupdate', { pointerType: 'mouse', clientX: 11, clientY: 61, buttons: 2 });
    if (reason === 'mode') screenMode(p, false);
    else if (reason === 'boot') await p.api.boot();
    else if (reason === 'visibilitychange') { p.document.visibilityState = 'hidden'; p.fireDocument(reason); }
    else p.fireWindow(reason);
    const frozen = p.elements.get('screen-input-report').textContent;
    const report = JSON.parse(frozen);
    assert.equal(report.state, 'stopped', reason);
    assert.equal(report.counts.mousedown, undefined);
    assert.equal(report.counts.pointerrawupdate, 1);
    assert.deepEqual(p.keys(), [], 'diagnostic motion never acquires notes');
    p.panel.dispatch('mousemove', { clientX: 1, clientY: 1 }); await settle();
    assert.equal(p.elements.get('screen-input-report').textContent, frozen);
  }
});

test('explicit Save downloads the current local JSON without resetting capture', async () => {
  let blob = null, clicked = 0, filename = null, revoked = [];
  const p = await inputPage(0, { URL: class extends URL {
    static createObjectURL(value) { blob = value; return 'blob:local-test'; }
    static revokeObjectURL(url) { revoked.push(url); }
  } });
  const originalCreate = p.document.createElement;
  p.document.createElement = name => {
    const e = originalCreate(name);
    if (name === 'a') e.click = () => { clicked++; filename = e.download; };
    return e;
  };
  screenMode(p); p.elements.get('screen-capture-start').dispatch('click');
  secondary(p, 'pointerdown'); secondary(p, 'pointerup');
  p.elements.get('screen-capture-stop').dispatch('click');
  const frozen = p.elements.get('screen-input-report').textContent;
  assert.equal(clicked, 0);
  p.elements.get('screen-report-save').dispatch('click');
  assert.equal(clicked, 1);
  assert.match(filename, /^fm1-input-report-\d+\.json$/);
  assert.equal(await blob.text(), frozen);
  assert.equal(p.elements.get('screen-input-report').textContent, frozen);
});

test('capture is available in normal mode without enabling secondary-button compatibility', async () => {
  const p=await inputPage();
  assert.equal(p.elements.get('screen-capture-start').disabled,false);
  assert.notEqual(p.elements.get('screen-compat').checked,true);
  p.elements.get('screen-capture-start').dispatch('click');
  p.pointer('pointerdown',1,10,60,{pointerType:'mouse',button:0,buttons:1,timeStamp:10});
  p.pointer('pointerup',1,10,60,{pointerType:'mouse',button:0,buttons:0,timeStamp:60});
  p.elements.get('screen-capture-stop').dispatch('click');
  const report=JSON.parse(p.elements.get('screen-input-report').textContent);
  assert.equal(report.initialContext.inputMode,'normal');assert.equal(report.initialContext.compatibility,false);
  assert.equal(report.stopContext.safariEstimateEnabled,false);assert.equal(report.counts.pointerdown,1);
  assert.deepEqual(report.keyOutput,{down:1,up:1});assert.deepEqual(p.keys(),[[21,true],[21,false]]);
});

test('inactive Safari gestures are observable without enabling estimates or adding default prevention', async () => {
  const p=await inputPage();p.elements.get('screen-capture-start').dispatch('click');
  const start=gesture(p,'gesturestart',{timeStamp:100,scale:1.2,rotation:15});
  const change=gesture(p,'gesturechange',{timeStamp:140,clientX:25,scale:1.3,rotation:20});
  const end=gesture(p,'gestureend',{timeStamp:170,scale:1.3,rotation:20});
  for(const event of [start,change,end])assert.notEqual(event.defaultPrevented,true);
  p.elements.get('screen-capture-stop').dispatch('click');
  const report=JSON.parse(p.elements.get('screen-input-report').textContent);
  assert.equal(report.initialContext.inputMode,'normal');assert.equal(report.counts.gesturechange,1);
  const first=report.gestures.gesturestart.first,last=report.gestures.gestureend.last;
  assert.equal(first.scale,1.2);assert.equal(first.rotationDeg,15);
  assert.equal(first.reason,'safari-gesture-observed-trial-off');assert.equal(first.defaultPrevented,false);
  assert.equal(last.eventTimeStamp-first.eventTimeStamp,70);assert.equal(last.estimatorStateAfter,'disarmed');
  assert.deepEqual(p.audio.messages,[],'observation cannot acquire notes');
});

test('active Safari capture records handled geometry after existing note processing and prevention', async () => {
  const p=await estimatedPage();p.elements.get('screen-capture-start').dispatch('click');
  p.pointer('pointerdown',1,10,60,{isTrusted:true,pointerType:'mouse',timeStamp:100});
  gesture(p,'gesturestart',{timeStamp:120});gesture(p,'gesturechange',{timeStamp:160,rotation:2});
  gesture(p,'gestureend',{timeStamp:200});p.elements.get('screen-capture-stop').dispatch('click');
  const report=JSON.parse(p.elements.get('screen-input-report').textContent);
  assert.equal(report.initialContext.inputMode,'safari-estimate');assert.equal(report.initialContext.compatibility,false);
  const first=report.gestures.gesturestart.first,last=report.gestures.gestureend.last;
  assert.equal(first.estimatorStateBefore,'armed');assert.equal(first.estimatorStateAfter,'tracking');
  assert.equal(first.defaultPrevented,true);assert.equal(last.defaultPrevented,true);
  assert.equal(last.estimatorStateAfter,'ended');assert.equal(last.estimatorReason,'gestureend');
  assert.equal(report.keyOutput.down,2);assert.equal(report.keyOutput.up,2);
  assert.deepEqual(p.keys(),[[21,true],[22,true],[21,false],[22,false]]);
});

test('Safari diagnostic scoping requires a canvas target or an inside position verified by hit testing', async () => {
  const p=await inputPage();p.elements.get('screen-capture-start').dispatch('click');
  const elsewhere=new Element();
  gesture(p,'gesturechange',{target:elsewhere}); // no elementFromPoint: cannot verify fallback
  p.document.elementFromPoint=()=>elsewhere;gesture(p,'gesturechange',{target:elsewhere});
  p.document.elementFromPoint=()=>p.panel;gesture(p,'gesturechange',{target:elsewhere,clientX:120});
  gesture(p,'gesturechange',{target:elsewhere,clientX:20,clientY:60,timeStamp:40});
  gesture(p,'gesturechange',{target:p.panel,clientX:120,timeStamp:50}); // capture the owned target even when estimator would reject its position
  p.elements.get('screen-capture-stop').dispatch('click');
  const report=JSON.parse(p.elements.get('screen-input-report').textContent),entry=report.gestures.gesturechange;
  assert.equal(report.counts.gesturechange,2);assert.equal(entry.first.scopeBasis,'verified-canvas-hit');
  assert.equal(entry.last.scopeBasis,'canvas-target');assert.deepEqual(p.keys(),[]);
});

test('effective Safari mode changes freeze captures while diagnostic starts remain available in each mode', async () => {
  const p=await inputPage();p.elements.get('screen-capture-start').dispatch('click');enableEstimates(p);
  const frozen=p.elements.get('screen-input-report').textContent;
  assert.equal(JSON.parse(frozen).state,'stopped');assert.equal(JSON.parse(frozen).stopReason,'input-mode-changed');
  gesture(p,'gesturechange');await settle();assert.equal(p.elements.get('screen-input-report').textContent,frozen);
  p.elements.get('screen-capture-start').dispatch('click');screenMode(p,true);
  const next=JSON.parse(p.elements.get('screen-input-report').textContent);
  assert.equal(next.initialContext.inputMode,'safari-estimate');assert.equal(next.state,'stopped');
  p.elements.get('screen-capture-start').dispatch('click');p.elements.get('screen-capture-stop').dispatch('click');
  assert.equal(JSON.parse(p.elements.get('screen-input-report').textContent).initialContext.inputMode,'secondary-compatibility');
});


test('only explicit compatibility mouse piano presses request an emulated minimum pulse', async () => {
  const p=await inputPage();
  p.pointer('pointerdown',1,10,60,{pointerType:'mouse'});p.pointer('pointerup',1);
  assert.equal(p.audio.messages.find(m=>m.type==='key'&&m.down).minHoldMs,undefined);
  screenMode(p);p.audio.messages.length=0;
  p.pointer('pointerdown',2,10,60,{pointerType:'mouse'});p.pointer('pointerup',2);
  assert.equal(p.audio.messages.find(m=>m.type==='key'&&m.down).minHoldMs,20);
  assert.equal(p.audio.messages.filter(m=>m.type==='flush-key-releases').length,0,'normal up and its capture-loss notification retain the short-tap guard');
  p.audio.messages.length=0;p.key('keydown');p.key('keyup');
  assert.equal(p.audio.messages.find(m=>m.type==='key'&&m.down).minHoldMs,undefined,'keyboard remains immediate');
  p.audio.messages.length=0;
  p.pointer('pointerdown',3,10,60,{pointerType:'touch'});p.pointer('pointerup',3);
  assert.equal(p.audio.messages.find(m=>m.type==='key'&&m.down).minHoldMs,undefined,'actual independent contacts remain immediate');
  p.audio.messages.length=0;
  p.pointer('pointerdown',4,10,40,{pointerType:'mouse'});p.pointer('pointerup',4);
  assert.equal(p.audio.messages.find(m=>m.type==='key'&&m.down).minHoldMs,undefined,'transport is not pulse-stretched');
});
test('compatibility glissando marks each musical note and cancellation forces pending release', async () => {
  const p=await inputPage();screenMode(p);
  secondary(p,'pointerdown');secondary(p,'pointermove',0,30);
  assert.deepEqual(p.audio.messages.filter(m=>m.type==='key'&&m.down).map(m=>m.minHoldMs),[20,20]);
  secondary(p,'pointercancel',0,30);
  assert.ok(p.audio.messages.some(m=>m.type==='flush-key-releases'));
});
test('lifecycle and input-mode cleanup flush deferred compatibility note releases', async () => {
  for(const reason of ['blur','pagehide','boot','mode']){
    const p=await inputPage();screenMode(p);
    secondary(p,'pointerdown');secondary(p,'pointerup');p.audio.messages.length=0;
    if(reason==='mode')screenMode(p,false);
    else if(reason==='boot')await p.api.boot();
    else p.fireWindow(reason);
    assert.ok(p.audio.messages.some(m=>m.type==='flush-key-releases'),reason);
  }
});
