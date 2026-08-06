// 标注画布:手绘风渲染 + 工具交互。坐标全部相对窗口左上角,覆盖层跟着窗口走,标注自然跟着走。
'use strict';
const { ipcRenderer } = require('electron');
const geo = require('../src/regions'); // 多区跟随:落笔点归哪块区、几何判定(纯逻辑,与主进程共用同一套)

const COLORS = {
  neutral: '#3d3d40', red: '#e5484d', amber: '#ee9d2b',
  green: '#2f9e63', blue: '#0e8fd8', purple: '#8e4ec6',
};

const svg = document.getElementById('canvas');
const scrollG = document.getElementById('scroll-g');
const inkLayer = document.getElementById('ink-layer');
const hlLayer = document.getElementById('hl-layer');
const notesLayer = document.getElementById('notes');
const toolbar = document.getElementById('toolbar');
const toolInk = document.getElementById('tool-ink');
const bindBadge = document.getElementById('bind-badge');

let mode = 'view';        // view | draw
let tool = 'pen';         // pen | arrow | rect | hl | note | eraser
let color = 'red';
let items = [];           // 标注对象:坐标=画下那刻的窗口本地坐标;roff0=落笔所在滚动区当时的位移(跟随基准)
let undoStack = [];
let nextId = 1;

// 多区跟随:主进程每帧发来当前所有可滚动区 [{key, rect{x,y,w,h}, off}](浮层本地 DIP)。
// 每条标注按"落笔点落在哪块区"归属,渲染时按那块区(缓动后)的位移整体上移;不在任何区就钉在窗口上。
let liveRegions = [];
const easedOff = new Map(); // key -> 缓动后的位移,每帧向目标 off 逼近,把 45ms 一跳抹顺
let regionRAF = null;
const elCache = new Map();   // item.id -> 渲染出的元素(缓存,免每帧 querySelector;绝不挂到 items 上,否则 IPC/存档序列化会炸)
const bboxCache = new Map(); // item.id -> 包围盒(缓存,免每帧 getBBox 触发重排)
const cy = (clientY) => clientY; // 坐标存窗口本地(不再叠加滚动),跟随交给每条标注各自的区位移

