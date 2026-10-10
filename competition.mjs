import {discoverApi, createCloudApi} from './api-client.mjs';
import {compareSectorTimes, formatMs, formatDelta} from './sector-comparison.mjs';
import {monthLabel, sectorLabels, standingsRows, idealMs, asAttempt, REVIEW_LABELS} from './competition-core.mjs';

const $ = id => document.getElementById(id);
const map = L.map('map', {zoomControl:true}).setView([36.76,-4.46],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);

let api=null, me=null, circuits=[], board=null, artwork=[];
const status=(message,type='')=>{const el=$('status');el.textContent=message;el.className='status '+type;};
const account=(message,type='')=>{const el=$('account');el.textContent=message;el.className='save-feedback '+type;};
function node(tag,props={},children=[]) {
  const el=Object.assign(document.createElement(tag),props);
  el.append(...children);
  return el;
}
function placeholder(text){return node('p',{className:'placeholder',textContent:text});}
const selectedCircuit=()=>circuits.find(c=>c.id===$('circuitSelect').value)||null;
const dateText=iso=>iso?new Date(iso).toLocaleDateString('es-ES',{day:'numeric',month:'short'}):'—';

function drawCircuit(circuit, comparison=null) {
  artwork.forEach(layer=>map.removeLayer(layer));artwork=[];
  if(!circuit)return;
  const pts=circuit.points.map(p=>[p[0],p[1]]);
  const add=layer=>{layer.addTo(map);artwork.push(layer);return layer;};
  add(L.polyline(pts,{color:'#229fff',weight:6,opacity:.9}));
  if(comparison){
    const colors={faster:'#1ddd93',slower:'#ff6275',equal:'#85caff',unknown:'#9facc0'};
    for(const s of comparison.sectors)
      add(L.polyline(pts.slice(s.from,s.to+1),{color:colors[s.status],weight:9,opacity:.95}))
        .bindTooltip('S'+(s.index+1)+' · '+formatDelta(s.deltaMs),{sticky:true,direction:'top'});
  }
  const gate=(p,color,label)=>add(L.circleMarker(p,{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:1})).bindTooltip(label);
  gate(pts[0],'#1fd68c','Salida');
  circuit.sectors.forEach((s,i)=>gate(pts[s.index],'#f2c34f','Puerta '+(i+1)+(s.name?' · '+s.name:'')));
  gate(pts.at(-1),'#f85d74','Meta');
  if(!comparison)map.fitBounds(L.latLngBounds(pts),{padding:[30,30]});
}

function renderStandings() {
  const circuit=selectedCircuit(), out=$('standings');
  out.replaceChildren();
  const rows=standingsRows(board);
  $('statRiders').textContent=board?String(rows.length):'—';
  $('statBest').textContent=rows.length?formatMs(rows[0].elapsed_ms):'—';
  $('statIdeal').textContent=formatMs(idealMs(board));
  $('boardTag').textContent=board?monthLabel(board.month).toUpperCase():'—';
  if(!circuit||!board)return out.append(node('p',{className:'board-empty',textContent:'Elige un circuito para ver la clasificación.'}));
  if(!rows.length)return out.append(node('p',{className:'board-empty',
    textContent:'Todavía no hay tiempos aprobados en '+monthLabel(board.month)+'. Sube tu bajada y sé el primero.'}));
  const labels=sectorLabels(circuit);
  const head=node('tr',{},['Pos','Piloto','Tiempo','Dif.',...labels.map(l=>l.short)].map((text,i)=>
    node('th',{textContent:text,title:i>3?labels[i-4].long:''})));
  const body=node('tbody');
  for(const row of rows){
    const tr=node('tr',{tabIndex:0,title:'Ver en el mapa dónde gana o pierde tiempo frente al líder'},[
      node('td',{className:'pos',textContent:String(row.rank)}),
      node('td',{textContent:row.pilot}),
      node('td',{className:'time',textContent:formatMs(row.elapsed_ms)}),
      node('td',{className:row.gap_ms===0?'lead':'gap',textContent:row.gapText}),
      ...row.sectors.map((s,i)=>node('td',{className:s.best?'best':'',textContent:formatMs(s.ms),
        title:labels[i].long+(s.best?' · mejor parcial del mes':'')}))
    ]);
    const pick=()=>{
      body.querySelectorAll('tr').forEach(r=>r.classList.toggle('selected',r===tr));
      compareWithLeader(circuit,rows[0],row);
    };
    tr.addEventListener('click',pick);
    tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}});
    body.append(tr);
  }
  out.append(node('table',{className:'standings'},[node('thead',{},[head]),body]));
}

