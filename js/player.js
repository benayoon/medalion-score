// Reference recording attached to a song: slow down without changing pitch, A–B loop.
import { h, icon, btn, sheet, toast } from './ui.js';
import * as store from './store.js';
import { t } from './i18n.js';
import * as db from './db.js';

let audio = null; let audioFor = null; let loop = { a: null, b: null };

export async function audioSheet(score) {
  const meta = store.metaFor(score.id);
  const body = h('div', { class: 'audio-sheet' });
  const pick = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.aac', hidden: true });
  pick.onchange = async () => {
    const f = pick.files[0]; if (!f) return;
    const key = 'audio:' + score.id;
    await db.setBlob(key, f);
    store.updateMeta(score.id, { audioKey: key, audioName: f.name });
    if (audio) { audio.pause(); audio = null; audioFor = null; }
    toast(t('ההקלטה צורפה לשיר'));
    s.close(); audioSheet(score);
  };
  const attach = h('button', { class: 'btn labeled', onclick: () => pick.click() }, icon('import'), meta.audioKey ? t('החלפת הקלטה') : t('צירוף הקלטה (mp3/m4a)'));

  if (!meta.audioKey) {
    body.append(h('p', { class: 'hint' }, t('אין עדיין הקלטת רפרנס לשיר הזה.')), attach, pick);
    const s = sheet(t('הקלטת רפרנס'), body);
    return;
  }
  if (audioFor !== score.id) {
    const blob = await db.getBlob(meta.audioKey);
    if (!blob) { toast(t('ההקלטה לא נמצאה')); return; }
    if (audio) audio.pause();
    audio = new Audio(URL.createObjectURL(blob));
    audio.preservesPitch = true; audio.webkitPreservesPitch = true;
    audioFor = score.id; loop = { a: null, b: null };
    audio.addEventListener('timeupdate', () => {
      if (loop.a != null && loop.b != null && audio.currentTime >= loop.b) audio.currentTime = loop.a;
    });
  }
  const fmt = t => isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00';
  const time = h('span', { class: 'mono' });
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'range', 'aria-label': t('מיקום') });
  const playB = btn(audio.paused ? 'play' : 'pause', t('ניגון'), () => { if (audio.paused) audio.play(); else audio.pause(); }, 'big');
  const upd = () => {
    time.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
    if (!seek._drag && audio.duration) seek.value = Math.round(audio.currentTime / audio.duration * 1000);
    playB.querySelector('.ic').innerHTML = (audio.paused ? icon('play') : icon('pause')).innerHTML;
  };
  seek.addEventListener('pointerdown', () => { seek._drag = true; });
  seek.addEventListener('change', () => { seek._drag = false; if (audio.duration) audio.currentTime = seek.value / 1000 * audio.duration; });
  const iv = setInterval(upd, 250);
  audio.addEventListener('play', upd); audio.addEventListener('pause', upd);
  const speed = h('select', { class: 'mini-select', 'aria-label': t('מהירות') },
    ...[0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25].map(r => h('option', { value: r, selected: audio.playbackRate === r }, Math.round(r * 100) + '%')));
  speed.onchange = () => { audio.playbackRate = +speed.value; };
  const loopLabel = h('span', { class: 'muted' });
  const showLoop = () => { loopLabel.textContent = loop.a != null ? `A ${fmt(loop.a)}${loop.b != null ? ' → B ' + fmt(loop.b) : ''}` : t('בלי לולאה'); };
  showLoop();
  body.append(
    h('p', { class: 'muted', dir: 'auto' }, meta.audioName || ''),
    h('div', { class: 'row center' }, btn('back', t('אחורה 5 שניות'), () => { audio.currentTime = Math.max(0, audio.currentTime - 5); }, ''), playB, time),
    seek,
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('מהירות (בלי שינוי גובה)')), speed)),
    h('div', { class: 'row' },
      h('button', { class: 'btn labeled', onclick: () => { loop.a = audio.currentTime; loop.b = null; showLoop(); } }, 'A'),
      h('button', { class: 'btn labeled', onclick: () => { if (loop.a != null && audio.currentTime > loop.a) { loop.b = audio.currentTime; audio.currentTime = loop.a; } showLoop(); } }, 'B'),
      h('button', { class: 'btn labeled', onclick: () => { loop = { a: null, b: null }; showLoop(); } }, t('ביטול לולאה')),
      loopLabel),
    h('div', { class: 'row' }, attach, pick,
      h('button', {
        class: 'btn labeled danger', onclick: async () => {
          audio.pause(); await db.delBlob(meta.audioKey); store.updateMeta(score.id, { audioKey: null, audioName: null });
          audio = null; audioFor = null; s.close(); toast(t('ההקלטה הוסרה'));
        },
      }, t('הסרה'))));
  upd();
  const s = sheet(t('הקלטת רפרנס'), body, { onClose: () => clearInterval(iv) });
}
