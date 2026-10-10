import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCircuit, detectAttempts, distanceSeries, nearestTrackIndex, referenceStops, withoutStops, summarize, readCircuitCollection, writeCircuitCollection} from '../gps-engine.mjs';

const origin = Date.UTC(2026,9,9,12,0,0);
function route(t0=origin, step=2000, withoutTime=false) {
  return Array.from({length:100},(_,i)=>({
    lat:36.74 - i*0.000061,lon:-4.45+Math.sin(i/11)*0.000094,
    ele:430-i*1.3,time:withoutTime?null:t0+i*step
  }));
}
const ref = route();
const create = () => buildCircuit('Santa Cruz',ref,10,87,
  [{index:28,name:'Curvas'},{index:62,name:'Rock garden'}],
  [{from:41,to:50,name:'Sombra GPS'}]);

test('creates a circuit from ordered gates and known weak-signal intervals',()=>{
  const c=create();
  assert.equal(c.points.length,78);
  assert.deepEqual(c.sectors.map(x=>x.index),[18,52]);
  assert.deepEqual(c.weakZones.map(x=>[x.from,x.to]),[[31,40]]);
  assert.ok(distanceSeries(c.points).at(-1)>300);
});
test('rejects invalid start/finish boundaries',()=>{
  assert.throws(()=>buildCircuit('Invalid',ref,51,52,[]),/salida y una meta/);
  assert.throws(()=>buildCircuit('Invalid',ref,10,87,[{index:95}]),/sectores/);
});
test('snaps clicks to a real source point',()=>{
  const snap=nearestTrackIndex(ref,{lat:ref[37].lat,lon:ref[37].lon});
  assert.equal(snap.index,37);
  assert.equal(snap.meters,0);
});
test('accepts Leaflet click LatLng objects and selects a GPS point',()=>{
  const click={lat:ref[37].lat,lng:ref[37].lon};
  const snap=nearestTrackIndex(ref,click);
  assert.equal(snap.index,37);
  assert.ok(Number.isFinite(snap.meters));
  assert.ok(snap.meters<1);
});
test('finds the candidate and computes ordered sector splits',()=>{
  const r=route(origin,2000);
  const attempts=detectAttempts(r,create());
  assert.equal(attempts.length,1);
  assert.ok(Math.abs(attempts[0].seconds-154)<1.1);
  assert.equal(attempts[0].splits.length,3);
  assert.ok(attempts[0].splits.every(s=>s>0));
  assert.equal(attempts[0].status,'compatible');
});
test('finds two runs and returns distinct attempts',()=>{
  const first=route(origin,2000),second=route(origin+500000,1700);
  const attempts=detectAttempts([...first,...second],create());
  assert.equal(attempts.length,2);
  assert.ok(attempts[1].seconds<attempts[0].seconds);
});
test('does not infer timing without GPS timestamps',()=>{
  const attempts=detectAttempts(route(origin,2000,true),create());
  assert.equal(attempts.length,1);
  assert.equal(attempts[0].seconds,null);
  assert.equal(attempts[0].status,'revisar');
});
test('does not falsely claim a matching lap on a distant activity',()=>{
  const r=route().map(p=>({...p,lat:p.lat+0.05}));
  assert.equal(detectAttempts(r,create()).length,0);
});
test('losing GPS for 15 s at a believable speed does not invalidate the run',()=>{
  const r=route();
  const broken=r.map((p,i)=>({...p,time:i>=48?p.time+15000:p.time}));
  const result=detectAttempts(broken,create());
  assert.equal(result.length,1);
  assert.equal(result[0].status,'compatible');
  assert.ok(Math.abs(result[0].seconds-169)<1.1);
  assert.ok(result[0].notes.some(x=>x.startsWith('GPS perdido o desviado 17 s')));
});
test('a shortcut while the GPS is lost is flagged by its impossible speed',()=>{
  const r=route();
  // Points 51-69 never recorded and point 70 reached 6 s after point 50: 136 m at 82 km/h.
  const cut=[...r.slice(0,51),...r.slice(70).map(p=>({...p,time:p.time-32000}))];
  const [run]=detectAttempts(cut,create());
  assert.equal(run.status,'revisar');
  assert.ok(run.issues.some(x=>x.includes('¿atajo o fallo del GPS?')));
});
test('reports distance, elevation and time',()=>{
  const stats=summarize(ref);
  assert.equal(stats.points,100);
  assert.ok(stats.descent>100);
  assert.ok(stats.seconds>0);
});


