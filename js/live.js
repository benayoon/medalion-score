// Live mode: the song engraved on the iPad by MuseScore itself (webmscore), in any key, part or mix of
// parts, so it looks exactly like MuseScore: its fonts, spacing, line and page breaks. Songs that came as
// MusicXML are turned into a MuseScore file first. Playback (a simple synth with a measure cursor, tempo,
// count-in, A–B loop, mute/solo) reads the notes with Verovio, which is never drawn.
import { h, $, $$, icon, btn, toast, sheet, toggle } from './ui.js';
import * as store from './store.js';
import { t } from './i18n.js';
import * as db from './db.js';
import { verovioInterval } from './music.js';
import { audioCtx, countIn } from './metronome.js';
import { readZip, writeZip } from './zip.js';
import { transposeMscx } from './mstranspose.js';
import { xmlToMsFiles, drawMscz, partFiles, fixFonts, fontsOnHand, withScore, patchMscz } from './engrave.js';

let tkP = null;
function toolkit() {
  if (!tkP) {
    tkP = new Promise((resolve, reject) => {
      const ready = () => { try { resolve(new window.verovio.toolkit()); } catch (e) { reject(e); } };
      const s = document.createElement('script');
      s.src = new URL('../vendor/verovio-toolkit-wasm.js', import.meta.url).href;
      s.onload = () => {
        const m = window.verovio.module;
        if (m.calledRun) ready(); else m.onRuntimeInitialized = ready;
      };
      s.onerror = () => reject(new Error(t('Verovio לא נטען')));
      document.head.append(s);
    });
    tkP.catch(() => { tkP = null; });
  }
  return tkP;
}

