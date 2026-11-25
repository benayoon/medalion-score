// Library: grid/list of songs, search (Hebrew + English), tags, filters, favorites, recent, duplicates.
import { h, $, icon, btn, toast, sheet, segmented, confirmBox, fmtDate, onLongPress, promptBox } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import { keyName, norm, ALL_KEYS, fmtDuration } from './music.js';
import { openViewer, currentViewer } from './viewer.js';
import { importFiles } from './importer.js';
import { renderSetlistsNav, openSetlist, newSetlist } from './setlists.js';
import { openSettings } from './settings.js';
import { audioCtx } from './metronome.js';
import { fmtDur } from './duration.js';
import { band, openBand, bandLabel, shareSong } from './band.js';
import { t } from './i18n.js';
import { withInst } from './instruments.js';

const ui = { q: '', tag: '', filter: 'all', key: '', tempoMin: '', tempoMax: '' };
let root = null;

export function renderLibrary() {
  root = document.getElementById('app');
  const st = store.state.settings;
  // no accept list: iPadOS greys out .musicxml/.mxl it has no type for; unknown files are skipped on import
  const file = h('input', { type: 'file', multiple: true, hidden: true });
  file.onchange = async () => { await importFiles(file.files); file.value = ''; };

  const search = h('input', { class: 'search', type: 'search', placeholder: t('חיפוש שיר, מלחין, תגית…'), value: ui.q, 'aria-label': t('חיפוש'), dir: 'auto' });
  search.oninput = () => { ui.q = search.value; renderGrid(); };

  const view = h('div', { class: 'lib' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 30, height: 30 }), h('div', {}, h('b', {}, 'Medalion'), h('span', {}, ' Score'))),
      h('nav', { class: 'side-nav' },
        navItem('all', t('כל השירים'), 'music'), navItem('fav', t('מועדפים'), 'star'), navItem('recent', t('נפתחו לאחרונה'), 'history'),
        navItem('dups', t('כפילויות'), 'copy')),
      h('div', { class: 'side-head' }, h('span', {}, t('סטליסטים')), btn('plus', t('סטליסט חדש'), () => newSetlist(), 'ghost small')),
      h('div', { class: 'side-setlists' }, renderSetlistsNav()),
      h('div', { class: 'side-foot' },
        h('button', { class: 'btn labeled ghost', title: t('טיונר'), 'aria-label': t('טיונר'), onclick: async () => { audioCtx(); (await import('./tuner.js')).openTuner(); } }, icon('tuner'), h('span', {}, t('טיונר'))),
        h('button', { class: 'btn labeled ghost', title: t('הגדרות'), 'aria-label': t('הגדרות'), onclick: () => openSettings() }, icon('gear'), h('span', {}, t('הגדרות'))))),
    h('main', { class: 'main' },
      h('header', { class: 'lib-head' },
        h('div', { class: 'search-wrap' }, icon('search'), search),
        // a filter in use shows what it is; otherwise only the icon
        filterOn() ? h('button', { class: 'btn labeled ghost on', onclick: () => filterSheet() }, icon('tag'), h('span', {}, filterLabel()))
          : btn('tag', t('סינון'), () => filterSheet(), 'ghost'),
        btn(st.view === 'grid' ? 'grid' : 'list', t('תצוגה|lib'), () => viewSheet(), 'ghost'),
        h('button', { class: 'btn ghost band-badge' + (band.role ? ' on' : ''), title: t('להקה'), 'aria-label': t('להקה'), onclick: () => openBand() }, icon('sync'), band.role ? h('span', {}, bandLabel()) : null),
        btn('plus', t('שיר חדש: קובץ תווים ריק לכתוב בו'), () => newSong(), 'ghost'),
        h('button', { class: 'btn labeled primary', onclick: () => file.click() }, icon('import'), h('span', {}, t('ייבוא'))), file),
      h('div', { class: 'tagbar' }),
      h('div', { class: 'grid ' + st.view })));
  root.replaceChildren(view);

  // drag & drop (iPad Split View / Mac browser)
  view.addEventListener('dragover', e => { e.preventDefault(); });
  view.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

  renderTagbar();
  renderGrid();
}

