// Win32 桥:窗口追踪所需的最小 API 集(koffi FFI,无需编译)
'use strict';
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const U32BOX = koffi.struct('U32BOX', { v: 'uint32' });

const GetForegroundWindow = user32.func('int64 GetForegroundWindow()');
const IsWindow = user32.func('bool IsWindow(int64 hwnd)');
const IsIconic = user32.func('bool IsIconic(int64 hwnd)');
const GetWindowRect = user32.func('bool GetWindowRect(int64 hwnd, _Out_ RECT *rect)');
const GetWindowTextW = user32.func('int GetWindowTextW(int64 hwnd, void *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(int64 hwnd, _Out_ U32BOX *pid)');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(int64 hwnd)');
const OpenProcess = kernel32.func('int64 OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool CloseHandle(int64 h)');
const QueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(int64 h, uint32 flags, void *buf, _Inout_ U32BOX *size)');
// attr 9 = DWMWA_EXTENDED_FRAME_BOUNDS(可见边框,物理像素); attr 14 = DWMWA_CLOAKED(仅写 4 字节,借 RECT 当缓冲)
const DwmGetWindowAttribute = dwmapi.func('int DwmGetWindowAttribute(int64 hwnd, uint32 attr, _Out_ RECT *pv, uint32 cb)');

const hkey = (hwnd) => BigInt(hwnd).toString();
const same = (a, b) => BigInt(a) === BigInt(b);

function getForegroundWindow() {
  return GetForegroundWindow();
}

function getWindowState(hwnd) {
  if (!IsWindow(hwnd)) return null;
  const state = { minimized: IsIconic(hwnd), cloaked: false, rect: null };

  const cloak = {};
  if (DwmGetWindowAttribute(hwnd, 14, cloak, 4) === 0) state.cloaked = (cloak.left | 0) !== 0;

  const r = {};
  let ok = DwmGetWindowAttribute(hwnd, 9, r, koffi.sizeof(RECT)) === 0;
  if (!ok) ok = GetWindowRect(hwnd, r);
  if (ok) state.rect = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  return state;
}

function getWindowInfo(hwnd) {
  if (!IsWindow(hwnd)) return null;
  const tbuf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, tbuf, 512);
  const title = tbuf.toString('utf16le', 0, n * 2);

  let exe = '';
  const pid = {};
  GetWindowThreadProcessId(hwnd, pid);
  if (pid.v) {
    const h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid.v);
    if (BigInt(h) !== 0n) {
      const pbuf = Buffer.alloc(2080);
      const size = { v: 1040 };
      if (QueryFullProcessImageNameW(h, 0, pbuf, size)) {
        exe = pbuf.toString('utf16le', 0, size.v * 2).split('\\').pop();
      }
      CloseHandle(h);
    }
  }
  return { title, exe, pid: pid.v || 0 };
}

function setForegroundWindow(hwnd) {
  return SetForegroundWindow(hwnd);
}

// 注:曾用 WH_MOUSE_LL 低级鼠标钩子截滚轮来"估算"目标滚动量,但外挂读不到目标内部真实滚动,
// 估算常对不齐甚至乱动(用户实测确认)。现改由 src/scroll-uia.js 走系统无障碍读"真实滚动百分比",
// 全局滚轮钩子已废弃移除,少挂一个系统级 hook,后台更轻。

module.exports = {
  getForegroundWindow, getWindowState, getWindowInfo, setForegroundWindow, hkey, same,
};
