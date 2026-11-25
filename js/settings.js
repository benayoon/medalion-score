// Settings: profile, pedal mapping, display, storage, backup.
import { h, $, icon, btn, toast, sheet, segmented, toggle, fmtDateTime } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import { confirmBox } from './ui.js';
import { t, lang, setLang } from './i18n.js';
import { PICKS, drawingOf, instrumentOf } from './instruments.js';

export function openSettings() {
  const st = store.state.settings;
  const set = (k) => v => store.setSetting(k, v);
  const input = (k, attrs = {}) => {
    const i = h('input', { class: 'input', value: st[k] || '', dir: 'auto', ...attrs });
    i.onchange = () => store.setSetting(k, i.value.trim());
    return i;
  };
  // the main instrument: typed, or picked from the icons (which also fills the default part's words,
  // unless the player wrote their own)
  const instInput = input('instrument');
  const wordsInput = input('partWords', { dir: 'ltr' });
  const autoWords = () => (PICKS.find(p => p[1] === st.instrument) || [])[2] || '';
  const picksOn = () => instPicks.querySelectorAll('.inst-pick').forEach(b => b.classList.toggle('on', b.dataset.k === instrumentOf(instInput.value)));
  const instPicks = h('div', { class: 'inst-picks' }, ...PICKS.map(([k, he, words]) => h('button', {
    class: 'inst-pick', 'data-k': k, title: t(he), 'aria-label': t(he),
    onclick: () => {
      const wasAuto = !st.partWords || st.partWords === autoWords();
      instInput.value = t(he); store.setSetting('instrument', he);
      if (wasAuto) { wordsInput.value = words; store.setSetting('partWords', words); }
      picksOn();
    },
  }, h('span', { class: 'ic', html: drawingOf(k) }), h('span', {}, t(he)))));
  instInput.addEventListener('input', picksOn);
  picksOn();
  const keyNames = k => k.map(x => x === ' ' ? t('רווח') : x).join(', ');
  const nextLbl = h('span', { class: 'mono' }, keyNames(st.keysNext));
  const prevLbl = h('span', { class: 'mono' }, keyNames(st.keysPrev));
  const learn = (which, lbl) => {
    toast(t('לחץ עכשיו על הפדל (או מקש)…'), 6000);
    const on = e => {
      e.preventDefault(); window.removeEventListener('keydown', on, true);
      const k = e.key;
      const nextK = st.keysNext.filter(x => x !== k); const prevK = st.keysPrev.filter(x => x !== k);
      if (which === 'next') nextK.unshift(k); else prevK.unshift(k);
      store.setSetting('keysNext', nextK); store.setSetting('keysPrev', prevK);
      nextLbl.textContent = keyNames(nextK); prevLbl.textContent = keyNames(prevK);
      toast(which === 'next' ? t('"{key}" ממופה לעמוד הבא', { key: k === ' ' ? t('רווח') : k }) : t('"{key}" ממופה לעמוד קודם', { key: k === ' ' ? t('רווח') : k }));
    };
    window.addEventListener('keydown', on, true);
  };

  const storage = h('p', { class: 'muted small' });
  const fontsLine = h('p', { class: 'muted small' });
  const showFonts = async () => {
    const list = (await db.get('fonts')) || [];
    fontsLine.textContent = list.length ? t('{n} גופנים: {names}', { n: list.length, names: list.map(f => f.name.replace(/\.[^.]+$/, '')).join(', ') }) : t('עוד לא יובאו גופני טקסט');
  };
  showFonts();
  const fontInput = h('input', { type: 'file', hidden: true, multiple: true });
  fontInput.onchange = async () => { const { importFiles } = await import('./importer.js'); await importFiles(fontInput.files); fontInput.value = ''; showFonts(); };
  const restoreInput = h('input', { type: 'file', hidden: true, accept: '.json,application/json' });
  restoreInput.onchange = async () => { const f = restoreInput.files[0]; restoreInput.value = ''; if (f) await restoreBackup(f); };
  (async () => {
    const parts = [t('{n} שירים', { n: store.state.local.length })];
    try { const e = await navigator.storage.estimate(); parts.push(t('{mb}MB בשימוש', { mb: (e.usage / 1048576).toFixed(0) })); } catch { /* n/a */ }
    try { parts.push(await navigator.storage.persisted() ? t('שמור לצמיתות') : t('לא מוגן מפני ניקוי – פתח מהמסך הבית')); } catch { /* n/a */ }
    storage.textContent = parts.join(' · ');
  })();

  sheet(t('הגדרות'), h('div', { class: 'settings' },
    h('h3', {}, t('שפה')),
    h('div', { class: 'field' },
      segmented([{ value: 'en', label: 'English' }, { value: 'he', label: 'עברית' }], lang(), v => setLang(v))),

    h('h3', {}, t('פרופיל')),
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('שם')), input('profileName')), h('label', { class: 'field' }, h('span', {}, t('כלי ראשי')), instInput)),
    instPicks,
    h('label', { class: 'field' }, h('span', {}, t('פרט ברירת מחדל: מילים בשם הפרט, מופרדות בפסיק')), wordsInput),
    h('p', { class: 'hint' }, t('שיר עם פרטים ייפתח בפרט הראשון שמתאים למילים האלה (למשל Piano לקלידן).')),

    h('h3', {}, t('דפדוף ופדל')),
    h('div', { class: 'field' }, h('span', {}, t('לחיצה בצד הזה מעבירה קדימה')),
      segmented([{ value: 'right', label: t('ימין') }, { value: 'left', label: t('שמאל') }], st.nextSide, set('nextSide'))),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('span', {}, t('עמוד הבא')), nextLbl, h('button', { class: 'btn labeled', onclick: () => learn('next', nextLbl) }, t('למידה מהפדל'))),
      h('div', { class: 'field' }, h('span', {}, t('עמוד קודם')), prevLbl, h('button', { class: 'btn labeled', onclick: () => learn('prev', prevLbl) }, t('למידה מהפדל')))),
    h('p', { class: 'hint' }, t('פדלי AirTurn / PageFlip במצב מקלדת שולחים חצים או PageUp/PageDown, והם כבר ממופים.')),

    h('h3', {}, t('תצוגה')),
    h('div', { class: 'field' }, h('span', {}, t('רקע')), segmented([{ value: 'normal', label: t('רגיל') }, { value: 'night', label: t('לילה') }, { value: 'sepia', label: t('ספיה') }], st.theme, set('theme'))),
    toggle(t('שני עמודים ברוחב'), st.twoUp, set('twoUp')),
    toggle(t('חיתוך שוליים אוטומטי'), st.crop, set('crop')),
    toggle(t('חצי עמוד'), st.halfPage, set('halfPage')),
    toggle(t('רק העיפרון מצייר (אצבע מדפדפת)'), st.pencilOnly, set('pencilOnly')),
    toggle(t('ספירה לפני ניגון במצב חי'), st.countIn, set('countIn')),

    h('h3', {}, t('MuseScore באייפד')),
    h('p', { class: 'hint' }, t('מייבאים את קובץ ה-MuseScore עצמו (.mscz), ו-MuseScore כותב אותו כאן: פרטיטורה, כל הפרטים, ובכל טון שבוחרים – בעיצוב המקורי. טון של שיר בסטליסט נכתב מראש ונשמר, כך שבהופעה הוא מוכן.')),
    fontsLine,
    h('div', { class: 'row' },
      h('button', { class: 'btn labeled', onclick: () => fontInput.click() }, icon('import'), t('ייבוא גופנים')), fontInput,
      h('button', { class: 'btn labeled', onclick: async () => { await clearFonts(); showFonts(); } }, t('מחיקת הגופנים'))),
    h('p', { class: 'hint' }, t('גופני התווים של MuseScore כבר בפנים. גופני טקסט שהשירים שלך משתמשים בהם (כותרות, עברית, אקורדים) מייבאים פעם אחת: קובצי ttf/otf מהמק (למשל מ-~/Library/Fonts), בקובץ zip או אחד אחד. בלי הגופן, הטקסט ייכתב בגופן אחר.')),
    h('p', { class: 'hint' }, t('שירים שיובאו כ-PDF: טון אחר מוצג במצב חי, או דרך רשימת הטונים וסקריפט הייצוא במק.')),
    h('button', { class: 'btn labeled', onclick: async () => { const { exportKeysList } = await import('./setlists.js'); exportKeysList(); } }, icon('key'), t('רשימת טונים ל-MuseScore')),
    h('h3', {}, t('ספרייה וגיבוי')),
    h('p', { class: 'hint' }, t('כל השירים שמורים באייפד ועובדים בלי אינטרנט. שיר שעודכן ב-MuseScore: מייצאים שוב ומייבאים – הוא נשמר כגרסה חדשה, וההערות עוברות לפי מספר תיבה.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn labeled', onclick: () => exportBackup() }, icon('share'), t('גיבוי הערות וסטליסטים')),
      h('button', { class: 'btn labeled', onclick: () => restoreInput.click() }, icon('import'), t('שחזור מגיבוי')), restoreInput),
    h('p', { class: 'hint' }, t('הגיבוי כולל הגדרות, תגיות, סטליסטים והערות עיפרון (בלי קובצי התווים עצמם, שנשארים אצלך ב-iCloud).')),
    storage,
    h('p', { class: 'muted small' }, t('Medalion Score · גרסה {v}', { v: '0.7.0' }))), { wide: true });
}

