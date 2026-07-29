// Window Annotator — 给任意 Windows 窗口贴手绘标注,标注跟着窗口走
// Ctrl+Alt+A: 给当前窗口开/关标注模式   Ctrl+Alt+Q: 退出程序
'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, Notification, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const win32 = require('./src/win32');
const store = require('./src/store');
const settings = require('./src/settings');

// 滚轮一格(WHEEL_DELTA=120)平移多少像素——不同软件滚动步长不同,给三档可调
let scrollPxPerNotch = settings.get('scrollPxPerNotch', 100);

// key = 目标窗口 hwnd 字符串 -> { win, overlayHwnd, target, storeKey, drawMode, visible, lastBounds }
const overlays = new Map();

function storeKeyOf(info) {
  return `${info.exe}|${info.title}`;
}

function createOverlay(targetHwnd, info) {
  const state = win32.getWindowState(targetHwnd);
  if (!state || !state.rect) return;

  const win = new BrowserWindow({
    x: 0, y: 0, width: 400, height: 300,
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, fullscreenable: false,
    type: 'toolbar', show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);

  const o = {
    win,
    overlayHwnd: win.getNativeWindowHandle().readBigInt64LE(0),
    target: targetHwnd,
    storeKey: storeKeyOf(info),
    info,
    drawMode: false,
    visible: false,
    lastBounds: null,
  };
  overlays.set(win32.hkey(targetHwnd), o);

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('init', {
      items: store.load(o.storeKey),
      appName: info.exe.replace(/\.exe$/i, ''),
    });
    applyBounds(o, state.rect);
    win.showInactive();
    o.visible = true;
    setDrawMode(o, true);
  });
  win.on('closed', () => overlays.delete(win32.hkey(targetHwnd)));
  win.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
}

function applyBounds(o, physRect) {
  const dip = screen.screenToDipRect(o.win, {
    x: physRect.x, y: physRect.y, width: physRect.width, height: physRect.height,
  });
  const b = {
    x: Math.round(dip.x), y: Math.round(dip.y),
    width: Math.max(1, Math.round(dip.width)), height: Math.max(1, Math.round(dip.height)),
  };
  const k = `${b.x},${b.y},${b.width},${b.height}`;
  if (o.lastBounds === k) return;
  o.lastBounds = k;
  o.win.setBounds(b);
}

function setDrawMode(o, on) {
  if (o.drawMode === on) return;
  o.drawMode = on;
  if (on) {
    o.win.setIgnoreMouseEvents(false);
    o.win.focus();
  } else {
    o.win.setIgnoreMouseEvents(true, { forward: true });
    win32.setForegroundWindow(o.target); // 把焦点还给目标窗口
  }
  o.win.webContents.send('mode', on ? 'draw' : 'view');
}

// 快捷键:前台是已贴标注的窗口 -> 切换标注模式;是新窗口 -> 贴上并进入标注模式
function toggleAnnotate() {
  const fg = win32.getForegroundWindow();
  for (const o of overlays.values()) {
    if (win32.same(o.overlayHwnd, fg)) { setDrawMode(o, false); return; }
  }
  const key = win32.hkey(fg);
  const existing = overlays.get(key);
  if (existing) { setDrawMode(existing, !existing.drawMode); return; }

  const info = win32.getWindowInfo(fg);
  if (!info || !info.exe || info.exe.toLowerCase() === 'explorer.exe' && !info.title) return;
  createOverlay(fg, info);
}

// 追踪循环:跟随移动/缩放,目标最小化或失去前台就藏起来;查看模式下把滚轮换算成标注平移
function tick() {
  if (!overlays.size) return;
  const fg = win32.getForegroundWindow();
  const wheel = win32.takeWheel(); // 系统级累积的滚轮增量(单位 120/格)
  for (const [key, o] of overlays) {
    const state = win32.getWindowState(o.target);
    if (!state) { // 目标窗口关闭
      o.win.destroy();
      overlays.delete(key);
      continue;
    }
    const active = win32.same(fg, o.target) || win32.same(fg, o.overlayHwnd);
    const shouldShow = !state.minimized && !state.cloaked && state.rect && active;
    if (shouldShow) {
      applyBounds(o, state.rect);
      if (!o.visible) { o.win.showInactive(); o.visible = true; }
      // 只在查看模式、且滚的正是这个目标窗口时,跟随滚动平移标注
      if (wheel && !o.drawMode && win32.same(fg, o.target)) {
        o.win.webContents.send('scroll', -(wheel / 120) * scrollPxPerNotch);
      }
    } else {
      if (o.drawMode && !win32.same(fg, o.overlayHwnd)) setDrawMode(o, false);
      if (o.visible) { o.win.hide(); o.visible = false; }
    }
  }
}

