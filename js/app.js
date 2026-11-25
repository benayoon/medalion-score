// Entry point. Everything runs on the iPad: no server, no account.
import * as store from './store.js';
import { t } from './i18n.js';
import { renderLibrary } from './library.js';
import { currentViewer } from './viewer.js';

async function main() {
  await store.load();
  renderLibrary();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
  // ask Safari not to evict the library (granted to apps added to the home screen)
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // make sure the engines for live mode and PDF export are cached (the service worker keeps what it fetches)
  setTimeout(() => {
    if (!navigator.onLine) return;
    for (const f of ['vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js', 'vendor/verovio-toolkit-wasm.js']) fetch(f).catch(() => {});
    import('./engrave.js').then(m => m.warm());
  }, 8000);
  // keys chosen in setlists that MuseScore has not engraved yet (songs imported as .mscz)
  setTimeout(() => import('./importer.js').then(m => m.prepareKeys()).catch(e => console.warn(e)), 15000);

  store.onChange(what => {
    if (currentViewer()) return;
    if (what === 'local' && document.querySelector('.lib')) renderLibrary();
  });
  // the band button in the library shows who is connected
  import('./band.js').then(({ onBand }) => onBand(() => { if (!currentViewer() && document.querySelector('.lib') && !document.querySelector('.sheet')) renderLibrary(); }));
}

main().catch(e => {
  console.error(e);
  document.getElementById('app').textContent = t('שגיאה בטעינת האפליקציה: {msg}', { msg: e.message });
});
