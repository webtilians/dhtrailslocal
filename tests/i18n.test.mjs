import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {EN, EN_PATTERNS} from '../en.mjs';
import {tServer} from '../i18n.mjs';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const files = ext => readdirSync(root).filter(name => name.endsWith(ext));
const PLACEHOLDERS = /\{(\w+)\}/g;
const names = text => [...text.matchAll(PLACEHOLDERS)].map(m => m[1]).sort().join(',');

// The same in both languages: names and marks.
const SAME = new Set(['DH TRAILS LOCAL', 'DH / TIME TRIAL', 'Time trial | DH Trails Local', 'GPX', 'TCX', 'GPX / TCX', 'GoPro']);

// The texts given to T(): a string, or several joined with + (a long one over two lines).
const LITERAL = String.raw`'(?:[^'\\]|\\.)*'`;
const T_CALL = new RegExp(String.raw`\bT\(((?:${LITERAL}\s*\+\s*)*${LITERAL})`, 'g');
const unquote = literal => JSON.parse('"' + literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
export const codeTexts = code => [...code.matchAll(T_CALL)].map(m => m[1].match(new RegExp(LITERAL, 'g')).map(unquote).join(''));

test('every text the code passes to T() is in English', () => {
  const missing = [];
  for (const name of files('.mjs')) {
    if (name === 'en.mjs') continue;
    for (const text of codeTexts(read(name))) if (!(text in EN)) missing.push(name + ': ' + text);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(codeTexts("T('a\\n' +\n  'b {n}', {n})"), ['a\nb {n}']);
});

// The text pieces and the titles, placeholders and labels of a page, as translatePage finds them.
function pageTexts(html) {
  const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&copy;/g, '©').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const texts = body.split(/<[^>]*>/).map(s => decode(s).trim().replace(/\s+/g, ' '));
  const attributes = [...body.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)].map(m => decode(m[1]).trim());
  return [...texts, ...attributes].filter(s => /\p{L}/u.test(s) && !SAME.has(s));
}

test('every text written in the pages is in English', () => {
  const missing = [];
  for (const name of files('.html')) for (const text of pageTexts(read(name))) if (!(text in EN)) missing.push(name + ': ' + text);
  assert.deepEqual(missing, []);
});

test('each English text keeps the {names} of its Spanish one', () => {
  const wrong = Object.entries(EN).filter(([es, en]) => names(es) !== names(en)).map(([es]) => es);
  assert.deepEqual(wrong, []);
});

// What the server answers, in Spanish (backend/app): as it is, or an example of the ones with a name,
// a date or a number in them.
const SERVER_EXAMPLES = [
  'El torneo empieza el 01/11/2026',
  'El torneo terminó el 31/10/2026',
  'No hay en el archivo una bajada completa y con hora de la salida a la meta de Kawasaki',
  'La bajada es del 12/10/2026 y el torneo va del 01/10/2026 al 31/10/2026',
  'Ya sois amigos con Jota',
  'Ya le enviaste una solicitud a Jota',
  'Ese circuito ya existe: «Kawasaki». Búscalo en la lista de circuitos',
  'Ya tienes 10 circuitos: borra alguno antes de crear otro',
  'Ya habías subido esta ruta a entrenamiento: «Bicicleta (3).gpx», salida del 12/10/2026 10:31',
  'Ya habías subido esta ruta a entrenamiento: «Bicicleta (3).gpx»',
  'Ya tienes 50 notas: borra alguna antes de añadir otra',
  '2 puerta(s) de sector sin datos GPS',
  'entre el km 1.60 y el 2.10 el GPS va por otro sitio, a 240 m del circuito: ¿te saliste del trazado?',
  'entre el km 0.45 y el 0.80 irías a 61 km/h de media sin GPS fiable: ¿atajo o fallo del GPS?',
  'coincide un 62 % con el circuito (mínimo 80 %)',
  'solo sigues el 40 % de su trazado (hace falta el 80 %)',
  'GPS perdido o desviado 6 s entre el km 0.45 y el 0.60 a 31 km/h de media, coherente',
  'GPS perdido o desviado 6 s entre el km 0.45 y el 0.60 a 31 km/h de media, coherente (y 1 tramo(s) más); parciales estimados con esa velocidad',
  'salida estimada: el GPS empieza 12 m después de la línea',
  'Con el circuito cambiado ya no hay en el archivo una bajada completa de la salida a la meta',
  'coincide un 62 % con el circuito (mínimo 80 %); el GPS se separa del trazado en más de la mitad de la bajada',
];

test('what the server says reaches an English page in English', () => {
  const plain = [];
  for (const name of readdirSync(new URL('backend/app/', root)).filter(n => n.endsWith('.py'))) {
    const code = read('backend/app/' + name);
    for (const m of code.matchAll(/(?:HTTPException\(\d+,\s*|detail=|GpsError\(|ValueError\(|issues\.append\(|SENT=)"([^"{}]+)"(?=[),\n])/g))
      if (/\p{L}/u.test(m[1]) && !/^(El formato XML|Extensión y tipo)/.test(m[1])) plain.push(m[1]);
  }
  assert.ok(plain.length > 40, String(plain.length));
  const untranslated = [...plain, ...SERVER_EXAMPLES].filter(text => tServer(text, 'en') === text);
  assert.deepEqual(untranslated, []);
  assert.equal(tServer('Ya sois amigos con Jota', 'en'), 'You and Jota are already friends');
  assert.equal(tServer('El torneo empieza el 01/11/2026', 'es'), 'El torneo empieza el 01/11/2026');
  assert.ok(EN_PATTERNS.every(([pattern]) => pattern instanceof RegExp && pattern.source.startsWith('^')));
});
