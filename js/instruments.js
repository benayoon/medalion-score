// Instrument icons: which instrument a part or a player is (by its name, in English or Hebrew, also the short
// names MuseScore prints: "Pno.", "B. Guit.", "Tpt."), and a small line drawing of it, in the style of the
// app's other icons.
import { h } from './ui.js';

const S = inner => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const DRAW = {
  score: S('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 7.5h8M8 10.5h8M8 13.5h8M8 16.5h5"/>'),
  piano: S('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M6.8 5v7.5h2.2V5M11 5v7.5h2.2V5M15.2 5v7.5h2.2V5M8 12.5V19M12.1 12.5V19M16.3 12.5V19"/>'),
  guitar: S('<path d="M13.6 10.4a3.4 3.4 0 00-4.8 0c-.8.8-.9 1.6-1.6 2.1-.8.5-2.3.4-3.3 1.4a3.9 3.9 0 005.6 5.6c1-1 .9-2.5 1.4-3.3.5-.7 1.3-.8 2.1-1.6a3.4 3.4 0 00.6-4.2z"/><circle cx="9.6" cy="14.4" r="1.3"/><path d="M12.4 11.6L19 5M17.5 3.5l3 3"/>'),
  bass: S('<path d="M12.8 11.2l-2-2c-1 .2-2.2 1.3-2.4 2.6-.1.8-1.3 1-2.6 2.2-1.6 1.6-1.4 4.2.4 5.8 1.6 1.6 4 1.6 5.4.2 1.3-1.3 1-2.6 1.9-3 1.2-.4 2.2-1.6 2.4-2.6z"/><path d="M8.3 15.7l2.4-2.4"/><path d="M13.8 10.2L21 3"/><path d="M18.6 3.4l2 2M17.4 4.6l2 2"/>'),
  drums: S('<ellipse cx="12" cy="11" rx="8" ry="2.8"/><path d="M4 11v6.2c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8V11"/><path d="M4.5 14.6l3.8 2.6 3.7-2.4 3.7 2.4 3.8-2.6"/><path d="M6.5 3.5L11 9M17.5 3.5L13 9"/>'),
  percussion: S('<ellipse cx="12" cy="5" rx="5" ry="1.8"/><path d="M7 5c-.9 4.6-.6 9.6 1.4 15h7.2c2-5.4 2.3-10.4 1.4-15"/><path d="M7.3 9.5h9.4"/>'),
  voice: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0012 0M12 17v4M9 21h6"/>'),
  trumpet: S('<path d="M2.5 12h11"/><path d="M13.5 9.5l7-4v13l-7-4z"/><path d="M5.5 12V8.5M8 12V8.5M10.5 12V8.5"/><path d="M4.5 12v3h9v-3"/>'),
  trombone: S('<path d="M2.5 9.5h12M2.5 14.5h12M2.5 9.5v5"/><path d="M14.5 9.5l6-3.5v12l-6-3.5"/><path d="M9 14.5v3.5h5.5"/>'),
  sax: S('<path d="M6 3l3.5 2.5V15a4 4 0 008 0v-3"/><path d="M14.5 12h6"/><path d="M9.5 8.5h.01M9.5 11.5h.01M9.5 14.5h.01"/>'),
  flute: S('<path d="M3.5 18.2L18.2 3.5l2.3 2.3L5.8 20.5z"/><path d="M8.5 15.5h.01M11 13h.01M13.5 10.5h.01M16 8h.01"/>'),
  clarinet: S('<path d="M11 2.5h2v14l2.5 5h-7l2.5-5z"/><path d="M12 6.5h.01M12 9.5h.01M12 12.5h.01"/>'),
  violin: S('<path d="M12 2v6"/><path d="M10 8c-2 0-3.1 1.3-3.1 2.8 0 1.2 1 1.8 1 2.7s-1.5 1.5-1.5 3.4C6.4 19.4 8.6 21 12 21s5.6-1.6 5.6-4.1c0-1.9-1.5-2.5-1.5-3.4s1-1.5 1-2.7C17.1 9.3 16 8 14 8z"/><path d="M10 15.5h4M10.2 11.5v2M13.8 11.5v2"/>'),
  cello: S('<path d="M12 1.5v5"/><path d="M10 6.5c-2.2 0-3.5 1.4-3.5 3.1 0 1.3 1.1 2 1.1 3s-1.7 1.6-1.7 3.6c0 2.6 2.4 4.3 6.1 4.3s6.1-1.7 6.1-4.3c0-2-1.7-2.6-1.7-3.6s1.1-1.7 1.1-3c0-1.7-1.3-3.1-3.5-3.1z"/><path d="M12 20.5v2M10 15h4"/>'),
  horn: S('<circle cx="10" cy="12.5" r="6"/><circle cx="10" cy="12.5" r="2.6"/><path d="M15.2 9.5l5.3-3.5v8l-4.4-2"/>'),
  harp: S('<path d="M5.5 3v18h13C18.5 13 13 6.5 5.5 3z"/><path d="M9 6.5V21M12.5 9.5V21M16 14V21"/>'),
  accordion: S('<rect x="3.5" y="5" width="4" height="14" rx="1"/><rect x="16.5" y="5" width="4" height="14" rx="1"/><path d="M7.5 6l3 2-3 2 3 2-3 2 3 2-3 2M16.5 6l-3 2 3 2-3 2 3 2-3 2 3 2"/>'),
  other: S('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
};

// the first rule that matches wins (so "Bass Clarinet" is a clarinet and "Alto Sax" a sax, not a voice)
const RULES = [
  ['score', /full score|^score$|פרטיטורה/],
  ['sax', /sax|סקסופון|סקס/],
  ['clarinet', /clarinet|\bcl\.|oboe|\bob\.|bassoon|\bbsn\.|cor anglais|english horn|קלרינט|אבוב|בסון/],
  ['flute', /flute|piccolo|\bfl\.|\bpicc\.|recorder|whistle|חליל|פיקולו/],
  ['trombone', /trombone|\btbn\.|\btrb\.|tuba|euphonium|baritone horn|טרומבון|טובה/],
  ['trumpet', /trumpet|\btpt\.|\btrp\.|flugel|cornet|חצוצרה|פליגלהורן|קורנט/],
  ['horn', /\bhorn|\bhn\.|קרן/],
  ['cello', /cello|\bvc\.|\bvlc\.|contrabass|double bass|upright bass|string bass|\bcb\.|צ['׳]?לו|קונטרבס/],
  ['violin', /violin|viola|\bvln\.|\bvn\.|\bvla\.|fiddle|strings?\b|כינור|ויולה|כלי קשת|מיתרים/],
  ['drums', /bass drum|kick drum/],
  ['bass', /bass|\bb\.\s*gu?i?t|בס/],
  ['guitar', /guitar|\bgtr\.|\bgt\.|\bguit\.|banjo|ukulele|mandolin|oud|bouzouki|גיטרה|יוקולילי|מנדולינה|בוזוקי/],
  ['harp', /harp|נבל/],
  ['accordion', /accordion|bandoneon|אקורדיון/],
  ['piano', /piano|\bpno\.|\bpf\.|keys|keyboard|organ|\borg\.|synth|rhodes|wurli|clav|harpsichord|celesta|vibraphone|marimba|xylophone|glock|פסנתר|קלידים|קלידן|אורגן|סינתי|ויברפון|מרימבה|קסילופון/],
  ['drums', /drum|\bkit\b|\bd\.\s*kit|\bdr\.|תופים|מתופף/],
  ['percussion', /perc|conga|bongo|cajon|shaker|tambourine|timbal|timpani|cowbell|הקשה|דרבוקה|קחון|טימפני/],
  ['voice', /voice|vocal|\bvox\b|singer|soprano|\balto\b|tenor|baritone|choir|chorus|lead|\bbv\b|backing|זמר|שירה|קול|מקהלה/],
];

export function instrumentOf(name) {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return 'other';
  for (const [k, re] of RULES) if (re.test(n)) return k;
  return 'other';
}

// a small icon for a part or an instrument name; '' (no part) is the full score
export function instIcon(name, { score = false } = {}) {
  const k = score && !name ? 'score' : instrumentOf(name);
  return h('span', { class: 'ic inst inst-' + k, html: DRAW[k] });
}

// an icon and a name side by side (for lists, buttons, chips)
export function withInst(name, label = name, opts = {}) {
  return h('span', { class: 'inst-label' }, instIcon(name, opts), h('span', { dir: 'auto' }, label));
}

// the instruments a player picks in Settings, with the words their part names usually have
export const PICKS = [
  ['piano', 'קלידים', 'piano, keys, keyboard, פסנתר, קלידים'],
  ['guitar', 'גיטרה', 'guitar, gtr, guit, גיטרה'],
  ['bass', 'בס', 'bass, בס'],
  ['drums', 'תופים', 'drum, kit, תופים'],
  ['percussion', 'כלי הקשה', 'perc, הקשה'],
  ['voice', 'שירה', 'voice, vocal, vox, שירה, זמר'],
  ['trumpet', 'חצוצרה', 'trumpet, tpt, חצוצרה'],
  ['sax', 'סקסופון', 'sax, סקסופון'],
  ['trombone', 'טרומבון', 'trombone, tbn, טרומבון'],
  ['flute', 'חליל', 'flute, חליל'],
  ['clarinet', 'קלרינט', 'clarinet, קלרינט'],
  ['violin', 'כינור', 'violin, כינור'],
  ['cello', 'צ׳לו', 'cello, צ׳לו'],
  ['horn', 'קרן', 'horn, קרן'],
];
export const drawingOf = k => DRAW[k] || DRAW.other;
