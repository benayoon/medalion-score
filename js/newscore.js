// A new, empty song: its name, instruments, key, meter, tempo and number of measures. It is written as a
// MusicXML file of whole-measure rests and goes through the same import as any other file, so it is a song
// like the rest (live mode, note editor, versions), and opens straight in the note editor.
import { h, sheet, toast } from './ui.js';
import { t } from './i18n.js';
import * as store from './store.js';
import { importFiles } from './importer.js';
import { PICKS, drawingOf, instrumentOf } from './instruments.js';

// what each instrument is on paper: its name, clef(s), and for a transposing one how far its written notes
// are from the sound ([diatonic, chromatic, octaves]); program: the General MIDI sound
const INST = {
  piano: { name: 'Piano', abbr: 'Pno.', clefs: [['G', 2], ['F', 4]], program: 1 },
  guitar: { name: 'Guitar', abbr: 'Guit.', clefs: [['G', 2, -1]], tr: [0, 0, -1], program: 26 },
  bass: { name: 'Bass Guitar', abbr: 'B. Guit.', clefs: [['F', 4, -1]], tr: [0, 0, -1], program: 34 },
  drums: { name: 'Drum Kit', abbr: 'D. Kit', clefs: [['percussion']], drums: true },
  percussion: { name: 'Percussion', abbr: 'Perc.', clefs: [['percussion']], drums: true },
  voice: { name: 'Voice', abbr: 'Vo.', clefs: [['G', 2]], program: 53 },
  trumpet: { name: 'B♭ Trumpet', abbr: 'B♭ Tpt.', clefs: [['G', 2]], tr: [-1, -2, 0], program: 57 },
  sax: { name: 'Alto Saxophone', abbr: 'A. Sax.', clefs: [['G', 2]], tr: [-5, -9, 0], program: 66 },
  trombone: { name: 'Trombone', abbr: 'Tbn.', clefs: [['F', 4]], program: 58 },
  flute: { name: 'Flute', abbr: 'Fl.', clefs: [['G', 2]], program: 74 },
  clarinet: { name: 'B♭ Clarinet', abbr: 'B♭ Cl.', clefs: [['G', 2]], tr: [-1, -2, 0], program: 72 },
  violin: { name: 'Violin', abbr: 'Vln.', clefs: [['G', 2]], program: 41 },
  cello: { name: 'Violoncello', abbr: 'Vc.', clefs: [['F', 4]], program: 43 },
  horn: { name: 'Horn in F', abbr: 'F Hn.', clefs: [['G', 2]], tr: [-4, -7, 0], program: 61 },
};
// a written key for a transposing instrument: so many fifths more than the concert key
const KEY_UP = { '-2': 2, '-9': 3, '-7': 1 };
const KEYS = [[-7, 'C♭'], [-6, 'G♭'], [-5, 'D♭'], [-4, 'A♭'], [-3, 'E♭'], [-2, 'B♭'], [-1, 'F'], [0, 'C'], [1, 'G'], [2, 'D'], [3, 'A'], [4, 'E'], [5, 'B'], [6, 'F♯'], [7, 'C♯']];
const MINOR = { '-7': 'A♭m', '-6': 'E♭m', '-5': 'B♭m', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm', 0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F♯m', 4: 'C♯m', 5: 'G♯m', 6: 'D♯m', 7: 'A♯m' };
const METERS = ['4/4', '3/4', '2/4', '6/8', '12/8', '2/2', '5/4', '6/4', '7/8', '9/8'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the MusicXML of an empty song. insts: keys of INST, top to bottom
export function newScoreXml({ title, composer = '', insts = ['piano'], fifths = 0, meter = '4/4', tempo = 120, measures = 32 }) {
  const [beats, beatType] = meter.split('/').map(Number);
  const DIV = 8; const len = beats * DIV * 4 / beatType;
  const list = insts.map(k => INST[k] || INST.piano);
  // two of the same instrument: "Voice 1", "Voice 2"
  const names = list.map((x, i) => { const n = list.filter(y => y === x).length; return n > 1 ? `${x.name} ${list.slice(0, i + 1).filter(y => y === x).length}` : x.name; });
  const partList = list.map((x, i) => `    <score-part id="P${i + 1}">
      <part-name>${esc(names[i])}</part-name>
      <part-abbreviation>${esc(x.abbr)}</part-abbreviation>
      <score-instrument id="P${i + 1}-I1"><instrument-name>${esc(x.name)}</instrument-name></score-instrument>
      <midi-instrument id="P${i + 1}-I1"><midi-channel>${x.drums ? 10 : (i % 9) + 1}</midi-channel><midi-program>${x.program || 1}</midi-program></midi-instrument>
    </score-part>`).join('\n');
  const rest = (staff, voice) => `      <note><rest measure="yes"/><duration>${len}</duration><voice>${voice}</voice>${staff ? `<staff>${staff}</staff>` : ''}</note>`;
  const parts = list.map((x, i) => {
    const two = x.clefs.length > 1;
    const key = x.drums ? 0 : Math.max(-7, Math.min(7, fifths + (x.tr ? KEY_UP[x.tr[1]] || 0 : 0)));
    const attrs = `      <attributes>
        <divisions>${DIV}</divisions>
        <key><fifths>${key}</fifths></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
${two ? `        <staves>${x.clefs.length}</staves>\n` : ''}${x.clefs.map(([sign, line, oct], k) => `        <clef${two ? ` number="${k + 1}"` : ''}><sign>${sign}</sign>${line ? `<line>${line}</line>` : ''}${oct ? `<clef-octave-change>${oct}</clef-octave-change>` : ''}</clef>`).join('\n')}
${x.tr ? `        <transpose><diatonic>${x.tr[0]}</diatonic><chromatic>${x.tr[1]}</chromatic>${x.tr[2] ? `<octave-change>${x.tr[2]}</octave-change>` : ''}</transpose>\n` : ''}      </attributes>`;
    const mark = i === 0 && tempo ? `      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>\n` : '';
    const body = two ? `${rest(1, 1)}\n      <backup><duration>${len}</duration></backup>\n${rest(2, 5)}` : rest(0, 1);
    const ms = [];
    for (let m = 1; m <= measures; m++) {
      ms.push(`    <measure number="${m}">\n${m === 1 ? attrs + '\n' + mark : ''}${body}\n${m === measures ? '      <barline location="right"><bar-style>light-heavy</bar-style></barline>\n' : ''}    </measure>`);
    }
    return `  <part id="P${i + 1}">\n${ms.join('\n')}\n  </part>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${esc(title)}</work-title></work>
  <identification>${composer ? `<creator type="composer">${esc(composer)}</creator>` : ''}<encoding><software>Medalion Score</software></encoding></identification>
  <part-list>
${partList}
  </part-list>
${parts}
</score-partwise>
`;
}

const keyOf = s => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
// a name no song in the library has (a file with a song's name would become that song's next version)
function freeName(want) {
  const have = new Set(store.state.local.flatMap(s => [keyOf(s.fileName), keyOf(s.title)]));
  if (!have.has(keyOf(want))) return want;
  for (let n = 2; ; n++) if (!have.has(keyOf(`${want} ${n}`))) return `${want} ${n}`;
}

// the sheet: what the new song is; open(scoreId) shows it (the library opens it in the note editor)
export function openNewScore(open) {
  const st = store.state.settings;
  const mine = instrumentOf(st.instrument);
  const chosen = [INST[mine] ? mine : 'piano'];
  const title = h('input', { class: 'input', dir: 'auto', placeholder: t('שם השיר') });
  const composer = h('input', { class: 'input', dir: 'auto', value: st.name || '' });
  const sel = (opts, value) => { const s = h('select', { class: 'input' }, ...opts.map(([v, label]) => h('option', { value: String(v) }, label))); s.value = String(value); return s; };
  const key = sel(KEYS.map(([f, n]) => [f, `${n} / ${MINOR[f]}${f ? `  (${Math.abs(f)}${f > 0 ? '♯' : '♭'})` : ''}`]), 0);
  const meter = sel(METERS.map(m => [m, m]), '4/4');
  const tempo = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 20, max: 400, value: 120 });
  const count = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min: 1, max: 400, value: 32 });
  const order = h('p', { class: 'hint', dir: 'auto' });
  const picks = h('div', { class: 'inst-picks' });
  const draw = () => {
    picks.replaceChildren(...PICKS.filter(([k]) => INST[k]).map(([k, he]) => h('button', {
      class: 'inst-pick' + (chosen.includes(k) ? ' on' : ''), type: 'button', 'aria-pressed': String(chosen.includes(k)),
      onclick: () => { const i = chosen.indexOf(k); if (i >= 0) chosen.splice(i, 1); else chosen.push(k); draw(); },
    }, h('span', { class: 'ic', html: drawingOf(k) }), h('span', {}, t(he)))));
    order.textContent = chosen.length > 1 ? t('בפרטיטורה, מלמעלה למטה: {list}', { list: chosen.map(k => t(PICKS.find(p => p[0] === k)[1])).join(', ') }) : '';
  };
  draw();
  let busy = false;
  const go = h('button', { class: 'btn labeled primary' }, t('יצירה ועריכה'));
  go.onclick = async () => {
    if (busy) return;
    const name = title.value.trim();
    if (!name) { title.focus(); return toast(t('צריך שם לשיר')); }
    if (!chosen.length) return toast(t('בוחרים לפחות כלי אחד'));
    busy = true; go.disabled = true; go.textContent = t('יוצר…');
    try {
      const free = freeName(name);
      const xml = newScoreXml({
        title: free, composer: composer.value.trim(), insts: chosen, fifths: +key.value, meter: meter.value,
        tempo: Math.max(20, Math.min(400, +tempo.value || 120)), measures: Math.max(1, Math.min(400, +count.value || 32)),
      });
      const before = new Set(store.state.local.map(s => s.id));
      const r = await importFiles([new File([xml], free + '.musicxml', { type: 'application/vnd.recordare.musicxml+xml' })], { quiet: true });
      const song = store.state.local.find(s => !before.has(s.id));
      if (!song || r.failed) throw new Error(t('השיר לא נוצר'));
      sh.close();
      open(song.id);
    } catch (e) {
      console.error(e); toast(t('יצירת השיר נכשלה: {msg}', { msg: e.message }), 5000);
      busy = false; go.disabled = false; go.textContent = t('יצירה ועריכה');
    }
  };
  const sh = sheet(t('שיר חדש'), h('div', { class: 'confirm new-score' },
    h('label', { class: 'field' }, h('span', {}, t('שם השיר')), title),
    h('label', { class: 'field' }, h('span', {}, t('מלחין / מעבד')), composer),
    h('div', { class: 'field' }, h('span', {}, t('כלים (אפשר כמה)')), picks, order),
    h('div', { class: 'row ns-row' },
      h('label', { class: 'field' }, h('span', {}, t('סולם')), key),
      h('label', { class: 'field' }, h('span', {}, t('משקל')), meter)),
    h('div', { class: 'row ns-row' },
      h('label', { class: 'field' }, h('span', {}, t('טמפו (רבעים לדקה)')), tempo),
      h('label', { class: 'field' }, h('span', {}, t('מספר תיבות')), count)),
    h('p', { class: 'hint' }, t('השיר נפתח ישר בעורך התווים. תיבות, סולם ומשקל אפשר לשנות גם אחר כך בחלון "תיבה".')),
    h('div', { class: 'row end' }, go)), { wide: true });
  setTimeout(() => title.focus(), 350);
}
