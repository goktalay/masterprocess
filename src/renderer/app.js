'use strict';

// Ana pencere: süreç tablosu (ağaç / liste, sanal kaydırma, satır içi küçük grafikler), sistem özeti, arama,
// sıralama, klavye ve yönetim eylemleri. Seçili sürecin ayrıntıları detail.js'tedir (DETAIL).
const $ = (s) => document.querySelector(s);
const IS_RTL = document.documentElement.dir === 'rtl';
const ROW_H = 26;
const SEC = t('unit.sec');
const DUR = { d: t('unit.d'), h: t('unit.h'), m: t('unit.m'), s: t('unit.s') };
const OSS = [['Master Process', 'MIT'], ['Electron', 'MIT'], ['Chromium', 'BSD-3-Clause +'], ['Node.js', 'MIT'], ['@napi-rs/keyring', 'MIT'], ['.NET runtime (mp-agent)', 'MIT']];
const SHORTCUTS = [
  ['↑ / ↓', 'keys.nav'], ['← / →', 'keys.expand'], ['Home / End', 'keys.ends'], ['Del', 'keys.kill'], ['Ctrl+F', 'keys.search'],
  ['Space', 'keys.pause'], ['Ctrl+,', 'keys.settings'], ['Esc', 'keys.escape'],
];
// Sütunlar: [sıralama anahtarı, etiket, sınıf]
const COLUMNS = [
  ['name', 'col.name', ''], ['pid', 'col.pid', 'num'], ['cpu', 'col.cpu', 'num'], ['ws', 'col.mem', 'num'],
  ['io', 'col.io', 'num'], ['gpu', 'col.gpu', 'num'], ['threads', 'col.threads', 'num w-only'], ['handles', 'col.handles', 'num w-only'],
];
const METRICS = [['cpu', 'cpu', 44, 10], ['ws', 'ws', 44, 0], ['io', 'io', 44, 65536], ['gpu', 'gpu', 36, 10]]; // [alan, renk, tuval genişliği, ölçek tabanı]

const APP = {
  hist: null, hello: null,
  mon: { kind: null, platform: window.api.platform, error: null, paused: false, refreshMs: 1000, capacity: 300 },
  procs: [], byPid: new Map(), byKey: new Map(), sys: null, t: 0,
  rows: [], matched: null, selected: null, query: '',
  settings: {}, view: { refreshMs: 1000, mode: 'tree', sort: { key: 'name', dir: 1 } },
  collapsed: new Set(), fresh: new Map(), events: [],
};
let acct = { loggedIn: false };
let barDismissed = false;
const tailBuf = new Float32Array(60);

const errText = (code) => {
  const key = `err.${code || 'failed'}`;
  const s = t(key);
  return s === key ? t('err.failed') : s;
};
APP.errText = errText;
const hueOf = (name) => {
  let x = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x % 360;
};
APP.hueOf = hueOf;
APP.gpuOn = () => !!(APP.hello && APP.hello.gpuCounters);

// --- Sistem özeti ---------------------------------------------------------------
const SYS_TILES = [['cpu', 'sys.cpu', '--m-cpu'], ['mem', 'sys.mem', '--m-mem'], ['io', 'sys.io', '--m-io'], ['gpu', 'sys.gpu', '--m-gpu']];
function buildSys() {
  $('#sys').innerHTML = SYS_TILES.map(([k, label, c]) => `<button class="sys-tile" type="button" data-k="${k}" style="--c:var(${c})">
    <span><span class="st-l">${esc(t(label))}</span><span class="st-v" data-v></span></span><canvas></canvas></button>`).join('');
  $('#sys').onclick = (e) => { if (e.target.closest('.sys-tile')) select(null); };
}
function sysValue(k) {
  const s = APP.sys;
  if (!s) return '—';
  if (k === 'cpu') return `${FMT.pct(s.cpu)}<small> %</small>`;
  if (k === 'mem') return `${esc(FMT.bytes(s.memTotal - s.memAvail))}<small> / ${esc(FMT.bytes(s.memTotal))}</small>`;
  if (k === 'io') return esc(FMT.rate((s.ioRead || 0) + (s.ioWrite || 0), SEC));
  return APP.gpuOn() ? `${FMT.pct(s.gpu)}<small> %</small>` : '—';
}
function paintSys() {
  const ss = APP.hist ? APP.hist.sysSeries() : null;
  const c = CHARTS.colors();
  for (const tile of $('#sys').children) {
    const k = tile.dataset.k;
    tile.querySelector('[data-v]').innerHTML = sysValue(k);
    const cv = tile.querySelector('canvas');
    if (!ss || !cv.offsetParent) continue;
    const n = Math.min(ss.n, 60);
    const vals = ss[k].subarray(ss[k].length - n);
    CHARTS.spark(cv, vals, n, { w: 62, h: 28, color: c[k], floorMax: k === 'io' ? 1048576 : 100, slots: 60 });
  }
  $('#stats').textContent = APP.procs.length ? t('stats.procs', { count: APP.procs.length }) : `v${window.api.version}`;
}

