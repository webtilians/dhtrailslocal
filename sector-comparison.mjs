// DH Trails Local v0.5 — pure, deterministic comparison of recorded sector times.
// Negative difference means the second (B) attempt is faster than reference (A).
export function compareSectorTimes(circuit, first, second) {
  if (!circuit || !Array.isArray(circuit.points) || circuit.points.length < 2)
    throw new Error('Selecciona un circuito válido.');
  if (!first || !second || first.id === second.id)
    throw new Error('Selecciona dos intentos diferentes.');
  const circuitId = String(circuit.cloud_id || circuit.id || '');
  if (!circuitId || String(first.circuit_id) !== circuitId || String(second.circuit_id) !== circuitId)
    throw new Error('Ambos intentos deben pertenecer al mismo circuito.');
  const boundaries = [0, ...(circuit.sectors || []).map(s => s.index), circuit.points.length - 1];
  if (boundaries.some((v,i) => !Number.isInteger(v) || v < 0 || v >= circuit.points.length || (i && v <= boundaries[i-1])))
    throw new Error('Los límites del circuito no son válidos.');
  const splitsA = first.sector_splits_ms, splitsB = second.sector_splits_ms;
  if (!Array.isArray(splitsA) || !Array.isArray(splitsB) ||
      splitsA.length !== boundaries.length - 1 || splitsB.length !== boundaries.length - 1)
    throw new Error('Los parciales guardados no coinciden con los sectores actuales. Puede que el circuito haya cambiado.');
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  let accumulated = 0, allKnown = true;
  const sectors = splitsA.map((a,i) => {
    const b = splitsB[i];
    const known = valid(a) && valid(b);
    const delta = known ? b - a : null;
    if (delta === null) allKnown = false;
    else if (allKnown) accumulated += delta;
    return {
      index: i,
      from: boundaries[i],
      to: boundaries[i+1],
      name: circuit.sectors?.[i]?.name || (i === splitsA.length - 1 ? 'Meta' : 'Sector '+(i+1)),
      firstMs: valid(a) ? a : null,
      secondMs: valid(b) ? b : null,
      deltaMs: delta,
      cumulativeDeltaMs: allKnown ? accumulated : null,
      status: delta === null ? 'unknown' : delta < -0.5 ? 'faster' : delta > 0.5 ? 'slower' : 'equal'
    };
  });
  const firstTotal = valid(first.elapsed_ms) ? first.elapsed_ms : null;
  const secondTotal = valid(second.elapsed_ms) ? second.elapsed_ms : null;
  const totalDeltaMs = firstTotal !== null && secondTotal !== null ? secondTotal - firstTotal : null;
  return {
    first: first.id,
    second: second.id,
    firstTotal, secondTotal, totalDeltaMs,
    sectors,
    complete: sectors.every(s => s.deltaMs !== null),
    hasGpsReview: first.gps_status !== 'compatible' || second.gps_status !== 'compatible'
  };
}

export function formatMs(ms) {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const tenths = Math.round(Math.abs(ms) / 100);
  return (ms < 0 ? '−' : '') + String(Math.floor(tenths / 600)).padStart(2,'0')
    + ':' + String(Math.floor(tenths / 10) % 60).padStart(2,'0')
    + '.' + String(tenths % 10);
}
export function formatDelta(ms) {
  if (ms === null || !Number.isFinite(ms)) return 'Sin datos';
  if (Math.abs(ms) < 0.5) return '±0.0 s';
  return (ms < 0 ? '−' : '+') + (Math.abs(ms) / 1000).toFixed(1) + ' s';
}
