// 截图裁剪几何单测(纯 Node,不需 electron/真实屏幕)。用法: node test/unit-shotgeom.js
'use strict';
const assert = require('assert');
const { cropRect } = require('../src/shot-geom');

let n = 0, fails = 0;
function eq(name, got, want) {
  n++;
  try { assert.deepStrictEqual(got, want); console.log('PASS - ' + name); }
  catch (e) { fails++; console.log('FAIL - ' + name + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}

// 1) 1x 主屏,窗口整个在屏内 —— 缩略图=物理=DIP,裁剪原样
eq('1x 主屏 窗口在内',
  cropRect({ x: 100, y: 120, width: 800, height: 600 }, { x: 0, y: 0 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
  { x: 100, y: 120, width: 800, height: 600 });

// 2) 2x HiDPI:显示器 1920x1080 DIP,缩略图 3840x2160 物理;窗口 DIP (0,0,960,540) -> 物理 (0,0,1920,1080)
eq('2x HiDPI 比例映射',
  cropRect({ x: 0, y: 0, width: 960, height: 540 }, { x: 0, y: 0 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }),
  { x: 0, y: 0, width: 1920, height: 1080 });

// 3) 窗口左上角滚出屏幕(x/y 为负)-> 夹到 0,宽高相应缩短(不越界)
eq('出屏左上 夹取',
  cropRect({ x: -50, y: -30, width: 400, height: 300 }, { x: 0, y: 0 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
  { x: 0, y: 0, width: 350, height: 270 });

// 4) 副屏(原点 1920,0):窗口在副屏内,按副屏原点做相对换算
eq('副屏 相对原点',
  cropRect({ x: 2020, y: 100, width: 600, height: 400 }, { x: 1920, y: 0 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
  { x: 100, y: 100, width: 600, height: 400 });

// 5) 窗口右/下超出屏幕 -> 宽高被夹到屏幕边界内
eq('出屏右下 夹取',
  cropRect({ x: 1600, y: 900, width: 800, height: 600 }, { x: 0, y: 0 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
  { x: 1600, y: 900, width: 320, height: 180 });

console.log(fails === 0 ? `ALL PASS (${n})` : `${fails}/${n} FAILED`);
process.exit(fails === 0 ? 0 : 1);
