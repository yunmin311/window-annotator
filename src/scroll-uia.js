// UIA 滚动读取器(Node 侧,多区版):拉起常驻 PowerShell 子进程,持续读"前台窗口的所有可滚动区",
// 主进程随用随取。读不到就返回 null,由 main.js 退回"标注钉在窗口上"。
// 兼容:get() 仍返回"最大的那块区"(旧单区口径),getRegions() 返回全部区(多区新路)。
'use strict';
const { spawn } = require('child_process');
const path = require('path');

let proc = null;
const latest = new Map(); // hwnd 字符串 -> { regions:[{x,y,w,h,percent,viewsize}], t }

// 纯函数:解析一行 reader 输出。返回 { hwnd, regions } / { na:hwnd } / null。抽出来好无头单测。
function parseLine(line) {
  if (!line) return null;
  if (line.startsWith('S ')) {
    const bar = line.indexOf('|');
    if (bar < 0) return null;
    const hwnd = line.slice(2, bar).trim();
    const regions = line.slice(bar + 1).split('|').map((seg) => {
      const p = seg.split(',');
      return { x: +p[0], y: +p[1], w: +p[2], h: +p[3], percent: +p[4], viewsize: +p[5] };
    }).filter((r) => Number.isFinite(r.percent) && r.w > 0 && r.h > 0);
    return { hwnd, regions };
  }
  if (line.startsWith('NA ')) return { na: line.slice(3).trim() };
  return null;
}

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
      const r = parseLine(line);
      if (!r) continue;
      if (r.na !== undefined) latest.delete(r.na);
      else latest.set(r.hwnd, { regions: r.regions, t: Date.now() });
    }
  });
  proc.on('exit', () => { proc = null; latest.clear(); });
  proc.on('error', () => { proc = null; });
}

function stop() {
  if (proc) { try { proc.kill(); } catch { /* 忽略 */ } proc = null; }
  latest.clear();
}

// 某窗口最近读到的所有可滚动区;太旧(>1s)视为无效
function getRegions(hwnd) {
  const v = latest.get(BigInt(hwnd).toString());
  if (!v || Date.now() - v.t > 1000) return null;
  return v.regions;
}

// 旧单区口径:最大的那块正在滚的区,包成旧形状 {percent, viewsize, viewportPx}。main 暂时还用它,不回归。
function get(hwnd) {
  const rs = getRegions(hwnd);
  if (!rs || !rs.length) return null;
  let best = null, bestArea = -1;
  for (const r of rs) { const a = r.w * r.h; if (a > bestArea) { bestArea = a; best = r; } }
  if (!best) return null;
  return { percent: best.percent, viewsize: best.viewsize, viewportPx: best.h };
}

module.exports = { start, stop, get, getRegions, parseLine };
