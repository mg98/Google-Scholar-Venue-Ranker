"use strict";
// scholar-ranker/content.ts
// --- NEW: Custom Error for specific DBLP API failures ---
class DblpRateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DblpRateLimitError';
    }
}
class DblpUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DblpUnavailableError';
    }
}

// --- START: MV3 background fetch proxy to avoid CORS/opaque failures on DBLP/SPARQL ---
/**
 * Fetch wrapper that routes DBLP/SPARQL requests through the MV3 service worker (background.js)
 * to avoid CORS/opaque failures from a Google Scholar page context.
 */
async function gsvrFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
    const isDblp = /^https:\/\/(dblp\.org|sparql\.dblp\.org)\b/i.test(url);

    // Non-DBLP requests behave exactly like normal fetch.
    if (!isDblp) {
        return globalThis.fetch(input, init);
    }

    // If runtime messaging isn't available, fall back to direct fetch.
    if (!chrome?.runtime?.sendMessage) {
        return globalThis.fetch(input, init);
    }

    // Serialize RequestInit safely for message passing.
    const safeInit = init ? {
        method: init.method,
        headers: init.headers,
        body: init.body,
        credentials: init.credentials,
        cache: init.cache,
        redirect: init.redirect,
        referrer: init.referrer,
        referrerPolicy: init.referrerPolicy,
        integrity: init.integrity,
        keepalive: init.keepalive,
        mode: init.mode,
        priority: init.priority,
        signal: undefined, // signals can't be cloned; service worker has its own timeout logic
    } : undefined;

    try {
        const result = await chrome.runtime.sendMessage({
            type: 'GSVR_FETCH',
            url,
            init: safeInit,
        });

        if (result && (typeof result.status === 'number')) {
            const headers = new Headers(result.headers || {});
            // Build a real Response so existing code can call .json()/.text() unchanged.
            return new Response(result.bodyText ?? '', {
                status: result.status,
                statusText: result.statusText ?? '',
                headers,
            });
        }

        // If background failed unexpectedly, fall back to direct fetch once.
        return globalThis.fetch(input, init);
    }
    catch (e) {
        // Fall back to direct fetch; caller will handle the error.
        return globalThis.fetch(input, init);
    }
}
// --- END: MV3 background fetch proxy ---

function createEmptyCoreRankCounts() {
    return { 'A*': 0, 'A': 0, 'B': 0, 'C': 0, 'N/A': 0 };
}
function createEmptySjrRankCounts() {
    return { 'Q1': 0, 'Q2': 0, 'Q3': 0, 'Q4': 0, 'N/A': 0 };
}
/** array → map */
function packRanks(arr) {
    const obj = {};
    for (const { url, rank, system, reason, matchConfidence, matchedVenue, venueMatchConfidence, dblpVenue, sourceYear, sourceYearFallback, decisionVersion, decisionStatus, confidence, matchedKey, matchedSourceId, decisionEvidence } of arr) {
        obj[url] = {
            rank,
            system,
            reason: reason ?? null,
            matchConfidence: (typeof matchConfidence === 'number' ? matchConfidence : null),
            matchedVenue: matchedVenue ?? null,
            venueMatchConfidence: (typeof venueMatchConfidence === 'number' ? venueMatchConfidence : null),
            dblpVenue: dblpVenue ?? null,
            sourceYear: (typeof sourceYear === 'number' ? sourceYear : null),
            sourceYearFallback: sourceYearFallback === true,
            decisionVersion: (typeof decisionVersion === 'number' ? decisionVersion : null),
            decisionStatus: decisionStatus ?? null,
            confidence: (typeof confidence === 'number' ? confidence : null),
            matchedKey: matchedKey ?? null,
            matchedSourceId: matchedSourceId ?? null,
            decisionEvidence: Array.isArray(decisionEvidence) ? decisionEvidence.slice(0, 12) : null
        };
    }
    return obj;
}
/** map → array (titleText stays empty – it is never used after load) */
function unpackRanks(map) {
    return Object.entries(map).map(([url, entry]) => ({
        url,
        rank: entry.rank,
        system: entry.system ?? 'UNKNOWN',
        reason: entry.reason ?? null,
        matchConfidence: (typeof entry.matchConfidence === 'number' ? entry.matchConfidence : null),
        matchedVenue: entry.matchedVenue ?? null,
        venueMatchConfidence: (typeof entry.venueMatchConfidence === 'number' ? entry.venueMatchConfidence : null),
        dblpVenue: entry.dblpVenue ?? null,
        sourceYear: (typeof entry.sourceYear === 'number' ? entry.sourceYear : null),
        sourceYearFallback: entry.sourceYearFallback === true,
        decisionVersion: (typeof entry.decisionVersion === 'number' ? entry.decisionVersion : null),
        decisionStatus: entry.decisionStatus ?? null,
        confidence: (typeof entry.confidence === 'number' ? entry.confidence : null),
        matchedKey: entry.matchedKey ?? null,
        matchedSourceId: entry.matchedSourceId ?? null,
        decisionEvidence: Array.isArray(entry.decisionEvidence) ? entry.decisionEvidence : null,
        titleText: ""
    }));
}
const VALID_RANKS = ["A*", "A", "B", "C"]; // Added string[] type
const SJR_QUARTILES = ["Q1", "Q2", "Q3", "Q4"];
const IGNORE_KEYWORDS = [
    "workshop", "transactions", "poster", "demo", "abstract",
    "extended abstract", "doctoral consortium", "doctoral symposium", "adjunct", "technical report",
    "tech report", "industry track", "tutorial notes", "working notes"
];
const ARXIV_PLAIN_KEYWORDS = [
    " arxiv ",
    " corr ",
    " computing research repository ",
    " arxiv preprint ",
    " arxiv e print ",
    " arxiv e prints "
];
const ARXIV_NORMALIZED_VALUES = new Set([
    "arxiv",
    "arxiv preprint",
    "arxiv e print",
    "arxiv e prints",
    "computing research repository",
    "corr"
]);

// Workshops should not inherit the parent conference rank unless explicitly enabled.
const INHERIT_PARENT_CONFERENCE_RANK_FOR_WORKSHOPS = false;
const STATUS_ELEMENT_ID = 'scholar-ranker-status-progress';
const SUMMARY_PANEL_ID = 'scholar-ranker-summary';
const BADGE_POPOVER_ID = 'gsr-badge-popover';
// "Null" state for Scholar entries that cannot be verified against the matched DBLP profile.
const DBLP_ENTRY_MISSING_LABEL = 'DBLP Entry Missing';
const DBLP_ENTRY_MISSING_TOOLTIP = 'This paper is not indexed in the matched DBLP profile.';
const RANKING_UTILS = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
const RANKING_CONFIG = RANKING_UTILS?.RANKING_CONFIG ?? {
    profileNameSimilarityThreshold: 0.72,
    profileMinOverlapCount: 2,
    profileMatchScoreThreshold: 3.6,
    profileStrongScoreThreshold: 5.4,
    profileAmbiguityGap: 0.45,
    publicationSimilarityThreshold: 0.88,
    publicationStrongSimilarityThreshold: 0.94,
    publicationMaxYearDiff: 2,
    publicationStrongYearDiff: 4,
    publicationAmbiguityGap: 0.018,
    coreFuzzyThreshold: 0.92,
    coreAmbiguityGap: 0.02,
    sjrFuzzyThreshold: 0.92,
    sjrAmbiguityGap: 0.015
};
const DECISION_VERSION = RANKING_UTILS?.DECISION_VERSION ?? 2;
const DECISION_STATUS = RANKING_UTILS?.DECISION_STATUS ?? {
    MATCHED: 'matched',
    UNRANKED: 'unranked',
    AMBIGUOUS: 'ambiguous',
    MISSING: 'missing'
};
// Cache schema bumped for v1.9.0 (ranking decision pipeline metadata).
const CACHE_VERSION = 9;
const CACHE_PREFIX = `scholarRanker_profile_v${CACHE_VERSION}_`;
const CACHE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 7 days
const DBLP_CACHE_DURATION_MS = Number.POSITIVE_INFINITY; // never expires
console.log("Google Scholar Ranker: Content script loaded (v1.9.0 - precision ranking pipeline).");

