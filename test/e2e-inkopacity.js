// 冒烟测:画笔模式滚轮两作用(透明度 / 缩放)+ 小图标切换。加载真实 overlay,进画笔模式逐一验。
// 用法: electron test/e2e-inkopacity.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'inkopacity-result.txt');
try { fs.writeFileSync(RESULT, 'inkopacity start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 20000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const w = new BrowserWindow({
    width: 600, height: 400, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  const wc = w.webContents;
  const jsNum = (expr) => wc.executeJavaScript(expr);
  const wheelN = (dy, n) => wc.executeJavaScript(`for(let i=0;i<${n};i++)window.dispatchEvent(new WheelEvent('wheel',{deltaY:${dy},cancelable:true})); true;`);

  await wc.executeJavaScript(`addItem({id:1,type:'pen',color:'red',points:[[100,100],[150,130]]}); true;`);
  wc.send('mode', 'draw');
  await sleep(250);
  check('进入画笔模式', (await jsNum('mode')) === 'draw');
  check('默认滚轮作用=透明度', (await jsNum('wheelMode')) === 'opacity');

  // —— 透明度模式 ——
  const op = () => jsNum('parseFloat(document.getElementById("canvas").style.opacity||"1")');
  await wheelN(-120, 3); await sleep(60);
  const op1 = await op();
  check('上滚:标注变淡 (' + op1 + ')', op1 < 0.85 && op1 >= 0.12);
  await wheelN(-120, 20); await sleep(60);
  check('一直上滚:封底 ~0.12 (' + (await op()) + ')', (await op()) <= 0.13 && (await op()) >= 0.11);
  await wheelN(120, 20); await sleep(60);
  check('下滚:回不透明并封顶 1 (' + (await op()) + ')', (await op()) >= 0.99);

  // —— 切到缩放模式(点小图标)——
  await wc.executeJavaScript(`document.getElementById('wheel-mode').click(); true;`);
  check('点小图标 -> 切到缩放', (await jsNum('wheelMode')) === 'zoom');
  const sc = () => jsNum('inkScale');
  await wheelN(-120, 4); await sleep(60);
  const s1 = await sc();
  check('缩放模式上滚 = 放大 (scale=' + s1 + ')', s1 > 1.1);
  check('缩放已施加到标注层', /scale\(/.test(await jsNum('document.getElementById("canvas").style.transform')));
  await wheelN(120, 30); await sleep(60);
  check('缩放模式一直下滚:封底 0.4 (' + (await sc()) + ')', (await sc()) <= 0.41 && (await sc()) >= 0.39);

  // 缩放模式下,滚轮不该动透明度(还是上一步的 1)
  check('缩放模式不影响透明度', (await op()) >= 0.99);

  // 右键小图标 -> 切回透明度
  await wc.executeJavaScript(`document.getElementById('wheel-mode').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); true;`);
  check('右键小图标 -> 切回透明度', (await jsNum('wheelMode')) === 'opacity');

  // 切回查看模式 -> 透明度 + 缩放都复位
  wc.send('mode', 'view');
  await sleep(150);
  check('切回查看:透明度复位 1', (await op()) >= 0.99);
  check('切回查看:缩放复位 1', Math.abs((await sc()) - 1) < 0.001);

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + (e && e.stack || e)); app.exit(3); });
