// 工具条液态进出 e2e(渲染端):进画笔 -> .shown(弹入)、离开 -> .hiding(退场)、再进 -> 重播;
// 并校验入场后 tool-ink 高亮准确落在当前工具下(不再飘成"白椭圆")。用法: electron test/e2e-toolbaranim.js
'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'toolbaranim-result.txt');
try { fs.writeFileSync(RESULT, 'toolbaranim start\n'); } catch {}
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
  const cls = () => js('document.getElementById("toolbar").className');

  // 读 #toolbar transform 矩阵的 scaleX(matrix 的第一个分量 a);隐藏/落定都能读
  const scaleX = () => js(`(function(){const t=getComputedStyle(document.getElementById('toolbar')).transform;
    const m=t.match(/matrix\\(([^)]+)\\)/);return m?parseFloat(m[1].split(',')[0]):1;})()`);

  // 初始 view:工具条静止隐藏态,不可见,且基态被压成"短胶囊"(scaleX 明显 < 1)——弹开动画的起点
  check('初始工具条不可见(隐藏态)', (await js('getComputedStyle(document.getElementById("toolbar")).visibility')) === 'hidden');
  check('初始基态是压缩胶囊(scaleX<.8)', (await scaleX()) < 0.8);

  // 进入画笔:加 .shown,可见
  wc.send('mode', 'draw');
  await sleep(60);
  check('进画笔:加上 .shown', (await cls()).includes('shown'));
  check('进画笔:没有 .hiding', !(await cls()).includes('hiding'));
  await sleep(120);
  check('进画笔:工具条可见', (await js('getComputedStyle(document.getElementById("toolbar")).visibility')) === 'visible');

  // 等入场动画+摆位结束,校验 tool-ink 高亮准确落在画笔按钮下(不飘成白椭圆)
  await sleep(720);
  const ink = await js(`(function(){
    const el=document.getElementById('tool-ink');
    const pen=document.querySelector('[data-tool="pen"]');
    const ir=el.getBoundingClientRect(), pr=pen.getBoundingClientRect();
    return { op:getComputedStyle(el).opacity, dLeft:Math.round(Math.abs(ir.left-pr.left)), dW:Math.round(Math.abs(ir.width-pr.width)) };
  })()`);
  check('tool-ink 已淡入(opacity≈1)', Number(ink.op) > 0.9);
  check('tool-ink 落在画笔按钮下(左沿对齐,dLeft=' + ink.dLeft + ')', ink.dLeft <= 3);
  check('tool-ink 宽度≈按钮(dW=' + ink.dW + ')', ink.dW <= 3);
  const sx = await scaleX();
  check('弹开落定后 scaleX≈1(回到全宽,不残留拉伸,sx=' + sx.toFixed(3) + ')', Math.abs(sx - 1) < 0.02);

  // 真机点击层面:pointer-events 必须是 auto(否则整条继承 none = 按钮全点不动),且命中检测真落在按钮上。
  // 用 elementFromPoint 而不是 .click():前者尊重 pointer-events/visibility,能抓到"看得见却点不动"的坑。
  const hit = await js(`(function(){
    const pe = getComputedStyle(document.getElementById('toolbar')).pointerEvents;
    const btn = document.getElementById('undo'), r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
    return { pe, onBtn: !!(el && el.closest && el.closest('#undo')) };
  })()`);
  check('工具条 pointer-events=auto(能接住点击)', hit.pe === 'auto');
  check('命中检测真落在工具按钮上(不穿透)', hit.onBtn);

  // 离开画笔:加 .hiding、去 .shown,退场后不可见
  wc.send('mode', 'view');
  await sleep(40);
  check('离开:加上 .hiding', (await cls()).includes('hiding'));
  check('离开:去掉 .shown', !(await cls()).includes('shown'));
  await sleep(420);
  check('退场结束:工具条不可见', (await js('getComputedStyle(document.getElementById("toolbar")).visibility')) === 'hidden');
  check('退场后 pointer-events=none(不挡下面)', (await js('getComputedStyle(document.getElementById("toolbar")).pointerEvents')) === 'none');

  // 再次进入:重播弹入(.shown 回来、.hiding 走)
  wc.send('mode', 'draw');
  await sleep(60);
  check('再进:重新 .shown', (await cls()).includes('shown'));
  check('再进:清掉 .hiding', !(await cls()).includes('hiding'));

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
