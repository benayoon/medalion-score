// Band mode: one leader iPad, any number of musicians on the same Wi-Fi (no internet, no server).
// The leader's iPad sends its state (song, key, setlist, where in the song) and every musician's iPad
// follows it in its own part: by measure, so each part turns at the right place. Songs and setlists the
// musicians are missing come from the leader automatically. The leader can send short cues to everyone.
import { h, toast, sheet, toggle, icon, confirmBox } from './ui.js';
import { t, locale } from './i18n.js';
import * as store from './store.js';
import { Peer } from './net.js';
import { instIcon } from './instruments.js';

export const band = {
  role: null,          // null | 'leader' | 'member'
  peers: [],           // leader: the musicians [{ peer, info, state }]
  leader: null,        // member: the connection to the leader
  leaderInfo: null,
  follow: true,        // member: follow the leader's page turns and songs
  last: null,          // member: the leader's last state
  seq: 0,
  cues: [],
  controlBy: null,     // leader: the musician who turns the pages for everyone right now (null: the leader)
  control: false,      // member: this iPad turns the pages for everyone
  controller: null,    // everyone: the name of who turns the pages, when it is not the leader
};
const listeners = new Set();
export const onBand = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

const me = () => ({ name: store.state.settings.profileName || t('נגן'), instrument: store.state.settings.instrument || '' });
const viewerMod = () => import('./viewer.js');

// ---------------------------------------------------------------- leader
export function startLeading() {
  if (band.role === 'member') leaveBand();
  band.role = 'leader';
  clearInterval(band.beat);
  // the state again every 2 s: a musician who missed a message (or just joined) catches up
  band.beat = setInterval(() => { if (band.lastState) broadcast(band.lastState); }, 2000);
  changed();
}

// a fresh invitation: one connection per musician
export async function newInvite() {
  const peer = new Peer();
  const code = await peer.invite();
  return { peer, code };
}
export async function addMusician(peer, answer) {
  await peer.complete(answer);
  await peer.waitOpen();
  const m = { peer, info: { name: t('נגן'), instrument: '' }, state: {} };
  band.peers.push(m);
  wire(peer, m);
  peer.send({ t: 'hello', ...me(), role: 'leader' });
  if (band.lastState) peer.send(band.lastState);
  changed();
  return m;
}

function broadcast(msg) { for (const m of band.peers) if (m.peer.state === 'open') m.peer.send(msg); }

// called by the viewer whenever the leader's screen changes
export async function report(v) {
  const controlling = band.role === 'member' && band.control && band.leader;
  if (band.role !== 'leader' && !controlling) return;
  if (band.role === 'leader' && band.controlBy) return;   // someone else turns the pages now
  const st = { t: 'state', seq: ++band.seq, at: Date.now(), song: null };
  if (v && v.score) {
    const s = v.score;
    st.song = { hash: store.songHash(s), title: s.title, file: s.fileName || s.title };
    st.semis = v.semis; st.perform = !!v.perform;
    const pos = v.engine && v.engine.position ? v.engine.position() : null;
    if (pos) { st.measure = pos.measure; st.frac = pos.frac; }
    if (v.setlist) {
      st.setlist = { id: v.setlist.id, name: v.setlist.name, items: v.setlist.items.map(it => {
        const x = store.scoreById(it.scoreId);
        return { hash: store.songHash(x), title: x ? x.title : '?', file: x ? x.fileName || x.title : '', semis: it.semis ?? store.metaFor(it.scoreId).semis ?? 0, note: it.note || '' };
      }) };
      st.index = v.index;
    }
  }
  if (controlling) { band.leader.send(st); return; }
  band.lastState = st;
  broadcast(st);
}