function compareWithLeader(circuit,leader,row) {
  if(row.entry_id===leader.entry_id){
    drawCircuit(circuit);
    return status(row.pilot+' lidera '+monthLabel(board.month)+' con '+formatMs(row.elapsed_ms)+'.','success');
  }
  try{
    const comparison=compareSectorTimes(circuit,asAttempt(leader,circuit.id),asAttempt(row,circuit.id));
    drawCircuit(circuit,comparison);
    const worst=comparison.sectors.filter(s=>s.deltaMs!==null).sort((a,b)=>b.deltaMs-a.deltaMs)[0];
    status(row.pilot+' frente a '+leader.pilot+': '+formatDelta(comparison.totalDeltaMs)+
      (worst&&worst.deltaMs>0?'. Donde más pierde: S'+(worst.index+1)+' ('+formatDelta(worst.deltaMs)+').':'.'),'success');
  }catch(err){status(err.message,'error')}
}

async function loadBoard(month) {
  const circuit=selectedCircuit();
  board=null;
  if(circuit){
    try{board=await api.leaderboard(circuit.id,month);}
    catch(err){status('No se pudo leer la clasificación: '+err.message,'error');}
  }
  const select=$('monthSelect');
  select.replaceChildren(...(board?.months||[]).map(m=>node('option',{value:m,
    textContent:monthLabel(m)+(m===board.current_month?' · en curso':'')})));
  if(board)select.value=board.month;
  drawCircuit(circuit);
  renderStandings();
}

async function loadCircuits() {
  const keep=$('circuitSelect').value;
  circuits=await api.publicCircuits();
  const select=$('circuitSelect');
  select.replaceChildren(...(circuits.length?circuits.map(c=>node('option',{value:c.id,textContent:c.name})):
    [node('option',{value:'',textContent:'La organización aún no ha publicado circuitos'})]));
  if(circuits.some(c=>c.id===keep))select.value=keep;
  await loadBoard();
}

function entryBox(entry, actions=[]) {
  const ok=entry.gps_status==='compatible';
  const box=node('div',{className:'attempt'},[
    node('div',{className:'attempt-head'},[
      node('div',{},[node('div',{className:'caps',textContent:(entry.pilot||'Piloto')+' · '+entry.circuit_name+' · '+dateText(entry.started_at)}),
        node('strong',{textContent:formatMs(entry.elapsed_ms)})]),
      node('span',{className:'badge'+(ok?' ok':''),textContent:ok?'Traza compatible':'Revisión GPS'})])
  ]);
  if(entry.issues)box.append(node('div',{className:'issue',textContent:entry.issues}));
  const labels=entry.sector_splits_ms.map((_,i)=>'S'+(i+1));
  box.append(node('div',{className:'splits'},entry.sector_splits_ms.map((ms,i)=>
    node('div',{className:'split'},[node('span',{textContent:labels[i]}),node('b',{textContent:formatMs(ms)})]))));
  if(actions.length)box.append(node('div',{className:'entry-actions'},actions));
  return box;
}

async function refreshMine() {
  const list=$('myEntries');
  const entries=await api.myEntries();
  list.replaceChildren(...(entries.length?entries.map(e=>{
    const label=REVIEW_LABELS[e.review_status]||e.review_status;
    return node('div',{className:'item'},[
      node('span',{textContent:e.circuit_name+' · '+dateText(e.started_at)+' · '+formatMs(e.elapsed_ms)+(e.review_note?' · '+e.review_note:'')}),
      node('span',{className:'badge'+(e.review_status==='approved'?' ok':e.review_status==='rejected'?' bad':''),textContent:label})]);
  }):[placeholder('Todavía no has enviado bajadas.')]));
}

async function downloadEntry(entry) {
  const blob=await api.entryFile(entry.id);
  const url=URL.createObjectURL(blob);
  try{const a=node('a',{href:url,download:entry.source_filename||'bajada.gpx'});document.body.append(a);a.click();a.remove();}
  finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
}

async function refreshOrganizer() {
  if(!me?.organizer)return;
  const queue=await api.reviewQueue('pending');
  $('pendingCount').textContent=String(queue.length);
  $('reviewList').replaceChildren(...(queue.length?queue.map(entry=>{
    const note=node('input',{maxLength:300,placeholder:'Nota para el piloto (opcional)'});
    const decide=decision=>async()=>{
      try{
        await api.reviewEntry(entry.id,decision,note.value.trim());
        status('Bajada de '+entry.pilot+(decision==='approved'?' aprobada.':' rechazada.'),'success');
        await Promise.all([refreshOrganizer(),loadBoard($('monthSelect').value||undefined)]);
      }catch(err){status('No se pudo guardar la revisión: '+err.message,'error')}
    };
    const button=(text,cls,fn)=>{const b=node('button',{type:'button',className:'btn '+cls,textContent:text});b.addEventListener('click',fn);return b;};
    return entryBox(entry,[note,button('Aprobar','primary',decide('approved')),button('Rechazar','outline',decide('rejected')),
      button('GPX','outline',()=>downloadEntry(entry).catch(err=>status(err.message,'error')))]);
  }):[placeholder('No hay bajadas pendientes.')]));
  const own=(await api.listCircuits()).filter(c=>!c.published);
  $('publishSelect').replaceChildren(...(own.length?own.map(c=>node('option',{value:c.id,textContent:c.name})):
    [node('option',{value:'',textContent:'Sin circuitos por publicar: guárdalos antes desde el editor'})]));
}

