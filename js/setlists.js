// Setlists: ordered songs with per-song key/part/tempo/transition note, medleys, templates, PDF export.
import { h, $, icon, btn, toast, sheet, confirmBox, promptBox, fmtDate } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import { keyAfter, keyName, semisLabel, norm } from './music.js';
import { openViewer } from './viewer.js';
import { band, shareSetlist } from './band.js';
import { pdfLib, canEngrave, engraveKey, prepareKeys } from './importer.js';
import { itemSeconds, fmtDur, parseDur, fillDurations } from './duration.js';
import { t, isHe } from './i18n.js';

const back = async () => (await import('./library.js')).renderLibrary();

export function renderSetlistsNav() {
  const lists = [...store.state.setlists].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
  if (!lists.length) return h('p', { class: 'hint side-hint' }, t('אין עדיין סטליסטים'));
  return lists.map(l => h('button', { class: 'nav-i', onclick: () => openSetlist(l.id) },
    icon('setlist'), h('span', { dir: 'auto' }, l.name), h('small', { class: 'muted' }, l.items.length)));
}

export async function newSetlist(openIt = true) {
  const tpls = store.state.templates;
  return new Promise(resolve => {
    const name = h('input', { class: 'input', placeholder: t('שם (למשל: טקס יום הזיכרון 2027)'), dir: 'auto' });
    const date = h('input', { class: 'input', type: 'date' });
    const place = h('input', { class: 'input', placeholder: t('מקום'), dir: 'auto' });
    let tpl = null;
    const tplWrap = h('div', { class: 'chips' }, ...tpls.map(t => {
      const b = h('button', { class: 'chip' }, t.name + (t.items.length ? ` (${t.items.length})` : ''));
      b.onclick = () => { tpl = tpl === t ? null : t; tplWrap.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); if (tpl) { b.classList.add('on'); if (!name.value) name.value = t.name; } };
      return b;
    }));
    let done = false;
    const create = () => {
      done = true;
      const l = {
        id: store.uid(), name: name.value.trim() || (tpl ? tpl.name : t('סטליסט חדש')), date: date.value, place: place.value.trim(),
        template: tpl ? tpl.name : '', created: Date.now(),
        items: tpl ? tpl.items.map(i => ({ ...i, uid: store.uid() })).filter(i => store.scoreById(i.scoreId)) : [],
      };
      store.state.setlists.push(l); store.save('setlists');
      sh.close();
      if (openIt) openSetlist(l.id);
      resolve(l);
    };
    const sh = sheet(t('סטליסט חדש'), h('div', {},
      h('label', { class: 'field' }, h('span', {}, t('שם')), name),
      h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('תאריך האירוע')), date), h('label', { class: 'field' }, h('span', {}, t('מקום')), place)),
      h('div', { class: 'field' }, h('span', {}, t('התחלה מתבנית')), tplWrap),
      h('div', { class: 'row end' }, h('button', { class: 'btn labeled primary', onclick: create }, t('יצירה')))),
    { onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => name.focus(), 250);
  });
}

export function openSetlist(id) {
  const l = store.state.setlists.find(x => x.id === id);
  if (!l) return back();
  const app = document.getElementById('app');
  const list = h('ol', { class: 'sl-list' });
  const head = h('header', { class: 'sl-head' },
    btn('back', t('חזרה'), () => back(), 'ghost'),
    h('div', { class: 'sl-title' },
      h('h1', { dir: 'auto', onclick: async () => { const n = await promptBox(t('שם הסטליסט'), l.name); if (n) { l.name = n; store.save('setlists'); openSetlist(id); } } }, l.name),
      h('span', { class: 'muted' }, [l.date && fmtDate(l.date), l.place, t('{n} שירים', { n: l.items.length }), setLength(l)].filter(Boolean).join(' · '))),
    h('div', { class: 'sl-actions' },
      h('button', { class: 'btn labeled', onclick: () => pickSongs(l, () => openSetlist(id)) }, icon('plus'), h('span', {}, t('הוספת שירים'))),
      h('button', { class: 'btn labeled', onclick: () => exportPdf(l) }, icon('share'), h('span', {}, 'PDF')),
      btn('more', t('עוד'), () => setlistMenu(l), 'ghost'),
      h('button', { class: 'btn labeled primary', onclick: () => l.items.length && openViewer({ setlistId: l.id, index: 0, perform: true, onClose: () => openSetlist(id) }) }, icon('perform'), h('span', {}, t('מצב הופעה')))));
  app.replaceChildren(h('div', { class: 'setlist' }, head, list,
    !l.items.length ? h('div', { class: 'empty' }, icon('setlist', 'big'), h('h3', {}, t('הסטליסט ריק')), h('p', {}, t('הוסף שירים מהספרייה.'))) : null));
  renderItems(l, list);
  // songs without a stored length get one from their MusicXML, then the list is drawn again
  if (l.items.some(it => { const x = store.scoreById(it.scoreId); return x && x.version.dur === undefined && x.version.xml; }))
    fillDurations(l.items.map(it => it.scoreId)).then(n => { if (n && document.querySelector('.setlist')) openSetlist(id); });
}