async function clearFonts() {
  for (const f of (await db.get('fonts')) || []) await db.delBlob(f.key);
  await db.set('fonts', []);
  (await import('./engrave.js')).fontsChanged();
  toast(t('הגופנים נמחקו'));
}

// ---------------------------------------------------------------- backup (user data only, not the score files)
export async function backupData() {
  const ann = {};
  for (const k of await db.keys()) if (String(k).startsWith('ann:')) ann[k] = await db.get(k);
  const songs = Object.fromEntries(store.state.local.map(s => [s.id, s.fileName || s.title]));
  return { app: 'medalion-score', version: 1, date: Date.now(), settings: store.state.settings, meta: store.state.meta,
    setlists: store.state.setlists, templates: store.state.templates, annotations: ann, songs };
}


async function exportBackup() {
  const data = await backupData();
  const name = t('Medalion Score גיבוי {date}', { date: new Date().toISOString().slice(0, 10) }) + '.json';
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file] }).catch(e => { if (e.name !== 'AbortError') toast(t('השיתוף נכשל: {msg}', { msg: e.message })); });
  }
  else { const a = h('a', { href: URL.createObjectURL(file), download: name }); a.click(); }
}

export async function restoreBackup(f) {
  let data;
  try { data = JSON.parse(await f.text()); } catch { return toast(t('הקובץ אינו גיבוי תקין')); }
  if (data.app !== 'medalion-score') return toast(t('הקובץ אינו גיבוי של Medalion Score'));
  if (!(await confirmBox(t('השחזור מחליף את ההגדרות, הסטליסטים, התגיות וההערות שבאייפד. להמשיך?'), t('שחזור'), true))) return;
  // songs are matched by file name, since ids differ between iPads
  const key = s => String(s || '').normalize('NFC').toLowerCase().trim();
  const here = new Map(store.state.local.map(s => [key(s.fileName || s.title), s.id]));
  const map = id => here.get(key((data.songs || {})[id])) || id;
  store.state.settings = { ...store.state.settings, ...data.settings };
  store.state.meta = Object.fromEntries(Object.entries(data.meta || {}).map(([id, m]) => [map(id), m]));
  store.state.setlists = (data.setlists || []).map(l => ({ ...l, items: l.items.map(it => ({ ...it, scoreId: map(it.scoreId) })) }));
  store.state.templates = data.templates || store.state.templates;
  for (const [k, v] of Object.entries(data.annotations || {})) await db.set('ann:' + map(k.slice(4)), v);
  for (const k of ['settings', 'meta', 'setlists', 'templates']) await store.saveNow(k);
  toast(t('השחזור הושלם'));
  setTimeout(() => location.reload(), 800);
}
