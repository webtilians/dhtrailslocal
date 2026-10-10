// DH Trails Local v0.6 — pure helpers for the monthly standings (no DOM, tested in Node).
import {formatDelta} from './sector-comparison.mjs';

const MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
export const REVIEW_LABELS={pending:'Pendiente de revisión',approved:'Aprobada',rejected:'Rechazada'};

export function monthLabel(month) {
  const match=/^(\d{4})-(\d{2})$/.exec(String(month||''));
  if(!match||+match[2]<1||+match[2]>12)return String(month||'');
  return MONTHS[+match[2]-1]+' de '+match[1];
}
// Sector i runs from gate i to gate i+1; each gate keeps the name given in the editor.
export function sectorLabels(circuit) {
  const gates=['Salida',...(circuit?.sectors||[]).map((s,i)=>s.name||'Límite '+(i+1)),'Meta'];
  return gates.slice(1).map((to,i)=>({short:'S'+(i+1),long:gates[i]+' → '+to}));
}
export function standingsRows(board) {
  const best=board?.best_sectors_ms||[];
  return (board?.rows||[]).map(row=>({
    ...row,
    gapText:row.gap_ms===0?'Líder':formatDelta(row.gap_ms),
    sectors:(row.sector_splits_ms||[]).map((ms,i)=>({ms,best:ms!==null&&ms===best[i]}))
  }));
}
// Sum of the month's best sector times: the run nobody has done yet.
export function idealMs(board) {
  const best=board?.best_sectors_ms||[];
  return best.length&&best.every(Number.isFinite)?best.reduce((a,b)=>a+b,0):null;
}
// Shape a standings row like a saved attempt so compareSectorTimes can colour the map.
export function asAttempt(row,circuitId) {
  return {id:row.entry_id,circuit_id:circuitId,elapsed_ms:row.elapsed_ms,
    sector_splits_ms:row.sector_splits_ms,gps_status:row.gps_status};
}
