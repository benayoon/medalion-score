// The note editor: on MuseScore's own drawing of the song (live mode). Tap the staff to select a note or
// rest, or, in note input, to write a note there; letters, lengths, accidentals, ties, marks and measure
// tools on the palette and on the keyboard (as in MuseScore). Every change is made in the song's MuseScore
// file (score and all parts together) and drawn again right away; "שמירה" keeps it as a new version.
import { h, icon, btn, toast, sheet, confirmBox, promptBox, segmented } from './ui.js';
import * as store from './store.js';
import { MsDoc, NOTE_NAMES, noteName, pitchToTpc } from './msedit.js';
import { pageStaves, tapPlace, placeRect, onsets, toWritten, toConcert, writtenKey } from './staffhit.js';
import { guessChords, notesIn } from './chordguess.js';
import { saveEdited } from './importer.js';
import { nameKey } from './live.js';
import { audioCtx } from './metronome.js';
import { t } from './i18n.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// lengths: [type, MuseScore's key, flags (-1 whole, 0 half: hollow)]
const DURS = [['whole', '7', -1], ['half', '6', 0], ['quarter', '5', 1], ['eighth', '4', 2], ['16th', '3', 3], ['32nd', '2', 4]];
const DUR_NAME = { whole: t('שלם'), half: t('חצי'), quarter: t('רבע'), eighth: t('שמינית'), '16th': t('שש-עשרה'), '32nd': t('שלושים ושתיים') };
const ARTICS = [['articStaccatoAbove', '•', t('סטקטו')], ['articAccentAbove', '>', t('אקסנט')], ['articTenutoAbove', '–', t('טנוטו')], ['articMarcatoAbove', '^', t('מרקטו')], ['articStaccatissimoAbove', '▾', t('סטקטיסימו')]];
const DYNS = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'sfz', 'fp'];

// a small drawing of a note value (no music font needed)
function durSvg(type) {
  const d = DURS.find(x => x[0] === type); const flags = d ? d[2] : 1;
  const hollow = flags <= 0;
  let s = `<ellipse cx="9" cy="17.5" rx="4.4" ry="3.1" transform="rotate(-22 9 17.5)" fill="${hollow ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="1.6"/>`;
  if (flags >= 0) s += '<path d="M13.1 16.6V3.5" stroke="currentColor" stroke-width="1.6"/>';
  for (let k = 1; k < Math.max(1, flags); k++) s += `<path d="M13.1 ${3.5 + (k - 1) * 3.6}c1 2.6 4.6 3.4 4.4 7" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">${s}</svg>`;
}
const ICO = {
  rest: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M10 3l4 5-3 4 4 5c-2-1-4-.5-3 3-3-2-3-5 0-5l-3-4 3-3z" fill="currentColor"/></svg>',
  dot: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>',
  tie: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M3 10c4 6 14 6 18 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  input: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 20l4-1L19 8a2.1 2.1 0 00-3-3L5 16z" fill="none" stroke="currentColor" stroke-width="1.5"/><ellipse cx="7" cy="7" rx="3" ry="2.2" transform="rotate(-22 7 7)" fill="currentColor"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 11a6 6 0 0012 0M12 17v4M9 21h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  redo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/></svg>',
};
const ib = (html, label, onclick, cls = '') => h('button', { class: 'btn ne-b ' + cls, title: label, 'aria-label': label, onclick, html });
const tb = (text, label, onclick, cls = '') => h('button', { class: 'btn ne-b ne-t ' + cls, title: label, 'aria-label': label, onclick }, text);

export class ScoreEditor {
  constructor(v) {
    this.v = v; this.doc = null; this.sel = null; this.input = false; this.dur = 'quarter'; this.dots = 0;
    this.voice = 0; this.chord = false; this.last = null; this.busy = false; this.drawing = false;
  }
  get eng() { return this.v.engine; }
  get dirty() { return !!(this.doc && this.doc.changes > 0); }

  async open() {
    const ver = this.v.score.version;
    this.scoreId = this.v.scoreId;
    this.fromXml = !ver.mscz;
    if (this.fromXml) toast(t('MuseScore מכין את השיר לעריכה…'), 4000);
    const bytes = await this.eng.editableMscz();
    this.doc = await MsDoc.open(bytes);
    this.cache = { rev: -1, bytes: null };
    this.eng.edit = { rev: 0, bytes: () => this.bytes(), measures: () => this.doc.measureCount() };
    this.eng.onRender = () => this.afterRender();
    this.keys = e => this.onKey(e);
    window.addEventListener('keydown', this.keys, true);
    this.build();
    await this.redraw(true);
    return this;
  }
  bytes() {
    if (this.cache.rev !== this.doc.rev) this.cache = { rev: this.doc.rev, bytes: this.doc.save() };
    return this.cache.bytes;
  }
  // the staves on screen (main ids, top to bottom): the part shown, or all of them
  viewStaves() {
    const sel = this.eng.selectedParts();
    if (sel && sel.length === 1 && this.eng.parts.length > 1) {
      const want = nameKey(this.eng.parts.find(p => p.id === sel[0]).name);
      const f = this.doc.files.find(x => !x.main && nameKey((x.doc.querySelector('metaTag[name="partName"]') || {}).textContent) === want);
      if (f) return [...f.toLocal.keys()];
    }
    return this.doc.staves().map(s => s.id);
  }
  staffInfo(id) { return this.doc.staves().find(s => s.id === id) || {}; }

  // ---------------------------------------------------------------- drawing again
  // one drawing at a time; edits made meanwhile are drawn right after it (the newest wins)
  async redraw(now = false) {
    clearTimeout(this.timer);
    if (!now) { this.timer = setTimeout(() => this.redraw(true), 90); return; }
    if (this.drawing) { this.again = true; return; }
    this.drawing = true; this.again = false;
    this.dock.classList.add('drawing');
    try {
      this.eng.edit.rev = this.doc.rev;
      await this.eng.render();
    } catch (e) { console.warn('edit draw', e); toast(t('MuseScore לא הצליח לצייר: {msg}', { msg: e.message || e }), 4000); }
    finally {
      this.drawing = false;
      if (this.again || this.eng.edit && this.eng.edit.rev !== this.doc.rev) this.redraw(true);
      else this.dock.classList.remove('drawing');
    }
  }
  afterRender() {
    const svgs = this.eng.pages.map(p => p.querySelector(':scope > svg'));
    this.geo = { boxes: this.eng.boxes, segs: this.eng.segs, staves: svgs.map(s => (s ? pageStaves(s) : [])) };
    this.paint();
  }

