// 放大镜 e2e(渲染端):选放大镜工具→框选→body.shooting+发出 capture-loupe(region);
// 模拟主进程回传 loupe-result(带假 dataURL)→ 建一枚可拖镜片 div + 撤 shooting。太小的框忽略。
// 真实抓屏/裁剪由 shot-geom 单测 + e2e-capture 覆盖,这里专测渲染端流程。用法: electron test/e2e-loupe.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'loupe-result.txt');
try { fs.writeFileSync(RESULT, 'loupe start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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

  check('工具条有放大镜按钮', await js('!!document.querySelector(\'[data-tool="loupe"]\')'));
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'8',bubbles:true})); true;`);
  await sleep(30);
  check('数字键 8 -> loupe 工具', (await js('tool')) === 'loupe');

  // 框选一块 160×100(DIP)—— 先不松手,读 drawing.region 验证计算(不依赖离屏 rAF 的真实 send)
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:120,clientY:120,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:200,clientY:180,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:280,clientY:220,button:0,buttons:1}));
    return true;})()`);
  const reg = JSON.parse(await js('JSON.stringify(drawing && drawing.region)'));
  check('框选 region 计算正确', reg && reg.x === 120 && reg.y === 120 && reg.w === 160 && reg.h === 100);
  check('框选中显示橡皮筋', await js('!!document.querySelector(".loupe-band")'));
  // 松手 -> 进入 shooting(藏工具条/橡皮筋),准备抓屏
  await js(`window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:280,clientY:220,button:0})); true;`);
  check('松手后进入 shooting(藏工具条)', await js('document.body.classList.contains("shooting")'));
  check('框选橡皮筋已移除', await js('!document.querySelector(".loupe-band")'));

  // 模拟主进程回传放大快照(渲染端流程;真实抓屏由 shot-geom 单测 + e2e-capture 覆盖)
  wc.send('loupe-result', { ok: true, region: reg, dataURL: PNG1x1 });
  await sleep(150);
  check('撤销 shooting(工具条复原)', !(await js('document.body.classList.contains("shooting")')));
  const it = JSON.parse(await js('JSON.stringify(items[items.length-1]||null)'));
  check('建了 loupe item(带 img)', it && it.type === 'loupe' && it.x === 120 && it.y === 120 && it.w === 160 && it.h === 100 && /^data:image/.test(it.img));
  check('渲染出镜片 div(尺寸=源×2)', await js(`(function(){
    const d=document.querySelector('.loupe[data-id]');
    return !!d && d.style.width==='320px' && d.style.height==='200px';})()`));
  check('提示"放大镜已放置"', await js('/放大镜已放置/.test(document.getElementById("shot-toast").textContent)'));

  // 拖动镜片:移位后 item.x/y 变
  await js(`(function(){
    const d=document.querySelector('.loupe[data-id]');
    d.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:130,clientY:130,button:0}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:230,clientY:180,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:230,clientY:180,button:0}));
    return true;})()`);
  await sleep(40);
  const moved = JSON.parse(await js('JSON.stringify(items[items.length-1])'));
  check('镜片可拖动(位置更新)', moved.x === 220 && moved.y === 170);

  // —— 形状:右键放大镜按钮切圆形,新镜片带 .circle ——
  await js(`document.querySelector('[data-tool="loupe"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); true;`);
  check('右键放大镜按钮 -> 形状=圆形', (await js('loupeShape')) === 'circle');
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:400,clientY:120,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:480,clientY:200,button:0,buttons:1}));
    return true;})()`);
  const reg2 = JSON.parse(await js('JSON.stringify(drawing && drawing.region)'));
  await js(`window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:480,clientY:200,button:0})); true;`);
  wc.send('loupe-result', { ok: true, region: reg2, dataURL: PNG1x1 });
  await sleep(120);
  check('圆形放大镜 item.shape=circle', (await js('items[items.length-1].shape')) === 'circle');
  check('圆形镜片有 .circle class', await js('!!document.querySelector(".loupe.circle[data-id]")'));

  // 太小的框忽略(不进 shooting)
  await js(`(function(){
    const svg=document.getElementById('canvas');
    svg.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:400,clientY:300,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:404,clientY:303,button:0,buttons:1}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:404,clientY:303,button:0}));
    return true;})()`);
  await sleep(40);
  check('太小的框被忽略(不进 shooting)', !(await js('document.body.classList.contains("shooting")')));

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
