import {parseGps, nearestTrackIndex, buildCircuit, distanceSeries, summarize, detectAttempts} from './gps-engine.mjs';

const $ = id => document.getElementById(id);
const map = L.map('map', {zoomControl:true}).setView([36.76,-4.46],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {maxZoom:19, attribution:'&copy; OpenStreetMap contributors'}).addTo(map);

const STORAGE = 'dhtrailslocal:v0.2:circuits';
let circuits = readLibrary();
let selectedId = '';
let source = null, attemptRoute = null, activeTool = '';
let draft = blankDraft(), history = [], pendingZone = null;
let artwork = [];
let attempts = [];
const resetArt = () => {artwork.forEach(layer => map.removeLayer(layer)); artwork = [];};
const add = layer => {layer.addTo(map); artwork.push(layer);return layer;};
const status = (message, type='') => {const el=$('status');el.textContent=message;el.className='status ' + type;};
const point = p => Array.isArray(p) ? [p[0],p[1]] : [p.lat,p.lon];
const coordinates = p => ({lat:point(p)[0],lon:point(p)[1]});
function blankDraft(){return {start:null,finish:null,sectors:[],zones:[]};}
function snapshot(){history.push(JSON.stringify(draft));if(history.length>30)history.shift();}
function readLibrary(){try{const data=JSON.parse(localStorage.getItem(STORAGE)||'[]');return Array.isArray(data)?data:[]}catch{return []}}
function saveLibrary(){localStorage.setItem(STORAGE,JSON.stringify(circuits));}
function selectedCircuit(){return circuits.find(c=>c.id===selectedId)||null;}
function fillLibrary() {
  const select=$('circuitSelect');select.replaceChildren();
  if(!circuits.length){const opt=document.createElement('option');opt.textContent='Aún no hay circuitos';opt.value='';select.appendChild(opt);selectedId='';return;}
  circuits.forEach(c=>{const opt=document.createElement('option');opt.value=c.id;opt.textContent=c.name;select.appendChild(opt)});
  if(!circuits.some(c=>c.id===selectedId))selectedId=circuits[0].id;
  select.value=selectedId;
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
$('saveCircuit').addEventListener('click',()=>{
  try{
    if(!source)throw Error('Importa primero la ruta de referencia.');
    if(draft.start===null||draft.finish===null)throw Error('Debes marcar salida y meta.');
    const circuit=buildCircuit($('circuitName').value,source,draft.start,draft.finish,draft.sectors,draft.zones);
    circuits.push(circuit);selectedId=circuit.id;saveLibrary();fillLibrary();viewCircuit(circuit);
    status('Circuito '+circuit.name+' guardado localmente. Puedes exportarlo a JSON o cronometrar un GPX.','success');
  }catch(err){status('No se pudo guardar: '+err.message,'error')}
});
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
  showStats(ref,circuit.sectors.length+1);
  refreshDraft();
}
$('circuitSelect').addEventListener('change',e=>{selectedId=e.target.value;});
$('loadCircuit').addEventListener('click',()=>{const c=selectedCircuit();if(!c)return status('No hay circuito seleccionado.','error');viewCircuit(c);status('Circuito '+c.name+' cargado. Puedes importar una actividad para detectar intentos.','success')});
$('exportCircuit').addEventListener('click',()=>{
  const c=selectedCircuit();if(!c)return status('Selecciona un circuito primero.','error');
  const blob=new Blob([JSON.stringify(c,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=c.name.toLowerCase().replace(/[^a-z0-9-_]+/gi,'-')+'.dhtrails.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  status('Copia JSON del circuito descargada.','success');
});
function validateImport(c) {
  if(!c||c.version!==2||typeof c.name!=='string'||!Array.isArray(c.points)||c.points.length<16||c.points.length>12000)throw Error('El JSON no tiene un circuito v0.2 válido.');
  if(c.points.some(p=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>90||Math.abs(p[1])>180))throw Error('Coordenadas incorrectas.');
  if(!Array.isArray(c.sectors)||c.sectors.some(g=>!Number.isInteger(g.index)||g.index<=0||g.index>=c.points.length-1)||!Array.isArray(c.weakZones))throw Error('Sectores o zonas incorrectas.');
  if(c.weakZones.some(z=>!Number.isInteger(z.from)||!Number.isInteger(z.to)||z.from<0||z.to>=c.points.length||z.from>=z.to))throw Error('Zona GPS débil incorrecta.');
  c.name=c.name.slice(0,100);c.sectors=c.sectors.map(g=>({index:g.index,name:String(g.name||'Sector').slice(0,70)})).sort((a,b)=>a.index-b.index);
  c.weakZones=c.weakZones.map(z=>({from:z.from,to:z.to,name:String(z.name||'GPS débil').slice(0,70)}));
  c.id='dh-import-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);return c;
}
$('importCircuit').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{if(file.size>3e6)throw Error('JSON demasiado grande.');
    const circuit=validateImport(JSON.parse(await file.text()));circuits.push(circuit);saveLibrary();selectedId=circuit.id;fillLibrary();viewCircuit(circuit);
    status('Circuito '+circuit.name+' importado correctamente.','success');
  }catch(err){status('Error al importar: '+err.message,'error')}
});
$('attemptFile').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{attemptRoute=await readFile(file);$('attemptFileName').textContent=file.name+' · '+attemptRoute.length+' puntos';
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
      const splits=document.createElement('div');splits.className='splits';
      a.splits.forEach((duration,n)=>{const row=document.createElement('div');row.className='split';
        const label=document.createElement('span');label.textContent=n===0?'Salida → '+(c.sectors[0]?.name||'Meta'):(c.sectors[n-1]?.name||'Sector '+n)+' → '+(c.sectors[n]?.name||'Meta');
        const time=document.createElement('b');time.textContent=timeString(duration);row.append(label,time);splits.append(row);
      });
      box.append(splits);
      const see=document.createElement('button');see.type='button';see.className='btn outline full';see.textContent='Ver solo este intento en el mapa';see.addEventListener('click',()=>focusAttempt(i));box.append(see);
      results.append(box);
    });
    focusAttempt(0);
    status(attempts.length+' intento(s) localizado(s). Los tiempos son estimados por GPS y no equivalen a un cronometraje de competición.','success');
  }catch(err){status('Fallo del detector: '+err.message,'error')}
});
fillLibrary();
if(selectedCircuit()){viewCircuit(selectedCircuit());status('Biblioteca de circuitos cargada. Puedes editar uno nuevo importando un GPX.');}
else{refreshDraft();}
