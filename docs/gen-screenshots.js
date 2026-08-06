// 生成 README 用的使用截图:用与工具完全一致的手绘渲染,把标注合成到模拟窗口上。
// 用法: electron docs/gen-screenshots.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = __dirname;

// ---- 与 overlay.js 一致的手绘渲染(截图独立副本;含方框 rect) ----
const RENDER = `
const COLORS = { neutral:'#3d3d40', red:'#e5484d', amber:'#ee9d2b', green:'#2f9e63', blue:'#0e8fd8', purple:'#8e4ec6' };
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function sketchSegment(x1,y1,x2,y2,rnd,bowScale=0.045){const dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len,parts=[];for(let p=0;p<2;p++){const bow=(rnd()-0.5)*2*Math.min(9,len*bowScale),j=()=>(rnd()-0.5)*2.4,mx=x1+dx*(0.4+rnd()*0.2)+nx*bow+j(),my=y1+dy*(0.4+rnd()*0.2)+ny*bow+j();parts.push('M'+(x1+j())+' '+(y1+j())+' Q'+mx+' '+my+' '+(x2+j())+' '+(y2+j()));}return parts.join(' ');}
function arrowPath(it){const[x1,y1]=it.from,[x2,y2]=it.to,rnd=mulberry32(it.seed),dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy)||1,ang=Math.atan2(dy,dx),h=Math.min(16,8+len*0.12);let d=sketchSegment(x1,y1,x2,y2,rnd);for(const s of[-1,1]){const a=ang+Math.PI+s*0.46+(rnd()-0.5)*0.1;d+=' '+sketchSegment(x2,y2,x2+Math.cos(a)*h,y2+Math.sin(a)*h,rnd,0.1);}return d;}
function rectPath(it){const[x1,y1]=it.from,[x2,y2]=it.to,ax=Math.min(x1,x2),ay=Math.min(y1,y2),bx=Math.max(x1,x2),by=Math.max(y1,y2),rnd=mulberry32(it.seed),seg=(a,b,c,d)=>sketchSegment(a,b,c,d,rnd,0.02);return[seg(ax,ay,bx,ay),seg(bx,ay,bx,by),seg(bx,by,ax,by),seg(ax,by,ax,ay)].join(' ');}
function smoothPath(pts){if(pts.length<2){const[x,y]=pts[0];return 'M'+x+' '+y+' l0.01 0';}let d='M'+pts[0][0]+' '+pts[0][1];for(let i=1;i<pts.length-1;i++){const mx=(pts[i][0]+pts[i+1][0])/2,my=(pts[i][1]+pts[i+1][1])/2;d+=' Q'+pts[i][0]+' '+pts[i][1]+' '+mx+' '+my;}const l=pts[pts.length-1];d+=' L'+l[0]+' '+l[1];return d;}
function render(items){const ink=document.getElementById('ink-layer'),hl=document.getElementById('hl-layer'),notes=document.getElementById('notes');
for(const it of items){if(it.type==='note'){const div=document.createElement('div');div.className='note';div.style.left=it.x+'px';div.style.top=it.y+'px';div.style.color=COLORS[it.color];div.style.transform='rotate('+it.rot+'deg)';div.textContent=it.text;notes.appendChild(div);continue;}
const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('stroke',COLORS[it.color]);p.setAttribute('fill','none');p.setAttribute('stroke-linecap','round');p.setAttribute('stroke-linejoin','round');
if(it.type==='pen'){p.setAttribute('d',smoothPath(it.points));p.setAttribute('stroke-width',2.6);ink.appendChild(p);}
else if(it.type==='hl'){p.setAttribute('d',smoothPath(it.points));p.setAttribute('stroke-width',16);p.setAttribute('stroke-linecap','butt');p.style.opacity='.38';p.style.mixBlendMode='multiply';hl.appendChild(p);}
else if(it.type==='arrow'){p.setAttribute('d',arrowPath(it));p.setAttribute('stroke-width',2.4);ink.appendChild(p);}
else if(it.type==='rect'){p.setAttribute('d',rectPath(it));p.setAttribute('stroke-width',2.4);ink.appendChild(p);}}}
`;

const NOTE_CSS = `
.note{position:absolute;font-family:'Ink Free','Segoe Print',cursive;font-size:20px;line-height:1.3;font-weight:600;white-space:pre-wrap;
width:max-content;max-width:320px;
text-shadow:0 1px 0 rgba(255,255,255,.6),0 -1px 0 rgba(255,255,255,.6),1px 0 0 rgba(255,255,255,.6),-1px 0 0 rgba(255,255,255,.6);}
#canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#notes{position:absolute;inset:0}
`;

