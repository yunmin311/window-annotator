// 视觉+行为:把"绑定状态牌"两种状态各截一张,肉眼看清「跟随滚动中」/「钉在窗口·读不到滚动」长啥样,
// 顺便断言牌子的文字和状态类正确。用法: electron test/visual-bind.js  输出 E2E_OUT/bind-scroll.png / bind-window.png
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.E2E_OUT || __dirname;

const readBadge = (wc) => wc.executeJavaScript(`(() => {
  const b = document.getElementById('bind-badge');
  return JSON.stringify({ text: b.textContent, cls: b.className, opacity: getComputedStyle(b).opacity });
})()`);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const win = new BrowserWindow({
    width: 520, height: 340, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  win.showInactive(); // 让窗口真正合成(不抢焦点),离屏 show:false 会节流 compositor 导致首帧截图漏画
  const wc = win.webContents;
  // 预览铺个深底(真机是透明的),好看清浅色牌子;并关掉牌子的淡入过渡——
  // 离屏窗口(show:false)compositor 被节流,渐变不推进,读到的 opacity 会失真;关过渡后 opacity 直接反映状态。
  // 真机浮层是可见窗口,过渡照常工作,这里只是让测试确定性。
  await wc.executeJavaScript("document.body.style.background='linear-gradient(160deg,#2a2f37,#171a1f)'; document.getElementById('bind-badge').style.transition='none'; true");

  // 查看模式 + 一条标注垫底,再推绑定状态(牌子只在查看模式显示)
  wc.send('init', { items: [{ id: 1, type: 'hl', color: 'amber', from: [60, 120], to: [320, 120] }], appName: '预览' });
  wc.send('mode', 'view');
  await sleep(300);

  // 状态一:跟随滚动中(立即显示)
  wc.send('bind-state', 'scroll');
  await sleep(600);
  let s = JSON.parse(await readBadge(wc));
  console.log('scroll badge:', JSON.stringify(s));
  check('scroll 牌子文字对', s.text.includes('跟随滚动'));
  check('scroll 牌子状态类对', /\bscroll\b/.test(s.cls) && /\bshow\b/.test(s.cls));
  check('scroll 牌子可见', parseFloat(s.opacity) > 0.5);
  fs.writeFileSync(path.join(OUT, 'bind-scroll.png'), (await wc.capturePage()).toPNG());

  // 状态二:钉在窗口·读不到滚动(window 状态刻意延后 1.2s 才显示,躲切窗抖动;这里等过它)
  wc.send('bind-state', 'window');
  await sleep(1700);
  s = JSON.parse(await readBadge(wc));
  console.log('window badge:', JSON.stringify(s));
  check('window 牌子文字对', s.text.includes('钉在窗口'));
  check('window 牌子状态类对', /\bwindow\b/.test(s.cls) && /\bshow\b/.test(s.cls));
  check('window 牌子可见', parseFloat(s.opacity) > 0.5);
  fs.writeFileSync(path.join(OUT, 'bind-window.png'), (await wc.capturePage()).toPNG());

  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  console.log('previews written to', OUT);
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