// --- Strict DBLP-only UI labels ---
const DBLP_MISSING_BADGE_LABEL = 'DBLP Entry Missing';
const DBLP_MISSING_BADGE_TOOLTIP = 'This paper is not indexed in the matched DBLP profile.';
const SETTINGS_API = (typeof window !== 'undefined' && window.GSVRSettings) ? window.GSVRSettings : null;
const DEFAULT_SETTINGS = SETTINGS_API?.DEFAULT_SETTINGS ?? {
    autoRun: true,
    compactMode: false,
    showUnranked: true,
    defaultHighlightMode: 'none',
    showDebugDetails: true
};
const coreDataCache = {};
let isMainProcessing = false;
let activeCachedPublicationRanks = null;
let publicationTableObserver = null;
let rankMapForObserver = null; // Maps URL to rank & system
let currentSettings = { ...DEFAULT_SETTINGS };
let activeSummaryFilter = null;
let previewSummaryFilter = null;
let gsrBadgePopoverEl = null;
let gsrBadgePopoverHideTimeout = null;
let gsrSearchOverlayEl = null;
let gsrAboutOverlayEl = null;
let gsrVenueDatalistPopulated = false;
let gsrDialogLastFocusedEl = null;
// --- START: DBLP Constants & Globals (UPDATED with new logic) ---
const DBLP_API_AUTHOR_SEARCH_URL = "https://dblp.org/search/author/api";
const DBLP_API_PERSON_PUBS_URL_PREFIX = "https://dblp.org/pid/";
const DBLP_SPARQL_ENDPOINT = "https://sparql.dblp.org/sparql";
const DBLP_HEURISTIC_MIN_OVERLAP_COUNT = RANKING_CONFIG.profileMinOverlapCount;
const DBLP_MAX_HUB_VARIANTS_TO_CHECK = 275; // New constant
const HEURISTIC_SCORE_THRESHOLD = RANKING_CONFIG.profileMatchScoreThreshold;
const HEURISTIC_MIN_NAME_SIMILARITY = RANKING_CONFIG.profileNameSimilarityThreshold;
// ---
let dblpPubsForCurrentUser = [];
let scholarUrlToDblpVenueMap = new Map();
let scholarUrlToDblpInfoMap = new Map();
/** --------  STREAM-XML memo cache  -------- */
const streamMetaCache = new Map();
const coreAliasIndexCache = {};
function parseYearFromText(value) {
    if (!value)
        return null;
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
}
function normalizeIssnValue(value) {
    return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase() || null;
}
function normalizeIssnList(values) {
    const list = Array.isArray(values) ? values : String(values || '').split(/[;,]/);
    const out = [];
    const seen = new Set();
    for (const value of list) {
        const normalized = normalizeIssnValue(value);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
function createDecisionMeta(base = {}) {
    return {
        decisionVersion: DECISION_VERSION,
        decisionStatus: base.decisionStatus ?? DECISION_STATUS.MISSING,
        confidence: (typeof base.confidence === 'number' ? base.confidence : null),
        matchedKey: base.matchedKey ?? null,
        matchedSourceId: base.matchedSourceId ?? null,
        sourceYearFallback: base.sourceYearFallback === true,
        decisionEvidence: Array.isArray(base.decisionEvidence) ? base.decisionEvidence : null
    };
}
function mergeDecisionMeta(target, patch) {
    const next = createDecisionMeta({ ...target, ...patch });
    return next;
}
function extractStreamRef(node) {
    const rawId = node.getAttribute("id")?.trim();
    if (!rawId)
        return null;
    const match = rawId.match(/^streams\/(conf|journals)\/([^/]+)$/);
    if (!match)
        return null;
    const [, streamType, streamId] = match;
    const sinceYear = parseYearFromText(node.getAttribute("label")?.trim());
    return {
        streamType: streamType,
        streamId,
        sinceYear,
    };
}
async function fetchDblpStreamMetadata(streamType, streamId) {
    const cacheKey = `${streamType}:${streamId}`;
    if (!streamMetaCache.has(cacheKey)) {
        streamMetaCache.set(cacheKey, (async () => {
            const streamXmlUrl = `https://dblp.org/streams/${streamType}/${streamId}.xml`;
            try {
                const resp = await gsvrFetch(streamXmlUrl);
                if (resp.ok) {
                    const xml = await resp.text();
                    const doc = new DOMParser().parseFromString(xml, "application/xml");
                    if (!doc.querySelector("parsererror")) {
                        const nodeSelector = streamType === "conf" ? "dblpstreams > conf" : "dblpstreams > journal";
                        const node = doc.querySelector(nodeSelector);
                        if (node) {
                            const rawTitle = node.querySelector("title")?.textContent ?? "";
                            const title = rawTitle ? rawTitle.replace(/\s+/g, " ").trim() : null;
                            const acronymNodeName = streamType === "conf" ? "acronym" : "short";
                            const acronym = node.querySelector(acronymNodeName)?.textContent?.trim() ?? null;
                            const shortTitle = streamType === "journals"
                                ? node.querySelector("short")?.textContent?.trim() ?? null
                                : null;
                            const issns = normalizeIssnList(Array.from(node.querySelectorAll("issn")).map(n => n.textContent || ""));
                            const discontinuedYear = parseYearFromText(node.querySelector("disc")?.textContent?.trim());
                            const successorRefs = Array.from(node.querySelectorAll("successor"))
                                .map(extractStreamRef)
                                .filter((ref) => Boolean(ref));
                            if (title || acronym || shortTitle || issns.length || successorRefs.length || discontinuedYear !== null) {
                                return {
                                    streamType,
                                    streamId,
                                    acronym,
                                    title,
                                    shortTitle,
                                    issns,
                                    discontinuedYear,
                                    successorRefs,
                                };
                            }
                        }
                    }
                }
            }
            catch {
                // ignore and fall back below
            }
            if (streamType === "journals") {
                try {
                    const indexUrl = `https://dblp.org/db/journals/${streamId}/index.xml`;
                    const indexResp = await gsvrFetch(indexUrl);
                    if (indexResp.ok) {
                        const indexXml = await indexResp.text();
                        const indexDoc = new DOMParser().parseFromString(indexXml, "application/xml");
                        if (!indexDoc.querySelector("parsererror")) {
                            const titleAttr = indexDoc.querySelector("bht")?.getAttribute("title")?.trim();
                            const h1Title = indexDoc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
                            const title = titleAttr || h1Title || null;
                            const shortTitle = indexDoc.querySelector("short")?.textContent?.trim() || null;
                            const issns = normalizeIssnList(Array.from(indexDoc.querySelectorAll("issn")).map(n => n.textContent || ""));
                            if (title) {
                                return {
                                    streamType,
                                    streamId,
                                    acronym: null,
                                    title,
                                    shortTitle,
                                    issns,
                                    discontinuedYear: null,
                                    successorRefs: [],
                                };
                            }
                        }
                    }
                }
                catch {
                    // ignore and fall back to null
                }

                // Final fallback: fetch the HTML journal index page and extract its header.
                // This helps for stream IDs where streams/*.xml or index.xml parsing fails.
                try {
                    const htmlUrls = [
                        `https://dblp.org/db/journals/${streamId}/`,
                        `https://dblp.org/db/journals/${streamId}/index.html`,
                    ];
                    for (const htmlUrl of htmlUrls) {
                        const htmlResp = await gsvrFetch(htmlUrl);
                        if (!htmlResp.ok)
                            continue;
                        const html = await htmlResp.text();
                        const htmlDoc = new DOMParser().parseFromString(html, 'text/html');
                        const h1 = htmlDoc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
                        const bht = htmlDoc.querySelector('.bht')?.getAttribute('title')?.trim();
                        const title = bht || h1 || null;
                        const issnText = Array.from(htmlDoc.querySelectorAll('body, .body, #main'))
                            .map(node => node.textContent || '')
                            .find(text => /\bISSN\b/i.test(text || '')) || '';
                        const issns = normalizeIssnList(issnText.match(/\b\d{4}-?\d{3}[\dXx]\b/g) || []);
                        if (title) {
                            return {
                                streamType,
                                streamId,
                                acronym: null,
                                title,
                                shortTitle: null,
                                issns,
                                discontinuedYear: null,
                                successorRefs: [],
                            };
                        }
                    }
                }
                catch {
                    // ignore
                }
            }
            return null;
        })());
    }
    return streamMetaCache.get(cacheKey);
}
async function resolveDblpStreamMetadata(streamType, streamId, options = {}) {
    const visited = new Set();
    let currentType = streamType;
    let currentId = streamId;
    let latestMeta = null;
    const targetYear = typeof options.year === "number" && !Number.isNaN(options.year) ? options.year : null;
    while (true) {
        const key = `${currentType}:${currentId}`;
        if (visited.has(key))
            break;
        visited.add(key);
        const meta = await fetchDblpStreamMetadata(currentType, currentId);
        if (!meta)
            break;
        latestMeta = meta;
        if (currentType !== "conf" || targetYear === null) {
            break;
        }
        const discYear = meta.discontinuedYear;
        const successor = meta.successorRefs.find((ref) => {
            const refKey = `${ref.streamType}:${ref.streamId}`;
            if (visited.has(refKey))
                return false;
            if (ref.sinceYear != null && targetYear < ref.sinceYear)
                return false;
            if (discYear != null) {
                return targetYear > discYear;
            }
            return ref.sinceYear != null && targetYear >= ref.sinceYear;
        });
        if (!successor) {
            break;
        }
        currentType = successor.streamType;
        currentId = successor.streamId;
    }
    return latestMeta;
}
function getScholarUserId() {
    const params = new URLSearchParams(window.location.search);
    const userId = params.get('user');
    return userId;
}
function normalizeUrlForCache(url) {
    try {
        // Ensure the URL is absolute before parsing.
        // window.location.href provides the base if the input 'url' might be relative.
        const urlObj = new URL(url, window.location.href);
        const essentialParams = new URLSearchParams();
        // Essential parameters for identifying a specific publication view
        if (urlObj.searchParams.has('user')) {
            essentialParams.set('user', urlObj.searchParams.get('user'));
        }
        if (urlObj.searchParams.has('citation_for_view')) {
            essentialParams.set('citation_for_view', urlObj.searchParams.get('citation_for_view'));
        }
        // 'view_op=view_citation' is consistently part of these links
        if (urlObj.searchParams.has('view_op') && urlObj.searchParams.get('view_op') === 'view_citation') {
            essentialParams.set('view_op', 'view_citation');
        }
        // We might also want to keep 'mauthors' if present, as it can be part of the core link
        // to a specific version of a citation when multiple authors share a profile.
        // However, for simplicity and based on provided examples, we'll omit it for now.
        // If issues arise with co-authored papers from combined profiles, this could be a param to add.
        // Sort params for extremely consistent keys.
        essentialParams.sort();
        let normalized = `${urlObj.origin}${urlObj.pathname}`;
        if (essentialParams.toString()) {
            normalized += `?${essentialParams.toString()}`;
        }
        return normalized;
    }
    catch (e) {
        console.warn("GSR: Could not normalize URL:", url, e);
        // Fallback: remove hash and trim (less robust but better than nothing)
        return url.split('#')[0].trim();
    }
}
function getCacheKey(userId) {
    return `${CACHE_PREFIX}${userId}`;
}
async function loadCachedData(userId) {
    const cacheKey = getCacheKey(userId);
    try {
        const result = await chrome.storage.local.get(cacheKey);
        if (chrome.runtime.lastError) {
            //console.error("DEBUG: loadCachedData - chrome.runtime.lastError:", chrome.runtime.lastError.message);
        }
        if (result && result[cacheKey]) {
            const data = result[cacheKey];
            if (data.version === CACHE_VERSION) {
                const isExpired = Number.isFinite(CACHE_DURATION_MS)
                    ? (Date.now() - (data.timestamp ?? 0)) > CACHE_DURATION_MS
                    : false;
                if (!isExpired) {
                    return data;
                }
                await chrome.storage.local.remove(cacheKey);
                console.log("GSR INFO: Cached data expired for", cacheKey);
            }
        }
    }
    catch (error) {
        //console.error("DEBUG: loadCachedData - Error:", error, "Key:", cacheKey);
    }
    return null;
}
async function saveCachedData(userId, coreRankCounts, sjrRankCounts, publicationRanks, dblpAuthorPid) {
    const cacheKey = getCacheKey(userId);
    const dataToStore = {
        version: CACHE_VERSION,
        coreRankCounts,
        sjrRankCounts,
        publicationRanks: packRanks(publicationRanks),
        timestamp: Date.now(),
        dblpAuthorPid: dblpAuthorPid || undefined,
        dblpMatchTimestamp: dblpAuthorPid ? Date.now() : undefined
    };
    try {
        await chrome.storage.local.set({ [cacheKey]: dataToStore });
        if (chrome.runtime.lastError) {
            //console.error("DEBUG: saveCachedData - chrome.runtime.lastError:", chrome.runtime.lastError.message);
        }
    }
    catch (error) {
        //console.error("DEBUG: saveCachedData - Error:", error, "Key:", cacheKey);
    }
}
async function clearCachedData(userId) {
    const cacheKey = getCacheKey(userId);
    try {
        await chrome.storage.local.remove(cacheKey);
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
        dblpPubsForCurrentUser = [];
        scholarUrlToDblpVenueMap.clear();
        console.log("GSR INFO: Cleared cached ranking data for", userId);
        if (chrome.runtime.lastError) {
            //console.error("DEBUG: clearCachedData - chrome.runtime.lastError:", chrome.runtime.lastError.message);
        }
    }
    catch (error) {
        //console.error("DEBUG: clearCachedData - Error:", error);
    }
}
function getSettingsRootElement() {
    return document.body || document.documentElement;
}
function syncSettingsClasses() {
    const root = getSettingsRootElement();
    if (!root?.classList)
        return;
    root.classList.toggle('gsr-compact-mode', currentSettings.compactMode);
    root.classList.toggle('gsr-hide-unranked', currentSettings.showUnranked === false);
    root.classList.toggle('gsr-debug-off', currentSettings.showDebugDetails === false);
}
async function loadSettingsIntoState() {
    if (SETTINGS_API?.loadSettings) {
        currentSettings = await SETTINGS_API.loadSettings();
    }
    else {
        currentSettings = { ...DEFAULT_SETTINGS };
    }
    syncSettingsClasses();
    return currentSettings;
}
function isRankedResultInfo(info) {
    return (info?.system === 'CORE' && VALID_RANKS.includes(info.rank))
        || (info?.system === 'SJR' && SJR_QUARTILES.includes(info.rank));
}
function getRowStatusKind(info) {
    if (info?.system === 'DBLP' && info?.rank === DBLP_ENTRY_MISSING_LABEL) {
        return 'dblp-missing';
    }
    if (isRankedResultInfo(info)) {
        return 'ranked';
    }
    return 'unranked';
}
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function normalizeRankKey(value) {
    return String(value ?? 'na')
        .toLowerCase()
        .replace(/\*/g, 'star')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Wait until the Scholar publication table's row count stays stable for a short window.
// This reduces run-to-run variability caused by racing the UI rendering pipeline.
async function waitForStablePublicationRowCount(stableWindowMs = 350, timeoutMs = 5000) {
    const start = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    while (Date.now() - start < timeoutMs) {
        const count = document.querySelectorAll('tr.gsc_a_tr').length;
        if (count !== lastCount) {
            lastCount = count;
            lastChange = Date.now();
        }
        else if (Date.now() - lastChange >= stableWindowMs) {
            return;
        }
        await new Promise(r => setTimeout(r, 80));
    }
}
async function expandAllPublications(statusElement) {
    const showMoreButtonId = 'gsc_bpf_more';
    const publicationsTableBodySelector = '#gsc_a_b';
    let attempts = 0;
    const maxAttempts = 30;
    const statusTextElement = statusElement.querySelector('.gsr-status-text');
    while (attempts < maxAttempts) {
        const showMoreButton = document.getElementById(showMoreButtonId);
        if (!showMoreButton || showMoreButton.disabled) {
            if (statusTextElement && (statusTextElement.textContent || "").includes("Expanding")) {
                statusTextElement.textContent = "All publications loaded.";
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            break;
        }
        if (statusTextElement)
            statusTextElement.textContent = `Expanding publications... (click ${attempts + 1})`;
        const tableBody = document.querySelector(publicationsTableBodySelector);
        if (!tableBody) {
            if (statusTextElement)
                statusTextElement.textContent = "Error finding table.";
            break;
        }
        const contentLoadedPromise = new Promise((resolve) => {
            const observer = new MutationObserver((mutationsList, obs) => {
                for (const mutation of mutationsList) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        const newRows = Array.from(mutation.addedNodes).filter(node => node.nodeName === 'TR' && node.classList.contains('gsc_a_tr'));
                        if (newRows.length > 0) {
                            obs.disconnect();
                            resolve();
                            return;
                        }
                    }
                }
            });
            observer.observe(tableBody, { childList: true, subtree: false });
            showMoreButton.click();
            setTimeout(() => { observer.disconnect(); resolve(); }, 5000); // Timeout for click
        });
        await contentLoadedPromise;
        // Deterministic post-click wait: wait for the row count to settle.
        await waitForStablePublicationRowCount(350, 5000);
        attempts++;
    }
    if (attempts >= maxAttempts) {
        console.warn("Google Scholar Ranker: Reached max attempts for 'Show more'.");
        if (statusTextElement)
            statusTextElement.textContent = "Max expansion attempts.";
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
function getCoreDataFileForYear(pubYear) {
    // Use the newest available CORE dataset when the year is unknown.
    if (pubYear === null) {
        return 'core/CORE_2026.json';
    }
    // CORE 2026 is the latest dataset bundled with the extension.
    if (pubYear >= 2026)
        return 'core/CORE_2026.json';
    if (pubYear >= 2023)
        return 'core/CORE_2023.json';
    if (pubYear >= 2021)
        return 'core/CORE_2021.json';
    if (pubYear >= 2020)
        return 'core/CORE_2020.json';
    if (pubYear >= 2018)
        return 'core/CORE_2018.json';
    if (pubYear >= 2017)
        return 'core/CORE_2017.json';
    if (pubYear <= 2016) {
        return 'core/CORE_2014.json';
    }
    // Fallback
    return 'core/CORE_2026.json';
}
const ORDERED_CORE_DATA_FILES = [
    'core/CORE_2026.json',
    'core/CORE_2023.json',
    'core/CORE_2021.json',
    'core/CORE_2020.json',
    'core/CORE_2018.json',
    'core/CORE_2017.json',
    'core/CORE_2014.json',
];
function getCoreDatasetYear(coreDataFile) {
    const match = String(coreDataFile || '').match(/CORE_(\d{4})/i);
    return match ? parseInt(match[1], 10) : null;
}
function formatCoreStatusLabel(rawRankLabel) {
    const value = String(rawRankLabel || '').trim();
    if (!value)
        return null;
    return value.charAt(0).toUpperCase() + value.slice(1);
}
function buildConferenceSearchCandidates(venueQuery) {
    const query = String(venueQuery || '').trim();
    if (!query)
        return [];
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (value) => {
        const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
        if (!trimmed)
            return;
        const key = trimmed.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        candidates.push(trimmed);
    };
    const addExpandedVariants = (value) => {
        pushCandidate(value);
        if (RANKING_UTILS?.canonicalizeCsrankingsVenueName) {
            pushCandidate(RANKING_UTILS.canonicalizeCsrankingsVenueName(value));
        }
        if (RANKING_UTILS?.expandVenueCandidates) {
            for (const variant of RANKING_UTILS.expandVenueCandidates(value)) {
                pushCandidate(variant);
            }
        }
        for (const acronym of getPossibleAcronymsFromVenue(value)) {
            pushCandidate(acronym);
        }
    };
    addExpandedVariants(query);
    const queryWithoutYear = query.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (queryWithoutYear && queryWithoutYear !== query) {
        addExpandedVariants(queryWithoutYear);
    }
    return candidates;
}
function getConferenceSearchStatusPriority(status) {
    switch (status) {
        case DECISION_STATUS.MATCHED:
            return 4;
        case DECISION_STATUS.UNRANKED:
            return 3;
        case DECISION_STATUS.AMBIGUOUS:
            return 2;
        default:
            return 1;
    }
}
function getConferenceSearchMatchPriority(matchType) {
    switch (matchType) {
        case 'acronym_exact':
        case 'alias_exact':
            return 4;
        case 'acronym_disambiguated':
        case 'alias_disambiguated':
            return 3;
        case 'fuzzy':
            return 2;
        default:
            return 1;
    }
}
function pickBetterConferenceSearchOutcome(currentBest, nextCandidate) {
    if (!currentBest)
        return nextCandidate;
    const statusDelta = getConferenceSearchStatusPriority(nextCandidate.status) - getConferenceSearchStatusPriority(currentBest.status);
    if (statusDelta !== 0)
        return statusDelta > 0 ? nextCandidate : currentBest;
    const matchDelta = getConferenceSearchMatchPriority(nextCandidate.matchType) - getConferenceSearchMatchPriority(currentBest.matchType);
    if (matchDelta !== 0)
        return matchDelta > 0 ? nextCandidate : currentBest;
    const nextConfidence = typeof nextCandidate.confidence === 'number' ? nextCandidate.confidence : -1;
    const currentConfidence = typeof currentBest.confidence === 'number' ? currentBest.confidence : -1;
    if (nextConfidence !== currentConfidence)
        return nextConfidence > currentConfidence ? nextCandidate : currentBest;
    const nextMatchedVenue = String(nextCandidate.matchedVenue || '');
    const currentMatchedVenue = String(currentBest.matchedVenue || '');
    if (nextMatchedVenue.length !== currentMatchedVenue.length)
        return nextMatchedVenue.length > currentMatchedVenue.length ? nextCandidate : currentBest;
    return currentBest;
}
async function searchConferenceInCoreFile(venueQuery, coreDataFile) {
    const coreData = await loadCoreDataForFile(coreDataFile);
    const datasetYear = getCoreDatasetYear(coreDataFile);
    const originalQuery = String(venueQuery || '').trim();
    let best = null;
    for (const candidate of buildConferenceSearchCandidates(originalQuery)) {
        const details = {};
        const resolvedRank = findRankForVenue(candidate, coreData, originalQuery, details);
        const outcome = {
            query: originalQuery,
            searchedCandidate: candidate,
            coreDataFile,
            sourceYear: datasetYear,
            rank: VALID_RANKS.includes(resolvedRank) ? resolvedRank : 'N/A',
            status: details.decisionStatus
                || (VALID_RANKS.includes(resolvedRank)
                    ? DECISION_STATUS.MATCHED
                    : (details.matchedVenue ? DECISION_STATUS.UNRANKED : DECISION_STATUS.MISSING)),
            matchedVenue: details.matchedVenue ?? null,
            confidence: (typeof details.venueMatchConfidence === 'number' ? details.venueMatchConfidence : null),
            matchedKey: details.matchedKey ?? null,
            matchType: details.matchType ?? null,
            rawRankLabel: details.rawRankLabel ?? null,
            decisionEvidence: details.decisionEvidence ?? null
        };
        best = pickBetterConferenceSearchOutcome(best, outcome);
        if (best?.status === DECISION_STATUS.MATCHED && best.matchType && best.matchType !== 'fuzzy') {
            break;
        }
    }
    return best || {
        query: originalQuery,
        coreDataFile,
        sourceYear: datasetYear,
        rank: 'N/A',
        status: DECISION_STATUS.MISSING,
        matchedVenue: null,
        confidence: null,
        matchedKey: null,
        matchType: null,
        rawRankLabel: null,
        decisionEvidence: ['no_core_match']
    };
}
async function resolveConferenceSearchQuery(venueQuery, yearVal) {
    const inferredYear = Number.isFinite(yearVal) ? yearVal : parseYearFromText(venueQuery);
    const primaryFile = getCoreDataFileForYear(inferredYear ?? null);
    const primary = await searchConferenceInCoreFile(venueQuery, primaryFile);
    let latestRankedSnapshot = null;
    const primaryYear = getCoreDatasetYear(primaryFile) ?? Number.POSITIVE_INFINITY;
    const fallbackFiles = ORDERED_CORE_DATA_FILES.filter((file) => file !== primaryFile && ((getCoreDatasetYear(file) ?? 0) < primaryYear));
    for (const fallbackFile of fallbackFiles) {
        const outcome = await searchConferenceInCoreFile(venueQuery, fallbackFile);
        if (outcome.status === DECISION_STATUS.MATCHED && VALID_RANKS.includes(outcome.rank)) {
            latestRankedSnapshot = outcome;
            break;
        }
    }
    return { primary, latestRankedSnapshot };
}
function generateAcronymFromTitle(title) {
    if (!title)
        return "";
    const words = title.split(/[\s\-‑\/.,:;&]+/);
    let acronym = "";
    for (const word of words) {
        if (word.length > 0 && word[0] === word[0].toUpperCase() && /^[A-Za-z]/.test(word[0])) {
            acronym += word[0];
        }
        if (acronym.length >= 8)
            break;
    }
    return acronym.toUpperCase();
}
function normalizeCoreRawRankLabel(value) {
    const text = String(value || '').trim();
    if (!text)
        return null;
    const upper = text.toUpperCase();
    if (VALID_RANKS.includes(upper)) {
        return upper;
    }
    if (/\b(unranked|merged|journal|inactive|discontinued|ceased|not\s+ranked|removed|withdrawn|retired|suspended)\b/i.test(text)) {
        return text;
    }
    return null;
}
async function loadCoreDataForFile(coreDataFile) {
    if (coreDataCache[coreDataFile]) {
        if (!coreAliasIndexCache[coreDataFile] && RANKING_UTILS?.createCoreAliasIndex) {
            coreAliasIndexCache[coreDataFile] = RANKING_UTILS.createCoreAliasIndex(coreDataCache[coreDataFile]);
        }
        return coreDataCache[coreDataFile];
    }
    try {
        const url = chrome.runtime.getURL(coreDataFile);
        const response = await gsvrFetch(url);
        if (!response.ok)
            throw new Error(`Failed to fetch ${coreDataFile}: ${response.statusText} (URL: ${url})`);
        const jsonData = await response.json();
        if (!Array.isArray(jsonData)) {
            console.error(`CORE data from ${coreDataFile} is not an array.`, jsonData);
            return [];
        }
        const parsedData = jsonData.map((rawEntry) => {
            const entry = { title: "", acronym: "", rank: "N/A", rawRank: null };
            let pTitleKey = "International Conference on Advanced Communications and Computation", pAcroKey = "INFOCOMP"; // Default keys that might vary
            if (coreDataFile.includes('2018') || coreDataFile.includes('2017') || coreDataFile.includes('2014')) {
                pTitleKey = "Information Retrieval Facility Conference";
                pAcroKey = "IRFC"; // Example adjustment
            }
            if (typeof rawEntry[pTitleKey] === 'string')
                entry.title = rawEntry[pTitleKey];
            else if (typeof rawEntry.title === 'string')
                entry.title = rawEntry.title;
            else if (typeof rawEntry.Title === 'string')
                entry.title = rawEntry.Title;
            if (typeof rawEntry[pAcroKey] === 'string')
                entry.acronym = rawEntry[pAcroKey];
            else if (typeof rawEntry.acronym === 'string')
                entry.acronym = rawEntry.acronym;
            else if (typeof rawEntry.Acronym === 'string')
                entry.acronym = rawEntry.Acronym;
            let fRank;
            if (typeof rawEntry.Unranked === 'string')
                fRank = rawEntry.Unranked; // For 2014
            else if (typeof rawEntry.rank === 'string')
                fRank = rawEntry.rank;
            else if (typeof rawEntry.CORE_Rating === 'string')
                fRank = rawEntry.CORE_Rating; // For 2017
            else if (typeof rawEntry.Rating === 'string')
                fRank = rawEntry.Rating; // For some 2018
            if (fRank) {
                const cleanedRank = normalizeCoreRawRankLabel(fRank);
                entry.rawRank = cleanedRank || null;
                const uRank = String(cleanedRank || '').toUpperCase();
                if (VALID_RANKS.includes(uRank))
                    entry.rank = uRank;
            }
            entry.title = String(entry.title || "").trim();
            entry.acronym = String(entry.acronym || "").trim();
            if (!entry.acronym && entry.title) {
                const genAcro = generateAcronymFromTitle(entry.title);
                if (genAcro.length >= 2)
                    entry.acronym = genAcro;
            }
            return (entry.title || entry.acronym) ? entry : null;
        }).filter(entry => entry !== null);
        coreDataCache[coreDataFile] = parsedData;
        if (RANKING_UTILS?.createCoreAliasIndex) {
            coreAliasIndexCache[coreDataFile] = RANKING_UTILS.createCoreAliasIndex(parsedData);
        }
        return parsedData;
    }
    catch (error) {
        console.error(`Error loading/parsing CORE data from ${coreDataFile}:`, error);
        return [];
    }
}
async function fetchVenueAndYear(publicationUrl) {
    let venueName = null, publicationYear = null, venueLabel = null, pdfUrl = null, doi = null;
    try {
        const response = await gsvrFetch(publicationUrl);
        if (!response.ok) {
            return { venueName, publicationYear, venueLabel, pdfUrl, doi };
        }
        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');

        const baseUrl = new URL(publicationUrl);

        const resolveHref = (href) => {
            if (!href) return null;
            try {
                return new URL(href, baseUrl).toString();
            } catch {
                return null;
            }
        };

        // Best-effort PDF link extraction (usually present for [PDF] versions).
        const pdfCandidates = [
            doc.querySelector('#gsc_oci_title_gg a'),
            doc.querySelector('.gsc_oci_title_gg a'),
            doc.querySelector('a.gsc_oci_title_gg'),
        ].filter(Boolean);

        for (const a of pdfCandidates) {
            const href = a?.getAttribute?.('href') || null;
            const resolved = resolveHref(href);
            if (resolved) { pdfUrl = resolved; break; }
        }

        if (!pdfUrl) {
            for (const a of Array.from(doc.querySelectorAll('a'))) {
                const href = a.getAttribute('href') || '';
                const text = (a.textContent || '').trim();
                const looksPdf = /\.pdf(\?|#|$)/i.test(href) || /\bpdf\b/i.test(text) || /scholar\.googleusercontent\.com/i.test(href);
                if (!looksPdf) continue;
                const resolved = resolveHref(href);
                if (resolved) { pdfUrl = resolved; break; }
            }
        }

        const targetLabels = ['journal', 'conference', 'proceedings', 'book title', 'series', 'source', 'publication', 'book'];
        const yearLabel = 'publication date';

        let foundInOci = false;
        const sectionsOci = doc.querySelectorAll('#gsc_oci_table div.gs_scl');
        if (sectionsOci.length > 0) {
            for (const section of sectionsOci) {
                const fieldEl = section.querySelector('div.gsc_oci_field'), valueEl = section.querySelector('div.gsc_oci_value');
                if (fieldEl && valueEl) {
                    const label = fieldEl.textContent?.trim().toLowerCase() || '';
                    const valueText = valueEl.textContent?.trim() || '';
                    if (!venueName && targetLabels.includes(label)) {
                        venueName = valueText || null;
                        venueLabel = label;
                        foundInOci = true;
                    }
                    if (!publicationYear && label === yearLabel) {
                        const yT = valueText.split('/')[0];
                        if (yT && /^\d{4}$/.test(yT)) publicationYear = parseInt(yT, 10);
                        foundInOci = true;
                    }
                    if (!doi && label === 'doi') {
                        doi = valueText || null;
                        foundInOci = true;
                    }
                }
                if (venueName && publicationYear && (doi !== null || true)) {
                    // don't break solely on doi; keep scanning quickly
                    // but venue+year is enough to stop.
                    if (venueName && publicationYear) break;
                }
            }
        }

        if (!venueName || !publicationYear || !foundInOci) {
            const rowsVcd = doc.querySelectorAll('#gsc_vcd_table tr');
            for (const row of rowsVcd) {
                const fieldEl = row.querySelector('td.gsc_vcd_field'), valueEl = row.querySelector('td.gsc_vcd_value');
                if (fieldEl && valueEl) {
                    const label = fieldEl.textContent?.trim().toLowerCase() || '';
                    const valueText = valueEl.textContent?.trim() || '';
                    if (!venueName && targetLabels.includes(label)) {
                        venueName = valueText || null;
                        venueLabel = label;
                    }
                    if (!publicationYear && label === yearLabel) {
                        const yT = valueText.split('/')[0];
                        if (yT && /^\d{4}$/.test(yT)) publicationYear = parseInt(yT, 10);
                    }
                    if (!doi && label === 'doi') {
                        doi = valueText || null;
                    }
                }
                if (venueName && publicationYear) break;
            }
        }
    }
    catch (error) {
        console.error(`Error fetching/parsing ${publicationUrl}:`, error);
    }
    return { venueName, publicationYear, venueLabel, pdfUrl, doi };
}
// Best-effort PDF page count extraction.
// Only attempts PDFs hosted on scholar.googleusercontent.com (allowed by host permissions).
async function tryGetPdfPageCount(pdfUrl) {
    if (!pdfUrl) return null;
    let urlObj;
    try { urlObj = new URL(pdfUrl); } catch { return null; }
    if (urlObj.hostname !== 'scholar.googleusercontent.com') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
        // Range request keeps this lightweight (not all servers honor Range; that's ok).
        const resp = await gsvrFetch(pdfUrl, {
            headers: { 'Range': 'bytes=0-2000000' },
            signal: controller.signal
        });
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const text = new TextDecoder('latin1').decode(buf);

        const m = text.match(/\/Type\s*\/Pages[\s\S]{0,250}\/Count\s+(\d+)/);
        if (m && m[1]) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) return n;
        }
        const matches = text.match(/\/Type\s*\/Page\b/g);
        if (matches && matches.length > 0) return matches.length;
        return null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}

function normalizeJournalName(name) {
    if (!name)
        return "";
    // Journal names coming from DBLP and Scholar are often abbreviated and may contain
    // volume/issue/year tokens. For SJR matching we want a *stable* representation that:
    //  - expands common abbreviations
    //  - strips numeric volume/issue/year tokens
    //  - removes low-signal stop words
    //  - lightly stems plural forms (networks->network, surveys->survey, etc.)
    let cleaned = cleanTextForComparison(name, true);
    if (!cleaned)
        return "";
    // Drop bare numeric tokens (years, volumes, issues, article numbers).
    cleaned = cleaned.replace(/\b\d{1,6}\b/g, " ");
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    if (!cleaned)
        return "";

    const STOP = new Set([
        'a', 'an', 'the', 'of', 'and', 'for', 'in', 'on', 'to', 'at',
        // Journal boilerplate terms
        'journal', 'international', 'transactions', 'letters'
    ]);

    const stem = (tok) => {
        // Simple stemming sufficient for venue name matching.
        if (tok.length <= 4)
            return tok;
        if (tok.endsWith('ies') && tok.length > 5)
            return tok.slice(0, -3) + 'y';
        if (tok.endsWith('sses'))
            return tok; // e.g., "processes" edge
        if (tok.endsWith('s') && !tok.endsWith('ss'))
            return tok.slice(0, -1);
        return tok;
    };

    const tokens = cleaned
        .split(' ')
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .map(t => stem(t))
        .filter(t => t.length > 0 && !STOP.has(t));

    return tokens.join(' ').trim();
}

// Some abbreviations map ambiguously (e.g., "Comput." could be "Computer" or "Computing").
// To avoid lowering the global fuzzy threshold, try a handful of deterministic variants.
function generateJournalNormalizationVariants(name) {
    const base = normalizeJournalName(name);
    if (!base)
        return [];
    const variants = new Set([base]);
    // "ACM computer survey" vs "ACM computing survey"
    if (/\bacm\s+computer\b/.test(base)) {
        variants.add(base.replace(/\bacm\s+computer\b/g, 'acm computing'));
    }
    if (/\bcomputer\s+survey\b/.test(base)) {
        variants.add(base.replace(/\bcomputer\b/g, 'computing'));
    }
    if (/\bcomputing\s+survey\b/.test(base)) {
        variants.add(base.replace(/\bcomputing\b/g, 'computer'));
    }
    return Array.from(variants);
}
function isArxivLikeVenue(info) {
    const key = info.dblpKey?.toLowerCase() ?? "";
    if (key.startsWith('journals/corr') || key.includes('/corr/')) {
        return true;
    }
    const candidates = [info.venue, info.venue_full, info.acronym];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const normalized = normalizeJournalName(candidate);
        if (!normalized)
            continue;
        if (ARXIV_NORMALIZED_VALUES.has(normalized)) {
            return true;
        }
        const padded = ` ${normalized} `;
        for (const keyword of ARXIV_PLAIN_KEYWORDS) {
            if (padded.includes(keyword)) {
                return true;
            }
        }
    }
    return false;
}
const SJR_DATASET_START_YEAR = 2010;
const SJR_DATASET_END_YEAR = 2024;
const sjrLookupCache = new Map();
let sjrDatasetPromise = null;
function parseSjrCsv(text) {
    const rows = [];
    let currentField = '';
    let currentRow = [];
    let inQuotes = false;
    const sanitized = text.replace(/\ufeff/g, '');
    for (let i = 0; i < sanitized.length; i++) {
        const char = sanitized[i];
        if (char === '"') {
            if (inQuotes && sanitized[i + 1] === '"') {
                currentField += '"';
                i++;
            }
            else {
                inQuotes = !inQuotes;
            }
        }
        else if (char === ';' && !inQuotes) {
            currentRow.push(currentField);
            currentField = '';
        }
        else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && sanitized[i + 1] === '\n') {
                i++;
            }
            currentRow.push(currentField);
            currentField = '';
            if (currentRow.some(value => value.trim().length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
        }
        else {
            currentField += char;
        }
    }
    if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.some(value => value.trim().length > 0)) {
            rows.push(currentRow);
        }
    }
    return rows;
}
function createTokenSet(normalizedTitle) {
    const STOP_WORDS = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'international', 'transactions', 'letters']);
    const tokens = normalizedTitle
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
    return new Set(tokens);
}
function createSjrTokenIndex(entries) {
    const tokenToIndexes = new Map();
    const tokenFrequency = new Map();
    entries.forEach((entry, index) => {
        for (const token of entry.tokenSet || []) {
            if (!tokenToIndexes.has(token))
                tokenToIndexes.set(token, new Set());
            tokenToIndexes.get(token).add(index);
            tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
        }
    });
    return { tokenToIndexes, tokenFrequency };
}
function chooseBetterQuartile(existing, nextValue) {
    if (!nextValue)
        return existing;
    if (!existing)
        return nextValue;
    const parse = (value) => {
        const match = value.match(/^Q(\d)$/i);
        return match ? parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
    };
    return parse(nextValue) < parse(existing) ? nextValue : existing;
}
function createSjrEntry(normalizedTitle, title, quartilesByYear, extra = {}) {
    return {
        normalizedTitle,
        resolvedTitle: title,
        quartilesByYear,
        tokenSet: new Set(Array.isArray(extra.tokens) ? extra.tokens : createTokenSet(normalizedTitle)),
        issns: normalizeIssnList(extra.issns),
        sourceId: extra.sourceId ?? null,
        coverage: extra.coverage ?? null
    };
}
async function loadSjrDataset() {
    try {
        const indexUrl = chrome.runtime.getURL('data/sjr-index.json');
        const response = await gsvrFetch(indexUrl);
        if (response.ok) {
            const payload = await response.json();
            if (payload && Array.isArray(payload.entries)) {
                const byNormalized = new Map();
                const byIssn = new Map();
                const entries = [];
                for (const item of payload.entries) {
                    if (!item?.n || !item?.t || !item?.q)
                        continue;
                    const entry = createSjrEntry(item.n, item.t, item.q, {
                        tokens: item.k,
                        issns: item.i,
                        sourceId: item.s,
                        coverage: item.c
                    });
                    byNormalized.set(entry.normalizedTitle, entry);
                    entries.push(entry);
                    for (const issn of entry.issns) {
                        if (!byIssn.has(issn))
                            byIssn.set(issn, []);
                        byIssn.get(issn).push(entry);
                    }
                }
                if (entries.length > 0) {
                    return {
                        version: payload.version ?? 1,
                        startYear: payload.startYear ?? SJR_DATASET_START_YEAR,
                        endYear: payload.endYear ?? SJR_DATASET_END_YEAR,
                        byNormalized,
                        byIssn,
                        entries,
                        tokenIndex: createSjrTokenIndex(entries)
                    };
                }
            }
        }
    }
    catch (error) {
        console.warn('Falling back to raw SJR CSV data because the compact index could not be loaded.', error);
    }
    const byNormalized = new Map();
    const byIssn = new Map();
    const entries = [];
    for (let year = SJR_DATASET_START_YEAR; year <= SJR_DATASET_END_YEAR; year++) {
        const datasetPath = `sjr/scimagojr ${year}.csv`;
        try {
            const url = chrome.runtime.getURL(datasetPath);
            const response = await gsvrFetch(url);
            if (!response.ok) {
                console.error(`Failed to fetch ${datasetPath}: ${response.status} ${response.statusText}`);
                continue;
            }
            const text = await response.text();
            const rows = parseSjrCsv(text);
            if (rows.length === 0)
                continue;
            const header = rows[0].map(cell => cell.trim().toLowerCase());
            const sourceIdIndex = header.findIndex(cell => cell === 'sourceid');
            const titleIndex = header.findIndex(cell => cell === 'title');
            const quartileIndex = header.findIndex(cell => cell === 'sjr best quartile');
            const typeIndex = header.findIndex(cell => cell === 'type');
            const issnIndex = header.findIndex(cell => cell === 'issn');
            const coverageIndex = header.findIndex(cell => cell === 'coverage');
            if (titleIndex === -1 || quartileIndex === -1) {
                console.warn(`Skipping ${datasetPath} because header columns were not found.`);
                continue;
            }
            for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
                const row = rows[rowIndex];
                if (!row || row.length <= Math.max(titleIndex, quartileIndex))
                    continue;
                const type = typeIndex >= 0 ? row[typeIndex]?.trim().toLowerCase() : '';
                if (type && type !== 'journal')
                    continue;
                const title = row[titleIndex]?.trim();
                const quartileRaw = row[quartileIndex]?.trim().toUpperCase();
                const sourceId = sourceIdIndex >= 0 ? row[sourceIdIndex]?.trim() || null : null;
                const issns = issnIndex >= 0 ? normalizeIssnList(row[issnIndex]) : [];
                const coverage = coverageIndex >= 0 ? row[coverageIndex]?.trim() || null : null;
                if (!title)
                    continue;
                const normalizedTitle = normalizeJournalName(title);
                if (!normalizedTitle)
                    continue;
                const quartile = quartileRaw && /^Q[1-4]$/i.test(quartileRaw) ? quartileRaw.toUpperCase() : undefined;
                let entry = byNormalized.get(normalizedTitle);
                if (!entry) {
                    entry = createSjrEntry(normalizedTitle, title, {}, {
                        issns,
                        sourceId,
                        coverage
                    });
                    byNormalized.set(normalizedTitle, entry);
                    entries.push(entry);
                }
                else if (title.length > entry.resolvedTitle.length) {
                    entry.resolvedTitle = title;
                }
                if (!entry.sourceId && sourceId) {
                    entry.sourceId = sourceId;
                }
                if (!entry.coverage && coverage) {
                    entry.coverage = coverage;
                }
                for (const issn of issns) {
                    if (!entry.issns.includes(issn))
                        entry.issns.push(issn);
                }
                if (quartile) {
                    const current = entry.quartilesByYear[year];
                    const best = chooseBetterQuartile(current, quartile);
                    if (best) {
                        entry.quartilesByYear[year] = best;
                    }
                }
            }
        }
        catch (error) {
            console.error(`Error loading SJR dataset for ${year}:`, error);
        }
    }
    for (const entry of entries) {
        for (const issn of entry.issns) {
            if (!byIssn.has(issn))
                byIssn.set(issn, []);
            byIssn.get(issn).push(entry);
        }
    }
    return {
        version: 1,
        startYear: SJR_DATASET_START_YEAR,
        endYear: SJR_DATASET_END_YEAR,
        byNormalized,
        byIssn,
        entries,
        tokenIndex: createSjrTokenIndex(entries)
    };
}
function ensureSjrDataset() {
    if (!sjrDatasetPromise) {
        sjrDatasetPromise = loadSjrDataset();
    }
    return sjrDatasetPromise;
}
function selectQuartileForYear(data, publicationYear) {
    const entries = Object.entries(data.quartilesByYear)
        .map(([year, quartile]) => ({ year: Number(year), quartile }))
        .filter(entry => Number.isFinite(entry.year))
        .sort((a, b) => b.year - a.year);
    if (entries.length === 0) {
        return { quartile: null, year: null };
    }
    if (publicationYear) {
        const targetYear = Math.max(SJR_DATASET_START_YEAR, publicationYear);
        const matchingYear = entries.find(entry => entry.year === targetYear);
        if (matchingYear) {
            return { quartile: matchingYear.quartile, year: matchingYear.year, sourceYearFallback: false };
        }
        const previousYear = entries.find(entry => entry.year < targetYear);
        if (previousYear) {
            return {
                quartile: previousYear.quartile,
                year: previousYear.year,
                sourceYearFallback: true
            };
        }
    }
    const latestEntry = entries[0];
    return { quartile: latestEntry.quartile, year: latestEntry.year, sourceYearFallback: true };
}
function selectSjrCandidateIndexes(queryTokens, dataset) {
    if (!queryTokens.length || !dataset?.tokenIndex)
        return null;
    const ranked = queryTokens
        .map(token => ({ token, count: dataset.tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY }))
        .filter(entry => Number.isFinite(entry.count))
        .sort((a, b) => a.count - b.count || a.token.localeCompare(b.token));
    if (!ranked.length)
        return null;
    let candidateSet = null;
    for (const entry of ranked.slice(0, 3)) {
        const indexes = dataset.tokenIndex.tokenToIndexes.get(entry.token);
        if (!indexes?.size)
            continue;
        candidateSet = candidateSet ? new Set([...candidateSet].filter(index => indexes.has(index))) : new Set(indexes);
        if (candidateSet.size > 0 && candidateSet.size <= 48) {
            break;
        }
    }
    if (candidateSet?.size) {
        return candidateSet;
    }
    return dataset.tokenIndex.tokenToIndexes.get(ranked[0].token) || null;
}
function findBestSjrMatch({ normalizedQuery, queryIssns, dataset }) {
    const exactIssnMatches = [];
    for (const issn of normalizeIssnList(queryIssns)) {
        const matches = dataset.byIssn?.get(issn) || [];
        for (const match of matches) {
            if (!exactIssnMatches.includes(match))
                exactIssnMatches.push(match);
        }
    }
    if (exactIssnMatches.length === 1) {
        return { status: DECISION_STATUS.MATCHED, entry: exactIssnMatches[0], score: 1.0, matchedBy: 'issn' };
    }
    if (exactIssnMatches.length > 1) {
        return { status: DECISION_STATUS.AMBIGUOUS, score: 1.0, matchedBy: 'issn' };
    }
    const directMatch = dataset.byNormalized.get(normalizedQuery);
    if (directMatch) {
        return { status: DECISION_STATUS.MATCHED, entry: directMatch, score: 1.0, matchedBy: 'title_exact' };
    }
    const queryTokens = normalizedQuery
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length >= 3);
    const candidateIndexes = selectSjrCandidateIndexes(queryTokens, dataset) || new Set(dataset.entries.map((_, index) => index));
    let best = null;
    let second = null;
    for (const index of candidateIndexes) {
        const entry = dataset.entries[index];
        if (!entry)
            continue;
        const score = RANKING_UTILS?.hybridSimilarity
            ? RANKING_UTILS.hybridSimilarity(normalizedQuery, entry.normalizedTitle)
            : (0.72 * jaroWinkler(normalizedQuery, entry.normalizedTitle));
        if (score < RANKING_CONFIG.sjrFuzzyThreshold) {
            continue;
        }
        const candidate = { entry, score };
        if (!best || score > best.score) {
            second = best;
            best = candidate;
        }
        else if (!second || score > second.score) {
            second = candidate;
        }
    }
    if (!best) {
        return { status: DECISION_STATUS.MISSING };
    }
    const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
    if (second && best.score < 0.97 && gap < RANKING_CONFIG.sjrAmbiguityGap) {
        return { status: DECISION_STATUS.AMBIGUOUS, score: best.score, gap, matchedBy: 'title_fuzzy' };
    }
    return { status: DECISION_STATUS.MATCHED, entry: best.entry, score: best.score, matchedBy: 'title_fuzzy' };
}
async function resolveSjrQuartile(journalName, publicationYear, journalMeta = {}) {
    const variants = generateJournalNormalizationVariants(journalName);
    if (!variants.length)
        return { status: 'not_found' };
    const queryIssns = normalizeIssnList(journalMeta.issns);

    // Try cache first across variants.
    let sawNotFound = false;
    for (const normalizedQuery of variants) {
        if (!sjrLookupCache.has(normalizedQuery))
            continue;
        const cachedEntry = sjrLookupCache.get(normalizedQuery);
        if (cachedEntry?.kind === 'not_found') {
            sawNotFound = true;
            continue;
        }
        if (cachedEntry?.kind === 'success') {
            const { quartile, year, sourceYearFallback } = selectQuartileForYear(cachedEntry.data, publicationYear ?? null);
            return {
                status: 'success',
                quartile,
                year,
                resolvedTitle: cachedEntry.data.resolvedTitle,
                matchScore: cachedEntry.matchScore ?? null,
                matchedNormalizedTitle: cachedEntry.matchedNormalizedTitle ?? null,
                matchedSourceId: cachedEntry.data.sourceId ?? null,
                sourceYearFallback
            };
        }
    }
    try {
        const dataset = await ensureSjrDataset();
        let sawAmbiguous = false;
        for (const normalizedQuery of variants) {
            const match = findBestSjrMatch({ normalizedQuery, queryIssns, dataset });
            if (!match || match.status === DECISION_STATUS.MISSING)
                continue;
            if (match.status === DECISION_STATUS.AMBIGUOUS) {
                sawAmbiguous = true;
                continue;
            }
            const entry = match.entry;
            const data = {
                resolvedTitle: entry.resolvedTitle,
                quartilesByYear: { ...entry.quartilesByYear },
                sourceId: entry.sourceId ?? null
            };
            // Cache the successful match for all variants to avoid repeated fuzzy scans.
            for (const v of variants) {
                sjrLookupCache.set(v, {
                    kind: 'success',
                    data,
                    matchScore: match.score,
                    matchedNormalizedTitle: entry.normalizedTitle
                });
            }
            const { quartile, year, sourceYearFallback } = selectQuartileForYear(data, publicationYear ?? null);
            return {
                status: 'success',
                quartile,
                year,
                resolvedTitle: data.resolvedTitle,
                matchScore: match.score,
                matchedNormalizedTitle: entry.normalizedTitle,
                matchedSourceId: entry.sourceId ?? null,
                sourceYearFallback
            };
        }
        if (sawAmbiguous) {
            return { status: 'ambiguous' };
        }

        // Not found: cache negative result for all variants.
        if (!sawNotFound) {
            for (const v of variants) {
                sjrLookupCache.set(v, { kind: 'not_found' });
            }
        }
        return { status: 'not_found' };
    }
    catch (error) {
        console.error('Error resolving SJR quartile from local dataset:', error);
        return { status: 'error', transient: false };
    }
}
function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