// ---------------------------------------------------------------- handing over the page turns
// The leader's iPad stays the hub (everyone is connected to it); a musician who gets the page turns sends
// its state to the leader, who follows it and passes it on to everyone else.
export function giveControl(m) {
  if (band.role !== 'leader') return;
  if (band.controlBy && band.controlBy !== m) band.controlBy.peer.send({ t: 'control', on: false });
  band.controlBy = m;
  m.peer.send({ t: 'control', on: true });
  broadcast({ t: 'controller', name: m.info.name });
  band.controller = m.info.name;
  toast(t('הדפדוף עבר ל{name}', { name: m.info.name }), 3000);
  changed();
}
export async function takeControl() {
  if (band.role !== 'leader') return;
  const m = band.controlBy; band.controlBy = null; band.controller = null;
  if (m) m.peer.send({ t: 'control', on: false });
  broadcast({ t: 'controller', name: null });
  toast(t('הדפדוף חזר אליך'), 2500);
  changed();
  const { currentViewer } = await viewerMod();
  report(currentViewer());
}
export function giveBack() {
  if (band.role === 'member' && band.leader) band.leader.send({ t: 'giveback' });
}

export function sendCue(text) {
  if (band.role !== 'leader' || !text) return;
  broadcast({ t: 'cue', text, at: Date.now() });
  showCue(text, true);
}

// ---------------------------------------------------------------- member
// the leader's invitation → an answer code to show the leader; connects in the background
export async function join(invite, onOpen) {
  if (band.role) leaveBand();
  const peer = new Peer();
  const answer = await peer.accept(invite);
  peer.waitOpen(120000).then(() => {
    band.role = 'member'; band.leader = peer; band.follow = true; band.control = false; band.lostLeader = null;
    wire(peer, null);
    peer.send({ t: 'hello', ...me(), role: 'member' });
    sendStatus();
    toast(t('מחובר ללידר'), 3000);
    changed();
    if (onOpen) onOpen();
  }).catch(e => toast(e.message, 5000));
  return answer;
}

function sendStatus() {
  if (band.role !== 'member' || !band.leader) return;
  const v = currentViewerSync();
  band.leader.send({ t: 'status', ...me(), follow: band.follow, song: v && v.score ? store.songHash(v.score) : null, missing: [...wanted] });
}
let currentViewerSync = () => null;
viewerMod().then(m => { currentViewerSync = m.currentViewer; });

export function setFollow(v) {
  band.follow = v; sendStatus(); changed();
  if (v && band.last) applyState(band.last);
}

export function leaveBand() {
  for (const m of band.peers) m.peer.close();
  if (band.leader) band.leader.close();
  clearInterval(band.beat);
  Object.assign(band, { role: null, peers: [], leader: null, leaderInfo: null, last: null, lastState: null, controlBy: null, control: false, controller: null, lostLeader: null });
  changed();
}

// ---------------------------------------------------------------- messages
function wire(peer, m) {
  let wasLost = false;
  peer.onState = s => {
    const who = m ? m.info.name : t('הלידר');
    if (s === 'lost') { wasLost = true; toast(t('{who}: החיבור נחלש… מנסה להמשיך', { who }), 3000); }
    else if (s === 'open' && wasLost) { wasLost = false; toast(t('{who}: החיבור חזר', { who }), 2500); if (band.role === 'leader' && band.lastState) peer.send(band.lastState); }
    else if (s === 'failed' || s === 'closed') {
      if (band.role === 'member' && peer === band.leader) {
        // stay in the band: the setlist and songs stay, and one scan connects again
        band.leader = null; band.control = false; band.lostLeader = band.leaderInfo;
        toast(t('הלידר: החיבור נותק. אפשר להתחבר שוב מסמל הלהקה'), 6000);
      } else if (m) {
        if (band.controlBy === m) { band.controlBy = null; band.controller = null; broadcast({ t: 'controller', name: null }); }
        toast(t('{who}: החיבור נותק. "חיבור מחדש" במסך הלהקה', { who }), 5000);
      }
    }
    changed();
  };
  peer.onMessage = msg => handle(peer, m, msg).catch(e => console.error(e));
  peer.onFile = (meta, buf) => receiveFile(peer, meta, buf).catch(e => { console.error(e); toast(t('קבלת הקובץ נכשלה: {msg}', { msg: e.message })); });
}

