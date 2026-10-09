import test from 'node:test';
import assert from 'node:assert/strict';
import {validateApiUrl,createCloudApi} from '../api-client.mjs';

test('accepts local Python server without TLS only on loopback',()=>{
  assert.deepEqual(validateApiUrl('http://127.0.0.1:8000/'),{url:'http://127.0.0.1:8000'});
  assert.deepEqual(validateApiUrl('http://localhost:8000'),{url:'http://localhost:8000'});
});
test('rejects insecure remote backend or credentials in URL',()=>{
  assert.throws(()=>validateApiUrl('http://example.com:8000'),/HTTPS/);
  assert.throws(()=>validateApiUrl('http://user:pass@localhost:8000'),/credenciales/);
  assert.throws(()=>validateApiUrl('http://localhost:8000/backend/.env'),/sin rutas/);
});
test('the browser API client uses its own REST endpoint (not Supabase)',async()=>{
  const originalFetch=globalThis.fetch;
  const originalStorage=globalThis.localStorage;
  const calls=[];
  const data=new Map();
  globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  globalThis.fetch=async(url,opts)=>{
    calls.push({url,opts});
    if(String(url).endsWith('/api/health'))return {ok:true,status:200,json:async()=>({ok:true})};
    if(String(url).endsWith('/api/auth/register'))return {ok:true,status:201,json:async()=>({access_token:'test-token',user:{id:'1',email:'tester@example.com'}})};
    if(String(url).endsWith('/api/circuits')&&opts.method==='GET')return {ok:true,status:200,json:async()=>([])};
    throw Error('Unexpected request: '+url);
  };
  try {
    const api=createCloudApi({url:'http://127.0.0.1:8000'});
    assert.deepEqual(await api.health(),{ok:true});
    assert.equal((await api.signUp('tester@example.com','pass-secret')).user.email,'tester@example.com');
    await api.listCircuits();
    assert.equal(calls[2].opts.headers.Authorization,'Bearer test-token');
    assert.equal(calls[2].url,'http://127.0.0.1:8000/api/circuits');
  }finally{
    globalThis.fetch=originalFetch;
    if(originalStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=originalStorage;
  }
});
