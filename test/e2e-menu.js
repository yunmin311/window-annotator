// 托盘自绘菜单 e2e(渲染端):加载真实 menu.html,喂一份 menu-state,验证
// 新增的「截图保存位置…」行存在、显示当前文件夹名、点击派发 set-shots-dir;顺带验证勾选态渲染。
// 用法: electron test/e2e-menu.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
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
    width: 360, height: 400, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'tray-menu', 'menu.html'));
  const wc = w.webContents;
  const js = (e) => wc.executeJavaScript(e);

  check('菜单有「设置截图保存位置」行', await js('!!document.querySelector(\'[data-action="set-shots-dir"]\')'));
  check('该行紧挨「打开截图文件夹」之前', await js(`(function(){
    const set = document.querySelector('[data-action="set-shots-dir"]');
    const open = document.querySelector('[data-action="open-shots"]');
    return !!set && !!open && (set.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })()`));

  // 喂一份状态,含当前截图文件夹名
  wc.send('menu-state', {
    autostart: false, follow: true,
    annotateKey: 'Ctrl+Alt+A', quitKey: 'Ctrl+Alt+Q', shotsName: 'MyShots',
  });
  await sleep(150);
  check('显示当前截图文件夹名', (await js('document.getElementById("sc-shots").textContent')) === 'MyShots');
  check('跟随滚动勾选态已渲染', await js('document.getElementById("row-follow").classList.contains("on")'));
  check('开机自启未勾选', await js('!document.getElementById("row-autostart").classList.contains("on")'));

  // 点「设置截图保存位置…」应派发 tray-action:set-shots-dir(拦截 ipcRenderer.send 记录)
  await js('window.__sent=null; require("electron").ipcRenderer.send=(ch,...a)=>{window.__sent=[ch,...a]}; true;');
  await js('document.querySelector(\'[data-action="set-shots-dir"]\').click(); true;');
  await sleep(60);
  check('点击派发 tray-action:set-shots-dir', await js('JSON.stringify(window.__sent)===JSON.stringify(["tray-action","set-shots-dir"])'));

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
