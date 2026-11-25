// Metronome with Web Audio look-ahead scheduling and a visual flash callback.
let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// accent: true = first beat, false = beat, 'sub' = a subdivision between beats (softer)
export function click(time, accent) {
  const c = audioCtx();
  const o = c.createOscillator(); const g = c.createGain();
  o.frequency.value = accent === 'sub' ? 880 : accent ? 1760 : 1175;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent === 'sub' ? 0.25 : accent ? 0.9 : 0.55, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
  o.connect(g).connect(c.destination);
  o.start(time); o.stop(time + 0.08);
}

export class Metronome {
  constructor() {
    this.bpm = 100; this.beats = 4; this.running = false; this.onBeat = null;
    this.sub = 1;        // clicks per beat: 1, 2 (eighths), 3 (triplets), 4 (sixteenths)
    this.sound = true;   // false: silent, only the flash on the screen
    this._timer = null; this._next = 0; this._beat = 0;
  }
  start() {
    if (this.running) return;
    const c = audioCtx();
    this.running = true; this._beat = 0; this._s = 0; this._next = c.currentTime + 0.08;
    const tick = () => {
      while (this._next < c.currentTime + 0.12) {
        const sub = Math.max(1, this.sub | 0);
        if (this._s >= sub) this._s = 0;   // the subdivision was changed while running
        const onBeat = this._s === 0;
        const b = this._beat % this.beats;
        const accent = onBeat ? b === 0 : 'sub';
        if (this.sound) click(this._next, accent);
        if (onBeat) {
          const delay = Math.max(0, (this._next - c.currentTime) * 1000);
          setTimeout(() => this.onBeat && this.onBeat(b, accent), delay);
        }
        this._next += 60 / this.bpm / sub;
        if (++this._s >= sub) { this._s = 0; this._beat++; }
      }
    };
    tick();
    this._timer = setInterval(tick, 25);
  }
  stop() { this.running = false; clearInterval(this._timer); }
  toggle() { this.running ? this.stop() : this.start(); return this.running; }
}

// count-in: `bars` bars of clicks, resolves when done
export function countIn(bpm, beats, bars = 1, onBeat) {
  const c = audioCtx();
  const t0 = c.currentTime + 0.1; const dt = 60 / bpm;
  for (let i = 0; i < beats * bars; i++) {
    click(t0 + i * dt, i % beats === 0);
    setTimeout(() => onBeat && onBeat(i % beats), (0.1 + i * dt) * 1000);
  }
  return new Promise(r => setTimeout(r, (0.1 + beats * bars * dt) * 1000));
}