const COMMON_ABBREVIATIONS = {
    "int'l": "international",
    "intl": "international",
    "int.": "international",
    "int": "international",
    "conf.": "conference",
    "conf": "conference",
    "proc.": "proceedings",
    "proc": "proceedings",
    "symp.": "symposium",
    "symp": "symposium",
    "j.": "journal",
    "j": "journal",
    "jour": "journal",
    "trans.": "transactions",
    "trans": "transactions",
    "annu.": "annual",
    "annu": "annual",
    // NOTE: DBLP abbreviations use "Comput." overwhelmingly to mean "Computer".
    // Some venues expand to "Computing" (e.g., "ACM Computing Surveys"),
    // which we handle via lightweight normalization variants in journal matching.
    "comput.": "computer",
    "comput": "computer",
    "comp.": "computer",
    "comp": "computer",
    "commun.": "communications",
    "commun": "communications",
    "comm.": "communications",
    "comm": "communications",
    "rev.": "review",
    "rev": "review",
    "syst.": "systems",
    "syst": "systems",
    // Common DBLP journal abbreviations
    "manag.": "management",
    "manag": "management",
    "process.": "processing",
    "process": "processing",
    "sci.": "science",
    "sci": "science",
    "sens.": "sensor",
    "sens": "sensor",
    "netw.": "networks",
    "netw": "networks",
    "archit.": "architecture",
    "archit": "architecture",
    "tech.": "technical",
    "tech": "technical",
    "technol": "technology",
    "engin.": "engineering",
    "engin": "engineering",
    "res.": "research",
    "res": "research",
    "adv.": "advances",
    "adv": "advances",
    "appl.": "applications",
    "appl": "applications",
    "surv.": "surveys",
    "surv": "surveys",
    "wirel.": "wireless",
    "wirel": "wireless",
    "inf.": "information",
    "inf": "information",
    "lectures notes": "lecture notes",
    "lect notes": "lecture notes",
    "lncs": "lecture notes in computer science",
};
function cleanTextForComparison(text, isGoogleScholarVenue = false) {
    if (!text)
        return "";
    let cleanedText = text.toLowerCase();
    cleanedText = cleanedText.replace(/&/g, " and ");
    cleanedText = cleanedText.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”()\[\]]/g, " ");
    cleanedText = cleanedText.replace(/\s-\s/g, " ");
    if (isGoogleScholarVenue) {
        cleanedText = cleanedText.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, "");
        cleanedText = cleanedText.replace(/,\s*\d{4}$/, "");
        cleanedText = cleanedText.replace(/\(\d{4}\)$/, "");
        // Scholar/DBLP often appends "(2)", "(Part 2)", etc. Strip trailing numeric/issue tokens.
        cleanedText = cleanedText.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, " ");
        cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, "");
    }
    // Also remove a trailing standalone number for non-Scholar venues (e.g., "MobiQuitous (2)")
    cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, "");
    cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

    // Expand abbreviations *after* punctuation is normalized to spaces.
    // This avoids false negatives for dotted abbreviations like "Commun." or "J.".
    for (const [abbr, expansion] of Object.entries(COMMON_ABBREVIATIONS)) {
        const regex = new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi');
        cleanedText = cleanedText.replace(regex, expansion);
    }

    cleanedText = cleanedText.replace(/\s+/g, ' ');
    return cleanedText.trim();
}
const FUZZY_THRESHOLD = 0.90;
function jaroWinkler(s1, s2) {
    if (!s1 || !s2)
        return 0;
    const m = (a, b) => {
        const bound = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
        const match = new Array(a.length).fill(false), bMatch = new Array(b.length).fill(false);
        let matches = 0;
        for (let i = 0; i < a.length; i++) {
            const lo = Math.max(0, i - bound), hi = Math.min(i + bound + 1, b.length);
            for (let j = lo; j < hi; j++)
                if (!bMatch[j] && a[i] === b[j]) {
                    match[i] = bMatch[j] = true;
                    matches++;
                    break;
                }
        }
        if (!matches)
            return { matches: 0, trans: 0 };
        let k = 0, trans = 0;
        for (let i = 0; i < a.length; i++)
            if (match[i]) {
                while (!bMatch[k])
                    k++;
                if (a[i] !== b[k])
                    trans++;
                k++;
            }
        return { matches, trans: trans / 2 };
    };
    const { matches, trans } = m(s1, s2);
    if (!matches)
        return 0;
    const j = (matches / s1.length + matches / s2.length + (matches - trans) / matches) / 3;
    const l = Math.min(4, [...s1].findIndex((c, i) => c !== s2[i] || i >= s2.length));
    return j + l * 0.1 * (1 - j);
}
const ORG_PREFIXES_TO_IGNORE = ["acm/ieee", "ieee/acm", "acm-ieee", "ieee-acm", "acm sigplan", "acm sigops", "acm sigbed", "acm sigcomm", "acm sigmod", "acm sigarch", "acm sigsac", "acm", "ieee", "ifip", "usenix", "eurographics", "springer", "elsevier", "wiley", "sigplan", "sigops", "sigbed", "sigcomm", "sigmod", "sigarch", "sigsac", "international", "national", "annual"];
function stripOrgPrefixes(text) {
    let currentText = text;
    let strippedSomething;
    do {
        strippedSomething = false;
        for (const prefix of ORG_PREFIXES_TO_IGNORE) {
            if (currentText.startsWith(prefix + " ") || currentText === prefix) {
                currentText = currentText.substring(prefix.length).trim();
                strippedSomething = true;
            }
        }
    } while (strippedSomething && currentText.length > 0);
    return currentText;
}
const CORE_TITLE_TRAILING_PATTERNS = [
    /\bpreviously\b.*$/,
    /\bformerly\b.*$/,
    /\bincluding\b.*$/,
    /\bincorporating\b.*$/,
    /\bfeaturing\b.*$/,
    /\bco\s+located\b.*$/,
    /\bco\s+hosted\b.*$/,
];
function generateCoreTitleVariants(coreTitle) {
    const normalized = coreTitle.replace(/\s+/g, ' ').trim();
    if (!normalized)
        return [];
    const variants = new Set([normalized]);
    for (const pattern of CORE_TITLE_TRAILING_PATTERNS) {
        const trimmed = normalized.replace(pattern, '').trim();
        if (trimmed && trimmed !== normalized) {
            variants.add(trimmed);
        }
    }
    return Array.from(variants);
}
function findRankForVenue(venueKey, coreData, fullVenueTitle = undefined, detailsOut = null) {
    const setDetails = (details) => {
        if (!detailsOut || typeof detailsOut !== 'object')
            return;
        for (const [key, value] of Object.entries(details || {})) {
            detailsOut[key] = value;
        }
    };
    const resolver = RANKING_UTILS?.resolveCoreVenue;
    const aliasIndex = Object.values(coreAliasIndexCache).find((entry) => entry?.entries === coreData) || null;
    if (resolver) {
        const result = resolver({
            venueKey,
            fullVenueTitle,
            coreData,
            aliasIndex
        });
        if (result) {
            setDetails({
                matchType: result.matchType ?? result.status ?? null,
                matchedVenue: result.matchedVenue ?? venueKey ?? null,
                venueMatchConfidence: (typeof result.confidence === 'number' ? result.confidence : null),
                decisionStatus: result.status ?? null,
                matchedKey: result.matchedKey ?? null,
                rawRankLabel: result.rawRankLabel ?? null,
                decisionEvidence: result.reason ? [result.reason] : null
            });
            return VALID_RANKS.includes(result.rank) ? result.rank : "N/A";
        }
    }
    return "N/A";
}
function extractPotentialAcronymsFromText(scholarVenueName) {
    const acronyms = new Set();
    const originalVenueName = scholarVenueName;
    const parentheticalMatches = originalVenueName.match(/\(([^)]+)\)/g);
    if (parentheticalMatches) {
        parentheticalMatches.forEach(match => {
            const contentInParen = match.slice(1, -1).trim();
            const partsInParen = contentInParen.split(/[,;]/).map(p => p.trim());
            for (const part of partsInParen) {
                const potentialAcronym = part.match(/^([A-Z][a-zA-Z0-9'’]*[a-zA-Z0-9]|[A-Z]{2,}[0-9'’]*)$/);
                if (potentialAcronym && potentialAcronym[0]) {
                    let extracted = potentialAcronym[0];
                    let cleanedParenAcronym = extracted.replace(/['’]\d{2,4}$/, '').replace(/['’]s$/, '');
                    if (cleanedParenAcronym.length >= 2 && cleanedParenAcronym.length <= 12 &&
                        !/^\d+$/.test(cleanedParenAcronym) &&
                        !IGNORE_KEYWORDS.includes(cleanedParenAcronym.toLowerCase()) &&
                        !["was", "formerly", "inc", "ltd", "vol", "no"].includes(cleanedParenAcronym.toLowerCase())) {
                        acronyms.add(cleanedParenAcronym.toLowerCase());
                    }
                }
                else {
                    const simplerPatterns = part.match(/([A-Z]{2,}[0-9']*\b|[A-Z]+[0-9]+[A-Z0-9]*\b)/g);
                    if (simplerPatterns) {
                        simplerPatterns.forEach(pAcronym => {
                            let cleanedParenAcronym = pAcronym.replace(/['’]\d{2,4}$/, '').replace(/['’]s$/, '');
                            if (cleanedParenAcronym.length >= 2 && cleanedParenAcronym.length <= 12 &&
                                !/^\d+$/.test(cleanedParenAcronym) &&
                                !IGNORE_KEYWORDS.includes(cleanedParenAcronym.toLowerCase()) &&
                                !["was", "formerly"].includes(cleanedParenAcronym.toLowerCase())) {
                                acronyms.add(cleanedParenAcronym.toLowerCase());
                            }
                        });
                    }
                }
            }
        });
    }
    let textWithoutParens = originalVenueName.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    textWithoutParens = textWithoutParens.replace(/\b(Proceedings\s+of\s+(the)?|Proc\.\s+of\s+(the)?|International\s+Conference\s+on|Intl\.\s+Conf\.\s+on|Conference\s+on|Symposium\s+on|Workshop\s+on|Journal\s+of)\b/gi, ' ').trim();
    const words = textWithoutParens.split(/[\s\-‑\/.,:;&]+/);
    const commonNonAcronymWords = new Set([...IGNORE_KEYWORDS, 'proc', 'data', 'services', 'models', 'security', 'time', 'proceedings', 'journal', 'conference', 'conf', 'symposium', 'symp', 'workshop', 'ws', 'international', 'intl', 'natl', 'national', 'annual', 'vol', 'volume', 'no', 'number', 'pp', 'page', 'pages', 'part', 'edition', 'of', 'the', 'on', 'in', 'and', 'for', 'to', 'at', 'st', 'nd', 'rd', 'th', 'springer', 'elsevier', 'wiley', 'press', 'extended', 'abstracts', 'poster', 'session', 'sessions', 'doctoral', 'companion', 'joint', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'advances', 'systems', 'networks', 'computing', 'applications', 'technology', 'technologies', 'research', 'science', 'sciences', 'engineering', 'management', 'information', 'communication', 'communications', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'letters', 'bulletin', 'archive', 'archives', 'series', 'chapter', 'section', 'tutorial', 'tutorials', 'report', 'technical', 'tech', ...(Array.from({ length: 75 }, (_, i) => (1970 + i).toString()))]);
    words.forEach(word => {
        const cleanWordOriginalCase = word.trim();
        if (cleanWordOriginalCase.length >= 2 && cleanWordOriginalCase.length <= 12 && !/^\d+$/.test(cleanWordOriginalCase)) {
            if ((!commonNonAcronymWords.has(cleanWordOriginalCase.toLowerCase())) &&
                (/^[A-Z0-9]+$/.test(cleanWordOriginalCase) ||
                    /^[A-Z][a-z]+[A-Z]+[A-Za-z0-9]*$/.test(cleanWordOriginalCase) ||
                    /^[A-Z][A-Z0-9]+$/.test(cleanWordOriginalCase) && cleanWordOriginalCase.length <= 5)) {
                acronyms.add(cleanWordOriginalCase.toLowerCase());
            }
        }
    });
    if (acronyms.size === 0 &&
        originalVenueName.length >= 2 && originalVenueName.length <= 10 &&
        !originalVenueName.includes(" ") && /^[A-Za-z0-9]+$/.test(originalVenueName) &&
        !/^\d+$/.test(originalVenueName) &&
        !commonNonAcronymWords.has(originalVenueName.toLowerCase())) {
        acronyms.add(originalVenueName.toLowerCase());
    }
    return Array.from(acronyms);
}
function getPossibleAcronymsFromVenue(venueText) {
    if (!venueText || typeof venueText !== "string") return [];
    try {
        // Reuse the existing acronym extractor and return a small set of uppercase candidates.
        const extracted = extractPotentialAcronymsFromText(venueText) || [];
        const out = [];
        const seen = new Set();
        for (const a of extracted) {
            if (!a) continue;
            const upper = String(a).trim().toUpperCase();
            if (!upper || upper.length < 2 || upper.length > 12) continue;
            if (!/^[A-Z0-9]+$/.test(upper)) continue;
            if (!seen.has(upper)) {
                seen.add(upper);
                out.push(upper);
            }
            if (out.length >= 8) break;
        }
        return out;
    } catch (e) {
        return [];
    }
}
function buildBadgeDetailItems(rank, system, reason = null, meta = null) {
    const items = [];
    items.push({ label: 'Source', value: system });
    items.push({ label: 'Rank', value: rank });
    if (reason) {
        items.push({ label: 'Reason', value: reason });
    }
    if (meta && typeof meta === 'object' && currentSettings.showDebugDetails !== false) {
        const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : null);
        if (meta.sourceYear) {
            items.push({ label: 'Dataset Year', value: String(meta.sourceYear) });
        }
        if (meta.sourceYearFallback) {
            items.push({ label: 'Year Mode', value: 'Latest available fallback' });
        }
        if (meta.matchedVenue && (system === 'CORE' || system === 'SJR')) {
            items.push({ label: 'Matched Venue', value: meta.matchedVenue });
        }
        if (meta.matchedSourceId && system === 'SJR') {
            items.push({ label: 'SJR Source ID', value: String(meta.matchedSourceId) });
        }
        if (pct(meta.venueMatchConfidence) && (system === 'CORE' || system === 'SJR')) {
            items.push({ label: 'Venue Confidence', value: pct(meta.venueMatchConfidence) });
        }
        if (meta.dblpVenue) {
            items.push({ label: 'DBLP Venue', value: meta.dblpVenue });
        }
        if (pct(meta.matchConfidence)) {
            items.push({ label: 'DBLP Title Match', value: pct(meta.matchConfidence) });
        }
        if (meta.decisionStatus) {
            items.push({ label: 'Decision', value: String(meta.decisionStatus) });
        }
        if (pct(meta.confidence) && !pct(meta.venueMatchConfidence) && !pct(meta.matchConfidence)) {
            items.push({ label: 'Confidence', value: pct(meta.confidence) });
        }
    }
    return items.filter(item => item.value);
}
function ensureBadgePopover() {
    if (gsrBadgePopoverEl && document.body.contains(gsrBadgePopoverEl)) {
        return gsrBadgePopoverEl;
    }
    const popover = document.createElement('div');
    popover.id = BADGE_POPOVER_ID;
    popover.className = 'gsr-badge-popover';
    popover.setAttribute('role', 'tooltip');
    popover.setAttribute('aria-hidden', 'true');
    document.body.appendChild(popover);
    gsrBadgePopoverEl = popover;
    return popover;
}
function hideBadgePopover(immediate = false) {
    if (gsrBadgePopoverHideTimeout) {
        clearTimeout(gsrBadgePopoverHideTimeout);
        gsrBadgePopoverHideTimeout = null;
    }
    const applyHide = () => {
        const popover = ensureBadgePopover();
        popover.classList.remove('is-visible');
        popover.innerHTML = '';
        popover.setAttribute('aria-hidden', 'true');
    };
    if (immediate) {
        applyHide();
        return;
    }
    gsrBadgePopoverHideTimeout = window.setTimeout(applyHide, 120);
}
function showBadgePopover(anchor, items) {
    if (!anchor || !items.length) {
        hideBadgePopover(true);
        return;
    }
    if (gsrBadgePopoverHideTimeout) {
        clearTimeout(gsrBadgePopoverHideTimeout);
        gsrBadgePopoverHideTimeout = null;
    }
    const popover = ensureBadgePopover();
    popover.innerHTML = items
        .map(item => `<div class="gsr-badge-popover__row"><span class="gsr-badge-popover__label">${escapeHtml(item.label)}</span><span class="gsr-badge-popover__value">${escapeHtml(item.value)}</span></div>`)
        .join('');
    popover.classList.add('is-visible');
    popover.setAttribute('aria-hidden', 'false');
    const rect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    let left = rect.left + (rect.width / 2) - (popoverRect.width / 2);
    let top = rect.bottom + 10;
    const maxLeft = window.innerWidth - popoverRect.width - 12;
    left = Math.max(12, Math.min(left, maxLeft));
    if (top + popoverRect.height > window.innerHeight - 12) {
        top = rect.top - popoverRect.height - 10;
    }
    popover.style.left = `${Math.max(12, left)}px`;
    popover.style.top = `${Math.max(12, top)}px`;
}
function attachBadgeDetailBehavior(badge, rank, system, reason = null, meta = null) {
    const items = buildBadgeDetailItems(rank, system, reason, meta);
    if (!items.length) {
        return;
    }
    badge.setAttribute('title', items.map(item => `${item.label}: ${item.value}`).join('\n'));
    badge.setAttribute('aria-describedby', BADGE_POPOVER_ID);
    const show = () => showBadgePopover(badge, items);
    badge.addEventListener('mouseenter', show);
    badge.addEventListener('focus', show);
    badge.addEventListener('mouseleave', () => hideBadgePopover(false));
    badge.addEventListener('blur', () => hideBadgePopover(false));
}
function setRowRankingMetadata(rowElement, info) {
    if (!rowElement || !info)
        return;
    const statusKind = getRowStatusKind(info);
    rowElement.dataset.gsrSystem = String(info.system || 'UNKNOWN').toLowerCase();
    rowElement.dataset.gsrRank = normalizeRankKey(info.rank || 'N/A');
    rowElement.dataset.gsrStatus = statusKind;
    rowElement.classList.toggle('gsr-row--needs-review', statusKind !== 'ranked');
    rowElement.classList.toggle('gsr-row--ranked', statusKind === 'ranked');
}
function isSameSummaryFilter(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
function getEffectiveSummaryFilter() {
    return previewSummaryFilter ?? activeSummaryFilter;
}
function matchesSummaryFilter(rowElement, filter) {
    if (!filter || !rowElement)
        return true;
    const status = rowElement.dataset.gsrStatus || '';
    const system = rowElement.dataset.gsrSystem || '';
    const rank = rowElement.dataset.gsrRank || '';
    if (filter.type === 'preset') {
        if (filter.mode === 'ranked-only') {
            return status === 'ranked';
        }
        if (filter.mode === 'needs-review') {
            return status === 'dblp-missing' || status === 'unranked';
        }
        return true;
    }
    if (filter.type === 'status') {
        return status === filter.status;
    }
    return system === filter.system && rank === filter.rank;
}
function syncSummaryFilterButtons() {
    const panel = document.getElementById(SUMMARY_PANEL_ID);
    if (!panel)
        return;
    panel.classList.toggle('gsr-summary-card--has-active-filter', !!activeSummaryFilter);
    panel.classList.toggle('gsr-summary-card--has-rank-selection', activeSummaryFilter?.type === 'rank' || activeSummaryFilter?.type === 'status');
    panel.querySelectorAll('[data-gsr-filter-type]').forEach((button) => {
        let isActive = false;
        let isPreviewed = false;
        const type = button.getAttribute('data-gsr-filter-type');
        if (type === 'reset') {
            isActive = !activeSummaryFilter;
        }
        else if (type === 'rank' && activeSummaryFilter?.type === 'rank') {
            isActive = activeSummaryFilter.system === button.getAttribute('data-gsr-system')
                && activeSummaryFilter.rank === button.getAttribute('data-gsr-rank');
        }
        else if (type === 'status' && activeSummaryFilter?.type === 'status') {
            isActive = activeSummaryFilter.status === button.getAttribute('data-gsr-status');
        }
        else if (type === 'preset' && activeSummaryFilter?.type === 'preset') {
            isActive = activeSummaryFilter.mode === button.getAttribute('data-gsr-mode');
        }
        if (type === 'rank' && previewSummaryFilter?.type === 'rank') {
            isPreviewed = previewSummaryFilter.system === button.getAttribute('data-gsr-system')
                && previewSummaryFilter.rank === button.getAttribute('data-gsr-rank');
        }
        else if (type === 'status' && previewSummaryFilter?.type === 'status') {
            isPreviewed = previewSummaryFilter.status === button.getAttribute('data-gsr-status');
        }
        else if (type === 'preset' && previewSummaryFilter?.type === 'preset') {
            isPreviewed = previewSummaryFilter.mode === button.getAttribute('data-gsr-mode');
        }
        button.classList.toggle('is-active', isActive);
        button.classList.toggle('is-previewed', !isActive && isPreviewed);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}
function applyActiveSummaryFilter() {
    const effectiveFilter = getEffectiveSummaryFilter();
    const hasPreview = !!previewSummaryFilter;
    const hasActiveSelection = !!activeSummaryFilter && !hasPreview;
    document.querySelectorAll('tr.gsc_a_tr').forEach((row) => {
        const matches = matchesSummaryFilter(row, effectiveFilter);
        row.classList.toggle('gsr-row--dimmed', !!effectiveFilter && !matches);
        row.classList.toggle('gsr-row--highlighted', !!effectiveFilter && matches);
        row.classList.toggle('gsr-row--selected', hasActiveSelection);
        row.classList.toggle('gsr-row--preview', hasPreview);
        row.classList.toggle('gsr-row--dimmed-strong', hasActiveSelection && !matches);
        row.classList.toggle('gsr-row--highlighted-strong', hasActiveSelection && matches);
    });
    syncSummaryFilterButtons();
}
function toggleSummaryFilter(nextFilter) {
    const sameFilter = isSameSummaryFilter(activeSummaryFilter, nextFilter);
    activeSummaryFilter = sameFilter ? null : nextFilter;
    previewSummaryFilter = null;
    applyActiveSummaryFilter();
}
function setSummaryFilterPreview(nextFilter) {
    if (isSameSummaryFilter(previewSummaryFilter, nextFilter)) {
        return;
    }
    previewSummaryFilter = nextFilter;
    applyActiveSummaryFilter();
}
function clearSummaryFilterPreview(nextFilter) {
    if (!isSameSummaryFilter(previewSummaryFilter, nextFilter)) {
        return;
    }
    previewSummaryFilter = null;
    applyActiveSummaryFilter();
}

function createRankBadgeElement(rank, system, reason = null, meta = null) {
    const badge = document.createElement('span');
    badge.classList.add('gsr-rank-badge');
    badge.dataset.gsrSystem = String(system || 'unknown').toLowerCase();
    if (rank === 'N/A' && reason) {
        if (String(reason).toLowerCase() === 'extended abstract') {
            badge.textContent = 'N/A: Extended Abstract';
        }
        else if (String(reason).toLowerCase() === 'demo/poster') {
            badge.textContent = 'N/A: Demo/Poster';
        }
        else {
            badge.textContent = `N/A: ${reason}`;
        }
    }
    else {
        badge.textContent = rank;
    }
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('aria-label', `${system} ${badge.textContent}`);
    const usePill = system === 'CORE' && !!reason;

    if (system === 'DBLP' && rank === DBLP_ENTRY_MISSING_LABEL) {
        badge.classList.add('badge-missing-dblp', 'gsr-rank-badge--pill', 'gsr-rank-badge--neutral');
        badge.dataset.gsrKind = 'dblp-missing';
        badge.setAttribute('title', DBLP_ENTRY_MISSING_TOOLTIP);
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    if (system === 'SJR' && SJR_QUARTILES.includes(rank)) {
        badge.classList.add('gsr-rank-badge--sjr', 'gsr-rank-badge--circular', `gsr-rank-badge--${rank.toLowerCase()}`);
        badge.dataset.gsrKind = 'ranked';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    if (system === 'CORE' && VALID_RANKS.includes(rank)) {
        badge.classList.add('gsr-rank-badge--core', 'gsr-rank-badge--pill', `gsr-rank-badge--${normalizeRankKey(rank)}`);
        badge.dataset.gsrKind = 'ranked';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    if (rank === 'N/A') {
        badge.classList.add('gsr-rank-badge--neutral');
        badge.classList.add((system === 'SJR' && !usePill) ? 'gsr-rank-badge--circular' : 'gsr-rank-badge--pill');
        badge.dataset.gsrKind = 'unranked';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    return null;
}
function displayRankBadgeAfterTitle(rowElement, rank, system, reason = null, meta = null) {
    const titleCell = rowElement.querySelector('td.gsc_a_t');
    if (titleCell) {
        const oldBadge = titleCell.querySelector('span.gsr-rank-badge-inline');
        oldBadge?.remove(); // Ensure any previous badge is cleared first
    }
    else {
        return; // No title cell found
    }
    // Original logic: if (!VALID_RANKS.includes(rank)) return;
    // We DO want to create N/A badges if rank is "N/A" via createRankBadgeElement
    // So, only return if createRankBadgeElement itself returns null (e.g. invalid rank string not in VALID_RANKS and not N/A)
    const titleLinkElement = rowElement.querySelector('td.gsc_a_t a.gsc_a_at');
    if (!titleLinkElement)
        return;
    const badge = createRankBadgeElement(rank, system, reason, meta); // Can return N/A badge or null
    if (badge) {
        badge.classList.add('gsr-rank-badge-inline');
        titleLinkElement.insertAdjacentElement('afterend', badge);
    }
    setRowRankingMetadata(rowElement, { rank, system, reason, ...(meta || {}) });
    if (activeSummaryFilter || previewSummaryFilter) {
        applyActiveSummaryFilter();
    }
}

// --- START: Manual Rank/Quartile Search Utility (Phase 2) ---
async function populateVenueDatalistIfNeeded() {
    if (gsrVenueDatalistPopulated)
        return;
    gsrVenueDatalistPopulated = true;
    try {
        const datalistId = 'gsr-venue-datalist';
        let datalist = document.getElementById(datalistId);
        if (!datalist) {
            datalist = document.createElement('datalist');
            datalist.id = datalistId;
            document.body.appendChild(datalist);
        }
        const coreData = await loadCoreDataForFile('core/CORE_2026.json');
        const seen = new Set();
        for (const entry of coreData) {
            const candidates = [entry.acronym, entry.title].filter(Boolean);
            for (const c of candidates) {
                const val = String(c || '').trim();
                if (!val)
                    continue;
                const key = val.toLowerCase();
                if (seen.has(key))
                    continue;
                seen.add(key);
                const opt = document.createElement('option');
                opt.value = val;
                datalist.appendChild(opt);
            }
        }
    }
    catch (err) {
        console.warn('GSR: Failed to populate venue autocomplete list.', err);
        // allow retry next time
        gsrVenueDatalistPopulated = false;
    }
}

function ensureSearchUtilityOverlay() {
    if (gsrSearchOverlayEl && document.body.contains(gsrSearchOverlayEl)) {
        return gsrSearchOverlayEl;
    }
    const overlay = document.createElement('div');
    overlay.className = 'search-utility-overlay';
    overlay.id = 'gsr-search-utility-overlay';
    const panel = document.createElement('div');
    panel.className = 'gsr-search-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'gsr-search-panel-title');
    panel.setAttribute('aria-describedby', 'gsr-search-panel-description');
    const header = document.createElement('div');
    header.className = 'gsr-search-panel__header';
    const titleGroup = document.createElement('div');
    const title = document.createElement('h3');
    title.id = 'gsr-search-panel-title';
    title.textContent = 'Search Ranking (CORE / SJR)';
    titleGroup.appendChild(title);
    const description = document.createElement('p');
    description.id = 'gsr-search-panel-description';
    description.className = 'gsr-search-panel__description';
    description.textContent = 'Search the local CORE and SJR datasets without leaving Google Scholar.';
    titleGroup.appendChild(description);
    header.appendChild(titleGroup);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'gsr-icon-button';
    closeButton.setAttribute('aria-label', 'Close ranking search');
    closeButton.textContent = '×';
    header.appendChild(closeButton);
    panel.appendChild(header);
    const row1 = document.createElement('div');
    row1.className = 'gsr-search-row';
    const venueLabel = document.createElement('label');
    venueLabel.className = 'gsr-search-label';
    venueLabel.htmlFor = 'gsr-venue-search-input';
    venueLabel.textContent = 'Venue Name or Acronym';
    panel.appendChild(venueLabel);
    const venueInput = document.createElement('input');
    venueInput.type = 'text';
    venueInput.placeholder = 'Venue name or acronym (e.g., SIGCOMM, TPAMI)';
    venueInput.id = 'gsr-venue-search-input';
    venueInput.name = 'venue';
    venueInput.autocomplete = 'off';
    venueInput.setAttribute('list', 'gsr-venue-datalist');
    row1.appendChild(venueInput);
    panel.appendChild(row1);
    const rowType = document.createElement('div');
    rowType.className = 'gsr-search-row gsr-search-type-row';
    const typeLabel = document.createElement('span');
    typeLabel.className = 'gsr-type-label';
    typeLabel.textContent = 'Type:';
    typeLabel.id = 'gsr-venue-type-label';
    rowType.appendChild(typeLabel);
    const mkRadio = (id, value, labelText, checked) => {
        const wrap = document.createElement('label');
        wrap.className = 'gsr-radio-wrap';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'gsr-venue-type';
        input.id = id;
        input.value = value;
        input.checked = !!checked;
        input.setAttribute('aria-labelledby', 'gsr-venue-type-label');
        const txt = document.createElement('span');
        txt.textContent = labelText;
        wrap.appendChild(input);
        wrap.appendChild(txt);
        return wrap;
    };

    rowType.appendChild(mkRadio('gsr-type-conference', 'conference', 'Conference', true));
    rowType.appendChild(mkRadio('gsr-type-journal', 'journal', 'Journal/Transaction', false));
    panel.appendChild(rowType);
    const row2 = document.createElement('div');
    row2.className = 'gsr-search-row';
    const yearLabel = document.createElement('label');
    yearLabel.className = 'gsr-search-label';
    yearLabel.htmlFor = 'gsr-venue-search-year';
    yearLabel.textContent = 'Publication Year';
    panel.appendChild(yearLabel);
    const yearSelect = document.createElement('select');
    yearSelect.id = 'gsr-venue-search-year';
    yearSelect.name = 'year';
    const yearAuto = document.createElement('option');
    yearAuto.value = '';
    yearAuto.textContent = 'Year (Auto)';
    yearSelect.appendChild(yearAuto);
    for (let y = 2026; y >= 2010; y--) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        yearSelect.appendChild(opt);
    }
    row2.appendChild(yearSelect);
    panel.appendChild(row2);
    const result = document.createElement('div');
    result.className = 'gsr-search-result';
    result.id = 'gsr-venue-search-result';
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    result.textContent = 'Choose type, enter a venue and (optionally) a year, then press Search.';
    panel.appendChild(result);
    const actions = document.createElement('div');
    actions.className = 'gsr-search-actions';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.textContent = 'Search';
    searchBtn.className = 'gsr-button gsr-button--primary';
    clearBtn.className = 'gsr-button gsr-button--ghost';
    closeButton.classList.add('gsr-icon-button');
    actions.appendChild(clearBtn);
    actions.appendChild(searchBtn);
    panel.appendChild(actions);
    const getFocusableElements = () => Array.from(panel.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'));
    const closeOverlay = (clear = true) => {
        overlay.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        hideBadgePopover(true);
        if (clear) {
            venueInput.value = '';
            yearSelect.value = '';
            result.textContent = 'Choose type, enter a venue and (optionally) a year, then press Search.';
        }
        if (gsrDialogLastFocusedEl instanceof HTMLElement) {
            gsrDialogLastFocusedEl.focus();
        }
    };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeOverlay(true);
        }
    });
    closeButton.addEventListener('click', () => closeOverlay(true));
    clearBtn.addEventListener('click', () => {
        venueInput.value = '';
        yearSelect.value = '';
        result.textContent = 'Choose type, enter a venue and (optionally) a year, then press Search.';
        venueInput.focus();
    });
    const doSearch = async () => {
        const venueQuery = String(venueInput.value || '').trim();
        if (!venueQuery) {
            result.textContent = 'Please enter a venue name or acronym.';
            venueInput.focus();
            return;
        }
        const yearVal = yearSelect.value ? parseInt(yearSelect.value, 10) : null;
        const selectedType = (panel.querySelector('input[name="gsr-venue-type"]:checked')?.value) || 'conference';
        result.textContent = 'Searching…';
        try {
            result.innerHTML = '';
            const addItem = (label, value) => {
                const line = document.createElement('div');
                line.className = 'gsr-result-item';
                const l = document.createElement('span');
                l.className = 'gsr-result-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.textContent = value;
                line.appendChild(l);
                line.appendChild(v);
                result.appendChild(line);
            };
            if (selectedType === 'conference') {
                const conferenceSearch = await resolveConferenceSearchQuery(venueQuery, yearVal);
                const primary = conferenceSearch.primary;
                const primaryYear = primary?.sourceYear ?? getCoreDatasetYear(getCoreDataFileForYear(yearVal));
                let primaryValue = 'Not found';
                if (primary.status === DECISION_STATUS.MATCHED && VALID_RANKS.includes(primary.rank)) {
                    primaryValue = primary.rank;
                }
                else if (primary.status === DECISION_STATUS.UNRANKED) {
                    primaryValue = 'Unranked';
                }
                else if (primary.status === DECISION_STATUS.AMBIGUOUS) {
                    primaryValue = 'Ambiguous';
                }
                addItem(`Conference (CORE ${primaryYear || ''}):`, primaryValue);
                if (primary.matchedVenue) {
                    addItem('Matched Venue:', primary.matchedVenue);
                }
                if (primary.status === DECISION_STATUS.UNRANKED && primary.rawRankLabel) {
                    addItem('Current CORE status:', formatCoreStatusLabel(primary.rawRankLabel));
                }
                if (conferenceSearch.latestRankedSnapshot
                    && conferenceSearch.latestRankedSnapshot.sourceYear
                    && conferenceSearch.latestRankedSnapshot.sourceYear !== primary.sourceYear) {
                    addItem('Latest ranked snapshot:', `CORE ${conferenceSearch.latestRankedSnapshot.sourceYear} · ${conferenceSearch.latestRankedSnapshot.rank}`);
                }
                if (primary.status === DECISION_STATUS.AMBIGUOUS) {
                    const note = document.createElement('div');
                    note.className = 'gsr-result-item';
                    note.textContent = 'Multiple CORE venues matched this query too closely. Please use a more specific venue title.';
                    result.appendChild(note);
                }
                else if (primary.status === DECISION_STATUS.UNRANKED) {
                    const note = document.createElement('div');
                    note.className = 'gsr-result-item';
                    note.textContent = conferenceSearch.latestRankedSnapshot
                        ? 'This venue exists in the current CORE snapshot but is not currently ranked there. The latest ranked snapshot is shown above.'
                        : 'This venue exists in the current CORE snapshot but is currently unranked there.';
                    result.appendChild(note);
                }
                else if (primary.status !== DECISION_STATUS.MATCHED) {
                    const note = document.createElement('div');
                    note.className = 'gsr-result-item';
                    note.textContent = conferenceSearch.latestRankedSnapshot
                        ? 'No ranked result was found in the selected CORE snapshot. The latest ranked snapshot is shown above.'
                        : 'No match was found in the bundled CORE snapshots for this query.';
                    result.appendChild(note);
                }
            }
            else {
                const sjr = await resolveSjrQuartile(venueQuery, yearVal);
                const sjrQuartile = (sjr.status === 'success' && sjr.quartile) ? sjr.quartile : null;
                addItem('Journal/Transaction (SJR):', (sjrQuartile && SJR_QUARTILES.includes(sjrQuartile)) ? sjrQuartile : 'Not found');
                if (sjr.status === 'success' && sjr.resolvedTitle) {
                    addItem('Matched Journal:', sjr.resolvedTitle);
                }
                if (!(sjrQuartile && SJR_QUARTILES.includes(sjrQuartile))) {
                    const note = document.createElement('div');
                    note.className = 'gsr-result-item';
                    note.textContent = 'No match in the local SJR dataset for this query.';
                    result.appendChild(note);
                }
            }
        }
        catch (err) {
            console.warn('GSR: Manual venue search failed.', err);
            result.textContent = 'Search failed. Please try again.';
        }
    };
    searchBtn.addEventListener('click', doSearch);
    venueInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeOverlay(true);
        }
    });
    yearSelect.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeOverlay(true);
        }
    });
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeOverlay(true);
            return;
        }
        if (e.key === 'Tab') {
            const focusable = getFocusableElements();
            if (focusable.length === 0)
                return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
            else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    panel.addEventListener('click', (e) => e.stopPropagation());
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    gsrSearchOverlayEl = overlay;
    return overlay;
}

