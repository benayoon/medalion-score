// The app's language. English by default; Hebrew is a choice in Settings. Every text on screen is written in
// the code in Hebrew and passed through t(), which gives the English from i18n-en.js (or the Hebrew itself).
// The choice is kept in localStorage so it is known before anything else loads (texts made at startup too).
import EN from './i18n-en.js';

let L = 'en';
try { L = localStorage.getItem('ms-lang') === 'he' ? 'he' : 'en'; } catch { /* private mode: English */ }

export const lang = () => L;
export const isHe = () => L === 'he';
export const locale = () => (L === 'he' ? 'he-IL' : 'en-US');

export function setLang(l) {
  try { localStorage.setItem('ms-lang', l === 'he' ? 'he' : 'en'); } catch { /* not kept */ }
  location.reload();
}

// t('שלום {name}', { name }) -> 'Hello Dana' / 'שלום Dana'
export function t(he, vars) {
  // 'סיום|band': the same Hebrew word with its own English in one place ('|…' is never shown)
  const base = he.split('|')[0];
  let s = L === 'he' ? base : (EN[he] ?? EN[base] ?? base);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

// music written left to right inside any text (keys "B♭", "F♯", transpositions "+2" / "−3", chords): kept in its
// own direction, so in Hebrew the ♭ / ♯ and the + / − stay on the right side
export const mus = s => (s === '' || s == null ? '' : '⁦' + s + '⁩');

document.documentElement.lang = L;
document.documentElement.dir = L === 'he' ? 'rtl' : 'ltr';
