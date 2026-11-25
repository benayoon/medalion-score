// How long a song plays: exact from MuseScore (.mscz), else estimated from the MusicXML (with repeats and
// voltas, without D.S./D.C. jumps). Used for setlist totals and the set timer.
import * as store from './store.js';

// MusicXML → seconds, following the first part
export function xmlSeconds(text) {
  const d = typeof text === 'string' ? new DOMParser().parseFromString(text, 'application/xml') : text;
  const part = d.querySelector('part');
  if (!part) return null;
  let divisions = 1, tempo = 120, beats = 4, beatType = 4;
  const ms = [];
  for (const m of part.querySelectorAll(':scope > measure')) {
    const div = m.querySelector('attributes > divisions'); if (div) divisions = +div.textContent || divisions;
    const b = m.querySelector('attributes > time > beats'), bt = m.querySelector('attributes > time > beat-type');
    if (b && bt) { beats = parseInt(b.textContent) || beats; beatType = +bt.textContent || beatType; }
    const snd = m.querySelector('sound[tempo]'); if (snd) tempo = +snd.getAttribute('tempo') || tempo;
    // the measure's real length: the furthest point any voice reaches
    let pos = 0, end = 0;
    for (const e of m.children) {
      const dur = +((e.querySelector(':scope > duration') || {}).textContent || 0);
      if (e.tagName === 'note') {
        if (e.querySelector(':scope > grace') || e.querySelector(':scope > chord')) continue;
        pos += dur;
      } else if (e.tagName === 'backup') pos -= dur;
      else if (e.tagName === 'forward') pos += dur;
      end = Math.max(end, pos);
    }
    const mRest = m.querySelector('measure-style > multiple-rest');
    let quarters = end ? end / divisions : beats * 4 / beatType;
    if (mRest && !end) quarters *= +mRest.textContent || 1;
    const rep = [...m.querySelectorAll('barline > repeat')];
    const endings = [...m.querySelectorAll('barline > ending')];
    ms.push({
      sec: quarters * 60 / tempo,
      fwd: rep.some(r => r.getAttribute('direction') === 'forward'),
      back: rep.find(r => r.getAttribute('direction') === 'backward'),
      endStart: endings.find(e => e.getAttribute('type') === 'start'),
      endStop: endings.some(e => /stop|discontinue/.test(e.getAttribute('type'))),
    });
  }
  // play through: a backward repeat jumps to the last forward repeat; voltas play on their pass only
  let total = 0, start = 0, pass = 1, volta = null, guard = 0;
  for (let i = 0; i < ms.length && guard < 20000; i++, guard++) {
    const x = ms[i];
    if (x.fwd && i !== start) { start = i; pass = 1; }
    if (x.endStart) volta = (x.endStart.getAttribute('number') || '1').split(/[,\s]+/).map(Number).filter(Boolean);
    const skip = volta && !volta.includes(pass);
    if (!skip) total += x.sec;
    if (x.back && !skip) {
      const times = +(x.back.getAttribute('times') || 2);
      if (pass < times) { pass++; volta = null; i = start - 1; continue; }
      pass = 1; start = i + 1;
    }
    if (x.endStop) { if (!skip && pass > 1) { pass = 1; start = i + 1; } volta = null; }   // the last ending is done
  }
  return Math.round(total);
}

export function fmtDur(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}
// "3:45" / "3.45" / "225" → seconds
export function parseDur(t) {
  t = String(t || '').trim(); if (!t) return null;
  const p = t.split(/[:.]/).map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 1 ? p[0] * 60 : p.reduce((a, x) => a * 60 + x, 0);
}

// seconds of a setlist item: its own length if one was typed, else the song's, at the item's tempo
export function itemSeconds(it, s = store.scoreById(it.scoreId)) {
  if (it.length) return { sec: it.length, exact: true };
  const d = s && s.version && s.version.dur;
  if (!d || !d.s) return null;
  const k = it.tempo && s.tempo ? s.tempo / it.tempo : 1;
  return { sec: Math.round(d.s * k), exact: d.exact && k === 1 };
}

// songs imported before lengths were stored get one from their MusicXML, in the background
let busy = null;
export function fillDurations(ids) {
  if (busy) return busy;
  busy = (async () => {
    let n = 0;
    for (const s of store.scores()) {
      if (ids && !ids.includes(s.id)) continue;
      if (s.version.dur !== undefined || !s.version.xml) continue;
      try { const sec = xmlSeconds(await store.loadXml(s)); s.version.dur = sec ? { s: sec, exact: false } : null; n++; }
      catch { s.version.dur = null; }
    }
    if (n) await store.saveNow('local');
    return n;
  })().finally(() => { busy = null; });
  return busy;
}
