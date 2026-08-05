// 集成测试:浏览器切标签页 = 目标窗口标题变。验证 main.checkTitle 会把浮层的标注换成"该标签页那套":
// 在 TAB_A 画 2 条 -> 切到 TAB_B(旧标注不再显示)-> 在 TAB_B 画 1 条 -> 切回 TAB_A(原来的 2 条回来)。
// 直接调 checkTitle + 用 executeJavaScript 注入,不依赖前台(躲开前台锁)。用 WA_TEST=1 放行单实例锁。
// 用法: WA_TEST=1 electron test/e2e-tabswitch.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const main = require('../main.js');
const win32 = require('../src/win32');
const store = require('../src/store');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESULT = path.join(process.env.E2E_OUT || __dirname, 'tabswitch-result.txt');
try { fs.writeFileSync(RESULT, 'tabswitch start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 25000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const target = new BrowserWindow({ x: 130, y: 90, width: 700, height: 520, title: 'TAB_A', backgroundColor: '#ffffff' });
  await target.loadURL('data:text/html,<body>tab test</body>');
  await sleep(500);
  const thwnd = target.getNativeWindowHandle().readBigInt64LE(0);
  main.createOverlay(thwnd, win32.getWindowInfo(thwnd));
  const o = main.overlays.get(win32.hkey(thwnd));
  check('overlay created', !!o);
  if (!o) { app.exit(1); return; }
  const wc = o.win.webContents;
  for (let t = 0; t < 80 && !o.visible; t++) await sleep(50);
  check('overlay visible', o.visible === true);
  const keyA = o.storeKey;

  // 在 TAB_A 画 2 条,等自动存(350ms 防抖)落盘到 TAB_A 的 key
  await wc.executeJavaScript('addItem({id:1,type:"pen",color:"red",points:[[100,100]]}); addItem({id:2,type:"pen",color:"blue",points:[[200,200]]}); true;');
  await sleep(700);
  check('TAB_A 画了 2 条', (await wc.executeJavaScript('items.length')) === 2);
  check('TAB_A 存档已落盘(2 条)', store.load(keyA).length === 2);

  // 切到 TAB_B(标题变)-> checkTitle 换成 TAB_B 那套(空)
  target.setTitle('TAB_B');
  await sleep(200);
  main.checkTitle(o);
  await sleep(250);
  check('切到 TAB_B:storeKey 换了', o.storeKey !== keyA && o.storeKey.includes('TAB_B'));
  check('切到 TAB_B:旧标注不再显示(items=0)', (await wc.executeJavaScript('items.length')) === 0);
  const keyB = o.storeKey;

  // 在 TAB_B 画 1 条
  await wc.executeJavaScript('addItem({id:5,type:"pen",color:"green",points:[[300,300]]}); true;');
  await sleep(700);

  // 切回 TAB_A -> 原来的 2 条回来
  target.setTitle('TAB_A');
  await sleep(200);
  main.checkTitle(o);
  await sleep(250);
  check('切回 TAB_A:原来的 2 条标注回来了', (await wc.executeJavaScript('items.length')) === 2);

  // 清理测试存档
  try {
    const f = path.join(__dirname, '..', 'data', 'annotations.json');
    const all = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete all[keyA]; delete all[keyB];
    fs.writeFileSync(f, JSON.stringify(all, null, 1));
  } catch {}

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERROR: ' + (e && e.stack || e)); app.exit(3); });
