// Score viewer: page mode (the exact PDFs exported from MuseScore) and live mode (Verovio), page turning,
// pedal, half-page turns, jumps, pencil, metronome, reference audio, setlist + performance mode.
import { h, $, icon, btn, toast, sheet, segmented, toggle, fmtDateTime, onLongPress, confirmBox } from './ui.js';
import * as store from './store.js';
import { t, locale } from './i18n.js';
import { openPdf } from './pdfdoc.js';
import { Annotator } from './annot.js';
import { Metronome, audioCtx } from './metronome.js';
import { keyAfter, keyName, semisLabel, matchPart, ALL_KEYS, semisBetween } from './music.js';
import { audioSheet } from './player.js';
import { canEngrave, engraveKey } from './importer.js';
import { ScoreEditor } from './scoreedit.js';
import { itemSeconds, fmtDur } from './duration.js';

// when each setlist's performance started (kept across a reload; a new one after 8 hours)
function setStart(id, reset = false) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('setStart') || '{}'); } catch { /* private mode */ }
  if (reset || !all[id] || Date.now() - all[id] > 8 * 3600e3) {
    all[id] = Date.now();
    try { localStorage.setItem('setStart', JSON.stringify(all)); } catch { /* private mode */ }
  }
  return all[id];
}
import { report as bandReport, band, openBand, bandLabel, onBand } from './band.js';

let current = null;
export const currentViewer = () => current;

export async function openViewer(opts) {
  if (current) current.destroy();
  current = new Viewer(opts);
  await current.init();
}

class Viewer {
  constructor({ scoreId, setlistId = null, index = 0, perform = false, onClose }) {
    this.setlist = setlistId ? store.state.setlists.find(s => s.id === setlistId) : null;
    this.index = index;
    this.scoreId = this.setlist ? this.setlist.items[index].scoreId : scoreId;
    this.perform = perform;
    this.onClose = onClose;
    this.mode = 'page';
    this.engine = null;
    this.chrome = !perform;
    this.locked = perform;
    this.metro = new Metronome();
    this.metro.sub = store.state.settings.metroSub || 1;
    this.metro.sound = store.state.settings.metroSound !== false;
    this.annot = null;
    this.wake = null;
  }

  get item() { return this.setlist ? this.setlist.items[this.index] : null; }
  get score() { return store.scoreById(this.scoreId); }
  get meta() { return store.metaFor(this.scoreId); }

  // ---------------------------------------------------------------- per song settings
  get semis() { const it = this.item; return (it && it.semis != null ? it.semis : this.meta.semis) || 0; }
  set semis(v) { if (this.item) { this.item.semis = v; store.save('setlists'); } else store.updateMeta(this.scoreId, { semis: v }); }
  get partName() {
    const it = this.item;
    if (it && it.part != null) return it.part;
    if (this.meta.part != null) return this.meta.part;
    const s = this.score;
    if (s && s.version.parts.length) {
      const i = matchPart(s.version.parts, store.state.settings.partWords);
      return i >= 0 ? s.version.parts[i].name : '';
    }
    return '';
  }
  set partName(v) { if (this.item) { this.item.part = v; store.save('setlists'); } else store.updateMeta(this.scoreId, { part: v }); }
  get tempo() { const it = this.item; return (it && it.tempo) || this.score.tempo || 100; }

  // ---------------------------------------------------------------- lifecycle
  async init() {
    this.el = h('div', { class: 'viewer theme-' + store.state.settings.theme });
    this.stage = h('div', { class: 'stage' });
    this.top = h('div', { class: 'chrome-top' });
    this.bottom = h('div', { class: 'chrome-bottom' });
    this.strip = h('div', { class: 'perform-strip' });
    this.flash = h('div', { class: 'flash' });
    this.lockBadge = h('button', { class: 'lockbadge', 'aria-label': t('לחיצה ארוכה לשחרור נעילה') }, icon('lock'));
    onLongPress(this.lockBadge, () => this.setLocked(false), 800);
    this.lockBadge.onclick = () => toast(t('לחיצה ארוכה לשחרור הנעילה'));
    this.el.append(this.strip, this.stage, this.top, this.bottom, this.flash, this.lockBadge);
    document.getElementById('app').append(this.el);
    document.body.classList.add('in-viewer');

    this.metro.onBeat = (b, accent) => this.blink(accent);
    this.keyHandler = e => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    this.resizeObs = new ResizeObserver(() => { clearTimeout(this._rt); this._rt = setTimeout(() => this.engine && this.engine.layout(), 120); });
    this.resizeObs.observe(this.stage);
    this.bindStage();
    if (this.perform) this.acquireWake();
    this.visHandler = () => { if (document.visibilityState === 'visible' && this.perform) this.acquireWake(); };
    document.addEventListener('visibilitychange', this.visHandler);
    this.offBand = onBand(() => this.renderBandBadge());
    await this.loadSong({});
  }

