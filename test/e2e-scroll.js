// Integration test for "follow page scroll": a REAL tall scrollable window -> UIA reader reads its
// real scroll -> the annotation on the overlay actually moves. Exercises the whole chain end to end
// (reader multi-region -> main.computeRegions -> overlay per-region follow), which the unit/DOM checks
// only cover in pieces. Single-region case (one tall page => one region). Run: electron test/e2e-scroll.js
'use strict';
process.env.WA_TEST = '1'; // 放行单实例锁,便于开着正式版时也能跑
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const main = require('../main.js');
const win32 = require('../src/win32');
const scrollUia = require('../src/scroll-uia');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Write results to a file too (flushed per line) so they survive stdout buffering / task kills.
const RESULT = path.join(process.env.E2E_OUT || __dirname, 'scroll-result.txt');
try { fs.writeFileSync(RESULT, 'scroll e2e start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };

setTimeout(() => { logf('SCROLL E2E TIMEOUT'); app.exit(2); }, 38000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const target = new BrowserWindow({
    x: 120, y: 80, width: 900, height: 700, title: 'ScrollTestTarget', backgroundColor: '#ffffff',
  });
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0"><div style="height:6000px;background:linear-gradient(#fff,#333)">tall content</div></body>'));
  app.focus({ steal: true }); // 强制本进程到前台:躲开 Windows 前台锁(自动化下 focus() 常被拦,窗口拿不到前台)
  target.focus();
  await sleep(1500);

  const thwnd = target.getNativeWindowHandle().readBigInt64LE(0);
  const info = win32.getWindowInfo(thwnd);
  main.createOverlay(thwnd, info);
  const o = main.overlays.get(win32.hkey(thwnd));
  check('overlay created', !!o);
  if (!o) { app.exit(1); return; }
  for (let t = 0; t < 150 && !(o.drawMode && o.visible); t++) await sleep(100);
  check('entered draw mode', o.drawMode === true);

  const wc = o.win.webContents;
  // capture the binding-status the main process pushes to the overlay ('scroll' once UIA locks on)
  await wc.executeJavaScript("window.__lastBind=null; require('electron').ipcRenderer.on('bind-state',(e,s)=>{window.__lastBind=s;}); true");

  // draw one short stroke, then leave to view mode (that hands foreground back to the target)
  const send = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra });
  send('mouseDown', 300, 300);
  for (let i = 0; i <= 8; i++) { send('mouseMove', 300 + i * 10, 300, { buttons: 1 }); await sleep(12); }
  send('mouseUp', 380, 300);
  await sleep(300);
  main.setDrawMode(o, false);
  await sleep(400);

  scrollUia.start();       // reader is on by default now, but be explicit for the test
  app.focus({ steal: true });
  target.focus();          // ensure target is the foreground the reader reads
  await sleep(1400);       // let the reader locate the scroll element + take a reading

  const r1 = scrollUia.get(thwnd);
  check(`UIA reads target scroll (percent=${r1 && r1.percent}, viewsize=${r1 && r1.viewsize}, vpPx=${r1 && r1.viewportPx})`,
    !!r1 && r1.viewsize > 0.1 && r1.viewsize < 99 && r1.percent >= 0 && r1.viewportPx > 0);
  const regs1 = scrollUia.getRegions(thwnd);
  check(`UIA reports region(s) (n=${regs1 && regs1.length})`, !!regs1 && regs1.length > 0);

  // 读被画出的那一笔当前的平移量(它所在区的 dy),和主进程发来的最大区位移
  const annoDy = () => wc.executeJavaScript(`(() => {
    const el = document.querySelector('#ink-layer path'); if (!el) return null;
    const m = (el.getAttribute('transform') || '').match(/translate\\(0 (-?[0-9.]+)\\)/);
    return m ? parseFloat(m[1]) : 0;
  })()`);
  const maxOff = () => wc.executeJavaScript('(typeof liveRegions!=="undefined"&&liveRegions.length)?Math.max.apply(null,liveRegions.map(function(r){return r.off;})):0');

  const dy0 = await annoDy();

  await target.webContents.executeJavaScript('window.scrollTo(0, 3000)');
  await sleep(1600);       // reader poll (45ms) + main tick + easing settle

  const r2 = scrollUia.get(thwnd);
  const dy1 = await annoDy();
  const off1 = await maxOff();
  logf(`after scrollTo(3000): percent ${r1 && r1.percent} -> ${r2 && r2.percent}; region off -> ${off1}; annotation dy ${dy0} -> ${dy1}`);
  check('reader saw the scroll (percent grew)', !!r2 && r2.percent > 5);
  check('a region reports a large scroll offset', off1 > 100);
  check('annotation followed its region (transform dy moved a lot)', dy0 != null && dy1 != null && Math.abs(dy1 - dy0) > 100);

  const bind = await wc.executeJavaScript('window.__lastBind');
  logf('overlay bind-state = ' + bind);
  check('main told the overlay it is scroll-following (bind-state=scroll)', bind === 'scroll');

  scrollUia.stop();
  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('SCROLL E2E ERROR: ' + (e && e.stack || e)); app.exit(3); });
