// 无头单元测试:纯 node 跑 src/regions.js 的几何/匹配逻辑,不碰 electron/前台/GPU,100% 可复现。
// 用法: node test/unit-regions.js
'use strict';
const R = require('../src/regions');
const U = require('../src/scroll-uia');

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  if (!ok) fails++;
};
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) fails++; };

// ---- contains / area ----
ok('contains inside', R.contains({ x: 0, y: 0, w: 100, h: 100 }, 50, 50));
ok('contains edge', R.contains({ x: 0, y: 0, w: 100, h: 100 }, 100, 0));
ok('contains outside', !R.contains({ x: 0, y: 0, w: 100, h: 100 }, 101, 50));
eq('area', R.area({ x: 0, y: 0, w: 30, h: 40 }), 1200);

// ---- pickRegion: 侧栏(小,内嵌)优先于整页正文(大);落在正文外则 null ----
const regions = [
  { key: 'main', rect: { x: 0, y: 0, w: 1000, h: 900 } },   // 整页正文
  { key: 'side', rect: { x: 0, y: 0, w: 300, h: 900 } },    // 左侧栏,套在正文左边
];
eq('pick 侧栏区域内的点 -> 最具体的 side', R.pickRegion(regions, 100, 400), 'side');
eq('pick 只在正文里的点 -> main', R.pickRegion(regions, 600, 400), 'main');
eq('pick 都不在 -> null', R.pickRegion(regions, 100, 2000), null);

// ---- matchRegions: 跨帧保持 key;轻微位移仍算同一块;全新区发新号 ----
const prev = [
  { key: 'r0', rect: { x: 0, y: 0, w: 1000, h: 900 } },
  { key: 'r1', rect: { x: 0, y: 0, w: 300, h: 900 } },
];
const keyRef = { n: 2 };
// 这一帧:两块各漂了几像素(滚动时容器可能微动),外加一块全新的区
const curr = [
  { x: 2, y: 1, w: 1000, h: 900, percent: 40, viewsize: 30 },  // 对应 r0
  { x: 0, y: 3, w: 300, h: 900, percent: 10, viewsize: 25 },   // 对应 r1
  { x: 1400, y: 0, w: 400, h: 900, percent: 0, viewsize: 50 }, // 全新
];
const matched = R.matchRegions(prev, curr, keyRef);
eq('match 第1块保持 r0', matched[0].key, 'r0');
eq('match 第2块保持 r1', matched[1].key, 'r1');
eq('match 全新块发新号 r2', matched[2].key, 'r2');
eq('match 保留 curr 字段(percent)', matched[0].percent, 40);
ok('match 尺寸差太大不误配', (() => {
  const m = R.matchRegions([{ key: 'x', rect: { x: 0, y: 0, w: 100, h: 100 } }], [{ x: 0, y: 0, w: 900, h: 900 }], { n: 5 });
  return m[0].key === 'r5'; // 尺寸差 800 > 容差,不该复用 x,应发新号
})());

// ---- toLocalDip: 物理屏幕 -> 浮层本地 DIP (DPR=1.5) ----
// 目标窗口可见边框在物理 (200,100),DPR=1.5;某区物理 (200,400,600,300)
const local = R.toLocalDip({ x: 200, y: 400, w: 600, h: 300 }, { x: 200, y: 100 }, 1.5);
eq('toLocalDip', local, { x: 0, y: 200, w: 400, h: 200 }); // (400-100)/1.5=200; 600/1.5=400; 300/1.5=200

// ---- offsetDip: 内容位移像素 ----
// viewsize=10% => 内容=视口的10倍;viewportDip=956 => content=9560, scrollable=8604;percent=50 => 4302
eq('offsetDip 50%', Math.round(R.offsetDip(50, 10, 956)), 4302);
eq('offsetDip 不可滚(vs=100)=0', R.offsetDip(0, 100, 956), 0);
eq('offsetDip percent=-1 => 0', R.offsetDip(-1, 10, 956), 0);
eq('offsetDip 顶部 percent=0 => 0', R.offsetDip(0, 10, 956), 0);

// ---- scroll-uia.parseLine: reader 输出的多区解析 ----
eq('parseLine 双区', U.parseLine('S 123|10,20,300,400,50.5,30.2|0,0,1920,900,0,80'),
  { hwnd: '123', regions: [
    { x: 10, y: 20, w: 300, h: 400, percent: 50.5, viewsize: 30.2 },
    { x: 0, y: 0, w: 1920, h: 900, percent: 0, viewsize: 80 }] });
eq('parseLine NA', U.parseLine('NA 456'), { na: '456' });
eq('parseLine 垃圾行 -> null', U.parseLine('hello world'), null);
ok('parseLine 坏字段被滤掉', (() => { const r = U.parseLine('S 5|bad,seg'); return r && r.hwnd === '5' && r.regions.length === 0; })());

// ---- outside: 标注 bbox 是否整个滚出了所在区(裁剪用) ----
const RG = { x: 0, y: 100, w: 200, h: 400 }; // 一块区,纵向 100..500
eq('outside 在区内 -> false', R.outside(50, 200, 30, 30, RG), false);
eq('outside 整个在区上方 -> true', R.outside(50, 40, 30, 30, RG), true);   // 底 70 < 100
eq('outside 整个在区下方 -> true', R.outside(50, 520, 30, 30, RG), true);  // 顶 520 > 500
eq('outside 跨上边界(还有一半在内)-> false', R.outside(50, 80, 30, 40, RG), false); // 80..120 与 100..500 有交
eq('outside 整个在区左侧 -> true', R.outside(-40, 200, 30, 30, RG), true); // 右 -10 < 0

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