  destroy() {
    this.metro.stop();
    clearInterval(this._clock);
    if (this.engine) this.engine.destroy();
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('visibilitychange', this.visHandler);
    this.resizeObs.disconnect();
    if (this.wake) { this.wake.release().catch(() => {}); this.wake = null; }
    if (this.offBand) this.offBand();
    this.el.remove();
    document.body.classList.remove('in-viewer');
    if (current === this) current = null;
  }
  close() {
    if (this.noteEd && this.noteEd.dirty) { this.stopNoteEdit().then(() => { if (!this.noteEd) this.close(); }); return; }
    this.destroy();
    bandReport(null);
    this.onClose && this.onClose();
  }

  async acquireWake() {
    try { if ('wakeLock' in navigator) this.wake = await navigator.wakeLock.request('screen'); }
    catch { /* not allowed: the user can set Auto-Lock to Never */ }
  }

  async loadSong({ atEnd = false }) {
    const s = this.score;
    if (!s) { toast(t('השיר לא נמצא בספרייה')); return this.close(); }
    store.updateMeta(this.scoreId, { lastOpened: Date.now() });
    this.metro.stop();
    this.metro.bpm = this.tempo; this.metro.beats = parseInt(s.timesig) || 4;
    this.annot = new Annotator({
      scoreId: this.scoreId,
      docName: () => this.docName(),
      mpos: () => (this.engine && this.engine.mpos) || null,
    });
    await this.annot.load();
    // songs open in page mode (the exact PDF). In another key: MuseScore's PDF of that key (engraved here
    // from the .mscz when the song has one), else live mode (Verovio)
    let exact = !this.semis || store.pdfKeys(s).includes(this.semis);
    if (!exact && canEngrave(s)) exact = await this.engrave(this.semis);
    const want = !s.hasPdf || (!exact && s.hasXml) ? 'live' : 'page';
    await this.setMode(want, { atEnd });
  }

  docName() { return this.partName ? 'part:' + this.partName : 'score'; }

  async setMode(mode, { atEnd = false } = {}) {
    const s = this.score;
    if (mode === 'page' && !s.hasPdf) { toast(t('לשיר הזה אין PDF – רק מצב חי')); mode = 'live'; }
    if (mode === 'live' && !s.hasXml) { toast(t('מצב חי צריך MusicXML. ב-MuseScore: ייצוא ← MusicXML, וייבוא מחדש')); mode = 'page'; }
    if (this.engine) { this.engine.destroy(); this.engine = null; }
    this.stage.replaceChildren();
    this.mode = mode;
    this.el.classList.toggle('mode-live', mode === 'live');
    if (mode === 'live') {
      const { LiveEngine } = await import('./live.js');
      this.engine = new LiveEngine(this);
    } else {
      this.engine = new PageEngine(this);
    }
    this.renderChrome();
    try {
      await this.engine.open();
      if (atEnd) this.engine.goEnd(); else this.engine.layout();
    } catch (e) {
      console.error(e);
      this.stage.replaceChildren(h('div', { class: 'stage-msg' }, h('p', {}, t('לא הצלחתי לפתוח את התווים')), h('p', { class: 'hint' }, String(e.message || e))));
    }
    this.renderChrome();
    if (this.chrome && !this.perform) { clearTimeout(this._hide); this._hide = setTimeout(() => this.toggleChrome(false), 2500); }
    bandReport(this);
  }

  // band: go where the leader is (by measure, so every part turns at the same place)
  followTo(measure, frac) {
    if (!this.engine || !this.engine.goMeasure) return;
    if (this.annot && this.annot.editing) return;
    if (this.engine.goMeasure(measure, frac)) this.afterTurn(true);
  }
  renderBandBadge() {
    if (!this.top) return;
    const b = this.top.querySelector('.band-badge');
    const label = bandLabel();
    if (b) { b.querySelector('span').textContent = label || t('להקה'); b.classList.toggle('on', !!band.role); }
  }

  // ---------------------------------------------------------------- navigation
  async next() {
    if (this.annot && this.annot.editing) return;
    if (this.engine && this.engine.next()) return this.afterTurn();
    if (this.setlist && this.index < this.setlist.items.length - 1) return this.gotoItem(this.index + 1);
    this.nudge();
  }
  async prev() {
    if (this.annot && this.annot.editing) return;
    if (this.engine && this.engine.prev()) return this.afterTurn();
    if (this.setlist && this.index > 0) return this.gotoItem(this.index - 1, true);
    this.nudge();
  }
  async gotoItem(i, atEnd = false) {
    // the note editor works on one song: finish it before moving on
    if (this.noteEd) { toast(t('קודם מסיימים את עריכת התווים (שמירה או סיום)')); this.nudge(); return; }
    this.index = i;
    this.scoreId = this.setlist.items[i].scoreId;
    await this.loadSong({ atEnd });
  }
  afterTurn(remote = false) { this.updateIndicator(); this.renderStrip(); if (!remote) bandReport(this); }
  nudge() { this.stage.classList.remove('nudge'); void this.stage.offsetWidth; this.stage.classList.add('nudge'); }

  onKey(e) {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const st = store.state.settings;
    if (st.keysNext.includes(e.key)) { e.preventDefault(); this.next(); }
    else if (st.keysPrev.includes(e.key)) { e.preventDefault(); this.prev(); }
    else if (e.key === 'Escape') { if (this.noteEd) this.stopNoteEdit(); else if (this.annot.editing) this.stopPencil(); else if (!this.locked) this.close(); }
  }

