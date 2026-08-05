// 端到端自测:造一个目标窗口 -> 贴覆盖层 -> 程序内模拟画笔 -> 校验跟随移动 + 存档 + 截图
// 用法: electron test/e2e-main.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const main = require('../main.js');
const win32 = require('../src/win32');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.E2E_OUT || __dirname;
// 结果逐行写文件,躲开 stdout 缓冲 / 后台任务被杀导致的空输出(同 e2e-scroll 的做法)
const RESULT = path.join(OUT, 'main-result.txt');
try { fs.writeFileSync(RESULT, 'e2e-main start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };

setTimeout(() => { logf('E2E TIMEOUT'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (name, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) fails++; };

  const target = new BrowserWindow({
    x: 200, y: 150, width: 720, height: 520,
    backgroundColor: '#fbfaf4', title: 'AnnotateTestTarget',
  });
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="font-family:sans-serif;padding:48px"><h1>目标窗口</h1><p>标注应该贴在这段文字上面。</p></body>'));
  app.focus({ steal: true }); // 强制本进程到前台:躲开 Windows 前台锁(自动化下 focus() 常被拦,窗口拿不到前台)
  target.focus();
  await sleep(1000);

  const thwnd = target.getNativeWindowHandle().readBigInt64LE(0);
  const info = win32.getWindowInfo(thwnd);
  console.log('target:', JSON.stringify(info));

  main.createOverlay(thwnd, info);
  const o = main.overlays.get(win32.hkey(thwnd));
  check('覆盖层已创建', !!o);
  if (!o) { app.exit(1); return; }
  for (let t = 0; t < 150 && !(o.drawMode && o.visible); t++) await sleep(100); // 等加载+贴附完成
  check('进入标注模式', o.drawMode === true);
  check('覆盖层可见', o.visible === true);
  await sleep(300);

  const before = { overlay: o.win.getBounds(), target: target.getBounds() };
  console.log('bounds before:', JSON.stringify(before));

  // 程序内模拟一笔波浪线(不经过 OS 键鼠)
  const wc = o.win.webContents;
  const send = (type, x, y, extra = {}) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  send('mouseDown', 140, 260);
  for (let i = 0; i <= 22; i++) {
    send('mouseMove', 140 + i * 16, 260 + Math.sin(i / 3.2) * 45, { buttons: 1 });
    await sleep(14);
  }
  send('mouseUp', 492, 260);
  await sleep(300);

  // 再模拟一支箭头
  wc.executeJavaScript(`document.querySelector('[data-tool="arrow"]').click()`);
  await sleep(120);
  send('mouseDown', 200, 380);
  for (let i = 0; i <= 10; i++) { send('mouseMove', 200 + i * 22, 380 - i * 12, { buttons: 1 }); await sleep(14); }
  send('mouseUp', 420, 260);
  await sleep(600);

  // 方框:拖一个矩形框
  await wc.executeJavaScript(`document.querySelector('[data-tool="rect"]').click()`);
  await sleep(80);
  send('mouseDown', 250, 300);
  for (let i = 0; i <= 10; i++) { send('mouseMove', 250 + i * 25, 300 + i * 12, { buttons: 1 }); await sleep(14); }
  send('mouseUp', 500, 420);
  await sleep(300);

  // 荧光笔:用渲染进程内合成的 DOM 事件同步划一道近水平线,验证"自动拉平成直带"。
  // (不走 sendInputEvent:那样合成事件不动物理光标,睡眠间隙里真实光标的 mousemove 会串进来污染终点)
  const hlItem = await wc.executeJavaScript(`(() => {
    document.querySelector('[data-tool="hl"]').click();
    const svg = document.getElementById('canvas');
    const fire = (el, type, x, y, b) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: b, bubbles: true }));
    fire(svg, 'mousedown', 160, 450, 1);
    for (let i = 1; i <= 12; i++) fire(window, 'mousemove', 160 + i * 25, 450 + Math.sin(i) * 4, 1); // 近水平抖动
    fire(window, 'mouseup', 460, 448, 0);
    const h = items.filter(i => i.type === 'hl').pop() || null;
    return JSON.stringify(h && { from: h.from, to: h.to });
  })()`);
  await sleep(200);
  const hl = JSON.parse(hlItem || 'null');

  const itemCount = await wc.executeJavaScript('items.length');
  check('画出 4 个标注对象:笔/箭头/方框/荧光 (实际 ' + itemCount + ')', itemCount === 4);
  const kinds = await wc.executeJavaScript('items.map(i => i.type).join(",")');
  check('含方框对象', /(^|,)rect(,|$)/.test(kinds));
  check('荧光笔=直带且近水平自动拉平 (' + hlItem + ')',
    !!hl && !!hl.from && !!hl.to && hl.from[1] === hl.to[1]);

  // 手写便签:选文字工具 -> 点一下进入编辑 -> 输入 -> 失焦保存
  await wc.executeJavaScript(`document.querySelector('[data-tool="note"]').click()`);
  await sleep(80);
  send('mouseDown', 300, 300); send('mouseUp', 300, 300);
  await sleep(120);
  const noteState = await wc.executeJavaScript(`(() => {
    const d = document.querySelector('.note.editing');
    if (!d) return { ok: false };
    d.innerText = '测试便签'; d.blur();
    return { ok: true, count: items.length, text: (items.find(i => i.type === 'note') || {}).text };
  })()`);
  check('手写便签可创建并输入文字 (' + JSON.stringify(noteState) + ')',
    noteState.ok && noteState.count === 5 && noteState.text === '测试便签');

  // 移动+缩放目标窗口,覆盖层应跟上(容差 DWM 不可见边框)
  target.setBounds({ x: 340, y: 260, width: 780, height: 560 });
  await sleep(600);
  const after = { overlay: o.win.getBounds(), target: target.getBounds() };
  console.log('bounds after:', JSON.stringify(after));
  const dxT = after.target.x - before.target.x, dxO = after.overlay.x - before.overlay.x;
  const dyT = after.target.y - before.target.y, dyO = after.overlay.y - before.overlay.y;
  check(`跟随移动 (目标Δ${dxT},${dyT} / 覆盖层Δ${dxO},${dyO})`, Math.abs(dxT - dxO) <= 2 && Math.abs(dyT - dyO) <= 2);
  const dwT = after.target.width - before.target.width, dwO = after.overlay.width - before.overlay.width;
  check(`跟随缩放 (目标Δw${dwT} / 覆盖层Δw${dwO})`, Math.abs(dwT - dwO) <= 2);

  // 标注模式截图(带工具条)
  fs.writeFileSync(path.join(OUT, 'e2e-drawmode.png'), (await wc.capturePage()).toPNG());

  // 最小化 -> 覆盖层应隐藏;恢复 -> 应重现
  target.minimize();
  await sleep(500);
  check('目标最小化后覆盖层隐藏', o.visible === false);
  target.restore(); app.focus({ steal: true }); target.focus();
  await sleep(600);
  check('目标恢复后覆盖层重现', o.visible === true);

  // 跟随滚动:查看模式下给一个滚动量,标注整体平移(scrollY=-60 -> 图层 translate 60)
  main.setDrawMode(o, false);
  await sleep(150);
  o.win.webContents.send('scroll-to', -60); // UIA 跟随:主进程发的是绝对目标位移
  // 缓动逼近目标,轮询等它追平(rAF 后台可能被限帧)
  let sc = 0;
  for (let t = 0; t < 40 && sc !== -60; t++) { await sleep(30); sc = await wc.executeJavaScript('scrollY'); }
  const tgt = await wc.executeJavaScript('targetScrollY');
  const tf = await wc.executeJavaScript(`document.getElementById('scroll-g').getAttribute('transform')`);
  check(`跟随滚动平移 (scrollY=${sc}, target=${tgt}, transform=${tf})`,
    tgt === -60 && sc === -60 && /translate\(0 60\)/.test(tf || ''));

  // 存档落盘
  const dataFile = path.join(__dirname, '..', 'data', 'annotations.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch {}
  const key = Object.keys(saved).find((k) => k.includes('AnnotateTestTarget')) ||
              Object.keys(saved).find((k) => (saved[k] || []).length === 5);
  check('标注已存档 data/annotations.json', !!key && saved[key].length === 5);

  // 截图覆盖层(透明底,只有笔迹和工具条)
  const img = await wc.capturePage();
  const capPath = path.join(OUT, 'e2e-overlay.png');
  fs.writeFileSync(capPath, img.toPNG());
  console.log('overlay capture:', capPath);

  // 清理测试存档
  if (key) { delete saved[key]; fs.writeFileSync(dataFile, JSON.stringify(saved, null, 1)); }

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((err) => { logf('E2E ERROR: ' + (err && err.stack || err)); app.exit(3); });
