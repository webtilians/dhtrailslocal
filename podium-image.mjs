// DH Trails — the podium of a tournament as a picture to share (1080 × 1350, the size Instagram and
// WhatsApp show whole). Drawn on a canvas in the browser; nothing is sent anywhere.
import {formatMs} from './sector-comparison.mjs';

const W = 1080, H = 1350;
const INK = '#071423', BLUE = '#45b8ff', TEXT = '#f0f6ff', MUTED = '#a4b9cd';
const MEDALS = ['#f0c04b', '#c9d3dd', '#d08a4e'];

// Lines of at most `width` pixels, cut between words.
function lines(ctx, text, width) {
  const out = [];
  for (const word of text.split(/\s+/)) {
    const line = out.length ? out.at(-1) + ' ' + word : word;
    if (out.length && ctx.measureText(line).width <= width) out[out.length - 1] = line;
    else out.push(word);
  }
  return out;
}
// The text shrunk until it fits in `width` on one line.
function fit(ctx, text, width, weight, size, family) {
  do ctx.font = `${weight} ${size}px ${family}`; while (ctx.measureText(text).width > width && --size > 20);
}

// rows: the standings rows ({rank, pilot, elapsed_ms, gapText, verified}); final: no more changes expected.
export async function podiumImage({tournament, circuit, rows, final, site}) {
  const head = "'Barlow Condensed', 'Arial Narrow', sans-serif", body = "Inter, system-ui, sans-serif";
  try {
    await Promise.all(['900 90px "Barlow Condensed"', '800 60px "Barlow Condensed"', '600 30px Inter', '800 24px Inter']
      .map(font => document.fonts.load(font)));
  } catch {}
  const canvas = Object.assign(document.createElement('canvas'), {width: W, height: H});
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  // Chequered flag along the top, like the app.
  for (let x = 0; x < W; x += 30) for (let y = 0; y < 60; y += 30)
    if ((x + y) / 30 % 2 === 0) {ctx.fillStyle = '#e8eef5'; ctx.fillRect(x, y, 30, 30);}

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = BLUE;
  ctx.font = `800 26px ${body}`;
  ctx.fillText('DH TRAILS LOCAL · TIME TRIAL', 80, 140);
  ctx.fillStyle = TEXT;
  ctx.font = `900 92px ${head}`;
  let y = 240;
  for (const line of lines(ctx, tournament.name.toUpperCase(), W - 160).slice(0, 2)) {ctx.fillText(line, 80, y); y += 92;}
  ctx.fillStyle = MUTED;
  ctx.font = `600 30px ${body}`;
  ctx.fillText(circuit.name + ' · ' + new Date(tournament.ends_on).toLocaleDateString('es-ES', {month: 'long', year: 'numeric'}), 80, y + 10);

  y += 110;
  ctx.fillStyle = final ? MEDALS[0] : MUTED;
  ctx.font = `800 26px ${body}`;
  ctx.fillText(final ? 'PODIO FINAL' : 'RESULTADO PROVISIONAL', 80, y);
  y += 40;
  rows.slice(0, 3).forEach((row, i) => {
    const top = y + i * 190, mid = top + 85;
    ctx.fillStyle = '#0e2033';
    ctx.fillRect(80, top, W - 160, 170);
    ctx.fillStyle = MEDALS[i];
    ctx.fillRect(80, top, 12, 170);
    ctx.beginPath();
    ctx.arc(170, mid, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `900 56px ${head}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(row.rank), 170, mid + 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = BLUE;
    ctx.font = `800 64px ${head}`;
    ctx.fillText(formatMs(row.elapsed_ms), W - 120, mid + 8);
    ctx.fillStyle = MUTED;
    ctx.font = `600 24px ${body}`;
    ctx.fillText(i ? row.gapText : 'Mejor tiempo', W - 120, mid + 48);
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    fit(ctx, row.pilot, 470, 800, 60, head);
    ctx.fillText(row.pilot, 250, mid + 8);
    ctx.fillStyle = row.verified ? '#7df0be' : MUTED;
    ctx.font = `600 24px ${body}`;
    ctx.fillText(row.verified ? '✓ Verificado' : 'Sin verificar', 250, mid + 48);
  });
  ctx.fillStyle = MUTED;
  ctx.font = `600 24px ${body}`;
  ctx.fillText('Tiempos calculados a partir del GPS de cada bajada · ' + site, 80, H - 70);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
