// 标注画布:手绘风渲染 + 工具交互。坐标全部相对窗口左上角,覆盖层跟着窗口走,标注自然跟着走。
'use strict';
const { ipcRenderer } = require('electron');

const COLORS = {
  neutral: '#3d3d40', red: '#e5484d', amber: '#ee9d2b',
  green: '#2f9e63', blue: '#0e8fd8', purple: '#8e4ec6',
};

const svg = document.getElementById('canvas');
const inkLayer = document.getElementById('ink-layer');
const hlLayer = document.getElementById('hl-layer');
const notesLayer = document.getElementById('notes');
const toolbar = document.getElementById('toolbar');

let mode = 'view';        // view | draw
let tool = 'pen';         // pen | arrow | hl | note | eraser
let color = 'red';
let items = [];           // 所有标注对象(可序列化)
let undoStack = [];
let nextId = 1;

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
    p.setAttribute('d', smoothPath(item.points));
    p.setAttribute('stroke-width', 16);
  } else if (item.type === 'arrow') {
    p.setAttribute('d', arrowPath(item));
    p.setAttribute('stroke-width', 2.4);
  }
  return p;
}

function makeNote(item) {
  const div = document.createElement('div');
  div.className = 'note';
  div.dataset.id = item.id;
  div.style.left = item.x + 'px';
  div.style.top = item.y + 'px';
  div.style.color = COLORS[item.color] || item.color;
  div.style.transform = `rotate(${item.rot}deg)`;
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

function bindNote(div, item) {
  div.addEventListener('mousedown', (e) => {
    if (mode !== 'draw' || div.classList.contains('editing')) return;
    e.stopPropagation();
    if (tool === 'eraser') { deleteItem(item.id); return; }
    // 拖动
    const sx = e.clientX - item.x, sy = e.clientY - item.y;
    const move = (ev) => {
      item.x = ev.clientX - sx; item.y = ev.clientY - sy;
      div.style.left = item.x + 'px'; div.style.top = item.y + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  div.addEventListener('dblclick', (e) => {
    if (mode !== 'draw') return;
    e.stopPropagation();
    editNote(div, item);
  });
}

function editNote(div, item) {
  div.classList.add('editing');
  div.contentEditable = 'true';
  div.focus();
  document.execCommand('selectAll', false, null);
  const finish = () => {
    div.contentEditable = 'false';
    div.classList.remove('editing');
    item.text = div.innerText.replace(/\n+$/, '');
    if (!item.text.trim()) deleteItem(item.id);
    else save();
  };
  div.addEventListener('blur', finish, { once: true });
  div.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); div.blur(); }
  });
}

/* ---------- 画布交互 ---------- */

let drawing = null; // 进行中的笔画

svg.addEventListener('mousedown', (e) => {
  if (mode !== 'draw' || e.button !== 0) return;
  const x = e.clientX, y = e.clientY;

  if (tool === 'eraser') {
    const t = e.target.closest('[data-id]');
    if (t) deleteItem(t.dataset.id);
    drawing = { type: 'eraser' };
    return;
  }
  if (tool === 'note') {
    const item = { id: nextId++, type: 'note', color, x, y: y - 12, text: '', rot: (Math.random() * 5 - 2.5) };
    addItem(item);
    undoStack.pop(); // 空便签不占撤销位,blur 时若为空会自动删除
    const div = notesLayer.querySelector(`[data-id="${item.id}"]`);
    editNote(div, item);
    return;
  }
  if (tool === 'arrow') {
    drawing = { type: 'arrow', item: { id: nextId++, type: 'arrow', color, from: [x, y], to: [x, y], seed: (Math.random() * 1e9) | 0 } };
  } else {
    drawing = { type: tool, item: { id: nextId++, type: tool, color, points: [[x, y]] } };
  }
  drawing.el = makePath(drawing.item);
  (tool === 'hl' ? hlLayer : inkLayer).appendChild(drawing.el);
});

window.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  const x = e.clientX, y = e.clientY;
  if (drawing.type === 'eraser') {
    if (e.buttons & 1) {
      const t = document.elementFromPoint(x, y);
      const hit = t && t.closest && t.closest('[data-id]');
      if (hit) deleteItem(hit.dataset.id);
    }
    return;
  }
  if (drawing.type === 'arrow') {
    drawing.item.to = [x, y];
    drawing.el.setAttribute('d', arrowPath(drawing.item));
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
  if (d.type === 'arrow') {
    const [x1, y1] = d.item.from, [x2, y2] = d.item.to;
    if (Math.hypot(x2 - x1, y2 - y1) < 8) return; // 误触
  }
  addItem(d.item);
});

window.addEventListener('keydown', (e) => {
  if (mode !== 'draw') return;
  if (e.key === 'Escape') ipcRenderer.send('exit-draw');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undo();
});

/* ---------- 工具条 ---------- */

toolbar.querySelectorAll('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    tool = btn.dataset.tool;
    toolbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
  });
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
  renderAll();
});

ipcRenderer.on('mode', (e, m) => {
  mode = m;
  document.body.className = m + (items.length ? ' has-items' : '');
  if (m === 'view' && drawing) drawing = null;
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
