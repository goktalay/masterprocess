'use strict';

// Linux sağlayıcısı (procfs). Windows yardımcısıyla (mp-agent.exe) AYNI protokolü uygular — bkz. docs/agent-protocol.md.
// Ürün Windows içindir; bu sağlayıcı arayüzün Linux'ta gerçek süreç verisiyle geliştirilip sınanabilmesi için vardır.
// Windows'a özgü kavramlar en yakın karşılıklarına eşlenir (çalışma kümesi → RSS, tanıtıcı → dosya tanımlayıcı,
// küme → dosya sistemi bloğu). Karşılığı olmayan komutlar (capture, gpudetail, volmap) `unsupported` döner.
// Ağ: bağlantı / port listesi (netconns) ve sistem ağ hızı gerçektir; paket yakalama (netcap açma, netwatch,
// netstream) yoktur — süreç başına ağ hızı sütunları bu yüzden 0'dır; netcap `reason: "unsupported"` ile
// yanıtlanır ve arayüz yalnız bağlantı listesini gösterir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HZ = 100; // USER_HZ: Linux'ta kullanıcı alanına her mimaride 100 olarak sunulur
const PAGE = 4096;
const MAX_ADDR = 0x7fffffffffff;
const MAX_IO = 65536;

function perr(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}
// errno → protokol hata kodu
function mapErr(e, what) {
  if (e && e.code && ['access', 'gone', 'bad_request', 'unsupported', 'timeout', 'failed'].includes(e.code)) return e;
  const c = e && e.code;
  if (c === 'EACCES' || c === 'EPERM') return perr('access', `${what}: permission denied`);
  if (c === 'ENOENT' || c === 'ESRCH') return perr('gone', `${what}: no such process or file`);
  return perr('failed', `${what}: ${(e && e.message) || e}`);
}
const hex = (n) => n.toString(16);
const readText = (p) => fs.readFileSync(p, 'utf8');
const tryText = (p) => { try { return readText(p); } catch (_) { return null; } };

// /proc/<pid>/stat: ad parantez içindedir ve boşluk/parantez içerebilir → son ')' konumundan böl
function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const f = text.slice(close + 2).trim().split(' ');
  return {
    pid: parseInt(text.slice(0, open), 10),
    comm: text.slice(open + 1, close),
    state: f[0],
    ppid: +f[1],
    session: +f[3],
    minflt: +f[7],
    majflt: +f[9],
    utime: +f[11],
    stime: +f[12],
    priority: +f[15],
    nice: +f[16],
    threads: +f[17],
    starttime: +f[19],
    vsize: +f[20],
    rss: +f[21],
  };
}

function parseKeyed(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}
const kb = (v) => (v ? parseInt(v, 10) * 1024 : 0);

function niceToPriority(n) {
  if (n >= 19) return 'idle';
  if (n >= 5) return 'below';
  if (n <= -15) return 'realtime';
  if (n <= -10) return 'high';
  if (n < 0) return 'above';
  return 'normal';
}
const PRIORITY_NICE = { idle: 19, below: 10, normal: 0, above: -5, high: -10 };

// "r-xp" → Win32 PAGE_* karşılığı
function protectOf(perms) {
  const r = perms[0] === 'r', w = perms[1] === 'w', x = perms[2] === 'x';
  if (x) return w ? 0x40 : r ? 0x20 : 0x10;
  if (w) return 0x04;
  return r ? 0x02 : 0x01;
}

