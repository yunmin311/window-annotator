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

setTimeout(() => { console.log('E2E TIMEOUT'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) fails++; };

  const target = new BrowserWindow({
    x: 200, y: 150, width: 720, height: 520,
    backgroundColor: '#fbfaf4', title: 'AnnotateTestTarget',
  });
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="font-family:sans-serif;padding:48px"><h1>目标窗口</h1><p>标注应该贴在这段文字上面。</p></body>'));
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

  const itemCount = await wc.executeJavaScript('items.length');
  check('画出 2 个标注对象 (实际 ' + itemCount + ')', itemCount === 2);

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
    noteState.ok && noteState.count === 3 && noteState.text === '测试便签');

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
  target.restore(); target.focus();
  await sleep(600);
  check('目标恢复后覆盖层重现', o.visible === true);

  // 跟随滚动:查看模式下给一个滚动量,标注整体平移(scrollY=-60 -> 图层 translate 60)
  main.setDrawMode(o, false);
  await sleep(150);
  o.win.webContents.send('scroll', -60);
  await sleep(200);
  const sc = await wc.executeJavaScript('scrollY');
  const tf = await wc.executeJavaScript(`document.getElementById('scroll-g').getAttribute('transform')`);
  check(`跟随滚动平移 (scrollY=${sc}, transform=${tf})`, sc === -60 && /translate\(0 60\)/.test(tf || ''));

  // 存档落盘
  const dataFile = path.join(__dirname, '..', 'data', 'annotations.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch {}
  const key = Object.keys(saved).find((k) => k.includes('AnnotateTestTarget')) ||
              Object.keys(saved).find((k) => (saved[k] || []).length === 3);
  check('标注已存档 data/annotations.json', !!key && saved[key].length === 3);

  // 截图覆盖层(透明底,只有笔迹和工具条)
  const img = await wc.capturePage();
  const capPath = path.join(OUT, 'e2e-overlay.png');
  fs.writeFileSync(capPath, img.toPNG());
  console.log('overlay capture:', capPath);

  // 清理测试存档
  if (key) { delete saved[key]; fs.writeFileSync(dataFile, JSON.stringify(saved, null, 1)); }

  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((err) => { console.error('E2E ERROR:', err); app.exit(3); });
