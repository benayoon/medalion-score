// Pencil annotations on top of PDF pages.
// Every mark is stored in PDF points and anchored to the nearest measure (layout computed from MusicXML),
// so when a new version is imported the mark moves with its measure. Marks whose measure is gone
// are flagged for review instead of silently landing in the wrong place.
import { h, icon, btn, toast, promptBox, sheet } from './ui.js';
import * as store from './store.js';
import { t } from './i18n.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  return el;
};

export const LAYERS = [
  { id: 'mine', name: t('ההערות שלי'), color: '#1f5fd1' },
  { id: 'rehearsal', name: t('הערות חזרה'), color: '#d12f2f' },
  { id: 'band', name: t('הערות להקה'), color: '#13865a' },
];
const COLORS = ['#111111', '#1f5fd1', '#d12f2f', '#13865a', '#b45f06', '#7b3fc4'];
const MARKER_COLORS = ['#ffe14d', '#7ee0a1', '#8fd3ff', '#ff9ccf'];
const BASE_STAMPS = ['𝄐', '’', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'cresc.', 'dim.', '1', '2', '3', '4', '5', '𝄽', '♯', '♭', '♮', 'V.S.', 'D.S.', 'Coda'];

export class Annotator {
  constructor(host) {
    this.host = host;            // { scoreId, docName(), mpos(), onChange() }
    this.data = { strokes: [] };
    this.overlays = [];          // [{svg, page, box}]
    this.editing = false;
    this.tool = 'pen';
    this.color = COLORS[0];
    this.markerColor = MARKER_COLORS[0];
    this.layer = 'mine';
    this.stamp = 'p';
    this.shape = 'line';
    this.width = 1.4;
    this.undoStack = [];
    this.hidden = new Set(JSON.parse(localStorage.getItem('ms-hidden-layers') || '[]'));
  }
  async load() {
    this.data = await store.annotations(this.host.scoreId);
  }
  save() {
    store.saveAnnotations(this.host.scoreId);
    this.host.onChange && this.host.onChange();
  }
  snapshot() {
    this.undoStack.push(JSON.stringify(this.data.strokes));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return toast(t('אין מה לבטל'));
    this.data.strokes = JSON.parse(s);
    this.save(); this.redraw();
  }

