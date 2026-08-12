// 生成 README 用的"工具条液态玻璃 进出"动图 docs/toolbar-pop.gif。
// 做法:一条 cycle 关键帧走完「凝结登场 → 停留 → 收拢退场」,用 animation-delay 负值 + paused 冻结在若干
// 进度点,逐帧 capturePage(冻结帧是静态计算值,绕开离屏限帧),再用 gifenc(纯 JS,仅生成时用)编码循环。
// 材质/动画与 overlay.css 的 #toolbar(液态玻璃 + toolbar-in/out)保持一致。用法: electron docs/gen-pop-gif.js
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc'); // 纯 JS,CJS 直接 require(别用 import(),会卡)

app.commandLine.appendSwitch('force-device-scale-factor', '1'); // 让 capturePage 的像素尺寸=窗口尺寸,便于喂 gif
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 30000); // 卡住就退,别无限挂

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = __dirname;
const W = 980, H = 190, DUR = 2.6;   // 一整轮(进+停+出)的名义时长,progress 0..1 对应 cycle 关键帧百分比

// 冻结帧的 bar:cycle 关键帧 0-20%=液态登场(虚→实+过冲+落定),20-72%=停留,75-92%=收拢退场
const html = (progress) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
body{width:100vw;height:100vh;overflow:hidden;position:relative;background:
  radial-gradient(520px 280px at 26% 30%, rgba(120,140,255,.34), transparent 60%),
  radial-gradient(480px 260px at 76% 72%, rgba(255,168,120,.30), transparent 62%),
  linear-gradient(135deg,#eef1f8,#e5ebf6)}
#bar{position:absolute;left:50%;top:50%;
  display:flex;align-items:center;gap:5px;border-radius:999px;padding:11px 20px;overflow:hidden;
  background:
    linear-gradient(115deg, transparent 46%, rgba(255,255,255,.08) 50%, transparent 54%),
    linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,0) 34%),
    linear-gradient(180deg, rgba(46,46,52,.86), rgba(20,20,24,.93));
  -webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 14px 40px rgba(0,0,0,.42),0 2px 6px rgba(0,0,0,.30),
    inset 0 1px .5px rgba(255,255,255,.55),inset 0 -1px 1px rgba(255,255,255,.10),
    inset 1px 0 1.5px rgba(255,255,255,.08),inset -1px 0 1.5px rgba(255,255,255,.08);
  transform-origin:center center;
  animation:cycle ${DUR}s linear forwards;
  animation-delay:-${(progress * DUR).toFixed(3)}s;animation-play-state:paused}
/* cycle:胶囊弹开(squash-stretch 过冲回弹)→ 停留 → 收拢回胶囊。与 overlay.css 的 toolbar-in/out 同型 */
@keyframes cycle{
  0%  {opacity:0;transform:translate(-50%,-50%) scaleX(.62) scaleY(.8)}    /* 短胶囊 */
  6%  {opacity:1}
  11% {transform:translate(-50%,-50%) scaleX(1.05) scaleY(1.03)}          /* 冲过头 */
  15% {transform:translate(-50%,-50%) scaleX(.982) scaleY(.99)}           /* 回弹 */
  18% {transform:translate(-50%,-50%) scaleX(1.007) scaleY(1.004)}        /* 小弹 */
  20% {opacity:1;transform:translate(-50%,-50%) scaleX(1) scaleY(1)}      /* 落定 */
  74% {opacity:1;transform:translate(-50%,-50%) scaleX(1) scaleY(1)}      /* 停留 */
  86% {opacity:0;transform:translate(-50%,-50%) scaleX(.66) scaleY(.82)}  /* 收回胶囊 */
  100%{opacity:0;transform:translate(-50%,-50%) scaleX(.66) scaleY(.82)}}