function navItem(id, label, ic) {
  return h('button', { class: 'nav-i' + (ui.filter === id ? ' on' : ''), onclick: () => { ui.filter = id; renderLibrary(); } }, icon(ic), h('span', {}, label));
}
const filterOn = () => ui.key !== '' || !!ui.tempoMin || !!ui.tempoMax;
// sort and layout together, in one place
function viewSheet() {
  const st = store.state.settings;
  const sh = sheet(t('תצוגה|lib'), h('div', {},
    h('div', { class: 'field' }, h('span', {}, t('מיון')),
      segmented([{ value: 'title', label: t('א–ב') }, { value: 'updated', label: t('עדכון') }], st.sort, v => { store.setSetting('sort', v); renderGrid(); })),
    h('div', { class: 'field' }, h('span', {}, t('פריסה')),
      segmented([{ value: 'grid', label: t('רשת') }, { value: 'list', label: t('רשימה') }], st.view, v => { store.setSetting('view', v); sh.close(); renderLibrary(); }))));
}
function filterLabel() {
  const parts = [];
  if (ui.key !== '') parts.push(keyName(+ui.key));
  if (ui.tempoMin || ui.tempoMax) parts.push(`${ui.tempoMin || '…'}–${ui.tempoMax || '…'} BPM`);
  return parts.length ? parts.join(' · ') : t('סינון');
}

function renderTagbar() {
  const bar = $('.tagbar'); if (!bar) return;
  const tags = store.allTags();
  bar.replaceChildren(...(tags.length ? [
    h('button', { class: 'chip' + (!ui.tag ? ' on' : ''), onclick: () => { ui.tag = ''; renderTagbar(); renderGrid(); } }, t('הכל')),
    ...tags.map(t => h('button', { class: 'chip' + (ui.tag === t ? ' on' : ''), onclick: () => { ui.tag = ui.tag === t ? '' : t; renderTagbar(); renderGrid(); } }, t)),
  ] : []));
}

function filtered() {
  let list = store.scores();
  const q = norm(ui.q);
  if (q) {
    const words = q.split(' ');
    list = list.filter(s => {
      const hay = norm([s.title, s.composer, s.subtitle, s.fileName, s.rel, (s.tags || []).join(' '), (s.instruments || []).join(' ')].join(' '));
      return words.every(w => hay.includes(w));
    });
  }
  if (ui.tag) list = list.filter(s => s.tags.includes(ui.tag));
  if (ui.filter === 'fav') list = list.filter(s => s.fav);
  if (ui.filter === 'recent') list = list.filter(s => s.lastOpened).sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 30);
  if (ui.filter === 'dups') list = list.filter(s => s.duplicate);
  if (ui.key !== '') list = list.filter(s => s.keysig != null && +s.keysig === +ui.key);
  if (ui.tempoMin) list = list.filter(s => s.tempo >= +ui.tempoMin);
  if (ui.tempoMax) list = list.filter(s => s.tempo && s.tempo <= +ui.tempoMax);
  if (ui.filter !== 'recent') {
    const sort = store.state.settings.sort;
    list = [...list].sort(sort === 'updated'
      ? (a, b) => (b.updated || 0) - (a.updated || 0)
      : (a, b) => a.title.localeCompare(b.title, 'he', { sensitivity: 'base' }));
  }
  return list;
}

export function renderGrid() {
  const grid = $('.grid'); if (!grid) return;
  const list = filtered();
  const st = store.state;
  if (!list.length) {
    const empty = !store.scores().length;
    grid.replaceChildren(h('div', { class: 'empty' },
      icon('music', 'big'),
      h('h3', {}, empty ? t('הספרייה עוד ריקה') : t('לא נמצאו שירים')),
      empty ? h('div', {},
        h('p', {}, t('ב-MuseScore: קובץ ← ייצוא ← PDF של הפרטיטורה והפרטים, ועוד MusicXML. שומרים ב-iCloud Drive.')),
        h('p', {}, t('כאן: "ייבוא" ובוחרים את כל הקבצים (או קובץ zip). הקבצים של אותו שיר מתקבצים לבד.')),
        h('button', { class: 'btn labeled primary', onclick: () => $('.lib-head input[type=file]').click() }, icon('import'), h('span', {}, t('ייבוא')))) : h('p', {}, t('נסה חיפוש אחר או נקה את הסינון.'))));
    return;
  }
  const isGrid = st.settings.view === 'grid';
  grid.replaceChildren(...list.map(s => isGrid ? card(s) : row(s)));
}

function badges(s) {
  return [
    s.keysig != null && s.keysig !== '' ? h('span', { class: 'b' }, keyName(s.keysig)) : null,
    s.tempo ? h('span', { class: 'b' }, s.tempo + '♩') : null,
    s.timesig ? h('span', { class: 'b' }, s.timesig) : null,
    s.version.dur && s.version.dur.s ? h('span', { class: 'b' }, (s.version.dur.exact ? '' : '≈') + fmtDur(s.version.dur.s)) : null,
    s.duplicate ? h('span', { class: 'b warn' }, t('כפול')) : null,
    !s.hasPdf ? h('span', { class: 'b' }, t('חי')) : null,
  ];
}

function thumbImg(s) {
  if (!s.thumb) return h('div', { class: 'thumb xml' }, icon('live', 'big'), h('span', {}, 'MusicXML'));
  return h('img', { class: 'thumb', src: s.thumb, alt: '', loading: 'lazy', decoding: 'async' });
}

