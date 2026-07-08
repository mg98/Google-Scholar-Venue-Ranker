"use strict";
/*
 * rankings_worker.js — GSVR matching worker.
 *
 * Hosts the production matcher (content.js) OFF the page's main thread. The
 * ~15 MB venue index (data/rankings-index.json) is fetched, parsed, and indexed
 * here, and every venue-string lookup runs here too, so those structures never
 * cross to the main thread. The main thread only ships small
 * { venue, title, year } tuples in and receives compact ranking decisions back.
 *
 * content.js is the single source of truth for matching logic (it is exercised
 * in-process by match_cli.js and the Node accuracy benchmark). This worker loads
 * that exact file with a set of headless shims — the same approach match_cli.js
 * uses in a Node vm — and calls the already-exposed
 * self.GSVRProductionMatcher.pickVenueRanking().
 *
 * If this worker cannot be created or loaded in some browser/CSP configuration,
 * content.js falls back to running the identical matcher in-process, so results
 * are never affected — only where the work runs.
 */

// ---- Headless environment shims, established before content.js is imported ----

// content.js reads its helper modules off `window` (e.g. window.GSVRUtils).
self.window = self;
// Skip content.js's page bootstrap (DOM observers, chrome listeners, auto-scan).
self.GSVR_DISABLE_AUTO_INIT = true;
// content.js's loadRankingsData() is already neutralized from spawning a nested
// data worker, but make doubly sure nothing here tries to create one.
self.Worker = undefined;

let gsvrBaseUrl = '';
let gsvrIndexUrl = 'data/rankings-index.json';

// Minimal chrome shim: the matcher only needs runtime.getURL to locate the
// bundled rankings index; storage/sendMessage are no-ops it never reaches here.
self.chrome = {
  runtime: {
    getURL(relativePath) {
      const rel = String(relativePath || '');
      if (/(^|\/)data\/rankings-index\.json$/.test(rel) && gsvrIndexUrl) {
        return gsvrIndexUrl;
      }
      return gsvrBaseUrl ? gsvrBaseUrl + rel.replace(/^\//, '') : rel;
    },
    sendMessage() { return undefined; },
    onMessage: { addListener() {} },
    lastError: null,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener() {} },
  },
};

// DOM-ish stubs. content.js only references these inside UI functions this
// worker never calls; deliberately no `document`, so the debug-bridge install is
// a no-op (installPageWorldDebugBridge early-returns without document).
self.MutationObserver = class { observe() {} disconnect() {} };
self.HTMLElement = class {};
self.HTMLAnchorElement = class {};
self.Node = class {};

// ---- Lazy load of the shared matcher modules + content.js ----
// Deferred to the first message so we know the absolute extension base URL,
// which lets importScripts work whether this worker runs from an extension-URL
// origin or a blob: origin (see content.js createRankingsWorkerInstance).
let matcherLoaded = false;
let matcherLoadError = null;

function loadMatcherOnce() {
  if (matcherLoaded || matcherLoadError) return;
  try {
    const base = gsvrBaseUrl || '';
    importScripts(
      base + 'core/text_normalize.js',
      base + 'venue_data.js',
      base + 'rank_core.js',
      base + 'settings.js',
      base + 'content.js'
    );
    if (!self.GSVRProductionMatcher || typeof self.GSVRProductionMatcher.pickVenueRanking !== 'function') {
      throw new Error('GSVRProductionMatcher.pickVenueRanking not available after import');
    }
    matcherLoaded = true;
  } catch (error) {
    matcherLoadError = error;
    throw error;
  }
}

function getMatcher() {
  loadMatcherOnce();
  return self.GSVRProductionMatcher;
}

async function ensureDatasetLoaded() {
  const matcher = getMatcher();
  if (typeof matcher.loadRankingsData !== 'function') {
    throw new Error('GSVRProductionMatcher.loadRankingsData not available');
  }
  await matcher.loadRankingsData();
}

async function rankItems(items) {
  const matcher = getMatcher();
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {};
    const venue = String(item.venue || '').trim();
    if (!venue) {
      out[i] = null;
      continue;
    }
    const year = Number.isFinite(item.year) ? item.year : (item.year == null ? null : Number(item.year));
    try {
      out[i] = await matcher.pickVenueRanking(venue, item.title || '', Number.isFinite(year) ? year : null);
    } catch (error) {
      // Mirror the in-process path, which treats a matcher throw as "no decision".
      out[i] = null;
    }
  }
  return out;
}

self.onmessage = async (event) => {
  const message = event && event.data ? event.data : {};
  const requestId = message.requestId;
  if (typeof message.baseUrl === 'string') gsvrBaseUrl = message.baseUrl;
  if (typeof message.indexUrl === 'string') gsvrIndexUrl = message.indexUrl;

  try {
    if (message.type === 'warm') {
      await ensureDatasetLoaded();
      self.postMessage({ requestId, ok: true });
      return;
    }
    if (message.type === 'rankBatch') {
      await ensureDatasetLoaded();
      const decisions = await rankItems(message.items);
      self.postMessage({ requestId, ok: true, decisions });
      return;
    }
    self.postMessage({ requestId, ok: false, error: `Unknown worker message type: ${message.type}` });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: (error && error.message) || String(error) });
  }
};
