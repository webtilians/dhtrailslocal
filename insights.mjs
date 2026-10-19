// DH Trails — what a rider's runs on one circuit say over time: the ideal run (the best of each sector
// put together), how the times move from day to day, and a short report of a new run against the ones
// before it. Runs as the training API lists them: {id, started_at, elapsed_ms, sector_splits_ms}.

const DAY = 86400000;
const known = ms => Number.isFinite(ms) && ms > 0;

// The best time of each sector across these runs and their sum: what the rider would do riding every
// sector as well as they already have. null while some sector has no time in any run.
// {ms, sectors: [{ms, run}], fastest (run), margin (ms between the fastest run and the ideal)}
export function idealRun(runs) {
  const count = Math.max(0, ...runs.map(r => r.sector_splits_ms?.length || 0));
  if (!runs.length || !count) return null;
  const sectors = Array.from({length: count}, (_, i) => runs.reduce((best, run) => {
    const ms = run.sector_splits_ms?.[i];
    return known(ms) && (!best || ms < best.ms) ? {ms, run} : best;
  }, null));
  if (sectors.some(s => !s)) return null;
  const ms = sectors.reduce((sum, s) => sum + s.ms, 0);
  const fastest = runs.reduce((a, b) => b.elapsed_ms < a.elapsed_ms ? b : a);
  return {ms, sectors, fastest, margin: fastest.elapsed_ms - ms};
}

// One run's sectors against another's, where both have a time: [{sector, ms}] (+ slower, − faster).
export function sectorDeltas(run, other) {
  return (run.sector_splits_ms || []).flatMap((ms, sector) => {
    const theirs = other?.sector_splits_ms?.[sector];
    return known(ms) && known(theirs) ? [{sector, ms: ms - theirs}] : [];
  });
}

// The runs in date order for the progress charts: x in days since the first one; each sector as the
// time over the best ever done in it (0 = your best), so all sectors share one scale.
export function progressSeries(runs) {
  const dated = runs.filter(r => r.started_at).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  if (!dated.length) return null;
  const first = Date.parse(dated[0].started_at), ideal = idealRun(dated);
  const best = ideal ? ideal.sectors.map(s => s.ms) : [];
  let record = Infinity;
  const points = dated.map(run => {
    record = Math.min(record, run.elapsed_ms);
    return {run, x: (Date.parse(run.started_at) - first) / DAY, total: run.elapsed_ms, record,
      over: best.map((b, i) => known(run.sector_splits_ms?.[i]) ? run.sector_splits_ms[i] - b : null)};
  });
  return {first, points, sectors: best.length};
}

// What to tell about a run against the earlier ones on the same circuit:
// record (better than every earlier run), vsBest and vsPrevious (ms), the sector most gained and most
// lost against the previous run, and where the run is furthest from the rider's best sector (margin).
export function runReport(run, earlier) {
  const before = earlier.filter(r => r.id !== run.id && Date.parse(r.started_at) < Date.parse(run.started_at));
  const best = before.length ? before.reduce((a, b) => b.elapsed_ms < a.elapsed_ms ? b : a) : null;
  const previous = before.length ? before.reduce((a, b) => Date.parse(b.started_at) > Date.parse(a.started_at) ? b : a) : null;
  const deltas = previous ? sectorDeltas(run, previous) : [];
  const gained = deltas.reduce((a, d) => d.ms < -200 && (!a || d.ms < a.ms) ? d : a, null);
  const lost = deltas.reduce((a, d) => d.ms > 200 && (!a || d.ms > a.ms) ? d : a, null);
  const ideal = idealRun([...before, run]);
  const margin = ideal ? (run.sector_splits_ms || []).reduce((a, ms, sector) => {
    const over = known(ms) ? ms - ideal.sectors[sector].ms : 0;
    return over > 300 && (!a || over > a.ms) ? {sector, ms: over} : a;
  }, null) : null;
  return {record: !best || run.elapsed_ms < best.elapsed_ms, best, previous,
    vsBest: best ? run.elapsed_ms - best.elapsed_ms : null, vsPrevious: previous ? run.elapsed_ms - previous.elapsed_ms : null,
    gained, lost, margin};
}

// Where a run loses most against another, as `length` metres to go and look at (not a long zone):
// from timeLost's stretches, the run of them that adds up to the biggest loss. null if it loses nowhere.
export function worstStretch(stretches, length = 100) {
  if (!stretches.length) return null;
  const step = stretches[0].to - stretches[0].from || 25, n = Math.min(stretches.length, Math.max(1, Math.round(length / step)));
  let worst = null;
  for (let i = 0; i + n <= stretches.length; i++) {
    const ms = stretches.slice(i, i + n).reduce((sum, s) => sum + s.ms, 0);
    if (ms > 0 && (!worst || ms > worst.ms)) worst = {from: stretches[i].from, to: stretches[i + n - 1].to, ms};
  }
  return worst;
}
