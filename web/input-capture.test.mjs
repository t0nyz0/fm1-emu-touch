import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createInputCapture} from './input-capture.js';

function fixture(extra = {}) {
  let time = 100;
  const queued = [], rendered = [];
  const mapping = { canvasRect: {left: 20, top: 40, width: 200, height: 100}, panelWidth: 400, panelHeight: 200, dpr: 2, scrollX: 0, scrollY: 10 };
  const context = {audioState: 'running', build: 'local-test'};
  const capture = createInputCapture({ getMapping: () => mapping, getContext: () => context,
    now: () => time, schedule: fn => queued.push(fn), render: (text, state) => rendered.push({text, state}), ...extra });
  return {capture, mapping, context, queued, rendered, advance: ms => {time += ms;},
    report: () => JSON.parse(capture.getReportText()), drain: () => { for(const fn of queued.splice(0)) fn(); } };
}
const event = (type, fields = {}) => ({type, clientX: 70, clientY: 65, timeStamp: 12,
  pointerType: 'mouse', button: 0, buttons: 1, isTrusted: true, cancelable: true, defaultPrevented: false, ...fields});

test('capture is explicitly started, canvas scoped and admits only the fixed event vocabulary', () => {
  const f = fixture();
  assert.equal(f.capture.record(event('pointerdown')), null);
  f.capture.start();
  assert.equal(f.capture.record(event('pointerdown'), 'window'), null);
  assert.equal(f.capture.record(event('keydown')), null);
  assert.equal(f.capture.record(event('arbitrary')), null);
  const e = event('pointerdown');
  f.capture.record(e); f.capture.record(e);
  assert.deepEqual(f.report().counts, {pointerdown: 1});
});

test('presses survive arbitrary wheel and motion floods with separately bounded samples', () => {
  const f = fixture(); f.capture.start();
  f.capture.record(event('pointerdown')); f.capture.record(event('pointerup', {buttons: 0}));
  for(let i = 0; i < 1000; i++) {
    f.capture.record(event('wheel', {deltaX: 1, deltaY: 2, deltaMode: 0, timeStamp: i}));
    f.capture.record(event('pointermove', {clientX: i, timeStamp: i}));
  }
  for(let i = 0; i < 40; i++) f.capture.record(event('click', {timeStamp: i}));
  const r = f.report();
  assert.equal(r.counts.wheel, 1000); assert.equal(r.counts.pointermove, 1000);
  assert.equal(r.firstDiscrete.length, 16); assert.equal(r.lastDiscrete.length, 16);
  assert.deepEqual(r.firstDiscrete.slice(0,2).map(e => e.type), ['pointerdown','pointerup']);
  assert.equal(r.motion.pointermove.first.clientX, 0); assert.equal(r.motion.pointermove.last.clientX, 999);
  assert.equal(r.wheel.first.eventTimeStamp, 0); assert.equal(r.wheel.last.eventTimeStamp, 999);
  assert.deepEqual(r.wheel.normalizedPixels, {deltaX:1000,deltaY:2000});
  assert.equal(f.queued.length, 1, 'all events accumulate before one batched render');
});

test('Stop freezes mappings, context, counts and output even against queued callbacks and later mutations', () => {
  const f = fixture(); f.capture.start();
  const record = f.capture.record(event('pointerdown'));
  f.capture.keyOutput(true); f.advance(30); f.capture.stop('manual-stop');
  const frozen = f.capture.getReportText();
  f.mapping.canvasRect.left = 999; f.context.audioState = 'closed';
  f.capture.record(event('pointerup')); f.capture.keyOutput(false);
  f.capture.finish(record, 'late-mutator', 999); f.drain();
  assert.equal(f.capture.getReportText(), frozen);
  assert.equal(f.rendered.at(-1).text, frozen);
  const r = f.report();
  assert.equal(r.initialMapping.canvasRect.left,20); assert.equal(r.stopMapping.canvasRect.left,20);
  assert.equal(r.stopContext.audioState,'running');
  assert.deepEqual(r.keyOutput,{down:1,up:0});
  assert.equal(f.capture.stop('later'),false);
});

test('old scheduled callbacks and record handles cannot mutate a restarted capture', () => {
  const f = fixture(); f.capture.start();
  const old = f.capture.record(event('pointerdown'));
  f.capture.stop('first'); f.capture.start();
  const next = f.capture.record(event('mousedown'));
  f.capture.finish(old,'stale',999); f.capture.finish(next,'new',112); f.drain();
  const r = f.report();
  assert.deepEqual(r.counts,{mousedown:1}); assert.equal(r.firstDiscrete[0].reason,'new');
  assert.equal(r.firstDiscrete[0].panelHit,112);
  assert.equal(f.rendered.at(-1).state,'recording');
});

test('geometry stays in CSS viewport/panel frames and sanitizes missing or non-finite fields', () => {
  const f = fixture(); f.capture.start();
  f.capture.record(event('pointerdown')); f.advance(35);
  f.capture.record(event('pointerup',{clientX:NaN,clientY:Infinity,timeStamp:Infinity,buttons:0}));
  const [a,b] = f.report().firstDiscrete;
  assert.equal(a.canvasX,50); assert.equal(a.canvasY,25); assert.equal(a.panelX,100); assert.equal(a.panelY,50);
  assert.equal(b.clientX,null); assert.equal(b.canvasX,null); assert.equal(b.eventTimeStamp,null); assert.equal(b.dtMs,35);
  assert.equal('pointerId' in a,false); assert.equal('key' in a,false);
});