  bindStage() {
    let sx = 0, sy = 0, st = 0, multi = false;
    this.stage.addEventListener('pointerdown', e => {
      if (e.target.closest('.annot.editing') && !(store.state.settings.pencilOnly && e.pointerType === 'touch')) return;
      sx = e.clientX; sy = e.clientY; st = Date.now(); multi = !e.isPrimary;
    });
    this.stage.addEventListener('pointerup', e => {
      if (!e.isPrimary || multi) return;
      if (e.target.closest('.annot.editing') && !(store.state.settings.pencilOnly && e.pointerType === 'touch')) return;
      if (e.target.closest('button, a, input, select')) return;
      const dx = e.clientX - sx; const dy = e.clientY - sy; const dt = Date.now() - st;
      const editing = this.annot && this.annot.editing;
      const scrollMode = this.mode === 'live' && store.state.settings.liveScroll;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600) {
        // swipe: finger moving left reveals the next page (like a book)
        this.swipedAt = Date.now();
        if (dx < 0) this.next(); else this.prev();
        return;
      }
      // note editing: a tap on the music is for the editor
      if (this.noteEd) { if (Math.abs(dx) <= 12 && Math.abs(dy) <= 12 && dt <= 700) this.noteEd.tap(e); return; }
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || dt > 500 || editing) return;
      const r = this.stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const zone = x > 0.7 ? 'right' : x < 0.3 ? 'left' : 'mid';
      if (zone === 'mid') { if (!this.locked) this.toggleChrome(); return; }
      if (scrollMode) return;
      const forward = zone === store.state.settings.nextSide;
      if (forward) this.next(); else this.prev();
    });
  }

  toggleChrome(force) {
    clearTimeout(this._hide);
    this.chrome = force ?? !this.chrome;
    this.el.classList.toggle('chrome', this.chrome);
  }
  setLocked(v) {
    this.locked = v;
    this.el.classList.toggle('locked', v);
    if (v) this.toggleChrome(false);
    toast(v ? t('המסך נעול – רק דפדוף. לחיצה ארוכה על המנעול משחררת') : t('הנעילה שוחררה'));
  }
  blink(accent) {
    if (!this.perform && !this.metroVisual && this.metro.sound) return;
    this.flash.classList.remove('on', 'accent'); void this.flash.offsetWidth;
    this.flash.classList.add('on'); if (accent) this.flash.classList.add('accent');
  }

  // ---------------------------------------------------------------- chrome
  renderChrome() {
    const s = this.score;
    if (!s) return;
    this.el.classList.toggle('chrome', this.chrome);
    this.el.classList.toggle('locked', this.locked);
    this.el.classList.toggle('perform', this.perform);
    const keyLabel = s.keysig != null ? keyAfter(s.keysig, this.semis) : semisLabel(this.semis);
    const parts = s.version.parts;
    const top = [
      btn('back', t('חזרה לספרייה'), () => this.close(), 'ghost'),
      h('div', { class: 'vt-title' },
        h('strong', { dir: 'auto' }, s.title),
        this.setlist ? h('span', { class: 'muted' }, `${this.setlist.name} · ${this.index + 1}/${this.setlist.items.length}`) : (s.composer ? h('span', { class: 'muted', dir: 'auto' }, s.composer) : null)),
      // only what is used while playing; the rest is in "more"
      h('div', { class: 'vt-tools' },
        segmented([{ value: 'page', label: t('דף') }, { value: 'live', label: t('חי') }], this.mode, m => this.setMode(m)),
        h('button', { class: 'vt-text', onclick: () => this.keySheet(), title: t('טון') },
          h('span', {}, keyLabel || t('טון')), this.semis ? h('small', {}, semisLabel(this.semis)) : null),
        parts.length || this.mode === 'live' ? h('button', { class: 'vt-text', onclick: () => this.partSheet(), title: t('פרט') }, h('span', { dir: 'auto' }, this.partName || t('פרטיטורה'))) : null,
        this.mode === 'page' ? btn('pen', t('עיפרון'), () => this.startPencil(), 'ghost') : null,
        this.mode === 'live' ? btn('play', t('ניגון'), () => this.engine.playSheet && this.engine.playSheet(), 'ghost') : null,
        // a running metronome stays in reach so it can be stopped
        this.metro.running ? btn('metronome', t('מטרונום'), () => this.metroSheet(), 'ghost on') : null,
        h('button', { class: 'btn ghost band-badge' + (band.role ? ' on' : ''), onclick: () => openBand(), title: t('להקה'), 'aria-label': t('להקה') }, icon('sync'), band.role ? h('span', {}, bandLabel()) : null),
        btn('more', t('עוד'), () => this.moreSheet(), 'ghost')),
    ];
    this.top.replaceChildren(...top);
    this.renderBottom();
    this.renderStrip();
  }

  renderBottom() {
    const jumps = this.engine ? this.engine.jumps() : [];
    const bar = h('div', { class: 'jumpbar', role: 'navigation', 'aria-label': t('קפיצה לחלק') },
      ...jumps.map(j => h('button', { class: 'jump', onclick: () => { this.engine.go(j); this.afterTurn(); } }, j.label)),
      this.mode === 'page' ? h('button', { class: 'jump add', onclick: () => this.addBookmark(), 'aria-label': t('סימניה חדשה') }, '+') : null);
    this.indicator = h('span', { class: 'indicator' });
    const review = this.annot && this.mode === 'page' ? this.annot.reviewCount() : 0;
    bar.dir = 'ltr';
    this.indicator.dir = 'ltr';
    this.bottom.replaceChildren(...[bar,
      review ? h('button', { class: 'btn labeled warn', onclick: () => this.reviewSheet() }, t('{n} הערות לבדיקה', { n: review })) : null,
      this.indicator].filter(Boolean));
    this.updateIndicator();
  }
  updateIndicator() { if (this.indicator && this.engine) this.indicator.textContent = this.engine.label(); }

  renderStrip() {
    if (!this.perform) { this.strip.replaceChildren(); return; }
    const s = this.score;
    const nextItem = this.setlist && this.setlist.items[this.index + 1];
    const ns = nextItem && store.scoreById(nextItem.scoreId);
    const clock = h('span', { class: 'clock' });
    // set timer: how long the set has run, and roughly how long the songs after this one take
    const l = this.setlist;
    const timer = l ? h('button', { class: 'ps-timer', 'aria-label': t('זמן הסט. לחיצה ארוכה מאפסת') }) : null;
    let left = 0, leftExact = true, leftKnown = false;
    if (l) for (const it of l.items.slice(this.index + 1)) { const d = itemSeconds(it); if (d) { left += d.sec; leftKnown = true; leftExact = leftExact && d.exact; } else leftExact = false; }
    const tick = () => {
      clock.textContent = new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
      if (timer) timer.replaceChildren(h('span', { dir: 'ltr' }, '⏱ ' + fmtDur((Date.now() - setStart(l.id)) / 1000)),
        leftKnown ? h('span', { class: 'ps-left' }, ' · ' + t('נותר') + ' ', h('span', { dir: 'ltr' }, (leftExact ? '' : '≈') + fmtDur(left))) : '');
    };
    if (timer) {
      onLongPress(timer, () => { setStart(l.id, true); tick(); toast(t('זמן הסט אופס')); }, 800);
      timer.onclick = () => toast(t('הזמן מתחילת הסט, ובערך כמה נשאר אחרי השיר הזה. לחיצה ארוכה מאפסת'));
    }
    tick(); clearInterval(this._clock); this._clock = setInterval(tick, 1000);
    const item = this.item;
    this.strip.replaceChildren(...[
      this.mode === 'page' && this.engine && this.engine.transposedMissing ? h('span', { class: 'ps-warn' }, t('⚠ מוצג בטון המקורי') + (s.keysig != null ? ` (${keyName(s.keysig)})` : '')) : null,
      h('span', { class: 'ps-now', dir: 'auto' }, h('b', {}, s.title), s.keysig != null ? [' · ', h('bdi', { dir: 'ltr' }, keyAfter(s.keysig, this.semis))] : '',
        item && item.note ? h('em', {}, ' · ' + item.note) : ''),
      ns ? h('span', { class: 'ps-next', dir: 'auto' }, t('הבא:') + ' ', h('b', {}, ns.title),
        ns.keysig != null ? [' · ', h('bdi', { dir: 'ltr' }, keyAfter(ns.keysig, nextItem.semis ?? store.metaFor(ns.id).semis ?? 0))] : '') : h('span', { class: 'ps-next' }, this.setlist ? t('שיר אחרון') : ''),
      this.engine ? h('span', { class: 'ps-page', dir: 'ltr' }, this.engine.label()) : null,
      timer,
      clock,
      h('button', { class: 'btn ghost ps-exit', 'aria-label': t('לחיצה ארוכה ליציאה ממצב הופעה') }, icon('close')),
    ].filter(Boolean));
    const exit = $('.ps-exit', this.strip);
    onLongPress(exit, () => this.close(), 800);
    exit.onclick = () => toast(t('לחיצה ארוכה ליציאה ממצב הופעה'));
  }

  // ---------------------------------------------------------------- sheets
  keySheet() {
    const s = this.score;
    const base = s.keysig;
    const sl = h('div', { class: 'keys' });
    for (let i = -6; i <= 6; i++) {
      const exact = i === 0 || store.pdfKeys(s).includes(i) || canEngrave(s);
      const b = h('button', { class: 'keyb' + (i === this.semis ? ' on' : '') + (exact && s.hasPdf ? ' exact' : '') },
        h('b', {}, base != null ? keyAfter(base, i) : semisLabel(i)), h('small', {}, semisLabel(i) + (i && exact && s.hasPdf ? ' · PDF' : '')));
      b.onclick = () => { sh.close(); this.applySemis(i); };
      sl.append(b);
    }
    const note = canEngrave(s) ? t('כל טון נכתב כאן באייפד על ידי MuseScore, בעיצוב המקורי, ונשמר לפעם הבאה.')
      : (s.hasPdf ? t('טונים עם PDF מוצגים בעיצוב המקורי של MuseScore.') + ' ' : '') + (s.hasXml
      ? t('טון אחר מוצג במצב חי, ש-MuseScore מצייר בטון החדש.')
      : t('לשיר הזה אין MusicXML, ולכן טון אחר אפשרי רק אחרי ייצוא מ-MuseScore.'));
    const sh = sheet(t('טון'), h('div', {}, sl,
      base != null ? h('p', { class: 'hint' }, t('טון מקורי: {key}', { key: keyName(base) })) : null,
      h('p', { class: 'hint' }, note),
      this.item ? h('p', { class: 'hint' }, t('הטון נשמר לשיר הזה בתוך הסטליסט.')) : null));
  }
  // MuseScore (on the iPad) engraves the song in another key from its .mscz
  async engrave(semis) {
    try { await engraveKey(this.scoreId, semis); return true; }
    catch (e) { console.error(e); toast(t('MuseScore לא הצליח לכתוב את הטון: {err}', { err: e.message }), 5000); return false; }
  }
  async applySemis(i) {
    const s = this.score;
    let exact = s.hasPdf && (i === 0 || store.pdfKeys(s).includes(i));
    if (!exact && canEngrave(s)) exact = await this.engrave(i);
    if (!exact && !s.hasXml) return toast(t('הטון הזה עוד לא יוצא מ-MuseScore, ואין MusicXML למצב חי'));
    const was = this.semis;
    this.semis = i;
    // a key MuseScore exported → its exact PDF; any other key → live
    let mode = this.mode;
    if (!exact && mode === 'page') { mode = 'live'; toast(t('הטון הזה מוצג במצב חי (עוד אין לו PDF מ-MuseScore)')); }
    else if (exact && was !== i && mode === 'live' && s.hasPdf) mode = 'page';
    await this.setMode(mode);
  }
  partSheet() {
    const s = this.score;
    const parts = this.mode === 'live' ? (this.engine.partList ? this.engine.partList() : []) : s.version.parts.map(p => p.name);
    const cur = this.partName;
    const list = h('div', { class: 'list' },
      h('button', { class: 'li' + (!cur ? ' on' : ''), onclick: () => pick('') }, t('פרטיטורה מלאה')),
      ...parts.map(n => h('button', { class: 'li' + (n === cur ? ' on' : ''), dir: 'auto', onclick: () => pick(n) }, n)));
    const extra = this.mode === 'live' && this.engine.comboPicker ? this.engine.comboPicker(() => sh.close()) : null;
    const sh = sheet(t('פרט'), h('div', {}, list, extra,
      h('p', { class: 'hint' }, t('פרט ברירת המחדל נבחר לפי הכלי שלך בהגדרות.'))));
    const pick = n => { sh.close(); this.partName = n; this.setMode(this.mode); };
  }
  metroSheet() {
    const bpm = h('input', { type: 'number', class: 'input', value: this.metro.bpm, min: 20, max: 320, inputmode: 'numeric' });
    const beats = h('input', { type: 'number', class: 'input', value: this.metro.beats, min: 1, max: 12, inputmode: 'numeric' });
    const apply = () => { this.metro.bpm = Math.max(20, Math.min(320, +bpm.value || 100)); this.metro.beats = Math.max(1, +beats.value || 4); };
    bpm.oninput = apply; beats.oninput = apply;
    const go = h('button', { class: 'btn labeled primary big' }, this.metro.running ? t('עצירה') : t('הפעלה'));
    go.onclick = () => { apply(); const on = this.metro.toggle(); go.textContent = on ? t('עצירה') : t('הפעלה'); this.renderChrome(); };
    let taps = [];
    const tap = h('button', { class: 'btn labeled' }, t('טאפ'));
    tap.onclick = () => {
      const t = performance.now(); taps = taps.filter(x => t - x < 3000); taps.push(t);
      if (taps.length > 1) { bpm.value = Math.round(60000 / ((taps.at(-1) - taps[0]) / (taps.length - 1))); apply(); }
    };
    sheet(t('מטרונום'), h('div', {},
      h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('טמפו')), bpm), h('label', { class: 'field' }, h('span', {}, t('פעמות בתיבה')), beats)),
      h('div', { class: 'row' }, go, tap),
      h('div', { class: 'field' }, h('span', {}, t('חלוקה')), segmented([{ value: 1, label: '♩' }, { value: 2, label: '♪♪' }, { value: 3, label: t('טריולה') }, { value: 4, label: '16' }], this.metro.sub, v => { this.metro.sub = v; store.setSetting('metroSub', v); })),
      toggle(t('צליל (כבוי: רק הבהוב, בשקט)'), this.metro.sound, v => { this.metro.sound = v; store.setSetting('metroSound', v); }),
      toggle(t('הבהוב על המסך'), this.metroVisual || this.perform, v => { this.metroVisual = v; }),
      h('p', { class: 'hint' }, t('הטמפו מהקובץ: {tempo}', { tempo: this.score.tempo || '—' }))));
  }
  displaySheet() {
    const st = store.state.settings;
    const rerender = () => this.engine && this.engine.layout(true);
    const body = h('div', {},
      h('div', { class: 'field' }, h('span', {}, t('רקע')), segmented([{ value: 'normal', label: t('רגיל') }, { value: 'night', label: t('לילה') }, { value: 'sepia', label: t('ספיה') }], st.theme, v => {
        store.setSetting('theme', v); this.el.className = this.el.className.replace(/theme-\w+/, 'theme-' + v);
      })),
      this.mode === 'page' ? [
        toggle(t('שני עמודים ברוחב'), st.twoUp, v => { store.setSetting('twoUp', v); rerender(); }),
        toggle(t('חיתוך שוליים אוטומטי'), st.crop, v => { store.setSetting('crop', v); rerender(); }),
        toggle(t('חצי עמוד (העליון מתחלף קודם)'), st.halfPage, v => { store.setSetting('halfPage', v); rerender(); }),
      ] : this.engine.displayControls ? this.engine.displayControls() : null);
    sheet(t('תצוגה'), body);
  }
  moreSheet() {
    const s = this.score;
    const go = fn => () => { sh.close(); fn(); };
    const items = [
      h('button', { class: 'li', onclick: go(() => this.metroSheet()) }, icon('metronome'), t('מטרונום')),
      h('button', { class: 'li', onclick: go(() => audioSheet(this.score)) }, icon('audio'), t('הקלטת רפרנס')),
      h('button', { class: 'li', onclick: go(() => this.displaySheet()) }, icon('moon'), t('תצוגה')),
      h('button', { class: 'li', onclick: go(() => this.setLocked(true)) }, icon('lock'), t('נעילת מסך')),
      s.versions.length > 1 ? h('button', { class: 'li', onclick: () => { sh.close(); this.versionsSheet(); } }, icon('history'), t('היסטוריית גרסאות')) : null,
      h('button', { class: 'li', onclick: () => { sh.close(); this.perform = !this.perform; if (this.perform) { this.acquireWake(); this.setLocked(true); } this.renderChrome(); } }, icon('perform'), this.perform ? t('יציאה ממצב הופעה') : t('מצב הופעה')),
      h('button', { class: 'li', onclick: () => { sh.close(); this.addBookmark(); } }, icon('bookmark'), t('סימניה בעמוד הזה')),
      s.hasXml || canEngrave(s) ? h('button', { class: 'li', onclick: () => { sh.close(); this.startNoteEdit(); } }, icon('edit'), t('עריכת תווים')) : null,
      h('button', { class: 'li', onclick: async () => { sh.close(); audioCtx(); (await import('./tuner.js')).openTuner(); } }, icon('tuner'), t('טיונר')),
      (this.meta.bookmarks || []).length ? h('button', { class: 'li', onclick: () => { sh.close(); this.bookmarksSheet(); } }, icon('edit'), t('עריכת סימניות')) : null,
    ];
    const sh = sheet(t('עוד'), h('div', { class: 'list' }, ...items));
  }
  versionsSheet() {
    const s = this.score;
    const pinned = this.meta.pinnedV;
    const latest = s.versions.at(-1).v;
    const rows = [...s.versions].reverse().map(v => h('button', {
      class: 'li' + ((pinned || latest) === v.v ? ' on' : ''),
      onclick: async () => { sh.close(); store.updateMeta(this.scoreId, { pinnedV: v.v === latest ? null : v.v }); await this.loadSong({}); toast(v.v === latest ? t('חזרה לגרסה האחרונה') : t('מוצגת גרסה {v}', { v: v.v })); },
    }, h('b', {}, t('גרסה {v}', { v: v.v })), h('span', { class: 'muted' }, ' · ' + fmtDateTime(v.date) + ' · ' + t('{n} עמ׳', { n: v.pages || '?' })), v.v === latest ? h('small', { class: 'badge' }, t('אחרונה')) : null));
    const sh = sheet(t('היסטוריית גרסאות'), h('div', {}, h('div', { class: 'list' }, ...rows),
      h('p', { class: 'hint' }, t('כל ייבוא מחדש של שיר נשמר כגרסה. ההערות עוברות לפי מספר תיבה.'))));
  }
  async addBookmark() {
    if (this.mode !== 'page') return toast(t('סימניות זמינות במצב דף'));
    const { promptBox } = await import('./ui.js');
    const label = await promptBox(t('שם לסימניה (למשל: D.S., Coda, פזמון)'), '');
    if (!label) return;
    const bm = [...(this.meta.bookmarks || []), { page: this.engine.currentPage(), label, doc: this.docName() }];
    store.updateMeta(this.scoreId, { bookmarks: bm });
    this.renderBottom();
  }
  bookmarksSheet() {
    const render = () => h('div', { class: 'list' }, ...(this.meta.bookmarks || []).map((b, i) => h('div', { class: 'li' },
      h('span', {}, `${b.label} · ${t('עמ׳ {n}', { n: b.page + 1 })}`),
      btn('trash', t('מחיקה'), () => { const bm = [...this.meta.bookmarks]; bm.splice(i, 1); store.updateMeta(this.scoreId, { bookmarks: bm }); body.replaceChildren(render()); this.renderBottom(); }, 'ghost'))));
    const body = h('div', {}, render());
    sheet(t('סימניות'), body);
  }
  reviewSheet() {
    const n = this.annot.reviewCount();
    const sh = sheet(t('הערות לבדיקה'), h('div', {},
      h('p', {}, t('{n} הערות לא מצאו את התיבה שלהן בגרסה החדשה. הן מסומנות במסגרת אדומה מקווקוות.', { n })),
      h('div', { class: 'row' },
        h('button', { class: 'btn labeled primary', onclick: () => { this.annot.acceptReview(); sh.close(); this.renderBottom(); } }, t('להשאיר במקום')),
        h('button', { class: 'btn labeled danger', onclick: async () => { if (await confirmBox(t('למחוק את ההערות האלה?'), t('מחיקה'), true)) { this.annot.clearReview(); sh.close(); this.renderBottom(); } } }, t('למחוק')))));
  }

  // ---------------------------------------------------------------- pencil
  startPencil() {
    if (this.mode !== 'page') return toast(t('העיפרון זמין במצב דף'));
    this.annot.setEditing(true);
    this.toggleChrome(false);
    this.el.classList.add('pencil');
    this.pencilBar = this.annot.toolbar(() => this.stopPencil());
    this.el.append(this.pencilBar);
  }
  // ---------------------------------------------------------------- note editing
  // on MuseScore's drawing in live mode: the whole score or one part (a combination of parts is a view only)
  async startNoteEdit() {
    if (this.noteEd) return;
    if (this.annot.editing) this.stopPencil();
    let reset = false;
    if (this.partName && this.partName.includes(' + ')) { this.partName = ''; reset = true; toast(t('עורכים את הפרטיטורה או תפקיד אחד; מוצגת הפרטיטורה')); }
    if (this.mode !== 'live' || reset) await this.setMode('live');
    if (this.mode !== 'live' || !this.engine) return;
    this.el.classList.add('noteedit');
    this.toggleChrome(false);
    try {
      this.noteEd = await new ScoreEditor(this).open();
    } catch (e) {
      console.error(e);
      if (this.engine) { this.engine.edit = null; this.engine.onRender = null; }
      this.noteEd = null; this.el.classList.remove('noteedit');
      if (this.engine) this.engine.layout(true);
      return toast(t('לא ניתן לפתוח לעריכה: {msg}', { msg: e.message || e }), 5000);
    }
    toast(t('נוגעים בתו כדי לבחור אותו. N: הזנת תווים'), 3500);
  }
  async stopNoteEdit() {
    if (!this.noteEd || !await this.noteEd.close()) return;
    const saved = this.noteEd.saved;
    this.noteEd = null;
    this.el.classList.remove('noteedit');
    // the song as saved (its newest version), or as it was
    if (saved) await this.loadSong({});
    else if (this.engine) this.engine.layout(true);
  }
  stopPencil() {
    this.annot.setEditing(false);
    this.el.classList.remove('pencil');
    if (this.pencilBar) this.pencilBar.remove();
    this.renderBottom();
  }
}

