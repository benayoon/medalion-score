// MuseScore on the iPad: webmscore (MuseScore 4 compiled to WebAssembly) engraves a .mscz file into
// the same PDFs and MusicXML that MuseScore exports, in any key. Runs in a worker, one job at a time.
//
//   engraveMscz(buf, semis) → { score: { pdf, xml, pages, layout }, parts: [{ name, pdf, xml, pages, layout }] }
//   layout: where every measure sits on the PDF pages, straight from MuseScore ({ measures: [{ m, page, x, y, w, h }] }
//   in PDF points from the top left, m = measure index), for pencil anchoring and rehearsal jumps
//
// Every part is engraved as a file of its own (its own layout from the .mscz), because webmscore leaves
// out parts whose instrument is hidden in the full score.
import { readZip, writeZip } from './zip.js';
import { transposeMscz } from './mscz.js';
import * as db from './db.js';
import { t } from './i18n.js';

const WORKER_URL = new URL('../vendor/webmscore/webmscore.worker.js', import.meta.url);
let worker = null; let ready = null; let seq = 0;
let fontsSent = false;   // fonts stay loaded in the worker: sent once, with its first score
let restart = false;     // the fonts changed: start a fresh worker for the next job
const pending = new Map();

function start() {
  if (ready) return ready;
  worker = new Worker(WORKER_URL); fontsSent = false;
  worker.onmessage = e => {
    const p = pending.get(e.data.id); if (!p) return;
    pending.delete(e.data.id); clearTimeout(p.t);
    if (e.data.error) p.reject(new Error(e.data.error.message || 'MuseScore error')); else p.resolve(e.data.result);
  };
  worker.onerror = e => { e.preventDefault(); stop(new Error(t('MuseScore נעצר: {msg}', { msg: e.message || t('שגיאה') }))); };
  ready = rpc('ready', [], [], 180000).then(() => rpc('setLogLevel', [0]));
  ready.catch(() => {});
  return ready;
}
function stop(err) {
  if (worker) worker.terminate();
  worker = null; ready = null;
  for (const p of pending.values()) { clearTimeout(p.t); p.reject(err); }
  pending.clear();
}
function rpc(method, params = [], transfer = [], ms = 120000) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    // a stuck engine (out of memory on a big score) is restarted, not waited on forever
    const tm = setTimeout(() => stop(new Error(t('MuseScore לא הגיב'))), ms);
    pending.set(id, { resolve, reject, t: tm });
    worker.postMessage({ id, method, params }, transfer);
  });
}

// text fonts the scores use (titles, chord fonts, Hebrew). MuseScore's own music fonts are built in.
let fontsP = null;
export function fontsChanged() { fontsP = null; restart = true; }
// which fonts a song was engraved with (songs engraved before a font import are engraved again)
export async function fontsSig() {
  const list = (await db.get('fonts')) || [];
  return list.map(f => `${f.name}:${f.size}`).sort().join('|');
}
async function fonts() {
  if (!fontsP) fontsP = (async () => {
    const list = (await db.get('fonts')) || [];
    const out = [];
    for (const f of list) { const b = await db.getBlob(f.key); if (b) out.push(new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b)); }
    return out;
  })();
  return fontsP;
}

// text fonts: a font the iPad doesn't have (not built into MuseScore, not imported in Settings) is drawn by
// MuseScore with a music font, where letters turn into symbols ("Lo" -> "L°", "h" -> "♮"). Such a font is
// replaced by FreeSerif, which MuseScore has built in and which also writes Hebrew.
const BUILTIN_FONTS = ['Edwin', 'FreeSerif', 'FreeSans', 'MuseJazz Text', 'MuseJazz', 'MScoreBC', 'MScore', 'MScore Text',
  'Leland', 'Leland Text', 'Bravura', 'Bravura Text', 'Petaluma', 'Petaluma Text', 'Petaluma Script', 'Gootville', 'Gootville Text',
  'Finale Maestro', 'Finale Maestro Text', 'Finale Broadway', 'Finale Broadway Text', 'Campania', 'ScoreText'];
const fontKey = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export async function fontsOnHand() {
  const list = (await db.get('fonts')) || [];
  return [...BUILTIN_FONTS, ...list.map(f => f.name.replace(/\.(ttf|otf|ttc|woff2?)$/i, ''))].map(fontKey).filter(Boolean);
}
export function fixFonts(t, have) {
  const sub = name => {
    const k = fontKey(name);
    return !k || have.some(x => x === k || x.startsWith(k) || k.startsWith(x)) ? name : 'FreeSerif';
  };
  return t.replace(/<(\w*FontFace|family)>([^<]*)</g, (m, tag, n) => `<${tag}>${sub(n)}<`)
    .replace(/<font face="([^"]*)"/g, (m, n) => `<font face="${sub(n)}"`);
}
// the .mscx / .mss texts inside a .mscz changed by fn(text, name); other files kept as they are
// a .mscx / .mss text shown in written pitch (MuseScore keeps both pitches in the file; this is only the view)
export const writtenPitch = x => x.replace(/<concertPitch>\s*1\s*<\/concertPitch>/g, '<concertPitch>0</concertPitch>');
// was the file saved showing concert pitch?
export const savedConcert = x => /<concertPitch>\s*1\s*<\/concertPitch>/.test(x);