// "≈ 48:30" for the whole set (≈ when a song's length is estimated or missing)
function setLength(l) {
  if (!l.items.length) return '';
  let sec = 0, exact = true, known = 0;
  for (const it of l.items) { const d = itemSeconds(it); if (d) { sec += d.sec; known++; exact = exact && d.exact; } else exact = false; }
  if (!known) return '';
  return (exact ? '' : '≈ ') + fmtDur(sec) + (known < l.items.length ? ' ' + t('({n} בלי אורך)', { n: l.items.length - known }) : '');
}

function renderItems(l, list) {
  const rows = l.items.map((it, i) => {
    const s = store.scoreById(it.scoreId);
    const meta = store.metaFor(it.scoreId);
    const semis = it.semis ?? meta.semis ?? 0;
    const prevMed = i > 0 && it.medley && l.items[i - 1].medley === it.medley;
    const nextMed = i < l.items.length - 1 && it.medley && l.items[i + 1].medley === it.medley;
    const li = h('li', { class: 'sl-item' + (it.medley ? ' medley' : '') + (prevMed ? ' med-cont' : '') + (nextMed ? ' med-next' : ''), 'data-i': i },
      h('span', { class: 'handle', 'aria-label': t('גרירה לסידור') }, icon('drag')),
      h('span', { class: 'num' }, i + 1),
      h('div', { class: 'sl-main', onclick: () => openViewer({ setlistId: l.id, index: i, onClose: () => openSetlist(l.id) }) },
        h('b', { dir: 'auto' }, s ? s.title : t('שיר שנמחק')),
        h('span', { class: 'muted', dir: 'auto' }, [
          it.medley && !prevMed ? t('מחרוזת: {name}', { name: it.medley }) : null,
          it.part || meta.part ? t('פרט: {part}', { part: it.part ?? meta.part }) : null,
          it.note ? '“' + it.note + '”' : null,
        ].filter(Boolean).join(' · '))),
      h('div', { class: 'badges' },
        s && s.keysig != null ? h('span', { class: 'b' + (semis ? ' accent' : '') }, keyAfter(s.keysig, semis)) : semis ? h('span', { class: 'b accent' }, semisLabel(semis)) : null,
        (it.tempo || (s && s.tempo)) ? h('span', { class: 'b' + (it.tempo ? ' accent' : '') }, (it.tempo || s.tempo) + '♩') : null,
        (d => d ? h('span', { class: 'b' + (it.length ? ' accent' : ''), dir: 'ltr' }, (d.exact ? '' : '≈') + fmtDur(d.sec)) : null)(itemSeconds(it, s))),
      btn('edit', t('הגדרות לשיר'), () => itemSheet(l, i), 'ghost'),
      btn('copy', t('שכפול'), () => { l.items.splice(i + 1, 0, { ...it, uid: store.uid() }); store.save('setlists'); openSetlist(l.id); }, 'ghost'),
      btn('trash', t('הסרה'), () => { l.items.splice(i, 1); store.save('setlists'); openSetlist(l.id); }, 'ghost'));
    return li;
  });
  list.replaceChildren(...rows);
  enableDrag(list, (from, to) => {
    const [x] = l.items.splice(from, 1); l.items.splice(to, 0, x); store.save('setlists'); openSetlist(l.id);
  });
}