// 一条标注的锚点(窗口本地):笔迹取首点,箭头/方框/荧光取起点,便签取左上角
function anchorOf(it) {
  if (it.type === 'note') return [it.x, it.y];
  if (it.from) return it.from;
  if (it.points && it.points.length) return it.points[0];
  return [0, 0];
}
// (x,y) 落在哪块区的当前位移(落笔基准);不在任何区返回 null
function roffAt(x, y) {
  const key = geo.pickRegion(liveRegions, x, y);
  const r = key && liveRegions.find((rr) => rr.key === key);
  return r ? r.off : null;
}
// 这条标注归属哪块区:有绑定基准(roff0 是数)且落笔点落在某区。没有则 null(钉窗口)。
function regionFor(it) {
  if (typeof it.roff0 !== 'number') return null;
  const a = anchorOf(it);
  const key = geo.pickRegion(liveRegions, a[0], a[1]);
  return key ? liveRegions.find((r) => r.key === key) : null;
}
// 该整体上移多少(DIP):所在区缓动位移 - 落笔基准;没区=0(钉窗口)
function dyOf(it, reg) {
  reg = reg || regionFor(it);
  if (!reg) return 0;
  const eased = easedOff.has(reg.key) ? easedOff.get(reg.key) : reg.off;
  return -(eased - it.roff0);
}
// 这条标注在它自己坐标系里的包围盒(算一次缓存;跟随时它不变,不必每帧 getBBox 触发重排)
function bboxOf(it) {
  if (bboxCache.has(it.id)) return bboxCache.get(it.id);
  const el = elCache.get(it.id); if (!el) return null;
  let b;
  if (it.type === 'note') b = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  else { try { const g = el.getBBox(); b = { x: g.x, y: g.y, w: g.width, h: g.height }; } catch { b = null; } }
  if (!b || (b.w === 0 && b.h === 0)) return null; // 还没排版好,先别缓存,下帧再试
  bboxCache.set(it.id, b);
  return b;
}
// 这条标注(按当前 dy 平移后)是不是整个滚出了它所在区的范围 —— 是就该藏起来,别飘到区外
function outsideRegion(it, dy, reg) {
  const b = bboxOf(it);
  if (!b) return false;
  return geo.outside(b.x, b.y + dy, b.w, b.h, reg.rect);
}
// 延迟绑定:画笔模式下浮层在前台、读不到目标滚动区,落笔当下没法定基准。回到查看、区读到了,就把还没
// 绑定的标注按落笔点归到所在区,基准取该区当前位移(此刻目标滚动位置≈落笔时,不会错位)。也让存档重载后按
// 几何自动重绑,不依赖易变的区 key。
function bindPending() {
  for (const it of items) {
    if (typeof it.roff0 === 'number') continue;
    const a = anchorOf(it);
    const key = geo.pickRegion(liveRegions, a[0], a[1]);
    if (!key) continue;
    const r = liveRegions.find((rr) => rr.key === key);
    if (r) it.roff0 = r.off;
  }
}
// 把每条标注按其所在区的位移平移到位:paths 各设 transform,便签设 translateY 叠加自身 rotate
function applyRegions() {
  bindPending();
  for (const it of items) {
    const el = elCache.get(it.id); // 缓存的元素引用,不再每帧 querySelector
    if (!el) continue;
    const reg = regionFor(it);
    const dy = dyOf(it, reg);
    if (it.type === 'note') el.style.transform = `translateY(${dy}px) rotate(${it.rot}deg)`;
    else el.setAttribute('transform', `translate(0 ${dy})`);
    // 裁剪:标注跟随其区滚出该区范围就隐藏(否则会"越级"飘到浏览器标签栏等区外)。
    // 用 visibility 不用 display:none —— 后者会让包围盒归零,下一帧误判"在区内"又闪回来。
    el.style.visibility = (reg && outsideRegion(it, dy, reg)) ? 'hidden' : '';
  }
}
// 每帧把每块区的 easedOff 向目标 off 逼近(0.35),把 45ms 一跳抹顺;都到位就停
function easeRegions() {
  let moving = false;
  for (const r of liveRegions) {
    const cur = easedOff.has(r.key) ? easedOff.get(r.key) : r.off;
    const d = r.off - cur;
    if (Math.abs(d) < 0.5) easedOff.set(r.key, r.off);
    else { easedOff.set(r.key, cur + d * 0.35); moving = true; }
  }
  applyRegions();
  regionRAF = moving ? requestAnimationFrame(easeRegions) : null;
}
// 立即吸附(进画笔模式/初始化,免坐标错位)
function snapRegions() {
  if (regionRAF) { cancelAnimationFrame(regionRAF); regionRAF = null; }
  for (const r of liveRegions) easedOff.set(r.key, r.off);
  applyRegions();
}

/* ---------- 手绘感渲染 ---------- */

// 可复现随机数:seed 存在标注对象里,每次重画抖动一致
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 一段带弯曲和抖动的"手画直线",画两遍叠出铅笔感
function sketchSegment(x1, y1, x2, y2, rnd, bowScale = 0.045) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // 垂直方向
  const parts = [];
  for (let pass = 0; pass < 2; pass++) {
    const bow = (rnd() - 0.5) * 2 * Math.min(9, len * bowScale);
    const j = () => (rnd() - 0.5) * 2.4;
    const mx = x1 + dx * (0.4 + rnd() * 0.2) + nx * bow + j();
    const my = y1 + dy * (0.4 + rnd() * 0.2) + ny * bow + j();
    parts.push(`M${x1 + j()} ${y1 + j()} Q${mx} ${my} ${x2 + j()} ${y2 + j()}`);
  }
  return parts.join(' ');
}

