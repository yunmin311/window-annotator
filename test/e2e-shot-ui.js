// 截图 UI 流程 e2e(渲染端):加载真实 overlay,进画笔模式,点 📷 -> 该隐藏工具条并进入 shooting;
// 模拟主进程回传结果 -> 复原 + 弹提示。覆盖成功/失败两条路径。用法: electron test/e2e-shot-ui.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'shotui-result.txt');
try { fs.writeFileSync(RESULT, 'shotui start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 20000);

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
  check('工具条有 📷 按钮', await js('!!document.getElementById("shot")'));

  // —— 成功路径 ——
  await js('document.getElementById("shot").click(); true;');
  check('点 📷 -> body.shooting 立即加上', await js('document.body.classList.contains("shooting")'));
  check('shooting 期间工具条被隐藏(不进画面)', await js('getComputedStyle(document.getElementById("toolbar")).visibility === "hidden"'));
  wc.send('capture-result', { ok: true, file: 'C:/x/WA.png' });
  await sleep(150);
  check('收到成功结果 -> 撤销 shooting(工具条复原)', !(await js('document.body.classList.contains("shooting")')));
  check('工具条恢复可见', await js('getComputedStyle(document.getElementById("toolbar")).visibility !== "hidden"'));
  check('弹出"已复制到剪贴板"提示', await js('document.getElementById("shot-toast").classList.contains("show") && /剪贴板/.test(document.getElementById("shot-toast").textContent)'));

  // —— 失败路径 ——
  await js('document.getElementById("shot").click(); true;');
  await sleep(20);
  wc.send('capture-result', { ok: false, error: 'test-err' });
  await sleep(120);
  check('失败也复原', !(await js('document.body.classList.contains("shooting")')));
  check('弹出"截图失败"提示', await js('/失败/.test(document.getElementById("shot-toast").textContent)'));

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
