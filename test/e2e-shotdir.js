// 截图保存位置 e2e(主进程):启动真实主进程,验证 shotsDir() 的「默认 / 自定义设置 / 清空回退」,
// 并确认设置能落盘。不动真实用户设置(跑前快照、跑完还原)。用法: electron test/e2e-shotdir.js
'use strict';
process.env.WA_TEST = '1';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const main = require('../main.js');
const settings = require('../src/settings');

const OUT = process.env.E2E_OUT || __dirname;
const RESULT = path.join(OUT, 'shotdir-result.txt');
try { fs.writeFileSync(RESULT, 'shotdir start\n'); } catch {}
const logf = (s) => { try { fs.appendFileSync(RESULT, s + '\n'); } catch {} console.log(s); };
setTimeout(() => { logf('TIMEOUT'); app.exit(2); }, 20000);

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');
function restoreShotsSetting(orig) {
  // orig===null 表示原本没设过:把 key 删掉,别留下残迹;否则原样写回
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  if (orig === null) delete obj.shotsDir; else obj.shotsDir = orig;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 1), 'utf8');
}

app.whenReady().then(async () => {
  let fails = 0;
  const check = (n, ok) => { logf((ok ? 'PASS' : 'FAIL') + ' - ' + n); if (!ok) fails++; };
  const orig = settings.get('shotsDir', null);

  const def = main.shotsDir();
  check('默认落在「图片\\Window Annotator」(' + def + ')', /[\\/]Window Annotator$/.test(def));

  const tmp = path.join(os.tmpdir(), 'WA-shotdir-test');
  settings.set('shotsDir', tmp);
  check('设了自定义目录后 shotsDir() 返回它', main.shotsDir() === tmp);

  // 落盘确认:重新读文件,自定义目录确实写进了 settings.json
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  check('自定义目录已落盘 settings.json', onDisk.shotsDir === tmp);

  settings.set('shotsDir', '');
  check('清空后回退到默认目录', main.shotsDir() === def);

  settings.set('shotsDir', '   ');
  check('只有空白也算没设,仍回退默认', main.shotsDir() === def);

  restoreShotsSetting(orig);   // 还原用户原设置,别污染
  logf(fails === 0 ? 'ALL PASS' : fails + ' FAILED');
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { logf('ERR ' + ((e && e.stack) || e)); app.exit(3); });