  // ---------------------------------------------------------------- the selection on the music
  paint() {
    for (const x of this.v.stage.querySelectorAll('.ne-mark')) x.remove();
    if (!this.geo || !this.sel) return;
    const a = this.sel; const ids = this.viewStaves();
    const k = ids.indexOf(a.staff); if (k < 0) return;
    const ev = this.doc.events(a.staff, a.m, a.voice); const e = ev && ev.events[a.i];
    const tick = e ? e.tick : 0;
    const p = placeRect(this.geo, a.m, k, tick, onsets(this.doc, ids, a.m), (ev || {}).len || 1920);
    if (!p) return;
    const svg = this.eng.pages[p.page] && this.eng.pages[p.page].querySelector(':scope > svg');
    if (!svg) return;
    const sp = p.st.sp;
    const add = (cls, attrs) => { const r = document.createElementNS(SVGNS, 'rect'); r.setAttribute('class', 'ne-mark ' + cls); for (const [n, v] of Object.entries(attrs)) r.setAttribute(n, v); svg.append(r); return r; };
    add('ne-measure', { x: p.box.x, y: p.st.top - sp, width: p.box.w, height: p.st.bottom - p.st.top + 2 * sp, rx: sp * 0.4 });
    if (this.input) add('ne-cursor', { x: p.x - sp * 0.3, y: p.st.top - sp * 1.5, width: sp * 0.35, height: p.st.bottom - p.st.top + 3 * sp, rx: sp * 0.15 });
    else if (e) {
      // the selected note (its line), or the whole column for a rest
      const n = !e.rest && e.notes[a.n];
      if (n) {
        const w = toWritten(this.doc, a.staff, n.pitch, n.tpc);
        const y = p.st.top + this.doc.staffLineOf(a.staff, a.m, tick, w.pitch, w.tpc) * sp / 2;
        add('ne-sel', { x: p.x - sp * 0.45, y: y - sp * 0.85, width: sp * 2.2, height: sp * 1.7, rx: sp * 0.5 });
      } else add('ne-sel', { x: p.x - sp * 0.45, y: p.st.top - sp * 0.5, width: sp * 2.2, height: p.st.bottom - p.st.top + sp, rx: sp * 0.5 });
    }
    // keep it on screen
    if (this.follow) {
      this.follow = false;
      const eng = this.eng;
      if (eng.scroll) { const r = svg.getBoundingClientRect(); const k2 = r.width / (eng.crop.x1 - eng.crop.x0); const y = r.top + (p.st.top - eng.crop.y0) * k2; const st = this.v.stage.getBoundingClientRect(); if (y < st.top + 60 || y > st.bottom - 160) this.v.stage.scrollTop += y - st.top - st.height / 3; }
      else if (p.page < eng.page || p.page >= eng.page + eng.perScreen()) { eng.page = p.page - (p.page % eng.perScreen()); eng.show(); }
    }
    this.renderInfo();
  }

  // ---------------------------------------------------------------- taps
  tap(e) {
    if (!this.geo) return;
    const pg = this.eng.pages.findIndex(p => p.classList.contains('on') && p.contains(e.target)) ;
    const page = pg >= 0 ? pg : this.eng.pages.findIndex(p => p.contains(e.target));
    if (page < 0) return;
    const svg = this.eng.pages[page].querySelector(':scope > svg');
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const ids = this.viewStaves();
    const pl = tapPlace(this.doc, this.geo, ids, page, pt.x, pt.y, this.voice);
    if (!pl) { this.sel = null; this.paint(); return; }
    const info = this.staffInfo(pl.staff);
    let i = pl.i;
    if (i < 0) {   // nothing in this voice here yet: voice 1
      this.voice = 0; i = tapPlace(this.doc, this.geo, ids, page, pt.x, pt.y, 0).i;
      if (i < 0) return;
    }
    const a = { staff: pl.staff, m: pl.m, voice: this.voice, i, n: 0 };
    if (this.input && !info.drums) {
      // note input: the note goes where the finger is (an accidental in the measure before holds)
      const ev = this.doc.events(a.staff, a.m, a.voice).events[i];
      if (this.chord && ev && !ev.rest) return this.act(() => { this.doc.addNote(a, pl.pitch, pl.tpc); this.sel = { ...a, n: this.noteIndex(a, pl.pitch) }; this.audition([pl.pitch]); });
      return this.enterAt(a, [[pl.pitch, pl.tpc]]);
    }
    const ev = this.doc.events(a.staff, a.m, a.voice).events[i];
    if (ev && !ev.rest && ev.notes.length > 1) a.n = this.nearestNote(ev, a.staff, pl.written.pitch);
    this.sel = a; this.paint();
    if (ev && !ev.rest) this.audition(ev.notes.map(n => n.pitch));
  }
  nearestNote(ev, staff, writtenPitch) {
    let best = 0, bd = Infinity;
    ev.notes.forEach((n, k) => { const d = Math.abs(toWritten(this.doc, staff, n.pitch, n.tpc).pitch - writtenPitch); if (d < bd) { bd = d; best = k; } });
    return best;
  }
  noteIndex(a, pitch) { const e = this.doc.events(a.staff, a.m, a.voice).events[a.i]; return Math.max(0, e ? e.notes.findIndex(n => n.pitch === pitch) : 0); }