export async function patchMscz(bytes, fn) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  for (const e of readZip(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength))) {
    const data = new Uint8Array(await (await e.blob()).arrayBuffer());
    out.push({ name: e.name, data: /\.(mscx|mss)$/i.test(e.name) ? fn(new TextDecoder().decode(data), e.name) : data });
  }
  return writeZip(out);
}

let queue = Promise.resolve();
const serial = fn => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };

// a score opened in MuseScore for one job: fn(call) runs MuseScore's functions on it (call('npages'),
// call('saveSvg', [0, true]), call('segmentPositions'), call('saveMsc', ['mscz']) …), then it is closed.
// format: 'mscz' | 'mxl' | 'musicxml'
export function withScore(bytes, format, fn) {
  return serial(async () => {
    if (restart) { restart = false; if (worker) stop(new Error('restart')); }
    await start();
    const f = fontsSent ? [] : await fonts();
    fontsSent = true;
    const data = (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice();
    await rpc('load', [format, data, f.map(x => x.slice()), true], [data.buffer]);
    try { return await fn((method, params = [], ms) => rpc(method, params, [], ms)); }
    finally { rpc('destroy', [true]).catch(() => {}); }
  });
}
// how many MuseScore jobs are waiting (a preview that is no longer wanted is skipped by its caller)
export const busy = () => pending.size;

async function engraveOne(data, { xml = true } = {}) {
  const f = fontsSent ? [] : await fonts();
  fontsSent = true;
  const copy = data.slice();
  await rpc('load', ['mscz', copy, f.map(x => x.slice()), true], [copy.buffer]);
  try {
    const pages = await rpc('npages');
    const pdf = await rpc('savePdf');
    const text = xml ? await rpc('saveXml') : null;
    let layout = null, duration = null;
    try {
      const [pos, meta] = await Promise.all([rpc('measurePositions'), rpc('metadata')]);
      if (meta.duration > 0) duration = Math.round(meta.duration);   // playback length with repeats, seconds
      const k = (meta.pageFormat.width * 72 / 25.4) / pos.pageSize.width;   // file pixels → PDF points
      const r = n => Math.round(n * k * 10) / 10;
      // one position per drawn measure: a multi-measure rest is one box for all its measures
      const span = text ? restSpans(text) : [];
      const measures = []; let m = 0;
      for (const e of pos.elements) {
        const box = { page: e.page, x: r(e.x), y: r(e.y), w: r(e.sx), h: r(e.sy) };
        const n = span[m] || 1;
        for (let k = 0; k < n; k++) measures.push({ m: m + k, ...box });
        m += n;
      }
      if (measures.length) layout = { measures };
    } catch (e) { console.warn('positions', e); }
    return { pdf: pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength), xml: text, pages, layout, duration };
  } finally {
    rpc('destroy', [true]).catch(() => {});
  }
}

// measure index → how many measures a multi-measure rest starting there covers (from MusicXML)
function restSpans(xml) {
  const part = (xml.match(/<part\s[\s\S]*?<\/part>/) || [''])[0];
  return part.split(/<measure[\s>]/).slice(1).map(m => +((m.match(/<multiple-rest[^>]*>(\d+)</) || [])[1] || 1));
}

// each part of the .mscz as a small .mscz of its own
export async function partFiles(entries) {
  const out = [];
  const byName = new Map(entries.map(e => [e.name, e]));
  for (const e of entries) {
    const m = e.name.match(/^Excerpts\/([^/]+)\/([^/]+)\.mscx$/);
    if (!m) continue;
    const dir = m[1];
    const mscx = new Uint8Array(await (await e.blob()).arrayBuffer());
    const head = new TextDecoder().decode(mscx.subarray(0, 20000));
    const name = ((head.match(/<metaTag name="partName">([^<]*)</) || head.match(/<name>([^<]*)<\/name>/) || [])[1] || dir.replace(/^\d+_/, '').replace(/_/g, ' '))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
    const mss = byName.get(`Excerpts/${dir}/${m[2]}.mss`);
    const files = [{ name: 'score.mscx', data: mscx }];
    if (mss) files.unshift({ name: 'score_style.mss', data: new Uint8Array(await (await mss.blob()).arrayBuffer()) });
    files.push({ name: 'META-INF/container.xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<container>\n  <rootfiles>\n'
      + files.map(f => `    <rootfile full-path="${f.name}"/>\n`).join('') + '    </rootfiles>\n  </container>\n' });
    out.push({ name, order: parseInt(dir) || 0, data: writeZip(files) });
  }
  return out.sort((a, b) => a.order - b.order);
}