async function handle(peer, m, msg) {
  if (msg.t === 'hello') {
    if (m) m.info = { name: msg.name, instrument: msg.instrument };
    else band.leaderInfo = { name: msg.name, instrument: msg.instrument };
    changed();
  } else if (msg.t === 'status' && m) {
    Object.assign(m.info, { name: msg.name, instrument: msg.instrument });
    m.state = { follow: msg.follow, song: msg.song, missing: msg.missing || [] };
    changed();
  } else if (msg.t === 'state' && band.role === 'member') {
    if (band.control) return;                  // this iPad leads the page turns now
    if (band.last && msg.seq < band.last.seq && msg.at <= band.last.at) return;
    await applyState(msg);
  } else if (msg.t === 'state' && band.role === 'leader' && m && band.controlBy === m) {
    // the musician who has the page turns: follow them here and pass it on to everyone else
    const st = { ...msg, seq: ++band.seq, at: Date.now() };
    if (st.setlist) st.setlist = { ...st.setlist, id: String(st.setlist.id).replace(/^band:/, '') };
    band.lastState = st;
    for (const x of band.peers) if (x !== m && x.peer.state === 'open') x.peer.send(st);
    await applyState(st);
  } else if (msg.t === 'control' && band.role === 'member') {
    band.control = !!msg.on;
    toast(band.control ? t('הדפדוף אצלך: כולם עוקבים אחריך') : t('הדפדוף חזר ללידר'), 3500);
    changed();
    if (band.control) { const { currentViewer } = await viewerMod(); report(currentViewer()); }
  } else if (msg.t === 'controller') {
    band.controller = msg.name; changed();
  } else if (msg.t === 'giveback' && m && band.controlBy === m) {
    await takeControl();
  } else if (msg.t === 'need') {
    await sendSong(peer, msg.hash);
  } else if (msg.t === 'cue') {
    showCue(msg.text);
  } else if (msg.t === 'setlist' && band.role === 'member') {
    mirrorSetlist(msg.setlist, true);
  }
}

// ---------------------------------------------------------------- following
const wanted = new Set();
function need(hash) {
  const from = band.role === 'member' ? band.leader : band.controlBy && band.controlBy.peer;
  if (!hash || wanted.has(hash) || store.findByHash(hash) || !from) return;
  wanted.add(hash);
  from.send({ t: 'need', hash });
  sendStatus();
}

function mirrorSetlist(sl, announce = false) {
  const id = 'band:' + sl.id;
  let local = store.state.setlists.find(x => x.id === id);
  const items = sl.items.map(it => {
    const f = store.findByHash(it.hash);
    if (!f) need(it.hash);
    const old = local && local.items.find(x => x.hash === it.hash);
    return { uid: 'b' + it.hash, scoreId: f ? f.song.id : 'missing:' + it.hash, hash: it.hash, semis: it.semis, note: it.note, ...(old && old.part != null ? { part: old.part } : {}) };
  });
  const same = local && JSON.stringify(local.items.map(x => [x.scoreId, x.semis, x.note])) === JSON.stringify(items.map(x => [x.scoreId, x.semis, x.note])) && local.name === sl.name + t(' · לידר');
  if (!local) { local = { id, name: sl.name + t(' · לידר'), created: Date.now(), items: [], band: true }; store.state.setlists.push(local); }
  if (!same) { local.items = items; local.name = sl.name + t(' · לידר'); store.save('setlists'); if (announce) toast(t('הסטליסט "{name}" התקבל מהלידר', { name: sl.name })); }
  return local;
}