  // ---------------------------------------------------------------- changes
  act(fn, { keepSel = false } = {}) {
    try { fn(); } catch (e) { toast(e.message, 3500); return false; }
    this.fixSel(keepSel);
    this.follow = true;
    this.changed();
    return true;
  }
  changed() { this.renderBar(); this.paint(); this.redraw(); }
  fixSel() {
    const a = this.sel; if (!a) return;
    if (a.m >= this.doc.measureCount()) { this.sel = null; return; }
    const ev = this.doc.events(a.staff, a.m, a.voice);
    if (!ev || !ev.events.length) { this.sel = null; return; }
    if (a.i >= ev.events.length) a.i = ev.events.length - 1;
    const e = ev.events[a.i]; if (e && a.n >= Math.max(1, e.notes.length)) a.n = 0;
  }
  // the place to work on: the selection, else the first note of the page on screen
  here() {
    if (this.sel) return this.sel;
    const b = this.eng.boxes.find(x => x.page >= this.eng.page) || this.eng.boxes[0];
    const ids = this.viewStaves();
    if (!b || !ids.length) return null;
    const ev = this.doc.events(ids[0], b.m, 0);
    if (!ev || !ev.events.length) return null;
    this.sel = { staff: ids[0], m: b.m, voice: 0, i: 0, n: 0 };
    return this.sel;
  }
  event(a = this.sel) { const ev = a && this.doc.events(a.staff, a.m, a.voice); return ev ? ev.events[a.i] : null; }

  // note input at a place: the note (or rest) with the length chosen, then on to the next place
  enterAt(a, notes, rest = false, slash = null) {
    const info = this.staffInfo(a.staff);
    if (info.drums && !rest && !slash) return toast(t('בתופים כותבים כאן אורכים, שתיקות וסלאשים; את התווים עצמם עורכים ב-MuseScore'));
    let next = null;
    const ok = this.act(() => { next = this.doc.enter(a, { type: this.dur, dots: this.dots, notes, rest, slash }); });
    if (!ok) return;
    this.last = rest || slash ? null : { ...a, notes };
    this.sel = next ? { ...next, n: 0 } : { ...a };
    this.paint();
    if (!rest && !slash) this.audition(notes.map(n => n[0]));
  }

  // slashes: in note input a slash with the length chosen (rhythmic notation); else the selected chord
  // becomes a slash, or a slash becomes the notes it was again
  slash() {
    const a = this.here(); if (!a) return;
    const d = this.doc;
    if (this.input) {
      const e = d.events(a.staff, a.m, a.voice).events[a.i];
      return this.enterAt(a, [d.middleNote(a.staff, a.m, e ? e.tick : 0)], false, 'rhythm');
    }
    const e = this.event();
    if (!e || e.rest) return toast(t('בוחרים תו כדי להפוך אותו לסלאש'));
    this.act(() => d.setSlash([a.staff], a.m, a.m, a.voice, e.slash ? null : 'rhythm', a.i), { keepSel: true });
  }
  // measures m…m+n-1 of one staff: filled with slashes, all chords as rhythmic notation, or back to notes
  slashMeasures(how, m, n, staff) {
    const d = this.doc; const m1 = Math.min(d.measureCount() - 1, m + n - 1);
    const info = this.staffInfo(staff);
    if (how === 'fill' || how === 'fillStems') return this.act(() => d.fillSlashes([staff], m, m1, { stems: how === 'fillStems' }), { keepSel: true });
    if (info.drums && !how) return toast(t('בתופים הסלאשים נשארים: את התווים עצמם עורכים ב-MuseScore'));
    let did = 0;
    this.act(() => { did = d.setSlash([staff], m, m1, this.sel ? this.sel.voice : 0, how); }, { keepSel: true });
    if (!did) toast(how ? t('אין כאן תווים להפוך לסלאשים') : t('אין כאן סלאשים'));
  }

  // a letter: in note input a new note (near the one before), else the selected note becomes it
  letter(step, { add = false } = {}) {
    const a = this.here(); if (!a) return;
    const d = this.doc; const ev = d.events(a.staff, a.m, a.voice); const e = ev.events[a.i];
    const wKey = writtenKey(d, a.staff, ev.key);
    // the octave: next to the note before (as MuseScore does)
    const prev = this.last && this.last.notes ? toWritten(d, a.staff, this.last.notes[0][0], this.last.notes[0][1])
      : e && !e.rest ? toWritten(d, a.staff, e.notes[a.n].pitch, e.notes[a.n].tpc)
        : (() => { const p = [...ev.events.slice(0, a.i)].reverse().find(x => !x.rest); return p ? toWritten(d, a.staff, p.notes[0].pitch, p.notes[0].tpc) : { pitch: this.staffMiddle(a) }; })();
    const w = d.pitchForLetter(step, prev.pitch, wKey);
    const c = toConcert(d, a.staff, w.pitch, w.tpc);
    if (add || this.chord) {
      const tgt = this.input && this.last ? { staff: this.last.staff, m: this.last.m, voice: this.last.voice, i: this.last.i } : a;
      const te = this.event(tgt);
      if (!te || te.rest) return toast(t('אין אקורד להוסיף אליו'));
      let p = c.pitch; const top = Math.max(...te.notes.map(n => n.pitch));
      while (p <= top) p += 12;
      this.act(() => d.addNote(tgt, p, c.tpc));
      this.audition([p]);
      return;
    }
    if (this.input) return this.enterAt(a, [[c.pitch, c.tpc]]);
    this.act(() => d.setEventPitch(a, c.pitch, c.tpc));
    this.audition([c.pitch]);
  }
  staffMiddle(a) { const w = this.doc.noteOnStaff(a.staff, a.m, 0, 4, 0); return w.pitch; }

