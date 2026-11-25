// QR codes for pairing iPads: draw one (qrcode-generator) and read one from the camera (jsQR). Both offline.
import { h, toast } from './ui.js';
import { t } from './i18n.js';

const scripts = {};
function script(name, global) {
  if (!scripts[name]) scripts[name] = new Promise((res, rej) => {
    if (window[global]) return res(window[global]);
    const s = document.createElement('script');
    s.src = new URL(`../vendor/${name}`, import.meta.url).href;
    s.onload = () => res(window[global]); s.onerror = () => rej(new Error(t('ספריית QR חסרה')));
    document.head.append(s);
  });
  return scripts[name];
}

export async function qrCanvas(text, size = 520) {
  const qrcode = await script('qrcode.js', 'qrcode');
  const q = qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
  const n = q.getModuleCount(); const quiet = 4; const cell = Math.max(2, Math.floor(size / (n + quiet * 2)));
  const c = h('canvas', { class: 'qr' }); c.width = c.height = cell * (n + quiet * 2);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
  return c;
}

export async function decodeCanvas(c) {
  const jsQR = await script('jsQR.js', 'jsQR');
  const x = c.getContext('2d', { willReadFrequently: true });
  const img = x.getImageData(0, 0, c.width, c.height);
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}

// the camera, until a code that `accept(text)` likes is seen. Returns { el, stop } to put in a sheet.
export function scanner(accept) {
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const msg = h('p', { class: 'hint' }, t('מכוונים את המצלמה אל הקוד שעל המסך השני'));
  let facing = 'environment'; let stream = null; let stopped = false; let timer = null;
  const work = h('canvas');
  const start = async () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = t('אין גישה למצלמה בכתובת הזו (צריך HTTPS). אפשר להדביק את הקוד בתיבה למטה.'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false });
      video.srcObject = stream; await video.play().catch(() => {});
      tick();
    } catch (e) { msg.textContent = t('המצלמה לא נפתחה: {msg}. אפשר להדביק את הקוד בתיבה למטה.', { msg: e.message }); }
  };
  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const k = Math.min(1, 900 / video.videoWidth);
      work.width = video.videoWidth * k; work.height = video.videoHeight * k;
      work.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, work.width, work.height);
      const text = await decodeCanvas(work).catch(() => null);
      if (text && await accept(text)) { stop(); return; }
    }
    timer = setTimeout(tick, 180);
  };
  const stop = () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
  const flip = h('button', { class: 'btn labeled', onclick: () => { facing = facing === 'environment' ? 'user' : 'environment'; start(); } }, t('החלפת מצלמה'));
  const paste = h('textarea', { class: 'input code-paste', rows: 2, dir: 'ltr', placeholder: t('או להדביק כאן את הקוד') });
  paste.oninput = async () => { const code = paste.value.trim(); if (code.length > 40 && await accept(code)) stop(); else if (code.length > 40) toast(t('הקוד לא מתאים')); };
  start();
  return { el: h('div', { class: 'scanner' }, video, msg, h('div', { class: 'row center' }, flip), paste), stop };
}

// a code to show: big QR plus the text (copy / share it when there is no camera)
export async function codeView(text, caption) {
  const c = await qrCanvas(text);
  const ta = h('textarea', { class: 'input code-text', rows: 3, dir: 'ltr', readonly: true }, text);
  ta.onclick = () => ta.select();
  const share = navigator.share ? h('button', { class: 'btn labeled', onclick: () => navigator.share({ text }).catch(() => {}) }, t('שליחת הקוד')) : null;
  return h('div', { class: 'codeview' }, h('p', { class: 'code-cap' }, caption), c, ta, share);
}