// /proc/net/tcp|udp adres alanı: IPv4 "0100007F" (ana makine bayt sırasında u32), IPv6 dört u32
function procAddr(hexText) {
  const b = [];
  for (let i = 0; i + 8 <= hexText.length; i += 8) {
    const w = hexText.slice(i, i + 8);
    b.push(parseInt(w.slice(6, 8), 16), parseInt(w.slice(4, 6), 16), parseInt(w.slice(2, 4), 16), parseInt(w.slice(0, 2), 16));
  }
  if (b.length === 4) return b.join('.');
  if (b.length !== 16) return '';
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i] << 8) | b[i + 1]);
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return `::ffff:${b.slice(12).join('.')}`;
  // en uzun sıfır dizisi "::" olur (RFC 5952)
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const h = (a) => a.map((x) => x.toString(16)).join(':');
  return best < 0 ? h(g) : `${h(g.slice(0, best))}::${h(g.slice(best + bestLen))}`;
}
const LINUX_TCP_STATES = ['unknown', 'established', 'syn_sent', 'syn_rcvd', 'fin_wait1', 'fin_wait2', 'time_wait', 'closed', 'close_wait', 'last_ack', 'listen', 'closing'];

// "sl local rem st … uid timeout inode" satırları → { inode, local, lport, remote, rport, st }
function parseProcNet(text) {
  const rows = [];
  if (!text) return rows;
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 10) continue;
    const l = f[1].split(':'), r = f[2].split(':');
    if (l.length !== 2 || r.length !== 2) continue;
    rows.push({ inode: f[9], local: procAddr(l[0]), lport: parseInt(l[1], 16), remote: procAddr(r[0]), rport: parseInt(r[1], 16), st: parseInt(f[3], 16) });
  }
  return rows;
}

// /proc/net/dev → geri döngü dışındaki arayüzlerin toplam alınan / gönderilen baytı
function parseNetDev(text) {
  let rx = 0, tx = 0;
  if (!text) return { rx, tx };
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (line.slice(0, i).trim() === 'lo') continue;
    const f = line.slice(i + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    rx += +f[0] || 0;
    tx += +f[8] || 0;
  }
  return { rx, tx };
}

