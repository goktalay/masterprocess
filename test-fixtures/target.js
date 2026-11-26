'use strict';
// Uçtan uca sınama hedefi: bilinen bir dosyayı açık tutar, bellekte bilinen bir dizge barındırır, düzenli olarak biraz
// işlemci ve dosya G/Ç'si üretir ve (istenirse) bir alt süreç başlatır. Yalnız scripts/ altındaki sınama betikleri çalıştırır.
// Kullanım: node target.js <dosya> [--child]
const fs = require('fs');
const { spawn } = require('child_process');

const file = process.argv[2];
const MARK = 'MASTER PROCESS E2E TARGET';
if (file && !process.argv.includes('--leaf')) {
  const line = Buffer.from(`${MARK} — bu dosya uçtan uca sınama için yazıldı.\n`);
  const fd0 = fs.openSync(file, 'w');
  for (let i = 0; i < 40000; i++) fs.writeSync(fd0, line);
  fs.fsyncSync(fd0); // diskteki yerleşimi hemen oluşsun
  fs.closeSync(fd0);
}
const fd = file ? fs.openSync(file, 'r') : null;
const keep = Buffer.alloc(8 * 1024 * 1024, MARK + ' ');
const buf = Buffer.alloc(256 * 1024);
let child = null;
if (process.argv.includes('--child')) child = spawn(process.execPath, [__filename, file, '--leaf'], { stdio: 'ignore' });
let pos = 0;
setInterval(() => {
  // ~%10–15 tek çekirdek + sıralı okuma
  const until = Date.now() + 12;
  let x = 0;
  while (Date.now() < until) x += Math.sqrt(x + keep[x & 1023]);
  if (fd !== null) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    pos = n < buf.length ? 0 : pos + n;
  }
}, 100);
// Alt süreç, üst süreç zorla sonlandırılırsa yetim kalmaz
if (process.argv.includes('--leaf')) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
    try { process.kill(parent, 0); } catch { process.exit(0); }
  }, 1000);
}
process.on('SIGTERM', () => { if (child) child.kill(); process.exit(0); });
process.stdout.write(`ready ${process.pid}\n`);
