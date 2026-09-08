'use strict';

let api;
try {
  api = require('../src/tray-menu-window');
} catch (error) {
  console.error('FAIL - tray menu window behavior is not implemented:', error.message);
  process.exit(1);
}

let fails = 0;
const check = (name, ok) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!ok) fails++;
};

const opts = api.trayMenuWindowOptions();
check('native tray window has an explicitly transparent backing color', opts.backgroundColor === '#00000000');
check('native tray window remains frameless and transparent', opts.frame === false && opts.transparent === true);
check('native tray window starts fully transparent for compositor warm-up', opts.opacity === 0);

let now = 0;
let nextId = 1;
const timers = new Map();
let hides = 0;
const guard = api.createMenuBlurGuard({
  now: () => now,
  schedule: (fn, delay) => { const id = nextId++; timers.set(id, { fn, due: now + delay }); return id; },
  cancel: (id) => timers.delete(id),
  hide: () => { hides++; },
  protectMs: 180,
});
const flush = () => {
  const pending = [...timers.values()];
  timers.clear();
  pending.forEach(({ fn, due }) => { now = Math.max(now, due); fn(); });
};

guard.openRequested();
guard.blurRequested();
flush();
check('blur caused by the tray click cannot immediately hide a newly opened menu', hides === 0);

now = 220;
guard.blurRequested();
check('a real outside blur closes immediately instead of waiting through another protection interval', hides === 1);
flush();
check('a later outside click still closes the menu', hides === 1);

now = 300;
guard.openRequested();
guard.blurRequested();
flush();
check('the opening click blur remains protected after an earlier close', hides === 1);

check('tray menu exposes a presentation cache', typeof api.createMenuPresenter === 'function');
if (typeof api.createMenuPresenter === 'function') {
  const presentations = [];
  const presenter = api.createMenuPresenter({
    present: (size, cursor) => presentations.push({ size, cursor }),
  });
  const measured = { winW: 196, winH: 246 };
  presenter.sizeReported(measured);
  check('background pre-measure does not accidentally open the menu', presentations.length === 0);
  presenter.openRequested({ x: 100, y: 200 });
  check('a pre-measured menu presents synchronously on click', presentations.length === 1 && presentations[0].size === measured);
  presenter.sizeReported({ ...measured });
  check('an unchanged renderer size report does not repeat window presentation work', presentations.length === 1);
  presenter.closeRequested();
  presenter.sizeReported({ winW: 198, winH: 246 });
  check('size updates while closed stay cached without reopening', presentations.length === 1);

  presenter.openRequested({ x: 110, y: 210 }, { deferUntilFreshSize: true });
  check('changed menu state does not flash the previously cached frame', presentations.length === 1);
  presenter.sizeReported({ winW: 198, winH: 246 });
  check('changed menu state presents only after its fresh renderer frame is ready', presentations.length === 2);
}

check('tray menu exposes a warm compositor surface', typeof api.createWarmMenuSurface === 'function');
if (typeof api.createWarmMenuSurface === 'function') {
  const calls = [];
  let focused = false;
  const win = {
    setBounds: (bounds) => calls.push(['bounds', bounds]),
    setOpacity: (opacity) => calls.push(['opacity', opacity]),
    setIgnoreMouseEvents: (ignore) => calls.push(['ignore', ignore]),
    showInactive: () => calls.push(['showInactive']),
    focus: () => { focused = true; calls.push(['focus']); },
    blur: () => { focused = false; calls.push(['blur']); },
    isFocused: () => focused,
  };
  const surface = api.createWarmMenuSurface({ win });
  surface.warm();
  check('warm-up shows one fully transparent click-through native surface',
    JSON.stringify(calls.slice(0, 3)) === JSON.stringify([['opacity', 0], ['ignore', true], ['showInactive']]));
  surface.open({ x: 10, y: 20, width: 196, height: 246 });
  surface.close();
  surface.open({ x: 10, y: 20, width: 196, height: 246 });
  check('reopening never calls native show or hide again',
    calls.filter(([name]) => name === 'showInactive').length === 1 && calls.every(([name]) => name !== 'show' && name !== 'hide'));
  check('close makes the resident surface transparent and click-through',
    calls.some((call, i) => call[0] === 'opacity' && call[1] === 0 && calls[i + 1]?.[0] === 'ignore' && calls[i + 1]?.[1] === true));
  check('reopen restores input and opacity without another compositor show',
    calls.slice(-3).some(([name, value]) => name === 'ignore' && value === false)
      && calls.slice(-3).some(([name, value]) => name === 'opacity' && value === 1));
}

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