// pointer-based drag reorder (HTML5 drag & drop does not work with touch on iPad)
function enableDrag(list, onMove) {
  list.querySelectorAll('.handle').forEach(hd => {
    hd.addEventListener('pointerdown', e => {
      e.preventDefault();
      const li = hd.closest('li'); const from = +li.dataset.i;
      const items = [...list.children]; const rects = items.map(x => x.getBoundingClientRect());
      const y0 = e.clientY; let to = from;
      li.classList.add('dragging'); hd.setPointerCapture(e.pointerId);
      const move = ev => {
        const dy = ev.clientY - y0;
        li.style.transform = `translateY(${dy}px)`;
        const cy = rects[from].top + rects[from].height / 2 + dy;
        to = rects.findIndex(r => cy < r.bottom); if (to < 0) to = items.length - 1;
        items.forEach((x, k) => {
          if (x === li) return;
          const shift = from < to && k > from && k <= to ? -rects[from].height : from > to && k >= to && k < from ? rects[from].height : 0;
          x.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const up = () => {
        hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); hd.removeEventListener('pointercancel', up);
        items.forEach(x => { x.style.transform = ''; }); li.classList.remove('dragging');
        if (to !== from) onMove(from, to);
      };
      hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up); hd.addEventListener('pointercancel', up);
    });
  });
}

function itemSheet(l, i) {
  const it = l.items[i];
  const s = store.scoreById(it.scoreId);
  const meta = store.metaFor(it.scoreId);
  const semisSel = h('select', { class: 'input' }, ...Array.from({ length: 13 }, (_, k) => k - 6).map(v =>
    h('option', { value: v, selected: (it.semis ?? meta.semis ?? 0) === v }, (s && s.keysig != null ? keyAfter(s.keysig, v) + '  ' : '') + `(${semisLabel(v)})`)));
  const parts = s ? (s.version.parts.length ? s.version.parts.map(p => p.name) : s.instruments || []) : [];
  const partSel = h('select', { class: 'input' }, h('option', { value: '__default' }, t('ברירת מחדל')), h('option', { value: '', selected: it.part === '' }, t('פרטיטורה מלאה')),
    ...parts.map(p => h('option', { value: p, selected: it.part === p }, p)));
  const tempo = h('input', { class: 'input', type: 'number', value: it.tempo || '', placeholder: String((s && s.tempo) || ''), inputmode: 'numeric' });
  const auto = itemSeconds({ ...it, length: null }, s);
  const length = h('input', { class: 'input', value: it.length ? fmtDur(it.length) : '', placeholder: auto ? fmtDur(auto.sec) : t('דקות:שניות'), dir: 'ltr', inputmode: 'decimal' });
  const note = h('input', { class: 'input', value: it.note || '', placeholder: t('למשל: צמוד לשיר הבא / עצירה לנאום'), dir: 'auto' });
  const quick = h('div', { class: 'chips' }, ...[t('צמוד לשיר הבא'), t('עצירה לנאום'), t('פתיחה בתופים'), t('אטאקה'), t('לחכות לסימן')].map(t =>
    h('button', { class: 'chip', onclick: () => { note.value = t; } }, t)));
  const medleys = [...new Set(l.items.map(x => x.medley).filter(Boolean))];
  const medley = h('input', { class: 'input', value: it.medley || '', placeholder: t('שם מחרוזת (שירים צמודים עם אותו שם)'), list: 'medleys', dir: 'auto' });
  const dl = h('datalist', { id: 'medleys' }, ...medleys.map(m => h('option', { value: m })));
  const sh = sheet(s ? s.title : t('שיר'), h('div', {},
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('טון')), semisSel), h('label', { class: 'field' }, h('span', {}, t('פרט')), partSel), h('label', { class: 'field' }, h('span', {}, t('טמפו')), tempo), h('label', { class: 'field' }, h('span', {}, t('אורך')), length)),
    h('label', { class: 'field' }, h('span', {}, t('הערת מעבר')), note), quick,
    h('label', { class: 'field' }, h('span', {}, t('מחרוזת')), medley), dl,
    h('div', { class: 'row end' }, h('button', {
      class: 'btn labeled primary', onclick: () => {
        it.semis = +semisSel.value;
        if (partSel.value === '__default') delete it.part; else it.part = partSel.value;
        it.tempo = +tempo.value || null; it.note = note.value.trim(); it.medley = medley.value.trim() || null;
        it.length = parseDur(length.value) || null;
        store.save('setlists'); sh.close(); openSetlist(l.id);
        // a new key is engraved by MuseScore in the background, ready for the gig
        if (it.semis) prepareKeys(it.scoreId);
      },
    }, t('שמירה')))));
}

