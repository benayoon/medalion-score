// A MuseScore file (.mscz) in another key: every score file inside it (the full score and each part)
// is transposed the way MuseScore does it, and the file is packed again. Runs in the browser or Node.
import { readZip, writeZip } from './zip.js';
import { transposeMscx } from './mstranspose.js';

export async function transposeMscz(buf, semis) {
  if (!semis) return new Uint8Array(buf);
  const out = [];
  for (const e of readZip(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))) {
    const data = new Uint8Array(await (await e.blob()).arrayBuffer());
    out.push({ name: e.name, data: /\.mscx$/i.test(e.name) ? transposeMscx(new TextDecoder().decode(data), semis) : data });
  }
  return writeZip(out);
}