// --- Tablo: satır listesi ---------------------------------------------------------
function rebuildRows() {
  const tree = APP.view.mode === 'tree';
  const sort = APP.view.sort || { key: 'name', dir: 1 };
  const f = TREE.filterProcs(APP.procs, APP.query, { keepAncestors: tree });
  APP.matched = f.matched;
  if (tree) {
    const built = f.matched ? TREE.buildTree(f.procs) : { roots: APP.roots || [] };
    // Arama sırasında daraltmalar yok sayılır: eşleşen süreç kapalı bir dalın içinde kalmasın
    APP.rows = TREE.flattenTree(built.roots, { sortKey: sort.key, sortDir: sort.dir, collapsed: f.matched ? new Set() : APP.collapsed });
  } else {
    APP.rows = TREE.flattenList(f.procs, { sortKey: sort.key, sortDir: sort.dir });
  }
}

function buildHead() {
  const sort = APP.view.sort || {};
  $('#ptHead').innerHTML = COLUMNS.map(([key, label, cls]) => {
    const on = sort.key === key;
    return `<button type="button" class="th ${cls}${on ? ' on' : ''}" data-key="${key}" title="${esc(t(label + 'Hint'))}">${cls.includes('num') && on ? icon(sort.dir < 0 ? 'chevronDown' : 'chevronUp') : ''}<span>${esc(t(label))}</span>${!cls.includes('num') && on ? icon(sort.dir < 0 ? 'chevronDown' : 'chevronUp') : ''}</button>`;
  }).join('');
}
function setSort(key) {
  const cur = APP.view.sort || {};
  const dir = cur.key === key ? -cur.dir : key === 'name' || key === 'pid' ? 1 : -1;
  APP.view = { ...APP.view, sort: { key, dir } };
  window.api.setSettings({ view: { sort: { key, dir } } });
  buildHead();
  refreshTable();
}
function setMode(mode) {
  if (APP.view.mode === mode) return;
  APP.view = { ...APP.view, mode };
  window.api.setSettings({ view: { mode } });
  paintMode();
  refreshTable();
  ensureVisible();
}
function paintMode() {
  for (const b of $('#viewMode').children) b.classList.toggle('on', b.dataset.m === APP.view.mode);
}

