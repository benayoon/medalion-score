// Import on the iPad. A MuseScore file (.mscz) is engraved right here by MuseScore itself (webmscore):
// the full score, every part and MusicXML, exactly as MuseScore exports them; any other key is engraved
// the same way when it is chosen. Files exported from MuseScore work too, grouped into songs by name:
//   Song.pdf (full score) · Song-Trumpet in B♭.pdf (parts) · Song.musicxml / .mxl (live mode, keys, layout)
//   Song-Piano.musicxml (optional: lets pencil marks follow measures in that part too)
//   Song@+2.pdf, Song@+2-Trumpet in B♭.pdf, Song@+2.musicxml (the song engraved by MuseScore in another key;
//   attached to the song, shown instead of live mode when that key is chosen)
// A .zip with many of these (a whole library) works too. Importing a song that already exists
// adds a new version; the last few are kept. Photos of pages become one PDF song.
import * as store from './store.js';
import * as db from './db.js';
import { toast } from './ui.js';
import { t } from './i18n.js';
import { thumbnail, pdfjs } from './pdfdoc.js';
import { readZip, unzipMusicXml } from './zip.js';
import { layoutFromMusicXml, rehearsalMarks } from './layout.js';
import { engraveMscz, fontsChanged, fontsSig } from './engrave.js';
import { xmlSeconds } from './duration.js';
import { concertInfo, concertSummary } from './concert.js';

const KEEP_VERSIONS = 4;
const ext = n => (n.split('.').pop() || '').toLowerCase();
const baseOf = n => n.split('/').pop().replace(/\.[^.]+$/, '').normalize('NFC').trim();
const SEP = /^\s*[-–_]\s*/;
const keyOf = s => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

