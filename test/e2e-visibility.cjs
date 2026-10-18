// Real Electron windows and main loop; only Windows OS / persistent user data boundaries are replaced.
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow, screen, net, dialog, shell, Tray } = require('electron');
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
let tray;
const trayOn = Tray.prototype.on;
Tray.prototype.on = function (...args) { tray = this; return trayOn.apply(this,args); };
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
    const stallServer = http.createServer(() => {});
    await new Promise(resolve => stallServer.listen(0,'127.0.0.1',resolve));
    const dialogs = [], opened = [];
    // A native modal may never settle when hidden behind a screen-saver-level menu.
    // Updates must remain usable even in that case; do not stub it as immediately closed.
    dialog.showMessageBox = options => { dialogs.push(options); return new Promise(() => {}); };
    shell.openExternal = async url => { opened.push(url); };
    const menu = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('tray-menu/menu.html'));
    if (menu.webContents.isLoading()) await new Promise(resolve => menu.webContents.once('did-finish-load', resolve));
    const click = action => menu.webContents.executeJavaScript(`document.querySelector('[data-action="${action}"]').click()`);
    const waitLabel = async pattern => {
      for (let i=0;i<230 && !pattern.test(main.trayMenuState().updateLabel);i++) await sleep(100);
      assert.match(main.trayMenuState().updateLabel,pattern);
      await sleep(40);
      assert.match(await menu.webContents.executeJavaScript("document.getElementById('tx-update').textContent"),pattern);
    };
    try {
      const opacityChanges = [], setOpacity = menu.setOpacity.bind(menu);
      menu.setOpacity = value => { opacityChanges.push(value); return setOpacity(value); };
      tray.emit('click'); await sleep(80); opacityChanges.length = 0;
      await click('check-updates'); await click('check-updates');
      await waitLabel(/0.3.0/);
      assert.equal(requests,1,'rapid clicks share one request');
      assert.equal(dialogs.length,0,'checking must never open a blocking native dialog');
      assert.ok(!opacityChanges.includes(0),'results stay inside the open menu');
      await click('open-release'); await sleep(50);
      assert.equal(opened.at(-1),'https://github.com/yunmin311/window-annotator/releases/tag/v0.3.0');
      responseStatus=403;
      tray.emit('click'); await click('check-updates'); await waitLabel(/检查失败/);
      assert.match(main.trayMenuState().updateDetail,/访问次数限制/);
      assert.equal(dialogs.length,0,'errors do not block retries with a modal');
      responseStatus=200; releaseTag='v0.2.0';
      await click('check-updates'); await waitLabel(/没有更新/);
      const workingFetch = net.fetch, workingRequest = net.request;
      net.fetch = () => new Promise(() => {});
      net.request = options => originalRequest({...options,url:`http://127.0.0.1:${stallServer.address().port}`});
      await click('check-updates'); await sleep(30);
      assert.match(main.trayMenuState().updateLabel,/正在检查/);
      await waitLabel(/检查失败/);
      assert.match(main.trayMenuState().updateDetail,/超时/);
      net.fetch = workingFetch; net.request = workingRequest;
      await click('check-updates'); await waitLabel(/没有更新/);
      assert.equal(dialogs.length,0,'repeated checks never use native modals');
      shell.openExternal = async () => { throw new Error('fixture: browser unavailable'); };
      await click('open-release'); await waitLabel(/检查失败/);
      assert.match(main.trayMenuState().updateDetail,/浏览器/);
      await click('check-updates'); await waitLabel(/没有更新/);
    } finally { stallServer.closeAllConnections(); stallServer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    console.log('ALL PASS - inline results, no modal dialogs, coalescing, failure/retry, timeout/recovery, browser failure');
    console.log('ALL PASS - hide, stay hidden, restore modes, retain ink, resume annotation, shortcut state');
    BrowserWindow.getAllWindows().forEach(w => w.destroy()); app.exit(0);
  } catch(e) { console.error(e); app.exit(1); }
});
