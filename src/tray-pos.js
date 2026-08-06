'use strict';
// 托盘自绘菜单的定位:托盘在屏幕右下角,菜单卡片的右下角尽量贴住光标、朝左上展开(和系统托盘菜单
// 的方向一致),再把整张卡片夹进工作区(避开任务栏,不出屏)。纯函数,便于无头单测。
// 坐标全是 DIP,与 screen.getCursorScreenPoint / BrowserWindow.setBounds 一致,不掺物理像素。
//   cursor  = {x, y}                         光标屏幕坐标
//   size    = {winW, winH, cardW, cardH, pad} 窗口透明、四周留 pad 给阴影,卡片在窗口内缩进 pad
//   workArea= {x, y, width, height}          目标显示器的可用区(已扣掉任务栏)
function menuPosition(cursor, size, workArea) {
  const { cardW, cardH, pad } = size;
  // 想让"卡片"的右下角落在光标处 —— 反推窗口左上角(卡片相对窗口缩进 pad)
  let x = cursor.x - pad - cardW;
  let y = cursor.y - pad - cardH;
  // 夹逼:保证卡片(不是带阴影的窗口)完整留在工作区内
  const minX = workArea.x - pad;
  const maxX = workArea.x + workArea.width - pad - cardW;
  const minY = workArea.y - pad;
  const maxY = workArea.y + workArea.height - pad - cardH;
  x = Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX)));
  y = Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY)));
  return { x, y };
}

module.exports = { menuPosition };
