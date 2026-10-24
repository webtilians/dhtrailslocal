// DH Trails Local v0.8 — browser client for the FastAPI server.
// Same-origin when the page is served by FastAPI (this PC or the public server).
import {T, tServer} from './i18n.mjs';
const ENDPOINT_CONFIG='dhtrailslocal:api:url';

export function validateApiUrl(raw) {
  const url=new URL(String(raw||'').trim());
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&local)) {
    throw new Error(T('El servidor debe usar HTTPS, salvo localhost/127.0.0.1 en desarrollo.'));
  }
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!=='') {
    throw new Error(T('Introduce solo la URL del servidor, sin rutas ni credenciales.'));
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
    })}catch(e){throw new Error(T('No se puede acceder a FastAPI en {url}. ¿Está arrancado python run.py?',{url}))}
    if(!response.ok){
      let info;try{info=await response.json()}catch{}
      if(response.status===401&&!path.startsWith('/auth/'))throw new Error(T('Sesión caducada. Vuelve a iniciar sesión.'));
      // The server writes in Spanish: its messages in the page's language.
      const detail=info?.detail;
      // A form the server refused (FastAPI's 422): what is wrong in each field.
      if(Array.isArray(detail)&&detail.length&&detail.every(d=>typeof d?.msg==='string'))
        throw new Error(detail.map(d=>tServer(d.msg.replace(/^Value error, /,''))).join('; '));
      throw new Error(typeof detail==='string'?tServer(detail):JSON.stringify(detail||response.statusText));
    }
    if(response.status===204)return null;
    if(path.endsWith('/file'))return response.blob();
    return response.json();
  }
  function persistToken(next) {
    token=next;
    try{if(token)localStorage.setItem(tokenKey,token);else localStorage.removeItem(tokenKey)}catch{}
  }
  // When the session was issued, in ms (0 if unknown): it is renewed once a day while the app is used.
  function issuedAt() {
    try{return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).iat*1000||0}
    catch{return 0}
  }
  async function user() {
    if(!token)return null;
    let me;
    try{me=await request('/auth/me')}
    catch{persistToken(null);return null}
    if(Date.now()-issuedAt()>24*3600*1000){
      try{persistToken((await request('/auth/refresh',{method:'POST'})).access_token)}catch{}
    }
    return me;
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
    // A forgotten password: a link by mail, then a new password from that link (which also signs in)
    async forgotPassword(email){return request('/auth/forgot',{method:'POST',body:{email}})},
    async resetPassword(resetToken,password){
      const result=await request('/auth/reset',{method:'POST',body:{token:resetToken,password}});
      persistToken(result.access_token);
      return result.user;
    },
    async signUp(email,password,{inviteCode,displayName}={}){
      const result=await request('/auth/register',{method:'POST',
        body:{email,password,invite_code:inviteCode||null,display_name:displayName||null}});
      persistToken(result.access_token);
      return {user:result.user,session:{user:result.user}};
    },
    async signOut(){persistToken(null);},
    // The session, for the app's native side when it uploads a file itself (the phone's sensors)
    sessionToken(){return token},
    async me(){return request('/auth/me')},
    async setDisplayName(name){return request('/me/profile',{method:'PUT',body:{display_name:name}})},
    // Circuits: any rider draws them; organizers approve them for tournaments
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
    async approveCircuit(id){return request('/circuits/'+encodeURIComponent(id)+'/approve',{method:'POST'})},
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
    // The file of one of the rider's routes, as uploaded (a Blob)
    async activityFile(id){return request('/activities/'+encodeURIComponent(id)+'/file')},
    async trainingRuns(circuitId,{friends=false}={}){
      const query=[circuitId?'circuit_id='+encodeURIComponent(circuitId):'',friends?'friends=true':''].filter(Boolean).join('&');
      return request('/training/runs'+(query?'?'+query:''));
    },
    async trainingRun(id){return request('/training/runs/'+encodeURIComponent(id))},
    async trainingNotes(circuitId){return request('/training/notes?circuit_id='+encodeURIComponent(circuitId))},
    async addTrainingNote(note){return request('/training/notes',{method:'POST',body:note})},
    async deleteTrainingNote(id){return request('/training/notes/'+encodeURIComponent(id),{method:'DELETE'})},
    // Friends share their training runs with each other
    async friends(){return request('/friends')},
    async addFriend(name){return request('/friends',{method:'POST',body:{display_name:name}})},
    async acceptFriend(pilotId){return request('/friends/'+encodeURIComponent(pilotId)+'/accept',{method:'POST'})},
    async removeFriend(pilotId){return request('/friends/'+encodeURIComponent(pilotId),{method:'DELETE'})},
    // Circuit records: every rider's best time on each circuit, and who holds its hot seat
    async records({friends=false}={}){return request('/records'+(friends?'?friends=true':''))},
    async circuitRecords(id,{friends=false}={}){return request('/records/'+encodeURIComponent(id)+(friends?'?friends=true':''))},
    async showInRecords(visible){return request('/records/me',{method:'PUT',body:{visible}})}
  };
}
