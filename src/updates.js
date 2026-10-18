// Source releases currently have no installer: check GitHub, then offer the official release page.
'use strict';
const RELEASES = 'https://github.com/yunmin311/window-annotator/releases';
const API = 'https://api.github.com/repos/yunmin311/window-annotator/releases/latest';
function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error('版本号格式无效');
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('版本号过大');
  return parts;
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
async function checkApi({ currentVersion, fetchImpl, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(API, { signal: controller.signal, headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'Window-Annotator',
    } });
    if (response.status === 404) throw new Error('更新接口未找到正式版本');
    if (response.status === 403 || response.status === 429) throw new Error('更新服务暂时拒绝请求，可能已达到访问次数限制。请稍后重试，或打开官方发布页查看。');
    if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
    const reader = response.body.getReader();
    let text = '', bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 256 * 1024) throw new Error('更新信息过大');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    const release = JSON.parse(text);
    const newer = compareVersions(release.tag_name, currentVersion) > 0;
    if (release.draft || release.prerelease || !newer) return { status: 'current' };
    const expected = `${RELEASES}/tag/${encodeURIComponent(release.tag_name)}`;
    if (release.html_url !== expected) throw new Error('更新链接无效');
    return { status: 'available', version: release.tag_name.replace(/^v/, ''), url: expected };
  } catch (err) {
    return { status: 'error', error: controller.signal.aborted ? '连接超时，请稍后重试' : String(err.message || err) };
  } finally { clearTimeout(timer); }
}
// GitHub's anonymous API quota is shared by users behind the same network/proxy.
// The official /latest redirect is independent of that quota and excludes prereleases.
async function checkForUpdate(options) {
  const apiResult = await checkApi(options);
  if (apiResult.status !== 'error') return apiResult;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const response = await options.fetchImpl(`${RELEASES}/latest`, {
      method: 'HEAD', redirect: 'follow', signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': 'Window-Annotator' },
    });
    if (!response.ok) throw new Error(`官方发布页返回 ${response.status}`);
    const match = /^https:\/\/github\.com\/yunmin311\/window-annotator\/releases\/tag\/(v?\d+\.\d+\.\d+)$/.exec(response.url);
    if (!match) throw new Error('无法从官方发布页确认版本号');
    if (compareVersions(match[1], options.currentVersion) <= 0) return { status: 'current' };
    return { status: 'available', version: match[1].replace(/^v/, ''), url: response.url };
  } catch (err) {
    const fallbackError = controller.signal.aborted ? '连接超时，请稍后重试' : String(err.message || err);
    return { status: 'error', error: `${apiResult.error}；备用检查失败：${fallbackError}` };
  } finally { clearTimeout(timer); }
}
module.exports = { compareVersions, checkForUpdate, RELEASES };