// --- Tablo: sanal kaydırma ve satır çizimi ---------------------------------------
const pool = [];
function makeRow() {
  const el = h(`<div class="pr"><div class="pn"></div><div class="c num"></div>${METRICS.map(([k]) => `<div class="c m${k === 'gpu' ? ' g' : ''}"><span class="v"></span><canvas></canvas></div>`).join('')}<div class="c num w-only"></div><div class="c num w-only"></div></div>`);
  const kids = el.children;
  const m = [2, 3, 4, 5].map((i) => ({ v: kids[i].firstElementChild, cv: kids[i].lastElementChild }));
  return { el, pn: kids[0], pid: kids[1], m, th: kids[6], hd: kids[7], sig: '', cls: '' };
}
function markName(name) {
  const q = APP.query.trim().toLowerCase();
  const i = q ? name.toLowerCase().indexOf(q) : -1;
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}`;
}
function nameHtml(r) {
  const p = r.p;
  let g = '';
  for (let d = 0; d < r.depth; d++) {
    g += d === r.depth - 1 ? `<span class="g ${r.last ? 'el' : 'tee'}"></span>` : `<span class="g${r.guides[d + 1] ? ' on' : ''}"></span>`;
  }
  const tw = r.hasChildren ? `<span class="tw has${r.collapsed ? ' closed' : ''}">${icon(r.collapsed ? 'chevronRight' : 'chevronDown')}</span>` : '<span class="tw"></span>';
  const name = String(p.name || '?');
  let sub = '';
  if (r.collapsed) {
    const node = APP.byPid.get(p.pid);
    if (node) sub = `<span class="pn-sub">+${TREE.subtreeSum(node, []).count - 1}</span>`;
  }
  return `${g}${tw}<span class="pi" style="--hue:${hueOf(name)}">${esc(name.charAt(0))}</span><span class="pn-name">${markName(name)}</span>${sub}`;
}
function rowTitle(r) {
  if (!r.collapsed) return '';
  const node = APP.byPid.get(r.p.pid);
  if (!node) return '';
  const s = TREE.subtreeSum(node, ['cpu', 'ws']);
  return t('tree.subtree', { count: s.count, cpu: FMT.pct(s.cpu), mem: FMT.bytes(s.ws) });
}
function fillRow(slot, r, c) {
  const p = r.p;
  const sig = `${p.key}|${r.depth}|${r.last}|${r.collapsed}|${r.hasChildren}|${r.guides.join('')}|${APP.query}|${p.name}`;
  if (slot.sig !== sig) {
    slot.sig = sig;
    slot.pn.innerHTML = nameHtml(r);
    slot.el.dataset.key = p.key;
    slot.pid.textContent = p.pid;
  }
  slot.el.title = rowTitle(r);
  const cls = `pr${p.key === APP.selected ? ' sel' : ''}${APP.matched && !APP.matched.has(p.pid) ? ' dim' : ''}${APP.fresh.has(p.key) ? ' new' : ''}`;
  if (slot.cls !== cls) { slot.cls = cls; slot.el.className = cls; }
  const gpuOn = APP.gpuOn();
  const text = [FMT.pct(p.cpu), FMT.bytes(p.ws), p.io > 0 ? FMT.rate(p.io) : '0', gpuOn ? FMT.pct(p.gpu) : '—'];
  const zero = [p.cpu < 0.05, false, !(p.io > 0), !(p.gpu >= 0.05)];
  const hot = [p.cpu >= 25, false, false, p.gpu >= 50];
  for (let i = 0; i < 4; i++) {
    const [k, color, w, floor] = METRICS[i];
    const cell = slot.m[i];
    cell.v.textContent = text[i];
    cell.v.className = `v${zero[i] ? ' z' : ''}${hot[i] ? ' hot' : ''}`;
    const n = k === 'gpu' && !gpuOn ? 0 : APP.hist.tail(p.key, k, tailBuf);
    CHARTS.spark(cell.cv, tailBuf, n, { w, h: 18, color: c[color], floorMax: floor, slots: 60 });
  }
  slot.th.textContent = p.threads;
  slot.hd.textContent = p.handles;
}
let paintQueued = false;
function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintTable(); });
}
function paintTable() {
  const body = $('#ptBody');
  const rowsEl = $('#ptRows');
  const total = APP.rows.length;
  $('#ptSpacer').style.height = `${total * ROW_H}px`;
  const first = Math.max(0, Math.floor(body.scrollTop / ROW_H) - 3);
  const last = Math.min(total, Math.ceil((body.scrollTop + body.clientHeight) / ROW_H) + 3);
  const need = Math.max(0, last - first);
  while (pool.length < need) { const s = makeRow(); pool.push(s); rowsEl.appendChild(s.el); }
  while (pool.length > need) rowsEl.removeChild(pool.pop().el);
  rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
  if (APP.hist) {
    const c = CHARTS.colors();
    for (let i = 0; i < need; i++) fillRow(pool[i], APP.rows[first + i], c);
  }
  const empty = $('#ptEmpty');
  const msg = total ? '' : APP.query.trim() ? t('empty.noMatch', { q: APP.query.trim() }) : APP.mon.error ? '' : APP.mon.kind === 'none' ? t('empty.unsupported') : t('empty.waiting');
  empty.classList.toggle('hidden', !msg);
  empty.textContent = msg;
}
function paintFoot() {
  let th = 0, hd = 0;
  for (const p of APP.procs) { th += p.threads || 0; hd += p.handles || 0; }
  const parts = [
    `${esc(t('foot.procs'))} <b>${FMT.int(APP.procs.length, LANG)}</b>`,
    `${esc(t('foot.threads'))} <b>${FMT.int(th, LANG)}</b>`,
    `${esc(t('foot.handles'))} <b>${FMT.int(hd, LANG)}</b>`,
  ];
  if (APP.matched) parts.push(`${esc(t('foot.matched'))} <b>${FMT.int(APP.matched.size, LANG)}</b>`);
  const right = APP.mon.paused
    ? `<span class="pf-paused">${icon('pause')}${esc(t('foot.paused'))}</span>`
    : `<span>${esc(t('foot.refresh', { sec: APP.mon.refreshMs / 1000 }))}</span>`;
  const who = APP.hello ? `<span>${esc(t(APP.hello.elevated ? 'foot.elevated' : 'foot.standard'))}</span>` : '';
  $('#ptFoot').innerHTML = `${parts.map((x) => `<span>${x}</span>`).join('')}<span class="spacer"></span>${who}${right}`;
}
function refreshTable() {
  rebuildRows();
  paintTable();
  paintFoot();
}
function indexOfKey(key) {
  for (let i = 0; i < APP.rows.length; i++) if (APP.rows[i].p.key === key) return i;
  return -1;
}
function ensureVisible() {
  const i = APP.selected ? indexOfKey(APP.selected) : -1;
  if (i < 0) return;
  const body = $('#ptBody');
  const top = i * ROW_H;
  if (top < body.scrollTop) body.scrollTop = top;
  else if (top + ROW_H > body.scrollTop + body.clientHeight) body.scrollTop = top + ROW_H - body.clientHeight;
  queuePaint();
}

// --- Seçim ve eylemler -----------------------------------------------------------
function select(key) {
  APP.selected = key || null;
  paintTable();
  DETAIL.select(APP.selected);
}
APP.select = select;
APP.selectPid = (pid) => {
  const n = APP.byPid.get(pid);
  if (!n) return false;
  // Ataları aç ki satır görünsün
  for (let a = n.parent; a; a = a.parent) APP.collapsed.delete(a.p.key);
  rebuildRows();
  select(n.p.key);
  ensureVisible();
  return true;
};
function toggleCollapse(key, force) {
  const want = force === undefined ? !APP.collapsed.has(key) : force;
  if (want) APP.collapsed.add(key); else APP.collapsed.delete(key);
  refreshTable();
}
function actionFailed(what, r) {
  toast(what, { type: 'err', sub: r.code === 'failed' && r.message ? r.message : errText(r.code) });
}
APP.copy = (text, label) => {
  window.api.copyText(String(text));
  toast(t('act.copied', { what: label }), { type: 'ok', timeout: 1600 });
};
APP.kill = async (p) => {
  const ok = await confirmBox(t('act.kill'), esc(t('act.killMsg', { name: p.name, pid: p.pid })), { okText: t('act.kill') });
  if (!ok) return;
  const r = await window.api.action('kill', p.pid);
  if (r.ok) toast(t('act.killed', { name: p.name, pid: p.pid }), { type: 'ok' });
  else actionFailed(t('act.killFailed', { name: p.name }), r);
};
APP.killTree = async (p) => {
  const count = TREE.subtreePids(APP.byPid, p.pid).length;
  const ok = await confirmBox(t('act.killTree'), esc(t('act.killTreeMsg', { name: p.name, pid: p.pid, count })), { okText: t('act.killTree') });
  if (!ok) return;
  const r = await window.api.action('killTree', p.pid);
  if (!r.ok) { actionFailed(t('act.killFailed', { name: p.name }), r); return; }
  const d = r.data;
  if (d.failed && d.failed.length) toast(t('act.treePartial', { killed: d.killed, total: d.total }), { type: 'warn', sub: d.failed.slice(0, 6).map((f) => `${f.pid}: ${errText(f.code)}`).join(' · ') });
  else toast(t('act.treeKilled', { count: d.killed }), { type: 'ok' });
};
APP.suspend = async (p, on) => {
  const r = await window.api.action(on ? 'suspend' : 'resume', p.pid);
  if (r.ok) toast(t(on ? 'act.suspended' : 'act.resumed', { name: p.name }), { type: 'ok', timeout: 1800 });
  else actionFailed(t(on ? 'act.suspendFailed' : 'act.resumeFailed', { name: p.name }), r);
  return r.ok;
};
APP.PRIORITIES = ['idle', 'below', 'normal', 'above', 'high'];
APP.setPriority = async (p, value) => {
  const r = await window.api.action('priority', p.pid, value);
  if (r.ok) toast(t('act.prioritySet', { name: p.name, value: t(`prio.${value}`) }), { type: 'ok', timeout: 1800 });
  else actionFailed(t('act.priorityFailed', { name: p.name }), r);
  return r.ok;
};
APP.reveal = async (file) => {
  const r = await window.api.reveal(file);
  if (!r.ok) toast(t('act.revealFailed'), { type: 'err', sub: errText(r.code) });
};
async function revealOf(p) {
  const r = await window.api.query('detail', { pid: p.pid });
  if (!r.ok) { actionFailed(t('act.revealFailed'), r); return; }
  if (!r.data.path) { toast(t('act.noPath'), { type: 'warn' }); return; }
  APP.reveal(r.data.path);
}
async function askPriority(p) {
  const cur = await window.api.query('detail', { pid: p.pid });
  const now = cur.ok ? cur.data.priority : 'normal';
  const body = h(`<div><div class="field"><label>${esc(t('act.priorityFor', { name: p.name, pid: p.pid }))}</label>
    <select class="input" id="p-prio">${APP.PRIORITIES.map((v) => `<option value="${v}" ${v === now ? 'selected' : ''}>${esc(t(`prio.${v}`))}</option>`).join('')}</select>
    <small class="set-hint">${esc(t('act.priorityHint'))}</small></div></div>`);
  const v = await openModal({ title: t('act.priority'), iconName: 'sliders', width: 420, body, buttons: [
    { label: t('common.cancel'), value: null },
    { label: t('common.save'), cls: 'primary', onClick: (m) => m.querySelector('#p-prio').value },
  ] });
  if (v && v !== now) APP.setPriority(p, v);
}
function rowMenu(p, x, y) {
  const node = APP.byPid.get(p.pid);
  const kids = node ? node.children.length : 0;
  contextMenu(x, y, [
    { label: t('act.kill'), icon: 'x', kbd: 'Del', danger: true, action: () => APP.kill(p) },
    kids ? { label: t('act.killTree'), icon: 'trash', danger: true, action: () => APP.killTree(p) } : null,
    '-',
    { label: t('act.suspend'), icon: 'pause', action: () => APP.suspend(p, true) },
    { label: t('act.resume'), icon: 'play', action: () => APP.suspend(p, false) },
    { label: t('act.priority') + '…', icon: 'sliders', action: () => askPriority(p) },
    '-',
    { label: t('act.reveal'), icon: 'folder', action: () => revealOf(p) },
    { label: t('act.copyPid'), icon: 'copy', action: () => APP.copy(p.pid, 'PID') },
    { label: t('act.copyName'), icon: 'copy', action: () => APP.copy(p.name, t('col.name')) },
    APP.view.mode === 'tree' && kids ? '-' : null,
    APP.view.mode === 'tree' && kids ? { label: t(APP.collapsed.has(p.key) ? 'act.expand' : 'act.collapse'), icon: APP.collapsed.has(p.key) ? 'chevronDown' : 'chevronRight', action: () => toggleCollapse(p.key) } : null,
    APP.view.mode === 'tree' ? { label: t('act.collapseAll'), icon: 'list', action: () => { for (const q of APP.procs) { const n = APP.byPid.get(q.pid); if (n && n.children.length && n.parent) APP.collapsed.add(q.key); } refreshTable(); } } : null,
    APP.view.mode === 'tree' && APP.collapsed.size ? { label: t('act.expandAll'), icon: 'list', action: () => { APP.collapsed.clear(); refreshTable(); } } : null,
  ]);
}

// --- İzleyici durumu ve anlık görüntüler ------------------------------------------
function paintPause() {
  const b = $('#btnPause');
  b.classList.toggle('on', !!APP.mon.paused);
  b.innerHTML = icon(APP.mon.paused ? 'play' : 'pause');
  b.title = `${t(APP.mon.paused ? 'top.resume' : 'top.pause')} (Space)`;
}
function paintMonBar() {
  const bar = $('#monBar');
  const m = APP.mon;
  let html = '';
  let err = false;
  if (m.error) {
    err = true;
    html = `${icon('alert')}<span><b>${esc(t('mon.error'))}</b> — ${esc(m.error.message || errText(m.error.code))}</span>
      <button class="btn sm" type="button" data-a="retry">${icon('refresh')}${esc(t('mon.retry'))}</button>`;
  } else if (m.kind === 'none') {
    err = true;
    html = `${icon('alert')}<span>${esc(t('empty.unsupported'))}</span>`;
  } else if (m.platform === 'win32' && APP.hello && APP.hello.elevated === false && !barDismissed) {
    html = `${icon('shield')}<span><b>${esc(t('mon.limited'))}</b> — ${esc(t('mon.limitedHint'))}</span>
      <button class="btn sm" type="button" data-a="elevate">${icon('shield')}${esc(t('mon.elevate'))}</button>
      <button class="icon-btn" type="button" data-a="dismiss" title="${esc(t('common.close'))}">${icon('x')}</button>`;
  }
  bar.classList.toggle('hidden', !html);
  bar.classList.toggle('err', err);
  if (bar.dataset.html !== html) { bar.dataset.html = html; bar.innerHTML = html; }
}
$('#monBar').onclick = async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  if (b.dataset.a === 'dismiss') { barDismissed = true; paintMonBar(); return; }
  if (b.dataset.a === 'retry') { b.disabled = true; applyState(await window.api.monRetry()); return; }
  if (b.dataset.a === 'elevate') {
    b.disabled = true;
    const r = await window.api.elevate();
    b.disabled = false;
    if (!r.ok && r.code !== 'cancelled') toast(t('mon.elevateFailed'), { type: 'err', sub: errText(r.code) });
  }
};
function applyState(st) {
  if (!st) return;
  const helloChanged = !!st.hello !== !!APP.hello;
  APP.mon = st;
  if (st.hello) APP.hello = st.hello;
  paintPause();
  paintMonBar();
  paintFoot();
  if (helloChanged) { paintTable(); DETAIL.tick(); }
  if (st.error) paintTable();
}
function applySnapshot(s, pushHist) {
  APP.t = s.t;
  APP.sys = s.sys;
  APP.procs = TREE.rowsToObjects(s.cols, s.procs);
  const built = TREE.buildTree(APP.procs);
  APP.roots = built.roots;
  APP.byPid = built.byPid;
  APP.byKey = new Map(APP.procs.map((p) => [p.key, p]));
  if (pushHist) APP.hist.push({ t: s.t, sys: s.sys, procs: APP.procs });
  for (const ev of s.events || []) {
    APP.events.push(ev);
    if (ev.type === 'start') APP.fresh.set(`${ev.pid}:${ev.start || 0}`, s.t);
  }
  if (APP.events.length > 2000) APP.events.splice(0, APP.events.length - 2000);
  for (const [k, at] of APP.fresh) if (s.t - at > 2500) APP.fresh.delete(k);
  if (APP.collapsed.size) for (const k of APP.collapsed) if (!APP.byKey.has(k)) APP.collapsed.delete(k);
  refreshTable();
  paintSys();
  DETAIL.tick();
}

// --- Etkileşim: tablo, arama, klavye ---------------------------------------------
$('#ptHead').onclick = (e) => { const b = e.target.closest('.th'); if (b) setSort(b.dataset.key); };
$('#ptBody').addEventListener('scroll', queuePaint, { passive: true });
$('#ptRows').onclick = (e) => {
  const row = e.target.closest('.pr');
  if (!row) return;
  if (e.target.closest('.tw.has')) { toggleCollapse(row.dataset.key); return; }
  select(row.dataset.key);
};
$('#ptRows').ondblclick = (e) => {
  const row = e.target.closest('.pr');
  if (!row || e.target.closest('.tw')) return;
  const r = APP.rows[indexOfKey(row.dataset.key)];
  if (r && r.hasChildren) toggleCollapse(row.dataset.key);
};
$('#ptRows').oncontextmenu = (e) => {
  const row = e.target.closest('.pr');
  if (!row) return;
  e.preventDefault();
  const p = APP.byKey.get(row.dataset.key);
  if (!p) return;
  if (APP.selected !== p.key) select(p.key);
  rowMenu(p, e.clientX, e.clientY);
};
$('#ptBody').onclick = (e) => { if (e.target === $('#ptBody') || e.target === $('#ptSpacer')) select(null); };
new ResizeObserver(() => {
  $('#procs').classList.toggle('wide', $('#procs').clientWidth >= 980);
  queuePaint();
}).observe($('#procs'));

function setQuery(q) {
  APP.query = q;
  $('#searchBox').classList.toggle('has', !!q);
  $('#ptBody').scrollTop = 0;
  refreshTable();
}
$('#search').oninput = (e) => setQuery(e.target.value);
$('#searchClear').onclick = () => { $('#search').value = ''; setQuery(''); $('#search').focus(); };
$('#viewMode').onclick = (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); };
$('#btnPause').onclick = () => window.api.setPaused(!APP.mon.paused);
$('#btnSettings').onclick = () => openSettings();
$('#btnAccount').onclick = () => openSettings('account');

function moveSel(delta, absolute) {
  if (!APP.rows.length) return;
  const cur = APP.selected ? indexOfKey(APP.selected) : -1;
  let i = absolute !== undefined ? absolute : cur < 0 ? (delta > 0 ? 0 : APP.rows.length - 1) : cur + delta;
  i = Math.max(0, Math.min(APP.rows.length - 1, i));
  select(APP.rows[i].p.key);
  ensureVisible();
}
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  const ae = document.activeElement;
  const tag = ae && ae.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.key === 'Escape') {
    if (document.querySelector('.ctx')) return;
    if (APP.query) { $('#search').value = ''; setQuery(''); }
    else if (typing) ae.blur();
    else if (APP.selected) select(null);
    return;
  }
  if (typing) {
    // Arama kutusundan aşağı ok / Enter ile listeye geçilir
    if (ae === $('#search') && (e.key === 'ArrowDown' || e.key === 'Enter') && APP.rows.length) {
      e.preventDefault();
      const first = APP.matched ? APP.rows.findIndex((r) => APP.matched.has(r.p.pid)) : 0;
      $('#ptBody').focus();
      moveSel(0, Math.max(0, first));
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Ayrıntı bölmesinde odak varken (hex, listeler) gezinme tuşları oraya aittir
  if (ae && ae.closest && ae.closest('#detail') && e.key !== ' ') return;
  const page = Math.max(1, Math.floor($('#ptBody').clientHeight / ROW_H) - 1);
  const cur = APP.selected ? APP.rows[indexOfKey(APP.selected)] : null;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); moveSel(1); break;
    case 'ArrowUp': e.preventDefault(); moveSel(-1); break;
    case 'PageDown': e.preventDefault(); moveSel(page); break;
    case 'PageUp': e.preventDefault(); moveSel(-page); break;
    case 'Home': e.preventDefault(); moveSel(0, 0); break;
    case 'End': e.preventDefault(); moveSel(0, APP.rows.length - 1); break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (!cur || APP.view.mode !== 'tree') break;
      e.preventDefault();
      const open = e.key === (IS_RTL ? 'ArrowLeft' : 'ArrowRight');
      if (open) {
        if (cur.collapsed) toggleCollapse(cur.p.key, false);
        else if (cur.hasChildren) moveSel(1);
      } else if (cur.hasChildren && !cur.collapsed) toggleCollapse(cur.p.key, true);
      else {
        const n = APP.byPid.get(cur.p.pid);
        if (n && n.parent && indexOfKey(n.parent.p.key) >= 0) { select(n.parent.p.key); ensureVisible(); }
      }
      break;
    }
    case 'Delete': if (cur) { e.preventDefault(); APP.kill(cur.p); } break;
    case ' ': if (tag !== 'BUTTON') { e.preventDefault(); window.api.setPaused(!APP.mon.paused); } break;
    default:
  }
});

// --- Hesap çipi ve güncelleme çubuğu ---------------------------------------------
function syncText(st) {
  if (!st.syncEnabled || st.state === 'off') return t('sync.off');
  if (st.state === 'syncing') return t('sync.syncing');
  if (st.state === 'offline') return t('sync.offline');
  if (st.state === 'error') {
    if (st.error === 'decrypt_failed') return t('sync.errDecrypt');
    if (st.error === 'too_large') return t('sync.errTooLarge');
    return t('sync.error', { msg: st.errorMessage || st.error });
  }
  return st.lastSyncAt ? t('acct.lastSync', { time: formatDate(st.lastSyncAt) }) : t('acct.never');
}
function paintAccount() {
  const b = $('#btnAccount');
  const email = (acct.user && acct.user.email) || acct.email || '';
  const name = (acct.user && acct.user.name) || email;
  b.querySelector('.ac-avatar').textContent = (name || '?').trim().charAt(0).toUpperCase();
  const st = !acct.syncEnabled ? 'off' : acct.state || 'idle';
  b.className = `account-chip s-${st}`;
  b.querySelector('.ac-sync').innerHTML = st === 'syncing' ? '<span class="spin"></span>' : icon(st === 'off' || st === 'offline' ? 'cloudOff' : 'cloud');
  b.title = `${email}\n${syncText(acct)}`;
  const el = $('#acct-status');
  if (el) el.textContent = syncText(acct);
}
window.api.onAccountStatus((st) => { acct = st; paintAccount(); });
window.api.accountState().then((st) => { acct = st; paintAccount(); });

function showUpdate(info) {
  if (!info) return;
  const bar = $('#updateBar');
  bar.innerHTML = `${icon('bolt')}<span><b>${esc(t('update.available', { version: info.version }))}</b> — ${esc(t('update.hint'))}</span>
    <button class="btn sm" type="button">${icon('open')}${esc(t('update.open'))}</button>`;
  bar.querySelector('button').onclick = () => window.api.openWeb('account');
  bar.classList.remove('hidden');
}
window.api.onUpdateAvailable(showUpdate);
window.api.about().then((a) => { showUpdate(a.update); });

// --- Ayarlar ----------------------------------------------------------------------
async function openSettings(startTab = 'general') {
  if (document.querySelector('.modal-backdrop')) return;
  const s = APP.settings || {};
  let appTheme = s.appTheme || 'system';
  let refreshMs = APP.view.refreshMs || 1000;
  const about = await window.api.about();
  const email = (acct.user && acct.user.email) || acct.email || '';
  const langOptions = Object.entries(I18N.LANGUAGES)
    .map(([code, l]) => `<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const tabs = [['general', 'gear', t('set.general')], ['account', 'user', t('set.account')], ['keys', 'keyboard', t('set.keys')], ['about', 'bolt', t('set.about')]];
  const ag = about.agent;
  const agentLine = ag
    ? `${ag.kind === 'win' ? 'mp-agent' : ag.kind} ${ag.agent || ''} · ${t('about.protocol', { v: ag.protocol })} · ${t(ag.elevated ? 'foot.elevated' : 'foot.standard')}`
    : t('about.noAgent');
  const body = h(`<div class="set-wrap">
    <nav class="set-nav">${tabs.map(([k, ic, label]) => `<button type="button" data-tab="${k}">${icon(ic)}<span>${esc(label)}</span></button>`).join('')}</nav>
    <div class="set-pages">
      <section data-page="general">
        <div class="field"><label>${esc(t('set.language'))}</label><select class="input" id="s-lang">${langOptions}</select><small class="set-hint">${esc(t('set.languageHint'))}</small></div>
        <div class="field"><label>${esc(t('set.theme'))}</label><div class="seg" id="s-theme">
          <button type="button" data-v="dark">${icon('moon')}${esc(t('set.themeDark'))}</button>
          <button type="button" data-v="light">${icon('sun')}${esc(t('set.themeLight'))}</button>
          <button type="button" data-v="system">${icon('monitor')}${esc(t('set.themeSystem'))}</button></div></div>
        <div class="field"><label>${esc(t('set.refresh'))}</label><div class="seg" id="s-refresh">
          ${[1000, 2000, 5000].map((v) => `<button type="button" data-v="${v}">${v / 1000} ${esc(SEC)}</button>`).join('')}</div>
          <small class="set-hint">${esc(t('set.refreshHint'))}</small></div>
        <div class="section-title">${esc(t('set.behavior'))}</div>
        <label class="check"><input type="checkbox" id="s-min" ${s.minimizeToTray ? 'checked' : ''}><span>${esc(t('set.minTray'))}<small>${esc(t('set.minTrayHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-close" ${s.closeToTray ? 'checked' : ''}><span>${esc(t('set.closeTray'))}<small>${esc(t('set.closeTrayHint'))}</small></span></label>
        <div class="section-title">${esc(t('set.startup'))}</div>
        <label class="check"><input type="checkbox" id="s-login" ${about.openAtLogin ? 'checked' : ''}><span>${esc(t('set.openAtLogin'))}<small>${esc(t('set.openAtLoginHint'))}</small></span></label>
        <div class="section-title">${esc(t('set.updates'))}</div>
        <label class="check"><input type="checkbox" id="s-upd" ${s.checkUpdates !== false ? 'checked' : ''}><span>${esc(t('set.checkUpdates'))}<small>${esc(t('set.checkUpdatesHint'))}</small></span></label>
      </section>
      <section data-page="account">
        <div class="acct-box">
          <div class="acct-who">${icon('user')}<span>${esc(t('acct.signedInAs', { email }))}</span></div>
          <label class="check"><input type="checkbox" id="s-sync" ${acct.syncEnabled ? 'checked' : ''}><span>${esc(t('acct.syncToggle'))}<small>${esc(t('acct.syncHint'))}</small></span></label>
          <div class="acct-status">${icon('cloud')}<span id="acct-status">${esc(syncText(acct))}</span></div>
          <div class="acct-actions"><button class="btn sm" type="button" id="s-syncnow">${icon('refresh')}${esc(t('acct.syncNow'))}</button>
            <button class="btn sm" type="button" id="s-delremote">${icon('trash')}${esc(t('acct.deleteRemote'))}</button></div>
          <div class="acct-actions"><button class="btn sm" type="button" id="s-web">${icon('open')}${esc(t('acct.myAccount'))}</button><span style="flex:1"></span>
            <button class="btn sm danger" type="button" id="s-logout">${icon('logout')}${esc(t('acct.logout'))}</button></div>
        </div>
        <div class="note">${icon('shield')}<span>${esc(t('privacy.note'))}</span></div>
      </section>
      <section data-page="keys"><div class="keys">${SHORTCUTS.map(([k, l]) => `<span class="kbd">${esc(k)}</span><span>${esc(t(l))}</span>`).join('')}</div></section>
      <section data-page="about">
        <div class="about-head"><img src="../../build/icon.png" alt=""><div><div class="about-name">Master Process</div>
          <div class="about-ver">${esc(t('about.version', { version: about.version }))}${about.portable ? ` · ${esc(t('about.portable'))}` : ''}</div></div></div>
        <div class="set-hint">${esc(t('about.family'))}</div>
        <div class="set-hint">${esc(t('about.agent'))}: <span class="mono">${esc(agentLine)}</span></div>
        <div class="acct-actions"><button class="btn sm" type="button" id="s-update">${icon('refresh')}${esc(t('about.checkUpdate'))}</button>
          <button class="btn sm" type="button" id="s-tool">${icon('globe')}${esc(t('about.toolPage'))}</button><span class="about-update" id="s-update-result"></span></div>
        <div class="section-title">${esc(t('about.licenses'))}</div>
        <div class="set-hint">${esc(t('about.licensesIntro'))}</div>
        <ul class="oss">${OSS.map(([n, l]) => `<li><span>${esc(n)}</span><span>${esc(l)}</span></li>`).join('')}</ul>
        <div class="acct-actions"><button class="btn sm" type="button" id="s-licenses">${icon('file')}${esc(t('about.chromium'))}</button>
          <span class="set-hint">Electron ${esc(about.electron)} · Chromium ${esc(about.chrome)}</span></div>
      </section>
    </div></div>`);
  const q = (sel) => body.querySelector(sel);
  const showTab = (k) => {
    body.querySelectorAll('.set-nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    body.querySelectorAll('.set-pages section').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== k));
  };
  body.querySelectorAll('.set-nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  showTab(startTab);
  const originalTheme = appTheme;
  const paintSeg = (id, v) => body.querySelectorAll(`${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  body.querySelectorAll('#s-theme button').forEach((b) => (b.onclick = () => { appTheme = b.dataset.v; paintSeg('#s-theme', appTheme); window.api.setSettings({ appTheme }); }));
  body.querySelectorAll('#s-refresh button').forEach((b) => (b.onclick = () => { refreshMs = Number(b.dataset.v); paintSeg('#s-refresh', refreshMs); }));
  paintSeg('#s-theme', appTheme);
  paintSeg('#s-refresh', refreshMs);
  q('#s-sync').onchange = async (e) => {
    const on = e.target.checked;
    const r = await window.api.setSyncEnabled(on);
    if (!r.ok) { e.target.checked = !on; toast(t('sync.error', { msg: r.code }), { type: 'err' }); }
  };
  q('#s-syncnow').onclick = () => window.api.syncNow();
  q('#s-delremote').onclick = async () => {
    const ok = await confirmBox(t('acct.deleteRemote'), esc(t('acct.deleteRemoteMsg')));
    if (!ok) return;
    const r = await window.api.deleteRemoteLibrary();
    if (r.ok) { q('#s-sync').checked = false; toast(t('acct.deleteRemoteDone'), { type: 'ok' }); } else toast(t('sync.error', { msg: r.code }), { type: 'err' });
  };
  q('#s-web').onclick = () => window.api.openWeb('account');
  q('#s-logout').onclick = async () => {
    const ok = await confirmBox(t('acct.logout'), esc(t('acct.logoutMsg')), { okText: t('acct.logout') });
    if (ok) window.api.logout();
  };
  q('#s-update').onclick = async () => {
    const out = q('#s-update-result');
    out.className = 'about-update';
    out.textContent = t('about.checking');
    const r = await window.api.checkUpdate();
    if (!r.ok) { out.classList.add('err'); out.textContent = t('about.checkFailed', { msg: r.message || r.code }); return; }
    if (r.newer) { out.classList.add('new'); out.textContent = `${t('update.available', { version: r.latest })} — ${t('update.hint')}`; }
    else { out.classList.add('ok'); out.textContent = t('about.upToDate'); }
  };
  q('#s-tool').onclick = () => window.api.openWeb('tool');
  q('#s-licenses').onclick = () => window.api.openLicenses();

  const res = await openModal({ title: t('set.title'), iconName: 'gear', width: 820, body, buttons: [
    { label: t('common.cancel'), value: null },
    { label: t('common.save'), cls: 'primary', onClick: (m) => ({
      appTheme, language: m.querySelector('#s-lang').value, view: { refreshMs },
      openAtLogin: m.querySelector('#s-login').checked, minimizeToTray: m.querySelector('#s-min').checked,
      closeToTray: m.querySelector('#s-close').checked, checkUpdates: m.querySelector('#s-upd').checked,
    }) },
  ] });
  if (!res) { if (appTheme !== originalTheme) window.api.setSettings({ appTheme: originalTheme }); return; }
  const langChanged = res.language !== LANG;
  if (!langChanged) delete res.language;
  await window.api.setSettings(res);
  if (!langChanged) toast(t('set.saved'), { type: 'ok', timeout: 1800 });
}

// --- Başlatma ---------------------------------------------------------------------
function applyStore(st) {
  APP.settings = (st && st.settings) || {};
  const v = APP.settings.view || {};
  const before = APP.view;
  APP.view = { refreshMs: v.refreshMs || 1000, mode: v.mode === 'list' ? 'list' : 'tree', sort: { key: (v.sort && v.sort.key) || 'name', dir: v.sort && v.sort.dir < 0 ? -1 : 1 } };
  buildHead();
  paintMode();
  if (before.mode !== APP.view.mode || before.sort.key !== APP.view.sort.key || before.sort.dir !== APP.view.sort.dir) refreshTable();
}
function buildChrome() {
  $('#searchBox .s-ico').innerHTML = icon('search');
  $('#searchClear').innerHTML = icon('x');
  $('#search').placeholder = t('top.search');
  $('#viewMode').innerHTML = `<button type="button" data-m="tree" title="${esc(t('top.tree'))}">${icon('share')}</button><button type="button" data-m="list" title="${esc(t('top.list'))}">${icon('list')}</button>`;
  $('#btnSettings').innerHTML = `${icon('gear')}<span>${esc(t('set.title'))}</span>`;
  $('#btnSettings').title = `${t('set.title')} (Ctrl+,)`;
  buildSys();
  mountMastertool($('#actions'));
}
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  CHARTS.resetColors();
  paintTable();
  paintSys();
  DETAIL.repaint();
});

(async function boot() {
  buildChrome();
  buildHead();
  paintMode();
  paintPause();
  paintFoot();
  const pending = [];
  let ready = false;
  window.api.onSnapshot((s) => { if (ready) applySnapshot(s, true); else pending.push(s); });
  window.api.onMonState(applyState);
  window.api.onStoreChanged(applyStore);
  const [store, init] = await Promise.all([window.api.getStore(), window.api.monInit()]);
  applyStore(store);
  APP.hist = HISTORY.createHistory({ capacity: (init.state && init.state.capacity) || 300 });
  if (init.history) APP.hist.load(init.history);
  APP.events = (init.events || []).slice(-2000);
  DETAIL.init($('#detail'));
  applyState(init.state);
  let lastT = 0;
  if (init.snapshot) { lastT = init.snapshot.t; applySnapshot({ ...init.snapshot, events: [] }, false); }
  else { refreshTable(); paintSys(); DETAIL.tick(); }
  ready = true;
  for (const s of pending) if (s.t > lastT) applySnapshot(s, true);
  $('#ptBody').focus();
})();