export function engraveMscz(buf, semis = 0, { onStep } = {}) {
  return serial(async () => {
    if (restart) { restart = false; if (worker) stop(new Error('restart')); }
    await start();
    const have = await fontsOnHand();
    // the PDFs are what the players read: always written pitch, also when the file was saved with
    // "Concert pitch" on (the B♭ trumpet's part in B♭, never the piano's notes). The file itself is not changed.
    const data = await patchMscz(await transposeMscz(buf, semis), x => writtenPitch(fixFonts(x, have)));
    const entries = readZip(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const parts = await partFiles(entries);
    const total = 1 + parts.length;
    if (onStep) onStep(1, total);
    const score = await engraveOne(data);
    const out = { score, parts: [] };
    for (let i = 0; i < parts.length; i++) {
      if (onStep) onStep(i + 2, total);
      const r = await engraveOne(parts[i].data);
      if (r.pages) out.parts.push({ name: parts[i].name, ...r });
    }
    // one instrument: its "part" is the score again
    if (out.parts.length === 1) out.parts = [];
    return out;
  });
}

// the engine files are big (about 22 MB): fetch them once ahead of time, so engraving works offline
export function warm() {
  for (const f of ['webmscore.worker.js', 'webmscore.lib.wasm', 'webmscore.lib.data']) fetch(new URL(f, WORKER_URL)).catch(() => {});
}

// ---------------------------------------------------------------- live mode
// MusicXML → MuseScore's own files ([{ name, text }]: .mscx and .mss). Chord symbols read from MusicXML are drawn without their
// root until the score is loaded again from MuseScore's own format, so live mode always draws from .mscx.
export function xmlToMsFiles(xml) {
  return serial(async () => {
    if (restart) { restart = false; if (worker) stop(new Error('restart')); }
    await start();
    const f = fontsSent ? [] : await fonts();
    fontsSent = true;
    const data = new TextEncoder().encode(xml);
    await rpc('load', ['musicxml', data, f.map(x => x.slice()), true], [data.buffer]);
    try {
      // the .mscx and its style (.mss: page size, staff size, spacing) as MuseScore saves them
      const r = await rpc('saveMsc', ['mscz']); const z = r instanceof Uint8Array ? r : new Uint8Array(r);
      const out = [];
      for (const e of readZip(z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength))) {
        if (/\.(mscx|mss)$/i.test(e.name)) out.push({ name: e.name, text: new TextDecoder().decode(new Uint8Array(await (await e.blob()).arrayBuffer())) });
      }
      return out;
    } finally { rpc('destroy', [true]).catch(() => {}); }
  });
}
// the pages as MuseScore draws them (SVG, text as outlines) and where each measure is on them
// (SVG units): boxes[m] for measure index m (the measures of a multi-measure rest share its box)
export function drawMscz(mscz, measures = 0, opts = {}) {
  return serial(async () => {
    if (restart) { restart = false; if (worker) stop(new Error('restart')); }
    await start();
    const f = fontsSent ? [] : await fonts();
    fontsSent = true;
    const copy = mscz.slice();
    await rpc('load', ['mscz', copy, f.map(x => x.slice()), true], [copy.buffer]);
    try {
      const n = await rpc('npages');
      const svgs = [];
      for (let i = 0; i < n; i++) svgs.push(await rpc('saveSvg', [i, true]));
      const pos = await rpc('measurePositions');
      const span = pos.elements.length < measures ? restSpans(await rpc('saveXml')) : [];
      // when each measure first sounds (ms), and when the music goes on after it
      const first = new Map(); const evs = [...pos.events].sort((a, b) => a.position - b.position);
      evs.forEach((ev, k) => { if (!first.has(ev.elid)) first.set(ev.elid, [ev.position, k + 1 < evs.length ? evs[k + 1].position : null]); });
      const boxes = []; let m = 0;
      for (const e of pos.elements) {
        const [ms0, ms1] = first.get(e.id) || [null, null];
        const box = { page: e.page, x: e.x, y: e.y, w: e.sx, h: e.sy, ms0, ms1 };
        const k = span[m] || 1;
        for (let j = 0; j < k; j++) boxes.push({ m: m + j, ...box });
        m += k;
      }
      // for editing: where each chord/rest column is drawn (x) and when it sounds
      let segs = null;
      if (opts.segments) {
        const sp = await rpc('segmentPositions');
        const at = new Map(); for (const ev of sp.events) if (!at.has(ev.elid) || ev.position < at.get(ev.elid)) at.set(ev.elid, ev.position);
        segs = sp.elements.map(e => ({ page: e.page, x: e.x, y: e.y, h: e.sy, ms: at.get(e.id) ?? null }));
      }
      return { svgs, boxes, segs };
    } finally { rpc('destroy', [true]).catch(() => {}); }
  });
}
