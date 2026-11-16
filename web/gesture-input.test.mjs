import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWheelControlNormalizer, createSafariPairEstimator } from './gesture-input.js';

// Trusted-shaped unit fixtures validate software state, not physical event delivery.
function gesture(type = 'gesturestart', values = {}) {
  return {type,isTrusted:true,cancelable:true,defaultPrevented:false,clientX:50,clientY:0,scale:1,rotation:0,
    preventDefault(){if(this.cancelable)this.defaultPrevented=true;},...values};
}
function fixture(options = {}) {
  let time=0,next=1;const timers=new Map(),allTimers=new Map(),pairs=[],ends=[];
  const clock={now:()=>time,set(value){time=value;},
    setTimer(fn,delay){const id=next++;const entry={at:time+delay,fn};timers.set(id,entry);allTimers.set(id,entry);return id;},
    clearTimer(id){timers.delete(id);},
    advance(ms){const finish=time+ms;while(true){const entry=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>finish)break;time=entry[1].at;timers.delete(entry[0]);entry[1].fn();}time=finish;},
    count:()=>timers.size,ids:()=>[...timers.keys()],fireOld(id){allTimers.get(id).fn();},
  };
  const estimator=createSafariPairEstimator({onPair:(points,meta)=>pairs.push({points,meta}),onEnd:reason=>ends.push(reason),
    now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,...options});
  return {estimator,clock,pairs,ends};
}
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('wheel normalizer converts modes, dynamic page units, and rejects zoom-modified wheel without preventing it',()=>{
  let height=300;const controls=createWheelControlNormalizer({linePixels:20,pagePixels:()=>height});
  assert.deepEqual(controls.normalize({deltaX:2,deltaY:-3,deltaMode:0},0),{controlId:0,deltaX:2,deltaY:-3});
  assert.deepEqual(controls.normalize({deltaY:2,deltaMode:1},3),{controlId:3,deltaX:0,deltaY:40});
  assert.equal(controls.normalize({deltaY:1,deltaMode:2},300).deltaY,300);
  height=500;assert.equal(controls.normalize({deltaY:-.5,deltaMode:2},300).deltaY,-250);
  for(const modifier of ['ctrlKey','metaKey'])assert.equal(controls.normalize({deltaY:5,[modifier]:true},0),null);
  let prevented=false;controls.normalize({deltaY:4,preventDefault(){prevented=true;}},0);assert.equal(prevented,false);
});

test('encoder residuals belong to each control and reset independently with signed finite clicks',()=>{
  const controls=createWheelControlNormalizer();
  assert.equal(controls.encoderSteps(0,25),0);assert.equal(controls.encoderSteps(1,25),0);
  assert.equal(controls.encoderSteps(0,15),1);assert.equal(controls.encoderSteps(1,-15),0);
  assert.equal(controls.encoderSteps(1,30),1);assert.equal(controls.encoderSteps(0,-81),-2);
  controls.encoderSteps(1,30);controls.reset(1);assert.equal(controls.encoderSteps(1,15),0);
  assert.equal(controls.encoderSteps(0,-39),-1);
  controls.reset();assert.equal(controls.encoderSteps(1,25),0);
  assert.ok(!Object.is(controls.encoderSteps(2,-1),-0));
});

test('invalid wheel data and oversized conversions are rejected atomically without corrupting encoder residuals',()=>{
  const controls=createWheelControlNormalizer({maxDelta:100});
  for(const event of [{deltaY:NaN},{deltaY:Infinity},{deltaY:101},{deltaX:Infinity,deltaY:1},
    {deltaY:1,deltaMode:3},{deltaY:10,deltaMode:1},{deltaY:1,deltaMode:2}])assert.equal(controls.normalize(event,0),null);
  assert.equal(controls.normalize({deltaY:1},-1),null);assert.equal(controls.normalize({deltaY:1},''),null);
  controls.encoderSteps(0,30);assert.equal(controls.encoderSteps(0,Infinity),0);assert.equal(controls.encoderSteps(0,NaN),0);
  assert.equal(controls.encoderSteps(0,1,.1),0);assert.equal(controls.encoderSteps(0,10),1);
  const badPage=createWheelControlNormalizer({pagePixels:()=>{throw Error('gone');}});assert.equal(badPage.normalize({deltaY:1,deltaMode:2},0),null);
  for(const options of [{linePixels:0},{pagePixels:NaN},{maxDelta:Infinity}])assert.throws(()=>createWheelControlNormalizer(options));
});

