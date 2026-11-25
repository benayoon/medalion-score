// Minimal zip reader (for .mxl files and for a whole exported library in one .zip),
// using the browser's own deflate-raw decompressor.
import { t } from './i18n.js';
export function readZip(buf) {
  const b = new Uint8Array(buf); const dv = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(t('קובץ zip פגום'));
  const count = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const flags = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true); const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true); const elen = dv.getUint16(off + 30, true); const clen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const raw = b.subarray(off + 46, off + 46 + nlen);
    const name = (flags & 0x800 ? new TextDecoder() : new TextDecoder('utf-8')).decode(raw).normalize('NFC');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name) || /(^|\/)\.DS_Store$/.test(name)) continue;
    out.push({
      name,
      async blob(type = '') {
        const ln = dv.getUint16(local + 26, true); const le = dv.getUint16(local + 28, true);
        const data = b.subarray(local + 30 + ln + le, local + 30 + ln + le + csize);
        if (method === 0) return new Blob([data.slice()], { type });
        const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Blob([await new Response(s).arrayBuffer()], { type });
      },
    });
  }
  return out;
}

// .mxl → MusicXML text
export async function unzipMusicXml(buf) {
  const files = readZip(buf);
  const byName = n => files.find(f => f.name === n);
  const container = byName('META-INF/container.xml');
  let root = container && ((await (await container.blob()).text()).match(/full-path="([^"]+)"/) || [])[1];
  const f = (root && byName(root)) || files.find(x => /\.(xml|musicxml)$/i.test(x.name) && !x.name.startsWith('META-INF'));
  if (!f) throw new Error(t('לא נמצא MusicXML בתוך הקובץ'));
  return (await f.blob()).text();
}

// Minimal zip writer (stored, no compression): repacks a MuseScore file after transposing it
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function writeZip(entries) {
  const enc = new TextEncoder();
  const files = entries.map(e => ({ name: enc.encode(e.name), data: typeof e.data === 'string' ? enc.encode(e.data) : e.data }));
  const size = files.reduce((s, f) => s + 30 + f.name.length + f.data.length + 46 + f.name.length, 22);
  const out = new Uint8Array(size); const dv = new DataView(out.buffer);
  let off = 0; const central = [];
  for (const f of files) {
    const crc = crc32(f.data);
    central.push({ f, crc, off });
    dv.setUint32(off, 0x04034b50, true); dv.setUint16(off + 4, 20, true); dv.setUint16(off + 6, 0x800, true);
    dv.setUint16(off + 8, 0, true); dv.setUint32(off + 10, 0x00210000, true); dv.setUint32(off + 14, crc, true);
    dv.setUint32(off + 18, f.data.length, true); dv.setUint32(off + 22, f.data.length, true);
    dv.setUint16(off + 26, f.name.length, true); dv.setUint16(off + 28, 0, true);
    out.set(f.name, off + 30); out.set(f.data, off + 30 + f.name.length);
    off += 30 + f.name.length + f.data.length;
  }
  const cd = off;
  for (const { f, crc, off: lo } of central) {
    dv.setUint32(off, 0x02014b50, true); dv.setUint16(off + 4, 20, true); dv.setUint16(off + 6, 20, true);
    dv.setUint16(off + 8, 0x800, true); dv.setUint16(off + 10, 0, true); dv.setUint32(off + 12, 0x00210000, true);
    dv.setUint32(off + 16, crc, true); dv.setUint32(off + 20, f.data.length, true); dv.setUint32(off + 24, f.data.length, true);
    dv.setUint16(off + 28, f.name.length, true); dv.setUint16(off + 30, 0, true); dv.setUint16(off + 32, 0, true);
    dv.setUint16(off + 34, 0, true); dv.setUint16(off + 36, 0, true); dv.setUint32(off + 38, 0, true); dv.setUint32(off + 42, lo, true);
    out.set(f.name, off + 46); off += 46 + f.name.length;
  }
  dv.setUint32(off, 0x06054b50, true); dv.setUint16(off + 8, files.length, true); dv.setUint16(off + 10, files.length, true);
  dv.setUint32(off + 12, off - cd, true); dv.setUint32(off + 16, cd, true);
  return out;
}