function arrowPath(item) {
  const [x1, y1] = item.from, [x2, y2] = item.to;
  const rnd = mulberry32(item.seed);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ang = Math.atan2(dy, dx);
  const headLen = Math.min(16, 8 + len * 0.12);
  let d = sketchSegment(x1, y1, x2, y2, rnd);
  for (const side of [-1, 1]) {
    const a = ang + Math.PI + side * 0.46 + (rnd() - 0.5) * 0.1;
    d += ' ' + sketchSegment(x2, y2, x2 + Math.cos(a) * headLen, y2 + Math.sin(a) * headLen, rnd, 0.1);
  }
  return d;
}

// 手绘方框:四条边各画一段带抖动的"手画线",四角自然不闭合、透着随手感
function rectPath(item) {
  const [x1, y1] = item.from, [x2, y2] = item.to;
  const ax = Math.min(x1, x2), ay = Math.min(y1, y2);
  const bx = Math.max(x1, x2), by = Math.max(y1, y2);
  const rnd = mulberry32(item.seed);
  const seg = (a, b, c, d) => sketchSegment(a, b, c, d, rnd, 0.02); // 直边少弯一点
  return [seg(ax, ay, bx, ay), seg(bx, ay, bx, by), seg(bx, by, ax, by), seg(ax, by, ax, ay)].join(' ');
}

// 荧光笔:一条直带(起点→终点),近水平时自动拉平,像划重点;宽 butt 端不自叠加深
function hlBandPath(item) {
  const [x1, y1] = item.from, [x2, y2] = item.to;
  return `M${x1} ${y1} L${x2} ${y2}`;
}

// 自由笔迹:中点二次贝塞尔平滑
function smoothPath(pts) {
  if (pts.length < 2) {
    const [x, y] = pts[0];
    return `M${x} ${y} l0.01 0`;
  }
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return d;
}

/* ---------- 渲染 ---------- */

function makePath(item) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.dataset.id = item.id;
  p.setAttribute('stroke', COLORS[item.color] || item.color);
  if (item.type === 'pen') {
    p.setAttribute('d', smoothPath(item.points));
    p.setAttribute('stroke-width', 2.6);
  } else if (item.type === 'hl') {
    // 新版是直带(from/to);老存档是自由笔迹(points),两种都能画出来
    p.setAttribute('d', item.from ? hlBandPath(item) : smoothPath(item.points));
    p.setAttribute('stroke-width', 16);
  } else if (item.type === 'arrow') {
    p.setAttribute('d', arrowPath(item));
    p.setAttribute('stroke-width', 2.4);
  } else if (item.type === 'rect') {
    p.setAttribute('d', rectPath(item));
    p.setAttribute('stroke-width', 2.6);
  }
  return p;
}

function makeNote(item) {
  const div = document.createElement('div');
  div.className = 'note';
  div.dataset.id = item.id;
  div.style.left = item.x + 'px';
  div.style.top = item.y + 'px';
  div.style.fontSize = (item.size || 19) + 'px';
  div.style.color = COLORS[item.color] || item.color;
  div.style.transform = `rotate(${item.rot}deg)`;
  div.title = '拖动移动 · 双击改字 · 滚轮缩放 · 选中后点颜色改色 · 右键删除';
  div.textContent = item.text || '';
  bindNote(div, item);
  return div;
}

function renderItem(item) {
  let el;
  if (item.type === 'note') { el = makeNote(item); notesLayer.appendChild(el); }
  else { el = makePath(item); (item.type === 'hl' ? hlLayer : inkLayer).appendChild(el); }
  elCache.set(item.id, el);   // 缓存元素(单独 Map,不进 items)
  bboxCache.delete(item.id);  // 包围盒待用时惰性算一次
}

function renderAll() {
  inkLayer.innerHTML = ''; hlLayer.innerHTML = ''; notesLayer.innerHTML = '';
  elCache.clear(); bboxCache.clear();
  items.forEach(renderItem);
  applyRegions(); // 渲染完按各自区位移就位(初次/重画时对齐)
  document.body.classList.toggle('has-items', items.length > 0);
}

function removeDom(id) {
  document.querySelectorAll(`[data-id="${id}"]`).forEach((el) => el.remove());
  elCache.delete(id); bboxCache.delete(id);
}

/* ---------- 数据 ---------- */

let saveTimer = null;
function save() {
  document.body.classList.toggle('has-items', items.length > 0);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ipcRenderer.send('annotations-changed', items), 350);
}

