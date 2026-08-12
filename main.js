// Window Annotator — 给任意 Windows 窗口贴手绘标注,标注跟着窗口走
// Ctrl+Alt+A: 给当前窗口开/关标注模式   Ctrl+Alt+Q: 退出程序
'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, Notification, nativeImage, shell, desktopCapturer, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const win32 = require('./src/win32');
const store = require('./src/store');
const settings = require('./src/settings');
const scrollUia = require('./src/scroll-uia');
const regions = require('./src/regions');
const trayPos = require('./src/tray-pos');
const shotGeom = require('./src/shot-geom');

// 跟随页面滚动:走系统无障碍(UIA)读目标窗口真实滚动位置,标注绝对跟踪、不漂移。
// 支持的软件(浏览器/PDF/多数笔记软件)能精确跟随;读不到的就退回"标注钉在窗口上"。
let scrollFollow = settings.get('scrollFollow', true);

// UIA 滚动读取的最小间隔(ms):UIA 遍历无障碍树是重活,~30fps 足够顺(渲染端还有缓动插值抹顺),
// 别每帧都读——这是"运行有点卡"的主要来源。位置对齐(applyBounds)不受此限,仍每帧跟手。
const UIA_MIN_MS = 32;

// 系统通知统一带上我们的 logo(不然开发模式下用的是 electron 默认图标)。配合 app.setAppUserModelId 用。
const NOTIF_ICON = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
function notify(opts) { return new Notification(Object.assign({ icon: NOTIF_ICON }, opts)); }

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
    capturing: false,      // 截图进行中:追踪循环这段时间跳过它,别把浮层退出画笔/隐藏,免得工具条回不来
    picking: false,        // 屏幕取色进行中(原生吸管):同理挂起追踪,焦点一走别把浮层判成"离开前台"退出画笔
    lastBounds: null,
    lastPhys: null,
    lastTitleCheck: 0,     // 上次查标题的时间戳(节流用):标题变=多半切了标签页,换对应标注
    lastUiaRead: 0,        // 上次读 UIA 滚动区的时间戳(节流到 ~30fps,见 UIA_MIN_MS)
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
    if (o.capturing || o.picking) continue; // 正在截图/取色:这段时间别动它(别退出画笔/别隐藏),完事自然复原
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
      // 查看模式且目标在前台:算出所有可滚动区发给浮层(变了才发),并更新绑定状态牌。
      // computeRegions 走 UIA 遍历无障碍树,是这循环里最重的活;位置对齐可以 60fps,但 UIA 没必要那么勤——
      // 节流到 ~30fps 读一次,渲染端 easeRegions 每帧 0.35 缓动插值,视觉照样顺,却省掉一半 UIA 开销(卡的主因)。
      if (!o.drawMode && win32.same(fg, o.target)) {
        if (scrollFollow) {
          if (Date.now() - (o.lastUiaRead || 0) >= UIA_MIN_MS) {
            o.lastUiaRead = Date.now();
            const payload = computeRegions(o, state.rect);
            const bs = payload.length ? 'scroll' : 'window';
            if (o.bindState !== bs) { o.bindState = bs; o.win.webContents.send('bind-state', bs); }
            const sig = JSON.stringify(payload);
            if (sig !== o.lastRegionsSent) { o.lastRegionsSent = sig; o.win.webContents.send('regions', payload); busy = true; }
          }
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

// 自适应节奏:有动静时 16ms(60fps)高频跟手,静止后回落 24ms 省电,完全没标注时 120ms 极懒待命。
// 高频档从 8ms(125fps)提到 16ms:窗口跟随视觉上 60fps 已足够跟手,却省掉近一半的每帧 FFI/循环开销。
let trackTimer = null;
let calmFrames = 0;
function trackLoop() {
  const busy = tick();
  calmFrames = busy ? 0 : Math.min(calmFrames + 1, 9999);
  let delay;
  if (!overlays.size) delay = 120;
  else if (calmFrames < 24) delay = 16;  // 刚有动静的一小段时间保持 60fps,拖动/滚动跟得紧
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
// 屏幕取色开始/结束:挂起/恢复对该浮层的追踪(见 tick 里的 picking 守卫)
ipcMain.on('eyedropper-active', (e, active) => {
  const o = overlayOf(e.sender);
  if (o) o.picking = !!active;
});

// 截图:把目标窗口那块屏幕整张抓下来。抓的是"屏幕合成后的像素",所以窗口内容 + 我们置顶的标注浮层
// 天然叠在一起 = 所见即所得。浮层已先自行隐藏工具条/描边/提示牌(body.shooting)并重绘上屏,才发来这条。
// 复制到剪贴板(主用途)+ 存一张 PNG 到 图片\Window Annotator(以防丢);裁剪几何走 shot-geom(已单测)。
// 截图保存位置:用户在托盘菜单里设过就用自定义目录,否则默认「图片\Window Annotator」。
// 存一个绝对路径在设置里(将来和大项目对接时,大项目那头也读同一个目录)。
function shotsDir() {
  const custom = settings.get('shotsDir', '');
  return (custom && String(custom).trim()) ? custom : path.join(app.getPath('pictures'), 'Window Annotator');
}
// 弹系统选文件夹对话框,选定后写进设置。托盘菜单和原生兜底菜单共用。
async function pickShotsDir() {
  const cur = shotsDir();
  let dflt;
  try { dflt = fs.existsSync(cur) ? cur : app.getPath('pictures'); } catch { dflt = app.getPath('pictures'); }
  const res = await dialog.showOpenDialog({
    title: '选择截图保存位置',
    defaultPath: dflt,
    buttonLabel: '就存这里',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return;
  settings.set('shotsDir', res.filePaths[0]);
  try { notify({ title: '✅ 截图保存位置已更新', body: res.filePaths[0] }).show(); } catch { /* 通知被关也没关系 */ }
}
// 抓浮层本地 DIP 区域 region={x,y,w,h} 那块的屏幕像素(合成后,含已画标注=所见即所得)。
// 整窗截图 / 框选区域截图 / 放大镜 共用同一套抓屏+裁剪(几何走 shot-geom,已单测)。
async function captureRegion(o, region, thumbScale) {
  const b = o.win.getBounds();
  const disp = screen.getDisplayMatching(b);
  const sf = disp.scaleFactor || 1;
  // 抓屏分辨率倍率:抓全屏 thumbnail 是这里最慢的一步,分辨率越高越慢。截图用 sf(要清晰要存盘);
  // 放大镜传 1(逻辑分辨率就够——它本来就放大、略糊无妨,却能省下高分屏 ×sf 的大半抓屏时间)。
  const scale = thumbScale || sf;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(disp.size.width * scale), height: Math.round(disp.size.height * scale) },
  });
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('拿不到屏幕画面(可能被系统禁止截屏)');
  const screenRect = { x: b.x + region.x, y: b.y + region.y, width: region.w, height: region.h };
  const crop = shotGeom.cropRect(screenRect, disp.bounds, disp.size, src.thumbnail.getSize());
  return src.thumbnail.crop(crop);
}
// 复制到剪贴板 + 存一张带时间戳的 PNG,返回文件路径。整窗截图 / 框选区域截图共用。
function saveShotImage(shot) {
  clipboard.writeImage(shot);
  const dir = shotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const file = path.join(dir,
    `WA_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`);
  fs.writeFileSync(file, shot.toPNG());
  return file;
}
async function captureWindow(o) {
  const b = o.win.getBounds();                       // 浮层正贴着目标窗口 -> 整块就是截图范围(DIP)
  const shot = await captureRegion(o, { x: 0, y: 0, w: b.width, h: b.height });
  return saveShotImage(shot);
}
ipcMain.on('capture-window', async (e) => {
  const o = overlayOf(e.sender);
  // 即便没找到对应浮层也要回话,否则渲染端的 .shooting 撤不掉、工具条回不来(渲染端另有兜底超时双保险)
  if (!o) { if (!e.sender.isDestroyed()) e.sender.send('capture-result', { ok: false, error: '找不到浮层' }); return; }
  o.capturing = true;   // 抓图这段时间让追踪循环别碰这个浮层(别因前台抖动退出画笔模式/隐藏它)
  try {
    const file = await captureWindow(o);
    if (!e.sender.isDestroyed()) e.sender.send('capture-result', { ok: true, file });
    // 系统通知:明确告诉"成功了 + 存哪了",点一下直接在资源管理器里定位到这张图(治"找不到保存位置")
    try {
      const n = notify({ title: '📷 已截图 · 已复制到剪贴板', body: '已保存到「图片\\Window Annotator」,点此打开' });
      n.on('click', () => shell.showItemInFolder(file));
      n.show();
    } catch { /* 通知被系统关掉也没关系,浮层还有提示牌 */ }
  } catch (err) {
    if (!e.sender.isDestroyed()) e.sender.send('capture-result', { ok: false, error: String((err && err.message) || err) });
  } finally {
    o.capturing = false;
  }
});

// 框选区域截图:抓框选那块(sf 高清,含标注),复制剪贴板 + 存 PNG(和整窗截图同款落地,共用 capture-result)
ipcMain.on('capture-region', async (e, region) => {
  const o = overlayOf(e.sender);
  if (!o) { if (!e.sender.isDestroyed()) e.sender.send('capture-result', { ok: false, error: '找不到浮层' }); return; }
  o.capturing = true;
  try {
    const shot = await captureRegion(o, region);   // 默认 sf 高清(要存盘)
    const file = saveShotImage(shot);
    if (!e.sender.isDestroyed()) e.sender.send('capture-result', { ok: true, file });
    try {
      const n = notify({ title: '📷 已截图(框选区域)· 已复制到剪贴板', body: '已保存到「图片\\Window Annotator」,点此打开' });
      n.on('click', () => shell.showItemInFolder(file));
      n.show();
    } catch { /* 通知被关也没关系,浮层还有提示牌 */ }
  } catch (err) {
    if (!e.sender.isDestroyed()) e.sender.send('capture-result', { ok: false, error: String((err && err.message) || err) });
  } finally {
    o.capturing = false;
  }
});

// 放大镜:抓框选那块的快照,放大 2x,回给渲染端做成一枚可拖的镜片(静态=那一刻的样子,用户已认可)
ipcMain.on('capture-loupe', async (e, region) => {
  const o = overlayOf(e.sender);
  if (!o) { if (!e.sender.isDestroyed()) e.sender.send('loupe-result', { ok: false, error: '找不到浮层' }); return; }
  o.capturing = true;
  try {
    // 不在主进程放大(resize + 大图 toDataURL 慢,会超时→"没有响应");抓原区域直接回传,放大交给渲染端 CSS。
    // 抓屏用 1× 逻辑分辨率(放大镜够用、快很多)。
    const img = await captureRegion(o, region, 1);
    if (!e.sender.isDestroyed()) e.sender.send('loupe-result', { ok: true, region, dataURL: img.toDataURL() });
  } catch (err) {
    if (!e.sender.isDestroyed()) e.sender.send('loupe-result', { ok: false, error: String((err && err.message) || err) });
  } finally {
    o.capturing = false;
  }
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
let menuWin = null;        // 自绘的托盘右键菜单(透明置顶小窗,深色玻璃,自适应内容)
let pendingCursor = null;  // 右键那一刻的光标屏幕坐标,等菜单量完尺寸再据此定位

const fmtKey = (k) => (k ? k.replace(/Control/g, 'Ctrl') : '—');

// 原生菜单只作兜底(自绘菜单没就绪时用);平时走 showTrayMenu 的自绘版
function buildTrayMenu() {
  const { annotateKey, quitKey } = trayKeys;
  return Menu.buildFromTemplate([
    { label: `标注当前窗口:${annotateKey ? annotateKey.replace(/Control/g, 'Ctrl') : '全部组合被占用'}`, enabled: false },
    { label: `退出程序:${quitKey ? quitKey.replace(/Control/g, 'Ctrl') : '—'}`, enabled: false },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: isAutoStart(),
      click: (mi) => { setAutoStart(mi.checked); } },
    { label: '跟随页面滚动', type: 'checkbox', checked: scrollFollow,
      click: (mi) => {
        scrollFollow = mi.checked;
        settings.set('scrollFollow', mi.checked);
        syncReader();
      } },
    { type: 'separator' },
    { label: '设置截图保存位置…', click: () => pickShotsDir() },
    { label: '打开截图文件夹', click: () => { fs.mkdirSync(shotsDir(), { recursive: true }); shell.openPath(shotsDir()); } },
    { label: '打开标注存档文件夹', click: () => shell.openPath(path.join(__dirname, 'data')) },
    { label: '退出', click: () => app.quit() },
  ]);
}

// 自绘菜单窗口:透明、无边框、置顶、跳过任务栏;开机就建好(藏着),右键时填状态再弹,避免首弹卡顿
function createTrayMenuWindow() {
  const w = new BrowserWindow({
    width: 320, height: 340, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, hasShadow: false, fullscreenable: false, type: 'toolbar',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setMenu(null);
  w.loadFile(path.join(__dirname, 'tray-menu', 'menu.html'));
  w.on('blur', () => { if (!w.isDestroyed() && w.isVisible()) w.hide(); }); // 点别处即收
  return w;
}

// 弹菜单:记下光标,把当前状态发给菜单;菜单量完尺寸回 'menu-size',那边再定位+显示
function showTrayMenu() {
  if (!menuWin || menuWin.isDestroyed() || !menuWin.webContents || menuWin.webContents.isLoading()) {
    try { tray.popUpContextMenu(buildTrayMenu()); } catch { /* 兜底也失败就算了 */ }
    return;
  }
  pendingCursor = screen.getCursorScreenPoint();
  menuWin.webContents.send('menu-state', {
    autostart: isAutoStart(), follow: scrollFollow,
    annotateKey: fmtKey(trayKeys.annotateKey), quitKey: fmtKey(trayKeys.quitKey),
    shotsName: path.basename(shotsDir()),   // 只给文件夹名(短),让菜单能显示"现在存哪"而不撑宽
  });
}

ipcMain.on('menu-size', (e, size) => {
  if (!menuWin || e.sender !== menuWin.webContents) return;
  const cur = pendingCursor || screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cur).workArea;
  const { x, y } = trayPos.menuPosition(cur, size, wa);
  menuWin.setBounds({ x, y, width: size.winW, height: size.winH });
  menuWin.show();
  menuWin.focus();          // 拿到焦点才能靠 blur 收起
});

ipcMain.on('tray-action', (e, action) => {
  if (menuWin && e.sender === menuWin.webContents && menuWin.isVisible()) menuWin.hide();
  if (action === 'autostart') setAutoStart(!isAutoStart());
  else if (action === 'follow') { scrollFollow = !scrollFollow; settings.set('scrollFollow', scrollFollow); syncReader(); }
  else if (action === 'set-shots-dir') pickShotsDir();
  else if (action === 'open-shots') { fs.mkdirSync(shotsDir(), { recursive: true }); shell.openPath(shotsDir()); }
  else if (action === 'open') shell.openPath(path.join(__dirname, 'data'));
  else if (action === 'quit') app.quit();
  // 'close'(按 Esc):已经 hide,别的什么都不做
});

function createTray(annotateKey, quitKey) {
  trayKeys = { annotateKey, quitKey };
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip(`Window Annotator — 标注:${annotateKey ? fmtKey(annotateKey) : '快捷键注册失败'}`);
  menuWin = createTrayMenuWindow();
  tray.on('right-click', showTrayMenu);
  tray.on('click', showTrayMenu);   // 左键也弹,没有别的主动作,省得找
}

if (!process.env.WA_TEST && !app.requestSingleInstanceLock()) {
  app.quit(); // 单实例:已有一个在跑就退。测试(WA_TEST=1)放行,便于开着正式版时也能跑集成测试
} else {
  app.on('second-instance', () => {
    notify({ title: 'Window Annotator 已经在运行', body: '看右下角托盘的 ✎ 红色圆点,无需重复启动' }).show();
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
    notify({ title: 'Window Annotator 正在后台运行', body }).show();

    // 不在启动时拉起 UIA 读取器(那会立刻扫前台窗口、拖慢开机);等真有标注浮层再按需启动,见 syncReader
    console.log(`Window Annotator 已启动:标注=${annotateKey || '注册失败'} 退出=${quitKey || '注册失败'} 跟随滚动=${scrollFollow ? 'UIA(按需)' : '关'}`);

    trackLoop();
  });
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); scrollUia.stop(); });
app.on('window-all-closed', () => {}); // 没有覆盖层时也保持后台驻留

module.exports = { createOverlay, setDrawMode, toggleAnnotate, overlays, checkTitle, shotsDir };
