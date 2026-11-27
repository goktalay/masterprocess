'use strict';

// Tuval çizimleri: tablo satırındaki küçük çizgi grafik, ayrıntı panelindeki zaman grafiği, bellek yerleşim
// haritası, disk küme haritası ve disk yüzeyi haritası. Hepsi verilen veriyi çizer; veri toplamaz.
const CHARTS = (() => {
  let palette = null;
  function colors() {
    if (palette) return palette;
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    palette = {
      cpu: v('--m-cpu', '#22d3ee'), ws: v('--m-mem', '#a78bfa'), mem: v('--m-mem', '#a78bfa'),
      io: v('--m-io', '#34d399'), gpu: v('--m-gpu', '#f59e0b'),
      net: v('--m-net', '#f472b6'), netUp: v('--m-net-up', '#818cf8'),
      image: v('--r-image', '#a78bfa'), mapped: v('--r-mapped', '#60a5fa'), private: v('--r-private', '#34d399'),
      grid: v('--border', 'rgba(255,255,255,.08)'), text: v('--text-3', '#64748b'), text2: v('--text-2', '#94a3b8'),
      surface: v('--surface-2', '#1e293b'), bg: v('--bg-2', '#0f172a'), accent: v('--accent', '#22d3ee'),
      strong: v('--text', '#e2e8f0'), font: v('--font', 'sans-serif'), mono: v('--mono', 'monospace'),
    };
    return palette;
  }
  // Tema değişince renkler yeniden okunur
  function resetColors() { palette = null; }

  // Tuvali CSS boyutuna ve ekran yoğunluğuna göre hazırlar; boyut değişmediyse yalnız temizler.
  function prep(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }
  function sizeOf(canvas) {
    const r = canvas.getBoundingClientRect();
    return { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
  }
  function alpha(color, a) {
    // #rrggbb → rgba; başka biçimler olduğu gibi (globalAlpha ile) kullanılır
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function maxOf(values, n) {
    let m = 0;
    for (let i = 0; i < n; i++) if (values[i] > m) m = values[i];
    return m;
  }

  // Tablo satırı için: son n değer, sağa yaslı. slots: tam genişliğin karşılık geldiği örnek sayısı.
  function spark(canvas, values, n, { w, h, color, floorMax = 0, slots = 60 }) {
    const ctx = prep(canvas, w, h);
    if (n < 2) return;
    const max = Math.max(maxOf(values, n), floorMax) || 1;
    const step = w / (slots - 1);
    const x0 = w - (n - 1) * step;
    const y = (v) => h - 1 - (Math.min(v, max) / max) * (h - 2);
    ctx.beginPath();
    ctx.moveTo(x0, y(values[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(x0 + i * step, y(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(x0, h);
    ctx.closePath();
    ctx.fillStyle = alpha(color, 0.16);
    ctx.fill();
  }

  // Zaman grafiği. series: [{ values, n, color }] — hepsi aynı zaman ekseninde, sağa yaslı.
  // capacity: tam genişliğe sığan örnek sayısı; fmt: eksen etiketi biçimleyici; max verilmezse veriden.
  function line(canvas, { series, capacity = 300, max = 0, floorMax = 0, fmt = (v) => String(Math.round(v)), stepMs = 1000, secLabel = 's' }) {
    const { w, h } = sizeOf(canvas);
    const ctx = prep(canvas, w, h);
    const c = colors();
    const padL = 4, padR = 4, padT = 14, padB = 14;
    const pw = w - padL - padR, ph = h - padT - padB;
    let top = max;
    if (!top) {
      for (const s of series) top = Math.max(top, maxOf(s.values, s.n));
      top = Math.max(top * 1.15, floorMax) || 1;
    }
    // Izgara
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(padT + (ph * i) / 4) + 0.5;
      ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y);
    }
    for (let i = 0; i <= 6; i++) {
      const x = Math.round(padL + (pw * i) / 6) + 0.5;
      ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph);
    }
    ctx.stroke();
    // Seriler
    const step = pw / Math.max(1, capacity - 1);
    for (const s of series) {
      if (s.n < 2) continue;
      const x0 = padL + pw - (s.n - 1) * step;
      const y = (v) => padT + ph - (Math.min(v, top) / top) * ph;
      ctx.beginPath();
      ctx.moveTo(x0, y(s.values[0]));
      for (let i = 1; i < s.n; i++) ctx.lineTo(x0 + i * step, y(s.values[i]));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (!s.noFill) {
        ctx.lineTo(padL + pw, padT + ph);
        ctx.lineTo(x0, padT + ph);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, padT, 0, padT + ph);
        g.addColorStop(0, alpha(s.color, 0.28));
        g.addColorStop(1, alpha(s.color, 0.02));
        ctx.fillStyle = g;
        ctx.fill();
      }
    }
    // Eksen etiketleri: üst sınır, sıfır, zaman aralığı
    ctx.fillStyle = c.text;
    ctx.font = `10.5px ${c.font}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(top), padL + pw, 1);
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    const span = Math.round(((capacity - 1) * stepMs) / 1000);
    ctx.fillText(`−${span >= 120 ? Math.round(span / 60) + ' min' : span + ' ' + secLabel}`, padL, h);
    ctx.textAlign = 'right';
    ctx.fillText('0', padL + pw, h);
  }

  // --- Bellek yerleşim haritası -------------------------------------------------
  // memmap yanıtından kaydedilmiş (commit) bölgeleri adres sırasıyla, kümülatif ofsetle çıkarır.
  function memModel(mm) {
    const items = [];
    let total = 0;
    const ps = mm.pageSize || 4096;
    for (let i = 0; i < mm.regions.length; i++) {
      const r = mm.regions[i];
      if (r[2] !== 1) continue; // yalnız commit
      const size = r[1];
      const ws = r[5] > 0 ? Math.min(1, (r[5] * ps) / size) : 0;
      items.push({ i, base: r[0], size, protect: r[3], type: r[4], wsPages: r[5], ws, name: r[6], cum: total });
      total += size;
    }
    return { items, total, pageSize: ps };
  }
  function itemAt(model, off) {
    let lo = 0, hi = model.items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (model.items[mid].cum <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const TYPE_COLOR = ['private', 'private', 'mapped', 'image'];

  // Her hücre eşit miktarda kaydedilmiş belleği temsil eder; renk bölge türü, parlaklık o bölgenin fiziksel
  // RAM'de bulunan oranıdır. Dönen nesne fare konumundan bölgeyi bulur.
  function memMap(canvas, model, { selected = -1, cell = 7 } = {}) {
    const { w, h } = sizeOf(canvas);
    const ctx = prep(canvas, w, h);
    const c = colors();
    const cols = Math.max(1, Math.floor(w / cell));
    const rows = Math.max(1, Math.floor(h / cell));
    const cells = cols * rows;
    const per = model.total / cells;
    const map = new Int32Array(cells).fill(-1);
    if (model.items.length && model.total > 0) {
      for (let k = 0; k < cells; k++) {
        const idx = itemAt(model, (k + 0.5) * per);
        map[k] = idx;
        const it = model.items[idx];
        ctx.fillStyle = alpha(c[TYPE_COLOR[it.type] || 'private'], 0.2 + 0.8 * it.ws);
        ctx.fillRect((k % cols) * cell, Math.floor(k / cols) * cell, cell - 1, cell - 1);
      }
      if (selected >= 0) {
        ctx.strokeStyle = c.strong;
        ctx.lineWidth = 1;
        for (let k = 0; k < cells; k++) {
          if (model.items[map[k]] && model.items[map[k]].i === selected) {
            ctx.strokeRect((k % cols) * cell - 0.5, Math.floor(k / cols) * cell - 0.5, cell, cell);
          }
        }
      }
    }
    return {
      perCell: per,
      at(x, y) {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return null;
        const idx = map[cy * cols + cx];
        return idx >= 0 ? model.items[idx] : null;
      },
    };
  }

  // --- Disk küme haritası ----------------------------------------------------------
  // Üst şerit: dosyanın parçalarının birim üzerindeki konumu (doğrusal ölçek; her parça en az 2 px).
  // Alt şerit: dosyanın kendisi, parçaları dosya sırasıyla ve uzunluklarıyla orantılı.
  function clusterMap(canvas, fm) {
    const { w, h } = sizeOf(canvas);
    const ctx = prep(canvas, w, h);
    const c = colors();
    const bandH = Math.floor((h - 10) / 2);
    const total = fm.totalClusters || 1;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, bandH);
    ctx.fillRect(0, bandH + 10, w, bandH);
    const ext = fm.extents || [];
    let sum = 0;
    for (const e of ext) sum += e[1];
    const hue = (i) => (i % 2 ? c.io : c.accent);
    let off = 0;
    for (let i = 0; i < ext.length; i++) {
      const [lcn, count] = ext[i];
      ctx.fillStyle = hue(i);
      const x = (lcn / total) * w;
      ctx.fillRect(Math.min(x, w - 2), 0, Math.max(2, (count / total) * w), bandH);
      if (sum > 0) {
        const fx = (off / sum) * w;
        const fw = (count / sum) * w;
        ctx.fillRect(fx, bandH + 10, Math.max(1, fw - (ext.length > 1 && fw > 3 ? 1 : 0)), bandH);
      }
      off += count;
    }
    ctx.strokeStyle = c.grid;
    ctx.strokeRect(0.5, 0.5, w - 1, bandH - 1);
    ctx.strokeRect(0.5, bandH + 10.5, w - 1, bandH - 1);
  }

  // --- Disk yüzeyi haritası --------------------------------------------------------
  // Birim eşit küme aralıklarına bölünür; her kare bir aralıktır (soldan sağa, yukarıdan aşağıya = birimin
  // başından sonuna). Kare tonu o aralığın doluluk oranıdır (vol: birim bit eşleminden); dosyanın parçalarının
  // düştüğü kareler vurgulanır. vol yoksa yalnız dosyanın kareleri çizilir, doluluk gösterilmez.
  function diskMap(canvas, fm, { vol = null, cell = 8, selected = -1 } = {}) {
    const { w, h } = sizeOf(canvas);
    const ctx = prep(canvas, w, h);
    const c = colors();
    const cols = Math.max(1, Math.floor(w / cell));
    const rows = Math.max(1, Math.floor(h / cell));
    const cells = cols * rows;
    const total = Math.max(1, fm.totalClusters || 1);
    const ext = fm.extents || [];
    const cellOf = (lcn) => Math.max(0, Math.min(cells - 1, Math.floor((lcn / total) * cells)));

    // Doluluk: bit eşlemi hücreleri ızgaraya yeniden örneklenir (kareye düşen hücrelerin ortalaması)
    let used = null;
    if (vol && vol.bytes && vol.bytes.length) {
      const V = vol.bytes.length;
      used = new Float32Array(cells);
      for (let k = 0; k < cells; k++) {
        const a = Math.min(V - 1, Math.floor((k * V) / cells));
        const b = Math.max(a + 1, Math.min(V, Math.ceil(((k + 1) * V) / cells)));
        let sum = 0;
        for (let i = a; i < b; i++) sum += vol.bytes[i];
        used[k] = sum / ((b - a) * 255);
      }
    }

    // Kare → o kareye düşen ilk parça; seçili parçanın kareleri ayrıca işaretlenir
    const first = new Int32Array(cells).fill(-1);
    const picked = new Uint8Array(cells);
    for (let i = 0; i < ext.length; i++) {
      const a = cellOf(ext[i][0]);
      const b = cellOf(ext[i][0] + Math.max(1, ext[i][1]) - 1);
      for (let k = a; k <= b; k++) {
        if (first[k] < 0) first[k] = i;
        if (i === selected) picked[k] = 1;
      }
    }

    const idle = alpha(c.text2, 0.1);
    for (let k = 0; k < cells; k++) {
      const x = (k % cols) * cell, y = Math.floor(k / cols) * cell;
      ctx.fillStyle = c.bg;
      ctx.fillRect(x, y, cell - 1, cell - 1);
      if (first[k] >= 0) ctx.fillStyle = first[k] % 2 ? c.io : c.accent;
      else if (!used) ctx.fillStyle = idle;
      else if (used[k] > 0) ctx.fillStyle = alpha(c.text2, 0.16 + 0.5 * used[k]);
      else continue;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
    ctx.strokeStyle = c.strong;
    ctx.lineWidth = 1;
    for (let k = 0; k < cells; k++) {
      if (picked[k]) ctx.strokeRect((k % cols) * cell - 0.5, Math.floor(k / cols) * cell - 0.5, cell, cell);
    }

    return {
      cells, cols, rows,
      perCell: total / cells,
      at(x, y) {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return null;
        const k = cy * cols + cx;
        const lcn0 = Math.floor((k * total) / cells);
        const lcn1 = Math.max(lcn0, Math.ceil(((k + 1) * total) / cells) - 1);
        const frags = [];
        let fragCount = 0;
        if (first[k] >= 0) {
          for (let i = first[k]; i < ext.length; i++) {
            if (cellOf(ext[i][0]) > k || cellOf(ext[i][0] + Math.max(1, ext[i][1]) - 1) < k) continue;
            fragCount++;
            if (frags.length < 6) frags.push(i);
          }
        }
        return { k, lcn0, lcn1, used: used ? used[k] : null, frags, fragCount };
      },
    };
  }

  // Pencere görüntüsü: BGRA baytlarını tuvale yazar (tuval w×h piksel olur; CSS ile ölçeklenir).
  function bgra(canvas, bytes, w, h) {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const n = Math.min(bytes.length, d.length);
    for (let i = 0; i + 3 < n; i += 4) {
      d[i] = bytes[i + 2]; d[i + 1] = bytes[i + 1]; d[i + 2] = bytes[i]; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  return { colors, resetColors, spark, line, memModel, memMap, clusterMap, diskMap, bgra, alpha };
})();