// ==================================================================== page mode
class PageEngine {
  constructor(v) {
    this.v = v; this.doc = null; this.mpos = null; this.pos = 0; this.cache = new Map(); this.gen = 0;
  }
  source() {
    const s = this.v.score;
    const semis = this.v.semis;
    const ref = store.pdfRef(s, this.v.partName, semis);
    if (!ref) throw new Error(t('לשיר הזה אין PDF'));
    this.transposedMissing = !!semis && !store.pdfKeys(s).includes(semis);
    return { key: ref.pdfKey, loader: () => store.blobBuffer(ref.pdfKey), mpos: ref.layout || null };
  }
  async open() {
    const src = this.source();
    this.src = src;
    this.mpos = src.mpos;
    this.doc = await openPdf(src.key, src.loader);
    this.pos = 0;
  }
  destroy() { this.gen++; this.cache.clear(); }

  spread() {
    const st = store.state.settings; const r = this.v.stage.getBoundingClientRect();
    return st.twoUp && !st.halfPage && r.width > r.height * 1.1 && this.doc.count > 1;
  }
  half() { return store.state.settings.halfPage && !this.spread(); }
  maxPos() {
    const n = this.doc.count;
    if (this.spread()) return Math.ceil(n / 2) - 1;
    if (this.half()) return 2 * (n - 1);
    return n - 1;
  }
  pagesAt(pos) {
    if (this.spread()) return [pos * 2, pos * 2 + 1].filter(i => i < this.doc.count);
    if (this.half()) return pos % 2 === 0 ? [pos / 2] : [(pos + 1) / 2, (pos - 1) / 2]; // [top, bottom]
    return [pos];
  }
  currentPage() { const p = this.pagesAt(this.pos); return this.half() && this.pos % 2 ? p[1] : p[0]; }
  posForPage(i) { return this.spread() ? Math.floor(i / 2) : this.half() ? i * 2 : i; }
  next() { if (this.pos >= this.maxPos()) return false; this.pos++; this.layout(); return true; }
  prev() { if (this.pos <= 0) return false; this.pos--; this.layout(); return true; }
  goEnd() { this.pos = this.maxPos(); this.layout(); }
  go(j) { this.pos = this.posForPage(j.page); this.layout(); }
  // where this screen is in the song: the first measure on the page (and how far through the pages)
  position() {
    if (!this.doc) return null;
    const page = this.currentPage();
    let measure = null;
    if (this.mpos) for (const m of this.mpos.measures) if (m.page === page && (measure == null || m.m < measure)) measure = m.m;
    return { measure, frac: this.doc.count > 1 ? page / (this.doc.count - 1) : 0 };
  }
  // the page that shows a measure (else the same share of the song)
  goMeasure(measure, frac) {
    if (!this.doc) return false;
    let page = null;
    if (measure != null && this.mpos) {
      let best = null;
      for (const m of this.mpos.measures) if (m.m <= measure && (!best || m.m > best.m || (m.m === best.m && m.page < best.page))) best = m;
      if (best) page = best.page;
    }
    if (page == null && frac != null) page = Math.round(frac * (this.doc.count - 1));
    if (page == null) return false;
    const pos = Math.min(this.posForPage(page), this.maxPos());
    // already showing that page (two pages side by side, or half page): stay
    if (this.pagesAt(this.pos).includes(page) || pos === this.pos) return false;
    this.pos = pos; this.layout();
    return true;
  }
  label() {
    if (!this.doc) return '';
    const p = this.pagesAt(this.pos).slice().sort((a, b) => a - b).map(i => i + 1);
    return `${p.join('–')} / ${this.doc.count}`;
  }
  jumps() {
    const out = [];
    const s = this.v.score;
    if (this.mpos) {
      for (const r of s.version.rehearsal || []) {
        // parts with multi-measure rests may not list every measure: take the closest earlier one
        let m = null;
        for (const x of this.mpos.measures) if (x.m <= r.measure && (!m || x.m > m.m)) m = x;
        if (m) out.push({ label: r.label, page: m.page });
      }
    }
    for (const b of this.v.meta.bookmarks || []) if (!b.doc || b.doc === this.v.docName()) out.push({ label: b.label, page: b.page });
    return out;
  }