export async function importFiles(fileList, { sig = null, quiet = false } = {}) {
  let files = [...fileList].map(f => ({ name: f.name.normalize('NFC'), blob: async () => f, file: f }));
  // expand zips
  const zips = files.filter(f => ext(f.name) === 'zip');
  files = files.filter(f => ext(f.name) !== 'zip');
  for (const z of zips) {
    try { files.push(...readZip(await z.file.arrayBuffer()).map(e => ({ name: e.name, blob: () => e.blob() }))); }
    catch (e) { console.error(e); toast(t('לא הצלחתי לפתוח את {name}', { name: z.name })); }
  }
  const images = files.filter(f => ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'].includes(ext(f.name)) || (f.file && f.file.type.startsWith('image/')));
  const mscz = files.filter(f => ext(f.name) === 'mscz');
  const fontFiles = files.filter(f => ['ttf', 'otf', 'ttc'].includes(ext(f.name)));
  const docs = files.filter(f => ['pdf', 'mxl', 'musicxml', 'xml'].includes(ext(f.name)));
  const other = files.filter(f => !images.includes(f) && !mscz.includes(f) && !docs.includes(f) && !fontFiles.includes(f));

  if (fontFiles.length) await importFonts(fontFiles);
  if (other.length) toast(t('דילגתי על {n} קבצים שאינם תווים', { n: other.length }));

  const report = { added: 0, updated: 0, same: 0, failed: 0, keys: 0 };
  const count = r => { if (r.status !== 'keys') report[r.status]++; report.keys += r.keys; };
  // song names: the file name; "Untitled score" takes its folder's name, and the same name in two
  // folders (inside a zip) gets the folder name too, like the Mac export script
  const folderOf = n => n.split('/').slice(-2, -1)[0] || '';
  const roots = mscz.map(f => /^untitled( score)?( \d+)?$/i.test(baseOf(f.name)) && folderOf(f.name) ? folderOf(f.name) : baseOf(f.name));
  roots.forEach((r, i) => { if (roots.filter(x => keyOf(x) === keyOf(r)).length > 1 && folderOf(mscz[i].name)) roots[i] = `${r} (${folderOf(mscz[i].name)})`; });
  for (let i = 0; i < mscz.length; i++) {
    const f = mscz[i];
    try { count(await importMscz(f, i, mscz.length, roots[i])); }
    catch (e) { console.error(e); report.failed++; toast(t('הייבוא של {name} נכשל: {msg}', { name: baseOf(f.name), msg: e.message }), 5000); }
  }
  if (docs.length) {
    const groups = await groupFiles(docs);
    let i = 0;
    // a song received from another iPad keeps its identity there (its PDFs' signature)
    if (sig && groups.length === 1) groups[0].sig = sig;
    for (const g of groups) {
      i++;
      if (groups.length > 3) toast(t('מייבא {i}/{n}: {name}', { i, n: groups.length, name: g.root }), 1500);
      try { count(await addSong(g)); } catch (e) { console.error(e); report.failed++; toast(t('הייבוא של {name} נכשל: {msg}', { name: g.root, msg: e.message })); }
    }
  }
  if (images.length) {
    const name = images.length === 1 ? baseOf(images[0].name) : baseOf(images[0].name) + ' ' + t('({n} עמ׳)', { n: images.length });
    try {
      const pdf = await imagesToPdf(await Promise.all(images.map(f => f.blob())));
      count(await addSong({ root: name, score: { buf: pdf }, parts: [], xml: null, partXml: {}, keys: {} }));
    } catch (err) { console.error(err); toast(t('המרת התמונות נכשלה')); report.failed++; }
  }
  await store.saveNow('local');
  // songs engraved before these fonts arrived are engraved again, with them
  if (fontFiles.length) reengraveAll().catch(e => console.warn(e));
  const msg = [
    report.added ? (report.added === 1 ? t('שיר אחד נוסף') : t('{n} שירים נוספו', { n: report.added })) : '',
    report.updated ? t('{n} עודכנו לגרסה חדשה', { n: report.updated }) : '',
    report.same ? t('{n} כבר היו בספרייה בלי שינוי', { n: report.same }) : '',
    report.keys ? t('{n} טונים מ-MuseScore נוספו', { n: report.keys }) : '',
    report.failed ? t('{n} נכשלו', { n: report.failed }) : '',
  ].filter(Boolean).join(' · ');
  if (msg && !quiet) toast(msg, 4000);
  return report;
}

// ---------------------------------------------------------------- grouping
async function groupFiles(docs) {
  const entries = [];
  for (const f of docs) {
    const e = { name: f.name, base: baseOf(f.name), semis: 0, type: ext(f.name) === 'pdf' ? 'pdf' : 'xml', get: f.blob };
    // "Song@+2" / "Song@-3-Piano": the same song in another key
    const km = e.base.match(/^(.*?\S)@([+-]\d{1,2})(?=$|\s*[-–_])(.*)$/);
    if (km && Math.abs(+km[2]) <= 6 && +km[2] !== 0) { e.base = km[1] + km[3]; e.semis = +km[2]; }
    if (e.type === 'xml') {
      const blob = await f.blob();
      e.text = ext(f.name) === 'mxl' ? await unzipMusicXml(await blob.arrayBuffer()) : await blob.text();
      e.info = readXmlInfo(e.text);
    }
    entries.push(e);
  }
  // a name is a part of another when it is "<other name><separator><part name>"
  // When the other name has MusicXML, the suffix must be one of its part names: "וזכני - צ׳ארט" is
  // a song of its own next to "וזכני", not a part of it.
  const bases = [...new Set(entries.map(e => e.base))].sort((a, b) => a.length - b.length);
  const xmlOf = b => entries.find(e => e.base === b && e.type === 'xml' && !e.semis) || entries.find(e => e.base === b && e.type === 'xml');
  const rootOf = new Map(); const partOf = new Map();
  const roots = [];
  for (const b of bases) {
    let best = null;
    for (const r of roots) {
      const rest = b.slice(r.length);
      const part = rest.replace(SEP, '').trim();
      if (!(b.length > r.length && b.startsWith(r) && SEP.test(rest) && part)) continue;
      const rx = xmlOf(r); const own = xmlOf(b);
      if (rx ? !rx.info.parts.some(p => nameKey(p) === nameKey(part)) : own && own.info.parts.length > 1) continue;
      if (!best || r.length > best.length) best = r;
    }
    if (best) { rootOf.set(b, best); partOf.set(b, b.slice(best.length).replace(SEP, '').trim()); }
    else { roots.push(b); rootOf.set(b, b); }
  }
  // parts exported without their score: "Song-Piano.pdf" + "Song-Bass.pdf" → one song "Song"
  const orphanPrefix = new Map();
  for (const b of roots) {
    const m = b.match(/^(.*\S)\s*[-–]\s*([^-–]+)$/);
    const own = xmlOf(b);
    // a full score of its own (MusicXML whose parts are not just this one) stays a song of its own
    if (m && !(own && !(own.info.parts.length === 1 && nameKey(own.info.parts[0]) === nameKey(m[2])))) {
      const list = orphanPrefix.get(m[1]) || []; list.push([b, m[2].trim()]); orphanPrefix.set(m[1], list);
    }
  }
  for (const [prefix, list] of orphanPrefix) {
    if (list.length < 2) continue;
    for (const [b, part] of list) { rootOf.set(b, prefix); partOf.set(b, part); }
  }
  const groups = new Map();
  const newSet = root => ({ root, score: null, parts: [], xml: null, partXml: {}, keys: {} });
  for (const e of entries) {
    const root = rootOf.get(e.base);
    const main = groups.get(root) || newSet(root);
    groups.set(root, main);
    const g = e.semis ? (main.keys[e.semis] = main.keys[e.semis] || newSet(root)) : main;
    const part = partOf.get(e.base);
    if (e.type === 'pdf') { if (part) g.parts.push({ name: part, get: e.get }); else g.score = { get: e.get }; }
    else if (part) g.partXml[part] = e.text;
    else g.xml = { text: e.text, info: e.info };
  }
  // part order: as in the score
  for (const main of groups.values()) for (const g of [main, ...Object.values(main.keys)]) {
    const x = g.xml || main.xml;
    const order = x ? x.info.parts : [];
    const idx = n => { const i = order.findIndex(p => nameKey(p) === nameKey(n)); return i < 0 ? 999 : i; };
    g.parts.sort((a, b) => idx(a.name) - idx(b.name) || a.name.localeCompare(b.name));
  }
  return [...groups.values()];
}
const nameKey = s => s.normalize('NFC').toLowerCase().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- one song
const hasFiles = g => !!(g.score || g.parts.length || g.xml);

async function addSong(g) {
  let status = null; let song; let version;
  if (hasFiles(g)) ({ status, song, version } = await addMain(g));
  else {
    song = store.state.local.find(s => keyOf(s.fileName || s.title) === keyOf(g.root));
    if (!song) throw new Error(t('השיר המקורי עוד לא בספרייה – ייבא אותו קודם'));
    version = song.versions[song.versions.length - 1];
  }
  let keys = 0;
  for (const [semis, kg] of Object.entries(g.keys || {})) if (await attachKey(song, version, +semis, kg)) keys++;
  if (keys) store.save('local');
  return { status: status || (keys ? 'keys' : 'same'), keys };
}

async function readSet(g) {
  const bufs = [];
  const scoreBuf = g.score ? (g.score.buf || await (await g.score.get()).arrayBuffer()) : null;
  if (scoreBuf) bufs.push(scoreBuf);
  const partBufs = [];
  for (const p of g.parts) { const b = await (await p.get()).arrayBuffer(); partBufs.push(b); bufs.push(b); }
  const enc = new TextEncoder();
  if (g.xml) bufs.push(enc.encode(g.xml.text));
  for (const t of Object.values(g.partXml)) bufs.push(enc.encode(t));
  return { scoreBuf, partBufs, sig: bufs.length ? await signature(bufs) : null };
}

// PDFs of one key (score + parts) into IndexedDB, with measure layout from the MusicXML of that key
async function storeSet(pre, g, { scoreBuf, partBufs }, xmlDoc, wantThumb) {
  const set = { score: null, parts: [], pages: 0, thumb: null };
  if (scoreBuf) {
    const t = wantThumb ? await thumbnail(scoreBuf) : { pages: await pageCount(scoreBuf) };
    set.thumb = t.thumb || null;
    await db.setBlob(pre + 'score.pdf', scoreBuf.slice(0));   // ArrayBuffer: safer than Blob in Safari's IndexedDB
    set.score = { pdfKey: pre + 'score.pdf', pages: t.pages, layout: g.score.layout || (xmlDoc ? compact(safeLayout(xmlDoc), t.pages) : null) };
    set.pages = t.pages;
  }
  for (let i = 0; i < g.parts.length; i++) {
    const p = g.parts[i]; const buf = partBufs[i];
    const t = set.thumb || !wantThumb ? { pages: await pageCount(buf) } : await thumbnail(buf);
    if (!set.thumb && t.thumb) set.thumb = t.thumb;
    const key = `${pre}part-${i}.pdf`;
    await db.setBlob(key, buf.slice(0));
    const px = Object.entries(g.partXml).find(([n]) => nameKey(n) === nameKey(p.name));
    set.parts.push({ name: p.name, pdfKey: key, pages: t.pages, layout: p.layout || (px ? compact(safeLayout(px[1]), t.pages) : null) });
    if (!set.pages) set.pages = t.pages;
  }
  return set;
}

// MuseScore keeps "Concert pitch" for the score and for every part on its own (a score shown in concert
// pitch, its parts written, is common): each part's PDF is what its own MusicXML says. null: no part files
function partsConcert(parts, partXml) {
  const own = parts.map(p => [p.name, Object.entries(partXml || {}).find(([n]) => nameKey(n) === nameKey(p.name))]).filter(x => x[1]);
  if (!own.length) return null;
  const bad = [];
  for (const [name, [, x]] of own) { const ci = concertInfo(x); if (ci.parts.length && ci.concert === true) bad.push(name); }
  return { c: bad.length > 0, parts: bad, exact: true };
}

async function addMain(g) {
  const data = await readSet(g);
  if (g.sig) data.sig = g.sig;
  const { sig } = data;
  const song = store.state.local.find(s => keyOf(s.fileName || s.title) === keyOf(g.root));
  const same = song && song.versions.find(v => v.sig === sig);
  if (same) return { status: 'same', song, version: same };

  const xmlText = g.xml ? g.xml.text : null;
  const id = song ? song.id : 'S' + store.uid();
  const vn = song ? Math.max(...song.versions.map(v => v.v)) + 1 : 1;
  const pre = `${id}:v${vn}:`;
  const info = g.xml ? g.xml.info : {};
  const xmlDoc = xmlText ? new DOMParser().parseFromString(xmlText, 'application/xml') : null;
  const set = await storeSet(pre, g, data, xmlDoc, true);
  const version = { v: vn, date: Date.now(), sig, pages: set.pages, score: set.score, parts: set.parts, xml: null, rehearsal: [], transposed: {} };
  // how long it plays: exact from MuseScore, else estimated from the MusicXML
  version.dur = g.duration ? { s: g.duration, exact: true } : xmlDoc ? (sec => sec ? { s: sec, exact: false } : null)(safeSeconds(xmlDoc)) : null;
  if (xmlText) {
    await db.setBlob(pre + 'score.musicxml', xmlText);
    version.xml = { key: pre + 'score.musicxml', zip: false };
    version.rehearsal = rehearsalMarks(xmlDoc);
    // exported with "Concert pitch" on? Then the PDFs of the trumpet, the sax… show the piano's notes
    try {
      version.concert = partsConcert(set.parts, g.partXml) || concertSummary(concertInfo(xmlDoc));
      const c = version.concert;
      if (c.c === true && set.parts.length && c.parts.length) toast(t('שימו לב: הקובץ יוצא מ-MuseScore בצליל קונצרטי (Concert pitch). התפקידים של {parts} יוצגו במצב חי בכתב של הכלי. כדי לקבל PDF נכון: לכבות Concert pitch ב-MuseScore ולייצא שוב', { parts: c.parts.join(', ') }), 9000);
    } catch (e) { console.warn('concert pitch check', e); }
  }
  // the MuseScore file itself: other keys are engraved from it
  if (g.mscz) {
    await db.setBlob(pre + 'source.mscz', g.mscz.slice(0));
    version.mscz = { key: pre + 'source.mscz' };
  }

  const fields = {
    title: info.title || g.root, composer: info.composer || '', keysig: info.fifths, tempo: info.tempo, timesig: info.timesig,
    instruments: info.parts && info.parts.length ? info.parts : version.parts.map(p => p.name),
    thumb: set.thumb, fileName: g.root, updated: Date.now(),
  };
  if (song) {
    Object.assign(song, fields);
    song.versions.push(version);
    while (song.versions.length > KEEP_VERSIONS) {
      // saves from the note editor go first, so the song as it was imported stays
      const ei = song.versions.findIndex((x, i) => x.edited && i < song.versions.length - 1);
      const [old] = song.versions.splice(ei >= 0 ? ei : 0, 1);
      for (const k of store.versionKeys(old)) await db.delBlob(k);
    }
    const m = store.metaFor(id);
    if (m.pinnedV && !song.versions.some(v => v.v === m.pinnedV)) store.updateMeta(id, { pinnedV: null });
    store.save('local');
    return { status: 'updated', song, version };
  }
  const created = { id, kind: 'song', created: Date.now(), versions: [version], ...fields };
  store.state.local.push(created);
  store.save('local');
  return { status: 'added', song: created, version };
}

// the song engraved by MuseScore in another key, attached to one version
async function attachKey(song, version, semis, kg) {
  if (!kg.score && !kg.parts.length) return false;
  const data = await readSet(kg);
  if (kg.sig) data.sig = kg.sig;
  version.transposed = version.transposed || {};
  const old = version.transposed[semis];
  if (old && old.sig === data.sig) return false;
  if (old) for (const k of [old.score && old.score.pdfKey, ...old.parts.map(p => p.pdfKey)].filter(Boolean)) await db.delBlob(k);
  const xmlDoc = kg.xml ? new DOMParser().parseFromString(kg.xml.text, 'application/xml') : null;
  const pre = `${song.id}:v${version.v}:t${semis}:${Date.now().toString(36)}:`;
  const set = await storeSet(pre, kg, data, xmlDoc, false);
  version.transposed[semis] = { sig: data.sig, date: Date.now(), pages: set.pages, score: set.score, parts: set.parts };
  return true;
}

// ---------------------------------------------------------------- MuseScore files
const engraved = (root, r) => ({
  root, score: { buf: r.score.pdf, layout: r.score.layout }, keys: {}, duration: r.score.duration,
  parts: r.parts.map(p => ({ name: p.name, layout: p.layout, get: async () => new Blob([p.pdf]) })),
  xml: r.score.xml ? { text: r.score.xml, info: readXmlInfo(r.score.xml) } : null,
  partXml: Object.fromEntries(r.parts.filter(p => p.xml).map(p => [p.name, p.xml])),
});

async function importMscz(f, i, n, root = baseOf(f.name)) {
  const buf = await (await f.blob()).arrayBuffer();
  const sig = 'mscz-' + await signature([buf]) + '-f' + await fontsHash();
  const song = store.state.local.find(s => keyOf(s.fileName || s.title) === keyOf(root));
  if (song && song.versions.some(v => v.sig === sig)) return { status: 'same', keys: 0 };
  const label = n > 1 ? `${i + 1}/${n} ` : '';
  const r = await engraveMscz(buf, 0, { onStep: (k, n) => toast(t('MuseScore כותב {label}{name}{step}…', { label, name: root, step: n > 1 ? ` (${k}/${n})` : '' }), 2500) });
  const g = engraved(root, r);
  g.sig = sig; g.mscz = buf;
  const res = await addSong(g);
  // keys this song is already played in (setlists) are engraved right away
  const s = store.state.local.find(x => keyOf(x.fileName || x.title) === keyOf(root));
  if (s) prepareKeys(s.id);
  return res;
}

const fontsHash = async () => (await signature([new TextEncoder().encode(await fontsSig())])).slice(0, 8);

// after a font import: every song from a .mscz is engraved again with the new fonts (a new version,
// so pencil marks move along by measure)
async function reengraveAll() {
  const fh = await fontsHash();
  const todo = store.state.local.filter(s => { const v = s.versions[s.versions.length - 1]; return v.mscz && !String(v.sig).endsWith('-f' + fh); });
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i]; const v = s.versions[s.versions.length - 1];
    try {
      const buf = await store.blobBuffer(v.mscz.key);
      await importMscz({ name: s.fileName + '.mscz', blob: async () => new Blob([buf]) }, i, todo.length, s.fileName);
    } catch (e) { console.warn('re-engrave', s.title, e); }
  }
  if (todo.length) { await store.saveNow('local'); toast(t('{n} שירים נכתבו מחדש עם הגופנים', { n: todo.length }), 4000); }
}

