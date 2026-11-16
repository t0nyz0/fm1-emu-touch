// Local, explicitly started diagnostics. This module installs no listeners and
// changes no input behavior. Counts describe DOM events, never physical fingers.
const DISCRETE = new Set(['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup',
  'click', 'auxclick', 'contextmenu', 'touchstart', 'touchend', 'touchcancel']);
const MOTION = new Set(['pointermove', 'pointerrawupdate', 'mousemove']);
const GESTURE = new Set(['gesturestart', 'gesturechange', 'gestureend']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15;
const number = value => finite(value) ? value : null;
const clone = value => { try { return JSON.parse(JSON.stringify(value)); } catch { return null; } };
const rounded = value => finite(value) ? Math.round(value * 10) / 10 : null;

export function createInputCapture({ getMapping, getContext = () => null, render = () => {},
  now = () => performance.now(), schedule = callback => queueMicrotask(callback) } = {}) {
  if (![getMapping, getContext, render, now, schedule].every(fn => typeof fn === 'function')) throw new TypeError('Capture callbacks must be functions');
  let state = 'idle', generation = 0, queued = false, data = null, lastTime = null;
  let lastEvent = null, frozenText = null;
  const sources = new WeakMap();
  function read(callback) { try { return clone(callback()); } catch { return null; } }
  function text() {
    if (state === 'stopped') return frozenText;
    return JSON.stringify(data ? { ...data, state, currentContext: read(getContext) }
      : { diagnostic: 'Local canvas input capture', state, instruction: 'Press Start capture in any input mode.' }, null, 2);
  }
  function flush() {
    const value = text();
    try { render(value, state); } catch { /* Diagnostics cannot break the instrument. */ }
    return value;
  }
  function requestRender() {
    if (queued || state !== 'recording') return;
    queued = true;
    const token = generation;
    schedule(() => {
      if (token !== generation || state !== 'recording') return;
      queued = false; flush();
    });
  }
  function start() {
    generation++; queued = false; state = 'recording'; frozenText = null; lastTime = null; lastEvent = null;
    data = { diagnostic: 'Local canvas DOM event capture; no physical-source inference', state,
      scope: 'Canvas-target events and Safari gestures with a verified canvas hit. Outside-target pointer releases may appear only in keyOutput. No global input capture.',
      startedAtMs: number(now()), stoppedAtMs: null, stopReason: null,
      initialMapping: read(getMapping), stopMapping: null, initialContext: read(getContext), stopContext: null,
      counts: {}, firstDiscrete: [], lastDiscrete: [], motion: {}, gestures: {},
      wheel: { count: 0, validCount: 0, invalidCount: 0, ctrlCount: 0, metaCount: 0,
        aggregation: 'All valid wheel events, not an inferred pan, zoom or momentum stream.',
        rawByMode: {}, byModifiers: {}, normalizedPixels: { deltaX: 0, deltaY: 0 }, first: null, last: null },
      keyOutput: { down: 0, up: 0 } };
    flush(); return true;
  }
  function stop(reason = 'manual-stop') {
    if (state !== 'recording') return false;
    generation++; queued = false; state = 'stopped';
    data.state = state; data.stopReason = String(reason).slice(0, 100);
    data.stoppedAtMs = number(now()); data.stopMapping = read(getMapping); data.stopContext = read(getContext);
    frozenText = JSON.stringify(data, null, 2);
    flush(); return true;
  }
  function record(event, scope = 'canvas') {
    if (state !== 'recording' || scope !== 'canvas' || !event || event === lastEvent
      || !(DISCRETE.has(event.type) || MOTION.has(event.type) || GESTURE.has(event.type) || event.type === 'wheel')) return null;
    lastEvent = event;
    const time = now(), mapping = read(getMapping), rect = mapping?.canvasRect;
    const touch = event.changedTouches?.[0];
    const x = number(event.clientX ?? touch?.clientX), y = number(event.clientY ?? touch?.clientY);
    const localX = x !== null && finite(rect?.left) ? number(x - rect.left) : null;
    const localY = y !== null && finite(rect?.top) ? number(y - rect.top) : null;
    const record = { type: event.type, scope: 'canvas', timeMs: rounded(time), eventTimeStamp: number(event.timeStamp),
      isTrusted: event.isTrusted === true, cancelable: event.cancelable === true, defaultPrevented: event.defaultPrevented === true,
      dtMs: lastTime !== null && finite(time) && time >= lastTime ? rounded(time - lastTime) : null,
      pointerType: ['mouse', 'touch', 'pen'].includes(event.pointerType) ? event.pointerType : null,
      button: Number.isInteger(event.button) ? number(event.button) : null,
      buttons: Number.isInteger(event.buttons) ? number(event.buttons) : null,
      clientX: x, clientY: y, canvasX: localX, canvasY: localY,
      panelX: localX !== null && rect?.width > 0 && finite(mapping?.panelWidth) ? number(localX * mapping.panelWidth / rect.width) : null,
      panelY: localY !== null && rect?.height > 0 && finite(mapping?.panelHeight) ? number(localY * mapping.panelHeight / rect.height) : null,
      touchCount: Number.isInteger(event.touches?.length) ? number(event.touches.length) : null,
      changedTouchCount: Number.isInteger(event.changedTouches?.length) ? number(event.changedTouches.length) : null,
      reason: 'observed', panelHit: null };
    lastTime = finite(time) ? time : null;
    data.counts[event.type] = (data.counts[event.type] || 0) + 1;
    if (DISCRETE.has(event.type)) {
      if (data.firstDiscrete.length < 16) data.firstDiscrete.push(record);
      data.lastDiscrete.push(record);
      if (data.lastDiscrete.length > 16) data.lastDiscrete.shift();
    } else if (MOTION.has(event.type)) {
      const entry = data.motion[event.type] ||= { count: 0, first: record, last: record };
      entry.count++; entry.last = record;
    } else if (GESTURE.has(event.type)) {
      Object.assign(record, { center: { x, y }, scale: number(event.scale), rotationDeg: number(event.rotation) });
      const entry = data.gestures[event.type] ||= { count: 0, first: record, last: record };
      entry.count++; entry.last = record;
    } else {
      const wheel = data.wheel;
      wheel.count++; wheel.ctrlCount += event.ctrlKey ? 1 : 0; wheel.metaCount += event.metaKey ? 1 : 0;
      Object.assign(record, { ctrlKey: !!event.ctrlKey, metaKey: !!event.metaKey,
        deltaMode: Number.isInteger(event.deltaMode) ? number(event.deltaMode) : null,
        deltaX: number(event.deltaX), deltaY: number(event.deltaY), normalizedX: null, normalizedY: null });
      const mode = event.deltaMode ?? 0, dx = event.deltaX ?? 0, dy = event.deltaY;
      const factor = mode === 0 ? 1 : mode === 1 ? 16 : mode === 2 && rect?.height > 0 ? rect.height : null;
      const nx = dx * factor, ny = dy * factor;
      const bucket = wheel.rawByMode[mode] || { count: 0, deltaX: 0, deltaY: 0 };
      if ([0, 1, 2].includes(mode) && finite(dx) && finite(dy) && Math.abs(dx) <= 1e6 && Math.abs(dy) <= 1e6
        && factor !== null && finite(factor) && finite(nx) && finite(ny) && Math.abs(nx) <= 1e9 && Math.abs(ny) <= 1e9
        && finite(bucket.deltaX + dx) && finite(bucket.deltaY + dy)
        && finite(wheel.normalizedPixels.deltaX + nx) && finite(wheel.normalizedPixels.deltaY + ny)) {
        wheel.validCount++; bucket.count++; bucket.deltaX += dx; bucket.deltaY += dy; wheel.rawByMode[mode] = bucket;
        wheel.normalizedPixels.deltaX += nx; wheel.normalizedPixels.deltaY += ny;
        const modifier = event.ctrlKey ? event.metaKey ? 'ctrl-meta' : 'ctrl' : event.metaKey ? 'meta' : 'plain';
        const group = wheel.byModifiers[modifier] ||= { count: 0, deltaX: 0, deltaY: 0 };
        group.count++; group.deltaX += nx; group.deltaY += ny;
        record.normalizedX = nx; record.normalizedY = ny;
      } else wheel.invalidCount++;
      wheel.first ||= record; wheel.last = record;
    }
    sources.set(record, { event, generation });
    requestRender(); return record;
  }
  function finish(record, reason, panelHit = null) {
    if (state !== 'recording' || !record || sources.get(record)?.generation !== generation) return;
    record.reason = String(reason).slice(0, 100);
    record.defaultPrevented = sources.get(record).event.defaultPrevented === true;
    if (Number.isInteger(panelHit) && finite(panelHit)) record.panelHit = panelHit;
    requestRender();
  }
  function keyOutput(down) {
    if (state !== 'recording') return;
    data.keyOutput[down ? 'down' : 'up']++; requestRender();
  }
  return Object.freeze({ start, stop, record, finish, keyOutput, flush, getReportText: text,
    get state() { return state; } });
}