const SVGNS = 'http://www.w3.org/2000/svg';
// kept while the app is open: reopening a song (or a song again in a setlist) is instant
const SRC = new Map(), FITS = new Map();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class LiveEngine {
  constructor(v) {
    this.v = v; this.mpos = null; this.page = 0; this.pages = []; this.xml = ''; this.parts = [];
    this.concert = false; this.player = null; this.src = new Map(); this.drawn = new Map(); this.boxes = [];
  }
  get scroll() { return store.state.settings.liveScroll; }

  async open() {
    this.v.stage.replaceChildren(h('div', { class: 'busy' }, h('div', { class: 'spinner' }), t('MuseScore מעבד את התווים…')));
    this.xml = await this.loadXml();
    this.parts = readParts(this.xml);
    this.nMeasures = countMeasures(this.xml);
    this.concert = !!this.v.meta.concert;
    await this.render();
  }
  async loadXml() {
    const s = this.v.score;
    return store.loadXml(s);
  }
  partList() { return this.parts.map(p => p.name); }
  selectedParts() {
    const pn = this.v.partName;
    if (!pn) return null;
    const names = pn.split(' + ').map(nameKey);
    const ids = this.parts.filter(p => names.includes(nameKey(p.name))).map(p => p.id);
    return ids.length ? ids : null;
  }

  // MuseScore's PDF layout of what is shown, when the MusicXML alone doesn't say where its lines break:
  // a part picked (its own PDF, even when the score is that one part) -> that part's layout;
  // the whole score without breaks in the MusicXML -> the score's (unless it was one endless line)
  layoutFor(sel, asPart = !!this.v.partName) {
    const ver = (this.v.score || {}).version;
    if (!ver) return null;
    if (sel && sel.length === 1 && asPart) {
      const name = nameKey(this.parts.find(p => p.id === sel[0]).name);
      const p = (ver.parts || []).find(x => nameKey(x.name) === name && x.layout);
      return p ? p.layout : null;
    }
    if (!sel || sel.length === this.parts.length) {
      const b = layoutBreaks(ver.score && ver.score.layout);
      if (b && b.size) return ver.score.layout;
      // no usable PDF layout: the breaks MuseScore wrote into the MusicXML (its import ignores them)
      const x = xmlBreaks(this.xml);
      return x.size ? { breaks: x } : null;
    }
    return null;
  }

  // the MuseScore files of what is shown, in the song's own key: [{ name, text }] (.mscx / .mss)
  async source(sel) {
    // while editing: the editor's file as it is now (the same bytes it saves: stored multi-measure rests left out)
    if (this.edit) return this.msczFiles(this.edit.bytes(), sel);
    const key = this.songKey() + JSON.stringify(sel);
    if (SRC.has(key)) return SRC.get(key);
    const ver = this.v.score.version;
    let files = null;
    // a real MuseScore file: its full score or the part as MuseScore keeps it (own style and breaks)
    if (ver.mscz && (!sel || sel.length === this.parts.length || sel.length === 1)) files = await this.msczFiles(await store.blobBuffer(ver.mscz.key), sel);
    if (!files) {
      // MusicXML: MuseScore's own breaks from the PDF it made, multi-measure rests where it drew them
      const lay = this.layoutFor(sel);
      let breaks = lay ? lay.breaks || layoutBreaks(lay) : null;
      const ms = lay && lay.measures ? [...lay.measures].sort((x, y) => x.m - y.m) : [];
      let mmRests = ms.some((x, i) => i && x.page === ms[i - 1].page && x.x === ms[i - 1].x && x.y === ms[i - 1].y);
      const xml = msXml(this.xml, { parts: sel });
      const keys = concertKeys(xml);
      files = (await xmlToMsFiles(xml)).map(f => {
        if (!/\.mscx$/i.test(f.name)) return f;
        let t = setKeys(f.text, keys);
        // no layout of its own: lines by phrase and section (see autoBreaks), long rests as one measure
        if (!breaks) { breaks = autoBreaks(t); mmRests = true; }
        if (breaks) t = setMsBreaks(t, breaks);
        return { ...f, text: t, fromXml: true };
      });
      files.breaks = breaks; files.mmRests = mmRests;
      // the paper of the PDF shown (parts are often on Letter while the score's MusicXML says A4)
      // (the PDF of the part whose layout is used, matched the same way; never the score's PDF for a part)
      const ver = this.v.score.version;
      const one = sel && sel.length === 1 && this.parts.length > 1 ? nameKey(this.parts.find(p => p.id === sel[0]).name) : null;
      const full = !sel || sel.length === this.parts.length;
      const ref = one ? (ver.parts || []).find(x => nameKey(x.name) === one) : full && ver.score ? ver.score : store.pdfRef(this.v.score, this.v.partName, 0);
      files.paper = ref && ref.pdfKey ? await pdfPaper(ref.pdfKey) : null;
      files.pages = lay && lay.measures && ref ? ref.pages : 0;
    }
    if (SRC.size > 12) SRC.delete(SRC.keys().next().value);
    SRC.set(key, files);
    return files;
  }

  // the .mscx / .mss texts of a MuseScore file for what is shown: the full score, or one part's own file
  async msczFiles(buf, sel) {
    const entries = readZip(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    let zip = null;
    if (sel && sel.length === 1 && this.parts.length > 1) {
      const name = nameKey(this.parts.find(p => p.id === sel[0]).name);
      const pf = (await partFiles(entries)).find(p => nameKey(p.name) === name);
      if (pf) zip = readZip(pf.data.buffer.slice(pf.data.byteOffset, pf.data.byteOffset + pf.data.byteLength));
    }
    const list = zip || entries.filter(e => !/^Excerpts\//.test(e.name));
    const out = [];
    for (const e of list) if (/\.(mscx|mss)$/i.test(e.name)) out.push({ name: e.name, text: new TextDecoder().decode(new Uint8Array(await (await e.blob()).arrayBuffer())) });
    return out.some(f => /\.mscx$/i.test(f.name)) ? out : null;
  }

  // ---------------------------------------------------------------- note editing
  // the song as a MuseScore file to edit: its .mscz, or one made from its MusicXML (score and parts, with the
  // lines and paper of its PDFs, as shown here). Nothing is stored until the editor saves.
  async editableMscz() {
    const s = this.v.score; const ver = s.version;
    if (ver.mscz) return new Uint8Array(await store.blobBuffer(ver.mscz.key));
    const fixFor = async (sel, one) => {
      const lay = this.layoutFor(sel, !!one);
      const breaks = lay ? lay.breaks || layoutBreaks(lay) : null;
      const ms = lay && lay.measures ? [...lay.measures].sort((x, y) => x.m - y.m) : [];
      const mmRests = !breaks || ms.some((x, i) => i && x.page === ms[i - 1].page && x.x === ms[i - 1].x && x.y === ms[i - 1].y);
      const ref = one ? (ver.parts || []).find(x => nameKey(x.name) === one) : ver.score;
      return { breaks, auto: !breaks, mmRests, paper: ref && ref.pdfKey ? await pdfPaper(ref.pdfKey) : null };
    };
    const score = await fixFor(null, null);
    const parts = new Map();
    if (this.parts.length > 1) for (const p of this.parts) parts.set(nameKey(p.name), await fixFor([p.id], nameKey(p.name)));
    return xmlToEditable(this.xml, { title: s.title, composer: s.composer, score, part: name => parts.get(nameKey(name)) || null });
  }

  songKey() { const s = this.v.score || {}; const v = s.version || {}; return `${s.id}:${(v.xml && v.xml.key) || ''}:${(v.mscz && v.mscz.key) || ''}:`; }

  // what the drawing depends on: a change here engraves again; anything else (screen size, rotation,
  // two pages, scrolling) only fits the same pages to the screen
  renderKey() {
    const st = store.state.settings;
    // (while editing: the file's own key, written pitch, each edit a new drawing)
    return JSON.stringify([this.edit ? 0 : this.v.semis, this.edit ? 'edit' : this.concert, this.selectedParts(), st.liveLyrics, st.liveAllMeasureNumbers, st.liveBigChords, this.edit ? this.edit.rev : null]);
  }

  async draw() {
    const key = this.renderKey();
    if (this.drawn.has(key)) return this.drawn.get(key);
    const st = store.state.settings;
    const s = this.v.score || {};
    const sel = this.selectedParts();
    const files = await this.source(sel);
    const all = files.some(f => /\.mss$/i.test(f.name)) ? files
      : [{ name: 'score_style.mss', text: '<?xml version="1.0" encoding="UTF-8"?>\n<museScore version="4.70">\n  <Style>\n    </Style>\n  </museScore>\n' }, ...files];
    const have = await fontsOnHand();
    const edit = this.edit;
    const make = fit => {
      const out = all.map(f => {
        let t = fixFonts(f.text, have);
        if (/\.mscx$/i.test(f.name)) {
          // MuseScore shows a key's written form (actualKey) whenever the file has one, also in concert pitch
          if (this.concert && !edit) t = t.replace(/\s*<actualKey>-?\d+<\/actualKey>/g, '');
          if (this.v.semis && !edit) t = transposeMscx(t, this.v.semis);
          t = fixSlashes(t);
          if (!st.liveLyrics) t = t.replace(/<Lyrics>[\s\S]*?<\/Lyrics>\s*/g, '');
          if (f.fromXml) t = setMsTitle(t, s.title, s.composer);
        } else {
          t = setStyle(t, 'concertPitch', this.concert && !edit ? 1 : 0);
          if (files.mmRests) t = setStyle(t, 'createMultiMeasureRests', 1);
          // editing: every measure and every staff drawn, so each can be tapped
          if (edit) { t = setStyle(t, 'createMultiMeasureRests', 0); t = setStyle(t, 'hideEmptyStaves', 0); }
          // one part, as in its PDF: no "Piano / Pno." in front of every line
          if (files.some(f => f.fromXml) && sel && sel.length === 1) t = setStyle(t, 'hideInstrumentNameIfOneInstrument', 1);
          if (fit.density) t = setStyle(t, 'spacingDensity', fit.density);
          if (fit.spatium) t = setStyle(t, 'spatium', fit.spatium);
          if (files.paper) t = setPaper(t, files.paper);
          if (st.liveAllMeasureNumbers) { t = setStyle(t, 'measureNumberInterval', 1); t = setStyle(t, 'measureNumberSystem', 0); t = setStyle(t, 'showMeasureNumberOne', 1); }
          if (st.liveBigChords) { t = setStyle(t, 'chordSymbolAFontSize', 15); t = setStyle(t, 'chordSymbolBFontSize', 15); }
        }
        return { name: f.name, data: t };
      });
      const container = '<?xml version="1.0" encoding="UTF-8"?>\n<container>\n  <rootfiles>\n'
        + out.map(f => `    <rootfile full-path="${esc(f.name)}"/>\n`).join('') + '    </rootfiles>\n  </container>\n';
      return writeZip([...out.filter(f => /\.mss$/i.test(f.name)), ...out.filter(f => /\.mscx$/i.test(f.name)), { name: 'META-INF/container.xml', data: container }]);
    };
    // the PDF's lines are kept: when its measures don't fit a line at MuseScore's default spacing (the
    // part had its own, tighter style), the spacing is tightened step by step, and if that is not enough
    // the staff is made a little smaller, until they do
    const sk = this.songKey() + JSON.stringify(sel);
    this.fits = FITS;
    const steps = [{}, { density: 1.3 }, { density: 1.7 }, { density: 2.2 }, { density: 3 }];
    const sp = +((all.find(f => /\.mss$/i.test(f.name)).text.match(/<spatium>([\d.]+)</) || [])[1] || 1.75);
    for (const k of [0.95, 0.9, 0.86, 0.82, 0.78]) steps.push({ density: 3, spatium: Math.round(sp * k * 1000) / 1000 });
    let i = files.breaks ? (this.fits.get(sk) || 0) : 0;
    const nm = edit ? edit.measures() : this.nMeasures;
    let r = await drawMscz(make(steps[i]), nm, { segments: !!edit });
    if (files.breaks) {
      const want = new Set([0, ...files.breaks.keys()]);
      const extra = x => (files.pages && x.svgs.length > files.pages)
        || x.boxes.some((b, j, a) => j && (b.y !== a[j - 1].y || b.page !== a[j - 1].page) && b.m !== a[j - 1].m && !want.has(b.m));
      while (extra(r) && i < steps.length - 1) r = await drawMscz(make(steps[++i]), nm, { segments: !!edit });
      this.fits.set(sk, i);
    }
    this.fit = steps[i];
    if (this.drawn.size > 6) this.drawn.delete(this.drawn.keys().next().value);
    this.drawn.set(key, r);
    return r;
  }

  // the pages exactly as MuseScore engraves them; the screen only decides how big they are shown
  async render() {
    const key = this.renderKey();
    let r;
    try { r = await this.draw(); } catch (e) { this.v.stage.replaceChildren(h('div', { class: 'busy' }, t('MuseScore לא הצליח לעבד את השיר: {err}', { err: e.message || e }))); throw e; }
    // something changed meanwhile: drawn again for what is asked now (a render already on its way finds it cached)
    if (key !== this.renderKey()) return this.render();
    this.pages = [];
    const wrap = h('div', { class: 'live-wrap measuring' });
    wrap.dir = 'ltr';
    for (const svg of r.svgs) {
      const page = h('div', { class: 'live-page', html: svg.replace(/^<\?xml[^>]*>\s*/, '') });
      const el = page.querySelector('svg');
      el.removeAttribute('width'); el.removeAttribute('height');
      el.querySelector('title')?.remove();
      this.pages.push(page); wrap.append(page);
    }
    this.boxes = r.boxes; this.segs = r.segs || null;
    const scrollTop = this.v.stage.scrollTop;
    this.v.stage.replaceChildren(wrap);
    this.wrap = wrap;
    this.key = key;
    this.measureCrop();
    wrap.classList.remove('measuring');
    this.fitPages();
    this.page = Math.max(0, Math.min(this.page, this.pages.length - 1));
    this.show();
    if (this.scroll) this.v.stage.scrollTop = scrollTop;
    if (this.onRender) this.onRender();
  }
  // trimmed margins (the "crop" setting, as in page mode): one box around what MuseScore drew on every
  // page, so all pages keep one size
  measureCrop() {
    const svgs = this.pages.map(p => p.querySelector(':scope > svg')).filter(Boolean);
    if (!svgs.length) return;
    const vb = svgs[0].viewBox.baseVal; const W = vb.width, H = vb.height;
    let box = { x0: 0, y0: 0, x1: W, y1: H };
    if (store.state.settings.crop) {
      box = { x0: W, y0: H, x1: 0, y1: 0 };
      for (const svg of svgs) {
        for (const g of svg.children) {
          if (g.tagName === 'title' || g.tagName === 'desc' || g.getAttribute('fill') === '#ffffff') continue;   // the white page
          let b; try { b = g.getBBox(); } catch { continue; }
          if (!b.width && !b.height) continue;
          box.x0 = Math.min(box.x0, b.x); box.y0 = Math.min(box.y0, b.y);
          box.x1 = Math.max(box.x1, b.x + b.width); box.y1 = Math.max(box.y1, b.y + b.height);
        }
      }
      const pad = W * 0.03;
      box = { x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(W, box.x1 + pad), y1: Math.min(H, box.y1 + pad) };
      if (box.x1 <= box.x0 || box.y1 <= box.y0) box = { x0: 0, y0: 0, x1: W, y1: H };
    }
    this.crop = box;
    for (const svg of svgs) svg.setAttribute('viewBox', `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
  }
  // pages per screen: two side by side when the screen is wide (as in page mode), else one
  perScreen() {
    const st = store.state.settings; const r = this.v.stage.getBoundingClientRect();
    return !this.scroll && st.twoUp && !st.halfPage && r.width > r.height * 1.1 && this.pages.length > 1 ? 2 : 1;
  }
  fitPages() {
    if (!this.wrap || !this.crop) return;
    const stage = this.v.stage; const cs = getComputedStyle(stage);
    const W = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (W < 50 || H < 50) return;
    const n = this.perScreen(); const gap = n > 1 ? 8 : 0;
    const cw = this.crop.x1 - this.crop.x0, ch = this.crop.y1 - this.crop.y0;
    const k = this.scroll ? W / cw : Math.min((W - gap) / n / cw, H / ch);
    this.k = k;
    this.wrap.classList.toggle('scroll', !!this.scroll);
    this.wrap.classList.toggle('two', n > 1);
    for (const p of this.pages) {
      const svg = p.querySelector(':scope > svg'); if (!svg) continue;
      Object.assign(svg.style, { width: Math.floor(cw * k) + 'px', height: Math.floor(ch * k) + 'px', maxWidth: 'none' });
    }
    if (n > 1) this.page -= this.page % 2;
  }
  show() {
    if (this.scroll) { this.pages.forEach(p => p.classList.add('on')); this.v.updateIndicator(); return; }
    const n = this.perScreen();
    this.pages.forEach((p, i) => p.classList.toggle('on', i >= this.page && i < this.page + n));
    this.v.updateIndicator(); this.v.renderStrip();
  }
  layout(force) {
    if (!this.wrap && !force) return;
    if (!force && this.wrap && this.key === this.renderKey()) { this.fitPages(); this.show(); return; }
    const m = this.firstMeasureOnPage();
    if (force) this.drawn.clear();
    this.render().then(() => { if (m != null) this.goToMeasureId(m); }).catch(e => console.warn('live', e));
  }
  destroy() { if (this.player) this.player.stop(); }

  // measures are addressed by index (0 = the first measure of the song)
  firstMeasureOnPage() {
    if (!this.boxes.length) return null;
    if (this.scroll) {
      const top = this.v.stage.getBoundingClientRect().top;
      for (const b of this.boxes) { const r = this.boxRect(b); if (r && r.bottom > top + 10) return b.m; }
      return null;
    }
    const b = this.boxes.find(x => x.page >= this.page);
    return b ? b.m : null;
  }
  boxRect(b) {
    const svg = this.pages[b.page] && this.pages[b.page].querySelector(':scope > svg');
    if (!svg || !this.crop) return null;
    const r = svg.getBoundingClientRect(); const k = r.width / (this.crop.x1 - this.crop.x0);
    return { top: r.top + (b.y - this.crop.y0) * k, bottom: r.top + (b.y + b.h - this.crop.y0) * k };
  }
  goToMeasureId(m) {
    const b = this.boxes.find(x => x.m === m);
    if (!b) return;
    if (this.scroll) { const svg = this.pages[b.page].querySelector('svg'); const r = this.boxRect(b); const st = this.v.stage; st.scrollTop += r.top - st.getBoundingClientRect().top - 10; return; }
    this.page = b.page - (b.page % this.perScreen()); this.show();
  }
  // the cursor of playback: the measure that sounds
  mark(m) {
    for (const x of $$('.live-cursor', this.wrap || document)) x.parentNode.removeChild(x);
    const b = m == null ? null : this.boxes.find(x => x.m === m);
    if (!b) return null;
    const svg = this.pages[b.page].querySelector(':scope > svg');
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('class', 'live-cursor');
    const pad = b.h * 0.25;
    Object.entries({ x: b.x, y: b.y - pad, width: b.w, height: b.h + pad * 2, rx: 30 }).forEach(([k, v]) => r.setAttribute(k, v));
    const bg = [...svg.children].find(x => x.getAttribute('fill') === '#ffffff');   // above the white page, under the music
    svg.insertBefore(r, bg ? bg.nextSibling : svg.firstChild);
    return b;
  }

  next() {
    if (this.scroll) { this.v.stage.scrollBy({ top: this.v.stage.clientHeight * 0.85, behavior: 'smooth' }); return true; }
    const n = this.perScreen();
    if (this.page + n > this.pages.length - 1) return false;
    this.page += n; this.show(); return true;
  }
  prev() {
    if (this.scroll) { this.v.stage.scrollBy({ top: -this.v.stage.clientHeight * 0.85, behavior: 'smooth' }); return true; }
    if (this.page <= 0) return false;
    this.page = Math.max(0, this.page - this.perScreen()); this.show(); return true;
  }
  goEnd() { const n = this.perScreen(); this.page = Math.max(0, this.pages.length - 1 - ((this.pages.length - 1) % n)); this.show(); if (this.scroll) this.v.stage.scrollTop = 1e9; }
  go(j) { this.goToMeasureId(j.measureId); }
  label() {
    if (this.scroll) return t('גלילה');
    const n = Math.min(this.perScreen(), this.pages.length - this.page);
    return `${n > 1 ? `${this.page + 1}–${this.page + n}` : this.page + 1} / ${this.pages.length || 1}`;
  }
  jumps() {
    if (!this.wrap) return [];
    return rehearsals(this.xml).filter(j => this.boxes.some(b => b.m === j.measureId));
  }

  // ---------------------------------------------------------------- display + parts UI
  displayControls() {
    const st = store.state.settings;
    const rer = () => this.layout();
    return [
      h('p', { class: 'hint' }, t('מצב חי מצויר על ידי MuseScore עצמו, בדיוק כמו בתוכנה: גופנים, מרווחים, שורות ועמודים. המסך רק מקטין או מגדיל את העמוד כולו.')),
      toggle(t('גלילה רציפה במקום עמודים'), st.liveScroll, v => { store.setSetting('liveScroll', v); rer(); }),
      toggle(t('אקורדים מוגדלים'), st.liveBigChords, v => { store.setSetting('liveBigChords', v); rer(); }),
      toggle(t('הצגת מילים'), st.liveLyrics, v => { store.setSetting('liveLyrics', v); rer(); }),
      toggle(t('מספר בכל תיבה'), st.liveAllMeasureNumbers, v => { store.setSetting('liveAllMeasureNumbers', v); rer(); }),
      toggle(t('צליל קונצרט (בלי כלים מעתיקים)'), this.concert, v => { this.concert = v; store.updateMeta(this.v.scoreId, { concert: v }); rer(); }),
      h('p', { class: 'hint' }, t('במצב חי הסקסופון והחצוצרה רואים את הפרט שלהם ב-E♭/B♭ אוטומטית, אלא אם בוחרים צליל קונצרט.')),
    ];
  }
  comboPicker(close) {
    const chosen = new Set((this.v.partName || '').split(' + ').filter(Boolean));
    const boxes = this.parts.map(p => {
      const cb = h('input', { type: 'checkbox', class: 'switch' }); cb.checked = chosen.has(p.name);
      cb.onchange = () => { cb.checked ? chosen.add(p.name) : chosen.delete(p.name); };
      return h('label', { class: 'field toggle' }, h('span', { dir: 'auto' }, p.name), cb);
    });
    return h('div', { class: 'combo' }, h('h4', {}, t('צירוף שורות (למשל קלידים + בס)')), ...boxes,
      h('button', { class: 'btn labeled primary', onclick: () => { close(); this.v.partName = [...chosen].join(' + '); this.v.setMode('live'); } }, t('הצגת הצירוף')));
  }

  // ---------------------------------------------------------------- playback
  // Verovio reads the notes (never drawn): written-out measure repeats, the key and parts on screen
  async playToolkit() {
    const st = store.state.settings;
    const key = JSON.stringify([this.v.semis, this.concert, this.selectedParts()]);
    if (this._ptk && this._ptkKey === key) return this._ptk;
    const tk = this._ptk || await toolkit();
    const xml = prepareXml(this.xml, { parts: this.selectedParts() });
    tk.setOptions({ header: 'none', footer: 'none', breaks: 'none', transpose: verovioInterval(this.v.semis), transposeToSoundingPitch: this.concert });
    if (!tk.loadData(xml)) throw new Error(t('לא ניתן לקרוא את התווים לניגון'));
    // Verovio's measure ids in order: measure index
    this.measureIndex = new Map([...tk.getMEI().matchAll(/<measure\b[^>]*?xml:id="([^"]+)"/g)].map((x, i) => [x[1], i]));
    this._ptk = tk; this._ptkKey = key;
    return tk;
  }
  async playSheet() {
    try { await this.playToolkit(); } catch (e) { toast(e.message || t('הניגון לא נטען')); return; }
    if (!this.player) this.player = new Player(this);
    this.player.sheet();
  }
}

// MusicXML for MuseScore to read: the parts shown, the marks of the whole score on them, slashes without
// accidentals, and MuseScore's line breaks of what is shown
export function msXml(xml, { parts }) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  // a score saved in concert pitch is exported in concert pitch, and MuseScore's import would read those
  // notes as written: the B♭ trumpet would see the concert key. Written pitch, as the parts are printed
  toWrittenPitch(d);
  d.querySelectorAll('defaults > concert-score').forEach(e => e.parentNode.removeChild(e));
  if (parts) {
    const keep = new Set(parts);
    systemTexts(d, keep);
    d.querySelectorAll('part-list > score-part').forEach(sp => { if (!keep.has(sp.getAttribute('id'))) sp.parentNode.removeChild(sp); });
    d.querySelectorAll('part-list > part-group').forEach(g => g.parentNode.removeChild(g));
    d.querySelectorAll('score-partwise > part').forEach(p => { if (!keep.has(p.getAttribute('id'))) p.parentNode.removeChild(p); });
  }
  slashesInKey(d);
  // MuseScore exports one "word font" for the whole score, and its import puts it on every text style
  // (titles, tempo, chords…), which is not how the file looked: MuseScore's own text styles instead
  d.querySelectorAll('defaults > word-font').forEach(e => e.parentNode.removeChild(e));
  return new XMLSerializer().serializeToString(d);
}
// MuseScore exports a slash as a B, with a natural sign when the key has B♭: written in the key it has none
function slashesInKey(d) {
  const ORDER = 'FCGDAEB';
  for (const part of d.querySelectorAll('score-partwise > part')) {
    let fifths = 0;
    for (const m of part.querySelectorAll(':scope > measure')) {
      for (const c of m.children) {
        if (c.tagName === 'attributes') { const f = c.querySelector('key > fifths'); if (f) fifths = +f.textContent || 0; continue; }
        if (c.tagName !== 'note' || (c.querySelector('notehead') || {}).textContent !== 'slash') continue;
        const step = c.querySelector('pitch > step'); if (!step) continue;
        const i = ORDER.indexOf(step.textContent.trim());
        const alter = fifths > 0 && i < fifths ? 1 : fifths < 0 && i >= 7 + fifths ? -1 : 0;
        let al = c.querySelector('pitch > alter');
        if (alter) { if (!al) { al = d.createElement('alter'); step.after(al); } al.textContent = alter; } else if (al) al.parentNode.removeChild(al);
        c.querySelectorAll('accidental').forEach(a => a.parentNode.removeChild(a));
      }
    }
  }
}
// MuseScore keeps a key as its concert key, and its MusicXML import leaves a transposing part written in
// C with no key at all (so another key or concert pitch shows accidentals): per staff, the concert key
// to add (null: nothing to add)
function concertKeys(xml) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const out = [];
  for (const part of d.querySelectorAll('score-partwise > part')) {
    const at = part.querySelector(':scope > measure > attributes');
    const staves = +((part.querySelector('attributes > staves') || {}).textContent || 1) || 1;
    const f = part.querySelector('attributes > key > fifths');
    const chrom = +((part.querySelector('attributes > transpose > chromatic') || {}).textContent || 0);
    let k = null;
    if (at && (!f || +f.textContent === 0) && chrom % 12) { k = ((7 * chrom) % 12 + 12) % 12; if (k > 6) k -= 12; }
    for (let i = 0; i < staves; i++) out.push(k);
  }
  return out;
}
function setKeys(t, keys) {
  keys.forEach((k, i) => {
    if (k == null || !k) return;
    const a = t.indexOf(`<Staff id="${i + 1}">`); if (a < 0) return;
    const m = t.indexOf('<voice>', t.indexOf('<Measure', a)); if (m < 0) return;
    const end = t.indexOf('</voice>', m);
    const voice = t.slice(m, end);
    if (/<KeySig>/.test(voice.slice(0, (voice.search(/<(Chord|Rest)>/) + 1 || voice.length + 1) - 1))) return;
    // the written key (C, as the MusicXML had it) goes in too: MuseScore shows it when it is there, so
    // for concert pitch it is taken out again (see draw)
    const ks = `\n          <KeySig>\n            <concertKey>${k}</concertKey>\n            <actualKey>0</actualKey>\n            </KeySig>`;
    const ts = voice.indexOf('<TimeSig>');
    const ce = voice.indexOf('</Clef>');
    const at = ts >= 0 && (ce < 0 || ts < voice.search(/<(Chord|Rest)>/)) ? m + ts : ce >= 0 ? m + ce + '</Clef>'.length : m + '<voice>'.length;
    t = t.slice(0, at) + ks + t.slice(at);
  });
  return t;
}
// slashes (rhythm / "fill with slashes") stay on the middle line as MuseScore draws them, whatever the key,
// transposition or concert pitch: a MusicXML brings them as notes at some pitch, which would move with it
function fixSlashes(t) {
  return t.replace(/<Note>((?:(?!<\/Note>)[\s\S])*?<head>slash<\/head>(?:(?!<\/Note>)[\s\S])*?)<\/Note>/g,
    (m, b) => /<fixed>/.test(b) ? m : `<Note>${b}<fixed>1</fixed>\n          <fixedLine>4</fixedLine>\n          </Note>`);
}
// MuseScore's line / page breaks (first measure index -> 'system' | 'page') in a .mscx text: a break
// belongs to the measure before, in the first staff
function setMsBreaks(t, breaks) {
  t = t.replace(/<LayoutBreak>(?:(?!<\/LayoutBreak>)[\s\S])*?<subtype>(?:line|page)<\/subtype>[\s\S]*?<\/LayoutBreak>\s*/g, '');
  const a = t.indexOf('<Staff id="1">'); if (a < 0) return t;
  const b = t.indexOf('</Staff>', a);
  let i = -1;
  // a multi-measure rest MuseScore keeps in the file is a <Measure> of its own, not a bar: not counted
  const staff = t.slice(a, b).replace(/<Measure(\s[^>]*)?>/g, (tag, _, at, all) => {
    if (/^\s*<multiMeasureRest>/.test(all.slice(at + tag.length, at + tag.length + 80))) return tag;
    i++;
    const br = breaks.get(i + 1);
    return br ? `${tag}\n        <LayoutBreak>\n          <subtype>${br === 'page' ? 'page' : 'line'}</subtype>\n          </LayoutBreak>` : tag;
  });
  return t.slice(0, a) + staff + t.slice(b);
}
// lines for a song that has no layout of its own (no PDF layout, no breaks in its MusicXML, or a mix of
// parts): 4 measures a line, 8 when all 8 are light (slashes, few notes and chords); every section
// (rehearsal mark) starts a line; a long rest (2+ empty measures, drawn as one multi-measure rest) has a
// line of its own, unless the line before it is short, then it joins that line; a line of 1-2 measures
// left at the end of a section joins the line before it. Returns first measure index -> 'system'.
export function autoBreaks(t) {
  const staves = [];
  for (const m of t.matchAll(/<Staff id="\d+">/g)) {
    const end = t.indexOf('</Staff>', m.index);
    const body = t.slice(m.index, end);
    if (body.includes('<Measure')) staves.push(body.split(/<Measure(?=[\s>])/).slice(1));
  }
  if (!staves.length) return new Map();
  const n = Math.min(...staves.map(s => s.length));
  const info = [];
  for (let i = 0; i < n; i++) {
    let notes = 0, chords = 0, mark = false, empty = true;
    for (const s of staves) {
      const m = s[i];
      const real = (m.match(/<Chord>(?:(?!<\/Chord>)[\s\S])*?<\/Chord>/g) || []).filter(c => !c.includes('<head>slash</head>')).length;
      const slashes = (m.match(/<head>slash<\/head>/g) || []).length;
      const harm = (m.match(/<Harmony>/g) || []).length;
      notes = Math.max(notes, real); chords = Math.max(chords, harm);
      if (m.includes('<RehearsalMark>')) mark = true;
      if (real || slashes || harm || /<(Tempo|StaffText|SystemText|Dynamic)>/.test(m)) empty = false;
    }
    info.push({ light: notes <= 4 && chords <= 2, mark, empty, pickup: i === 0 && /^\s[^>]*len=/.test(staves[0][0]) });
  }
  // sections, each a list of units: a long rest [i..j] or one measure
  const sections = [];
  for (let i = 0; i < n;) {
    if (!sections.length || info[i].mark) sections.push([]);
    const sec = sections[sections.length - 1];
    let j = i;
    while (j + 1 < n && info[i].empty && info[j + 1].empty && !info[j + 1].mark) j++;
    sec.push(j > i ? { rest: true, from: i, to: j } : { from: i, to: i });
    i = j + 1;
  }
  const lines = [];
  for (const sec of sections) {
    const out = [];   // lines of this section: { rest, units: [] }
    let k = 0;
    while (k < sec.length) {
      if (sec[k].rest) {
        const prev = out[out.length - 1];
        if (prev && !prev.rest && prev.units.length < 4) prev.units.push(sec[k]);
        else out.push({ rest: true, units: [sec[k]] });
        k++; continue;
      }
      let run = 0;
      while (k + run < sec.length && !sec[k + run].rest) run++;
      const units = sec.slice(k, k + run);
      for (let a = 0; a < units.length;) {
        const count = u => u.filter(x => !info[x.from].pickup).length;
        let take = Math.min(4, units.length - a);
        const eight = units.slice(a, a + 8);
        if (eight.length === 8 && eight.every(x => info[x.from].light)) take = 8;
        while (take < units.length - a && count(units.slice(a, a + take)) < Math.min(take, 4) && take < 9) take++;
        out.push({ units: units.slice(a, a + take) });
        a += take;
      }
      k += run;
    }
    // a short line at the end of the section joins the one before (an 8 is split 4 + 4+short)
    const last = out[out.length - 1], before = out[out.length - 2];
    if (last && before && !last.rest && !before.rest && last.units.length <= 2) {
      if (before.units.length >= 8) { const half = before.units.splice(4); last.units = [...half, ...last.units]; }
      else { before.units.push(...last.units); out.pop(); }
    }
    lines.push(...out);
  }
  const br = new Map();
  for (const l of lines) if (l.units[0].from) br.set(l.units[0].from, 'system');
  return br;
}
// the line / page breaks in a MusicXML (first measure index -> 'system' | 'page')
function xmlBreaks(xml) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const part = d.querySelector('score-partwise > part');
  const br = new Map();
  if (!part) return br;
  [...part.querySelectorAll(':scope > measure')].forEach((m, i) => {
    const pr = m.querySelector(':scope > print');
    if (!i || !pr) return;
    if (pr.getAttribute('new-page') === 'yes') br.set(i, 'page');
    else if (pr.getAttribute('new-system') === 'yes') br.set(i, 'system');
  });
  return br;
}
// the page size of a PDF (inches), when it is a page and not one endless strip
const papers = new Map();
async function pdfPaper(key) {
  if (papers.has(key)) return papers.get(key);
  let r = null;
  try {
    const b = await db.getBlob(key);
    const u = new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b);
    const m = new TextDecoder('latin1').decode(u.subarray(0, Math.min(u.length, 600000))).match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (m) { const w = (m[3] - m[1]) / 72, h = (m[4] - m[2]) / 72; if (w > 3 && h > w * 0.9 && w < 14) r = { w, h }; }
  } catch { /* no PDF: MuseScore's paper from the MusicXML */ }
  papers.set(key, r);
  return r;
}
// a paper size in a .mss text, keeping its margins
function setPaper(t, { w, h }) {
  const get = (n, d) => +((t.match(new RegExp(`<${n}>([\\d.]+)<`)) || [])[1] || d);
  const W = get('pageWidth', 8.27), L = get('pageOddLeftMargin', 0.5906), P = get('pagePrintableWidth', W - 2 * L);
  const R = Math.max(0, W - L - P);
  t = setStyle(t, 'pageWidth', w.toFixed(4)); t = setStyle(t, 'pageHeight', h.toFixed(4));
  return setStyle(t, 'pagePrintableWidth', Math.max(1, w - L - R).toFixed(4));
}
// a style value in a .mscx / .mss text
export function setStyle(t, name, value) {
  const re = new RegExp(`<${name}>[^<]*</${name}>`);
  if (re.test(t)) return t.replace(re, `<${name}>${value}</${name}>`);
  if (/<Style>/.test(t)) return t.replace('<Style>', `<Style>\n      <${name}>${value}</${name}>`);
  if (/<Score>/.test(t)) return t.replace('<Score>', `<Score>\n    <Style>\n      <${name}>${value}</${name}>\n      </Style>`);
  return t;
}
// the title frame as the file has it; only MuseScore's placeholders for a missing title / composer /
// subtitle (the MusicXML had none) become the library's title and composer, or nothing
function setMsTitle(t, title, composer) {
  const PH = { title: 'Untitled score', composer: 'Composer / arranger', subtitle: 'Subtitle', lyricist: 'Lyricist' };
  const val = { title: title || '', composer: composer || '', subtitle: '', lyricist: '' };
  for (const [style, ph] of Object.entries(PH)) {
    const re = new RegExp(`(<style>${style}</style>\\s*<text>)${ph.replace(/[/]/g, '\\/')}(</text>)`);
    t = t.replace(re, `$1${esc(val[style])}$2`);
  }
  return t;
}
function countMeasures(xml) {
  const p = (xml.match(/<part\s[\s\S]*?<\/part>/) || [''])[0];
  return (p.match(/<measure[\s>]/g) || []).length;
}
// rehearsal letters of the song: { label, measureId: measure index }
function rehearsals(xml) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const part = d.querySelector('score-partwise > part');
  if (!part) return [];
  const out = [];
  [...part.querySelectorAll(':scope > measure')].forEach((m, i) => {
    for (const r of m.querySelectorAll('direction rehearsal')) { const t = r.textContent.trim(); if (t) out.push({ label: t, measureId: i }); }
  });
  return out;
}

// ==================================================================== playback engine
class Player {
  constructor(eng) {
    this.e = eng; this.playing = false; this.rate = 1; this.muted = new Set(); this.solo = new Set();
    this.loopA = null; this.loopB = null; this.nodes = []; this.timers = [];
  }
  prepare() {
    const tk = this.e._ptk;
    if (this.tk === tk && this.key === this.e._ptkKey) return;
    this.tk = tk; this.key = this.e._ptkKey;
    this.timemap = tk.renderToTimemap({ includeMeasures: true, includeRests: false });
    this.notes = parseMidi(base64ToBytes(tk.renderToMIDI()));
    const idx = this.e.measureIndex;
    // the measures as they sound (repeats played again): their index on the page
    this.timemap = this.timemap.filter(t => t.measureOn).map(t => ({ m: idx.get(t.measureOn), tstamp: t.tstamp }));
    this.measureStarts = this.timemap.map(t => ({ m: t.m, t: t.tstamp }));
    // MIDI track → part: tracks with notes follow the staff order
    const staves = []; for (const p of this.e.parts.filter(p => !this.e.selectedParts() || this.e.selectedParts().includes(p.id))) for (let i = 0; i < p.staves; i++) staves.push(p.name);
    const tracks = [...new Set(this.notes.map(n => n.track))].sort((a, b) => a - b);
    this.trackPart = {};
    if (tracks.length === staves.length) tracks.forEach((t, i) => { this.trackPart[t] = staves[i]; });
  }
  partsInPlay() { return [...new Set(Object.values(this.trackPart))]; }
  audible(n) {
    const p = this.trackPart[n.track];
    if (!p) return true;
    if (this.solo.size) return this.solo.has(p);
    return !this.muted.has(p);
  }
  startMs() {
    if (this.loopA != null) return this.measureStarts[this.loopA]?.t ?? 0;
    const id = this.e.firstMeasureOnPage();
    const m = this.measureStarts.find(x => x.m === id);
    return m ? m.t : 0;
  }
  endMs() {
    if (this.loopB != null && this.measureStarts[this.loopB + 1]) return this.measureStarts[this.loopB + 1].t;
    return Infinity;
  }
  async play() {
    if (this.playing) return;
    this.prepare();
    const ctx = audioCtx();
    this.playing = true; this.onState && this.onState();
    const score = this.e.v.score;
    if (store.state.settings.countIn) {
      await countIn((score.tempo || 100) * this.rate, parseInt(score.timesig) || 4, 1, b => this.e.v.blink(b === 0));
      if (!this.playing) return;
    }
    const from = this.startMs(); const to = this.endMs();
    const t0 = ctx.currentTime + 0.05;
    const at = ms => t0 + (ms - from) / 1000 / this.rate;
    this.runEnd = Math.min(to, Math.max(...this.notes.map(n => n.t + n.d), 0));
    // schedule notes in look-ahead chunks
    const queue = this.notes.filter(n => n.t >= from && n.t < to && this.audible(n));
    let qi = 0;
    const pump = () => {
      const horizon = ctx.currentTime + 0.4;
      while (qi < queue.length && at(queue[qi].t) < horizon) {
        const n = queue[qi++];
        const dur = Math.min(n.d, to - n.t) / 1000 / this.rate;
        this.nodes.push(voice(ctx, at(n.t), Math.max(0.05, dur), n));
      }
    };
    pump();
    this.timers.push(setInterval(pump, 100));
    // cursor
    const marks = this.timemap.filter(t => t.tstamp >= from && t.tstamp < to);
    for (const m of marks) {
      const delay = (at(m.tstamp) - ctx.currentTime) * 1000;
      this.timers.push(setTimeout(() => this.cursor(m), Math.max(0, delay)));
    }
    const endDelay = (at(Math.min(to, this.runEnd)) - ctx.currentTime) * 1000 + 150;
    this.timers.push(setTimeout(() => {
      if (!this.playing) return;
      if (this.loopA != null && this.loopB != null) { this.stop(true); this.play(); } else this.stop();
    }, endDelay));
  }
  cursor(m) {
    if (!this.e.wrap) return;
    const b = this.e.mark(m.m);
    if (!b) return;
    // follow the cursor: turn the page / keep it in view
    if (this.e.scroll) {
      const r = this.e.boxRect(b); const sr = this.e.v.stage.getBoundingClientRect();
      if (r && (r.bottom > sr.bottom - 60 || r.top < sr.top)) this.e.v.stage.scrollBy({ top: r.top - sr.top - 20, behavior: 'smooth' });
    } else {
      const n = this.e.perScreen();
      if (b.page < this.e.page || b.page >= this.e.page + n) { this.e.page = b.page - (b.page % n); this.e.show(); }
    }
  }
  stop(keepLoop) {
    this.playing = false;
    this.timers.forEach(t => { clearTimeout(t); clearInterval(t); }); this.timers = [];
    const ctx = audioCtx();
    for (const n of this.nodes) { try { n.gain.gain.cancelScheduledValues(ctx.currentTime); n.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02); n.osc.stop(ctx.currentTime + 0.1); } catch { /* ended */ } }
    this.nodes = [];
    this.e.mark(null);
    this.onState && this.onState();
  }

  sheet() {
    this.prepare();
    const playB = h('button', { class: 'btn labeled primary big' });
    const paint = () => { playB.replaceChildren(icon(this.playing ? 'pause' : 'play'), this.playing ? t('עצירה') : t('ניגון מהעמוד הנוכחי')); };
    this.onState = paint; paint();
    playB.onclick = () => { this.playing ? this.stop() : this.play(); };
    const tempo = h('input', { type: 'range', class: 'range', min: 40, max: 150, value: Math.round(this.rate * 100), 'aria-label': t('טמפו') });
    const base = this.e.v.score.tempo || 0;
    const tl = h('span', { class: 'mono' });
    const pt = () => { tl.textContent = `${tempo.value}%` + (base ? ` · ${Math.round(base * tempo.value / 100)}♩` : ''); };
    pt();
    tempo.oninput = pt; tempo.onchange = () => { this.rate = tempo.value / 100; if (this.playing) { this.stop(); this.play(); } };
    const n = this.measureStarts.length;
    const opts = sel => [h('option', { value: '' }, '—'), ...this.measureStarts.map((m, i) => h('option', { value: i, selected: sel === i }, t('תיבה {m}', { m: (m.m ?? i) + 1 })))];
    const a = h('select', { class: 'mini-select', 'aria-label': t('תחילת לולאה') }, ...opts(this.loopA));
    const b = h('select', { class: 'mini-select', 'aria-label': t('סוף לולאה') }, ...opts(this.loopB));
    a.onchange = () => { this.loopA = a.value === '' ? null : +a.value; };
    b.onchange = () => { this.loopB = b.value === '' ? null : +b.value; };
    const parts = this.partsInPlay();
    const mix = parts.length > 1 ? h('div', { class: 'mix' }, ...parts.map(p => {
      const m = h('button', { class: 'chip' + (this.muted.has(p) ? ' on' : '') }, t('השתק'));
      const s = h('button', { class: 'chip' + (this.solo.has(p) ? ' on' : '') }, t('סולו'));
      m.onclick = () => { this.muted.has(p) ? this.muted.delete(p) : this.muted.add(p); m.classList.toggle('on'); if (this.playing) { this.stop(); this.play(); } };
      s.onclick = () => { this.solo.has(p) ? this.solo.delete(p) : this.solo.add(p); s.classList.toggle('on'); if (this.playing) { this.stop(); this.play(); } };
      return h('div', { class: 'mix-row' }, h('span', { dir: 'auto' }, p), m, s);
    })) : null;
    sheet(t('ניגון'), h('div', {},
      playB,
      h('label', { class: 'field' }, h('span', {}, t('טמפו')), h('div', { class: 'row' }, tempo, tl)),
      toggle(t('ספירה לפני כניסה'), store.state.settings.countIn, v => store.setSetting('countIn', v)),
      h('div', { class: 'field' }, h('span', {}, t('לולאה לתרגול ({n} תיבות)', { n })), h('div', { class: 'row' }, h('span', {}, 'A'), a, h('span', {}, 'B'), b)),
      mix,
      h('p', { class: 'hint' }, t('הצליל הוא סינתיסייזר פשוט מובנה – לשמיעת המבנה והתווים, לא הקלטה.'))));
  }
}

// one synth voice: pitched = filtered triangle/saw, drums (channel 10) = noise / sine thump
let noiseBuf = null;
function voice(ctx, t, dur, n) {
  const gain = ctx.createGain();
  const vel = (n.vel || 90) / 127;
  gain.connect(ctx.destination);
  if (n.ch === 9) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const kick = n.p <= 36;
    const osc = kick ? ctx.createOscillator() : ctx.createBufferSource();
    if (kick) { osc.frequency.setValueAtTime(120, t); osc.frequency.exponentialRampToValueAtTime(45, t + 0.12); }
    else osc.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = kick ? 'lowpass' : 'highpass'; f.frequency.value = kick ? 400 : (n.p >= 42 && n.p <= 46 ? 7000 : 1800);
    osc.connect(f).connect(gain);
    const len = kick ? 0.18 : n.p >= 42 && n.p <= 46 ? 0.06 : 0.16;
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.003); gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.start(t); osc.stop(t + len + 0.02);
    return { osc, gain };
  }
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 440 * Math.pow(2, (n.p - 69) / 12);
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2600;
  osc.connect(f).connect(gain);
  const peak = 0.16 * vel;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(peak * 0.6, t + 0.15);
  gain.gain.setValueAtTime(peak * 0.6, t + Math.max(0.15, dur - 0.03));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
  osc.start(t); osc.stop(t + dur + 0.1);
  return { osc, gain };
}

// ==================================================================== MusicXML helpers
function readParts(xml) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  return [...d.querySelectorAll('part-list > score-part')].map(sp => {
    const id = sp.getAttribute('id');
    const part = d.querySelector(`part[id="${CSS.escape(id)}"]`);
    const st = part && part.querySelector('attributes > staves');
    return { id, name: (sp.querySelector('part-name')?.textContent || id).trim(), staves: st ? +st.textContent : 1 };
  });
}

// part names from MuseScore ("Trumpet in B♭") vs MusicXML ("Trumpet in Bb")
export const nameKey = s => (s || '').normalize('NFC').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s+/g, '').toLowerCase();

// A score saved in MuseScore with "Concert pitch" on is exported in concert pitch even for
// transposing instruments. Detect that and rewrite those parts to written pitch, so the sax
// and trumpet see their own key unless the player asks for concert pitch.
const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NAT = [0, 2, 4, 5, 7, 9, 11];
function shiftPitch(step, alter, octave, diat, chrom) {
  const si = STEPS.indexOf(step);
  const midi = octave * 12 + NAT[si] + alter + chrom;
  let ns = si + diat; let oct = octave + Math.floor(ns / 7); ns = ((ns % 7) + 7) % 7;
  let alt = midi - (oct * 12 + NAT[ns]);
  if (alt > 6) { alt -= 12; } if (alt < -6) { alt += 12; }
  return { step: STEPS[ns], alter: alt, octave: Math.floor((midi - NAT[ns] - alt) / 12) };
}
function toWrittenPitch(d) {
  const parts = [...d.querySelectorAll('score-partwise > part')];
  const firstFifths = p => { const f = p.querySelector('key > fifths'); return f ? +f.textContent : null; };
  // MusicXML 4 (MuseScore 4.6, concert-pitch score): the transposition as <for-part><part-transpose>.
  // It becomes a plain <transpose> once the notes are written pitch, which every reader understands
  for (const fp of d.querySelectorAll('attributes > for-part')) {
    const pt = fp.querySelector('part-transpose');
    if (pt && !fp.parentNode.querySelector(':scope > transpose')) {
      const t = d.createElement('transpose');
      for (const c of [...pt.children]) t.appendChild(c.cloneNode(true));
      fp.parentNode.insertBefore(t, fp);
    }
    fp.parentNode.removeChild(fp);
  }
  const trans = p => { const t = p.querySelector('attributes > transpose'); return t ? { chrom: +(t.querySelector('chromatic')?.textContent || 0), diat: +(t.querySelector('diatonic')?.textContent || 0), oct: +(t.querySelector('octave-change')?.textContent || 0) } : null; };
  const refs = parts.filter(p => { const t = trans(p); return (!t || !t.chrom) && p.querySelector('pitch'); });
  if (!refs.length) return false;
  const concertFifths = firstFifths(refs[0]);
  let changed = false;
  for (const p of parts) {
    const t = trans(p);
    if (!t || !t.chrom || firstFifths(p) !== concertFifths) continue; // already written pitch
    const chrom = -(t.chrom + 12 * t.oct); const diat = -(t.diat + 7 * t.oct);
    for (const pitch of p.querySelectorAll('pitch')) {
      const st = pitch.querySelector('step'); const al = pitch.querySelector('alter'); const oc = pitch.querySelector('octave');
      const r = shiftPitch(st.textContent.trim(), al ? +al.textContent : 0, +oc.textContent, diat, chrom);
      st.textContent = r.step; oc.textContent = r.octave;
      if (r.alter) { if (al) al.textContent = r.alter; else { const a = d.createElement('alter'); a.textContent = r.alter; st.after(a); } } else if (al) al.remove();
      const acc = pitch.parentNode.querySelector('accidental'); if (acc) acc.remove();
    }
    for (const tag of ['root', 'bass']) {
      for (const el of p.querySelectorAll(`harmony > ${tag}`)) {
        const st = el.querySelector(`${tag}-step`); const al = el.querySelector(`${tag}-alter`);
        if (!st) continue;
        const r = shiftPitch(st.textContent.trim(), al ? +al.textContent : 0, 4, diat, chrom);
        st.textContent = r.step;
        if (r.alter) { if (al) al.textContent = r.alter; else { const a = d.createElement(`${tag}-alter`); a.textContent = r.alter; st.after(a); } } else if (al) al.remove();
      }
    }
    for (const f of p.querySelectorAll('key > fifths')) {
      let k = (+f.textContent + 7 * chrom) % 12; if (k < -6) k += 12; if (k > 6) k -= 12; f.textContent = k;
    }
    changed = true;
  }
  return changed;
}

// MusicXML for playback (Verovio reads the notes, never draws them): written pitch, the parts shown,
// measure-repeat signs played as the measures they repeat
export function prepareXml(xml, { parts }) {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  toWrittenPitch(d);
  if (parts) {
    const keep = new Set(parts);
    d.querySelectorAll('part-list > score-part').forEach(sp => { if (!keep.has(sp.getAttribute('id'))) sp.parentNode.removeChild(sp); });
    d.querySelectorAll('part-list > part-group').forEach(g => g.parentNode.removeChild(g));
    d.querySelectorAll('score-partwise > part').forEach(p => { if (!keep.has(p.getAttribute('id'))) p.parentNode.removeChild(p); });
  }
  d.querySelectorAll('lyric').forEach(l => l.parentNode.removeChild(l));
  writeOutMeasureRepeats(d);
  return new XMLSerializer().serializeToString(d);
}

// "repeat the last 1/2 bars" signs: MuseScore also writes the notes, so they play; the sign goes.
function writeOutMeasureRepeats(d) {
  const drop = e => e && e.parentNode && e.parentNode.removeChild(e);
  const signs = [];
  let staff0 = 0;
  for (const part of d.querySelectorAll('score-partwise > part')) {
    const ms = [...part.querySelectorAll(':scope > measure')];
    const staves = +((part.querySelector('attributes > staves') || {}).textContent || 1) || 1;
    let copied = null, len = 0, k = 0;
    ms.forEach((m, i) => {
      for (const r of [...m.querySelectorAll('measure-style > measure-repeat')]) {
        if (r.getAttribute('type') === 'start') {
          len = +(r.getAttribute('slashes') || r.textContent || 1) || 1; k = 0;
          copied = new Set(ms.slice(Math.max(0, i - len), i).flatMap(x => [...x.querySelectorAll(':scope > direction')].map(t => t.textContent.trim())));
        } else { copied = null; len = 0; }
        const st = r.parentNode; drop(r);
        if (!st.children.length) { const at = st.parentNode; drop(st); if (!at.children.length) drop(at); }
      }
      if (!copied) return;
      for (const dir of [...m.querySelectorAll(':scope > direction')]) if (copied.has(dir.textContent.trim())) drop(dir);
      if (len === 1 || len === 2) {
        const kind = len === 1 ? 'mRpt' : k % 2 === 0 ? 'mRpt2' : 'mSpace';
        for (let s = 1; s <= staves; s++) signs.push({ n: m.getAttribute('number'), staff: staff0 + s, kind });
      }
      k++;
    });
    staff0 += staves;
  }
  return signs;
}

// rehearsal letters and tempo belong to the whole score, but the MusicXML has them only in the top part:
// a part shown without it gets them, as MuseScore prints them on every part
function systemTexts(d, keep) {
  const all = [...d.querySelectorAll('score-partwise > part')];
  const top = all[0];
  const first = all.find(p => keep.has(p.getAttribute('id')));
  if (!top || !first || first === top) return;
  const sys = dir => dir.querySelector('rehearsal, metronome') || (dir.querySelector('sound[tempo]') && dir.querySelector('words'));
  const tm = [...top.querySelectorAll(':scope > measure')], fm = [...first.querySelectorAll(':scope > measure')];
  tm.forEach((m, i) => {
    const to = fm[i];
    if (!to) return;
    const has = new Set([...to.querySelectorAll(':scope > direction')].filter(sys).map(x => x.textContent.trim()));
    // the ones at the start of the bar, where these marks sit
    const lead = [];
    for (const c of m.children) { if (c.tagName === 'note' || c.tagName === 'forward') break; if (c.tagName === 'direction' && sys(c) && !has.has(c.textContent.trim())) lead.push(c); }
    const at = [...to.children].find(c => c.tagName === 'note' || c.tagName === 'forward' || c.tagName === 'backup' || c.tagName === 'direction') || null;
    for (const dir of lead) {
      const c = dir.cloneNode(true);
      c.querySelectorAll(':scope > staff').forEach(x => x.parentNode.removeChild(x));
      to.insertBefore(c, at);
    }
  });
}

export function layoutBreaks(layout) {
  if (!layout || !layout.measures || !layout.measures.length) return null;
  const br = new Map();
  const ms = [...layout.measures].sort((a, b) => a.m - b.m);
  // bars on one spot are a multi-measure rest: no break inside it
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1], b = ms[i];
    if (b.page !== a.page) br.set(b.m, 'page');
    else if (Math.abs(b.y - a.y) > 1 && b.x <= a.x) br.set(b.m, 'system');
  }
  return br;
}

// ==================================================================== tiny MIDI parser
function base64ToBytes(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function parseMidi(a) {
  let p = 0;
  const u32 = () => (a[p++] << 24 | a[p++] << 16 | a[p++] << 8 | a[p++]) >>> 0;
  const u16 = () => a[p++] << 8 | a[p++];
  const vlq = () => { let v = 0, c; do { c = a[p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
  p = 8; u16(); const ntr = u16(); const div = u16();
  const tempos = [{ tick: 0, us: 500000 }];
  const raw = [];
  for (let t = 0; t < ntr; t++) {
    while (p < a.length && String.fromCharCode(a[p], a[p + 1], a[p + 2], a[p + 3]) !== 'MTrk') p++;
    p += 4; const len = u32(); const end = p + len;
    let tick = 0; let run = 0; const open = {};
    while (p < end) {
      tick += vlq();
      let st = a[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) {
        const type = a[p++]; const l = vlq();
        if (type === 0x51) tempos.push({ tick, us: a[p] << 16 | a[p + 1] << 8 | a[p + 2] });
        p += l; continue;
      }
      if (st === 0xf0 || st === 0xf7) { p += vlq(); continue; }
      run = st;
      const type = st & 0xf0; const ch = st & 0x0f;
      if (type === 0x90 || type === 0x80) {
        const note = a[p++]; const vel = a[p++];
        const k = ch + ':' + note;
        if (type === 0x90 && vel > 0) { (open[k] = open[k] || []).push({ tick, vel }); }
        else if (open[k] && open[k].length) { const o = open[k].shift(); raw.push({ track: t, ch, p: note, vel: o.vel, t0: o.tick, t1: tick }); }
      } else if (type === 0xc0 || type === 0xd0) p += 1;
      else p += 2;
    }
    p = end;
  }
  tempos.sort((x, y) => x.tick - y.tick);
  const ms = tick => {
    let t = 0, last = 0, us = 500000;
    for (const tp of tempos) { if (tp.tick > tick) break; t += (tp.tick - last) * us / div / 1000; last = tp.tick; us = tp.us; }
    return t + (tick - last) * us / div / 1000;
  };
  return raw.map(n => ({ track: n.track, ch: n.ch, p: n.p, vel: n.vel, t: ms(n.t0), d: ms(n.t1) - ms(n.t0) })).sort((x, y) => x.t - y.t);
}

// ---------------------------------------------------------------- note editing of a MusicXML song
// A song that came as MusicXML becomes a MuseScore file to edit: the full score and one part file per
// instrument (MuseScore makes them), with what live mode does to it baked in, so the edited song looks
// the same: written-key signatures of transposing instruments, slashes on the middle line, fonts,
// titles, and (when known) the line breaks and paper of its PDFs.
//   opts.score / opts.part(name) -> { breaks: Map, paper: { w, h }, mmRests } or null
export async function xmlToEditable(xml, opts = {}) {
  const full = msXml(xml, { parts: null });
  const parts = readParts(full);
  const keysOf = sel => concertKeys(msXml(xml, { parts: sel }));
  const allKeys = concertKeys(full);
  const have = await fontsOnHand();
  const bytes = await withScore(new TextEncoder().encode(full), 'musicxml', async call => {
    // one part file per instrument (a single instrument needs none: its part is the score)
    if (parts.length > 1) await call('generateExcerpts');
    return call('saveMsc', ['mscz']);
  });
  return patchMscz(bytes, (text, name) => {
    const ex = name.match(/^Excerpts\/([^/]+)\//);
    let pname = null, fix = opts.score || null, keys = allKeys;
    if (ex) {
      const own = name.endsWith('.mscx') ? text : null;
      pname = ((own && own.match(/<metaTag name="partName">([^<]*)</)) || [])[1] || ex[1].replace(/^\d+_/, '').replace(/_/g, ' ');
      const p = parts.find(x => nameKey(x.name) === nameKey(pname));
      keys = p ? keysOf([p.id]) : [];
      fix = opts.part ? opts.part(pname) : null;
    }
    if (/\.mscx$/i.test(name)) {
      text = setKeys(text, keys);
      text = fixSlashes(text);
      text = setMsTitle(text, opts.title, opts.composer);
      if (fix && fix.breaks && fix.breaks.size) text = setMsBreaks(text, fix.breaks);
      else if (fix && fix.auto) text = setMsBreaks(text, autoBreaks(text));
      if (ex) text = setStyle(text, 'hideInstrumentNameIfOneInstrument', 1);
    } else {
      if (fix && fix.paper) text = setPaper(text, fix.paper);
      if (fix && fix.mmRests) text = setStyle(text, 'createMultiMeasureRests', 1);
      if (ex) text = setStyle(text, 'hideInstrumentNameIfOneInstrument', 1);
    }
    return fixFonts(text, have);
  });
}