// the note editor saved the song: MuseScore engraves it again and it becomes the song's newest version.
// Pencil marks follow their measures when measures were added or removed (ops from the editor).
export async function saveEdited(scoreId, bytes, ops = []) {
  const song = store.state.local.find(s => s.id === scoreId);
  if (!song) throw new Error(t('השיר לא נמצא'));
  const root = song.fileName || song.title;
  const res = await importMscz({ name: root + '.mscz', blob: async () => new Blob([bytes]) }, 0, 1, root);
  if (res.status === 'same') return res;
  const v = song.versions[song.versions.length - 1];
  v.edited = true;
  if (ops.length) {
    const ann = await store.annotations(scoreId);
    for (const st of ann.strokes) {
      if (!st.anchor) continue;
      let m = st.anchor.m;
      for (const o of ops) {
        if (m == null) break;
        if (o.op === 'insert' && m >= o.m) m++;
        else if (o.op === 'delete') { if (m === o.m) m = null; else if (m > o.m) m--; }
      }
      if (m == null) st.anchor = { ...st.anchor, m: -1 };   // its measure is gone: shown for review
      else st.anchor.m = m;
    }
    await store.saveAnnotations(scoreId);
  }
  if (store.metaFor(scoreId).pinnedV) store.updateMeta(scoreId, { pinnedV: null });
  await store.saveNow('local');
  return res;
}

