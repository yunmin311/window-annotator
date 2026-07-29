// 轻量设置项(滚动灵敏度等),存 data/settings.json
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'settings.json');
let cache = null;

function all() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

function get(key, dflt) {
  const v = all()[key];
  return v === undefined ? dflt : v;
}

function set(key, value) {
  const c = all();
  c[key] = value;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(c, null, 1), 'utf8');
}

module.exports = { get, set };
