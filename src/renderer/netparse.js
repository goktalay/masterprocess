'use strict';

// Ağ akışı çözümleyicisi: yakalanan baytları akış / yön başına biriktirir ve içeriği tanır (HTTP, JSON, resim,
// HTML / XML, form, çok parçalı gövde, TLS el sıkışması, DNS, WebSocket). Yalnız bellekte çalışır; hiçbir şeyi
// diske yazmaz, hiçbir yere göndermez. Arayüzde window.NETPARSE, testlerde require.
(function (root) {
  const F_SYN = 1, F_FIN = 2, F_RST = 4, F_GAP = 8;
  const MAX_INFLATE = 8 << 20; // açılmış gövde üst sınırı

  // ---- bayt / metin yardımcıları ----

  const EMPTY = new Uint8Array(0);
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // latin1: her bayt bir karakter (başlık satırları ve imza karşılaştırmaları için)
  function latin1(bytes, from = 0, to = bytes.length) {
    let s = '';
    for (let i = from; i < to; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 8192)));
    return s;
  }
  function indexOf(bytes, pat, from = 0, to = bytes.length) {
    const n = pat.length;
    outer: for (let i = from; i + n <= to; i++) {
      for (let k = 0; k < n; k++) if (bytes[i + k] !== pat[k]) continue outer;
      return i;
    }
    return -1;
  }
  const codes = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const startsWith = (bytes, s, at = 0) => {
    if (at + s.length > bytes.length) return false;
    for (let i = 0; i < s.length; i++) if (bytes[at + i] !== s.charCodeAt(i)) return false;
    return true;
  };

  // Okunur metin mi: NUL yok, denetim karakteri oranı düşük, UTF-8 olarak çözülebiliyor (sonu yarım kalmış olabilir)
  function isText(bytes) {
    const n = Math.min(bytes.length, 65536);
    if (!n) return false;
    let ctl = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[i];
      if (b === 0) return false;
      if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 27 && b !== 12) ctl++;
    }
    if (ctl > n * 0.02) return false;
    let hi = 0;
    for (let i = 0; i < n; i++) if (bytes[i] >= 0x80) hi++;
    if (!hi) return true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n), { stream: true });
      return true;
    } catch (_) {
      return hi < n * 0.3; // tek baytlı kod sayfası (latin1 / windows-125x) olabilir
    }
  }
  function decodeText(bytes, charset) {
    const tryDec = (cs, fatal) => { try { return new TextDecoder(cs, { fatal }).decode(bytes); } catch (_) { return null; } };
    const cs = String(charset || '').trim().toLowerCase();
    if (cs && cs !== 'utf-8' && cs !== 'utf8') { const s = tryDec(cs, false); if (s != null) return s; }
    if (bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
      const s = tryDec(bytes[0] === 0xFF ? 'utf-16le' : 'utf-16be', false);
      if (s != null) return s;
    }
    // Sonu yarım kalmış çok baytlı karakter hata sayılmasın
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); } catch (_) { /* aşağıda */ }
    return tryDec('windows-1252', false) || latin1(bytes);
  }
  function toBase64(bytes) {
    if (typeof btoa === 'function') {
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8190) bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 8190)));
      return btoa(bin);
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('base64');
  }

  // ---- akış deposu ----

  // Yardımcıdan gelen parçaları akış ve yön başına tek bir bayt dizisinde biriktirir. Sınır aşılınca en eski
  // baytlar atılır (base > 0); toplam sınır aşılınca en uzun süredir sessiz akış bütünüyle bırakılır.
  function createStore({ maxFlowBytes = 1 << 20, maxTotalBytes = 32 << 20 } = {}) {
    const flows = new Map();
    let total = 0;
    let evicted = 0;
    let rev = 0;
    const newSide = () => ({ buf: new Uint8Array(4096), len: 0, base: 0, total: 0, segs: [], fin: false, rst: false, gaps: 0, rev: 0 });

    function trim(s, keep) {
      const cut = s.len - keep;
      if (cut <= 0) return;
      s.buf.copyWithin(0, cut, s.len);
      s.len -= cut;
      s.base += cut;
      total -= cut;
      let k = 0;
      while (k < s.segs.length && s.segs[k].off + s.segs[k].len <= s.base) k++;
      if (k) s.segs.splice(0, k);
      const first = s.segs[0];
      if (first && first.off < s.base) { first.len -= s.base - first.off; first.off = s.base; first.cut = true; }
    }
    function drop(f) {
      total -= f.in.len + f.out.len;
      flows.delete(f.id);
      evicted++;
    }

    function add(c, data) {
      data = data || EMPTY;
      let f = flows.get(c.flow);
      if (!f) {
        f = { id: c.flow, pid: c.pid, proto: c.proto, v: c.v, local: c.local, lport: c.lport, remote: c.remote, rport: c.rport,
          firstT: c.t, lastT: c.t, in: newSide(), out: newSide() };
        flows.set(c.flow, f);
      }
      f.lastT = c.t;
      const s = c.dir === 'in' ? f.in : f.out;
      const fl = c.f | 0;
      if (fl & F_FIN) s.fin = true;
      if (fl & F_RST) s.rst = true;
      if (fl & F_GAP) s.gaps++;
      s.rev = ++rev;
      if (!data.length) {
        if (fl & F_GAP) s.pendingGap = true; // boşluk işareti bir sonraki veriye taşınır
        return f;
      }
      const need = s.len + data.length;
      if (need > s.buf.length) {
        const nb = new Uint8Array(Math.max(need, Math.min(s.buf.length * 2, maxFlowBytes + (maxFlowBytes >> 2) + data.length)));
        nb.set(s.buf.subarray(0, s.len));
        s.buf = nb;
      }
      s.buf.set(data, s.len);
      s.segs.push({ off: s.base + s.len, len: data.length, t: c.t, gap: !!(fl & F_GAP) || !!s.pendingGap });
      s.pendingGap = false;
      s.len += data.length;
      s.total += data.length;
      total += data.length;
      if (s.len > maxFlowBytes + (maxFlowBytes >> 2)) trim(s, maxFlowBytes);
      while (total > maxTotalBytes && flows.size > 1) {
        let old = null;
        for (const x of flows.values()) if (x !== f && (!old || x.lastT < old.lastT)) old = x;
        if (!old) break;
        drop(old);
      }
      return f;
    }

    // Bir akışın bir yönü: bytes (kopya değil; bir sonraki add() ile değişebilir), base = baştan atılan bayt sayısı
    function get(id, dir) {
      const f = flows.get(id);
      if (!f) return null;
      const s = dir === 'in' ? f.in : f.out;
      return { flow: f, bytes: s.buf.subarray(0, s.len), base: s.base, total: s.total, segs: s.segs, fin: s.fin, rst: s.rst, gaps: s.gaps, rev: s.rev };
    }
    return {
      add, get,
      flow: (id) => flows.get(id) || null,
      flows: () => Array.from(flows.values()),
      clear() { flows.clear(); total = 0; rev++; },
      get size() { return flows.size; },
      get bytes() { return total; },
      get evicted() { return evicted; },
      get rev() { return rev; },
    };
  }

  // Bir ofsetin ait olduğu parçanın zamanı (yardımcının tekdüze saati, ms)
  function timeAt(segs, off) {
    let lo = 0, hi = segs.length - 1, t = segs.length ? segs[0].t : 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].off <= off) { t = segs[m].t; lo = m + 1; } else hi = m - 1;
    }
    return t;
  }

  // ---- HTTP/1.x ----

  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK', 'REPORT', 'SEARCH', 'PURGE', 'M-SEARCH', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE'];
  const CRLF2 = [13, 10, 13, 10];
  const MAX_HEAD = 65536;

  function httpStartAt(bytes, at) {
    if (startsWith(bytes, 'HTTP/1.', at)) return 'response';
    const b = bytes[at];
    if (!(b >= 65 && b <= 90)) return null;
    for (const m of METHODS) if (startsWith(bytes, m + ' ', at)) return 'request';
    return null;
  }
  const header = (headers, name) => { const h = headers.find((x) => x[0].toLowerCase() === name); return h ? h[1] : ''; };

  // "aktarım kodlaması: parçalı" gövdeyi çözer. end = gövdenin bittiği ofset (tamamlanmadıysa eldeki verinin sonu)
  function decodeChunked(bytes, from = 0) {
    const parts = [];
    let size = 0;
    let p = from;
    for (;;) {
      const eol = indexOf(bytes, [13, 10], p, Math.min(bytes.length, p + 1024));
      if (eol < 0) return { body: join(parts, size), end: bytes.length, complete: false, bad: bytes.length - p >= 1024 };
      const line = latin1(bytes, p, eol).split(';')[0].trim();
      if (!/^[0-9a-fA-F]{1,8}$/.test(line)) return { body: join(parts, size), end: p, complete: false, bad: true };
      const n = parseInt(line, 16);
      p = eol + 2;
      if (n === 0) {
        // İsteğe bağlı son başlıklar, ardından boş satır
        for (;;) {
          const e = indexOf(bytes, [13, 10], p, Math.min(bytes.length, p + 8192));
          if (e < 0) return { body: join(parts, size), end: bytes.length, complete: false };
          const empty = e === p;
          p = e + 2;
          if (empty) return { body: join(parts, size), end: p, complete: true };
        }
      }
      const have = Math.min(n, bytes.length - p);
      if (have > 0) { parts.push(bytes.subarray(p, p + have)); size += have; }
      if (have < n || p + n + 2 > bytes.length) return { body: join(parts, size), end: bytes.length, complete: false };
      p += n + 2;
    }
  }
  function join(parts, size) {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(size);
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }

  // Bir yöndeki bayt akışından ardışık HTTP iletilerini çıkarır.
  // final: bağlantı bu yönde kapandı mı ("bağlantı kapanana dek" süren gövdeler için).
  // Dönüş: { messages, end } — end: son iletinin bittiği ofset (ardından gelen veri HTTP değil ya da henüz eksik).
  function parseHttp(bytes, { from = 0, final = false, max = 200 } = {}) {
    const messages = [];
    let p = from;
    while (p < bytes.length && messages.length < max) {
      const type = httpStartAt(bytes, p);
      if (!type) break;
      const headEnd = indexOf(bytes, CRLF2, p, Math.min(bytes.length, p + MAX_HEAD));
      if (headEnd < 0) {
        if (bytes.length - p >= MAX_HEAD) break;
        // Başlıklar henüz tamamlanmadı: eldeki satırlarla yarım ileti
        const m = parseHead(latin1(bytes, p, bytes.length), type);
        if (!m) break;
        messages.push(Object.assign(m, { start: p, end: bytes.length, body: EMPTY, complete: false, headOnly: true }));
        p = bytes.length;
        break;
      }
      const m = parseHead(latin1(bytes, p, headEnd), type);
      if (!m) break;
      const bodyAt = headEnd + 4;
      m.start = p;
      m.contentType = header(m.headers, 'content-type').split(';')[0].trim().toLowerCase();
      const cs = /charset\s*=\s*"?([^";\s]+)/i.exec(header(m.headers, 'content-type'));
      m.charset = cs ? cs[1] : '';
      const bd = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(header(m.headers, 'content-type'));
      m.boundary = bd ? (bd[1] || bd[2]) : '';
      m.encoding = header(m.headers, 'content-encoding').trim().toLowerCase();
      m.chunked = /\bchunked\b/i.test(header(m.headers, 'transfer-encoding'));
      const cl = header(m.headers, 'content-length').trim();
      m.length = /^\d{1,15}$/.test(cl) ? Number(cl) : -1;
      const noBody = type === 'response' && (m.status < 200 || m.status === 204 || m.status === 304);
      if (noBody) {
        m.body = EMPTY; m.complete = true; m.end = bodyAt;
        if (m.status === 101) { m.upgrade = header(m.headers, 'upgrade').toLowerCase(); messages.push(m); p = bodyAt; break; }
      } else if (m.chunked) {
        const c = decodeChunked(bytes, bodyAt);
        m.body = c.body; m.complete = c.complete; m.end = c.end;
        if (c.bad) m.malformed = true;
      } else if (m.length >= 0) {
        // HEAD yanıtı: uzunluk bildirir ama gövde taşımaz; ardından doğrudan yeni bir yanıt başlıyorsa gövde yok say
        if (type === 'response' && m.length > 0 && httpStartAt(bytes, bodyAt) === 'response') { m.body = EMPTY; m.complete = true; m.end = bodyAt; m.headReply = true; }
        else {
          const have = Math.min(m.length, bytes.length - bodyAt);
          m.body = bytes.subarray(bodyAt, bodyAt + have);
          m.complete = have >= m.length;
          m.end = bodyAt + have;
        }
      } else if (type === 'request') {
        m.body = EMPTY; m.complete = true; m.end = bodyAt;
        if (m.method === 'CONNECT') { messages.push(m); p = bodyAt; break; } // ardından tünel verisi gelir
      } else {
        m.body = bytes.subarray(bodyAt); m.complete = !!final; m.end = bytes.length; m.untilClose = true;
      }
      messages.push(m);
      p = m.end;
      if (!m.complete) break;
    }
    return { messages, end: p };
  }

  function parseHead(text, type) {
    const lines = text.split('\r\n');
    const m = { type, headers: [] };
    if (type === 'response') {
      const r = /^HTTP\/(1\.[01]) (\d{3})(?: (.*))?$/.exec(lines[0]);
      if (!r) return null;
      m.version = r[1]; m.status = Number(r[2]); m.reason = r[3] || '';
    } else {
      const r = /^([A-Z-]+) (\S+) HTTP\/(1\.[01])$/.exec(lines[0]);
      if (!r) return null;
      m.method = r[1]; m.target = r[2]; m.version = r[3];
    }
    for (let i = 1; i < lines.length; i++) {
      const k = lines[i].indexOf(':');
      if (k <= 0) continue;
      m.headers.push([lines[i].slice(0, k).trim(), lines[i].slice(k + 1).trim()]);
    }
    return m;
  }

  // gzip / deflate gövdeyi açar. Yarım kalmış ya da bozuk veride o ana dek açılabilen kısım döner (partial).
  // br ve zstd açılamaz (tarayıcı akış API'sinde yok): unsupported.
  async function decompress(bytes, encoding) {
    const enc = String(encoding || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => x && x !== 'identity');
    if (!enc.length) return { bytes, ok: true };
    if (enc.length > 1 || !['gzip', 'x-gzip', 'deflate'].includes(enc[0])) return { bytes, ok: false, unsupported: enc.join(', ') };
    if (typeof DecompressionStream !== 'function') return { bytes, ok: false, unsupported: enc[0] };
    const run = async (format) => {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(bytes).catch(() => {});
      writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      const parts = [];
      let size = 0;
      let partial = false;
      let truncated = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          size += value.length;
          if (size > MAX_INFLATE) { truncated = true; reader.cancel().catch(() => {}); break; }
        }
      } catch (_) { partial = true; }
      return { bytes: join(parts, size), ok: true, partial, truncated, size };
    };
    if (enc[0] !== 'deflate') return run('gzip');
    // "deflate" çoğunlukla zlib sarmalıdır; bazı sunucular ham deflate yollar
    const z = await run('deflate');
    if (z.size || !z.partial) return z;
    return run('deflate-raw');
  }

  // application/x-www-form-urlencoded → [[ad, değer]]
  function parseForm(text) {
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; } };
    const out = [];
    for (const part of String(text).split('&')) {
      if (!part) continue;
      const k = part.indexOf('=');
      out.push(k < 0 ? [dec(part), ''] : [dec(part.slice(0, k)), dec(part.slice(k + 1))]);
    }
    return out;
  }
  const looksForm = (text) => text.length < 65536 && /^[\w.%+~\-[\]]+=[^&\s]*(?:&[\w.%+~\-[\]]+=[^&\s]*)*$/.test(text.trim());

  // multipart/form-data → parçalar (dosya yüklemeleri: giden resimler çoğunlukla böyle taşınır)
  function parseMultipart(bytes, boundary) {
    const parts = [];
    const delim = codes('--' + boundary);
    let p = indexOf(bytes, delim, 0);
    while (p >= 0 && parts.length < 64) {
      let q = p + delim.length;
      if (bytes[q] === 45 && bytes[q + 1] === 45) break; // kapanış sınırı
      if (bytes[q] === 13) q += 2;
      const headEnd = indexOf(bytes, CRLF2, q, Math.min(bytes.length, q + 16384));
      if (headEnd < 0) break;
      const headers = [];
      for (const line of latin1(bytes, q, headEnd).split('\r\n')) {
        const k = line.indexOf(':');
        if (k > 0) headers.push([line.slice(0, k).trim(), line.slice(k + 1).trim()]);
      }
      const next = indexOf(bytes, delim, headEnd + 4);
      const end = next < 0 ? bytes.length : Math.max(headEnd + 4, next - 2);
      const disp = header(headers, 'content-disposition');
      const nm = /\bname="([^"]*)"/i.exec(disp);
      const fn = /\bfilename="([^"]*)"/i.exec(disp);
      parts.push({ headers, name: nm ? nm[1] : '', filename: fn ? fn[1] : '', contentType: header(headers, 'content-type').split(';')[0].trim().toLowerCase(),
        body: bytes.subarray(headEnd + 4, end), complete: next >= 0 });
      p = next;
    }
    return parts;
  }

  const core = { F_SYN, F_FIN, F_RST, F_GAP, EMPTY, escHtml, latin1, indexOf, codes, startsWith, isText, decodeText, toBase64, join, header,
    createStore, timeAt, httpStartAt, parseHttp, decodeChunked, decompress, parseForm, looksForm, parseMultipart };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.NETPARSE = core;
})(typeof self !== 'undefined' ? self : this);
