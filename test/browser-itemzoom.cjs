// Renderer regression: real Chromium layout + pointer input. Electron IPC alone is stubbed.
// Run: WA_PLAYWRIGHT_MODULE=<playwright module> WA_CHROMIUM_EXECUTABLE=<Linux chromium> node test/browser-itemzoom.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require(process.env.WA_PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const near = (a, b) => Math.abs(a - b) < 0.5;
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.WA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WA_CHROMIUM_EXECUTABLE } : {}) });
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`); if (!ok) failed++; };
  try {
    for (const dpr of (process.env.WA_TEST_DPRS || '1,2').split(',').map(Number)) {
      const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: dpr });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(({ source }) => {
        const mod = { exports: {} };
        new Function('module', 'exports', source)(mod, mod.exports);
        window.handlers = {}; window.saved = [];
        window.require = name => name === 'electron' ? { ipcRenderer: {
          on: (name, fn) => { window.handlers[name] = fn; },
          send: (name, value) => { if (name === 'annotations-changed') window.saved.push(structuredClone(value)); },
        } } : mod.exports;
      }, { source: fs.readFileSync(path.join(root, 'src/regions.js'), 'utf8') });
      await page.goto(pathToFileURL(path.join(root, 'overlay/overlay.html')).href);
      const fixture = async () => {
        await page.evaluate(() => {
          handlers.init({}, { items: [
            { id: 1, type: 'pen', color: 'red', points: [[180,160],[220,160]] },
            { id: 2, type: 'pen', color: 'blue', points: [[580,340],[620,340]] },
            { id: 3, type: 'note', color: 'red', x: 300, y: 300, rot: 0, text: 'note', size: 19 },
            { id: 4, type: 'loupe', color: 'red', x: 500, y: 180, w: 30, h: 30, zoom: 2, img: '' },
          ] });
          handlers.mode({}, 'draw'); selectTool('pen'); setWheelMode('zoom');
        });
        await page.waitForTimeout(450);
      };
      const rect = id => page.locator(`[data-id="${id}"]`).boundingBox();
      const zoom = async (id, ticks = 10) => {
        for (let i = 0; i < ticks; i++) {
          const b = await rect(id);
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await page.mouse.wheel(0, -120); await page.waitForTimeout(20);
        }
      };
      const tag = s => `DPR ${dpr}: ${s}`;
      await fixture();
      await page.evaluate(() => setWheelMode('opacity'));
      await page.locator('#wheel-mode').click();
      check(tag('real mode button enables zoom'), await page.evaluate(() => wheelMode === 'zoom'));
      const nearBefore = await rect(1), otherBefore = await rect(2);
      await page.mouse.move(200, 168); // 8 px off a 2.6 px stroke: normal imprecise pointing.
      await page.mouse.wheel(0, -120); await page.waitForTimeout(80);
      const nearAfter = await rect(1), otherAfter = await rect(2);
      check(tag('wheel near a thin stroke grows that annotation'), nearAfter.width > nearBefore.width * 1.05);
      check(tag('near-stroke zoom keeps own center and other annotations fixed'),
        near(nearAfter.x + nearAfter.width / 2, 200) && near(nearAfter.y + nearAfter.height / 2, 160)
        && near(otherAfter.width, otherBefore.width) && near(otherAfter.x, otherBefore.x));
      await page.mouse.move(700, 440); await page.mouse.wheel(0, -120); await page.waitForTimeout(80);
      check(tag('missing a zoom target explains where to point'), await page.locator('#ink-badge').textContent().then(t => /请将鼠标.*标注/.test(t)));
      check(tag('far-away wheel leaves the annotation unchanged'), near((await rect(1)).width, nearAfter.width));
      await fixture();
      const a0 = await rect(1), b0 = await rect(2);
      await zoom(1);
      const a = await rect(1), b = await rect(2);
      check(tag('only hovered stroke grows'), a.width > a0.width * 1.5 && near(b.width, b0.width) && near(b.x, b0.x));
      check(tag('stroke center stays fixed'), near(a.x + a.width / 2, 200) && near(a.y + a.height / 2, 160));
      await page.mouse.move(700, 440); await page.mouse.wheel(0, -120); await page.waitForTimeout(50);
      const blank = await rect(1);
      check(tag('empty-space wheel leaves annotations alone'), near(blank.x, a.x) && near(blank.width, a.width));
      await page.mouse.move(250,200); await page.mouse.down(); await page.mouse.move(300,200); await page.mouse.up();
      const start = await page.evaluate(() => {
        const it = items.at(-1), pt = svg.createSVGPoint(); pt.x = it.points[0][0]; pt.y = it.points[0][1];
        const p = pt.matrixTransform(elCache.get(it.id).getScreenCTM()); return [p.x,p.y];
      });
      check(tag('new stroke starts under pointer after zoom'), near(start[0],250) && near(start[1],200));
      await page.evaluate(() => { selectTool('eraser'); eraserRadius = 10; });
      await page.mouse.move(165,160); await page.mouse.down(); await page.mouse.up();
      check(tag('eraser hits enlarged visible edge'), await page.evaluate(() => !items.some(it => it.id === 1)));
      await fixture(); await zoom(1);
      await page.evaluate(() => { selectTool('eraser'); eraserRadius = 10; });
      await page.mouse.move(145,160); await page.mouse.down(); await page.mouse.up();
      check(tag('eraser leaves objects beyond visible radius'), await page.evaluate(() => items.some(it => it.id === 1)));
      for (const id of [3, 4]) {
        await fixture(); const base = await rect(id); await zoom(id);
        const grown = await rect(id);
        check(tag(`${id === 3 ? 'note' : 'loupe'} zoom keeps its own center`), grown.width > base.width * 1.5 && near(grown.x + grown.width/2, base.x + base.width/2) && near(grown.y + grown.height/2, base.y + base.height/2));
        await page.evaluate(() => { liveRegions = [{key:'all', rect:{x:0,y:0,w:800,h:500},off:0}]; items.forEach(it => {it.roff0=0;}); applyRegions(); });
        await page.mouse.move(grown.x+grown.width/2,grown.y+grown.height/2); await page.mouse.down();
        await page.mouse.move(grown.x+grown.width/2+40,grown.y+grown.height/2+20); await page.mouse.up();
        const moved = await rect(id);
        check(tag(`${id === 3 ? 'note' : 'loupe'} follows pointer 40 x 20 px`), near(moved.x-grown.x,40) && near(moved.y-grown.y,20));
        await page.evaluate(() => applyRegions());
        const reapplied = await rect(id);
        check(tag('region transform preserves size and position after drag'), near(reapplied.width,moved.width) && near(reapplied.x,moved.x));
        await page.mouse.move(reapplied.x+reapplied.width/2,reapplied.y+reapplied.height/2); await page.mouse.down();
        await page.mouse.move(reapplied.x+reapplied.width/2+100,reapplied.y+reapplied.height/2); await page.mouse.up();
        await page.evaluate(id => {
          const it=items.find(it=>it.id===id);
          liveRegions=[{key:'new',rect:{x:it.x,y:it.y,w:1,h:150},off:0}];
          applyRegions();
        },id);
        check(tag('drag refreshes bounds used by scroll clipping'), await page.locator(`[data-id="${id}"]`).isVisible());
      }
      await fixture(); await zoom(1); const edited = await rect(1);
      await page.evaluate(() => handlers.mode({}, 'view'));
      const view = await rect(1);
      check(tag('Done preserves edited scale'), near(view.width,edited.width) && near(view.x,edited.x));
      await page.waitForTimeout(400);
      await page.evaluate(() => { const data = structuredClone(window.saved.at(-1)); handlers.init({}, {items: data}); });
      const reloaded = await rect(1);
      check(tag('saved annotation reloads with edited scale'), near(reloaded.width,edited.width) && near(reloaded.x,edited.x));
      await page.evaluate(() => { handlers.mode({}, 'draw'); selectTool('pen'); setWheelMode('zoom'); });
      for (const type of ['arrow','rect','hl','ruler']) {
        await page.evaluate(type => selectTool(type),type);
        await page.mouse.move(250,200); await page.mouse.down(); await page.mouse.move(300,220); await page.mouse.up();
        const start = await page.evaluate(() => {
          const it=items.at(-1), pt=svg.createSVGPoint(); pt.x=it.from[0]; pt.y=it.from[1];
          const p=pt.matrixTransform(elCache.get(it.id).getScreenCTM()); return [it.type,p.x,p.y];
        });
        check(tag(`${type} starts under pointer after another item was zoomed`), start[0]===type && near(start[1],250) && near(start[2],200));
      }
      await fixture();
      await page.keyboard.press('7');
      await page.mouse.move(120,120); await page.mouse.down(); await page.mouse.move(320,200); await page.mouse.up();
      const rulerId = await page.evaluate(() => items.at(-1).id);
      // Measure the frame geometry, excluding the decorative stroke included by Playwright's SVG box.
      const rulerRect = () => page.locator(`g[data-id="${rulerId}"] rect`).evaluate(el => el.getBoundingClientRect().toJSON());
      const rulerText = () => page.locator(`g[data-id="${rulerId}"] text`).textContent();
      const rulerTextBox = () => page.locator(`g[data-id="${rulerId}"] text`).evaluate(el => el.getBoundingClientRect().toJSON());
      const baseTextBox = await rulerTextBox();
      const baseRulerBox = await rulerRect();
      const rulerLabelLayoutStable = async () => {
        const t = await rulerTextBox(), r = await rulerRect();
        return near(t.height,baseTextBox.height)
          && near(t.right-r.right,baseTextBox.right-baseRulerBox.right)
          && near(t.top-r.bottom,baseTextBox.top-baseRulerBox.bottom);
      };
      const rulerLabel = (w,h) => `${Math.round(w*dpr)} × ${Math.round(h*dpr)} px`;
      const rulerWheel = async delta => {
        const b = await rulerRect();
        await page.mouse.move(b.x+b.width/2,b.y); // Real wheel input on the measuring edge.
        await page.mouse.wheel(0,delta); await page.waitForTimeout(60);
      };
      check(tag('new ruler reports physical pixels'), await rulerText() === rulerLabel(200,80));
      await rulerWheel(-120);
      let rulerBox = await rulerRect();
      check(tag('ruler readout follows first enlargement'), await rulerText() === rulerLabel(216,86.4));
      check(tag('ruler label keeps font size and edge spacing after enlargement'), await rulerLabelLayoutStable());
      check(tag('ruler scales around measuring frame center'),
        near(rulerBox.width,216) && near(rulerBox.height,86.4)
        && near(rulerBox.x+rulerBox.width/2,220) && near(rulerBox.y+rulerBox.height/2,160));
      await rulerWheel(-120);
      check(tag('ruler readout follows successive enlargement'), await rulerText() === rulerLabel(232,92.8));
      check(tag('ruler label keeps font size through successive zoom'), await rulerLabelLayoutStable());
      await page.keyboard.press('Control+z');
      check(tag('undo refreshes ruler readout'), await rulerText() === rulerLabel(216,86.4));
      await page.keyboard.press('Control+z');
      check(tag('undo back to 100% restores original ruler readout'), await rulerText() === rulerLabel(200,80));
      check(tag('undo restores ruler label size and spacing'), await rulerLabelLayoutStable());
      await rulerWheel(120);
      rulerBox = await rulerRect();
      check(tag('ruler readout follows shrink'), await rulerText() === rulerLabel(184,73.6));
      check(tag('ruler label keeps font size and spacing after shrink'), await rulerLabelLayoutStable());
      check(tag('ruler readout matches rendered frame physical size'),
        await rulerText() === rulerLabel(rulerBox.width,rulerBox.height));
      check(tag('ruler zoom preserves original measurement coordinates'),
        await page.evaluate(id => { const it=items.find(it=>it.id===id); return it.from.join() === '120,120' && it.to.join() === '320,200'; },rulerId));
      await page.evaluate(() => handlers.mode({},'view'));
      await page.waitForTimeout(400);
      await page.evaluate(() => handlers.init({}, {items:structuredClone(window.saved.at(-1))}));
      const rulerReloaded = await rulerRect();
      check(tag('saved ruler reload preserves scaled readout'), await rulerText() === rulerLabel(184,73.6));
      check(tag('saved ruler reload keeps fixed label size and spacing'), await rulerLabelLayoutStable());
      check(tag('saved ruler reload preserves frame size and center'),
        near(rulerReloaded.x,rulerBox.x) && near(rulerReloaded.y,rulerBox.y)
        && near(rulerReloaded.width,rulerBox.width) && near(rulerReloaded.height,rulerBox.height));
      await page.evaluate(() => {
        liveRegions=[{key:'all',rect:{x:0,y:0,w:800,h:500},off:50}];
        items.forEach(it=>{it.roff0=0;}); easedOff.clear(); applyRegions();
      });
      const rulerScrolled = await rulerRect();
      check(tag('scroll moves ruler without changing measurement'),
        near(rulerScrolled.y,rulerReloaded.y-50) && await rulerText() === rulerLabel(184,73.6));
      await page.evaluate(() => { handlers.mode({},'draw'); setWheelMode('zoom'); });
      for (const [delta,w,h] of [[120,80,32],[-120,520,208]]) {
        await page.evaluate(({id,delta}) => {
          const el=elCache.get(id);
          for(let i=0;i<100;i++) el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:delta}));
        }, {id:rulerId,delta});
        check(tag(`ruler label remains legible at ${delta>0 ? 'minimum' : 'maximum'} scale`),
          await rulerLabelLayoutStable() && await rulerText() === rulerLabel(w,h));
      }
      await fixture(); await zoom(1,1);
      await page.keyboard.press('Control+z');
      const undone=await rect(1);
      check(tag('Ctrl+Z restores size without deleting the stroke'), near(undone.width,a0.width));
      await page.evaluate(() => {
        const el=elCache.get(1);
        for(let i=0;i<100;i++) el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:120}));
      });
      const small=await page.evaluate(() => { const r=elCache.get(1).getBoundingClientRect(); return [items.find(it=>it.id===1).scale,r.x+r.width/2,r.y+r.height/2]; });
      check(tag('shrink clamps at 40% with center fixed'), near(small[0],0.4) && near(small[1],200) && near(small[2],160));
      await page.evaluate(() => {
        const el=elCache.get(1);
        for(let i=0;i<100;i++) el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120}));
      });
      const large=await page.evaluate(() => { const r=elCache.get(1).getBoundingClientRect(); return [items.find(it=>it.id===1).scale,r.x+r.width/2,r.y+r.height/2]; });
      check(tag('enlarge clamps at 260% with center fixed'), near(large[0],2.6) && near(large[1],200) && near(large[2],160));
      check(tag('no renderer errors'), errors.length === 0);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
