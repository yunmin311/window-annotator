'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const updates = require('../src/updates');
const release = (tag = 'v0.3.0') => ({ tag_name: tag, draft: false, prerelease: false,
  html_url: `https://github.com/yunmin311/window-annotator/releases/tag/${tag}` });

test('compares numeric versions, ignoring optional v prefix', () => {
  assert.equal(updates.compareVersions('v0.10.0', '0.2.1'), 1);
  assert.equal(updates.compareVersions('0.2.1', 'v0.2.1'), 0);
  assert.equal(updates.compareVersions('0.2.0', '0.2.1'), -1);
  assert.throws(() => updates.compareVersions('latest', '0.2.1'));
});

test('real HTTP responses cover available, current, error and timeout paths', async () => {
  let body = release(), status = 200, delay = 0;
  const server = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }, delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, opts) => {
    assert.equal(url, 'https://api.github.com/repos/yunmin311/window-annotator/releases/latest');
    assert.equal(opts.headers.Accept, 'application/vnd.github+json');
    return fetch(local, opts);
  };
  const check = () => updates.checkForUpdate({ currentVersion: '0.2.1', fetchImpl, timeoutMs: 80 });
  try {
    assert.deepEqual(await check(), { status: 'available', version: '0.3.0', url: release().html_url });
    body = release('v0.2.1'); assert.equal((await check()).status, 'current');
    body = release('v0.2.0'); assert.equal((await check()).status, 'current');
    body = { ...release(), prerelease: true }; assert.equal((await check()).status, 'current');
    body = { ...release(), html_url: 'https://evil.example/download' }; assert.equal((await check()).status, 'error');
    body = { ...release(), tag_name: 'latest' }; assert.equal((await check()).status, 'error');
    body = {}; assert.equal((await check()).status, 'error');
    body = release(); status = 403; assert.equal((await check()).status, 'error');
    status = 404; assert.equal((await check()).status, 'error');
    status = 200; delay = 200; assert.equal((await check()).status, 'error');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('API rate limit falls back to official latest release redirect', async () => {
  let apiStatus = 403, fallbackStatus = 200, tag = 'v0.3.0';
  const server = http.createServer((req, res) => {
    if (req.url === '/api') { res.writeHead(apiStatus); res.end('{}'); }
    else if (req.url === '/latest') { res.writeHead(302, {Location:`/tag/${tag}`}); res.end(); }
    else { res.writeHead(fallbackStatus); res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = async (url, options) => {
    const api = url.includes('api.github.com');
    const response = await fetch(base + (api ? '/api' : '/latest'), options);
    // The local fixture represents the official origin; transport and redirects stay real.
    return new Proxy(response, {get(target, key) {
      if (key === 'url' && !api) return `${updates.RELEASES}/tag/${tag}`;
      const value = Reflect.get(target,key,target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  };
  const check = () => updates.checkForUpdate({currentVersion:'0.2.1',fetchImpl});
  try {
    assert.deepEqual(await check(), {status:'available',version:'0.3.0',url:release().html_url});
    apiStatus=429; tag='v0.2.0'; assert.equal((await check()).status,'current');
    apiStatus=404; assert.equal((await check()).status,'current');
    tag='latest'; assert.equal((await check()).status,'error');
    tag='v0.3.0'; fallbackStatus=503; assert.equal((await check()).status,'error');
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

// A network implementation may ignore AbortSignal, including during body cleanup.
test('stalled fetch, body and cancellation all have a hard deadline', async () => {
  const pending = () => new Promise(() => {});
  for (const phase of ['fetch', 'body', 'cancel']) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (phase === 'fetch' || calls > 1) return pending();
      return {ok:true, status:200, body:{getReader:() => ({
        read:phase === 'body' ? pending : async () => ({done:true}),
        cancel:pending,
      })}};
    };
    const result = await Promise.race([
      updates.checkForUpdate({currentVersion:'0.2.1',fetchImpl,timeoutMs:30}),
      new Promise(resolve => setTimeout(() => resolve({status:'stuck'}),250)),
    ]);
    assert.equal(result.status,'error', `${phase} must finish even if abort is ignored`);
    assert.equal(calls,2, 'a stalled API must still try the release page');
  }
});
