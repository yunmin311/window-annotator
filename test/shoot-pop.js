// 抓工具条"胶囊弹出"动画的几帧(用 animation-delay 负值 + paused 冻结在指定进度,确定性取帧),
// 肉眼核对登场效果。用法: electron test/shoot-pop.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = process.env.SHOOT_OUT || __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DUR = 0.4; // 秒,与 overlay.css 的 .36s 接近
const html = (progress) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
body{width:100vw;height:100vh;overflow:hidden;position:relative;background:
  radial-gradient(560px 300px at 26% 30%, rgba(120,140,255,.30), transparent 60%),
  radial-gradient(520px 280px at 76% 72%, rgba(255,168,120,.26), transparent 62%),
  linear-gradient(135deg,#eef1f8,#e5ebf6)}
#bar{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  display:flex;align-items:center;gap:6px;border-radius:999px;padding:12px 22px;overflow:hidden;
  background:linear-gradient(180deg,rgba(44,44,49,.80),rgba(20,20,23,.90));
  -webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 14px 44px rgba(0,0,0,.4),0 2px 6px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.16);
  animation:pop ${DUR}s cubic-bezier(.16,1,.3,1) forwards;
  animation-delay:-${(progress * DUR).toFixed(3)}s;animation-play-state:paused}
@keyframes pop{
  0%{opacity:0;max-width:44px;transform:translate(-50%,-50%) scale(.96)}
  55%{opacity:1}
  100%{opacity:1;max-width:820px;transform:translate(-50%,-50%) scale(1)}}
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
  const progresses = [0.06, 0.16, 0.34, 0.60, 1.0];
  for (let i = 0; i < progresses.length; i++) {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(progresses[i])));
    await sleep(220);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'pop-' + i + '.png'), img.toPNG());
    console.log('saved pop-' + i + '.png @progress ' + progresses[i]);
  }
  app.exit(0);
});
