// 生成 README 用的"工具条胶囊弹出"动图 docs/toolbar-pop.gif。
// 做法:用 animation-delay 负值 + paused 冻结在若干进度点,逐帧 capturePage,再用 gifenc(纯 JS,仅生成时用)编码。
// 用法: electron docs/gen-pop-gif.js
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc'); // 纯 JS,CJS 直接 require(别用 import(),会卡)

app.commandLine.appendSwitch('force-device-scale-factor', '1'); // 让 capturePage 的像素尺寸=窗口尺寸,便于喂 gif
setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 30000); // 卡住就退,别无限挂

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = __dirname;
const W = 940, H = 190, DUR = 0.4;

const html = (progress) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
body{width:100vw;height:100vh;overflow:hidden;position:relative;background:
  radial-gradient(520px 280px at 26% 30%, rgba(120,140,255,.30), transparent 60%),
  radial-gradient(480px 260px at 76% 72%, rgba(255,168,120,.26), transparent 62%),
  linear-gradient(135deg,#eef1f8,#e5ebf6)}
#bar{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  display:flex;align-items:center;gap:5px;border-radius:999px;padding:11px 20px;overflow:hidden;
  background:linear-gradient(180deg,rgba(44,44,49,.82),rgba(20,20,23,.92));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 14px 40px rgba(0,0,0,.4),0 2px 6px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.16);
  animation:pop ${DUR}s cubic-bezier(.16,1,.3,1) forwards;
  animation-delay:-${(progress * DUR).toFixed(3)}s;animation-play-state:paused}
@keyframes pop{
  0%{opacity:0;max-width:40px;transform:translate(-50%,-50%) scale(.96)}
  55%{opacity:1}
  100%{opacity:1;max-width:820px;transform:translate(-50%,-50%) scale(1)}}
#bar .app{color:rgba(255,255,255,.55);font-size:12px;padding:0 5px;white-space:nowrap}
#bar .sep{width:1px;height:20px;background:rgba(255,255,255,.20);margin:0 7px}
#bar button{border:none;background:transparent;color:#f2f2f4;width:34px;height:34px;border-radius:50%;font-size:16px}
#bar button.on{background:rgba(255,255,255,.24)}
#bar button.ink{font-family:'Ink Free','Segoe Print',cursive;font-weight:700}
#bar i{width:16px;height:16px;border-radius:50%;display:inline-block;margin:0 2px;border:2px solid transparent}
#bar i.on{border-color:#fff}
#bar b{margin-left:7px;padding:7px 14px;background:rgba(255,255,255,.20);border-radius:999px;color:#fff;font-size:13px;white-space:nowrap}
</style></head><body>
  <div id="bar">
    <span class="app">当前窗口</span><span class="sep"></span>
    <button>✏️</button><button class="on">↗</button><button>▭</button><button>▆</button><button class="ink">Aa</button><button>⌫</button>
    <span class="sep"></span>
    <i style="background:#3d3d40"></i><i style="background:#e5484d" class="on"></i><i style="background:#ee9d2b"></i><i style="background:#2f9e63"></i><i style="background:#0e8fd8"></i><i style="background:#8e4ec6"></i>
    <span class="sep"></span><button>↶</button><button>🗑</button><b>完成</b>
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

  // 进度点:前段密(展开快)、后段疏;最后一帧长停顿再循环
  const frames = [
    { p: 0.04, d: 60 }, { p: 0.09, d: 55 }, { p: 0.15, d: 55 }, { p: 0.23, d: 55 },
    { p: 0.34, d: 55 }, { p: 0.50, d: 55 }, { p: 0.72, d: 60 }, { p: 1.0, d: 1500 },
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
  }

  // 全局调色板:从最后一帧(内容最全)量一次,所有帧共用,避免逐帧换色闪烁
  const palette = quantize(rgbaFrames[rgbaFrames.length - 1], 256);
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
