// 冒烟测:画笔模式下滚轮调标注透明度。加载真实 overlay,进画笔模式,上滚变淡/下滚变实/切模式复位。
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

  await wc.executeJavaScript(`addItem({id:1,type:'pen',color:'red',points:[[100,100],[150,130]]}); true;`);
  wc.send('mode', 'draw');
  await sleep(250);
  check('进入画笔模式', (await wc.executeJavaScript('mode')) === 'draw');

  const op = () => wc.executeJavaScript('parseFloat(document.getElementById("canvas").style.opacity||"1")');
  const op0 = await op();
  // 上滚三下(deltaY<0)-> 变淡
  await wc.executeJavaScript(`for(let i=0;i<3;i++)window.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,cancelable:true})); true;`);
  await sleep(80);
  const op1 = await op();
  check('上滚:标注变淡 (' + op0 + ' -> ' + op1 + ')', op1 < 0.85 && op1 >= 0.12);

  // 使劲上滚(封底 0.12 不再更淡)
  await wc.executeJavaScript(`for(let i=0;i<20;i++)window.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,cancelable:true})); true;`);
  await sleep(80);
  const op2 = await op();
  check('一直上滚:封底 ~0.12 不消失 (' + op2 + ')', op2 >= 0.11 && op2 <= 0.13);

  // 下滚很多下 -> 回到不透明(封顶 1)
  await wc.executeJavaScript(`for(let i=0;i<20;i++)window.dispatchEvent(new WheelEvent('wheel',{deltaY:120,cancelable:true})); true;`);
  await sleep(80);
  const op3 = await op();
  check('下滚:回到不透明并封顶 1 (' + op3 + ')', op3 >= 0.99);

  // 先滚淡,再切回查看模式 -> 复位为 1(不把滚淡状态带进查看)
  await wc.executeJavaScript(`for(let i=0;i<4;i++)window.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,cancelable:true})); true;`);
  wc.send('mode', 'view');
  await sleep(150);
  const op4 = await op();
  check('切回查看模式:标注复位为不透明 (' + op4 + ')', op4 >= 0.99);

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + (e && e.stack || e)); app.exit(3); });
