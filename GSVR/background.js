/* background.js (MV3 service worker)
 * Shared DBLP / SPARQL fetch coordinator.
 * Keeps DBLP traffic global across tabs, dedupes identical requests, applies a small
 * concurrency cap, and distinguishes "busy" from "unavailable" failures.
 */
'use strict';

try {
  importScripts('dblp/dblp_scheduler.js');
} catch (error) {
  console.warn('GSVR: Failed to load DBLP scheduler module; falling back to legacy queue.', error);
}

const DBLP_SCHEDULER_API = (typeof self !== 'undefined' && self.GSVRDblpScheduler) ? self.GSVRDblpScheduler : null;
const DBLP_REQUEST_POLICY = DBLP_SCHEDULER_API?.DEFAULT_DBLP_REQUEST_POLICY || {
  maxConcurrent: 1,
  minDelayMs: 1200,
  jitterMs: [200, 800],
  maxRetries: 2,
  retryBackoffMs: [5000, 15000],
  respectRetryAfter: true,
  globalCooldownStorageKey: 'gsvr_dblp_cooldown_v1',
};
const dblpScheduler = DBLP_SCHEDULER_API?.createDblpScheduler
  ? DBLP_SCHEDULER_API.createDblpScheduler({
      fetch: globalThis.fetch.bind(globalThis),
      storageArea: chrome?.storage?.local,
      policy: DBLP_REQUEST_POLICY,
    })
  : null;

const DBLP_URL_RX = /^https:\/\/(dblp\.org|sparql\.dblp\.org)\b/i;
const DBLP_MAX_IN_FLIGHT = DBLP_REQUEST_POLICY.maxConcurrent || 1;
const DBLP_DEFAULT_COOLDOWN_MS = DBLP_REQUEST_POLICY.minDelayMs || 1200;
const DBLP_MAX_COOLDOWN_MS = 30000;
const DBLP_OUTAGE_WINDOW_MS = 60000;
const DBLP_OUTAGE_FAILURE_THRESHOLD = 3;
const REQUEST_PRIORITY = Object.freeze({
  author_search: 0,
  profile_verify_sparql: 0,
  author_xml: 0,
  stream_fast: 1,
  stream_depth: 2,
});

let dblpInFlightCount = 0;
let dblpCooldownUntil = 0;
let queuedPumpTimeout = null;
const dblpQueue = [];
const pendingRequestGroups = new Map();
const dblpRecentServerFailures = [];

function parseRetryAfterMs(headers, maxDelay = DBLP_MAX_COOLDOWN_MS) {
  const retryAfter = headers?.get?.('retry-after');
  if (!retryAfter) {
    return null;
  }
  const retrySeconds = Number(retryAfter);
  if (Number.isFinite(retrySeconds) && retrySeconds >= 0) {
    return Math.min(maxDelay, retrySeconds * 1000);
  }
  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.min(maxDelay, Math.max(0, retryAt - Date.now()));
  }
  return null;
}

function cloneHeaders(responseHeaders) {
  const headersObj = {};
  try {
    responseHeaders.forEach((value, key) => {
      headersObj[key] = value;
    });
  } catch (_) {
    // Ignore header iteration issues.
  }
  return headersObj;
}

function getPriority(requestClass) {
  return REQUEST_PRIORITY[String(requestClass || '').trim()] ?? 1;
}

function pruneRecentServerFailures(now = Date.now()) {
  while (dblpRecentServerFailures.length && (now - dblpRecentServerFailures[0]) > DBLP_OUTAGE_WINDOW_MS) {
    dblpRecentServerFailures.shift();
  }
}

function noteServerFailure(now = Date.now()) {
  dblpRecentServerFailures.push(now);
  pruneRecentServerFailures(now);
}

function noteServerSuccess() {
  dblpRecentServerFailures.length = 0;
}

function inferFailureKind(status) {
  const numericStatus = Number(status);
  if (numericStatus === 429) {
    return 'rate_limited';
  }
  if (numericStatus === 504 || numericStatus === 599 || numericStatus === 408) {
    return 'busy';
  }
  if ([500, 502, 503].includes(numericStatus)) {
    noteServerFailure();
    return dblpRecentServerFailures.length >= DBLP_OUTAGE_FAILURE_THRESHOLD ? 'unavailable' : 'busy';
  }
  return null;
}

function buildResponsePayload({ ok = false, status, statusText = '', headers = {}, bodyText = '', meta = null }) {
  return {
    ok,
    status,
    statusText,
    headers,
    bodyText,
    meta: meta && typeof meta === 'object' ? meta : null,
  };
}

function flushGroup(group, payload) {
  pendingRequestGroups.delete(group.key);
  for (const responder of group.responders) {
    try {
      responder(payload);
    } catch (_) {
      // Ignore responder failures.
    }
  }
}

function scheduleQueuePump(delayMs = 0) {
  if (queuedPumpTimeout) {
    clearTimeout(queuedPumpTimeout);
    queuedPumpTimeout = null;
  }
  queuedPumpTimeout = setTimeout(() => {
    queuedPumpTimeout = null;
    pumpQueue();
  }, Math.max(0, Number(delayMs) || 0));
}

function enqueueGroup(group) {
  const priority = getPriority(group.requestClass);
  let insertIndex = dblpQueue.length;
  for (let index = 0; index < dblpQueue.length; index += 1) {
    const existing = dblpQueue[index];
    if (getPriority(existing.requestClass) > priority) {
      insertIndex = index;
      break;
    }
  }
  dblpQueue.splice(insertIndex, 0, group);
}