function createProvider() {
  let btimeMs = 0;
  let prev = null; // önceki snapshot: { t, total, busy, procs: Map(pid → { ticks, rd, wr, start }) }
  const users = new Map();
  const exitCbs = [];

  function bootTime() {
    if (btimeMs) return btimeMs;
    const m = /^btime\s+(\d+)/m.exec(readText('/proc/stat'));
    btimeMs = m ? +m[1] * 1000 : Date.now() - os.uptime() * 1000;
    return btimeMs;
  }
  const startMs = (starttime) => Math.round(bootTime() + (starttime * 1000) / HZ);

  function userName(uid) {
    if (!users.size) {
      const txt = tryText('/etc/passwd') || '';
      for (const line of txt.split('\n')) {
        const f = line.split(':');
        if (f.length > 2) users.set(+f[2], f[0]);
      }
    }
    return users.get(uid) || String(uid);
  }

  function statOf(pid) {
    let txt;
    try { txt = readText(`/proc/${pid}/stat`); } catch (e) { throw perr('gone', `process ${pid} not found`); }
    const st = parseStat(txt);
    if (!st) throw perr('failed', 'stat parse');
    return st;
  }

  function hello() {
    return {
      agent: 'linux-procfs',
      protocol: 1,
      pid: process.pid,
      elevated: typeof process.getuid === 'function' && process.getuid() === 0,
      debugPrivilege: false,
      arch: process.arch,
      os: os.release(),
      cpuCount: os.cpus().length || 1,
      pageSize: PAGE,
      totalPhys: os.totalmem(),
      gpuCounters: false,
      gpus: [],
      net: true,
    };
  }

  function snapshot() {
    const t = Date.now();
    const cpuLine = readText('/proc/stat').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    const total = cpuLine.slice(0, 8).reduce((a, b) => a + b, 0);
    const busy = total - cpuLine[3] - (cpuLine[4] || 0);
    const mem = parseKeyed(tryText('/proc/meminfo'));
    const ncpu = os.cpus().length || 1;
    const dt = prev ? Math.max(0.001, (t - prev.t) / 1000) : 0;

    const cur = new Map();
    const procs = [];
    let ioR = 0, ioW = 0;
    for (const name of fs.readdirSync('/proc')) {
      const c = name.charCodeAt(0);
      if (c < 48 || c > 57) continue;
      const pid = +name;
      let st;
      try { st = parseStat(readText(`/proc/${pid}/stat`)); } catch (_) { continue; }
      if (!st) continue;
      const start = startMs(st.starttime);
      let priv = 0;
      const statm = tryText(`/proc/${pid}/statm`);
      if (statm) { const f = statm.split(' '); priv = Math.max(0, (+f[1] - +f[2]) * PAGE); }
      let rd = 0, wr = 0;
      const io = tryText(`/proc/${pid}/io`);
      if (io) {
        const m1 = /^read_bytes:\s*(\d+)/m.exec(io), m2 = /^write_bytes:\s*(\d+)/m.exec(io);
        rd = m1 ? +m1[1] : 0; wr = m2 ? +m2[1] : 0;
      }
      let handles = 0;
      try { handles = fs.readdirSync(`/proc/${pid}/fd`).length; } catch (_) { /* başka kullanıcının süreci */ }

      const ticks = st.utime + st.stime;
      const p = prev && prev.procs.get(pid);
      let cpu = 0, rRate = 0, wRate = 0;
      if (p && p.start === start && dt) {
        cpu = Math.min(100, Math.max(0, ((ticks - p.ticks) / HZ / dt / ncpu) * 100));
        rRate = Math.max(0, (rd - p.rd) / dt);
        wRate = Math.max(0, (wr - p.wr) / dt);
      }
      cur.set(pid, { ticks, rd, wr, start });
      ioR += rRate; ioW += wRate;
      procs.push([pid, st.ppid, st.comm, Math.round(cpu * 100) / 100, st.rss * PAGE, priv, Math.round(rRate), Math.round(wRate), 0, 0, 0, st.threads, handles, start, st.session, 0, 0]);
    }
    // Ebeveyn çocuktan sonra başlamışsa PID yeniden kullanılmıştır → 0
    for (const r of procs) {
      const par = cur.get(r[1]);
      if (r[1] && (!par || par.start > r[13])) r[1] = 0;
    }
    const sysCpu = prev && total > prev.total ? Math.min(100, Math.max(0, ((busy - prev.busy) / (total - prev.total)) * 100)) : 0;
    const dev = parseNetDev(tryText('/proc/net/dev'));
    const netRx = prev && prev.dev && dt ? Math.max(0, (dev.rx - prev.dev.rx) / dt) : 0;
    const netTx = prev && prev.dev && dt ? Math.max(0, (dev.tx - prev.dev.tx) / dt) : 0;
    prev = { t, total, busy, procs: cur, dev };
    return {
      t,
      sys: {
        cpu: Math.round(sysCpu * 100) / 100,
        memTotal: kb(mem.MemTotal), memAvail: kb(mem.MemAvailable),
        commitTotal: kb(mem.Committed_AS), commitLimit: kb(mem.CommitLimit),
        ioRead: Math.round(ioR), ioWrite: Math.round(ioW), gpu: 0, gpuDedicated: 0, gpuShared: 0,
        netRx: Math.round(netRx), netTx: Math.round(netTx), netCap: false,
      },
      cols: ['pid', 'ppid', 'name', 'cpu', 'ws', 'priv', 'ioRead', 'ioWrite', 'gpu', 'gpuDed', 'gpuShr', 'threads', 'handles', 'start', 'session', 'netRx', 'netTx'],
      procs,
    };
  }

  function detail({ pid }) {
    const st = statOf(pid);
    const status = parseKeyed(tryText(`/proc/${pid}/status`));
    const io = parseKeyed(tryText(`/proc/${pid}/io`));
    let exe = null;
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch (_) { /* çekirdek iş parçacığı ya da izin yok */ }
    const cmdRaw = tryText(`/proc/${pid}/cmdline`);
    const cmdline = cmdRaw ? cmdRaw.replace(/\0+$/, '').split('\0').join(' ') : null;
    const uid = status.Uid ? +status.Uid.split(/\s+/)[0] : null;
    let handles = 0;
    try { handles = fs.readdirSync(`/proc/${pid}/fd`).length; } catch (_) { /* izin yok */ }
    let file = null;
    if (exe) {
      try {
        const s = fs.statSync(`/proc/${pid}/exe`);
        file = { company: null, description: null, version: null, size: s.size, modified: Math.round(s.mtimeMs) };
      } catch (_) { /* silinmiş ikili */ }
    }
    const threads = [];
    try {
      for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
        const ts = parseStat(tryText(`/proc/${pid}/task/${tid}/stat`) || '');
        if (!ts) continue;
        const s = ts.state;
        threads.push({
          tid: +tid,
          cpuMs: Math.round(((ts.utime + ts.stime) * 1000) / HZ),
          priority: ts.priority,
          state: s === 'R' ? 'run' : (s === 'S' || s === 'D' || s === 'I') ? 'wait' : 'other',
          start: startMs(ts.starttime),
        });
      }
    } catch (_) { /* süreç bu arada bitti */ }
    const rssFile = kb(status.RssFile) + kb(status.RssShmem);
    return {
      pid, name: st.comm, path: exe, cmdline: cmdline || null,
      user: uid == null ? null : userName(uid),
      start: startMs(st.starttime),
      priority: niceToPriority(st.nice),
      arch: process.arch,
      elevated: uid === 0,
      suspended: st.state === 'T' || st.state === 't',
      ppid: st.ppid,
      counters: {
        handles, gdi: 0, user: 0, pageFaults: st.minflt + st.majflt,
        peakWs: kb(status.VmHWM), ws: st.rss * PAGE, priv: Math.max(0, st.rss * PAGE - rssFile), virt: st.vsize,
        ioReadOps: +(io.syscr || 0), ioWriteOps: +(io.syscw || 0), ioOtherOps: 0,
        ioReadBytes: +(io.read_bytes || 0), ioWriteBytes: +(io.write_bytes || 0), ioOtherBytes: 0,
        kernelMs: Math.round((st.stime * 1000) / HZ), userMs: Math.round((st.utime * 1000) / HZ),
      },
      file,
      threads,
      windows: [],
    };
  }

  // maps / smaps başlık satırı: "55d0c0a00000-55d0c0a21000 r--p 00000000 fd:01 1234  /usr/bin/x"
  const MAP_RE = /^([0-9a-f]+)-([0-9a-f]+) ([r-][w-][x-][ps]) [0-9a-f]+ \S+ \d+\s*(.*)$/;

  function modules({ pid }) {
    statOf(pid);
    let txt;
    try { txt = readText(`/proc/${pid}/maps`); } catch (e) { throw mapErr(e, 'maps'); }
    // Aynı dosyanın bitişik (ya da çok yakın) eşlemeleri tek modüldür; uzak bir adrese yeniden eşlenmişse ayrı satır
    const GAP = 16 << 20;
    const list = [];
    const last = new Map(); // yol → o yolun son modül girdisi
    for (const line of txt.split('\n')) {
      const m = MAP_RE.exec(line);
      if (!m || m[4][0] !== '/') continue;
      const start = parseInt(m[1], 16), end = parseInt(m[2], 16);
      const p = m[4].replace(/ \(deleted\)$/, '');
      const e = last.get(p);
      if (e && start <= e.end + GAP) { if (end > e.end) e.end = end; continue; }
      const n = { start, end, path: p };
      last.set(p, n);
      list.push(n);
    }
    list.sort((x, y) => x.start - y.start);
    return { modules: list.map((e) => ({ base: hex(e.start), size: e.end - e.start, path: e.path })) };
  }

  function memmap({ pid }) {
    statOf(pid);
    let txt;
    try { txt = readText(`/proc/${pid}/smaps`); } catch (e) { throw mapErr(e, 'smaps'); }
    const raw = [];
    const execPaths = new Set();
    let cur = null;
    for (const line of txt.split('\n')) {
      const m = MAP_RE.exec(line);
      if (m) {
        const start = parseInt(m[1], 16), end = parseInt(m[2], 16);
        if (start > MAX_ADDR) { cur = null; continue; } // vsyscall sayfası (2^53 üstü)
        cur = { start, end, perms: m[3], name: m[4], rss: 0 };
        if (cur.name[0] === '/' && cur.perms[2] === 'x') execPaths.add(cur.name);
        raw.push(cur);
      } else if (cur && line.startsWith('Rss:')) {
        cur.rss = parseInt(line.slice(4), 10) * 1024;
      }
    }
    const regions = [];
    const totals = { commit: 0, reserve: 0, free: 0, image: 0, mapped: 0, private: 0, ws: 0 };
    let cursor = 0x10000;
    const LIMIT = 200000;
    let truncated = false;
    for (const r of raw) {
      if (regions.length >= LIMIT) { truncated = true; break; }
      if (r.start > cursor) {
        regions.push([hex(cursor), r.start - cursor, 3, 0, 0, 0, '']);
        totals.free += r.start - cursor;
      }
      const size = r.end - r.start;
      const isFile = r.name[0] === '/';
      const type = isFile ? (execPaths.has(r.name) ? 3 : 2) : 1;
      // Erişimsiz (---p) eşleme: adres ayrılmış ama kullanılamaz → "reserve"
      const reserved = r.perms.startsWith('---');
      const state = reserved ? 2 : 1;
      regions.push([hex(r.start), size, state, reserved ? 0 : protectOf(r.perms), type, Math.round(r.rss / PAGE), r.name]);
      if (reserved) totals.reserve += size; else totals.commit += size;
      if (type === 3) totals.image += size; else if (type === 2) totals.mapped += size; else totals.private += size;
      totals.ws += r.rss;
      if (r.end > cursor) cursor = r.end;
    }
    if (!truncated && cursor < MAX_ADDR) {
      regions.push([hex(cursor), MAX_ADDR + 1 - cursor, 3, 0, 0, 0, '']);
      totals.free += MAX_ADDR + 1 - cursor;
    }
    const out = {
      pageSize: PAGE, min: hex(0x10000), max: hex(MAX_ADDR),
      cols: ['base', 'size', 'state', 'protect', 'type', 'wsPages', 'name'],
      regions, totals,
    };
    if (truncated) out.truncated = true;
    return out;
  }

  function readmem({ pid, addr, len }) {
    if (typeof addr !== 'string' || !/^[0-9a-f]{1,16}$/i.test(addr)) throw perr('bad_request', 'addr');
    if (!Number.isInteger(len) || len < 1 || len > MAX_IO) throw perr('bad_request', 'len');
    statOf(pid);
    let fd;
    try { fd = fs.openSync(`/proc/${pid}/mem`, 'r'); } catch (e) { throw mapErr(e, 'mem'); }
    try {
      const buf = Buffer.alloc(len);
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, len, BigInt('0x' + addr)); } catch (e) { throw perr('access', `read ${addr}: ${e.code || e.message}`); }
      if (n <= 0) throw perr('access', `read ${addr}: nothing readable`);
      return { addr: addr.toLowerCase(), len: n, b64: buf.subarray(0, n).toString('base64') };
    } finally {
      fs.closeSync(fd);
    }
  }

  function handles({ pid }) {
    statOf(pid);
    let names;
    try { names = fs.readdirSync(`/proc/${pid}/fd`); } catch (e) { throw mapErr(e, 'fd'); }
    const counts = {};
    const files = [];
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
    for (const n of names) {
      let target;
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${n}`); } catch (_) { continue; }
      if (target.startsWith('socket:')) bump('Socket');
      else if (target.startsWith('pipe:')) bump('Pipe');
      else if (target.startsWith('anon_inode:')) bump('Event');
      else if (target.startsWith('/dev/') || target.startsWith('/proc/') || target.startsWith('/sys/')) bump('Device');
      else if (target[0] === '/') {
        bump('File');
        const clean = target.replace(/ \(deleted\)$/, '');
        let kind = 'file', size = 0;
        try { const s = fs.statSync(`/proc/${pid}/fd/${n}`); kind = s.isDirectory() ? 'dir' : 'file'; size = kind === 'dir' ? 0 : s.size; } catch (_) { /* erişilemiyor */ }
        files.push({ h: hex(+n), path: clean, kind, size });
      } else bump('Other');
    }
    return { counts, files };
  }

  function mountOf(file) {
    const txt = tryText('/proc/self/mountinfo') || '';
    let best = '/';
    for (const line of txt.split('\n')) {
      const f = line.split(' ');
      const mp = f[4];
      if (!mp) continue;
      if ((file === mp || file.startsWith(mp === '/' ? '/' : mp + '/')) && mp.length > best.length) best = mp;
    }
    return best;
  }

  function filemap({ path: file }) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw perr('bad_request', 'path');
    let st, vfs;
    try { st = fs.statSync(file); vfs = fs.statfsSync(file); } catch (e) { throw mapErr(e, 'filemap'); }
    if (!st.isFile()) throw perr('unsupported', 'not a regular file');
    return new Promise((resolve, reject) => {
      execFile('filefrag', ['-v', '-b' + vfs.bsize, file], { timeout: 15000, maxBuffer: 16 << 20, env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/sbin:/sbin`, LC_ALL: 'C' } }, (err, stdout) => {
        if (err) return reject(perr(err.code === 'ENOENT' ? 'unsupported' : 'failed', `filefrag: ${err.code || err.message}`));
        const extents = [];
        let resident = false, truncated = false;
        //    0:        0..       3:    1234567..   1234570:      4:             last,eof
        const re = /^\s*\d+:\s*\d+\.\.\s*\d+:\s*(\d+)\.\.\s*\d+:\s*(\d+):\s*(?:\d+:)?\s*(.*)$/;
        for (const line of stdout.split('\n')) {
          const m = re.exec(line);
          if (!m) continue;
          const flags = m[3] || '';
          if (/inline/.test(flags)) { resident = true; continue; }
          if (/unknown|delalloc/.test(flags)) continue; // henüz diske yerleşmemiş
          if (extents.length >= 20000) { truncated = true; break; }
          extents.push([+m[1], +m[2]]);
        }
        const out = {
          path: file, volume: mountOf(file), clusterSize: vfs.bsize, totalClusters: vfs.blocks, freeClusters: vfs.bfree,
          size: st.size, extents, fragments: extents.length, resident,
        };
        if (truncated) out.truncated = true;
        resolve(out);
      });
    });
  }

  function readfile({ path: file, offset = 0, len }) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw perr('bad_request', 'path');
    if (!Number.isInteger(offset) || offset < 0) throw perr('bad_request', 'offset');
    if (!Number.isInteger(len) || len < 1 || len > MAX_IO) throw perr('bad_request', 'len');
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { throw mapErr(e, 'readfile'); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw perr('unsupported', 'not a regular file');
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, offset);
      return { offset, len: n, size: st.size, b64: buf.subarray(0, n).toString('base64') };
    } catch (e) {
      throw mapErr(e, 'readfile');
    } finally {
      fs.closeSync(fd);
    }
  }

  // Soket sahipliği: /proc/<pid>/fd içindeki "socket:[inode]" bağlantıları ↔ /proc/net/* tablolarının inode sütunu
  function netconns(args) {
    const pidOk = (v) => Number.isInteger(v) && v > 0;
    let pids;
    if (args.all === true) {
      pids = fs.readdirSync('/proc').filter((n) => n.charCodeAt(0) >= 48 && n.charCodeAt(0) <= 57).map(Number);
    } else if (Array.isArray(args.pids)) {
      if (args.pids.length > 256) throw perr('bad_request', "'pids' must be an array of at most 256 process ids");
      if (!args.pids.every(pidOk)) throw perr('bad_request', "invalid process id in 'pids'");
      pids = args.pids;
    } else if (pidOk(args.pid)) {
      pids = [args.pid];
    } else {
      throw perr('bad_request', "missing 'pid', 'pids' or 'all'");
    }
    const owner = new Map(); // inode → pid
    for (const pid of pids) {
      let fds;
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { continue; } // bitti ya da başka kullanıcının
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch (_) { continue; }
        if (link.startsWith('socket:[') && !owner.has(link.slice(8, -1))) owner.set(link.slice(8, -1), pid);
      }
    }
    const conns = [];
    let truncated = false;
    const add = (file, proto, v) => {
      if (!owner.size || truncated) return;
      for (const r of parseProcNet(tryText(file))) {
        const pid = owner.get(r.inode);
        if (!pid) continue;
        if (conns.length >= 2000) { truncated = true; return; }
        const listen = proto === 'tcp' && r.st === 10;
        const remote = proto === 'tcp' && !listen;
        conns.push({
          pid, proto, v, local: r.local, lport: r.lport, remote: remote ? r.remote : '', rport: remote ? r.rport : 0,
          state: proto === 'tcp' ? (LINUX_TCP_STATES[r.st] || 'unknown') : 'bound', rx: 0, tx: 0,
        });
      }
    };
    add('/proc/net/tcp', 'tcp', 4);
    add('/proc/net/tcp6', 'tcp', 6);
    add('/proc/net/udp', 'udp', 4);
    add('/proc/net/udp6', 'udp', 6);
    return { capture: false, conns, truncated };
  }
  const elevated = () => typeof process.getuid === 'function' && process.getuid() === 0;
  function netcap(args) {
    if (args.on === true) throw perr('unsupported', 'packet capture is Windows-only');
    return { capture: false, reason: 'unsupported', elevated: elevated(), ifaces: [], errors: [] };
  }

  function guardControl(pid) {
    if (!Number.isInteger(pid) || pid <= 2 || pid === process.pid) throw perr('bad_request', 'pid not allowed');
  }
  function signal(pid, sig) {
    guardControl(pid);
    try { process.kill(pid, sig); } catch (e) { throw mapErr(e, sig); }
    return { done: true };
  }
  function priority({ pid, value }) {
    guardControl(pid);
    if (!(value in PRIORITY_NICE)) throw perr('bad_request', 'value');
    try { os.setPriority(pid, PRIORITY_NICE[value]); } catch (e) { throw mapErr(e, 'priority'); }
    return { done: true };
  }

  const commands = {
    hello,
    snapshot,
    detail: (a) => detail(a),
    modules,
    memmap,
    readmem,
    handles,
    filemap,
    readfile,
    volmap: () => { throw perr('unsupported', 'volume bitmap is Windows-only'); },
    capture: () => { throw perr('unsupported', 'window capture is Windows-only'); },
    netcap,
    netconns,
    netwatch: () => { throw perr('unsupported', 'packet capture is Windows-only'); },
    netstream: () => { throw perr('unsupported', 'packet capture is Windows-only'); },
    gpudetail: () => { throw perr('unsupported', 'no GPU counters'); },
    kill: ({ pid }) => signal(pid, 'SIGKILL'),
    suspend: ({ pid }) => signal(pid, 'SIGSTOP'),
    resume: ({ pid }) => signal(pid, 'SIGCONT'),
    priority,
  };
  const NEEDS_PID = new Set(['detail', 'modules', 'memmap', 'readmem', 'handles', 'gpudetail', 'kill', 'suspend', 'resume', 'priority']);

  async function request(cmd, args = {}) {
    const fn = commands[cmd];
    if (!fn) throw perr('bad_request', `unknown command: ${cmd}`);
    if (NEEDS_PID.has(cmd) && !(Number.isInteger(args.pid) && args.pid > 0)) throw perr('bad_request', 'pid');
    try {
      return await fn(args);
    } catch (e) {
      throw mapErr(e, cmd);
    }
  }

  return {
    kind: 'linux',
    start: async () => hello(),
    request,
    stop: () => {},
    onExit: (cb) => { exitCbs.push(cb); },
  };
}

module.exports = { createProvider, parseStat, protectOf, niceToPriority, procAddr, parseProcNet, parseNetDev };
