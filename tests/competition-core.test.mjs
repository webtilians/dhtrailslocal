import test from 'node:test';
import assert from 'node:assert/strict';
import {monthLabel,sectorLabels,standingsRows,idealMs,asAttempt} from '../competition-core.mjs';
import {compareSectorTimes} from '../sector-comparison.mjs';

const circuit={id:'c1',points:Array.from({length:40},(_,i)=>[36.7+i*.00001,-4.5,300-i]),
  sectors:[{index:10,name:'Curvas'},{index:25,name:''}]};
const board={rows:[
  {rank:1,entry_id:'e1',pilot:'Rider Dos',elapsed_ms:130000,gap_ms:0,sector_splits_ms:[30000,60000,40000],gps_status:'compatible'},
  {rank:2,entry_id:'e2',pilot:'Rider Uno',elapsed_ms:154000,gap_ms:24000,sector_splits_ms:[29000,80000,45000],gps_status:'compatible'}
],best_sectors_ms:[29000,60000,40000]};

test('names months in Spanish and leaves unknown values alone',()=>{
  assert.equal(monthLabel('2026-10'),'octubre de 2026');
  assert.equal(monthLabel('2026-13'),'2026-13');
});
test('labels each sector by the gates that bound it',()=>{
  assert.deepEqual(sectorLabels(circuit).map(s=>s.long),['Salida → Curvas','Curvas → Límite 2','Límite 2 → Meta']);
  assert.deepEqual(sectorLabels(circuit).map(s=>s.short),['S1','S2','S3']);
});
test('marks the leader, gaps and the best time of each sector',()=>{
  const rows=standingsRows(board);
  assert.equal(rows[0].gapText,'Líder');
  assert.equal(rows[1].gapText,'+24.0 s');
  assert.deepEqual(rows[0].sectors.map(s=>s.best),[false,true,true]);
  assert.deepEqual(rows[1].sectors.map(s=>s.best),[true,false,false]);
});
test('ideal time needs every sector',()=>{
  assert.equal(idealMs(board),129000);
  assert.equal(idealMs({best_sectors_ms:[1000,null]}),null);
  assert.equal(idealMs({rows:[]}),null);
});
test('a rider can be compared with the leader sector by sector',()=>{
  const c=compareSectorTimes(circuit,asAttempt(board.rows[0],'c1'),asAttempt(board.rows[1],'c1'));
  assert.deepEqual(c.sectors.map(s=>s.status),['faster','slower','slower']);
  assert.equal(c.totalDeltaMs,24000);
});
