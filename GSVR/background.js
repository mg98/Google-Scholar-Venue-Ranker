/* background.js (MV3 service worker)
 * Routes DBLP / SPARQL requests through extension context to avoid CORS/opaque fetch failures
 * when running on Google Scholar pages.
 */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'GSVR_DOWNLOAD') {
    (async () => {
      try {
        const filename = String(message.filename || `gsvr-export-${Date.now()}.txt`);
        const hasDataUrl = typeof message.dataUrl === 'string' && /^data:/i.test(message.dataUrl);
        const mimeType = String(message.mimeType || 'text/plain;charset=utf-8');
        const content = String(message.content || '');
        const url = hasDataUrl ? message.dataUrl : `data:${mimeType},${encodeURIComponent(content)}`;
        const downloadId = await chrome.downloads.download({
          url,
          filename,
          saveAs: true
        });
        sendResponse({ ok: typeof downloadId === 'number', downloadId: downloadId ?? null });
      } catch (e) {
        sendResponse({
          ok: false,
          error: (e && e.message) ? String(e.message) : 'download failed'
        });
      }
    })();
    return true;
  }

  if (message.type !== 'GSVR_FETCH') return;

  const url = String(message.url || '');
  const init = message.init || undefined;
  const requestedTimeoutMs = Number.isFinite(Number(message.timeoutMs)) ? Number(message.timeoutMs) : 12000;
  const timeoutMs = Math.max(250, Math.min(requestedTimeoutMs, 30000));

  (async () => {
    let timeoutId = null;
    try {
      // Basic safety: only allow DBLP/SPARQL to be fetched via this proxy.
      if (!/^https:\/\/(dblp\.org|sparql\.dblp\.org)\b/i.test(url)) {
        sendResponse({ status: 400, statusText: 'Blocked by proxy (non-DBLP URL)', headers: {}, bodyText: '' });
        return;
      }

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, {
        ...(init || {}),
        signal: controller.signal
      });

      // Collect a small header set (cloneable)
      const headersObj = {};
      try {
        resp.headers.forEach((v, k) => { headersObj[k] = v; });
      } catch (_) {}

      const bodyText = await resp.text();
      sendResponse({
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        headers: headersObj,
        bodyText
      });
    } catch (e) {
      const isTimeout = e && e.name === 'AbortError';
      sendResponse({
        ok: false,
        status: isTimeout ? 504 : 599,
        statusText: isTimeout
          ? `timed out after ${timeoutMs}ms`
          : ((e && e.message) ? String(e.message) : 'fetch failed'),
        headers: {},
        bodyText: ''
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  })();

  // Keep the message channel open for async response
  return true;
});
