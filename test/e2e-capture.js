// 抓屏管线实机探针:真跑 desktopCapturer 抓主屏 -> 用 shot-geom 裁一块 -> 复制剪贴板 -> 落盘。
// 验证这台机器的截图链路可用、裁剪尺寸正确。用法: electron test/e2e-capture.js
'use strict';
process.env.WA_TEST = '1';
const { app, screen, desktopCapturer, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const shotGeom = require('../src/shot-geom');
const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'capture-result.txt');
try { fs.writeFileSync(RESULT, 'capture start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 15000);

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };

  const disp = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) },
  });
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  check('拿到屏幕源且非空', !!src && !src.thumbnail.isEmpty());
  if (!src || src.thumbnail.isEmpty()) { logf(fails + ' FAILED'); return app.exit(1); }

  const thumb = src.thumbnail.getSize();
  logf('thumb=' + JSON.stringify(thumb) + ' sf=' + sf + ' dispSize=' + JSON.stringify(disp.size));

  // 取屏幕里一块 400x300 的"窗口",按 shot-geom 裁
  const win = { x: disp.bounds.x + 200, y: disp.bounds.y + 150, width: 400, height: 300 };
  const crop = shotGeom.cropRect(win, disp.bounds, disp.size, thumb);
  logf('crop=' + JSON.stringify(crop));
  const shot = src.thumbnail.crop(crop);
  const sz = shot.getSize();
  check('裁剪出非空图', !shot.isEmpty());
  check('裁剪尺寸=请求的 crop', sz.width === crop.width && sz.height === crop.height);
  check('裁剪宽≈400*sf', Math.abs(crop.width - Math.round(400 * sf)) <= 2);
  check('裁剪高≈300*sf', Math.abs(crop.height - Math.round(300 * sf)) <= 2);

  // 放大镜走的是"抓区域→toDataURL"(去掉了慢的主进程 resize);确认序列化够快,不会撞渲染端兜底超时
  const t0 = Date.now();
  const url = shot.toDataURL();
  const dt = Date.now() - t0;
  check('toDataURL 非空且快(<1500ms,实际 ' + dt + 'ms)', url.length > 100 && dt < 1500);

  clipboard.writeImage(shot);
  check('剪贴板已写入图片', !clipboard.readImage().isEmpty());

  const file = path.join(OUT, 'capture-probe.png');
  fs.writeFileSync(file, shot.toPNG());
  check('PNG 落盘且非空', fs.existsSync(file) && fs.statSync(file).size > 0);

  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
