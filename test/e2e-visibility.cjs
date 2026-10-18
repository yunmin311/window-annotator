// Real Electron windows and main loop; only Windows OS / persistent user data boundaries are replaced.
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow, screen, net, dialog, shell } = require('electron');
// Native Windows DPI conversion is outside this Linux integration test.
app.whenReady().then(() => {
  if (process.platform !== 'win32') screen.screenToDipRect = (_win, rect) => rect;
});
process.on('uncaughtException', err => { console.error(err); app.exit(1); });
// Win32 HWND is 8 bytes; X11 returns a 4-byte native handle.
if (process.platform !== 'win32') {
  const nativeHandle = BrowserWindow.prototype.getNativeWindowHandle;
  BrowserWindow.prototype.getNativeWindowHandle = function () {
    const original = nativeHandle.call(this), handle = Buffer.alloc(8);
    original.copy(handle); return handle;
  };
}
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fg = 100n;
const stub = (name, exports) => { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../src/win32', {
  hkey: String, same: (a,b) => a === b,
  getForegroundWindow: () => fg, setForegroundWindow: hwnd => { fg = hwnd; },
  getWindowState: () => ({ rect: { x:20,y:20,width:800,height:500 }, minimized:false,cloaked:false }),
  getWindowInfo: () => ({exe:'fixture.exe',title:'Visibility test'}),
});
stub('../src/scroll-uia', { start() {}, stop() {}, getRegions: () => [] });
stub('../src/store', { load: () => [], save() {} });
stub('../src/settings', { get: (key,dflt) => dflt, set() {} });
const main = require('../main');
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 30000);
app.whenReady().then(async () => {
  try {
    assert.equal(typeof main.toggleVisibility, 'function', 'global hide/restore behavior must exist');
    main.createOverlay(100n, {exe:'fixture.exe',title:'Visibility test'});
    const o = main.overlays.get('100');
    await new Promise(resolve => o.win.webContents.once('did-finish-load', resolve));
    await sleep(100);
    assert.equal(o.visible, true);
    await o.win.webContents.executeJavaScript(`addItem({id:99,type:'pen',color:'red',points:[[100,200],[200,200]]})`);
    main.toggleVisibility();
    assert.equal(o.win.isVisible(), false, 'shortcut hides entire overlay');
    await sleep(250);
    assert.equal(o.win.isVisible(), false, 'tracking must not immediately re-show hidden overlays');
    assert.equal(main.trayMenuState().hidden, true);
    main.toggleVisibility(); await sleep(100);
    assert.equal(o.win.isVisible(), true, 'same shortcut restores overlay');
    assert.equal(o.drawMode, true, 'restore preserves editing mode');
    assert.equal(await o.win.webContents.executeJavaScript('items.length'), 1, 'hide/restore retains annotations');
    main.setDrawMode(o, false); main.toggleVisibility(); main.toggleVisibility(); await sleep(80);
    assert.equal(o.drawMode, false, 'restore also preserves viewing mode');
    main.toggleVisibility(); main.toggleAnnotate(); await sleep(80);
    assert.equal(main.trayMenuState().hidden, false, 'annotate shortcut can resume from hidden state');
    assert.equal(o.drawMode, true);
    assert.ok(main.trayMenuState().visibilityKey, 'actual global shortcut appears in menu state');
    // Exercise the actual tray renderer -> IPC -> checker -> OS dialog boundary.
    const http = require('node:http');
    const redirectServer = http.createServer((req,res) => {
      if (req.url === '/latest') { res.writeHead(302,{Location:'/tag/v0.3.0'}); res.end(); }
      else { res.writeHead(200); res.end(); }
    });
    await new Promise(resolve => redirectServer.listen(0,'127.0.0.1',resolve));
    try {
      const base = `http://127.0.0.1:${redirectServer.address().port}`;
      const transport = require('../src/update-fetch')(net);
      const response = await transport(`${base}/latest`,{method:'HEAD',signal:new AbortController().signal});
      assert.equal(response.url,`${base}/tag/v0.3.0`, 'native transport preserves final release URL');
      assert.equal(response.ok,true);
    } finally { redirectServer.closeAllConnections(); await new Promise(resolve=>redirectServer.close(resolve)); }

    let responseStatus = 200, releaseTag = 'v0.3.0', requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      setTimeout(() => { res.writeHead(responseStatus, { 'Content-Type':'application/json' });
        res.end(JSON.stringify({ tag_name:releaseTag, html_url:`https://github.com/yunmin311/window-annotator/releases/tag/${releaseTag}` })); }, 30);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const originalFetch = net.fetch.bind(net);
    const originalRequest = net.request.bind(net);
    net.request = options => originalRequest({...options, url:`http://127.0.0.1:${server.address().port}`});
    net.fetch = (_url, options) => originalFetch(`http://127.0.0.1:${server.address().port}`, options);
    const dialogs = [], opened = [];
    dialog.showMessageBox = async options => { dialogs.push(options); await sleep(50); return { response:0 }; };
    shell.openExternal = async url => { opened.push(url); };
    const menu = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('tray-menu/menu.html'));
    if (menu.webContents.isLoading()) await new Promise(resolve => menu.webContents.once('did-finish-load', resolve));
    const clickUpdate = () => menu.webContents.executeJavaScript(`document.querySelector('[data-action="check-updates"]').click()`);
    const waitDialogs = async count => {
      for (let i=0;i<100 && dialogs.length<count;i++) await sleep(20);
      assert.equal(dialogs.length, count); await sleep(80);
    };
    try {
      await clickUpdate(); await clickUpdate(); await waitDialogs(1);
      assert.equal(requests, 1, 'rapid clicks share one update request');
      assert.match(dialogs[0].message, /0.3.0/);
      assert.equal(opened[0], 'https://github.com/yunmin311/window-annotator/releases/tag/v0.3.0');
      responseStatus=403;
      await clickUpdate(); await waitDialogs(2);
      assert.match(dialogs[1].message, /无法检查/);
      assert.match(dialogs[1].detail, /访问次数限制/);
      assert.equal(opened[1], 'https://github.com/yunmin311/window-annotator/releases');
      responseStatus=200; releaseTag='v0.2.0';
      await clickUpdate(); await waitDialogs(3);
      assert.match(dialogs[2].message, /没有更新/);
      assert.equal(opened.length, 2, 'current version does not open a download');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    console.log('ALL PASS - tray update checks: available, coalescing, rate limit, release fallback, current');
    console.log('ALL PASS - hide, stay hidden, restore modes, retain ink, resume annotation, shortcut state');
    BrowserWindow.getAllWindows().forEach(w => w.destroy()); app.exit(0);
  } catch(e) { console.error(e); app.exit(1); }
});