function reflectUser() {
  $('authPanel').hidden=!api||!!me;
  $('riderPanel').hidden=!me;
  $('organizerPanel').hidden=!me?.organizer;
  $('logout').hidden=!!me?.local;
  $('accountTag').textContent=me?.organizer?'ORGANIZACIÓN':'PILOTOS';
  if(!me)return;
  $('riderName').textContent=me.display_name||'elige tu nombre para aparecer en la clasificación';
  $('displayName').value=me.display_name||'';
}

async function signedIn(user,message) {
  me=user;
  reflectUser();
  account(message,'success');
  await Promise.all([refreshMine(),refreshOrganizer()]);
}

$('circuitSelect').addEventListener('change',()=>loadBoard());
$('monthSelect').addEventListener('change',e=>loadBoard(e.target.value));
$('login').addEventListener('click',async()=>{
  try{const {user}=await api.signIn($('email').value.trim(),$('password').value);$('password').value='';
    await signedIn(user,'Sesión iniciada. Sube tu bajada cuando quieras.');}
  catch(err){account('No se pudo entrar: '+err.message,'error')}
});
$('signup').addEventListener('click',async()=>{
  try{
    if($('password').value.length<8)throw Error('Utiliza al menos 8 caracteres de contraseña.');
    const {user}=await api.signUp($('email').value.trim(),$('password').value,$('invite').value.trim());
    $('password').value='';
    await signedIn(user,'Cuenta creada. Elige tu nombre de piloto para aparecer en la clasificación.');
  }catch(err){account('No se pudo crear la cuenta: '+err.message,'error')}
});
$('logout').addEventListener('click',async()=>{await api.signOut();me=null;reflectUser();account('Sesión cerrada.');});
$('saveName').addEventListener('click',async()=>{
  try{me={...me,...await api.setDisplayName($('displayName').value)};reflectUser();account('Nombre guardado: '+me.display_name+'.','success');}
  catch(err){account('No se pudo guardar el nombre: '+err.message,'error')}
});
$('entryFile').addEventListener('change',e=>{
  const file=e.target.files[0];
  $('entryFileName').textContent=file?file.name+' · '+Math.round(file.size/1024)+' KB':'GPX / TCX con marcas de tiempo';
});
$('submitEntry').addEventListener('click',async()=>{
  const circuit=selectedCircuit(),file=$('entryFile').files[0];
  if(!circuit)return account('Elige primero el circuito en el que has bajado.','error');
  if(!file)return account('Elige el archivo GPX o TCX de tu bajada.','error');
  const btn=$('submitEntry');btn.disabled=true;account('Calculando tu tiempo en el servidor…');
  try{
    const entry=await api.submitEntry(circuit.id,file);
    $('entryResult').replaceChildren(entryBox(entry));
    account('Bajada recibida: '+formatMs(entry.elapsed_ms)+'. Entrará en la clasificación cuando la organización la apruebe.','success');
    $('entryFile').value='';$('entryFileName').textContent='GPX / TCX con marcas de tiempo';
    await Promise.all([refreshMine(),refreshOrganizer()]);
  }catch(err){account('No se ha aceptado la bajada: '+err.message,'error')}
  finally{btn.disabled=false}
});
$('publishCircuit').addEventListener('click',async()=>{
  const select=$('publishSelect'),id=select.value;
  if(!id)return status('No hay ningún circuito guardado sin publicar.','error');
  const name=select.selectedOptions[0].textContent;
  if(!window.confirm('¿Publicar «'+name+'» en la competición?\nSu trazado y sus sectores quedarán fijos: no podrás cambiarlos ni borrarlo.'))return;
  try{await api.publishCircuit(id);await Promise.all([loadCircuits(),refreshOrganizer()]);status('«'+name+'» ya está en la competición.','success');}
  catch(err){status('No se pudo publicar: '+err.message,'error')}
});

async function start() {
  const config=await discoverApi();
  if(!config){
    account('La competición funciona desde el servidor de DH Trails: abre esta página en su dirección.','error');
    return;
  }
  api=createCloudApi(config);
  const health=await api.health();
  me=health.local_mode?await api.localSession():await api.user();
  reflectUser();
  if(me)await signedIn(me,me.local?'Modo local: eres la organización de esta competición en tu PC.':'Sesión iniciada como '+(me.display_name||me.email)+'.');
  else account('Entra o crea tu cuenta para enviar bajadas. La clasificación es pública.');
  await loadCircuits();
}
start().catch(err=>{account('Error de conexión: '+err.message,'error');status(err.message,'error')});
