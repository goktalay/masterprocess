'use strict';

// Süreç ağacı: anlık görüntü satırlarından (snapshot.cols + snapshot.procs) ebeveyn-çocuk ağacı kurar, sıralar,
// daraltılmış dalları gizleyerek tabloya dizilecek düz satır listesini üretir. Hem ana süreçte (testler) hem
// arayüzde (window.TREE) kullanılır.
(function (root) {
  // Bir süreci yaşamı boyunca tanımlayan anahtar: PID yeniden kullanılabildiği için başlangıç zamanıyla birlikte.
  const keyOf = (p) => `${p.pid}:${p.start || 0}`;

  // snapshot.procs satırlarını (dizi) alan adlı nesnelere çevirir.
  function rowsToObjects(cols, rows) {
    const out = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const o = {};
      for (let c = 0; c < cols.length; c++) o[cols[c]] = r[c];
      o.key = keyOf(o);
      o.io = (o.ioRead || 0) + (o.ioWrite || 0);
      o.net = (o.netRx || 0) + (o.netTx || 0);
      out[i] = o;
    }
    return out;
  }

  // Ebeveyni listede olmayan (ya da kendisine/çevrime işaret eden) süreçler kök sayılır.
  function buildTree(procs) {
    const byPid = new Map();
    for (const p of procs) byPid.set(p.pid, { p, children: [], parent: null });
    const roots = [];
    for (const n of byPid.values()) {
      const par = n.p.ppid && n.p.ppid !== n.p.pid ? byPid.get(n.p.ppid) : null;
      // Çevrim koruması: ata zincirinde kendisi varsa kök yap
      let ok = !!par;
      for (let a = par, i = 0; ok && a; a = a.parent, i++) if (a === n || i > 4096) ok = false;
      if (ok) { n.parent = par; par.children.push(n); } else roots.push(n);
    }
    return { roots, byPid };
  }

  function comparator(key, dir) {
    const d = dir < 0 ? -1 : 1;
    if (key === 'name') {
      return (a, b) => d * String(a.p.name || '').localeCompare(String(b.p.name || ''), undefined, { sensitivity: 'base' }) || a.p.pid - b.p.pid;
    }
    return (a, b) => d * ((a.p[key] || 0) - (b.p[key] || 0)) || a.p.pid - b.p.pid;
  }

  // Yük sütunları: ağaç görünümünde bir dal, alt süreçleriyle birlikte toplam yüküne göre sıralanır.
  const SUM_KEYS = new Set(['cpu', 'ws', 'priv', 'io', 'net', 'gpu', 'threads', 'handles']);

  // Her düğümün alt ağaç toplamı (kendisi dahil), tek geçişte. Dönen: Map(düğüm → toplam).
  function subtreeTotals(roots, key) {
    const totals = new Map();
    const walk = (n, depth) => {
      let s = n.p[key] || 0;
      if (depth <= 4096) for (const c of n.children) s += walk(c, depth + 1);
      totals.set(n, s);
      return s;
    };
    for (const r of roots) walk(r, 0);
    return totals;
  }

  // Ağaç görünümü: kardeşler kendi aralarında sıralanır; yük sütunlarında (SUM_KEYS) ölçü dalın toplamıdır, böylece
  // en yüklü ana süreç — yükü alt süreçlerinden gelse bile — üste çıkar. Ad, PID ve başlangıç düğümün kendi değeriyle
  // sıralanır. collapsed: daraltılmış düğüm anahtarları (Set).
  // Çıkış satırı: { p, depth, hasChildren, collapsed, guides } — guides: her derinlikte dikey kılavuz çizgisi sürüyor mu.
  function flattenTree(roots, { sortKey = 'name', sortDir = 1, collapsed = new Set() } = {}) {
    let cmp = comparator(sortKey, sortDir);
    if (SUM_KEYS.has(sortKey)) {
      const totals = subtreeTotals(roots, sortKey);
      const d = sortDir < 0 ? -1 : 1;
      cmp = (a, b) => d * ((totals.get(a) || 0) - (totals.get(b) || 0)) || a.p.pid - b.p.pid;
    }
    const out = [];
    const walk = (nodes, depth, guides) => {
      const list = nodes.slice().sort(cmp);
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const last = i === list.length - 1;
        const isCollapsed = n.children.length > 0 && collapsed.has(n.p.key);
        out.push({ p: n.p, depth, hasChildren: n.children.length > 0, collapsed: isCollapsed, last, guides });
        if (n.children.length && !isCollapsed) walk(n.children, depth + 1, guides.concat(!last));
      }
    };
    walk(roots, 0, []);
    return out;
  }

  // Düz liste görünümü: ağaç yok, tüm süreçler tek düzeyde sıralanır.
  function flattenList(procs, { sortKey = 'cpu', sortDir = -1 } = {}) {
    const cmp = comparator(sortKey, sortDir);
    return procs.map((p) => ({ p })).sort(cmp).map((n) => ({ p: n.p, depth: 0, hasChildren: false, collapsed: false, last: false, guides: [] }));
  }

  // Arama: ad ya da PID eşleşen süreçler. Ağaç görünümünde eşleşenlerin ataları da (bağlam için) tutulur.
  function filterProcs(procs, query, { keepAncestors = false } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { procs, matched: null };
    const matched = new Set();
    for (const p of procs) {
      if (String(p.name || '').toLowerCase().includes(q) || String(p.pid) === q || String(p.pid).startsWith(q)) matched.add(p.pid);
    }
    if (!keepAncestors) return { procs: procs.filter((p) => matched.has(p.pid)), matched };
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const keep = new Set(matched);
    for (const pid of matched) {
      let p = byPid.get(pid);
      for (let i = 0; p && p.ppid && i < 4096; i++) {
        p = byPid.get(p.ppid);
        if (!p || keep.has(p.pid)) break;
        keep.add(p.pid);
      }
    }
    return { procs: procs.filter((p) => keep.has(p.pid)), matched };
  }

  // Bir sürecin tüm torunları, yapraktan köke doğru (ağacı sonlandırırken önce çocuklar). Kök dahil.
  function subtreePids(byPid, pid) {
    const out = [];
    const walk = (n, depth) => {
      if (!n || depth > 4096) return;
      for (const c of n.children) walk(c, depth + 1);
      out.push(n.p.pid);
    };
    walk(byPid.get(pid), 0);
    return out;
  }

  // Alt ağaç toplamı (daraltılmış dalın toplam CPU / bellek değerini göstermek için). Kök dahil.
  function subtreeSum(node, fields) {
    const sum = {};
    for (const f of fields) sum[f] = 0;
    let count = 0;
    const walk = (n, depth) => {
      if (depth > 4096) return;
      count++;
      for (const f of fields) sum[f] += n.p[f] || 0;
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(node, 0);
    sum.count = count;
    return sum;
  }

  const api = { keyOf, rowsToObjects, buildTree, flattenTree, flattenList, filterProcs, subtreePids, subtreeSum, subtreeTotals, SUM_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TREE = api;
})(typeof self !== 'undefined' ? self : this);
