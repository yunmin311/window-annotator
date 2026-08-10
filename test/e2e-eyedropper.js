// 屏幕取色(吸管)e2e(渲染端):加载真实 overlay,进画笔模式,桩掉 window.EyeDropper,
// 点吸管 -> 取到的 hex 成为画笔色 + 出现自定义色块 + 弹提示 + 之后画的一笔用该色渲染。
// 再测"取消(Esc)"路径:颜色不变、不报错。用法: electron test/e2e-eyedropper.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'eyedropper-result.txt');
try { fs.writeFileSync(RESULT, 'eyedropper start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 25000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const w = new BrowserWindow({
    width: 600, height: 400, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  const wc = w.webContents;
  const js = (e) => wc.executeJavaScript(e);

  wc.send('mode', 'draw');
  await sleep(200);
  check('进入画笔模式', (await js('mode')) === 'draw');
  check('工具条有吸管按钮', await js('!!document.getElementById("eyedropper")'));
  check('默认画笔工具', (await js('tool')) === 'pen');

  // —— 成功取色路径 ——(桩掉原生 EyeDropper,固定返回一个带字母的 hex,顺带验证大写归一)
  const HEX = '#3e7df0', HEXU = '#3E7DF0';
  await js(`window.EyeDropper = class { open(){ return Promise.resolve({ sRGBHex: '${HEX}' }); } }; true;`);
  await js('document.getElementById("eyedropper").click(); true;');
  await sleep(150);
  check('取到的颜色成为当前画笔色(已大写归一)', (await js('color')) === HEXU);
  check('自定义色块已出现', await js('customSwatch.style.display !== "none"'));
  check('自定义色块被标为 active', await js('customSwatch.classList.contains("active")'));
  check('命名色块全部让出 active', await js('[...colorsBox.querySelectorAll(".swatch:not(.custom)")].every(s => !s.classList.contains("active"))'));
  check('弹出"已取色"提示且含 hex', await js(`document.getElementById("shot-toast").classList.contains("show") && document.getElementById("shot-toast").textContent.includes("${HEXU}")`));

  // —— 取到的色真的用于渲染:画一笔 pen,末条标注颜色 = hex,渲染出的 path stroke = hex ——
  await js(`(function(){
    const svg = document.getElementById('canvas');
    const md = (t,x,y)=>({bubbles:true,clientX:x,clientY:y,button:0,buttons:1});
    svg.dispatchEvent(new MouseEvent('mousedown', md('d',100,100)));
    window.dispatchEvent(new MouseEvent('mousemove', md('m',140,130)));
    window.dispatchEvent(new MouseEvent('mousemove', md('m',180,120)));
    window.dispatchEvent(new MouseEvent('mouseup', md('u',180,120)));
    return true;
  })()`);
  await sleep(80);
  check('新画的一笔 item.color = 取到的色', await js(`items.length>0 && items[items.length-1].color === "${HEXU}"`));
  check('渲染出的 path stroke = 取到的色', await js(`(function(){const p=document.querySelector('#ink-layer path:last-child');return p && p.getAttribute('stroke').toLowerCase()==="${HEX}";})()`));

  // —— 回到命名色块可正常切回,取消 active ——
  await js('document.querySelector(".swatch:not(.custom)").click(); true;');
  await sleep(30);
  check('切回命名色块后自定义色块让出 active', await js('!customSwatch.classList.contains("active")'));
  check('点自定义色块可回到该 hex', await js('customSwatch.click(); customSwatch.classList.contains("active") && color === "' + HEXU + '"'));

  // —— 取消(Esc)路径:open() 抛错,静默,颜色不变、页面不崩 ——
  await js('document.querySelector(".swatch:not(.custom)").click(); true;'); // 先切回命名色
  const before = await js('color');
  await js(`window.EyeDropper = class { open(){ return Promise.reject(new DOMException('aborted','AbortError')); } }; true;`);
  await js('document.getElementById("eyedropper").click(); true;');
  await sleep(120);
  check('取消取色后颜色不变', (await js('color')) === before);
  check('页面仍存活(没崩)', (await js('1+1')) === 2);

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
