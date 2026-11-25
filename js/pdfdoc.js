// PDF rendering with pdf.js: page sizes, auto-crop, memory-safe canvas rendering.
let pdfjsP = null;
export function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('../vendor/pdf.min.mjs').then(m => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return pdfjsP;
}

const docs = new Map(); // key -> Promise<PdfDoc>
const MAX_DOCS = 6;

export function openPdf(key, loader) {
  if (docs.has(key)) {
    const p = docs.get(key); docs.delete(key); docs.set(key, p); // LRU bump
    return p;
  }
  const p = (async () => {
    const lib = await pdfjs();
    const data = await loader();
    const doc = await lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
    return new PdfDoc(doc);
  })();
  p.catch(() => docs.delete(key));
  docs.set(key, p);
  while (docs.size > MAX_DOCS) {
    const [k, old] = docs.entries().next().value;
    docs.delete(k); old.then(d => d.destroy()).catch(() => {});
  }
  return p;
}

export class PdfDoc {
  constructor(doc) {
    this.doc = doc;
    this.count = doc.numPages;
    this.pages = new Map();
    this.crops = new Map();
  }
  destroy() { this.doc.destroy(); }
  async page(i) {
    if (!this.pages.has(i)) this.pages.set(i, this.doc.getPage(i + 1));
    return this.pages.get(i);
  }
  async size(i) {
    const p = await this.page(i);
    const vp = p.getViewport({ scale: 1 });
    return { w: vp.width, h: vp.height };
  }
  // bounding box of the ink, in PDF points, with a small pad
  async crop(i) {
    if (this.crops.has(i)) return this.crops.get(i);
    const pr = (async () => {
      const p = await this.page(i);
      const vp = p.getViewport({ scale: 0.5 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y += 1) {
        for (let x = 0; x < c.width; x += 1) {
          const k = (y * c.width + x) * 4;
          if (d[k] < 200 || d[k + 1] < 200 || d[k + 2] < 200) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      const full = { x: 0, y: 0, w: vp.width / 0.5, h: vp.height / 0.5 };
      if (x1 < 0) return full;
      const pad = 10;
      const box = {
        x: Math.max(0, x0 / 0.5 - pad), y: Math.max(0, y0 / 0.5 - pad),
        w: Math.min(full.w, (x1 - x0) / 0.5 + pad * 2), h: Math.min(full.h, (y1 - y0) / 0.5 + pad * 2),
      };
      // ignore crops that would barely help
      if (box.w > full.w * 0.97 && box.h > full.h * 0.97) return full;
      return box;
    })();
    this.crops.set(i, pr);
    return pr;
  }
  // render region `box` (PDF pts) into canvas at `cssScale` css px per pt
  async render(i, canvas, box, cssScale) {
    const p = await this.page(i);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = cssScale * dpr;
    // iOS canvas limit ≈ 16.7M px; stay well under it
    const MAX = 12e6;
    if (box.w * box.h * scale * scale > MAX) scale = Math.sqrt(MAX / (box.w * box.h));
    const W = Math.floor(box.w * scale); const H = Math.floor(box.h * scale);
    canvas.width = W; canvas.height = H;
    canvas.style.width = box.w * cssScale + 'px';
    canvas.style.height = box.h * cssScale + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const vp = p.getViewport({ scale });
    if (canvas._task) { try { canvas._task.cancel(); } catch { /* */ } }
    const task = p.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -box.x * scale, -box.y * scale] });
    canvas._task = task;
    try { await task.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') throw e; }
    canvas._task = null;
  }
}

// first page → small JPEG data URL (for local imports)
export async function thumbnail(data) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise;
  const p = await doc.getPage(1);
  const vp0 = p.getViewport({ scale: 1 });
  const vp = p.getViewport({ scale: 360 / vp0.width });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: ctx, viewport: vp }).promise;
  const pages = doc.numPages;
  doc.destroy();
  return { thumb: c.toDataURL('image/jpeg', 0.75), pages };
}
