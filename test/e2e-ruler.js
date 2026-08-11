// 测量标尺 e2e(渲染端):选标尺工具(数字键7/点按钮),拖出测量框 → 生成 ruler item + 物理像素标签正确。
// 用法: electron test/e2e-ruler.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'ruler-result.txt');
try { fs.writeFileSync(RESULT, 'ruler start\n'); } catch {}
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

  check('工具条有标尺按钮', await js('!!document.querySelector(\'[data-tool="ruler"]\')'));
  // 数字键 7 -> ruler
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'7',bubbles:true})); true;`);
  await sleep(30);
  check('数字键 7 -> ruler 工具', (await js('tool')) === 'ruler');

  // 拖出一个 200×80(DIP)的测量框
  await js(`(function(){
    const svg=document.getElementById('canvas');
    const md=(x,y)=>new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:y,button:0,buttons:1});
    const mm=(x,y)=>new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y,button:0,buttons:1});
    const mu=(x,y)=>new MouseEvent('mouseup',{bubbles:true,clientX:x,clientY:y,button:0});
    svg.dispatchEvent(md(120,120)); window.dispatchEvent(mm(220,170)); window.dispatchEvent(mm(320,200)); window.dispatchEvent(mu(320,200));
    return true;})()`);
  await sleep(80);

  const last = JSON.parse(await js('JSON.stringify(items[items.length-1]||null)'));
  check('生成了 ruler item', last && last.type === 'ruler');
  check('from/to 正确', last && last.from[0] === 120 && last.from[1] === 120 && last.to[0] === 320 && last.to[1] === 200);

  // 渲染:ink-layer 里有 g[data-id],含 rect + text
  check('渲染出标尺 group(rect+text)', await js(`(function(){
    const g=document.querySelector('#ink-layer g[data-id]');
    return !!(g && g.querySelector('rect') && g.querySelector('text'));})()`));

  // 物理像素标签 = round(DIP宽×dpr) × round(DIP高×dpr)。DIP 宽=200 高=80
  const label = await js('document.querySelector("#ink-layer g[data-id] text").textContent');
  const expect = await js(`(function(){const d=window.devicePixelRatio||1;return Math.round(200*d)+' × '+Math.round(80*d)+' px';})()`);
  check('标签=物理像素 W×H (' + label + ')', label === expect);

  // 太小的框应被忽略(不新增 item)
  const before = await js('items.length');
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:400,clientY:300,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:403,clientY:302,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:403,clientY:302,button:0}));
    return true;})()`);
  await sleep(50);
  check('太小的框被忽略(不新增)', (await js('items.length')) === before);

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