// 深色玻璃工具条(磨砂 + 顶部高光 + 分层阴影),和 overlay.css 里真实工具条同款质感
const GLASS_BAR = `
  background:linear-gradient(180deg,rgba(44,44,49,.90),rgba(20,20,23,.96));
  -webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 14px 44px rgba(0,0,0,.4),0 2px 6px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.16);`;

// 模拟"浏览器窗口 + 一篇文章",再叠标注——展示"任意窗口都能标"。工具条=当前真实六个工具(含方框 ▭)
function heroHTML(withToolbar) {
  const toolbar = withToolbar ? `
  <div class="wa-toolbar">
    <span class="app">chrome</span><button style="opacity:.62">◐</button><span class="sep"></span>
    <button>✏️</button><button class="on">↗</button><button>▭</button><button>▆</button><button class="ink">Aa</button><button>⌫</button>
    <span class="sep"></span>
    <i style="background:#3d3d40"></i><i style="background:#e5484d" class="c-on"></i><i style="background:#ee9d2b"></i><i style="background:#2f9e63"></i><i style="background:#0e8fd8"></i><i style="background:#8e4ec6"></i>
    <span class="sep"></span><button>↶</button><button>🗑</button><b>完成</b>
  </div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
  body{width:1200px;height:760px;background:#eef1f5;overflow:hidden}
  .win{position:absolute;left:60px;top:56px;width:1080px;height:648px;background:#fff;border-radius:12px;
    box-shadow:0 24px 70px rgba(20,30,60,.22);overflow:hidden}
  .chrome{height:44px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;padding:0 16px;gap:8px}
  .dot{width:12px;height:12px;border-radius:50%}
  .url{flex:1;margin:0 14px;height:26px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;
    display:flex;align-items:center;padding:0 14px;color:#9aa1ab;font-size:13px}
  .page{padding:44px 72px}
  .page h1{font-size:30px;color:#111827;margin-bottom:8px;font-weight:800}
  .page .sub{color:#9aa1ab;font-size:14px;margin-bottom:26px}
  .page p{font-size:16px;line-height:2;color:#374151;max-width:760px;margin-bottom:16px}
  .page .kpi{font-weight:800;color:#111827}
  ${NOTE_CSS}
  /* 工具条 */
  .wa-toolbar{position:absolute;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;
    border-radius:999px;padding:6px 12px;z-index:9;${GLASS_BAR}}
  .wa-toolbar .app{color:rgba(255,255,255,.5);font-size:12px;padding:0 4px}
  .wa-toolbar .sep{width:1px;height:18px;background:rgba(255,255,255,.18);margin:0 5px}
  .wa-toolbar button{border:none;background:transparent;color:#f0f0f2;width:32px;height:32px;border-radius:50%;font-size:15px;cursor:pointer}
  .wa-toolbar button.on{background:rgba(255,255,255,.22)}
  .wa-toolbar button.ink{font-family:'Ink Free','Segoe Print',cursive;font-weight:700}
  .wa-toolbar i{width:16px;height:16px;border-radius:50%;display:inline-block;margin:0 2px;border:2px solid transparent}
  .wa-toolbar i.c-on{border-color:#fff}
  .wa-toolbar b{margin-left:6px;padding:5px 13px;background:rgba(255,255,255,.18);border-radius:999px;color:#fff;font-size:13px;font-weight:500}
  </style></head><body>
    <div class="win">
      <div class="chrome">
        <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
        <div class="url">🔒  your-team.notion.site / 季度复盘</div>
      </div>
      <div class="page">
        <h1>Q3 增长复盘</h1>
        <div class="sub">最后编辑于 3 小时前 · 协作者 5 人</div>
        <p>本季度新增注册用户 <span class="kpi">18,240</span>,环比上升 34%。其中来自内容渠道的占比首次超过一半,说明我们在长文与教程上的投入开始回收。</p>
        <p>但激活率仍然停在 41%,低于我们年初定下的 55% 目标。问题集中在新用户第一天的引导流程——超过一半的人没走完新手任务就流失了。</p>
        <p>下个季度的第一优先级,是把新手引导从"能用"做到"顺手":减少一步注册、把关键动作前置、并在第 7 天做一次召回。</p>
      </div>
    </div>
    ${toolbar}
    <svg id="canvas"><g id="hl-layer"></g><g id="ink-layer"></g></svg>
    <div id="notes"></div>
    <script>${RENDER}
    function circle(cx,cy,r){const pts=[];for(let a=-0.3;a<Math.PI*2+0.3;a+=0.25){pts.push([cx+Math.cos(a)*r*1.25,cy+Math.sin(a)*r]);}return pts;}
    render([
      // 方框:框住标题(展示新的"方框"工具)
      {type:'rect',color:'purple',from:[120,142],to:[300,190],seed:11},
      // 荧光笔划在"环比上升 34%"上
      {type:'hl',color:'amber',points:[[313,257],[372,258],[430,257]]},
      // 绿色圈住"41%"
      {type:'pen',color:'green',points:circle(296,337,26)},
      // 红色手绘箭头指向激活率那句
      {type:'arrow',color:'red',from:[930,468],to:[500,342],seed:7},
      // 蓝色手写便签
      {type:'note',color:'blue',x:940,y:298,text:'这句是重点\\n单独拎出来讲 →',rot:-3},
    ]);
    </script>
  </body></html>`;
}