function addItem(item) {
  items.push(item);
  renderItem(item);
  undoStack.push({ op: 'add', id: item.id });
  save();
}

function deleteItem(id) {
  const idx = items.findIndex((it) => String(it.id) === String(id));
  if (idx === -1) return;
  undoStack.push({ op: 'del', item: items[idx], idx });
  items.splice(idx, 1);
  removeDom(id);
  save();
}

function undo() {
  const a = undoStack.pop();
  if (!a) return;
  if (a.op === 'add') {
    const idx = items.findIndex((it) => it.id === a.id);
    if (idx !== -1) { items.splice(idx, 1); removeDom(a.id); }
  } else if (a.op === 'del') {
    items.splice(Math.min(a.idx, items.length), 0, a.item);
    renderItem(a.item);
  }
  save();
}

/* ---------- 便签交互 ---------- */

let activeNote = null; // 当前选中的便签对象(选中后可用颜色条改色)

function selectNote(item) {
  activeNote = item;
  notesLayer.querySelectorAll('.note').forEach((n) => n.classList.toggle('sel', n.dataset.id == item.id));
}
function clearNoteSelection() {
  activeNote = null;
  notesLayer.querySelectorAll('.note.sel').forEach((n) => n.classList.remove('sel'));
}

function bindNote(div, item) {
  div.addEventListener('mousedown', (e) => {
    if (mode !== 'draw' || div.classList.contains('editing')) return;
    if (e.button !== 0) return; // 右键交给 contextmenu 删除
    e.stopPropagation();
    if (tool === 'eraser') { deleteItem(item.id); return; }
    selectNote(item);
    // 拖动
    const sx = e.clientX - item.x, sy = e.clientY - item.y;
    let moved = false;
    const move = (ev) => {
      moved = true;
      item.x = ev.clientX - sx; item.y = ev.clientY - sy;
      div.style.left = item.x + 'px'; div.style.top = item.y + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // 右键删掉这一个便签
  div.addEventListener('contextmenu', (e) => {
    if (mode !== 'draw') return;
    e.preventDefault(); e.stopPropagation();
    deleteItem(item.id);
  });
  // 滚轮缩放字号(悬停便签滚动)
  div.addEventListener('wheel', (e) => {
    if (mode !== 'draw') return;
    e.preventDefault(); e.stopPropagation();
    const s = Math.max(10, Math.min(80, (item.size || 19) + (e.deltaY < 0 ? 2 : -2)));
    item.size = s; div.style.fontSize = s + 'px'; bboxCache.delete(item.id); // 字号变了,包围盒重算
    selectNote(item);
    save();
  }, { passive: false });
  div.addEventListener('dblclick', (e) => {
    if (mode !== 'draw') return;
    e.stopPropagation();
    editNote(div, item);
  });
}

function editNote(div, item) {
  selectNote(item);
  div.classList.add('editing');
  div.contentEditable = 'true';
  // 窗口刚拿到焦点时直接 focus 偶尔不生效,下一帧再抓一次并把光标放到末尾
  requestAnimationFrame(() => {
    div.focus();
    const r = document.createRange();
    r.selectNodeContents(div);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
  const finish = () => {
    div.contentEditable = 'false';
    div.classList.remove('editing');
    item.text = div.innerText.replace(/\n+$/, ''); bboxCache.delete(item.id); // 文字变了,包围盒重算
    if (!item.text.trim()) deleteItem(item.id);
    else save();
  };
  div.addEventListener('blur', finish, { once: true });
  div.addEventListener('keydown', (e) => {
    // Esc 或 Ctrl+Enter 结束输入;单独回车换行
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault(); e.stopPropagation(); div.blur();
    }
  });
}

/* ---------- 画布交互 ---------- */

let drawing = null; // 进行中的笔画

svg.addEventListener('mousedown', (e) => {
  if (mode !== 'draw' || e.button !== 0) return;
  clearNoteSelection(); // 在空白处落笔,取消便签选中
  const x = e.clientX, y = cy(e.clientY);
  // 不在落笔当下定 roff0:画笔模式下浮层在前台、读不到目标滚动区。回到查看模式由 bindPending 延迟绑定。

  if (tool === 'eraser') {
    const t = e.target.closest('[data-id]');
    if (t) deleteItem(t.dataset.id);
    drawing = { type: 'eraser' };
    return;
  }
  if (tool === 'note') {
    const item = { id: nextId++, type: 'note', color, x, y: y - 12, text: '', rot: (Math.random() * 5 - 2.5), size: 19 };
    addItem(item);
    undoStack.pop(); // 空便签不占撤销位,blur 时若为空会自动删除
    const div = notesLayer.querySelector(`[data-id="${item.id}"]`);
    editNote(div, item);
    return;
  }
  if (tool === 'arrow' || tool === 'rect' || tool === 'hl') {
    // 两点型:箭头 / 方框 / 荧光带,都靠 from→to 定形
    drawing = { type: tool, item: { id: nextId++, type: tool, color, from: [x, y], to: [x, y], seed: (Math.random() * 1e9) | 0 } };
  } else {
    drawing = { type: tool, item: { id: nextId++, type: tool, color, points: [[x, y]] } };
  }
  drawing.el = makePath(drawing.item);
  (tool === 'hl' ? hlLayer : inkLayer).appendChild(drawing.el);
});

window.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const x = e.clientX, y = cy(e.clientY);
  if (drawing.type === 'eraser') {
    if (e.buttons & 1) {
      const t = document.elementFromPoint(e.clientX, e.clientY); // 命中检测要用屏幕坐标
      const hit = t && t.closest && t.closest('[data-id]');
      if (hit) deleteItem(hit.dataset.id);
    }
    return;
  }
  if (drawing.type === 'arrow') {
    drawing.item.to = [x, y];
    drawing.el.setAttribute('d', arrowPath(drawing.item));
  } else if (drawing.type === 'rect') {
    drawing.item.to = [x, y];
    drawing.el.setAttribute('d', rectPath(drawing.item));
  } else if (drawing.type === 'hl') {
    const [x1, y1] = drawing.item.from;
    // 近水平就把终点拉平到同一行(划重点自动出直线),明显斜着划才保留角度
    const y2 = Math.abs(y - y1) < Math.abs(x - x1) * 0.35 ? y1 : y;
    drawing.item.to = [x, y2];
    drawing.el.setAttribute('d', hlBandPath(drawing.item));
  } else {
    const pts = drawing.item.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) > 2.5) {
      pts.push([x, y]);
      drawing.el.setAttribute('d', smoothPath(pts));
    }
  }
});