  async layout(force = false) {
    if (!this.doc) return;
    if (force) this.cache.clear();
    this.pos = Math.min(this.pos, this.maxPos());
    const gen = ++this.gen;
    const stage = this.v.stage;
    const W = stage.clientWidth; const H = stage.clientHeight;
    const pages = this.pagesAt(this.pos);
    const half = this.half() && this.pos % 2 === 1;
    const els = [];
    if (this.spread()) {
      // same note size on both pages: use the smaller of the two fits
      const fits = await Promise.all(pages.map(i => this.fit(i, W / 2, H)));
      const sc = Math.min(...fits);
      for (const i of pages) els.push(await this.pageEl(i, W / 2, H, sc));
    } else {
      for (const i of pages) els.push(await this.pageEl(i, W, H));
    }
    if (gen !== this.gen) return;
    for (const el of els) el.classList.remove('top-half', 'bottom-half');
    const wrap = h('div', { class: 'spread' + (this.spread() ? ' two' : '') + (half ? ' half' : '') });
    if (half) {
      els[0].classList.add('top-half'); els[1].classList.add('bottom-half');
      wrap.append(els[1], els[0], h('div', { class: 'half-line' }));
    } else {
      wrap.append(...els);
    }
    // keep RTL UI from reversing a two-page spread: page order is always left → right
    wrap.dir = 'ltr';
    stage.replaceChildren(wrap);
    for (const el of els) if (el._decorate) el._decorate();
    this.v.updateIndicator(); this.v.renderStrip();
    this.prefetch(W, H);
  }
  async box(i) {
    const full = await this.doc.size(i);
    return store.state.settings.crop ? this.doc.crop(i) : { x: 0, y: 0, w: full.w, h: full.h };
  }
  async fit(i, W, H) {
    const b = await this.box(i);
    return Math.min((W - 16) / b.w, (H - 16) / b.h);
  }
  async pageEl(i, W, H, forceScale) {
    const st = store.state.settings;
    const key = `${i}:${Math.round(W)}x${Math.round(H)}:${st.crop}:${forceScale ? forceScale.toFixed(4) : ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const box = await this.box(i);
    const scale = forceScale || await this.fit(i, W, H);
    const canvas = h('canvas', { class: 'pg-canvas' });
    const el = h('div', { class: 'pg', style: { width: box.w * scale + 'px', height: box.h * scale + 'px' } }, canvas);
    await this.doc.render(i, canvas, box, scale);
    el._decorate = () => { el.querySelectorAll('svg.annot').forEach(x => x.remove()); this.v.annot.decorate(el, i, box); };
    this.cache.set(key, el);
    if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
    return el;
  }
  async prefetch(W, H) {
    // render the next turn ahead of time so the pedal feels instant
    const gen = this.gen;
    if (this.pos < this.maxPos()) {
      await new Promise(r => setTimeout(r, 60));
      if (gen !== this.gen) return;
      const nx = this.pagesAt(this.pos + 1);
      if (this.spread()) {
        const sc = Math.min(...await Promise.all(nx.map(i => this.fit(i, W / 2, H))));
        for (const i of nx) { if (gen !== this.gen) return; await this.pageEl(i, W / 2, H, sc); }
      } else for (const i of nx) { if (gen !== this.gen) return; await this.pageEl(i, W, H); }
    }
  }
}