test('unarmed/untrusted/unknown gestures do nothing; an armed valid start is explicitly handled and immutable',()=>{
  const {estimator,clock,pairs}=fixture();const unarmed=gesture();assert.equal(estimator.processGesture(unarmed),false);
  assert.equal(unarmed.defaultPrevented,false);assert.equal(estimator.status,'disarmed');
  assert.equal(estimator.arm({x:0,y:0}),true);assert.equal(estimator.status,'armed');
  const untrusted=gesture('gesturestart',{isTrusted:false});assert.equal(estimator.processGesture(untrusted),false);assert.equal(untrusted.defaultPrevented,false);
  assert.equal(estimator.processGesture(gesture('wheel')),false);assert.equal(pairs.length,0);
  const start=gesture();assert.equal(estimator.processGesture(start),true);assert.equal(start.defaultPrevented,true);
  assert.equal(estimator.status,'tracking');assert.deepEqual(pairs[0].points,[{x:0,y:0},{x:100,y:0}]);
  assert.equal(pairs[0].meta.fidelity,'estimated');assert.equal(pairs[0].meta.phase,'began');
  for(const value of [pairs[0].points,...pairs[0].points,pairs[0].meta,pairs[0].meta.center])assert.ok(Object.isFrozen(value));
  assert.equal(clock.count(),1);estimator.end();assert.equal(clock.count(),0);
});

test('model uses frozen-baseline relative scale and rotation, with no repeated compounding',()=>{
  const {estimator,pairs}=fixture();estimator.arm({x:0,y:0});
  estimator.processGesture(gesture('gesturestart',{clientX:50,scale:2,rotation:10}));
  const moved=()=>gesture('gesturechange',{clientX:60,clientY:10,scale:1,rotation:100});
  estimator.processGesture(moved());const pair=pairs[1].points;
  close(pair[0].x,60);close(pair[0].y,-15);close(pair[1].x,60);close(pair[1].y,35);
  estimator.processGesture(moved());assert.deepEqual(pairs[2].points,pair);assert.equal(pairs[2].meta.phase,'moved');estimator.end();
});

test('stale input ends and releases the pair exactly once; the same gesture cannot resume',()=>{
  const {estimator,clock,pairs,ends}=fixture();estimator.arm({x:0,y:0});estimator.processGesture(gesture());
  clock.advance(499);estimator.processGesture(gesture('gesturechange',{clientX:55}));clock.advance(499);
  assert.equal(estimator.status,'tracking');clock.advance(1);assert.equal(estimator.status,'ended');assert.equal(estimator.reason,'stale');
  assert.deepEqual(ends,['stale']);assert.equal(clock.count(),0);const count=pairs.length;
  assert.equal(estimator.processGesture(gesture('gesturechange')),false);assert.equal(estimator.processGesture(gesture()),false);
  estimator.end('again');clock.advance(10000);assert.equal(pairs.length,count);assert.deepEqual(ends,['stale']);
  estimator.arm({x:0,y:0});assert.equal(estimator.processGesture(gesture()),true);assert.equal(estimator.status,'tracking');estimator.end();
});

test('clock-check rejects stale changes even when a busy event loop has not dispatched the timer',()=>{
  const {estimator,clock,pairs,ends}=fixture();estimator.arm({x:0,y:0});estimator.processGesture(gesture());clock.set(500);
  estimator.processGesture(gesture('gesturechange'));assert.equal(pairs.length,1);assert.deepEqual(ends,['stale']);assert.equal(clock.count(),0);
});

test('old cancelled timer callbacks cannot end a newer frame or erase its timer handle',()=>{
  const {estimator,clock,ends}=fixture();estimator.arm({x:0,y:0});const anchorTimer=clock.ids()[0];
  estimator.processGesture(gesture());const oldFrameTimer=clock.ids()[0];clock.advance(100);
  estimator.processGesture(gesture('gesturechange'));const current=clock.ids()[0];
  clock.fireOld(anchorTimer);clock.fireOld(oldFrameTimer);
  assert.equal(estimator.status,'tracking');assert.deepEqual(clock.ids(),[current]);assert.deepEqual(ends,[]);
  estimator.end();assert.equal(clock.count(),0);
});