function pickSongs(l, done) {
  const chosen = new Set();
  const q = h('input', { class: 'input search', type: 'search', placeholder: t('חיפוש…'), dir: 'auto' });
  const list = h('div', { class: 'list pick' });
  const paint = () => {
    const w = norm(q.value);
    const all = store.scores().filter(s => !w || norm(s.title + ' ' + (s.composer || '') + ' ' + s.tags.join(' ')).includes(w))
      .sort((a, b) => a.title.localeCompare(b.title, 'he'));
    list.replaceChildren(...all.map(s => h('button', {
      class: 'li' + (chosen.has(s.id) ? ' on' : ''), onclick: e => { chosen.has(s.id) ? chosen.delete(s.id) : chosen.add(s.id); e.currentTarget.classList.toggle('on'); count.textContent = t('הוספה ({n})', { n: chosen.size }); },
    }, h('span', { dir: 'auto' }, s.title), h('span', { class: 'muted' }, s.composer || ''))));
  };
  q.oninput = paint; paint();
  const count = h('button', { class: 'btn labeled primary' }, t('הוספה ({n})', { n: 0 }));
  count.onclick = () => {
    for (const id of chosen) l.items.push({ uid: store.uid(), scoreId: id });
    store.save('setlists'); sh.close(); done();
  };
  const sh = sheet(t('הוספת שירים'), h('div', {}, q, list, h('div', { class: 'row end sticky' }, count)), { wide: true });
}

function setlistMenu(l) {
  const sh = sheet(l.name, h('div', { class: 'list' },
    h('button', {
      class: 'li', onclick: async () => {
        sh.close(); const n = await promptBox(t('שם לעותק'), t('{name} (עותק)', { name: l.name })); if (!n) return;
        const c = { ...JSON.parse(JSON.stringify(l)), id: store.uid(), name: n, created: Date.now() };
        c.items.forEach(i => { i.uid = store.uid(); });
        store.state.setlists.push(c); store.save('setlists'); openSetlist(c.id);
      },
    }, icon('copy'), t('שכפול הסטליסט')),
    h('button', {
      class: 'li', onclick: async () => {
        sh.close(); const n = await promptBox(t('שם התבנית'), l.template || l.name); if (!n) return;
        const ex = store.state.templates.find(t => t.name === n);
        const items = l.items.map(({ uid, ...rest }) => rest);
        if (ex) ex.items = items; else store.state.templates.push({ id: store.uid(), name: n, items });
        store.save('templates'); toast(t('נשמר כתבנית'));
      },
    }, icon('bookmark'), t('שמירה כתבנית')),
    h('button', { class: 'li', onclick: () => { sh.close(); exportKeysList(); } }, icon('key'), t('רשימת טונים ל-MuseScore')),
    band.role === 'leader' ? h('button', { class: 'li', onclick: () => { sh.close(); shareSetlist(l.id); } }, icon('sync'), t('שליחה לכל הלהקה')) : null,
    h('button', {
      class: 'li danger', onclick: async () => {
        sh.close();
        if (await confirmBox(t('למחוק את "{name}"? השירים עצמם נשארים בספרייה.', { name: l.name }), t('מחיקה'), true)) {
          store.state.setlists = store.state.setlists.filter(x => x.id !== l.id); store.save('setlists'); back();
        }
      },
    }, icon('trash'), t('מחיקת הסטליסט'))));
}

// ---------------------------------------------------------------- one PDF for print / WhatsApp
async function exportPdf(l) {
  if (!l.items.length) return;
  toast('מכין PDF…', 20000);
  try {
    // keys not engraved yet: MuseScore writes them now (songs imported as .mscz)
    for (const it of l.items) {
      const s = store.scoreById(it.scoreId);
      const sm = s ? it.semis ?? store.metaFor(s.id).semis ?? 0 : 0;
      if (sm && canEngrave(s) && !store.pdfKeys(s).includes(sm)) await engraveKey(s.id, sm).catch(e => console.warn(e));
    }
    toast('מכין PDF…', 20000);
    const { PDFDocument } = await pdfLib();
    const out = await PDFDocument.create();
    // cover page drawn on a canvas (standard PDF fonts have no Hebrew)
    const cover = await coverPng(l);
    const img = await out.embedPng(cover);
    const p = out.addPage([595, 842]); p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    let missing = 0; let original = 0;
    for (const it of l.items) {
      const s = store.scoreById(it.scoreId);
      const sm = s ? it.semis ?? store.metaFor(s.id).semis ?? 0 : 0;
      if (sm && !store.pdfKeys(s).includes(sm)) original++;
      const buf = s && await pdfFor(s, it).catch(() => null);
      if (!buf) { missing++; continue; }
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(pg => out.addPage(pg));
    }
    const bytes = await out.save();
    const file = new File([bytes], `${l.name}.pdf`, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const shared = await navigator.share({ files: [file], title: l.name }).then(() => true, e => { if (e.name !== 'AbortError') toast(t('השיתוף נכשל: {msg}', { msg: e.message })); return false; });
      if (!shared) return;
    } else {
      const a = h('a', { href: URL.createObjectURL(file), download: file.name }); a.click();
    }
    toast([t('ה-PDF מוכן'), missing ? t('{n} שירים בלי PDF לא נכללו', { n: missing }) : '', original ? t('{n} שירים בטון אחר מופיעים ב-PDF בטון המקורי', { n: original }) : ''].filter(Boolean).join(' · '), 5000);
  } catch (e) {
    console.error(e); toast(t('הייצוא נכשל: {msg}', { msg: e.message }));
  }
}

