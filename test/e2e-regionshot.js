// 框选区域截图 e2e(渲染端):右键 📷 → 进入框选(regionShotArm)→ 框一块 → 松手 shooting + 发 capture-region;
// 模拟主进程回 capture-result → 复原+提示。太小忽略。用法: electron test/e2e-regionshot.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'regionshot-result.txt');
try { fs.writeFileSync(RESULT, 'regionshot start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 25000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const w = new BrowserWindow({
    width: 800, height: 500, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  const wc = w.webContents;
  const js = (e) => wc.executeJavaScript(e);

  wc.send('mode', 'draw');
  await sleep(150);

  // 右键 📷 -> 进入框选截图模式
  await js(`document.getElementById('shot').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); true;`);
  check('右键 📷 -> regionShotArm=true', await js('regionShotArm === true'));
  check('光标变 crosshair', (await js('document.getElementById("canvas").style.cursor')) === 'crosshair');
  check('提示"框选要截图的区域"', await js('/框选要截图/.test(document.getElementById("shot-toast").textContent)'));

  // 框选一块 200×100(先不松手,读 region)
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:120,clientY:120,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:320,clientY:220,button:0,buttons:1}));
    return true;})()`);
  const reg = JSON.parse(await js('JSON.stringify(drawing && drawing.region)'));
  check('框选 region 正确', reg && reg.x === 120 && reg.y === 120 && reg.w === 200 && reg.h === 100);
  check('框选中显示橡皮筋', await js('!!document.querySelector(".loupe-band")'));

  // 松手 -> shooting + 退出 arm + 橡皮筋移除
  await js(`window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:320,clientY:220,button:0})); true;`);
  check('松手 -> 进入 shooting(藏工具条)', await js('document.body.classList.contains("shooting")'));
  check('退出框选模式(regionShotArm=false)', await js('regionShotArm === false'));
  check('橡皮筋已移除', await js('!document.querySelector(".loupe-band")'));

  // 模拟主进程回传(截图成功)-> 复原 + 提示
  wc.send('capture-result', { ok: true, file: 'C:/x/WA.png' });
  await sleep(150);
  check('收到结果 -> 撤销 shooting(工具条复原)', !(await js('document.body.classList.contains("shooting")')));
  check('提示"已复制到剪贴板"', await js('/剪贴板/.test(document.getElementById("shot-toast").textContent)'));

  // 太小的框忽略:右键 arm -> 框 3px -> 不 shooting
  await js(`document.getElementById('shot').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); true;`);
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:400,clientY:300,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:403,clientY:302,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:403,clientY:302,button:0}));
    return true;})()`);
  await sleep(40);
  check('太小的框被忽略(不进 shooting)', !(await js('document.body.classList.contains("shooting")')));
  check('太小后也退出框选模式', await js('regionShotArm === false'));

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
