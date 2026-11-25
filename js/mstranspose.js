// Transpose a MuseScore 4 score (.mscx text) by semitones, the way MuseScore's "Transpose by interval"
// does it (same as `mscore --transpose` with transposeKeySignatures, transposeChordNames and no double
// sharps/flats). Works on the text so it runs anywhere (browser, worker, Node); drum staves are left alone.
//
// Spelling follows MuseScore's Transpose::transposeTpc: move the note by the interval's diatonic steps,
// and when that would need a double sharp/flat, move one step further/back instead.

// semitones → MuseScore interval (diatonic steps, chromatic semitones): m2 M2 m3 M3 P4 A4
const INTERVALS = { 1: [1, 1], 2: [1, 2], 3: [2, 3], 4: [2, 4], 5: [3, 5], 6: [3, 6] };
const STEP_OF = [3, 0, 4, 1, 5, 2, 6];            // (tpc+1)%7 → step: F C G D A E B
const STEP_SEMIS = [0, 2, 4, 5, 7, 9, 11];        // C D E F G A B
const NATURAL_TPC = [14, 16, 18, 13, 15, 17, 19]; // tpc of the natural note on each step

const tpc2step = t => STEP_OF[((t + 1) % 7 + 7) % 7];
const tpc2alter = t => Math.floor((t + 1) / 7) - 2;
const tpc2pitch = t => STEP_SEMIS[tpc2step(t)] + tpc2alter(t);
const step2tpc = (step, alter) => NATURAL_TPC[step] + 7 * alter;

export function interval(semis) {
  if (!semis) return [0, 0];
  const [d, c] = INTERVALS[Math.abs(semis)];
  return semis > 0 ? [d, c] : [-d, -c];
}

export function transposeTpc(tpc, [diatonic, chromatic], useDouble = false) {
  if (tpc == null || Number.isNaN(tpc) || tpc < -1 || tpc > 33) return tpc;
  if (!diatonic && !chromatic) return tpc;
  const minAlter = useDouble ? -2 : -1; const maxAlter = useDouble ? 2 : 1;
  const pitch = tpc2pitch(tpc);
  let steps = diatonic; let step = 0; let alter = 0;
  for (let k = 0; k < 10; k++) {
    step = ((tpc2step(tpc) + steps) % 7 + 7) % 7;
    const p1 = tpc2pitch(step2tpc(step, 0));
    alter = chromatic - (p1 - pitch);
    alter = ((alter % 12) + 18) % 12 - 6;            // into -6..5
    if (alter < minAlter) steps--;
    else if (alter > maxAlter) steps++;
    else break;
  }
  return step2tpc(step, alter);
}

// MuseScore: a key signature is a tpc (key + 14) transposed without doubles, kept within 7 sharps/flats
export function transposeKey(key, iv) {
  let t = transposeTpc(key + 14, iv, false);
  if (t > 21) t -= 12;
  if (t < 7) t += 12;
  return t - 14;
}

export function transposeMscx(text, semis) {
  if (!semis) return text;
  const iv = interval(semis);
  const tp = v => transposeTpc(v, iv, false);
  // staves of drum parts keep their notes
  const drumStaves = new Set();
  const writtenIv = new Map(); // staff id → concert→written interval of its instrument
  for (const p of text.matchAll(/<Part\b[\s\S]*?<\/Part>/g)) {
    const ids = [...p[0].matchAll(/<Staff id="(\d+)"/g)].map(m => m[1]);
    if (/<Drumset>|<useDrumset>1<\/useDrumset>/.test(p[0])) ids.forEach(i => drumStaves.add(i));
    const d = +((p[0].match(/<transposeDiatonic>(-?\d+)</) || [])[1] || 0);
    const c = +((p[0].match(/<transposeChromatic>(-?\d+)</) || [])[1] || 0);
    if (d || c) ids.forEach(i => writtenIv.set(i, [-d, -c]));
  }
  const chunks = text.split(/(?=<Staff id="\d+">\s*\n\s*<(?:Measure|VBox|HBox|TBox))/);
  return chunks.map(chunk => {
    const id = (chunk.match(/^<Staff id="(\d+)">/) || [])[1];
    if (!id || drumStaves.has(id)) return chunk;
    const wi = writtenIv.get(id);
    let concert = 0; // the concert key just read: a part's written key (actualKey) follows it
    return chunk.replace(
      /<(concertKey|actualKey)>(-?\d+)<\/\1>|<pitch>(\d+)<\/pitch>(\s*)<tpc>(-?\d+)<\/tpc>(?:(\s*)<tpc2>(-?\d+)<\/tpc2>)?|<tpc>(-?\d+)<\/tpc>|<(root|base)>(-?\d+)<\/\9>|<pitch>(\d+)<\/pitch>/g,
      (all, kt, kv, p, sp, v, sp2, v2, lone, rt, rv, lp) => {
        if (lp != null) return `<pitch>${+lp + semis}</pitch>`;
        if (kt === 'concertKey') { concert = transposeKey(+kv, iv); return `<${kt}>${concert}</${kt}>`; }
        if (kt) {
          // written key of a transposing instrument: from the new concert key, at most 6 sharps or flats
          if (!wi) return `<${kt}>${transposeKey(+kv, iv)}</${kt}>`;
          let k = transposeKey(concert, wi); if (k > 6) k -= 12; if (k < -6) k += 12;
          return `<${kt}>${k}</${kt}>`;
        }
        if (rt) return `<${rt}>${tp(+rv)}</${rt}>`;
        if (lone != null) return `<tpc>${tp(+lone)}</tpc>`;
        const pitch = +p + semis; const t1 = tp(+v);
        const out = `<pitch>${pitch}</pitch>${sp}<tpc>${t1}</tpc>`;
        if (v2 == null) return out;
        // written spelling of a transposing instrument follows the new concert note. Matches MuseScore on
        // the test scores except a rare enharmonic choice (it may write Fb/Gb for E/F# in a flat written key)
        return out + `${sp2}<tpc2>${wi ? transposeTpc(t1, wi, false) : tp(+v2)}</tpc2>`;
      });
  }).join('');
}
