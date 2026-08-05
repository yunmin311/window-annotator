// 标注画布:手绘风渲染 + 工具交互。坐标全部相对窗口左上角,覆盖层跟着窗口走,标注自然跟着走。
'use strict';
const { ipcRenderer } = require('electron');

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
let items = [];           // 所有标注对象(可序列化,y 为"内容坐标"= 滚动=0 时的窗口坐标)
let undoStack = [];
let nextId = 1;
let scrollY = 0;          // 当前渲染的滚动位移(像素,缓动逼近 targetScrollY)
let targetScrollY = 0;    // 滚轮累计到的目标位移
let scrollRAF = null;

// 屏幕纵坐标 -> 内容纵坐标:存进标注里的 y 都加上当前滚动量,这样滚动时整体平移一致
const cy = (clientY) => clientY + scrollY;

function applyScroll() {
  scrollG.setAttribute('transform', `translate(0 ${-scrollY})`);
  notesLayer.style.transform = `translateY(${-scrollY}px)`;
}

// 快速缓动:每帧把 scrollY 拉近 targetScrollY 的 35%,把滚轮的"一格一跳"抹成顺滑滑动
function easeScroll() {
  const d = targetScrollY - scrollY;
  if (Math.abs(d) < 0.5) { scrollY = targetScrollY; applyScroll(); scrollRAF = null; return; }
  scrollY += d * 0.35;
  applyScroll();
  scrollRAF = requestAnimationFrame(easeScroll);
}

function snapScroll() { // 立即吸附到目标位置(进画笔模式/初始化时,避免坐标错位)
  if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }
  scrollY = targetScrollY;
  applyScroll();
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
  if (item.type === 'note') notesLayer.appendChild(makeNote(item));
  else (item.type === 'hl' ? hlLayer : inkLayer).appendChild(makePath(item));
}

function renderAll() {
  inkLayer.innerHTML = ''; hlLayer.innerHTML = ''; notesLayer.innerHTML = '';
  items.forEach(renderItem);
  document.body.classList.toggle('has-items', items.length > 0);
}

function removeDom(id) {
  document.querySelectorAll(`[data-id="${id}"]`).forEach((el) => el.remove());
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
    item.size = s; div.style.fontSize = s + 'px';
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
    item.text = div.innerText.replace(/\n+$/, '');
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
  scrollY = 0; targetScrollY = 0;
  snapScroll();
  renderAll();
});

ipcRenderer.on('mode', (e, m) => {
  mode = m;
  document.body.className = m + (items.length ? ' has-items' : '') + (tool === 'note' ? ' tool-note' : '');
  if (m === 'view' && drawing) drawing = null;
  if (m === 'view') clearNoteSelection();
  if (m !== 'view') { clearTimeout(bindPendingTimer); clearTimeout(bindHideTimer); bindBadge.classList.remove('show'); }
  if (m === 'draw') {
    snapScroll(); // 进画笔模式先把缓动吸附到位,画笔坐标才不会错位
    requestAnimationFrame(() => placeInk(false)); // 工具条已显示,把高亮胶囊瞬间摆到当前工具下
  }
});

// 跟随滚动(绝对定位):主进程按 UIA 读到的真实滚动百分比给出目标位移,查看模式缓动平移过去。
// 绝对量而非累加增量 —— 自我校正、不漂移;读不到时主进程根本不发,标注保持钉在窗口上。
ipcRenderer.on('scroll-to', (e, y) => {
  if (mode !== 'view') return;
  targetScrollY = y;
  if (!scrollRAF) scrollRAF = requestAnimationFrame(easeScroll);
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
