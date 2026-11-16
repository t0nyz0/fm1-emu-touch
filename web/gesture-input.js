// Dependency-free input helpers. No DOM listeners, styles, synthetic contacts or
// import-time effects. Safari positions below are estimates, never hardware IDs.
const finite = (value, limit = 1e6) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const pointValid = point => point && finite(point.x) && finite(point.y);
const freezePoint = point => Object.freeze({ x: point.x, y: point.y });
const controlValid = id => (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)
  || (typeof id === 'string' && id.length > 0 && id.length <= 128);

/** Pure wheel conversion. Does not authenticate/prevent an event or guess its device. */
export function createWheelControlNormalizer({ linePixels = 16, pagePixels = 800, maxDelta = 1e6 } = {}) {
  if (!finite(linePixels) || linePixels <= 0) throw new RangeError('linePixels must be finite, positive and <= 1000000');
  if (typeof pagePixels !== 'function' && (!finite(pagePixels) || pagePixels <= 0)) throw new RangeError('pagePixels must be a positive finite number or callback');
  if (!finite(maxDelta, 1e9) || maxDelta <= 0) throw new RangeError('maxDelta must be finite, positive and <= 1000000000');
  const residuals = new Map();
  return Object.freeze({
    normalize(event, controlId) {
      if (!event || !controlValid(controlId) || event.ctrlKey || event.metaKey) return null;
      const dx = event.deltaX ?? 0, dy = event.deltaY, mode = event.deltaMode ?? 0;
      if (!finite(dx, maxDelta) || !finite(dy, maxDelta) || ![0, 1, 2].includes(mode)) return null;
      let factor = 1;
      if (mode === 1) factor = linePixels;
      if (mode === 2) {
        try { factor = typeof pagePixels === 'function' ? pagePixels() : pagePixels; }
        catch { return null; }
        if (!finite(factor) || factor <= 0) return null;
      }
      const deltaX = dx * factor, deltaY = dy * factor;
      if (!finite(deltaX, maxDelta) || !finite(deltaY, maxDelta)) return null;
      return Object.freeze({ controlId, deltaX, deltaY });
    },
    /** Positive pixelDelta yields positive clicks. Pass -deltaY for FM1's direction. */
    encoderSteps(controlId, pixelDelta, stepPixels = 40) {
      if (!controlValid(controlId) || !finite(pixelDelta, maxDelta) || !finite(stepPixels) || stepPixels < 1) return 0;
      if (!residuals.has(controlId) && residuals.size >= 128) return 0;
      const total = (residuals.get(controlId) ?? 0) + pixelDelta;
      const steps = Math.trunc(total / stepPixels);
      if (!Number.isSafeInteger(steps)) return 0;
      residuals.set(controlId, total - steps * stepPixels);
      return steps === 0 ? 0 : steps;
    },
    reset(controlId) {
      if (arguments.length === 0) residuals.clear();
      else residuals.delete(controlId);
    },
  });
}

// Guarded similarity model ported from the local research prototype; no imports.
// C must be the true live midpoint; A must have stayed still until calibration.
// No numerical validation can establish those physical assumptions.
function readSample(event) {
  if (!finite(event.clientX) || !finite(event.clientY)
    || !finite(event.scale) || event.scale < 1 / 1024 || event.scale > 1024
    || !finite(event.rotation)) return null;
  return { center: freezePoint({ x: event.clientX, y: event.clientY }), scale: event.scale, rotation: event.rotation };
}
function calibrate(anchor, initial) {
  const dx = anchor.x - initial.center.x, dy = anchor.y - initial.center.y;
  const separation = 2 * Math.hypot(dx, dy);
  if (!finite(separation, 100000) || separation < 2
    || !pointValid({ x: initial.center.x - dx, y: initial.center.y - dy })) return null;
  return { anchor, initial, separation };
}
function estimate(baseline, sample) {
  const relativeScale = sample.scale / baseline.initial.scale;
  const separation = baseline.separation * relativeScale;
  if (relativeScale < 1 / 64 || relativeScale > 64 || !finite(separation, 100000) || separation < 2) return null;
  const radians = ((sample.rotation - baseline.initial.rotation) % 360) * Math.PI / 180;
  const x = baseline.anchor.x - baseline.initial.center.x, y = baseline.anchor.y - baseline.initial.center.y;
  const dx = relativeScale * (Math.cos(radians) * x - Math.sin(radians) * y);
  const dy = relativeScale * (Math.sin(radians) * x + Math.cos(radians) * y);
  const a = { x: sample.center.x + dx, y: sample.center.y + dy };
  const b = { x: sample.center.x - dx, y: sample.center.y - dy };
  return pointValid(a) && pointValid(b) ? Object.freeze([freezePoint(a), freezePoint(b)]) : null;
}

