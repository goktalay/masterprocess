'use strict';

// Windows sağlayıcısı: yerel yardımcıyı (mp-agent.exe) çocuk süreç olarak çalıştırır ve stdin/stdout üzerinden
// satır başına bir JSON ile konuşur — bkz. docs/agent-protocol.md.
//
// İki yardımcı örneği kullanılır: "monitor" yalnız periyodik anlık görüntüyü (ve aynı sayaç durumuna dayanan GPU
// ayrıntısını) yanıtlar; "query" seçili sürecin ağır sorgularını (bellek haritası, tanıtıcılar, pencere görüntüsü…)
// yanıtlar. Yardımcı istekleri sırayla işlediği için tek örnekte birkaç saniyelik bir sorgu canlı listeyi dondururdu.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT = 30000;
const MONITOR_CMDS = new Set(['hello', 'snapshot', 'gpudetail']);
const MAX_RESTARTS = 5; // RESTART_WINDOW içinde
const RESTART_WINDOW = 60000;

function perr(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

function agentPath() {
  if (process.env.MP_AGENT) return process.env.MP_AGENT;
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'agent', 'mp-agent.exe') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'agent-out', 'mp-agent.exe');
}

// Tek yardımcı süreciyle istek/yanıt eşlemesi
function createAgentClient({ exe, args = [], name = 'agent', onDown = () => {}, spawnFn = spawn }) {
  let child = null;
  let nextId = 1;
  let buf = '';
  let stopped = false;
  let stderrTail = '';
  const pending = new Map(); // id → { resolve, reject, timer }
  const starts = [];

  function failAll(code, msg) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(perr(code, msg)); }
    pending.clear();
  }

  function onLine(line) {
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch (_) { return; } // protokol dışı satır: yok say
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.data);
    else p.reject(perr(m.err || 'failed', m.msg || m.err || 'failed'));
  }

  function ensure() {
    if (child) return;
    if (stopped) throw perr('failed', `${name}: stopped`);
    const now = Date.now();
    while (starts.length && now - starts[0] > RESTART_WINDOW) starts.shift();
    if (starts.length >= MAX_RESTARTS) throw perr('failed', `${name}: helper keeps exiting${stderrTail ? ` (${stderrTail.trim().slice(-200)})` : ''}`);
    starts.push(now);
    buf = '';
    const c = spawnFn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = c;
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
    c.stdin.on('error', () => {}); // yardımcı kapandıysa EPIPE: çıkış olayı zaten ele alır
    const down = (why) => {
      if (child !== c) return;
      child = null;
      failAll('failed', `${name}: helper exited (${why})`);
      if (!stopped) onDown(why);
    };
    c.on('error', (e) => down(e.code || e.message));
    c.on('exit', (code, sig) => down(sig || `code ${code}`));
  }

  function request(cmd, a = {}, timeout = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      try { ensure(); } catch (e) { return reject(e); }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(perr('timeout', `${cmd}: no answer in ${timeout} ms`));
        // Yanıtsız yardımcı sırayı tıkar: öldür, sonraki istekte yeniden başlasın
        if (child) { try { child.kill(); } catch (_) { /* zaten çıkmış */ } }
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, cmd, ...a }) + '\n');
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(perr('failed', `${name}: ${e.message}`));
      }
    });
  }

  function stop() {
    stopped = true;
    const c = child;
    child = null;
    failAll('failed', `${name}: stopped`);
    if (c) {
      try { c.stdin.end(); } catch (_) { /* kapalı */ }
      setTimeout(() => { try { c.kill(); } catch (_) { /* çıkmış */ } }, 500).unref();
    }
  }

  return { request, stop, running: () => !!child, stderr: () => stderrTail };
}

function createProvider({ exe = agentPath(), spawnFn } = {}) {
  const exitCbs = [];
  const notify = (who) => (why) => { for (const cb of exitCbs) { try { cb({ who, why }); } catch (_) { /* dinleyici hatası */ } } };
  const monitor = createAgentClient({ exe, name: 'monitor', onDown: notify('monitor'), spawnFn });
  const query = createAgentClient({ exe, name: 'query', onDown: notify('query'), spawnFn });

  return {
    kind: 'win',
    exe,
    start: () => {
      if (!fs.existsSync(exe)) return Promise.reject(perr('unsupported', `helper not found: ${exe}`));
      return monitor.request('hello', {}, 15000);
    },
    request: (cmd, args, timeout) => (MONITOR_CMDS.has(cmd) ? monitor : query).request(cmd, args, timeout),
    stop: () => { monitor.stop(); query.stop(); },
    onExit: (cb) => { exitCbs.push(cb); },
  };
}

module.exports = { createProvider, createAgentClient, agentPath };
