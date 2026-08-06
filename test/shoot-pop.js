// 抓工具条"胶囊弹出"动画在真实经过时间上的几帧(reload=重放,sleep 后 capturePage),
// 核对"肉眼能看见的展开"(不是一瞬间到位)。用法: electron test/shoot-pop.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.SHOOT_OUT || __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 动画与 overlay.css 的 toolbar-pop 保持一致(.52s + 同缓动)
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
body{width:100vw;height:100vh;overflow:hidden;position:relative;background:
  radial-gradient(560px 300px at 26% 30%, rgba(120,140,255,.30), transparent 60%),
  radial-gradient(520px 280px at 76% 72%, rgba(255,168,120,.26), transparent 62%),
  linear-gradient(135deg,#eef1f8,#e5ebf6)}
#bar{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  display:flex;align-items:center;gap:6px;border-radius:999px;padding:12px 22px;overflow:hidden;
  background:linear-gradient(180deg,rgba(44,44,49,.80),rgba(20,20,23,.90));border:1px solid rgba(255,255,255,.14);
  box-shadow:0 14px 44px rgba(0,0,0,.4),0 2px 6px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.16);
  animation:pop .5s cubic-bezier(.4,0,.2,1) forwards}
@keyframes pop{0%{opacity:0;max-width:46px;transform:translate(-50%,-50%) scale(.9)}
  15%{opacity:1}100%{opacity:1;max-width:760px;transform:translate(-50%,-50%) scale(1)}}
#bar .app{color:rgba(255,255,255,.55);font-size:13px;padding:0 6px;white-space:nowrap}
#bar .sep{width:1px;height:22px;background:rgba(255,255,255,.20);margin:0 8px}
#bar button{border:none;background:transparent;color:#f2f2f4;width:38px;height:38px;border-radius:50%;font-size:18px}
#bar button.on{background:rgba(255,255,255,.24)}
#bar button.ink{font-family:'Ink Free','Segoe Print',cursive;font-weight:700}
#bar i{width:18px;height:18px;border-radius:50%;display:inline-block;margin:0 3px;border:2px solid transparent}
#bar i.on{border-color:#fff}
#bar b{margin-left:8px;padding:8px 16px;background:rgba(255,255,255,.20);border-radius:999px;color:#fff;font-size:14px;white-space:nowrap}
</style></head><body>
  <div id="bar">
    <span class="app">当前窗口</span><span class="sep"></span>
    <button>✏️</button><button class="on">↗</button><button>▭</button><button>▆</button><button class="ink">Aa</button><button>⌫</button>
    <span class="sep"></span>
    <i style="background:#3d3d40"></i><i style="background:#e5484d" class="on"></i><i style="background:#ee9d2b"></i><i style="background:#2f9e63"></i><i style="background:#0e8fd8"></i><i style="background:#8e4ec6"></i>
    <span class="sep"></span><button>↶</button><button>🗑</button><b>完成</b>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1000, height: 240, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const times = [70, 150, 260, 400];   // ms:动画约 520ms,这几帧应看到宽度逐步变大
  for (let i = 0; i < times.length; i++) {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML)); // reload=重放动画
    await sleep(times[i]);
    const bw = await w.webContents.executeJavaScript('Math.round(document.getElementById("bar").getBoundingClientRect().width)');
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'pop-' + i + '.png'), img.toPNG());
    console.log('t=' + times[i] + 'ms  bar width=' + bw);
  }
  app.exit(0);
});