function card(s) {
  // the sheet itself, clean; under it the title (a small gold star for a favorite) and one "more" button
  const el = h('div', { class: 'card', role: 'button', tabindex: 0, 'aria-label': s.title },
    h('div', { class: 'thumb-wrap' }, thumbImg(s)),
    h('div', { class: 'card-meta' },
      h('div', { class: 'card-title' },
        s.fav ? h('span', { class: 'ic fav-mark', html: starFill(), 'aria-label': t('מועדף') }) : null,
        h('b', { dir: 'auto' }, s.title),
        h('button', { class: 'card-more', 'aria-label': t('אפשרויות'), onclick: e => { e.stopPropagation(); scoreMenu(s); } }, icon('more'))),
      s.composer ? h('span', { class: 'muted', dir: 'auto' }, s.composer) : null,
      h('div', { class: 'badges' }, ...badges(s))));
  el.onclick = () => open(s);
  el.onkeydown = e => { if (e.key === 'Enter') open(s); };
  onLongPress(el, () => scoreMenu(s));
  return el;
}
const starFill = () => '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>';
const starLine = () => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>';

function row(s) {
  const el = h('div', { class: 'row-item', role: 'button', tabindex: 0 },
    h('div', { class: 'row-thumb' }, thumbImg(s)),
    h('div', { class: 'row-main' }, h('b', { dir: 'auto' }, s.title), h('span', { class: 'muted', dir: 'auto' }, [s.composer, (s.tags || []).join(' · ')].filter(Boolean).join(' — '))),
    h('div', { class: 'badges' }, ...badges(s)),
    h('span', { class: 'muted small' }, fmtDate(s.updated)),
    h('button', { class: 'fav' + (s.fav ? ' on' : ''), 'aria-label': t('מועדף'), html: s.fav ? starFill() : starLine(), onclick: e => { e.stopPropagation(); store.updateMeta(s.id, { fav: !s.fav }); renderGrid(); } }),
    h('button', { class: 'btn ghost', 'aria-label': t('אפשרויות'), onclick: e => { e.stopPropagation(); scoreMenu(s); } }, icon('more')));
  el.onclick = () => open(s);
  onLongPress(el, () => scoreMenu(s));
  return el;
}

// a new, empty song: made, then opened straight in the note editor
async function newSong() {
  const { openNewScore } = await import('./newscore.js');
  openNewScore(async id => {
    await openViewer({ scoreId: id, onClose: () => renderLibrary() });
    const v = currentViewer();
    if (v && v.scoreId === id) await v.startNoteEdit();
  });
}

function open(s) {
  openViewer({ scoreId: s.id, onClose: () => renderLibrary() });
}

function scoreMenu(s) {
  const sh = sheet(s.title, h('div', { class: 'list' },
    h('button', { class: 'li', onclick: () => { sh.close(); store.updateMeta(s.id, { fav: !s.fav }); renderGrid(); } }, icon(s.fav ? 'starFill' : 'star'), s.fav ? t('הסרה מהמועדפים') : t('הוספה למועדפים')),
    h('button', { class: 'li', onclick: () => { sh.close(); editDetails(s); } }, icon('edit'), t('עריכת פרטים ותגיות')),
    h('button', { class: 'li', onclick: () => { sh.close(); addToSetlist(s); } }, icon('setlist'), t('הוספה לסטליסט')),
    h('button', { class: 'li', onclick: () => { sh.close(); openViewer({ scoreId: s.id, perform: true, onClose: () => renderLibrary() }); } }, icon('perform'), t('פתיחה במצב הופעה')),
    band.role ? h('button', { class: 'li', onclick: () => { sh.close(); shareSong(s.id); } }, icon('sync'), band.role === 'leader' ? t('שליחה לכל הלהקה') : t('שליחה ללידר')) : null,
    h('div', { class: 'li static' }, icon('history'), h('span', { class: 'muted', dir: 'auto' }, [
      t('גרסה {v}', { v: s.version.v }) + (s.versions.length > 1 ? ' ' + t('({n} שמורות)', { n: s.versions.length }) : ''),
      s.version.pages ? t('{n} עמ׳', { n: s.version.pages }) : '',
      s.version.parts.length ? t('{n} פרטים', { n: s.version.parts.length }) : '',
      s.hasXml ? 'MusicXML' : t('בלי MusicXML'), fmtDate(s.updated)].filter(Boolean).join(' · '))),
    s.instruments && s.instruments.length ? h('div', { class: 'li static inst-chips' }, ...s.instruments.map(n => h('span', { class: 'inst-chip' }, withInst(n)))) : null,
    h('button', {
      class: 'li danger', onclick: async () => {
        sh.close();
        if (await confirmBox(t('למחוק את "{name}" מהאייפד, כולל ההערות שלו? אי אפשר לבטל.', { name: s.title }), t('מחיקה'), true)) {
          await store.deleteSong(s.id);
          for (const l of store.state.setlists) l.items = l.items.filter(it => it.scoreId !== s.id);
          store.save('setlists'); renderLibrary();
        }
      },
    }, icon('trash'), t('מחיקה'))));
}

