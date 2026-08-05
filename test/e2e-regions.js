// Feasibility probe for multi-region follow. Forces Chromium to always build its accessibility tree
// (--force-renderer-accessibility) so UIA can read a window BY HANDLE even when it is not foreground,
// sidestepping both the foreground-lock and Chromium's lazy-AX. Two separate windows, two scenarios:
//   (1) document-level scroll (whole page scrolls) -> UIA must see the doc scroller (proves probe works)
//   (2) nested 2-pane page (two overflow:auto divs)  -> does Chromium expose the nested scrollers to UIA?
// If (1) sees a big scroller but (2) does not see >=2 big scrollers, multi-region follow is NOT viable
// for web content (Chromium exposes only the root document scroller, not nested overflow containers).
// Run: electron test/e2e-regions.js   (results also in E2E_OUT/regions-result.txt)
'use strict';
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-renderer-accessibility'); // build the AX tree even when not foreground
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.E2E_OUT || __dirname;

const RESULT = path.join(OUT, 'regions-result.txt');
try { fs.writeFileSync(RESULT, 'regions probe start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
setTimeout(() => { logf('REGIONS TIMEOUT'); app.exit(2); }, 30000);

const DOC = '<!doctype html><body style="margin:0"><div style="height:6000px;background:linear-gradient(#fff,#333)">tall document</div></body>';
const PANES = '<!doctype html><body style="margin:0;display:flex;font-family:sans-serif">' +
  '<div id="a" style="width:50%;height:100vh;overflow:auto;border-right:2px solid #333"><div style="height:4000px;background:linear-gradient(#eef,#33f)">LEFT</div></div>' +
  '<div id="b" style="width:50%;height:100vh;overflow:auto"><div style="height:4000px;background:linear-gradient(#fee,#f33)">RIGHT</div></div>' +
  '</body>';

function probe(hwnd, label) {
  const p = spawnSync('powershell.exe',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', path.join(__dirname, 'uia-regions-probe.ps1'), '-Hwnd', String(hwnd)],
    { encoding: 'utf8', windowsHide: true });
  const out = (p.stdout || '').trim();
  logf(`--- ${label} (hwnd ${hwnd}) ---`);
  logf(out || '(empty)');
  if (p.stderr && p.stderr.trim()) logf('stderr: ' + p.stderr.trim());
  const big = out.split(/\r?\n/).filter((l) => { const m = l.match(/^REGION .* w=(-?\d+) h=(-?\d+)/); return m && Math.abs(+m[1] * +m[2]) > 10000; });
  return { total: (out.match(/REGION/g) || []).length, big: big.length };
}

app.whenReady().then(async () => {
  const docFile = path.join(OUT, 'rgn-doc.html'); fs.writeFileSync(docFile, DOC);
  const panesFile = path.join(OUT, 'rgn-panes.html'); fs.writeFileSync(panesFile, PANES);

  const docWin = new BrowserWindow({ x: 80, y: 60, width: 900, height: 680, title: 'RgnDoc', backgroundColor: '#ffffff' });
  const panesWin = new BrowserWindow({ x: 1000, y: 60, width: 1000, height: 700, title: 'RgnPanes', backgroundColor: '#ffffff' });
  await docWin.loadFile(docFile);
  await panesWin.loadFile(panesFile);
  const dh = docWin.getNativeWindowHandle().readBigInt64LE(0);
  const ph = panesWin.getNativeWindowHandle().readBigInt64LE(0);
  await sleep(2000); // let both AX trees build (force-renderer-accessibility on)
  await docWin.webContents.executeJavaScript('window.scrollTo(0, 2000); true');
  await panesWin.webContents.executeJavaScript("document.getElementById('a').scrollTop=1500; document.getElementById('b').scrollTop=300; true");
  await sleep(700);

  const rd = probe(dh, 'scenario 1: document scroll');
  logf(`scenario 1 -> big(area>1e4)=${rd.big} (expect the doc scroller)`);
  const rp = probe(ph, 'scenario 2: nested two-pane');
  logf(`scenario 2 -> big(area>1e4)=${rp.big} (want >=2 for multi-region to be viable)`);
  logf(`SUMMARY: doc big=${rd.big}, panes big=${rp.big}`);
  app.exit(0);
}).catch((e) => { logf('REGIONS ERROR: ' + (e && e.stack || e)); app.exit(3); });