let applying = Promise.resolve();
export function applyState(st) {
  band.last = st;
  applying = applying.then(() => doApply(st)).catch(e => console.error(e));
  return applying;
}
async function doApply(st) {
  if (st !== band.last) return;               // a newer state arrived meanwhile
  const own = band.role === 'leader' && st.setlist && store.state.setlists.find(x => x.id === st.setlist.id);
  const sl = st.setlist ? own || mirrorSetlist(st.setlist) : null;
  changed();
  if (!band.follow || !st.song) return;
  const f = store.findByHash(st.song.hash);
  if (!f) { need(st.song.hash); return; }
  const { openViewer, currentViewer } = await viewerMod();
  let v = currentViewer();
  if (v && ((v.annot && v.annot.editing) || v.noteEd)) return;  // never turn the page under the pencil or the note editor
  if (sl) {
    if (!v || !v.setlist || v.setlist.id !== sl.id || v.index !== st.index) {
      await openViewer({ setlistId: sl.id, index: st.index, perform: !!st.perform || !!(v && v.perform) });
      v = currentViewer();
    }
  } else if (!v || v.scoreId !== f.song.id || v.setlist) {
    await openViewer({ scoreId: f.song.id, perform: !!st.perform || !!(v && v.perform) });
    v = currentViewer();
    if (v && (st.semis || 0) !== v.semis) await v.applySemis(st.semis || 0);
  } else if ((st.semis || 0) !== v.semis) {
    await v.applySemis(st.semis || 0);
  }
  if (v && v.followTo && st === band.last) v.followTo(st.measure, st.frac);
  sendStatus();
}

// ---------------------------------------------------------------- songs between iPads
const SONG_EXT = /\.(mscz|pdf|musicxml|mxl)$/i;
export async function songFiles(hash) {
  const f = store.findByHash(hash);
  if (!f) return null;
  const { song, version: v } = f;
  const root = song.fileName || song.title;
  if (v.mscz) return [{ name: root + '.mscz', data: await store.blobBuffer(v.mscz.key) }];
  const out = [];
  if (v.score) out.push({ name: root + '.pdf', data: await store.blobBuffer(v.score.pdfKey) });
  for (const p of v.parts) out.push({ name: `${root}-${p.name}.pdf`, data: await store.blobBuffer(p.pdfKey) });
  if (v.xml) out.push({ name: root + (v.xml.zip ? '.mxl' : '.musicxml'), data: await store.blobBuffer(v.xml.key) });
  return out;
}
async function sendSong(peer, hash) {
  const files = await songFiles(hash);
  if (!files) return;
  for (let i = 0; i < files.length; i++) {
    const d = files[i].data;
    await peer.sendFile({ kind: 'song', hash, name: files[i].name, i, n: files.length }, typeof d === 'string' ? new TextEncoder().encode(d) : d);
  }
}
// share one song (leader → all musicians, musician → leader)
export async function shareSong(scoreId) {
  const s = store.scoreById(scoreId); if (!s) return;
  const hash = store.songHash(s);
  const targets = band.role === 'leader' ? band.peers.filter(m => m.peer.state === 'open').map(m => m.peer) : band.leader ? [band.leader] : [];
  if (!targets.length) return toast(t('אין אף אחד מחובר'));
  toast(t('שולח את "{title}"…', { title: s.title }));
  for (const p of targets) await sendSong(p, hash);
  toast(t('"{title}" נשלח ל-{devices}', { title: s.title, devices: targets.length === 1 ? t('מכשיר אחד') : t('{n} מכשירים', { n: targets.length }) }));
}
export async function shareSetlist(setlistId) {
  const l = store.state.setlists.find(x => x.id === setlistId); if (!l || band.role !== 'leader') return;
  const msg = { t: 'setlist', setlist: { id: l.id, name: l.name, items: l.items.map(it => { const x = store.scoreById(it.scoreId); return { hash: store.songHash(x), title: x ? x.title : '?', semis: it.semis ?? 0, note: it.note || '' }; }) } };
  broadcast(msg);
  toast(t('הסטליסט נשלח ל-{n} נגנים. שירים שחסרים אצלם יישלחו לבד', { n: band.peers.length }));
}
export async function shareFonts() {
  const fonts = (await (await import('./db.js')).get('fonts')) || [];
  if (!fonts.length) return toast(t('אין גופנים לשלוח'));
  const db = await import('./db.js');
  for (const m of band.peers) for (let i = 0; i < fonts.length; i++) {
    const b = await db.getBlob(fonts[i].key);
    await m.peer.sendFile({ kind: 'font', name: fonts[i].name, i, n: fonts.length }, new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b));
  }
  toast(t('הגופנים נשלחו'));
}