/**
 * Explicitly armed, conditional two-point Safari experiment. The caller scopes
 * events to its surface and ends the session on focus/viewport/geometry changes.
 * This controller never installs handlers or emits trusted DOM input.
 *
 * onPair receives [model branch A, model branch B], not physical contact IDs.
 * onEnd runs once for each armed cycle, including one that never calibrated.
 * maxAgeMs limits anchor-to-calibration age, not a continuously updated session.
 * Stale input terminates the cycle: later events cannot resume without arm().
 */
export function createSafariPairEstimator({
  onPair, onEnd = () => {},
  now = () => globalThis.performance.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = handle => globalThis.clearTimeout(handle),
  maxAgeMs = 10000, staleMs = 500,
} = {}) {
  if (![onPair, onEnd, now, setTimer, clearTimer].every(fn => typeof fn === 'function')) throw new TypeError('Estimator callbacks and clock/timer functions are required');
  for (const [name, value] of [['maxAgeMs', maxAgeMs], ['staleMs', staleMs]]) {
    if (!finite(value, 2147483647) || value <= 0) throw new RangeError(`${name} must be finite, positive and within timer range`);
  }
  let state = 'disarmed';
  let reason = null;
  let anchor = null;
  let anchorAt = null;
  let baseline = null;
  let lastAt = null;
  let timer = null;
  let generation = 0;
  let callbackDepth = 0;
  const clockValid = value => finite(value, Number.MAX_SAFE_INTEGER) && value >= 0;
  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function invoke(callback, ...args) {
    callbackDepth++;
    try { callback(...args); }
    catch { if (callback === onPair) end('callback-error'); }
    finally { callbackDepth--; }
  }
  function end(nextReason = 'ended') {
    if (state !== 'armed' && state !== 'tracking') return;
    generation++;
    clear();
    state = 'ended';
    reason = typeof nextReason === 'string' ? nextReason.slice(0, 240) : 'ended';
    anchor = null;
    anchorAt = null;
    baseline = null;
    lastAt = null;
    invoke(onEnd, reason);
  }
  function schedule(delay, expectedState, endReason) {
    clear();
    const token = ++generation;
    timer = setTimer(() => {
      if (generation !== token || state !== expectedState) return;
      timer = null;
      end(endReason);
    }, delay);
  }
  function arm(point) {
    // A consumer callback cannot synchronously revive an ended cycle. Re-arm
    // must be a later explicit app/user action, outside notification callbacks.
    if (callbackDepth) return false;
    if (!pointValid(point)) { end('invalid-anchor'); return false; }
    const time = now();
    if (!clockValid(time)) { end('invalid-clock'); return false; }
    if (state === 'armed' || state === 'tracking') end('rearmed');
    generation++;
    state = 'armed';
    reason = null;
    anchor = freezePoint(point);
    anchorAt = time;
    baseline = null;
    lastAt = null;
    schedule(maxAgeMs, 'armed', 'anchor-expired');
    return true;
  }
  function processGesture(event) {
    if (callbackDepth || !event || event.isTrusted !== true || !['gesturestart', 'gesturechange', 'gestureend'].includes(event.type)
      || (state !== 'armed' && state !== 'tracking')) return false;
    // Scoping belongs to the embedding page; only events it explicitly routes
    // here during an armed cycle are claimed. Never prevent unrelated input.
    if (event.cancelable && typeof event.preventDefault === 'function') event.preventDefault();
    const time = now();
    if (!clockValid(time)) { end('invalid-clock'); return true; }
    if (event.type === 'gestureend') { end('gestureend'); return true; }
    if (state === 'tracking' && (!clockValid(lastAt) || time < lastAt || time - lastAt >= staleMs)) {
      end('stale');
      return true;
    }
    if (event.type === 'gesturestart' && state === 'tracking') { end('gesture-restarted'); return true; }
    if (event.type === 'gesturechange' && state !== 'tracking') { end('missing-gesturestart'); return true; }
    const sample = readSample(event);
    if (!sample) { end('invalid-geometry'); return true; }
    const phase = state === 'armed' ? 'began' : 'moved';
    if (state === 'armed') {
      if (time < anchorAt || time - anchorAt >= maxAgeMs) { end('anchor-expired'); return true; }
      baseline = calibrate(anchor, sample);
      if (!baseline) { end('invalid-geometry'); return true; }
    }
    const pair = estimate(baseline, sample);
    if (!pair) { end('invalid-geometry'); return true; }
    state = 'tracking';
    lastAt = time;
    // Schedule before notification: a callback that ends the session clears
    // this timer; nothing after the callback can revive state or recreate it.
    schedule(staleMs, 'tracking', 'stale');
    invoke(onPair, pair, Object.freeze({
      source: 'safari-gesture', fidelity: 'estimated', phase, timestamp: time,
      center: sample.center, scale: sample.scale, rotation: sample.rotation,
    }));
    return true;
  }
  return Object.freeze({
    arm,
    processGesture,
    end,
    get status() { return state; },
    get reason() { return reason; },
  });
}
