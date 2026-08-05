// 无头 DOM 测试:多区跟随的绑定+渲染。用真实 overlay.html,靠 IPC 喂"两块滚动区",注入三条标注
// (侧栏一条、正文一条、区外一条),再让两块区各滚不同的量,断言每条标注按"自己那块区"平移。
// 不碰前台/UIA/截图 —— 只读 DOM 的 transform,像 visual-bind 一样稳。用法: electron test/e2e-multiregion.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'multiregion-result.txt');
try { fs.writeFileSync(RESULT, 'multiregion start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 20000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };
  const win = new BrowserWindow({ width: 600, height: 850, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code);

  wc.send('mode', 'view');
  wc.send('init', { items: [], appName: 'mr' });
  await sleep(300);

  // 两块区:a=整块(0..500 宽);b=侧栏(更小,套在左边 0..200)。都 off=0
  const R = (aoff, boff) => ([
    { key: 'a', rect: { x: 0, y: 0, w: 500, h: 800 }, off: aoff },
    { key: 'b', rect: { x: 0, y: 0, w: 200, h: 800 }, off: boff },
  ]);
  wc.send('regions', R(0, 0));
  await sleep(150);
  await js('snapRegions()');

  // pickRegion:侧栏内的点 -> b(更具体);只在正文的点 -> a;区外 -> null
  check('落笔点(100,400)归侧栏 b', (await js('geo.pickRegion(liveRegions,100,400)')) === 'b');
  check('落笔点(350,400)归正文 a', (await js('geo.pickRegion(liveRegions,350,400)')) === 'a');
  check('落笔点(300,2000)区外 -> null', (await js('geo.pickRegion(liveRegions,300,2000)')) === null);

  // 注入三条(不带 roff0,模拟画笔模式落笔):S 侧栏(100,400)、M 正文(350,400)、W 区外(300,2000)
  await js(`
    addItem({ id: 1, type:'pen', color:'red',   points:[[100,400]] });
    addItem({ id: 2, type:'pen', color:'blue',  points:[[350,400]] });
    addItem({ id: 3, type:'pen', color:'green', points:[[300,2000]] });
    true;
  `);
  await js('snapRegions()'); // 触发 bindPending:回到查看时按落笔点延迟绑定
  check('侧栏标注延迟绑定 roff0=0(区当前位移)', (await js('items.find(i=>i.id===1).roff0')) === 0);
  check('正文标注延迟绑定 roff0=0', (await js('items.find(i=>i.id===2).roff0')) === 0);
  check('区外标注未绑定(钉窗口)', (await js('typeof items.find(i=>i.id===3).roff0')) === 'undefined');

  // 两块区各滚不同:正文 a 滚 100,侧栏 b 滚 300
  wc.send('regions', R(100, 300));
  await sleep(150);
  await js('snapRegions()');

  const tS = await js('document.querySelector(\'[data-id="1"]\').getAttribute(\'transform\')');
  const tM = await js('document.querySelector(\'[data-id="2"]\').getAttribute(\'transform\')');
  const tW = await js('document.querySelector(\'[data-id="3"]\').getAttribute(\'transform\')');
  logf(`transforms: S=${tS} M=${tM} W=${tW}`);
  check('侧栏标注跟侧栏(滚300) -> translate(0 -300)', tS === 'translate(0 -300)');
  check('正文标注跟正文(滚100) -> translate(0 -100)', tM === 'translate(0 -100)');
  check('区外标注不跟(钉窗口) -> translate(0 0)', tW === 'translate(0 0)');

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERROR: ' + (e && e.stack || e)); app.exit(3); });
