import {parseGps, nearestTrackIndex, buildCircuit, distanceSeries, summarize, detectAttempts, referenceStops, withoutStops, readCircuitCollection, writeCircuitCollection} from './gps-engine.mjs';
import {discoverApi, setLocalCloudConfig, createCloudApi} from './api-client.mjs';
import {compareSectorTimes, formatMs, formatDelta} from './sector-comparison.mjs';

const $ = id => document.getElementById(id);
const map = L.map('map', {zoomControl:true}).setView([36.76,-4.46],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);

const STORAGE = 'dhtrailslocal:v0.2:circuits';
let storageProblem = null;
let circuits = readLibrary();
let selectedId = '';
let source = null, attemptRoute = null, attemptFileBlob = null, attemptSourceName = null, activeTool = '';
let draft = blankDraft(), history = [], pendingZone = null;
let artwork = [];
let attempts = [];
let cloudApi=null,cloudUser=null;
const resetArt = () => {artwork.forEach(layer => map.removeLayer(layer)); artwork = [];};
const add = layer => {layer.addTo(map); artwork.push(layer);return layer;};
const status = (message, type='') => {const el=$('status');el.textContent=message;el.className='status ' + type;};
const point = p => Array.isArray(p) ? [p[0],p[1]] : [p.lat,p.lon];
const coordinates = p => ({lat:point(p)[0],lon:point(p)[1]});
function blankDraft(){return {start:null,finish:null,sectors:[],zones:[]};}
function snapshot(){history.push(JSON.stringify(draft));if(history.length>30)history.shift();}
function readLibrary(){
  try {return readCircuitCollection(localStorage, STORAGE);}
  catch(e) {storageProblem=e?.message||'Acceso al almacenamiento bloqueado';return [];}
}
function saveLibrary(nextCircuits){
  try {writeCircuitCollection(localStorage,STORAGE,nextCircuits);}
  catch(e){throw new Error('El navegador no ha podido guardar el circuito ('+(e?.message||'almacenamiento bloqueado')+').');}
}
function selectedCircuit(){return circuits.find(c=>c.id===selectedId)||null;}
function reportSave(message, type) {
  const feedback=$('saveFeedback');feedback.textContent=message;
  feedback.className='save-feedback '+(type||'');
  status(message,type);
  feedback.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function downloadCircuit(c) {
  const blob = new Blob([JSON.stringify(c,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  try {
    const a=document.createElement('a');
    a.href=url;
    a.download=c.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9-_]+/gi,'-')+'.dhtrails.json';
    document.body.append(a);a.click();a.remove();
    return true;
  }finally{setTimeout(()=>URL.revokeObjectURL(url),30000)}
}
function fillLibrary() {
  const select=$('circuitSelect');select.replaceChildren();
  if(!circuits.length){const opt=document.createElement('option');opt.textContent='Aún no hay circuitos';opt.value='';select.appendChild(opt);selectedId='';showCircuitState();return;}
  circuits.forEach(c=>{const opt=document.createElement('option');opt.value=c.id;opt.textContent=c.name+(c.published?' · publicado':'');select.appendChild(opt)});
  if(!circuits.some(c=>c.id===selectedId))selectedId=circuits[0].id;
  select.value=selectedId;
  showCircuitState();
}
function showTool(t) {
  activeTool=t;
  document.querySelectorAll('[data-tool]').forEach(btn=>btn.classList.toggle('active',btn.dataset.tool===t));
  const labels={start:'Haz clic en la salida',finish:'Haz clic en la meta',sector:'Haz clic en un límite de sector',zone:pendingZone===null?'Marca inicio de cobertura débil':'Marca final de cobertura débil'};
  $('toolLabel').textContent=labels[t]||'Selecciona una herramienta';
}
async function readFile(file) {
  if(!file)throw Error('Selecciona un archivo.');
  if(file.size>20*1024*1024)throw Error('El archivo supera los 20 MB.');
  const ext=file.name.split('.').at(-1).toLowerCase();
  if(ext!=='gpx'&&ext!=='tcx')throw Error('Solo admitimos GPX y TCX por ahora.');
  return parseGps(await file.text(),ext);
}
function showStats(pts, sectors=0) {
  if(!pts?.length){$('statDistance').textContent='—';$('statDown').textContent='—';$('statSectors').textContent='—';return;}
  const meta=summarize(pts);
  $('statDistance').textContent=(meta.meters/1000).toFixed(2)+' km';
  $('statDown').textContent=Math.round(meta.descent)+' m';
  $('statSectors').textContent=String(sectors);
}
function marker(latlon, kind, name, onDrop) {
  const colors={start:'#1fd68c',finish:'#f85d74',sector:'#f2c34f',zone:'#ff924f'};
  const glyph={start:'S',finish:'M',sector:'◆',zone:'!'}[kind];
  const html='<div style="height:28px;width:28px;border-radius:50%;display:grid;place-items:center;border:2px solid white;background:'+colors[kind]+';box-shadow:0 2px 10px #000b;color:#081a2a;font-weight:900;font-size:13px">'+glyph+'</div>';
  const m=add(L.marker(latlon,{draggable:!!onDrop,bubblingMouseEvents:false,icon:L.divIcon({html,className:'',iconSize:[28,28],iconAnchor:[14,14]})}));
  if(name)m.bindTooltip(name,{direction:'top',offset:[0,-12]});
  if(onDrop)m.on('dragend',()=>onDrop(m.getLatLng()));
  return m;
}
function drawLine(pts, style){if(pts.length<2)return;return add(L.polyline(pts.map(point),style));}
function paintZones(ref, zones, offset=0){
  zones.forEach((z,i)=>{const segment=ref.slice(z.from-offset,z.to-offset+1);if(segment.length>1)drawLine(segment,{color:'#ff954a',weight:7,opacity:.94,dashArray:'8 8'});
    const a=ref[z.from-offset],b=ref[z.to-offset];if(a)marker(point(a),'zone','GPS débil · inicio');if(b)marker(point(b),'zone','GPS débil · final');
  });
}
function refreshDraft(){
  const s=draft.start,f=draft.finish;
  $('sectorCount').textContent=draft.sectors.length+1;
  $('zoneCount').textContent=draft.zones.length+(pendingZone!==null?1:0);
  const list=$('gatesList');list.replaceChildren();
  if(s===null){const p=document.createElement('p');p.className='placeholder';p.textContent='Marca la salida y después los sectores y la meta.';list.append(p);}
  else{
    insertRow(list,'Salida · punto '+s,null);
    draft.sectors.forEach((g,i)=>{
      const row=document.createElement('div');row.className='item';
      const inp=document.createElement('input');inp.value=g.name;inp.maxLength=70;inp.setAttribute('aria-label','Nombre del sector '+(i+1));
      inp.addEventListener('change',()=>{draft.sectors[i].name=inp.value.trim()||'Sector '+(i+1)});
      const remove=document.createElement('button');remove.textContent='✕';remove.title='Quitar este límite';
      remove.addEventListener('click',()=>{snapshot();draft.sectors.splice(i,1);redraw()});
      row.append(inp,remove);list.append(row);
    });
    insertRow(list,f===null?'Meta · pendiente':'Meta · punto '+f,null);
  }
  const zones=$('zonesList');zones.replaceChildren();
  if(!draft.zones.length&&pendingZone===null){const p=document.createElement('p');p.className='placeholder';p.textContent='Marca dos puntos para indicar la zona donde suele fallar la cobertura GPS.';zones.append(p);}
  draft.zones.forEach((z,i)=>{
    const row=document.createElement('div');row.className='item';const inp=document.createElement('input');
    inp.maxLength=70;inp.value=z.name;inp.setAttribute('aria-label','Nombre de zona débil '+(i+1));
    inp.addEventListener('change',()=>{draft.zones[i].name=inp.value.trim()||'Zona GPS débil'});
    const remove=document.createElement('button');remove.textContent='✕';remove.title='Eliminar zona GPS débil';
    remove.addEventListener('click',()=>{snapshot();draft.zones.splice(i,1);redraw()});
    row.append(inp,remove);zones.append(row);
  });
  if(pendingZone!==null)insertRow(zones,'Inicio en punto '+pendingZone+' · marca el final',null);
  if(s!==null&&f!==null&&source)showStats(source.slice(s,f+1),draft.sectors.length+1);
  else if(source)showStats(source,draft.sectors.length+1);
}
function insertRow(parent,label,button){const row=document.createElement('div');row.className='item';row.textContent=label;if(button)row.appendChild(button);parent.append(row);}
function redraw(){
  resetArt();
  if(!source){refreshDraft();return;}
  drawLine(source,{color:'#427695',weight:3,opacity:.58});
  const {start,finish,sectors,zones}=draft;
  if(start!==null&&finish!==null)drawLine(source.slice(start,finish+1),{color:'#1aa5ff',weight:6,opacity:.98});
  else drawLine(source,{color:'#169dff',weight:4,opacity:.85});
  function moveGate(kind,i,latlng){
    const snap=nearestTrackIndex(source,latlng);
    if(snap.meters>35){status('Acércate a la ruta: el marcador debe quedar a menos de 35 m de la línea GPS.','error');redraw();return;}
    const boundary=draft.sectors.map(v=>v.index);
    if(kind==='start'&&(draft.finish!==null&&snap.index>=draft.finish-15||boundary.some(j=>j<=snap.index+1))){status('La salida debe quedar antes de todos los límites y de la meta.','error');redraw();return;}
    if(kind==='finish'&&(snap.index<=draft.start+15||boundary.some(j=>j>=snap.index-1))){status('La meta debe quedar después de la salida y todos los sectores.','error');redraw();return;}
    if(kind==='sector'&&(snap.index<=draft.start||draft.finish!==null&&snap.index>=draft.finish||boundary.some((j,n)=>n!==i&&Math.abs(j-snap.index)<2))){status('El límite debe estar dentro del circuito, sin duplicados.','error');redraw();return;}
    snapshot();
    if(kind==='sector'){draft.sectors[i].index=snap.index;draft.sectors.sort((a,b)=>a.index-b.index)}
    else draft[kind]=snap.index;
    redraw();
  }
  if(start!==null)marker(point(source[start]),'start','Salida · arrastra para ajustar',loc=>moveGate('start',0,loc));
  if(finish!==null)marker(point(source[finish]),'finish','Meta · arrastra para ajustar',loc=>moveGate('finish',0,loc));
  sectors.forEach((g,i)=>marker(point(source[g.index]),'sector','Límite de sector '+(i+1)+' · arrastra',loc=>moveGate('sector',i,loc)));
  paintZones(source,zones);
  if(pendingZone!==null)marker(point(source[pendingZone]),'zone','Inicio de zona pendiente');
  refreshDraft();
  $('mapTag').textContent='RUTA DE REFERENCIA';
}
function setPoint(index){
  if(!source)return status('Importa primero una ruta GPS.','error');
  if(activeTool==='start'){
    if(draft.finish!==null&&index>=draft.finish-15)return status('La salida debe quedar antes de la meta.','error');
    if(draft.sectors.some(g=>g.index<=index+1))return status('La salida debe quedar antes de los límites de sectores.','error');
    snapshot();draft.start=index;
  }else if(activeTool==='finish'){
    if(draft.start===null)return status('Primero marca la salida.','error');
    if(index<=draft.start+15||draft.sectors.some(g=>g.index>=index-1))return status('Coloca la meta después de la salida y los sectores.','error');
    snapshot();draft.finish=index;
  }else if(activeTool==='sector'){
    if(draft.start===null)return status('Primero marca la salida.','error');
    if(index<=draft.start+1||draft.finish!==null&&index>=draft.finish-1||draft.sectors.some(g=>Math.abs(g.index-index)<2))return status('El sector debe quedar entre salida y meta, sin solapar límites.','error');
    snapshot();draft.sectors.push({index,name:'Sector '+(draft.sectors.length+1)});draft.sectors.sort((a,b)=>a.index-b.index);
  }else if(activeTool==='zone'){
    if(draft.start===null||draft.finish===null)return status('Marca antes la salida y la meta.','error');
    if(index<draft.start||index>draft.finish)return status('La zona débil debe estar dentro del circuito.','error');
    if(pendingZone===null){pendingZone=index;showTool('zone');}
    else{if(index<=pendingZone)return status('El final de la zona debe estar después del inicio.','error');
      snapshot();draft.zones.push({from:pendingZone,to:index,name:'Cobertura débil '+(draft.zones.length+1)});pendingZone=null;showTool('zone');
    }
  }else return status('Selecciona primero una herramienta de edición.','error');
  redraw();
}
map.on('click',event=>{
  if(!source)return;
  const nearest=nearestTrackIndex(source,event.latlng);
  if(nearest.meters>35)return status('Haz clic más cerca del recorrido GPS (tolerancia visual 35 m).','error');
  setPoint(nearest.index);
});
document.querySelectorAll('[data-tool]').forEach(btn=>btn.addEventListener('click',()=>{if(!source)return status('Primero importa una ruta.','error');if(activeTool!==btn.dataset.tool)pendingZone=null;showTool(btn.dataset.tool);redraw()}));
$('undo').addEventListener('click',()=>{if(!history.length)return status('No hay cambios por deshacer.');draft=JSON.parse(history.pop());pendingZone=null;redraw();status('Último cambio deshecho.')});
$('routeFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{source=await readFile(file);draft=blankDraft();history=[];pendingZone=null;attemptRoute=null;
    $('sourceFileName').textContent=file.name;redraw();map.fitBounds(L.latLngBounds(source.map(point)),{padding:[25,25]});showTool('start');
    status('Ruta cargada ('+source.length+' puntos). Ahora marca la salida sobre el mapa.','success');
  }catch(err){status(err.message,'error')}
});
$('saveCircuit').addEventListener('click',async()=>{
  let circuit, stopNote='';
  try {
    if(!source)throw Error('Importa primero una ruta GPX/TCX para crear un circuito.');
    if(draft.start===null||draft.finish===null)throw Error('Debes marcar la salida y la meta antes de guardar.');
    if(!referenceIsClean())return;
    // Stops never belong to the circuit line: they are cut out before building it.
    const clean=withoutStops(source,draft.start,draft.finish,draft.sectors,draft.zones);
    if(clean.seconds>=30)stopNote=' Se ha quitado del trazado una parada de '+(clean.seconds/60).toFixed(1).replace('.',',')+' min.';
    circuit=buildCircuit($('circuitName').value,clean.route,clean.start,clean.finish,clean.sectors,clean.zones);
  }catch(err){reportSave('No se ha guardado: '+err.message,'error');return;}
  const next=[...circuits,circuit];
  try {
    saveLibrary(next);
  }catch(err){
    // Local quota/full storage MUST NOT prevent remote saving.
    let backup=false;
    try{backup=downloadCircuit(circuit)}catch(e){}
    if(cloudApi && cloudUser?.organizer){
      try{
        circuit.cloud_id=await cloudApi.saveCircuit(circuit);
        circuits=next;selectedId=circuit.id;fillLibrary();viewCircuit(circuit);
        reportSave('Circuito «'+circuit.name+'» guardado en el servidor PostgreSQL, pero no en almacenamiento local ('+err.message+'). '+(backup?'Conserva la copia JSON de Descargas.':'Exporta una copia JSON.'),'success');
        cloudMessage('Guardado en FastAPI confirmado. Usa Recuperar mis circuitos para volver a cargarlo en otro navegador.','success');
        return;
      }catch(cloudErr){
        cloudMessage('Tampoco se pudo guardar en la base de datos: '+cloudErr.message,'error');
      }
    }
    reportSave('No se ha podido guardar en este navegador. '+err.message+
      (backup?' Se ha solicitado la descarga JSON; comprueba Descargas.':' Conserva esta pestaña mientras exportas una copia JSON.'),'error');
    return;
  }
  circuits=next;selectedId=circuit.id;fillLibrary();
  let backup=false;
  try{backup=downloadCircuit(circuit)}catch(e){/* circuit is already stored */}
  try{viewCircuit(circuit)}catch(err){
    reportSave('Circuito guardado y verificado en este navegador, pero hubo un error al mostrarlo: '+err.message,'error');
    return;
  }
  reportSave('Circuito «'+circuit.name+'» guardado en este navegador ('+circuits.length+
    ' en Mis circuitos). '+(backup?'Se ha solicitado una descarga JSON de seguridad.':'Exporta un JSON de seguridad.')+stopNote,'success');
  // Remote persistence is optional: never lose the local copy due to a network error.
  if(cloudApi && cloudUser?.organizer) {
    try {
      const id=await cloudApi.saveCircuit(circuit);
      circuit.cloud_id=id;
      try{saveLibrary(circuits)}catch(e){/* already safely in remote DB */}
      cloudMessage('Circuito «'+circuit.name+'» guardado también en el servidor. Para que cuente en la competición, pulsa «Publicar en la competición» en 02 Mis circuitos.','success');
      showCircuitState();
    } catch(err) {
      cloudMessage('Guardado local correcto, pero falló la sincronización: '+(err.message||err),'error');
    }
  }
});
// A watch that keeps recording while the rider stands still writes repeated points and GPS drift:
// as a reference they would draw a scribble into the circuit. Offer a run of the same file
// without stops, keeping the same gates, or keep this one if the organizer prefers.
function referenceIsClean() {
  const stopped=referenceStops(source,draft.start,draft.finish);
  if(stopped<30)return true;
  const minutes=(stopped/60).toFixed(1).replace('.',',');
  let clean=null;
  try{
    const c=withoutStops(source,draft.start,draft.finish,draft.sectors,draft.zones);
    const provisional=buildCircuit($('circuitName').value||'Provisional',c.route,c.start,c.finish,c.sectors,c.zones);
    clean=detectAttempts(source,provisional)
      .filter(a=>(a.finishIndex<draft.start||a.startIndex>draft.finish)&&a.status==='compatible'&&a.gateIndices.every(Number.isInteger)&&referenceStops(source,a.startIndex,a.finishIndex)<30)
      .sort((a,b)=>a.seconds-b.seconds)[0]||null;
  }catch{}
  // Without a clean alternative the stop is simply cut out of the line when saving.
  if(!clean)return true;
  if(!window.confirm('La bajada marcada incluye una parada de '+minutes+' min (el GPS sigue grabando mientras estás parado).'+
    '\n\nEn este mismo archivo hay otra bajada sin paradas ('+timeString(clean.seconds)+'). ¿Usarla como referencia, con las mismas puertas?'+
    '\n\nSi cancelas, se guarda la marcada quitando la parada del trazado.'))return true;
  const within=i=>nearestTrackIndex(source,coordinates(source[i]),clean.startIndex,clean.finishIndex).index;
  const names=draft.sectors.map(s=>s.name);
  snapshot();
  draft={start:clean.startIndex,finish:clean.finishIndex,
    sectors:clean.gateIndices.slice(1,-1).map((index,i)=>({index,name:names[i]})),
    zones:draft.zones.map(z=>({...z,from:within(z.from),to:within(z.to)})).filter(z=>z.to>z.from)};
  pendingZone=null;
  redraw();
  map.fitBounds(L.latLngBounds(source.slice(draft.start,draft.finish+1).map(point)),{padding:[25,25]});
  reportSave('Referencia cambiada a la bajada sin paradas. Revisa las puertas en el mapa y pulsa Guardar otra vez.','success');
  return false;
}
function viewCircuit(circuit) {
  resetArt();
  source=null;draft=blankDraft();history=[];pendingZone=null;showTool('');
  const pts=circuit.points.map(p=>[p[0],p[1]]);
  drawLine(pts,{color:'#229fff',weight:6,opacity:1});
  const ref=circuit.points;
  marker(point(ref[0]),'start','Salida');
  marker(point(ref.at(-1)),'finish','Meta');
  circuit.sectors.forEach((g,i)=>marker(point(ref[g.index]),'sector','Sector '+(i+1)));
  paintZones(ref,circuit.weakZones||[]);
  map.fitBounds(L.latLngBounds(pts),{padding:[30,30]});
  $('mapTag').textContent='CIRCUITO: '+circuit.name.toUpperCase();
  refreshDraft();
  // Saved points are [lat, lon, ele] arrays; the summary reads named fields.
  showStats(ref.map(p=>({lat:p[0],lon:p[1],ele:p[2]??null})),circuit.sectors.length+1);
  $('sectorCount').textContent=String(circuit.sectors.length+1);
  $('zoneCount').textContent=String((circuit.weakZones||[]).length);
  const gateList=$('gatesList');gateList.replaceChildren();
  insertRow(gateList,'Salida · km 0.00');
  const d=distanceSeries(ref);
  circuit.sectors.forEach((g,i)=>insertRow(gateList,(g.name||'Sector '+(i+1))+' · km '+(d[g.index]/1000).toFixed(2)));
  insertRow(gateList,'Meta · km '+(d.at(-1)/1000).toFixed(2));
  const zones=$('zonesList');zones.replaceChildren();
  (circuit.weakZones||[]).forEach(z=>insertRow(zones,(z.name||'GPS débil')+' · '+Math.round(d[z.from])+'–'+Math.round(d[z.to])+' m'));
  if(!(circuit.weakZones||[]).length){const p=document.createElement('p');p.className='placeholder';p.textContent='Este circuito no tiene zonas de cobertura débil registradas.';zones.append(p)}
}
$('circuitSelect').addEventListener('change',e=>{
  selectedId=e.target.value;
  showCircuitState();
  attemptHistory=[];
  fillHistorySelectors();
  showComparisonMessage('Circuito cambiado. Carga sus intentos guardados para comparar.');
});
$('loadCircuit').addEventListener('click',()=>{const c=selectedCircuit();if(!c)return status('No hay circuito seleccionado.','error');viewCircuit(c);status('Circuito '+c.name+' cargado. Puedes importar una actividad para detectar intentos.','success')});
// Where the selected circuit lives: only in this browser, on the server, or in the competition.
function showCircuitState(){
  const c=selectedCircuit();
  $('circuitState').textContent=!c?'':c.published?'Publicado en la competición: los pilotos ya pueden subir sus bajadas. Su trazado y sus puertas no cambian.':
    c.cloud_id?'Guardado en el servidor, todavía sin publicar.':'Guardado solo en este navegador.';
  $('publishCircuit').hidden=!c||!!c.published||!(cloudApi&&cloudUser?.organizer);
}
$('publishCircuit').addEventListener('click',async()=>{
  const c=selectedCircuit();
  if(!c||!cloudApi||!cloudUser?.organizer)return;
  if(!window.confirm('¿Publicar «'+c.name+'» en la competición?\nLos pilotos podrán subir sus bajadas. Su trazado y sus puertas quedarán fijos.'))return;
  const btn=$('publishCircuit');btn.disabled=true;
  try{
    if(!c.cloud_id)c.cloud_id=await cloudApi.saveCircuit(c);
    await cloudApi.publishCircuit(c.cloud_id);
    c.published=true;
    try{saveLibrary(circuits)}catch{}
    fillLibrary();
    status('«'+c.name+'» publicado: ya aparece en Competición y los pilotos pueden subir sus bajadas.','success');
  }catch(err){status('No se pudo publicar: '+err.message,'error')}
  finally{btn.disabled=false}
});
$('deleteCircuit').addEventListener('click',async()=>{
  const c=selectedCircuit();
  if(!c)return status('Selecciona un circuito primero.','error');
  // In the local database too, or it would come back the next time the app connects.
  const inDatabase=!!(cloudApi&&cloudUser?.organizer&&c.cloud_id);
  if(!window.confirm('¿Borrar «'+c.name+'»?\n'+(inDatabase?'Se borra de este navegador y de la base de datos, con sus intentos guardados.':'Se borra de este navegador.')+'\nEsta acción no se puede deshacer.'))return;
  try{
    if(inDatabase)await cloudApi.deleteCircuit(c.cloud_id);
    const next=circuits.filter(x=>x!==c);
    saveLibrary(next);circuits=next;selectedId='';fillLibrary();
    if(selectedCircuit())viewCircuit(selectedCircuit());else{resetArt();refreshDraft();}
    status('Circuito «'+c.name+'» borrado.','success');
  }catch(err){status('No se pudo borrar: '+err.message,'error')}
});
$('exportCircuit').addEventListener('click',()=>{
  const c=selectedCircuit();
  if(!c)return status('Selecciona un circuito primero.','error');
  try {
    downloadCircuit(c);
    status('Se ha solicitado la descarga del JSON de «'+c.name+'». Comprueba Descargas.','success');
  }catch(err){status('No se ha podido exportar: '+err.message,'error');}
});
function validateImport(c) {
  if(!c||c.version!==2||typeof c.name!=='string'||!Array.isArray(c.points)||c.points.length<16||c.points.length>12000)throw Error('El JSON no tiene un circuito v0.2 válido.');
  if(c.points.some(p=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>90||Math.abs(p[1])>180))throw Error('Coordenadas incorrectas.');
  if(!Array.isArray(c.sectors)||c.sectors.some(g=>!Number.isInteger(g.index)||g.index<=0||g.index>=c.points.length-1)||!Array.isArray(c.weakZones))throw Error('Sectores o zonas incorrectas.');
  if(c.weakZones.some(z=>!Number.isInteger(z.from)||!Number.isInteger(z.to)||z.from<0||z.to>=c.points.length||z.from>=z.to))throw Error('Zona GPS débil incorrecta.');
  c.name=c.name.slice(0,100);c.sectors=c.sectors.map(g=>({index:g.index,name:String(g.name||'Sector').slice(0,70)})).sort((a,b)=>a.index-b.index);
  c.weakZones=c.weakZones.map(z=>({from:z.from,to:z.to,name:String(z.name||'GPS débil').slice(0,70)}));
  // A copy exported from a server belongs to that server: this one starts as a new draft.
  delete c.cloud_id;delete c.published;
  c.id='dh-import-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);return c;
}
$('importCircuit').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{if(file.size>3e6)throw Error('JSON demasiado grande.');
    const circuit=validateImport(JSON.parse(await file.text()));
    const next=[...circuits,circuit];
    saveLibrary(next);circuits=next;selectedId=circuit.id;fillLibrary();viewCircuit(circuit);
    status('Circuito '+circuit.name+' importado y guardado en este navegador. Conserva el JSON original como copia de respaldo.','success');
    if(cloudApi&&cloudUser?.organizer){
      try{
        circuit.cloud_id=await cloudApi.saveCircuit(circuit);
        saveLibrary(circuits);showCircuitState();
        status('Circuito '+circuit.name+' importado y guardado en el servidor. Pulsa «Publicar en la competición» cuando quieras que cuente.','success');
      }catch(err){status('Importado en este navegador, pero no en el servidor: '+err.message,'error')}
    }
  }catch(err){status('Error al importar: '+err.message,'error')}
});
$('attemptFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{attemptRoute=await readFile(file);attemptFileBlob=file;attemptSourceName=file.name;$('attemptFileName').textContent=file.name+' · '+attemptRoute.length+' puntos';
    status('Actividad cargada. Pulsa Detectar intentos.','success');
  }catch(err){status('Error al cargar actividad: '+err.message,'error')}
});
function timeString(seconds){
  if(seconds===null||!Number.isFinite(seconds))return 'Sin tiempo';
  const total=Math.max(0,seconds);
  return String(Math.floor(total/60)).padStart(2,'0')+':'+String(Math.floor(total%60)).padStart(2,'0')+'.'+Math.floor((total%1)*10);
}
function focusAttempt(n) {
  const c=selectedCircuit(),attempt=attempts[n];
  if(!c||!attempt||!attemptRoute)return;
  viewCircuit(c); // Repaint reference, but retain the loaded attempt data.
  const slice=attemptRoute.slice(attempt.startIndex,attempt.finishIndex+1);
  drawLine(slice,{color:'#68ebff',weight:4,opacity:.95});
  $('mapTag').textContent='INTENTO '+(n+1)+' · '+c.name.toUpperCase();
  map.fitBounds(L.latLngBounds(slice.map(point)),{padding:[35,35]});
}
$('match').addEventListener('click',()=>{
  const c=selectedCircuit();
  if(!c)return status('Primero guarda o importa un circuito y selecciónalo.','error');
  if(!attemptRoute)return status('Importa una actividad del piloto antes de detectar intentos.','error');
  try{
    attempts=detectAttempts(attemptRoute,c);const results=$('results');results.replaceChildren();
    if(!attempts.length){const p=document.createElement('p');p.className='placeholder';p.textContent='No se ha encontrado un paso completo entre la salida y la meta. Prueba con otro GPX o revisa las puertas del circuito.';results.append(p);
      viewCircuit(c);status('Sin intentos detectados. No se ha inventado ningún tiempo.');return;}
    attempts.forEach((a,i)=>{
      const box=document.createElement('div');box.className='attempt';
      const head=document.createElement('div');head.className='attempt-head';
      const left=document.createElement('div');const title=document.createElement('div');title.textContent='INTENTO '+(i+1);title.className='caps';
      const value=document.createElement('strong');value.textContent=timeString(a.seconds);left.append(title,value);
      const badge=document.createElement('span');badge.className='badge'+(a.status==='compatible'?' ok':'');
      badge.textContent=a.status==='compatible'?'Traza compatible':'Revisión GPS';head.append(left,badge);box.append(head);
      if(a.issues.length){const warning=document.createElement('div');warning.className='issue';warning.textContent=a.issues.join(' · ');box.append(warning);}
      if(a.notes?.length){const note=document.createElement('div');note.className='note';note.textContent=a.notes.join(' · ');box.append(note);}
      const splits=document.createElement('div');splits.className='splits';
      a.splits.forEach((duration,n)=>{const row=document.createElement('div');row.className='split';
        const label=document.createElement('span');label.textContent=n===0?'Salida → '+(c.sectors[0]?.name||'Meta'):(c.sectors[n-1]?.name||'Sector '+n)+' → '+(c.sectors[n]?.name||'Meta');
        const time=document.createElement('b');time.textContent=timeString(duration);row.append(label,time);splits.append(row);
      });
      box.append(splits);
      if(cloudApi && cloudUser) {
        const save=document.createElement('button');save.className='btn outline full';save.type='button';
        save.textContent='Guardar intento privado en nube';
        save.addEventListener('click',async()=>{
          save.disabled=true;save.textContent='Guardando…';
          try {
            const id=await cloudApi.saveAttempt(c,a,attemptSourceName,attemptRoute);
            save.textContent='Intento guardado · '+id.slice(0,8);
            status('Intento guardado para entrenamiento personal. No es un resultado oficial.','success');
            refreshAttemptHistory().catch(()=>{});
          }catch(err){save.disabled=false;save.textContent='Guardar intento privado en nube';status('No se pudo guardar intento: '+err.message,'error')}
        });
        box.append(save);
      }
      const see=document.createElement('button');see.type='button';see.className='btn outline full';see.textContent='Ver solo este intento en el mapa';see.addEventListener('click',()=>focusAttempt(i));box.append(see);
      results.append(box);
    });
    focusAttempt(0);
    status(attempts.length+' intento(s) localizado(s). Los tiempos son estimados por GPS y no equivalen a un cronometraje de competición.','success');
  }catch(err){status('Fallo del detector: '+err.message,'error')}
});

