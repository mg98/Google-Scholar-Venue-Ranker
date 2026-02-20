/* background.js (MV3 service worker)
 * Routes DBLP / SPARQL requests through extension context to avoid CORS/opaque fetch failures
 * when running on Google Scholar pages.
 */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'GSVR_FETCH') return;

  const url = String(message.url || '');
  const init = message.init || undefined;

  (async () => {
    try {
      // Basic safety: only allow DBLP/SPARQL to be fetched via this proxy.
      if (!/^https:\/\/(dblp\.org|sparql\.dblp\.org)\b/i.test(url)) {
        sendResponse({ status: 400, statusText: 'Blocked by proxy (non-DBLP URL)', headers: {}, bodyText: '' });
        return;
      }

      const resp = await fetch(url, init);

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
      // Network errors end up here (e.g., DNS/connection)
      sendResponse({
        ok: false,
        status: 0,
        statusText: (e && e.message) ? String(e.message) : 'fetch failed',
        headers: {},
        bodyText: ''
      });
    }
  })();

  // Keep the message channel open for async response
  return true;
});
