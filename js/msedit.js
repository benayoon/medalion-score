// Editing a MuseScore 4 file (.mscz) on the iPad. Every change is made the same way in the full score and
// in every part stored in the file (MuseScore keeps a linked copy of the notes for each part), so the
// score and the parts stay identical. Edits are addressed by: main staff id, measure index, voice, event.
//
//   const d = await MsDoc.open(buf);
//   d.setPitch({ staff: '1', m: 4, voice: 0, i: 2, n: 0 }, 67);  d.setDuration(addr, 'eighth', 0);
//   d.setChordSymbol('1', 4, tick, 'Am7/G');  d.insertMeasure(5);  const bytes = d.save();
import { readZip, writeZip } from './zip.js';
import { transposeTpc, transposeKey as transposeKeyBy } from './mstranspose.js';
import { t } from './i18n.js';

export const DUR = { breve: 3840, whole: 1920, half: 960, quarter: 480, eighth: 240, '16th': 120, '32nd': 60, '64th': 30 };
const DUR_ORDER = ['breve', 'whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];
const NATURAL_TPC = [14, 16, 18, 13, 15, 17, 19];          // C D E F G A B
const STEP_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const STEP_OF = [3, 0, 4, 1, 5, 2, 6];
export const tpcStep = t => STEP_OF[((t + 1) % 7 + 7) % 7];
export const tpcAlter = t => Math.floor((t + 1) / 7) - 2;
const tpcClass = t => ((STEP_SEMIS[tpcStep(t)] + tpcAlter(t)) % 12 + 12) % 12;
export const pitchToTpc = (pitch, key) => { const b = 11 + key; return ((pitch * 7 + 26 - b) % 12 + 12) % 12 + b; };
// the spelling a key signature gives a letter
const keyTpc = (step, key) => {
  const t = NATURAL_TPC[step];
  const order = t - 13;                                     // F=0 C=1 G=2 D=3 A=4 E=5 B=6
  if (key > 0 && order < key) return t + 7;
  if (key < 0 && order >= 7 + key) return t - 7;
  return t;
};
export const NOTE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export function noteName(pitch, tpc) {
  const a = tpcAlter(tpc);
  return NOTE_NAMES[tpcStep(tpc)] + (a > 0 ? '♯'.repeat(a) : a < 0 ? '♭'.repeat(-a) : '') + (Math.floor((pitch - tpcAlter(tpc)) / 12) - 1);
}
const ticksOf = (type, dots) => { let d = DUR[type] || 0; let add = d; for (let k = 0; k < dots; k++) { add /= 2; d += add; } return d; };
// the plainest notation of a length: [type, dots]
function typeFor(ticks) {
  for (const t of DUR_ORDER) for (let dots = 0; dots <= 2; dots++) if (ticksOf(t, dots) === ticks) return [t, dots];
  return null;
}
// a length as a list of plain notes (for rests that fill a gap)
function split(ticks) {
  const out = [];
  for (const t of DUR_ORDER) while (ticks >= DUR[t]) { out.push([t, 0]); ticks -= DUR[t]; }
  return out;
}
// as split, but the rest of a tied note: one dotted value when it is exactly one (a dotted half, not half + quarter)
function splitNote(ticks) {
  for (const t of DUR_ORDER) for (const d of [1, 2]) if (DUR[t] * (2 - 1 / 2 ** d) === ticks) return [[t, d]];
  return split(ticks);
}
// an element id like MuseScore's: two 64-bit numbers, base64 without padding
const newEid = () => { const half = () => { const b = crypto.getRandomValues(new Uint8Array(8)); b[0] &= 0x7f; return btoa(String.fromCharCode(...b)).replace(/=+$/, ''); }; return half() + '_' + half(); };
const staffMeasures = el => kids(el, 'Measure').filter(m => !kid(m, 'multiMeasureRest'));
const fracTicks = s => { const [n, d] = String(s).split('/').map(Number); return d ? 1920 * n / d : 0; };
// ticks as MuseScore writes a fraction of a whole note: 480 -> "1/4", -720 -> "-3/8"
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
export const fracOf = ticks => { const g = gcd(Math.round(ticks), 1920) || 1; return `${Math.round(ticks) / g}/${1920 / g}`; };
// the top line of the staff for each clef, as a scale step (octave * 7 + step, C4 = 28)
const CLEF_TOP = { G: 38, G8vb: 31, G8va: 45, G15ma: 52, G15mb: 24, G8vbo: 31, G8vbp: 31, F: 26, F8vb: 19, F8va: 33, F15mb: 12, F15ma: 40, F_B: 28, F_C: 24,
  C1: 36, C2: 34, C3: 32, C4: 30, C5: 28, C4_8vb: 23, PERC: 38, PERC2: 38 };

const kids = (el, tag) => [...el.children].filter(c => !tag || c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0] || null;
const txt = (el, tag) => { const k = kid(el, tag); return k ? k.textContent : null; };

// ---------------------------------------------------------------- undo steps, kept small
// a stack of states ({ xml: [file texts], ops }); only the top one is kept whole, every other one as the
// difference from the one above it (an edit changes a few lines of a file that can be megabytes long)
const own = x => (' ' + x).slice(1);   // a copy that does not keep the long text it was cut from alive
// how many characters a and b share at the start / at the end (one pass, in chunks)
function samePrefix(a, b) {
  const n = Math.min(a.length, b.length), C = 8192;
  let i = 0;
  while (i + C <= n && a.slice(i, i + C) === b.slice(i, i + C)) i += C;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
function sameSuffix(a, b, max) {
  const C = 8192, la = a.length, lb = b.length;
  let i = 0;
  while (i + C <= max && a.slice(la - i - C, la - i) === b.slice(lb - i - C, lb - i)) i += C;
  while (i < max && a.charCodeAt(la - 1 - i) === b.charCodeAt(lb - 1 - i)) i++;
  return i;
}
// a as the change from b. Small texts: the part between what they share at the start and at the end.
// Big ones (a song file of megabytes, where an edit can touch every staff): a diff by measures, so only the
// measures that changed are kept.
const CUT = '</Measure>';
function diffText(a, b) {
  if (a === b) return null;
  const p = samePrefix(a, b);
  const s = sameSuffix(a, b, Math.min(a.length, b.length) - p);
  if (a.length - p - s > 200000) { const c = diffChunks(a.split(CUT), b.split(CUT)); if (c) return c; }
  return { p, s, mid: own(a.slice(p, a.length - s)) };
}
function applyText(d, b) {
  if (!d) return b;
  if (!d.parts) return own(b.slice(0, d.p) + d.mid + b.slice(b.length - d.s));
  const bc = b.split(CUT), out = [];
  for (const q of d.parts) if (typeof q === 'string') out.push(q); else for (let k = q[0]; k < q[0] + q[1]; k++) out.push(bc[k]);
  return out.join(CUT);
}
// A as pieces of B: [string (a piece of A's own) | [start, count] (pieces of B)] (Myers' diff on the pieces)
function diffChunks(A0, B0) {
  const ids = new Map(); const id = x => { let v = ids.get(x); if (v === undefined) ids.set(x, v = ids.size); return v; };
  const A = A0.map(id), B = B0.map(id), N = A.length, M = B.length, MAX = 3000, off = MAX + 1;
  const V = new Int32Array(2 * MAX + 3); const trace = [];
  let D = -1;
  for (let d = 0; d <= MAX && D < 0; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { D = d; break; }
    }
  }
  if (D < 0) return null;
  const runs = []; let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const Vp = trace[d], at = k => Vp[k + d + 1], k = x - y;
    const pk = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk, xs = pk === k + 1 ? px : px + 1;
    if (x > xs) runs.push([xs, xs - k, x - xs]);
    x = px; y = py;
  }
  if (x > 0) runs.push([0, 0, x]);
  runs.reverse();
  const parts = []; let ax = 0;
  for (const [xs, ys, n] of runs) { for (let k = ax; k < xs; k++) parts.push(own(A0[k])); parts.push([ys, n]); ax = xs + n; }
  for (let k = ax; k < N; k++) parts.push(own(A0[k]));
  return { parts, size: parts.reduce((t, q) => t + (typeof q === 'string' ? q.length : 16), 0) };
}
export class Steps {
  constructor() { this.a = []; }
  get length() { return this.a.length; }
  push(st) {
    const n = this.a.length;
    if (n) { const top = this.a[n - 1]; this.a[n - 1] = { d: top.xml.map((x, i) => diffText(x, st.xml[i])), ops: top.ops }; }
    this.a.push(st);
  }
  pop() {
    const st = this.a.pop(); if (!st) return undefined;
    const n = this.a.length;
    if (n) { const below = this.a[n - 1]; this.a[n - 1] = { xml: below.d.map((d, i) => applyText(d, st.xml[i])), ops: below.ops }; }
    return st;
  }
  shift() { this.a.shift(); }
  size() {
    let n = 0;
    for (const st of this.a) if (st.xml) n += st.xml.reduce((t, x) => t + x.length, 0); else for (const d of st.d) if (d) n += (d.parts ? d.size : d.mid.length) + 64;
    return n;
  }
}