function overlayOf(sender) {
  for (const o of overlays.values()) if (o.win.webContents === sender) return o;
  return null;
}

ipcMain.on('annotations-changed', (e, items) => {
  const o = overlayOf(e.sender);
  if (o) store.save(o.storeKey, items);
});
ipcMain.on('exit-draw', (e) => { const o = overlayOf(e.sender); if (o) setDrawMode(o, false); });
ipcMain.on('enter-draw', (e) => { const o = overlayOf(e.sender); if (o) setDrawMode(o, true); });
ipcMain.on('set-ignore', (e, ignore) => {
  const o = overlayOf(e.sender);
  if (o && !o.drawMode) o.win.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
});

// 快捷键注册:首选组合被别的软件占了(QQ 截图就是 Ctrl+Alt+A)就顺着备用链找,并明确告知
function registerHotkey(candidates, fn) {
  for (const c of candidates) {
    try { if (globalShortcut.register(c, fn)) return c; } catch { /* 无效组合跳过 */ }
  }
  return null;
}

// 开机自启:交给系统的登录项(注册表 Run 键),自己不用记状态
function isAutoStart() {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function setAutoStart(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [path.resolve(__dirname)] });
}

let tray = null;
let trayKeys = { annotateKey: null, quitKey: null };

function buildTrayMenu() {
  const { annotateKey, quitKey } = trayKeys;
  const scrollItem = (label, px) => ({
    label, type: 'radio', checked: scrollPxPerNotch === px,
    click: () => { scrollPxPerNotch = px; settings.set('scrollPxPerNotch', px); },
  });
  return Menu.buildFromTemplate([
    { label: `标注当前窗口:${annotateKey ? annotateKey.replace(/Control/g, 'Ctrl') : '全部组合被占用'}`, enabled: false },
    { label: `退出程序:${quitKey ? quitKey.replace(/Control/g, 'Ctrl') : '—'}`, enabled: false },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: isAutoStart(),
      click: (mi) => { setAutoStart(mi.checked); } },
    { label: '滚动跟随灵敏度', submenu: [
      scrollItem('慢', 60), scrollItem('正常', 100), scrollItem('快', 140),
    ] },
    { type: 'separator' },
    { label: '打开标注存档文件夹', click: () => shell.openPath(path.join(__dirname, 'data')) },
    { label: '退出', click: () => app.quit() },
  ]);
}

function createTray(annotateKey, quitKey) {
  trayKeys = { annotateKey, quitKey };
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip(`Window Annotator — 标注:${annotateKey ? annotateKey.replace(/Control/g, 'Ctrl') : '快捷键注册失败'}`);
  tray.setContextMenu(buildTrayMenu());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    new Notification({ title: 'Window Annotator 已经在运行', body: '看右下角托盘的 ✎ 红色圆点,无需重复启动' }).show();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('Window Annotator');
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

    const annotateKey = registerHotkey(
      ['Control+Alt+A', 'Control+Alt+W', 'Control+Shift+Alt+A'], toggleAnnotate);
    const quitKey = registerHotkey(['Control+Alt+Q', 'Control+Shift+Alt+Q'], () => app.quit());
    createTray(annotateKey, quitKey);

    let body;
    if (!annotateKey) body = '标注快捷键注册失败:备用组合也全被其他软件占用了';
    else if (annotateKey !== 'Control+Alt+A') body = `Ctrl+Alt+A 被其他软件占用(常见是 QQ 截图),已改用 ${annotateKey.replace(/Control/g, 'Ctrl')}`;
    else body = '把标注贴到当前窗口:Ctrl+Alt+A;退出:Ctrl+Alt+Q';
    new Notification({ title: 'Window Annotator 正在后台运行', body }).show();

    const hookOk = win32.installWheelHook();
    console.log(`Window Annotator 已启动:标注=${annotateKey || '注册失败'} 退出=${quitKey || '注册失败'} 滚轮钩子=${hookOk ? 'OK' : '失败'}`);

    setInterval(tick, 16);
  });
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); win32.uninstallWheelHook(); });
app.on('window-all-closed', () => {}); // 没有覆盖层时也保持后台驻留

module.exports = { createOverlay, setDrawMode, toggleAnnotate, overlays };
