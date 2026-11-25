// Music helpers: key names, transposition, transposing instruments, search normalization.
// key names and transpositions are shown as music, left to right (B♭, F♯, +2, −3) in any language
import { mus } from './i18n.js';
const MAJOR = { '-7': 'C♭', '-6': 'G♭', '-5': 'D♭', '-4': 'A♭', '-3': 'E♭', '-2': 'B♭', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F♯', 7: 'C♯' };

export function keyName(fifths) {
  if (fifths === undefined || fifths === null || fifths === '' || isNaN(fifths)) return '';
  return mus(MAJOR[String(+fifths)] || '');
}
// fifths after moving by semitones, kept in the readable range (prefers flats, F♯ only for 6)
export function transposeFifths(fifths, semis) {
  if (fifths === undefined || fifths === null || isNaN(fifths)) return null;
  let f = (+fifths + 7 * semis) % 12;
  if (f < -6) f += 12;
  if (f > 6) f -= 12;
  if (f === -6 && semis > 0) f = 6;
  return f;
}
export function keyAfter(fifths, semis) {
  const f = transposeFifths(fifths, semis || 0);
  return f === null ? '' : keyName(f);
}
export const semisLabel = s => mus(s > 0 ? '+' + s : s < 0 ? '−' + Math.abs(s) : '0');

// all 12 keys for "pick a target key": [{fifths, name}]
export const ALL_KEYS = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map(f => ({ fifths: f, name: keyName(f) }));
// semitones from key a to key b, in -6..+5
export function semisBetween(fromFifths, toFifths) {
  let s = ((toFifths - fromFifths) * 7) % 12;
  if (s < 0) s += 12;
  if (s > 6) s -= 12;
  return s;
}

// Verovio interval names for semitone shifts
const VRV = { 1: 'm2', 2: 'M2', 3: 'm3', 4: 'M3', 5: 'P4', 6: 'A4' };
export const verovioInterval = s => (s === 0 ? '' : (s < 0 ? '-' : '+') + VRV[Math.abs(s)]);

// Search: lowercase, strip niqqud and gershayim, unify final letters
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
export function norm(s) {
  return (s || '').normalize('NFKD').replace(/[֑-ׇ]/g, '').toLowerCase()
    .replace(/[ךםןףץ]/g, c => FINALS[c]).replace(/[׳״'"`´’\-_.,()\[\]+&/]/g, ' ').replace(/\s+/g, ' ').trim();
}
// title key for duplicate detection
export const dupKey = t => norm(t).replace(/\s/g, '');

export function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60); const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// match a part name against the profile instrument words
export function matchPart(parts, words) {
  if (!parts || !parts.length || !words) return -1;
  const ws = words.split(/[,،]/).map(w => norm(w)).filter(Boolean);
  for (const w of ws) {
    const i = parts.findIndex(p => norm(p.name).includes(w));
    if (i >= 0) return i;
  }
  return -1;
}
