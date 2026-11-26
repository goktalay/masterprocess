'use strict';

// Biçimleme yardımcıları: bayt, hız, yüzde, süre, adres, sayfa koruması. Arayüzde window.FMT, testlerde require.
(function (root) {
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  // 1536 → "1.5 KB"; 1024 tabanlı. Üç anlamlı basamak: 999 B, 1.00 KB, 12.3 MB, 123 GB
  function bytes(n) {
    let v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    let u = 0;
    while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u++; }
    // Yuvarlama 1024'e çıkarıyorsa bir üst birime geç (1023.99 KB → 1.00 MB)
    if (u > 0 && v >= 999.5 && u < UNITS.length - 1 && Math.round(v) >= 1024) { v /= 1024; u++; }
    const s = u === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${s} ${UNITS[u]}`;
  }

  // Bayt/sn. Sıfır için kısa çizgi yerine "0": tabloda hizalı dursun diye çağıran karar verir.
  function rate(n, perSec) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    return `${bytes(v)}/${perSec || 's'}`;
  }

  // Yüzde: 0–10 arası bir ondalık, üstü tam sayı; 0.05 altı "0"
  function pct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v < 0.05) return '0';
    if (v < 10) return v.toFixed(1);
    return String(Math.round(Math.min(v, 100)));
  }

  // Süre: en büyük iki birim. u = { d, h, m, s } birim kısaltmaları
  function duration(ms, u) {
    const U = Object.assign({ d: 'd', h: 'h', m: 'm', s: 's' }, u || {});
    let sec = Math.floor(Number(ms) / 1000);
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const d = Math.floor(sec / 86400); sec -= d * 86400;
    const hh = Math.floor(sec / 3600); sec -= hh * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    if (d) return `${d}${U.d} ${hh}${U.h}`;
    if (hh) return `${hh}${U.h} ${m}${U.m}`;
    if (m) return `${m}${U.m} ${sec}${U.s}`;
    return `${sec}${U.s}`;
  }

  // Onaltılık adres dizgesini sabit genişliğe doldurur: "7ff6a1b20000" → "00007ff6a1b20000"
  function addr(hex, width) {
    const s = String(hex || '0').toLowerCase();
    const w = width || (s.length > 8 ? 16 : 8);
    return s.length >= w ? s : '0'.repeat(w - s.length) + s;
  }

  // Onaltılık adres + ofset (BigInt; 2^53 üstü adresler için)
  function addrAdd(hex, offset) {
    return (BigInt('0x' + (hex || '0')) + BigInt(offset)).toString(16);
  }

  // Win32 PAGE_* → "RWX" biçimi; G = guard, C = yazınca kopyala
  function protect(p) {
    const v = Number(p) || 0;
    const base = v & 0xff;
    const map = { 0x01: '---', 0x02: 'R--', 0x04: 'RW-', 0x08: 'RC-', 0x10: '--X', 0x20: 'R-X', 0x40: 'RWX', 0x80: 'RCX' };
    if (!base) return '';
    let s = map[base] || '???';
    if (v & 0x100) s += 'G';
    return s;
  }

  // Binlik ayırıcılı tam sayı (dil bağımsız, ince boşluk yerine yerel ayar: çağıran LANG verir)
  function int(n, lang) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    try { return Math.round(v).toLocaleString(lang || undefined); } catch (_) { return String(Math.round(v)); }
  }

  // Uzun yolu ortadan kısaltır: baş ve son korunur
  function midEllipsis(s, max) {
    const str = String(s || '');
    if (str.length <= max) return str;
    const keep = max - 1;
    const head = Math.ceil(keep * 0.4);
    return str.slice(0, head) + '…' + str.slice(str.length - (keep - head));
  }

  function baseName(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // base64 → Uint8Array (arayüzde atob, Node'da Buffer)
  function b64ToBytes(b64) {
    if (!b64) return new Uint8Array(0);
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  const api = { bytes, rate, pct, duration, addr, addrAdd, protect, int, midEllipsis, baseName, b64ToBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FMT = api;
})(typeof self !== 'undefined' ? self : this);