function openSearchUtilityOverlay() {
    const overlay = ensureSearchUtilityOverlay();
    gsrDialogLastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add('is-open');
    overlay.querySelector('.gsr-search-panel')?.setAttribute('aria-hidden', 'false');
    populateVenueDatalistIfNeeded();
    setTimeout(() => {
        const input = document.getElementById('gsr-venue-search-input');
        if (input instanceof HTMLInputElement) {
            input.focus();
            input.select();
        }
    }, 0);
}

function createAboutSection(titleText, bodyNodes) {
    const section = document.createElement('section');
    section.className = 'gsr-about-panel__section';
    const title = document.createElement('h4');
    title.className = 'gsr-about-panel__section-title';
    title.textContent = titleText;
    section.appendChild(title);
    bodyNodes.forEach((node) => section.appendChild(node));
    return section;
}

function createAboutParagraph(text) {
    const paragraph = document.createElement('p');
    paragraph.className = 'gsr-about-panel__text';
    paragraph.textContent = text;
    return paragraph;
}

function createAboutList(items) {
    const list = document.createElement('ul');
    list.className = 'gsr-about-panel__list';
    items.forEach((item) => {
        const entry = document.createElement('li');
        entry.className = 'gsr-about-panel__list-item';
        if (typeof item === 'string') {
            entry.textContent = item;
        }
        else {
            if (item.title) {
                const strong = document.createElement('strong');
                strong.textContent = item.title;
                entry.appendChild(strong);
            }
            if (item.body) {
                entry.appendChild(document.createTextNode(item.title ? ` ${item.body}` : item.body));
            }
            if (Array.isArray(item.extraNodes)) {
                item.extraNodes.forEach((node) => entry.appendChild(node));
            }
        }
        list.appendChild(entry);
    });
    return list;
}

