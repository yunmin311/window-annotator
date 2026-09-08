'use strict';

function trayMenuWindowOptions() {
  return {
    width: 320,
    height: 340,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    opacity: 0,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    type: 'toolbar',
  };
}

function createMenuBlurGuard({
  now = Date.now,
  hide,
  protectMs = 180,
} = {}) {
  let protectedUntil = 0;

  return {
    openRequested() {
      protectedUntil = now() + protectMs;
    },
    blurRequested() {
      if (now() < protectedUntil) return;
      hide();
    },
    dispose() {},
  };
}

function sameMenuSize(a, b) {
  return !!a && !!b && a.winW === b.winW && a.winH === b.winH;
}

function createMenuPresenter({ present } = {}) {
  let lastSize = null;
  let cursor = null;
  let open = false;
  let presentedSize = null;

  function presentIfNeeded(size) {
    if (!open || !size || sameMenuSize(size, presentedSize)) return;
    presentedSize = size;
    present(size, cursor);
  }

  return {
    sizeReported(size) {
      lastSize = size;
      presentIfNeeded(size);
    },
    openRequested(nextCursor, { deferUntilFreshSize = false } = {}) {
      open = true;
      cursor = nextCursor;
      presentedSize = null;
      if (deferUntilFreshSize) return;
      presentIfNeeded(lastSize);
    },
    closeRequested() {
      open = false;
      presentedSize = null;
    },
  };
}

function sameBounds(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createWarmMenuSurface({ win } = {}) {
  let warmed = false;
  let open = false;
  let bounds = null;

  return {
    warm() {
      if (warmed) return;
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      win.showInactive();
      warmed = true;
    },
    open(nextBounds) {
      if (!sameBounds(bounds, nextBounds)) {
        win.setBounds(nextBounds);
        bounds = { ...nextBounds };
      }
      if (!warmed) this.warm();
      win.setIgnoreMouseEvents(false);
      win.setOpacity(1);
      open = true;
      win.focus();
    },
    close() {
      if (!warmed || !open) return;
      open = false;
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      if (win.isFocused()) win.blur();
    },
  };
}

module.exports = { trayMenuWindowOptions, createMenuBlurGuard, createMenuPresenter, createWarmMenuSurface };
