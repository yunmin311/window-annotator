'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Execute the real main-process capture handlers; replace only OS boundaries.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const values = {}, notifications = [], opened = [], handlers = {};
  let openError = '';
  class Notification extends EventEmitter {
    constructor(options) { super(); this.options = options; notifications.push(new WeakRef(this)); }
    show() {}
  }
  const image = { isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }),
    crop() { return this; }, toPNG: () => Buffer.from('PNG-test') };
  const electron = {
    app: { whenReady: () => new Promise(() => {}), on() {}, getPath: () => root },
    ipcMain: { on: (name, fn) => { handlers[name] = fn; } },
    nativeImage: { createFromPath() {} }, Notification,
    clipboard: { writeImage() {} },
    screen: { getDisplayMatching: () => ({ id: 1, scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 800, height: 600 }, size: { width: 800, height: 600 } }) },
    desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: image }] },
    shell: { showItemInFolder: file => opened.push(['select', file]),
      openPath: async dir => { opened.push(['open', dir]); if (openError instanceof Error) throw openError; return openError; } },
  };
  const filename = path.resolve(__dirname, '../main.js'), nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const requireFixture = id => {
    if (id === 'electron') return electron;
    if (id === './src/win32' || id === './src/scroll-uia' || id === './src/store') return {};
    if (id === './src/settings') return { get: (key, dflt) => values[key] ?? dflt, set: (key, value) => { values[key] = value; } };
    return nativeRequire(id);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: requireFixture, module, __dirname: path.dirname(filename), console,
    process: { env: { WA_TEST: '1' } }, setTimeout, setInterval, clearTimeout, clearInterval,
  }, { filename });
  const results = [], sender = { isDestroyed: () => false, send: (_name, result) => results.push(result) };
  module.exports.overlays.set('test', { win: { webContents: sender,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) } });
  return { root, values, notifications, opened, results, main: module.exports,
    failOpen: error => { openError = error; },
    capture: name => handlers[name]({ sender }, { x: 0, y: 0, w: 200, h: 100 }) };
}

for (const channel of ['capture-window', 'capture-region']) {
  test(`${channel}: saved path, notice and click agree even after changing settings`, async t => {
    const f = fixture(t);
    assert.equal(f.main.shotsDir(), path.join(f.root, 'Window Annotator'));
    f.values.shotsDir = path.join(f.root, '自定义 截图');
    await f.capture(channel);
    assert.equal(f.results[0].ok, true);
    const file = f.results[0].file, n = f.notifications[0].deref();
    assert.equal(fs.readFileSync(file, 'utf8'), 'PNG-test');
    assert.ok(n.options.body.includes(path.dirname(file)), 'notice must display actual destination');
    f.values.shotsDir = path.join(f.root, 'another-folder');
    n.emit('click');
    await new Promise(setImmediate);
    assert.deepEqual(f.opened, [['open', path.dirname(file)]], 'click opens this screenshot folder');
  });
}

test('notification survives GC and banner timeout while it remains in notification center', async t => {
  const f = fixture(t);
  await f.capture('capture-window');
  f.notifications[0].deref().emit('close', {}, 'timedOut');
  assert.equal(typeof global.gc, 'function', 'run with node --expose-gc');
  for (let i = 0; i < 4; i++) { await new Promise(setImmediate); global.gc(); }
  const n = f.notifications[0].deref();
  assert.ok(n, 'keep the notification so its click handler survives');
  n.emit('click');
  await new Promise(setImmediate);
  assert.deepEqual(f.opened, [['open', path.dirname(f.results[0].file)]]);
});

test('opening a folder reports both returned and thrown errors without an unhandled rejection', async t => {
  const f = fixture(t);
  for (const error of ['Explorer unavailable', new Error('OS failure')]) {
    await f.capture('capture-region');
    const n = f.notifications.at(-1).deref();
    f.failOpen(error);
    n.emit('click');
    await new Promise(setImmediate);
    const failure = f.notifications.at(-1).deref();
    assert.match(failure.options.title, /无法打开/);
    assert.ok(failure.options.body.includes(f.main.shotsDir()));
    assert.ok(failure.options.body.includes(String(error.message || error)));
  }
});