  // ---------------------------------------------------------------- placement
  measuresOn(page) {
    const mp = this.host.mpos();
    return mp ? mp.measures.filter(m => m.page === page) : [];
  }
  nearestMeasure(page, x, y) {
    let best = null; let bd = Infinity;
    for (const m of this.measuresOn(page)) {
      const dx = x < m.x ? m.x - x : x > m.x + m.w ? x - m.x - m.w : 0;
      const dy = y < m.y ? m.y - y : y > m.y + m.h ? y - m.y - m.h : 0;
      const d = dx * dx + dy * dy * 4; // prefer same system
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  place(s) {
    const mp = this.host.mpos();
    if (s.anchor && mp) {
      const m = mp.measures.find(x => x.m === s.anchor.m);
      if (m) return { page: m.page, dx: m.x - s.anchor.x, dy: m.y - s.anchor.y, review: false };
      return { page: s.page, dx: 0, dy: 0, review: true };
    }
    return { page: s.page, dx: 0, dy: 0, review: false };
  }
  strokesFor(page) {
    const doc = this.host.docName();
    const out = [];
    for (const s of this.data.strokes) {
      if (s.doc !== doc || this.hidden.has(s.layer)) continue;
      const p = this.place(s);
      if (p.page === page) out.push([s, p]);
    }
    return out;
  }
  reviewCount() {
    const doc = this.host.docName();
    return this.data.strokes.filter(s => s.doc === doc && this.place(s).review).length;
  }

  // ---------------------------------------------------------------- drawing
  decorate(pgEl, page, box) {
    const o = svg('svg', { class: 'annot', viewBox: `${box.x} ${box.y} ${box.w} ${box.h}`, preserveAspectRatio: 'none' });
    pgEl.append(o);
    const rec = { svg: o, page, box };
    this.overlays.push(rec);
    this.overlays = this.overlays.filter(r => r.svg.isConnected || r.svg === o);
    this.drawInto(rec);
    this.bindPointer(rec);
    return o;
  }
  redraw() {
    this.overlays = this.overlays.filter(r => r.svg.isConnected);
    for (const r of this.overlays) this.drawInto(r);
  }
  drawInto(rec) {
    rec.svg.replaceChildren();
    rec.svg.classList.toggle('editing', this.editing);
    for (const [s, p] of this.strokesFor(rec.page)) rec.svg.append(this.render(s, p));
  }
  render(s, p) {
    const g = svg('g', { 'data-id': s.id, transform: `translate(${p.dx} ${p.dy})`, class: p.review ? 'review' : '' });
    const color = s.color;
    if (s.tool === 'pen' || s.tool === 'marker') {
      g.append(svg('path', {
        d: smoothPath(s.pts), fill: 'none', stroke: color, 'stroke-width': s.w,
        'stroke-linecap': s.tool === 'marker' ? 'butt' : 'round', 'stroke-linejoin': 'round',
        opacity: s.tool === 'marker' ? 0.38 : 1,
      }));
    } else if (s.tool === 'line') {
      const [a, b] = s.pts;
      g.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: color, 'stroke-width': s.w, 'stroke-linecap': 'round' }));
    } else if (s.tool === 'rect') {
      const [a, b] = s.pts;
      g.append(svg('rect', { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), fill: 'none', stroke: color, 'stroke-width': s.w, rx: 2 }));
    } else if (s.tool === 'ellipse') {
      const [a, b] = s.pts;
      g.append(svg('ellipse', { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2, fill: 'none', stroke: color, 'stroke-width': s.w }));
    } else if (s.tool === 'text' || s.tool === 'stamp') {
      const t = svg('text', {
        x: s.pts[0][0], y: s.pts[0][1], fill: color, 'font-size': s.size || 14,
        'font-family': s.tool === 'stamp' ? '"Bravura Text", "Times New Roman", serif' : '-apple-system, "Helvetica Neue", Arial, sans-serif',
        'font-style': s.tool === 'stamp' && /^[pmfsz]+$/.test(s.text) ? 'italic' : 'normal',
        'font-weight': s.tool === 'stamp' ? 'bold' : 'normal', 'dominant-baseline': 'middle', 'text-anchor': 'middle',
      });
      t.textContent = s.text;
      g.append(t);
    }
    return g;
  }

  // ---------------------------------------------------------------- input
  bindPointer(rec) {
    const o = rec.svg;
    let cur = null; let start = null; let moving = null; let erased = false;
    const toPt = e => {
      const m = o.getScreenCTM().inverse();
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
      return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
    };
    const blocked = e => !this.editing || (store.state.settings.pencilOnly && e.pointerType === 'touch');
    o.addEventListener('pointerdown', e => {
      if (blocked(e)) return;
      e.preventDefault(); e.stopPropagation();
      o.setPointerCapture(e.pointerId);
      const pt = toPt(e);
      start = pt;
      if (this.tool === 'eraser') { this.snapshot(); erased = this.eraseAt(rec, pt) || false; return; }
      if (this.tool === 'select') {
        const hit = this.hit(rec, pt);
        if (hit) { this.snapshot(); moving = { s: hit, last: pt }; }
        return;
      }
      if (this.tool === 'text' || this.tool === 'stamp') return; // on pointerup
      const tool = this.tool === 'shape' ? this.shape : this.tool;
      cur = {
        tool, pts: [pt], color: tool === 'marker' ? this.markerColor : this.color,
        w: tool === 'marker' ? 9 : this.width,
      };
      cur.el = this.render({ ...cur, pts: tool === 'pen' || tool === 'marker' ? [pt] : [pt, pt] }, { dx: 0, dy: 0 });
      o.append(cur.el);
    });
    o.addEventListener('pointermove', e => {
      if (blocked(e)) return;
      if (this.tool === 'eraser' && start) { erased = this.eraseAt(rec, toPt(e)) || erased; return; }
      if (moving) {
        const pt = toPt(e);
        const dx = pt[0] - moving.last[0]; const dy = pt[1] - moving.last[1];
        moving.last = pt;
        moving.s.pts = moving.s.pts.map(([x, y]) => [x + dx, y + dy]);
        if (moving.s.anchor) { /* anchor stays: the mark keeps its offset to the measure */ }
        this.drawInto(rec);
        return;
      }
      if (!cur) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (cur.tool === 'pen' || cur.tool === 'marker') for (const ev of evs) cur.pts.push(toPt(ev));
      else cur.pts = [cur.pts[0], toPt(e)];
      const el = this.render(cur, { dx: 0, dy: 0 });
      cur.el.replaceWith(el); cur.el = el;
    });
    const end = async e => {
      if (blocked(e)) return;
      if (this.tool === 'eraser') { if (erased) this.save(); else this.undoStack.pop(); start = null; erased = false; return; }
      if (moving) { moving = null; this.save(); return; }
      if ((this.tool === 'text' || this.tool === 'stamp') && start && e.type === 'pointerup') {
        const pt = start; start = null;
        let text = this.stamp; let size = 16;
        if (this.tool === 'text') { text = await promptBox(t('טקסט על התווים'), ''); size = 12; if (!text) return; }
        this.add(rec, { tool: this.tool, pts: [pt], text, size, color: this.color, w: 0 });
        return;
      }
      start = null;
      if (!cur) return;
      const s = cur; cur = null; s.el.remove(); delete s.el;
      if ((s.tool === 'pen' || s.tool === 'marker') && s.pts.length < 2) s.pts.push([s.pts[0][0] + 0.3, s.pts[0][1] + 0.3]);
      if (s.tool === 'pen' || s.tool === 'marker') s.pts = simplify(s.pts, 0.35);
      this.add(rec, s);
    };
    o.addEventListener('pointerup', end);
    o.addEventListener('pointercancel', end);
  }
  add(rec, s) {
    this.snapshot();
    const [x, y] = s.pts[0];
    const m = this.nearestMeasure(rec.page, x, y);
    const stroke = {
      id: store.uid(), doc: this.host.docName(), layer: this.layer, page: rec.page,
      anchor: m ? { m: m.m, x: m.x, y: m.y } : null, created: Date.now(), ...s,
    };
    if (this.layer !== 'mine' && (s.tool === 'pen' || s.tool === 'text' || s.tool === 'stamp' || s.tool === 'line' || s.tool === 'rect' || s.tool === 'ellipse') && this.color === COLORS[0]) {
      stroke.color = LAYERS.find(l => l.id === this.layer).color;
    }
    this.data.strokes.push(stroke);
    this.save();
    this.drawInto(rec);
  }
  hit(rec, [x, y], r = 6) {
    const list = this.strokesFor(rec.page).reverse();
    for (const [s, p] of list) {
      const pts = s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'line' ? densify(s.pts) : s.pts;
      const rr = s.tool === 'text' || s.tool === 'stamp' ? Math.max(r, (s.size || 14) * 0.8) : r + s.w / 2;
      for (const [px, py] of pts) {
        if (Math.hypot(px + p.dx - x, py + p.dy - y) < rr) return s;
      }
    }
    return null;
  }
  eraseAt(rec, pt) {
    const s = this.hit(rec, pt, 7);
    if (!s) return false;
    this.data.strokes = this.data.strokes.filter(x => x !== s);
    this.drawInto(rec);
    return true;
  }
  clearReview() {
    const doc = this.host.docName();
    this.snapshot();
    this.data.strokes = this.data.strokes.filter(s => !(s.doc === doc && this.place(s).review));
    this.save(); this.redraw();
  }
  acceptReview() {
    // keep the flagged marks where they are on the page and drop their (lost) measure anchor
    const doc = this.host.docName();
    for (const s of this.data.strokes) if (s.doc === doc && this.place(s).review) s.anchor = null;
    this.save(); this.redraw();
  }

  // ---------------------------------------------------------------- toolbar
  setEditing(on) {
    this.editing = on;
    this.redraw();
  }
  toolbar(onDone) {
    const bar = h('div', { class: 'pencilbar', role: 'toolbar', 'aria-label': t('כלי עיפרון') });
    const tools = [
      ['pen', 'pen', t('עט')], ['marker', 'marker', t('מרקר')], ['eraser', 'eraser', t('מחק')], ['text', 'text', t('טקסט')],
      ['stamp', 'stamp', t('חותמות')], ['shape', 'shape', t('צורות')], ['select', 'select', t('בחירה והזזה')],
    ];
    const toolBtns = {};
    const setTool = t => {
      this.tool = t;
      for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('on', k === t);
      if (t === 'stamp') this.stampPicker(chip);
      if (t === 'shape') this.shapePicker();
    };
    const toolsWrap = h('div', { class: 'pb-group' });
    for (const [t, ic, label] of tools) {
      const b = btn(ic, label, () => setTool(t), 'ghost' + (this.tool === t ? ' on' : ''));
      toolBtns[t] = b; toolsWrap.append(b);
    }
    const chip = h('span', { class: 'pb-stamp' }, this.stamp);
    const colors = h('div', { class: 'pb-group' });
    const paint = () => {
      colors.replaceChildren(...(this.tool === 'marker' ? MARKER_COLORS : COLORS).map(c => {
        const sel = (this.tool === 'marker' ? this.markerColor : this.color) === c;
        const b = h('button', { class: 'swatch' + (sel ? ' on' : ''), style: { background: c }, 'aria-label': t('צבע') });
        b.onclick = () => { if (this.tool === 'marker') this.markerColor = c; else this.color = c; paint(); };
        return b;
      }));
    };
    paint();
    for (const b of Object.values(toolBtns)) b.addEventListener('click', paint);
    const widthSel = h('select', { class: 'mini-select', 'aria-label': t('עובי') },
      ...[['0.8', t('דק')], ['1.4', t('רגיל')], ['2.4', t('עבה')]].map(([v, l]) => h('option', { value: v, selected: +v === this.width }, l)));
    widthSel.onchange = () => { this.width = +widthSel.value; };
    const layerSel = h('select', { class: 'mini-select', 'aria-label': t('שכבה') },
      ...LAYERS.map(l => h('option', { value: l.id, selected: l.id === this.layer }, l.name)));
    layerSel.onchange = () => { this.layer = layerSel.value; };
    bar.append(
      toolsWrap, chip, h('div', { class: 'pb-sep' }), colors, widthSel, layerSel,
      btn('layers', t('הצגת שכבות'), () => this.layersSheet(), 'ghost'),
      btn('undo', t('ביטול פעולה'), () => this.undo(), 'ghost'),
      h('button', { class: 'btn labeled primary', onclick: onDone }, t('סיום')),
    );
    return bar;
  }
  stampPicker(chip) {
    const custom = store.state.settings.customStamps || [];
    const s = sheet(t('חותמות'), h('div', {},
      h('div', { class: 'stamps' }, ...[...BASE_STAMPS, ...custom].map(t => h('button', {
        class: 'stamp-b', onclick: () => { this.stamp = t; chip.textContent = t; s.close(); },
      }, t))),
      h('button', {
        class: 'btn labeled', onclick: async () => {
          const st = await promptBox(t('חותמת חדשה (למשל: "לאט", "שקט!", "Tutti")'));
          if (!st) return;
          store.setSetting('customStamps', [...custom, st]);
          this.stamp = st; chip.textContent = st; s.close();
        },
      }, icon('plus'), t('חותמת אישית'))));
  }
  shapePicker() {
    const s = sheet(t('צורה'), h('div', { class: 'row' },
      ...[['line', t('קו')], ['rect', t('מלבן')], ['ellipse', t('עיגול')]].map(([v, l]) =>
        h('button', { class: 'btn labeled' + (this.shape === v ? ' primary' : ''), onclick: () => { this.shape = v; s.close(); } }, l))));
  }
  layersSheet() {
    const rows = LAYERS.map(l => {
      const cb = h('input', { type: 'checkbox', class: 'switch' });
      cb.checked = !this.hidden.has(l.id);
      cb.onchange = () => {
        if (cb.checked) this.hidden.delete(l.id); else this.hidden.add(l.id);
        localStorage.setItem('ms-hidden-layers', JSON.stringify([...this.hidden]));
        this.redraw();
      };
      return h('label', { class: 'field toggle' }, h('span', {}, h('i', { class: 'dot', style: { background: l.color } }), l.name), cb);
    });
    sheet(t('שכבות'), h('div', {}, ...rows, h('p', { class: 'hint' }, t('שכבת הלהקה תשותף עם הנגנים בשלב 3.'))));
  }
}

// ---------------------------------------------------------------- geometry
function smoothPath(pts) {
  if (pts.length < 3) return 'M' + pts.map(p => p.join(' ')).join(' L');
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2; const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0]} ${pts[i][1]} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]} ${l[1]}`;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    if (Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) >= tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function densify(pts) {
  const [a, b] = pts;
  if (!b) return pts;
  const out = [];
  // rectangle/ellipse/line outline approximated by the bounding box edges
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    out.push([x0 + (x1 - x0) * t, y0], [x0 + (x1 - x0) * t, y1], [x0, y0 + (y1 - y0) * t], [x1, y0 + (y1 - y0) * t]);
  }
  return out;
}
