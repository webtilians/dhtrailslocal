import {SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY} from './cloud-config.mjs';

const LOCAL_CONFIG = 'dhtrailslocal:supabase:public-config';

export function validateCloudConfig(url, key) {
  const endpoint = String(url||'').trim().replace(/\/+$/,'');
  const publishable = String(key||'').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(endpoint)) {
    throw new Error('La URL debe ser https://TU-PROYECTO.supabase.co');
  }
  if (!publishable || (!publishable.startsWith('sb_publishable_') && !publishable.startsWith('eyJ'))) {
    throw new Error('Usa la clave pública publishable/anon de Supabase, nunca una clave secreta.');
  }
  if(publishable.startsWith('sb_secret_'))throw new Error('Nunca pegues una clave secreta en esta web.');
  return {url:endpoint,key:publishable};
}

export function getCloudConfig() {
  if (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) {
    return validateCloudConfig(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
  }
  try {
    const cfg=JSON.parse(localStorage.getItem(LOCAL_CONFIG)||'null');
    return cfg ? validateCloudConfig(cfg.url,cfg.key) : null;
  } catch {return null;}
}
export function setLocalCloudConfig(url,key) {
  const cfg=validateCloudConfig(url,key);
  localStorage.setItem(LOCAL_CONFIG,JSON.stringify(cfg));
  return cfg;
}

export function cloudCircuitFromRow(row) {
  return {
    id:row.id, cloud_id:row.id,version:2,
    name:row.name,createdAt:row.created_at,points:row.reference_points,
    gateRadius:row.gate_radius_m,
    sectors:(row.circuit_sectors||[]).sort((a,b)=>a.sort_order-b.sort_order)
      .map(x=>({index:x.gate_index,name:x.name})),
    weakZones:(row.circuit_weak_zones||[]).sort((a,b)=>a.from_index-b.from_index)
      .map(x=>({from:x.from_index,to:x.to_index,name:x.name}))
  };
}

// Load the browser SDK ONLY when the user has configured a project.
// This is a static site with no private server credentials.
export async function createCloudApi(config) {
  const safe=validateCloudConfig(config.url,config.key);
  const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');
  const client=createClient(safe.url,safe.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  async function requiredUser(){
    const {data:{user},error}=await client.auth.getUser();
    if(error)throw error;
    if(!user)throw new Error('Inicia sesión para guardar circuitos en la nube.');
    return user;
  }
  async function session(){
    const {data:{session},error}=await client.auth.getSession();
    if(error)throw error;
    return session;
  }
  return {
    async user(){const s=await session();return s?.user||null},
    async signIn(email,password){
      const {data,error}=await client.auth.signInWithPassword({email,password});
      if(error)throw error;return data;
    },
    async signUp(email,password){
      const {data,error}=await client.auth.signUp({email,password});
      if(error)throw error;return data;
    },
    async signOut(){
      const {error}=await client.auth.signOut();if(error)throw error;
    },
    async saveCircuit(circuit){
      await requiredUser();
      if(!circuit?.points?.length)throw new Error('El circuito no contiene puntos.');
      const {data,error}=await client.rpc('save_circuit',{
        p_name:circuit.name,p_points:circuit.points,
        p_sectors:circuit.sectors||[],p_weak_zones:circuit.weakZones||[],
        p_gate_radius:circuit.gateRadius||18,
        p_id:/^[0-9a-f-]{36}$/i.test(circuit.cloud_id||'')?circuit.cloud_id:null
      });
      if(error)throw error;
      if(!data)throw new Error('Supabase no devolvió el identificador del circuito.');
      return data;
    },
    async listCircuits(){
      await requiredUser();
      const {data,error}=await client
        .from('circuits')
        .select('id,name,reference_points,gate_radius_m,created_at,circuit_sectors(sort_order,gate_index,name),circuit_weak_zones(from_index,to_index,name)')
        .order('updated_at',{ascending:false});
      if(error)throw error;
      return (data||[]).map(cloudCircuitFromRow);
    },
    async saveAttempt(circuit,attempt,routeFilename,activity){
      const user=await requiredUser();
      if(!circuit?.cloud_id)throw new Error('Guarda primero el circuito en la nube.');
      const began=activity?.[attempt.startIndex]?.time;
      const payload={
        circuit_id:circuit.cloud_id,pilot_id:user.id,
        source_filename:String(routeFilename||'ruta.gpx').slice(0,200),
        started_at:Number.isFinite(began)?new Date(began).toISOString():null,
        elapsed_ms:Number.isFinite(attempt.seconds)?Math.round(attempt.seconds*1000):null,
        sector_splits_ms:(attempt.splits||[]).map(v=>Number.isFinite(v)?Math.round(v*1000):null),
        confidence:Number.isFinite(attempt.confidence)?Math.min(1,Math.max(0,attempt.confidence)):null,
        gps_status:attempt.status==='compatible'?'compatible':'review',
        notes:(attempt.issues||[]).join(' · ').slice(0,500)
      };
      const {data,error}=await client.from('training_attempts').insert(payload).select('id').single();
      if(error)throw error;
      return data.id;
    }
  };
}
