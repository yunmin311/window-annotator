// 键鼠交互 e2e(渲染端):白色画笔色、数字键 1-6 切工具、滚轮"切工具"模式、鼠标中键循环滚轮模式。
// 用法: electron test/e2e-keywheel.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'keywheel-result.txt');
try { fs.writeFileSync(RESULT, 'keywheel start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 25000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const w = new BrowserWindow({
    width: 900, height: 400, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  const wc = w.webContents;
  const js = (e) => wc.executeJavaScript(e);

  wc.send('mode', 'draw');
  await sleep(150);

  // —— 白色画笔色 ——
  check('COLORS 含 white=#ffffff', await js('COLORS.white === "#ffffff"'));
  check('调色板渲染出白色块', await js('!!document.querySelector(\'.swatch[title="white"]\')'));
  check('白色块有 .light 描边类', await js('document.querySelector(\'.swatch[title="white"]\').classList.contains("light")'));
  await js('document.querySelector(\'.swatch[title="white"]\').click(); true;');
  check('点白块 -> 画笔色变白', (await js('color')) === 'white');
  // 画一笔,渲染 stroke 应是白
  await js(`(function(){const svg=document.getElementById('canvas');
    const md=(x,y)=>({bubbles:true,clientX:x,clientY:y,button:0,buttons:1});
    svg.dispatchEvent(new MouseEvent('mousedown',md(80,80)));
    window.dispatchEvent(new MouseEvent('mousemove',md(120,110)));
    window.dispatchEvent(new MouseEvent('mouseup',md(120,110)));return true;})()`);
  await sleep(60);
  check('白笔渲染 stroke=#ffffff', await js('document.querySelector("#ink-layer path:last-child").getAttribute("stroke").toLowerCase()==="#ffffff"'));

  // —— 数字键 1-6 切工具 ——
  const dn = (k) => js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',bubbles:true})); true;`);
  await dn('3'); await sleep(30);
  check('数字键 3 -> rect', (await js('tool')) === 'rect');
  await dn('6'); await sleep(30);
  check('数字键 6 -> eraser', (await js('tool')) === 'eraser');
  await dn('1'); await sleep(30);
  check('数字键 1 -> pen', (await js('tool')) === 'pen');
  check('active 工具按钮同步到 pen', await js('document.querySelector("[data-tool].active").dataset.tool === "pen"'));

  // 编辑便签时数字键不抢(应仍能输入):模拟一个 contentEditable 聚焦
  await js(`(function(){const d=document.createElement('div');d.contentEditable='true';d.id='__probe';document.body.appendChild(d);d.focus();return true;})()`);
  const toolBefore = await js('tool');
  await dn('4'); await sleep(30);
  check('编辑态(contentEditable)下数字键不切工具', (await js('tool')) === toolBefore);
  await js('document.getElementById("__probe").remove(); true;');

  // —— 滚轮模式:默认 opacity;中键循环 opacity->zoom->tool->opacity ——
  check('默认滚轮模式 opacity', (await js('wheelMode')) === 'opacity');
  const mdEvt = (btn) => js(`window.dispatchEvent(new MouseEvent('mousedown',{button:${btn},bubbles:true})); true;`);
  await mdEvt(1); await sleep(20);
  check('中键1次 -> zoom', (await js('wheelMode')) === 'zoom');
  await mdEvt(1); await sleep(20);
  check('中键2次 -> tool', (await js('wheelMode')) === 'tool');
  check('wheel-mode 按钮字形=✎(tool)', (await js('document.getElementById("wheel-mode").textContent')) === '✎');
  await mdEvt(1); await sleep(20);
  check('中键3次 -> 回到 opacity(三态循环)', (await js('wheelMode')) === 'opacity');

  // —— 滚轮"切工具"模式:滚一格切下一个工具 ——
  await js('setWheelMode("tool"); true;');
  await js('selectTool("pen"); true;');
  const wheel = (dy) => js(`window.dispatchEvent(new WheelEvent('wheel',{deltaY:${dy},bubbles:true,cancelable:true})); true;`);
  await wheel(120); await sleep(30);
  check('tool模式 下滚 -> pen 的下一个 arrow', (await js('tool')) === 'arrow');
  await wheel(-120); await sleep(30);
  check('tool模式 上滚 -> 回到 pen', (await js('tool')) === 'pen');
  await wheel(-120); await sleep(30);
  check('tool模式 上滚在头部循环 -> loupe(最后一个)', (await js('tool')) === 'loupe');

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