  duration(type) {
    if (this.input || !this.sel) { this.dur = type; this.dots = 0; this.renderPal(); return; }
    const e = this.event(); if (!e) return;
    this.dur = type;
    this.act(() => this.doc.setDuration(this.sel, type, 0));
    this.renderPal();
  }
  toggleDot() {
    if (this.input || !this.sel) { this.dots = this.dots ? 0 : 1; this.renderPal(); return; }
    const e = this.event(); if (!e) return;
    const ty = e.type === 'measure' ? 'whole' : e.type;
    this.act(() => this.doc.setDuration(this.sel, ty, e.dots ? 0 : 1));
  }
  rest() {
    const a = this.here(); if (!a) return;
    if (this.input) return this.enterAt(a, null, true);
    this.act(() => this.doc.toRest(a));
  }
  // in note input: the note before again, tied to it; else tie the selected note to the next
  tie() {
    if (this.input) {
      if (!this.last) return toast(t('קודם כותבים תו, ואז קשת חיבור'));
      const a = this.here(); if (!a) return;
      const from = { staff: this.last.staff, m: this.last.m, voice: this.last.voice, i: this.last.i, n: 0 };
      let next = null;
      const ok = this.act(() => this.doc.batch(() => {
        next = this.doc.enter(a, { type: this.dur, dots: this.dots, notes: this.last.notes });
        if (!this.doc.hasTie(this.event(from))) this.doc.toggleTie(from);
      }));
      if (ok) { this.last = { ...a, notes: this.last.notes }; this.sel = next ? { ...next, n: 0 } : a; this.paint(); }
      return;
    }
    if (!this.sel) return;
    this.act(() => this.doc.toggleTie(this.sel));
  }
  move(how) {
    const a = this.input && this.last ? { staff: this.last.staff, m: this.last.m, voice: this.last.voice, i: this.last.i, n: 0 } : this.sel;
    if (!a) return;
    const e = this.event(a); if (!e || e.rest) return;
    let r = null;
    if (this.act(() => { r = this.doc.move(a, how); }, { keepSel: true })) {
      if (this.input && this.last && r) this.last.notes = [[r.pitch, r.tpc]];
      this.audition([r.pitch]);
    }
  }
  del() {
    const a = this.sel; if (!a) return;
    const e = this.event(); if (!e) return;
    if (!e.rest && e.notes.length > 1) this.act(() => this.doc.deleteNote(a));
    else this.act(() => this.doc.toRest(a));
  }
  step(dir) {
    const a = this.here(); if (!a) return;
    const nx = dir > 0 ? this.doc.nextOf(a) : this.doc.prevOf(a);
    if (!nx) return;
    this.sel = { staff: nx.staff, m: nx.m, voice: nx.voice, i: nx.i, n: 0 };
    this.follow = true; this.paint();
    const e = this.event(); if (e && !e.rest && !this.input) this.audition(e.notes.map(n => n.pitch));
  }
  // up/down through the notes of a chord, or to the staff above/below
  chordStep(dir) {
    const a = this.sel; if (!a) return;
    const e = this.event(); if (e && !e.rest && e.notes.length > 1) { a.n = Math.max(0, Math.min(e.notes.length - 1, a.n + dir)); this.paint(); }
  }
  undo() { if (!this.doc.undo()) return toast(t('אין מה לבטל')); this.last = null; this.fixSel(); this.changed(); }
  redo() { if (!this.doc.redo()) return toast(t('אין מה לשחזר')); this.fixSel(); this.changed(); }
  setInput(on) {
    this.input = on; this.last = null;
    if (on) this.here(); else this.stopMic();
    this.renderPal(); this.paint();
  }