async function dispatchGroup(group) {
  dblpInFlightCount += 1;
  let timeoutId = null;
  try {
    const requestedTimeoutMs = Number.isFinite(Number(group.timeoutMs)) ? Number(group.timeoutMs) : 12000;
    const timeoutMs = Math.max(250, Math.min(requestedTimeoutMs, 30000));
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(group.url, {
      ...(group.init || {}),
      signal: controller.signal,
    });
    const retryAfterMs = parseRetryAfterMs(response.headers);
    if (response.ok) {
      noteServerSuccess();
    }
    const failureKind = response.ok ? null : inferFailureKind(response.status);
    if (response.status === 429) {
      dblpCooldownUntil = Math.max(
        dblpCooldownUntil,
        Date.now() + Math.max(retryAfterMs ?? 0, DBLP_DEFAULT_COOLDOWN_MS)
      );
    }
    const payload = buildResponsePayload({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: cloneHeaders(response.headers),
      bodyText: await response.text(),
      meta: {
        failureKind,
        retryAfterMs: retryAfterMs ?? null,
        queuedMs: Date.now() - group.enqueuedAt,
      },
    });
    flushGroup(group, payload);
  } catch (error) {
    const isTimeout = error && error.name === 'AbortError';
    const payload = buildResponsePayload({
      ok: false,
      status: isTimeout ? 504 : 599,
      statusText: isTimeout
        ? `timed out after ${group.timeoutMs || 12000}ms`
        : ((error && error.message) ? String(error.message) : 'fetch failed'),
      headers: {},
      bodyText: '',
      meta: {
        failureKind: 'busy',
        retryAfterMs: Math.max(0, dblpCooldownUntil - Date.now()) || null,
        queuedMs: Date.now() - group.enqueuedAt,
      },
    });
    flushGroup(group, payload);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    dblpInFlightCount = Math.max(0, dblpInFlightCount - 1);
    pumpQueue();
  }
}

function pumpQueue() {
  if (!dblpQueue.length) {
    return;
  }
  const now = Date.now();
  pruneRecentServerFailures(now);
  if (now < dblpCooldownUntil) {
    scheduleQueuePump(dblpCooldownUntil - now);
    return;
  }
  while (dblpInFlightCount < DBLP_MAX_IN_FLIGHT && dblpQueue.length > 0) {
    const group = dblpQueue.shift();
    if (!group || !pendingRequestGroups.has(group.key)) {
      continue;
    }
    const waitedMs = Date.now() - group.enqueuedAt;
    if (Number.isFinite(group.waitBudgetMs) && group.waitBudgetMs > 0 && waitedMs > group.waitBudgetMs) {
      flushGroup(group, buildResponsePayload({
        ok: false,
        status: 599,
        statusText: 'DBLP fetch budget exhausted while waiting in queue',
        headers: {},
        bodyText: '',
        meta: {
          failureKind: group.allowDefer ? 'deferred' : 'busy',
          retryAfterMs: Math.max(0, dblpCooldownUntil - Date.now()) || null,
          queuedMs: waitedMs,
        },
      }));
      continue;
    }
    dispatchGroup(group);
  }
}

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
  if (!DBLP_URL_RX.test(url)) {
    sendResponse(buildResponsePayload({
      ok: false,
      status: 400,
      statusText: 'Blocked by proxy (non-DBLP URL)',
      headers: {},
      bodyText: '',
      meta: { failureKind: null, retryAfterMs: null, queuedMs: 0 },
    }));
    return false;
  }

  const dedupeKey = String(
    message.dedupeKey
    || `${String(message.init?.method || 'GET').toUpperCase()}:${url}:${typeof message.init?.body === 'string' ? message.init.body : ''}`
  );

  if (dblpScheduler) {
    dblpScheduler.schedule({
      url,
      init: message.init || undefined,
      timeoutMs: message.timeoutMs,
      requestClass: message.requestClass || null,
      waitBudgetMs: Number.isFinite(Number(message.waitBudgetMs)) ? Number(message.waitBudgetMs) : null,
      allowDefer: message.allowDefer === true,
      dedupeKey,
    }).then((payload) => {
      sendResponse(payload);
    }).catch((error) => {
      sendResponse(buildResponsePayload({
        ok: false,
        status: 599,
        statusText: (error && error.message) ? String(error.message) : 'DBLP scheduler failed',
        headers: {},
        bodyText: '',
        meta: { failureKind: 'busy', retryAfterMs: null, queuedMs: 0 },
      }));
    });
    return true;
  }

  const existing = pendingRequestGroups.get(dedupeKey);
  if (existing) {
    existing.responders.push(sendResponse);
    return true;
  }

  const group = {
    key: dedupeKey,
    url,
    init: message.init || undefined,
    timeoutMs: message.timeoutMs,
    requestClass: message.requestClass || null,
    waitBudgetMs: Number.isFinite(Number(message.waitBudgetMs)) ? Number(message.waitBudgetMs) : null,
    allowDefer: message.allowDefer === true,
    enqueuedAt: Date.now(),
    responders: [sendResponse],
  };
  pendingRequestGroups.set(group.key, group);
  enqueueGroup(group);
  pumpQueue();
  return true;
});
