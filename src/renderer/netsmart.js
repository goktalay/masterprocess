'use strict';

// "Akıllı" görünümün tanıma katmanı: bir yöndeki baytların ne olduğunu anlar (HTTP iletileri, JSON, resim,
// HTML / XML, form, TLS el sıkışması, DNS, WebSocket çerçeveleri) ve gösterilecek bölümlere ayırır.
// Veriyi değiştirmez: JSON yeniden biçimlenirken değerler ayrıştırılıp yeniden yazılmaz, yalnız girintilenir.
(function (root) {
  const P = typeof module !== 'undefined' && module.exports ? require('./netparse') : root.NETPARSE;
  const { escHtml, latin1, startsWith, isText, decodeText } = P;

  const u16 = (b, p) => (b[p] << 8) | b[p + 1];
  const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const u16le = (b, p) => b[p] | (b[p + 1] << 8);
  const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

  // ---- resim ----

  // Baştaki imzadan resim türü ve boyutu. Tanınmıyorsa null.
  function imageInfo(b) {
    const n = b.length;
    if (n >= 24 && b[0] === 0x89 && startsWith(b, 'PNG\r\n\x1a\n', 1)) return { mime: 'image/png', w: u32(b, 16), h: u32(b, 20) };
    if (n >= 4 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
      let p = 2;
      while (p + 9 < n) {
        if (b[p] !== 0xFF) { p++; continue; }
        const m = b[p + 1];
        if (m === 0xFF) { p++; continue; }
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { mime: 'image/jpeg', w: u16(b, p + 7), h: u16(b, p + 5) };
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
        p += 2 + u16(b, p + 2);
      }
      return { mime: 'image/jpeg', w: 0, h: 0 };
    }
    if (n >= 10 && (startsWith(b, 'GIF87a') || startsWith(b, 'GIF89a'))) return { mime: 'image/gif', w: u16le(b, 6), h: u16le(b, 8) };
    if (n >= 16 && startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) {
      if (n >= 30 && startsWith(b, 'VP8 ', 12)) return { mime: 'image/webp', w: u16le(b, 26) & 0x3FFF, h: u16le(b, 28) & 0x3FFF };
      if (n >= 25 && startsWith(b, 'VP8L', 12)) return { mime: 'image/webp', w: 1 + (((b[22] & 0x3F) << 8) | b[21]), h: 1 + (((b[24] & 0x0F) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6)) };
      if (n >= 30 && startsWith(b, 'VP8X', 12)) return { mime: 'image/webp', w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      return { mime: 'image/webp', w: 0, h: 0 };
    }
    if (n >= 26 && b[0] === 0x42 && b[1] === 0x4D && [12, 40, 52, 56, 108, 124].includes(u32le(b, 14))) {
      return { mime: 'image/bmp', w: u32le(b, 18) | 0, h: Math.abs(u32le(b, 22) | 0) };
    }
    if (n >= 22 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && u16le(b, 4) >= 1 && u16le(b, 4) <= 64 && b[9] === 0) {
      return { mime: 'image/x-icon', w: b[6] || 256, h: b[7] || 256 };
    }
    if (n >= 12 && startsWith(b, 'ftyp', 4) && (startsWith(b, 'avif', 8) || startsWith(b, 'avis', 8))) return { mime: 'image/avif', w: 0, h: 0 };
    return null;
  }

  const MAGIC = [['%PDF-', 'PDF'], ['PK\x03\x04', 'ZIP'], ['\x1f\x8b\x08', 'gzip'], ['\x7fELF', 'ELF'], ['SQLite format 3', 'SQLite'], ['Rar!\x1a', 'RAR'],
    ['7z\xbc\xaf', '7z'], ['OggS', 'Ogg'], ['ID3', 'MP3'], ['fLaC', 'FLAC'], ['wOFF', 'WOFF'], ['wOF2', 'WOFF2'], ['\x00asm', 'WebAssembly'],
    ['\x1a\x45\xdf\xa3', 'Matroska / WebM'], ['MZ', 'PE (exe / dll)'], ['PRI * HTTP/2.0', 'HTTP/2']];
  function magic(b) {
    for (const [sig, name] of MAGIC) if (startsWith(b, sig)) return name;
    if (b.length >= 12 && startsWith(b, 'ftyp', 4)) return 'MP4';
    if (b.length >= 12 && startsWith(b, 'RIFF') && startsWith(b, 'WAVE', 8)) return 'WAV';
    return '';
  }

  // ---- JSON ----

  // 'json' (geçerli; satır başına bir değer de olabilir), 'partial' (JSON gibi başlıyor ama tamamlanmamış / bozuk), null
  function jsonKind(text) {
    const s = text.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
    try { JSON.parse(s); return 'json'; } catch (_) { /* aşağıda */ }
    const lines = s.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length > 1) {
      try { for (const l of lines) JSON.parse(l); return 'json'; } catch (_) { /* aşağıda */ }
    }
    return /^[[{]\s*(?:"|\{|\[|-?\d|true|false|null|\]|\})/.test(s) ? 'partial' : null;
  }

  const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
  const isStop = (c) => isWs(c) || c === 44 || c === 58 || c === 91 || c === 93 || c === 123 || c === 125 || c === 34;

  // JSON metnini girintileyip renklendirir (kaçışlanmış HTML). Belirteçler aynen korunur: büyük sayılar, kaçış
  // dizileri, anahtar sırası değişmez. Bozuk / yarım metinde de çalışır.
  function jsonHtml(text, { max = 400000 } = {}) {
    const n = Math.min(text.length, max);
    const out = [];
    let ind = 0;
    let i = 0;
    const nl = () => '\n' + '  '.repeat(Math.min(ind, 100));
    const span = (cls, s) => `<span class="${cls}">${escHtml(s)}</span>`;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        let j = i + 1;
        while (j < n) {
          const d = text.charCodeAt(j);
          if (d === 92) j += 2;
          else if (d === 34) break;
          else j++;
        }
        const s = text.slice(i, Math.min(j + 1, n));
        i = j + 1;
        let k = i;
        while (k < n && isWs(text.charCodeAt(k))) k++;
        out.push(span(text.charCodeAt(k) === 58 ? 'j-k' : 'j-s', s));
      } else if (c === 123 || c === 91) {
        let k = i + 1;
        while (k < n && isWs(text.charCodeAt(k))) k++;
        if (text.charCodeAt(k) === c + 2) { out.push(span('j-p', text[i] + text[k])); i = k + 1; }
        else { ind++; out.push(span('j-p', text[i]), nl()); i++; }
      } else if (c === 125 || c === 93) {
        ind = Math.max(0, ind - 1);
        out.push(nl(), span('j-p', text[i]));
        i++;
      } else if (c === 44) { out.push(span('j-p', ','), nl()); i++; }
      else if (c === 58) { out.push(span('j-p', ':'), ' '); i++; }
      else if (isWs(c)) {
        if (c === 10 && ind === 0 && out.length && out[out.length - 1] !== '\n') out.push('\n');
        i++;
      } else {
        let j = i;
        while (j < n && !isStop(text.charCodeAt(j))) j++;
        const w = text.slice(i, j);
        i = j;
        out.push(span(/^-?\d/.test(w) ? 'j-n' : w === 'true' || w === 'false' ? 'j-b' : w === 'null' ? 'j-z' : 'j-x', w));
      }
    }
    return out.join('');
  }

  // ---- HTML / XML kaynağı ----

  function markupKind(text, contentType = '') {
    const head = text.slice(0, 1024).trimStart();
    if (/xml/.test(contentType) || /^<\?xml\b/i.test(head)) return 'xml';
    if (/html/.test(contentType) || /^<!doctype\s+html|^<html[\s>]/i.test(head)) return 'html';
    if (/^<[A-Za-z!][^>]*>/.test(head) && /<\/[A-Za-z][\w:.-]*\s*>|\/>/.test(text.slice(0, 65536))) return /^<(?:!doctype|html|head|body|div|span|p|a|ul|ol|table|script|style|h[1-6]|meta|link|form|section|main|nav)\b/i.test(head) ? 'html' : 'xml';
    return null;
  }

  const TAG = /<!--[\s\S]*?(?:-->|$)|<[!?][^>]{0,4000}(?:>|$)|<\/?[A-Za-z][\w:.-]*(?:"[^"]{0,8000}"|'[^']{0,8000}'|[^>"']){0,4000}(?:>|$)/g;
  const ATTR = /([^\s=/"']+)(\s*=\s*)?("[^"]*"?|'[^']*'?|[^\s"'>]+)?/g;

  // İşaretleme kaynağını renklendirir (kaçışlanmış HTML). Yakalanan içerik asla işlenmez; yalnız kaynak olarak gösterilir.
  function markupHtml(text, { max = 400000 } = {}) {
    const src = text.length > max ? text.slice(0, max) : text;
    const out = [];
    let last = 0;
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(src))) {
      const s = m[0];
      if (!s.length) { TAG.lastIndex++; continue; }
      out.push(escHtml(src.slice(last, m.index)));
      last = m.index + s.length;
      if (s.startsWith('<!--')) { out.push(`<span class="m-c">${escHtml(s)}</span>`); continue; }
      if (s[1] === '!' || s[1] === '?') { out.push(`<span class="m-d">${escHtml(s)}</span>`); continue; }
      const r = /^(<\/?)([A-Za-z][\w:.-]*)([\s\S]*?)(\/?>?)$/.exec(s);
      const attrs = r[3].replace(ATTR, (all, a, eq, v) => `<span class="m-a">${escHtml(a)}</span>${eq ? escHtml(eq) : ''}${v ? `<span class="m-v">${escHtml(v)}</span>` : ''}`);
      out.push(`<span class="m-p">${escHtml(r[1])}</span><span class="m-t">${escHtml(r[2])}</span>${attrs}<span class="m-p">${escHtml(r[4])}</span>`);
    }
    out.push(escHtml(src.slice(last)));
    return out.join('');
  }

  // ---- TLS ----

  const TLS_VER = { 0x0300: 'SSL 3.0', 0x0301: 'TLS 1.0', 0x0302: 'TLS 1.1', 0x0303: 'TLS 1.2', 0x0304: 'TLS 1.3' };
  const tlsVer = (v) => TLS_VER[v] || `0x${v.toString(16).padStart(4, '0')}`;
  const isGrease = (v) => (v & 0x0F0F) === 0x0A0A;

  function parseHello(b) {
    const h = { type: b[0] === 1 ? 'client' : 'server', version: tlsVer(u16(b, 4)), sni: '', alpn: [], versions: [], cipher: '', suites: 0 };
    try {
      let q = 4 + 2 + 32;
      q += 1 + b[q];
      if (h.type === 'client') { const cs = u16(b, q); h.suites = cs >> 1; q += 2 + cs; q += 1 + b[q]; }
      else { h.cipher = `0x${u16(b, q).toString(16).padStart(4, '0')}`; q += 3; }
      if (q + 2 > b.length) return h;
      const end = Math.min(b.length, q + 2 + u16(b, q));
      q += 2;
      while (q + 4 <= end) {
        const et = u16(b, q);
        const el = u16(b, q + 2);
        q += 4;
        const d = b.subarray(q, Math.min(end, q + el));
        if (et === 0 && d.length >= 5) h.sni = latin1(d, 5, Math.min(d.length, 5 + u16(d, 3)));
        else if (et === 16 && d.length >= 2) {
          for (let r = 2; r < d.length && h.alpn.length < 16;) { const l = d[r]; h.alpn.push(latin1(d, r + 1, Math.min(d.length, r + 1 + l))); r += 1 + l; }
        } else if (et === 43) {
          if (h.type === 'client') { for (let r = 1; r + 1 < d.length; r += 2) { const v = u16(d, r); if (!isGrease(v)) h.versions.push(tlsVer(v)); } }
          else if (d.length >= 2) h.version = tlsVer(u16(d, 0));
        }
        q += el;
      }
    } catch (_) { /* yarım el sıkışma: eldeki alanlarla */ }
    return h;
  }

  // TLS kayıtlarını sayar; ilk Client / Server Hello'nun açık alanlarını (SNI, ALPN, sürüm) okur. İçerik çözülmez.
  function parseTls(b) {
    if (b.length < 6 || b[0] < 20 || b[0] > 23 || b[1] !== 3 || b[2] > 4) return null;
    const res = { records: 0, handshake: 0, app: 0, alert: 0, ccs: 0, appBytes: 0, hello: null, end: 0, bad: false };
    let p = 0;
    while (p + 5 <= b.length) {
      const type = b[p];
      const len = u16(b, p + 3);
      if (type < 20 || type > 23 || b[p + 1] !== 3 || len > 18432) { res.bad = true; break; }
      const body = b.subarray(p + 5, Math.min(b.length, p + 5 + len));
      if (type === 22) { res.handshake++; if (!res.hello && body.length >= 6 && (body[0] === 1 || body[0] === 2)) res.hello = parseHello(body); }
      else if (type === 23) { res.app++; res.appBytes += len; }
      else if (type === 21) res.alert++;
      else res.ccs++;
      res.records++;
      if (p + 5 + len > b.length) break;
      p += 5 + len;
      res.end = p;
    }
    return res.records ? res : null;
  }

  // ---- DNS ----

  const DNS_TYPE = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 41: 'OPT', 64: 'SVCB', 65: 'HTTPS', 255: 'ANY' };
  const RCODE = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'];

  function dnsName(b, p) {
    const labels = [];
    let next = -1;
    let done = false;
    for (let hops = 0; hops < 128; hops++) {
      if (p >= b.length) return null;
      const l = b[p];
      if (l === 0) { p++; done = true; break; }
      if ((l & 0xC0) === 0xC0) {
        if (p + 1 >= b.length) return null;
        if (next < 0) next = p + 2;
        p = ((l & 0x3F) << 8) | b[p + 1];
        continue;
      }
      if (l > 63 || p + 1 + l > b.length) return null;
      labels.push(latin1(b, p + 1, p + 1 + l));
      p += 1 + l;
    }
    if (!done) return null; // kendine dönen işaretçi zinciri
    return { name: labels.join('.') || '.', next: next < 0 ? p : next };
  }

  function parseDns(bytes, tcp) {
    let b = bytes;
    if (tcp) {
      if (b.length < 14) return null;
      const l = u16(b, 0);
      if (l < 12 || l + 2 > b.length) return null;
      b = b.subarray(2, 2 + l);
    }
    if (b.length < 12) return null;
    const flags = u16(b, 2);
    const qd = u16(b, 4);
    const an = u16(b, 6);
    if (qd > 16 || an > 256 || (!qd && !an) || ((flags >> 11) & 15) > 5) return null;
    const res = { id: u16(b, 0), response: !!(flags & 0x8000), rcode: RCODE[flags & 15] || String(flags & 15), questions: [], answers: [] };
    let p = 12;
    for (let i = 0; i < qd; i++) {
      const nm = dnsName(b, p);
      if (!nm || nm.next + 4 > b.length) return null;
      const ty = u16(b, nm.next);
      res.questions.push({ name: nm.name, type: DNS_TYPE[ty] || String(ty) });
      p = nm.next + 4;
    }
    for (let i = 0; i < an; i++) {
      const nm = dnsName(b, p);
      if (!nm || nm.next + 10 > b.length) break;
      const ty = u16(b, nm.next);
      const ttl = u32(b, nm.next + 4);
      const rl = u16(b, nm.next + 8);
      const d = nm.next + 10;
      if (d + rl > b.length) break;
      let data = `${rl} B`;
      if (ty === 1 && rl === 4) data = `${b[d]}.${b[d + 1]}.${b[d + 2]}.${b[d + 3]}`;
      else if (ty === 28 && rl === 16) { const g = []; for (let k = 0; k < 16; k += 2) g.push(u16(b, d + k).toString(16)); data = g.join(':'); }
      else if (ty === 5 || ty === 2 || ty === 12) { const x = dnsName(b, d); if (x) data = x.name; }
      else if (ty === 15 && rl > 2) { const x = dnsName(b, d + 2); if (x) data = `${u16(b, d)} ${x.name}`; }
      else if (ty === 33 && rl > 6) { const x = dnsName(b, d + 6); if (x) data = `${x.name}:${u16(b, d + 4)}`; }
      else if (ty === 16) { const parts = []; for (let k = d; k < d + rl;) { const l = b[k]; parts.push(latin1(b, k + 1, Math.min(d + rl, k + 1 + l))); k += 1 + l; } data = parts.join(' '); }
      res.answers.push({ name: nm.name, type: DNS_TYPE[ty] || String(ty), ttl, data });
      p = d + rl;
    }
    return res;
  }

  // ---- WebSocket ----

  const WS_OP = { 0: 'continuation', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

  function parseWebSocket(b, { max = 300 } = {}) {
    const frames = [];
    let p = 0;
    let bad = false;
    while (p + 2 <= b.length && frames.length < max) {
      const b0 = b[p];
      const b1 = b[p + 1];
      const op = b0 & 15;
      if ((b0 & 0x30) || !WS_OP[op]) { bad = true; break; }
      let len = b1 & 127;
      let q = p + 2;
      if (len === 126) { if (q + 2 > b.length) break; len = u16(b, q); q += 2; }
      else if (len === 127) {
        if (q + 8 > b.length) break;
        if (u32(b, q) > 0x1FFFFF) { bad = true; break; }
        len = u32(b, q) * 4294967296 + u32(b, q + 4);
        q += 8;
      }
      const masked = !!(b1 & 128);
      if (masked && q + 4 > b.length) break;
      const key = masked ? b.subarray(q, q + 4) : null;
      if (masked) q += 4;
      const have = Math.min(len, b.length - q);
      let payload = b.subarray(q, q + have);
      if (masked) {
        const un = new Uint8Array(Math.min(have, 1 << 20));
        for (let i = 0; i < un.length; i++) un[i] = payload[i] ^ key[i & 3];
        payload = un;
      }
      frames.push({ op: WS_OP[op], fin: !!(b0 & 0x80), compressed: !!(b0 & 0x40), masked, len, payload, complete: have >= len, at: p });
      if (have < len) break;
      p = q + len;
    }
    return { frames, end: p, bad };
  }

  // ---- içerik tanıma ----

  // Bir gövdenin (ya da ham akışın) ne olduğunu belirler.
  function classify(bytes, ctx = {}) {
    const ct = ctx.contentType || '';
    const depth = ctx.depth || 0;
    if (!bytes || !bytes.length) return { kind: 'empty' };
    const img = imageInfo(bytes);
    if (img) return { kind: 'image', mime: img.mime, w: img.w, h: img.h, bytes };
    if (ct.startsWith('multipart/') && ctx.boundary && depth < 2) {
      const parts = P.parseMultipart(bytes, ctx.boundary).map((x) => ({ name: x.name, filename: x.filename, contentType: x.contentType, complete: x.complete,
        size: x.body.length, section: classify(x.body, { contentType: x.contentType, depth: depth + 1 }) }));
      if (parts.length) return { kind: 'multipart', parts };
    }
    if (isText(bytes)) {
      const text = decodeText(bytes, ctx.charset);
      if (/svg/.test(ct) || /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(text.slice(0, 1024))) return { kind: 'xml', text, svg: true };
      const first = text.trimStart()[0];
      if (ct.includes('json') || first === '{' || first === '[') {
        const jk = jsonKind(text);
        if (jk) return { kind: 'json', text, valid: jk === 'json' };
      }
      if (ct === 'application/x-www-form-urlencoded' || (!ct && P.looksForm(text))) return { kind: 'form', pairs: P.parseForm(text.trim()), text };
      const mk = markupKind(text, ct);
      if (mk) return { kind: mk, text };
      return { kind: 'text', text };
    }
    return { kind: 'binary', bytes, magic: magic(bytes) };
  }

  const DNS_PORTS = new Set([53, 5353, 5355]);

  async function httpSection(m, t) {
    const sec = { kind: 'http', msg: m, t, body: { kind: 'empty' } };
    if (m.body && m.body.length) {
      const dec = await P.decompress(m.body, m.encoding);
      if (m.encoding) sec.decoded = { encoding: m.encoding, ok: dec.ok, unsupported: dec.unsupported || '', partial: !!dec.partial, truncated: !!dec.truncated, from: m.body.length, to: dec.bytes.length };
      sec.body = dec.ok ? classify(dec.bytes, { contentType: m.contentType, charset: m.charset, boundary: m.boundary }) : { kind: 'binary', bytes: m.body, magic: '' };
    }
    return sec;
  }

  // Bir akışın bir yönünü bölümlere ayırır.
  // side: createStore().get() çıktısı; ctx: { proto: 'tcp' | 'udp', lport, rport }
  // Dönüş: { protocol, sections, skipped } — skipped: baştaki tanınmayan / kırpılmış bayt sayısı
  async function analyze(side, ctx = {}) {
    const { bytes, segs, base } = side;
    const sections = [];
    if (!bytes.length) return { protocol: '', sections, skipped: 0 };
    const dnsPort = DNS_PORTS.has(ctx.lport) || DNS_PORTS.has(ctx.rport);

    if (ctx.proto === 'udp') {
      // Her datagram ayrı bir ileti
      const list = segs.slice(-200);
      let dns = 0;
      for (const s of list) {
        const d = bytes.subarray(s.off - base, s.off - base + s.len);
        const q = dnsPort ? parseDns(d, false) : null;
        if (q) { dns++; sections.push({ kind: 'dns', dns: q, t: s.t, size: s.len }); }
        else sections.push({ kind: 'datagram', t: s.t, size: s.len, body: classify(d) });
      }
      return { protocol: dns ? 'dns' : 'udp', sections, skipped: 0 };
    }

    const tls = parseTls(bytes);
    if (tls) return { protocol: 'tls', sections: [{ kind: 'tls', tls, t: segs.length ? segs[0].t : 0 }], skipped: 0 };

    // HTTP: baş kırpılmışsa ya da boşluk varsa parça sınırlarından yeniden eşitlenir
    let start = P.httpStartAt(bytes, 0) ? 0 : -1;
    if (start < 0) {
      for (let i = 1; i < segs.length && i < 4096; i++) {
        if (P.httpStartAt(bytes, segs[i].off - base)) { start = segs[i].off - base; break; }
      }
    }
    if (start >= 0) {
      const { messages, end } = P.parseHttp(bytes, { from: start, final: side.fin || side.rst });
      if (messages.length) {
        const shown = messages.slice(-100);
        for (const m of shown) sections.push(await httpSection(m, P.timeAt(segs, base + m.start)));
        const last = messages[messages.length - 1];
        const rest = bytes.subarray(end);
        let protocol = 'http';
        if (rest.length && last.complete) {
          const wsUp = last.upgrade === 'websocket' || (last.type === 'request' && /websocket/i.test(P.header(last.headers, 'upgrade')));
          const ws = wsUp ? parseWebSocket(rest) : null;
          if (ws && ws.frames.length) {
            protocol = 'websocket';
            for (const f of ws.frames) {
              sections.push({ kind: 'ws', frame: f, t: P.timeAt(segs, base + end + f.at),
                body: f.compressed || (f.op !== 'text' && f.op !== 'binary') ? null : classify(f.payload) });
            }
          } else {
            const t2 = parseTls(rest);
            sections.push(t2 ? { kind: 'tls', tls: t2, t: P.timeAt(segs, base + end) } : { kind: 'raw', t: P.timeAt(segs, base + end), size: rest.length, body: classify(rest) });
          }
        }
        return { protocol, sections, skipped: start, more: messages.length - shown.length };
      }
    }

    if (dnsPort) {
      const q = parseDns(bytes, true);
      if (q) return { protocol: 'dns', sections: [{ kind: 'dns', dns: q, t: segs.length ? segs[0].t : 0, size: bytes.length }], skipped: 0 };
    }
    return { protocol: '', sections: [{ kind: 'raw', t: segs.length ? segs[0].t : 0, size: bytes.length, body: classify(bytes) }], skipped: 0 };
  }

  const api = { imageInfo, magic, jsonKind, jsonHtml, markupKind, markupHtml, parseTls, parseDns, parseWebSocket, classify, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NETSMART = api;
})(typeof self !== 'undefined' ? self : this);
