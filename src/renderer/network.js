'use strict';

// Ağ sekmesi (süreç ayrıntısı): yakalama durumu, sürecin bağlantıları / dinlediği portlar ve seçilen akışın
// giden / gelen verisi (Akıllı · Hex · Metin · HTML · Base64). Çözümleme netparse.js / netsmart.js, HTML üretimi
// netrender.js içindedir; burada yoklama, durum ve DOM vardır. Yakalanan içerik yalnız pencere belleğinde tutulur:
// diske yazılmaz, hiçbir yere gönderilmez; sekmeden çıkınca bırakılır.
const NETVIEW = (() => {
  const FORMATS = [['smart', 'net.fmt.smart'], ['hex', 'net.fmt.hex'], ['text', 'net.fmt.text'], ['html', 'net.fmt.html'], ['base64', 'net.fmt.base64']];
  const WIN = { hex: 16384, text: 65536, base64: 49152 };          // ham görünümlerde gösterilen son bayt sayısı
  const WIN_MAX = { hex: 262144, text: 1048576, base64: 262144 };
  const STATES = new Set(['established', 'listen', 'bound', 'closed', 'active', 'ended', 'syn_sent', 'syn_rcvd', 'fin_wait1', 'fin_wait2', 'close_wait', 'closing', 'last_ack', 'time_wait', 'delete_tcb', 'unknown']);
  const prefs = { format: 'smart', children: true, ports: '' };     // oturum boyunca hatırlanır
  let chain = Promise.resolve();                                    // netwatch çağrıları sırayla gider (sekmeler arası da)

  const endText = (v, addr, port) => (v === 6 ? `[${addr}]:${port}` : `${addr}:${port}`);

  function create(el, x) {
    const me = x.cur();
    const store = NETPARSE.createStore();
    let dead = false, cap = null, capSig = '', fw = null, conns = [], connErr = '', rows = [];
    let since = 0, clock = null, agentNow = 0, dropped = 0, paused = false, lastRev = -1, selKey = '', autoFlow = null;
    let gen = 0; // temizleme / yeniden izleme sayacı: eski yanıtın parçaları depoya girmesin
    let watchSig = null, watched = false, sawCapture = false, capBusy = false, connBusy = false, pullBusy = false, acting = false;
    let ports = NETRENDER.portFilter(prefs.ports);
    const fmtO = { t, bytes: FMT.bytes, time: (ms) => (clock === null || !ms ? '' : new Date(ms + clock).toLocaleTimeString(LANG)) };

    // --- İskelet -----------------------------------------------------------------
    const capEl = h('<div class="card nt-cap"></div>');
    el.appendChild(capEl);
    const chart = x.chartCard(el, t('col.net'), '--m-net');
    const statsEl = h(`<div class="stats">${x.statBox(t('net.rateDown'), 'rx')}${x.statBox(t('net.rateUp'), 'tx')}${x.statBox(t('net.totalDown'), 'rb')}${x.statBox(t('net.totalUp'), 'tb')}${x.statBox(t('net.connCount'), 'cn')}${x.statBox(t('net.listenCount'), 'ls')}</div>`);
    el.appendChild(statsEl);
    const headEl = h(`<div class="bar-row nt-head"><b>${esc(t('net.conns'))}</b><span class="badge" data-r="count">0</span><span class="spacer"></span>
      <input class="input sm" type="search" data-a="ports" spellcheck="false" autocomplete="off" placeholder="${esc(t('net.portFilter'))}" title="${esc(t('net.portFilterHint'))}" value="${esc(prefs.ports)}">
      <label class="check sm" title="${esc(t('net.childrenHint'))}"><input type="checkbox" data-a="children"${prefs.children ? ' checked' : ''}><span>${esc(t('net.children'))}</span></label></div>`);
    el.appendChild(headEl);
    const list = x.vlist(el, { cols: '44px 68px minmax(0,1fr) minmax(0,1.2fr) 100px 72px 72px', grow: false, height: 208, empty: t('net.noConns'),
      head: [[t('net.colProto')], ['PID', 'num'], [t('net.colLocal')], [t('net.colRemote')], [t('net.colState')], ['↓', 'num'], ['↑', 'num']] });
    const paneHtml = (dir, arrow, cls, title) => `<section class="nt-pane" data-dir="${dir}"><header><span class="${cls}">${arrow}</span><b>${esc(t(title))}</b><span class="nt-meta" data-r="meta"></span><span class="spacer"></span><button class="icon-btn" data-a="copy" title="${esc(t('net.copy'))}">${icon('copy')}</button></header><div class="nt-warn" data-r="warn" hidden></div><div class="nt-body" tabindex="0"></div></section>`;
    const streamEl = h(`<div class="card nt-stream"><div class="nt-bar"><div class="seg sm" data-r="fmt">${FORMATS.map(([f, k]) => `<button data-f="${f}"${f === prefs.format ? ' class="on"' : ''}>${esc(t(k))}</button>`).join('')}</div>
      <button class="btn sm ghost" data-a="pause"></button><button class="btn sm ghost" data-a="clear">${icon('trash')}${esc(t('net.clear'))}</button>
      <span class="nt-scope" data-r="scope"></span><span class="spacer"></span><span class="nt-status" data-r="status"></span></div>
      <div class="nt-panes">${paneHtml('out', '↑', 'nv-up', 'net.outTitle')}${paneHtml('in', '↓', 'nv-dn', 'net.inTitle')}</div></div>`);
    el.appendChild(streamEl);
    el.appendChild(h(`<div class="note">${esc(t(APP.mon.kind === 'linux' ? 'net.linuxNote' : 'net.privacy'))}</div>`));
    const panes = {};
    for (const sec of streamEl.querySelectorAll('.nt-pane')) {
      panes[sec.dataset.dir] = { el: sec, body: sec.querySelector('.nt-body'), meta: sec.querySelector('[data-r="meta"]'), warn: sec.querySelector('[data-r="warn"]'), sig: '', job: 0, win: {}, flow: null, mode: '' };
    }
    const scopeEl = streamEl.querySelector('[data-r="scope"]');
    const statusEl = streamEl.querySelector('[data-r="status"]');
    const pauseBtn = streamEl.querySelector('[data-a="pause"]');
    const countEl = headEl.querySelector('[data-r="count"]');
    const ro = new ResizeObserver(() => streamEl.classList.toggle('wide', streamEl.clientWidth >= 1100));
    ro.observe(streamEl);
    const paintPause = () => { pauseBtn.innerHTML = `${icon(paused ? 'play' : 'pause')}${esc(t(paused ? 'net.resume' : 'net.pause'))}`; pauseBtn.classList.toggle('on', paused); };
    paintPause();

    // --- Yakalama kartı ----------------------------------------------------------
    const capLine = (lead, title, hint, actions, cls) => `<div class="nt-capline${cls ? ` ${cls}` : ''}">${lead}<div class="nt-captext"><b>${esc(title)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div>${actions || ''}</div>`;
    const capBtn = (a, key, cls) => `<button class="btn sm${cls ? ` ${cls}` : ''}" data-a="${a}"${acting ? ' disabled' : ''}>${esc(t(key))}</button>`;
    function paintCap() {
      const sig = JSON.stringify([cap && [cap.capture, cap.reason, cap.elevated, cap.error || 0, (cap.ifaces || []).map((i) => i.addr), cap.errors || []], fw && fw.rule, acting]);
      if (sig === capSig) return;
      capSig = sig;
      let html;
      if (!cap) html = capLine('<span class="spin"></span>', t('d.loading'), '', '');
      else if (cap.reason === 'unsupported') html = capLine(icon('info'), t('net.capUnsupported'), t('net.capUnsupportedHint'), '');
      else if (cap.capture) {
        const v4 = (cap.ifaces || []).filter((i) => i.v !== 6);
        html = capLine('<span class="nt-dot"></span>', t('net.capOn'), `${t('net.capIfaces', { count: v4.length })}${v4.length ? ` · ${v4.slice(0, 6).map((i) => i.addr).join(', ')}${v4.length > 6 ? ' …' : ''}` : ''}`, capBtn('stop', 'net.capStop'));
        if (fw) {
          html += fw.rule
            ? capLine(icon('shield'), t('net.fwOn'), t('net.fwOnHint'), capBtn('fw-remove', 'net.fwRemove', 'ghost'), 'nt-fw')
            : capLine(icon('alert'), t('net.fwOff'), t('net.fwOffHint'), capBtn('fw-allow', 'net.fwAllow'), 'nt-fw warn');
        }
        if (cap.errors && cap.errors.length) html += `<div class="note warn">${cap.errors.slice(0, 4).map(esc).join('<br>')}</div>`;
      } else if (cap.elevated === false) {
        html = capLine(icon('lock'), t('net.capNeedsAdmin'), t('net.capNeedsAdminHint'), capBtn('elevate', 'mon.elevate', 'primary'));
      } else {
        const why = cap.reason === 'nonet' ? t('net.capNoIface') : cap.reason === 'failed' ? `${t('net.capFailed')}${cap.error ? ` (${cap.error})` : ''}` : '';
        html = capLine(icon('radar'), t('net.capOffTitle'), t('net.capOffHint'), capBtn('start', 'net.capStart', 'primary'));
        if (why) html += `<div class="note warn">${esc(why)}</div>`;
      }
      capEl.innerHTML = `<div class="cb">${html}</div>`;
    }
    function setCap(r) {
      const was = !!(cap && cap.capture);
      cap = r;
      if (r.capture) sawCapture = true;
      if (r.capture && !was) { watchSig = null; syncWatch(true); loadFw(); }
      if (!r.capture && was) { watched = false; watchSig = null; fw = null; }
      streamEl.hidden = r.reason === 'unsupported';
      // Yakalama bu platformda yoksa hız grafiği ve hız / toplam kutuları da anlamsızdır
      chart.el.hidden = streamEl.hidden;
      for (const k of ['rx', 'tx', 'rb', 'tb']) { const v = statsEl.querySelector(`[data-v="${k}"]`); if (v) v.closest('.stat').hidden = streamEl.hidden; }
      paintCap();
      if (r.capture !== was) paintStream(true);
    }
    async function loadCap() {
      if (capBusy || acting) return;
      capBusy = true;
      try { const r = await x.query('netcap', {}); if (!dead) setCap(r); }
      catch (e) { if (!dead) setCap({ capture: false, reason: e.code === 'unsupported' ? 'unsupported' : 'failed', error: x.errOf(e), ifaces: [], errors: [] }); }
      finally { capBusy = false; }
    }
    async function loadFw() {
      if (APP.mon.kind !== 'win') return;
      const r = await window.api.firewall('status');
      if (dead) return;
      fw = r.ok ? r.data : null;
      paintCap();
    }
    capEl.onclick = async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b || acting) return;
      const a = b.dataset.a;
      acting = true;
      paintCap();
      try {
        if (a === 'start' || a === 'stop') {
          try {
            const r = await x.query('netcap', { on: a === 'start' });
            if (dead) return;
            setCap(r);
            if (a === 'start' && !r.capture && r.elevated !== false) toast(t('net.capFailed'), { type: 'err', sub: r.reason === 'nonet' ? t('net.capNoIface') : r.error ? String(r.error) : '' });
          } catch (err) { if (!dead) toast(t('net.capFailed'), { type: 'err', sub: x.errOf(err) }); }
        } else if (a === 'elevate') {
          const r = await window.api.elevate();
          if (!r.ok && r.code !== 'cancelled') toast(t('mon.elevateFailed'), { type: 'err', sub: APP.errText(r.code) });
        } else if (a === 'fw-allow' || a === 'fw-remove') {
          const r = await window.api.firewall(a === 'fw-allow' ? 'allow' : 'remove');
          if (dead) return;
          if (r.ok) fw = r.data;
          else toast(t('net.fwFailed'), { type: 'err', sub: r.code === 'failed' && r.message ? r.message : APP.errText(r.code) });
        }
      } finally { acting = false; capSig = ''; if (!dead) paintCap(); }
    };

    // --- İzlenen süreçler --------------------------------------------------------
    function pids() {
      let p = prefs.children ? TREE.subtreePids(APP.byPid, me.pid) : [me.pid];
      if (!p.includes(me.pid)) p = p.concat(me.pid);
      return p.slice(-256).sort((a, b) => a - b); // kök sonda gelir: kırpılırsa korunur
    }
    function syncWatch(reset) {
      if (!cap || !cap.capture || me.exited) return;
      const p = pids();
      const sig = p.join(',');
      if (!reset && sig === watchSig) return;
      watchSig = sig;
      if (reset) gen++;
      chain = chain.then(async () => {
        if (dead) return;
        const r = await x.query('netwatch', { pids: p, reset: !!reset });
        if (dead) return;
        if (reset) { store.clear(); since = r.next; }
        watched = true;
      }).catch(() => { watchSig = null; });
    }

    // --- Bağlantılar -------------------------------------------------------------
    async function loadConns() {
      if (connBusy || me.exited) return;
      connBusy = true;
      try {
        const r = await x.query('netconns', { pids: pids() });
        if (dead) return;
        conns = r.conns || [];
        connErr = r.truncated ? t('d.truncated') : '';
        rebuild();
      } catch (e) {
        if (dead) return;
        conns = [];
        connErr = x.errOf(e);
        rebuild();
      } finally { connBusy = false; }
    }
    const group = (r) => (r.state === 'ended' || r.state === 'closed' ? 2 : r.listen ? 1 : 0);
    function rebuild() {
      const all = [];
      const seen = new Set();
      const bound = new Set();
      for (const c of conns) if (c.proto === 'udp' && c.state === 'bound') bound.add(`${c.pid}|${c.lport}`);
      for (const c of conns) {
        if (c.flow !== undefined) seen.add(c.flow);
        all.push({ key: c.flow !== undefined ? `f${c.flow}` : `${c.pid}|${c.proto}|${c.v}|${c.local}|${c.lport}|${c.remote}|${c.rport}`, pid: c.pid, proto: c.proto, v: c.v, local: c.local, lport: c.lport,
          remote: c.remote, rport: c.rport, state: c.state, rx: c.rx, tx: c.tx, flow: c.flow, listen: !c.remote,
          dup: c.proto === 'udp' && !!c.remote && bound.has(`${c.pid}|${c.lport}`) }); // bağlı (bound) satırında zaten toplanmış
      }
      for (const f of store.flows()) {
        if (seen.has(f.id)) continue;
        all.push({ key: `f${f.id}`, pid: f.pid, proto: f.proto, v: f.v, local: f.local, lport: f.lport, remote: f.remote, rport: f.rport,
          state: 'ended', rx: f.in.total, tx: f.out.total, flow: f.id, listen: false, dup: true });
      }
      let rb = 0, tb = 0, cn = 0, ls = 0;
      for (const r of all) {
        if (!r.dup) { rb += r.rx; tb += r.tx; }
        if (r.listen) ls++; else if (r.state !== 'ended' && r.state !== 'closed') cn++;
      }
      rows = all.filter((r) => ports.empty || ports.test(r.lport) || (r.rport > 0 && ports.test(r.rport)));
      rows.sort((a, b) => group(a) - group(b) || (a.proto < b.proto ? -1 : a.proto > b.proto ? 1 : 0) || a.lport - b.lport || (a.remote < b.remote ? -1 : a.remote > b.remote ? 1 : 0) || a.rport - b.rport || a.pid - b.pid);
      if (selKey && !rows.some((r) => r.key === selKey)) selKey = '';
      const capOn = !!(cap && cap.capture);
      x.setV(statsEl, 'rb', capOn ? FMT.bytes(rb) : '—');
      x.setV(statsEl, 'tb', capOn ? FMT.bytes(tb) : '—');
      x.setV(statsEl, 'cn', FMT.int(cn, LANG));
      x.setV(statsEl, 'ls', FMT.int(ls, LANG));
      countEl.textContent = rows.length === all.length ? String(all.length) : `${rows.length} / ${all.length}`;
      list.set({
        count: rows.length, empty: connErr || (all.length ? t('net.noMatch') : t('net.noConns')), sel: rows.findIndex((r) => r.key === selKey),
        render(i) {
          const r = rows[i];
          const cls = r.state === 'established' || r.state === 'active' ? ' ok' : r.listen ? ' acc' : '';
          const st = STATES.has(r.state) ? t(`net.state.${r.state}`) : r.state;
          const blind = capOn && r.v === 6 && r.flow === undefined; // IPv6 içeriği yakalanmaz
          const num = (n) => (blind ? `<span class="num dim" title="${esc(t('net.ipv6Note'))}">—</span>` : `<span class="num${n ? '' : ' dim'}">${n ? esc(FMT.bytes(n)) : '—'}</span>`);
          const local = endText(r.v, r.local, r.lport);
          const remote = r.remote ? endText(r.v, r.remote, r.rport) : '';
          return `<span class="dim">${r.proto.toUpperCase()}${r.v === 6 ? '6' : ''}</span><span class="num mono">${r.pid}</span><span class="mono" title="${esc(local)}">${esc(local)}</span>`
            + `<span class="mono${remote ? '' : ' dim'}" title="${esc(remote)}">${remote ? esc(remote) : '—'}</span><span><span class="badge${cls}">${esc(st)}</span></span>${num(r.rx)}${num(r.tx)}`;
        },
        onClick(i) {
          const r = rows[i];
          selKey = r && r.key !== selKey ? r.key : '';
          autoFlow = null;
          list.select(rows.findIndex((q) => q.key === selKey), false);
          paintStream(true);
        },
        onMenu(i, e) {
          const r = rows[i];
          if (!r) return;
          const local = endText(r.v, r.local, r.lport);
          const items = [{ label: t('net.copyLocal'), icon: 'copy', action: () => APP.copy(local, t('net.colLocal')) }];
          if (r.remote) items.push({ label: t('net.copyRemote'), icon: 'copy', action: () => APP.copy(endText(r.v, r.remote, r.rport), t('net.colRemote')) });
          items.push({ label: t('net.filterPort', { port: r.lport }), icon: 'filter', action: () => setPorts(String(r.lport)) });
          if (r.rport) items.push({ label: t('net.filterPort', { port: r.rport }), icon: 'filter', action: () => setPorts(String(r.rport)) });
          contextMenu(e.clientX, e.clientY, items);
        },
      });
    }
    const portsEl = headEl.querySelector('[data-a="ports"]');
    function setPorts(text) {
      const pf = NETRENDER.portFilter(text);
      if (portsEl.value !== text) portsEl.value = text;
      portsEl.classList.toggle('invalid', !pf.ok);
      if (!pf.ok) return;
      ports = pf;
      prefs.ports = text;
      autoFlow = null;
      rebuild();
      paintStream(true);
    }
    portsEl.oninput = () => setPorts(portsEl.value);
    headEl.querySelector('[data-a="children"]').onchange = (e) => {
      prefs.children = e.target.checked;
      loadConns();
      syncWatch(false);
    };

    // --- Akış: giden / gelen veri ------------------------------------------------
    const passes = (f) => ports.empty || ports.test(f.lport) || (f.rport > 0 && ports.test(f.rport));
    // Gösterilecek akış: listede seçilen bağlantı; seçim yoksa süzgece uyan en son etkin akış
    function scopeFlow() {
      const sel = selKey ? rows.find((r) => r.key === selKey) : null;
      if (sel) {
        if (sel.flow !== undefined) return { id: sel.flow, picked: true, row: sel };
        let best = null;
        for (const f of store.flows()) if (f.pid === sel.pid && f.proto === sel.proto && f.lport === sel.lport && (!best || f.lastT > best.lastT)) best = f;
        return { id: best ? best.id : -1, picked: true, row: sel };
      }
      const now = autoFlow === null ? null : store.flow(autoFlow);
      if (now && passes(now) && agentNow - now.lastT < 3000) return { id: now.id, picked: false };
      let best = null;
      for (const f of store.flows()) if (passes(f) && f.in.total + f.out.total > 0 && (!best || f.lastT > best.lastT)) best = f;
      if (best) autoFlow = best.id;
      else if (!now || !passes(now)) autoFlow = null;
      return { id: autoFlow === null ? -1 : autoFlow, picked: false };
    }
    function paintChrome(sc) {
      const f = sc.id >= 0 ? store.flow(sc.id) : null;
      const tag = `<span class="badge${sc.picked ? ' acc' : ''}">${esc(t(sc.picked ? 'net.scopePicked' : 'net.scopeAuto'))}</span>`;
      let html;
      if (f) html = `${tag}<span class="mono">${esc(`${f.proto.toUpperCase()} ${endText(f.v, f.local, f.lport)} ⇄ ${endText(f.v, f.remote, f.rport)}`)}</span>`;
      else if (sc.row) html = `${tag}<span class="mono">${esc(`${sc.row.proto.toUpperCase()} ${endText(sc.row.v, sc.row.local, sc.row.lport)}${sc.row.remote ? ` ⇄ ${endText(sc.row.v, sc.row.remote, sc.row.rport)}` : ''}`)}</span>`;
      else html = `<span class="dim">${esc(t('net.scopeNone'))}</span>`;
      if (scopeEl.dataset.h !== html) { scopeEl.dataset.h = html; scopeEl.innerHTML = html; }
      const status = store.size ? `${t('net.captured', { size: FMT.bytes(store.bytes), flows: store.size })}${dropped ? ` · ${t('net.dropped', { count: FMT.int(dropped, LANG) })}` : ''}` : '';
      if (statusEl.textContent !== status) statusEl.textContent = status;
    }
    function blank(p, text) {
      const sig = `e|${text}`;
      if (p.sig === sig) return;
      p.sig = sig;
      p.job++;
      p.flow = null;
      p.stick = true;
      p.body.innerHTML = `<div class="nt-empty">${esc(text)}</div>`;
      p.meta.textContent = '';
      p.warn.hidden = true;
    }
    function selecting(p) {
      const s = window.getSelection();
      return !!s && !s.isCollapsed && !!s.anchorNode && p.body.contains(s.anchorNode);
    }
    // Değişmeyen bölümlerin düğümü yerinde kalır: açık "Başlıklar" kutusu, yüklenmiş resimler ve seçim korunur
    function reconcile(p, items) {
      const body = p.body;
      const old = new Map();
      for (const n of Array.from(body.children)) {
        if (n.classList.contains('ns-sec') && n.dataset.k && !old.has(n.dataset.k)) old.set(n.dataset.k, n); else n.remove();
      }
      let prev = null;
      for (const it of items) {
        let n = old.get(it.key);
        if (n) {
          old.delete(it.key);
          if (n.dataset.s !== it.sig) { n.innerHTML = it.html; n.dataset.s = it.sig; }
        } else {
          n = document.createElement('div');
          n.className = 'ns-sec';
          n.dataset.k = it.key;
          n.dataset.s = it.sig;
          n.innerHTML = it.html;
        }
        const want = prev ? prev.nextSibling : body.firstChild;
        if (want !== n) body.insertBefore(n, want);
        prev = n;
      }
      for (const n of old.values()) n.remove();
    }
    async function paintPane(p, sc, dir, force) {
      const capOn = !!(cap && cap.capture);
      if (!capOn && !store.size) return blank(p, t('net.capOff'));
      if (sc.id < 0) return blank(p, sc.row && sc.row.v === 6 && sc.row.flow === undefined ? t('net.ipv6Note') : t('net.noData'));
      const side = store.get(sc.id, dir);
      if (!side) return blank(p, t('net.noData'));
      if (!side.bytes.length) return blank(p, t(side.total ? 'net.olderGone' : 'net.noDirData'));
      const fmt = prefs.format;
      const f = side.flow;
      const sig = `${f.id}|${fmt}|${side.rev}|${p.win[fmt] || 0}`;
      if (sig === p.sig) return undefined;
      if (!force && selecting(p)) return undefined; // seçim yapılırken içerik yerinden oynamasın
      if (p.flow !== f.id || p.mode !== fmt) {
        if (p.flow !== f.id) p.win = {};
        p.body.innerHTML = '';
        p.flow = f.id;
        p.mode = fmt;
        p.stick = true;
      }
      p.sig = sig;
      const job = ++p.job;
      let label = '';
      let skipped = 0;
      if (fmt === 'smart' || fmt === 'html') {
        // Çözümleme eşzamansızdır (sıkıştırma çözme); depo o sırada kayabileceği için anlık kopya üzerinde çalışılır
        const snap = { flow: f, bytes: side.bytes.slice(), base: side.base, total: side.total, fin: side.fin, rst: side.rst, gaps: side.gaps, rev: side.rev,
          segs: side.segs.map((s) => ({ off: s.off, len: s.len, t: s.t, gap: s.gap, cut: s.cut })) };
        let res;
        try { res = await NETSMART.analyze(snap, { proto: f.proto, lport: f.lport, rport: f.rport }); }
        catch (_) { res = { protocol: '', sections: [], skipped: 0 }; }
        if (dead || job !== p.job) return undefined;
        const open = new Set();
        for (const d of p.body.querySelectorAll('.ns-sec')) if (d.querySelector('details[open]')) open.add(d.dataset.k);
        let items = fmt === 'smart' ? NETRENDER.smartItems(res, snap, fmtO, open) : NETRENDER.markupItems(res, snap, fmtO);
        if (!items.length) {
          const tail = snap.bytes.subarray(Math.max(0, snap.bytes.length - WIN.text));
          items = [{ key: 'none', sig: String(snap.rev), html: fmt === 'html'
            ? `<div class="ns-note">${esc(t('net.noMarkup'))}</div><pre class="ns-code">${NETSMART.markupHtml(NETRENDER.textOf(tail))}</pre>`
            : `<pre class="ns-code">${esc(NETRENDER.textOf(tail))}</pre>` }];
        }
        reconcile(p, items);
        label = NETRENDER.protocolLabel(res.protocol);
        skipped = res.skipped || 0;
      } else {
        const max = p.win[fmt] || WIN[fmt];
        let start = Math.max(0, side.bytes.length - max);
        if (fmt === 'hex' && start > 0) start -= Math.min(start, (side.base + start) % 16); // satırlar 16'nın katında başlasın
        const part = side.bytes.subarray(start);
        let top = '';
        if (start > 0 && max < WIN_MAX[fmt]) top = `<button class="btn sm ghost nt-older" data-a="older">${icon('chevronsUp')}${esc(t('net.showOlder'))}</button>`;
        else if (side.base > 0 || start > 0) top = `<div class="ns-note">${esc(t('net.olderGone'))}</div>`;
        p.body.innerHTML = top + (fmt === 'hex'
          ? `<pre class="hexv-body nt-raw">${NETRENDER.hexHtml(part, side.base + start)}</pre>`
          : `<pre class="ns-code nt-raw">${esc(fmt === 'text' ? NETRENDER.textOf(part) : NETRENDER.base64Of(part))}</pre>`);
      }
      const meta = `${FMT.bytes(side.total)}${label ? ` · ${label}` : ''}${side.rst ? ' · RST' : side.fin ? ' · FIN' : ''}`;
      if (p.meta.textContent !== meta) p.meta.textContent = meta;
      const warn = [side.gaps > 0 ? t('net.gaps', { count: FMT.int(side.gaps, LANG) }) : '', skipped > 0 ? t('net.skipped', { size: FMT.bytes(skipped) }) : ''].filter(Boolean).join(' · ');
      p.warn.hidden = !warn;
      if (p.warn.textContent !== warn) p.warn.textContent = warn;
      if (p.stick) p.body.scrollTop = p.body.scrollHeight;
      return undefined;
    }
    function paintStream(force) {
      if (dead) return;
      const sc = scopeFlow();
      paintChrome(sc);
      paintPane(panes.out, sc, 'out', force);
      paintPane(panes.in, sc, 'in', force);
    }
    for (const p of Object.values(panes)) {
      p.stick = true;
      p.body.addEventListener('scroll', () => { p.stick = p.body.scrollHeight - p.body.scrollTop - p.body.clientHeight < 28; }, { passive: true });
      // Resim sonradan yüklenir: en alttaysak altta kal. Yüklenemeyen (yarım / bozuk) resim işaretlenir.
      p.body.addEventListener('load', () => { if (p.stick) p.body.scrollTop = p.body.scrollHeight; }, true);
      p.body.addEventListener('error', (e) => { const fig = e.target.closest && e.target.closest('.ns-img'); if (fig) fig.classList.add('broken'); }, true);
    }
    streamEl.onclick = (e) => {
      const fb = e.target.closest('button[data-f]');
      if (fb) {
        prefs.format = fb.dataset.f;
        for (const q of fb.parentNode.children) q.classList.toggle('on', q === fb);
        paintStream(true);
        return;
      }
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const sec = b.closest('.nt-pane');
      const p = sec ? panes[sec.dataset.dir] : null;
      if (b.dataset.a === 'pause') { paused = !paused; paintPause(); if (!paused) paintStream(true); }
      else if (b.dataset.a === 'clear') {
        autoFlow = null;
        gen++;
        dropped = 0;
        store.clear();
        lastRev = store.rev;
        rebuild();
        paintStream(true);
        syncWatch(true);
      } else if (b.dataset.a === 'copy' && p) {
        const text = p.body.querySelector('.nt-empty') ? '' : p.body.innerText;
        if (text) APP.copy(text, t(sec.dataset.dir === 'out' ? 'net.outTitle' : 'net.inTitle'));
      } else if (b.dataset.a === 'older' && p) {
        const fmt = prefs.format;
        p.win[fmt] = Math.min(WIN_MAX[fmt], (p.win[fmt] || WIN[fmt]) * 4);
        p.stick = false;
        paintStream(true);
      }
    };

    // --- Yoklama -----------------------------------------------------------------
    async function pull() {
      if (pullBusy || !watched || !cap || !cap.capture) return;
      pullBusy = true;
      try {
        for (let round = 0; round < 4; round++) {
          const g = gen;
          const r = await x.query('netstream', { since, max: 262144 });
          if (dead) return;
          if (g !== gen) break;
          if (r.next < since) { since = 0; store.clear(); continue; } // yardımcı yeniden başladı: sıra numaraları sıfırlandı
          clock = Date.now() - r.now;
          agentNow = r.now;
          dropped = r.dropped || 0;
          for (const c of r.chunks || []) store.add(c, c.b64 ? FMT.b64ToBytes(c.b64) : null);
          since = r.next;
          if (!r.more) break;
        }
      } catch (_) { /* yardımcı yeniden başlıyor olabilir; bir sonraki turda yeniden denenir */ }
      finally { pullBusy = false; }
      if (dead) return;
      if (store.rev !== lastRev) { lastRev = store.rev; rebuild(); }
      if (!paused) paintStream(false);
    }
    function paintLive() {
      const on = !!(APP.sys && APP.sys.netCap);
      const s = APP.hist.series(me.key);
      if (on && s) x.netChart(chart, s, 65536); else chart.blank(on ? '—' : t('net.capOff'));
      const p = x.live();
      x.setV(statsEl, 'rx', on && p ? x.fRate(p.netRx) : '—');
      x.setV(statsEl, 'tx', on && p ? x.fRate(p.netTx) : '—');
    }

    paintCap();
    rebuild();
    paintStream(true);
    requestAnimationFrame(() => { if (!dead) paintLive(); });
    loadCap();
    loadConns();
    return {
      tick(n) {
        paintLive();
        if (n % 5 === 0) loadCap();
        if (n % 2 === 0) { loadConns(); syncWatch(false); }
        pull();
      },
      repaint: paintLive,
      destroy() {
        dead = true;
        list.destroy();
        ro.disconnect();
        x.hideTip();
        for (const p of Object.values(panes)) p.job++;
        // Sekmeden çıkınca izleme biter; yardımcıda tutulan akış verisi bırakılır
        if (sawCapture) chain = chain.then(() => x.query('netwatch', { pids: [], reset: true })).catch(() => {});
      },
    };
  }

  return { create };
})();
