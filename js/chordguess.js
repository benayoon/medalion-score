// Chord symbol suggestions from the notes that sound: which chord the music under a place spells.
// notes: [{ pitch, weight }] (weight: how long it sounds; the lowest note counts as the bass), key: -7…7
// → [{ text: 'Am7', score }] best first. Pure: no DOM, no store.
import { pitchToTpc } from './msedit.js';

const KINDS = [
  // [suffix, intervals, how plain it is (plain names win a tie)]
  ['', [0, 4, 7], 0], ['m', [0, 3, 7], 0], ['7', [0, 4, 7, 10], 0.1], ['maj7', [0, 4, 7, 11], 0.15], ['m7', [0, 3, 7, 10], 0.1],
  ['m7b5', [0, 3, 6, 10], 0.25], ['dim', [0, 3, 6], 0.3], ['dim7', [0, 3, 6, 9], 0.35], ['sus4', [0, 5, 7], 0.25], ['sus2', [0, 2, 7], 0.3],
  ['6', [0, 4, 7, 9], 0.3], ['m6', [0, 3, 7, 9], 0.35], ['aug', [0, 4, 8], 0.4], ['add9', [0, 2, 4, 7], 0.35], ['9', [0, 2, 4, 7, 10], 0.35],
  ['m9', [0, 2, 3, 7, 10], 0.4], ['7sus4', [0, 5, 7, 10], 0.35], ['5', [0, 7], 0.45],
];
const LETTER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const spell = tpc => LETTER[((tpc + 1) % 7 + 7) % 7] + (tpc < 13 ? 'b'.repeat(Math.ceil((13 - tpc) / 7)) : tpc > 19 ? '#'.repeat(Math.ceil((tpc - 19) / 7)) : '');
const pcName = (pc, key) => spell(pitchToTpc(60 + pc, key));

export function guessChords(notes, key = 0, max = 5) {
  const ns = notes.filter(n => n && n.weight > 0 && n.pitch != null);
  if (!ns.length) return [];
  const w = new Array(12).fill(0);
  for (const n of ns) w[((n.pitch % 12) + 12) % 12] += n.weight;
  const low = ns.reduce((a, n) => (n.pitch < a.pitch ? n : a), ns[0]);
  const bass = ((low.pitch % 12) + 12) % 12;
  w[bass] += Math.max(...w) * 0.35;   // the bass weighs more
  const total = w.reduce((a, x) => a + x, 0);
  const scale = new Set([0, 2, 4, 5, 7, 9, 11].map(x => (((x + 7 * key) % 12) + 12) % 12));
  const out = [];
  for (let root = 0; root < 12; root++) {
    for (const [suf, iv, plain] of KINDS) {
      const pcs = new Set(iv.map(x => (root + x) % 12));
      let inC = 0, outC = 0, missing = 0;
      for (let pc = 0; pc < 12; pc++) if (pcs.has(pc)) { inC += w[pc]; if (!w[pc]) missing++; } else outC += w[pc];
      // the third (or what stands for it) and the root should be there
      if (!w[root] && bass !== root) continue;
      let s = (inC - 1.2 * outC) / total - missing * 0.22 - plain * 0.3;
      if (bass === root) s += 0.18;
      else if (pcs.has(bass)) s += 0.02; else s -= 0.3;
      if (scale.has(root)) s += 0.05;
      const text = pcName(root, key) + suf + (bass !== root && pcs.has(bass) && w[bass] > total * 0.12 ? '/' + pcName(bass, key) : '');
      out.push({ text, score: s });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set(); const best = [];
  for (const c of out) { if (seen.has(c.text)) continue; seen.add(c.text); best.push(c); if (best.length >= max) break; }
  return best;
}

// the notes sounding in a span of a measure, from every staff of the song (drums and slashes left out)
// doc: MsDoc; from/to: ticks inside measure m. Pitches are concert.
export function notesIn(doc, m, from, to) {
  const out = [];
  for (const s of doc.staves()) {
    if (s.drums) continue;
    for (let v = 0; v < 4; v++) {
      const ev = doc.events(s.id, m, v); if (!ev) continue;
      for (const e of ev.events) {
        if (e.rest || e.grace) continue;
        const a = Math.max(from, e.tick), b = Math.min(to, e.tick + e.ticks);
        if (b <= a) continue;
        // a note on the beat says more about the chord than a passing one
        const w = (b - a) * (e.tick % 480 === 0 ? 1 : 0.6);
        for (const n of e.notes) if (!n.slash) out.push({ pitch: n.pitch, weight: w });
      }
    }
  }
  return out;
}