#bar .app{color:rgba(255,255,255,.5);font-size:12px;padding:0 5px;white-space:nowrap}
#bar .sep{width:1px;height:20px;background:rgba(255,255,255,.18);margin:0 7px}
#bar button{border:none;background:transparent;color:#f0f0f2;width:34px;height:34px;border-radius:50%;font-size:16px;display:inline-flex;align-items:center;justify-content:center}
#bar button.on{background:rgba(255,255,255,.16);border-radius:10px}
#bar button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
#bar button.ink{font-family:'Ink Free','Segoe Print',cursive;font-weight:700}
#bar i{width:16px;height:16px;border-radius:50%;display:inline-block;margin:0 2px;border:2px solid transparent}
#bar i.on{border-color:#fff}
#bar b{margin-left:7px;padding:7px 14px;background:rgba(255,255,255,.18);border-radius:999px;color:#fff;font-size:13px;white-space:nowrap}
</style></head><body>
  <div id="bar">
    <span class="app">当前窗口</span><button style="opacity:.62">◧</button><span class="sep"></span>
    <button>✏️</button><button class="on">↗</button><button>▭</button><button>▆</button><button class="ink">Aa</button><button><svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"/><path d="M22 21H8"/><path d="m5 11 9 9"/></svg></button><button>📐</button><button><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="m21 21-4.6-4.6"/><path d="M10.5 7.5v6M7.5 10.5h6"/></svg></button>
    <span class="sep"></span>
    <i style="background:#3d3d40"></i><i style="background:#e5484d" class="on"></i><i style="background:#ee9d2b"></i><i style="background:#2f9e63"></i><i style="background:#0e8fd8"></i><i style="background:#8e4ec6"></i><i style="background:#ffffff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.22)"></i>
    <button title="取色"><svg viewBox="0 0 24 24"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4Z"/></svg></button>
    <span class="sep"></span>
    <button><svg viewBox="0 0 24 24"><path d="M4 9a2 2 0 0 1 2-2h1.6l.9-1.5A1 1 0 0 1 9.4 5h5.2a1 1 0 0 1 .9.5L16.4 7H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.8" r="3"/></svg></button><button><svg viewBox="0 0 24 24"><path d="M8 5 4 9l4 4"/><path d="M4 9h9a5 5 0 0 1 0 10h-1"/></svg></button><button><svg viewBox="0 0 24 24"><path d="M5 7h14"/><path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7"/><path d="M6.7 7l.8 11.4a1.4 1.4 0 0 0 1.4 1.3h6.2a1.4 1.4 0 0 0 1.4-1.3L18 7"/></svg></button><b>完成</b>
  </div>
</body></html>`;

// capturePage 给的是 BGRA,gifenc 要 RGBA:交换 R/B
function bgraToRgba(bgra) {
  const out = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]; out[i + 1] = bgra[i + 1]; out[i + 2] = bgra[i]; out[i + 3] = 255;
  }
  return out;
}

app.whenReady().then(async () => {
  const sf = screen.getPrimaryDisplay().scaleFactor; // force-scale=1 下应为 1
  const w = new BrowserWindow({
    width: W, height: H, show: false, frame: false, useContentSize: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // 进度点(=cycle 百分比):登场段密(抓胶囊→展开→过冲→回弹→落定)、停留长停、退场收拢、末尾留白再循环
  const frames = [
    { p: 0.02, d: 70 }, { p: 0.08, d: 55 }, { p: 0.11, d: 55 }, { p: 0.15, d: 55 }, { p: 0.20, d: 90 }, // 登场
    { p: 0.45, d: 1200 },                                                                                // 停留(内容最全,用作调色板)
    { p: 0.76, d: 60 }, { p: 0.81, d: 55 }, { p: 0.86, d: 80 },                                          // 退场收拢
    { p: 0.97, d: 480 },                                                                                 // 留白后循环
  ];

  const rgbaFrames = [];
  let pw = W, ph = H;
  for (const f of frames) {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(f.p)));
    await sleep(220);
    const img = await w.webContents.capturePage();
    const size = img.getSize();
    pw = Math.round(size.width * sf); ph = Math.round(size.height * sf);
    rgbaFrames.push(bgraToRgba(img.toBitmap()));
    if (f.p === 0.45 && process.env.HOLD_PNG) { try { fs.writeFileSync(process.env.HOLD_PNG, img.toPNG()); } catch {} } // 供肉眼核对静态帧
  }

  // 全局调色板:从"停留"帧(内容最全)量一次,所有帧共用,避免逐帧换色闪烁
  const palette = quantize(rgbaFrames[5], 256);
  const gif = GIFEncoder();
  for (let i = 0; i < rgbaFrames.length; i++) {
    const index = applyPalette(rgbaFrames[i], palette);
    gif.writeFrame(index, pw, ph, i === 0 ? { palette, delay: frames[i].d, repeat: 0 } : { delay: frames[i].d });
  }
  gif.finish();
  const out = path.join(OUT, 'toolbar-pop.gif');
  fs.writeFileSync(out, Buffer.from(gif.bytes()));
  console.log('saved', out, pw + 'x' + ph, frames.length + ' frames', fs.statSync(out).size + ' bytes');
  app.exit(0);
});
