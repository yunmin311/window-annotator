// 抓一张"真实"自绘托盘菜单(加载 tray-menu/menu.html,喂一份状态,量尺寸 + 截图),
// 用来肉眼核对比例/左列间隙/对勾,并验证自适应量尺寸这条链路。用法: electron test/shoot-menu.js
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.SHOOT_OUT || __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 360, height: 400, show: false, frame: false, transparent: true,
    hasShadow: false, webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'tray-menu', 'menu.html'));

  let sized = null;
  ipcMain.on('menu-size', (e, size) => { sized = size; });

  // 模拟主进程在右键时发来的状态:开机自启=开、跟随=关(好核对对勾的有/无)
  w.webContents.send('menu-state', {
    autostart: true, follow: false, annotateKey: 'Ctrl+Alt+A', quitKey: 'Ctrl+Alt+Q',
  });

  for (let i = 0; i < 40 && !sized; i++) await sleep(50); // 等 renderer 量完回报
  console.log('menu-size =', JSON.stringify(sized));
  await sleep(200);

  const img = await w.webContents.capturePage();
  const out = path.join(OUT, 'menu-real.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out);

  const ok = sized && sized.cardW > 150 && sized.cardW < 340 && sized.cardH > 150 && sized.cardH < 340;
  console.log(ok ? 'SIZE OK' : 'SIZE SUSPECT');
  app.exit(ok ? 0 : 1);
});
