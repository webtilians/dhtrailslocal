// DH Trails Local v0.4 — public FastAPI client (no Supabase).
// Same-origin when run from http://127.0.0.1:8000/editor.html
const ENDPOINT_CONFIG='dhtrailslocal:api:url';

export function validateApiUrl(raw) {
  const url=new URL(String(raw||'').trim());
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&local)) {
    throw new Error('El servidor debe usar HTTPS, salvo localhost/127.0.0.1 en desarrollo.');
  }
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!=='') {
    throw new Error('Introduce solo la URL del servidor, sin rutas ni credenciales.');
  }
  return {url:url.origin};
}
export function getCloudConfig() {
  try {
    const saved=localStorage.getItem(ENDPOINT_CONFIG);
    if(saved)return validateApiUrl(saved);
  }catch{}
  if(typeof window!=='undefined' && ['localhost','127.0.0.1'].includes(window.location.hostname) && window.location.port==='8000')
    return {url:window.location.origin};
  return null;
}
export function setLocalCloudConfig(raw) {
  const safe=validateApiUrl(raw);
  localStorage.setItem(ENDPOINT_CONFIG,safe.url);
  return safe;
}
export function createCloudApi(config) {
  const {url}=validateApiUrl(config.url);
  const tokenKey='dhtrailslocal:api:token:'+url;
  let token;
  try{token=localStorage.getItem(tokenKey)||null}catch{token=null}

  async function request(path,{method='GET',body,form=false}={}) {
    const headers={};
    if(token)headers.Authorization='Bearer '+token;
    if(body!==undefined&&!form)headers['Content-Type']='application/json';
    let response;
    try{response=await fetch(url+'/api'+path,{
      method,headers,body:body===undefined?undefined:form?body:JSON.stringify(body)
    })}catch(e){throw new Error('No se puede acceder a FastAPI en '+url+'. ¿Está arrancado python run.py?')}
    if(!response.ok){
      let info;try{info=await response.json()}catch{}
      if(response.status===401)throw new Error('Sesión caducada. Vuelve a iniciar sesión.');
      const detail=info?.detail;
      throw new Error(typeof detail==='string'?detail:JSON.stringify(detail||response.statusText));
    }
    if(response.status===204)return null;
    if(path.endsWith('/file'))return response.blob();
    return response.json();
  }
  function persistToken(next) {
    token=next;
    try{if(token)localStorage.setItem(tokenKey,token);else localStorage.removeItem(tokenKey)}catch{}
  }
  async function user() {
    if(!token)return null;
    try{return await request('/auth/me')}
    catch{persistToken(null);return null}
  }
  return {
    user,
    async signIn(email,password){
      const result=await request('/auth/login',{method:'POST',body:{email,password}});
      persistToken(result.access_token);
      return {user:result.user,session:{user:result.user}};
    },
    async signUp(email,password){
      const result=await request('/auth/register',{method:'POST',body:{email,password}});
      persistToken(result.access_token);
      return {user:result.user,session:{user:result.user}};
    },
    async signOut(){persistToken(null);},
    async saveCircuit(circuit){
      const isRemote=/^[0-9a-f-]{36}$/i.test(circuit.cloud_id||'');
      const result=await request(isRemote?'/circuits/'+circuit.cloud_id:'/circuits',{
        method:isRemote?'PUT':'POST',
        body:{
          name:circuit.name,points:circuit.points,
          sectors:circuit.sectors||[],weakZones:circuit.weakZones||[],
          gateRadius:circuit.gateRadius||18
        }
      });
      return result.id;
    },
    async listCircuits(){return request('/circuits')},
    async saveAttempt(circuit,attempt,filename,route){
      if(!circuit?.cloud_id)throw new Error('Guarda primero el circuito en el servidor.');
      const began=route?.[attempt.startIndex]?.time;
      const saved=await request('/attempts',{method:'POST',body:{
        circuit_id:circuit.cloud_id,
        source_filename:String(filename||'ruta.gpx').slice(0,200),
        started_at:Number.isFinite(began)?new Date(began).toISOString():null,
        elapsed_ms:Number.isFinite(attempt.seconds)?Math.round(attempt.seconds*1000):null,
        sector_splits_ms:(attempt.splits||[]).map(v=>Number.isFinite(v)?Math.round(v*1000):null),
        confidence:Number.isFinite(attempt.confidence)?attempt.confidence:null,
        gps_status:attempt.status==='compatible'?'compatible':'review',
        notes:(attempt.issues||[]).join(' · ').slice(0,500)
      }});
      return saved.id;
    },
    async uploadActivity(file,points,distance){
      const ext=String(file.name||'').split('.').at(-1).toLowerCase();
      if(!['gpx','tcx'].includes(ext))throw new Error('Solo GPX/TCX.');
      const data=new FormData();
      data.append('file',file,file.name);
      if(points?.length)data.append('gps_points',String(points.length));
      if(Number.isFinite(distance))data.append('distance_m',String(distance));
      return request('/activities',{method:'POST',body:data,form:true});
    },
    async listActivities(){return request('/activities')},
    async downloadActivity(id){
      const items=await request('/activities');
      const item=items.find(x=>x.id===id);
      if(!item)throw new Error('Actividad no encontrada.');
      const blob=await request('/activities/'+encodeURIComponent(id)+'/file');
      return {blob,item};
    },
    async deleteActivity(id){return request('/activities/'+encodeURIComponent(id),{method:'DELETE'})}
  };
}
