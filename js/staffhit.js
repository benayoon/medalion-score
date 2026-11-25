// Where a tap on MuseScore's own drawing lands in the music, and back: where a place in the music is drawn.
// Works on what webmscore gives: the page SVG (its staff lines), the measure boxes (one per measure, the
// height of the whole system) and the chord/rest columns ("segments", across the system, with when they
// sound). No store, no UI: the editor and the tests both use it.
import { transposeTpc, transposeKey } from './mstranspose.js';
import { tpcStep, tpcAlter } from './msedit.js';

// staves drawn on one page: [{ x0, x1, top, bottom, sp, lines }] (sp: the distance between two lines)
export function pageStaves(svg) {
  const ls = [];
  for (const p of svg.querySelectorAll('.StaffLines')) {
    const pts = (p.getAttribute('points') || '').trim().split(/\s+/).map(s => s.split(',').map(Number));
    if (pts.length < 2 || pts.some(q => q.length < 2 || q.some(isNaN))) continue;
    ls.push({ x0: Math.min(pts[0][0], pts[1][0]), x1: Math.max(pts[0][0], pts[1][0]), y: pts[0][1] });
  }
  // the smallest distance between two lines of one length: the staff space
  const byRow = new Map();
  for (const l of ls) { const k = Math.round(l.x0) + ':' + Math.round(l.x1); (byRow.get(k) || byRow.set(k, []).get(k)).push(l); }
  let sp = Infinity;
  for (const row of byRow.values()) { row.sort((a, b) => a.y - b.y); for (let i = 1; i < row.length; i++) { const d = row[i].y - row[i - 1].y; if (d > 0.5) sp = Math.min(sp, d); } }
  if (!isFinite(sp)) sp = 80;
  const out = [];
  for (const row of byRow.values()) {
    let cur = null;
    for (const l of row) {
      if (cur && l.y - cur.lines[cur.lines.length - 1] <= sp * 1.35) { cur.lines.push(l.y); continue; }
      cur = { x0: l.x0, x1: l.x1, lines: [l.y] }; out.push(cur);
    }
  }
  for (const s of out) {
    s.top = s.lines[0]; s.bottom = s.lines[s.lines.length - 1];
    s.sp = s.lines.length > 1 ? (s.bottom - s.top) / (s.lines.length - 1) : sp;
    // a one-line staff (percussion) is read as the middle line of five
    if (s.lines.length === 1) { s.top -= 2 * sp; s.bottom += 2 * sp; }
  }
  return out.sort((a, b) => a.top - b.top || a.x0 - b.x0);
}

// the staves of the system a measure box belongs to, top to bottom
export function systemStaves(staves, box) {
  const pad = 2;
  return staves.filter(s => s.top >= box.y - pad && s.bottom <= box.y + box.h + pad && s.x0 <= box.x + 1 && s.x1 >= box.x + box.w - 1);
}

// the chord/rest columns inside a measure box, left to right
export function boxSegments(segs, box) {
  return (segs || []).filter(s => s.page === box.page && Math.abs(s.y - box.y) < 1 && s.x >= box.x - 0.5 && s.x < box.x + box.w - 0.5).sort((a, b) => a.x - b.x);
}

// a tap (page coordinates) -> { box, staff (index in the system), halfSpaces (0 = top line, down is +), col, cols }
export function hitTest(geo, page, x, y) {
  const boxes = geo.boxes.filter(b => b.page === page && x >= b.x && x <= b.x + b.w);
  if (!boxes.length) return null;
  const staves = geo.staves[page] || [];
  const near = [];
  for (const b of boxes) {
    const sys = systemStaves(staves, b);
    sys.forEach((s, k) => {
      const d = y < s.top ? s.top - y : y > s.bottom ? y - s.bottom : 0;
      if (d <= s.sp * 6) near.push({ d, box: b, staff: k, st: s, n: sys.length });
    });
  }
  if (!near.length) return null;
  near.sort((a, b) => a.d - b.d);
  const one = c => {
    const { box, st } = c;
    const halfSpaces = Math.round((y - st.top) / (st.sp / 2));
    const cols = boxSegments(geo.segs, box);
    // the column under the finger: the notehead sits just right of the column's x
    let col = -1, cd = Infinity;
    cols.forEach((q, k) => { const d = Math.abs(q.x + st.sp * 0.6 - x); if (d < cd) { cd = d; col = k; } });
    return { box, m: box.m, staff: c.staff, staves: c.n, halfSpaces, col, cols, sp: st.sp, st, d: c.d };
  };
  const hit = one(near[0]);
  // between two staves (ledger lines of either): the other one too, so a note there can decide
  if (near[1] && near[0].d > 0 && near[1].box === near[0].box) hit.alt = one(near[1]);
  return hit;
}

// the tick of a column: by order when the columns are exactly the measure's onsets, else by when it sounds
export function colTick(hit, onsets, len) {
  const { cols, col, box } = hit;
  if (col < 0) return 0;
  if (cols.length === onsets.length) return onsets[col];
  const c = cols[col];
  if (c.ms != null && box.ms0 != null && box.ms1 != null && box.ms1 > box.ms0) {
    const t = (c.ms - box.ms0) / (box.ms1 - box.ms0) * len;
    return onsets.reduce((a, o) => (Math.abs(o - t) < Math.abs(a - t) ? o : a), 0);
  }
  // nothing better: by the place across the measure
  const t = (c.x - box.x) / box.w * len;
  return onsets.reduce((a, o) => (Math.abs(o - t) < Math.abs(a - t) ? o : a), 0);
}