function ensureAboutOverlay() {
    if (gsrAboutOverlayEl && document.body.contains(gsrAboutOverlayEl)) {
        return gsrAboutOverlayEl;
    }
    const overlay = document.createElement('div');
    overlay.className = 'search-utility-overlay';
    overlay.id = 'gsr-about-overlay';
    const panel = document.createElement('div');
    panel.className = 'gsr-search-panel gsr-about-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'gsr-about-panel-title');
    panel.setAttribute('aria-describedby', 'gsr-about-panel-description');
    const header = document.createElement('div');
    header.className = 'gsr-search-panel__header';
    const titleGroup = document.createElement('div');
    const title = document.createElement('h3');
    title.id = 'gsr-about-panel-title';
    title.textContent = 'About Google Scholar Venue Ranker';
    titleGroup.appendChild(title);
    const description = document.createElement('p');
    description.id = 'gsr-about-panel-description';
    description.className = 'gsr-search-panel__description';
    description.textContent = 'Open-source ranking logic, data sources, and editorial rules used by the extension.';
    titleGroup.appendChild(description);
    header.appendChild(titleGroup);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'gsr-icon-button';
    closeButton.setAttribute('aria-label', 'Close about panel');
    closeButton.textContent = '×';
    header.appendChild(closeButton);
    panel.appendChild(header);
    const content = document.createElement('div');
    content.className = 'gsr-about-panel__content';
    const intro = document.createElement('p');
    intro.className = 'gsr-about-panel__lede';
    intro.textContent = 'This is an open-source extension developed by ';
    const authorLink = document.createElement('a');
    authorLink.href = 'https://naveedanwarbhatti.github.io/';
    authorLink.target = '_blank';
    authorLink.rel = 'noopener noreferrer';
    authorLink.textContent = 'Naveed Bhatti';
    intro.appendChild(authorLink);
    intro.appendChild(document.createTextNode('. It aims to make Google Scholar publication lists more trustworthy by resolving venues against curated bibliographic sources instead of relying on profile text alone.'));
    content.appendChild(intro);
    content.appendChild(createAboutSection('Why We Trust DBLP for Venue Extraction', [
        createAboutParagraph('Google Scholar profiles are useful for discovery, but profile entries can be added or edited by users and sometimes contain noisy or incomplete venue text. When a paper can be matched to DBLP, the extension treats DBLP as the authoritative source for venue extraction because it is curated bibliographic metadata, not free-form profile text.')
    ]));
    content.appendChild(createAboutSection('Why We Use CORE and SJR', [
        createAboutList([
            {
                title: 'CORE for conferences.',
                body: 'CORE provides the conference ranking source used by the extension, so conference venues are normalized against CORE labels such as A*, A, B, and C.'
            },
            {
                title: 'SJR for journals.',
                body: 'SCImago Journal Rank data is used for journal quartiles, so journals and transactions are resolved to Q1, Q2, Q3, or Q4 when a trusted match exists.'
            },
            {
                title: 'Precision before guessing.',
                body: 'If a venue match is ambiguous or unsupported, the extension prefers to abstain and show review-needed or unranked states rather than assign a risky label.'
            }
        ])
    ]));
    content.appendChild(createAboutSection('Editorial Rules and Heuristics', [
        createAboutList([
            {
                title: 'Short papers are excluded.',
                body: 'Publications with fewer than 6 pages are treated as short papers and are not counted toward ranking. This follows the same general CSRankings-style heuristic used to avoid inflating venue quality with short-format track entries.'
            },
            {
                title: 'Workshop, demo, poster, and extended-abstract tracks are filtered.',
                body: 'The ranker uses title, venue, DBLP metadata, crossref hints, and page-count signals to identify non-main-track publications and keep them out of the ranked totals.'
            },
            {
                title: 'Conference proceedings published in journals can still map back to the conference.',
                body: 'Special venue overrides are used for cases such as proceedings-style journals so the extension can preserve conference intent when the bibliographic record is published through a journal series.'
            },
            {
                title: 'Scholar text is supporting evidence, not final authority.',
                body: 'Scholar snippets are still used to help with matching and display, but final venue decisions come from the DBLP plus CORE/SJR pipeline whenever a verified match is available.'
            }
        ])
    ]));
    content.appendChild(createAboutSection('What the Extension Optimizes For', [
        createAboutList([
            'Reduce false positives by rejecting weak or ambiguous venue matches.',
            'Reduce false negatives by canonicalizing acronyms, aliases, and proceedings variants before giving up.',
            'Show review-needed states when the data is incomplete instead of silently hiding uncertainty.'
        ])
    ]));
    panel.appendChild(content);
    const actions = document.createElement('div');
    actions.className = 'gsr-search-actions';
    const closeAction = document.createElement('button');
    closeAction.type = 'button';
    closeAction.className = 'gsr-button gsr-button--primary';
    closeAction.textContent = 'Close';
    actions.appendChild(closeAction);
    panel.appendChild(actions);
    const getFocusableElements = () => Array.from(panel.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'));
    const closeOverlay = () => {
        overlay.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        if (gsrDialogLastFocusedEl instanceof HTMLElement) {
            gsrDialogLastFocusedEl.focus();
        }
    };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeOverlay();
        }
    });
    closeButton.addEventListener('click', closeOverlay);
    closeAction.addEventListener('click', closeOverlay);
    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeOverlay();
            return;
        }
        if (e.key === 'Tab') {
            const focusable = getFocusableElements();
            if (focusable.length === 0)
                return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
            else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    gsrAboutOverlayEl = overlay;
    return overlay;
}

function openAboutOverlay() {
    const overlay = ensureAboutOverlay();
    gsrDialogLastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add('is-open');
    overlay.querySelector('.gsr-about-panel')?.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        const closeButton = overlay.querySelector('.gsr-button--primary');
        if (closeButton instanceof HTMLButtonElement) {
            closeButton.focus();
        }
    }, 0);
}
// --- END: Manual Rank/Quartile Search Utility (Phase 2) ---
function createStatusElement(initialMessage = "Initializing...") {
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    const container = document.createElement('div');
    container.id = STATUS_ELEMENT_ID;
    container.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-status-card';
    const title = document.createElement('div');
    title.className = 'gsr-card__title';
    title.textContent = "Rank Processing";
    container.appendChild(title);
    const progressBarOuter = document.createElement('div');
    progressBarOuter.className = 'gsr-progress';
    container.appendChild(progressBarOuter);
    const progressBarInner = document.createElement('div');
    progressBarInner.classList.add('gsr-progress-bar-inner');
    progressBarInner.style.width = '0%';
    progressBarOuter.appendChild(progressBarInner);
    const statusText = document.createElement('div');
    statusText.classList.add('gsr-status-text');
    statusText.setAttribute('aria-live', 'polite');
    statusText.textContent = initialMessage;
    container.appendChild(statusText);
    const gsBdy = document.getElementById('gs_bdy');
    if (!gsBdy) {
        document.body.prepend(container);
        return container;
    }
    const rightSidebarContainer = gsBdy.querySelector('div.gsc_rsb');
    if (rightSidebarContainer) {
        const citedByElement = rightSidebarContainer.querySelector('#gsc_rsb_cit');
        const publicAccessElement = rightSidebarContainer.querySelector('#gsc_rsb_mnd');
        const coauthorsElement = rightSidebarContainer.querySelector('#gsc_rsb_co');
        if (publicAccessElement)
            rightSidebarContainer.insertBefore(container, publicAccessElement);
        else if (coauthorsElement)
            rightSidebarContainer.insertBefore(container, coauthorsElement);
        else if (citedByElement?.nextSibling)
            rightSidebarContainer.insertBefore(container, citedByElement.nextSibling);
        else if (citedByElement)
            citedByElement.parentNode?.appendChild(container);
        else
            rightSidebarContainer.prepend(container);
    }
    else {
        const profileTableContainer = document.getElementById('gsc_a_c');
        if (profileTableContainer)
            profileTableContainer.before(container);
        else
            document.body.prepend(container);
    }
    return container;
}
function updateStatusElement(statusContainer, processed, total, messagePrefix) {
    const progressBarInner = statusContainer.querySelector('.gsr-progress-bar-inner');
    const statusText = statusContainer.querySelector('.gsr-status-text');
    const percentage = total > 0 ? (processed / total) * 100 : 0;
    if (progressBarInner)
        progressBarInner.style.width = `${percentage}%`;
    const prefix = messagePrefix ? messagePrefix + ": " : "";
    if (statusText)
        statusText.textContent = `${prefix}Processing ${processed} of ${total} publications…`;
}
function displayDormantStatus() {
    const statusElement = createStatusElement("Auto-run is off for this Scholar profile.");
    statusElement.querySelector('.gsr-progress')?.remove();
    const statusText = statusElement.querySelector('.gsr-status-text');
    if (statusText) {
        statusText.textContent = 'Turn on auto-run in the extension popup or start analysis manually here.';
    }
    const actions = document.createElement('div');
    actions.className = 'gsr-card__actions gsr-card__actions--stack';
    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.className = 'gsr-button gsr-button--primary';
    runButton.textContent = 'Run Analysis';
    runButton.addEventListener('click', () => {
        document.getElementById(STATUS_ELEMENT_ID)?.remove();
        main().catch(error => console.error('GSR: Error while manually starting analysis.', error));
    });
    actions.appendChild(runButton);
    const searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.className = 'gsr-button gsr-button--ghost';
    searchButton.textContent = 'Open Search Utility';
    searchButton.addEventListener('click', () => openSearchUtilityOverlay());
    actions.appendChild(searchButton);
    statusElement.appendChild(actions);
    return statusElement;
}
function displaySummaryPanel(coreRankCounts, sjrRankCounts, currentUserId, initialCachedPubRanks, cacheTimestamp, dblpAuthorPid // New parameter for DBLP PID
) {
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    disconnectPublicationTableObserver();
    hideBadgePopover(true);
    const statusCounts = { 'DBLP Entry Missing': 0, 'Unranked': 0 };
    for (const item of initialCachedPubRanks || []) {
        if (!item || item.system === 'UNKNOWN') {
            continue;
        }
        const kind = getRowStatusKind(item);
        if (kind === 'dblp-missing') {
            statusCounts['DBLP Entry Missing'] += 1;
        }
        else if (kind === 'unranked') {
            statusCounts['Unranked'] += 1;
        }
    }
    const sumCounts = (counts) => Object.values(counts || {}).reduce((total, value) => total + (Number(value) || 0), 0);
    const totalConferencePapers = sumCounts(coreRankCounts);
    const totalJournalPapers = sumCounts(sjrRankCounts);
    const totalReviewPapers = sumCounts(statusCounts);
    const totalTrackedPapers = totalConferencePapers + totalJournalPapers + totalReviewPapers;
    const panel = document.createElement('div');
    panel.id = SUMMARY_PANEL_ID;
    panel.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-summary-card';
    const headerDiv = document.createElement('div');
    headerDiv.className = 'gsr-card__header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'gsr-card__title-group';
    const titleLine = document.createElement('div');
    titleLine.className = 'gsr-card__title-line';
    const summaryTitle = document.createElement('span');
    summaryTitle.className = 'gsr-card__title';
    summaryTitle.textContent = 'Venue Ranks';
    titleLine.appendChild(summaryTitle);
    const summaryCount = document.createElement('span');
    summaryCount.className = 'gsr-pill gsr-pill--accent gsr-summary-total';
    summaryCount.textContent = `${totalTrackedPapers} paper${totalTrackedPapers === 1 ? '' : 's'}`;
    titleLine.appendChild(summaryCount);
    titleGroup.appendChild(titleLine);
    const summarySubtitle = document.createElement('span');
    summarySubtitle.className = 'gsr-card__subtitle';
    summarySubtitle.textContent = totalReviewPapers > 0
        ? `${totalConferencePapers + totalJournalPapers} ranked | ${totalReviewPapers} review`
        : `${totalConferencePapers + totalJournalPapers} ranked`;
    titleGroup.appendChild(summarySubtitle);
    headerDiv.appendChild(titleGroup);
    if (currentUserId) {
        const headerActions = document.createElement('div');
        headerActions.className = 'gsr-summary-header__actions';
        const refreshButton = document.createElement('button');
        refreshButton.type = 'button';
        refreshButton.className = 'gsr-summary-refresh';
        refreshButton.setAttribute('title', 'Recalculate rankings for this Scholar profile');
        refreshButton.setAttribute('aria-label', 'Refresh rankings');
        const refreshIcon = document.createElement('span');
        refreshIcon.className = 'gsr-summary-refresh__icon';
        refreshIcon.setAttribute('aria-hidden', 'true');
        refreshIcon.textContent = '↻';
        const refreshLabel = document.createElement('span');
        refreshLabel.className = 'gsr-summary-refresh__label';
        refreshLabel.textContent = 'Refresh';
        refreshButton.appendChild(refreshIcon);
        refreshButton.appendChild(refreshLabel);
        refreshButton.onclick = async () => {
            if (isMainProcessing)
                return;
            disconnectPublicationTableObserver();
            activeCachedPublicationRanks = null;
            rankMapForObserver = null;
            activeSummaryFilter = null;
            previewSummaryFilter = null;
            document.getElementById(STATUS_ELEMENT_ID)?.remove();
            document.getElementById(SUMMARY_PANEL_ID)?.remove();
            if (currentUserId) {
                await clearCachedData(currentUserId);
            }
            main().catch(error => {
                console.error('DEBUG: Error during refresh after cache clear:', error);
                const statusElemCheck = document.getElementById(STATUS_ELEMENT_ID);
                if (!statusElemCheck) {
                    const statusElem = createStatusElement('Error during refresh. Check console.');
                    const progress = statusElem.querySelector('.gsr-progress-bar-inner');
                    if (progress) {
                        progress.style.backgroundColor = 'red';
                    }
                }
            });
        };
        headerActions.appendChild(refreshButton);
        headerDiv.appendChild(headerActions);
    }
    panel.appendChild(headerDiv);
    const attachSummaryFilterInteractions = (element, filter, { preview = true } = {}) => {
        element.addEventListener('click', () => toggleSummaryFilter(filter));
        if (!preview) {
            return;
        }
        element.addEventListener('mouseenter', () => setSummaryFilterPreview(filter));
        element.addEventListener('focus', () => setSummaryFilterPreview(filter));
        element.addEventListener('mouseleave', () => clearSummaryFilterPreview(filter));
        element.addEventListener('blur', () => clearSummaryFilterPreview(filter));
    };
    const summarySectionsContainer = document.createElement('div');
    summarySectionsContainer.className = 'gsr-summary-sections';
    const createSummaryBadge = (rank, system, chipText = null) => {
        if (chipText) {
            const chip = document.createElement('span');
            chip.className = 'gsr-rank-badge gsr-rank-badge--pill gsr-rank-badge--neutral gsr-summary-row__badge gsr-summary-row__status-chip';
            chip.dataset.gsrStatusChip = normalizeRankKey(rank);
            chip.textContent = chipText;
            return chip;
        }
        const badge = createRankBadgeElement(rank, system, null, null);
        if (!badge) {
            const fallback = document.createElement('span');
            fallback.className = 'gsr-rank-badge gsr-rank-badge--pill gsr-rank-badge--neutral gsr-summary-row__badge';
            fallback.textContent = rank;
            return fallback;
        }
        badge.classList.add('gsr-summary-row__badge');
        badge.removeAttribute('tabindex');
        badge.removeAttribute('aria-describedby');
        return badge;
    };
    const createSummarySection = ({ titleText, metaText = '', counts, orderedRanks, system, getFilter, getLabel, getInlineLabel = () => '', getChipText = () => null }) => {
        const sectionWrapper = document.createElement('div');
        sectionWrapper.className = 'gsr-summary-section';
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'gsr-summary-section__header';
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'gsr-summary-section__title';
        sectionTitle.textContent = titleText;
        sectionHeader.appendChild(sectionTitle);
        const sectionMeta = document.createElement('span');
        sectionMeta.className = 'gsr-summary-section__meta';
        const sectionTotal = orderedRanks.reduce((total, rank) => total + (counts[rank] || 0), 0);
        sectionMeta.textContent = metaText ? `${metaText} ${sectionTotal}` : `${sectionTotal}`;
        sectionHeader.appendChild(sectionMeta);
        sectionWrapper.appendChild(sectionHeader);
        const list = document.createElement('div');
        list.className = 'gsr-summary-section__list';
        const displayRanks = orderedRanks.slice();
        let maxCountForScale = Math.max(1, ...displayRanks.map(rank => counts[rank] || 0));
        if (!Number.isFinite(maxCountForScale) || maxCountForScale <= 0)
            maxCountForScale = 1;
        for (const rank of displayRanks) {
            const count = counts[rank] || 0;
            const itemButton = document.createElement('button');
            itemButton.type = 'button';
            itemButton.className = 'gsr-summary-row';
            const filter = getFilter(rank);
            if (filter.type === 'rank') {
                itemButton.setAttribute('data-gsr-filter-type', 'rank');
                itemButton.setAttribute('data-gsr-system', filter.system);
                itemButton.setAttribute('data-gsr-rank', filter.rank);
            }
            else if (filter.type === 'status') {
                itemButton.setAttribute('data-gsr-filter-type', 'status');
                itemButton.setAttribute('data-gsr-status', filter.status);
            }
            attachSummaryFilterInteractions(itemButton, filter);
            itemButton.setAttribute('aria-label', `${titleText} ${getLabel(rank)} ${count} paper${count === 1 ? '' : 's'}`);
            itemButton.appendChild(createSummaryBadge(rank, system, getChipText(rank)));
            const mainContent = document.createElement('div');
            mainContent.className = 'gsr-summary-row__main';
            const inlineLabelText = getInlineLabel(rank);
            if (inlineLabelText) {
                const textLabel = document.createElement('span');
                textLabel.className = 'gsr-summary-row__label';
                textLabel.textContent = inlineLabelText;
                mainContent.appendChild(textLabel);
            }
            const barContainer = document.createElement('div');
            barContainer.className = 'gsr-summary-row__bar';
            const barFill = document.createElement('div');
            const percentageWidth = maxCountForScale > 0 ? (count / maxCountForScale) * 100 : 0;
            barFill.className = 'gsr-summary-row__bar-fill';
            barFill.style.width = `${Math.min(percentageWidth, 100)}%`;
            if (rank) {
                barFill.dataset.gsrRank = normalizeRankKey(rank);
            }
            barContainer.appendChild(barFill);
            mainContent.appendChild(barContainer);
            mainContent.classList.toggle('is-bar-only', !inlineLabelText);
            itemButton.appendChild(mainContent);
            const countTextSpan = document.createElement('span');
            countTextSpan.className = 'gsr-summary-row__count';
            countTextSpan.textContent = `${count}`;
            countTextSpan.setAttribute('aria-label', `${count} paper${count === 1 ? '' : 's'}`);
            countTextSpan.setAttribute('title', `${count} paper${count === 1 ? '' : 's'}`);
            itemButton.appendChild(countTextSpan);
            list.appendChild(itemButton);
        }
        sectionWrapper.appendChild(list);
        return sectionWrapper;
    };
    summarySectionsContainer.appendChild(createSummarySection({
        titleText: 'Conference',
        metaText: 'CORE',
        counts: coreRankCounts,
        orderedRanks: ['A*', 'A', 'B', 'C'],
        system: 'CORE',
        getFilter: (rank) => ({ type: 'rank', system: 'core', rank: normalizeRankKey(rank) }),
        getLabel: (rank) => rank
    }));
    summarySectionsContainer.appendChild(createSummarySection({
        titleText: 'Journal',
        metaText: 'SJR',
        counts: sjrRankCounts,
        orderedRanks: ['Q1', 'Q2', 'Q3', 'Q4'],
        system: 'SJR',
        getFilter: (rank) => ({ type: 'rank', system: 'sjr', rank: normalizeRankKey(rank) }),
        getLabel: (rank) => rank
    }));
    summarySectionsContainer.appendChild(createSummarySection({
        titleText: 'Review',
        counts: statusCounts,
        orderedRanks: ['DBLP Entry Missing', 'Unranked'],
        system: 'CORE',
        getFilter: (rank) => ({
            type: 'status',
            status: rank === 'DBLP Entry Missing' ? 'dblp-missing' : 'unranked'
        }),
        getLabel: (rank) => rank,
        getInlineLabel: (rank) => rank === 'DBLP Entry Missing' ? 'Missing' : 'Unranked',
        getChipText: (rank) => rank === 'DBLP Entry Missing' ? 'DBLP' : 'N/A'
    }));
    panel.appendChild(summarySectionsContainer);
    const finalFooterDiv = document.createElement('div');
    finalFooterDiv.className = 'gsr-card__footer gsr-summary-footer';
    const footerMeta = document.createElement('div');
    footerMeta.className = 'gsr-summary-footer__meta';
    if (dblpAuthorPid) {
        const dblpProfileLink = document.createElement('a');
        dblpProfileLink.href = `https://dblp.org/pid/${dblpAuthorPid}.html`;
        dblpProfileLink.target = '_blank';
        dblpProfileLink.rel = 'noopener noreferrer';
        dblpProfileLink.className = 'gsr-summary-meta__link gsr-summary-meta__link--profile';
        dblpProfileLink.textContent = 'DBLP Profile';
        dblpProfileLink.setAttribute('title', 'Open your DBLP profile in a new tab');
        footerMeta.appendChild(dblpProfileLink);
    }
    if (cacheTimestamp) {
        const timestampTextElement = document.createElement('span');
        timestampTextElement.className = 'gsr-summary-footer__stamp';
        const lastRankingTime = new Date(cacheTimestamp);
        const formattedDate = lastRankingTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const formattedTime = lastRankingTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        timestampTextElement.textContent = `Updated ${formattedDate} ${formattedTime}`;
        footerMeta.appendChild(timestampTextElement);
    }
    if (footerMeta.childNodes.length > 0) {
        finalFooterDiv.appendChild(footerMeta);
    }
    const footerActions = document.createElement('div');
    footerActions.className = 'gsr-summary-footer__actions';
    const createFooterAction = ({ label, badgeText, title, href = null, variant = 'neutral', onClick = null }) => {
        const element = href ? document.createElement('a') : document.createElement('button');
        if (href) {
            element.href = href;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
        }
        else {
            element.type = 'button';
        }
        element.className = `gsr-summary-footer__action gsr-summary-footer__action--${variant}`;
        element.setAttribute('title', title);
        if (typeof onClick === 'function') {
            element.addEventListener('click', onClick);
        }
        const icon = document.createElement('span');
        icon.className = 'gsr-summary-footer__action-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = badgeText;
        const text = document.createElement('span');
        text.className = 'gsr-summary-footer__action-label';
        text.textContent = label;
        element.appendChild(icon);
        element.appendChild(text);
        return element;
    };
    footerActions.appendChild(createFooterAction({
        label: 'Search',
        badgeText: 'S',
        title: 'Search ranking in the bundled CORE and SJR datasets',
        variant: 'search',
        onClick: () => openSearchUtilityOverlay()
    }));
    footerActions.appendChild(createFooterAction({
        label: 'Report',
        badgeText: '!',
        title: 'Report a bug or inconsistency (opens new tab)',
        href: 'https://forms.office.com/r/PbSzWaQmpJ',
        variant: 'report'
    }));
    footerActions.appendChild(createFooterAction({
        label: 'About',
        badgeText: 'i',
        title: 'About the extension, ranking sources, and editorial rules',
        variant: 'about',
        onClick: () => openAboutOverlay()
    }));
    finalFooterDiv.appendChild(footerActions);
    panel.appendChild(finalFooterDiv);
    const gsBdy = document.getElementById('gs_bdy');
    const rightSidebarContainer = gsBdy?.querySelector('div.gsc_rsb');
    if (rightSidebarContainer) {
        const publicAccessElement = rightSidebarContainer.querySelector('#gsc_rsb_mnd');
        const coauthorsElement = rightSidebarContainer.querySelector('#gsc_rsb_co');
        const citedByElement = rightSidebarContainer.querySelector('#gsc_rsb_cit');
        if (publicAccessElement)
            rightSidebarContainer.insertBefore(panel, publicAccessElement);
        else if (coauthorsElement)
            rightSidebarContainer.insertBefore(panel, coauthorsElement);
        else if (citedByElement?.nextSibling)
            rightSidebarContainer.insertBefore(panel, citedByElement.nextSibling);
        else if (citedByElement)
            citedByElement.parentNode?.appendChild(panel);
        else
            rightSidebarContainer.prepend(panel);
    }
    else {
        const profileTableContainer = document.getElementById('gsc_a_c');
        if (profileTableContainer)
            profileTableContainer.before(panel);
        else
            document.body.prepend(panel);
    }
    if (initialCachedPubRanks && initialCachedPubRanks.length > 0) {
        activeCachedPublicationRanks = initialCachedPubRanks;
        rankMapForObserver = new Map();
        activeCachedPublicationRanks.forEach(pubRank => {
            if (pubRank.url && pubRank.rank) {
                rankMapForObserver.set(pubRank.url, {
                    rank: pubRank.rank,
                    system: pubRank.system,
                    reason: pubRank.reason ?? null,
                    matchConfidence: pubRank.matchConfidence ?? null,
                    matchedVenue: pubRank.matchedVenue ?? null,
                    venueMatchConfidence: pubRank.venueMatchConfidence ?? null,
                    dblpVenue: pubRank.dblpVenue ?? null,
                    sourceYear: pubRank.sourceYear ?? null
                });
            }
        });
        restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks);
        setupPublicationTableObserver();
    }
    else {
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
    }
    if (!activeSummaryFilter && currentSettings.defaultHighlightMode !== 'none') {
        activeSummaryFilter = { type: 'preset', mode: currentSettings.defaultHighlightMode };
    }
    applyActiveSummaryFilter();
}
// --- NEW: Function to display the specific DBLP rate limit error ---
function displayDblpRateLimitError() {
    const statusElement = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("DBLP Error");
    const title = statusElement.querySelector('div:first-child');
    if (title) {
        title.textContent = "DBLP API Busy";
    }
    const progressBar = statusElement.querySelector('.gsr-progress-bar-inner');
    if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#FFA500'; // Orange for warning
    }
    const statusText = statusElement.querySelector('.gsr-status-text');
    if (statusText) {
        statusText.textContent = "DBLP is receiving too many requests right now. Give it a moment, then try again.";
        statusText.style.color = '#b45309';
    }
    let tryAgainButton = statusElement.querySelector('.gsr-try-again-button');
    if (!tryAgainButton) {
        tryAgainButton = document.createElement('button');
        tryAgainButton.textContent = 'Try Again';
        tryAgainButton.className = 'gsr-try-again-button gsr-button gsr-button--secondary';
        tryAgainButton.onclick = () => {
            if (isMainProcessing)
                return;
            console.log("GSR: 'Try Again' clicked. Rerunning main process.");
            main().catch(error => console.error("GSR: Error during manual retry:", error));
        };
        statusElement.appendChild(tryAgainButton);
    }
}

