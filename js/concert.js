// Transposing instruments: is a MusicXML file written pitch (as the trumpet player reads it) or concert pitch
// (MuseScore had "Concert pitch" on when it was exported)? Its PDFs were made the same way, so this also says
// whether a trumpet part's PDF shows the trumpet's notes or the piano's.
//
// The answer comes from several signs, the surest first:
//   1. MusicXML 4 says so itself: <concert-score/>, or the transposition as <for-part><part-transpose>
//   2. key signatures: written, a B♭ trumpet has two sharps more than the piano; in concert the same key
//   3. two transposing instruments of different kinds (B♭ and E♭) with the same key: concert
//   4. the notes themselves (when every key is C, or there is none): which shift makes the trumpet's notes
//      the same notes as the rest of the band's
// → { concert: true | false | null (no way to tell), why, parts: [{ id, name, chrom, diat, oct }] (transposing) }

import * as store from './store.js';

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function partsOf(d) {
  const names = new Map([...d.querySelectorAll('part-list > score-part')].map(sp => [sp.getAttribute('id'), (sp.querySelector('part-name')?.textContent || '').trim()]));
  return [...d.querySelectorAll('score-partwise > part')].map(p => {
    const tr = p.querySelector('attributes > transpose') || p.querySelector('attributes > for-part > part-transpose');
    const num = (el, tag) => +((el && el.querySelector(tag)?.textContent) || 0);
    const f = p.querySelector('attributes > key > fifths');
    const hist = new Array(12).fill(0); let n = 0;
    for (const pitch of p.querySelectorAll('note > pitch')) {
      const note = pitch.parentNode;
      if (note.querySelector('rest') || note.querySelector('unpitched')) continue;
      const step = pitch.querySelector('step')?.textContent.trim();
      if (!(step in PC)) continue;
      const pc = (PC[step] + Math.round(+(pitch.querySelector('alter')?.textContent || 0)) + 120) % 12;
      // long notes count more, a little (a run of 16ths is not the tune's key)
      const dur = +(note.querySelector('duration')?.textContent || 1);
      hist[pc] += Math.min(4, Math.max(1, Math.sqrt(dur))); n++;
    }
    const drums = !!p.querySelector('attributes > clef > sign') && p.querySelector('attributes > clef > sign').textContent.trim() === 'percussion';
    return {
      id: p.getAttribute('id'), name: names.get(p.getAttribute('id')) || p.getAttribute('id'),
      chrom: num(tr, 'chromatic'), diat: num(tr, 'diatonic'), oct: num(tr, 'octave-change'),
      fifths: f ? +f.textContent : null, hist, n, drums,
    };
  });
}
// the written key of a concert key for an instrument chrom semitones below its written notes
const writtenKey = (k, chrom) => { let w = (k - 7 * chrom) % 12; if (w > 6) w -= 12; if (w < -6) w += 12; return w; };
const same = (a, b) => a != null && b != null && ((a - b) % 12 + 12) % 12 === 0;
function corr(a, b, shift) {
  let s = 0; let na = 0; let nb = 0;
  for (let i = 0; i < 12; i++) { const x = a[i]; const y = b[(i + shift + 120) % 12]; s += x * y; na += x * x; nb += y * y; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

export function concertInfo(docOrText) {
  const d = typeof docOrText === 'string' ? new DOMParser().parseFromString(docOrText, 'application/xml') : docOrText;
  const all = partsOf(d).filter(p => !p.drums);
  const parts = all.filter(p => ((p.chrom % 12) + 12) % 12 !== 0);   // an octave only (guitar, bass) is not a key
  const out = (concert, why) => ({ concert, why, parts: parts.map(({ id, name, chrom, diat, oct }) => ({ id, name, chrom, diat, oct })) });
  if (!parts.length) return out(false, 'no transposing instruments');
  // 1. said in the file
  if (d.querySelector('concert-score') || d.querySelector('attributes > for-part > part-transpose')) return out(true, 'the file says concert pitch');
  // MuseScore 4 always says so when it exports in concert pitch: no word of it is written pitch
  const sw = [...d.querySelectorAll('encoding > software')].map(x => x.textContent).join(' ');
  if (/MuseScore\s*(Studio|[4-9]\.)/i.test(sw)) return out(false, 'MuseScore 4: written pitch');
  const refs = all.filter(p => ((p.chrom % 12) + 12) % 12 === 0);
  const ref = refs.find(p => p.fifths != null && p.n);
  // 2. keys against an instrument in C
  if (ref) {
    let c = 0; let w = 0;
    for (const p of parts) {
      if (p.fifths == null || !p.n) continue;   // (an empty part: MuseScore may write the concert key)
      const wk = writtenKey(ref.fifths, p.chrom);
      if (same(wk, ref.fifths)) continue;              // (a tritone: the key can't tell)
      if (same(p.fifths, ref.fifths)) c++; else if (same(p.fifths, wk)) w++;
    }
    if (c && !w) return out(true, 'keys: the transposing parts have the concert key');
    if (w && !c) return out(false, 'keys: written keys');
  }
  // 3. two kinds of transposing instruments
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i]; const b = parts[j];
    if (a.fifths == null || b.fifths == null || !a.n || !b.n || same(a.chrom, b.chrom)) continue;
    if (same(writtenKey(a.fifths, -a.chrom), writtenKey(b.fifths, -b.chrom)) && !same(a.fifths, b.fifths)) return out(false, 'keys: B♭ and E♭ parts in their own keys');
    if (same(a.fifths, b.fifths) && a.fifths !== 0) return out(true, 'keys: B♭ and E♭ parts in one key');
  }
  // 4. the notes: the shift that makes a transposing part sound like the rest
  const band = new Array(12).fill(0); let bn = 0;
  for (const p of refs) if (p.n) { p.hist.forEach((v, i) => { band[i] += v / p.n; }); bn += p.n; }
  let c = 0; let w = 0;
  for (const p of parts) {
    if (p.n < 12 || bn < 12) continue;
    // written pitch: the trumpet's written C is the band's B♭, so its notes match the band's chrom semitones lower
    const asConcert = corr(p.hist, band, 0); const asWritten = corr(p.hist, band, p.chrom);
    if (asConcert > asWritten + 0.08) c++; else if (asWritten > asConcert + 0.08) w++;
  }
  if (c && !w) return out(true, 'notes: they match the band without a shift');
  if (w && !c) return out(false, 'notes: they match the band once transposed');
  return out(null, 'no sign either way');
}

