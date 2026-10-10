// DH Trails Local v0.8 — public FastAPI client (no Supabase).
// Same-origin when the page is served by FastAPI (this PC or the public server).
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
  if(typeof window!=='undefined' && ['localhost','127.0.0.1'].includes(window.location.hostname) && window.location.port==='8000')
    return {url:window.location.origin};
  try {
    const saved=localStorage.getItem(ENDPOINT_CONFIG);
    if(saved)return validateApiUrl(saved);
  }catch{}
  return null;
}
// A page served by FastAPI itself uses its own origin; GitHub Pages falls back to the saved URL.
export async function discoverApi() {
  if(typeof window!=='undefined' && /^https?:$/.test(window.location.protocol)) {
    try {
      const response=await fetch(window.location.origin+'/api/health',{cache:'no-store'});
      if(response.ok && (await response.json())?.service==='dhtrailslocal-fastapi')return validateApiUrl(window.location.origin);
    }catch{}
  }
  return getCloudConfig();
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

  async function request(path,{method='GET',body,form=false,local=false}={}) {
    const headers={};
    if(local)headers['X-DH-Local']='1';
    if(token)headers.Authorization='Bearer '+token;
    if(body!==undefined&&!form)headers['Content-Type']='application/json';
    let response;
    try{response=await fetch(url+'/api'+path,{
      method,headers,body:body===undefined?undefined:form?body:JSON.stringify(body)
    })}catch(e){throw new Error('No se puede acceder a FastAPI en '+url+'. ¿Está arrancado python run.py?')}
    if(!response.ok){
      let info;try{info=await response.json()}catch{}
      if(response.status===401&&!path.startsWith('/auth/'))throw new Error('Sesión caducada. Vuelve a iniciar sesión.');
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
    async localSession(){
      const result=await request('/auth/local',{method:'POST',local:true});
      persistToken(result.access_token);
      return result.user;
    },
    async health(){return request('/health')},
    async signIn(email,password){
      const result=await request('/auth/login',{method:'POST',body:{email,password}});
      persistToken(result.access_token);
      return {user:result.user,session:{user:result.user}};
    },
    async signUp(email,password,{inviteCode,displayName}={}){
      const result=await request('/auth/register',{method:'POST',
        body:{email,password,invite_code:inviteCode||null,display_name:displayName||null}});
      persistToken(result.access_token);
      return {user:result.user,session:{user:result.user}};
    },
    async signOut(){persistToken(null);},
    async me(){return request('/auth/me')},
    async setDisplayName(name){return request('/me/profile',{method:'PUT',body:{display_name:name}})},
    // Circuits (organizers)
    async saveCircuit(circuit){
      const isRemote=/^[0-9a-f-]{36}$/i.test(circuit.cloud_id||'');
      const result=await request(isRemote?'/circuits/'+circuit.cloud_id:'/circuits',{
        method:isRemote?'PUT':'POST',
        body:{name:circuit.name,points:circuit.points,sectors:circuit.sectors||[],
          weakZones:circuit.weakZones||[],gateRadius:circuit.gateRadius||18}
      });
      return result.id;
    },
    async listCircuits(){return request('/circuits')},
    async deleteCircuit(id){return request('/circuits/'+encodeURIComponent(id),{method:'DELETE'})},
    async circuitCatalog(){return request('/public/circuits')},
    // Time trial
    async tournaments(){return request('/public/tournaments')},
    async tournament(id){return request('/public/tournaments/'+encodeURIComponent(id))},
    async createTournament(body){return request('/tournaments',{method:'POST',body})},
    async deleteTournament(id){return request('/tournaments/'+encodeURIComponent(id),{method:'DELETE'})},
    async submitEntry(tournamentId,file){
      const data=new FormData();
      data.append('file',file,file.name);
      return request('/tournaments/'+encodeURIComponent(tournamentId)+'/entries',{method:'POST',body:data,form:true});
    },
    async myEntries(tournamentId){return request('/tournaments/'+encodeURIComponent(tournamentId)+'/entries/mine')},
    async tournamentEntries(tournamentId){return request('/tournaments/'+encodeURIComponent(tournamentId)+'/entries')},
    async reviewEntry(id,decision,note){
      return request('/entries/'+encodeURIComponent(id)+'/review',{method:'POST',body:{decision,note:note||null}});
    },
    async entryFile(id){return request('/entries/'+encodeURIComponent(id)+'/file')},
    // Training
    async uploadTrainingRoute(file){
      const data=new FormData();
      data.append('file',file,file.name);
      return request('/training/routes',{method:'POST',body:data,form:true});
    },
    async trainingRoutes(){return request('/training/routes')},
    async deleteTrainingRoute(id){return request('/training/routes/'+encodeURIComponent(id),{method:'DELETE'})},
    async trainingRuns(circuitId){return request('/training/runs'+(circuitId?'?circuit_id='+encodeURIComponent(circuitId):''))},
    async trainingRun(id){return request('/training/runs/'+encodeURIComponent(id))}
  };
}