test('wheel totals include every valid mode/modifier and reject malformed conversions atomically', () => {
  const f = fixture(); f.capture.start();
  f.capture.record(event('wheel',{deltaX:1,deltaY:2,deltaMode:0}));
  f.capture.record(event('wheel',{deltaX:2,deltaY:3,deltaMode:1,ctrlKey:true}));
  f.capture.record(event('wheel',{deltaX:1,deltaY:-1,deltaMode:2,metaKey:true}));
  for(const fields of [{deltaY:NaN,deltaMode:0},{deltaX:1,deltaY:1,deltaMode:8},{deltaY:1e20,deltaMode:0}]) f.capture.record(event('wheel',fields));
  const w = f.report().wheel;
  assert.equal(w.count,6); assert.equal(w.validCount,3); assert.equal(w.invalidCount,3);
  assert.deepEqual(w.normalizedPixels,{deltaX:133,deltaY:-50});
  assert.equal(w.rawByMode[1].deltaY,3); assert.equal(w.byModifiers.ctrl.deltaY,48);
  assert.equal(w.byModifiers.meta.deltaY,-100);
  assert.equal(w.ctrlCount,1); assert.equal(w.metaCount,1);
});

test('trusted/default-prevention metadata is observed without changing the original event', () => {
  const f = fixture(); f.capture.start();
  const e = event('contextmenu');
  const r = f.capture.record(e);
  assert.equal(e.defaultPrevented,false);
  e.defaultPrevented = true; f.capture.finish(r,'existing-prevention');
  const record = f.report().firstDiscrete[0];
  assert.equal(record.isTrusted,true); assert.equal(record.cancelable,true); assert.equal(record.defaultPrevented,true);
});

test('mouse, touch and raw motion retain counts without creating contact IDs or interpreting device provenance', () => {
  const f = fixture(); f.capture.start();
  for(const type of ['mousedown','mouseup','click','auxclick','contextmenu','touchstart','touchend','touchcancel','pointercancel'])
    f.capture.record(event(type,{touches:[],changedTouches:[{clientX:30,clientY:50,identifier:987}]}));
  f.capture.record(event('pointerrawupdate')); f.capture.record(event('mousemove'));
  const r = f.report();
  assert.equal(Object.keys(r.counts).length,11);
  assert.equal(r.firstDiscrete.find(e => e.type === 'touchstart').changedTouchCount,1);
  assert.ok(r.firstDiscrete.every(e => !('identifier' in e) && !('pointerId' in e)));
  assert.equal(r.motion.pointerrawupdate.count,1);
});

test('Safari gesture geometry has bounded first/last samples and counts independent of pointer mode', () => {
  const f = fixture();
  assert.match(f.capture.getReportText(), /any input mode/);
  f.capture.start();
  f.capture.record(event('gesturestart',{clientX:50,clientY:60,scale:1,rotation:0,timeStamp:10}));
  for(let i=0;i<1000;i++)f.capture.record(event('gesturechange',{clientX:50+i/100,clientY:60,scale:1+i/1000,rotation:i/10,timeStamp:20+i}));
  f.capture.record(event('gestureend',{clientX:60,clientY:60,scale:2,rotation:100,timeStamp:1020}));
  const r=f.report();
  assert.equal(r.counts.gesturestart,1);assert.equal(r.counts.gesturechange,1000);assert.equal(r.counts.gestureend,1);
  assert.equal(r.gestures.gesturechange.count,1000);
  assert.equal(r.gestures.gesturechange.first.eventTimeStamp,20);
  assert.equal(r.gestures.gesturechange.last.eventTimeStamp,1019);
  assert.deepEqual(r.gestures.gesturestart.first.center,{x:50,y:60});
  assert.equal(r.gestures.gestureend.last.scale,2);assert.equal(r.gestures.gestureend.last.rotationDeg,100);
  assert.equal(r.firstDiscrete.length,0);assert.equal(f.queued.length,1);
  f.capture.stop();const frozen=f.capture.getReportText();f.capture.record(event('gesturechange'));f.drain();
  assert.equal(f.capture.getReportText(),frozen);
});

test('gesture metadata sanitizes geometry and observes final prevention without manufacturing input', () => {
  const f=fixture();f.capture.start();
  const e=event('gesturestart',{isTrusted:false,scale:NaN,rotation:Infinity,clientX:NaN});
  const record=f.capture.record(e);assert.equal(e.defaultPrevented,false);
  e.defaultPrevented=true;f.capture.finish(record,'existing-handler');
  const r=f.report().gestures.gesturestart.first;
  assert.equal(r.isTrusted,false);assert.equal(r.scale,null);assert.equal(r.rotationDeg,null);
  assert.equal(r.center.x,null);assert.equal(r.defaultPrevented,true);
  assert.equal(f.capture.record(event('gesturechange'),'outside'),null);
});