// written = concert + n: what a player reads in each key (for "read in my key")
export const READ_KEYS = [{ value: 0, label: 'C' }, { value: 2, label: 'B♭' }, { value: 9, label: 'E♭' }, { value: 7, label: 'F' }];
// the key a player's instrument reads in, from its name (Hebrew or English); 0: concert (C)
export function readKeyOf(name) {
  const n = String(name || '').toLowerCase();
  if (/alto|bari|אלט|בריטון|e♭|eb\b|mib/.test(n) && /sax|סקס|clar|קלרינט|horn|קרן/.test(n)) return 9;
  if (/tenor|soprano|טנור|סופרן/.test(n) && /sax|סקס/.test(n)) return 2;
  if (/sax|סקס/.test(n)) return 9;                    // a saxophone with no other word: alto
  if (/trumpet|tpt|cornet|flugel|clarinet|חצוצר|קורנט|פליגל|קלרינט/.test(n)) return 2;
  if (/horn|קרן/.test(n) && !/english|cor anglais/.test(n)) return 7;
  return 0;
}
// this player's key: as chosen in Settings, else from the instrument's name
export function myReadKey() {
  const st = store.state.settings || {};
  return st.readKey != null ? +st.readKey : readKeyOf(st.instrument);
}
// semitones up to read a concert part in that key, as MuseScore can transpose them (−6…+6) and octaves
export function readShift(n, semis = 0) {
  let s = n + semis; let oct = 0;
  while (s > 6) { s -= 12; oct++; }
  while (s < -6) { s += 12; oct--; }
  return { semis: s, oct };
}

// a song's answer, worked out once from its MusicXML and kept with the version:
// { c: true | false | null, parts: [names of the transposing parts] }
export function concertSummary(info) { return { c: info.concert, parts: info.parts.map(p => p.name) }; }
export async function concertOf(score) {
  const v = score && score.version;
  if (!v) return { c: false, parts: [] };
  if (v.concert) return v.concert;
  if (!v.xml) return { c: null, parts: [] };
  try {
    v.concert = concertSummary(concertInfo(await store.loadXml(score)));
    store.save('local');
  } catch { return { c: null, parts: [] }; }
  return v.concert;
}
const norm = s => String(s || '').toLowerCase().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();
// is this part (a PDF's name) one of the listed ones? By name; when the list is not exact (worked out from
// the full score only), also any part whose name is a transposing instrument
export function isTransposingPart(name, summary) {
  if (!name) return false;
  const n = norm(name);
  const names = (summary && summary.parts) || [];
  if (names.some(p => norm(p) === n)) return true;
  return !(summary && summary.exact) && readKeyOf(name) !== 0;
}
export const readKeyLabel = n => (READ_KEYS.find(k => k.value === n) || {}).label || '';
