// Chromatic tuner on the iPad microphone (YIN pitch detection), plus a reference tone. Works offline.
import { h, sheet, segmented } from './ui.js';
import { t } from './i18n.js';
import * as store from './store.js';
import { audioCtx } from './metronome.js';

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// what the player reads: written = concert + n semitones
export const TRANSPOSE = [
  { value: 0, label: 'C' }, { value: 2, label: 'B♭' }, { value: 9, label: 'E♭' }, { value: 7, label: 'F' },
];

// YIN on a mono buffer → { freq, clarity } or null for silence / no clear pitch
export function detectPitch(input, sampleRate, minF = 30, maxF = 2200) {
  const buf = input, sr = sampleRate;
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.008) return null;
  const maxTau = Math.min(Math.floor(sr / minF), n >> 1);
  const minTau = Math.max(2, Math.floor(sr / maxF));
  const w = n - maxTau;
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let i = 0; i < w; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
    d[tau] = s;
  }
  // cumulative mean normalized difference
  const c = new Float32Array(maxTau + 1); c[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxTau; tau++) { run += d[tau]; c[tau] = run ? d[tau] * tau / run : 1; }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (c[t] < 0.15) { while (t + 1 <= maxTau && c[t + 1] < c[t]) t++; tau = t; break; }
  }
  if (tau < 0) {   // no dip under the threshold: the best one, if it is good enough
    let best = minTau;
    for (let t = minTau; t <= maxTau; t++) if (c[t] < c[best]) best = t;
    if (c[best] > 0.35) return null;
    tau = best;
  }
  // parabolic interpolation around the dip
  let t = tau;
  if (tau > 1 && tau < maxTau) {
    const a = d[tau - 1], b = d[tau], e = d[tau + 1];
    const den = a + e - 2 * b;
    if (den) t = tau + (a - e) / (2 * den);
  }
  return { freq: sr / t, clarity: 1 - c[tau], rms };
}

// frequency → nearest note (MIDI number) and how far off, in cents
export function noteOf(freq, a4 = 440) {
  const m = 69 + 12 * Math.log2(freq / a4);
  const midi = Math.round(m);
  return { midi, cents: Math.round((m - midi) * 100) };
}
export const noteName = midi => NAMES[((midi % 12) + 12) % 12];
export const octave = midi => Math.floor(midi / 12) - 1;
export const freqOf = (midi, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12);

// playing notes in: which notes heard one after another are new notes. s: the state ({} to start),
// midi: the note heard now (null: nothing clear), now: ms. A note counts once it holds steady for `hold` ms;
// the same note again counts only after a silence of `gap` ms (two A's in a row need a breath between them).
export function heardNote(s, midi, now, hold = 80, gap = 90) {
  if (midi == null) {
    if (s.quietSince == null) s.quietSince = now;
    if (now - s.quietSince >= gap) s.held = null;
    s.cand = null;
    return null;
  }
  s.quietSince = null;
  if (midi !== s.cand) { s.cand = midi; s.since = now; }
  if (now - s.since >= hold && midi !== s.held) { s.held = midi; return midi; }
  return null;
}

