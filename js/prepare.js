// Before a show: every song of the setlist ready on this iPad as a PDF, so during the show the iPad only
// shows pages it already has. MuseScore (on the iPad) works before the first song, never between songs.
// The same rules decide here and when a song opens (viewer.js), so "ready" means what will really be shown.
//
//   plan(score, part, semis) → { kind: 'pdf' | 'engrave' | 'live' | 'none', why }
//     pdf:     a PDF is stored for this part and key
//     engrave: no PDF yet, MuseScore can make it here from the song's .mscz (done by prepareShow)
//     live:    drawn by MuseScore at the show (no PDF can be right: a phone, a key with no .mscz,
//              a part exported in concert pitch, a player reading in B♭/E♭/F)
//     none:    nothing to show (the song is missing on this iPad)
import * as store from './store.js';
import { t } from './i18n.js';
import { matchPart } from './music.js';
import { canEngrave, engraveKey } from './importer.js';
import { concertOf, isTransposingPart, myReadKey, readKeyLabel } from './concert.js';

// the part and key a song opens in (in a setlist: the item's own, else the song's, else by the instrument)
export function partFor(s, item = null) {
  if (item && item.part != null) return item.part;
  const m = store.metaFor(s.id);
  if (m.part != null) return m.part;
  if (s.version.parts.length) {
    const i = matchPart(s.version.parts, store.state.settings.partWords);
    return i >= 0 ? s.version.parts[i].name : '';
  }
  return '';
}
export const semisFor = (s, item = null) => (item && item.semis != null ? item.semis : store.metaFor(s.id).semis) || 0;
// a phone: a whole PDF page is too small there, so songs open in live mode (laid out for the phone)
export const isPhone = s => !!(s && s.hasXml) && store.state.settings.livePhone !== false && Math.min(window.innerWidth, window.innerHeight) < 600;

// why this part should not be shown from its PDF ('' when the PDF is right): a transposing part exported
// in concert pitch shows the piano's notes, not the trumpet's; a player on a B♭/E♭/F instrument reads a
// song with no part for it in their own key
export async function liveReason(s, part) {
  if (!s || !s.hasXml) return '';
  const c = await concertOf(s);
  const tr = part && part.split(' + ').some(n => isTransposingPart(n, c));
  if (c.c === true && tr) {
    return c.exact ? t('ה-PDF של {part} יצא מ-MuseScore בצליל קונצרטי (Concert pitch), אז הוא מוצג במצב חי בכתב של הכלי', { part })
      : t('ייתכן שה-PDF של {part} בצליל קונצרטי (הפרטיטורה יצאה כך מ-MuseScore), אז הוא מוצג במצב חי בכתב של הכלי. ייבוא מחדש יבדוק כל תפקיד לחוד', { part });
  }
  const rk = myReadKey();
  if (rk && !c.parts.length && !tr) return t('מוצג במצב חי ב-{key}, לפי הכלי שלך (אפשר לשנות בהגדרות)', { key: readKeyLabel(rk) });
  return '';
}

export async function plan(s, part, semis) {
  if (!s) return { kind: 'none', why: t('השיר חסר באייפד') };
  if (isPhone(s)) return { kind: 'live', why: t('בטלפון השירים מוצגים במצב חי') };
  if (!s.hasPdf) return s.hasXml ? { kind: 'live', why: t('לשיר אין PDF') } : { kind: 'none', why: t('לשיר אין תווים') };
  if (part && part.includes(' + ')) return { kind: 'live', why: t('צירוף של כמה פרטים מוצג במצב חי') };
  const why = await liveReason(s, part);
  if (why) return { kind: 'live', why };
  if (!semis || store.pdfKeys(s).includes(semis)) return { kind: 'pdf' };
  if (canEngrave(s)) return { kind: 'engrave' };
  if (s.hasXml) return { kind: 'live', why: t('אין PDF בטון הזה. אפשר לייצא אותו מהמק: "רשימת טונים ל-MuseScore" (בסטליסט או בהגדרות)') };
  return { kind: 'none', why: t('אין PDF בטון הזה, ואין MusicXML') };
}

// the songs of a show: [{ s, part, semis, item }], the one on screen first
export function showSongs(v) {
  const list = v.setlist ? v.setlist.items.map((it, i) => ({ i, it })) : [{ i: 0, it: null }];
  const first = v.setlist ? v.index : 0;
  list.sort((a, b) => (a.i === first ? -1 : b.i === first ? 1 : a.i - b.i));
  return list.map(({ it }) => {
    const s = store.scoreById(it ? it.scoreId : v.scoreId);
    return { s, item: it, part: s ? partFor(s, it) : '', semis: s ? semisFor(s, it) : 0, title: s ? s.title : (it && it.title) || '?' };
  });
}

// everything that can be made ready now, one after the other. onStep(done, total, title) while working.
// → { total, ready, live: [{ title, why }], none: [{ title, why }], failed: [{ title, why }] }
export async function prepareShow(songs, onStep = null) {
  const out = { total: songs.length, ready: 0, live: [], none: [], failed: [] };
  const plans = [];
  for (const x of songs) plans.push({ x, p: await plan(x.s, x.part, x.semis) });
  const work = plans.filter(y => y.p.kind === 'engrave');
  let done = 0;
  for (const y of plans) {
    const { x, p } = y;
    if (p.kind === 'engrave') {
      if (onStep) onStep(done, work.length, x.title);
      try { await engraveKey(x.s.id, x.semis, { quiet: true }); out.ready++; }
      catch (e) { console.warn('prepare', x.title, e); out.failed.push({ title: x.title, why: String(e.message || e) }); }
      done++;
    } else if (p.kind === 'pdf') out.ready++;
    else out[p.kind].push({ title: x.title, why: p.why });
  }
  if (onStep && work.length) onStep(done, work.length, '');
  return out;
}
