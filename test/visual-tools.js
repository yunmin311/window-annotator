// 纯视觉预览:把五种工具的成品摆开不重叠,连工具条一起截一张图,肉眼看新加的"方框/荧光笔"长什么样。
// 用法: electron test/visual-tools.js   输出 E2E_OUT/tools-preview.png
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.E2E_OUT || __dirname;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640, height: 460, show: false, frame: false, transparent: true,
    backgroundColor: '#fbfaf4', // 预览用浅底,好看清半透明荧光笔;真机是透明的
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));

  const items = [
    { id: 1, type: 'rect',  color: 'red',    from: [60, 70],  to: [300, 180], seed: 918273 },
    { id: 2, type: 'arrow', color: 'blue',   from: [420, 175], to: [520, 90], seed: 5551 },
    { id: 3, type: 'pen',   color: 'green',  points: [[360, 250], [380, 238], [410, 262], [445, 236], [480, 260], [515, 240]] },
    { id: 4, type: 'hl',    color: 'amber',  from: [60, 250], to: [300, 250] },
    { id: 5, type: 'note',  color: 'purple', x: 70, y: 320, text: '手写便签', rot: -2.4, size: 24 },
    { id: 6, type: 'hl',    color: 'green',  from: [360, 330], to: [560, 330] },
  ];
  win.webContents.send('init', { items, appName: '预览' });
  win.webContents.send('mode', 'draw'); // draw 模式才显示工具条,顺便展示新增的 ▭ 按钮
  await sleep(700);

  // 第一张:默认工具(画笔)—— 滑动高亮胶囊应停在画笔下
  fs.writeFileSync(path.join(OUT, 'tools-preview.png'), (await win.webContents.capturePage()).toPNG());

  // 切到"方框"工具,胶囊应平滑滑过去;等过渡结束(300ms)再截,证明指示器跟着选择走
  await win.webContents.executeJavaScript(`document.querySelector('[data-tool="rect"]').click()`);
  await sleep(500);
  const inkAt = await win.webContents.executeJavaScript(`(() => {
    const ink = getComputedStyle(document.getElementById('tool-ink'));
    const rectBtn = document.querySelector('[data-tool="rect"]');
    return JSON.stringify({ inkTransform: ink.transform, inkOpacity: ink.opacity, rectLeft: rectBtn.offsetLeft });
  })()`);
  console.log('ink state after selecting rect:', inkAt);
  fs.writeFileSync(path.join(OUT, 'tools-preview-rect.png'), (await win.webContents.capturePage()).toPNG());

  console.log('previews written to', OUT);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
