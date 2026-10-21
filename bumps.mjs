// DH Trails v0.8 — where two videos of the same trail pass the same place, from the trail's own bumps.
// Every rock and root shakes the camera the same way each time it is ridden over, on the frames' own clock;
// a few seconds of that shaking from one video are found in the other near where the GPS puts the same
// place (on 21/10/2026, two runs of kawasaki: the GPS was up to a second off where the images agreed with
// the bumps). Pure functions, tested in Node.

// The camera's shaking: spread of the total acceleration over a quarter of a second, 20 times a second.
export function shakeSeries({t, g}, step = 0.05, half = 0.125) {
  const out = [];
  if (!t?.length) return out;
  let j = 0;
  for (let s = 0; s < t.at(-1); s += step) {
    while (j < t.length && t[j] < s - half) j++;
    let n = 0, sum = 0, squares = 0;
    for (let k = j; k < t.length && t[k] <= s + half; k++) {n++; sum += g[k]; squares += g[k] * g[k];}
    out.push(n > 3 ? Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)) : 0);
  }
  return out;
}

function similarity(a, from, b, at, length) {
  let ma = 0, mb = 0;
  for (let i = 0; i < length; i++) {ma += a[from + i]; mb += b[at + i];}
  ma /= length; mb /= length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < length; i++) {const x = a[from + i] - ma, y = b[at + i] - mb; ab += x * y; aa += x * x; bb += y * y;}
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

// Moments of video A (seconds) with the moment of video B where the bumps say the same place is, only where
// they say it clearly: a window of `win` s each side of the moment in A, looked for `search` s each side of
// where `guide` (the GPS) puts it in B; a match counts when it is good (`minPeak`) and clearly better
// (`minMargin`) than any other more than a second away. [[secondA, secondB, score], ...]
export function matchBumps(shakeA, shakeB, guide, {from, to, every = 1, win = 3, search = 4, minPeak = 0.55, minMargin = 0.12, step = 0.05} = {}) {
  const out = [], size = Math.round(2 * win / step);
  for (let tA = from; tA <= to; tA += every) {
    const guess = guide(tA), startA = Math.round((tA - win) / step);
    if (!Number.isFinite(guess) || startA < 0 || startA + size > shakeA.length) continue;
    const scores = [];
    for (let k = Math.round((guess - search - win) / step); k <= Math.round((guess + search - win) / step); k++) {
      if (k < 0 || k + size > shakeB.length) continue;
      scores.push([(k * step) + win, similarity(shakeA, startA, shakeB, k, size)]);
    }
    if (!scores.length) continue;
    const best = scores.reduce((x, y) => y[1] > x[1] ? y : x);
    const other = scores.reduce((m, s) => Math.abs(s[0] - best[0]) > 1 && s[1] > m ? s[1] : m, -1);
    if (best[1] >= minPeak && best[1] - other >= minMargin) out.push([tA, best[0], best[1]]);
  }
  return out;
}

// For any moment of video A, the moment of video B at the same place. Between two matches up to `bridge` s
// apart, the two riders are taken to keep their pace (a straight line from one match to the next): where
// the bumps say nothing for a moment the GPS is often what failed. Over longer stretches, before the first
// match and after the last, the GPS guide moved by what the bumps said nearby. A match more than `tolerance`
// s off the trend of the matches within `around` s does not count (a few seconds of bumps can look like
// another stretch close by: on tuliki, four matches in a row 2 s off the rest); the trend, because the gap
// between two riders grows or shrinks steadily. Never back in time. Null without `minMatches` matches.
export function samePlace(matches, guide, {minMatches = 3, bridge = 25, around = 15, tolerance = 0.6} = {}) {
  if (matches.length < minMatches) return null;
  const raw = matches.map(([tA, tB]) => [tA, tB, tB - guide(tA)]);
  const median = list => {const v = [...list].sort((a, b) => a - b); return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;};
  // Against the trend of the matches around (Theil–Sen: the median of the slopes between every two of them,
  // and the median line with that slope): the moment in B less the moment in A (the gap) changes slowly.
  const kept = raw.filter(m => {
    const near = raw.filter(x => Math.abs(x[0] - m[0]) <= around).map(x => [x[0], x[1] - x[0]]), slopes = [];
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) slopes.push((near[j][1] - near[i][1]) / (near[j][0] - near[i][0]));
    const slope = slopes.length ? median(slopes) : 0, level = median(near.map(([t, g]) => g - slope * t));
    return Math.abs((m[1] - m[0]) - (level + slope * m[0])) <= tolerance;
  });
  if (kept.length < minMatches) return null;
  return tA => {
    const after = kept.findIndex(([t]) => t >= tA);
    if (after === 0) return guide(tA) + kept[0][2];
    if (after < 0) return guide(tA) + kept.at(-1)[2];
    const [a0, b0, c0] = kept[after - 1], [a1, b1, c1] = kept[after], f = (tA - a0) / (a1 - a0);
    return a1 - a0 <= bridge ? b0 + (b1 - b0) * f : guide(tA) + c0 + (c1 - c0) * f;
  };
}
