'use strict';
// Sınama için sahte yardımcı: mp-agent protokolünün çerçevesini konuşur (gerçek veri üretmez).
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stderr.write('fake agent up\n');
const net = { on: false, watch: [] }; // ağ komutlarının durumu (yakalama yapılmaz: yalnız çerçeve)
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch (_) { return out({ id: 0, ok: false, err: 'bad_request', msg: 'json' }); }
  switch (m.cmd) {
    case 'hello': return out({ id: m.id, ok: true, data: { agent: 'fake', protocol: 1, pid: process.pid, elevated: false, net: true } });
    case 'snapshot': if (m.crash) return process.exit(4); return out({ id: m.id, ok: true, data: { t: 1, sys: {}, cols: ['pid'], procs: [[process.pid]] } });
    case 'detail': return out({ id: m.id, ok: true, data: { pid: m.pid, agentPid: process.pid } });
    case 'kill': return out({ id: m.id, ok: false, err: 'access', msg: 'denied (5)' });
    case 'noise': process.stdout.write('not json\n'); return out({ id: m.id, ok: true, data: { fine: true } });
    case 'split': {
      // Yanıtı iki parçada yaz: satır tamponlaması sınanır
      const s = JSON.stringify({ id: m.id, ok: true, data: { big: 'x'.repeat(5000) } }) + '\n';
      process.stdout.write(s.slice(0, 100));
      return setTimeout(() => process.stdout.write(s.slice(100)), 30);
    }
    case 'netcap':
      if (typeof m.on === 'boolean') { net.on = m.on; if (!m.on) net.watch = []; }
      return out({ id: m.id, ok: true, data: { capture: net.on, reason: net.on ? 'ok' : 'off', elevated: false, ifaces: [], errors: [], agentPid: process.pid } });
    case 'netconns': return out({ id: m.id, ok: true, data: { capture: net.on, conns: [], truncated: false } });
    case 'netwatch':
      net.watch = Array.isArray(m.pids) ? m.pids : m.pid ? [m.pid] : [];
      return out({ id: m.id, ok: true, data: { watch: net.watch, capture: net.on, next: 0 } });
    case 'netstream':
      return out({ id: m.id, ok: true, data: { watch: net.watch, capture: net.on, now: 1, first: 0, dropped: 0, chunks: [], next: 0, more: false, agentPid: process.pid } });
    case 'volmap': return out({ id: m.id, ok: false, err: 'unsupported', msg: 'no volume bitmap' });
    case 'slow': return; // hiç yanıtlama
    case 'crash': return process.exit(3);
    default: return out({ id: m.id, ok: false, err: 'bad_request', msg: 'unknown' });
  }
});
rl.on('close', () => process.exit(0));