// one key of a song, engraved by MuseScore on the iPad from the song's .mscz
const inFlight = new Map();
export const canEngrave = score => !!(score && score.version && score.version.mscz);
export function engraveKey(scoreId, semis, { quiet = false } = {}) {
  const k = scoreId + ':' + semis;
  if (inFlight.has(k)) return inFlight.get(k);
  const p = (async () => {
    const song = store.state.local.find(s => s.id === scoreId);
    const version = song && (store.scoreById(scoreId) || {}).version;
    if (!version || !version.mscz || !semis) return false;
    if ((version.transposed || {})[semis]) return true;
    const buf = await store.blobBuffer(version.mscz.key);
    const r = await engraveMscz(buf, semis, { onStep: quiet ? null : (i, n) => toast(t('MuseScore כותב בטון החדש{step}…', { step: n > 1 ? ` (${i}/${n})` : '' }), 2500) });
    const kg = engraved(song.fileName || song.title, r);
    kg.sig = `${version.sig}@${semis}`;
    await attachKey(song, version, semis, kg);
    // a song imported before lengths were kept gets its exact one here (a key change does not change it)
    if (r.score.duration && !(version.dur && version.dur.exact)) version.dur = { s: r.score.duration, exact: true };
    store.save('local');
    return true;
  })();
  inFlight.set(k, p);
  p.finally(() => inFlight.delete(k)).catch(() => {});
  return p;
}