const inbox = new Map();
async function receiveFile(peer, meta, buf) {
  const key = meta.kind + ':' + (meta.hash || 'fonts');
  const box = inbox.get(key) || []; box[meta.i || 0] = new File([buf], meta.name); inbox.set(key, box);
  if (box.filter(Boolean).length < (meta.n || 1)) return;
  inbox.delete(key);
  const { importFiles } = await import('./importer.js');
  if (meta.kind === 'font') { await importFiles(box); return; }
  if (!SONG_EXT.test(meta.name)) return;
  const pdfSong = !box.some(f => /\.mscz$/i.test(f.name));
  await importFiles(box, { sig: pdfSong ? meta.hash : null, quiet: true });
  wanted.delete(meta.hash);
  toast(t('התקבל: {name}', { name: meta.name.replace(SONG_EXT, '') }), 2500);
  sendStatus();
  if (band.role === 'leader') for (const x of band.peers) if (x.peer !== peer && x.state.missing && x.state.missing.includes(meta.hash)) sendSong(x.peer, meta.hash).catch(() => {});
  if (band.last && (band.role === 'member' || band.controlBy)) applyState(band.last);
}

// ---------------------------------------------------------------- cues on screen
export function showCue(text, mine = false) {
  band.cues.unshift({ text, at: Date.now() }); band.cues.length = Math.min(band.cues.length, 20);
  document.querySelectorAll('.cue-banner').forEach(x => x.remove());
  const el = h('div', { class: 'cue-banner' + (mine ? ' mine' : ''), role: 'alert', dir: 'auto' }, t(text + '|cue'));
  el.onclick = () => el.remove();
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------------------------------------------------------------- the band screen
export const CUES = ['חוזרים על הפזמון', 'עוד פעם', 'לקודה', 'סיום', 'עצירה', 'שקט / רק תופים', 'ביחד!', 'האטה', 'סולו', 'לשיר הבא'];

export async function openBand() {
  const body = h('div', { class: 'band' });
  const sh = sheet(t('להקה'), body, { wide: true, onClose: () => { off(); if (scan) scan.stop(); } });
  let scan = null;
  const off = onBand(() => render());
  const render = () => {
    if (scan) return;
    body.replaceChildren(...(band.role === 'leader' ? leaderView() : band.role === 'member' ? memberView() : startView()));
  };
  const startView = () => [
    h('p', {}, t('כל האייפדים על אותה רשת Wi-Fi (גם בלי אינטרנט). הלידר מדפדף, וכל נגן רואה את הפרט שלו באותו מקום.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn labeled primary big', onclick: () => { startLeading(); invite(); } }, icon('perform'), t('אני הלידר')),
      h('button', { class: 'btn labeled big', onclick: () => joinFlow() }, icon('import'), t('הצטרפות ללידר'))),
    h('p', { class: 'hint' }, t('השם שלך: {name} (משנים בהגדרות)', { name: me().name + (me().instrument ? ' · ' + t(me().instrument) : '') })),
  ];
  const leaderView = () => [
    h('p', {}, h('b', {}, t('אתה הלידר. ')), band.peers.length ? t('{n} נגנים מחוברים.', { n: band.peers.filter(m => m.peer.state === 'open').length }) : t('עוד אין נגנים מחוברים.')),
    band.controlBy ? h('div', { class: 'row' }, h('span', {}, t('הדפדוף אצל '), h('b', { dir: 'auto' }, band.controlBy.info.name), t(' – כולם, גם אתה, עוקבים אחריו.')),
      h('button', { class: 'btn labeled primary', onclick: () => takeControl() }, t('החזרת הדפדוף אליי'))) : null,
    h('div', { class: 'list' }, ...band.peers.map(m => h('div', { class: 'li' },
      h('span', { class: 'dot ' + (m.peer.state === 'open' ? 'ok' : 'bad') }),
      m.info.instrument ? instIcon(m.info.instrument) : null, h('b', { dir: 'auto' }, m.info.name), h('span', { class: 'muted', dir: 'auto' }, m.info.instrument ? ' · ' + t(m.info.instrument) : ''),
      h('span', { class: 'muted' }, ' · ' + (m.peer.state === 'lost' ? t('החיבור נחלש…') : m.peer.state !== 'open' ? t('מנותק') : band.controlBy === m ? t('מדפדף לכולם') : m.state.missing && m.state.missing.length ? t('מקבל {n} שירים…', { n: m.state.missing.length }) : m.state.follow === false ? t('לא עוקב') : t('עוקב'))),
      m.peer.state === 'open' && band.controlBy !== m ? h('button', { class: 'btn labeled small', onclick: () => giveControl(m) }, t('העברת הדפדוף')) : null,
      m.peer.state === 'failed' || m.peer.state === 'closed' ? h('button', { class: 'btn labeled small primary', onclick: () => invite(m) }, t('חיבור מחדש')) : null,
      h('button', { class: 'btn ghost small', onclick: () => { if (band.controlBy === m) takeControl(); m.peer.close(); band.peers = band.peers.filter(x => x !== m); changed(); }, 'aria-label': t('ניתוק') }, icon('close'))))),
    h('div', { class: 'row' },
      h('button', { class: 'btn labeled primary', onclick: () => invite() }, icon('plus'), t('הוספת נגן')),
      h('button', { class: 'btn labeled', onclick: () => shareFonts() }, t('שליחת הגופנים שלי')),
      h('button', { class: 'btn labeled danger', onclick: async () => { if (await confirmBox(t('לסיים את הלהקה ולנתק את כולם?'), t('סיום|band'), true)) leaveBand(); } }, t('סיום|band'))),
    h('h3', {}, t('הודעה לכולם')),
    h('div', { class: 'cues' }, ...CUES.map(c => h('button', { class: 'chip', onclick: () => sendCue(c) }, t(c + '|cue')))),
    cueInput(),
    h('p', { class: 'hint' }, t('הדפדוף, השיר, הטון והסטליסט שלך עוברים לכולם לבד. כל נגן רואה את הפרט שלו, ועובר עמוד באותה תיבה שבה אתה.')),
  ];
  const cueInput = () => {
    const i = h('input', { class: 'input', dir: 'auto', placeholder: t('הודעה חופשית…') });
    const go = () => { sendCue(i.value.trim()); i.value = ''; };
    i.onkeydown = e => { if (e.key === 'Enter') go(); };
    return h('div', { class: 'row' }, i, h('button', { class: 'btn labeled', onclick: go }, t('שליחה')));
  };
  const memberView = () => !band.leader ? [
    h('p', {}, h('span', { class: 'dot bad' }), t(' החיבור ללידר '), h('b', { dir: 'auto' }, band.lostLeader ? band.lostLeader.name : ''), t(' נותק. הסטליסט והשירים נשארו אצלך.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn labeled primary big', onclick: () => joinFlow() }, icon('sync'), t('חיבור מחדש ללידר')),
      h('button', { class: 'btn labeled', onclick: () => leaveBand() }, t('יציאה מהלהקה'))),
    h('p', { class: 'hint' }, t('אצל הלידר: "חיבור מחדש" ליד השם שלך, ואז סורקים כמו בפעם הראשונה.')),
  ] : [
    h('p', {}, h('span', { class: 'dot ' + (band.leader.state === 'open' ? 'ok' : 'bad') }), band.leader.state === 'lost' ? t(' החיבור נחלש… ') : t(' מחובר ללידר '), h('b', { dir: 'auto' }, band.leaderInfo ? band.leaderInfo.name : '')),
    band.control ? h('div', { class: 'row' }, h('b', {}, t('הדפדוף אצלך – כולם עוקבים אחריך.')), h('button', { class: 'btn labeled', onclick: () => giveBack() }, t('החזרה ללידר')))
      : band.controller ? h('p', { class: 'hint' }, t('הדפדוף עכשיו אצל {name}', { name: band.controller })) : null,
    toggle(t('לעקוב אחרי הלידר (שיר, טון ודפדוף)'), band.follow, v => setFollow(v)),
    wanted.size ? h('p', { class: 'hint' }, t('מקבל {n} שירים מהלידר…', { n: wanted.size })) : null,
    band.cues.length ? h('div', { class: 'list' }, ...band.cues.slice(0, 5).map(c => h('div', { class: 'li' }, h('span', { dir: 'auto' }, t(c.text + '|cue')), h('small', { class: 'muted' }, new Date(c.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }))))) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn labeled danger', onclick: () => leaveBand() }, t('התנתקות'))),
    h('p', { class: 'hint' }, t('אפשר תמיד לדפדף לבד. הדפדוף הבא של הלידר מחזיר אותך למקום שלו.')),
  ];
  // leader: show an invitation, then scan the musician's answer
  const invite = async (replace = null) => {
    body.replaceChildren(h('p', { class: 'hint' }, t('מכין קוד…')));
    try {
      const { codeView, scanner } = await import('./qr.js');
      const { peer, code } = await newInvite();
      const view = await codeView(code, replace ? t('1. {name} סורק את הקוד הזה ("חיבור מחדש ללידר")', { name: replace.info.name }) : t('1. הנגן סורק את הקוד הזה ("הצטרפות ללידר")'));
      const next = h('button', { class: 'btn labeled primary big', onclick: () => {
        scan = scanner(async text => {
          try {
            if (replace) { band.peers = band.peers.filter(x => x !== replace); replace.peer.close(); }
            await addMusician(peer, text); toast(t('נגן התחבר')); scan = null; render(); return true;
          }
          catch (e) { toast(e.message, 4000); return false; }
        });
        body.replaceChildren(h('p', {}, t('2. סורקים את הקוד שמופיע עכשיו אצל הנגן')), scan.el,
          h('button', { class: 'btn labeled', onclick: () => { scan.stop(); scan = null; render(); } }, t('ביטול')));
      } }, t('2. סריקת הקוד של הנגן'));
      body.replaceChildren(view, next, h('button', { class: 'btn labeled', onclick: () => { peer.close(); render(); } }, t('ביטול')));
    } catch (e) { toast(e.message, 5000); render(); }
  };
  // musician: scan the leader's invitation, then show the answer
  const joinFlow = async () => {
    const { codeView, scanner } = await import('./qr.js');
    scan = scanner(async text => {
      try {
        const answer = await join(text, () => { scan = null; render(); });
        scan = { stop() {} };   // keep the answer on screen until connected
        body.replaceChildren(await codeView(answer, t('הלידר סורק עכשיו את הקוד הזה')), h('p', { class: 'hint' }, t('מחכה לחיבור…')));
        return true;
      } catch (e) { toast(e.message, 4000); return false; }
    });
    body.replaceChildren(h('p', {}, t('סורקים את הקוד שעל המסך של הלידר')), scan.el,
      h('button', { class: 'btn labeled', onclick: () => { scan.stop(); scan = null; render(); } }, t('ביטול')));
  };
  render();
  return sh;
}

// a small status for the library and viewer
export function bandLabel() {
  if (band.role === 'leader') return t('לידר · {n}', { n: band.peers.filter(m => m.peer.state === 'open').length });
  if (band.role === 'member') return !band.leader ? t('מנותק') : band.control ? t('מדפדף לכולם') : band.follow ? t('עוקב') : t('מחובר');
  return '';
}