window.addEventListener('mouseup', () => {
  if (!drawing) return;
  const d = drawing;
  drawing = null;
  if (d.type === 'eraser') return;
  d.el.remove();
  if (d.type === 'arrow' || d.type === 'hl') {
    const [x1, y1] = d.item.from, [x2, y2] = d.item.to;
    if (Math.hypot(x2 - x1, y2 - y1) < 8) return; // 误触:太短不成一笔
  }
  if (d.type === 'rect') {
    const [x1, y1] = d.item.from, [x2, y2] = d.item.to;
    if (Math.abs(x2 - x1) < 8 && Math.abs(y2 - y1) < 8) return; // 误触:太小不成一框
  }
  addItem(d.item);
});

// 右键任意一笔(画笔/箭头/荧光笔)删掉这一个
svg.addEventListener('contextmenu', (e) => {
  if (mode !== 'draw') return;
  const t = e.target.closest && e.target.closest('[data-id]');
  if (t) { e.preventDefault(); e.stopPropagation(); deleteItem(t.dataset.id); }
});

window.addEventListener('keydown', (e) => {
  if (mode !== 'draw') return;
  if (e.key === 'Escape') ipcRenderer.send('exit-draw');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undo();
});

// 画笔模式下,空白处滚鼠标滚轮有两个作用,可切换(默认透明度):
//  · 透明度:上滚变淡看清下面窗口、下滚变实(参考 PixPin 的 Ctrl+滚轮)
//  · 缩放  :放大 / 缩小整层标注(参考 PixPin 默认滚轮缩放贴图)
// 都只动标注层(笔迹 + 便签),工具条 / 描边不动;悬在便签上滚仍是改字号(那儿 stopPropagation,走不到这)。
// 切换:点或右键工具条左端那个小图标(◐透明度 / 🔍缩放)。换模式复位。
let inkOpacity = 1;
let inkScale = 1;
let wheelMode = 'opacity';            // 'opacity' | 'zoom'
let inkBadgeTimer = null;
const inkBadge = document.getElementById('ink-badge');
const wheelModeBtn = document.getElementById('wheel-mode');

