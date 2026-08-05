// UIA 滚动读取器(Node 侧):按需拉起一个常驻 PowerShell 子进程,持续读"前台窗口的真实滚动",
// 主进程随用随取。读不到就返回 null,由 main.js 自动退回"标注钉在窗口上"的稳妥行为。
'use strict';
const { spawn } = require('child_process');
const path = require('path');

let proc = null;
const latest = new Map(); // hwnd 字符串 -> { percent, viewsize, viewportPx, t }

function start() {
  if (proc) return;
  try {
    proc = spawn('powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', path.join(__dirname, 'scroll-reader.ps1')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { proc = null; return; }

  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const p = line.split(/\s+/);
      if (p[0] === 'S') {
        latest.set(p[1], {
          percent: parseFloat(p[2]),
          viewsize: parseFloat(p[3]),
          viewportPx: parseFloat(p[4]) || 0,
          t: Date.now(),
        });
      } else if (p[0] === 'NA') {
        latest.delete(p[1]);
      }
    }
  });
  proc.on('exit', () => { proc = null; latest.clear(); });
  proc.on('error', () => { proc = null; });
}

function stop() {
  if (proc) { try { proc.kill(); } catch { /* 忽略 */ } proc = null; }
  latest.clear();
}

// 取某窗口最近一次读到的滚动;太旧(>1s,说明已读不到)视为无效
function get(hwnd) {
  const v = latest.get(BigInt(hwnd).toString());
  if (!v || Date.now() - v.t > 1000) return null;
  return v;
}

module.exports = { start, stop, get };
