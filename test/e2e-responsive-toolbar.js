'use strict';
process.env.WA_TEST = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' ' + detail : ''));
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inspectAt(w, width) {
  w.setContentSize(width, 420);
  await sleep(120);
  return w.webContents.executeJavaScript(`(() => {
    const toolbar = document.getElementById('toolbar');
    const more = document.getElementById('more-toggle');
    const panel = document.getElementById('more-panel');
    const appName = document.getElementById('app-name');
    const rect = toolbar.getBoundingClientRect();
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    return {
      width: innerWidth,
      tier: document.body.dataset.toolbarTier || '',
      fits: rect.left >= -0.5 && rect.right <= innerWidth + 0.5,
      toolbarLeft: Math.round(rect.left),
      toolbarRight: Math.round(rect.right),
      appNameVisible: visible(appName),
      moreVisible: visible(more),
      panelExists: !!panel,
      advancedInPanel: !!panel && !!panel.querySelector('[data-tool="ruler"]') && !!panel.querySelector('[data-tool="loupe"]'),
      colorsInPanel: !!panel && !!panel.querySelector('#colors'),
      coreVisible: ['pen','arrow','rect','hl','note','eraser'].every((tool) => visible(document.querySelector('[data-tool="' + tool + '"]'))),
      doneVisible: visible(document.getElementById('done')),
      undoVisible: visible(document.getElementById('undo')),
    };
  })()`);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 900, height: 420, show: false, frame: false, transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  w.webContents.send('mode', 'draw');
  await sleep(750);

  const wide = await inspectAt(w, 900);
  check('900px keeps the full toolbar', wide.tier === 'wide' && wide.appNameVisible && !wide.moreVisible, JSON.stringify(wide));
  check('900px toolbar stays inside the target window', wide.fits, JSON.stringify(wide));

  const medium = await inspectAt(w, 600);
  check('600px enters medium compaction and hides the app name', medium.tier === 'medium' && !medium.appNameVisible, JSON.stringify(medium));
  check('600px toolbar stays inside the target window', medium.fits, JSON.stringify(medium));

  const narrow = await inspectAt(w, 420);
  check('420px moves secondary controls into More', narrow.tier === 'narrow' && narrow.moreVisible && narrow.panelExists && narrow.advancedInPanel && narrow.colorsInPanel, JSON.stringify(narrow));
  check('420px keeps core drawing, undo and done visible', narrow.coreVisible && narrow.undoVisible && narrow.doneVisible, JSON.stringify(narrow));
  check('420px toolbar stays inside the target window', narrow.fits, JSON.stringify(narrow));

  const tiny = await inspectAt(w, 320);
  check('320px enters tiny compaction', tiny.tier === 'tiny', JSON.stringify(tiny));
  check('320px keeps core drawing, undo and done visible', tiny.coreVisible && tiny.undoVisible && tiny.doneVisible, JSON.stringify(tiny));
  check('320px toolbar stays inside the target window', tiny.fits, JSON.stringify(tiny));

  const moreWorks = await w.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('more-toggle');
    const panel = document.getElementById('more-panel');
    if (!btn || !panel) return false;
    btn.click();
    return panel.classList.contains('open') && getComputedStyle(panel).visibility !== 'hidden';
  })()`);
  check('More opens the compact secondary controls', moreWorks);

  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((error) => {
  console.error(error.stack || error);
  app.exit(2);
});