function applyInk(showBadge) {
  svg.style.opacity = inkOpacity;
  notesLayer.style.opacity = inkOpacity;
  svg.style.transformOrigin = notesLayer.style.transformOrigin = 'center';
  svg.style.transform = notesLayer.style.transform = 'scale(' + inkScale + ')';
  if (showBadge && inkBadge) {
    inkBadge.textContent = wheelMode === 'zoom'
      ? '缩放 ' + Math.round(inkScale * 100) + '%'
      : '标注 ' + Math.round(inkOpacity * 100) + '%';
    inkBadge.classList.add('show');
    clearTimeout(inkBadgeTimer);
    inkBadgeTimer = setTimeout(() => inkBadge.classList.remove('show'), 900);
  }
}
function setWheelMode(m) {
  wheelMode = m;
  if (!wheelModeBtn) return;
  wheelModeBtn.textContent = m === 'zoom' ? '🔍' : '◐';
  wheelModeBtn.title = m === 'zoom'
    ? '滚轮 = 缩放标注(点击 / 右键切成透明度)'
    : '滚轮 = 标注透明度(点击 / 右键切成缩放)';
}
if (wheelModeBtn) {
  const toggle = (e) => { if (e) e.preventDefault(); setWheelMode(wheelMode === 'zoom' ? 'opacity' : 'zoom'); applyInk(true); };
  wheelModeBtn.addEventListener('click', toggle);
  wheelModeBtn.addEventListener('contextmenu', toggle);
  setWheelMode('opacity');
}
window.addEventListener('wheel', (e) => {
  if (mode !== 'draw') return;
  e.preventDefault();
  if (wheelMode === 'zoom') inkScale = Math.max(0.4, Math.min(2.6, inkScale + (e.deltaY > 0 ? -0.08 : 0.08)));
  else inkOpacity = Math.max(0.12, Math.min(1, inkOpacity + (e.deltaY > 0 ? 0.08 : -0.08)));
  applyInk(true);
}, { passive: false });

/* ---------- 工具条 ---------- */

const CURSORS = { note: 'text', eraser: 'cell' };

// 把滑动高亮胶囊移到当前工具按钮下方。animate=false 时先关过渡瞬间到位(工具条刚出现,别从角落滑进来)
function placeInk(animate) {
  const btn = toolbar.querySelector('[data-tool].active');
  if (!btn || !btn.offsetParent) return; // 工具条没显示时 offsetParent 为空,不测量
  if (!animate) toolInk.style.transition = 'none';
  toolInk.style.width = btn.offsetWidth + 'px';
  toolInk.style.height = btn.offsetHeight + 'px';
  toolInk.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
  toolInk.style.opacity = '1';
  if (!animate) { void toolInk.offsetWidth; toolInk.style.transition = ''; } // 强制回流后恢复过渡
}

function selectTool(name) {
  tool = name;
  if (name !== 'note') clearNoteSelection();
  toolbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  svg.style.cursor = CURSORS[name] || 'crosshair';
  document.body.classList.toggle('tool-note', name === 'note');
  placeInk(true); // 平滑滑到新工具
}
toolbar.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
});