export function openTuner() {
  audioCtx();   // created inside the tap, before any await: Safari allows audio only then
  const st = store.state.settings;
  let a4 = st.tunerA4 || 440;
  let trans = st.tunerTrans || 0;
  let stream = null, src = null, an = null, timer = null, stopped = false;
  let hist = [];
  let drone = null;

  const name = h('div', { class: 'tn-name' }, '—');
  const oct = h('sub', {}, '');
  const cents = h('div', { class: 'tn-cents', dir: 'ltr' }, '');
  const hz = h('div', { class: 'tn-hz muted', dir: 'ltr' }, '');
  const needle = h('div', { class: 'tn-needle' });
  const scale = h('div', { class: 'tn-scale', dir: 'ltr' },
    ...[-50, -25, 0, 25, 50].map(v => h('span', { style: `left:${50 + v}%` }, v ? (v > 0 ? '+' + v : String(v)) : '0')), needle);
  const msg = h('p', { class: 'hint' }, t('מנגנים צליל אחד ארוך'));
  const box = h('div', { class: 'tuner' }, h('div', { class: 'tn-note' }, name, oct), cents, scale, hz);

  const show = r => {
    if (!r) {
      box.classList.add('idle'); return;
    }
    hist.push(r.freq); if (hist.length > 5) hist.shift();
    const f = [...hist].sort((x, y) => x - y)[hist.length >> 1];   // median: one wrong octave does not jump
    const { midi, cents: c } = noteOf(f, a4);
    const w = midi + trans;
    box.classList.remove('idle');
    name.textContent = noteName(w); oct.textContent = octave(w);
    cents.textContent = (c > 0 ? '+' : '') + c;
    hz.textContent = f.toFixed(1) + ' Hz';
    needle.style.left = (50 + Math.max(-50, Math.min(50, c))) + '%';
    box.classList.toggle('in', Math.abs(c) <= 3);
    box.classList.toggle('near', Math.abs(c) > 3 && Math.abs(c) <= 10);
  };

  const start = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = t('אין גישה למיקרופון בכתובת הזו (צריך HTTPS).'); return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { msg.textContent = t('המיקרופון לא נפתח: {msg}', { msg: e.message }); return; }
    if (stopped) return stop();
    const c = audioCtx();
    if (c.state !== 'running') await c.resume().catch(() => {});
    if (c.state !== 'running') {   // Safari may hold the audio until a touch
      msg.textContent = t('נוגעים במסך כדי להפעיל את הטיונר');
      box.onclick = () => c.resume().then(() => { msg.textContent = t('מנגנים צליל אחד ארוך'); });
    }
    src = c.createMediaStreamSource(stream);
    an = c.createAnalyser(); an.fftSize = 4096;
    // through a silent output, so the browser keeps pulling the microphone
    const mute = c.createGain(); mute.gain.value = 0;
    src.connect(an); an.connect(mute).connect(c.destination);
    const buf = new Float32Array(an.fftSize);
    let silent = 0;
    const tick = () => {
      if (stopped) return;
      an.getFloatTimeDomainData(buf);
      const r = detectPitch(buf, c.sampleRate);
      if (r && r.clarity > 0.8) { silent = 0; show(r); }
      else if (++silent > 8) { hist = []; show(null); }
      timer = setTimeout(tick, 60);
    };
    tick();
  };
  const stopDrone = () => { if (drone) { const c = audioCtx(); drone.g.gain.setTargetAtTime(0, c.currentTime, 0.05); const d = drone; setTimeout(() => d.o.forEach(o => o.stop()), 300); drone = null; } };
  const stop = () => {
    stopped = true; clearTimeout(timer); stopDrone();
    try { src && src.disconnect(); an && an.disconnect(); } catch { /* gone */ }
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
  };

  // reference tone: the written note the player picks, sounding at concert pitch
  const droneRow = h('div', { class: 'tn-drone', dir: 'ltr' });
  const renderDrone = () => droneRow.replaceChildren(...NAMES.map((n, i) => {
    const b = h('button', { class: 'btn' + (drone && drone.i === i ? ' on' : '') }, n);
    b.onclick = () => {
      const was = drone && drone.i === i;
      stopDrone();
      if (!was) {
        const c = audioCtx();
        const midi = 60 + ((i - trans) % 12 + 12) % 12;   // concert pitch, between C4 and B4
        const f = freqOf(midi, a4);
        const g = c.createGain(); g.gain.value = 0; g.connect(c.destination);
        const o = [1, 2].map((k, j) => { const x = c.createOscillator(); x.type = j ? 'sine' : 'triangle'; x.frequency.value = f * k; const gg = c.createGain(); gg.gain.value = j ? 0.15 : 0.5; x.connect(gg).connect(g); x.start(); return x; });
        g.gain.setTargetAtTime(0.35, c.currentTime, 0.05);
        drone = { i, o, g, midi };
      }
      renderDrone();
    };
    return b;
  }));
  renderDrone();

  const a4In = h('input', { type: 'number', class: 'input', value: a4, min: 415, max: 466, inputmode: 'numeric' });
  a4In.onchange = () => { a4 = Math.max(415, Math.min(466, +a4In.value || 440)); a4In.value = a4; store.setSetting('tunerA4', a4); hist = [];
    if (drone) drone.o.forEach((x, k) => x.frequency.setValueAtTime(freqOf(drone.midi, a4) * (k + 1), audioCtx().currentTime)); };

  sheet(t('טיונר'), h('div', {},
    box, msg,
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('span', {}, t('טון הכלי (C = צליל קונצרט)')), segmented(TRANSPOSE.map(o => ({ value: o.value, label: h('bdi', { dir: 'ltr' }, o.label) })), trans, v => { trans = +v; store.setSetting('tunerTrans', trans); hist = []; renderDrone(); })),
      h('label', { class: 'field' }, h('span', {}, t('כיוון הלה (A4, הרץ)')), a4In)),
    h('div', { class: 'field' }, h('span', {}, t('צליל ייחוס (נוגעים שוב כדי להפסיק)')), droneRow),
    h('p', { class: 'hint' }, t('ירוק = מכוון (עד 3 סנט). בכלי מעתיק בוחרים את הטון שלו, והטיונר מראה את התו הכתוב שהנגן קורא.'))),
    { onClose: stop });
  start();
}
