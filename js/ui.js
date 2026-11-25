// Small DOM helpers, icons, toast, sheets and dialogs.
import { t, locale } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const P = d => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  back: P('<path d="M9 6l6 6-6 6"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: P('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  grid: P('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  list: P('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  star: P('<path d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/>'),
  starFill: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>',
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  import: P('<path d="M12 3v12M7 10l5 5 5-5M4 19h16"/>'),
  sync: P('<path d="M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4"/>'),
  pen: P('<path d="M4 20l4-1L19 8a2.1 2.1 0 00-3-3L5 16z"/><path d="M14 7l3 3"/>'),
  marker: P('<path d="M9 15l-3 5h6l1-2"/><path d="M9 15l7-11 4 3-7 11z"/>'),
  eraser: P('<path d="M7 20h12"/><path d="M5.5 15.5l9-9a2 2 0 012.8 0l1.2 1.2a2 2 0 010 2.8L11 18H8z"/>'),
  text: P('<path d="M5 6V5h14v1M12 5v14M9 19h6"/>'),
  shape: P('<rect x="4" y="4" width="9" height="9" rx="1"/><circle cx="15.5" cy="15.5" r="4.5"/>'),
  select: P('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
  stamp: P('<path d="M5 15a7 7 0 0114 0"/><path d="M12 15h.01"/><path d="M3 19h18"/>'),
  undo: P('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  layers: P('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  lock: P('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  unlock: P('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>'),
  play: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  tuner: P('<path d="M4 18a8 8 0 0116 0"/><path d="M12 18l4-7"/>'),
  metronome: P('<path d="M8 21h8l-3-17h-2z"/><path d="M12 15l5-8"/>'),
  music: P('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  key: P('<path d="M4 17l6-10 4 6 2-3 4 7z"/>'),
  parts: P('<path d="M4 6h16M4 12h10M4 18h6"/>'),
  moon: P('<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>'),
  setlist: P('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h1M4 12h1M4 18h1"/>'),
  perform: P('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  more: P('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  drag: P('<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>'),
  trash: P('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>'),
  copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>'),
  share: P('<path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>'),
  bookmark: P('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  history: P('<path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 3"/>'),
  live: P('<path d="M3 12h3l3-8 4 16 3-8h5"/>'),
  page: P('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>'),
  audio: P('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>'),
  zoom: P('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M8.5 11h5M11 8.5v5"/>'),
  tag: P('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
  edit: P('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  loop: P('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 01-3 3H3"/>'),
  mac: P('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>'),
};

export function icon(name, cls = '') {
  const s = h('span', { class: 'ic ic-' + name + ' ' + cls, html: ICON[name] || '' });
  return s;
}
export function btn(iconName, label, onClick, cls = '') {
  return h('button', { class: 'btn ' + cls, onclick: onClick, 'aria-label': label, title: label },
    iconName ? icon(iconName) : null, label && cls.includes('labeled') ? h('span', {}, label) : null);
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Escape (a keyboard on the iPad) closes the sheet on top
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = [...document.querySelectorAll('.sheet-back:not(.closing)')].pop();
  if (top && top.closeSheet) { e.preventDefault(); e.stopPropagation(); top.closeSheet(); }
});

// bottom/center sheet; returns {el, close}
export function sheet(title, body, { wide = false, onClose } = {}) {
  const back = h('div', { class: 'sheet-back' });
  let shut = false;
  const close = () => { if (shut) return; shut = true; back.classList.remove('open'); back.classList.add('closing'); setTimeout(() => back.remove(), 200); onClose && onClose(); };
  back.closeSheet = close;
  const box = h('div', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', {}, title), btn('close', t('סגירה'), close, 'ghost')),
    h('div', { class: 'sheet-body' }, body));
  back.append(box);
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('open'));
  return { el: box, close };
}

export function confirmBox(text, okLabel = t('אישור'), danger = false) {
  return new Promise(resolve => {
    let done = false;
    const s = sheet('', h('div', { class: 'confirm' },
      h('p', {}, text),
      h('div', { class: 'row end' },
        h('button', { class: 'btn labeled', onclick: () => { done = true; s.close(); resolve(false); } }, t('ביטול')),
        h('button', { class: 'btn labeled ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; s.close(); resolve(true); } }, okLabel))),
    { onClose: () => { if (!done) resolve(false); } });
  });
}

export function promptBox(title, value = '', placeholder = '') {
  return new Promise(resolve => {
    let done = false;
    const input = h('input', { class: 'input', value, placeholder, dir: 'auto' });
    const ok = () => { done = true; s.close(); resolve(input.value.trim()); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    const s = sheet(title, h('div', { class: 'confirm' }, input,
      h('div', { class: 'row end' },
        h('button', { class: 'btn labeled', onclick: () => { done = true; s.close(); resolve(null); } }, t('ביטול')),
        h('button', { class: 'btn labeled primary', onclick: ok }, t('שמירה')))),
    { onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => input.focus(), 250);
  });
}

// segmented control
export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  for (const o of options) {
    const b = h('button', { class: 'seg-b' + (o.value === value ? ' on' : ''), role: 'radio', 'aria-checked': String(o.value === value) }, o.label);
    b.onclick = () => {
      wrap.querySelectorAll('.seg-b').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('on'); b.setAttribute('aria-checked', 'true');
      onChange(o.value);
    };
    wrap.append(b);
  }
  return wrap;
}

export function toggle(label, value, onChange) {
  const input = h('input', { type: 'checkbox', class: 'switch' });
  input.checked = !!value;
  input.onchange = () => onChange(input.checked);
  return h('label', { class: 'field toggle' }, h('span', {}, label), input);
}

export const fmtDate = t => t ? new Date(t).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '';
export const fmtDateTime = t => t ? new Date(t).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

// long press helper (for menus / exits)
export function onLongPress(el, fn, ms = 600) {
  let t = null;
  el.addEventListener('pointerdown', e => { t = setTimeout(() => { t = null; fn(e); }, ms); });
  const cancel = () => { if (t) clearTimeout(t); t = null; };
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', e => e.preventDefault());
}