// every key a song is played in (setlists, its own setting) that has no PDF yet, engraved in the background
export async function prepareKeys(onlyId = null) {
  if (store.state.performing) return;   // during a show the iPad does only what the show needs
  const { wantedKeys } = await import('./setlists.js');
  for (const w of wantedKeys({ missingOnly: true, withIds: true })) {
    if (onlyId && w.id !== onlyId) continue;
    if (!canEngrave(store.scoreById(w.id))) continue;
    for (const semis of w.keys) {
      if (store.state.performing) return;
      try { await engraveKey(w.id, semis, { quiet: true }); }
      catch (e) { console.warn('key', w.title, semis, e); }
    }
  }
}

// text fonts used by the scores (Hebrew, titles, chord fonts): MuseScore on the iPad needs the files
async function importFonts(list) {
  const fonts = (await db.get('fonts')) || [];
  let added = 0;
  for (const f of list) {
    const name = f.name.split('/').pop();
    const buf = await (await f.blob()).arrayBuffer();
    const old = fonts.find(x => x.name === name);
    const key = old ? old.key : 'font:' + store.uid();
    await db.setBlob(key, buf);
    if (old) old.size = buf.byteLength; else { fonts.push({ name, key, size: buf.byteLength }); added++; }
  }
  await db.set('fonts', fonts);
  fontsChanged();
  toast(added ? t('{n} גופנים נוספו ל-MuseScore', { n: added }) : t('הגופנים עודכנו'), 3000);
}

