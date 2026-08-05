// Window Annotator — 给任意 Windows 窗口贴手绘标注,标注跟着窗口走
// Ctrl+Alt+A: 给当前窗口开/关标注模式   Ctrl+Alt+Q: 退出程序
'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, Notification, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const win32 = require('./src/win32');
const store = require('./src/store');
const settings = require('./src/settings');
const scrollUia = require('./src/scroll-uia');

// 跟随页面滚动:走系统无障碍(UIA)读目标窗口真实滚动位置,标注绝对跟踪、不漂移。
// 支持的软件(浏览器/PDF/多数笔记软件)能精确跟随;读不到的就退回"标注钉在窗口上"。
let scrollFollow = settings.get('scrollFollow', true);

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
    lastPhys: null,
    baseOffset: null,   // 进入查看模式那一刻的真实滚动偏移(DIP),之后按相对它平移
    lastScrollSent: null,
    bindState: null,    // 上次发给浮层的绑定状态('scroll'跟随滚动 / 'window'只钉窗口);变了才重发
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

// 目标窗口有没有"可用的真实滚动读数":读得到、且确实可滚动(内容高于视口)才算。读不到返回 null。
function validScroll(target) {
  const s = scrollUia.get(target);
  if (!s || !(s.viewsize > 0.01 && s.viewsize < 99.99) || s.percent < 0 || s.viewportPx <= 0) return null;
  return s;
}

// 覆盖层当前的"绑定状态":读得到目标真实滚动 = 跟随滚动;读不到 = 只能钉在窗口上。
// 用来给浮层显示一个看得见的状态牌,让"跟不跟得住滚动"不再是黑箱。
function bindStateOf(o) {
  return validScroll(o.target) ? 'scroll' : 'window';
}

// 按 UIA 读到的真实滚动百分比,把标注平移到对应位置(相对进入查看时的基准)。读不到就返回 false(保持钉住)
function applyScrollFollow(o, physRect) {
  const s = validScroll(o.target);
  if (!s) return false;
  // 视口高度 + 可视比例 -> 内容总高与可滚范围(物理像素)
  const contentPx = s.viewportPx / (s.viewsize / 100);
  const scrollablePhys = Math.max(0, contentPx - s.viewportPx);
  const offsetPhys = (s.percent / 100) * scrollablePhys;
  // 物理像素 -> 覆盖层 CSS 像素(DIP)
  const db = o.win.getBounds();
  const scale = db.height > 0 ? physRect.height / db.height : 1;
  const offsetDip = offsetPhys / (scale || 1);
  if (o.baseOffset == null) o.baseOffset = offsetDip;
  // 绝对跟踪:标注位移 = 内容真实位移。不乘任何"灵敏度",否则会和内容错位对不齐
  const y = offsetDip - o.baseOffset;
  if (o.lastScrollSent == null || Math.abs(o.lastScrollSent - y) > 0.5) {
    o.lastScrollSent = y;
    o.win.webContents.send('scroll-to', y);
    return true;
  }
  return false;
}

function setDrawMode(o, on) {
  if (o.drawMode === on) return;
  o.drawMode = on;
  o.baseOffset = null; o.lastScrollSent = null; o.bindState = null; // 每次切换重设滚动基准+状态牌:下次查看从头对齐、重新点亮
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

// 追踪循环:跟随移动/缩放,目标最小化或失去前台就藏起来;查看模式下按 UIA 真实滚动平移标注
// 返回这一帧是否"有动静"(位置变了 / 滚动了),用来驱动自适应节奏
function tick() {
  if (!overlays.size) return false;
  const fg = win32.getForegroundWindow();
  let busy = false;
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
      // 物理矩形没变就整帧跳过 DPI 换算/setBounds,只有真移动了才对齐,拖动时才顶格出力
      const r = state.rect;
      const pk = `${r.x},${r.y},${r.width},${r.height}`;
      if (pk !== o.lastPhys) { o.lastPhys = pk; applyBounds(o, r); busy = true; }
      if (!o.visible) { o.win.showInactive(); o.visible = true; busy = true; }
      // 查看模式且目标在前台:把"绑定状态"发给浮层(变了才发,显示可见的状态牌),再按真实滚动平移标注
      if (!o.drawMode && win32.same(fg, o.target)) {
        if (scrollFollow) {
          const bs = bindStateOf(o);
          if (o.bindState !== bs) { o.bindState = bs; o.win.webContents.send('bind-state', bs); }
          if (applyScrollFollow(o, state.rect)) busy = true;
        } else if (o.bindState !== null) {
          o.bindState = null; // 用户关掉跟随:清掉状态,不发牌子;重新开启再点亮
        }
      }
    } else {
      if (o.drawMode && !win32.same(fg, o.overlayHwnd)) setDrawMode(o, false);
      if (o.visible) { o.win.hide(); o.visible = false; o.lastPhys = null; o.baseOffset = null; busy = true; }
    }
  }
  return busy;
}

// 自适应节奏:有动静时贴到 8ms 高频跟手,静止后回落 24ms 省电,完全没标注时 120ms 极懒待命
let trackTimer = null;
let calmFrames = 0;
function trackLoop() {
  const busy = tick();
  calmFrames = busy ? 0 : Math.min(calmFrames + 1, 9999);
  let delay;
  if (!overlays.size) delay = 120;
  else if (calmFrames < 24) delay = 8;   // 刚有动静的一小段时间保持高频,拖动/滚动才跟得紧
  else delay = 24;                        // 静止:一秒 ~40 次,足够第一时间发现窗口又动了
  trackTimer = setTimeout(trackLoop, delay);
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
  return Menu.buildFromTemplate([
    { label: `标注当前窗口:${annotateKey ? annotateKey.replace(/Control/g, 'Ctrl') : '全部组合被占用'}`, enabled: false },
    { label: `退出程序:${quitKey ? quitKey.replace(/Control/g, 'Ctrl') : '—'}`, enabled: false },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: isAutoStart(),
      click: (mi) => { setAutoStart(mi.checked); } },
    { label: '跟随页面滚动(浏览器/PDF/笔记等;读不到就钉在窗口上)', type: 'checkbox', checked: scrollFollow,
      click: (mi) => {
        scrollFollow = mi.checked;
        settings.set('scrollFollow', mi.checked);
        if (mi.checked) scrollUia.start(); else scrollUia.stop();
        tray.setContextMenu(buildTrayMenu());
      } },
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

    if (scrollFollow) scrollUia.start(); // 跟随页面滚动开着才拉起 UIA 读取器,平时零开销
    console.log(`Window Annotator 已启动:标注=${annotateKey || '注册失败'} 退出=${quitKey || '注册失败'} 跟随滚动=${scrollFollow ? 'UIA' : '关'}`);

    trackLoop();
  });
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); scrollUia.stop(); });
app.on('window-all-closed', () => {}); // 没有覆盖层时也保持后台驻留

module.exports = { createOverlay, setDrawMode, toggleAnnotate, overlays };
