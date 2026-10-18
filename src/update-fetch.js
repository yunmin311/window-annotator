'use strict';
// Electron net.fetch currently leaves Response.url empty after redirects.
// Track the final URL explicitly for the body-free release lookup.
module.exports = function createUpdateFetch(net) {
  return (url, options) => {
    if (options.method !== 'HEAD') return net.fetch(url, options);
    return new Promise((resolve, reject) => {
      const request = net.request({ url, method: 'HEAD', redirect: 'follow' });
      let finalUrl = url;
      const abort = () => { request.abort(); reject(new Error('检查已取消')); };
      const cleanup = () => options.signal.removeEventListener('abort', abort);
      request.on('redirect', (_status, _method, target) => { finalUrl = target; });
      request.on('error', err => { cleanup(); reject(err); });
      request.on('response', response => {
        cleanup();
        response.on('error', () => {});
        response.resume();
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode, url: finalUrl });
      });
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) { abort(); return; }
      for (const [key, value] of Object.entries(options.headers || {})) request.setHeader(key, value);
      request.end();
    });
  };
};