// Saved runs comparison — read-only. Personal training estimates, never official race times.
let attemptHistory = [];
function fillHistorySelectors() {
  for(const id of ['comparisonFirst','comparisonSecond']) {
    const el=$(id);
    el.replaceChildren();
    if(!attemptHistory.length) {
      const empty=document.createElement('option');
      empty.value='';empty.textContent='No hay intentos guardados';el.append(empty);
    }
    for(const a of attemptHistory) {
      const option=document.createElement('option');
      option.value=a.id;
      option.textContent=new Date(a.created_at).toLocaleString('es-ES')+
        ' · '+formatMs(a.elapsed_ms)+
        ' · '+(a.source_filename||'GPS')+
        (a.gps_status==='compatible'?'':' · revisar GPS');
      el.append(option);
    }
  }
  if(attemptHistory.length>1){
    $('comparisonFirst').value=attemptHistory[1].id;
    $('comparisonSecond').value=attemptHistory[0].id;
  }
}
function showComparisonMessage(message) {
  const out=$('comparisonResults');out.replaceChildren();
  const p=document.createElement('p');p.className='placeholder';p.textContent=message;out.append(p);
}
async function refreshAttemptHistory() {
  if(!cloudApi||!cloudUser)throw Error('Conecta FastAPI e inicia sesión para recuperar tus intentos.');
  const circuit=selectedCircuit();
  if(!circuit?.cloud_id)throw Error('Primero guarda el circuito en PostgreSQL. Los circuitos solo locales no tienen historial compartido.');
  attemptHistory=await cloudApi.listAttempts(circuit);
  fillHistorySelectors();
  showComparisonMessage(attemptHistory.length>1?
    'Elige dos intentos y pulsa «Comparar sectores en el mapa».':
    'Se han encontrado '+attemptHistory.length+' intento(s). Guarda al menos dos del mismo circuito para compararlos.');
  return attemptHistory.length;
}
$('loadAttemptHistory').addEventListener('click',async()=>{
  const btn=$('loadAttemptHistory');btn.disabled=true;
  try {
    const n=await refreshAttemptHistory();
    status(n+' intento(s) recuperados de PostgreSQL para '+selectedCircuit().name+'.','success');
  }catch(err){showComparisonMessage(err.message);status(err.message,'error')}
  finally{btn.disabled=false}
});
function showComparisonOnMap(circuit, comparison) {
  viewCircuit(circuit);
  const colors={faster:'#1ddd93',slower:'#ff6275',equal:'#85caff',unknown:'#9facc0'};
  for(const s of comparison.sectors) {
    const layer=drawLine(circuit.points.slice(s.from,s.to+1),
      {color:colors[s.status],weight:8,opacity:.95});
    if(layer)layer.bindTooltip(
      'Sector '+(s.index+1)+' · '+(s.deltaMs===null?'Sin datos':formatDelta(s.deltaMs)),
      {sticky:true,direction:'top'});
  }
  $('mapTag').textContent='COMPARACIÓN A / B · '+circuit.name.toUpperCase();
}
$('compareAttempts').addEventListener('click',()=>{
  const circuit=selectedCircuit();
  try{
    if(!circuit?.cloud_id)throw Error('Guarda primero el circuito en PostgreSQL.');
    const first=attemptHistory.find(a=>a.id===$('comparisonFirst').value);
    const second=attemptHistory.find(a=>a.id===$('comparisonSecond').value);
    const comparison=compareSectorTimes(circuit,first,second);
    const out=$('comparisonResults');out.replaceChildren();
    const headline=document.createElement('div');headline.className='comparison-head';
    const text=document.createElement('div');text.textContent='B frente a A';text.className='caps';
    const total=document.createElement('strong');
    total.textContent=comparison.totalDeltaMs===null?'Total sin datos':formatDelta(comparison.totalDeltaMs);
    total.className='comparison-delta '+(comparison.totalDeltaMs===null?'unknown':comparison.totalDeltaMs<0?'faster':'slower');
    headline.append(text,total);out.append(headline);
    const info=document.createElement('p');info.className='comparison-info';
    info.textContent='A: '+formatMs(comparison.firstTotal)+' · B: '+formatMs(comparison.secondTotal);
    out.append(info);
    if(comparison.hasGpsReview || !comparison.complete){
      const note=document.createElement('p');note.className='comparison-warning';
      note.textContent=(comparison.hasGpsReview?'Al menos uno de los intentos requiere revisión GPS. ':'')+
        (!comparison.complete?'Hay sectores sin parcial válido; no se calcula su diferencia. ':'')+
        'Comparación orientativa, no homologada.';
      out.append(note);
    }
    const table=document.createElement('table');table.className='comparison-table';
    const head=document.createElement('thead'),header=document.createElement('tr');
    for(const title of ['Sector','A','B','Δ B−A','Acum.']) {
      const th=document.createElement('th');th.textContent=title;header.append(th);
    }
    head.append(header);table.append(head);
    const body=document.createElement('tbody');
    for(const s of comparison.sectors) {
      const row=document.createElement('tr');
      row.className='sector-'+s.status;
      row.tabIndex=0;
      row.setAttribute('aria-label','Sector '+(s.index+1)+', '+(s.name)+', '+formatDelta(s.deltaMs));
      const vals=[
        String(s.index+1)+' · '+s.name,
        formatMs(s.firstMs),
        formatMs(s.secondMs),
        formatDelta(s.deltaMs),
        formatDelta(s.cumulativeDeltaMs)
      ];
      vals.forEach((v,i)=>{
        const cell=document.createElement('td');
        cell.textContent=v;
        if(i===3)cell.className='sector-delta';
        row.append(cell);
      });
      row.title='Ver sector '+(s.index+1)+' en el mapa';
      const zoom=()=>map.fitBounds(L.latLngBounds(circuit.points.slice(s.from,s.to+1).map(point)),{padding:[55,55],maxZoom:18});
      row.addEventListener('click',zoom);
      row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();zoom()}});
      body.append(row);
    }
    table.append(body);out.append(table);
    const legend=document.createElement('p');legend.className='comparison-info';
    legend.textContent='Verde: B más rápido · Rojo: B más lento · Azul: empate · Gris: parcial desconocido. Pulsa cualquier sector para verlo.';
    out.append(legend);
    showComparisonOnMap(circuit,comparison);
    status('Comparación de '+comparison.sectors.length+' sectores lista. Los tiempos son estimaciones GPS.','success');
  }catch(err){showComparisonMessage(err.message);status('Comparación no disponible: '+err.message,'error')}
});
function cloudMessage(message,type=''){
  const el=$('cloudStatus');
  el.textContent=message;
  el.className='save-feedback '+type;
}
function reflectCloudUser(){
  $('cloudAuthPanel').hidden=!cloudApi||!!cloudUser;
  $('cloudSyncPanel').hidden=!cloudUser;
  $('cloudAccount').textContent=cloudUser?.local?'Mis datos en este PC':cloudUser?.email||'Piloto';
  $('storageMode').textContent=cloudUser?.local?'EN ESTE PC':'ALMACENAMIENTO';
  if(cloudUser?.local)$('storageHelp').textContent='Guarda tus circuitos, actividades y tiempos en este ordenador. No necesitas registrarte.';
  $('cloudLogout').hidden=!!cloudUser?.local;
  // Only organizers store circuits on the server; riders upload their runs in Competición.
  $('cloudPush').hidden=!cloudUser?.organizer;
  $('cloudConfigDetails').hidden=!!cloudUser?.local;
  showCircuitState();
}
// Organizers see the circuits stored on the server, with their competition state.
async function syncLibraryWithServer(){
  if(!cloudApi||!cloudUser?.organizer)return;
  for(const item of await cloudApi.listCircuits()){
    const local=circuits.find(c=>c.cloud_id===item.id||c.id===item.id);
    if(local)local.published=!!item.published;else circuits.push(item);
  }
  try{saveLibrary(circuits)}catch{}
  if(!selectedCircuit()&&circuits.length)selectedId=circuits[0].id;
  fillLibrary();
  // Never throw away a route the organizer is editing.
  if(selectedCircuit()&&!source)viewCircuit(selectedCircuit());
}
async function refreshCloudActivities(){
  if(!cloudApi||!cloudUser)return;
  const activities=await cloudApi.listActivities();
  const select=$('cloudActivitySelect');
  select.replaceChildren();
  if(!activities.length){
    const option=document.createElement('option');option.value='';option.textContent='Todavía no hay actividades guardadas';select.append(option);
  }
  for(const a of activities){
    const option=document.createElement('option');
    option.value=a.id;
    option.textContent=a.filename+' · '+(a.distance_m!=null?(Number(a.distance_m)/1000).toFixed(2)+' km':'distancia desconocida')+' · '+new Date(a.created_at).toLocaleDateString('es-ES');
    select.append(option);
  }
  return activities.length;
}
$('cloudRefreshActivities').addEventListener('click',async()=>{
  try {const count=await refreshCloudActivities();cloudMessage(count+' actividad(es) guardadas.','success')}
  catch(err){cloudMessage('No se pudo actualizar la biblioteca GPS: '+err.message,'error')}
});
$('cloudUploadActivity').addEventListener('click',async()=>{
  if(!cloudApi||!cloudUser)return cloudMessage('Espera a que se conecte la base de datos.','error');
  if(!attemptFileBlob||!attemptRoute)return cloudMessage('Carga antes un GPX/TCX completo en la sección 04.','error');
  const btn=$('cloudUploadActivity');btn.disabled=true;
  cloudMessage('Guardando GPS en la base de datos…');
  try {
    await cloudApi.uploadActivity(attemptFileBlob,attemptRoute,summarize(attemptRoute).meters);
    const count=await refreshCloudActivities();
    cloudMessage('Actividad «'+attemptSourceName+'» guardada en almacenamiento privado. '+count+' en tu biblioteca.','success');
  }catch(err){cloudMessage('No se pudo subir actividad: '+err.message,'error')}
  finally{btn.disabled=false;}
});
$('cloudLoadActivity').addEventListener('click',async()=>{
  if(!cloudApi||!cloudUser)return cloudMessage('Espera a que se conecte la base de datos.','error');
  const id=$('cloudActivitySelect').value;
  if(!id)return cloudMessage('Selecciona una actividad en tu biblioteca.','error');
  const btn=$('cloudLoadActivity');btn.disabled=true;
  try {
    const {blob,item}=await cloudApi.downloadActivity(id);
    const file=new File([blob],item.filename,{type:blob.type||'application/xml'});
    attemptRoute=await readFile(file);
    attemptFileBlob=file;attemptSourceName=file.name;
    $('attemptFileName').textContent=file.name+' · '+attemptRoute.length+' puntos (desde nube)';
    cloudMessage('GPS «'+file.name+'» recuperado. Puedes analizarlo en la sección 04.','success');
  }catch(err){cloudMessage('No se pudo descargar el GPX: '+err.message,'error')}
  finally{btn.disabled=false;}
});
$('cloudDeleteActivity').addEventListener('click',async()=>{
  if(!cloudApi||!cloudUser)return;
  const select=$('cloudActivitySelect'),id=select.value;
  if(!id)return cloudMessage('Selecciona primero una actividad.','error');
  const label=select.selectedOptions[0]?.textContent||'actividad';
  if(!window.confirm('¿Eliminar definitivamente este archivo GPS de la nube?\n'+label+'\nEsta acción no se puede deshacer.'))return;
  try {
    await cloudApi.deleteActivity(id);
    await refreshCloudActivities();
    cloudMessage('Actividad eliminada de la base de datos. El GPX que tengas en tu dispositivo no se ha tocado.','success');
  }catch(err){cloudMessage('No se pudo eliminar la actividad: '+err.message,'error')}
});
async function connectCloud(config){
  cloudMessage('Conectando con FastAPI y PostgreSQL…');
  cloudApi=createCloudApi(config);
  const health=await cloudApi.health();
  cloudUser=health.local_mode?await cloudApi.localSession():await cloudApi.user();
  reflectCloudUser();
  await syncLibraryWithServer();
  if(cloudUser)refreshCloudActivities().catch(()=>{});
  cloudMessage(cloudUser?.local?'Base de datos local conectada. Todo listo para guardar tus datos.':cloudUser?'Sesión iniciada como '+cloudUser.email+'. Puedes guardar o recuperar circuitos.':'FastAPI conectado. Crea una cuenta o inicia sesión.','success');
}
$('cloudConnect').addEventListener('click',async()=>{
  try{
    const cfg=setLocalCloudConfig($('cloudUrl').value);
    await connectCloud(cfg);
  }catch(err){cloudApi=null;cloudUser=null;reflectCloudUser();cloudMessage('No se ha podido conectar: '+err.message,'error')}
});
$('cloudLogin').addEventListener('click',async()=>{
  if(!cloudApi)return;
  try{
    const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
    const data=await cloudApi.signIn(email,password);
    cloudUser=data.user;
    $('cloudPassword').value='';
    reflectCloudUser();
    cloudMessage('Sesión iniciada. Puedes subir tus circuitos existentes o recuperarlos.','success');
    syncLibraryWithServer().catch(err=>cloudMessage('Sesión iniciada, pero no se pudieron leer tus circuitos: '+err.message,'error'));
    refreshCloudActivities().catch(err=>cloudMessage('Sesión iniciada, pero no se pudieron leer las actividades: '+err.message,'error'));
  }catch(err){cloudMessage('No se pudo iniciar sesión: '+err.message,'error')}
});
$('cloudSignup').addEventListener('click',async()=>{
  if(!cloudApi)return;
  try{
    const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
    if(password.length<8)throw Error('Utiliza al menos 8 caracteres de contraseña.');
    const data=await cloudApi.signUp(email,password);
    $('cloudPassword').value='';
    cloudUser=data.session?.user||null;
    reflectCloudUser();
    cloudMessage(cloudUser?'Cuenta creada e iniciada en tu servidor local.':'Cuenta creada. Inicia sesión.','success');
  }catch(err){cloudMessage('No se pudo crear cuenta: '+err.message,'error')}
});
$('cloudLogout').addEventListener('click',async()=>{
  if(!cloudApi)return;
  try {await cloudApi.signOut();cloudUser=null;reflectCloudUser();cloudMessage('Sesión cerrada. Los circuitos locales siguen disponibles.');}
  catch(err){cloudMessage('Error al cerrar sesión: '+err.message,'error')}
});
$('cloudPush').addEventListener('click',async()=>{
  const c=selectedCircuit();
  if(!c)return cloudMessage('Selecciona un circuito guardado en Mis circuitos.','error');
  if(!cloudApi||!cloudUser)return cloudMessage('Espera a que se conecte la base de datos.','error');
  const btn=$('cloudPush');btn.disabled=true;
  try {
    const id=await cloudApi.saveCircuit(c);
    c.cloud_id=id;
    try {saveLibrary(circuits);}catch(e){/* remote saved; local ID may not persist */}
    cloudMessage('«'+c.name+'» guardado correctamente en PostgreSQL.','success');
  }catch(err){cloudMessage('No se pudo guardar: '+err.message,'error')}
  finally{btn.disabled=false;}
});
$('cloudPull').addEventListener('click',async()=>{
  if(!cloudApi||!cloudUser)return cloudMessage('Espera a que se conecte la base de datos.','error');
  const btn=$('cloudPull');btn.disabled=true;
  try {
    const remote=await cloudApi.listCircuits();
    const imported=[...circuits];
    for(const item of remote){
      const i=imported.findIndex(x=>x.cloud_id===item.cloud_id || x.id===item.id);
      if(i>=0)imported[i]=item;else imported.push(item);
    }
    try {saveLibrary(imported);}
    catch(err) {cloudMessage('Circuitos recuperados, pero el navegador no permitió guardarlos localmente: '+err.message,'error');}
    circuits=imported;
    if(remote.length)selectedId=remote[0].id;
    fillLibrary();
    if(selectedCircuit())viewCircuit(selectedCircuit());
    cloudMessage(remote.length+' circuito(s) cargado(s) desde PostgreSQL. ','success');
  }catch(err){cloudMessage('No se pudieron recuperar circuitos: '+err.message,'error')}
  finally{btn.disabled=false;}
});
discoverApi().then(config=>{
  if(config){
    $('cloudUrl').value=config.url;
    return connectCloud(config);
  }
  $('cloudConfigDetails').open=false;
  reflectCloudUser();
  cloudMessage('Versión web: guardado en este navegador. La base de datos está disponible al abrir la aplicación en tu PC.');
}).catch(err=>cloudMessage('Error de conexión: '+err.message,'error'));
fillLibrary();
if(selectedCircuit()){viewCircuit(selectedCircuit());status('Biblioteca local de '+circuits.length+' circuito(s) cargada. Los JSON exportados son tu copia de seguridad.');}
else{refreshDraft();if(storageProblem)status('El almacenamiento del navegador no está disponible o contiene datos inválidos: '+storageProblem+'. Usa siempre una copia JSON.','error');}
