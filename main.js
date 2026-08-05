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
const regions = require('./src/regions');

// 跟随页面滚动:走系统无障碍(UIA)读目标窗口真实滚动位置,标注绝对跟踪、不漂移。
// 支持的软件(浏览器/PDF/多数笔记软件)能精确跟随;读不到的就退回"标注钉在窗口上"。
let scrollFollow = settings.get('scrollFollow', true);

// key = 目标窗口 hwnd 字符串 -> { win, overlayHwnd, target, storeKey, drawMode, visible, lastBounds }
const overlays = new Map();

function storeKeyOf(info) {
  // 去掉标题开头的未读计数(如 "(3) ")—— 否则计数一跳就被当成切了标签页,标注乱闪
  const title = (info.title || '').replace(/^\(\d+\+?\)\s*/, '');
  return `${info.exe}|${title}`;
}

// 只在真有标注浮层、且跟随开着时才跑 UIA 读取器 —— 平时(没标注 / 刚开机)零 UIA 开销,不拖慢系统。
// 之前开机就拉起读取器、立刻不停扫前台窗口那棵极大的无障碍树,是"启动很卡"的主因。start/stop 都幂等。
function syncReader() {
  if (scrollFollow && overlays.size > 0) scrollUia.start();
  else scrollUia.stop();
}

// 目标窗口标题变了(浏览器多半=切了标签页):换到新标题对应的那套标注,别让旧页的标注赖在新页上。
// 当前这套已由自动存(按旧 key)持久化,这里只需切 key + 载入新 key 的标注 + 让浮层重载。
function checkTitle(o) {
  const info = win32.getWindowInfo(o.target);
  if (!info || !info.exe) return;
  const key = storeKeyOf(info);
  if (key === o.storeKey) return;
  o.storeKey = key;
  o.info = info;
  o.win.webContents.send('init', { items: store.load(key), appName: info.exe.replace(/\.exe$/i, '') });
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
    lastTitleCheck: 0,     // 上次查标题的时间戳(节流用):标题变=多半切了标签页,换对应标注
    regionsKeyed: [],      // 上一帧带 key 的可滚动区 [{key, rect}](物理),跨帧保持同一块区的 key
    keyRef: { n: 0 },      // 给新区发号
    lastRegionsSent: null, // 上次发给浮层的区 payload 签名;变了才重发
    bindState: null,       // 上次发的绑定状态('scroll'/'window');变了才重发
  };
  overlays.set(win32.hkey(targetHwnd), o);
  syncReader(); // 第一个浮层出现,按需拉起读取器

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
  win.on('closed', () => { overlays.delete(win32.hkey(targetHwnd)); syncReader(); });
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

// 算这一帧目标窗口的所有可滚动区,交给浮层。每块:{ key, rect:{x,y,w,h}(浮层本地 DIP), off(内容已上移 DIP) }。
// key 由跨帧矩形匹配保持稳定(给浮层做每块缓动用);读不到返回 []。绝对量、自我校正、不漂移。
function computeRegions(o, physRect) {
  const raw = scrollUia.getRegions(o.target);
  if (!raw || !raw.length) { o.regionsKeyed = []; return []; }
  const keyed = regions.matchRegions(o.regionsKeyed, raw, o.keyRef);
  o.regionsKeyed = keyed.map((k) => ({ key: k.key, rect: { x: k.x, y: k.y, w: k.w, h: k.h } }));
  const db = o.win.getBounds();
  const scale = db.height > 0 ? physRect.height / db.height : 1; // = DPR
  return keyed.map((k) => {
    const rect = regions.toLocalDip({ x: k.x, y: k.y, w: k.w, h: k.h }, physRect, scale);
    return { key: k.key, rect, off: regions.offsetDip(k.percent, k.viewsize, rect.h) };
  });
}

function setDrawMode(o, on) {
  if (o.drawMode === on) return;
  o.drawMode = on;
  o.lastRegionsSent = null; o.bindState = null; // 每次切换重设:下次查看重发区+状态牌
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
      syncReader(); // 没浮层了就停读取器,回到零开销
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
      // 标题变了(多半切了标签页)就换这个窗口对应的那套标注(节流,别每帧查)
      if (Date.now() - o.lastTitleCheck > 400) { o.lastTitleCheck = Date.now(); checkTitle(o); }
      // 查看模式且目标在前台:算出所有可滚动区发给浮层(变了才发),并更新绑定状态牌
      if (!o.drawMode && win32.same(fg, o.target)) {
        if (scrollFollow) {
          const payload = computeRegions(o, state.rect);
          const bs = payload.length ? 'scroll' : 'window';
          if (o.bindState !== bs) { o.bindState = bs; o.win.webContents.send('bind-state', bs); }
          const sig = JSON.stringify(payload);
          if (sig !== o.lastRegionsSent) { o.lastRegionsSent = sig; o.win.webContents.send('regions', payload); busy = true; }
        } else if (o.bindState !== null) {
          o.bindState = null; o.lastRegionsSent = '[]'; o.win.webContents.send('regions', []); // 关跟随:清区+状态
        }
      }
    } else {
      if (o.drawMode && !win32.same(fg, o.overlayHwnd)) setDrawMode(o, false);
      if (o.visible) { o.win.hide(); o.visible = false; o.lastPhys = null; o.lastRegionsSent = null; busy = true; }
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
        syncReader();
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

if (!process.env.WA_TEST && !app.requestSingleInstanceLock()) {
  app.quit(); // 单实例:已有一个在跑就退。测试(WA_TEST=1)放行,便于开着正式版时也能跑集成测试
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

    // 不在启动时拉起 UIA 读取器(那会立刻扫前台窗口、拖慢开机);等真有标注浮层再按需启动,见 syncReader
    console.log(`Window Annotator 已启动:标注=${annotateKey || '注册失败'} 退出=${quitKey || '注册失败'} 跟随滚动=${scrollFollow ? 'UIA(按需)' : '关'}`);

    trackLoop();
  });
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); scrollUia.stop(); });
app.on('window-all-closed', () => {}); // 没有覆盖层时也保持后台驻留

module.exports = { createOverlay, setDrawMode, toggleAnnotate, overlays, checkTitle };