// Issue 4: Friendly message when DBLP is down/unreachable
function displayDblpUnavailableError(message = "DBLP is down/unreachable. Please try again later.") {
    const statusElement = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("DBLP Unavailable");
    const title = statusElement.querySelector('div:first-child');
    if (title) {
        title.textContent = "DBLP Unavailable";
    }
    statusElement.querySelector('.gsr-progress')?.remove();
    const statusText = statusElement.querySelector('.gsr-status-text');
    if (statusText) {
        statusText.textContent = `${message} Reload Scholar or try again in a few minutes.`;
        statusText.style.color = '#b91c1c';
    }
    let retryButton = statusElement.querySelector('.gsr-try-again-button');
    if (!retryButton) {
        retryButton = document.createElement('button');
        retryButton.className = 'gsr-try-again-button gsr-button gsr-button--secondary';
        retryButton.textContent = 'Reload Page';
        retryButton.addEventListener('click', () => {
            window.location.reload();
        });
        statusElement.appendChild(retryButton);
    }
}
function setupPublicationTableObserver(retryCount = 0) {
    disconnectPublicationTableObserver(); // Ensure any old one is gone
    const MAX_RETRIES = 5; // Try up to 5 times
    const RETRY_DELAY = 250; // Wait 250ms between retries
    const tableContainer = document.getElementById('gsc_a_b');
    if (!tableContainer) {
        if (retryCount < MAX_RETRIES) {
            setTimeout(() => setupPublicationTableObserver(retryCount + 1), RETRY_DELAY);
        }
        else {
            console.error("GSR OBSERVER: Max retries reached for finding #gsc_a_b. Observer not set up. 'Show more' may not work.");
        }
        return;
    }
    if (!activeCachedPublicationRanks || !rankMapForObserver || rankMapForObserver.size === 0) {
        console.warn("GSR OBSERVER: Setup aborted, missing cached rank data or rank map is empty.");
        return;
    }
    let reapplyDebounceTimeout = null;
    publicationTableObserver = new MutationObserver((mutationsList, observerInstance) => {
        if (!document.body.contains(tableContainer) || publicationTableObserver !== observerInstance) {
            observerInstance.disconnect();
            if (publicationTableObserver === observerInstance) {
                publicationTableObserver = null;
            }
            return;
        }
        if (!activeCachedPublicationRanks || !rankMapForObserver || rankMapForObserver.size === 0) {
            console.warn("GSR OBSERVER: Observer callback aborted, cached rank data became unavailable or empty.");
            return;
        }
        let newPubRowsAdded = false;
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (node.nodeName === 'TR' && node.classList.contains('gsc_a_tr')) {
                        newPubRowsAdded = true;
                        break;
                    }
                }
            }
            if (newPubRowsAdded)
                break;
        }
        if (!newPubRowsAdded) {
            return;
        }
        const addedRows = [];
        for (const mutation of mutationsList) {
            if (mutation.type !== 'childList')
                continue;
            for (const node of Array.from(mutation.addedNodes)) {
                if (node.nodeName === 'TR' && node.classList.contains('gsc_a_tr')) {
                    addedRows.push(node);
                }
                else if (node instanceof HTMLElement) {
                    addedRows.push(...Array.from(node.querySelectorAll('tr.gsc_a_tr')));
                }
            }
        }
        if (reapplyDebounceTimeout) {
            clearTimeout(reapplyDebounceTimeout);
        }
        reapplyDebounceTimeout = window.setTimeout(() => {
            if (activeCachedPublicationRanks && rankMapForObserver && rankMapForObserver.size > 0) {
                restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks, addedRows);
            }
            else {
                console.warn("GSR OBSERVER: Debounced re-scan aborted at execution, cached rank data is unavailable or empty.");
            }
        }, 300);
    });
    try {
        publicationTableObserver.observe(tableContainer, { childList: true, subtree: true });
        console.log("GSR OBSERVER: Publication table container observer successfully attached.");
    }
    catch (e) {
        console.error("GSR ERROR: Failed to attach publication table container observer:", e);
    }
}
function disconnectPublicationTableObserver() {
    if (publicationTableObserver) {
        publicationTableObserver.disconnect();
        publicationTableObserver = null;
    }
}
function restoreVisibleInlineBadgesFromCache(cachedRanks, targetRows = null) {
    const allVisibleRows = targetRows && targetRows.length ? targetRows : document.querySelectorAll('tr.gsc_a_tr');
    const currentRankMap = rankMapForObserver;
    if (allVisibleRows.length === 0 || !cachedRanks || cachedRanks.length === 0 || !currentRankMap || currentRankMap.size === 0) {
        return;
    }
    let badgesAppliedCount = 0;
    allVisibleRows.forEach((row) => {
        const rowElement = row;
        const linkEl = rowElement.querySelector('td.gsc_a_t a.gsc_a_at');
        const titleCell = rowElement.querySelector('td.gsc_a_t');
        if (titleCell) {
            const oldBadge = titleCell.querySelector('span.gsr-rank-badge-inline');
            oldBadge?.remove();
        }
        if (linkEl instanceof HTMLAnchorElement && linkEl.href) {
            const currentDomUrl = linkEl.href;
            const normalizedCurrentUrl = normalizeUrlForCache(currentDomUrl);
            const cachedRank = currentRankMap.get(normalizedCurrentUrl);
            if (cachedRank) {
                displayRankBadgeAfterTitle(rowElement, cachedRank.rank, cachedRank.system, cachedRank.reason ?? null, cachedRank);
                badgesAppliedCount++;
            }
        }
    });
    if (badgesAppliedCount > 0 || activeSummaryFilter || previewSummaryFilter) {
        applyActiveSummaryFilter();
    }
}
// --- START: DBLP Integration Functions (REPLACED/UPDATED) ---
const normalizeText = (s) => s.toLowerCase().replace(/[\.,\/#!$%\^&\*;:{}=\_`~?"“”()\[\]]/g, " ").replace(/\s+/g, ' ').trim();
function getScholarAuthorName() {
    const nameElement = document.getElementById('gsc_prf_in');
    if (nameElement) {
        return nameElement.textContent?.trim() || null;
    }
    const h1NameElement = document.querySelector('#gs_hdr_name > a, #gs_hdr_name');
    if (h1NameElement) {
        return h1NameElement.textContent?.trim() || null;
    }
    return null;
}
function sanitizeAuthorName(name) {
    let cleaned = name.trim();
    const commaIndex = cleaned.indexOf(',');
    if (commaIndex !== -1) {
        cleaned = cleaned.substring(0, commaIndex);
    }
    const prefixPatterns = [
        /^professor\s*/i,
        /^prof\.?\s*/i,
        /^dr\.?\s*/i
    ];
    for (const p of prefixPatterns) {
        cleaned = cleaned.replace(p, "");
    }
    cleaned = cleaned.replace(/\./g, "");
    cleaned = cleaned.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ");
    return cleaned.trim();
}
function getScholarSamplePublications(count = 7) {
    const samples = [];
    const publicationRows = document.querySelectorAll('tr.gsc_a_tr');
    for (let i = 0; i < Math.min(publicationRows.length, count); i++) {
        const row = publicationRows[i];
        const linkEl = row.querySelector('td.gsc_a_t a.gsc_a_at');
        const yearEl = row.querySelector('td.gsc_a_y span.gsc_a_h');
        if (linkEl instanceof HTMLAnchorElement && linkEl.href && linkEl.textContent) {
            let year = null;
            if (yearEl?.textContent && /^\d{4}$/.test(yearEl.textContent.trim())) {
                year = parseInt(yearEl.textContent.trim(), 10);
            }
            samples.push({
                title: cleanTextForComparison(linkEl.textContent),
                year: year,
                scholarUrl: linkEl.href
            });
        }
    }
    return samples;
}
// --- NEW FAST DBLP IDENTIFICATION LOGIC ---
async function searchDblpForCandidates(authorName) {
    const url = new URL(DBLP_API_AUTHOR_SEARCH_URL);
    url.searchParams.set('q', authorName);
    url.searchParams.set('format', 'json');
    url.searchParams.set('h', '500'); // Fetch more results for better hub detection
    try {
        const resp = await gsvrFetch(url.toString());
        if (resp.status === 429) {
            throw new DblpRateLimitError("DBLP API rate limit hit during author search.");
        }
        if (!resp.ok) {
            console.error(`DBLP author search failed with status: ${resp.status}`);
            if (resp.status >= 500) {
                throw new DblpUnavailableError("DBLP is down/unreachable");
            }
            return [];
        }
        const data = await resp.json();
        const hits = data.result?.hits?.hit;
        const initialCandidates = Array.isArray(hits) ? hits : hits ? [hits] : [];
        if (initialCandidates.length === 0)
            return [];
        // Find the most common base PID from the search results
        const basePidCounts = {};
        for (const hit of initialCandidates) {
            const pid = extractPidFromUrl(hit.info.url);
            if (pid) {
                const basePid = pid.split('-')[0];
                basePidCounts[basePid] = (basePidCounts[basePid] || 0) + 1;
            }
        }
        let mostCommonBasePid = null;
        let maxCount = 0;
        for (const basePid in basePidCounts) {
            if (basePidCounts[basePid] > maxCount) {
                maxCount = basePidCounts[basePid];
                mostCommonBasePid = basePid;
            }
        }
        // If a hub is detected, generate potential candidates programmatically
        if (mostCommonBasePid && maxCount > 4) {
            console.log(`GSR: Detected likely DBLP hub with base PID "${mostCommonBasePid}". Generating variants to test.`);
            const generatedCandidates = [];
            for (let i = 1; i <= DBLP_MAX_HUB_VARIANTS_TO_CHECK; i++) {
                const newPid = `${mostCommonBasePid}-${i}`;
                generatedCandidates.push({
                    info: {
                        author: `${authorName} (Variant ${i})`,
                        url: `https://dblp.org/pid/${newPid}.html`
                    }
                });
            }
            return generatedCandidates;
        }
        console.log("GSR: No obvious DBLP hub detected. Proceeding with raw API results.");
        return initialCandidates;
    }
    catch (error) {
        if (error instanceof DblpRateLimitError)
            throw error;
        console.error("GSR: DBLP candidate search fetch failed:", error);
        if (error instanceof DblpUnavailableError || error instanceof TypeError) {
            throw new DblpUnavailableError("DBLP is down/unreachable");
        }
        throw new Error("DBLP connection failed during author search.");
    }
}
async function fetchDblpPubsForCheck(pid) {
    const authorUri = `https://dblp.org/pid/${pid}`;
    const query = `PREFIX dblp: <https://dblp.org/rdf/schema#> SELECT ?title ?year WHERE { ?paper dblp:authoredBy <${authorUri}> . ?paper dblp:title ?title . OPTIONAL { ?paper dblp:yearOfPublication ?year . } } LIMIT 200`;
    const url = `${DBLP_SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&output=json`;
    try {
        const response = await gsvrFetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
        if (response.status === 429) {
            throw new DblpRateLimitError("DBLP SPARQL endpoint rate limit hit.");
        }
        if (!response.ok) {
            // This is an expected failure for non-existent PIDs, so we don't log an error.
            throw new Error(`SPARQL query failed for PID ${pid} with status ${response.status}`);
        }
        const json = await response.json();
        return json.results.bindings.map((b) => ({ title: b.title.value, year: b.year ? b.year.value : null }));
    }
    catch (error) {
        if (error instanceof DblpRateLimitError)
            throw error;
        // Re-throw other errors so the "guess and check" can catch them.
        throw new Error(`SPARQL connection failed for PID ${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function extractPidFromUrl(url) {
    let match = url.match(/pid\/([^/]+\/[^.]+)/i);
    if (match?.[1])
        return match[1];
    match = url.match(/pers\/hd\/[a-z0-9]\/([^.]+)/i);
    if (match?.[1])
        return match[1].replace(/=/g, '');
    match = url.match(/pid\/([\w\/-]+)\.html/i);
    if (match?.[1])
        return match[1];
    return null;
}
async function fetchDblpPublicationsViaSparql(pid) {
    const authorUri = `https://dblp.org/pid/${pid}`;
    const query = `
        PREFIX dblp: <https://dblp.org/rdf/schema#> 
        SELECT ?title ?year 
        WHERE { 
            ?paper dblp:authoredBy <${authorUri}> . 
            ?paper dblp:title ?title . 
            OPTIONAL { ?paper dblp:yearOfPublication ?year . } 
        } 
        ORDER BY DESC(?year)`;
    const url = `${DBLP_SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&output=json`;
    try {
        const response = await gsvrFetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
        if (response.status === 429) {
            throw new DblpRateLimitError("DBLP SPARQL endpoint rate limit hit.");
        }
        if (!response.ok) {
            console.error(`SPARQL query failed for PID ${pid} with status ${response.status}`);
            return [];
        }
        const json = await response.json();
        return json.results.bindings.map((b) => ({ title: b.title.value, year: b.year ? b.year.value : null }));
    }
    catch (error) {
        if (error instanceof DblpRateLimitError)
            throw error;
        console.error(`SPARQL query connection failed for PID ${pid}:`, error);
        throw new DblpRateLimitError("DBLP connection failed during SPARQL query.");
    }
}
async function mapWithConcurrencyLimit(items, limit, worker) {
    const maxConcurrency = Math.max(1, limit || 1);
    const results = new Array(items.length);
    let nextIndex = 0;
    async function runWorker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex++;
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }
    const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runWorker());
    await Promise.all(workers);
    return results;
}
// in content.ts
async function findBestDblpProfile(scholarName, scholarSamplePubs) {
    const candidates = await searchDblpForCandidates(scholarName);
    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
    const evaluations = await mapWithConcurrencyLimit(candidates, 4, async (candidate) => {
        const rawName = candidate?.info?.author || '';
        const dblpName = rawName.replace(/\s\d{4}$/, '').replace(/\s+\(Variant \d+\)$/, '').trim();
        const pid = extractPidFromUrl(candidate?.info?.url || '');
        if (!pid)
            return null;
        const nameSimilarity = utils?.hybridSimilarity
            ? utils.hybridSimilarity(utils.normalizeProfileName(scholarName), utils.normalizeProfileName(dblpName))
            : jaroWinkler(scholarName.toLowerCase(), dblpName.toLowerCase());
        if (nameSimilarity < HEURISTIC_MIN_NAME_SIMILARITY)
            return null;
        try {
            const dblpPublications = await fetchDblpPubsForCheck(pid);
            if (!dblpPublications.length)
                return null;
            const score = utils?.scoreDblpProfileCandidate
                ? utils.scoreDblpProfileCandidate({
                    scholarName,
                    scholarSamplePubs,
                    candidateName: dblpName,
                    dblpPublications
                })
                : null;
            if (!score)
                return null;
            return {
                pid,
                dblpName,
                nameSimilarity,
                dblpPublications,
                score: score.score,
                confidence: score.confidence,
                overlapCount: score.overlapCount,
                status: score.status,
                reason: score.reason
            };
        }
        catch {
            return null;
        }
    });
    const ranked = evaluations
        .filter((entry) => !!entry && entry.status === DECISION_STATUS.MATCHED)
        .sort((left, right) => {
        if (right.score !== left.score)
            return right.score - left.score;
        if ((right.overlapCount || 0) !== (left.overlapCount || 0))
            return (right.overlapCount || 0) - (left.overlapCount || 0);
        return String(left.pid || '').localeCompare(String(right.pid || ''));
    });
    const best = ranked[0] || null;
    const runnerUp = ranked[1] || null;
    if (!best) {
        console.log(`GSR: DBLP profile matching failed for "${scholarName}". No candidate met the precision threshold.`);
        return null;
    }
    const gap = runnerUp ? best.score - runnerUp.score : Number.POSITIVE_INFINITY;
    if (runnerUp && best.score < RANKING_CONFIG.profileStrongScoreThreshold && gap < RANKING_CONFIG.profileAmbiguityGap) {
        console.log(`GSR: DBLP profile match for "${scholarName}" was ambiguous. Best PID ${best.pid} gap ${gap.toFixed(2)}.`);
        return null;
    }
    console.log(`GSR: DBLP profile match success for "${scholarName}" -> PID ${best.pid} (score ${best.score.toFixed(2)}, overlap ${best.overlapCount}).`);
    return best.pid;
}
async function fetchPublicationsFromDblp(authorPidPath, statusElement) {
    const statusTextEl = statusElement?.querySelector(".gsr-status-text");
    const progressBarInner = statusElement?.querySelector(".gsr-progress-bar-inner");
    const clamp01 = (x) => Math.max(0, Math.min(1, x));
    const setProgress = (fraction, message) => {
        if (progressBarInner) {
            const pct = (clamp01(fraction) * 100).toFixed(1);
            progressBarInner.style.width = `${pct}%`;
        }
        if (statusTextEl && message) {
            statusTextEl.textContent = message;
        }
    };
    setProgress(0, `DBLP: Fetching publications for PID ${authorPidPath} (downloading XML)…`);
    const xmlUrl = `${DBLP_API_PERSON_PUBS_URL_PREFIX}${authorPidPath}.xml`;
    const publications = [];
    try {
        const response = await gsvrFetch(xmlUrl);
        if (response.status === 429) {
            throw new DblpRateLimitError(`DBLP XML download rate limit hit for PID ${authorPidPath}.`);
        }
        if (!response.ok) {
            console.warn(`DBLP: Fetching publications XML failed for PID "${authorPidPath}": ${response.statusText} (${response.status})`);
            // Issue 4: DBLP down/unreachable – show friendly message.
            if (response.status >= 500) {
                if (statusTextEl)
                    statusTextEl.textContent = "DBLP is down/unreachable. Please try again later.";
                throw new DblpUnavailableError("DBLP is down/unreachable");
            }
            if (statusTextEl)
                statusTextEl.textContent = "DBLP: XML fetch failed.";
            return [];
        }
        const xmlText = await response.text();
        setProgress(0.05, `DBLP: Downloaded XML for PID ${authorPidPath}. Parsing publications…`);
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "application/xml");
        if (xmlDoc.querySelector("parsererror")) {
            console.error("DBLP: XML parse error for PID", authorPidPath);
            if (statusTextEl)
                statusTextEl.textContent = "DBLP: XML parse error.";
            return [];
        }
        const items = Array.from(xmlDoc.querySelectorAll("dblpperson > r > *"));
        const totalItems = items.length || 0;
        const streamKeysSeen = new Set();
        let streamFetchCount = 0;
        let lastUiUpdateMs = 0;
        const uiNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
        const maybeUpdateUi = (processed, extra = "") => {
            const now = uiNow();
            if (processed === 0 || processed === totalItems || now - lastUiUpdateMs > 450) {
                const frac = totalItems > 0 ? (processed / totalItems) : 0;
                setProgress(0.05 + 0.95 * frac, `DBLP: Processing ${processed} / ${totalItems} publications — resolving venue metadata (streams fetched: ${streamFetchCount})${extra}…`);
                lastUiUpdateMs = now;
            }
        };
        maybeUpdateUi(0);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const dblpKey = item.getAttribute("key") || "";
            if (!dblpKey)
                continue;
            const title = (item.querySelector("title")?.textContent || "").replace(/\.$/, "");
            if (!title)
                continue;
            const year = item.querySelector("year")?.textContent || null;
            const pages = item.querySelector("pages")?.textContent || null;
            const venueElements = ["booktitle", "journal", "series", "school"];
            let rawVenue = null;
            for (const tag of venueElements) {
                const txt = item.querySelector(tag)?.textContent?.trim();
                if (txt) {
                    rawVenue = txt;
                    break;
                }
            }
            const volume = item.querySelector('volume')?.textContent?.trim() || null;
            const number = item.querySelector('number')?.textContent?.trim() || null;
            const crossref = item.querySelector("crossref")?.textContent?.trim() || null;
            const dblpType = item.tagName ? item.tagName.toLowerCase() : null;

            let acronym = null;
            let venue_full = null;
            let journalIssns = [];
            let journalShortTitle = null;

            const pubUrl = item.querySelector("url")?.textContent?.trim() || null;
            const numericYear = year ? parseInt(year, 10) : null;

            const streamCandidates = [];
            const addStreamCandidate = (streamType, streamId) => {
                if (!streamType || !streamId) return;
                const key = `${streamType}:${streamId}`.toLowerCase();
                if (!streamCandidates.some(c => c.key === key)) {
                    streamCandidates.push({ streamType, streamId, key });
                }
            };

            // Prefer dblpKey (stable, present for all entries)
            const keyMatch = dblpKey.match(/^(conf|journals)\/([^\/]+)\//i);
            if (keyMatch && keyMatch[2]) {
                addStreamCandidate(keyMatch[1].toLowerCase() === "conf" ? "conf" : "journals", keyMatch[2]);
            }

            // Secondary: parse stream hints from DBLP urls (db/* and rec/*)
            if (pubUrl) {
                let path = pubUrl;
                try {
                    path = new URL(pubUrl).pathname;
                } catch (e) {
                    // ignore - leave as-is (sometimes DBLP provides relative urls)
                }
                path = String(path || "").replace(/^\/+/, "");

                const journalMatch = path.match(/^(?:db|rec)\/journals\/([^\/]+)\//i);
                if (journalMatch && journalMatch[1]) addStreamCandidate("journals", journalMatch[1]);

                const confMatch = path.match(/^(?:db|rec)\/conf\/([^\/]+)\//i);
                if (confMatch && confMatch[1]) addStreamCandidate("conf", confMatch[1]);

                // db/conf/<series>/<event-file>.html patterns
                const confFileMatch = path.match(/^db\/conf\/[^\/]+\/([a-zA-Z][\w-]*?)(?:\d{4}.*)?\.html/i);
                if (confFileMatch && confFileMatch[1]) addStreamCandidate("conf", confFileMatch[1]);

                const streamXmlMatch = path.match(/^streams\/(conf|journals)\/([^\/]+)(?:\.xml)?$/i);
                if (streamXmlMatch && streamXmlMatch[1] && streamXmlMatch[2]) {
                    addStreamCandidate(streamXmlMatch[1].toLowerCase(), streamXmlMatch[2]);
                }
            }

            let streamMeta = null;
            for (const candidate of streamCandidates) {
                const cacheKey = (candidate.key || `${candidate.streamType}:${candidate.streamId}`).toLowerCase();
                if (!streamKeysSeen.has(cacheKey)) {
                    streamKeysSeen.add(cacheKey);
                    if (typeof streamMetaCache !== "undefined" && !streamMetaCache.has(cacheKey)) {
                        streamFetchCount++;
                        // update UI before a potentially long await for stream metadata
                        maybeUpdateUi(i, ` (fetching ${cacheKey})`);
                    }
                }
                if (candidate.streamType === "conf") {
                    streamMeta = await resolveDblpStreamMetadata("conf", candidate.streamId, { year: numericYear });
                } else {
                    streamMeta = await resolveDblpStreamMetadata("journals", candidate.streamId);
                }
                if (streamMeta && (streamMeta.acronym || streamMeta.title)) {
                    break;
                }
            }

            if (streamMeta) {
                if (streamMeta.acronym) {
                    acronym = streamMeta.acronym;
                }
                if (streamMeta.title) {
                    venue_full = streamMeta.title;
                }
                if (Array.isArray(streamMeta.issns)) {
                    journalIssns = normalizeIssnList(streamMeta.issns);
                }
                if (streamMeta.shortTitle) {
                    journalShortTitle = streamMeta.shortTitle;
                }
            }

            if (!acronym && rawVenue?.startsWith('Proc. ACM') && number && /^[A-Za-z]{2,}$/.test(number)) {
                acronym = number;
            }
            publications.push({ dblpKey, title, venue: rawVenue, year, pages, venue_full, acronym, volume, number, crossref, dblpType, journalIssns, journalShortTitle });
            maybeUpdateUi(i + 1);
        }
        setProgress(1, `DBLP: Fetched ${publications.length} publications.`);
    }
    catch (err) {
        if (err instanceof DblpRateLimitError || err instanceof DblpUnavailableError)
            throw err;
        console.error("DBLP: Error fetching/parsing XML:", err);
        // Network errors (e.g. TypeError: Failed to fetch) should be treated as DBLP down.
        if (err instanceof TypeError) {
            if (statusTextEl)
                statusTextEl.textContent = "DBLP is down/unreachable. Please try again later.";
            throw new DblpUnavailableError("DBLP is down/unreachable");
        }
        if (statusTextEl)
            statusTextEl.textContent = "DBLP: Error fetching pubs.";
        throw err;
    }
    return publications;
}
function getPageCountFromDblpString(pageStr) {
    if (!pageStr)
        return null;
    pageStr = pageStr.trim();
    if (/^(article\s+\d+|\d+$|[ivxlcdm]+$)/i.test(pageStr) && !pageStr.includes('-') && !pageStr.includes(':')) {
        return null;
    }
    // Patterns like S1-S8, e123-e130, A12-A18
    let match = pageStr.match(/^([a-z]+)\s*(\d+)\s*[-‑–—]\s*([a-z]+)\s*(\d+)$/i);
    if (match) {
        const start = parseInt(match[2], 10);
        const end = parseInt(match[4], 10);
        if (!isNaN(start) && !isNaN(end) && end >= start) {
            return end - start + 1;
        }
    }

    // Patterns like 123-128 or a:123-a:128
    match = pageStr.match(/^(?:[a-z\d]+:)?(\d+)\s*[-‑–—]\s*(?:[a-z\d]+:)?(\d+)$/i);
    if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        if (!isNaN(start) && !isNaN(end) && end >= start) {
            return end - start + 1;
        }
    }
    match = pageStr.match(/^(?:(\d+):)?(\d+)\s*[-‑–—]\s*(?:(\d+):)?(\d+)$/i);
    if (match) {
        const prefix1 = match[1];
        const startPage = parseInt(match[2], 10);
        const prefix2 = match[3];
        const endPage = parseInt(match[4], 10);
        if (!isNaN(startPage) && !isNaN(endPage) && endPage >= startPage) {
            if (prefix1 === undefined && prefix2 === undefined)
                return endPage - startPage + 1;
            if (prefix1 && prefix2 && prefix1 === prefix2)
                return endPage - startPage + 1;
            return endPage - startPage + 1;
        }
    }
    return null;
}
async function buildDblpInfoMap(scholarPubLinkElements, dblpPublications, mapToFill, statusElement) {
    if (dblpPublications.length === 0)
        return;
    const statusTextEl = statusElement?.querySelector('.gsr-status-text');
    if (statusTextEl)
        statusTextEl.textContent = `DBLP: Mapping ${scholarPubLinkElements.length} Scholar to ${dblpPublications.length} DBLP entries...`;
    // Deterministic matching: choose the best DBLP entry among all candidates
    // (rather than the first one that passes a threshold).
    const sortedDblp = dblpPublications.slice().sort((a, b) => (a.dblpKey || '').localeCompare(b.dblpKey || ''));
    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
    let mappedCount = 0;
    for (const scholarPub of scholarPubLinkElements) {
        const best = utils?.selectBestDblpMatchDetailed
            ? utils.selectBestDblpMatchDetailed({
                scholarTitle: scholarPub.titleText,
                scholarYear: scholarPub.yearFromProfile,
                dblpPublications: sortedDblp,
                similarityThreshold: RANKING_CONFIG.publicationSimilarityThreshold,
                maxYearDiff: RANKING_CONFIG.publicationMaxYearDiff,
                strongSimilarityThreshold: RANKING_CONFIG.publicationStrongSimilarityThreshold
            })
            : null;
        if (!best || best.status !== DECISION_STATUS.MATCHED || !best.match?.dblpKey)
            continue;
        const matched = best.match;
        const pageCount = getPageCountFromDblpString(matched.pages);
        mapToFill.set(scholarPub.url, {
            title: matched.title ?? null,
            year: matched.year ?? null,
            venue: matched.venue,
            pages: matched.pages ?? null,
            pageCount: pageCount,
            dblpKey: matched.dblpKey,
            venue_full: matched.venue_full,
            acronym: matched.acronym,
            dblpType: matched.dblpType ?? null,
            crossref: matched.crossref ?? null,
            volume: matched.volume ?? null,
            number: matched.number ?? null,
            journalIssns: matched.journalIssns ?? [],
            journalShortTitle: matched.journalShortTitle ?? null,
            matchScore: typeof best.confidence === 'number' ? best.confidence : (typeof matched.matchScore === 'number' ? matched.matchScore : null),
            decisionStatus: best.status,
            decisionEvidence: best.reason ? [best.reason] : null
        });
        mappedCount++;
    }
    console.log(`GSR: DBLP Info Mapping: Matched ${mappedCount} of ${scholarPubLinkElements.length} Scholar publications to DBLP entries.`);
    if (statusTextEl && mappedCount > 0)
        statusTextEl.textContent = `DBLP: Mapped ${mappedCount} publication details.`;
}
async function main() {
    if (isMainProcessing) {
        return;
    }
    isMainProcessing = true;
    await loadSettingsIntoState();
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    dblpPubsForCurrentUser = [];
    scholarUrlToDblpInfoMap.clear();
    const statusElement = createStatusElement("Initializing Scholar Ranker...");
    const statusTextElement = statusElement.querySelector('.gsr-status-text');
    const currentUserId = getScholarUserId();
    const determinedPublicationRanks = [];
    const persistentPublicationRanks = [];
    let cachedDblpPidForSave = null;
    const scholarTitlesAlreadyRanked = new Set();
    const dblpKeysAlreadyUsedForRank = new Set();
    try {
        // -----------------------
        // Strict DBLP-only: PID is mandatory.
        // -----------------------
        const scholarAuthorName = getScholarAuthorName();
        const sanitizedName = scholarAuthorName ? sanitizeAuthorName(scholarAuthorName) : null;
        if (!sanitizedName) {
            if (statusTextElement)
                statusTextElement.textContent = "Could not determine Scholar author name from page.";
            return;
        }

        const cachedUserData = currentUserId ? await loadCachedData(currentUserId) : null;
        if (cachedUserData?.dblpAuthorPid && cachedUserData.dblpMatchTimestamp && (Date.now() - cachedUserData.dblpMatchTimestamp) < DBLP_CACHE_DURATION_MS) {
            cachedDblpPidForSave = cachedUserData.dblpAuthorPid;
            console.log("GSR INFO: Using cached DBLP PID:", cachedDblpPidForSave);
        }
        else {
            if (cachedUserData?.dblpAuthorPid)
                console.log("GSR INFO: Cached DBLP PID is stale or missing timestamp. Will attempt fresh DBLP author match.");
            else
                console.log("GSR INFO: No cached DBLP PID. Attempting DBLP author match for:", sanitizedName);

            if (statusTextElement)
                statusTextElement.textContent = `DBLP: Searching for ${sanitizedName}...`;

            const scholarSamplePubs = getScholarSamplePublications(7);
            if (scholarSamplePubs.length >= DBLP_HEURISTIC_MIN_OVERLAP_COUNT) {
                cachedDblpPidForSave = await findBestDblpProfile(sanitizedName, scholarSamplePubs);
            }
            else {
                // Not enough data to do name+title overlap verification.
                cachedDblpPidForSave = null;
            }
        }

        if (!cachedDblpPidForSave) {
            // Termination clause: halt all execution when PID cannot be verified.
            const title = statusElement.querySelector('div:first-child');
            if (title)
                title.textContent = "DBLP Author Not Found";
            const progressBar = statusElement.querySelector('.gsr-progress-bar-inner');
            if (progressBar && progressBar.parentElement) {
                progressBar.parentElement.style.display = 'none';
            }
            if (statusTextElement) {
                statusTextElement.textContent = "DBLP Author Not Found";
                statusTextElement.setAttribute('title', `No verified DBLP PID for "${sanitizedName}".`);
                statusTextElement.style.color = '#64748b';
            }
            return;
        }

        if (statusTextElement && dblpPubsForCurrentUser.length === 0)
            statusTextElement.textContent = `DBLP: Fetching publications for PID ${cachedDblpPidForSave}...`;
        dblpPubsForCurrentUser = await fetchPublicationsFromDblp(cachedDblpPidForSave, statusElement);

        // Strict DBLP-only: if DBLP publications cannot be fetched, do not continue.
        if (!dblpPubsForCurrentUser || dblpPubsForCurrentUser.length === 0) {
            const title = statusElement.querySelector('div:first-child');
            if (title)
                title.textContent = "DBLP Publications Unavailable";
            const progressBar = statusElement.querySelector('.gsr-progress-bar-inner');
            if (progressBar && progressBar.parentElement) {
                progressBar.parentElement.style.display = 'none';
            }
            if (statusTextElement) {
                statusTextElement.textContent = "Could not fetch the matched DBLP publication list.";
                statusTextElement.style.color = '#64748b';
            }
            return;
        }
        if (statusTextElement)
            statusTextElement.textContent = "Expanding publications list...";
        await expandAllPublications(statusElement);
        const publicationLinkElements = [];
        document.querySelectorAll('tr.gsc_a_tr').forEach(row => {
            const linkEl = row.querySelector('td.gsc_a_t a.gsc_a_at');
            const yearEl = row.querySelector('td.gsc_a_y span.gsc_a_h');
            let yearFromProfile = null;
            if (yearEl?.textContent && /^\d{4}$/.test(yearEl.textContent.trim())) {
                yearFromProfile = parseInt(yearEl.textContent.trim(), 10);
            }
            if (linkEl instanceof HTMLAnchorElement && linkEl.href && linkEl.textContent) {
                publicationLinkElements.push({
                    url: normalizeUrlForCache(linkEl.href),
                    rowElement: row,
                    titleText: linkEl.textContent.trim().toLowerCase(),
                    yearFromProfile: yearFromProfile
                });
            }
        });
        if (publicationLinkElements.length === 0) {
            if (statusTextElement)
                statusTextElement.textContent = "No publications found on profile.";
            setTimeout(() => document.getElementById(STATUS_ELEMENT_ID)?.remove(), 3000);
            isMainProcessing = false;
            return;
        }
        if (dblpPubsForCurrentUser.length > 0) {
            await buildDblpInfoMap(publicationLinkElements, dblpPubsForCurrentUser, scholarUrlToDblpInfoMap, statusElement);
        }
        updateStatusElement(statusElement, 0, publicationLinkElements.length, "Ranking");
        const coreRankCounts = createEmptyCoreRankCounts();
        const sjrRankCounts = createEmptySjrRankCounts();
        let processedCount = 0;
        const processPublication = async (pubInfo, titlesAlreadyProcessedSet, dblpKeysUsedSet) => {
            const defaultResult = {
                rank: "N/A",
                system: 'UNKNOWN',
                reason: null,
                rowElement: pubInfo.rowElement,
                titleText: pubInfo.titleText,
                url: pubInfo.url,
                shouldPersist: true,
                matchConfidence: null,
                matchedVenue: null,
                venueMatchConfidence: null,
                dblpVenue: null,
                sourceYear: null,
                ...createDecisionMeta()
            };
            if (titlesAlreadyProcessedSet.has(pubInfo.titleText)) {
                return defaultResult;
            }
            let currentRank = "N/A";
            let rankingSystem = 'UNKNOWN';
            let naReason = null;
            let dblpKeyUsedForThisRanking = null;
            let shouldPersist = true;
            let matchConfidence = null;
            let matchedVenue = null;
            let venueMatchConfidence = null;
            let dblpVenue = null;
            let sourceYear = null;
            let decisionMeta = createDecisionMeta();
            try {
                const dblpInfo = scholarUrlToDblpInfoMap.get(pubInfo.url);
                if (dblpInfo) {
                    if (typeof dblpInfo.matchScore === 'number')
                        matchConfidence = dblpInfo.matchScore;
                    dblpVenue = (dblpInfo.venue_full || dblpInfo.venue || null);
                    decisionMeta = mergeDecisionMeta(decisionMeta, {
                        decisionStatus: dblpInfo.decisionStatus ?? DECISION_STATUS.MATCHED,
                        confidence: dblpInfo.matchScore ?? null,
                        matchedKey: dblpInfo.dblpKey ?? null,
                        decisionEvidence: dblpInfo.decisionEvidence ?? null
                    });
                }
                if (dblpInfo && dblpInfo.venue && dblpInfo.dblpKey) {
                    dblpKeyUsedForThisRanking = dblpInfo.dblpKey;
                    if (dblpKeysUsedSet.has(dblpInfo.dblpKey)) {
                        return defaultResult;
                    }
                    let venueName = dblpInfo.venue;
                    let pageCount = dblpInfo.pageCount;
                    let publicationYear = pubInfo.yearFromProfile;
                    const matchedDblpEntry = dblpPubsForCurrentUser.find(dp => dp.dblpKey === dblpInfo.dblpKey);
                    if (matchedDblpEntry && matchedDblpEntry.year) {
                        const dblpYearNum = parseInt(matchedDblpEntry.year, 10);
                        if (!isNaN(dblpYearNum)) {
                            publicationYear = dblpYearNum;
                        }
                    }
                    const dblpKeyLower = dblpInfo.dblpKey.toLowerCase();
                    const isJournal = dblpKeyLower.startsWith('journals/') || String(dblpInfo.dblpType || '').toLowerCase() === 'article';
                    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
                    const csrOverride = utils?.resolveCsrankingsVenueOverride
                        ? utils.resolveCsrankingsVenueOverride({
                            dblpKey: dblpInfo.dblpKey,
                            venue: matchedDblpEntry?.venue || dblpInfo.venue,
                            year: publicationYear ?? null,
                            volume: matchedDblpEntry?.volume || null,
                            number: matchedDblpEntry?.number || null,
                            dblpType: matchedDblpEntry?.dblpType || dblpInfo.dblpType
                        })
                        : null;
                    const forcedCore = !!(csrOverride && csrOverride.system === 'CORE');
                    const csrCanonicalVenue = csrOverride?.canonicalVenue || null;
                    if (forcedCore && csrCanonicalVenue) {
                        // Treat proceedings-as-journals as conferences (CSRankings-style).
                        venueName = csrCanonicalVenue;
                        if (typeof csrOverride.year === 'number' && Number.isFinite(csrOverride.year)) {
                            publicationYear = csrOverride.year;
                        }
                    }
                    if (isJournal && !forcedCore) {
                        if (isArxivLikeVenue(dblpInfo)) {
                            return defaultResult;
                        }
                        rankingSystem = 'SJR';
                        const candidateNames = Array.from(new Set([dblpInfo.venue_full, dblpInfo.journalShortTitle, venueName, dblpInfo.acronym, utils?.canonicalizeCsrankingsVenueName ? utils.canonicalizeCsrankingsVenueName(venueName) : null].filter((name) => !!name && name.trim().length > 0)));
                        let sjrLookupTransientFailure = false;
                        let bestSjr = null;
                        let sawAmbiguousSjr = false;
                        for (const candidate of candidateNames) {
                            const sjrResult = await resolveSjrQuartile(candidate, publicationYear ?? null, {
                                issns: dblpInfo.journalIssns
                            });
                            if (sjrResult.status === 'success' && sjrResult.quartile && SJR_QUARTILES.includes(sjrResult.quartile)) {
                                const score = (typeof sjrResult.matchScore === 'number') ? sjrResult.matchScore : 1.0;
                                if (!bestSjr || score > bestSjr.score) {
                                    bestSjr = { ...sjrResult, score };
                                }
                                sjrLookupTransientFailure = false;
                                continue;
                            }
                            if (sjrResult.status === 'ambiguous') {
                                sawAmbiguousSjr = true;
                            }
                            if (sjrResult.status === 'error' && sjrResult.transient) {
                                sjrLookupTransientFailure = true;
                            }
                        }
                        if (bestSjr) {
                            currentRank = bestSjr.quartile;
                            matchedVenue = bestSjr.resolvedTitle ?? matchedVenue;
                            venueMatchConfidence = (typeof bestSjr.matchScore === 'number') ? bestSjr.matchScore : venueMatchConfidence;
                            sourceYear = bestSjr.year ?? sourceYear;
                            decisionMeta = mergeDecisionMeta(decisionMeta, {
                                decisionStatus: DECISION_STATUS.MATCHED,
                                confidence: bestSjr.matchScore ?? 1,
                                matchedKey: bestSjr.matchedNormalizedTitle ?? matchedVenue,
                                matchedSourceId: bestSjr.matchedSourceId ?? null,
                                sourceYearFallback: bestSjr.sourceYearFallback === true,
                                decisionEvidence: bestSjr.matchedSourceId ? [`source:${bestSjr.matchedSourceId}`] : null
                            });
                        }
                        else if (sawAmbiguousSjr) {
                            naReason = 'Ambiguous Journal Match';
                            decisionMeta = mergeDecisionMeta(decisionMeta, {
                                decisionStatus: DECISION_STATUS.AMBIGUOUS,
                                matchedKey: venueName ?? null,
                                decisionEvidence: ['sjr_ambiguous']
                            });
                        }
                        if (currentRank === 'N/A' && sjrLookupTransientFailure) {
                            shouldPersist = false;
                        }
                    }
                    else {
                        rankingSystem = 'CORE';
                        const effectiveYear = publicationYear;
                        const trackVenueForClassification = (forcedCore && csrCanonicalVenue) ? csrCanonicalVenue : dblpInfo.venue;
                        const trackVenueFullForClassification = (forcedCore && csrCanonicalVenue) ? csrCanonicalVenue : dblpInfo.venue_full;
                        const trackInfo = utils?.classifyVenueTrack
                            ? utils.classifyVenueTrack({
                                title: (dblpInfo.title || matchedDblpEntry?.title || pubInfo.titleText),
                                venue: trackVenueForClassification,
                                venue_full: trackVenueFullForClassification,
                                acronym: (forcedCore && csrCanonicalVenue) ? csrCanonicalVenue : dblpInfo.acronym,
                                dblpKey: dblpInfo.dblpKey,
                                dblpType: dblpInfo.dblpType,
                                crossref: dblpInfo.crossref,
                                scholarVenue: null,
                                pageCount: pageCount
                            })
                            : { isWorkshop: false, isDemoPoster: false, isShortPaper: false, reason: null, resolvedVenue: null, parentVenue: null, seriesId: null, signals: [] };
                        naReason = trackInfo.reason;
                        // Exclusions that should never be ranked in CORE.
                        if (trackInfo.isExtendedAbstract || naReason === 'Extended Abstract') {
                            return {
                                rank: "N/A",
                                system: 'CORE',
                                reason: 'Extended Abstract',
                                rowElement: pubInfo.rowElement,
                                titleText: pubInfo.titleText,
                                url: pubInfo.url,
                                shouldPersist: true,
                                matchConfidence,
                                matchedVenue: null,
                                venueMatchConfidence: null,
                                dblpVenue,
                                sourceYear,
                                ...mergeDecisionMeta(decisionMeta, {
                                    decisionStatus: DECISION_STATUS.UNRANKED,
                                    decisionEvidence: trackInfo.signals ?? ['extended_abstract']
                                })
                            };
                        }
                        if (naReason === 'Editorship') {
                            return {
                                rank: "N/A",
                                system: 'CORE',
                                reason: 'Editorship',
                                rowElement: pubInfo.rowElement,
                                titleText: pubInfo.titleText,
                                url: pubInfo.url,
                                shouldPersist: true,
                                matchConfidence,
                                matchedVenue: null,
                                venueMatchConfidence: null,
                                dblpVenue,
                                sourceYear,
                                ...mergeDecisionMeta(decisionMeta, {
                                    decisionStatus: DECISION_STATUS.UNRANKED,
                                    decisionEvidence: trackInfo.signals ?? ['editorship']
                                })
                            };
                        }
                        // Demo/Poster tracks should not inherit the parent conference rank.
                        if (trackInfo.isDemoPoster) {
                            return {
                                rank: "N/A",
                                system: 'CORE',
                                reason: naReason || 'Demo/Poster',
                                rowElement: pubInfo.rowElement,
                                titleText: pubInfo.titleText,
                                url: pubInfo.url,
                                shouldPersist: true,
                                matchConfidence,
                                matchedVenue: null,
                                venueMatchConfidence: null,
                                dblpVenue,
                                sourceYear,
                                ...mergeDecisionMeta(decisionMeta, {
                                    decisionStatus: DECISION_STATUS.UNRANKED,
                                    decisionEvidence: trackInfo.signals ?? ['demo_poster']
                                })
                            };
                        }
                        const coreDataFile = getCoreDataFileForYear(effectiveYear);
                        const coreDataYearMatch = coreDataFile.match(/CORE_(\d{4})/);
                        sourceYear = coreDataYearMatch ? parseInt(coreDataYearMatch[1], 10) : sourceYear;
                        const yearSpecificCoreData = await loadCoreDataForFile(coreDataFile);
                        if (yearSpecificCoreData.length > 0) {
                                const fullVenueTitleForRanking = (forcedCore && csrCanonicalVenue) ? csrCanonicalVenue : (dblpInfo.venue_full ?? null);
                                const rankingCandidates = [];
                                const pushCandidate = (candidate) => {
                                    if (!candidate)
                                        return;
                                    const trimmed = candidate.trim();
                                    if (!trimmed)
                                        return;
                                    const lower = trimmed.toLowerCase();
                                    if (!rankingCandidates.some(existing => existing.toLowerCase() === lower)) {
                                        rankingCandidates.push(trimmed);
                                    }
                                    // Also try CSRankings-style canonicalization for top venues and common variants.
                                    const canon = utils?.canonicalizeCsrankingsVenueName ? utils.canonicalizeCsrankingsVenueName(trimmed) : null;
                                    if (canon) {
                                        const c = canon.trim();
                                        if (c) {
                                            const cl = c.toLowerCase();
                                            if (!rankingCandidates.some(existing => existing.toLowerCase() === cl)) {
                                                rankingCandidates.push(c);
                                            }
                                        }
                                    }
                                };
                                const expandVenue = (candidate, opts) => {
                                    if (!candidate)
                                        return;
                                    const variants = utils?.expandVenueCandidates ? utils.expandVenueCandidates(candidate, opts) : [candidate];
                                    for (const v of variants) {
                                        pushCandidate(v);
                                    }
                                };
                                const inheritWorkshopParentRank = INHERIT_PARENT_CONFERENCE_RANK_FOR_WORKSHOPS;
                                if (csrCanonicalVenue) {
                                    // Add CSRankings-derived canonical venue hint early.
                                    expandVenue(csrCanonicalVenue, (trackInfo.isWorkshop && !inheritWorkshopParentRank) ? { includeAtParent: false } : undefined);
                                }
                                if (trackInfo.isWorkshop && !inheritWorkshopParentRank) {
                                    // Prefer the actual workshop/track series and do NOT add parent conference as a candidate.
                                    if (trackInfo.resolvedVenue)
                                        expandVenue(trackInfo.resolvedVenue, { includeAtParent: false });
                                    // seriesId is often the *parent* conference in DBLP (e.g., conf/sensys/* for ENSsys@SenSys).
                                    // Only include it if it is the same as the resolved venue (or if resolved venue is unknown).
                                    if (trackInfo.seriesId && (!trackInfo.resolvedVenue || trackInfo.seriesId.toLowerCase() === trackInfo.resolvedVenue.toLowerCase()))
                                        expandVenue(trackInfo.seriesId, { includeAtParent: false });
                                    // Add acronym only if it doesn't look like a parent venue.
                                    if (dblpInfo.acronym && (!trackInfo.parentVenue || dblpInfo.acronym.toLowerCase() !== trackInfo.parentVenue.toLowerCase())) {
                                        expandVenue(dblpInfo.acronym, { includeAtParent: false });
                                    }
                                    // If DBLP provides a full proceedings title, prefer it as it usually contains explicit track keywords.
                                    if (fullVenueTitleForRanking)
                                        expandVenue(fullVenueTitleForRanking, { includeAtParent: false });
                                    // Only add raw venue strings if they don't contain an explicit "@Parent" marker.
                                    if (venueName && !(trackInfo.parentVenue && venueName.toLowerCase().includes(`@${trackInfo.parentVenue.toLowerCase()}`))) {
                                        expandVenue(venueName, { includeAtParent: false });
                                    }
                                }
                                else {
                                    expandVenue(dblpInfo.acronym);
                                    expandVenue(venueName);
                                    expandVenue(fullVenueTitleForRanking);
                                }
                                let resolvedRank = null;
                                let resolvedDetails = null;
                                for (const candidate of rankingCandidates) {
                                    const details = {};
                                    const attempt = findRankForVenue(candidate, yearSpecificCoreData, fullVenueTitleForRanking, details);
                                    if (VALID_RANKS.includes(attempt)) {
                                        resolvedRank = attempt;
                                        resolvedDetails = details;
                                        break;
                                    }
                                    if (resolvedRank === null && attempt !== "N/A") {
                                        resolvedRank = attempt;
                                        resolvedDetails = details;
                                        continue;
                                    }
                                    // Preserve a "matched venue" even when CORE rank is N/A (some venues are explicitly unranked in CORE).
                                    if (resolvedDetails === null && attempt === "N/A" && details && details.matchedVenue) {
                                        resolvedDetails = details;
                                    }
                                }
                                currentRank = resolvedRank ?? "N/A";
                                if (resolvedDetails) {
                                    matchedVenue = resolvedDetails.matchedVenue ?? matchedVenue;
                                    venueMatchConfidence = resolvedDetails.venueMatchConfidence ?? venueMatchConfidence;
                                    decisionMeta = mergeDecisionMeta(decisionMeta, {
                                        decisionStatus: resolvedDetails.decisionStatus ?? (VALID_RANKS.includes(currentRank) ? DECISION_STATUS.MATCHED : DECISION_STATUS.UNRANKED),
                                        confidence: resolvedDetails.venueMatchConfidence ?? decisionMeta.confidence,
                                        matchedKey: resolvedDetails.matchedKey ?? matchedVenue,
                                        decisionEvidence: resolvedDetails.decisionEvidence ?? null
                                    });
                                }
                                // If this is a workshop and we didn't find a CORE rank for the workshop itself, mark as N/A (Workshop)
                                if (currentRank === 'N/A' && trackInfo.isWorkshop) {
                                    naReason = naReason || 'Workshop';
                                }
                                if (currentRank === 'N/A' && resolvedDetails?.decisionStatus === DECISION_STATUS.AMBIGUOUS) {
                                    naReason = naReason || 'Ambiguous Venue Match';
                                }
                        }
                        // Page-length override (strictly < 6 pages) unless already classified as Demo/Poster or Workshop.
                        if (pageCount !== null && pageCount < 6 && !trackInfo.isDemoPoster && !trackInfo.isWorkshop) {
                            currentRank = 'N/A';
                            naReason = 'Short-paper';
                            decisionMeta = mergeDecisionMeta(decisionMeta, {
                                decisionStatus: DECISION_STATUS.UNRANKED,
                                decisionEvidence: [...(trackInfo.signals || []), 'short_by_pages']
                            });
                        }
                    }
                } else {
                    // Strict DBLP-only: do not use Scholar metadata for ranking.
                    // If a Scholar entry cannot be matched to the matched DBLP profile,
                    // flag it as missing rather than attempting any Scholar-based inference.
                    rankingSystem = 'DBLP';
                    currentRank = DBLP_ENTRY_MISSING_LABEL;
                    naReason = null;
                    decisionMeta = mergeDecisionMeta(decisionMeta, {
                        decisionStatus: DECISION_STATUS.MISSING,
                        decisionEvidence: ['dblp_entry_missing']
                    });
                }
            }
            catch (error) {
                console.warn(`GSR Error processing publication (URL: ${pubInfo.url}, Title: "${pubInfo.titleText.substring(0, 50)}..."):`, error);
            }
            const hasCoreRank = rankingSystem === 'CORE' && VALID_RANKS.includes(currentRank);
            const hasSjrRank = rankingSystem === 'SJR' && SJR_QUARTILES.includes(currentRank);
            if (hasCoreRank || hasSjrRank) {
                titlesAlreadyProcessedSet.add(pubInfo.titleText);
                if (dblpKeyUsedForThisRanking) {
                    dblpKeysUsedSet.add(dblpKeyUsedForThisRanking);
                }
            }
            if (hasCoreRank || hasSjrRank) {
                decisionMeta = mergeDecisionMeta(decisionMeta, {
                    decisionStatus: DECISION_STATUS.MATCHED,
                    confidence: venueMatchConfidence ?? matchConfidence ?? decisionMeta.confidence
                });
            }
            else if (currentRank === 'N/A' && decisionMeta.decisionStatus === DECISION_STATUS.MISSING) {
                decisionMeta = mergeDecisionMeta(decisionMeta, {
                    decisionStatus: DECISION_STATUS.UNRANKED
                });
            }
            return { rank: currentRank, system: rankingSystem, reason: (currentRank === 'N/A' ? naReason : null), rowElement: pubInfo.rowElement, titleText: pubInfo.titleText, url: pubInfo.url, shouldPersist, matchConfidence, matchedVenue, venueMatchConfidence, dblpVenue, sourceYear, ...decisionMeta };
        };
        for (const pubInfo of publicationLinkElements) {
            const result = await processPublication(pubInfo, scholarTitlesAlreadyRanked, dblpKeysAlreadyUsedForRank);
            if (result.system === 'CORE') {
                const coreKey = VALID_RANKS.includes(result.rank) ? result.rank : 'N/A';
                coreRankCounts[coreKey] += 1;
            }
            else if (result.system === 'SJR') {
                const sjrKey = SJR_QUARTILES.includes(result.rank) ? result.rank : 'N/A';
                sjrRankCounts[sjrKey] += 1;
            }
            displayRankBadgeAfterTitle(result.rowElement, result.rank, result.system, result.reason, result);
            const publicationRankInfo = {
                titleText: result.titleText,
                rank: result.rank,
                system: result.system,
                reason: result.reason,
                url: result.url,
                matchConfidence: result.matchConfidence ?? null,
                matchedVenue: result.matchedVenue ?? null,
                venueMatchConfidence: result.venueMatchConfidence ?? null,
                dblpVenue: result.dblpVenue ?? null,
                sourceYear: result.sourceYear ?? null,
                sourceYearFallback: result.sourceYearFallback === true,
                decisionVersion: result.decisionVersion ?? DECISION_VERSION,
                decisionStatus: result.decisionStatus ?? null,
                confidence: result.confidence ?? null,
                matchedKey: result.matchedKey ?? null,
                matchedSourceId: result.matchedSourceId ?? null,
                decisionEvidence: result.decisionEvidence ?? null
            };
            determinedPublicationRanks.push(publicationRankInfo);
            if (result.shouldPersist !== false) {
                persistentPublicationRanks.push(publicationRankInfo);
            }
            processedCount++;
            updateStatusElement(statusElement, processedCount, publicationLinkElements.length, "Ranking");
        }
        if (currentUserId && persistentPublicationRanks.length > 0) {
            await saveCachedData(currentUserId, coreRankCounts, sjrRankCounts, persistentPublicationRanks, cachedDblpPidForSave);
        }
        displaySummaryPanel(coreRankCounts, sjrRankCounts, currentUserId, determinedPublicationRanks, Date.now(), cachedDblpPidForSave);
    }
    catch (error) {
        if (error instanceof DblpRateLimitError) {
            console.warn("GSR: Caught a DBLP rate limit error. Displaying message to user.", error.message);
            displayDblpRateLimitError();
        }
        else if (error instanceof DblpUnavailableError) {
            console.warn("GSR: DBLP appears unavailable. Displaying friendly message.", error.message);
            displayDblpUnavailableError();
        }
        else {
            console.error("GSR: Uncaught error in main pipeline:", error);
            const statusElem = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("An error occurred in main pipeline.");
            const currentStatusText = statusElem.querySelector('.gsr-status-text');
            if (currentStatusText)
                currentStatusText.textContent = "Error in main. Check console.";
            const progressBar = statusElem.querySelector('.gsr-progress-bar-inner');
            if (progressBar)
                progressBar.style.backgroundColor = 'red';
        }
    }
    finally {
        isMainProcessing = false;
    }
}
// --- END: Main Orchestration ---
async function initialLoad() {
    if (isMainProcessing) {
        return;
    }
    await loadSettingsIntoState();
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    const userId = getScholarUserId();
    if (userId) {
        const cached = await loadCachedData(userId);
        if (cached && cached.publicationRanks) {
            const pubRanksArr = unpackRanks(cached.publicationRanks);
            displaySummaryPanel(cached.coreRankCounts, cached.sjrRankCounts, userId, pubRanksArr, cached.timestamp, cached.dblpAuthorPid);
            return;
        }
    }
    if (currentSettings.autoRun === false) {
        displayDormantStatus();
        return;
    }
    main().catch(error => {
        // Errors are now handled inside main(), so this top-level catch is a final fallback.
        if (!(error instanceof DblpRateLimitError)) {
            console.error("GSR: Error during initial full analysis in main():", error);
            const statusElem = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("A critical error occurred.");
            const statusText = statusElem.querySelector('.gsr-status-text');
            if (statusText)
                statusText.textContent = "Critical Error. Check console.";
            const progressBar = statusElem.querySelector('.gsr-progress-bar-inner');
            if (progressBar)
                progressBar.style.backgroundColor = 'red';
        }
    });
}
function executeInitialLoad() {
    initialLoad();
}
let pageInitializationObserver = null;
if (chrome?.storage?.onChanged && SETTINGS_API?.SETTINGS_KEY) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
        if (areaName !== 'local' || !changes[SETTINGS_API.SETTINGS_KEY]) {
            return;
        }
        await loadSettingsIntoState();
        if (!activeSummaryFilter) {
            activeSummaryFilter = currentSettings.defaultHighlightMode !== 'none'
                ? { type: 'preset', mode: currentSettings.defaultHighlightMode }
                : null;
        }
        previewSummaryFilter = null;
        if (activeCachedPublicationRanks && activeCachedPublicationRanks.length > 0) {
            restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks);
        }
        else {
            applyActiveSummaryFilter();
        }
    });
}
function attemptPageInitialization() {
    if (isMainProcessing && (document.getElementById(STATUS_ELEMENT_ID) || document.getElementById(SUMMARY_PANEL_ID))) {
        return true;
    }
    if (document.getElementById(SUMMARY_PANEL_ID)) {
        return true;
    }
    if (window.location.pathname.includes("/citations")) {
        const tableBodyElement = document.getElementById('gsc_a_b');
        if (tableBodyElement) {
            if (pageInitializationObserver) {
                pageInitializationObserver.disconnect();
                pageInitializationObserver = null;
            }
            setTimeout(executeInitialLoad, 500);
            return true;
        }
    }
    else {
        if (pageInitializationObserver) {
            pageInitializationObserver.disconnect();
            pageInitializationObserver = null;
        }
    }
    return false;
}
if (!attemptPageInitialization()) {
    pageInitializationObserver = new MutationObserver(() => {
        if (attemptPageInitialization()) {
            // Observer is disconnected within the function
        }
    });
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            if (document.documentElement && pageInitializationObserver) {
                pageInitializationObserver.observe(document.documentElement, { childList: true, subtree: true });
            }
        });
    }
    else {
        if (document.documentElement && pageInitializationObserver) {
            pageInitializationObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    }
    setTimeout(() => {
        if (pageInitializationObserver) {
            pageInitializationObserver.disconnect();
            pageInitializationObserver = null;
        }
    }, 15000);
}