// where to draw a place: the x of the column at `tick` (or between columns) and the staff's lines
export function placeRect(geo, m, staffIdx, tick, onsets, len) {
  const box = geo.boxes.find(b => b.m === m);
  if (!box) return null;
  const sys = systemStaves(geo.staves[box.page] || [], box);
  const st = sys[staffIdx] || sys[0];
  if (!st) return null;
  const cols = boxSegments(geo.segs, box);
  let x;
  const k = onsets.indexOf(tick);
  if (cols.length === onsets.length && k >= 0) x = cols[k].x;
  else if (cols.length && box.ms0 != null && box.ms1 > box.ms0) {
    const ms = box.ms0 + tick / len * (box.ms1 - box.ms0);
    const c = cols.reduce((a, c) => (c.ms != null && Math.abs(c.ms - ms) < Math.abs(a.ms - ms) ? c : a), cols[0]);
    x = c.x;
  } else x = box.x + tick / len * box.w;
  return { page: box.page, x, st, box };
}

// ---------------------------------------------------------------- with the song's file (MsDoc)
// every onset (chord or rest, any voice) of a measure on the staves drawn: the columns MuseScore draws
export function onsets(doc, staves, m) {
  const s = new Set();
  for (const id of staves) for (let v = 0; v < 4; v++) {
    const ev = doc.events(id, m, v);
    if (ev) for (const e of ev.events) if (!e.grace) s.add(e.tick);
  }
  return [...s].sort((a, b) => a - b);
}

// the event of a voice sounding at a tick (the one that starts there, or holds over it)
export function eventAt(doc, staff, m, voice, tick) {
  const ev = doc.events(staff, m, voice);
  if (!ev) return -1;
  let i = ev.events.findIndex(e => !e.grace && e.tick <= tick && tick < e.tick + e.ticks);
  if (i < 0) i = ev.events.findIndex(e => !e.grace && e.tick >= tick);
  if (i < 0) for (let k = ev.events.length - 1; k >= 0; k--) if (!ev.events[k].grace) { i = k; break; }
  return i;
}

// written pitch (what a transposing instrument reads, and what the editor draws) <-> concert (what the file keeps)
export function toWritten(doc, staff, pitch, tpc) {
  const iv = doc.writtenIv(doc.main, staff);
  return iv ? { pitch: pitch + iv[1], tpc: transposeTpc(tpc, iv, false) } : { pitch, tpc };
}
export function toConcert(doc, staff, pitch, tpc) {
  const iv = doc.writtenIv(doc.main, staff);
  return iv ? { pitch: pitch - iv[1], tpc: transposeTpc(tpc, [-iv[0], -iv[1]], false) } : { pitch, tpc };
}
export function writtenKey(doc, staff, key) {
  const iv = doc.writtenIv(doc.main, staff);
  return iv ? transposeKey(key, iv) : key;
}

// a tap -> a place in the music: { staff (main id), m, tick, i (event in `voice`), pitch, tpc (concert), hit }
// `staves`: the main ids of the staves drawn, top to bottom
export function tapPlace(doc, geo, staves, page, x, y, voice = 0) {
  const h0 = hitTest(geo, page, x, y);
  if (!h0) return null;
  const a = placeOf(doc, h0, staves, voice);
  if (!a || !h0.alt) return a;
  // in the gap between two staves: the staff that has a note on that line there
  const b = placeOf(doc, h0.alt, staves, voice);
  const onLine = p => p && [0, 1, 2, 3].some(v => { const ev = doc.events(p.staff, p.m, v); return ev && ev.events.some(e => !e.rest && e.tick === p.tick && e.notes.some(q => { const w = toWritten(doc, p.staff, q.pitch, q.tpc); return Math.abs(doc.staffLineOf(p.staff, p.m, p.tick, w.pitch, w.tpc) - p.hit.halfSpaces) <= 1; })); });
  return !onLine(a) && onLine(b) ? b : a;
}
function placeOf(doc, hit, staves, voice) {
  const staff = staves[hit.staves === staves.length ? hit.staff : Math.min(hit.staff, staves.length - 1)];
  if (staff == null) return null;
  const m = hit.m;
  if (m == null || m >= doc.measureCount()) return null;
  const ctx = doc.context(staff, m);
  const tick = colTick(hit, onsets(doc, staves, m), ctx.len);
  const i = eventAt(doc, staff, m, voice, tick);
  let w = doc.noteOnStaff(staff, m, tick, hit.halfSpaces, writtenKey(doc, staff, ctx.key));
  const held = heldAccidental(doc, staff, m, tick, w);
  if (held) w = held;
  const c = toConcert(doc, staff, w.pitch, w.tpc);
  return { staff, m, tick, i, voice, pitch: c.pitch, tpc: c.tpc, written: w, hit };
}

// an accidental earlier in the measure on the same line holds until the barline (as the player reads it)
function heldAccidental(doc, staff, m, tick, w) {
  const nat = (p, tpc) => p - tpcAlter(tpc);   // the pitch of the line itself
  const line = nat(w.pitch, w.tpc);
  let best = null;
  for (let v = 0; v < 4; v++) {
    const ev = doc.events(staff, m, v); if (!ev) continue;
    for (const e of ev.events) {
      if (e.rest || e.tick >= tick || (best && e.tick < best.tick)) continue;
      for (const q of e.notes) {
        const wq = toWritten(doc, staff, q.pitch, q.tpc);
        if (tpcStep(wq.tpc) === w.step && nat(wq.pitch, wq.tpc) === line) best = { tick: e.tick, pitch: wq.pitch, tpc: wq.tpc, step: w.step };
      }
    }
  }
  return best;
}