export class MsDoc {
  static async open(buf) {
    const d = new MsDoc();
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    d.entries = [];
    for (const e of readZip(ab)) d.entries.push({ name: e.name, data: new Uint8Array(await (await e.blob()).arrayBuffer()) });
    d.files = [];
    for (const e of d.entries) {
      if (!/\.mscx$/i.test(e.name)) continue;
      const text = new TextDecoder().decode(e.data);
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error(t('קובץ MuseScore פגום: {name}', { name: e.name }));
      const main = !e.name.startsWith('Excerpts/');
      d.files.push({ entry: e, doc, main, head: text.match(/^<\?xml[^>]*\?>\s*/)?.[0] || '' });
    }
    // which files show concert pitch: there a transposing instrument's chord symbols are stored in concert
    for (const f of d.files) {
      const dir = f.entry.name.includes('/') ? f.entry.name.slice(0, f.entry.name.lastIndexOf('/') + 1) : '';
      const mss = d.entries.find(e => /\.mss$/i.test(e.name) && (f.main ? !e.name.startsWith('Excerpts/') : e.name.startsWith(dir)));
      const style = mss ? new TextDecoder().decode(mss.data) : new XMLSerializer().serializeToString(f.doc);
      f.concert = /<concertPitch>1<\/concertPitch>/.test(style);
    }
    d.main = d.files.find(f => f.main);
    if (!d.main) throw new Error(t('בקובץ אין פרטיטורה'));
    d.files.sort((a, b) => b.main - a.main);   // the full score first: parts link to what it gets
    d.linked = d.files.length > 1;
    // MuseScore 4.6 links a part's element to the score's by eid (<linkedTo>); before, by order (<linked>)
    d.eidLinks = d.linked && d.files.some(f => !f.main && f.doc.querySelector('voice linkedTo'));
    for (const f of d.files) d.index(f);
    // MuseScore 4.6 keeps a chord symbol's root / kind / bass inside <harmonyInfo>
    d.v46 = parseFloat(d.main.doc.documentElement.getAttribute('version') || '0') >= 4.6;
    d.history = new Steps(); d.future = new Steps(); d.ops = []; d.changes = 0; d.rev = 0;
    return d;
  }

  // staves (with music) of a file, and how they map to the main score's staves
  index(f) {
    const score = f.doc.querySelector('museScore > Score');
    f.score = score;
    f.parts = kids(score, 'Part');
    f.staffEls = new Map();
    for (const s of kids(score, 'Staff')) f.staffEls.set(s.getAttribute('id'), s);
    // staves are numbered in order (newer files leave the id out of the instrument's staff)
    f.toLocal = new Map(); f.partOf = new Map(); f.ids = new Map();
    let k = 0;
    for (const p of f.parts) for (const s of kids(p, 'Staff')) {
      const id = s.getAttribute('id') || String(k + 1); k = +id || k + 1;
      f.ids.set(s, id);
      let link = txt(s, 'linkedTo');
      if (link && !/^\d+$/.test(link)) link = this.staffByEid && this.staffByEid.get(link);
      if (f.main) { (this.staffByEid = this.staffByEid || new Map()).set(txt(s, 'eid'), id); }
      f.toLocal.set(f.main ? id : (link || id), id);
      f.partOf.set(id, p);
    }
  }

  // ---------------------------------------------------------------- reading
  staves() {
    const out = [];
    for (const p of this.main.parts) {
      const name = txt(p, 'trackName') || (p.querySelector('Instrument longName') || {}).textContent || 'כלי';
      const ids = kids(p, 'Staff').map(s => this.main.ids.get(s));
      ids.forEach((id, k) => out.push({ id, part: name, label: ids.length > 1 ? `${name} ${k + 1}` : name, drums: /<Drumset>|<useDrumset>1/.test(new XMLSerializer().serializeToString(p)) }));
    }
    return out;
  }
  // main staff ids shown in a part (by the part's name), all staves for the full score
  stavesOfPart(partName) {
    if (!partName) return this.staves().map(s => s.id);
    const f = this.files.find(x => !x.main && (x.doc.querySelector('metaTag[name="partName"]') || {}).textContent === partName);
    if (!f) return this.staves().map(s => s.id);
    return [...f.toLocal.keys()];
  }
  // the measures of a staff. In parts MuseScore also stores the multi-measure rests it drew, as extra
  // <Measure> elements in front of the measures they stand for: those are not measures of the music.
  measures(f, staff) {
    const local = f.toLocal.get(staff);
    const el = local && f.staffEls.get(local);
    return el ? staffMeasures(el) : [];
  }
  measureCount() { return this.measures(this.main, this.staves()[0].id).length; }

  // time signature and key at a measure (from the first staff, read in order)
  context(staff, m) {
    let n = 4, dd = 4, key = 0;
    const ms = this.measures(this.main, staff);
    for (let i = 0; i <= m && i < ms.length; i++) {
      for (const v of kids(ms[i], 'voice')) {
        const ts = kid(v, 'TimeSig'); if (ts) { n = +txt(ts, 'sigN'); dd = +txt(ts, 'sigD'); }
        const ks = kid(v, 'KeySig'); if (ks && txt(ks, 'concertKey') != null) key = +txt(ks, 'concertKey');
      }
    }
    const len = ms[m] && ms[m].getAttribute('len');
    return { len: len ? fracTicks(len) : 1920 * n / dd, key, timesig: `${n}/${dd}` };
  }

  // the events of one voice in one measure: chords and rests, with their place in the measure
  events(staff, m, voice = 0, f = this.main) {
    const meas = this.measures(f, staff)[m];
    if (!meas) return null;
    const v = kids(meas, 'voice')[voice];
    const ctx = this.context(staff, m);
    const out = { voiceEl: v, events: [], marks: [], complex: false, len: ctx.len, key: ctx.key };
    if (!v) return out;
    let tick = 0; let tuplet = 0;
    // inside a tuplet a note lasts normal/actual of its value (three eighths in the time of two)
    const ratio = []; const scaled = x => ratio.reduce((v, [n, a]) => v * n, x) / ratio.reduce((v, [, a]) => v * a, 1);
    for (const c of kids(v)) {
      const tag = c.tagName;
      if (tag === 'Chord' || tag === 'Rest') {
        let d;
        const type = txt(c, 'durationType');
        if (type === 'measure') d = fracTicks(txt(c, 'duration') || ctx.timesig);
        else d = scaled(ticksOf(type, +(txt(c, 'dots') || 0)));
        if (tuplet) out.complex = 'tuplet';
        const grace = !!(kid(c, 'acciaccatura') || kid(c, 'appoggiatura') || kid(c, 'grace4') || kid(c, 'grace8after') || kid(c, 'grace16') || kid(c, 'grace32') || kid(c, 'grace8'));
        const ev = { el: c, rest: tag === 'Rest', type, dots: +(txt(c, 'dots') || 0), ticks: grace ? 0 : d, tick, grace,
          notes: kids(c, 'Note').map(n => ({ el: n, pitch: +txt(n, 'pitch'), tpc: +txt(n, 'tpc'), tpc2: txt(n, 'tpc2') != null ? +txt(n, 'tpc2') : null, slash: txt(n, 'fixed') === '1' || txt(n, 'head') === 'slash' })) };
        ev.slash = !ev.rest && ev.notes.length > 0 && ev.notes.every(n => n.slash) ? (kid(c, 'noStem') && txt(c, 'noStem') === '1' ? 'slash' : 'rhythm') : null;
        out.events.push(ev);
        if (!grace) tick += d;
      } else if (tag === 'Tuplet') {
        tuplet++; out.complex = 'tuplet';
        const n = +txt(c, 'normalNotes') || 2, a = +txt(c, 'actualNotes') || 3;
        ratio.push([n, a]);
      }
      else if (tag === 'endTuplet') { tuplet = Math.max(0, tuplet - 1); ratio.pop(); }
      else if (tag === 'location') { out.complex = out.complex || 'location'; const fr = c.querySelector('fractions'); if (fr) tick += fracTicks(fr.textContent); out.marks.push({ el: c, tick: null }); }
      else if (tag !== 'eid') out.marks.push({ el: c, tick });
    }
    return out;
  }