test('saved circuits remain readable across simulated reloads',()=>{
  const data=new Map();
  const store={getItem:key=>data.get(key)??null,setItem:(key,val)=>data.set(key,val)};
  const c=create();
  writeCircuitCollection(store,'circuits',[c]);
  assert.deepEqual(readCircuitCollection(store,'circuits').map(x=>x.name),['Santa Cruz']);
});

test('storage writes must be verified before reporting success',()=>{
  const fake={setItem:()=>{},getItem:()=>null};
  assert.throws(()=>writeCircuitCollection(fake,'circuits',[create()]),/no confirmó/);
});

test('storage quota or privacy errors are reported rather than ignored',()=>{
  const blocked={setItem:()=>{throw new Error('QuotaExceededError')},getItem:()=>null};
  assert.throws(()=>writeCircuitCollection(blocked,'circuits',[create()]),/QuotaExceededError/);
});

test('corrupt library is not silently accepted as an empty valid collection',()=>{
  const invalid={getItem:()=>'{invalid',setItem:()=>{}};
  assert.throws(()=>readCircuitCollection(invalid,'circuits'),/JSON/);
});

// v0.6.1 — gates follow the position along the circuit, not a radius around one point.
const eastMetres = m => m / (111195 * Math.cos(36.74 * Math.PI / 180));
test('a gate passed with the GPS 35 m to one side is timed at the average speed of that stretch',()=>{
  const shifted=route().map((p,i)=>i>=55&&i<=69?{...p,lon:p.lon+eastMetres(35)}:p);
  const [run]=detectAttempts(shifted,create());
  assert.ok(Math.abs(run.seconds-154)<1.1);
  assert.equal(run.missing,0);
  assert.ok(Math.abs(run.splits[1]-68)<1.5,String(run.splits[1]));
  assert.equal(run.status,'compatible');
  assert.ok(run.notes.some(x=>x.includes('parciales estimados')));
});
test('waiting at the start line is not timed',()=>{
  const r=route(), wait=[];
  // Rolling back and forth over the line for a minute; the last position is behind it.
  for(let j=0;j<30;j++)wait.push({...r[10],lat:r[10].lat+(j%2===0?-0.00002:0.00002),time:r[10].time+j*2000});
  const shiftedTimes=r.slice(10).map(p=>({...p,time:p.time+60000}));
  const runs=detectAttempts([...r.slice(0,10),...wait,...shiftedTimes],create());
  assert.equal(runs.length,1);
  assert.ok(Math.abs(runs[0].seconds-154)<1.1,String(runs[0].seconds));
});
test('a stop inside the reference stretch is measured',()=>{
  const r=route(), stop=Array.from({length:60},(_,j)=>({...r[40],time:r[40].time+(j+1)*2000}));
  const withStop=[...r.slice(0,41),...stop,...r.slice(41).map(p=>({...p,time:p.time+120000}))];
  const seconds=referenceStops(withStop,10,withStop.length-13);
  assert.ok(seconds>=110&&seconds<=140,String(seconds));
  assert.equal(referenceStops(r,10,87),0);
});
test('a circuit built from a run with a stop leaves the stop out',()=>{
  const r=route(), stop=Array.from({length:60},(_,j)=>({...r[40],lat:r[40].lat+(j%3-1)*0.00002,time:r[40].time+(j+1)*2000}));
  const withStop=[...r.slice(0,41),...stop,...r.slice(41).map(p=>({...p,time:p.time+120000}))];
  const finish=withStop.length-13, gates=[{index:28,name:'Curvas'},{index:62+60,name:'Rock garden'}];
  const clean=withoutStops(withStop,10,finish,gates,[]);
  assert.ok(clean.seconds>=110);
  const c=buildCircuit('Santa Cruz',clean.route,clean.start,clean.finish,clean.sectors,clean.zones);
  assert.ok(Math.abs(distanceSeries(c.points).at(-1)-distanceSeries(create().points).at(-1))<15);
  assert.deepEqual(c.sectors.map(g=>g.name),['Curvas','Rock garden']);
  assert.equal(detectAttempts(r,c)[0].status,'compatible');
});