// 工具条特写:居中、不缩放(靠 shootFit 紧裁,保证完整+居中),六个工具:画笔/箭头/方框/荧光笔/便签/橡皮
function toolbarHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
  body{width:100vw;height:100vh;overflow:hidden;display:flex;align-items:center;justify-content:center;
    background:
      radial-gradient(560px 300px at 26% 32%, rgba(120,140,255,.34), transparent 60%),
      radial-gradient(520px 280px at 76% 70%, rgba(255,168,120,.30), transparent 62%),
      linear-gradient(135deg,#eef1f8,#e5ebf6)}
  #shot{display:flex;align-items:center;gap:6px;border-radius:999px;padding:13px 24px;${GLASS_BAR}}
  #shot .app{color:rgba(255,255,255,.55);font-size:14px;padding:0 6px}
  #shot .sep{width:1px;height:22px;background:rgba(255,255,255,.20);margin:0 8px}
  #shot button{border:none;background:transparent;color:#f2f2f4;width:40px;height:40px;border-radius:50%;font-size:19px;cursor:pointer}
  #shot button.on{background:rgba(255,255,255,.24)}
  #shot button.ink{font-family:'Ink Free','Segoe Print',cursive;font-weight:700}
  #shot i{width:20px;height:20px;border-radius:50%;display:inline-block;margin:0 3px;border:2px solid transparent}
  #shot i.on{border-color:#fff}
  #shot b{margin-left:8px;padding:8px 18px;background:rgba(255,255,255,.20);border-radius:999px;color:#fff;font-size:15px;font-weight:500}
  </style></head><body>
    <div id="shot">
      <span class="app">当前窗口</span><button style="opacity:.62" title="滚轮作用:透明度/缩放">◐</button><span class="sep"></span>
      <button title="画笔">✏️</button>
      <button class="on" title="箭头">↗</button>
      <button title="方框">▭</button>
      <button title="荧光笔">▆</button>
      <button class="ink" title="手写便签">Aa</button>
      <button title="橡皮">⌫</button>
      <span class="sep"></span>
      <i style="background:#3d3d40"></i><i style="background:#e5484d" class="on"></i><i style="background:#ee9d2b"></i><i style="background:#2f9e63"></i><i style="background:#0e8fd8"></i><i style="background:#8e4ec6"></i>
      <span class="sep"></span>
      <button title="撤销">↶</button><button title="清空">🗑</button><b>完成</b>
    </div>
  </body></html>`;
}

// 整窗截图(hero):按窗口大小整张抓
async function shoot(win, html, file) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await sleep(750);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('saved', file);
}

// 元素特写:量出 #shot 尺寸,把窗口缩到"主体 + 四周等距留白"再整张抓 ——
// 用缩窗口(而不是裁剪)保证主体完整、居中、周围留白匀称,绝不会切到边
async function shootFit(win, html, file, pad = 56) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await sleep(750);
  const r = await win.webContents.executeJavaScript(
    `(()=>{const b=document.getElementById('shot').getBoundingClientRect();return{w:Math.ceil(b.width),h:Math.ceil(b.height)};})()`);
  win.setContentSize(r.w + pad * 2, r.h + pad * 2);   // 窗口缩到贴合主体;body flex 居中 -> 四周 pad 均匀
  await sleep(220);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  console.log('saved', file, 'shot', JSON.stringify(r));
}

app.whenReady().then(async () => {
  const mk = (w, h) => new BrowserWindow({
    width: w, height: h, show: false, frame: false, useContentSize: true, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  const hero = mk(1200, 760);
  await shoot(hero, heroHTML(true), 'hero.png');
  hero.close();

  const bar = mk(1360, 360);
  await shootFit(bar, toolbarHTML(), 'toolbar.png');
  bar.close();

  console.log('DONE');
  app.exit(0);
});
