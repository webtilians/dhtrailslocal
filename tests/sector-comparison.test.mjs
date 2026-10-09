import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSectorTimes,formatMs,formatDelta} from '../sector-comparison.mjs';

const circuit={
  id:'circuit-1',cloud_id:'d21adc1e-7e1f-44af-8d40-9be4a4cc9ac0',
  points:Array.from({length:40},(_,i)=>[36.7+i*.00001,-4.5-i*.00001,300-i]),
  sectors:[{index:10,name:'Curvas'},{index:25,name:'Rocas'}]
};
const a={
  id:'attempt-A',circuit_id:circuit.cloud_id,
  elapsed_ms:167000,sector_splits_ms:[50000,72000,45000],
  gps_status:'compatible'
};
const b={
  id:'attempt-B',circuit_id:circuit.cloud_id,
  elapsed_ms:165000,sector_splits_ms:[49000,76000,40000],
  gps_status:'compatible'
};

test('compares manual sector boundaries and cumulative deltas',()=>{
  const c=compareSectorTimes(circuit,a,b);
  assert.equal(c.sectors.length,3);
  assert.deepEqual(c.sectors.map(s=>[s.from,s.to]),[[0,10],[10,25],[25,39]]);
  assert.deepEqual(c.sectors.map(s=>s.deltaMs),[-1000,4000,-5000]);
  assert.deepEqual(c.sectors.map(s=>s.cumulativeDeltaMs),[-1000,3000,-2000]);
  assert.deepEqual(c.sectors.map(s=>s.status),['faster','slower','faster']);
  assert.equal(c.totalDeltaMs,-2000);
  assert.equal(c.complete,true);
  assert.equal(c.hasGpsReview,false);
});
test('preserves unknown partial instead of inventing time or cumulative total',()=>{
  const b2={...b,sector_splits_ms:[49000,null,40000],gps_status:'review'};
  const c=compareSectorTimes(circuit,a,b2);
  assert.deepEqual(c.sectors.map(s=>s.deltaMs),[-1000,null,-5000]);
  assert.deepEqual(c.sectors.map(s=>s.cumulativeDeltaMs),[-1000,null,null]);
  assert.deepEqual(c.sectors.map(s=>s.status),['faster','unknown','faster']);
  assert.equal(c.hasGpsReview,true);
  assert.equal(c.complete,false);
});
test('rejects attempts from other circuit',()=>{
  assert.throws(()=>compareSectorTimes(circuit,a,{...b,circuit_id:'other'}),/mismo circuito/);
});
test('rejects stale stored splits if gates have changed',()=>{
  assert.throws(()=>compareSectorTimes({...circuit,sectors:[...circuit.sectors,{index:35,name:'Último'}]},a,b),/sectores actuales/);
});
test('rejects selecting one attempt twice',()=>{
  assert.throws(()=>compareSectorTimes(circuit,a,a),/diferentes/);
});
test('rounds time display correctly near minute boundaries',()=>{
  assert.equal(formatMs(59999),'01:00.0');
  assert.equal(formatMs(167000),'02:47.0');
  assert.equal(formatMs(null),'—');
  assert.equal(formatDelta(-1450),'−1.5 s');
  assert.equal(formatDelta(0),'±0.0 s');
});
