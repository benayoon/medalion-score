// Where every measure sits on the PDF page, computed from the layout data MuseScore writes into
// MusicXML (page size, margins, system breaks, measure widths, staff distances).
// Output matches the shape the viewer uses: { measures: [{ m, page, x, y, w, h }] } in PDF points.

const num = (el, sel, def = 0) => { const x = el && el.querySelector(sel); return x ? parseFloat(x.textContent) : def; };

export function layoutFromMusicXml(xml) {
  const d = typeof xml === 'string' ? new DOMParser().parseFromString(xml, 'application/xml') : xml;
  const def = d.querySelector('defaults');
  if (!def || !def.querySelector('page-layout')) return null;
  const mm = num(def, 'scaling millimeters', 7); const tenths = num(def, 'scaling tenths', 40);
  const pt = t => t * (mm / tenths) * (72 / 25.4);           // tenths → PDF points
  const pl = def.querySelector('page-layout');
  const margins = type => pl.querySelector(`page-margins[type="${type}"]`) || pl.querySelector('page-margins[type="both"]') || pl.querySelector('page-margins');
  const defStaffDist = num(def, 'staff-layout staff-distance', 65);
  const defSysDist = num(def, 'system-layout system-distance', 100);
  const defTopSys = num(def, 'system-layout top-system-distance', 70);

  const parts = [...d.querySelectorAll('score-partwise > part')];
  if (!parts.length) return null;
  const measuresByPart = parts.map(p => [...p.children].filter(c => c.tagName === 'measure'));
  const staves = parts.map(p => num(p, 'attributes > staves', 1));
  const n = measuresByPart[0].length;

  // staff distance for staff k of part p at measure i (latest <print> wins)
  const lastDist = parts.map((_, p) => Array(staves[p]).fill(defStaffDist));
  const visible = parts.map((_, p) => Array(staves[p]).fill(true));   // hidden empty staves
  let restLeft = 0; let restBox = null;                               // inside a multi-measure rest
  const out = [];
  let page = 0; let x = 0; let y = 0; let sysH = 0; let left = 0; let first = true;

  const pageW = num(pl, 'page-width', 0);
  const widthOf = m => parseFloat(m.getAttribute('width'));
  if (!measuresByPart[0].some(m => widthOf(m) > 0)) return null;   // exported without layout
  // multi-measure rests are written with width 0: they get the room left over in their system
  const sysStart = i => { const pr = measuresByPart[0][i].querySelector(':scope > print'); return i === 0 || (pr && (pr.getAttribute('new-page') === 'yes' || pr.getAttribute('new-system') === 'yes')); };
  const fillW = new Map();
  let pg = 0;
  for (let i = 0; i < n;) {
    let j = i + 1; while (j < n && !sysStart(j)) j++;
    const pr0 = measuresByPart[0][i].querySelector(':scope > print');
    if (i && pr0 && pr0.getAttribute('new-page') === 'yes') pg++;
    const mg = margins(pg % 2 === 0 ? 'odd' : 'even');
    const avail = pageW - num(mg, 'left-margin') - num(mg, 'right-margin') - num(pr0, 'system-margins left-margin', 0) - num(pr0, 'system-margins right-margin', 0);
    let used = 0; const zero = [];
    let skip = 0;
    for (let k = i; k < j; k++) {
      if (skip > 0) { skip--; continue; }
      const m = measuresByPart[0][k]; const w = widthOf(m) || 0;
      const mr = m.querySelector('measure-style multiple-rest');
      if (mr) skip = (parseInt(mr.textContent) || 1) - 1;
      if (w > 0) used += w; else zero.push(k);
    }
    if (zero.length) { const each = Math.max(60, (avail - used) / zero.length); zero.forEach(k => fillW.set(k, each)); }
    i = j;
  }

  for (let i = 0; i < n; i++) {
    const m0 = measuresByPart[0][i];
    const pr = m0.querySelector(':scope > print');
    const newPage = pr && pr.getAttribute('new-page') === 'yes';
    const newSystem = first || newPage || (pr && pr.getAttribute('new-system') === 'yes');
    // staff distances and hidden staves can change at any system
    parts.forEach((p, pi) => {
      const mi = measuresByPart[pi][i];
      if (!mi) return;
      for (const sd of mi.querySelectorAll(':scope > attributes > staff-details')) {
        const k = (parseInt(sd.getAttribute('number')) || 1) - 1;
        if (k < staves[pi]) visible[pi][k] = sd.getAttribute('print-object') !== 'no';
      }
      const ppr = mi.querySelector(':scope > print');
      if (!ppr) return;
      for (const sl of ppr.querySelectorAll('staff-layout')) {
        const k = (parseInt(sl.getAttribute('number')) || 1) - 1;
        if (k < staves[pi]) lastDist[pi][k] = num(sl, 'staff-distance', lastDist[pi][k]);
      }
    });
    if (newSystem) {
      if (newPage && !first) page++;
      const mg = margins(page % 2 === 0 ? 'odd' : 'even'); // MuseScore counts the first page as odd
      const top = num(mg, 'top-margin');
      left = num(mg, 'left-margin') + num(pr, 'system-margins left-margin', 0);
      if (first || newPage) y = top + num(pr, 'top-system-distance', defTopSys);
      else y = y + sysH + num(pr, 'system-distance', defSysDist);
      // system height: every staff is 4 spaces (40 tenths), plus the gaps between visible staves
      sysH = 0;
      let firstStaff = true;
      parts.forEach((_, pi) => {
        for (let k = 0; k < staves[pi]; k++) {
          if (!visible[pi][k]) continue;
          if (!firstStaff) sysH += lastDist[pi][k];
          sysH += 40; firstStaff = false;
        }
      });
      x = left;
      first = false;
    }
    if (restLeft > 0 && !newSystem) { restLeft--; out.push({ ...restBox, m: i }); continue; }
    restLeft = 0;
    const w = widthOf(m0) || fillW.get(i) || 100;
    const mr = m0.querySelector('measure-style multiple-rest');
    out.push({ m: i, page, x: pt(x), y: pt(y), w: pt(w), h: pt(sysH) });
    if (mr) { restLeft = (parseInt(mr.textContent) || 1) - 1; restBox = out[out.length - 1]; }
    x += w;
  }
  return { measures: out, pages: page + 1 };
}

// rehearsal marks from the first part, by measure index
export function rehearsalMarks(xml) {
  const d = typeof xml === 'string' ? new DOMParser().parseFromString(xml, 'application/xml') : xml;
  const part = d.querySelector('score-partwise > part');
  if (!part) return [];
  const out = [];
  [...part.children].filter(c => c.tagName === 'measure').forEach((m, i) => {
    const r = m.querySelector('rehearsal');
    if (r && r.textContent.trim()) out.push({ measure: i, label: r.textContent.trim() });
  });
  return out;
}
