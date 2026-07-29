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

/* ---------- 全局滚轮钩子 ----------
   外挂浮层读不到目标软件内部的滚动位置,所以用 WH_MOUSE_LL 低级鼠标钩子在系统层
   截下滚轮增量(WHEEL_DELTA=120/格),累加起来给主进程按帧取用,换算成像素平移标注。*/
const GetModuleHandleW = kernel32.func('int64 GetModuleHandleW(void *name)');
const SetWindowsHookExW = user32.func('int64 SetWindowsHookExW(int idHook, void *fn, int64 hmod, uint32 threadId)');
const CallNextHookEx = user32.func('int64 CallNextHookEx(int64 hhk, int nCode, uint64 wParam, int64 lParam)');
const UnhookWindowsHookEx = user32.func('bool UnhookWindowsHookEx(int64 hhk)');
// MSLLHOOKSTRUCT: pt(2×long) + mouseData(滚轮高16位有符号) + flags + time + extra
const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
  x: 'long', y: 'long', mouseData: 'int32', flags: 'uint32', time: 'uint32', extra: 'uint64',
});
const MouseProc = koffi.proto('int64 __stdcall MouseProc(int nCode, uint64 wParam, int64 lParam)');

let hookHandle = 0;
let wheelAccum = 0; // 累积滚轮增量(单位 WHEEL_DELTA)
let hookCb = null;

function installWheelHook() {
  if (hookHandle) return true;
  hookCb = koffi.register((nCode, wParam, lParam) => {
    try {
      if (nCode >= 0 && Number(wParam) === 0x020A /* WM_MOUSEWHEEL */) {
        const info = koffi.decode(lParam, MSLLHOOKSTRUCT);
        wheelAccum += (info.mouseData >> 16); // 向上滚为正,向下滚为负
      }
    } catch { /* 钩子回调必须永不抛错 */ }
    return CallNextHookEx(0, nCode, wParam, lParam);
  }, koffi.pointer(MouseProc));
  hookHandle = SetWindowsHookExW(14 /* WH_MOUSE_LL */, hookCb, GetModuleHandleW(null), 0);
  return BigInt(hookHandle) !== 0n;
}

function takeWheel() {
  const v = wheelAccum;
  wheelAccum = 0;
  return v;
}

function uninstallWheelHook() {
  if (hookHandle) { UnhookWindowsHookEx(hookHandle); hookHandle = 0; }
}

module.exports = {
  getForegroundWindow, getWindowState, getWindowInfo, setForegroundWindow, hkey, same,
  installWheelHook, takeWheel, uninstallWheelHook,
};
