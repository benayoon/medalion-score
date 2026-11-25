// App state: settings, the library (all on the iPad), per-score user data, setlists, annotations.
import * as db from './db.js';
import { dupKey } from './music.js';
import { t } from './i18n.js';

export const DEFAULT_SETTINGS = {
  profileName: '',
  instrument: 'קלידים',
  partWords: 'piano, keys, keyboard, פסנתר, קלידים',
  keysNext: ['ArrowRight', 'ArrowDown', 'PageDown', ' '],
  keysPrev: ['ArrowLeft', 'ArrowUp', 'PageUp'],
  nextSide: 'right',       // tap side that turns forward
  theme: 'normal',          // normal | night | sepia
  twoUp: true,              // two pages side by side in landscape
  crop: true,               // auto-trim margins
  halfPage: false,          // half-page turns
  pencilOnly: true,         // only Apple Pencil draws; fingers still turn pages
  view: 'grid',
  sort: 'title',
  liveScale: 45,
  liveScroll: false,
  liveBigChords: false,     // MuseScore's chord size; on = 30% bigger
  liveLook: 2,              // live mode in MuseScore's look (fonts, sizes)
  liveLyrics: true,
  liveAllMeasureNumbers: false,
  countIn: true,
};

const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = what => listeners.forEach(fn => { try { fn(what); } catch (e) { console.error(e); } });

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  local: [],                         // the library: every song lives on the iPad
  meta: {},                          // per score user data
  setlists: [],
  templates: [],
};

export async function load() {
  const [settings, local, meta, setlists, templates] = await Promise.all(
    ['settings', 'local', 'meta', 'setlists', 'templates'].map(k => db.get(k)));
  Object.assign(state.settings, settings || {});
  // live mode now follows MuseScore's look: chords at MuseScore's size, unless chosen again after this
  if (settings && (settings.liveLook || 0) < 2) { state.settings.liveBigChords = false; state.settings.liveLook = 2; save('settings'); }
  state.local = (local || []).map(migrate);
  state.meta = meta || {};
  state.setlists = setlists || [];
  state.templates = templates || defaultTemplates();
  rev++;   // a song list read before the library was loaded is not kept
}

// songs imported by the first version (one PDF or one MusicXML each) become one-version songs
function migrate(s) {
  if (s.kind === 'song') return s;
  const v = { v: 1, date: s.created || Date.now(), pages: s.pages || 0, score: null, parts: [], xml: null, rehearsal: [] };
  if (s.kind === 'pdf') v.score = { pdfKey: s.pdfKey, pages: s.pages || 0, layout: null };
  if (s.kind === 'xml') v.xml = { key: s.xmlKey, zip: !!s.xmlZip };
  return {
    id: s.id, kind: 'song', title: s.title, composer: s.composer || '', keysig: s.keysig, tempo: s.tempo, timesig: s.timesig,
    instruments: s.instruments || [], thumb: s.thumb || null, fileName: s.title, created: s.created || Date.now(), updated: s.updated || Date.now(),
    versions: [v],
  };
}

function defaultTemplates() {
  return ['השבעה', 'טקס זיכרון', 'קבלת שבת', 'הופעה'].map((name, i) => ({ id: 'tpl' + i, name, items: [] }));
}

const saveTimers = {};
export function save(key) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => db.set(key, state[key]), 150);
  emit(key);
}
export async function saveNow(key) { clearTimeout(saveTimers[key]); await db.set(key, state[key]); emit(key); }
export function setSetting(k, v) { state.settings[k] = v; save('settings'); }

export function metaFor(id) {
  if (!state.meta[id]) state.meta[id] = { tags: [], fav: false, bookmarks: [] };
  return state.meta[id];
}
export function updateMeta(id, patch) { Object.assign(metaFor(id), patch); save('meta'); }

