// DH Trails v0.8 — the app in Spanish or English. Texts are written in Spanish in the pages and the code,
// and en.mjs has each one in English. The language: the one chosen with ES | EN (kept on this device),
// else the browser's (Spanish for a Spanish browser, English for any other).
import {EN, EN_PATTERNS} from './en.mjs';

const KEY = 'dhtrails:lang';
function chosen() {
  try {const v = localStorage.getItem(KEY); return v === 'es' || v === 'en' ? v : null;} catch {return null;}
}
// Outside a browser (the tests in Node), Spanish.
export const lang = typeof document === 'undefined' ? 'es' : chosen() || (/^es\b/i.test(navigator.language || 'es') ? 'es' : 'en');
export const locale = lang === 'en' ? 'en-GB' : 'es-ES';
export function setLang(next) {
  try {localStorage.setItem(KEY, next);} catch {}
  location.reload();
}

// A text in the page's language; {name} in it takes params.name. (T, not t: t is a tournament or a time
// all over the code.)
export function T(text, params) {
  let out = lang === 'en' ? EN[text] ?? text : text;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => k in params ? String(params[k]) : m);
  return out;
}
// A number with `n` decimals: a comma in Spanish, a point in English.
export const dec = (x, n = 1) => {
  const s = Number(x).toFixed(n);
  return lang === 'es' ? s.replace('.', ',') : s;
};
// A place in a table: 1º in Spanish, 1st in English.
const SUFFIX = {one: 'st', two: 'nd', few: 'rd', other: 'th'};
export const ordinal = n => n + (lang === 'en' ? SUFFIX[new Intl.PluralRules('en', {type: 'ordinal'}).select(n)] : 'º');
// A message from the server (it writes them in Spanish), in the page's language: as a whole, or by the
// pattern of the ones that carry a name, a date or a number. Several joined with «; » or « · » (the
// reasons a run is out, its notes), each one.
export function tServer(text, language = lang) {
  if (language !== 'en' || typeof text !== 'string') return text;
  const one = piece => {
    if (EN[piece]) return EN[piece];
    for (const [pattern, english] of EN_PATTERNS) {
      const m = pattern.exec(piece);
      if (m) return english(m);
    }
    return null;
  };
  return one(text) ?? text.split(/(; | · )/).map(piece => one(piece) ?? piece).join('');
}

// The texts written in a page's HTML: each piece of text between its tags, and the titles, placeholders and
// labels of its elements.
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
export function translatePage(root = document.body) {
  if (lang !== 'en') return;
  document.documentElement.lang = 'en';
  if (EN[document.title.trim()]) document.title = EN[document.title.trim()];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => /^(SCRIPT|STYLE)$/.test(n.parentNode?.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const n of texts) {
    const text = n.nodeValue, key = text.trim().replace(/\s+/g, ' ');
    if (key && EN[key]) n.nodeValue = text.replace(text.trim(), () => EN[key]);
  }
  for (const name of ATTRIBUTES)
    root.querySelectorAll('[' + name + ']').forEach(el => {
      const key = el.getAttribute(name).trim();
      if (EN[key]) el.setAttribute(name, EN[key]);
    });
}
