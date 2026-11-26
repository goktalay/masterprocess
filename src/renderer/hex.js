'use strict';

// Hex görüntüleyici: bir bayt kaynağını (süreç belleği ya da dosya) sayfa sayfa gösterir. Canlı kipte sayfayı
// yeniden okuyup değişen baytları işaretler; "dizgeler" kipinde sayfadaki okunur metinleri listeler.
const HEX = (() => {
  const PAGE = 4096;
  const ROW = 16;
  const HEXD = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

  // bytes: Uint8Array; label(i): satır başı adres dizgesi; prev: bir önceki okuma (değişen baytlar için)
  function render(bytes, label, prev) {
    const out = [];
    for (let r = 0; r < bytes.length; r += ROW) {
      let hx = '';
      let asc = '';
      for (let i = 0; i < ROW; i++) {
        const k = r + i;
        if (k >= bytes.length) { hx += '   '; asc += ' '; }
        else {
          const b = bytes[k];
          const chg = prev && k < prev.length && prev[k] !== b;
          const cell = HEXD[b];
          hx += chg ? `<b>${cell}</b> ` : b === 0 ? `<i>${cell}</i> ` : cell + ' ';
          const ch = b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
          const safe = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
          asc += chg ? `<b>${safe}</b>` : b >= 32 && b < 127 ? safe : '<i>.</i>';
        }
        if (i === 7) hx += ' ';
      }
      out.push(`<span class="hx-a">${label(r)}</span>  ${hx} <span class="hx-t">${asc}</span>`);
    }
    return out.join('\n');
  }

  // Sayfadaki okunur dizgeler: ASCII ve UTF-16LE, en az `min` karakter
  function strings(bytes, min = 5) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= bytes.length; i++) {
      const ok = i < bytes.length && bytes[i] >= 32 && bytes[i] < 127;
      if (ok) { if (start < 0) start = i; }
      else if (start >= 0) {
        if (i - start >= min) out.push({ off: start, kind: 'ascii', text: String.fromCharCode.apply(null, bytes.subarray(start, i)) });
        start = -1;
      }
    }
    start = -1;
    let n = 0;
    for (let i = 0; i + 1 <= bytes.length; i += 2) {
      const ok = i + 1 < bytes.length && bytes[i + 1] === 0 && bytes[i] >= 32 && bytes[i] < 127;
      if (ok) { if (start < 0) { start = i; n = 0; } n++; }
      else if (start >= 0) {
        if (n >= min) {
          let s = '';
          for (let k = start; k < i; k += 2) s += String.fromCharCode(bytes[k]);
          out.push({ off: start, kind: 'utf16', text: s });
        }
        start = -1;
      }
    }
    out.sort((a, b) => a.off - b.off);
    return out;
  }

  // host: görüntüleyicinin yerleşeceği öğe.
  // src: { title, total (bayt), base (bellek için onaltılık taban adres; dosyada null), read(offset, len) → Promise<Uint8Array>,
  //        live: canlı yenileme sunulsun mu }
  function createViewer(host, src) {
    let offset = 0;
    let mode = 'hex';
    let bytes = null;
    let prev = null;
    let timer = null;
    let seq = 0;
    let dead = false;
    const total = src.total;
    const width = src.base ? 16 : Math.max(8, (Math.max(0, total - 1)).toString(16).length);
    const label = (i) => (src.base ? FMT.addr(FMT.addrAdd(src.base, offset + i), width) : FMT.addr((offset + i).toString(16), width));

    host.innerHTML = '';
    const el = h(`<div class="hexv">
      <div class="hexv-bar">
        <span class="hexv-title" title="${esc(src.title)}">${icon('file')}<span>${ltr(esc(src.title))}</span></span>
        <span class="spacer"></span>
        <div class="seg sm" data-role="mode"><button data-m="hex" class="on">${esc(t('hex.modeHex'))}</button><button data-m="str">${esc(t('hex.modeStrings'))}</button></div>
        ${src.live ? `<label class="check sm" title="${esc(t('hex.liveHint'))}"><input type="checkbox" data-role="live"><span>${esc(t('hex.live'))}</span></label>` : ''}
        <button class="icon-btn" data-role="prev" title="${esc(t('hex.prev'))}">${icon('chevronUp')}</button>
        <button class="icon-btn" data-role="next" title="${esc(t('hex.next'))}">${icon('chevronDown')}</button>
        <input class="input sm mono" data-role="goto" spellcheck="false" placeholder="${esc(t('hex.goto'))}" title="${esc(t('hex.gotoHint'))}">
        <button class="icon-btn" data-role="copy" title="${esc(t('hex.copy'))}">${icon('copy')}</button>
        <button class="icon-btn" data-role="close" title="${esc(t('common.close'))}">${icon('x')}</button>
      </div>
      <pre class="hexv-body" tabindex="0"></pre>
      <div class="hexv-foot"></div>
    </div>`);
    host.appendChild(el);
    const body = el.querySelector('.hexv-body');
    const foot = el.querySelector('.hexv-foot');
    const q = (role) => el.querySelector(`[data-role="${role}"]`);

    function paint() {
      if (!bytes) return;
      if (mode === 'hex') {
        body.innerHTML = render(bytes, label, prev);
      } else {
        const list = strings(bytes);
        body.innerHTML = list.length
          ? list.map((s) => `<span class="hx-a">${label(s.off)}</span>  <span class="hx-k">${s.kind === 'utf16' ? 'U16' : 'ASC'}</span>  ${esc(s.text)}`).join('\n')
          : `<span class="hx-empty">${esc(t('hex.noStrings'))}</span>`;
      }
      const end = offset + bytes.length;
      foot.textContent = t('hex.range', { from: ltr(label(0)), to: ltr(label(Math.max(0, bytes.length - 1))), size: FMT.bytes(total) })
        + (end >= total ? '' : '');
      q('prev').disabled = offset <= 0;
      q('next').disabled = offset + PAGE >= total;
    }

    async function load(keepPrev) {
      const my = ++seq;
      const len = Math.max(1, Math.min(PAGE, total - offset));
      try {
        const data = await src.read(offset, len);
        if (dead || my !== seq) return;
        prev = keepPrev ? bytes : null;
        bytes = data;
        el.classList.remove('err');
        paint();
      } catch (e) {
        if (dead || my !== seq) return;
        bytes = null;
        prev = null;
        el.classList.add('err');
        body.innerHTML = `<span class="hx-empty">${esc(src.errorText ? src.errorText(e) : String(e.message || e))}</span>`;
        foot.textContent = '';
        stopLive();
      }
    }
    function go(off) {
      const max = Math.max(0, total - 1);
      offset = Math.max(0, Math.min(Math.floor(off / ROW) * ROW, Math.floor(max / ROW) * ROW));
      body.scrollTop = 0;
      load(false);
    }
    function stopLive() {
      if (timer) { clearInterval(timer); timer = null; }
      const cb = q('live');
      if (cb) cb.checked = false;
    }

    q('prev').onclick = () => go(offset - PAGE);
    q('next').onclick = () => go(offset + PAGE);
    q('close').onclick = () => { destroy(); if (src.onClose) src.onClose(); };
    q('copy').onclick = () => {
      if (!bytes) return;
      const text = body.textContent;
      window.api.copyText(text);
      toast(t('hex.copied'), { type: 'ok', timeout: 1800 });
    };
    q('mode').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      mode = b.dataset.m;
      for (const x of q('mode').children) x.classList.toggle('on', x === b);
      paint();
    };
    q('goto').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      const raw = e.target.value.trim().toLowerCase().replace(/^0x/, '');
      if (!/^[0-9a-f]{1,16}$/.test(raw)) { e.target.classList.add('bad'); return; }
      e.target.classList.remove('bad');
      // Bellekte mutlak adres, dosyada ofset
      let off;
      if (src.base) {
        const d = BigInt('0x' + raw) - BigInt('0x' + src.base);
        if (d < 0n || d >= BigInt(total)) { e.target.classList.add('bad'); return; }
        off = Number(d);
      } else {
        off = parseInt(raw, 16);
        if (off >= total) { e.target.classList.add('bad'); return; }
      }
      go(off);
    };
    const live = q('live');
    if (live) {
      live.onchange = () => {
        if (timer) { clearInterval(timer); timer = null; }
        if (live.checked) timer = setInterval(() => load(true), 1000);
      };
    }
    body.addEventListener('wheel', (e) => {
      // Sayfa sonunda/başında tekerlek bir sonraki/önceki sayfaya geçer
      if (e.deltaY > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 1 && offset + PAGE < total) { e.preventDefault(); go(offset + PAGE); }
      else if (e.deltaY < 0 && body.scrollTop <= 0 && offset > 0) { e.preventDefault(); go(offset - PAGE); requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; }); }
    }, { passive: false });

    function destroy() {
      dead = true;
      if (timer) clearInterval(timer);
      timer = null;
      el.remove();
    }

    go(src.start || 0);
    return { destroy, go };
  }

  return { PAGE, render, strings, createViewer };
})();