async function pageCount(buf) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise;
  const n = doc.numPages; doc.destroy();
  return n;
}

function safeLayout(xml) {
  try { return layoutFromMusicXml(xml); } catch (e) { console.warn('layout', e); return null; }
}
// layout is only trusted when it agrees with the PDF's page count
function compact(l, pages) {
  if (!l || !l.measures.length || l.pages !== pages) return null;
  const r = n => Math.round(n * 10) / 10;
  return { measures: l.measures.map(m => ({ m: m.m, page: m.page, x: r(m.x), y: r(m.y), w: r(m.w), h: r(m.h) })) };
}

async function signature(bufs) {
  try {
    const parts = await Promise.all(bufs.map(b => crypto.subtle.digest('SHA-256', b)));
    const all = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
    return [...new Uint8Array(all)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return bufs.map(b => b.byteLength).join('-');
  }
}

function safeSeconds(doc) { try { return xmlSeconds(doc); } catch { return null; } }

function readXmlInfo(text) {
  try {
    const d = new DOMParser().parseFromString(text, 'application/xml');
    const q = s => d.querySelector(s);
    const beats = q('time beats'); const bt = q('time beat-type');
    // MuseScore's placeholders ("Untitled score", "Composer / arranger") are not real data
    const real = t => t && !/^(untitled( score)?|composer( \/ arranger)?|arranger|subtitle|title|lyricist)$/i.test(t) ? t : null;
    const credit = type => [...d.querySelectorAll('credit')].filter(c => (c.querySelector('credit-type') || {}).textContent === type)
      .map(c => [...c.querySelectorAll('credit-words')].map(w => w.textContent).join(' ').replace(/\s+/g, ' ').trim()).find(real);
    const txt = sel => { const x = q(sel); return x ? x.textContent.replace(/\s+/g, ' ').trim() : null; };
    const title = real(txt('work-title')) || real(txt('movement-title')) || credit('title');
    return {
      title,
      composer: real(txt('creator[type="composer"]')) || real(txt('creator[type="arranger"]')) || credit('composer') || '',
      fifths: q('key fifths') ? +q('key fifths').textContent : undefined,
      tempo: q('sound[tempo]') ? Math.round(+q('sound[tempo]').getAttribute('tempo')) : undefined,
      timesig: beats && bt ? `${beats.textContent}/${bt.textContent}` : undefined,
      parts: [...d.querySelectorAll('score-part part-name')].map(x => x.textContent.trim()),
    };
  } catch { return { parts: [] }; }
}

let pdfLibP = null;
export function pdfLib() {
  if (!pdfLibP) {
    pdfLibP = new Promise((res, rej) => {
      if (window.PDFLib) return res(window.PDFLib);
      const s = document.createElement('script');
      s.src = new URL('../vendor/pdf-lib.min.js', import.meta.url).href;
      s.onload = () => res(window.PDFLib); s.onerror = rej;
      document.head.append(s);
    });
  }
  return pdfLibP;
}

async function imagesToPdf(images) {
  const { PDFDocument } = await pdfLib();
  const pdf = await PDFDocument.create();
  for (const f of images) {
    // re-encode through a canvas: handles HEIC→JPEG on iPad, EXIF rotation and huge camera photos
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => null);
    let bytes;
    if (bmp) {
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bytes = await new Promise(r => c.toBlob(b => r(b.arrayBuffer()), 'image/jpeg', 0.88));
    } else {
      bytes = await f.arrayBuffer();
    }
    const img = await pdf.embedJpg(await bytes);
    const w = 595; const hgt = w * img.height / img.width;
    const page = pdf.addPage([w, hgt]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: hgt });
  }
  return (await pdf.save()).buffer;
}
