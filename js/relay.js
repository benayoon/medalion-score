// One scan to join the band: the leader's QR holds a meeting place on a public relay (ntfy.sh) and a key
// that never leaves the two iPads. The musician's iPad asks there for a connection, the leader's iPad answers
// with one, and from then on everything goes straight between the iPads on the Wi-Fi (net.js).
// Only the connection codes pass through the relay, sealed (AES-GCM) with the key from the QR: the relay
// sees random topic names and unreadable bytes, and nobody without the QR can join or read them.
//
//   leader:   const r = await newRelay(); const sub = listen(r.topic, r.key, msg => …); token(r) → in the QR
//   musician: const r = await fromToken(text); await post(r.topic, r.key, { t: 'join', … })

const BASE = 'https://ntfy.sh/';

function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64(s) { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(t, c => c.charCodeAt(0)); }
export const randomId = (n = 12) => b64(crypto.getRandomValues(new Uint8Array(n)));

const importKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// a new meeting place: { topic, key (CryptoKey), raw (the key's bytes, for the QR) }
export async function newRelay() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return { topic: 'ms' + randomId(15), key: await importKey(raw), raw };
}
// what goes into the QR (after the connection code): R=<topic>.<key>
export const token = r => `R=${r.topic}.${b64(r.raw)}`;
// the meeting place from a scanned code, or null when it has none (an older leader, or a code to type in)
export async function fromToken(code) {
  const m = String(code || '').match(/(?:^|;)R=(ms[A-Za-z0-9_-]{10,40})\.([A-Za-z0-9_-]{20,24})(?:;|$)/);
  if (!m) return null;
  const raw = unb64(m[2]);
  return raw.length === 16 ? { topic: m[1], key: await importKey(raw), raw } : null;
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64(out);
}
async function unseal(key, text) {
  try {
    const all = unb64(String(text).trim());
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }   // not ours (or tampered with): ignored
}

export async function post(topic, key, obj, ms = 6000) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(BASE + topic, { method: 'POST', body: await seal(key, obj), signal: ctl.signal, cache: 'no-store', headers: { Cache: 'no' } });
    if (!r.ok) throw new Error('relay ' + r.status);
  } finally { clearTimeout(timer); }
}

// messages on a topic from now on: onMsg(obj) for each one sealed with this key. → { ready, close }
export function listen(topic, key, onMsg) {
  let es = null; let closed = false; let opened;
  const ready = new Promise((res, rej) => { opened = res; setTimeout(() => rej(new Error('relay: no connection')), 6000); });
  ready.catch(() => {});
  const open = () => {
    if (closed) return;
    es = new EventSource(BASE + topic + '/sse');
    es.onopen = () => opened();
    es.onmessage = async e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event !== 'message' || !m.message) return;
      const obj = await unseal(key, m.message);
      if (obj && !closed) onMsg(obj);
    };
    // the browser reconnects by itself; after a hard failure (no internet for long) a new one is opened
    es.onerror = () => { if (es.readyState === EventSource.CLOSED && !closed) setTimeout(open, 3000); };
  };
  open();
  return { ready, close() { closed = true; if (es) es.close(); } };
}

// this iPad, for the leader to know a musician who connects again (a random name, kept on the iPad)
let device = null;
export function deviceId() {
  if (device) return device;
  try {
    let id = localStorage.getItem('ms-device');
    if (!id) { id = randomId(9); localStorage.setItem('ms-device', id); }
    return (device = id);
  } catch { return (device = 'x' + randomId(6)); }
}