async function pdfFor(s, it) {
  const meta = store.metaFor(s.id);
  const ref = store.pdfRef(s, it.part ?? meta.part ?? '', it.semis ?? meta.semis ?? 0);
  return ref ? store.blobBuffer(ref.pdfKey) : null;
}

async function coverPng(l) {
  const c = document.createElement('canvas'); c.width = 1190; c.height = 1684;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  // Hebrew: titles from the right margin, keys at the left; English: mirrored
  const he = isHe(), A = he ? 'right' : 'left', B = he ? 'left' : 'right', XA = he ? 1090 : 100, XB = he ? 100 : 1090;
  x.direction = he ? 'rtl' : 'ltr'; x.textAlign = A; x.fillStyle = '#111';
  x.font = 'bold 64px -apple-system, "Helvetica Neue", Arial';
  x.fillText(l.name, XA, 160);
  x.font = '32px -apple-system, Arial'; x.fillStyle = '#666';
  x.fillText([l.date && fmtDate(l.date), l.place].filter(Boolean).join(' · '), XA, 215);
  x.fillStyle = '#111'; x.font = '36px -apple-system, Arial';
  let y = 320;
  l.items.forEach((it, i) => {
    const s = store.scoreById(it.scoreId);
    const semis = it.semis ?? store.metaFor(it.scoreId).semis ?? 0;
    // the PDFs are in the original key: say so next to songs played in another key
    const orig = semis && !store.pdfKeys(s).includes(semis);
    const key = s && s.keysig != null ? keyAfter(s.keysig, semis) + (orig ? ' ' + t('(בדף: {key})', { key: keyName(s.keysig) }) : '') : semis ? semisLabel(semis) : '';
    x.fillText(`${i + 1}.  ${s ? s.title : '?'}`, XA, y);
    x.textAlign = B; x.fillStyle = '#666';
    x.fillText([key, it.note].filter(Boolean).join('  ·  '), XB, y);
    x.textAlign = A; x.fillStyle = '#111';
    y += 62;
  });
  return new Promise(r => c.toBlob(b => b.arrayBuffer().then(r), 'image/png'));
}

// ---------------------------------------------------------------- keys list for the Mac export script
// Every key chosen for a song (in any setlist, or on the song itself) that MuseScore has not exported yet.
// Saved into iCloud Drive › Medalion Score, the export script engraves those keys in the original layout.
export function wantedKeys({ missingOnly = false, withIds = false } = {}) {
  const want = new Map();
  const add = (id, semis) => {
    const s = store.scoreById(id);
    if (!s || !semis || (missingOnly && store.pdfKeys(s).includes(semis))) return;
    if (!want.has(id)) want.set(id, { ...(withIds ? { id } : {}), file: s.fileName || s.title, title: s.title, keys: new Set() });
    want.get(id).keys.add(semis);
  };
  for (const l of store.state.setlists) for (const it of l.items) add(it.scoreId, it.semis ?? store.metaFor(it.scoreId).semis ?? 0);
  for (const s of store.scores()) add(s.id, store.metaFor(s.id).semis || 0);
  return [...want.values()].map(w => ({ ...w, keys: [...w.keys].sort((a, b) => a - b) }));
}

export async function exportKeysList() {
  const songs = wantedKeys();
  if (!songs.length) return toast(t('אין בסטליסטים שירים בטון אחר'));
  const missing = wantedKeys({ missingOnly: true }).reduce((n, s) => n + s.keys.length, 0);
  const data = { app: 'medalion-keys', version: 1, date: Date.now(), songs };
  const file = new File([JSON.stringify(data, null, 1)], t('טונים מהאייפד') + '.json', { type: 'application/json' });
  const tip = t('שמור ב-iCloud Drive › Medalion Score, ואז הרץ במק את סקריפט הייצוא');
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const ok = await navigator.share({ files: [file] }).then(() => true, e => { if (e.name !== 'AbortError') toast(t('השיתוף נכשל: {msg}', { msg: e.message })); return false; });
    if (!ok) return;
  } else {
    const a = h('a', { href: URL.createObjectURL(file), download: file.name }); a.click();
  }
  toast(t('{n} טונים ברשימה ({missing} עוד בלי PDF). {tip}', { n: songs.reduce((n, s) => n + s.keys.length, 0), missing, tip }), 6000);
}
