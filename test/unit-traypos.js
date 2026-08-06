// 无头单测:托盘自绘菜单的定位 menuPosition —— 贴光标 + 夹进工作区不出屏。用法: node test/unit-traypos.js
'use strict';
const { menuPosition } = require('../src/tray-pos');

let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) fails++; };

// 1920x1080、底部 40px 任务栏 -> 工作区高 1040
const wa = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { winW: 260, winH: 260, cardW: 224, cardH: 224, pad: 18 };
const cardBox = (p) => ({ l: p.x + size.pad, t: p.y + size.pad, r: p.x + size.pad + size.cardW, b: p.y + size.pad + size.cardH });
const inWA = (b) => b.l >= wa.x && b.t >= wa.y && b.r <= wa.x + wa.width && b.b <= wa.y + wa.height;

// 光标在右下托盘处,空间充足:卡片右下角正好贴光标
const p1 = menuPosition({ x: 1900, y: 1035 }, size, wa);
ok('右下角:卡片右下贴光标 (x=' + p1.x + ',y=' + p1.y + ')', p1.x === 1900 - 18 - 224 && p1.y === 1035 - 18 - 224);
ok('右下角:卡片仍在工作区内', inWA(cardBox(p1)));

// 光标贴左边:x 若照公式会为负,应夹到卡片左沿=工作区左沿
const p2 = menuPosition({ x: 5, y: 1035 }, size, wa);
ok('贴左边:卡片左沿=工作区左沿 (cardL=' + cardBox(p2).l + ')', cardBox(p2).l === wa.x);
ok('贴左边:卡片仍在工作区内', inWA(cardBox(p2)));

// 光标贴顶:y 照公式为负,应夹到卡片上沿=工作区上沿
const p3 = menuPosition({ x: 960, y: 8 }, size, wa);
ok('贴顶:卡片上沿=工作区上沿 (cardT=' + cardBox(p3).t + ')', cardBox(p3).t === wa.y);

// 光标贴右下极角:不能让卡片被任务栏切到 —— 底边不超过工作区底
const p4 = menuPosition({ x: 1919, y: 1039 }, size, wa);
ok('贴右下角:卡片底边不越过任务栏 (cardB=' + cardBox(p4).b + '<=' + (wa.y + wa.height) + ')', cardBox(p4).b <= wa.y + wa.height);
ok('贴右下角:卡片仍在工作区内', inWA(cardBox(p4)));

// 屏幕中间:整张卡片都在工作区里
const p5 = menuPosition({ x: 960, y: 520 }, size, wa);
ok('屏幕中间:卡片完整在工作区内', inWA(cardBox(p5)));

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