const colorsBox = document.getElementById('colors');
for (const name of Object.keys(COLORS)) {
  const s = document.createElement('span');
  s.className = 'swatch' + (name === color ? ' active' : '');
  s.style.background = COLORS[name];
  s.title = name;
  s.addEventListener('click', () => {
    color = name;
    document.body.style.setProperty('--accent', COLORS[name]);
    colorsBox.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('active', el === s));
    // 若正选中某个便签,顺手把它改成这个颜色
    if (activeNote) {
      activeNote.color = name;
      const d = notesLayer.querySelector(`[data-id="${activeNote.id}"]`);
      if (d) d.style.color = COLORS[name];
      save();
    }
  });
  colorsBox.appendChild(s);
}
document.body.style.setProperty('--accent', COLORS[color]);

document.getElementById('undo').addEventListener('click', undo);
document.getElementById('clear').addEventListener('click', () => {
  if (!items.length) return;
  items = []; undoStack = [];
  renderAll(); save();
});
document.getElementById('done').addEventListener('click', () => ipcRenderer.send('exit-draw'));
document.getElementById('chip').addEventListener('click', () => ipcRenderer.send('enter-draw'));

/* ---------- 与主进程协作 ---------- */

ipcRenderer.on('init', (e, data) => {
  items = data.items || [];
  nextId = items.reduce((m, it) => Math.max(m, Number(it.id) || 0), 0) + 1;
  document.getElementById('app-name').textContent = data.appName || '';
  liveRegions = []; easedOff.clear();
  renderAll();
});

ipcRenderer.on('mode', (e, m) => {
  mode = m;
  document.body.className = m + (items.length ? ' has-items' : '') + (tool === 'note' ? ' tool-note' : '');
  inkOpacity = 1; inkScale = 1; applyInk(false); // 换模式复位:标注恢复不透明 + 原始大小
  if (m === 'view' && drawing) drawing = null;
  if (m === 'view') clearNoteSelection();
  if (m !== 'view') { clearTimeout(bindPendingTimer); clearTimeout(bindHideTimer); bindBadge.classList.remove('show'); }
  if (m === 'draw') {
    snapRegions(); // 进画笔模式先把缓动吸附到位,画笔坐标才不会错位
    requestAnimationFrame(() => placeInk(false)); // 工具条已显示,把高亮胶囊瞬间摆到当前工具下
  }
});

// 多区跟随:主进程每帧发来当前所有可滚动区(浮层本地 DIP + 各自内容位移),查看模式下每条标注
// 按它落笔所在那块区缓动平移。绝对量、自我校正、不漂移;读不到时主进程发空数组,标注钉在窗口上。
ipcRenderer.on('regions', (e, list) => {
  if (mode !== 'view') return;
  liveRegions = list || [];
  for (const k of [...easedOff.keys()]) if (!liveRegions.some((r) => r.key === k)) easedOff.delete(k); // 清消失区的残留
  if (!regionRAF) regionRAF = requestAnimationFrame(easeRegions);
});

// 绑定状态牌:主进程算好"跟随滚动中 / 只钉在窗口上"发过来,查看模式下短暂亮一下再淡出。
// 刚切回窗口那一下,读取器还没锁定会误报一次"读不到",所以 window 状态延后 1.2s 再显示,躲开这个抖动。
let bindHideTimer = null, bindPendingTimer = null;
function showBind(state) {
  bindBadge.textContent = state === 'scroll' ? '跟随滚动中' : '钉在窗口 · 读不到滚动';
  bindBadge.classList.remove('scroll', 'window');
  bindBadge.classList.add(state, 'show');
  clearTimeout(bindHideTimer);
  bindHideTimer = setTimeout(() => bindBadge.classList.remove('show'), 2600);
}
ipcRenderer.on('bind-state', (e, state) => {
  if (mode !== 'view') return;
  clearTimeout(bindPendingTimer);
  if (state === 'scroll') showBind('scroll');
  else bindPendingTimer = setTimeout(() => { if (mode === 'view') showBind('window'); }, 1200);
});

// 查看模式:整窗穿透,但悬停到 ✎ 小按钮时临时接住鼠标
let ignoring = true;
window.addEventListener('mousemove', (e) => {
  if (mode !== 'view') return;
  const over = !!(e.target && e.target.closest && e.target.closest('.hoverable'));
  if (over === ignoring) {
    ignoring = !over;
    ipcRenderer.send('set-ignore', !over);
  }
});
