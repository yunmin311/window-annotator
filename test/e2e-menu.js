// 托盘自绘菜单 e2e(渲染端):加载真实 menu.html,喂一份 menu-state,验证
// 新增的「截图保存位置…」行存在、显示当前文件夹名、点击派发 set-shots-dir;顺带验证勾选态渲染。
// 用法: electron test/e2e-menu.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { trayMenuWindowOptions, createWarmMenuSurface } = require('../src/tray-menu-window');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'menu-result.txt');
try { fs.writeFileSync(RESULT, 'menu start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 20000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const w = new BrowserWindow({
    ...trayMenuWindowOptions(),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'tray-menu', 'menu.html'));
  const wc = w.webContents;
  const js = (e) => wc.executeJavaScript(e);
  let sizeReports = 0;
  const onMenuSize = (event) => { if (event.sender === wc) sizeReports++; };
  ipcMain.on('menu-size', onMenuSize);

  check('菜单有「设置截图保存位置」行', await js('!!document.querySelector(\'[data-action="set-shots-dir"]\')'));
  check('该行紧挨「打开截图文件夹」之前', await js(`(function(){
    const set = document.querySelector('[data-action="set-shots-dir"]');
    const open = document.querySelector('[data-action="open-shots"]');
    return !!set && !!open && (set.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })()`));

  // 喂一份状态,含当前截图文件夹名。首次保持可见,确保建立一份尺寸基线。
  w.show();
  wc.send('menu-state', {
    autostart: false, follow: true,
    annotateKey: 'Ctrl+Alt+A', quitKey: 'Ctrl+Alt+Q', shotsName: 'MyShots',
  });
  await sleep(150);
  check('首次打开会报告菜单尺寸', sizeReports >= 1);
  check('显示当前截图文件夹名', (await js('document.getElementById("sc-shots").textContent')) === 'MyShots');
  check('跟随滚动勾选态已渲染', await js('document.getElementById("row-follow").classList.contains("on")'));
  check('开机自启未勾选', await js('!document.getElementById("row-autostart").classList.contains("on")'));

  // 模拟真实生命周期:首次显示后隐藏,第二次托盘左键再次发送状态。
  const firstSizeReports = sizeReports;
  w.hide();
  wc.send('menu-state', {
    autostart: true, follow: false,
    annotateKey: 'Ctrl+Alt+A', quitKey: 'Ctrl+Alt+Q', shotsName: 'MyShots2',
  });
  await sleep(250);
  check('隐藏后第二次打开仍会报告菜单尺寸', sizeReports > firstSizeReports);

  const surface = await js(`(function(){
    const bodyStyle = getComputedStyle(document.body);
    const cardStyle = getComputedStyle(document.querySelector('.menu'));
    const shadows = [];
    let part = '', depth = 0;
    for (const char of cardStyle.boxShadow) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (char === ',' && depth === 0) { shadows.push(part.trim()); part = ''; }
      else part += char;
    }
    if (part.trim()) shadows.push(part.trim());
    return {
      padding: bodyStyle.padding,
      outerShadowFree: cardStyle.boxShadow === 'none' || shadows.every((shadow) => shadow.includes('inset')),
    };
  })()`);
  check('圆角菜单没有形成方形底板的透明外边距', surface.padding === '0px');
  check('圆角菜单阴影不再伸出卡片并被矩形窗口裁切', surface.outerShadowFree);

  const warmSurface = createWarmMenuSurface({ win: w });
  warmSurface.warm();
  await sleep(60);
  check('预热后的原生窗口保持显示但完全透明', w.isVisible() && w.getOpacity() === 0);
  warmSurface.open({ x: 20, y: 20, width: 196, height: 246 });
  check('打开菜单只恢复常驻窗口透明度', w.isVisible() && w.getOpacity() === 1);
  warmSurface.close();
  await sleep(60);
  check('关闭菜单后窗口不 hide,仅回到完全透明', w.isVisible() && w.getOpacity() === 0);

  // 点「设置截图保存位置…」应派发 tray-action:set-shots-dir(拦截 ipcRenderer.send 记录)
  await js('window.__sent=null; require("electron").ipcRenderer.send=(ch,...a)=>{window.__sent=[ch,...a]}; true;');
  await js('document.querySelector(\'[data-action="set-shots-dir"]\').click(); true;');
  await sleep(60);
  check('点击派发 tray-action:set-shots-dir', await js('JSON.stringify(window.__sent)===JSON.stringify(["tray-action","set-shots-dir"])'));

  ipcMain.removeListener('menu-size', onMenuSize);
  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