// ---------------------------------------------------------------- score list
let cache = null; let cacheSig = '';
let rev = 0;
onChange(w => { if (w === 'meta' || w === 'local') rev++; });
export function scores() {
  const sig = String(rev);
  if (cache && sig === cacheSig) return cache;
  const out = [];
  for (const s of state.local) {
    const m = metaFor(s.id);
    const latest = s.versions[s.versions.length - 1];
    const version = (m.pinnedV && s.versions.find(v => v.v === m.pinnedV)) || latest;
    out.push({
      ...s, version, latest,
      hasPdf: !!(version.score || version.parts.length), hasXml: !!version.xml,
      title: m.title || s.title, composer: m.composer ?? s.composer ?? '',
      keysig: m.keysig ?? s.keysig, tempo: m.tempo || s.tempo || 0, timesig: m.timesig || s.timesig || '',
      tags: m.tags || [], fav: !!m.fav, lastOpened: m.lastOpened || 0, instruments: s.instruments || [],
    });
  }
  const dups = {};
  for (const s of out) { const k = dupKey(s.title); dups[k] = (dups[k] || 0) + 1; }
  for (const s of out) s.duplicate = dups[dupKey(s.title)] > 1;
  cache = out; cacheSig = sig;
  return out;
}

export const scoreById = id => scores().find(s => s.id === id);
export const allTags = () => [...new Set(scores().flatMap(s => s.tags))].sort((a, b) => a.localeCompare(b, 'he'));

// ---------------------------------------------------------------- files (all in IndexedDB)
export async function blobBuffer(key) {
  const b = await db.getBlob(key);
  if (!b) throw new Error(t('הקובץ חסר באייפד – ייבא את השיר מחדש'));
  return b instanceof Blob ? b.arrayBuffer() : b;
}
// the PDF shown for a song: in the chosen key when MuseScore exported it, the chosen part, else the
// full score, else the first part
export function pdfRef(score, partName, semis = 0) {
  const v = (semis && (score.version.transposed || {})[semis]) || score.version;
  const part = partName ? v.parts.find(p => p.name === partName) : null;
  return part || v.score || v.parts[0] || null;
}
export async function loadXml(score) {
  const x = score.version.xml;
  if (!x) throw new Error(t('לשיר הזה אין MusicXML'));
  const b = await db.getBlob(x.key);
  if (!b) throw new Error(t('קובץ ה-MusicXML חסר באייפד'));
  if (x.zip) { const { unzipMusicXml } = await import('./zip.js'); return unzipMusicXml(await b.arrayBuffer()); }
  return typeof b === 'string' ? b : b.text();
}
export function versionKeys(v) {
  const t = Object.values(v.transposed || {}).flatMap(x => [x.score && x.score.pdfKey, ...x.parts.map(p => p.pdfKey)]);
  return [v.score && v.score.pdfKey, ...v.parts.map(p => p.pdfKey), v.xml && v.xml.key, v.mscz && v.mscz.key, ...t].filter(Boolean);
}
// keys of this song engraved by MuseScore (exact PDFs), as numbers
export const pdfKeys = score => Object.keys(score.version.transposed || {}).map(Number).filter(Boolean).sort((a, b) => a - b);
// the same song on every iPad: content of its MuseScore file (or of its PDFs), not the local id
export const versionHash = v => v ? String(v.sig || '').replace(/-f[^-]*$/, '') : null;
export const songHash = score => versionHash(score && score.version);
export function findByHash(hash) {
  if (!hash) return null;
  for (const s of state.local) for (const v of s.versions) if (versionHash(v) === hash) return { song: s, version: v };
  return null;
}
export async function deleteSong(id) {
  const s = state.local.find(x => x.id === id);
  if (!s) return;
  for (const v of s.versions) for (const k of versionKeys(v)) await db.delBlob(k);
  state.local = state.local.filter(x => x.id !== id);
  await db.del('ann:' + id);
  delete state.meta[id];
  save('meta'); save('local');
}

// ---------------------------------------------------------------- annotations (one record per score)
const annCache = new Map();
export async function annotations(id) {
  if (!annCache.has(id)) annCache.set(id, (await db.get('ann:' + id)) || { strokes: [] });
  return annCache.get(id);
}
export async function saveAnnotations(id) {
  await db.set('ann:' + id, annCache.get(id));
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
