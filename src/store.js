// 标注存档:按 "程序名|窗口标题" 存 JSON,窗口关了再开自动恢复
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'annotations.json');
let cache = null;

function loadAll() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function load(key) {
  return loadAll()[key] || [];
}

function save(key, items) {
  const all = loadAll();
  if (items && items.length) all[key] = items;
  else delete all[key];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 1), 'utf8');
}

module.exports = { load, save };
