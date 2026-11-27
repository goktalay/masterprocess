'use strict';

// Örnek tarihçesi: süreç başına ve sistem geneli için sabit boyutlu halka tamponlar (CPU %, bellek, G/Ç, GPU %, ağ).
// Ana süreçte tutulur (pencere kapansa da birikir); arayüz açılışta tümünü alır (dump → load), sonra her anlık
// görüntüyü kendi kopyasına ekler. Süreç başlama/bitme olaylarını da buradan üretir.
(function (root) {
  const METRICS = ['cpu', 'ws', 'io', 'gpu', 'net', 'netRx', 'netTx'];
  const SYS_METRICS = ['cpu', 'mem', 'io', 'gpu', 'net', 'netRx', 'netTx'];

  function ring(capacity) {
    return { buf: new Float32Array(capacity), n: 0, head: 0 };
  }
  function ringPush(r, v) {
    r.buf[r.head] = v;
    r.head = (r.head + 1) % r.buf.length;
    if (r.n < r.buf.length) r.n++;
  }
  // En eskiden en yeniye, yeni bir Float32Array
  function ringValues(r) {
    const out = new Float32Array(r.n);
    const cap = r.buf.length;
    const start = (r.head - r.n + cap) % cap;
    for (let i = 0; i < r.n; i++) out[i] = r.buf[(start + i) % cap];
    return out;
  }
  function ringFrom(values, capacity) {
    const r = ring(capacity);
    const src = values.length > capacity ? values.slice(values.length - capacity) : values;
    for (let i = 0; i < src.length; i++) ringPush(r, src[i]);
    return r;
  }

  function createHistory({ capacity = 300 } = {}) {
    const procs = new Map(); // anahtar (pid:start) → { pid, name, start, first, last, peakCpu, peakWs, sumCpu, samples, r: {cpu, ws, io, gpu} }
    const sys = {};
    for (const m of SYS_METRICS) sys[m] = ring(capacity);
    const times = { buf: new Float64Array(capacity), n: 0, head: 0 };
    let primed = false;

    function sysSample(s) {
      const memUsed = s.memTotal ? ((s.memTotal - s.memAvail) / s.memTotal) * 100 : 0;
      return {
        cpu: s.cpu || 0, mem: memUsed, io: (s.ioRead || 0) + (s.ioWrite || 0), gpu: s.gpu || 0,
        net: (s.netRx || 0) + (s.netTx || 0), netRx: s.netRx || 0, netTx: s.netTx || 0,
      };
    }

    // snap: { t, sys, procs: [{ key, pid, name, start, cpu, ws, io, gpu, net, netRx, netTx, ... }] }
    // Dönen: { started: [...], exited: [...] } — ilk çağrıda ikisi de boştur (o an çalışanlar "başladı" sayılmaz).
    function push(snap) {
      const t = snap.t || Date.now();
      times.buf[times.head] = t;
      times.head = (times.head + 1) % capacity;
      if (times.n < capacity) times.n++;
      const ss = sysSample(snap.sys || {});
      for (const m of SYS_METRICS) ringPush(sys[m], ss[m]);

      const started = [];
      const exited = [];
      const seen = new Set();
      for (const p of snap.procs) {
        seen.add(p.key);
        let h = procs.get(p.key);
        if (!h) {
          h = { pid: p.pid, name: p.name, start: p.start || 0, first: t, last: t, peakCpu: 0, peakWs: 0, sumCpu: 0, samples: 0, r: {} };
          for (const m of METRICS) h.r[m] = ring(capacity);
          procs.set(p.key, h);
          if (primed) started.push({ pid: p.pid, name: p.name, start: p.start || 0, ppid: p.ppid || 0, t });
        }
        h.last = t;
        h.name = p.name;
        h.samples++;
        h.sumCpu += p.cpu || 0;
        if ((p.cpu || 0) > h.peakCpu) h.peakCpu = p.cpu || 0;
        if ((p.ws || 0) > h.peakWs) h.peakWs = p.ws || 0;
        for (const m of METRICS) ringPush(h.r[m], p[m] || 0);
      }
      for (const [key, h] of procs) {
        if (seen.has(key)) continue;
        procs.delete(key);
        exited.push({
          pid: h.pid, name: h.name, start: h.start, t,
          // Başlangıcı bilinen süreçte gerçek ömür; bilinmiyorsa gözlemlenen süre
          lifeMs: h.start ? Math.max(0, t - h.start) : Math.max(0, h.last - h.first),
          peakCpu: Math.round(h.peakCpu * 10) / 10, peakWs: h.peakWs,
          avgCpu: h.samples ? Math.round((h.sumCpu / h.samples) * 10) / 10 : 0,
        });
      }
      primed = true;
      return { started, exited };
    }

    // Süreç serisi: son n örnek, sistem zaman ekseninin son n noktasıyla hizalıdır.
    function series(key) {
      const h = procs.get(key);
      if (!h) return null;
      const out = { n: h.r.cpu.n, peakCpu: h.peakCpu, peakWs: h.peakWs };
      for (const m of METRICS) out[m] = ringValues(h.r[m]);
      return out;
    }
    // Tablo sparkline'ı için: halkayı kopyalamadan son `count` değeri verilen diziye yazar, yazılan adedi döner.
    function tail(key, metric, out) {
      const h = procs.get(key);
      if (!h) return 0;
      const r = h.r[metric];
      const n = Math.min(r.n, out.length);
      const cap = r.buf.length;
      const start = (r.head - n + cap) % cap;
      for (let i = 0; i < n; i++) out[i] = r.buf[(start + i) % cap];
      return n;
    }
    function sysSeries() {
      const out = { n: sys.cpu.n, t: timeValues() };
      for (const m of SYS_METRICS) out[m] = ringValues(sys[m]);
      return out;
    }
    function timeValues() {
      const out = new Float64Array(times.n);
      const start = (times.head - times.n + capacity) % capacity;
      for (let i = 0; i < times.n; i++) out[i] = times.buf[(start + i) % capacity];
      return out;
    }

    // Tüm tarihçenin yapısal kopyası (ana süreç → arayüz, tek sefer)
    function dump() {
      const p = {};
      for (const [key, h] of procs) {
        const o = { pid: h.pid, name: h.name, start: h.start, first: h.first, last: h.last, peakCpu: h.peakCpu, peakWs: h.peakWs, sumCpu: h.sumCpu, samples: h.samples };
        for (const m of METRICS) o[m] = ringValues(h.r[m]);
        p[key] = o;
      }
      const s = {};
      for (const m of SYS_METRICS) s[m] = ringValues(sys[m]);
      return { capacity, t: timeValues(), sys: s, procs: p, primed };
    }
    function load(d) {
      if (!d || !d.procs) return;
      procs.clear();
      const tv = d.t || [];
      times.n = 0; times.head = 0;
      const tsrc = tv.length > capacity ? tv.slice(tv.length - capacity) : tv;
      for (let i = 0; i < tsrc.length; i++) { times.buf[times.head] = tsrc[i]; times.head = (times.head + 1) % capacity; times.n++; }
      const slen = ((d.sys && d.sys.cpu) || []).length;
      for (const m of SYS_METRICS) sys[m] = ringFrom((d.sys && d.sys[m]) || new Float32Array(slen), capacity);
      for (const key of Object.keys(d.procs)) {
        const o = d.procs[key];
        const h = { pid: o.pid, name: o.name, start: o.start, first: o.first, last: o.last, peakCpu: o.peakCpu || 0, peakWs: o.peakWs || 0, sumCpu: o.sumCpu || 0, samples: o.samples || 0, r: {} };
        // Eski bir dökümde bulunmayan seri (ör. ağ) diğerleriyle aynı uzunlukta sıfırla doldurulur: seriler hizalı kalır
        const len = (o.cpu || []).length;
        for (const m of METRICS) h.r[m] = ringFrom(o[m] || new Float32Array(len), capacity);
        procs.set(key, h);
      }
      primed = !!d.primed;
    }

    return { push, series, tail, sysSeries, dump, load, size: () => procs.size, has: (key) => procs.has(key), capacity };
  }

  const api = { createHistory, METRICS, SYS_METRICS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HISTORY = api;
})(typeof self !== 'undefined' ? self : this);