test('anchor age is bounded and first sample must be a gesturestart; expired cycles need rearm',()=>{
  const first=fixture();first.estimator.arm({x:0,y:0});first.clock.advance(10000);
  assert.equal(first.estimator.reason,'anchor-expired');assert.equal(first.estimator.processGesture(gesture()),false);
  const second=fixture({maxAgeMs:20});second.estimator.arm({x:0,y:0});second.clock.set(20);
  second.estimator.processGesture(gesture());assert.deepEqual(second.ends,['anchor-expired']);
  const third=fixture();third.estimator.arm({x:0,y:0});third.estimator.processGesture(gesture('gesturechange'));
  assert.deepEqual(third.ends,['missing-gesturestart']);assert.equal(third.pairs.length,0);
});

test('every terminal gesture releases once, even if its final geometry is malformed; restart never recalibrates',()=>{
  const {estimator,pairs,ends,clock}=fixture();estimator.arm({x:0,y:0});estimator.processGesture(gesture());
  const ended=gesture('gestureend',{scale:NaN,clientX:NaN});assert.equal(estimator.processGesture(ended),true);
  assert.equal(ended.defaultPrevented,true);assert.deepEqual(ends,['gestureend']);assert.equal(clock.count(),0);
  estimator.processGesture(ended);assert.equal(ends.length,1);
  estimator.arm({x:0,y:0});estimator.processGesture(gesture());const count=pairs.length;
  estimator.processGesture(gesture());assert.equal(estimator.reason,'gesture-restarted');assert.equal(pairs.length,count);
});

test('invalid geometry, degenerate separation and discontinuous scale end the entire cycle',()=>{
  for(const values of [{clientX:NaN},{clientY:Infinity},{scale:0},{rotation:Infinity},{clientX:0},{clientX:50001}]){
    const {estimator,pairs,ends}=fixture();estimator.arm({x:0,y:0});estimator.processGesture(gesture('gesturestart',values));
    assert.equal(estimator.status,'ended');assert.equal(pairs.length,0);assert.deepEqual(ends,['invalid-geometry']);
  }
  const {estimator,pairs}=fixture();estimator.arm({x:0,y:0});estimator.processGesture(gesture());
  estimator.processGesture(gesture('gesturechange',{scale:65}));assert.equal(pairs.length,1);assert.equal(estimator.reason,'invalid-geometry');
});

test('callback reentrancy cannot revive or recursively reroute a cycle; consumer failure still releases',()=>{
  let estimator,recursive,armedFromPair,armedFromEnd,endCalls=0,frames=0;
  const f=fixture({onPair(){frames++;recursive=estimator.processGesture(gesture('gesturechange'));estimator.end('consumer-stop');armedFromPair=estimator.arm({x:0,y:0});},
    onEnd(){endCalls++;armedFromEnd=estimator.arm({x:0,y:0});}});estimator=f.estimator;
  estimator.arm({x:0,y:0});estimator.processGesture(gesture());assert.equal(frames,1);assert.equal(recursive,false);
  assert.equal(armedFromPair,false);assert.equal(armedFromEnd,false);assert.equal(endCalls,1);assert.equal(estimator.status,'ended');assert.equal(f.clock.count(),0);
  const broken=fixture({onPair(){throw Error('synth failed');}});broken.estimator.arm({x:0,y:0});
  assert.doesNotThrow(()=>broken.estimator.processGesture(gesture()));assert.deepEqual(broken.ends,['callback-error']);assert.equal(broken.clock.count(),0);
});

test('explicit rearm ends an older active cycle, while invalid anchors/clocks never emit a pair',()=>{
  const {estimator,clock,pairs,ends}=fixture();estimator.arm({x:0,y:0});estimator.processGesture(gesture());
  estimator.arm({x:10,y:0});assert.deepEqual(ends,['rearmed']);assert.equal(estimator.status,'armed');
  assert.equal(estimator.arm({x:NaN,y:0}),false);assert.equal(estimator.reason,'invalid-anchor');assert.equal(clock.count(),0);
  clock.set(NaN);assert.equal(estimator.arm({x:0,y:0}),false);assert.equal(pairs.length,1);
  for(const options of [{maxAgeMs:0},{staleMs:Infinity},{onPair:null}])assert.throws(()=>fixture(options));
});
