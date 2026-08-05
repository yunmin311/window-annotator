// 多区跟随的纯几何 / 匹配逻辑。刻意不依赖 electron / DOM / UIA,所以能用 node 直接跑单元测试
//(避开前台锁和 GPU 退化那些环境坑)。矩形一律 {x, y, w, h}。坐标单位在各函数注释里说明。
'use strict';

function area(r) { return Math.max(0, r.w) * Math.max(0, r.h); }

// 点 (x,y) 是否落在矩形 r 内(闭区间)
function contains(r, x, y) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

// 把这一帧读到的滚动区,匹配到上一帧带 key 的区,让同一块区跨帧保持同一个 key
//(滚动时容器本身几乎不动,只有内容在滚,所以按"中心接近 + 尺寸接近"贪心匹配很稳)。
// prevKeyed: [{key, rect}]; curr: [{x,y,w,h,...}]; keyRef: {n} 用来给新区发号。
// 返回 [{key, ...curr字段}]。
function matchRegions(prevKeyed, curr, keyRef, tol = 40) {
  const used = new Set();
  return curr.map((c) => {
    let best = null, bestDist = Infinity;
    for (const p of prevKeyed) {
      if (used.has(p.key)) continue;
      const dcx = (c.x + c.w / 2) - (p.rect.x + p.rect.w / 2);
      const dcy = (c.y + c.h / 2) - (p.rect.y + p.rect.h / 2);
      const dist = Math.hypot(dcx, dcy);
      const dw = Math.abs(c.w - p.rect.w), dh = Math.abs(c.h - p.rect.h);
      if (dist <= tol && dw <= tol && dh <= tol && dist < bestDist) { best = p; bestDist = dist; }
    }
    let key;
    if (best) { key = best.key; used.add(best.key); }
    else { key = 'r' + (keyRef.n++); }
    return Object.assign({ key }, c);
  });
}

// 区矩形:物理屏幕像素 -> 浮层本地 DIP。targetPhys=目标窗口可见边框(物理);scale=DPR=targetPhys.h / 浮层DIP高。
function toLocalDip(regionPhys, targetPhys, scale) {
  const s = scale || 1;
  return {
    x: (regionPhys.x - targetPhys.x) / s,
    y: (regionPhys.y - targetPhys.y) / s,
    w: regionPhys.w / s,
    h: regionPhys.h / s,
  };
}

// 由 UIA 滚动状态算"内容已上移多少"(DIP)。percent 0..100;viewsize=视口占内容的百分比;viewportDip=区高(DIP)。
function offsetDip(percent, viewsize, viewportDip) {
  if (!(viewsize > 0.01 && viewsize < 99.99) || percent < 0) return 0;
  const contentDip = viewportDip / (viewsize / 100);
  const scrollableDip = Math.max(0, contentDip - viewportDip);
  return (percent / 100) * scrollableDip;
}

// bbox(bx,by,bw,bh)是否整个落在 region 矩形 r 之外 —— 裁剪用:标注跟随滚出所在区就隐藏,别飘到区外
// (比如侧栏的标注滚到侧栏顶部以上,应消失,而不是继续上飘到浏览器标签栏)。
function outside(bx, by, bw, bh, r) {
  return (by + bh) < r.y || by > (r.y + r.h) || (bx + bw) < r.x || bx > (r.x + r.w);
}

// 点该归给哪一块区:落在其中、面积最小的那块(最具体,比如页面里的侧栏优先于整页正文)。返回 key 或 null。
function pickRegion(regions, x, y) {
  let bestKey = null, bestArea = Infinity;
  for (const r of regions) {
    if (contains(r.rect, x, y)) {
      const a = area(r.rect);
      if (a < bestArea) { bestArea = a; bestKey = r.key; }
    }
  }
  return bestKey;
}

module.exports = { area, contains, matchRegions, toLocalDip, offsetDip, pickRegion, outside };
