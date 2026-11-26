'use strict';

// Ayrıntı bölmesi: seçili sürecin sekmeleri (genel, performans, bellek, disk, GPU, pencere, modüller, iş
// parçacıkları, tarihçe); seçim yokken sistem görünümü. Veriyi window.api.query ile ister; süreç listesi ve
// tarihçe APP'ten (app.js) çağrı anında okunur.
const DETAIL = (() => {
  const SEC = t('unit.sec');
  const DUR = { d: t('unit.d'), h: t('unit.h'), m: t('unit.m'), s: t('unit.s') };
  const TABS = [['general', 'info'], ['perf', 'radar'], ['memory', 'db'], ['disk', 'folder'], ['gpu', 'monitor'], ['window', 'desktop'], ['modules', 'list'], ['threads', 'cpu'], ['history', 'history']];
  const SYS_TABS = [['overview', 'radar'], ['history', 'history']];
  let host = null;
  let headEl = null;
  let tabsEl = null;
  let bodyEl = null;
  let cur = null; // { key, pid, name, start, info, infoErr, exited }
  let tab = 'general';
  let sysTab = 'overview';
  let ctl = null; // etkin sekme: { tick(n), repaint(), destroy(), onInfo() }
  let tickNo = 0;
  let tip = null;

  // --- Yardımcılar --------------------------------------------------------------
  async function query(cmd, args) {
    const r = await window.api.query(cmd, args);
    if (!r.ok) { const e = new Error(r.message || r.code); e.code = r.code; throw e; }
    return r.data;
  }
  const errOf = (e) => (e && e.code === 'failed' && e.message ? e.message : APP.errText(e && e.code));
  const live = () => (cur ? APP.byKey.get(cur.key) : null);
  const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString(LANG) : '—');
  function message(el, iconName, title, sub) {
    el.innerHTML = `<div class="d-msg">${iconName === 'spin' ? '<span class="spin"></span>' : icon(iconName)}${title ? `<b>${esc(title)}</b>` : ''}${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
  }
  const loading = (el) => message(el, 'spin', '', t('d.loading'));
  function failure(el, e) {
    if (e && e.code === 'gone') message(el, 'ban', t('d.gone'), t('d.goneHint'));
    else if (e && e.code === 'access') message(el, 'lock', t('d.access'), t(APP.hello && APP.hello.elevated ? 'd.accessProtected' : 'd.accessHint'));
    else if (e && e.code === 'unsupported') message(el, 'info', t('d.unsupported'), '');
    else message(el, 'alert', t('d.failed'), errOf(e));
  }
  function stats(values, n) {
    let peak = 0, sum = 0;
    for (let i = 0; i < n; i++) { const v = values[i]; if (v > peak) peak = v; sum += v; }
    return { cur: n ? values[n - 1] : 0, peak, avg: n ? sum / n : 0 };
  }
  function showTip(html, x, y) {
    if (!tip) { tip = h('<div class="tip"></div>'); document.body.appendChild(tip); }
    tip.innerHTML = html;
    tip.style.display = '';
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(6, Math.min(x + 14, window.innerWidth - r.width - 8))}px`;
    tip.style.top = `${Math.max(6, y + 16 + r.height > window.innerHeight ? y - r.height - 10 : y + 16)}px`;
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  // Grafik kartı: başlık + güncel değer + ek bilgi + çizgi grafiği
  function chartCard(parent, title, colorVar, sm) {
    const el = h(`<div class="chart${sm ? ' sm' : ''}" style="--c:var(${colorVar})"><div class="ch-top"><span class="ch-t">${esc(title)}</span><span class="ch-v"></span><span class="ch-x"></span></div><canvas></canvas></div>`);
    parent.appendChild(el);
    const v = el.querySelector('.ch-v');
    const x = el.querySelector('.ch-x');
    const canvas = el.querySelector('canvas');
    return {
      el,
      set(values, n, { color, fmt, max = 0, floorMax = 0 }) {
        const s = stats(values, n);
        v.textContent = fmt(s.cur);
        x.innerHTML = `${esc(t('d.peak'))} <b>${esc(fmt(s.peak))}</b> · ${esc(t('d.avg'))} <b>${esc(fmt(s.avg))}</b>`;
        CHARTS.line(canvas, { series: [{ values, n, color }], capacity: APP.hist.capacity, max, floorMax, fmt, stepMs: APP.mon.refreshMs || 1000, secLabel: SEC });
      },
      blank(text) { v.textContent = text; x.textContent = ''; CHARTS.line(canvas, { series: [], capacity: APP.hist.capacity, max: 1, fmt: () => '', stepMs: APP.mon.refreshMs || 1000, secLabel: SEC }); },
    };
  }
  const fPct = (v) => `${FMT.pct(v)} %`;
  const fRate = (v) => FMT.rate(v, SEC);

  // Sanal liste: yalnız görünen satırlar üretilir. cols: grid şablonu; head: [[etiket, sınıf]]
  function vlist(parent, { cols, head, grow = true, height = 0, empty = '' }) {
    const ROW = 24;
    const el = h(`<div class="vl${grow ? ' grow' : ''}" style="--vl-cols:${cols}${height ? `;height:${height}px` : ''}">
      <div class="vl-head">${head.map(([label, cls]) => `<span class="${cls || ''}">${esc(label)}</span>`).join('')}</div>
      <div class="vl-body" tabindex="0"><div></div><div class="vl-rows"></div></div></div>`);
    parent.appendChild(el);
    const body = el.querySelector('.vl-body');
    const spacer = body.firstElementChild;
    const rows = body.lastElementChild;
    let count = 0, render = () => '', onClick = null, onMenu = null, sel = -1, queued = false;
    function paint() {
      queued = false;
      spacer.style.height = `${count * ROW}px`;
      if (!count) { rows.style.transform = ''; rows.innerHTML = empty ? `<div class="vl-empty">${esc(empty)}</div>` : ''; return; }
      const first = Math.max(0, Math.floor(body.scrollTop / ROW) - 4);
      const last = Math.min(count, Math.ceil((body.scrollTop + (body.clientHeight || 300)) / ROW) + 4);
      let html = '';
      for (let i = first; i < last; i++) html += `<div class="vl-row${onClick ? ' click' : ''}${i === sel ? ' sel' : ''}" data-i="${i}">${render(i)}</div>`;
      rows.style.transform = `translateY(${first * ROW}px)`;
      rows.innerHTML = html;
    }
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
    body.addEventListener('scroll', queue, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(body);
    rows.onclick = (e) => { const r = e.target.closest('.vl-row'); if (r && onClick) onClick(Number(r.dataset.i), e); };
    rows.oncontextmenu = (e) => { const r = e.target.closest('.vl-row'); if (r && onMenu) { e.preventDefault(); onMenu(Number(r.dataset.i), e); } };
    return {
      el,
      set(o) {
        if (o.count !== undefined) count = o.count;
        if (o.render) render = o.render;
        if (o.onClick !== undefined) onClick = o.onClick;
        if (o.onMenu !== undefined) onMenu = o.onMenu;
        if (o.sel !== undefined) sel = o.sel;
        if (o.empty !== undefined) empty = o.empty;
        if (o.top) body.scrollTop = 0;
        paint();
      },
      select(i, reveal) {
        sel = i;
        if (reveal && i >= 0) {
          const top = i * ROW;
          if (top < body.scrollTop || top + ROW > body.scrollTop + body.clientHeight) body.scrollTop = Math.max(0, top - body.clientHeight / 2);
        }
        paint();
      },
      paint,
      destroy() { ro.disconnect(); },
    };
  }
  function pathMenu(file, e) {
    contextMenu(e.clientX, e.clientY, [
      { label: t('act.copyPath'), icon: 'copy', action: () => APP.copy(file, t('d.path')) },
      { label: t('act.reveal'), icon: 'folder', action: () => APP.reveal(file) },
    ]);
  }

  // --- Çatı: başlık, sekmeler -----------------------------------------------------
  function badges() {
    const out = [];
    const i = cur.info;
    if (cur.exited) out.push(`<span class="badge err">${esc(t('d.exited'))}</span>`);
    if (i) {
      if (i.suspended) out.push(`<span class="badge warn">${esc(t('d.suspended'))}</span>`);
      if (i.elevated) out.push(`<span class="badge warn">${icon('shield')}${esc(t('d.elevated'))}</span>`);
      if (i.arch) out.push(`<span class="badge">${esc(i.arch)}</span>`);
      if (i.priority && i.priority !== 'normal') out.push(`<span class="badge acc">${esc(t(`prio.${i.priority}`))}</span>`);
    }
    return out.join('');
  }
  let headSig = '';
  function paintHead() {
    if (!headEl) return;
    if (!cur) {
      const hl = APP.hello;
      const sub = hl ? [hl.os, hl.arch, t('sys.cpus', { count: hl.cpuCount }), FMT.bytes(hl.totalPhys)].filter(Boolean).map(esc).join(' · ') : esc(t('d.waiting'));
      const html = `<div class="d-ico sys">${icon('monitor')}</div><div class="d-title"><div class="d-name">${esc(t('sys.title'))}</div><div class="d-sub">${sub}</div></div>`;
      if (html !== headSig) { headSig = html; headEl.innerHTML = html; }
      return;
    }
    // Yapı yalnız değişince yeniden kurulur: her yenilemede kurmak kapat düğmesine tıklamayı yutabilir
    const html = `<div class="d-ico" style="--hue:${APP.hueOf(cur.name)}">${esc(String(cur.name || '?').charAt(0))}</div>
      <div class="d-title"><div class="d-name" title="${esc(cur.name)}">${esc(cur.name)}</div>
      <div class="d-sub"><span>PID ${cur.pid}</span><span data-r="now"></span>${badges()}</div></div>
      <button class="icon-btn" type="button" data-a="close" title="${esc(t('d.backToSystem'))} (Esc)">${icon('x')}</button>`;
    if (html !== headSig) { headSig = html; headEl.innerHTML = html; }
    const p = live();
    const now = headEl.querySelector('[data-r="now"]');
    const text = p ? `· CPU ${FMT.pct(p.cpu)} % · ${FMT.bytes(p.ws)}` : '';
    if (now && now.textContent !== text) now.textContent = text;
  }
  function paintTabs() {
    const list = cur ? TABS : SYS_TABS;
    const on = cur ? tab : sysTab;
    tabsEl.innerHTML = list.map(([id, ic]) => `<button type="button" data-tab="${id}" class="${id === on ? 'on' : ''}">${icon(ic)}${esc(t(cur ? `tab.${id}` : `systab.${id}`))}</button>`).join('');
  }
  function unmount() {
    hideTip();
    if (ctl && ctl.destroy) { try { ctl.destroy(); } catch { /* sekme zaten kaldırılmış */ } }
    ctl = null;
  }
  function mount() {
    unmount();
    // Gövde her seferinde yenilenir: önceki sekmenin olay dinleyicileri öğeyle birlikte gider
    const fresh = h('<div class="d-body"></div>');
    bodyEl.replaceWith(fresh);
    bodyEl = fresh;
    const make = cur ? PROC[tab] : SYS[sysTab];
    ctl = make(bodyEl) || {};
  }
  function render() {
    if (!host) return;
    paintHead();
    paintTabs();
    mount();
  }
  async function loadInfo() {
    const c = cur;
    if (!c || c.exited) return;
    try {
      const info = await query('detail', { pid: c.pid });
      if (cur !== c) return;
      // PID yeniden kullanılmış olabilir: başlangıç zamanı tutmuyorsa bu başka bir süreçtir
      if (c.start && info.start && Math.abs(info.start - c.start) > 2000) { c.exited = true; c.infoErr = { code: 'gone' }; }
      else { c.info = info; c.infoErr = null; }
    } catch (e) {
      if (cur !== c) return;
      c.infoErr = e;
      if (e.code === 'gone') c.exited = true;
    }
    paintHead();
    if (ctl && ctl.onInfo) ctl.onInfo();
  }

  // --- Süreç sekmeleri --------------------------------------------------------------
  const PROC = {};
  const kvRow = (label, value, cls, key) => `<dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ''}${key ? ` data-v="${key}"` : ''}>${value}</dd>`;
  const statBox = (label, key, value) => `<div class="stat"><div class="s-l" title="${esc(label)}">${esc(label)}</div><div class="s-v" data-v="${key}">${esc(value === undefined ? '—' : value)}</div></div>`;
  function setV(root, key, text) {
    const n = root.querySelector(`[data-v="${key}"]`);
    if (n && n.textContent !== text) n.textContent = text;
  }

  PROC.general = (el) => {
    let built = false;
    function parentHtml(ppid) {
      const node = ppid ? APP.byPid.get(ppid) : null;
      return node ? `<a data-a="parent" data-pid="${ppid}">${esc(node.p.name)}</a> <span class="mono">(${ppid})</span>` : ppid ? `<span class="mono">${ppid}</span>` : '—';
    }
    function counters(i) {
      const c = i.counters || {};
      return {
        handles: FMT.int(c.handles, LANG), gdi: FMT.int(c.gdi, LANG), user: FMT.int(c.user, LANG), threads: FMT.int((i.threads || []).length, LANG),
        ws: FMT.bytes(c.ws), peakWs: FMT.bytes(c.peakWs), priv: FMT.bytes(c.priv), virt: FMT.bytes(c.virt), pageFaults: FMT.int(c.pageFaults, LANG),
        kernel: FMT.duration(c.kernelMs, DUR), userT: FMT.duration(c.userMs, DUR),
        ioR: FMT.bytes(c.ioReadBytes), ioW: FMT.bytes(c.ioWriteBytes), ioO: FMT.bytes(c.ioOtherBytes),
      };
    }
    const LABELS = [['threads', 'col.threads'], ['handles', 'col.handles'], ['gdi', 'g.gdi'], ['user', 'g.userObj'], ['ws', 'g.ws'], ['peakWs', 'g.peakWs'], ['priv', 'g.priv'], ['virt', 'g.virt'],
      ['pageFaults', 'g.pageFaults'], ['kernel', 'g.kernelTime'], ['userT', 'g.userTime'], ['ioR', 'g.ioRead'], ['ioW', 'g.ioWrite'], ['ioO', 'g.ioOther']];
    function build() {
      const i = cur.info;
      const p = live();
      el.innerHTML = '';
      if (!i) {
        if (!cur.infoErr) { loading(el); return; }
        // Ayrıntı okunamadı (korumalı süreç ya da yetki yok): süreç listesindeki bilgiler gösterilir
        const base = p || { pid: cur.pid, ppid: 0, start: cur.start };
        el.appendChild(h(`<div class="card"><h4>${esc(t('g.identity'))}</h4><div class="cb"><dl class="kv">
          ${kvRow('PID', `<span class="mono">${cur.pid}</span>`)}${kvRow(t('g.parent'), parentHtml(base.ppid))}
          ${kvRow(t('g.started'), esc(cur.start ? formatDate(cur.start) : '—'))}</dl></div></div>`));
        const box = h('<div class="card"><div class="cb"></div></div>');
        failure(box.firstElementChild, cur.infoErr);
        el.appendChild(box);
        return;
      }
      built = true;
      const dead = cur.exited;
      const dis = dead ? ' disabled' : '';
      const prioOpts = APP.PRIORITIES.concat(i.priority === 'realtime' ? ['realtime'] : []).map((v) => `<option value="${v}"${v === i.priority ? ' selected' : ''}${v === 'realtime' ? ' disabled' : ''}>${esc(t(`prio.${v}`))}</option>`).join('');
      const f = i.file;
      const cv = counters(i);
      el.appendChild(h(`<div class="card"><h4>${esc(t('g.actions'))}</h4><div class="cb"><div class="acts">
        <button class="btn danger-ghost" type="button" data-a="kill"${dis}>${icon('x')}${esc(t('act.kill'))}</button>
        <button class="btn danger-ghost" type="button" data-a="killTree"${dis}>${icon('trash')}${esc(t('act.killTree'))}</button>
        <button class="btn" type="button" data-a="suspend"${dis}>${icon(i.suspended ? 'play' : 'pause')}<span>${esc(t(i.suspended ? 'act.resume' : 'act.suspend'))}</span></button>
        <select class="input" data-a="prio" title="${esc(t('act.priority'))}"${dis}>${prioOpts}</select>
        ${i.path ? `<button class="btn" type="button" data-a="reveal">${icon('folder')}${esc(t('act.reveal'))}</button>` : ''}
      </div></div></div>`));
      el.appendChild(h(`<div class="card"><h4>${esc(t('g.identity'))}</h4><div class="cb"><dl class="kv">
        ${kvRow('PID', `<span class="mono">${i.pid}</span>`)}
        ${kvRow(t('g.parent'), parentHtml(i.ppid))}
        ${kvRow(t('g.user'), esc(i.user || '—'))}
        ${kvRow(t('g.started'), esc(i.start ? formatDate(i.start) : '—'))}
        ${kvRow(t('g.uptime'), '—', '', 'uptime')}
        ${kvRow(t('g.priority'), esc(t(`prio.${i.priority || 'normal'}`)), '', 'prio')}
        ${kvRow(t('g.arch'), esc(i.arch || '—'))}
        ${kvRow(t('d.path'), i.path ? `${esc(i.path)} <a data-a="copyPath">${esc(t('act.copy'))}</a>` : '—', 'mono')}
        ${kvRow(t('g.cmdline'), i.cmdline ? `${esc(i.cmdline)} <a data-a="copyCmd">${esc(t('act.copy'))}</a>` : '—', 'mono')}
      </dl></div></div>`));
      if (f) {
        el.appendChild(h(`<div class="card"><h4>${esc(t('g.file'))}</h4><div class="cb"><dl class="kv">
          ${kvRow(t('g.description'), esc(f.description || '—'))}${kvRow(t('g.company'), esc(f.company || '—'))}
          ${kvRow(t('g.version'), esc(f.version || '—'), 'mono')}${kvRow(t('g.size'), esc(FMT.bytes(f.size)))}
          ${kvRow(t('g.modified'), esc(f.modified ? formatDate(f.modified) : '—'))}</dl></div></div>`));
      }
      el.appendChild(h(`<div class="card"><h4>${esc(t('g.counters'))}</h4><div class="cb"><div class="stats">${LABELS.map(([k, key]) => statBox(t(key), k, cv[k])).join('')}</div></div></div>`));
      paintLive();
    }
    function paintLive() {
      if (!built || !cur.info) return;
      const end = cur.exited ? (cur.endT || APP.t || Date.now()) : (APP.t || Date.now());
      setV(el, 'uptime', cur.info.start ? FMT.duration(end - cur.info.start, DUR) : '—');
    }
    function update() {
      if (!built || !cur.info) { build(); return; }
      const i = cur.info;
      const cv = counters(i);
      for (const [k] of LABELS) setV(el, k, cv[k]);
      setV(el, 'prio', t(`prio.${i.priority || 'normal'}`));
      const sel = el.querySelector('[data-a="prio"]');
      if (sel && document.activeElement !== sel && sel.value !== i.priority) sel.value = i.priority;
      const sb = el.querySelector('[data-a="suspend"]');
      if (sb) sb.innerHTML = `${icon(i.suspended ? 'play' : 'pause')}<span>${esc(t(i.suspended ? 'act.resume' : 'act.suspend'))}</span>`;
      if (cur.exited) for (const b of el.querySelectorAll('[data-a="kill"],[data-a="killTree"],[data-a="suspend"],[data-a="prio"]')) b.disabled = true;
      paintLive();
    }
    el.onclick = async (e) => {
      const a = e.target.closest('[data-a]');
      if (!a || a.disabled || a.tagName === 'SELECT') return;
      const act = a.dataset.a;
      const p = live() || { pid: cur.pid, name: cur.name, key: cur.key };
      const i = cur.info || {};
      if (act === 'parent') APP.selectPid(Number(a.dataset.pid));
      else if (act === 'kill') APP.kill(p);
      else if (act === 'killTree') APP.killTree(p);
      else if (act === 'suspend') { if (await APP.suspend(p, !i.suspended)) loadInfo(); }
      else if (act === 'reveal') APP.reveal(i.path);
      else if (act === 'copyPath') APP.copy(i.path, t('d.path'));
      else if (act === 'copyCmd') APP.copy(i.cmdline, t('g.cmdline'));
    };
    el.onchange = async (e) => {
      if (!e.target.matches('[data-a="prio"]')) return;
      const p = live() || { pid: cur.pid, name: cur.name, key: cur.key };
      await APP.setPriority(p, e.target.value);
      e.target.blur();
      loadInfo();
    };
    build();
    return { tick: paintLive, onInfo: update };
  };

  PROC.perf = (el) => {
    const gpuOn = APP.gpuOn();
    const cpu = chartCard(el, t('sys.cpu'), '--m-cpu');
    const mem = chartCard(el, t('col.mem'), '--m-mem');
    const io = chartCard(el, t('col.io'), '--m-io');
    const gpu = gpuOn ? chartCard(el, t('sys.gpu'), '--m-gpu') : null;
    el.appendChild(h(`<div class="note">${esc(t('perf.note'))}${gpuOn ? '' : ' ' + esc(t('gpu.noCounters'))}</div>`));
    function paint() {
      const c = CHARTS.colors();
      const s = APP.hist.series(cur.key);
      if (!s) { for (const k of [cpu, mem, io, gpu]) if (k) k.blank('—'); return; }
      cpu.set(s.cpu, s.n, { color: c.cpu, fmt: fPct, max: 100 });
      mem.set(s.ws, s.n, { color: c.ws, fmt: FMT.bytes, floorMax: 1048576 });
      io.set(s.io, s.n, { color: c.io, fmt: fRate, floorMax: 65536 });
      if (gpu) gpu.set(s.gpu, s.n, { color: c.gpu, fmt: fPct, max: 100 });
    }
    requestAnimationFrame(paint);
    return { tick: paint, repaint: paint };
  };

  // Bellek: commit edilmiş bölgelerin yerleşim haritası, bölge listesi, seçili bölgenin içeriği
  PROC.memory = (el) => {
    const TYPE = { 1: ['private', 'mem.private'], 2: ['mapped', 'mem.mapped'], 3: ['image', 'mem.image'] };
    let model = null, hit = null, list = null, viewer = null, shown = [], selected = -1, filter = '', dead = false;
    const typeOf = (it) => TYPE[it.type] || TYPE[1];
    const inRam = (it) => (it.wsPages < 0 ? '—' : `${FMT.pct(it.ws * 100)} %`);
    function paintMap() {
      const canvas = el.querySelector('.mm-canvas');
      if (canvas && model) hit = CHARTS.memMap(canvas, model, { selected });
    }
    function applyFilter() {
      const qs = filter.trim().toLowerCase();
      shown = !qs ? model.items : model.items.filter((it) => (it.name || '').toLowerCase().includes(qs) || FMT.addr(it.base, 16).includes(qs.replace(/^0x/, '')) || t(typeOf(it)[1]).toLowerCase().includes(qs));
      list.set({
        count: shown.length, top: true, sel: shown.findIndex((it) => it.i === selected), empty: t('mem.noRegions'),
        render: (k) => {
          const it = shown[k];
          const [cls, key] = typeOf(it);
          return `<span class="mono">${ltr(FMT.addr(it.base, 16))}</span><span class="num">${esc(FMT.bytes(it.size))}</span><span><i class="dot" style="--c:var(--r-${cls})"></i>${esc(t(key))}</span>`
            + `<span class="mono">${esc(FMT.protect(it.protect))}</span><span class="num">${inRam(it)}</span><span class="dim start" title="${esc(it.name || '')}">${esc(it.name || '')}</span>`;
        },
        onClick: (k) => pick(shown[k], false),
      });
    }
    function pick(it, reveal) {
      if (!it) return;
      selected = it.i;
      paintMap();
      list.select(shown.findIndex((x) => x.i === selected), reveal);
      if (viewer) viewer.destroy();
      const pid = cur.pid;
      const hostEl = el.querySelector('[data-r="hex"]');
      viewer = HEX.createViewer(hostEl, {
        title: `${FMT.addr(it.base, 16)} · ${FMT.bytes(it.size)}${it.name ? ' · ' + FMT.baseName(it.name) : ''}`,
        total: it.size, base: it.base, live: true, errorText: errOf,
        read: async (off, len) => FMT.b64ToBytes((await query('readmem', { pid, addr: FMT.addrAdd(it.base, off), len })).b64),
        onClose: () => { viewer = null; selected = -1; paintMap(); list.select(-1); },
      });
      hostEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    async function load() {
      const c = cur;
      loading(el);
      if (viewer) { viewer.destroy(); viewer = null; }
      if (list) { list.destroy(); list = null; }
      let mm;
      try { mm = await query('memmap', { pid: c.pid }); } catch (e) { if (!dead && cur === c) failure(el, e); return; }
      if (dead || cur !== c) return;
      model = CHARTS.memModel(mm);
      selected = -1;
      const byType = { 1: 0, 2: 0, 3: 0 };
      for (const it of model.items) byType[it.type || 1] = (byType[it.type || 1] || 0) + it.size;
      const tt = mm.totals || {};
      el.innerHTML = '';
      el.appendChild(h(`<div class="bar-row"><div class="chips">
        <span class="chip" title="${esc(t('mem.commitHint'))}">${esc(t('mem.commit'))} <b>${esc(FMT.bytes(tt.commit))}</b></span>
        <span class="chip" title="${esc(t('mem.inRamHint'))}">${esc(t('mem.inRam'))} <b>${esc(FMT.bytes(tt.ws))}</b></span>
        <span class="chip">${esc(t('mem.private'))} <b>${esc(FMT.bytes(byType[1]))}</b></span>
        <span class="chip">${esc(t('mem.image'))} <b>${esc(FMT.bytes(byType[3]))}</b></span>
        <span class="chip">${esc(t('mem.mapped'))} <b>${esc(FMT.bytes(byType[2]))}</b></span>
        <span class="chip" title="${esc(t('mem.reserveHint'))}">${esc(t('mem.reserve'))} <b>${esc(FMT.bytes(tt.reserve))}</b></span>
        </div><span class="spacer" style="flex:1"></span><button class="btn" type="button" data-a="reload">${icon('refresh')}${esc(t('d.refresh'))}</button></div>`));
      el.appendChild(h(`<div class="card"><h4>${esc(t('mem.layout'))}<span class="spacer"></span><span style="text-transform:none;letter-spacing:0">${esc(t('mem.regions', { count: FMT.int(model.items.length, LANG) }))}</span></h4><div class="cb">
        <div class="mm-wrap"><canvas class="mm-canvas"></canvas></div>
        <div class="legend" style="margin-top:8px"><span class="lg"><i style="--c:var(--r-private)"></i>${esc(t('mem.private'))}</span><span class="lg"><i style="--c:var(--r-image)"></i>${esc(t('mem.image'))}</span>
        <span class="lg"><i style="--c:var(--r-mapped)"></i>${esc(t('mem.mapped'))}</span><span class="lg-ramp">${esc(t('mem.rampLow'))}<i></i>${esc(t('mem.rampHigh'))}</span></div>
        <div class="note" style="margin-top:6px">${esc(t('mem.mapHint'))}${mm.truncated ? ' ' + esc(t('d.truncated')) : ''}</div></div></div>`));
      el.appendChild(h(`<div class="bar-row"><input class="input sm" type="search" spellcheck="false" data-a="filter" placeholder="${esc(t('mem.filter'))}" style="flex:1;min-width:160px"></div>`));
      list = vlist(el, { cols: '150px 84px 104px 64px 70px minmax(0,1fr)', grow: false, height: 250,
        head: [[t('mem.addr')], [t('g.size'), 'num'], [t('mem.type')], [t('mem.protect')], [t('mem.inRam'), 'num'], [t('mem.name')]] });
      el.appendChild(h('<div data-r="hex"></div>'));
      applyFilter();
      const canvas = el.querySelector('.mm-canvas');
      canvas.onmousemove = (e) => {
        const r = canvas.getBoundingClientRect();
        const it = hit && hit.at(e.clientX - r.left, e.clientY - r.top);
        if (!it) { hideTip(); return; }
        showTip(`<div class="mono">${FMT.addr(it.base, 16)} · <b>${esc(FMT.bytes(it.size))}</b></div><div>${esc(t(typeOf(it)[1]))} · <span class="mono">${esc(FMT.protect(it.protect))}</span> · ${esc(t('mem.inRam'))} ${inRam(it)}</div>${it.name ? `<div class="t3">${esc(FMT.midEllipsis(it.name, 70))}</div>` : ''}`, e.clientX, e.clientY);
      };
      canvas.onmouseleave = hideTip;
      canvas.onclick = (e) => {
        const r = canvas.getBoundingClientRect();
        pick(hit && hit.at(e.clientX - r.left, e.clientY - r.top), true);
      };
      requestAnimationFrame(paintMap);
    }
    el.addEventListener('click', (e) => { if (e.target.closest('[data-a="reload"]')) load(); });
    el.addEventListener('input', (e) => { if (e.target.matches('[data-a="filter"]')) { filter = e.target.value; applyFilter(); } });
    const ro = new ResizeObserver(() => { if (model) paintMap(); });
    ro.observe(el);
    load();
    return { repaint: paintMap, destroy() { dead = true; ro.disconnect(); if (viewer) viewer.destroy(); if (list) list.destroy(); } };
  };

  // Disk: G/Ç hızı, açık tutamaç türleri, açık dosyalar; seçilen dosyanın birimdeki yerleşimi ve içeriği
  PROC.disk = (el) => {
    let list = null, files = [], shown = [], filter = '', sel = -1, viewer = null, dead = false, seq = 0;
    const io = chartCard(el, t('disk.io'), '--m-io', true);
    const statsEl = h(`<div class="stats">${[['rr', 'disk.readRate'], ['wr', 'disk.writeRate'], ['rb', 'g.ioRead'], ['wb', 'g.ioWrite'], ['ro', 'disk.readOps'], ['wo', 'disk.writeOps']].map(([k, key]) => statBox(t(key), k)).join('')}</div>`);
    el.appendChild(statsEl);
    el.appendChild(h(`<div class="note">${esc(t('disk.ioNote'))}</div>`));
    const area = h('<div style="display:flex;flex-direction:column;gap:12px"></div>');
    el.appendChild(area);
    function paintLive() {
      const c = CHARTS.colors();
      const s = APP.hist.series(cur.key);
      if (s) io.set(s.io, s.n, { color: c.io, fmt: fRate, floorMax: 65536 }); else io.blank('—');
      const p = live();
      setV(statsEl, 'rr', p ? fRate(p.ioRead) : '—');
      setV(statsEl, 'wr', p ? fRate(p.ioWrite) : '—');
      const k = (cur.info && cur.info.counters) || null;
      setV(statsEl, 'rb', k ? FMT.bytes(k.ioReadBytes) : '—');
      setV(statsEl, 'wb', k ? FMT.bytes(k.ioWriteBytes) : '—');
      setV(statsEl, 'ro', k ? FMT.int(k.ioReadOps, LANG) : '—');
      setV(statsEl, 'wo', k ? FMT.int(k.ioWriteOps, LANG) : '—');
    }
    function applyFilter() {
      const qs = filter.trim().toLowerCase();
      shown = qs ? files.filter((f) => f.path.toLowerCase().includes(qs)) : files;
      list.set({
        count: shown.length, top: true, sel: shown.indexOf(files[sel]), empty: t(files.length ? 'disk.noMatch' : 'disk.noFiles'),
        render: (k) => {
          const f = shown[k];
          return `<span class="start" title="${esc(f.path)}">${esc(f.path)}</span><span class="dim">${esc(t(f.kind === 'dir' ? 'disk.dir' : 'disk.file'))}</span><span class="num">${f.kind === 'dir' || !(f.size >= 0) ? '—' : esc(FMT.bytes(f.size))}</span>`;
        },
        onClick: (k) => pick(files.indexOf(shown[k])),
        onMenu: (k, e) => pathMenu(shown[k].path, e),
      });
    }
    async function pick(i) {
      const f = files[i];
      if (!f) return;
      sel = i;
      list.select(shown.indexOf(f));
      if (viewer) { viewer.destroy(); viewer = null; }
      const my = ++seq;
      const box = area.querySelector('[data-r="file"]');
      box.innerHTML = '';
      const card = h(`<div class="card"><h4><span style="text-transform:none;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.path)}">${esc(FMT.midEllipsis(f.path, 90))}</span><span class="spacer"></span>
        <button class="icon-btn" type="button" data-a="copy" title="${esc(t('act.copyPath'))}">${icon('copy')}</button><button class="icon-btn" type="button" data-a="reveal" title="${esc(t('act.reveal'))}">${icon('folder')}</button></h4><div class="cb" data-r="map"></div></div>`);
      card.querySelector('[data-a="copy"]').onclick = () => APP.copy(f.path, t('d.path'));
      card.querySelector('[data-a="reveal"]').onclick = () => APP.reveal(f.path);
      box.appendChild(card);
      const mapEl = card.querySelector('[data-r="map"]');
      const hexEl = h('<div></div>');
      box.appendChild(hexEl);
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (f.kind === 'dir') { mapEl.innerHTML = `<div class="note">${esc(t('disk.dirNote'))}</div>`; return; }
      mapEl.innerHTML = `<div class="note">${esc(t('d.loading'))}</div>`;
      let size = f.size >= 0 ? f.size : -1;
      try {
        const fm = await query('filemap', { path: f.path });
        if (dead || my !== seq) return;
        if (fm.size >= 0) size = fm.size;
        const used = (fm.extents || []).reduce((a, x) => a + x[1], 0) * (fm.clusterSize || 0);
        mapEl.innerHTML = `<div class="chips">
          <span class="chip">${esc(t('disk.volume'))} <b>${esc(fm.volume || '—')}</b></span>
          <span class="chip">${esc(t('g.size'))} <b>${esc(FMT.bytes(fm.size))}</b></span>
          <span class="chip" title="${esc(t('disk.onDiskHint'))}">${esc(t('disk.onDisk'))} <b>${esc(FMT.bytes(used))}</b></span>
          <span class="chip">${esc(t('disk.cluster'))} <b>${esc(FMT.bytes(fm.clusterSize))}</b></span>
          <span class="chip" title="${esc(t('disk.fragmentsHint'))}">${esc(t('disk.fragments'))} <b>${FMT.int(fm.fragments, LANG)}</b></span></div>`
          + (fm.resident ? `<div class="note" style="margin-top:8px">${esc(t('disk.resident'))}</div>`
            : `<canvas class="cm-canvas" style="margin-top:10px"></canvas><div class="cm-labels"><span>${esc(t('disk.volStart'))}</span><span>${esc(t('disk.volEnd', { size: FMT.bytes((fm.totalClusters || 0) * (fm.clusterSize || 0)) }))}</span></div>
               <div class="note" style="margin-top:4px">${esc(t('disk.mapHint'))}${fm.truncated ? ' ' + esc(t('d.truncated')) : ''}</div>`);
        const canvas = mapEl.querySelector('canvas');
        if (canvas) { ctlMap = () => CHARTS.clusterMap(canvas, fm); requestAnimationFrame(ctlMap); }
      } catch (e) {
        if (dead || my !== seq) return;
        ctlMap = null;
        mapEl.innerHTML = `<div class="note${e.code === 'unsupported' ? '' : ' warn'}">${esc(e.code === 'unsupported' ? t('disk.mapUnsupported') : `${t('disk.mapFailed')} ${errOf(e)}`)}</div>`;
      }
      if (size > 0) {
        viewer = HEX.createViewer(hexEl, {
          title: f.path, total: size, base: null, live: false, errorText: errOf,
          read: async (off, len) => FMT.b64ToBytes((await query('readfile', { path: f.path, offset: off, len })).b64),
          onClose: () => { viewer = null; },
        });
      } else if (size === 0) hexEl.innerHTML = `<div class="note">${esc(t('disk.emptyFile'))}</div>`;
    }
    let ctlMap = null;
    async function load() {
      const c = cur;
      if (viewer) { viewer.destroy(); viewer = null; }
      if (list) { list.destroy(); list = null; }
      ctlMap = null;
      loading(area);
      let hd;
      try { hd = await query('handles', { pid: c.pid }); } catch (e) { if (!dead && cur === c) failure(area, e); return; }
      if (dead || cur !== c) return;
      files = (hd.files || []).slice().sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? 1 : -1));
      sel = -1;
      const counts = Object.entries(hd.counts || {}).sort((a, b) => b[1] - a[1]);
      area.innerHTML = '';
      area.appendChild(h(`<div class="card"><h4>${esc(t('disk.handles'))}<span class="spacer"></span><button class="icon-btn" type="button" data-a="reload" title="${esc(t('d.refresh'))}">${icon('refresh')}</button></h4>
        <div class="cb"><div class="chips">${counts.length ? counts.map(([k, v]) => `<span class="chip">${esc(k)} <b>${FMT.int(v, LANG)}</b></span>`).join('') : `<span class="note">${esc(t('disk.noHandles'))}</span>`}</div>
        ${hd.truncated ? `<div class="note" style="margin-top:6px">${esc(t('d.truncated'))}</div>` : ''}</div></div>`));
      area.appendChild(h(`<div class="bar-row"><b style="font-size:12.5px">${esc(t('disk.openFiles', { count: FMT.int(files.length, LANG) }))}</b><input class="input sm" type="search" spellcheck="false" data-a="filter" placeholder="${esc(t('disk.filter'))}" style="flex:1;min-width:160px"></div>`));
      list = vlist(area, { cols: 'minmax(0,1fr) 70px 86px', grow: false, height: 240, head: [[t('d.path')], [t('mem.type')], [t('g.size'), 'num']] });
      area.appendChild(h('<div data-r="file" style="display:flex;flex-direction:column;gap:12px"></div>'));
      applyFilter();
    }
    el.addEventListener('click', (e) => { if (e.target.closest('[data-a="reload"]')) load(); });
    el.addEventListener('input', (e) => { if (e.target.matches('[data-a="filter"]')) { filter = e.target.value; applyFilter(); } });
    requestAnimationFrame(paintLive);
    load();
    return {
      tick: paintLive, onInfo: paintLive,
      repaint() { paintLive(); if (ctlMap) ctlMap(); },
      destroy() { dead = true; if (viewer) viewer.destroy(); if (list) list.destroy(); },
    };
  };

  PROC.gpu = (el) => {
    if (!APP.gpuOn()) {
      message(el, 'info', t('gpu.noCounters'), t(APP.mon.kind === 'linux' ? 'gpu.linuxHint' : 'gpu.noCountersHint'));
      return {};
    }
    const gpus = (APP.hello && APP.hello.gpus) || [];
    const nameOf = (luid) => { const g = gpus.find((x) => x.luid === luid); return g ? g.name : luid; };
    let engines = [], dead = false, busy = false;
    const chart = chartCard(el, t('sys.gpu'), '--m-gpu');
    const statsEl = h(`<div class="stats">${statBox(t('gpu.dedicated'), 'ded')}${statBox(t('gpu.shared'), 'shr')}</div>`);
    el.appendChild(statsEl);
    el.appendChild(h(`<div class="card"><h4>${esc(t('gpu.adapters'))}</h4><div class="cb"><dl class="kv">${gpus.length ? gpus.map((g) => kvRow(g.name, `${esc(FMT.bytes(g.dedicated))} ${esc(t('gpu.dedicated'))} · ${esc(FMT.bytes(g.shared))} ${esc(t('gpu.shared'))}${g.software ? ` <span class="badge">${esc(t('gpu.software'))}</span>` : ''}`)).join('') : kvRow('—', esc(t('gpu.noAdapters')))}</dl></div></div>`));
    const list = vlist(el, { cols: 'minmax(0,1fr) 70px 150px 84px', grow: false, height: 200, empty: t('gpu.noEngines'),
      head: [[t('gpu.adapter')], [t('gpu.engine'), 'num'], [t('mem.type')], [t('gpu.util'), 'num']] });
    el.appendChild(h(`<div class="note">${esc(t('gpu.note'))}</div>`));
    function paintLive() {
      const c = CHARTS.colors();
      const s = APP.hist.series(cur.key);
      if (s) chart.set(s.gpu, s.n, { color: c.gpu, fmt: fPct, max: 100 }); else chart.blank('—');
      const p = live();
      setV(statsEl, 'ded', p ? FMT.bytes(p.gpuDed) : '—');
      setV(statsEl, 'shr', p ? FMT.bytes(p.gpuShr) : '—');
    }
    async function load() {
      if (busy || cur.exited) return;
      busy = true;
      const c = cur;
      try {
        const d = await query('gpudetail', { pid: c.pid });
        if (dead || cur !== c) return;
        engines = (d.engines || []).slice().sort((a, b) => b.util - a.util || a.eng - b.eng);
        list.set({ count: engines.length, render: (k) => { const e = engines[k]; return `<span title="${esc(nameOf(e.luid))}">${esc(nameOf(e.luid))}</span><span class="num mono">${e.eng}</span><span class="dim">${esc(e.type || '—')}</span><span class="num">${FMT.pct(e.util)} %</span>`; } });
      } catch (e) {
        if (dead || cur !== c) return;
        engines = [];
        list.set({ count: 0, empty: errOf(e) });
      } finally { busy = false; }
    }
    requestAnimationFrame(paintLive);
    load();
    return { tick(n) { paintLive(); if (n % 2 === 0) load(); }, repaint: paintLive, destroy() { dead = true; list.destroy(); } };
  };

  // Pencere: sürecin üst düzey pencereleri ve seçilenin görüntüsü
  PROC.window = (el) => {
    let hwnd = null, auto = false, busy = false, again = false, dead = false, sig = null;
    const wins = () => ((cur.info && cur.info.windows) || []).slice().sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0) || (b.title ? 1 : 0) - (a.title ? 1 : 0));
    async function capture() {
      const box = el.querySelector('[data-r="cap"]');
      if (!box || !hwnd) return;
      if (busy) { again = true; return; }
      busy = true;
      const c = cur, my = hwnd;
      try {
        const r = await query('capture', { hwnd: my, maxW: 1100 });
        if (dead || cur !== c || hwnd !== my) return;
        const info = el.querySelector('[data-r="capinfo"]');
        if (!r.w || !r.h || !r.b64) {
          box.innerHTML = `<div class="note">${esc(t(r.minimized ? 'win.minimized' : 'win.empty'))}</div>`;
          if (info) info.textContent = '';
          return;
        }
        let canvas = box.querySelector('canvas');
        if (!canvas) { box.innerHTML = ''; canvas = document.createElement('canvas'); box.appendChild(canvas); }
        CHARTS.bgra(canvas, FMT.b64ToBytes(r.b64), r.w, r.h);
        if (info) info.textContent = t('win.capInfo', { w: r.srcW, h: r.srcH, time: timeOf(Date.now()) });
      } catch (e) {
        if (dead || cur !== c || hwnd !== my) return;
        box.innerHTML = `<div class="note${e.code === 'unsupported' ? '' : ' warn'}">${esc(e.code === 'unsupported' ? t('win.unsupported') : e.code === 'gone' ? t('win.closed') : `${t('win.failed')} ${errOf(e)}`)}</div>`;
      } finally {
        busy = false;
        if (again && !dead) { again = false; capture(); }
      }
    }
    function build() {
      const list = wins();
      const s = list.map((w) => `${w.hwnd}|${w.title}|${w.visible}|${w.minimized}`).join('\n') + (cur.info ? '' : '?') + (cur.infoErr ? cur.infoErr.code : '');
      if (s === sig) return;
      sig = s;
      el.innerHTML = '';
      if (!cur.info) { if (cur.infoErr) failure(el, cur.infoErr); else loading(el); return; }
      if (!list.length) {
        message(el, 'desktop', t('win.none'), t(APP.mon.kind === 'linux' ? 'win.unsupported' : 'win.noneHint'));
        return;
      }
      if (!list.some((w) => w.hwnd === hwnd)) hwnd = list[0].hwnd;
      el.appendChild(h(`<div class="win-list">${list.map((w) => `<button type="button" class="win-item${w.hwnd === hwnd ? ' on' : ''}${w.visible ? '' : ' off'}" data-h="${esc(w.hwnd)}">
        ${icon('desktop')}<span class="wi-t" title="${esc(w.title || '')}">${esc(w.title || t('win.untitled'))}</span>
        <span class="wi-s">${esc(w.cls || '')} · ${w.rect ? `${w.rect[2]}×${w.rect[3]}` : ''}${w.minimized ? ' · ' + esc(t('win.stMin')) : w.visible ? '' : ' · ' + esc(t('win.stHidden'))}</span></button>`).join('')}</div>`));
      el.appendChild(h(`<div class="bar-row"><button class="btn" type="button" data-a="shot">${icon('refresh')}${esc(t('d.refresh'))}</button>
        <label class="check sm" style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px"><input type="checkbox" data-a="auto"${auto ? ' checked' : ''}><span>${esc(t('win.auto'))}</span></label>
        <span class="spacer" style="flex:1"></span><span class="note" data-r="capinfo"></span></div>`));
      el.appendChild(h(`<div class="cap-box" data-r="cap"><div class="note">${esc(t('d.loading'))}</div></div>`));
      el.appendChild(h(`<div class="note">${esc(t('win.note'))}</div>`));
      capture();
    }
    el.addEventListener('click', (e) => {
      const w = e.target.closest('[data-h]');
      if (w) {
        hwnd = w.dataset.h;
        for (const b of el.querySelectorAll('.win-item')) b.classList.toggle('on', b === w);
        const box = el.querySelector('[data-r="cap"]');
        if (box) box.innerHTML = `<div class="note">${esc(t('d.loading'))}</div>`;
        capture();
      } else if (e.target.closest('[data-a="shot"]')) capture();
    });
    el.addEventListener('change', (e) => { if (e.target.matches('[data-a="auto"]')) auto = e.target.checked; });
    build();
    return { tick(n) { if (auto && n % 2 === 0 && !cur.exited) capture(); }, onInfo: build, destroy() { dead = true; } };
  };

  PROC.modules = (el) => {
    el.classList.add('fill');
    let mods = [], shown = [], filter = '', list = null, dead = false;
    function applyFilter() {
      const qs = filter.trim().toLowerCase();
      shown = qs ? mods.filter((m) => m.path.toLowerCase().includes(qs)) : mods;
      const cnt = el.querySelector('[data-r="count"]');
      if (cnt) cnt.textContent = t('mod.count', { count: FMT.int(shown.length, LANG), size: FMT.bytes(shown.reduce((a, m) => a + (m.size || 0), 0)) });
      list.set({
        count: shown.length, top: true, empty: t('mod.none'),
        render: (k) => {
          const m = shown[k];
          return `<span title="${esc(m.path)}">${esc(FMT.baseName(m.path) || m.path)}</span><span class="mono">${ltr(FMT.addr(m.base, 16))}</span><span class="num">${esc(FMT.bytes(m.size))}</span><span class="dim start" title="${esc(m.path)}">${esc(m.path)}</span>`;
        },
        onClick: (k, e) => pathMenu(shown[k].path, e),
        onMenu: (k, e) => pathMenu(shown[k].path, e),
      });
    }
    async function load() {
      const c = cur;
      if (list) { list.destroy(); list = null; }
      loading(el);
      let r;
      try { r = await query('modules', { pid: c.pid }); } catch (e) { if (!dead && cur === c) failure(el, e); return; }
      if (dead || cur !== c) return;
      mods = r.modules || [];
      el.innerHTML = '';
      el.appendChild(h(`<div class="bar-row"><input class="input sm" type="search" spellcheck="false" data-a="filter" placeholder="${esc(t('mod.filter'))}" style="flex:1;min-width:160px" value="${esc(filter)}">
        <span class="note" data-r="count"></span><button class="icon-btn" type="button" data-a="reload" title="${esc(t('d.refresh'))}">${icon('refresh')}</button></div>`));
      list = vlist(el, { cols: 'minmax(120px,220px) 150px 84px minmax(0,1fr)', head: [[t('mem.name')], [t('mod.base')], [t('g.size'), 'num'], [t('d.path')]] });
      applyFilter();
    }
    el.addEventListener('click', (e) => { if (e.target.closest('[data-a="reload"]')) load(); });
    el.addEventListener('input', (e) => { if (e.target.matches('[data-a="filter"]')) { filter = e.target.value; applyFilter(); } });
    load();
    return { destroy() { dead = true; if (list) list.destroy(); } };
  };

  PROC.threads = (el) => {
    el.classList.add('fill');
    let list = null, rows = [], prev = new Map(), prevT = 0, src = null;
    function update() {
      const i = cur.info;
      if (!i) { if (!list) { if (cur.infoErr) failure(el, cur.infoErr); else loading(el); } return; }
      if (!list) {
        el.innerHTML = '';
        el.appendChild(h(`<div class="bar-row"><span class="note" data-r="count"></span></div>`));
        list = vlist(el, { cols: '90px minmax(90px,1fr) 80px 76px 110px minmax(120px,1.4fr)', empty: t('thr.none'),
          head: [[t('thr.tid')], [t('thr.state')], [t('g.priority'), 'num'], ['CPU', 'num'], [t('thr.cpuTime'), 'num'], [t('g.started')]] });
      }
      if (i !== src) {
        // CPU %: ardışık iki sorgu arasındaki CPU süresi farkı / geçen süre (tek çekirdeğe göre)
        const now = Date.now();
        const dt = prevT ? now - prevT : 0;
        const next = new Map();
        rows = (i.threads || []).map((th) => {
          next.set(th.tid, th.cpuMs);
          const before = prev.get(th.tid);
          return { ...th, pct: dt > 200 && before !== undefined ? Math.max(0, Math.min(100, ((th.cpuMs - before) / dt) * 100)) : -1 };
        });
        rows.sort((a, b) => b.pct - a.pct || b.cpuMs - a.cpuMs || a.tid - b.tid);
        prev = next;
        prevT = now;
        src = i;
      }
      el.querySelector('[data-r="count"]').textContent = t('thr.count', { count: FMT.int(rows.length, LANG) });
      list.set({
        count: rows.length,
        render: (k) => {
          const th = rows[k];
          return `<span class="mono">${th.tid}</span><span${th.state === 'run' ? '' : ' class="dim"'}>${esc(t(`thr.st.${['run', 'ready', 'wait'].includes(th.state) ? th.state : 'other'}`))}</span><span class="num">${esc(String(th.priority ?? '—'))}</span>`
            + `<span class="num">${th.pct < 0 ? '—' : FMT.pct(th.pct) + ' %'}</span><span class="num">${esc(FMT.duration(th.cpuMs, DUR))}</span><span class="dim">${esc(th.start ? formatDate(th.start) : '—')}</span>`;
        },
      });
    }
    update();
    return { onInfo: update, destroy() { if (list) list.destroy(); } };
  };

  // Tarihçe: süreç başlama/sonlanma olayları. pid verilirse o sürecin ve çocuklarının olayları öne alınır.
  function historyView(el, forProc) {
    el.classList.add('fill');
    let scope = forProc ? 'proc' : 'all', kind = 'all', filter = '', shown = [], sig = '';
    const seg = (role, items, on) => `<div class="seg sm" data-seg="${role}">${items.map(([v, label]) => `<button type="button" data-v="${v}" class="${v === on ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
    if (forProc) {
      el.appendChild(h(`<div class="stats">${statBox(t('hist.firstSeen'), 'first')}${statBox(t('hist.lifetime'), 'life')}${statBox(t('hist.peakCpu'), 'pc')}${statBox(t('hist.avgCpu'), 'ac')}${statBox(t('hist.peakMem'), 'pm')}</div>`));
    }
    el.appendChild(h(`<div class="bar-row">${forProc ? seg('scope', [['proc', t('hist.thisProc')], ['all', t('hist.all')]], scope) : ''}
      ${seg('kind', [['all', t('hist.kindAll')], ['start', t('hist.started')], ['exit', t('hist.exited')]], kind)}
      <input class="input sm" type="search" spellcheck="false" data-a="filter" placeholder="${esc(t('hist.filter'))}" style="flex:1;min-width:120px">
      <span class="note" data-r="count"></span>${forProc ? '' : `<button class="btn" type="button" data-a="clear">${icon('trash')}${esc(t('hist.clear'))}</button>`}</div>`));
    const list = vlist(el, { cols: '84px 92px minmax(0,1fr) 70px 84px 70px 84px', empty: t('hist.none'),
      head: [[t('hist.time')], [t('hist.event')], [t('hist.process')], ['PID', 'num'], [t('hist.lifetime'), 'num'], [t('hist.peakCpu'), 'num'], [t('hist.peakMem'), 'num']] });
    el.appendChild(h(`<div class="note">${esc(t('hist.note'))}</div>`));
    function summary() {
      if (!forProc) return;
      const s = APP.hist.series(cur.key);
      const end = cur.exited ? (cur.endT || APP.t) : APP.t;
      const st = s ? stats(s.cpu, s.n) : null;
      setV(el, 'first', cur.start ? formatDate(cur.start) : '—');
      setV(el, 'life', cur.start && end ? FMT.duration(end - cur.start, DUR) : '—');
      setV(el, 'pc', s ? fPct(s.peakCpu) : '—');
      setV(el, 'ac', st ? fPct(st.avg) : '—');
      setV(el, 'pm', s ? FMT.bytes(s.peakWs) : '—');
    }
    function refresh(force) {
      summary();
      const evs = APP.events;
      const lastEv = evs[evs.length - 1];
      const s = `${evs.length}:${lastEv ? `${lastEv.t}${lastEv.type}${lastEv.pid}` : ''}`;
      if (!force && s === sig) return;
      sig = s;
      const qs = filter.trim().toLowerCase();
      shown = [];
      for (let k = evs.length - 1; k >= 0; k--) {
        const ev = evs[k];
        if (kind !== 'all' && ev.type !== kind) continue;
        if (scope === 'proc' && !(ev.pid === cur.pid && (!ev.start || !cur.start || Math.abs(ev.start - cur.start) < 2000)) && ev.ppid !== cur.pid) continue;
        if (qs && !(String(ev.name || '').toLowerCase().includes(qs) || String(ev.pid) === qs)) continue;
        shown.push(ev);
      }
      el.querySelector('[data-r="count"]').textContent = t('hist.count', { count: FMT.int(shown.length, LANG) });
      list.set({
        count: shown.length,
        render: (k) => {
          const ev = shown[k];
          const ex = ev.type === 'exit';
          return `<span class="mono dim" title="${esc(formatDate(ev.t))}">${esc(timeOf(ev.t))}</span><span class="${ex ? 'ev-exit' : 'ev-start'}">${esc(t(ex ? 'hist.exited' : 'hist.started'))}</span><span title="${esc(ev.name || '')}">${esc(ev.name || '?')}</span><span class="num mono">${ev.pid}</span>`
            + `<span class="num">${ex ? esc(FMT.duration(ev.lifeMs, DUR)) : '—'}</span><span class="num">${ex ? fPct(ev.peakCpu) : '—'}</span><span class="num">${ex ? esc(FMT.bytes(ev.peakWs)) : '—'}</span>`;
        },
        onClick: (k) => { if (!APP.selectPid(shown[k].pid)) toast(t('hist.notRunning', { name: shown[k].name || shown[k].pid }), { type: 'warn', timeout: 2200 }); },
      });
    }
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-seg] button');
      if (b) {
        const role = b.parentElement.dataset.seg;
        if (role === 'scope') scope = b.dataset.v; else kind = b.dataset.v;
        for (const x of b.parentElement.children) x.classList.toggle('on', x === b);
        refresh(true);
      } else if (e.target.closest('[data-a="clear"]')) {
        await window.api.clearEvents();
        APP.events = [];
        refresh(true);
      }
    });
    el.addEventListener('input', (e) => { if (e.target.matches('[data-a="filter"]')) { filter = e.target.value; refresh(true); } });
    refresh(true);
    return { tick: () => refresh(false), onInfo: summary, destroy() { list.destroy(); } };
  }
  PROC.history = (el) => historyView(el, true);

  // --- Sistem görünümü (seçim yokken) ------------------------------------------------
  const SYS = {};
  SYS.history = (el) => historyView(el, false);
  SYS.overview = (el) => {
    const gpuOn = APP.gpuOn();
    const grid = h('<div class="charts2"></div>');
    el.appendChild(grid);
    const cpu = chartCard(grid, t('sys.cpu'), '--m-cpu', true);
    const mem = chartCard(grid, t('sys.mem'), '--m-mem', true);
    const io = chartCard(grid, t('sys.io'), '--m-io', true);
    const gpu = gpuOn ? chartCard(grid, t('sys.gpu'), '--m-gpu', true) : null;
    const tops = h(`<div class="charts2">${[['cpu', 'sys.topCpu', 'CPU'], ['ws', 'sys.topMem', t('col.mem')]].map(([k, key, col]) => `<div class="vl" style="--vl-cols:minmax(0,1fr) 54px 78px" data-top="${k}">
      <div class="vl-head"><span>${esc(t(key))}</span><span class="num">PID</span><span class="num">${esc(col)}</span></div><div data-r="rows"></div></div>`).join('')}</div>`);
    el.appendChild(tops);
    const info = h(`<div class="card"><h4>${esc(t('sys.info'))}</h4><div class="cb"><dl class="kv" data-r="kv"></dl></div></div>`);
    el.appendChild(info);
    let kvSig = '';
    function paint() {
      const c = CHARTS.colors();
      const s = APP.hist.sysSeries();
      if (s && s.n) {
        cpu.set(s.cpu, s.n, { color: c.cpu, fmt: fPct, max: 100 });
        mem.set(s.mem, s.n, { color: c.mem, fmt: fPct, max: 100 });
        io.set(s.io, s.n, { color: c.io, fmt: fRate, floorMax: 1048576 });
        if (gpu) gpu.set(s.gpu, s.n, { color: c.gpu, fmt: fPct, max: 100 });
      } else for (const k of [cpu, mem, io, gpu]) if (k) k.blank('—');
      for (const box of tops.querySelectorAll('[data-top]')) {
        const k = box.dataset.top;
        const best = APP.procs.filter((p) => p.pid !== 0).sort((a, b) => b[k] - a[k]).slice(0, 6);
        box.querySelector('[data-r="rows"]').innerHTML = best.map((p) => `<div class="vl-row click" data-key="${esc(p.key)}"><span title="${esc(p.name)}">${esc(p.name)}</span><span class="num mono dim">${p.pid}</span><span class="num">${k === 'cpu' ? FMT.pct(p.cpu) + ' %' : esc(FMT.bytes(p.ws))}</span></div>`).join('')
          || `<div class="vl-empty">${esc(t('empty.waiting'))}</div>`;
      }
      const hl = APP.hello;
      const y = APP.sys;
      const rows = [];
      if (hl) {
        rows.push(kvRow(t('sys.os'), esc([hl.os, hl.arch].filter(Boolean).join(' · ') || '—')));
        rows.push(kvRow(t('sys.cpuCount'), FMT.int(hl.cpuCount, LANG)));
      }
      if (y) {
        rows.push(kvRow(t('sys.memUsed'), `${esc(FMT.bytes(y.memTotal - y.memAvail))} / ${esc(FMT.bytes(y.memTotal))}`));
        if (y.commitLimit) rows.push(kvRow(t('sys.commit'), `${esc(FMT.bytes(y.commitTotal))} / ${esc(FMT.bytes(y.commitLimit))}`));
        rows.push(kvRow(t('sys.io'), `${esc(t('disk.readRate'))} ${esc(fRate(y.ioRead))} · ${esc(t('disk.writeRate'))} ${esc(fRate(y.ioWrite))}`));
      }
      if (hl) {
        for (const g of hl.gpus || []) rows.push(kvRow(t('sys.gpu'), `${esc(g.name)} · ${esc(FMT.bytes(g.dedicated))}${g.software ? ` <span class="badge">${esc(t('gpu.software'))}</span>` : ''}`));
        rows.push(kvRow(t('sys.access'), esc(t(hl.elevated ? 'foot.elevated' : 'foot.standard'))));
        rows.push(kvRow(t('about.agent'), `<span class="mono">${esc(hl.agent || '—')}</span> · ${esc(t('about.protocol', { v: hl.protocol }))}`));
      }
      const html = rows.join('') || kvRow('—', esc(t('d.waiting')));
      if (html !== kvSig) { kvSig = html; info.querySelector('[data-r="kv"]').innerHTML = html; }
    }
    // Satırlar her yenilemede yeniden yazıldığı için tıklama yerine basış anı dinlenir
    tops.addEventListener('mousedown', (e) => { const r = e.target.closest('[data-key]'); if (r && e.button === 0) APP.select(r.dataset.key); });
    requestAnimationFrame(paint);
    return { tick: paint, repaint: paint };
  };

  // --- Dış arayüz -------------------------------------------------------------------
  function init(el) {
    host = el;
    host.innerHTML = '<div class="d-head"></div><div class="d-tabs"></div><div class="d-body"></div>';
    [headEl, tabsEl, bodyEl] = host.children;
    headEl.onclick = (e) => { if (e.target.closest('[data-a="close"]')) APP.select(null); };
    tabsEl.onclick = (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      if (cur) tab = b.dataset.tab; else sysTab = b.dataset.tab;
      paintTabs();
      mount();
    };
    render();
  }
  function select(key) {
    const p = key ? APP.byKey.get(key) : null;
    if ((cur ? cur.key : null) === (p ? p.key : null)) return;
    cur = p ? { key: p.key, pid: p.pid, name: p.name, start: p.start, info: null, infoErr: null, exited: false, endT: 0 } : null;
    headSig = '';
    render();
    if (cur) loadInfo();
  }
  function tick() {
    if (!host) return;
    tickNo++;
    if (cur && !cur.exited && !APP.byKey.has(cur.key)) {
      cur.exited = true;
      cur.endT = APP.t;
      if (ctl && ctl.onInfo) ctl.onInfo();
    }
    paintHead();
    if (ctl && ctl.tick) ctl.tick(tickNo);
    if (cur && !cur.exited && tickNo % 2 === 0) loadInfo();
  }
  function repaint() {
    if (!host) return;
    if (ctl && ctl.repaint) requestAnimationFrame(() => { if (ctl && ctl.repaint) ctl.repaint(); });
  }
  return { init, select, tick, repaint };
})();
