'use strict';
// 截图裁剪几何(纯函数,可单测):把目标窗口的「DIP 屏幕矩形」映射进「整屏缩略图」的像素空间。
// 关键:用"窗口占该显示器的比例"来换算,而不是乘缩放系数 —— 这样天然免疫 DPI 缩放与取整误差,
// 也不关心缩略图到底多少分辨率。再把结果夹进缩略图范围,窗口有一部分滚出屏幕/出界也不会越界报错。
//
//   win        目标窗口矩形 {x,y,width,height}(DIP,Electron 屏幕坐标系)
//   dispOrigin 窗口所在显示器的原点 {x,y}(DIP,= display.bounds)
//   dispSize   该显示器尺寸 {width,height}(DIP,= display.size)
//   thumb      desktopCapturer 抓到的整屏缩略图像素尺寸 {width,height}(= thumbnail.getSize())
function cropRect(win, dispOrigin, dispSize, thumb) {
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  // 先按比例算出窗口在缩略图里的"原始"矩形(可能有负坐标/超边)
  const rawX = Math.round(((win.x - dispOrigin.x) / dispSize.width) * thumb.width);
  const rawY = Math.round(((win.y - dispOrigin.y) / dispSize.height) * thumb.height);
  const rawW = Math.round((win.width / dispSize.width) * thumb.width);
  const rawH = Math.round((win.height / dispSize.height) * thumb.height);
  // 再与屏幕 [0,thumb] 求交集:出屏的部分被切掉,可见宽高相应缩短(不是简单把 x 夹到 0)
  const x0 = clamp(0, thumb.width, rawX);
  const y0 = clamp(0, thumb.height, rawY);
  const x1 = clamp(0, thumb.width, rawX + rawW);
  const y1 = clamp(0, thumb.height, rawY + rawH);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

module.exports = { cropRect };