  // ---------------------------------------------------------------- marks
  async chordSymbol() {
    const a = this.here(); if (!a) return;
    const d = this.doc;
    const run = async () => {
      const e = this.event(); if (!e) return;
      const ev = d.events(a.staff, a.m, 0);
      const cur = d.chordSymbols(a.staff, a.m).find(c => c.tick === e.tick);
      // suggestions: what sounds from here to the next chord symbol (or the end of the measure)
      const later = d.chordSymbols(a.staff, a.m).map(c => c.tick).filter(x => x > e.tick);
      const end = later.length ? Math.min(...later) : ev.len;
      const iv = d.writtenIv(d.main, a.staff);
      const sug = guessChords(notesIn(d, a.m, e.tick, end).map(n => ({ ...n, pitch: n.pitch + (iv ? iv[1] : 0) })), writtenKey(d, a.staff, ev.key));
      return new Promise(resolve => {
        const input = h('input', { class: 'input ne-chord-in', value: cur ? cur.text : '', placeholder: 'Am7, F#m7b5, Bb/D, N.C.', dir: 'ltr', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
        const save = text => { if ((cur ? cur.text : '') !== text) this.act(() => d.setChordSymbol(a.staff, a.m, e.tick, text), { keepSel: true }); };
        const finish = go => { const v = input.value.trim(); save(v); resolve(go); sh.close(); };
        input.addEventListener('keydown', k => {
          if (k.key === 'Enter') { k.preventDefault(); finish(false); }
          else if (k.key === 'Tab' || (k.key === ' ' && !input.value.includes(' '))) { k.preventDefault(); finish(true); }
          else if (k.key === 'Escape') { k.preventDefault(); sh.close(); resolve(false); }
          k.stopPropagation();
        });
        const chips = sug.length ? h('div', { class: 'ne-chips', dir: 'ltr' }, ...sug.map((s, k) => h('button', { class: 'chip' + (k === 0 ? ' on' : ''), onclick: () => { input.value = s.text; finish(false); } }, s.text))) : null;
        const sh = sheet(t('אקורד בתיבה {m}', { m: a.m + 1 }), h('div', { class: 'confirm' },
          input,
          chips ? h('p', { class: 'hint' }, t('הצעות לפי הצלילים שנשמעים כאן:')) : null, chips,
          h('div', { class: 'row end' },
            cur ? h('button', { class: 'btn labeled danger', onclick: () => { input.value = ''; finish(false); } }, t('מחיקה')) : null,
            h('button', { class: 'btn labeled', onclick: () => finish(true) }, t('שמירה והבא ←')),
            h('button', { class: 'btn labeled primary', onclick: () => finish(false) }, t('שמירה')))),
        { onClose: () => resolve(false) });
        setTimeout(() => { input.focus(); input.select(); }, 250);
      });
    };
    // "next": on to the next beat with a note or rest, as typing chords along a song
    while (await run()) {
      const nx = d.nextOf(this.sel); if (!nx) break;
      this.sel = { staff: nx.staff, m: nx.m, voice: nx.voice, i: nx.i, n: 0 }; a.m = nx.m; a.i = nx.i; a.staff = nx.staff; a.voice = nx.voice;
      this.follow = true; this.paint();
    }
  }
  async text(kind) {
    const a = this.here(); if (!a) return;
    const e = this.event(); const tick = e ? e.tick : 0;
    const d = this.doc;
    const list = kind === 'RehearsalMark' ? d.systemTexts(a.m) : d.texts(a.staff, a.m, 'StaffText');
    const cur = list.find(x => x.tick === tick);
    const ttl = kind === 'RehearsalMark' ? t('סימן חזרה (A, B, Intro…). ריק = מחיקה') : t('טקסט מעל החמשה. ריק = מחיקה');
    const val = await promptBox(ttl, cur ? cur.text : '');
    if (val == null) return;
    this.act(() => kind === 'RehearsalMark' ? d.setSystemText(a.m, tick, kind, val) : d.setText(a.staff, a.m, tick, kind, val), { keepSel: true });
  }
  dynamicsSheet() {
    const a = this.here(); if (!a) return;
    const e = this.event(); const tick = e ? e.tick : 0;
    const now = (this.doc.dynamics(a.staff, a.m) || []).find(x => x.tick === tick);
    const sh = sheet(t('דינמיקה'), h('div', { class: 'ne-grid', dir: 'ltr' },
      ...DYNS.map(dy => h('button', { class: 'btn ne-dyn' + (now && now.text === dy ? ' on' : ''), onclick: () => { sh.close(); this.act(() => this.doc.setDynamic(a.staff, a.m, tick, dy), { keepSel: true }); } }, dy)),
      now ? h('button', { class: 'btn labeled danger', onclick: () => { sh.close(); this.act(() => this.doc.setDynamic(a.staff, a.m, tick, ''), { keepSel: true }); } }, t('מחיקה')) : null));
  }
  artic(sub) { if (!this.sel) return toast(t('בוחרים קודם תו')); this.act(() => this.doc.toggleArticulation(this.sel, sub), { keepSel: true }); }
  fermata() { if (!this.sel) return toast(t('בוחרים קודם תו')); this.act(() => this.doc.toggleFermata(this.sel), { keepSel: true }); }

  // ---------------------------------------------------------------- measures
  measureSheet() {
    const a = this.here(); if (!a) return;
    const d = this.doc; const m = a.m;
    const go = fn => () => { sh.close(); fn(); };
    const rep = d.repeats(m) || {};
    const ks = d.keyChanges().find(k => k.m === m);
    const count = h('input', { class: 'input ne-num', type: 'number', inputmode: 'numeric', min: 1, max: 64, value: this.clipN || 1 });
    const keyNames = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
    const keySel = h('select', { class: 'input mini-select' }, h('option', { value: '' }, t('בלי שינוי')), ...keyNames.map((n, k) => h('option', { value: String(k - 7), selected: ks && ks.key === k - 7 }, n + ' / ' + keyNames[(k + 3) % 15].replace(/$/, 'm'))));
    const staves = this.viewStaves();
    const sh = sheet(t('תיבה {n}', { n: m + 1 }), h('div', { class: 'ne-msheet' },
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn labeled', onclick: go(() => this.act(() => d.insertMeasure(m))) }, t('תיבה ריקה לפני')),
        h('button', { class: 'btn labeled', onclick: go(() => this.act(() => d.insertMeasure(m + 1))) }, t('תיבה ריקה אחרי')),
        h('button', { class: 'btn labeled danger', onclick: async () => { sh.close(); if (await confirmBox(t('למחוק את תיבה {n} מכל הכלים?', { n: m + 1 }), t('מחיקה'), true)) this.act(() => d.deleteMeasure(m)); } }, t('מחיקת התיבה'))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn labeled' + (rep.start ? ' on' : ''), onclick: go(() => this.act(() => d.toggleRepeat(m, 'start'), { keepSel: true })) }, '𝄆 ' + t('תחילת חזרה')),
        h('button', { class: 'btn labeled' + (rep.end ? ' on' : ''), onclick: go(() => this.act(() => d.toggleRepeat(m, 'end'), { keepSel: true })) }, t('סוף חזרה') + ' 𝄇')),
      h('label', { class: 'field' }, h('span', {}, t('סולם מהתיבה הזו')), keySel),
      h('div', { class: 'row end' }, h('button', { class: 'btn labeled', onclick: go(() => this.act(() => d.setKey(m, keySel.value === '' ? null : +keySel.value), { keepSel: true })) }, t('החלת סולם'))),
      h('label', { class: 'field inline' }, h('span', {}, t('מספר תיבות מכאן (לסלאשים, העתקה וניקוי)')), count),
      h('h4', {}, t('סלאשים ({staff})', { staff: this.staffInfo(a.staff).label || '' })),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn labeled', onclick: go(() => this.slashMeasures('fill', m, +count.value || 1, a.staff)) }, '𝄍 ' + t('מילוי בסלאשים')),
        h('button', { class: 'btn labeled', onclick: go(() => this.slashMeasures('fillStems', m, +count.value || 1, a.staff)) }, t('מילוי בסלאשים עם גבעולים')),
        h('button', { class: 'btn labeled', onclick: go(() => this.slashMeasures('rhythm', m, +count.value || 1, a.staff)) }, t('סימון קצבי (התווים כסלאשים)')),
        h('button', { class: 'btn labeled', onclick: go(() => this.slashMeasures(null, m, +count.value || 1, a.staff)) }, t('סלאשים חזרה לתווים'))),
      h('p', { class: 'hint' }, t('מילוי מחליף את מה שכתוב בקול 1 בסלאש על כל פעמה; אקורדים וטקסטים נשארים. סימון קצבי משאיר את הקצב ומסתיר את הצלילים, ואפשר להחזיר אותם.')),
      h('h4', {}, t('העתקה והדבקה')),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn labeled', onclick: go(() => this.copy(m, +count.value || 1, staves)) }, icon('copy'), t('העתקה')),
        this.clip ? h('button', { class: 'btn labeled', onclick: go(() => this.paste(m)) }, t('הדבקה כאן ({n} תיבות)', { n: this.clip.n })) : null,
        h('button', { class: 'btn labeled danger', onclick: go(() => this.act(() => d.clear(staves, m, Math.min(d.measureCount() - 1, m + (+count.value || 1) - 1)), { keepSel: true })) }, t('ניקוי'))),
      h('p', { class: 'hint' }, t('העתקה, הדבקה וניקוי חלים על החמשות שעל המסך ({list}).', { list: staves.map(id => this.staffInfo(id).label).join(', ') }))));
  }
  copy(m, n, staves) {
    const m1 = Math.min(this.doc.measureCount() - 1, m + n - 1);
    try { this.clip = this.doc.copy(staves, m, m1); this.clipN = n; toast(t('הועתקו {n} תיבות', { n: m1 - m + 1 })); } catch (e) { toast(e.message, 3500); }
  }
  paste(m) {
    if (!this.clip) return toast(t('אין מה להדביק'));
    this.act(() => this.doc.paste(this.clip, m, this.clip.staves.length === 1 && this.sel ? this.sel.staff : null), { keepSel: true });
  }

  // ---------------------------------------------------------------- hearing it
  audition(pitches) {
    if (!pitches || !pitches.length || this.muted) return;
    try {
      const c = audioCtx(); const t0 = c.currentTime + 0.01;
      for (const p of pitches.slice(0, 6)) {
        const o = c.createOscillator(); const g = c.createGain();
        o.type = 'triangle'; o.frequency.value = 440 * Math.pow(2, (p - 69) / 12);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.14 / Math.sqrt(pitches.length), t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
        o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + 0.5);
      }
    } catch { /* no audio */ }
  }

  // ---------------------------------------------------------------- playing notes in (microphone)
  // note input by ear: play or sing a note, it is written with the length chosen, then the next one
  async toggleMic(given = null) {   // given: another sound source (a MediaStream), for tests
    if (this.mic) return this.stopMic();
    if (!this.input) this.setInput(true);
    let stream = given;
    if (!stream) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast(t('אין גישה למיקרופון בכתובת הזו (צריך HTTPS).'));
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
      catch (e) { return toast(t('המיקרופון לא נפתח: {msg}', { msg: e.message }), 4000); }
    }
    const { detectPitch, noteOf, heardNote } = await import('./tuner.js');
    const c = audioCtx(); if (c.state !== 'running') await c.resume().catch(() => {});
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser(); an.fftSize = 2048;
    const mute = c.createGain(); mute.gain.value = 0;
    src.connect(an); an.connect(mute).connect(c.destination);
    const buf = new Float32Array(an.fftSize);
    const mic = this.mic = { stream, src, an, timer: 0, heard: {} };
    this.muted = true;   // the editor's own sound would be heard back
    const a4 = store.state.settings.a4 || 440;
    const tick = () => {
      if (this.mic !== mic) return;
      an.getFloatTimeDomainData(buf);
      const r = detectPitch(buf, c.sampleRate, 50, 1500);
      const midi = r && r.clarity > 0.85 ? noteOf(r.freq, a4).midi : null;
      const got = heardNote(mic.heard, midi, performance.now());
      if (got != null) {
        const a = this.here();
        if (a) { const ev = this.doc.events(a.staff, a.m, a.voice); this.enterAt(a, [[got, pitchToTpc(got, ev.key)]]); }
      }
      this.micLevel(r ? Math.min(1, r.rms * 12) : 0, midi);
      mic.timer = setTimeout(tick, 35);
    };
    tick();
    this.renderPal();
    toast(t('מנגנים או שרים צליל אחרי צליל: כל צליל נכתב באורך שנבחר'), 4000);
  }
  stopMic() {
    const mic = this.mic; if (!mic) return;
    this.mic = null; this.muted = false;
    clearTimeout(mic.timer);
    try { mic.src.disconnect(); mic.an.disconnect(); } catch { /* gone */ }
    mic.stream.getTracks().forEach(x => x.stop());
    this.renderPal();
    this.paint();
  }
  micLevel(level, midi) {
    const el = this.dock && this.dock.querySelector('.ne-mic'); if (!el) return;
    el.style.setProperty('--lvl', String(level));
    el.dataset.note = midi != null ? noteName(midi, pitchToTpc(midi, 0)) : '';
  }

  // ---------------------------------------------------------------- the dock: bar + palette
  build() {
    this.dock = h('div', { class: 'ne-dock', role: 'toolbar', 'aria-label': t('עריכת תווים') });
    this.barEl = h('div', { class: 'ne-bar' });
    this.infoEl = h('div', { class: 'ne-info', dir: 'auto' });
    this.palEl = h('div', { class: 'ne-pal' });
    this.dock.append(this.barEl, this.palEl);
    this.v.el.append(this.dock);
    this.renderBar(); this.renderPal();
    this.fit();
    this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(this.dock);
  }
  // the music keeps clear of the dock
  fit() {
    const hgt = this.dock.getBoundingClientRect().height;
    this.v.el.style.setProperty('--ne-dock', Math.ceil(hgt) + 'px');
    if (this.eng && this.eng.wrap) { this.eng.fitPages(); this.eng.show(); this.paint(); }
  }
  renderBar() {
    const n = this.doc ? this.doc.changes : 0;
    this.barEl.replaceChildren(
      h('strong', { class: 'nb-title' }, t('עריכת תווים')),
      this.infoEl,
      h('span', { class: 'ne-spacer' }),
      h('span', { class: 'muted nb-count' }, n ? t('{n} שינויים', { n }) : ''),
      btn('undo', t('ביטול (⌘Z)'), () => this.undo(), 'ghost'),
      ib(ICO.redo, t('שחזור (⇧⌘Z)'), () => this.redo(), 'ghost'),
      btn('more', t('עוד'), () => this.moreSheet(), 'ghost'),
      h('button', { class: 'btn labeled primary', disabled: !n || this.busy, onclick: () => this.save() }, this.busy ? t('שומר…') : t('שמירה')),
      h('button', { class: 'btn labeled', onclick: () => this.v.stopNoteEdit() }, t('סיום')));
    this.renderInfo();
  }
  renderInfo() {
    if (!this.infoEl) return;
    const a = this.sel; const e = a && this.event();
    if (!a || !e) { this.infoEl.textContent = this.input ? t('נוגעים בחמשה כדי לכתוב תו') : t('נוגעים בתו כדי לבחור אותו'); return; }
    const st = this.staffInfo(a.staff);
    const what = e.rest ? t('שתיקה') : e.slash ? (e.slash === 'slash' ? t('סלאש') : t('סלאש קצבי')) : e.notes.map((n, k) => { const w = toWritten(this.doc, a.staff, n.pitch, n.tpc); const s = noteName(w.pitch, w.tpc); return k === a.n && e.notes.length > 1 ? `[${s}]` : s; }).join(' ');
    this.infoEl.textContent = `${t('תיבה {n}', { n: a.m + 1 })} · ${st.label || ''}${a.voice ? ' · ' + t('קול {n}', { n: a.voice + 1 }) : ''} · ${DUR_NAME[e.type] || (e.type === 'measure' ? t('תיבה שלמה') : e.type)}${e.dots ? '.' : ''} · ${what}`;
  }
  renderPal() {
    if (!this.palEl) return;
    const e = !this.input && this.sel ? this.event() : null;
    const curDur = e ? e.type : this.dur; const curDots = e ? e.dots : this.dots;
    const sep = () => h('span', { class: 'ne-sep' });
    const row1 = h('div', { class: 'ne-row', dir: 'ltr' },
      ib(ICO.input, t('הזנת תווים (N)'), () => this.setInput(!this.input), 'ne-input' + (this.input ? ' on' : '')),
      sep(),
      ...DURS.map(([ty, k]) => ib(durSvg(ty), `${DUR_NAME[ty]} (${k})`, () => this.duration(ty), curDur === ty ? 'on' : '')),
      ib(ICO.dot, t('נקודה (.)'), () => this.toggleDot(), curDots ? 'on' : ''),
      ib(ICO.rest, t('שתיקה (0)'), () => this.rest()),
      ib(ICO.tie, t('קשת חיבור (+)'), () => this.tie()),
      tb('𝄍', t('סלאש (/): בהזנה כותב סלאש באורך שנבחר; על תו נבחר הופך אותו לסלאש ובחזרה'), () => this.slash(), 'ne-slash' + (e && e.slash ? ' on' : '')),
      sep(),
      tb('♭', t('במול (-)'), () => this.move('flat')), tb('♮', t('בקר'), () => this.move('natural')), tb('♯', t('דיאז (=)'), () => this.move('sharp')),
      tb('▲', t('צליל למעלה (↑)'), () => this.move('up')), tb('▼', t('צליל למטה (↓)'), () => this.move('down')),
      tb('8▲', t('אוקטבה למעלה (⌘↑)'), () => this.move('octUp')), tb('8▼', t('אוקטבה למטה (⌘↓)'), () => this.move('octDown')),
      sep(),
      tb('◀', t('קודם (←)'), () => this.step(-1)), tb('▶', t('הבא (→)'), () => this.step(1)),
      btn('trash', t('מחיקה (⌫)'), () => this.del(), 'ghost ne-b'));
    const row2 = h('div', { class: 'ne-row', dir: 'ltr' },
      ...NOTE_NAMES.map((L, step) => tb(L, `${L} (${L})`, () => this.letter(step), 'ne-letter')),
      tb('+♪', t('צליל נוסף לאקורד (⇧ + אות)'), () => { this.chord = !this.chord; this.renderPal(); }, this.chord ? 'on' : ''),
      h('span', { class: 'ne-lbl' }, t('קול')),
      segmented([0, 1, 2, 3].map(k => ({ value: String(k), label: String(k + 1) })), String(this.voice), v => { this.voice = +v; if (this.sel) { this.sel = null; this.paint(); } }),
      sep(),
      tb(t('אקורד'), t('אקורד (⌘K)'), () => this.chordSymbol(), 'ne-w'),
      tb(t('טקסט'), t('טקסט (⌘T)'), () => this.text('StaffText'), 'ne-w'),
      tb(t('סימן'), t('סימן חזרה (⌘M)'), () => this.text('RehearsalMark'), 'ne-w'),
      tb('mf', t('דינמיקה'), () => this.dynamicsSheet(), 'ne-dyn'),
      ...ARTICS.map(([sub, s, nm]) => tb(s, nm, () => this.artic(sub))),
      tb('𝄐', t('פרמטה'), () => this.fermata()),
      sep(),
      tb(t('תיבה'), t('תיבה: הוספה, מחיקה, סולם, חזרות, העתקה'), () => this.measureSheet(), 'ne-w'),
      ib(ICO.mic, t('כתיבה בנגינה: המיקרופון שומע וכותב'), () => this.toggleMic(), 'ne-mic' + (this.mic ? ' on' : '')));
    this.palEl.replaceChildren(row1, row2);
  }

  // ---------------------------------------------------------------- keyboard (as in MuseScore)
  onKey(e) {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.sheet-back:not(.closing)')) return;
    const k = e.key; const cmd = e.metaKey || e.ctrlKey;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (cmd && k.toLowerCase() === 'z') { stop(); return e.shiftKey ? this.redo() : this.undo(); }
    if (cmd && k.toLowerCase() === 'y') { stop(); return this.redo(); }
    if (cmd && k.toLowerCase() === 's') { stop(); return this.save(); }
    if (cmd && k.toLowerCase() === 'k') { stop(); return this.chordSymbol(); }
    if (cmd && k.toLowerCase() === 't') { stop(); return this.text('StaffText'); }
    if (cmd && k.toLowerCase() === 'm') { stop(); return this.text('RehearsalMark'); }
    if (cmd && k.toLowerCase() === 'c' && this.sel) { stop(); return this.copy(this.sel.m, 1, this.viewStaves()); }
    if (cmd && k.toLowerCase() === 'v' && this.sel) { stop(); return this.paste(this.sel.m); }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      stop(); const up = k === 'ArrowUp';
      if (e.altKey) return this.chordStep(up ? 1 : -1);
      return this.move(cmd ? (up ? 'octUp' : 'octDown') : (up ? 'sharp' : 'flat'));
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { stop(); return this.step(k === 'ArrowRight' ? 1 : -1); }
    if (cmd || e.altKey) return;
    if (k === 'Escape') { stop(); if (this.input) return this.setInput(false); if (this.sel) { this.sel = null; return this.paint(); } return this.v.stopNoteEdit(); }
    const L = k.toUpperCase();
    if (/^[A-G]$/.test(L)) { stop(); return this.letter(NOTE_NAMES.indexOf(L), { add: e.shiftKey }); }
    const d = DURS.find(x => x[1] === k);
    if (d) { stop(); return this.duration(d[0]); }
    if (k === 'n' || k === 'N') { stop(); return this.setInput(!this.input); }
    if (k === '.') { stop(); return this.toggleDot(); }
    if (k === '0') { stop(); return this.rest(); }
    if (k === '+') { stop(); return this.tie(); }
    if (k === '/') { stop(); return this.slash(); }
    if (k === '-') { stop(); return this.move('flat'); }
    if (k === '=') { stop(); return this.move('sharp'); }
    if (k === 'Backspace' || k === 'Delete') { stop(); return this.del(); }
    if (k === ' ') { stop(); return this.step(1); }
  }

  // ---------------------------------------------------------------- song, file, save, close
  moreSheet() {
    const go = fn => () => { sh.close(); fn(); };
    const sh = sheet(t('עריכת תווים'), h('div', { class: 'list' },
      h('button', { class: 'li', onclick: go(() => this.songSheet()) }, icon('edit'), t('שם השיר וטמפו')),
      h('button', { class: 'li', onclick: go(() => this.measureSheet()) }, icon('grid'), t('תיבה: הוספה, מחיקה, סולם, חזרות, העתקה')),
      h('button', { class: 'li', onclick: go(() => this.exportFile()) }, icon('share'), t('שליחת קובץ MuseScore (.mscz)')),
      h('button', { class: 'li', onclick: go(() => this.keysHelp()) }, icon('key'), t('קיצורי מקלדת'))));
  }
  keysHelp() {
    const rows = [['N', t('הזנת תווים: הפעלה / כיבוי')], ['A–G', t('צליל (⇧ + אות: הוספה לאקורד)')], ['2–7', t('אורך: 1/32 … שלם')], ['.', t('נקודה')], ['0', t('שתיקה')],
      ['+', t('קשת חיבור')], ['/', t('סלאש: בהזנה כותב סלאש; על תו נבחר הופך לסלאש ובחזרה')], ['↑ ↓', t('חצי טון')], ['⌘↑ ⌘↓', t('אוקטבה')], ['← →', t('תו קודם / הבא')], ['⌥↑ ⌥↓', t('צליל באקורד')], ['⌫', t('מחיקה')],
      ['⌘K', t('אקורד (רווח: שמירה והבא)')], ['⌘T', t('טקסט')], ['⌘M', t('סימן חזרה')], ['⌘C ⌘V', t('העתקה והדבקה של תיבה')], ['⌘Z ⇧⌘Z', t('ביטול / שחזור')], ['⌘S', t('שמירה')], ['Esc', t('יציאה ממצב / סיום')]];
    sheet(t('קיצורי מקלדת'), h('div', { class: 'ne-keys' }, ...rows.map(([k, d]) => h('div', { class: 'ne-key' }, h('kbd', { dir: 'ltr' }, k), h('span', {}, d)))));
  }
  songSheet() {
    const title = h('input', { class: 'input', value: this.doc.title(), dir: 'auto' });
    const tempo = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 20, max: 400, value: this.doc.tempo() || '' });
    const sh = sheet(t('שם השיר וטמפו'), h('div', { class: 'confirm' },
      h('label', { class: 'field' }, h('span', {}, t('שם השיר')), title),
      this.doc.tempo() != null ? h('label', { class: 'field' }, h('span', {}, t('טמפו (רבעים לדקה)')), tempo) : h('p', { class: 'hint' }, t('אין סימון טמפו בקובץ')),
      h('div', { class: 'row end' }, h('button', { class: 'btn labeled primary', onclick: () => {
        sh.close();
        this.act(() => this.doc.batch(() => {
          if (title.value.trim() && title.value.trim() !== this.doc.title()) this.doc.setTitle(title.value.trim());
          if (this.doc.tempo() != null && +tempo.value && +tempo.value !== this.doc.tempo()) this.doc.setTempo(+tempo.value);
        }), { keepSel: true });
      } }, t('אישור')))));
  }
  exportFile() {
    const bytes = this.doc.save();
    const name = (this.v.score.fileName || this.v.score.title || 'score') + '.mscz';
    const file = new File([bytes], name, { type: 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
    else { const a = h('a', { href: URL.createObjectURL(file), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
  }
  async save() {
    if (this.busy || !this.dirty) return;
    if (this.fromXml && !await confirmBox(t('השיר יישמר כקובץ MuseScore, והתווים (גם ה-PDF והתפקידים) ייכתבו מחדש ב-MuseScore שבאייפד. הגרסה הקודמת נשארת בהיסטוריית הגרסאות.'), t('שמירה'))) return;
    this.busy = true; this.renderBar();
    try {
      if (this.v.scoreId !== this.scoreId) throw new Error(t('במסך עכשיו שיר אחר'));
      const res = await saveEdited(this.scoreId, this.doc.save(), this.doc.ops.slice());
      this.doc.saved(); this.fromXml = false; this.saved = true;
      toast(res.status === 'same' ? t('אין שינוי בקובץ') : t('נשמר: גרסה {v}', { v: this.v.score.version.v }), 3000);
    } catch (e) {
      console.error(e); toast(t('השמירה נכשלה: {msg}', { msg: e.message }), 5000);
    } finally { this.busy = false; this.renderBar(); }
  }
  async close() {
    if (this.dirty && !await confirmBox(t('יש {n} שינויים שלא נשמרו. לצאת בלי לשמור?', { n: this.doc.changes }), t('יציאה בלי שמירה'), true)) return false;
    this.stopMic();
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.keys, true);
    if (this.ro) this.ro.disconnect();
    if (this.dock) this.dock.remove();
    this.v.el.style.removeProperty('--ne-dock');
    for (const x of this.v.stage.querySelectorAll('.ne-mark')) x.remove();
    if (this.eng) { this.eng.edit = null; this.eng.onRender = null; }
    return true;
  }
}
