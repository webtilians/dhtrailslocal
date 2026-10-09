import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCloudConfig, cloudCircuitFromRow} from '../cloud-client.mjs';

test('accepts a public Supabase URL and publishable key',()=>{
  const config=validateCloudConfig(' https://myproject.supabase.co/ ','sb_publishable_abcdef');
  assert.equal(config.url,'https://myproject.supabase.co');
  assert.equal(config.key,'sb_publishable_abcdef');
});
test('rejects a secret key',()=>{
  assert.throws(()=>validateCloudConfig('https://myproject.supabase.co','sb_secret_veryprivate'),/clave pública|Nunca/);
});
test('rejects non HTTPS non-Supabase endpoints',()=>{
  assert.throws(()=>validateCloudConfig('http://localhost:8000','sb_publishable_abcdef'),/URL/);
});
test('maps relational circuit with ordered sectors and weak zones to editor schema',()=>{
  const c=cloudCircuitFromRow({
    id:'b95d1ae8-3831-4588-9c67-e44cce325381',
    name:'Santa Cruz',
    created_at:'2026-10-09T20:00:00Z',
    reference_points:[[36.7,-4.4,400],[36.6,-4.3,200]],
    gate_radius_m:18,
    circuit_sectors:[
      {sort_order:1,gate_index:17,name:'Curvas'},
      {sort_order:0,gate_index:8,name:'Recta'}
    ],
    circuit_weak_zones:[{from_index:11,to_index:15,name:'Sin cobertura'}]
  });
  assert.equal(c.name,'Santa Cruz');
  assert.equal(c.points.length,2);
  assert.deepEqual(c.sectors.map(x=>x.index),[8,17]);
  assert.deepEqual(c.weakZones,[{from:11,to:15,name:'Sin cobertura'}]);
  assert.equal(c.cloud_id,c.id);
});