  // ---------------------------------------------------------------- one change everywhere
  // run fn on the same place in the full score and every part that has that staff
  each(staff, fn) {
    let did = 0;
    this.made = new Map();
    for (const f of this.files) {
      if (!f.toLocal.has(staff)) continue;
      this.linkTo(f, staff);
      fn(f); did++;
    }
    return did;
  }
  // new elements in a part are linked to the ones just made in the score, in the same order
  linkTo(f, staff) { this.cur = { f, staff, k: 0 }; if (f.main) this.made.set(staff, []); }
  // every change can be undone (and redone); `ops` lists inserted/removed measures (pencil marks move with them)
  // a snapshot shares the text of every file not changed since the last one (a big song has ~30 files;
  // an edit touches the score and one or two parts), so undo stays fast and small
  watch(f) {
    if (f.obs) f.obs.disconnect();
    // changes are seen right away (takeRecords) or, once the browser has handed them to the observer, by `dirty`
    f.obs = new MutationObserver(() => { f.dirty = true; });
    f.obs.observe(f.doc, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  text(f) {
    if (!f.obs) { this.watch(f); f.ser = null; }
    if (f.obs.takeRecords().length || f.dirty) { f.ser = null; f.dirty = false; }
    return f.ser || (f.ser = new XMLSerializer().serializeToString(f.doc));
  }
  state() { return { xml: this.files.map(f => this.text(f)), ops: this.ops.slice() }; }
  restore(s) {
    this.files.forEach((f, i) => {
      if (this.text(f) === s.xml[i]) return;
      f.doc = new DOMParser().parseFromString(s.xml[i], 'application/xml');
      this.index(f); this.watch(f); f.ser = s.xml[i]; f.dirty = false;
    });
    this.ops = s.ops.slice();
  }
  snapshot() {
    if (this.quiet) return;
    this.history.push(this.state());
    this.trim();
    this.future = new Steps();
    this.changes++; this.rev = (this.rev || 0) + 1;
  }
  // at most 200 steps, and not much more than ~60 MB of file text kept for them (steps are kept as
  // differences, so a big song keeps its whole history)
  trim() {
    while (this.history.length > 200 || (this.history.length > 5 && this.history.size() > 60e6)) this.history.shift();
  }
  undo() {
    const s = this.history.pop(); if (!s) return false;
    this.future.push(this.state());
    this.restore(s); this.changes = Math.max(0, this.changes - 1); this.rev = (this.rev || 0) + 1;
    return true;
  }
  redo() {
    const s = this.future.pop(); if (!s) return false;
    this.history.push(this.state());
    this.restore(s); this.changes++; this.rev = (this.rev || 0) + 1;
    return true;
  }
  // several changes as one: one undo step, and nothing changes when one of them fails
  batch(fn) {
    if (this.quiet) return fn();
    this.snapshot(); this.quiet = true;
    try { return fn(); } catch (e) { this.quiet = false; this.undo(); this.future.pop(); throw e; } finally { this.quiet = false; }
  }
  saved() { this.changes = 0; this.ops = []; this.history = new Steps(); this.future = new Steps(); }
  canUndo() { return this.history.length > 0; }
  canRedo() { return this.future.length > 0; }

  newEl(f, tag, children = []) {
    const el = f.doc.createElement(tag);
    const add = (t, v) => { const c = f.doc.createElement(t); if (v != null) c.textContent = v; el.append(c); };
    if (this.eidLinks) {
      const eid = newEid(); add('eid', eid);
      const q = this.cur && this.made && this.made.get(this.cur.staff);
      if (f.main) { if (q) q.push(eid); } else if (q && q[this.cur.k] && this.cur.f === f) add('linkedTo', q[this.cur.k++]);
    } else if (this.linked) add(f.main ? 'linkedMain' : 'linked');
    for (const [t, v] of children) { const c = f.doc.createElement(t); if (v instanceof Node) c.append(v); else c.textContent = v; el.append(c); }
    return el;
  }
  writtenIv(f, staff) {
    const p = f.partOf.get(f.toLocal.get(staff)); if (!p) return null;
    const d = +(p.querySelector('Instrument transposeDiatonic') || {}).textContent || 0;
    const c = +(p.querySelector('Instrument transposeChromatic') || {}).textContent || 0;
    return d || c ? [-d, -c] : null;
  }
  noteEl(f, staff, pitch, tpc) {
    const wi = this.writtenIv(f, staff);
    const kv = [['pitch', String(pitch)], ['tpc', String(tpc)]];
    if (wi) kv.push(['tpc2', String(transposeTpc(tpc, wi, false))]);
    return this.newEl(f, 'Note', kv);
  }
  setNoteValues(f, staff, el, pitch, tpc) {
    const set = (tag, v) => { let k = kid(el, tag); if (!k) { k = f.doc.createElement(tag); el.append(k); } k.textContent = String(v); };
    set('pitch', pitch); set('tpc', tpc);
    const wi = this.writtenIv(f, staff);
    if (wi) set('tpc2', transposeTpc(tpc, wi, false)); else { const k = kid(el, 'tpc2'); if (k) k.remove(); }
  }

  // ---------------------------------------------------------------- notes
  // pitch of one note (tpc: the spelling; by default the one the key prefers)
  setPitch(a, pitch, tpc = null) {
    const ev = this.events(a.staff, a.m, a.voice);
    const e = ev && ev.events[a.i];
    if (!e || e.rest || !e.notes[a.n]) throw new Error(t('אין תו במקום הזה'));
    if (pitch < 0 || pitch > 127) throw new Error(t('הצליל מחוץ לטווח'));
    const tp = tpc ?? pitchToTpc(pitch, ev.key);
    this.snapshot();
    this.each(a.staff, f => {
      const x = this.events(a.staff, a.m, a.voice, f).events[a.i];
      if (!x || !x.notes[a.n]) return;
      if (x.notes[a.n].pitch !== pitch) this.dropTies(f, a, x, [x.notes[a.n]]);
      this.setNoteValues(f, a.staff, x.notes[a.n].el, pitch, tp);
      if (x.slash) this.slashEl(f, x.el, null);
    });
  }
  // up/down one step of the scale, a semitone, or an octave
  move(a, how) {
    const ev = this.events(a.staff, a.m, a.voice);
    const e = ev && ev.events[a.i]; const n = e && e.notes[a.n];
    if (!n) throw new Error(t('אין תו במקום הזה'));
    let { pitch, tpc } = n;
    if (how === 'octUp') pitch += 12;
    else if (how === 'octDown') pitch -= 12;
    else if (how === 'sharp') { pitch += 1; tpc = tpcAlter(tpc) < 1 ? tpc + 7 : pitchToTpc(pitch, ev.key); }
    else if (how === 'flat') { pitch -= 1; tpc = tpcAlter(tpc) > -1 ? tpc - 7 : pitchToTpc(pitch, ev.key); }
    else if (how === 'natural') { const nt = NATURAL_TPC[tpcStep(tpc)]; pitch += -tpcAlter(tpc); tpc = nt; }
    else {
      const dir = how === 'up' ? 1 : -1;
      const step = (tpcStep(tpc) + dir + 7) % 7;
      const nt = keyTpc(step, ev.key);
      const cls = tpcClass(nt);
      let p = pitch + dir; while (((p % 12) + 12) % 12 !== cls) p += dir;
      pitch = p; tpc = nt;
    }
    this.setPitch(a, pitch, tpc);
    return { pitch, tpc };
  }
  // a letter name typed in: the nearest such note to `near` (the key gives the sharp/flat)
  pitchForLetter(step, near, key, alter = null) {
    const t = alter == null ? keyTpc(step, key) : NATURAL_TPC[step] + 7 * alter;
    const cls = tpcClass(t);
    let best = null;
    for (let p = near - 6; p <= near + 6; p++) if (((p % 12) + 12) % 12 === cls && (best == null || Math.abs(p - near) < Math.abs(best - near))) best = p;
    return { pitch: best, tpc: t };
  }
  addNote(a, pitch, tpc = null) {
    const ev = this.events(a.staff, a.m, a.voice);
    const e = ev && ev.events[a.i];
    if (!e) throw new Error(t('אין אירוע במקום הזה'));
    const tp = tpc ?? pitchToTpc(pitch, ev.key);
    this.snapshot();
    this.each(a.staff, f => {
      const x = this.events(a.staff, a.m, a.voice, f).events[a.i]; if (!x) return;
      if (x.rest) {
        const ch = this.chordLike(f, x, a.staff, [[pitch, tp]]);
        x.el.replaceWith(ch);
      } else {
        if (x.notes.some(nn => nn.pitch === pitch)) return;
        const nn = this.noteEl(f, a.staff, pitch, tp);
        if (x.slash) this.slashNote(f, nn, true);
        const after = x.notes.filter(q => q.pitch < pitch).pop();
        if (after) after.el.after(nn); else if (x.notes[0]) x.notes[0].el.before(nn); else x.el.append(nn);
      }
    });
  }
  // a chord with the same length as event x
  chordLike(f, x, staff, notes) {
    const kv = [];
    if (x.type === 'measure') { const [t, dd] = typeFor(x.ticks) || ['whole', 0]; if (dd) kv.push(['dots', String(dd)]); kv.push(['durationType', t]); }
    else { if (x.dots) kv.push(['dots', String(x.dots)]); kv.push(['durationType', x.type]); }
    const ch = this.newEl(f, 'Chord', kv);
    for (const [p, t] of notes) ch.append(this.noteEl(f, staff, p, t));
    return ch;
  }
  restLike(f, x) {
    const kv = [];
    if (x.dots) kv.push(['dots', String(x.dots)]);
    kv.push(['durationType', x.type === 'measure' ? 'measure' : x.type]);
    if (x.type === 'measure') kv.push(['duration', txt(x.el, 'duration') || '4/4']);
    return this.newEl(f, 'Rest', kv);
  }
  // remove a note; the last note of a chord turns it into a rest
  deleteNote(a) {
    const e = this.events(a.staff, a.m, a.voice).events[a.i];
    if (!e || e.rest) throw new Error(t('אין תו במקום הזה'));
    this.snapshot();
    this.each(a.staff, f => {
      const x = this.events(a.staff, a.m, a.voice, f).events[a.i]; if (!x || x.rest) return;
      if (x.notes.length > 1 && x.notes[a.n]) { this.dropTies(f, a, x, [x.notes[a.n]]); x.notes[a.n].el.remove(); }
      else { this.dropTies(f, a, x); if (x.grace) x.el.remove(); else x.el.replaceWith(this.restLike(f, x)); }
    });
  }
  toRest(a) { const e = this.events(a.staff, a.m, a.voice).events[a.i]; if (e && !e.rest) { this.snapshot(); this.each(a.staff, f => { const x = this.events(a.staff, a.m, a.voice, f).events[a.i]; if (x && !x.rest) { this.dropTies(f, a, x); if (x.grace) x.el.remove(); else x.el.replaceWith(this.restLike(f, x)); } }); } }
  // remove the ties on these notes, and the other half of each tie (on the note it comes from or goes to)
  dropTies(f, a, x, notes = x.notes, only = null) {
    for (const n of notes) for (const sp of kids(n.el, 'Spanner')) {
      if (sp.getAttribute('type') !== 'Tie') continue;
      if (only && !kid(sp, only)) continue;
      const p = this.tiePartner(f, a, x, n, sp);
      if (p) p.remove();
      sp.remove();
    }
  }
  tiePartner(f, a, x, n, sp) {
    const dir = kid(sp, 'next') ? 'next' : kid(sp, 'prev') ? 'prev' : null;
    const loc = dir && kid(kid(sp, dir), 'location');
    if (!loc || kid(loc, 'staves') || kid(loc, 'voices')) return null;
    const ev = this.events(a.staff, a.m + +(txt(loc, 'measures') || 0), a.voice, f);
    const at = x.tick + fracTicks(txt(loc, 'fractions') || '0/1');
    const t = ev && ev.events.find(e => !e.grace && !e.rest && Math.abs(e.tick - at) < 1);
    const q = t && t.notes.find(z => z.pitch === n.pitch);
    return q ? kids(q.el, 'Spanner').find(z => z.getAttribute('type') === 'Tie' && kid(z, dir === 'next' ? 'prev' : 'next')) : null;
  }

  // a new length for one event. Longer eats the following events, shorter leaves a rest (like MuseScore).
  setDuration(a, type, dots = 0) {
    const ev = this.events(a.staff, a.m, a.voice);
    if (!ev || !ev.events[a.i]) throw new Error(t('אין אירוע במקום הזה'));
    if (ev.complex === 'tuplet') throw new Error(t('בתיבה הזו יש טריולות: אפשר לשנות כאן גובה צליל, לא אורך'));
    const e = ev.events[a.i];
    if (e.grace) throw new Error(t('אי אפשר לשנות אורך של תו קישוט'));
    const want = ticksOf(type, dots);
    if (!want) throw new Error(t('אורך לא מוכר'));
    const room = ev.len - e.tick;
    if (want > room) throw new Error(t('האורך הזה יוצא מהתיבה'));
    if (want === e.ticks && type === e.type && dots === e.dots) return;
    this.snapshot();
    this.each(a.staff, f => this.rewrite(f, a, x => {
      // x: the events of this voice; keep everything before, the changed one, then refill
      const out = []; let t = 0;
      for (const y of x.events) {
        if (y.grace) { if (y.tick < e.tick || (y.tick === e.tick && out.length < a.i)) out.push({ keep: y }); continue; }
        if (y.tick < e.tick) { out.push({ keep: y }); t = y.tick + y.ticks; continue; }
        break;
      }
      const cur = x.events[a.i];
      out.push({ like: cur, type, dots, ticks: want });
      t = e.tick + want;
      // following events: those that start after the new end stay; one cut in half becomes rests
      const end = e.tick + e.ticks;
      for (const y of x.events) {
        if (y.grace || y.tick <= e.tick) continue;
        if (y.tick >= t) { if (y.tick > t) out.push(...split(y.tick - t).map(([ty, dd]) => ({ rest: true, type: ty, dots: dd }))); out.push({ keep: y }); t = y.tick + y.ticks; }
        else if (y.tick + y.ticks > t) { out.push(...split(y.tick + y.ticks - t).map(([ty, dd]) => ({ rest: true, type: ty, dots: dd }))); t = y.tick + y.ticks; }
      }
      if (t < Math.max(end, x.len)) out.push(...split(Math.max(end, x.len) - t).map(([ty, dd]) => ({ rest: true, type: ty, dots: dd })));
      return out;
    }));
  }

  // rebuild one voice of one measure in one file from a plan of events
  rewrite(f, a, plan) {
    const x = this.events(a.staff, a.m, a.voice, f);
    if (!x || !x.voiceEl) return;
    const steps = plan(x);
    const v = x.voiceEl;
    // a changed or removed event loses its ties (their other end would point to the wrong place)
    // (an event that only changes its length keeps the tie coming into it: its start doesn't move)
    for (const y of x.events) if (!y.rest && !steps.some(st => st.keep === y)) this.dropTies(f, a, y, y.notes, steps.some(st => st.like === y && !y.rest && y.type !== 'measure') ? 'next' : null);
    // marks (chord symbols, texts, dynamics, key/time signatures…) stay at their place in time
    const marks = x.marks.filter(mk => mk.el.tagName !== 'location');
    const nodes = [];
    let t = 0;
    const placeMarks = upTo => { for (const mk of marks) if (!mk.done && mk.tick <= upTo) { nodes.push(mk.el); mk.done = true; } };
    for (const s of steps) {
      placeMarks(t);
      let el;
      if (s.keep) { el = s.keep.el; t += s.keep.ticks; }
      else if (s.rest) {
        el = this.newEl(f, 'Rest', [...(s.dots ? [['dots', String(s.dots)]] : []), ['durationType', s.type]]);
        t += ticksOf(s.type, s.dots);
      } else {
        const src = s.like;
        if (src.rest || src.type === 'measure') {
          el = src.rest ? this.newEl(f, 'Rest', [...(s.dots ? [['dots', String(s.dots)]] : []), ['durationType', s.type]]) : null;
          if (!el) { el = this.chordLike(f, { ...src, type: s.type, dots: s.dots }, a.staff, src.notes.map(n => [n.pitch, n.tpc])); }
        } else {
          el = src.el;
          let dt = kid(el, 'durationType'); dt.textContent = s.type;
          let dd = kid(el, 'dots');
          if (s.dots) { if (!dd) { dd = f.doc.createElement('dots'); dt.before(dd); } dd.textContent = String(s.dots); } else if (dd) dd.remove();
          const du = kid(el, 'duration'); if (du) du.remove();
        }
        t += s.ticks;
      }
      nodes.push(el);
    }
    placeMarks(Infinity);
    const eid = kid(v, 'eid');
    v.replaceChildren(...(eid ? [eid] : []), ...nodes);
  }

  // replace an event by a note of the given letter (note input): keeps its length
  setEventPitch(a, pitch, tpc) {
    const e = this.events(a.staff, a.m, a.voice).events[a.i];
    if (!e) throw new Error(t('אין אירוע במקום הזה'));
    if (!e.rest && (e.notes.length === 1 || e.grace)) return this.setPitch({ ...a, n: 0 }, pitch, tpc);
    this.snapshot();
    this.each(a.staff, f => {
      const x = this.events(a.staff, a.m, a.voice, f).events[a.i]; if (!x) return;
      if (!x.rest) this.dropTies(f, a, x);
      x.el.replaceWith(this.chordLike(f, x, a.staff, [[pitch, tpc]]));
    });
  }

  // ---------------------------------------------------------------- chord symbols and texts
  // text like "Am7", "F#m7b5/C#", "Bbmaj7": root, kind, bass
  static parseChord(s) {
    if (/^\s*n\.?\s*c\.?\s*$/i.test(String(s))) return { root: null, name: 'N.C.', base: null };
    const m = String(s).trim().match(/^([A-Ga-g])([#♯b♭]?)(.*?)(?:\/([A-Ga-g])([#♯b♭]?))?$/);
    if (!m) return null;
    const tpcOf = (l, acc) => NATURAL_TPC[NOTE_NAMES.indexOf(l.toUpperCase())] + (/[#♯]/.test(acc) ? 7 : /[b♭]/.test(acc) ? -7 : 0);
    return { root: tpcOf(m[1], m[2]), name: m[3].trim(), base: m[4] ? tpcOf(m[4], m[5]) : null };
  }
  static chordText(h) {
    const nm = t => NOTE_NAMES[tpcStep(t)] + (tpcAlter(t) > 0 ? '#' : tpcAlter(t) < 0 ? 'b' : '');
    return h.root != null ? nm(h.root) + (h.name || '') + (h.base != null ? '/' + nm(h.base) : '') : (h.name || '');
  }
  // chord symbols in a measure (voice 1), with their place
  chordSymbols(staff, m) {
    const ev = this.events(staff, m, 0);
    // shown as the player reads it (written pitch for a transposing instrument)
    const iv = this.main.concert ? this.writtenIv(this.main, staff) : null;
    const w = t => t == null ? null : iv ? transposeTpc(t, iv, false) : t;
    return ev ? ev.marks.filter(mk => mk.el.tagName === 'Harmony').map(mk => {
      const hi = kid(mk.el, 'harmonyInfo') || mk.el;
      const bs = txt(hi, 'bass') ?? txt(hi, 'base');
      return { tick: mk.tick, text: MsDoc.chordText({ root: w(txt(hi, 'root') != null ? +txt(hi, 'root') : null), name: txt(hi, 'name'), base: w(bs != null ? +bs : null) }) };
    }) : [];
  }
  // put (or change, or remove with '') a chord symbol at a place in a measure
  setChordSymbol(staff, m, tick, text) {
    const c = text ? MsDoc.parseChord(text) : null;
    if (text && !c) throw new Error(t('לא הבנתי את האקורד. למשל: Am7, F#m7b5, Bb/D'));
    this.snapshot();
    this.each(staff, f => this.setMark(f, staff, m, tick, 'Harmony', c && (el => {
      for (const tag of ['root', 'rootCase', 'name', 'base', 'harmonyInfo']) { const k = kid(el, tag); if (k) k.remove(); }
      // typed as written; a file that shows concert pitch keeps a transposing instrument's chords in concert
      const iv = f.concert ? this.writtenIv(f, staff) : null;
      const st = t => iv ? transposeTpc(t, [-iv[0], -iv[1]], false) : t;
      if (this.v46) {
        // <harmonyInfo> first, as MuseScore 4.6 writes it
        const hi = f.doc.createElement('harmonyInfo');
        const add = (tag, v) => { const k = f.doc.createElement(tag); k.textContent = String(v); hi.append(k); };
        if (c.name) add('name', c.name); if (c.root != null) add('root', st(c.root)); if (c.base != null) add('bass', st(c.base));
        el.prepend(hi);
        return;
      }
      const add = (tag, v) => { const k = f.doc.createElement(tag); k.textContent = String(v); const lk = kid(el, 'linkedMain') || kid(el, 'linked'); if (lk) lk.before(k); else el.append(k); };
      if (c.root != null) { add('root', st(c.root)); add('rootCase', 1); } if (c.name) add('name', c.name); if (c.base != null) add('base', st(c.base));
    })));
  }
  texts(staff, m, tag, f = this.main) {
    const ev = this.events(staff, m, 0, f);
    return ev ? ev.marks.filter(mk => mk.el.tagName === tag).map(mk => ({ tick: mk.tick, text: (kid(mk.el, 'text') || {}).textContent || '' })) : [];
  }
  setText(staff, m, tick, tag, text) {
    this.snapshot();
    this.each(staff, f => this.setMark(f, staff, m, tick, tag, text && (el => {
      let t = kid(el, 'text'); if (!t) { t = f.doc.createElement('text'); el.append(t); }
      t.textContent = text;
    })));
  }
  // one mark of a kind at a place: fill(el) edits it, no fill removes it
  setMark(f, staff, m, tick, tag, fill) {
    const x = this.events(staff, m, 0, f);
    if (!x || !x.voiceEl) return;
    const old = x.marks.find(mk => mk.el.tagName === tag && mk.tick === tick);
    if (!fill) { if (old) old.el.remove(); return null; }
    if (old) { fill(old.el); return null; }
    const el = this.newEl(f, tag);
    fill(el);
    const at = x.events.find(e => e.tick >= tick && !e.grace);
    if (at) at.el.before(el); else x.voiceEl.append(el);
    return el;
  }
  // rehearsal marks belong to the whole system: in the score on the top staff, in each part on its top staff
  systemTexts(m, tag = 'RehearsalMark') { return this.texts([...this.main.toLocal.keys()][0], m, tag); }
  setSystemText(m, tick, tag, text) {
    this.snapshot();
    const top = [...this.main.toLocal.keys()][0];
    this.made = new Map();
    for (const f of this.files) {
      const st = f.main ? top : [...f.toLocal.keys()][0];
      if (!st) continue;
      this.linkTo(f, 'sys');
      const el = this.setMark(f, st, m, tick, tag, text && (e => { let t = kid(e, 'text'); if (!t) { t = f.doc.createElement('text'); e.append(t); } t.textContent = text; }));
      // older files: the part's copy says how many staves away the score's mark is
      const lk = el && !f.main && kid(el, 'linked');
      if (lk && st !== top && /^\d+$/.test(st) && /^\d+$/.test(top)) {
        const loc = f.doc.createElement('location'); const sv = f.doc.createElement('staves'); sv.textContent = String(+top - +st); loc.append(sv); lk.append(loc);
      }
    }
  }

  // ---------------------------------------------------------------- measures
  insertMeasure(m) {
    const n = this.measureCount();
    if (m < 0 || m > n) throw new Error(t('מקום לא תקין'));
    this.snapshot();
    const first = [...this.main.toLocal.keys()][0];
    const ctx = this.context(first, Math.max(0, m - 1));
    this.made = new Map();
    for (const f of this.files) for (const [mainId, local] of f.toLocal) {
      const staffEl = f.staffEls.get(local); if (!staffEl) continue;
      const ms = staffMeasures(staffEl); if (!ms.length) continue;
      this.shiftSpanners(staffEl, m, 'insert');
      this.linkTo(f, mainId);
      const meas = f.doc.createElement('Measure');
      if (kid(ms[Math.min(m, ms.length - 1)], 'eid')) { const e = f.doc.createElement('eid'); e.textContent = newEid(); meas.append(e); }
      const v = f.doc.createElement('voice');
      v.append(this.newEl(f, 'Rest', [['durationType', 'measure'], ['duration', ctx.timesig]]));
      meas.append(v);
      if (m >= ms.length) ms[ms.length - 1].after(meas);
      else {
        ms[m].before(meas);
        // a new first measure takes over the key and time signature (and tempo) the song starts with
        if (m === 0) this.moveStarters(ms[0], meas);
      }
    }
    this.ops.push({ op: 'insert', m });
    return true;
  }
  moveStarters(from, to) {
    const fv = kids(from, 'voice')[0]; const tv = kids(to, 'voice')[0]; if (!fv || !tv) return;
    const first = kids(tv).find(c => c.tagName !== 'eid');
    for (const tag of ['Clef', 'KeySig', 'TimeSig', 'Tempo']) { const k = kid(fv, tag); if (k && !kid(tv, tag)) tv.insertBefore(k, first); }
  }
  deleteMeasure(m) {
    const n = this.measureCount();
    if (n <= 1) throw new Error(t('אי אפשר למחוק את התיבה היחידה'));
    this.snapshot();
    for (const f of this.files) for (const [, local] of f.toLocal) {
      const staffEl = f.staffEls.get(local); if (!staffEl) continue;
      const ms = staffMeasures(staffEl); const el = ms[m]; if (!el) continue;
      this.shiftSpanners(staffEl, m, 'delete');
      // key, time signature and tempo that start here move to the next measure
      if (ms[m + 1]) this.moveStarters(el, ms[m + 1]);
      el.remove();
    }
    this.ops.push({ op: 'delete', m });
    return true;
  }
  // ties, slurs, hairpins… find their other end by a distance in measures: keep that right when a
  // measure comes in or goes out between the two ends (both ends go when one is in a deleted measure)
  shiftSpanners(staffEl, m, op) {
    const ms = staffMeasures(staffEl);
    ms.forEach((meas, i) => {
      for (const sp of meas.querySelectorAll('Spanner')) {
        const dir = kid(sp, 'next') ? 'next' : kid(sp, 'prev') ? 'prev' : null;
        const loc = dir && kid(kid(sp, dir), 'location');
        if (!loc) continue;
        let me = kid(loc, 'measures'); const d = me ? +me.textContent : 0;
        const target = i + d;
        let nd = d;
        if (op === 'insert') {
          if (dir === 'next' && i < m && target >= m) nd = d + 1;
          if (dir === 'prev' && i >= m && target < m) nd = d - 1;
        } else {
          if (i === m) continue;                       // goes with its measure
          if (target === m) { sp.remove(); continue; } // its other end is in the deleted measure
          if (dir === 'next' && i < m && target > m) nd = d - 1;
          if (dir === 'prev' && i > m && target < m) nd = d + 1;
        }
        if (nd === d) continue;
        if (!me) { me = staffEl.ownerDocument.createElement('measures'); loc.prepend(me); }
        if (nd) me.textContent = String(nd); else me.remove();
      }
    });
  }

  // ---------------------------------------------------------------- note input
  // the event at a becomes a note (notes: [[pitch, tpc]…]) or a rest of this length, and the place after it
  // is returned. Longer than what is left of the measure: tied over the barline, as MuseScore does.
  enter(a, { type, dots = 0, notes = null, rest = false, slash = null }) {
    return this.batch(() => {
      const ev = this.events(a.staff, a.m, a.voice);
      const e = ev && ev.events[a.i];
      if (!e) throw new Error(t('אין אירוע במקום הזה'));
      let want = type ? ticksOf(type, dots) : e.ticks;
      if (!want) throw new Error(t('אורך לא מוכר'));
      let cur = { ...a, n: 0 };
      const put = (at, ty, dd) => {
        const x = this.events(at.staff, at.m, at.voice).events[at.i];
        if (ty && (x.type !== ty || (x.dots || 0) !== dd)) this.setDuration(at, ty, dd);
        const y = this.events(at.staff, at.m, at.voice).events[at.i];
        if (rest || !notes || !notes.length) { this.toRest(at); return; }
        // already these notes (the second half of a tied note): kept, with its tie
        if (!(!y.rest && y.notes.length === notes.length && notes.every(([p]) => y.notes.some(q => q.pitch === p)))) {
          this.setEventPitch(at, notes[0][0], notes[0][1]); for (const [p, tp] of notes.slice(1)) this.addNote(at, p, tp);
        }
        // a slash written in (rhythmic notation), or a note written over a slash
        const z = this.events(at.staff, at.m, at.voice).events[at.i];
        if (z && !z.rest && (z.slash || null) !== slash) this.setSlash([at.staff], at.m, at.m, at.voice, slash, at.i);
      };
      for (let guard = 0; guard < 16; guard++) {
        const x = this.events(cur.staff, cur.m, cur.voice);
        const y = x.events[cur.i];
        const room = x.len - y.tick;
        if (want <= room) {
          const parts = type && want === ticksOf(type, dots) && guard === 0 ? [[type, dots]] : splitNote(want);
          for (let k = 0; k < parts.length; k++) {
            put(cur, parts[k][0], parts[k][1]);
            if (k < parts.length - 1) { const nx = this.nextOf(cur); cur = this.tieOn(cur, nx, rest); }
          }
          const nx = this.nextOf(cur);
          return nx ? { staff: nx.staff, m: nx.m, voice: nx.voice, i: nx.i, n: 0 } : null;
        }
        // what fits in this measure, tied to the rest in the next one
        const parts = splitNote(room);
        for (let k = 0; k < parts.length; k++) {
          put(cur, parts[k][0], parts[k][1]);
          const nx = this.nextOf(cur);
          if (!nx) return null;   // the end of the song: the note is cut there
          cur = this.tieOn(cur, nx, rest);
        }
        want -= room;
      }
      return null;
    });
  }

  // note input going on over a tie: what was at the next place is written over (as in MuseScore), and tied to
  tieOn(cur, nx, rest) {
    const b = { staff: nx.staff, m: nx.m, voice: nx.voice, i: nx.i, n: 0 };
    if (!rest) { this.toRest(b); this.toggleTie(cur); }
    return b;
  }

  // ---------------------------------------------------------------- ties, articulations, dynamics
  // the event after a = { staff, m, voice, i } in its voice (in the next measure when a is the last one)
  nextOf(a) {
    const ev = this.events(a.staff, a.m, a.voice);
    let i = a.i + 1;
    while (ev.events[i] && ev.events[i].grace) i++;
    if (ev.events[i]) return { ...a, i, ev };
    const nx = this.events(a.staff, a.m + 1, a.voice);
    const k = nx ? nx.events.findIndex(e => !e.grace) : -1;
    return k >= 0 ? { ...a, m: a.m + 1, i: k, ev: nx } : null;
  }
  prevOf(a) {
    const ev = this.events(a.staff, a.m, a.voice);
    let i = a.i - 1;
    while (i >= 0 && ev.events[i].grace) i--;
    if (i >= 0) return { ...a, i, ev };
    const pv = a.m > 0 ? this.events(a.staff, a.m - 1, a.voice) : null;
    if (!pv) return null;
    let k = pv.events.length - 1; while (k >= 0 && pv.events[k].grace) k--;
    return k >= 0 ? { ...a, m: a.m - 1, i: k, ev: pv } : null;
  }
  hasTie(e) { return !e.rest && e.notes.some(n => kids(n.el, 'Spanner').some(s => s.getAttribute('type') === 'Tie' && kid(s, 'next'))); }
  // tie the selected event to the next one (a rest there becomes the same notes); again: untie
  toggleTie(a) {
    const ev = this.events(a.staff, a.m, a.voice); const e = ev && ev.events[a.i];
    if (!e || e.rest) throw new Error(t('אין תו במקום הזה'));
    if (e.grace) throw new Error(t('אי אפשר לקשור תו קישוט'));
    const nx = this.nextOf(a);
    if (!nx) throw new Error(t('אין אחריו תו לקשור אליו'));
    if (ev.complex === 'tuplet' || nx.ev.complex === 'tuplet') throw new Error(t('קשתות לתיבה עם טריולות עוד לא נתמכות'));
    return this.batch(() => {
      if (this.hasTie(e)) {
        this.each(a.staff, f => {
          const x = this.events(a.staff, a.m, a.voice, f).events[a.i]; if (!x || x.rest) return;
          for (const n of x.notes) for (const sp of kids(n.el, 'Spanner')) if (sp.getAttribute('type') === 'Tie' && kid(sp, 'next')) { const p = this.tiePartner(f, a, x, n, sp); if (p) p.remove(); sp.remove(); }
        });
        return false;
      }
      const y0 = nx.ev.events[nx.i];
      const b = { staff: a.staff, m: nx.m, voice: a.voice, i: nx.i, n: 0 };
      if (y0.rest) {
        this.setEventPitch(b, e.notes[0].pitch, e.notes[0].tpc);
        for (const n of e.notes.slice(1)) this.addNote(b, n.pitch, n.tpc);
      } else {
        for (const n of e.notes) if (!y0.notes.some(q => q.pitch === n.pitch)) this.addNote(b, n.pitch, n.tpc);
      }
      this.each(a.staff, f => {
        const x = this.events(a.staff, a.m, a.voice, f).events[a.i];
        const y = this.events(a.staff, nx.m, a.voice, f).events[nx.i];
        if (!x || !y || x.rest || y.rest) return;
        const dm = nx.m - a.m, dt = y.tick - x.tick;
        for (const n of x.notes) {
          const q = y.notes.find(z => z.pitch === n.pitch);
          if (!q || kids(n.el, 'Spanner').some(s => s.getAttribute('type') === 'Tie' && kid(s, 'next'))) continue;
          const s1 = f.doc.createElement('Spanner'); s1.setAttribute('type', 'Tie');
          s1.append(this.newEl(f, 'Tie'), this.locEl(f, 'next', dm, dt));
          n.el.insertBefore(s1, kid(n.el, 'pitch'));
          const s2 = f.doc.createElement('Spanner'); s2.setAttribute('type', 'Tie');
          s2.append(this.locEl(f, 'prev', -dm, -dt));
          q.el.insertBefore(s2, kid(q.el, 'pitch'));
        }
      });
      return true;
    });
  }
  // <next>/<prev><location><measures>…<fractions>…</location></…>
  locEl(f, dir, dm, dt) {
    const d = f.doc.createElement(dir); const loc = f.doc.createElement('location');
    if (dm) { const k = f.doc.createElement('measures'); k.textContent = String(dm); loc.append(k); }
    if (dt) { const k = f.doc.createElement('fractions'); k.textContent = fracOf(dt); loc.append(k); }
    d.append(loc); return d;
  }
  // staccato, accent, tenuto, marcato…: on when off, off when on (sub: 'articStaccatoAbove', …)
  toggleArticulation(a, sub) {
    const e = this.events(a.staff, a.m, a.voice).events[a.i];
    if (!e || e.rest) throw new Error(t('אין תו במקום הזה'));
    const base = s => String(s).replace(/(Above|Below)$/, '');
    const on = kids(e.el, 'Articulation').some(x => base(txt(x, 'subtype')) === base(sub));
    this.snapshot();
    this.each(a.staff, f => {
      const x = this.events(a.staff, a.m, a.voice, f).events[a.i]; if (!x || x.rest) return;
      const old = kids(x.el, 'Articulation').filter(z => base(txt(z, 'subtype')) === base(sub));
      if (on) { old.forEach(z => z.remove()); return; }
      const el = this.newEl(f, 'Articulation', [['subtype', sub]]);
      const before = kids(x.el).find(c => ['StemDirection', 'Stem', 'Note', 'Hook', 'Lyrics', 'Spanner'].includes(c.tagName));
      x.el.insertBefore(el, before || null);
    });
    return !on;
  }
  articulations(a) { const e = this.events(a.staff, a.m, a.voice).events[a.i]; return e && !e.rest ? kids(e.el, 'Articulation').map(x => txt(x, 'subtype')) : []; }
  // a fermata over the event (chord or rest)
  toggleFermata(a) {
    const ev = this.events(a.staff, a.m, a.voice); const e = ev && ev.events[a.i];
    if (!e) throw new Error(t('אין אירוע במקום הזה'));
    const on = ev.marks.some(mk => mk.el.tagName === 'Fermata' && mk.tick === e.tick);
    this.snapshot();
    this.each(a.staff, f => this.setMark(f, a.staff, a.m, e.tick, 'Fermata', !on && (el => { if (!kid(el, 'subtype')) { const k = f.doc.createElement('subtype'); k.textContent = 'fermataAbove'; el.prepend(k); } })));
    return !on;
  }
  // a dynamic (p, mf, ff, sfz…) under the staff at a place; '' removes it
  dynamics(staff, m) { const ev = this.events(staff, m, 0); return ev ? ev.marks.filter(mk => mk.el.tagName === 'Dynamic').map(mk => ({ tick: mk.tick, text: txt(mk.el, 'subtype') || '' })) : []; }
  setDynamic(staff, m, tick, sub) {
    this.snapshot();
    this.each(staff, f => this.setMark(f, staff, m, tick, 'Dynamic', sub && (el => {
      for (const tag of ['subtype', 'velocity', 'text']) { const k = kid(el, tag); if (k) k.remove(); }
      const k = f.doc.createElement('subtype'); k.textContent = sub; el.prepend(k);
    })));
  }

  // ---------------------------------------------------------------- key, repeats
  // the key from measure m on (concert pitch, -7…7); null removes a key change there
  keyChanges() {
    const first = this.staves()[0].id; const out = [];
    this.measures(this.main, first).forEach((ms, i) => { const v = kids(ms, 'voice')[0]; const ks = v && kid(v, 'KeySig'); if (ks && txt(ks, 'concertKey') != null) out.push({ m: i, key: +txt(ks, 'concertKey') }); });
    return out;
  }
  setKey(m, key) {
    if (key != null && !(key >= -7 && key <= 7)) throw new Error(t('סולם לא תקין'));
    if (key == null && m === 0) throw new Error(t('לתיבה הראשונה תמיד יש סולם'));
    this.snapshot();
    this.made = new Map();
    for (const f of this.files) for (const [mainId, local] of f.toLocal) {
      if ((this.staves().find(s => s.id === mainId) || {}).drums) continue;
      const staffEl = f.staffEls.get(local); if (!staffEl) continue;
      const meas = staffMeasures(staffEl)[m]; if (!meas) continue;
      const v = kids(meas, 'voice')[0]; if (!v) continue;
      let ks = kid(v, 'KeySig');
      if (key == null) { if (ks) ks.remove(); continue; }
      this.linkTo(f, mainId);
      if (!ks) {
        ks = this.newEl(f, 'KeySig');
        const clef = kid(v, 'Clef');
        if (clef) clef.after(ks); else v.insertBefore(ks, kids(v).find(c => c.tagName !== 'eid') || null);
      }
      for (const tag of ['concertKey', 'actualKey', 'accidental', 'key', 'subtype']) { const k = kid(ks, tag); if (k) k.remove(); }
      const ck = f.doc.createElement('concertKey'); ck.textContent = String(key); ks.append(ck);
    }
  }
  repeats(m) {
    const first = this.staves()[0].id; const ms = this.measures(this.main, first)[m];
    return { start: !!(ms && kid(ms, 'startRepeat')), end: ms && kid(ms, 'endRepeat') ? +txt(ms, 'endRepeat') || 2 : 0 };
  }
  // a start / end repeat barline on measure m (on every staff)
  toggleRepeat(m, which) {
    const on = which === 'start' ? this.repeats(m).start : !!this.repeats(m).end;
    this.snapshot();
    for (const f of this.files) for (const [, local] of f.toLocal) {
      const staffEl = f.staffEls.get(local); const meas = staffEl && staffMeasures(staffEl)[m]; if (!meas) continue;
      const tag = which === 'start' ? 'startRepeat' : 'endRepeat';
      const old = kid(meas, tag);
      if (on) { if (old) old.remove(); continue; }
      if (old) continue;
      const el = f.doc.createElement(tag); if (tag === 'endRepeat') el.textContent = '2';
      const eid = kid(meas, 'eid'); if (eid) eid.after(el); else meas.prepend(el);
    }
    return !on;
  }

  // ---------------------------------------------------------------- staff positions
  // the clef at a place: 'G', 'F', 'C3', 'G8vb', 'PERC'…
  clefAt(staff, m, tick = Infinity) {
    let clef = 'G';
    const local = this.main.toLocal.get(staff);
    const p = this.main.partOf.get(local);
    if (p) {
      const ids = kids(p, 'Staff').map(s => this.main.ids.get(s));
      const k = ids.indexOf(local) + 1;
      const c = [...p.querySelectorAll('Instrument > clef')].find(e => (e.getAttribute('staff') || '1') === String(k));
      if (c) clef = c.textContent.trim();
      if ((this.staves().find(s => s.id === staff) || {}).drums) clef = 'PERC';
    }
    const ms = this.measures(this.main, staff);
    const val = c => txt(c, 'transposingClefType') || txt(c, 'concertClefType') || txt(c, 'subtype') || clef;   // as drawn in written pitch
    // measures before: their last clef holds; in this one only the clefs up to the tick
    for (let i = 0; i < m && i < ms.length; i++) for (const v of kids(ms[i], 'voice').slice(0, 1)) for (const c of kids(v, 'Clef')) clef = val(c);
    const ev = m < ms.length ? this.events(staff, m, 0) : null;
    for (const mk of ev ? ev.marks : []) if (mk.el.tagName === 'Clef' && (mk.tick ?? 0) <= tick) clef = val(mk.el);
    return clef;
  }
  // the note on a line or space of a staff: lines counted in half-spaces from the top line (0 = top line,
  // 8 = bottom line, negative = above); spelled as the key at that place has it
  noteOnStaff(staff, m, tick, halfSpaces, key) {
    const top = CLEF_TOP[this.clefAt(staff, m, tick)] ?? 38;
    const d = top - halfSpaces;
    const step = ((d % 7) + 7) % 7, oct = Math.floor(d / 7);
    const tpc = keyTpc(step, key);
    return { pitch: (oct + 1) * 12 + STEP_SEMIS[step] + tpcAlter(tpc), tpc, step };
  }
  // where a note sits on the staff (half-spaces from the top line), for the clef there
  staffLineOf(staff, m, tick, pitch, tpc) {
    const top = CLEF_TOP[this.clefAt(staff, m, tick)] ?? 38;
    const step = tpcStep(tpc); const oct = Math.floor((pitch - STEP_SEMIS[step] - tpcAlter(tpc)) / 12) - 1;
    return top - (oct * 7 + step);
  }

  // ---------------------------------------------------------------- slashes (as MuseScore writes them)
  // a slash is a note with a slash head fixed on the middle line, not played. 'slash': without a stem (a
  // chart's "play here" beats), 'rhythm': with its stem (rhythmic notation: the rhythm, no pitches).
  // The pitches stay in the file, so a slash turned back into a note gets its pitch back.
  slashNote(f, n, on) {
    const drop = tag => kids(n, tag).forEach(x => x.remove());
    if (!on) {
      if (txt(n, 'head') === 'slash') drop('head');
      drop('play'); drop('fixed'); drop('fixedLine');
      return;
    }
    drop('head'); drop('play'); drop('fixed'); drop('fixedLine');
    const at = kid(n, 'tpc2') || kid(n, 'tpc') || kid(n, 'pitch');
    const els = [['head', 'slash'], ['play', '0'], ['fixed', '1'], ['fixedLine', '4']].map(([tg, v]) => { const e = f.doc.createElement(tg); e.textContent = v; return e; });
    if (at) at.after(...els); else n.append(...els);
  }
  // the note on the middle line (where a slash sits), concert: [pitch, tpc]
  middleNote(staff, m, tick) {
    const ctx = this.context(staff, m);
    const iv = this.writtenIv(this.main, staff);
    const w = this.noteOnStaff(staff, m, tick, 4, iv ? transposeKeyBy(ctx.key, iv) : ctx.key);
    return iv ? [w.pitch - iv[1], transposeTpc(w.tpc, [-iv[0], -iv[1]], false)] : [w.pitch, w.tpc];
  }
  // mode: 'slash' | 'rhythm' | null (back to notes)
  slashEl(f, ch, mode) {
    const was = kid(ch, 'noStem') && txt(ch, 'noStem') === '1';
    kids(ch, 'noStem').forEach(x => x.remove());
    if (was) kids(ch, 'BeamMode').filter(x => x.textContent === 'no').forEach(x => x.remove());
    for (const n of kids(ch, 'Note')) this.slashNote(f, n, !!mode);
    if (mode === 'slash') {
      const after = kid(ch, 'durationType') || kid(ch, 'dots');
      const ns = f.doc.createElement('noStem'); ns.textContent = '1';
      const bm = f.doc.createElement('BeamMode'); bm.textContent = 'no';
      if (after) after.after(bm, ns); else ch.prepend(bm, ns);
    }
  }
  // the chords of measures m0…m1 (one voice) as slashes, rhythmic notation, or notes again
  setSlash(staves, m0, m1, voice, mode, idx = null) {
    let did = 0;
    for (const s of staves) for (let k = m0; k <= m1; k++) { const ev = this.events(s, k, voice); if (ev) did += ev.events.filter((e, i) => !e.rest && !e.grace && (idx == null || i === idx) && e.slash !== mode).length; }
    if (!did) return 0;
    this.snapshot();
    for (const s of staves) for (let k = m0; k <= m1; k++) {
      this.each(s, f => {
        const ev = this.events(s, k, voice, f); if (!ev) return;
        ev.events.forEach((e, i) => { if (!e.rest && !e.grace && (idx == null || i === idx) && e.slash !== mode) this.slashEl(f, e.el, mode); });
      });
    }
    return did;
  }
  // fill measures with slashes, one on each beat (voice 1; chord symbols, texts and the rest stay where they
  // are, and a chord symbol between two beats gets a slash of its own). stems: rhythmic notation instead.
  fillSlashes(staves, m0, m1, { stems = false } = {}) {
    this.snapshot();
    for (const s of staves) for (let k = m0; k <= m1; k++) {
      const ctx = this.context(s, k);
      const [n, d] = ctx.timesig.split('/').map(Number);
      const beat = d > 4 && n % 3 === 0 ? 1920 * 3 / d : 1920 / d;
      // where slashes start: every beat, and every chord symbol or mark inside a beat (as the score has it)
      const main = this.events(s, k, 0);
      const cuts = new Set();
      for (let x = 0; x < ctx.len; x += beat) cuts.add(x);
      for (const mk of main ? main.marks : []) if (mk.tick != null && mk.tick > 0 && mk.tick < ctx.len && mk.el.tagName === 'Harmony') cuts.add(mk.tick);
      const at = [...cuts].sort((a, b) => a - b);
      const plan = [];
      at.forEach((x, i) => { let t0 = x; for (const [ty, dd] of splitNote((at[i + 1] ?? ctx.len) - x)) { plan.push({ tick: t0, ty, dd }); t0 += ticksOf(ty, dd); } });
      const [pitch, tpc] = this.middleNote(s, k, 0);
      this.each(s, f => {
        const meas = this.measures(f, s)[k]; if (!meas) return;
        let v0 = kids(meas, 'voice')[0];
        if (!v0) { v0 = f.doc.createElement('voice'); meas.append(v0); }
        const x = this.events(s, k, 0, f);
        for (const y of x.events) if (!y.rest) this.dropTies(f, { staff: s, m: k, voice: 0 }, y);
        const head = kids(v0, 'eid');
        const marks = x.marks.filter(mk => mk.tick != null);
        const chords = plan.map(p => {
          const kv = []; if (p.dd) kv.push(['dots', String(p.dd)]); kv.push(['durationType', p.ty]);
          const ch = this.newEl(f, 'Chord', kv);
          ch.append(this.noteEl(f, s, pitch, tpc));
          this.slashEl(f, ch, stems ? 'rhythm' : 'slash');
          return { tick: p.tick, el: ch };
        });
        const out = [...head]; let mi = 0;
        for (const c of chords) { while (mi < marks.length && marks[mi].tick <= c.tick) out.push(marks[mi++].el); out.push(c.el); }
        while (mi < marks.length) out.push(marks[mi++].el);
        v0.replaceChildren(...out);
      });
    }
  }

  // ---------------------------------------------------------------- copy, paste, clear
  // the music of measures m0…m1 on some staves (as the full score has it)
  copy(staves, m0, m1) {
    const ser = new XMLSerializer();
    const out = { staves: staves.slice(), n: m1 - m0 + 1, lens: [], data: {} };
    for (let k = m0; k <= m1; k++) out.lens.push(this.context(staves[0], k).len);
    for (const s of staves) out.data[s] = [];
    for (let k = m0; k <= m1; k++) for (const s of staves) {
      const meas = this.measures(this.main, s)[k];
      out.data[s].push(meas ? kids(meas, 'voice').map(v => ser.serializeToString(v)) : []);
    }
    return out;
  }
  // put copied music at measure m (onto the same staves, or onto `to` when one staff was copied)
  paste(clip, m, to = null) {
    const targets = to && clip.staves.length === 1 ? [to] : clip.staves;
    if (m + clip.n > this.measureCount()) throw new Error(t('אין מספיק תיבות אחרי המקום הזה'));
    for (let k = 0; k < clip.n; k++) if (this.context(targets[0], m + k).len !== clip.lens[k]) throw new Error(t('למקום הזה יש משקל אחר'));
    this.snapshot();
    const parse = s => new DOMParser().parseFromString(s, 'application/xml').documentElement;
    for (let j = 0; j < targets.length; j++) {
      const src = clip.data[clip.staves[j]];
      const mainEids = [];
      for (const f of this.files) {
        const local = f.toLocal.get(targets[j]); const staffEl = local && f.staffEls.get(local); if (!staffEl) continue;
        const ms = staffMeasures(staffEl);
        let e = 0;
        for (let k = 0; k < clip.n; k++) {
          const meas = ms[m + k]; if (!meas) continue;
          const keep = new Map();   // what belongs to the measure's place, not to the copied music
          const v0 = kids(meas, 'voice')[0];
          if (v0) for (const c of kids(v0)) if (['Clef', 'KeySig', 'TimeSig', 'Tempo', 'RehearsalMark', 'SystemText'].includes(c.tagName)) keep.set(c, true);
          const old = kids(meas, 'voice');
          const slot = old.length ? old[old.length - 1].nextSibling : null;   // the voices go back where they were
          for (const v of old) v.remove();
          src[k].forEach((vs, vi) => {
            const v = f.doc.importNode(parse(vs), true);
            // the copied measure's own key / time / tempo / section marks are not pasted
            for (const c of kids(v)) if (['Clef', 'KeySig', 'TimeSig', 'Tempo', 'RehearsalMark', 'SystemText', 'Beam'].includes(c.tagName)) c.remove();
            for (const c of v.querySelectorAll('Chord > Beam, Rest > Beam')) c.remove();
            // ties / slurs reaching outside the pasted measures go
            for (const sp of [...v.querySelectorAll('Spanner')]) {
              const dir = kid(sp, 'next') ? 'next' : kid(sp, 'prev') ? 'prev' : null;
              const loc = dir && kid(kid(sp, dir), 'location');
              const dm = loc ? +(txt(loc, 'measures') || 0) : 0;
              if (k + dm < 0 || k + dm >= clip.n || (loc && (kid(loc, 'staves') || kid(loc, 'voices')))) sp.remove();
            }
            if (vi === 0) for (const c of [...keep.keys()].reverse()) v.insertBefore(c, kids(v).find(x => x.tagName !== 'eid') || null);
            // new ids; a part's copy is linked to the score's copy (same order)
            for (const el of v.querySelectorAll('eid')) {
              const id = newEid(); el.textContent = id;
              for (const lk of [...el.parentNode.children].filter(x => ['linkedTo', 'linkedMain', 'linked'].includes(x.tagName))) lk.remove();
              if (f.main) { mainEids.push(id); if (this.linked && !this.eidLinks) el.after(f.doc.createElement('linkedMain')); }
              else if (this.eidLinks) { const lt = f.doc.createElement('linkedTo'); lt.textContent = mainEids[e++] || ''; el.after(lt); }
              else if (this.linked) el.after(f.doc.createElement('linked'));
            }
            meas.insertBefore(v, slot && slot.parentNode === meas ? slot : null);
          });
        }
      }
    }
  }
  // empty measures m0…m1 on some staves: one rest for the whole measure (section marks, key and time stay)
  clear(staves, m0, m1) {
    this.snapshot();
    for (const s of staves) for (let k = m0; k <= m1; k++) {
      const ctx = this.context(s, k);
      this.each(s, f => {
        const meas = this.measures(f, s)[k]; if (!meas) return;
        const voices = kids(meas, 'voice'); const v0 = voices[0]; if (!v0) return;
        voices.slice(1).forEach(v => v.remove());
        const x = this.events(s, k, 0, f);
        for (const y of x.events) if (!y.rest) this.dropTies(f, { staff: s, m: k, voice: 0 }, y);
        const keep = kids(v0).filter(c => ['eid', 'Clef', 'KeySig', 'TimeSig', 'Tempo', 'RehearsalMark', 'SystemText'].includes(c.tagName));
        v0.replaceChildren(...keep, this.newEl(f, 'Rest', [['durationType', 'measure'], ['duration', fracOf(ctx.len)]]));
      });
    }
  }

  // ---------------------------------------------------------------- song details
  title() { const t = [...this.main.doc.querySelectorAll('VBox > Text')].find(x => txt(x, 'style') === 'title'); return t ? (kid(t, 'text') || {}).textContent || '' : ''; }
  setTitle(text) {
    this.snapshot();
    for (const f of this.files) {
      const t = [...f.doc.querySelectorAll('VBox > Text')].find(x => txt(x, 'style') === 'title');
      if (t) { let k = kid(t, 'text'); if (!k) { k = f.doc.createElement('text'); t.append(k); } k.textContent = text; }
      const meta = f.doc.querySelector('metaTag[name="workTitle"]'); if (meta && f.main) meta.textContent = text;
    }
  }
  tempo() { const t = this.main.doc.querySelector('Tempo > tempo'); return t ? Math.round(+t.textContent * 60) : null; }
  setTempo(bpm) {
    if (!(bpm >= 20 && bpm <= 400)) throw new Error(t('טמפו בין 20 ל-400'));
    this.snapshot();
    for (const f of this.files) {
      const t = f.doc.querySelector('Tempo'); if (!t) continue;
      kid(t, 'tempo').textContent = (bpm / 60).toFixed(6);
      const tx = kid(t, 'text'); if (tx) tx.innerHTML = tx.innerHTML.replace(/=\s*\d+(\.\d+)?/, '= ' + bpm);
    }
  }

  // ---------------------------------------------------------------- out
  save() {
    const ser = new XMLSerializer();
    // stored multi-measure rests may no longer fit the music: MuseScore draws them again from the measures
    if (this.changes) for (const f of this.files) for (const st of f.staffEls.values()) {
      for (const m of kids(st, 'Measure')) if (kid(m, 'multiMeasureRest')) {
        // a line/page break on the rest belongs to the last measure it stands for
        const lb = kid(m, 'LayoutBreak');
        let last = m; for (let k = +txt(m, 'multiMeasureRest') || 1; k > 0 && last; k--) { last = last.nextElementSibling; while (last && last.tagName !== 'Measure') last = last.nextElementSibling; }
        if (lb && last && !kid(last, 'LayoutBreak')) { const e = kid(last, 'eid'); if (e) e.after(lb); else last.prepend(lb); }
        m.remove();
      }
    }
    const out = this.entries.map(e => {
      const f = this.files.find(x => x.entry === e);
      if (!f) return { name: e.name, data: e.data };
      let s = ser.serializeToString(f.doc);
      if (!s.startsWith('<?xml')) s = f.head + s;
      return { name: e.name, data: s };
    });
    return writeZip(out);
  }
}
