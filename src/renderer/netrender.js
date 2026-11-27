'use strict';

// Ağ sekmesinin çizim katmanı: yakalanan baytları ve "akıllı" çözümlemenin (netsmart.js) bölümlerini HTML'e
// çevirir. Saf fonksiyonlardır; DOM'a dokunmaz. Yakalanan içerik her zaman kaçışlanır: HTML / SVG yalnız kaynak
// olarak gösterilir, asla işlenmez. Resimler yalnız bilinen raster türlerinde data: adresiyle önizlenir.
(function (root) {
  const node = typeof module !== 'undefined' && module.exports;
  const P = node ? require('./netparse') : root.NETPARSE;
  const S = node ? require('./netsmart') : root.NETSMART;
  const esc = P.escHtml;

  const HEXD = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  const IMG_MAX = 4 << 20;       // önizlenen en büyük resim
  const TEXT_MAX = 400000;       // tek gövdede gösterilen en çok karakter
  const HEX_PEEK = 256;          // ikili gövdelerde gösterilen ilk bayt sayısı

  // 16 bayt / satır hex dökümü; base: ilk baytın akıştaki konumu
  function hexHtml(bytes, base = 0) {
    const out = [];
    for (let r = 0; r < bytes.length; r += 16) {
      let hx = '';
      let asc = '';
      for (let i = 0; i < 16; i++) {
        const k = r + i;
        if (k >= bytes.length) { hx += '   '; asc += ' '; }
        else {
          const b = bytes[k];
          hx += b === 0 ? `<i>${HEXD[b]}</i> ` : HEXD[b] + ' ';
          asc += b >= 32 && b < 127 ? (b === 60 ? '&lt;' : b === 62 ? '&gt;' : b === 38 ? '&amp;' : String.fromCharCode(b)) : '<i>.</i>';
        }
        if (i === 7) hx += ' ';
      }
      out.push(`<span class="hx-a">${(base + r).toString(16).padStart(8, '0')}</span>  ${hx} <span class="hx-t">${asc}</span>`);
    }
    return out.join('\n');
  }
  function hexText(bytes, base = 0) {
    const out = [];
    for (let r = 0; r < bytes.length; r += 16) {
      let hx = '';
      let asc = '';
      for (let i = 0; i < 16; i++) {
        const k = r + i;
        if (k >= bytes.length) { hx += '   '; }
        else { const b = bytes[k]; hx += HEXD[b] + ' '; asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'; }
        if (i === 7) hx += ' ';
      }
      out.push(`${(base + r).toString(16).padStart(8, '0')}  ${hx} ${asc}`);
    }
    return out.join('\n');
  }

  // Metin görünümü: UTF-8 (olmazsa Windows-1252) çözülür; satır sonu ve sekme dışındaki denetim karakterleri "·" olur
  function textOf(bytes) {
    // eslint-disable-next-line no-control-regex
    return P.decodeText(bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '·');
  }
  function base64Of(bytes) {
    const s = P.toBase64(bytes);
    const out = [];
    for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
    return out.join('\n');
  }

  const clip = (text) => (text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text);

  // o: { t (çeviri), bytes(n) → "1,2 KB", time(agentMs) → "12:01:02" }
  function bodyHtml(body, o, depth = 0) {
    if (!body || body.kind === 'empty') return '';
    const { t } = o;
    switch (body.kind) {
      case 'image': {
        const cap = `${esc(body.mime.replace('image/', '').toUpperCase())}${body.w && body.h ? ` · ${body.w} × ${body.h}` : ''} · ${esc(o.bytes(body.bytes.length))}`;
        if (body.bytes.length > IMG_MAX) return `<div class="ns-note">${esc(t('net.imgTooBig'))} — ${cap}</div>`;
        return `<figure class="ns-img"><img alt="" src="data:${esc(body.mime)};base64,${P.toBase64(body.bytes)}"><figcaption><span class="badge acc">${esc(t('net.kind.image'))}</span> ${cap}<span class="ns-broken"> · ${esc(t('net.imgPartial'))}</span></figcaption></figure>`;
      }
      case 'json':
        return `<div class="ns-tag"><span class="badge acc">JSON</span>${body.valid ? '' : ` <span class="badge warn">${esc(t('net.partial'))}</span>`}</div><pre class="ns-code">${S.jsonHtml(clip(body.text))}</pre>${more(body.text, o)}`;
      case 'html':
      case 'xml':
        return `<div class="ns-tag"><span class="badge acc">${body.svg ? 'SVG' : body.kind.toUpperCase()}</span> <span class="ns-dim">${esc(t('net.sourceOnly'))}</span></div><pre class="ns-code">${S.markupHtml(clip(body.text))}</pre>${more(body.text, o)}`;
      case 'form':
        return `<div class="ns-tag"><span class="badge acc">${esc(t('net.kind.form'))}</span></div><dl class="ns-kv">${body.pairs.slice(0, 500).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
      case 'multipart':
        return `<div class="ns-tag"><span class="badge acc">${esc(t('net.kind.multipart'))}</span> <span class="ns-dim">${esc(t('net.parts', { count: body.parts.length }))}</span></div>`
          + body.parts.map((p) => `<div class="ns-part"><div class="ns-part-h"><b>${esc(p.name || '—')}</b>${p.filename ? ` <span class="mono">${esc(p.filename)}</span>` : ''}${p.contentType ? ` <span class="ns-dim">${esc(p.contentType)}</span>` : ''} <span class="ns-dim">${esc(o.bytes(p.size))}</span>${p.complete ? '' : ` <span class="badge warn">${esc(t('net.partial'))}</span>`}</div>${depth < 3 ? bodyHtml(p.section, o, depth + 1) : ''}</div>`).join('');
      case 'text':
        return `<pre class="ns-code">${esc(clip(body.text))}</pre>${more(body.text, o)}`;
      case 'binary': {
        const n = Math.min(HEX_PEEK, body.bytes.length);
        return `<div class="ns-tag"><span class="badge">${esc(body.magic || t('net.kind.binary'))}</span> <span class="ns-dim">${esc(o.bytes(body.bytes.length))}${body.bytes.length > n ? ` · ${esc(t('net.firstBytes', { count: n }))}` : ''}</span></div><pre class="hexv-body ns-hex">${hexHtml(body.bytes.subarray(0, n))}</pre>`;
      }
      default: return '';
    }
  }
  const more = (text, o) => (text.length > TEXT_MAX ? `<div class="ns-note">${esc(o.t('net.clipped', { size: o.bytes(TEXT_MAX) }))}</div>` : '');

  const headList = (headers) => `<dl class="ns-kv">${headers.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  const statusCls = (s) => (s >= 500 ? ' err' : s >= 400 ? ' warn' : s >= 200 && s < 300 ? ' ok' : '');

  function httpHtml(sec, o, open) {
    const m = sec.msg;
    const { t } = o;
    const line = m.type === 'request'
      ? `<span class="badge acc">${esc(m.method)}</span> <b class="mono ns-target">${esc(m.target)}</b> <span class="ns-dim">${esc(m.version)}</span>`
      : `<span class="badge${statusCls(m.status)}">${esc(String(m.status))}</span> <b class="mono">${esc(m.reason || '')}</b> <span class="ns-dim">${esc(m.version)}</span>`;
    const meta = [];
    if (m.contentType) meta.push(esc(m.contentType));
    if (m.body && m.body.length) meta.push(esc(o.bytes(m.body.length)));
    const d = sec.decoded;
    if (d) meta.push(d.ok ? `${esc(d.encoding)} → ${esc(o.bytes(d.to))}${d.partial ? ` (${esc(t('net.partial'))})` : ''}` : `${esc(d.encoding)}: ${esc(t(d.unsupported ? 'net.encUnsupported' : 'net.encFailed'))}`);
    if (m.chunked) meta.push('chunked');
    if (!m.complete && !m.headOnly) meta.push(`<span class="badge warn">${esc(t('net.partial'))}</span>`);
    if (m.malformed) meta.push(`<span class="badge warn">${esc(t('net.malformed'))}</span>`);
    return `<div class="ns-h"><span class="ns-time">${esc(o.time(sec.t))}</span>${line}</div>`
      + (meta.length ? `<div class="ns-meta">${meta.join(' · ')}</div>` : '')
      + `<details class="ns-hd"${open ? ' open' : ''}><summary>${esc(t('net.headers', { count: m.headers.length }))}</summary>${headList(m.headers)}</details>`
      + bodyHtml(sec.body, o);
  }

  function tlsHtml(sec, o) {
    const x = sec.tls;
    const { t } = o;
    const hello = x.hello;
    const rows = [];
    if (hello) {
      rows.push([t('net.tls.hello'), hello.type === 'client' ? 'ClientHello' : 'ServerHello']);
      if (hello.sni) rows.push([t('net.tls.sni'), hello.sni]);
      const ver = hello.versions.length ? hello.versions.join(', ') : hello.version;
      if (ver) rows.push([t('net.tls.version'), ver]);
      if (hello.alpn.length) rows.push(['ALPN', hello.alpn.join(', ')]);
      if (hello.cipher) rows.push([t('net.tls.cipher'), hello.cipher]);
      else if (hello.suites) rows.push([t('net.tls.suites'), String(hello.suites)]);
    }
    rows.push([t('net.tls.records'), `${x.records} (${t('net.tls.handshake')} ${x.handshake} · ${t('net.tls.appData')} ${x.app}${x.alert ? ` · ${t('net.tls.alert')} ${x.alert}` : ''})`]);
    rows.push([t('net.tls.encrypted'), o.bytes(x.appBytes)]);
    return `<div class="ns-h"><span class="ns-time">${esc(o.time(sec.t))}</span><span class="badge acc">TLS</span>${hello && hello.sni ? ` <b class="mono">${esc(hello.sni)}</b>` : ''}</div>`
      + `<dl class="ns-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="ns-note">${esc(t('net.tls.note'))}</div>`;
  }

  function dnsHtml(sec, o) {
    const d = sec.dns;
    const { t } = o;
    const q = d.questions.map((x) => `<span class="mono">${esc(x.name)}</span> <span class="ns-dim">${esc(x.type)}</span>`).join(', ');
    const ans = d.answers.length ? `<dl class="ns-kv">${d.answers.map((a) => `<dt>${esc(a.type)}</dt><dd>${esc(a.data)} <span class="ns-dim">TTL ${a.ttl}</span></dd>`).join('')}</dl>` : '';
    return `<div class="ns-h"><span class="ns-time">${esc(o.time(sec.t))}</span><span class="badge acc">DNS</span> <span class="badge${d.response && d.rcode !== 'NOERROR' ? ' warn' : ''}">${esc(d.response ? `${t('net.dns.answer')} · ${d.rcode}` : t('net.dns.query'))}</span> ${q}</div>${ans}`;
  }

  function wsHtml(sec, o) {
    const f = sec.frame;
    const { t } = o;
    const flags = [f.masked ? t('net.ws.masked') : '', f.compressed ? t('net.ws.compressed') : '', f.fin ? '' : t('net.ws.fragment'), f.complete ? '' : t('net.partial')].filter(Boolean);
    return `<div class="ns-h"><span class="ns-time">${esc(o.time(sec.t))}</span><span class="badge acc">WebSocket</span> <b>${esc(f.op)}</b> <span class="ns-dim">${esc(o.bytes(f.len))}${flags.length ? ` · ${esc(flags.join(' · '))}` : ''}</span></div>`
      + (sec.body ? bodyHtml(sec.body, o) : f.compressed ? `<div class="ns-note">${esc(t('net.ws.compressedNote'))}</div>` : '');
  }

  // Bölümleri kararlı anahtarlarla döndürür: arayüz değişmeyen bölümlerin düğümünü yerinde bırakır
  // (açık "Başlıklar" kutusu, kaydırma konumu ve yüklenmiş resimler korunur).
  function smartItems(result, side, o, openKeys) {
    const items = [];
    const seen = new Map();
    const { t } = o;
    if (result.more) items.push({ key: 'more', sig: String(result.more), html: `<div class="ns-note">${esc(t('net.olderHidden', { count: result.more }))}</div>` });
    for (const sec of result.sections) {
      let key, sig, html;
      if (sec.kind === 'http') {
        const m = sec.msg;
        key = `h${side.base + m.start}`;
        sig = `${m.end}|${m.complete ? 1 : 0}|${m.body ? m.body.length : 0}|${sec.decoded ? sec.decoded.to : ''}`;
        html = httpHtml(sec, o, !!(openKeys && openKeys.has(key)));
      } else if (sec.kind === 'tls') {
        key = 'tls'; sig = `${sec.tls.records}|${sec.tls.appBytes}`; html = tlsHtml(sec, o);
      } else if (sec.kind === 'dns') {
        key = `d${sec.t}:${sec.dns.id}:${sec.dns.response ? 1 : 0}`; sig = String(sec.size); html = dnsHtml(sec, o);
      } else if (sec.kind === 'ws') {
        key = `w${sec.t}:${sec.frame.at}`; sig = `${sec.frame.len}|${sec.frame.complete ? 1 : 0}`; html = wsHtml(sec, o);
      } else {
        key = `${sec.kind === 'datagram' ? 'u' : 'r'}${sec.t}`; sig = String(sec.size);
        html = `<div class="ns-h"><span class="ns-time">${esc(o.time(sec.t))}</span><span class="badge">${esc(t(sec.kind === 'datagram' ? 'net.kind.datagram' : 'net.kind.raw'))}</span> <span class="ns-dim">${esc(o.bytes(sec.size))}</span></div>${bodyHtml(sec.body, o)}`;
      }
      const n = seen.get(key) || 0; // aynı anda gelen eş anahtarlar ayrışsın
      seen.set(key, n + 1);
      items.push({ key: n ? `${key}#${n}` : key, sig, html });
    }
    return items;
  }

  // HTML görünümü: HTTP gövdelerindeki HTML / XML (sıkıştırma çözülmüş) kaynak olarak; hiç yoksa akışın metni
  function markupItems(result, side, o) {
    const items = [];
    for (const sec of result.sections) {
      if (sec.kind !== 'http' || !sec.body || (sec.body.kind !== 'html' && sec.body.kind !== 'xml')) continue;
      const m = sec.msg;
      const title = m.type === 'request' ? `${m.method} ${m.target}` : `${m.status} ${m.reason || ''}`;
      items.push({
        key: `h${side.base + m.start}`, sig: `${m.end}|${sec.body.text.length}`,
        html: `<div class="ns-h"><span class="ns-time">${esc(o.time(sec.t))}</span><b class="mono ns-target">${esc(title)}</b> <span class="ns-dim">${esc(m.contentType || '')}</span></div><pre class="ns-code">${S.markupHtml(clip(sec.body.text))}</pre>${more(sec.body.text, o)}`,
      });
    }
    return items;
  }

  // Bir akışın tür etiketi (liste sütunu için): iki yönün çözümlemesinden
  function protocolLabel(protocol) {
    return { http: 'HTTP', tls: 'TLS', dns: 'DNS', websocket: 'WebSocket', udp: 'UDP' }[protocol] || '';
  }

  // Port süzgeci: "443", "80, 443", "8000-8100" (virgül ya da boşlukla ayrılır). Geçersizse ok: false.
  function portFilter(text) {
    const s = String(text || '').replace(/\s*-\s*/g, '-').trim();
    const ranges = [];
    for (const part of s.split(/[\s,;]+/)) {
      if (!part) continue;
      const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
      if (!m) return { ok: false, empty: false, test: () => true };
      let a = Number(m[1]);
      let b = m[2] === undefined ? a : Number(m[2]);
      if (a > 65535 || b > 65535) return { ok: false, empty: false, test: () => true };
      if (a > b) [a, b] = [b, a];
      ranges.push([a, b]);
    }
    return { ok: true, empty: !ranges.length, test: (port) => !ranges.length || ranges.some(([a, b]) => port >= a && port <= b) };
  }

  const api = { IMG_MAX, TEXT_MAX, hexHtml, hexText, textOf, base64Of, bodyHtml, smartItems, markupItems, protocolLabel, portFilter };
  if (node) module.exports = api;
  else root.NETRENDER = api;
})(typeof self !== 'undefined' ? self : this);
