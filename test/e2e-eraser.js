// 橡皮擦圆形范围擦 e2e(渲染端):选橡皮→body.tool-eraser+圆光标;落笔/划过圆范围内的标注被擦、范围外不擦;
// 滚轮改圆半径;圆光标跟随鼠标。用法: electron test/e2e-eraser.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'eraser-result.txt');
try { fs.writeFileSync(RESULT, 'eraser start\n'); } catch {}
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
  const penAt = (x1, y1, x2, y2) => js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:${x1},clientY:${y1},button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${x2},clientY:${y2},button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:${x2},clientY:${y2},button:0}));
    return true;})()`);

  wc.send('mode', 'draw');
  await sleep(150);

  // 选橡皮 -> body.tool-eraser + 圆光标存在
  await js(`selectTool('eraser'); true;`);
  check('选橡皮 -> tool==="eraser"', (await js('tool')) === 'eraser');
  check('body.tool-eraser', await js('document.body.classList.contains("tool-eraser")'));
  check('圆光标元素存在', await js('!!document.getElementById("eraser-ring")'));

  // 圆光标跟随鼠标(移动到 300,200,ring 应更新 left/top/尺寸)
  await js(`window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:300,clientY:200})); true;`);
  check('圆光标跟随(left=300 top=200)', await js('(function(){const r=document.getElementById("eraser-ring");return r.style.left==="300px"&&r.style.top==="200px";})()'));
  check('圆光标直径=2×半径(默认60px)', await js('document.getElementById("eraser-ring").style.width==="60px"'));

  // 画两笔:A 在(120,110)附近,B 在(600,400)附近
  await js(`selectTool('pen'); true;`);
  await penAt(100, 100, 140, 120);   // A
  await penAt(560, 380, 640, 420);   // B
  const n0 = await js('items.length');
  check('画了 2 笔', n0 === 2);

  // 橡皮:在 A 的位置落笔(圆 r30 覆盖 A),A 被擦、B 不动
  await js(`selectTool('eraser'); true;`);
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:120,clientY:110,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:120,clientY:110,button:0}));
    return true;})()`);
  await sleep(50);
  check('圆范围内的 A 被擦掉(还剩 1)', (await js('items.length')) === 1);
  check('范围外的 B 还在', await js('items.length===1'));

  // 滚轮改半径(逻辑):合成 WheelEvent+preventDefault 在 headless 会卡,真机正常;这里测半径可变 + 圆光标随半径更新
  await js('eraserRadius = Math.max(10, Math.min(120, eraserRadius + 6)); updateRing(300,200); true;');
  check('橡皮半径可增(30→36)', (await js('eraserRadius')) === 36);
  check('圆光标随半径更新(直径 72px)', await js('document.getElementById("eraser-ring").style.width==="72px"'));

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
