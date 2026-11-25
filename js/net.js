// Direct connection between iPads on the same Wi-Fi, with no server and no internet (WebRTC data channel).
// Pairing is done by codes shown as QR: the leader's invite code → scanned by the musician → the musician's
// answer code → scanned by the leader. A code holds only what the connection needs (ICE user/password,
// DTLS fingerprint, local addresses): about 150–250 characters, a sparse QR that scans off a screen.
//
//   const p = new Peer(); const invite = await p.invite();      // leader
//   const q = new Peer(); const answer = await q.accept(invite); // musician
//   await p.complete(answer);                                    // leader → both sides 'open'
//   p.send({ t: 'hello' }); p.onMessage = msg => …; p.sendFile(meta, bytes) …

import { t } from './i18n.js';

const PREFIX = 'MS1';
const CHUNK = 16 * 1024;

// ---------------------------------------------------------------- codes
function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64(s) { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(t, c => c.charCodeAt(0)); }

export function encodeSdp(sdp, role) {
  const get = re => (sdp.match(re) || [])[1];
  const ufrag = get(/a=ice-ufrag:(\S+)/); const pwd = get(/a=ice-pwd:(\S+)/);
  const fp = get(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/);
  if (!ufrag || !pwd || !fp) throw new Error(t('קוד חיבור לא תקין'));
  const cands = [];
  for (const m of sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ (host|srflx)/gi)) {
    const c = `${m[3][0]}${m[1]},${m[2]}`;
    if (!cands.includes(c)) cands.push(c);
  }
  if (!cands.length) throw new Error(t('אין כתובת ברשת: בדוק שהאייפד מחובר ל-Wi-Fi'));
  const fpBytes = Uint8Array.from(fp.split(':').map(x => parseInt(x, 16)));
  return [PREFIX, role, ufrag, pwd, b64(fpBytes), cands.join(' ')].join(';');
}

export function decodeCode(code) {
  const p = String(code || '').trim().split(';');
  if (p[0] !== PREFIX || p.length < 6) throw new Error(t('זה לא קוד חיבור של Medalion Score'));
  const [, role, ufrag, pwd, fp, cands] = p;
  const fingerprint = [...unb64(fp)].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const lines = [
    'v=0', `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`, `a=setup:${role === 'o' ? 'actpass' : 'active'}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ];
  let k = 1;
  for (const c of cands.split(' ').filter(Boolean)) {
    const [addr, port] = c.slice(1).split(',');
    const typ = c[0] === 's' ? 'srflx' : 'host';
    lines.push(`a=candidate:${k} 1 udp ${typ === 'host' ? 2122260223 - k : 1686052607 - k} ${addr} ${port} typ ${typ}${typ === 'srflx' ? ' raddr 0.0.0.0 rport 0' : ''} generation 0`);
    k++;
  }
  lines.push('a=end-of-candidates');
  return { role, sdp: lines.join('\r\n') + '\r\n' };
}

// ---------------------------------------------------------------- one connection
export class Peer {
  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: [] });
    // the same channel on both sides, agreed in advance: nothing else to negotiate
    this.dc = this.pc.createDataChannel('medalion', { negotiated: true, id: 0, ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 256 * 1024;
    this.onMessage = null; this.onFile = null; this.onState = null;
    this.state = 'new';
    this.opened = new Promise((res, rej) => { this._open = res; this._fail = rej; });
    this.dc.onopen = () => { this.setState('open'); this._open(); };
    this.dc.onclose = () => this.setState('closed');
    this.dc.onmessage = e => this.receive(e.data);
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') { this.setState('failed'); this._fail(new Error(t('החיבור נכשל'))); }
      else if (s === 'disconnected') this.setState('lost');
      else if (s === 'connected' && this.dc.readyState === 'open') this.setState('open');
    };
    this.incoming = null; this.sendQ = Promise.resolve();
  }
  setState(s) { if (this.state === s) return; this.state = s; if (this.onState) this.onState(s); }

  async gathered() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise(res => {
      const t = setTimeout(res, 3000);
      this.pc.addEventListener('icegatheringstatechange', () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  // leader: a code to show
  async invite() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gathered();
    return encodeSdp(this.pc.localDescription.sdp, 'o');
  }
  // musician: the leader's code → an answer code to show back
  async accept(code) {
    const { role, sdp } = decodeCode(code);
    if (role !== 'o') throw new Error(t('זה קוד תשובה. צריך לסרוק את הקוד שעל המסך של הלידר'));
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gathered();
    return encodeSdp(this.pc.localDescription.sdp, 'a');
  }
  // leader: the musician's answer code
  async complete(code) {
    const { role, sdp } = decodeCode(code);
    if (role !== 'a') throw new Error(t('זה קוד הזמנה. צריך לסרוק את הקוד שעל המסך של הנגן'));
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }
  waitOpen(ms = 20000) {
    return Promise.race([this.opened, new Promise((_, rej) => setTimeout(() => rej(new Error(t('אין חיבור: בדוק ששני האייפדים על אותה רשת Wi-Fi'))), ms))]);
  }
  close() { try { this.dc.close(); this.pc.close(); } catch { /* closed */ } this.setState('closed'); }

  // ---------------------------------------------------------------- messages
  send(obj) {
    if (this.dc.readyState !== 'open') return false;
    this.sendQ = this.sendQ.then(() => { if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj)); }).catch(() => {});
    return true;
  }
  // a file: its description, then its bytes in chunks (the channel keeps the order)
  sendFile(meta, bytes, onProgress) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const n = Math.ceil(data.length / CHUNK) || 1;
    const job = async () => {
      if (this.dc.readyState !== 'open') throw new Error(t('החיבור נסגר'));
      this.dc.send(JSON.stringify({ t: 'file', meta, size: data.length, n }));
      for (let i = 0; i < n; i++) {
        if (this.dc.bufferedAmount > 1024 * 1024) await new Promise(r => { this.dc.onbufferedamountlow = () => { this.dc.onbufferedamountlow = null; r(); }; });
        if (this.dc.readyState !== 'open') throw new Error(t('החיבור נסגר'));
        this.dc.send(data.slice(i * CHUNK, (i + 1) * CHUNK));
        if (onProgress) onProgress((i + 1) / n);
      }
    };
    const p = this.sendQ.then(job);
    this.sendQ = p.catch(() => {});
    return p;
  }
  receive(data) {
    if (typeof data !== 'string') {
      const f = this.incoming; if (!f) return;
      const b = new Uint8Array(data); f.buf.set(b, f.got); f.got += b.length; f.k++;
      if (f.k >= f.n) { this.incoming = null; if (this.onFile) this.onFile(f.meta, f.buf); }
      return;
    }
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'file') { this.incoming = { meta: msg.meta, n: msg.n, k: 0, got: 0, buf: new Uint8Array(msg.size) }; if (msg.size === 0) { this.incoming = null; if (this.onFile) this.onFile(msg.meta, new Uint8Array(0)); } return; }
    if (this.onMessage) this.onMessage(msg);
  }
}
