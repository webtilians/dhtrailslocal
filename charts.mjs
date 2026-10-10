// DH Trails v0.8 — small SVG line charts for training telemetry (no library).
// One y-axis per chart, thin 2 px lines, recessive grid, a crosshair with every run's value.
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
function niceTicks(min, max, count = 5) {
  if (min === max) {min -= 1; max += 1;}
  const raw = (max - min) / count, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(v => v >= raw);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return {ticks, min: Math.min(min, ticks[0]), max: Math.max(max, ticks.at(-1))};
}

// series: [{label, color, points: [{x, y}]}]; x is km along the circuit.
export function lineChart(host, {series, yFormat = v => String(v), xFormat = v => v.toFixed(2).replace('.', ',') + ' km', zero = false, height = 220}) {
  host.replaceChildren();
  const width = Math.max(280, host.clientWidth || 600);
  const m = {top: 12, right: 14, bottom: 26, left: 52};
  const xs = series.flatMap(s => s.points.map(p => p.x)), ys = series.flatMap(s => s.points.filter(p => p.y !== null).map(p => p.y));
  if (!xs.length || !ys.length) return;
  const xMax = Math.max(...xs), y = niceTicks(Math.min(...ys, zero ? 0 : Infinity), Math.max(...ys, zero ? 0 : -Infinity));
  const sx = v => m.left + v / xMax * (width - m.left - m.right);
  const sy = v => m.top + (y.max - v) / (y.max - y.min) * (height - m.top - m.bottom);
  const root = svg('svg', {viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img'});
  for (const t of y.ticks) {
    root.append(svg('line', {x1: m.left, x2: width - m.right, y1: sy(t), y2: sy(t), class: t === 0 && zero ? 'chart-zero' : 'chart-grid'}));
    const label = svg('text', {x: m.left - 8, y: sy(t) + 4, 'text-anchor': 'end', class: 'chart-tick'});
    label.textContent = yFormat(t);
    root.append(label);
  }
  for (const t of niceTicks(0, xMax, 6).ticks.filter(t => t <= xMax)) {
    const label = svg('text', {x: sx(t), y: height - 8, 'text-anchor': 'middle', class: 'chart-tick'});
    label.textContent = xFormat(t);
    root.append(label);
  }
  for (const s of series) {
    let d = '', pen = 'M';
    for (const p of s.points) {
      if (p.y === null) {pen = 'M'; continue;}
      d += pen + sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1) + ' ';
      pen = 'L';
    }
    root.append(svg('path', {d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'}));
  }
  // Crosshair: the nearest sample of every run at the pointer's distance.
  const cross = svg('line', {y1: m.top, y2: height - m.bottom, class: 'chart-cross', visibility: 'hidden'});
  const dots = series.map(s => svg('circle', {r: 4, fill: s.color, stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden'}));
  const hit = svg('rect', {x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom, fill: 'transparent'});
  root.append(cross, ...dots, hit);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.append(root, tip);
  const nearest = (points, x) => points.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best, points[0]);
  hit.addEventListener('pointermove', event => {
    const box = root.getBoundingClientRect();
    const x = Math.max(0, Math.min(xMax, (event.clientX - box.left - m.left) / (width - m.left - m.right) * xMax));
    cross.setAttribute('x1', sx(x)); cross.setAttribute('x2', sx(x)); cross.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const head = document.createElement('b');
    head.textContent = xFormat(x);
    tip.append(head);
    series.forEach((s, i) => {
      const p = nearest(s.points, x);
      const visible = p && p.y !== null;
      dots[i].setAttribute('visibility', visible ? 'visible' : 'hidden');
      if (visible) {dots[i].setAttribute('cx', sx(p.x)); dots[i].setAttribute('cy', sy(p.y));}
      const row = document.createElement('div');
      const chip = document.createElement('i');
      chip.style.background = s.color;
      row.append(chip, s.label + ': ' + (visible ? yFormat(p.y) : '—'));
      tip.append(row);
    });
    tip.hidden = false;
    const left = sx(x) + 14, flip = left + 190 > width;
    tip.style.left = (flip ? sx(x) - 14 - tip.offsetWidth : left) + 'px';
    tip.style.top = m.top + 'px';
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach(dot => dot.setAttribute('visibility', 'hidden'));
  });
}