function editDetails(s) {
  const m = store.metaFor(s.id);
  const f = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const title = h('input', { class: 'input', value: s.title, dir: 'auto' });
  const composer = h('input', { class: 'input', value: s.composer || '', dir: 'auto' });
  const key = h('select', { class: 'input' }, h('option', { value: '' }, '—'), ...ALL_KEYS.map(k => h('option', { value: k.fifths, selected: s.keysig != null && +s.keysig === k.fifths }, k.name)));
  const tempo = h('input', { class: 'input', type: 'number', value: s.tempo || '', inputmode: 'numeric' });
  const timesig = h('input', { class: 'input', value: s.timesig || '', placeholder: '4/4' });
  let tags = [...(m.tags || [])];
  const tagWrap = h('div', { class: 'tags-edit' });
  const allTags = [...new Set([...store.allTags(), 'שבת', 'טקסים', 'השבעה', 'זיכרון', 'הופעה'])];
  const paintTags = () => tagWrap.replaceChildren(
    ...allTags.map(t => h('button', { class: 'chip' + (tags.includes(t) ? ' on' : ''), onclick: () => { tags = tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t]; paintTags(); } }, t)),
    h('button', { class: 'chip add', onclick: async () => { const v = await promptBox(t('תגית חדשה')); if (v) { allTags.push(v); tags.push(v); paintTags(); } } }, t('+ תגית')));
  paintTags();
  const sh = sheet(t('פרטי שיר'), h('div', {},
    f(t('שם'), title), f(t('מלחין / מעבד'), composer),
    h('div', { class: 'row' }, f(t('טון'), key), f(t('טמפו'), tempo), f(t('משקל'), timesig)),
    h('div', { class: 'field' }, h('span', {}, t('תגיות')), tagWrap),
    h('div', { class: 'row end' }, h('button', {
      class: 'btn labeled primary', onclick: () => {
        store.updateMeta(s.id, {
          title: title.value.trim() && title.value.trim() !== store.state.local.find(x => x.id === s.id)?.title ? title.value.trim() : null,
          composer: composer.value.trim(), keysig: key.value === '' ? null : +key.value, tempo: +tempo.value || null,
          timesig: timesig.value.trim() || null, tags,
        });
        sh.close(); renderLibrary();
      },
    }, t('שמירה')))));
}

function addToSetlist(s) {
  const lists = store.state.setlists;
  const sh = sheet(t('הוספה לסטליסט'), h('div', { class: 'list' },
    ...lists.map(l => h('button', {
      class: 'li', onclick: () => {
        l.items.push({ uid: store.uid(), scoreId: s.id });
        store.save('setlists'); sh.close(); toast(t('נוסף ל"{name}"', { name: l.name })); renderLibrary();
      },
    }, icon('setlist'), l.name, h('span', { class: 'muted' }, ' · ' + t('{n} שירים', { n: l.items.length })))),
    h('button', { class: 'li', onclick: async () => { sh.close(); const l = await newSetlist(false); if (l) { l.items.push({ uid: store.uid(), scoreId: s.id }); store.save('setlists'); renderLibrary(); } } }, icon('plus'), t('סטליסט חדש'))));
}

function filterSheet() {
  const key = h('select', { class: 'input' }, h('option', { value: '' }, t('כל הטונים')), ...ALL_KEYS.map(k => h('option', { value: k.fifths, selected: ui.key !== '' && +ui.key === k.fifths }, k.name)));
  const tmin = h('input', { class: 'input', type: 'number', value: ui.tempoMin, placeholder: t('מ-'), inputmode: 'numeric' });
  const tmax = h('input', { class: 'input', type: 'number', value: ui.tempoMax, placeholder: t('עד'), inputmode: 'numeric' });
  const sh = sheet(t('סינון'), h('div', {},
    h('label', { class: 'field' }, h('span', {}, t('טון')), key),
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('טמפו מינימלי')), tmin), h('label', { class: 'field' }, h('span', {}, t('טמפו מקסימלי')), tmax)),
    h('div', { class: 'row end' },
      h('button', { class: 'btn labeled', onclick: () => { ui.key = ''; ui.tempoMin = ''; ui.tempoMax = ''; sh.close(); renderLibrary(); } }, t('ניקוי')),
      h('button', { class: 'btn labeled primary', onclick: () => { ui.key = key.value; ui.tempoMin = tmin.value; ui.tempoMax = tmax.value; sh.close(); renderLibrary(); } }, t('הצגה')))));
}
