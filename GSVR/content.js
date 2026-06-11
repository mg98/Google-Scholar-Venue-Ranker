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
class DblpBusyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DblpBusyError';
    }
}
class DblpTransientLookupError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DblpTransientLookupError';
    }
}
class ScanSessionCancelledError extends Error {
    constructor(message = 'Scan session was superseded by a newer run.') {
        super(message);
        this.name = 'ScanSessionCancelledError';
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
    const timeoutMs = Number.isFinite(Number(init?.timeoutMs)) ? Math.max(250, Number(init.timeoutMs)) : null;
    const requestClass = typeof init?.requestClass === 'string' ? init.requestClass.trim() : null;
    const waitBudgetMs = Number.isFinite(Number(init?.waitBudgetMs)) ? Math.max(0, Number(init.waitBudgetMs)) : null;
    const allowDefer = init?.allowDefer === true;
    const dedupeKey = typeof init?.dedupeKey === 'string' && init.dedupeKey.trim()
        ? init.dedupeKey.trim()
        : `${String(init?.method || 'GET').toUpperCase()}:${url}:${typeof init?.body === 'string' ? init.body : ''}`;
    const fetchInit = init ? {
        ...init
    } : undefined;
    if (fetchInit) {
        delete fetchInit.timeoutMs;
        delete fetchInit.requestClass;
        delete fetchInit.waitBudgetMs;
        delete fetchInit.allowDefer;
        delete fetchInit.dedupeKey;
    }

    // Non-DBLP requests behave exactly like normal fetch.
    if (!isDblp) {
        return globalThis.fetch(input, fetchInit);
    }

    // If runtime messaging isn't available, fall back to direct fetch.
    if (!chrome?.runtime?.sendMessage) {
        return globalThis.fetch(input, fetchInit);
    }

    // Serialize RequestInit safely for message passing.
    const safeInit = fetchInit ? {
        method: fetchInit.method,
        headers: fetchInit.headers,
        body: fetchInit.body,
        credentials: fetchInit.credentials,
        cache: fetchInit.cache,
        redirect: fetchInit.redirect,
        referrer: fetchInit.referrer,
        referrerPolicy: fetchInit.referrerPolicy,
        integrity: fetchInit.integrity,
        keepalive: fetchInit.keepalive,
        mode: fetchInit.mode,
        priority: fetchInit.priority,
        signal: undefined, // signals can't be cloned; service worker has its own timeout logic
    } : undefined;

    try {
        const result = await chrome.runtime.sendMessage({
            type: 'GSVR_FETCH',
            url,
            init: safeInit,
            timeoutMs,
            requestClass,
            waitBudgetMs,
            allowDefer,
            dedupeKey
        });

        if (result && (typeof result.status === 'number')) {
            const headers = new Headers(result.headers || {});
            // Build a real Response so existing code can call .json()/.text() unchanged.
            const proxiedResponse = new Response(result.bodyText ?? '', {
                status: result.status,
                statusText: result.statusText ?? '',
                headers,
            });
            if (result.meta && typeof result.meta === 'object') {
                Object.defineProperty(proxiedResponse, '__gsvrMeta', {
                    value: result.meta,
                    configurable: true
                });
                if (result.meta.failureKind === 'rate_limited') {
                    dblpRateLimitEvents.push({
                        at: new Date().toISOString(),
                        url,
                        retryAfterMs: result.meta.retryAfterMs ?? null,
                        cooldownUntil: result.meta.cooldownUntil ?? null,
                    });
                    dblpRateLimitEvents = dblpRateLimitEvents.slice(-20);
                }
            }
            return proxiedResponse;
        }

        // If background failed unexpectedly, fall back to direct fetch once.
        return globalThis.fetch(input, fetchInit);
    }
    catch (e) {
        // Fall back to direct fetch; caller will handle the error.
        return globalThis.fetch(input, fetchInit);
    }
}
// --- END: MV3 background fetch proxy ---
const DBLP_FETCH_TIMEOUTS_MS = Object.freeze({
    default: 12000,
    authorSearch: 20000,
    authorXml: 20000,
    sparqlProfileCheck: 20000,
    streamFast: 2200,
    streamDepth: 5500,
});
const DBLP_STREAM_RETRY_POLICY = Object.freeze({
    baseDelay: 900,
    maxDelay: 6000,
    maxDepthRetries: 2,
});
const DBLP_PROFILE_MATCH_POLICY = Object.freeze({
    cheapCandidateLimit: 12,
    rescueCandidateLimit: 40,
    cheapHubVariantLimit: 0,
    rescueHubVariantLimit: 40,
    cheapSampleCount: 7,
    cheapSparqlLimit: 200,
    backoffBaseDelay: 2000,
    backoffMaxDelay: 20000,
});
const DBLP_PROFILE_CHECK_CONCURRENCY = 1;
const DBLP_TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 599]);
let dblpStreamBackoffUntil = 0;
let dblpProfileBackoffUntil = 0;
function getGsvrFetchMeta(response) {
    return response && typeof response === 'object' ? response.__gsvrMeta || null : null;
}
function getDblpFailureKind(response) {
    const kind = getGsvrFetchMeta(response)?.failureKind;
    return typeof kind === 'string' && kind.trim() ? kind.trim() : null;
}
function isDblpBusyResponse(response) {
    const failureKind = getDblpFailureKind(response);
    return failureKind === 'busy' || failureKind === 'rate_limited' || failureKind === 'deferred';
}
function isDblpUnavailableResponse(response) {
    return getDblpFailureKind(response) === 'unavailable';
}
function isDblpTransientStatus(status) {
    return DBLP_TRANSIENT_STATUS_CODES.has(Number(status));
}
function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
function parseRetryAfterDelayMs(response, maxDelay = DBLP_STREAM_RETRY_POLICY.maxDelay) {
    const retryAfter = response?.headers?.get?.('retry-after');
    if (!retryAfter)
        return null;
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
async function waitForDblpStreamBackoffIfNeeded() {
    const waitMs = dblpStreamBackoffUntil - Date.now();
    if (waitMs > 0) {
        await sleepMs(waitMs);
    }
}
async function waitForDblpProfileBackoffIfNeeded() {
    const waitMs = dblpProfileBackoffUntil - Date.now();
    if (waitMs > 0) {
        await sleepMs(waitMs);
    }
}
function computeDblpTransientRetryDelayMs(response, attempt) {
    const retryAfterDelayMs = parseRetryAfterDelayMs(response, DBLP_STREAM_RETRY_POLICY.maxDelay);
    const computedDelayMs = Math.min(DBLP_STREAM_RETRY_POLICY.maxDelay, DBLP_STREAM_RETRY_POLICY.baseDelay * Math.pow(2, Math.max(0, attempt)));
    const delayMs = Math.max(retryAfterDelayMs ?? 0, computedDelayMs);
    if (Number(response?.status) === 429) {
        dblpStreamBackoffUntil = Math.max(dblpStreamBackoffUntil, Date.now() + delayMs);
    }
    return delayMs;
}
function computeDblpProfileRetryDelayMs(response, attempt = 0) {
    const retryAfterDelayMs = parseRetryAfterDelayMs(response, DBLP_PROFILE_MATCH_POLICY.backoffMaxDelay);
    const computedDelayMs = Math.min(DBLP_PROFILE_MATCH_POLICY.backoffMaxDelay, DBLP_PROFILE_MATCH_POLICY.backoffBaseDelay * Math.pow(2, Math.max(0, attempt)));
    return Math.max(retryAfterDelayMs ?? 0, computedDelayMs);
}
function noteDblpProfileCooldown(response, attempt = 0) {
    const delayMs = computeDblpProfileRetryDelayMs(response, attempt);
    dblpProfileBackoffUntil = Math.max(dblpProfileBackoffUntil, Date.now() + delayMs);
    return delayMs;
}

function createEmptyCoreRankCounts() {
    return { 'A*': 0, 'A': 0, 'B': 0, 'C': 0, 'N/A': 0 };
}
function createEmptySjrRankCounts() {
    return { 'Q1': 0, 'Q2': 0, 'Q3': 0, 'Q4': 0, 'N/A': 0 };
}
/** array → map */
function packRanks(arr) {
    const obj = {};
    for (const { url, paperTitle, publicationYear, authorCount, rank, system, reason, matchConfidence, matchedVenue, venueMatchConfidence, dblpVenue, sourceYear, sourceYearFallback, decisionVersion, decisionStatus, confidence, matchedKey, matchedSourceId, dblpKey, decisionEvidence, topCandidates } of arr) {
        obj[url] = {
            paperTitle: paperTitle ?? null,
            publicationYear: (typeof publicationYear === 'number' ? publicationYear : null),
            authorCount: (typeof authorCount === 'number' ? authorCount : null),
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
            dblpKey: dblpKey ?? null,
            decisionEvidence: Array.isArray(decisionEvidence) ? decisionEvidence.slice(0, 12) : null,
            topCandidates: Array.isArray(topCandidates) ? topCandidates.slice(0, 6) : null
        };
    }
    return obj;
}
/** map → array */
function unpackRanks(map) {
    return Object.entries(map).map(([url, entry]) => ({
        url,
        paperTitle: entry.paperTitle ?? "",
        publicationYear: (typeof entry.publicationYear === 'number' ? entry.publicationYear : null),
        authorCount: (typeof entry.authorCount === 'number' ? entry.authorCount : null),
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
        dblpKey: entry.dblpKey ?? null,
        decisionEvidence: Array.isArray(entry.decisionEvidence) ? entry.decisionEvidence : null,
        topCandidates: Array.isArray(entry.topCandidates) ? entry.topCandidates : null,
        titleText: String(entry.paperTitle || '').trim().toLowerCase()
    }));
}
const SCORE_CONFIG_API = (typeof window !== 'undefined' && window.GSVRScoreConfig) ? window.GSVRScoreConfig : null;
const SCORE_MODEL_API = (typeof window !== 'undefined' && window.GSVRScoreModel) ? window.GSVRScoreModel : null;
const SCORE_SENSITIVITY_API = (typeof window !== 'undefined' && window.GSVRScoreSensitivity) ? window.GSVRScoreSensitivity : null;
const REPORT_SCHEMA_API = (typeof window !== 'undefined' && window.GSVRReportSchema) ? window.GSVRReportSchema : null;
const TIMELINE_STATS_API = (typeof window !== 'undefined' && window.GSVRTimelineStats) ? window.GSVRTimelineStats : null;
const JOURNAL_MATCH_API = (typeof window !== 'undefined' && window.GSVRJournalMatch) ? window.GSVRJournalMatch : null;
const SCORE_MODEL_VERSION = SCORE_CONFIG_API?.SCORE_MODEL_VERSION || 'gsvr-fractional-venue-v1';
const DEFAULT_SCORE_CONFIG = SCORE_CONFIG_API?.DEFAULT_SCORE_CONFIG || null;
const VALID_RANKS = ["A*", "A", "B", "C"];
const VENUE_PROFILE_INDEX_WEIGHTS = Object.freeze({
    "A*": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.["A*"] ?? 1,
    "A": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.A ?? 0.75,
    "B": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.B ?? 0.5,
    "C": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.C ?? 0.25,
    "Q1": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q1 ?? 0.75,
    "Q2": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q2 ?? 0.5,
    "Q3": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q3 ?? 0.25,
    "Q4": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q4 ?? 0.1
});
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
const FACULTY_SCORE_PANEL_ID = 'gsr-faculty-score-panel';
const SCORE_DETAILS_OVERLAY_ID = 'gsr-score-details-overlay';
const COMPLETENESS_OVERLAY_ID = 'gsr-completeness-overlay';
const BADGE_POPOVER_ID = 'gsr-badge-popover';
const DETAIL_DRAWER_ID = 'gsr-detail-drawer';
const REVIEW_INBOX_OVERLAY_ID = 'gsr-review-inbox-overlay';
const REPORT_PACKET_OVERLAY_ID = 'gsr-report-packet-overlay';
const EXPORT_OVERLAY_ID = 'gsr-export-overlay';
const COMPARE_OVERLAY_ID = 'gsr-compare-overlay';
const MANUAL_DBLP_OVERLAY_ID = 'gsr-manual-dblp-overlay';
const CHANGELOG_NOTES = Object.freeze([
    'Precision-first DBLP matching and cached decision metadata.',
    'Explain drawer, review inbox, export menu, snapshots, and compare mode.',
    'Venue Explorer, insights view, and in-product data freshness reporting.'
]);
const REPORT_FORM_URL = 'https://forms.office.com/r/PbSzWaQmpJ';
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
// Cache schema retained for v2.0.3 (ranking decision pipeline metadata).
const CACHE_VERSION = 11;
const CACHE_PREFIX = `scholarRanker_profile_v${CACHE_VERSION}_`;
const DBLP_PID_CACHE_KEY_PREFIX = 'scholarRanker_dblpPid_v1_';
const MANUAL_DBLP_PID_KEY_PREFIX = 'scholarRanker_manualDblpPid_v1_';
const BUNDLED_SJR_DATA_VERSION = 3;
const CACHE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DBLP_CACHE_DURATION_MS = Number.POSITIVE_INFINITY; // never expires
console.log("Google Scholar Ranker: Content script loaded (v2.0.3 - timeline statistics and historical SJR coverage).");

// --- Strict DBLP-only UI labels ---
const DBLP_MISSING_BADGE_LABEL = 'DBLP Entry Missing';
const DBLP_MISSING_BADGE_TOOLTIP = 'This paper is not indexed in the matched DBLP profile.';
const SETTINGS_API = (typeof window !== 'undefined' && window.GSVRSettings) ? window.GSVRSettings : null;
const FEATURE_STORAGE_KEYS = SETTINGS_API?.FEATURE_STORAGE_KEYS ?? {
    reportDraft: 'gsvr_report_draft_v1',
    enabledRankingPacks: 'gsvr_enabled_ranking_packs_v1',
    dataFreshnessState: 'gsvr_data_freshness_state_v1',
    profileSnapshots: 'gsvr_profile_snapshots_v1',
    savedCompareSet: 'gsvr_saved_compare_set_v1'
};
const DEFAULT_RANKING_PACKS = SETTINGS_API?.DEFAULT_RANKING_PACKS ?? ['core', 'sjr'];
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
let activeScanSessionId = 0;
let activeForegroundScanSessionId = 0;
let activeSummaryFilter = null;
let previewSummaryFilter = null;
let gsrBadgePopoverEl = null;
let gsrBadgePopoverHideTimeout = null;
let gsrSearchOverlayEl = null;
let gsrAboutOverlayEl = null;
let gsrScoreDetailsOverlayEl = null;
let gsrCompletenessOverlayEl = null;
let gsrDetailDrawerEl = null;
let gsrReviewInboxOverlayEl = null;
let gsrReportPacketOverlayEl = null;
let gsrExportOverlayEl = null;
let gsrCompareOverlayEl = null;
let gsrManualDblpOverlayEl = null;
let gsrVenueDatalistPopulated = false;
let gsrDialogLastFocusedEl = null;
let currentRankingPacks = [...DEFAULT_RANKING_PACKS];
let currentSummaryState = null;
let activeDateRangeMode = TIMELINE_STATS_API?.RANGE_FULL || 'full';
let currentProfileContext = {
    userId: null,
    authorName: null,
    dblpAuthorPid: null,
    dblpPidSource: null,
    surfaceMode: 'profile',
    scholarProfileUrl: null
};
let dblpRateLimitEvents = [];
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
const dblpPersonSnapshotCache = new Map();
const dblpAuthorSearchCache = new Map();
const dblpCheapProfileCache = new Map();
const coreAliasIndexCache = {};
function parseYearFromText(value) {
    if (!value)
        return null;
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
}
function normalizeIssnValue(value) {
    return JOURNAL_MATCH_API.normalizeIssnValue(value);
}
function normalizeIssnList(values) {
    return JOURNAL_MATCH_API.normalizeIssnList(values);
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
async function fetchDblpStreamMetadata(streamType, streamId, options = {}) {
    const cacheKey = `${streamType}:${streamId}`;
    if (!streamMetaCache.has(cacheKey)) {
        const persistentCacheKey = buildDblpStreamMetaPersistentCacheKey(streamType, streamId);
        const persistentCacheTtlMs = getPersistentCacheTtlMs('stream');
        const timeoutMs = Number.isFinite(Number(options.timeoutMs))
            ? Math.max(250, Number(options.timeoutMs))
            : DBLP_FETCH_TIMEOUTS_MS.default;
        const transientRetries = Number.isFinite(Number(options.transientRetries))
            ? Math.max(0, Number(options.transientRetries))
            : 0;
        const diagnostics = (options.diagnostics && typeof options.diagnostics === 'object') ? options.diagnostics : null;
        const loadPromise = (async () => {
            let transientFailure = false;
            const notFoundSentinel = { __notFound: true };
            const transientSentinel = { __transient: true };
            const cachedMeta = await loadPersistentDblpCacheEntry(persistentCacheKey, persistentCacheTtlMs);
            if (cachedMeta && typeof cachedMeta === 'object') {
                return cachedMeta;
            }
            const persistResolvedMeta = async (meta) => {
                if (!meta || typeof meta !== 'object') {
                    return meta;
                }
                await savePersistentDblpCacheEntry(persistentCacheKey, meta);
                return meta;
            };
            const fetchStreamResource = async (resourceUrl) => {
                for (let attempt = 0; attempt <= transientRetries; attempt++) {
                    try {
                        await waitForDblpStreamBackoffIfNeeded();
                        const response = await gsvrFetch(resourceUrl, {
                            timeoutMs,
                            requestClass: transientRetries > 0 ? 'stream_depth' : 'stream_fast',
                            waitBudgetMs: transientRetries > 0 ? 6000 : 2500,
                            allowDefer: transientRetries > 0,
                            dedupeKey: resourceUrl
                        });
                        if (!isDblpTransientStatus(response.status)) {
                            return response;
                        }
                        if (isDblpBusyResponse(response)) {
                            transientFailure = true;
                        }
                        if (Number(response.status) === 429 && diagnostics) {
                            diagnostics.rateLimitDetected = true;
                            diagnostics.rateLimitEvents = (Number(diagnostics.rateLimitEvents) || 0) + 1;
                        }
                        if (attempt >= transientRetries) {
                            transientFailure = true;
                            return null;
                        }
                        await sleepMs(computeDblpTransientRetryDelayMs(response, attempt));
                    }
                    catch {
                        if (attempt >= transientRetries) {
                            transientFailure = true;
                            return null;
                        }
                        await sleepMs(Math.min(DBLP_STREAM_RETRY_POLICY.maxDelay, DBLP_STREAM_RETRY_POLICY.baseDelay * Math.pow(2, Math.max(0, attempt))));
                    }
                }
                transientFailure = true;
                return null;
            };
            const streamXmlUrl = `https://dblp.org/streams/${streamType}/${streamId}.xml`;
            try {
                const resp = await fetchStreamResource(streamXmlUrl);
                if (resp?.ok) {
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
                                return persistResolvedMeta({
                                    streamType,
                                    streamId,
                                    acronym,
                                    title,
                                    shortTitle,
                                    issns,
                                    discontinuedYear,
                                    successorRefs,
                                });
                            }
                        }
                    }
                }
            }
            catch {
                transientFailure = true;
            }
            if (transientFailure) {
                return transientSentinel;
            }
            if (streamType === "journals") {
                try {
                    const indexUrl = `https://dblp.org/db/journals/${streamId}/index.xml`;
                    const indexResp = await fetchStreamResource(indexUrl);
                    if (transientFailure) {
                        return transientSentinel;
                    }
                    if (indexResp?.ok) {
                        const indexXml = await indexResp.text();
                        const indexDoc = new DOMParser().parseFromString(indexXml, "application/xml");
                        if (!indexDoc.querySelector("parsererror")) {
                            const titleAttr = indexDoc.querySelector("bht")?.getAttribute("title")?.trim();
                            const h1Title = indexDoc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
                            const title = titleAttr || h1Title || null;
                            const shortTitle = indexDoc.querySelector("short")?.textContent?.trim() || null;
                            const issns = normalizeIssnList(Array.from(indexDoc.querySelectorAll("issn")).map(n => n.textContent || ""));
                            if (title) {
                                return persistResolvedMeta({
                                    streamType,
                                    streamId,
                                    acronym: null,
                                    title,
                                    shortTitle,
                                    issns,
                                    discontinuedYear: null,
                                    successorRefs: [],
                                });
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
                        const htmlResp = await fetchStreamResource(htmlUrl);
                        if (transientFailure) {
                            return transientSentinel;
                        }
                        if (!htmlResp?.ok)
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
                            return persistResolvedMeta({
                                streamType,
                                streamId,
                                acronym: null,
                                title,
                                shortTitle: null,
                                issns,
                                discontinuedYear: null,
                                successorRefs: [],
                            });
                        }
                    }
                }
                catch {
                    transientFailure = true;
                }
            }
            return transientFailure ? transientSentinel : notFoundSentinel;
        })();
        streamMetaCache.set(cacheKey, loadPromise);
    }
    const result = await streamMetaCache.get(cacheKey);
    if (result?.__transient) {
        streamMetaCache.delete(cacheKey);
        return null;
    }
    if (result?.__notFound) {
        return null;
    }
    return result;
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
        const meta = await fetchDblpStreamMetadata(currentType, currentId, options);
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
function getDblpPidCacheKey(userId) {
    return `${DBLP_PID_CACHE_KEY_PREFIX}${userId}`;
}
function getManualDblpPidCacheKey(userId) {
    return `${MANUAL_DBLP_PID_KEY_PREFIX}${userId}`;
}
function extractDblpPidValue(rawValue) {
    const extracted = SETTINGS_API?.extractDblpPid ? SETTINGS_API.extractDblpPid(rawValue) : null;
    if (typeof extracted === 'string' && extracted.trim()) {
        return extracted.trim();
    }
    return null;
}
function extractScholarUserIdFromUrl(rawValue) {
    const extracted = SETTINGS_API?.extractScholarUserId ? SETTINGS_API.extractScholarUserId(rawValue) : null;
    if (typeof extracted === 'string' && extracted.trim()) {
        return extracted.trim();
    }
    return null;
}
function normalizeScholarProfileUrlValue(rawValue) {
    const normalized = SETTINGS_API?.normalizeScholarProfileUrl ? SETTINGS_API.normalizeScholarProfileUrl(rawValue) : null;
    if (typeof normalized === 'string' && normalized.trim()) {
        return normalized.trim();
    }
    return null;
}
function buildDblpStreamMetaPersistentCacheKey(streamType, streamId) {
    if (SETTINGS_API?.buildDblpStreamMetaCacheKey) {
        return SETTINGS_API.buildDblpStreamMetaCacheKey(streamType, streamId);
    }
    const type = String(streamType || '').trim().toLowerCase();
    const id = String(streamId || '').trim().toLowerCase();
    return type && id ? `gsvr_dblp_stream_meta_v1_${encodeURIComponent(`${type}:${id}`)}` : null;
}
function buildDblpAuthorSearchPersistentCacheKey(authorName) {
    if (SETTINGS_API?.buildDblpAuthorSearchCacheKey) {
        return SETTINGS_API.buildDblpAuthorSearchCacheKey(authorName);
    }
    const normalized = encodeURIComponent(String(authorName || '').trim().toLowerCase().replace(/\s+/g, ' '));
    return normalized ? `gsvr_dblp_author_search_v1_${normalized}` : null;
}
function buildDblpCheapProfilePersistentCacheKey(pid) {
    if (SETTINGS_API?.buildDblpCheapProfileCacheKey) {
        return SETTINGS_API.buildDblpCheapProfileCacheKey(pid);
    }
    const normalizedPid = extractDblpPidValue(pid);
    return normalizedPid ? `gsvr_dblp_profile_check_v1_${encodeURIComponent(normalizedPid.toLowerCase())}` : null;
}
function buildLocalVenueCandidateNamesFromEntry(entry) {
    if (SETTINGS_API?.buildLocalVenueCandidateNames) {
        const values = SETTINGS_API.buildLocalVenueCandidateNames(entry);
        return Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.trim()) : [];
    }
    const out = [];
    const seen = new Set();
    const push = (value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
            return;
        }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        out.push(trimmed);
    };
    push(entry?.rawVenue);
    push(entry?.booktitle);
    push(entry?.journal);
    push(entry?.series);
    return out;
}
function getPersistentCacheTtlMs(type) {
    if (type === 'stream') {
        return Number(SETTINGS_API?.DBLP_STREAM_META_CACHE_TTL_MS) || (1000 * 60 * 60 * 24 * 180);
    }
    if (type === 'author-search') {
        return Number(SETTINGS_API?.DBLP_AUTHOR_SEARCH_CACHE_TTL_MS) || (1000 * 60 * 60 * 24 * 30);
    }
    if (type === 'cheap-profile') {
        return Number(SETTINGS_API?.DBLP_CHEAP_PROFILE_CACHE_TTL_MS) || (1000 * 60 * 60 * 24 * 30);
    }
    return 0;
}
async function loadPersistentDblpCacheEntry(storageKey, ttlMs) {
    if (!storageKey || !chrome?.storage?.local?.get) {
        return null;
    }
    try {
        const result = await chrome.storage.local.get(storageKey);
        const entry = result?.[storageKey];
        if (!entry || typeof entry !== 'object') {
            return null;
        }
        const storedAt = Number(entry.storedAt);
        if (Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(storedAt) && (Date.now() - storedAt) > ttlMs) {
            if (chrome?.storage?.local?.remove) {
                chrome.storage.local.remove(storageKey).catch(() => undefined);
            }
            return null;
        }
        return entry.value ?? null;
    }
    catch {
        return null;
    }
}
async function savePersistentDblpCacheEntry(storageKey, value) {
    if (!storageKey || !chrome?.storage?.local?.set) {
        return value;
    }
    try {
        await chrome.storage.local.set({
            [storageKey]: {
                storedAt: Date.now(),
                value
            }
        });
    }
    catch {
        // Ignore cache write failures and continue with live data.
    }
    return value;
}
function extractDblpPersonUrlsFromXmlText(xmlText) {
    if (SETTINGS_API?.extractDblpPersonUrlsFromXml) {
        const urls = SETTINGS_API.extractDblpPersonUrlsFromXml(xmlText);
        return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && url.trim()) : [];
    }
    const text = String(xmlText || '');
    const personBlockMatch = text.match(/<person\b[^>]*>([\s\S]*?)<\/person>/i);
    const personBlock = personBlockMatch?.[1] || '';
    if (!personBlock) {
        return [];
    }
    return Array.from(personBlock.matchAll(/<url>([^<]+)<\/url>/gi))
        .map((match) => String(match?.[1] || '').trim())
        .filter(Boolean);
}
function buildScholarVerificationSampleEntries(entries, count) {
    if (SETTINGS_API?.buildScholarVerificationSample) {
        const sample = SETTINGS_API.buildScholarVerificationSample(entries, count);
        return Array.isArray(sample) ? sample : [];
    }
    return Array.isArray(entries) ? entries.slice(0, Math.max(1, Number(count) || 1)) : [];
}
function selectBestProfileVerificationCandidate(evaluations) {
    if (SETTINGS_API?.selectBestProfileVerificationCandidate) {
        return SETTINGS_API.selectBestProfileVerificationCandidate(evaluations, {
            profileStrongScoreThreshold: RANKING_CONFIG.profileStrongScoreThreshold,
            profileAmbiguityGap: RANKING_CONFIG.profileAmbiguityGap
        });
    }
    const ranked = (Array.isArray(evaluations) ? evaluations : [])
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
        return null;
    }
    const gap = runnerUp ? best.score - runnerUp.score : Number.POSITIVE_INFINITY;
    if (runnerUp && best.score < RANKING_CONFIG.profileStrongScoreThreshold && gap < RANKING_CONFIG.profileAmbiguityGap) {
        return null;
    }
    return best;
}
function shouldEscalateProfileVerificationStatus(status) {
    if (SETTINGS_API?.shouldEscalateProfileVerification) {
        return SETTINGS_API.shouldEscalateProfileVerification(status);
    }
    return status === 'no_match' || status === 'ambiguous';
}
function shouldReuseProfileCacheEntry(cacheEntry) {
    if (SETTINGS_API?.shouldReuseProfileCacheEntry) {
        return SETTINGS_API.shouldReuseProfileCacheEntry(cacheEntry);
    }
    const publicationRanks = cacheEntry?.publicationRanks;
    const hasPublicationRanks = !!publicationRanks
        && typeof publicationRanks === 'object'
        && Object.keys(publicationRanks).length > 0;
    if (!hasPublicationRanks) {
        return true;
    }
    return typeof cacheEntry?.dblpAuthorPid === 'string' && cacheEntry.dblpAuthorPid.trim().length > 0;
}
function getCurrentCoreDataYear() {
    const years = ORDERED_CORE_DATA_FILES
        .map((value) => getCoreDatasetYear(value))
        .filter((value) => Number.isFinite(value));
    return years.length ? Math.max(...years) : null;
}
function getCurrentSjrDataYear() {
    return Number.isFinite(SJR_DATASET_END_YEAR) ? SJR_DATASET_END_YEAR : null;
}
function getCurrentSjrDataVersion() {
    return BUNDLED_SJR_DATA_VERSION;
}
function buildRankingDataVersion() {
    return `core-${getCurrentCoreDataYear() || 'unknown'}__sjr-v${getCurrentSjrDataVersion()}-${getCurrentSjrDataYear() || 'unknown'}`;
}
function buildExpectedCacheMetadata() {
    return {
        scoreModelVersion: SCORE_MODEL_VERSION,
        rankingDataVersion: buildRankingDataVersion(),
        coreDataYear: getCurrentCoreDataYear(),
        sjrDataVersion: getCurrentSjrDataVersion(),
        decisionVersion: DECISION_VERSION
    };
}
function hasMatchingCacheMetadata(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    const expected = buildExpectedCacheMetadata();
    return data.scoreModelVersion === expected.scoreModelVersion
        && data.rankingDataVersion === expected.rankingDataVersion
        && data.coreDataYear === expected.coreDataYear
        && data.sjrDataVersion === expected.sjrDataVersion
        && data.decisionVersion === expected.decisionVersion;
}
async function loadLegacyCachedDblpPid(userId) {
    if (!userId || !chrome?.storage?.local?.get) {
        return null;
    }
    try {
        const allEntries = await chrome.storage.local.get(null);
        if (!allEntries || typeof allEntries !== 'object') {
            return null;
        }
        const legacyMatches = Object.entries(allEntries)
            .filter(([key, value]) => /^scholarRanker_profile_v\d+_/i.test(key)
            && key.endsWith(String(userId))
            && value
            && typeof value === 'object'
            && typeof value.dblpAuthorPid === 'string'
            && value.dblpAuthorPid.trim())
            .sort((left, right) => {
            const leftTimestamp = Number(left[1]?.dblpMatchTimestamp ?? left[1]?.timestamp ?? 0);
            const rightTimestamp = Number(right[1]?.dblpMatchTimestamp ?? right[1]?.timestamp ?? 0);
            return rightTimestamp - leftTimestamp;
        });
        return legacyMatches[0]?.[1]?.dblpAuthorPid?.trim() || null;
    }
    catch {
        return null;
    }
}
async function loadPersistentDblpPid(userId) {
    if (!userId || !chrome?.storage?.local?.get) {
        return null;
    }
    const pidCacheKey = getDblpPidCacheKey(userId);
    try {
        const result = await chrome.storage.local.get(pidCacheKey);
        const cachedPid = result?.[pidCacheKey];
        if (typeof cachedPid === 'string' && cachedPid.trim()) {
            return cachedPid.trim();
        }
    }
    catch {
        // Ignore and fall back below.
    }
    const legacyPid = await loadLegacyCachedDblpPid(userId);
    if (legacyPid) {
        try {
            await chrome.storage.local.set({ [pidCacheKey]: legacyPid });
        }
        catch {
            // Ignore cache write failures; the recovered PID is still usable for this run.
        }
        return legacyPid;
    }
    return null;
}
async function loadManualDblpPid(userId) {
    if (!userId || !chrome?.storage?.local?.get) {
        return null;
    }
    const cacheKey = getManualDblpPidCacheKey(userId);
    try {
        const result = await chrome.storage.local.get(cacheKey);
        const normalizedPid = extractDblpPidValue(result?.[cacheKey]);
        if (normalizedPid) {
            return normalizedPid;
        }
        if (result?.[cacheKey] && chrome?.storage?.local?.remove) {
            await chrome.storage.local.remove(cacheKey);
        }
    }
    catch {
        // Ignore and fall back below.
    }
    return null;
}
async function savePersistentDblpPid(userId, dblpAuthorPid) {
    if (!userId || !dblpAuthorPid || !chrome?.storage?.local?.set) {
        return;
    }
    try {
        await chrome.storage.local.set({ [getDblpPidCacheKey(userId)]: String(dblpAuthorPid).trim() });
    }
    catch {
        // Ignore cache write failures.
    }
}
async function saveManualDblpPid(userId, dblpAuthorPid) {
    const normalizedPid = extractDblpPidValue(dblpAuthorPid);
    if (!userId || !normalizedPid || !chrome?.storage?.local?.set) {
        return;
    }
    try {
        await chrome.storage.local.set({ [getManualDblpPidCacheKey(userId)]: normalizedPid });
    }
    catch {
        // Ignore cache write failures.
    }
}
async function removeManualDblpPid(userId) {
    if (!userId || !chrome?.storage?.local?.remove) {
        return;
    }
    try {
        await chrome.storage.local.remove(getManualDblpPidCacheKey(userId));
    }
    catch {
        // Ignore cache removal failures.
    }
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
                if (!hasMatchingCacheMetadata(data)) {
                    await chrome.storage.local.remove(cacheKey);
                    console.log("GSR INFO: Cached data invalidated by model/data/decision version change for", cacheKey);
                    return null;
                }
                if (!shouldReuseProfileCacheEntry(data)) {
                    await chrome.storage.local.remove(cacheKey);
                    console.log("GSR INFO: Discarded incomplete cached profile data for", cacheKey);
                    return null;
                }
                const isExpired = Number.isFinite(CACHE_DURATION_MS)
                    ? (Date.now() - (data.timestamp ?? 0)) > CACHE_DURATION_MS
                    : false;
                if (!isExpired) {
                    return {
                        ...data,
                        scanStage: data.scanStage || 'depth',
                        fastCompletedAt: Number.isFinite(data.fastCompletedAt) ? data.fastCompletedAt : null,
                        depthCompletedAt: Number.isFinite(data.depthCompletedAt) ? data.depthCompletedAt : null,
                        depthAttemptedAt: Number.isFinite(data.depthAttemptedAt) ? data.depthAttemptedAt : null,
                        depthCompletionDismissed: data.depthCompletionDismissed === true
                    };
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
async function saveCachedData(userId, coreRankCounts, sjrRankCounts, publicationRanks, dblpAuthorPid, scanMetadata = {}) {
    const cacheKey = getCacheKey(userId);
    const dblpPidSource = typeof scanMetadata?.dblpPidSource === 'string' ? scanMetadata.dblpPidSource : null;
    const dataToStore = {
        version: CACHE_VERSION,
        ...buildExpectedCacheMetadata(),
        coreRankCounts,
        sjrRankCounts,
        publicationRanks: packRanks(publicationRanks),
        timestamp: Date.now(),
        dblpAuthorPid: dblpAuthorPid || undefined,
        dblpPidSource: dblpPidSource || undefined,
        dblpMatchTimestamp: dblpAuthorPid ? Date.now() : undefined,
        scanStage: scanMetadata.scanStage || 'depth',
        fastCompletedAt: Number.isFinite(scanMetadata.fastCompletedAt) ? scanMetadata.fastCompletedAt : null,
        depthCompletedAt: Number.isFinite(scanMetadata.depthCompletedAt) ? scanMetadata.depthCompletedAt : null,
        depthAttemptedAt: Number.isFinite(scanMetadata.depthAttemptedAt) ? scanMetadata.depthAttemptedAt : null,
        depthCompletionDismissed: scanMetadata.depthCompletionDismissed === true
    };
    try {
        await chrome.storage.local.set({ [cacheKey]: dataToStore });
        if (dblpPidSource !== 'manual') {
            await savePersistentDblpPid(userId, dblpAuthorPid);
        }
        if (chrome.runtime.lastError) {
            //console.error("DEBUG: saveCachedData - chrome.runtime.lastError:", chrome.runtime.lastError.message);
        }
    }
    catch (error) {
        //console.error("DEBUG: saveCachedData - Error:", error, "Key:", cacheKey);
    }
}
async function setCachedDepthCompletionDismissed(userId, dismissed) {
    if (!userId || !chrome?.storage?.local?.get || !chrome?.storage?.local?.set) {
        return;
    }
    const cacheKey = getCacheKey(userId);
    try {
        const result = await chrome.storage.local.get(cacheKey);
        const cached = result?.[cacheKey];
        if (!cached || cached.version !== CACHE_VERSION) {
            return;
        }
        await chrome.storage.local.set({
            [cacheKey]: {
                ...cached,
                depthCompletionDismissed: dismissed === true
            }
        });
    }
    catch {
        // Ignore cache write failures; the in-page dismissal should still work.
    }
}
async function clearCachedData(userId) {
    const cacheKey = getCacheKey(userId);
    const pidCacheKey = getDblpPidCacheKey(userId);
    try {
        await chrome.storage.local.remove([cacheKey, pidCacheKey]);
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
        dblpPubsForCurrentUser = [];
        scholarUrlToDblpInfoMap.clear();
        scholarUrlToDblpVenueMap.clear();
        streamMetaCache.clear();
        dblpPersonSnapshotCache.clear();
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
    if (SETTINGS_API?.loadRankingPacks) {
        currentRankingPacks = await SETTINGS_API.loadRankingPacks();
    }
    else {
        currentRankingPacks = [...DEFAULT_RANKING_PACKS];
    }
    syncSettingsClasses();
    return currentSettings;
}
function getScholarSampleTargetCount() {
    return 15;
}
function looksLikeVenueAcronym(value) {
    const text = String(value || '').trim();
    return /^[A-Za-z][A-Za-z0-9-]{1,15}$/.test(text);
}
function pushUniqueCaseInsensitive(target, value, seen = null) {
    const list = Array.isArray(target) ? target : [];
    const seenSet = seen instanceof Set ? seen : new Set(list.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return;
    }
    const key = trimmed.toLowerCase();
    if (seenSet.has(key)) {
        return;
    }
    seenSet.add(key);
    list.push(trimmed);
}
function getOrCreateCoreAliasIndexForData(coreDataFile, coreData) {
    if (!Array.isArray(coreData) || !coreData.length) {
        return null;
    }
    if (!coreAliasIndexCache[coreDataFile]) {
        coreAliasIndexCache[coreDataFile] = RANKING_UTILS?.createCoreAliasIndex
            ? RANKING_UTILS.createCoreAliasIndex(coreData)
            : null;
    }
    return coreAliasIndexCache[coreDataFile] || null;
}
function buildExpandedLocalVenueCandidates(entry, trackInfo = null) {
    const utils = RANKING_UTILS;
    const baseCandidates = buildLocalVenueCandidateNamesFromEntry(entry);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value, expandOptions) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
            return;
        }
        const expanded = utils?.expandVenueCandidates ? utils.expandVenueCandidates(trimmed, expandOptions) : [trimmed];
        for (const variant of expanded) {
            pushUniqueCaseInsensitive(candidates, variant, seen);
            const canonical = utils?.canonicalizeCsrankingsVenueName ? utils.canonicalizeCsrankingsVenueName(variant) : null;
            if (canonical) {
                pushUniqueCaseInsensitive(candidates, canonical, seen);
            }
        }
    };
    for (const candidate of baseCandidates) {
        addCandidate(candidate);
    }
    if (trackInfo?.resolvedVenue) {
        addCandidate(trackInfo.resolvedVenue, trackInfo.isWorkshop ? { includeAtParent: false } : undefined);
    }
    if (trackInfo?.parentVenue) {
        addCandidate(trackInfo.parentVenue);
    }
    if (trackInfo?.seriesId) {
        addCandidate(trackInfo.seriesId, trackInfo.isWorkshop ? { includeAtParent: false } : undefined);
    }
    return candidates;
}
async function resolveLocalVenueBeforeStreamLookup(entry, phase = 'fast') {
    const utils = RANKING_UTILS;
    const streamCandidates = Array.isArray(entry?.streamCandidates) ? entry.streamCandidates : [];
    const venueFull = String(entry?.booktitle || entry?.journal || entry?.series || entry?.rawVenue || '').trim() || null;
    const procAcmAcronym = String(entry?.rawVenue || '').startsWith('Proc. ACM') && looksLikeVenueAcronym(entry?.number)
        ? String(entry.number).trim()
        : null;
    const acronymCandidates = [];
    const acronymSeen = new Set();
    pushUniqueCaseInsensitive(acronymCandidates, procAcmAcronym, acronymSeen);
    pushUniqueCaseInsensitive(acronymCandidates, looksLikeVenueAcronym(entry?.number) ? entry.number : null, acronymSeen);
    pushUniqueCaseInsensitive(acronymCandidates, looksLikeVenueAcronym(entry?.rawVenue) ? entry.rawVenue : null, acronymSeen);
    pushUniqueCaseInsensitive(acronymCandidates, looksLikeVenueAcronym(entry?.series) ? entry.series : null, acronymSeen);
    const pageCount = getPageCountFromDblpString(entry?.pages || null);
    const defaultTrackInfo = { isWorkshop: false, isDemoPoster: false, isShortPaper: false, isExtendedAbstract: false, reason: null, resolvedVenue: null, parentVenue: null, seriesId: null, signals: [] };
    const trackInfo = utils?.classifyVenueTrack
        ? utils.classifyVenueTrack({
            title: entry?.title || '',
            venue: entry?.rawVenue || venueFull,
            venue_full: venueFull,
            acronym: acronymCandidates[0] || null,
            dblpKey: entry?.dblpKey || null,
            dblpType: entry?.dblpType || null,
            crossref: entry?.crossref || null,
            scholarVenue: null,
            pageCount
        })
        : defaultTrackInfo;
    const localCandidates = buildExpandedLocalVenueCandidates(entry, trackInfo);
    const isJournalLike = String(entry?.dblpKey || '').toLowerCase().startsWith('journals/')
        || String(entry?.dblpType || '').toLowerCase() === 'article';
    const canFetchStreamMetadata = streamCandidates.length > 0;
    if (isJournalLike) {
        const journalCandidates = localCandidates.filter((candidate) => !looksLikeVenueAcronym(candidate));
        let sawAmbiguous = false;
        for (const candidate of journalCandidates) {
            const localJournalResult = await resolveSjrQuartile(candidate, entry?.numericYear ?? null);
            if (localJournalResult.status === 'success'
                && localJournalResult.quartile
                && SJR_QUARTILES.includes(localJournalResult.quartile)) {
                return {
                    status: 'matched',
                    rankingSystem: 'SJR',
                    candidateNames: journalCandidates,
                    trackInfo,
                    needsStreamMetadata: false,
                    acronym: acronymCandidates[0] || null,
                    venueFull: localJournalResult.resolvedTitle || venueFull || candidate,
                    journalIssns: [],
                    journalShortTitle: null
                };
            }
            if (localJournalResult.status === 'ambiguous') {
                sawAmbiguous = true;
            }
        }
        return {
            status: sawAmbiguous ? 'ambiguous' : 'unresolved',
            rankingSystem: 'SJR',
            candidateNames: journalCandidates,
            trackInfo,
            needsStreamMetadata: canFetchStreamMetadata,
            acronym: acronymCandidates[0] || null,
            venueFull,
            journalIssns: [],
            journalShortTitle: null
        };
    }
    const coreDataFile = getCoreDataFileForYear(entry?.numericYear ?? null);
    const yearSpecificCoreData = await loadCoreDataForFile(coreDataFile);
    const aliasIndex = getOrCreateCoreAliasIndexForData(coreDataFile, yearSpecificCoreData);
    const evaluationCandidates = [];
    const evaluationSeen = new Set();
    for (const candidate of localCandidates) {
        pushUniqueCaseInsensitive(evaluationCandidates, candidate, evaluationSeen);
        const override = utils?.resolveCsrankingsVenueOverride
            ? utils.resolveCsrankingsVenueOverride({
                dblpKey: entry?.dblpKey || null,
                venue: candidate,
                year: entry?.numericYear ?? null,
                volume: entry?.volume || null,
                number: entry?.number || null,
                dblpType: entry?.dblpType || null
            })
            : null;
        if (override?.canonicalVenue) {
            pushUniqueCaseInsensitive(evaluationCandidates, override.canonicalVenue, evaluationSeen);
        }
    }
    let ambiguous = false;
    let bestUnranked = null;
    let matchedCoreResult = null;
    for (const candidate of evaluationCandidates) {
        const resolution = utils?.resolveCoreVenue
            ? utils.resolveCoreVenue({
                venueKey: candidate,
                fullVenueTitle: venueFull,
                coreData: yearSpecificCoreData,
                aliasIndex
            })
            : null;
        if (!resolution) {
            continue;
        }
        if (resolution.status === DECISION_STATUS.MATCHED) {
            matchedCoreResult = resolution;
            break;
        }
        if (resolution.status === DECISION_STATUS.UNRANKED && !bestUnranked) {
            bestUnranked = resolution;
        }
        if (resolution.status === DECISION_STATUS.AMBIGUOUS) {
            ambiguous = true;
        }
    }
    if (matchedCoreResult) {
        pushUniqueCaseInsensitive(acronymCandidates, matchedCoreResult.matchedKey, acronymSeen);
        return {
            status: 'matched',
            rankingSystem: 'CORE',
            candidateNames: evaluationCandidates,
            trackInfo,
            needsStreamMetadata: false,
            acronym: acronymCandidates[0] || null,
            venueFull: venueFull || matchedCoreResult.matchedVenue || null,
            journalIssns: [],
            journalShortTitle: null
        };
    }
    if (bestUnranked && !ambiguous) {
        pushUniqueCaseInsensitive(acronymCandidates, bestUnranked.matchedKey, acronymSeen);
        return {
            status: 'unranked',
            rankingSystem: 'CORE',
            candidateNames: evaluationCandidates,
            trackInfo,
            needsStreamMetadata: false,
            acronym: acronymCandidates[0] || null,
            venueFull: venueFull || bestUnranked.matchedVenue || null,
            journalIssns: [],
            journalShortTitle: null
        };
    }
    return {
        status: ambiguous ? 'ambiguous' : 'unresolved',
        rankingSystem: 'CORE',
        candidateNames: evaluationCandidates,
        trackInfo,
        needsStreamMetadata: canFetchStreamMetadata,
        acronym: acronymCandidates[0] || null,
        venueFull,
        journalIssns: [],
        journalShortTitle: null
    };
}
function shouldResolveDblpStreamMetadata({ dblpKey, dblpType, rawVenue, streamCandidates, localResolution }, phase = 'fast') {
    if (localResolution && localResolution.needsStreamMetadata === false) {
        return false;
    }
    const hasStreamCandidates = Array.isArray(streamCandidates) && streamCandidates.length > 0;
    if (!hasStreamCandidates) {
        return false;
    }
    if (phase === 'depth') {
        return true;
    }
    const dblpKeyLower = String(dblpKey || '').toLowerCase();
    const dblpTypeLower = String(dblpType || '').toLowerCase();
    const venueText = String(rawVenue || '').trim();
    const isJournalLike = dblpKeyLower.startsWith('journals/') || dblpTypeLower === 'article';
    if (isJournalLike) {
        return false;
    }
    if (!venueText) {
        return true;
    }
    if (venueText.startsWith('Proc. ACM') || /^proceedings of /i.test(venueText)) {
        return true;
    }
    return false;
}
function getFacultyScoreWeight(rank) {
    const normalizedRank = String(rank || '').trim().toUpperCase();
    return VENUE_PROFILE_INDEX_WEIGHTS[normalizedRank] ?? 0;
}
function isResearchQualityRankedInfo(info) {
    return (info?.system === 'CORE' && VALID_RANKS.includes(info.rank))
        || (info?.system === 'SJR' && SJR_QUARTILES.includes(info.rank));
}
function getResearchQualityMetrics(info) {
    const rawAuthorCount = Number(info?.authorCount);
    const authorCount = Number.isFinite(rawAuthorCount) && rawAuthorCount > 0 ? Math.round(rawAuthorCount) : null;
    if (!isResearchQualityRankedInfo(info)) {
        return {
            rank: String(info?.rank || '').trim().toUpperCase(),
            weight: 0,
            authorCount,
            credit: 0
        };
    }
    const rank = String(info?.rank || '').trim().toUpperCase();
    const weight = getFacultyScoreWeight(rank);
    return {
        rank,
        weight,
        authorCount,
        credit: weight > 0 && authorCount ? weight / authorCount : 0
    };
}
function nextScanSessionId() {
    activeScanSessionId += 1;
    return activeScanSessionId;
}
function isCurrentScanSession(sessionId) {
    return typeof sessionId === 'number' && sessionId === activeScanSessionId;
}
function throwIfStaleScanSession(sessionId) {
    if (typeof sessionId === 'number' && !isCurrentScanSession(sessionId)) {
        throw new ScanSessionCancelledError();
    }
}
function buildScanLifecycleState(status, message, improvementCount = null) {
    return {
        phase: 'depth',
        status,
        message,
        improvementCount: typeof improvementCount === 'number' ? improvementCount : null
    };
}
function countAdditionalRanksFound(previousRanks, nextRanks) {
    const previousByUrl = new Map((previousRanks || []).map((info) => [normalizeUrlForCache(info?.url || ''), info]));
    let improvementCount = 0;
    for (const nextInfo of nextRanks || []) {
        const normalizedUrl = normalizeUrlForCache(nextInfo?.url || '');
        const previousInfo = previousByUrl.get(normalizedUrl) || null;
        const previousRanked = isRankedResultInfo(previousInfo);
        const nextRanked = isRankedResultInfo(nextInfo);
        if (nextRanked && (!previousRanked || previousInfo?.rank !== nextInfo?.rank || previousInfo?.system !== nextInfo?.system)) {
            improvementCount += 1;
        }
    }
    return improvementCount;
}
function collectPublicationLinkElements() {
    const publicationLinkElements = [];
    document.querySelectorAll('tr.gsc_a_tr').forEach((row) => {
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
                paperTitle: linkEl.textContent.trim(),
                titleText: linkEl.textContent.trim().toLowerCase(),
                yearFromProfile
            });
        }
    });
    return publicationLinkElements;
}
async function rescanCurrentProfile(options = {}) {
    if (isMainProcessing) {
        return;
    }
    const sessionId = nextScanSessionId();
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    dblpRateLimitEvents = [];
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    currentSummaryState = null;
    const currentUserId = getScholarUserId();
    if (currentUserId) {
        if (options?.clearManualOverride === true) {
            await removeManualDblpPid(currentUserId);
        }
        await clearCachedData(currentUserId);
    }
    main({ sessionId, forceFresh: true }).catch(error => {
        console.error('GSR: Error during rescan after cache clear:', error);
        const statusElemCheck = document.getElementById(STATUS_ELEMENT_ID);
        if (!statusElemCheck) {
            const statusElem = createStatusElement('Error during rescan. Check console.');
            const progress = statusElem.querySelector('.gsr-progress-bar-inner');
            if (progress) {
                progress.style.backgroundColor = 'red';
            }
            appendStatusRescanControls(statusElem);
        }
    });
}
async function clearManualDblpOverrideForCurrentProfile() {
    await rescanCurrentProfile({ clearManualOverride: true });
}
function appendStatusRescanControls(statusElement, { includeReload = false, includeManualEntry = false, rescanLabel = 'Rescan' } = {}) {
    if (!statusElement) {
        return;
    }
    let actions = statusElement.querySelector('.gsr-status-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'gsr-card__actions gsr-status-actions';
        statusElement.appendChild(actions);
    }
    actions.replaceChildren();
    const rescanButton = document.createElement('button');
    rescanButton.type = 'button';
    rescanButton.className = 'gsr-button gsr-button--primary';
    rescanButton.textContent = rescanLabel;
    rescanButton.addEventListener('click', () => {
        rescanCurrentProfile().catch((error) => console.error('GSR: Failed to start rescan.', error));
    });
    actions.appendChild(rescanButton);
    if (includeManualEntry) {
        const manualButton = document.createElement('button');
        manualButton.type = 'button';
        manualButton.className = 'gsr-button gsr-button--secondary';
        manualButton.textContent = 'Add My DBLP Profile';
        manualButton.addEventListener('click', () => {
            openManualDblpOverrideOverlay().catch((error) => console.error('GSR: Failed to open manual DBLP overlay.', error));
        });
        actions.appendChild(manualButton);
    }
    if (includeReload) {
        const reloadButton = document.createElement('button');
        reloadButton.type = 'button';
        reloadButton.className = 'gsr-button gsr-button--ghost';
        reloadButton.textContent = 'Reload Page';
        reloadButton.addEventListener('click', () => {
            window.location.reload();
        });
        actions.appendChild(reloadButton);
    }
}
function isRankingPackEnabled(packName) {
    return currentRankingPacks.includes(String(packName || '').trim().toLowerCase());
}
async function loadFeatureState(name) {
    if (SETTINGS_API?.loadFeatureState) {
        return SETTINGS_API.loadFeatureState(name);
    }
    const key = FEATURE_STORAGE_KEYS[name];
    if (!key || !chrome?.storage?.local?.get) {
        return null;
    }
    try {
        const result = await chrome.storage.local.get(key);
        return result?.[key] ?? null;
    }
    catch {
        return null;
    }
}
async function saveFeatureState(name, value) {
    if (SETTINGS_API?.saveFeatureState) {
        return SETTINGS_API.saveFeatureState(name, value);
    }
    const key = FEATURE_STORAGE_KEYS[name];
    if (!key || !chrome?.storage?.local?.set) {
        return value;
    }
    await chrome.storage.local.set({ [key]: value });
    return value;
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
function humanizeIdentifier(value) {
    return String(value || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (match) => match.toUpperCase());
}
function getPaperTitle(info) {
    return String(info?.paperTitle || info?.titleText || '').trim();
}
function getPublicationYear(info) {
    return Number.isFinite(info?.publicationYear) ? info.publicationYear : null;
}
function getDecisionEvidenceTokens(info) {
    return Array.isArray(info?.decisionEvidence)
        ? info.decisionEvidence.filter((value) => !!value).map((value) => String(value))
        : [];
}
function humanizeEvidenceToken(token) {
    const value = String(token || '').trim();
    if (!value)
        return '';
    if (value.startsWith('source:')) {
        return `Source ID ${value.slice('source:'.length)}`;
    }
    const map = {
        dblp_entry_missing: 'DBLP entry missing from matched profile',
        publication_ambiguous: 'DBLP publication match is ambiguous',
        ambiguous_fuzzy_core: 'CORE venue match is ambiguous',
        ambiguous_acronym: 'Venue acronym is ambiguous',
        ambiguous_title_alias: 'Venue title alias is ambiguous',
        sjr_ambiguous: 'SJR journal match is ambiguous',
        sjr_historical_coverage_unavailable: 'SJR historical coverage unavailable',
        short_by_pages: 'Excluded by short-paper page rule',
        extended_abstract: 'Excluded as extended abstract',
        demo_poster: 'Excluded as demo/poster track',
        editorship: 'Excluded as editorship entry',
        no_core_match: 'No bundled CORE match',
        top_venue_fallback: 'CSRankings top-venue fallback applied',
    };
    return map[value] || humanizeIdentifier(value);
}
function getReviewReason(info) {
    if (info?.system === 'DBLP' && info?.rank === DBLP_ENTRY_MISSING_LABEL) {
        return 'DBLP Entry Missing';
    }
    if (info?.reason) {
        return String(info.reason);
    }
    const evidence = getDecisionEvidenceTokens(info);
    if (evidence.some((token) => token === 'dblp_entry_missing')) {
        return 'DBLP Entry Missing';
    }
    if (evidence.some((token) => token.includes('ambiguous'))) {
        return 'Ambiguous Match';
    }
    if (evidence.includes('sjr_historical_coverage_unavailable')) {
        return 'SJR Historical Coverage Unavailable';
    }
    if (evidence.includes('short_by_pages')) {
        return 'Short-paper';
    }
    if (evidence.includes('extended_abstract')) {
        return 'Extended Abstract';
    }
    if (evidence.includes('demo_poster')) {
        return 'Demo/Poster';
    }
    if (evidence.includes('editorship')) {
        return 'Editorship';
    }
    if (info?.decisionStatus === DECISION_STATUS.AMBIGUOUS) {
        return 'Ambiguous Match';
    }
    if (info?.decisionStatus === DECISION_STATUS.MISSING) {
        return 'Missing Evidence';
    }
    return 'Unranked';
}
function getDblpEntryUrl(info) {
    if (!info?.dblpKey) {
        return null;
    }
    return `https://dblp.org/rec/${info.dblpKey}.html`;
}
function formatConfidencePercent(value) {
    return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'N/A';
}
function formatTimestamp(value) {
    if (!value) {
        return 'Never';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function getTopCandidates(info) {
    return Array.isArray(info?.topCandidates) ? info.topCandidates : [];
}
function buildEvidenceItems(info) {
    const items = [];
    for (const token of getDecisionEvidenceTokens(info)) {
        items.push({
            raw: token,
            label: humanizeEvidenceToken(token),
        });
    }
    return items;
}
function buildFacultyScoreState(publicationRanks) {
    const profileScore = SCORE_MODEL_API?.computeProfileScore
        ? SCORE_MODEL_API.computeProfileScore(publicationRanks || [], DEFAULT_SCORE_CONFIG || undefined)
        : null;
    const countedPublications = [];
    const tierCredits = {
        'A*': 0,
        'A': 0,
        'B': 0,
        'C': 0,
        'Q1': 0,
        'Q2': 0,
        'Q3': 0,
        'Q4': 0
    };
    let totalScore = 0;

    if (profileScore) {
        for (const scored of profileScore.publications || []) {
            const info = scored.raw || {};
            const contribution = Number(scored.score?.contribution) || 0;
            const rank = String(scored.score?.rank || scored.ranking?.rank || info.rank || '').trim().toUpperCase();
            if (contribution <= 0 || !rank) {
                continue;
            }
            totalScore += contribution;
            if (typeof tierCredits[rank] !== 'number') {
                tierCredits[rank] = 0;
            }
            tierCredits[rank] += contribution;
            countedPublications.push({
                title: getPaperTitle(info),
                venue: info?.matchedVenue || info?.dblpVenue || 'Unknown Venue',
                system: scored.score?.rankSource || scored.ranking?.source || info?.system || 'UNKNOWN',
                rank,
                weight: Number(scored.score?.venueValue ?? scored.ranking?.venueValue) || getFacultyScoreWeight(rank),
                credit: contribution,
                authorCount: Number(scored.score?.authorCount) || null,
                fractionalCredit: Number(scored.score?.fractionalCredit) || null,
                rankingSnapshotYear: scored.score?.rankingSnapshotYear ?? scored.ranking?.rankingSnapshotYear ?? info?.sourceYear ?? null,
                year: getPublicationYear(info),
                decisionEvidence: getDecisionEvidenceTokens(info),
                publicationType: scored.classification?.publicationType ?? null,
                scoreEligible: scored.score?.eligible === true,
                exclusionReason: scored.score?.exclusionReason ?? null
            });
        }
    }
    else {
        for (const info of publicationRanks || []) {
            if (!isResearchQualityRankedInfo(info)) {
                continue;
            }
            const { rank, weight, authorCount, credit } = getResearchQualityMetrics(info);
            if (weight <= 0) {
                continue;
            }
            totalScore += credit;
            if (typeof tierCredits[rank] !== 'number') {
                tierCredits[rank] = 0;
            }
            tierCredits[rank] += credit;
            countedPublications.push({
                title: getPaperTitle(info),
                venue: info?.matchedVenue || info?.dblpVenue || 'Unknown Venue',
                system: info?.system || 'UNKNOWN',
                rank,
                weight,
                credit,
                authorCount,
                year: getPublicationYear(info),
                decisionEvidence: getDecisionEvidenceTokens(info)
            });
        }
    }

    countedPublications.sort((left, right) => right.credit - left.credit
        || right.weight - left.weight
        || String(left.system).localeCompare(String(right.system))
        || String(left.title).localeCompare(String(right.title)));
    const scoreSummary = profileScore?.scores || {};
    const diagnostics = profileScore?.diagnostics || null;
    const completeness = profileScore?.completeness || normalizeScoringCompleteness(null, diagnostics, scoreSummary, publicationRanks);
    const fractionalPublicationWeight = Number(scoreSummary.fractionalPublicationWeight ?? countedPublications.reduce((total, item) => total + (Number(item.fractionalCredit) || 0), 0));
    const eligibleRankedPublications = Number(scoreSummary.eligibleRankedPublications ?? countedPublications.length);
    const gsvrScore = Number(scoreSummary.gsvrScore ?? totalScore);
    const averageVenueValue = Number(scoreSummary.averageVenueValue ?? (fractionalPublicationWeight > 0 ? gsvrScore / fractionalPublicationWeight : 0));
    return {
        totalScore: gsvrScore,
        gsvrScore,
        adjustedCount: gsvrScore,
        normalizedIndex: gsvrScore,
        denominator: fractionalPublicationWeight,
        fractionalPublicationWeight,
        eligibleRankedPublications,
        averageVenueValue,
        coreContribution: Number(scoreSummary.coreContribution ?? 0),
        sjrContribution: Number(scoreSummary.sjrContribution ?? 0),
        coreIndex: profileScore?.coreIndex ?? null,
        sjrIndex: profileScore?.sjrIndex ?? null,
        combinedIndex: profileScore?.scores ?? null,
        coverage: diagnostics,
        diagnostics,
        completeness,
        scoreModelVersion: profileScore?.scoreModelVersion || SCORE_MODEL_VERSION,
        calibrationStrategy: 'fractional_venue_score',
        authorshipModel: 'fractional_counting',
        rawProfileScore: profileScore,
        tierCredits,
        countedPapers: eligibleRankedPublications,
        averageCreditPerPaper: eligibleRankedPublications > 0 ? gsvrScore / eligibleRankedPublications : 0,
        countedPublications,
    };
}
function normalizeScoringCompleteness(rawCompleteness = null, diagnostics = null, scores = null, publicationRanks = null) {
    const raw = rawCompleteness && typeof rawCompleteness === 'object' ? rawCompleteness : {};
    const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
    const score = scores && typeof scores === 'object' ? scores : {};
    const totalFallback = Array.isArray(publicationRanks) ? publicationRanks.length : 0;
    const counts = {
        total: Number(raw.total ?? diag.totalScholarItems ?? totalFallback) || 0,
        scored: Number(raw.scored ?? score.eligibleRankedPublications ?? diag.eligibleRankedPublications ?? 0) || 0,
        dblpMissing: Number(raw.dblpMissing ?? diag.dblpMissing ?? diag.missingDblp ?? 0) || 0,
        ambiguous: Number(raw.ambiguous ?? diag.ambiguousMatches ?? diag.ambiguous ?? 0) || 0,
        rankNotFound: Number(raw.rankNotFound ?? diag.unrankedVenues ?? diag.sourceMissing ?? 0) || 0,
        excludedType: Number(raw.excludedType ?? (
            Number(diag.excludedShortPapers || 0)
            + Number(diag.excludedWorkshops || 0)
            + Number(diag.excludedDemosPosters || 0)
            + Number(diag.excludedExtendedAbstracts || 0)
            + Number(diag.excludedPreprints || 0)
        )) || 0,
        missingAuthorCount: Number(raw.missingAuthorCount ?? diag.missingAuthorCount ?? 0) || 0,
        lookupUnavailable: Number(raw.lookupUnavailable ?? (
            Number(diag.sourceRateLimited || 0)
            + Number(diag.sourceUnavailable || 0)
        )) || 0,
    };
    const segmentDefinitions = [
        ['scored', 'Scored'],
        ['dblpMissing', 'DBLP missing'],
        ['ambiguous', 'Ambiguous match'],
        ['rankNotFound', 'Venue unranked'],
        ['excludedType', 'Excluded type'],
        ['missingAuthorCount', 'Missing author count'],
        ['lookupUnavailable', 'Lookup unavailable'],
    ];
    return {
        ...counts,
        completeness: counts.total > 0 ? counts.scored / counts.total : 0,
        formula: raw.formula || 'N_scored / N_total',
        segments: segmentDefinitions.map(([key, label]) => ({
            key,
            label,
            count: counts[key],
            ratio: counts.total > 0 ? counts[key] / counts.total : 0,
        })),
    };
}
function formatCompletenessPercent(completeness) {
    const value = Number(completeness?.completeness ?? completeness ?? 0);
    return `${Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100)}%`;
}
function getCompletenessBreakdownText(completeness) {
    const value = normalizeScoringCompleteness(completeness);
    const unavailable = value.lookupUnavailable + value.missingAuthorCount;
    return `${value.dblpMissing} DBLP missing · ${value.ambiguous} ambiguous · ${value.rankNotFound} unranked · ${value.excludedType} excluded · ${unavailable} unavailable/metadata`;
}
function createScoringCompletenessBar(completeness, className = '') {
    const value = normalizeScoringCompleteness(completeness);
    const bar = document.createElement('div');
    bar.className = `gsr-completeness-bar${className ? ` ${className}` : ''}`.trim();
    bar.setAttribute('aria-hidden', 'true');
    for (const segment of value.segments || []) {
        if (!segment.count) {
            continue;
        }
        const part = document.createElement('span');
        part.className = `gsr-completeness-bar__segment gsr-completeness-bar__segment--${segment.key}`;
        part.style.flexGrow = String(Math.max(0, Number(segment.count) || 0));
        part.title = `${segment.label}: ${segment.count}`;
        bar.appendChild(part);
    }
    if (!bar.children.length) {
        const empty = document.createElement('span');
        empty.className = 'gsr-completeness-bar__segment gsr-completeness-bar__segment--empty';
        empty.style.flexGrow = '1';
        bar.appendChild(empty);
    }
    return bar;
}
function getTimelineCurrentYear() {
    return new Date().getFullYear();
}
function normalizeDateRangeMode(mode) {
    return TIMELINE_STATS_API?.normalizeRangeMode
        ? TIMELINE_STATS_API.normalizeRangeMode(mode)
        : (mode === 'last10' ? 'last10' : 'full');
}
function buildTimelineViewState(publicationRanks, rangeMode = activeDateRangeMode) {
    const source = Array.isArray(publicationRanks) ? publicationRanks : [];
    const currentYear = getTimelineCurrentYear();
    if (TIMELINE_STATS_API?.buildTimelineStats) {
        return TIMELINE_STATS_API.buildTimelineStats(source, {
            rangeMode: normalizeDateRangeMode(rangeMode),
            currentYear,
            recentYears: 8,
        });
    }
    const mode = normalizeDateRangeMode(rangeMode);
    const range = mode === 'last10'
        ? { mode, label: 'Last 10 Years', startYear: currentYear - 9, endYear: currentYear }
        : { mode: 'full', label: 'Full Timeline', startYear: null, endYear: null };
    const getYear = (info) => getPublicationYear(info);
    const filtered = range.mode === 'last10'
        ? source.filter((info) => {
            const year = getYear(info);
            return year != null && year >= range.startYear && year <= range.endYear;
        })
        : source.slice();
    const coreRankCounts = createEmptyCoreRankCounts();
    const sjrRankCounts = createEmptySjrRankCounts();
    for (const info of filtered) {
        if (info?.system === 'CORE') {
            coreRankCounts[VALID_RANKS.includes(info.rank) ? info.rank : 'N/A'] += 1;
        }
        else if (info?.system === 'SJR') {
            sjrRankCounts[SJR_QUARTILES.includes(info.rank) ? info.rank : 'N/A'] += 1;
        }
    }
    const buildWindow = (items, startYear, endYear) => {
        const buckets = new Map();
        for (let year = startYear; year <= endYear; year++) {
            buckets.set(year, {
                year,
                ranks: { 'A*': 0, A: 0, B: 0, C: 0, Q1: 0, Q2: 0, Q3: 0, Q4: 0 },
                conference: 0,
                journal: 0,
                total: 0,
            });
        }
        for (const info of items) {
            const year = getYear(info);
            const bucket = buckets.get(year);
            if (!bucket)
                continue;
            if (info?.system === 'CORE' && VALID_RANKS.includes(info.rank)) {
                bucket.ranks[info.rank] += 1;
                bucket.conference += 1;
                bucket.total += 1;
            }
            else if (info?.system === 'SJR' && SJR_QUARTILES.includes(info.rank)) {
                bucket.ranks[info.rank] += 1;
                bucket.journal += 1;
                bucket.total += 1;
            }
        }
        return Array.from(buckets.values());
    };
    const knownYears = source.map(getYear).filter((year) => year != null);
    const recentHistogram = buildWindow(filtered, currentYear - 7, currentYear);
    const fullHistogram = knownYears.length ? buildWindow(source, Math.min(...knownYears), Math.max(...knownYears)) : [];
    return {
        rangeMode: range.mode,
        range,
        currentYear,
        publications: filtered,
        allPublications: source,
        coreRankCounts,
        sjrRankCounts,
        recentHistogram,
        fullHistogram,
        focusedHistograms: {
            recent: buildFocusedTimelineHistograms(recentHistogram),
            full: buildFocusedTimelineHistograms(fullHistogram),
        },
        unknownYearCount: filtered.filter((info) => getYear(info) == null).length,
        allUnknownYearCount: source.filter((info) => getYear(info) == null).length,
    };
}
function buildSummaryInsights(coreRankCounts, sjrRankCounts, publicationRanks) {
    const topRankedVenues = new Map();
    const reviewReasonCounts = new Map();
    const yearly = new Map();
    let rankedCount = 0;
    let conferenceCount = 0;
    let journalCount = 0;
    let reviewCount = 0;
    for (const info of publicationRanks || []) {
        const year = getPublicationYear(info);
        const yearKey = year != null ? String(year) : 'Unknown';
        if (!yearly.has(yearKey)) {
            yearly.set(yearKey, { year: yearKey, ranked: 0, review: 0, conference: 0, journal: 0 });
        }
        const bucket = yearly.get(yearKey);
        const ranked = isRankedResultInfo(info);
        if (ranked) {
            rankedCount++;
            bucket.ranked += 1;
            const venueKey = String(info.matchedVenue || info.dblpVenue || info.rank || 'Unknown Venue');
            topRankedVenues.set(venueKey, (topRankedVenues.get(venueKey) || 0) + 1);
        }
        else {
            reviewCount++;
            bucket.review += 1;
            const reviewReason = getReviewReason(info);
            reviewReasonCounts.set(reviewReason, (reviewReasonCounts.get(reviewReason) || 0) + 1);
        }
        if (info?.system === 'CORE') {
            conferenceCount += 1;
            bucket.conference += 1;
        }
        else if (info?.system === 'SJR') {
            journalCount += 1;
            bucket.journal += 1;
        }
    }
    const orderedYears = Array.from(yearly.values()).sort((left, right) => {
        if (left.year === 'Unknown')
            return 1;
        if (right.year === 'Unknown')
            return -1;
        return Number(left.year) - Number(right.year);
    });
    return {
        totalPapers: (publicationRanks || []).length,
        rankedCount,
        reviewCount,
        conferenceCount,
        journalCount,
        rankedShare: (publicationRanks || []).length > 0 ? rankedCount / publicationRanks.length : 0,
        topRankedVenues: Array.from(topRankedVenues.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 6)
            .map(([venue, count]) => ({ venue, count })),
        reviewReasons: Array.from(reviewReasonCounts.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([reason, count]) => ({ reason, count })),
        yearlyTrend: orderedYears,
        highlightedMix: {
            'A*/A': (Number(coreRankCounts?.['A*']) || 0) + (Number(coreRankCounts?.A) || 0),
            'Q1': Number(sjrRankCounts?.Q1) || 0,
            'Needs Review': reviewCount,
        },
    };
}
function buildSummaryState(coreRankCounts, sjrRankCounts, publicationRanks, cacheTimestamp, scanLifecycle = null) {
    const allPublicationRanks = Array.isArray(publicationRanks) ? publicationRanks.slice() : [];
    const timeline = buildTimelineViewState(allPublicationRanks, activeDateRangeMode);
    const filteredPublicationRanks = Array.isArray(timeline.publications) ? timeline.publications : allPublicationRanks;
    const effectiveCoreRankCounts = timeline.coreRankCounts || coreRankCounts || createEmptyCoreRankCounts();
    const effectiveSjrRankCounts = timeline.sjrRankCounts || sjrRankCounts || createEmptySjrRankCounts();
    const reviewItems = filteredPublicationRanks.filter((info) => !isRankedResultInfo(info));
    const venueProfileIndex = buildFacultyScoreState(filteredPublicationRanks);
    return {
        coreRankCounts: effectiveCoreRankCounts,
        sjrRankCounts: effectiveSjrRankCounts,
        allCoreRankCounts: coreRankCounts || effectiveCoreRankCounts,
        allSjrRankCounts: sjrRankCounts || effectiveSjrRankCounts,
        publicationRanks: filteredPublicationRanks,
        allPublicationRanks,
        cacheTimestamp: cacheTimestamp ?? null,
        reviewItems,
        insights: buildSummaryInsights(effectiveCoreRankCounts, effectiveSjrRankCounts, filteredPublicationRanks),
        timeline,
        dateRangeMode: timeline.rangeMode || activeDateRangeMode,
        venueProfileIndex,
        facultyScore: venueProfileIndex,
        context: { ...currentProfileContext },
        scanLifecycle: scanLifecycle ?? null,
    };
}
function sumSummaryCountKeys(counts, keys) {
    return (keys || []).reduce((total, key) => total + (Number(counts?.[key]) || 0), 0);
}
function buildSummaryCountSnapshot(summaryState) {
    // Exclude N/A buckets so ranked totals stay aligned across the score,
    // sidebar summary, and exported report metrics.
    const conferenceCount = sumSummaryCountKeys(summaryState?.coreRankCounts, ['A*', 'A', 'B', 'C']);
    const journalCount = sumSummaryCountKeys(summaryState?.sjrRankCounts, ['Q1', 'Q2', 'Q3', 'Q4']);
    const rankedCount = conferenceCount + journalCount;
    const totalPapers = Array.isArray(summaryState?.publicationRanks)
        ? summaryState.publicationRanks.length
        : (Number(summaryState?.insights?.totalPapers) || rankedCount + (Number(summaryState?.insights?.reviewCount) || 0));
    return {
        totalPapers,
        conferenceCount,
        journalCount,
        rankedCount,
        reviewCount: Math.max(0, totalPapers - rankedCount)
    };
}
function buildExportRows(summaryState) {
    return (summaryState?.publicationRanks || []).map((info) => {
        const scored = SCORE_MODEL_API?.computePublicationScore
            ? SCORE_MODEL_API.computePublicationScore(info, DEFAULT_SCORE_CONFIG || undefined)
            : null;
        const score = scored?.score || {};
        const ranking = scored?.ranking || {};
        return {
            title: getPaperTitle(info),
            year: getPublicationYear(info),
            dblpKey: info?.dblpKey || '',
            publicationType: scored?.classification?.publicationType || '',
            rankSource: score.rankSource || ranking.source || info?.system || 'UNKNOWN',
            rank: score.rank || ranking.rank || info?.rank || 'N/A',
            rankingSnapshotYear: score.rankingSnapshotYear ?? ranking.rankingSnapshotYear ?? info?.sourceYear ?? '',
            authorCount: score.authorCount ?? '',
            venueValue: Number.isFinite(score.venueValue) ? Number(score.venueValue.toFixed(4)) : '',
            fractionalCredit: Number.isFinite(score.fractionalCredit) ? Number(score.fractionalCredit.toFixed(10)) : '',
            scoreContribution: Number.isFinite(score.contribution) ? Number(score.contribution.toFixed(10)) : 0,
            scoreEligible: score.eligible === true,
            exclusionReason: score.eligible === true ? '' : (score.exclusionReason || ''),
            scholarUrl: info?.url || '',
            decisionStatus: info?.decisionStatus || '',
            reason: info?.reason || getReviewReason(info),
            matchedVenue: info?.matchedVenue || '',
            dblpVenue: info?.dblpVenue || '',
            confidence: typeof info?.confidence === 'number' ? Number(info.confidence.toFixed(4)) : '',
            decisionEvidence: getDecisionEvidenceTokens(info).join('; '),
            statusReasonCode: scored?.status || '',
        };
    });
}
function csvEscape(value) {
    const raw = value == null ? '' : String(value);
    if (/[,"\n]/.test(raw)) {
        return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
}
function buildCsvExport(summaryState) {
    const rows = buildExportRows(summaryState);
    const headers = ['title', 'year', 'dblpKey', 'publicationType', 'rankSource', 'rank', 'rankingSnapshotYear', 'authorCount', 'venueValue', 'fractionalCredit', 'scoreContribution', 'scoreEligible', 'exclusionReason'];
    const lines = [headers.join(',')];
    for (const row of rows) {
        lines.push(headers.map((header) => csvEscape(row[header])).join(','));
    }
    return lines.join('\n');
}
function buildCanonicalProfileReport(summaryState) {
    const scoreState = summaryState?.venueProfileIndex || summaryState?.facultyScore || buildFacultyScoreState(summaryState?.publicationRanks || []);
    const rawProfileScore = scoreState.rawProfileScore || (SCORE_MODEL_API?.computeProfileScore
        ? SCORE_MODEL_API.computeProfileScore(summaryState?.publicationRanks || [], DEFAULT_SCORE_CONFIG || undefined)
        : null);
    const sensitivityResult = SCORE_SENSITIVITY_API?.runSensitivity
        ? SCORE_SENSITIVITY_API.runSensitivity(summaryState?.publicationRanks || [], DEFAULT_SCORE_CONFIG || undefined)
        : null;
    const compactSensitivityScore = (score) => score ? ({
        scores: score.scores || null,
        diagnostics: score.diagnostics || null,
        completeness: score.completeness || null,
        gsvrScore: score.scores?.gsvrScore ?? score.gsvrScore ?? 0,
    }) : null;
    const sensitivity = sensitivityResult ? {
        primary: compactSensitivityScore(sensitivityResult.primary),
        variants: (sensitivityResult.variants || []).map((variant) => ({
            name: variant.name,
            score: compactSensitivityScore(variant.score),
            delta: variant.delta,
            changedItems: variant.changedItems,
            explanation: variant.explanation,
        })),
        stability: sensitivityResult.stability || null,
    } : null;
    const scoredPublications = rawProfileScore?.publications || [];
    const publications = (summaryState?.publicationRanks || []).map((info, index) => {
        const scored = scoredPublications[index] || (SCORE_MODEL_API?.computePublicationScore
            ? SCORE_MODEL_API.computePublicationScore(info, DEFAULT_SCORE_CONFIG || undefined)
            : null);
        const payload = {
            scholar: {
                title: getPaperTitle(info),
                year: getPublicationYear(info),
                url: info?.url || null,
                venueText: info?.scholarVenue || null,
                authorsText: info?.authorsText || null,
            },
            dblp: {
                status: info?.system === 'DBLP' ? 'missing' : 'verified',
                pid: summaryState?.context?.dblpAuthorPid || null,
                key: info?.dblpKey || null,
                title: info?.dblpTitle || null,
                year: info?.dblpYear || null,
                venue: info?.dblpVenue || null,
                venueFull: info?.dblpVenueFull || null,
                type: info?.dblpType || null,
                pages: info?.pages || null,
                authorCount: info?.authorCount ?? null,
                authors: Array.isArray(info?.authors) ? info.authors : [],
            },
            match: {
                status: info?.decisionStatus || null,
                probability: scored?.match?.probability ?? info?.matchConfidence ?? info?.confidence ?? null,
                rawSimilarity: info?.rawSimilarity ?? null,
                candidateGap: info?.candidateGap ?? null,
                topCandidates: getTopCandidates(info),
                evidence: getDecisionEvidenceTokens(info),
            },
            classification: {
                publicationType: scored?.classification?.publicationType ?? null,
                scoreEligibleByType: scored?.classification?.scoreEligibleByType ?? null,
                typeExclusionReason: scored?.classification?.typeExclusionReason ?? null,
                signals: Array.isArray(scored?.classification?.signals) ? scored.classification.signals : [],
            },
            ranking: {
                source: scored?.ranking?.source || info?.system || null,
                rankingSnapshotYear: scored?.ranking?.rankingSnapshotYear ?? info?.sourceYear ?? null,
                rank: scored?.ranking?.rank || info?.rank || null,
                matchedVenue: info?.matchedVenue || info?.dblpVenue || null,
                confidence: info?.venueMatchConfidence ?? info?.confidence ?? null,
            },
            score: {
                eligible: scored?.score?.eligible === true,
                exclusionReason: scored?.score?.exclusionReason ?? null,
                venueValue: scored?.score?.venueValue ?? null,
                authorCount: scored?.score?.authorCount ?? null,
                fractionalCredit: scored?.score?.fractionalCredit ?? null,
                contribution: scored?.score?.contribution ?? 0,
                rankSource: scored?.score?.rankSource ?? null,
                rank: scored?.score?.rank ?? null,
                rankingSnapshotYear: scored?.score?.rankingSnapshotYear ?? info?.sourceYear ?? null,
            },
        };
        return REPORT_SCHEMA_API?.buildPublicationDecision ? REPORT_SCHEMA_API.buildPublicationDecision(payload) : payload;
    });
    const diagnostics = rawProfileScore?.diagnostics || scoreState.diagnostics || scoreState.coverage || {};
    const scores = rawProfileScore?.scores || {
        gsvrScore: scoreState.gsvrScore || scoreState.totalScore || 0,
        coreContribution: scoreState.coreContribution || 0,
        sjrContribution: scoreState.sjrContribution || 0,
        eligibleRankedPublications: scoreState.eligibleRankedPublications || scoreState.countedPapers || 0,
        fractionalPublicationWeight: scoreState.fractionalPublicationWeight || 0,
        averageVenueValue: scoreState.averageVenueValue || 0,
    };
    const completeness = normalizeScoringCompleteness(rawProfileScore?.completeness || scoreState.completeness, diagnostics, scores, summaryState?.publicationRanks || []);
    const fullTimelineState = buildTimelineViewState(summaryState?.allPublicationRanks || summaryState?.publicationRanks || [], 'full');
    const fullFocusedHistograms = getTimelineFocusedHistograms(fullTimelineState, 'full');
    const reportPayload = {
        scoreModelVersion: scoreState.scoreModelVersion || SCORE_MODEL_VERSION,
        decisionVersion: DECISION_VERSION,
        generatedAt: new Date().toISOString(),
        scholarProfile: {
            userId: summaryState?.context?.userId || null,
            name: summaryState?.context?.authorName || null,
            url: summaryState?.context?.scholarProfileUrl || window.location?.href || null,
        },
        dblpProfile: {
            pid: summaryState?.context?.dblpAuthorPid || null,
            name: summaryState?.context?.authorName || null,
            confidence: null,
        },
        settings: {
            scoringMode: 'fractional_venue_score',
            authorshipModel: 'fractional_counting',
            publicationTypePolicy: 'full_papers_only',
            rankingPacks: currentRankingPacks.slice(),
        },
        scoringPolicy: rawProfileScore?.scoringPolicy || SCORE_CONFIG_API?.getScoringPolicy?.(DEFAULT_SCORE_CONFIG || undefined) || {
            formula: 'sum(venueValue / authorCount)',
            authorship: 'fractional',
            eligiblePublicationTypes: ['full_conference', 'full_journal'],
            venueValues: DEFAULT_SCORE_CONFIG?.venueValues || {},
            fractionalCountingOnly: true,
        },
        diagnostics,
        completeness,
        scores: {
            ...scores,
            sensitivity,
        },
        metadata: {
            cache: buildExpectedCacheMetadata(),
            rateLimitEvents: dblpRateLimitEvents.slice(),
            timeline: {
                activeRange: summaryState?.timeline?.range || fullTimelineState.range,
                fullHistogram: fullTimelineState.fullHistogram || [],
                fullFocusedHistograms,
                allUnknownYearCount: fullTimelineState.allUnknownYearCount || 0,
            },
        },
        publications,
    };
    return REPORT_SCHEMA_API?.buildProfileReport ? REPORT_SCHEMA_API.buildProfileReport(reportPayload) : reportPayload;
}
function buildJsonExport(summaryState) {
    return JSON.stringify(buildCanonicalProfileReport(summaryState), null, 2);
}
function buildMarkdownExport(summaryState) {
    const rows = buildExportRows(summaryState);
    const report = buildCanonicalProfileReport(summaryState);
    const lines = [
        '# DBLP-Verified Venue Profile Report',
        '',
        `- Exported At: ${new Date().toISOString()}`,
        `- Surface: ${summaryState?.context?.surfaceMode || 'profile'}`,
        `- Author: ${summaryState?.context?.authorName || 'Unknown'}`,
        `- Score Model: ${report.scoreModelVersion || SCORE_MODEL_VERSION}`,
        `- GSVR Score: ${Number(report.scores?.gsvrScore || 0).toFixed(4)}`,
        `- Scoring Completeness: ${formatCompletenessPercent(report.completeness)} (${Number(report.completeness?.scored || 0)}/${Number(report.completeness?.total || 0)} scored)`,
        `- Fractional Publication Weight: ${Number(report.scores?.fractionalPublicationWeight || 0).toFixed(4)}`,
        `- Eligible Ranked Publications: ${Number(report.scores?.eligibleRankedPublications || 0)}`,
        '',
        '| Title | Year | Source | Rank | Score Eligible | Exclusion Reason | Contribution |',
        '| --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const row of rows) {
        lines.push(`| ${String(row.title || '').replace(/\|/g, '\\|')} | ${row.year || ''} | ${row.rankSource} | ${row.rank} | ${row.scoreEligible} | ${String(row.exclusionReason || '').replace(/\|/g, '\\|')} | ${row.scoreContribution} |`);
    }
    return lines.join('\n');
}
function buildDownloadReportData(summaryState) {
    const rows = buildExportRows(summaryState);
    const facultyScore = summaryState?.venueProfileIndex || summaryState?.facultyScore || buildFacultyScoreState(summaryState?.publicationRanks || []);
    const countSnapshot = buildSummaryCountSnapshot(summaryState);
    const canonicalReport = buildCanonicalProfileReport(summaryState);
    const fullTimelineState = buildTimelineViewState(summaryState?.allPublicationRanks || summaryState?.publicationRanks || [], 'full');
    const recentHistogram = summaryState?.timeline?.recentHistogram || [];
    const fullHistogram = fullTimelineState.fullHistogram || [];
    const recentFocusedHistograms = getTimelineFocusedHistograms(summaryState?.timeline || { recentHistogram }, 'recent');
    const fullFocusedHistograms = getTimelineFocusedHistograms(fullTimelineState, 'full');
    return {
        exportedAt: new Date().toISOString(),
        extensionVersion: chrome?.runtime?.getManifest?.().version || 'unknown',
        scoreModelVersion: canonicalReport.scoreModelVersion || SCORE_MODEL_VERSION,
        decisionVersion: canonicalReport.decisionVersion || DECISION_VERSION,
        context: summaryState?.context || null,
        counts: {
            conferences: { ...(summaryState?.coreRankCounts || createEmptyCoreRankCounts()) },
            journals: { ...(summaryState?.sjrRankCounts || createEmptySjrRankCounts()) },
            totalPapers: countSnapshot.totalPapers || rows.length,
            rankedCount: countSnapshot.rankedCount,
            reviewCount: countSnapshot.reviewCount,
            diagnostics: canonicalReport.diagnostics || {},
            completeness: canonicalReport.completeness || {},
            byReasonCode: canonicalReport.diagnostics?.byReasonCode || {}
        },
        score: {
            gsvrScore: Number(facultyScore.gsvrScore || canonicalReport.scores?.gsvrScore || 0),
            totalScore: Number(facultyScore.gsvrScore || canonicalReport.scores?.gsvrScore || 0),
            eligibleRankedPublications: Number(facultyScore.eligibleRankedPublications || canonicalReport.scores?.eligibleRankedPublications || 0),
            countedPapers: Number(facultyScore.countedPapers || canonicalReport.scores?.eligibleRankedPublications || 0),
            fractionalPublicationWeight: Number(facultyScore.fractionalPublicationWeight || canonicalReport.scores?.fractionalPublicationWeight || 0),
            averageVenueValue: Number(facultyScore.averageVenueValue || canonicalReport.scores?.averageVenueValue || 0),
            coreContribution: Number(facultyScore.coreContribution || canonicalReport.scores?.coreContribution || 0),
            sjrContribution: Number(facultyScore.sjrContribution || canonicalReport.scores?.sjrContribution || 0),
            averageCreditPerPaper: Number(facultyScore.averageCreditPerPaper || 0),
            tierCredits: { ...(facultyScore.tierCredits || {}) },
            completeness: canonicalReport.completeness || facultyScore.completeness || {},
            scores: canonicalReport.scores || null
        },
        completeness: canonicalReport.completeness || facultyScore.completeness || {},
        timeline: {
            activeRange: summaryState?.timeline?.range || fullTimelineState.range,
            recentHistogram,
            fullHistogram,
            recentFocusedHistograms,
            fullFocusedHistograms,
            allUnknownYearCount: fullTimelineState.allUnknownYearCount || 0,
        },
        rows,
        canonicalReport,
        countedPublications: Array.isArray(facultyScore.countedPublications) ? facultyScore.countedPublications.map((item) => ({ ...item })) : []
    };
}
function buildHtmlReport(summaryState) {
    const report = buildDownloadReportData(summaryState);
    const authorName = escapeHtml(report.context?.authorName || 'Unknown');
    const heroMeta = `${authorName} | ${escapeHtml(report.context?.surfaceMode || 'profile')} | ${escapeHtml(report.exportedAt)} | DBLP ${escapeHtml(report.context?.dblpAuthorPid || 'N/A')}`;
    const summaryRows = [
        ['Exported', report.exportedAt],
        ['Extension', report.extensionVersion],
        ['Surface', report.context?.surfaceMode || 'profile'],
        ['DBLP PID', report.context?.dblpAuthorPid || 'N/A'],
        ['GSVR Score', report.score.gsvrScore.toFixed(4)],
        ['Scoring Completeness', `${formatCompletenessPercent(report.score.completeness)} (${Number(report.score.completeness?.scored || 0)}/${Number(report.score.completeness?.total || 0)} scored)`],
        ['Eligible Ranked Publications', String(report.score.eligibleRankedPublications)],
        ['Fractional Publication Weight', report.score.fractionalPublicationWeight.toFixed(4)],
        ['Average Venue Value', report.score.averageVenueValue.toFixed(4)],
        ['CORE Contribution', report.score.coreContribution.toFixed(4)],
        ['SJR Contribution', report.score.sjrContribution.toFixed(4)]
    ].map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
    const tierRows = ['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4']
        .map((rank) => `<tr><th>${rank}</th><td>${Number(report.score.tierCredits?.[rank] || 0).toFixed(2)}</td></tr>`)
        .join('');
    const distributionRows = [
        ...['A*', 'A', 'B', 'C'].map((rank) => `<tr><th>Conference ${rank}</th><td>${Number(report.counts.conferences?.[rank] || 0)}</td></tr>`),
        ...['Q1', 'Q2', 'Q3', 'Q4'].map((rank) => `<tr><th>Journal ${rank}</th><td>${Number(report.counts.journals?.[rank] || 0)}</td></tr>`),
        `<tr><th>Ranked Total</th><td>${report.counts.rankedCount}</td></tr>`,
        `<tr><th>Unranked</th><td>${report.counts.reviewCount}</td></tr>`
    ].join('');
    const auditRows = report.rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.year ?? '')}</td>
        <td>${escapeHtml(row.rankSource)}</td>
        <td>${escapeHtml(row.rank)}</td>
        <td>${escapeHtml(row.exclusionReason || '')}</td>
        <td>${escapeHtml(row.matchedVenue || row.dblpVenue || '')}</td>
        <td>${escapeHtml(row.authorCount || '')}</td>
        <td>${escapeHtml(row.venueValue || '')}</td>
        <td>${escapeHtml(row.fractionalCredit || '')}</td>
        <td>${escapeHtml(row.scoreContribution ?? '')}</td>
      </tr>`).join('');
    const evidenceRows = report.rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.decisionStatus || '')}</td>
        <td>${escapeHtml(row.matchedVenue || row.dblpVenue || '')}</td>
        <td>${escapeHtml(row.dblpKey || '')}</td>
        <td>${escapeHtml(row.rankingSnapshotYear || '')}</td>
        <td>${escapeHtml(row.confidence || '')}</td>
        <td>${escapeHtml(row.authorCount || '')}</td>
        <td>${escapeHtml(row.venueValue || '')}</td>
        <td>${escapeHtml(row.fractionalCredit || '')}</td>
        <td>${escapeHtml(row.scoreContribution ?? '')}</td>
        <td>${escapeHtml(row.decisionEvidence || '')}</td>
      </tr>`).join('');
    const fullTimelineHistogram = Array.isArray(report.timeline?.fullHistogram) ? report.timeline.fullHistogram : [];
    const fullFocusedHistograms = report.timeline?.fullFocusedHistograms || buildFocusedTimelineHistograms(fullTimelineHistogram);
    const renderTimelineLegend = (rankOrder) => rankOrder.map((rank) => `<span class="timeline-legend-item"><span class="timeline-legend-swatch timeline-segment-${escapeHtml(normalizeRankKey(rank))}"></span>${escapeHtml(rank)}</span>`).join('');
    const renderTimelineStrip = (histogram, rankOrder, emptyText) => {
        const buckets = Array.isArray(histogram) ? histogram : [];
        if (!buckets.length) {
            return `<div class="timeline-empty-state">${escapeHtml(emptyText)}</div>`;
        }
        const timelineMaxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket?.total) || 0));
        const columns = buckets.map((bucket) => {
            const total = Number(bucket?.total || 0);
            const details = rankOrder
                .map((rank) => `${rank}: ${Number(bucket?.ranks?.[rank] || 0)}`)
                .join(', ');
            const segments = rankOrder.slice().reverse().map((rank) => {
                const value = Number(bucket?.ranks?.[rank] || 0);
                if (!value) {
                    return '';
                }
                const height = Math.max(4, (value / timelineMaxTotal) * 100);
                return `<span class="timeline-segment timeline-segment-${escapeHtml(normalizeRankKey(rank))}" style="height:${Math.min(height, 100)}%" title="${escapeHtml(`${bucket.year} ${rank}: ${value}`)}"></span>`;
            }).join('');
            return `<div class="timeline-year-column" title="${escapeHtml(`${bucket.year}: ${total} (${details})`)}"><span class="timeline-count">${total}</span><div class="timeline-bar">${segments || '<span class="timeline-empty"></span>'}</div><span class="timeline-year"><span class="timeline-year-label">${escapeHtml(bucket.year)}</span></span></div>`;
        }).join('');
        return `<div class="timeline-strip" style="grid-template-columns:repeat(${Math.max(1, buckets.length)},minmax(0,1fr))">${columns}</div>`;
    };
    const topCoreTimelineStrip = renderTimelineStrip(fullFocusedHistograms.topCoreHistogram, getTopCoreHistogramRankOrder(), 'No known-year A*/A publications.');
    const q1TimelineStrip = renderTimelineStrip(fullFocusedHistograms.q1Histogram, getQ1HistogramRankOrder(), 'No known-year Q1 journal publications.');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DBLP-Verified Venue Profile Report - ${authorName}</title>
  <style>
    body{font-family:Georgia,"Times New Roman",serif;margin:32px;color:#18263f;background:#fff}
    h1,h2,h3{margin:0 0 12px;color:#12356f}
    p{margin:0 0 12px;line-height:1.6}
    .meta{margin:14px 0 18px;color:#4a5e84}
    .hero{padding:18px 20px;border:1px solid #c9d7f2;border-radius:16px;background:linear-gradient(135deg,#eef4ff,#fff8e6);margin-bottom:22px}
    .hero-score{font-size:44px;font-weight:800;line-height:1;margin-top:8px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}
    .panel{border:1px solid #d8e2f5;border-radius:14px;padding:14px 16px}
    .timeline-grid{display:grid;grid-template-columns:1fr;gap:18px}
    .timeline-panel{break-inside:avoid;page-break-inside:avoid;border:1px solid #d8e2f5;border-radius:16px;padding:16px 18px;background:linear-gradient(180deg,#ffffff,#f8fbff);box-shadow:0 12px 28px rgba(23,49,95,.07)}
    .timeline-panel h3{font-size:18px;margin-bottom:8px}
    .timeline-strip{display:grid;align-items:end;gap:4px;min-height:224px;padding:18px 12px 10px;border:1px solid #dce7fa;border-radius:14px;background:linear-gradient(180deg,#fbfdff 0%,#f4f8ff 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.92)}
    .timeline-year-column{display:grid;grid-template-rows:16px 126px 64px;align-items:end;gap:4px;min-width:0}
    .timeline-count{display:block;color:#5e7297;font-size:9px;font-weight:800;line-height:1;text-align:center;white-space:nowrap}
    .timeline-bar{display:flex;flex-direction:column-reverse;justify-content:flex-start;height:126px;background:linear-gradient(180deg,#f0f5ff,#e6eefb);border-radius:7px 7px 4px 4px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(183,201,236,.72),inset 0 -12px 18px rgba(23,49,95,.04)}
    .timeline-empty{display:block;width:100%;height:4px;margin-top:auto;background:#cbd7ed}
    .timeline-segment{display:block;width:100%;min-height:2px}
    .timeline-year{display:flex;align-items:flex-start;justify-content:center;height:64px;overflow:visible;color:#53688f;font-size:9px;font-weight:800;line-height:1}
    .timeline-year-label{display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap}
    .timeline-empty-state{padding:44px 8px;border:1px solid #e2ebfb;border-radius:14px;background:#f7faff;color:#5e7297;font-size:12px;text-align:center}
    .timeline-segment-astar{background:#153064}.timeline-segment-a{background:#2f63d8}.timeline-segment-b{background:#7a9b21}.timeline-segment-c{background:#d97836}
    .timeline-segment-q1{background:#c08c12}.timeline-segment-q2{background:#1f9467}.timeline-segment-q3{background:#8ba728}.timeline-segment-q4{background:#d56f3d}
    .timeline-legend{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px;color:#4a5e84;font-size:11px}
    .timeline-legend-item{display:inline-flex;align-items:center;gap:4px}
    .timeline-legend-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border:1px solid #dbe4f5;padding:8px 9px;text-align:left;vertical-align:top}
    th{background:#f3f7ff;color:#12356f}
    section{margin-top:24px}
    .small{font-size:11px;color:#5e7297}
  </style>
</head>
<body>
  <div class="hero">
    <h1>DBLP-Verified Venue Profile Report</h1>
    <div class="meta">${heroMeta}</div>
    <div class="hero-score">${report.score.gsvrScore.toFixed(4)}</div>
  </div>
  <div class="grid">
    <section class="panel">
      <h2>Profile Summary</h2>
      <table><tbody>${summaryRows}</tbody></table>
    </section>
    <section class="panel">
      <h2>Fractional Venue Contribution Breakdown</h2>
      <table><tbody>${tierRows}</tbody></table>
    </section>
  </div>
  <section>
    <h2>Rank Distribution</h2>
    <table><tbody>${distributionRows}</tbody></table>
  </section>
  <section>
    <h2>Full Timeline Highlights</h2>
    <div class="timeline-grid">
      <div class="timeline-panel">
        <h3>A*/A CORE Timeline</h3>
        <div class="timeline-legend">${renderTimelineLegend(getTopCoreHistogramRankOrder())}</div>
        ${topCoreTimelineStrip}
      </div>
      <div class="timeline-panel">
        <h3>Q1 Journal Timeline</h3>
        <div class="timeline-legend">${renderTimelineLegend(getQ1HistogramRankOrder())}</div>
        ${q1TimelineStrip}
      </div>
    </div>
  </section>
  <section>
    <h2>Full Audit</h2>
    <table>
      <thead><tr><th>Title</th><th>Year</th><th>Source</th><th>Rank</th><th>Exclusion Reason</th><th>Venue</th><th>Authors</th><th>Venue Value</th><th>Fractional Credit</th><th>Contribution</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>
  </section>
  <section>
    <h2>Evidence Appendix</h2>
    <table>
      <thead><tr><th>Title</th><th>Status</th><th>Matched Venue</th><th>DBLP Key</th><th>Ranking Snapshot Year</th><th>Confidence</th><th>Authors</th><th>Venue Value</th><th>Fractional Credit</th><th>Contribution</th><th>Decision Evidence</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table>
  </section>
  <p class="small">The GSVR Score is a raw fractional venue score: GSVR = sum(venueValue / authorCount) over eligible DBLP-verified ranked publications.</p>
</body>
</html>`;
}
function buildPdfReportDefinition(summaryState, reportVariant = 'full') {
    const report = buildDownloadReportData(summaryState);
    const isSummaryReport = reportVariant === 'summary';
    const authorName = report.context?.authorName || 'Unknown';
    const exportedDate = new Date(report.exportedAt);
    const exportedLabel = Number.isNaN(exportedDate.getTime())
        ? report.exportedAt
        : exportedDate.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    const palette = {
        ink: '#17315f',
        inkMuted: '#5e7297',
        brand: '#2f63d8',
        brandDeep: '#153064',
        brandSoft: '#eef4ff',
        card: '#fbfcff',
        border: '#cfdcf7',
        borderSoft: '#e2ebfb',
        warm: '#fff4dc',
        warmDeep: '#e5b74f',
        positive: '#1d8f63',
        positiveSoft: '#e7f8f0',
        neutral: '#f4f7fd',
        neutralAlt: '#edf3ff',
        textSoft: '#6d7f9e'
    };
    const noBorderLayout = {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0
    };
    const cardLayout = {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => palette.border,
        vLineColor: () => palette.border,
        paddingLeft: () => 14,
        paddingRight: () => 14,
        paddingTop: () => 12,
        paddingBottom: () => 12
    };
    const summaryCardLayout = {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => palette.border,
        vLineColor: () => palette.border,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 9,
        paddingBottom: () => 9
    };
    const compactTableLayout = {
        hLineWidth: (index, node) => (index === 0 || index === node.table.body.length ? 0 : 1),
        vLineWidth: () => 0,
        hLineColor: () => palette.borderSoft,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 6,
        paddingBottom: () => 6
    };
    const summaryCompactTableLayout = {
        hLineWidth: (index, node) => (index === 0 || index === node.table.body.length ? 0 : 1),
        vLineWidth: () => 0,
        hLineColor: () => palette.borderSoft,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 4,
        paddingBottom: () => 4
    };
    const dataTableLayout = {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => palette.borderSoft,
        vLineColor: () => palette.borderSoft,
        paddingLeft: () => 7,
        paddingRight: () => 7,
        paddingTop: () => 6,
        paddingBottom: () => 6
    };
    const tierOrder = ['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4'];
    const tierWeights = VENUE_PROFILE_INDEX_WEIGHTS;
    const summaryTierAccents = {
        'A*': '#153064',
        'A': '#2f63d8',
        'B': '#779818',
        'C': '#d97836',
        'Q1': '#c08c12',
        'Q2': '#1f9467',
        'Q3': '#78981d',
        'Q4': '#d56f3d'
    };
    const summaryTierFills = {
        'A*': '#eef3ff',
        'A': '#f2f7ff',
        'B': '#f5fae9',
        'C': '#fff3e9',
        'Q1': '#fff7df',
        'Q2': '#ecf9f2',
        'Q3': '#f6fae9',
        'Q4': '#fff1e6'
    };
    const summaryTable = [
        ['Exported', exportedLabel],
        ['Extension', report.extensionVersion],
        ['Surface', report.context?.surfaceMode || 'profile'],
        ['DBLP PID', report.context?.dblpAuthorPid || 'N/A'],
        ['GSVR Score', report.score.gsvrScore.toFixed(4)],
        ['Scoring Completeness', `${formatCompletenessPercent(report.score.completeness)} (${Number(report.score.completeness?.scored || 0)}/${Number(report.score.completeness?.total || 0)} scored)`],
        ['Eligible Ranked Publications', String(report.score.eligibleRankedPublications)],
        ['Fractional Publication Weight', report.score.fractionalPublicationWeight.toFixed(4)],
        ['Average Venue Value', report.score.averageVenueValue.toFixed(4)]
    ];
    const distributionTable = [
        ['Conference A*', Number(report.counts.conferences?.['A*'] || 0)],
        ['Conference A', Number(report.counts.conferences?.A || 0)],
        ['Conference B', Number(report.counts.conferences?.B || 0)],
        ['Conference C', Number(report.counts.conferences?.C || 0)],
        ['Journal Q1', Number(report.counts.journals?.Q1 || 0)],
        ['Journal Q2', Number(report.counts.journals?.Q2 || 0)],
        ['Journal Q3', Number(report.counts.journals?.Q3 || 0)],
        ['Journal Q4', Number(report.counts.journals?.Q4 || 0)],
        ['Ranked Total', report.counts.rankedCount],
        ['Unranked', report.counts.reviewCount]
    ];
    function createKeyValueRows(rows) {
        return rows.map(([label, value]) => [
            { text: String(label), style: 'tableKey' },
            { text: String(value), style: 'tableValue', alignment: 'right' }
        ]);
    }
    function createSummaryKeyValueRows(rows) {
        return rows.map(([label, value]) => [
            { text: String(label), style: 'summaryTableKey' },
            { text: String(value), style: 'summaryTableValue', alignment: 'right' }
        ]);
    }
    function wrapCard(title, subtitle, bodyNode) {
        const cardStack = [
            { text: title, style: 'panelTitle' }
        ];
        if (subtitle) {
            cardStack.push({ text: subtitle, style: 'panelSubtitle', margin: [0, 4, 0, 12] });
        }
        cardStack.push(bodyNode);
        return {
            table: {
                widths: ['*'],
                body: [[{
                            stack: cardStack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout
        };
    }
    function createSummaryCard(title, bodyNode, subtitle = null) {
        const cardStack = [
            { text: title, style: 'summaryPanelTitle' }
        ];
        if (subtitle) {
            cardStack.push({ text: subtitle, style: 'summaryPanelSubtitle', margin: [0, 3, 0, 8] });
        }
        cardStack.push(bodyNode);
        return {
            table: {
                widths: ['*'],
                body: [[{
                            stack: cardStack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: summaryCardLayout
        };
    }
    function createMetricCard(label, value, note, accent) {
        const stack = [
            { text: label, style: 'metricLabel' },
            { text: value, style: 'metricValue', color: accent || palette.ink }
        ];
        if (note) {
            stack.push({ text: note, style: 'metricNote' });
        }
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout
        };
    }
    function createSummaryMetricCard(label, value, accent, note = '') {
        const stack = [
            { text: label, style: 'summaryMetricLabel' },
            { text: value, style: 'summaryMetricValue', color: accent || palette.ink }
        ];
        if (note) {
            stack.push({ text: note, style: 'summaryMetricNote' });
        }
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: summaryCardLayout
        };
    }
    function truncateSummaryText(text, maxLength = 72) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }
    function createSummaryBreakdownTile(rank, value) {
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack: [
                                { text: rank, style: 'summaryBreakdownRank', color: summaryTierAccents[rank] || palette.brandDeep },
                                { text: Number(value || 0).toFixed(2), style: 'summaryBreakdownValue', color: summaryTierAccents[rank] || palette.brandDeep }
                            ],
                            fillColor: summaryTierFills[rank] || palette.neutralAlt,
                            border: [false, false, false, false]
                        }]]
            },
            layout: summaryCardLayout
        };
    }
    function createSummaryLinkRow(label, url) {
        if (!url) {
            return null;
        }
        return {
            columns: [
                {
                    width: 'auto',
                    text: `${label}:`,
                    style: 'summaryLinkLabel',
                    margin: [0, 0, 6, 0]
                },
                {
                    width: '*',
                    text: url,
                    style: 'summaryLinkText',
                    link: url
                }
            ],
            columnGap: 0,
            margin: [0, 4, 0, 0]
        };
    }
    function createWeightTile(rank, value) {
        const isTopTier = rank === 'A*' || rank === 'A' || rank === 'Q1';
        const fillColor = isTopTier ? palette.brandSoft : palette.neutral;
        const valueColor = isTopTier ? palette.brandDeep : palette.ink;
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack: [
                                { text: rank, style: 'weightRank' },
                                { text: Number(value).toFixed(2), style: 'weightValue', color: valueColor }
                            ],
                            fillColor,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout
        };
    }
    function getRankColors(rank) {
        switch (rank) {
            case 'A*':
                return { fillColor: '#153f86', color: '#ffffff' };
            case 'A':
            case 'Q1':
                return { fillColor: '#2f63d8', color: '#ffffff' };
            case 'B':
            case 'Q2':
                return { fillColor: '#d9e6ff', color: '#183260' };
            case 'C':
            case 'Q3':
                return { fillColor: '#eef4ff', color: '#254478' };
            case 'Q4':
                return { fillColor: '#fff4dc', color: '#7a5b12' };
            default:
                return { fillColor: '#eef2fb', color: '#52688f' };
        }
    }
    function getSystemColors(system) {
        if (system === 'CORE') {
            return { fillColor: '#e9f1ff', color: '#17315f' };
        }
        if (system === 'SJR') {
            return { fillColor: '#e9f8f2', color: '#11664b' };
        }
        return { fillColor: '#f2f5fb', color: '#4d6387' };
    }
    function createTagCell(text, colors) {
        return {
            text: String(text || ''),
            fillColor: colors.fillColor,
            color: colors.color,
            alignment: 'center',
            bold: true,
            fontSize: 8,
            margin: [0, 2, 0, 0]
        };
    }
    function escapeSvgText(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
    function createPdfFocusedTimelineChartSvg(histogram, rankOrder, { compact = false, emptyText = 'No known-year publications.' } = {}) {
        const buckets = Array.isArray(histogram) ? histogram : [];
        const ranks = Array.isArray(rankOrder) && rankOrder.length ? rankOrder : getHistogramRankOrder();
        const chartWidth = compact ? 500 : 498;
        const chartHeight = compact ? 174 : 188;
        const plotLeft = compact ? 14 : 16;
        const plotRight = compact ? 10 : 12;
        const plotTop = compact ? 22 : 24;
        const plotHeight = compact ? 92 : 104;
        const labelBaseline = plotTop + plotHeight + (compact ? 46 : 50);
        const axisY = plotTop + plotHeight;
        const plotWidth = chartWidth - plotLeft - plotRight;
        if (!buckets.length) {
            return {
                svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}"><rect x="0" y="0" width="${chartWidth}" height="${chartHeight}" rx="8" fill="#f7faff" stroke="#e2ebfb"/><text x="${chartWidth / 2}" y="${chartHeight / 2}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 7 : 8}" fill="#6d7f9e">${escapeSvgText(emptyText)}</text></svg>`,
                width: chartWidth,
                margin: [0, 2, 0, 0]
            };
        }
        const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket?.total) || 0));
        const columnWidth = plotWidth / Math.max(1, buckets.length);
        const barGap = buckets.length > 24 ? 1.2 : 2.4;
        const barWidth = Math.max(2.4, Math.min(compact ? 9 : 10, columnWidth - barGap));
        const parts = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}">`,
            `<rect x="0.5" y="0.5" width="${chartWidth - 1}" height="${chartHeight - 1}" rx="12" fill="#f8fbff" stroke="#dce7fa"/>`,
            `<line x1="${plotLeft}" y1="${plotTop + plotHeight * 0.25}" x2="${chartWidth - plotRight}" y2="${plotTop + plotHeight * 0.25}" stroke="#e7eefb" stroke-width="0.8"/>`,
            `<line x1="${plotLeft}" y1="${plotTop + plotHeight * 0.5}" x2="${chartWidth - plotRight}" y2="${plotTop + plotHeight * 0.5}" stroke="#e7eefb" stroke-width="0.8"/>`,
            `<line x1="${plotLeft}" y1="${plotTop + plotHeight * 0.75}" x2="${chartWidth - plotRight}" y2="${plotTop + plotHeight * 0.75}" stroke="#e7eefb" stroke-width="0.8"/>`,
            `<line x1="${plotLeft}" y1="${axisY}" x2="${chartWidth - plotRight}" y2="${axisY}" stroke="#c9d7f2" stroke-width="1.1"/>`,
            `<text x="${plotLeft}" y="${plotTop - 7}" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 6 : 7}" fill="#6d7f9e">Max ${maxTotal}</text>`
        ];
        for (const [index, bucket] of buckets.entries()) {
            const x = plotLeft + index * columnWidth + (columnWidth - barWidth) / 2;
            let y = axisY;
            let rendered = false;
            for (const rank of ranks) {
                const value = Number(bucket?.ranks?.[rank] || 0);
                if (!value) {
                    continue;
                }
                const height = Math.max(1.4, (value / maxTotal) * plotHeight);
                y -= height;
                parts.push(`<rect x="${x.toFixed(2)}" y="${Math.max(plotTop, y).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.min(height, axisY - plotTop).toFixed(2)}" rx="2" fill="${getRankColors(rank).fillColor}"/><rect x="${x.toFixed(2)}" y="${Math.max(plotTop, y).toFixed(2)}" width="${barWidth.toFixed(2)}" height="1" rx="0.5" fill="#ffffff" opacity="0.28"/>`);
                rendered = true;
            }
            if (!rendered) {
                parts.push(`<rect x="${x.toFixed(2)}" y="${(axisY - 2.4).toFixed(2)}" width="${barWidth.toFixed(2)}" height="2.4" rx="1.2" fill="#cfdaee"/>`);
            }
            const total = Number(bucket?.total || 0);
            if (total > 0 && columnWidth >= 12) {
                parts.push(`<text x="${(x + barWidth / 2).toFixed(2)}" y="${Math.max(10, y - 4).toFixed(2)}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 5.5 : 6.3}" font-weight="700" fill="#52688f">${total}</text>`);
            }
            const labelX = x + barWidth / 2;
            parts.push(`<text x="${labelX.toFixed(2)}" y="${labelBaseline}" text-anchor="start" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 6.2 : 6.8}" font-weight="700" fill="#52688f" transform="rotate(-90 ${labelX.toFixed(2)} ${labelBaseline})">${escapeSvgText(bucket.year)}</text>`);
        }
        parts.push('</svg>');
        return {
            svg: parts.join(''),
            width: chartWidth,
            margin: [0, 2, 0, compact ? 2 : 4]
        };
    }
    function createPdfFocusedTimelineLegend(rankOrder, compact = false) {
        const ranks = Array.isArray(rankOrder) && rankOrder.length ? rankOrder : getHistogramRankOrder();
        return {
            columns: ranks.map((rank) => ({
                width: '*',
                columns: [
                    {
                        width: 8,
                        canvas: [{ type: 'rect', x: 0, y: 2, w: 7, h: 7, color: getRankColors(rank).fillColor }]
                    },
                    { width: '*', text: rank, style: compact ? 'summaryLegendTight' : 'metricNote' }
                ],
                columnGap: 3
            })),
            columnGap: compact ? 3 : 5,
            margin: [0, 0, 0, compact ? 6 : 8]
        };
    }
    function createPdfFocusedTimelineChart(title, histogram, rankOrder, { compact = false, label = 'Papers' } = {}) {
        return {
            unbreakable: true,
            stack: [
                { text: title, style: compact ? 'summarySubsectionTitle' : 'tableKey', margin: [0, 0, 0, 5] },
                createPdfFocusedTimelineLegend(rankOrder, compact),
                createPdfFocusedTimelineChartSvg(histogram, rankOrder, {
                    compact,
                    emptyText: `No known-year ${label.toLowerCase()}.`
                })
            ]
        };
    }
    function createPdfFocusedTimelineChartsNode({ compact = false } = {}) {
        const fullFocusedHistograms = report.timeline?.fullFocusedHistograms || buildFocusedTimelineHistograms(report.timeline?.fullHistogram || []);
        return {
            stack: [
                createPdfFocusedTimelineChart('A*/A CORE Timeline', fullFocusedHistograms.topCoreHistogram || [], getTopCoreHistogramRankOrder(), {
                    compact,
                    label: 'A*/A papers'
                }),
                {
                    margin: [0, compact ? 10 : 14, 0, 0],
                    stack: [
                        createPdfFocusedTimelineChart('Q1 Journal Timeline', fullFocusedHistograms.q1Histogram || [], getQ1HistogramRankOrder(), {
                            compact,
                            label: 'Q1 papers'
                        })
                    ]
                }
            ]
        };
    }
    const conferenceRankedTotal = (Number(report.counts.conferences?.['A*']) || 0)
        + (Number(report.counts.conferences?.A) || 0)
        + (Number(report.counts.conferences?.B) || 0)
        + (Number(report.counts.conferences?.C) || 0);
    const journalRankedTotal = (Number(report.counts.journals?.Q1) || 0)
        + (Number(report.counts.journals?.Q2) || 0)
        + (Number(report.counts.journals?.Q3) || 0)
        + (Number(report.counts.journals?.Q4) || 0);
    const conferenceDistributionRows = [
        ['A*', Number(report.counts.conferences?.['A*'] || 0)],
        ['A', Number(report.counts.conferences?.A || 0)],
        ['B', Number(report.counts.conferences?.B || 0)],
        ['C', Number(report.counts.conferences?.C || 0)],
        ['Conference Total', conferenceRankedTotal]
    ];
    const journalDistributionRows = [
        ['Q1', Number(report.counts.journals?.Q1 || 0)],
        ['Q2', Number(report.counts.journals?.Q2 || 0)],
        ['Q3', Number(report.counts.journals?.Q3 || 0)],
        ['Q4', Number(report.counts.journals?.Q4 || 0)],
        ['Journal Total', journalRankedTotal],
        ['Unranked', report.counts.reviewCount]
    ];
    const summaryContributorItems = report.countedPublications.slice(0, 5);
    const summaryContributorRows = summaryContributorItems.length > 0
        ? summaryContributorItems.map((item, index) => [
            {
                stack: [
                    { text: `#${index + 1} ${truncateSummaryText(item?.title || 'Untitled publication', 74)}`, style: 'summaryContributorTitle' },
                    {
                        text: `${item?.system || 'UNKNOWN'} ${item?.rank || 'N/A'} • ${truncateSummaryText(item?.venue || 'Unknown venue', 48)}`,
                        style: 'summaryContributorMeta',
                        margin: [0, 2, 0, 0]
                    }
                ],
                fillColor: index % 2 === 0 ? '#fbfcff' : '#f6f9ff',
                border: [false, false, false, false]
            },
            {
                stack: [
                    { text: 'Contribution', style: 'summaryContributorCreditLabel' },
                    { text: Number(item?.credit || 0).toFixed(2), style: 'summaryContributorCreditValue' }
                ],
                fillColor: index % 2 === 0 ? '#eef4ff' : '#e9f1ff',
                border: [false, false, false, false]
            }
        ])
        : [[
            {
                text: 'No ranked publications contributed to the score in this export.',
                style: 'summaryEmptyState',
                colSpan: 2,
                fillColor: palette.card,
                border: [false, false, false, false]
            },
            {}
        ]];
    const scholarProfileUrl = report.context?.scholarProfileUrl || (report.context?.userId ? `https://scholar.google.com/citations?user=${encodeURIComponent(report.context.userId)}` : '');
    const dblpProfileUrl = report.context?.dblpAuthorPid ? `https://dblp.org/pid/${report.context.dblpAuthorPid}.html` : '';
    const summaryContent = [
        {
            columns: [
                {
                    width: '*',
                    stack: [
                        { text: 'GSVR SUMMARY', style: 'summaryEyebrow' },
                        { text: authorName, style: 'summaryHeroAuthor', margin: [0, 4, 0, 0] },
                        { text: `Exported ${exportedLabel}`, style: 'summaryHeroMeta', margin: [0, 6, 0, 0] },
                        ...(dblpProfileUrl ? [createSummaryLinkRow('DBLP Profile', dblpProfileUrl)] : []),
                        ...(scholarProfileUrl ? [createSummaryLinkRow('Google Scholar', scholarProfileUrl)] : [])
                    ],
                    margin: [0, 4, 0, 0]
                },
                {
                    width: 184,
                    table: {
                        widths: ['*'],
                        body: [[{
                                    stack: [
                                        { text: 'GSVR Score', style: 'summaryScoreLabel' },
                                        { text: report.score.gsvrScore.toFixed(4), style: 'summaryScoreValue' },
                                        { text: `${report.score.eligibleRankedPublications} eligible ranked publications`, style: 'summaryScoreMeta', margin: [0, 3, 0, 0] }
                                    ],
                                    fillColor: palette.brandDeep,
                                    border: [false, false, false, false]
                                }]]
                    },
                    layout: summaryCardLayout
                }
            ],
            columnGap: 12,
            margin: [0, 0, 0, 10]
        },
        {
            columns: [
                createSummaryMetricCard('Processed', String(report.counts.totalPapers), palette.brandDeep, 'All profile papers'),
                createSummaryMetricCard('Ranked', String(report.counts.rankedCount), palette.brand, 'CORE + SJR'),
                createSummaryMetricCard('Unranked', String(report.counts.reviewCount), '#c27a16', 'Not Applicable')
            ],
            columnGap: 8,
        margin: [0, 0, 0, 10]
        },
        {
            columns: [
                createSummaryCard('Venue Distribution', {
                    stack: [
                        { text: 'Conference', style: 'summarySubsectionTitle', margin: [0, 0, 0, 5] },
                        {
                            table: {
                                widths: ['*', 'auto'],
                                body: createSummaryKeyValueRows(conferenceDistributionRows)
                            },
                            layout: summaryCompactTableLayout,
                            margin: [0, 0, 0, 8]
                        },
                        { text: 'Journal', style: 'summarySubsectionTitle', margin: [0, 0, 0, 5] },
                        {
                            table: {
                                widths: ['*', 'auto'],
                                body: createSummaryKeyValueRows(journalDistributionRows)
                            },
                            layout: summaryCompactTableLayout
                        }
                    ]
                }),
                createSummaryCard('Score Breakdown', {
                    stack: [
                        {
                            columns: ['A*', 'A', 'B', 'C'].map((rank) => createSummaryBreakdownTile(rank, report.score.tierCredits?.[rank] || 0)),
                            columnGap: 6,
                            margin: [0, 0, 0, 6]
                        },
                        {
                            columns: ['Q1', 'Q2', 'Q3', 'Q4'].map((rank) => createSummaryBreakdownTile(rank, report.score.tierCredits?.[rank] || 0)),
                            columnGap: 6,
                            margin: [0, 0, 0, 6]
                        },
                    { text: 'Contribution is venue value divided by DBLP author count.', style: 'summaryLegend', margin: [0, 0, 0, 3] },
                    { text: `Venue values: A*=${VENUE_PROFILE_INDEX_WEIGHTS['A*'].toFixed(2)} • A=${VENUE_PROFILE_INDEX_WEIGHTS.A.toFixed(2)} • B=${VENUE_PROFILE_INDEX_WEIGHTS.B.toFixed(2)} • C=${VENUE_PROFILE_INDEX_WEIGHTS.C.toFixed(2)} • Q1=${VENUE_PROFILE_INDEX_WEIGHTS.Q1.toFixed(2)} • Q2=${VENUE_PROFILE_INDEX_WEIGHTS.Q2.toFixed(2)} • Q3=${VENUE_PROFILE_INDEX_WEIGHTS.Q3.toFixed(2)} • Q4=${VENUE_PROFILE_INDEX_WEIGHTS.Q4.toFixed(2)}`, style: 'summaryLegendTight' }
                    ]
                })
            ],
            columnGap: 10,
            margin: [0, 0, 0, 10]
        },
        createSummaryCard('Full Timeline Highlights', createPdfFocusedTimelineChartsNode({ compact: true }), 'A*/A CORE and Q1 journal papers across the complete dataset'),
        createSummaryCard('Top Contributors', {
            table: {
                widths: ['*', 56],
                body: summaryContributorRows
            },
            layout: summaryCompactTableLayout
                }, 'Highest contribution publications')
    ];
    function createAuditBody() {
        const header = [
            { text: 'Title', style: 'tableHeader' },
            { text: 'Year', style: 'tableHeader', alignment: 'center' },
            { text: 'Source', style: 'tableHeader', alignment: 'center' },
            { text: 'Rank', style: 'tableHeader', alignment: 'center' },
            { text: 'Exclusion Reason', style: 'tableHeader' },
            { text: 'Venue', style: 'tableHeader' },
            { text: 'Authors', style: 'tableHeader', alignment: 'center' },
            { text: 'Venue Value', style: 'tableHeader', alignment: 'center' },
            { text: 'Contribution', style: 'tableHeader', alignment: 'center' }
        ];
        const body = [header];
        report.rows.forEach((row, index) => {
            const fillColor = index % 2 === 0 ? '#fbfcff' : '#f4f8ff';
            body.push([
                { text: row.title || '', style: 'tableCell', fillColor },
                { text: row.year == null ? '' : String(row.year), style: 'tableCell', fillColor, alignment: 'center' },
                createTagCell(row.rankSource || '', getSystemColors(row.rankSource)),
                createTagCell(row.rank || '', getRankColors(row.rank)),
                { text: row.exclusionReason || '', style: 'tableCell', fillColor },
                { text: row.matchedVenue || row.dblpVenue || '', style: 'tableCell', fillColor },
                { text: row.authorCount == null ? '' : String(row.authorCount), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.venueValue == null ? '' : String(row.venueValue), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.scoreContribution == null ? '' : String(row.scoreContribution), style: 'tableCell', fillColor, alignment: 'center' }
            ]);
        });
        return body;
    }
    function createEvidenceBody() {
        const header = [
            { text: 'Title', style: 'tableHeader' },
            { text: 'Status', style: 'tableHeader', alignment: 'center' },
            { text: 'Matched Venue', style: 'tableHeader' },
            { text: 'DBLP Key', style: 'tableHeader' },
            { text: 'Ranking Snapshot Year', style: 'tableHeader', alignment: 'center' },
            { text: 'Confidence', style: 'tableHeader', alignment: 'center' },
            { text: 'Authors', style: 'tableHeader', alignment: 'center' },
            { text: 'Venue Value', style: 'tableHeader', alignment: 'center' },
            { text: 'Contribution', style: 'tableHeader', alignment: 'center' },
            { text: 'Decision Evidence', style: 'tableHeader' }
        ];
        const body = [header];
        report.rows.forEach((row, index) => {
            const fillColor = index % 2 === 0 ? '#fbfcff' : '#f4f8ff';
            body.push([
                { text: row.title || '', style: 'tableCell', fillColor },
                { text: row.decisionStatus || '', style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.matchedVenue || row.dblpVenue || '', style: 'tableCell', fillColor },
                { text: row.dblpKey || '', style: 'tableCellMono', fillColor },
                { text: row.rankingSnapshotYear == null ? '' : String(row.rankingSnapshotYear), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.confidence == null ? '' : String(row.confidence), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.authorCount == null ? '' : String(row.authorCount), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.venueValue == null ? '' : String(row.venueValue), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.scoreContribution == null ? '' : String(row.scoreContribution), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.decisionEvidence || '', style: 'tableCell', fillColor }
            ]);
        });
        return body;
    }
    function createContributionCard(item, index) {
        return {
            table: {
                widths: ['*'],
                body: [[{
                            stack: [
                                { text: `#${index} • ${item.system} ${item.rank}`, style: 'contributionEyebrow' },
                                { text: item.title || 'Untitled publication', style: 'contributionTitle', margin: [0, 6, 0, 6] },
                                { text: item.venue || 'Unknown venue', style: 'contributionVenue' },
                                {
                                    columns: [
                    { width: '*', text: `Venue value ${Number(item.weight || 0).toFixed(2)}`, style: 'contributionMeta' },
                    { width: '*', text: `Contribution ${Number(item.credit || 0).toFixed(2)}`, style: 'contributionMeta', alignment: 'center' },
                                        { width: '*', text: `${Number(item.authorCount || 0)} authors`, style: 'contributionMeta', alignment: 'right' }
                                    ],
                                    margin: [0, 10, 0, 0]
                                }
                            ],
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout,
            margin: [0, 0, 0, 10]
        };
    }
    const contributionCards = report.countedPublications.slice(0, 6).map((item, index) => createContributionCard(item, index + 1));
    const leftCards = [];
    const rightCards = [];
    contributionCards.forEach((card, index) => {
        if (index % 2 === 0) {
            leftCards.push(card);
        }
        else {
            rightCards.push(card);
        }
    });
    const heroTextStack = [
        { text: isSummaryReport ? 'GSVR VENUE PROFILE SUMMARY' : 'DBLP-VERIFIED VENUE PROFILE REPORT', style: 'eyebrow' },
        { text: isSummaryReport ? 'Venue Profile Summary' : 'Venue Profile Report', style: 'heroTitle', margin: [0, 6, 0, 0] },
        { text: authorName, style: 'heroAuthor', margin: [0, 12, 0, 0] },
        {
            text: `${report.context?.surfaceMode || 'profile'} • Exported ${exportedLabel} • DBLP ${report.context?.dblpAuthorPid || 'N/A'}`,
            style: 'heroMeta',
            margin: [0, 8, 0, 0]
        }
    ];
    const heroLeadCell = {
        stack: heroTextStack,
        fillColor: palette.brandSoft,
        border: [false, false, false, false]
    };
    const fullContent = [
        {
            table: {
                widths: ['*', 180],
                body: [[
                        heroLeadCell,
                        {
                            stack: [
                                { text: 'GSVR Score', style: 'heroScoreLabel' },
                                { text: report.score.gsvrScore.toFixed(4), style: 'heroScoreValue' },
                                { text: `${report.score.eligibleRankedPublications} eligible ranked publications`, style: 'heroScoreMeta' },
                                { text: `${report.score.fractionalPublicationWeight.toFixed(4)} fractional publication weight`, style: 'heroScoreMeta', margin: [0, 4, 0, 0] }
                            ],
                            fillColor: palette.brandDeep,
                            border: [false, false, false, false]
                        }
                    ]]
            },
            layout: {
                ...noBorderLayout,
                paddingLeft: (index) => index === 0 ? 18 : 16,
                paddingRight: (index, node) => index === node.table.widths.length - 1 ? 16 : 18,
                paddingTop: () => 16,
                paddingBottom: () => 16
            },
            margin: [0, 0, 0, 16]
        },
        {
            columns: [
                createMetricCard('Total Papers', String(report.counts.totalPapers), `${report.counts.rankedCount} ranked`, palette.brand),
                createMetricCard('Unranked', String(report.counts.reviewCount), '', '#c27a16'),
                createMetricCard('Conference Count', String((Number(report.counts.conferences?.['A*']) || 0)
                    + (Number(report.counts.conferences?.A) || 0)
                    + (Number(report.counts.conferences?.B) || 0)
                    + (Number(report.counts.conferences?.C) || 0)), 'CORE-ranked papers', palette.ink),
                createMetricCard('Journal Count', String((Number(report.counts.journals?.Q1) || 0)
                    + (Number(report.counts.journals?.Q2) || 0)
                    + (Number(report.counts.journals?.Q3) || 0)
                    + (Number(report.counts.journals?.Q4) || 0)), 'SJR-ranked papers', palette.positive)
            ],
            columnGap: 10,
            margin: [0, 0, 0, 16]
        },
        {
            columns: [
                {
                    width: '*',
                    stack: [
                        wrapCard('Profile Snapshot', 'Audit context and score summary for this export.', {
                            table: { widths: ['*', 'auto'], body: createKeyValueRows(summaryTable) },
                            layout: compactTableLayout
                        })
                    ]
                },
                {
                    width: '*',
                    stack: [
                        wrapCard('Venue Distribution', 'Conference tiers, journal quartiles, and unranked rows counted in this report.', {
                            table: { widths: ['*', 'auto'], body: createKeyValueRows(distributionTable) },
                            layout: compactTableLayout
                        })
                    ]
                }
            ],
            columnGap: 14,
            margin: [0, 0, 0, 16]
        },
        wrapCard('Full Timeline Highlights', 'Annual A*/A CORE and Q1 journal counts across the complete dataset.', createPdfFocusedTimelineChartsNode({ compact: false })),
        wrapCard('Scoring Model', 'The primary score is raw, unbounded, and fractional.', {
            stack: [
                {
        text: 'Each scored publication contributes venue value divided by DBLP author count. Excluded and unranked publications remain visible in the audit.',
                    style: 'bodyCopy',
                    margin: [0, 0, 0, 12]
                },
                {
                    columns: tierOrder.slice(0, 4).map((rank) => createWeightTile(rank, tierWeights[rank] || 0)),
                    columnGap: 10,
                    margin: [0, 0, 0, 10]
                },
                {
                    columns: tierOrder.slice(4).map((rank) => createWeightTile(rank, tierWeights[rank] || 0)),
                    columnGap: 10
                }
            ]
        }),
        {
            margin: [0, 16, 0, 0],
            stack: [
                { text: 'Top GSVR Contributions', style: 'sectionTitle' },
                { text: 'Highest-contribution ranked publications included in the GSVR Score.', style: 'sectionSubtitle', margin: [0, 4, 0, 12] },
                contributionCards.length > 0
                    ? {
                        columns: [
                            { width: '*', stack: leftCards },
                            { width: '*', stack: rightCards.length > 0 ? rightCards : [{ text: '', margin: [0, 0, 0, 0] }] }
                        ],
                        columnGap: 12
                    }
                    : { text: 'No ranked publications contributed to the GSVR Score in this export.', style: 'emptyState' }
            ]
        }
    ];
    if (!isSummaryReport) {
        fullContent.push({
            pageBreak: 'before',
            pageOrientation: 'landscape',
            stack: [
                { text: 'Full Audit', style: 'sectionTitle' },
                { text: 'Ranked and unranked publications with scoring columns for committee-style review.', style: 'sectionSubtitle', margin: [0, 4, 0, 12] },
                {
                    table: {
                        headerRows: 1,
                        widths: ['*', 36, 48, 38, 74, 112, 42, 42, 44],
                        body: createAuditBody()
                    },
                    layout: dataTableLayout,
                    fontSize: 8
                }
            ]
        }, {
            pageBreak: 'before',
            pageOrientation: 'landscape',
            stack: [
                { text: 'Evidence Appendix', style: 'sectionTitle' },
                { text: 'Decision metadata, matching confidence, and traceable evidence for every row.', style: 'sectionSubtitle', margin: [0, 4, 0, 12] },
                {
                    table: {
                        headerRows: 1,
                        widths: ['*', 54, 92, 80, 48, 48, 42, 42, 44, '*'],
                        body: createEvidenceBody()
                    },
                    layout: dataTableLayout,
                    fontSize: 8
                }
            ]
        });
    }
    fullContent.push({
        text: `The GSVR Score is a raw fractional venue score: GSVR = sum(venueValue / authorCount). Venue values are A*=${VENUE_PROFILE_INDEX_WEIGHTS['A*'].toFixed(2)}, A=${VENUE_PROFILE_INDEX_WEIGHTS.A.toFixed(2)}, B=${VENUE_PROFILE_INDEX_WEIGHTS.B.toFixed(2)}, C=${VENUE_PROFILE_INDEX_WEIGHTS.C.toFixed(2)}, Q1=${VENUE_PROFILE_INDEX_WEIGHTS.Q1.toFixed(2)}, Q2=${VENUE_PROFILE_INDEX_WEIGHTS.Q2.toFixed(2)}, Q3=${VENUE_PROFILE_INDEX_WEIGHTS.Q3.toFixed(2)}, and Q4=${VENUE_PROFILE_INDEX_WEIGHTS.Q4.toFixed(2)}.`,
        style: 'footnote',
        margin: [0, 14, 0, 0]
    });
    return {
        pageSize: 'A4',
        pageMargins: isSummaryReport ? [18, 18, 18, 18] : [24, 24, 24, 28],
        footer: isSummaryReport ? undefined : ((currentPage, pageCount) => ({
            margin: [24, 4, 24, 0],
            columns: [
                { text: `GSVR v${report.extensionVersion} • ${authorName}`, style: 'footerText' },
                { text: `Page ${currentPage} of ${pageCount}`, style: 'footerText', alignment: 'right' }
            ]
        })),
        content: isSummaryReport ? summaryContent : fullContent,
        styles: {
            eyebrow: { fontSize: 9, bold: true, color: palette.brand, characterSpacing: 1.1 },
            heroTitle: { fontSize: 22, bold: true, color: palette.brandDeep },
            heroAuthor: { fontSize: 14, bold: true, color: palette.ink },
            heroMeta: { fontSize: 9, color: palette.inkMuted },
            heroScoreLabel: { fontSize: 10, bold: true, color: '#dfe9ff', alignment: 'center' },
            heroScoreValue: { fontSize: 34, bold: true, color: '#ffffff', alignment: 'center', margin: [0, 8, 0, 8] },
            heroScoreMeta: { fontSize: 9, color: '#d9e4ff', alignment: 'center' },
            metricLabel: { fontSize: 9, bold: true, color: palette.inkMuted },
            metricValue: { fontSize: 20, bold: true, margin: [0, 6, 0, 4] },
            metricNote: { fontSize: 8, color: palette.textSoft },
            summaryEyebrow: { fontSize: 8, bold: true, color: palette.brand, characterSpacing: 0.9 },
            summaryHeroAuthor: { fontSize: 18, bold: true, color: palette.brandDeep },
            summaryHeroMeta: { fontSize: 8, color: palette.inkMuted },
            summaryScoreLabel: { fontSize: 9, bold: true, color: '#dfe9ff', alignment: 'center' },
            summaryScoreValue: { fontSize: 30, bold: true, color: '#ffffff', alignment: 'center', margin: [0, 6, 0, 6] },
            summaryScoreMeta: { fontSize: 8, color: '#d9e4ff', alignment: 'center' },
            summaryMetricLabel: { fontSize: 8, bold: true, color: palette.inkMuted },
            summaryMetricValue: { fontSize: 18, bold: true, margin: [0, 4, 0, 2] },
            summaryMetricNote: { fontSize: 7, color: palette.textSoft },
            summaryPanelTitle: { fontSize: 12, bold: true, color: palette.brandDeep },
            summaryPanelSubtitle: { fontSize: 8, color: palette.inkMuted },
            summarySubsectionTitle: { fontSize: 9, bold: true, color: palette.brandDeep },
            summaryTableKey: { fontSize: 8, bold: true, color: palette.ink },
            summaryTableValue: { fontSize: 8, color: palette.ink },
            summaryBodyCopy: { fontSize: 8.5, color: palette.ink, lineHeight: 1.2 },
            summaryLegend: { fontSize: 8, color: palette.inkMuted },
            summaryLegendTight: { fontSize: 7.2, color: palette.inkMuted, lineHeight: 1.1 },
            summaryLinkLabel: { fontSize: 7.4, bold: true, color: palette.brandDeep },
            summaryLinkText: { fontSize: 7.2, color: palette.brand, decoration: 'underline' },
            summaryBreakdownRank: { fontSize: 7.5, bold: true, alignment: 'center' },
            summaryBreakdownValue: { fontSize: 12, bold: true, alignment: 'center', margin: [0, 3, 0, 0] },
            summaryContributorTitle: { fontSize: 8.2, bold: true, color: palette.ink },
            summaryContributorMeta: { fontSize: 7.1, color: palette.inkMuted },
            summaryContributorCreditLabel: { fontSize: 6.5, bold: true, color: palette.inkMuted, alignment: 'center' },
            summaryContributorCreditValue: { fontSize: 12, bold: true, color: palette.brandDeep, alignment: 'center', margin: [0, 2, 0, 0] },
            summaryEmptyState: { fontSize: 8, italics: true, color: palette.textSoft },
            panelTitle: { fontSize: 13, bold: true, color: palette.brandDeep },
            panelSubtitle: { fontSize: 9, color: palette.inkMuted },
            sectionTitle: { fontSize: 15, bold: true, color: palette.brandDeep },
            sectionSubtitle: { fontSize: 9, color: palette.inkMuted },
            tableHeader: { fontSize: 8, bold: true, color: '#ffffff', fillColor: palette.brandDeep, margin: [0, 2, 0, 0] },
            tableKey: { fontSize: 9, bold: true, color: palette.ink },
            tableValue: { fontSize: 9, color: palette.ink },
            tableCell: { fontSize: 8, color: palette.ink },
            tableCellMono: { fontSize: 8, color: palette.inkMuted },
            weightRank: { fontSize: 10, bold: true, color: palette.brandDeep, alignment: 'center' },
            weightValue: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 8, 0, 0] },
            contributionEyebrow: { fontSize: 8, bold: true, color: palette.brand },
            contributionTitle: { fontSize: 11, bold: true, color: palette.ink },
            contributionVenue: { fontSize: 9, color: palette.inkMuted },
            contributionMeta: { fontSize: 8, color: palette.textSoft },
            bodyCopy: { fontSize: 10, color: palette.ink, lineHeight: 1.35 },
            emptyState: { fontSize: 10, italics: true, color: palette.textSoft },
            footnote: { fontSize: 9, color: palette.inkMuted },
            footerText: { fontSize: 8, color: palette.textSoft }
        },
        defaultStyle: {
            fontSize: 10,
            color: palette.ink
        }
    };
}
// pdfmake (~2.2 MB with fonts) is loaded on demand the first time a PDF report
// is generated, instead of being parsed on every Scholar page load.
let pdfMakeLoadPromise = null;
function ensurePdfMakeLoaded() {
    if (typeof window !== 'undefined' && window.pdfMake?.createPdf) {
        return Promise.resolve(window.pdfMake);
    }
    if (!pdfMakeLoadPromise) {
        pdfMakeLoadPromise = (async () => {
            const pdfModule = await import(chrome.runtime.getURL('vendor/pdfmake.min.js'));
            if (!window.pdfMake?.createPdf) {
                // The UMD bundle normally attaches to self/window; fall back to
                // the module namespace if a future build stops doing that.
                const candidate = pdfModule?.pdfMake || pdfModule?.default;
                if (candidate?.createPdf) {
                    window.pdfMake = candidate;
                }
            }
            await import(chrome.runtime.getURL('vendor/vfs_fonts.js'));
            if (!window.pdfMake?.createPdf) {
                throw new Error('pdfMake failed to initialize after dynamic load.');
            }
            return window.pdfMake;
        })().catch((error) => {
            pdfMakeLoadPromise = null;
            throw error;
        });
    }
    return pdfMakeLoadPromise;
}
async function buildPdfReportDataUrl(summaryState, reportVariant = 'full') {
    const pdfMake = await ensurePdfMakeLoaded();
    const docDefinition = buildPdfReportDefinition(summaryState, reportVariant);
    return await new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error(`PDF generation timed out for ${reportVariant} report.`));
        }, 15000);
        try {
            pdfMake.createPdf(docDefinition).getDataUrl((dataUrl) => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeoutId);
                if (dataUrl) {
                    resolve(dataUrl);
                }
                else {
                    reject(new Error('PDF data URL was empty.'));
                }
            });
        }
        catch (error) {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            reject(error);
        }
    });
}
function sanitizeFilenamePart(value) {
    const fallback = String(value || 'gsvr').trim();
    return fallback.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'gsvr';
}
async function copyTextToClipboard(text) {
    if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
}
async function triggerDownload(filename, mimeType, content) {
    if (chrome?.runtime?.sendMessage) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'GSVR_DOWNLOAD',
                filename,
                mimeType,
                content,
            });
            if (result?.ok) {
                return true;
            }
        }
        catch {
            // fall through to anchor download
        }
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
async function triggerDataUrlDownload(filename, dataUrl) {
    if (chrome?.runtime?.sendMessage) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'GSVR_DOWNLOAD',
                filename,
                dataUrl,
            });
            if (result?.ok) {
                return true;
            }
        }
        catch {
            // fall through to anchor download
        }
    }
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
}
function buildReportPayload(info) {
    const payload = {
        createdAt: new Date().toISOString(),
        profile: {
            authorName: currentProfileContext.authorName,
            scholarUserId: currentProfileContext.userId,
            dblpAuthorPid: currentProfileContext.dblpAuthorPid,
            surfaceMode: currentProfileContext.surfaceMode,
        },
        paper: info ? {
            title: getPaperTitle(info),
            scholarUrl: info.url || null,
            publicationYear: getPublicationYear(info),
            dblpKey: info.dblpKey || null,
            dblpUrl: getDblpEntryUrl(info),
        } : null,
        decision: info ? {
            system: info.system || 'UNKNOWN',
            rank: info.rank || 'N/A',
            reason: info.reason || getReviewReason(info),
            decisionStatus: info.decisionStatus || null,
            matchedVenue: info.matchedVenue || null,
            dblpVenue: info.dblpVenue || null,
            sourceYear: info.sourceYear || null,
            confidence: info.confidence ?? null,
            matchConfidence: info.matchConfidence ?? null,
            venueMatchConfidence: info.venueMatchConfidence ?? null,
            decisionEvidence: getDecisionEvidenceTokens(info),
            topCandidates: getTopCandidates(info),
        } : null,
    };
    return payload;
}
function getCurrentSummaryFilenameBase() {
    const authorPart = sanitizeFilenamePart(currentProfileContext.authorName || currentProfileContext.userId || 'profile');
    const surfacePart = sanitizeFilenamePart(currentProfileContext.surfaceMode || 'profile');
    return `${authorPart}-${surfacePart}`;
}
function getCurrentReportDownloadFilenameBase() {
    const authorName = currentSummaryState?.context?.authorName || currentProfileContext.authorName || currentSummaryState?.context?.userId || currentProfileContext.userId || 'profile';
    const fallback = String(authorName || 'profile').trim();
    return fallback
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'profile';
}
function buildSnapshotFromSummary(summaryState) {
    if (!summaryState) {
        return null;
    }
    const counts = {
        aStar: Number(summaryState.coreRankCounts?.['A*']) || 0,
        a: Number(summaryState.coreRankCounts?.A) || 0,
        q1: Number(summaryState.sjrRankCounts?.Q1) || 0,
        review: Number(summaryState.insights?.reviewCount) || 0,
        ranked: Number(summaryState.insights?.rankedCount) || 0,
        total: Number(summaryState.insights?.totalPapers) || 0,
    };
    return {
        id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        authorName: summaryState.context?.authorName || currentProfileContext.authorName || 'Unknown',
        userId: summaryState.context?.userId || currentProfileContext.userId || null,
        dblpAuthorPid: summaryState.context?.dblpAuthorPid || currentProfileContext.dblpAuthorPid || null,
        surfaceMode: summaryState.context?.surfaceMode || currentProfileContext.surfaceMode || 'profile',
        cacheTimestamp: summaryState.cacheTimestamp ?? null,
        coreRankCounts: { ...(summaryState.coreRankCounts || {}) },
        sjrRankCounts: { ...(summaryState.sjrRankCounts || {}) },
        dateRangeMode: summaryState.dateRangeMode || activeDateRangeMode,
        allPublicationRanks: Array.isArray(summaryState.allPublicationRanks) ? summaryState.allPublicationRanks.map((item) => ({ ...item })) : [],
        insights: summaryState.insights ? JSON.parse(JSON.stringify(summaryState.insights)) : null,
        publicationRanks: Array.isArray(summaryState.publicationRanks) ? summaryState.publicationRanks.map((item) => ({ ...item })) : [],
        counts,
    };
}
function buildSnapshotOptionLabel(snapshot) {
    if (!snapshot) {
        return 'Unknown snapshot';
    }
    const author = snapshot.authorName || 'Unknown';
    const when = formatTimestamp(snapshot.createdAt);
    return `${author} · ${when}`;
}
function getSnapshotMetric(summaryLike, key) {
    if (!summaryLike) {
        return 0;
    }
    if (key === 'rankedShare') {
        return Number(summaryLike.insights?.rankedShare) || 0;
    }
    if (key === 'aStarA') {
        return (Number(summaryLike.coreRankCounts?.['A*']) || 0) + (Number(summaryLike.coreRankCounts?.A) || 0);
    }
    if (key === 'q1') {
        return Number(summaryLike.sjrRankCounts?.Q1) || 0;
    }
    if (key === 'review') {
        return Number(summaryLike.insights?.reviewCount) || 0;
    }
    if (key === 'ranked') {
        return Number(summaryLike.insights?.rankedCount) || 0;
    }
    if (key === 'total') {
        return Number(summaryLike.insights?.totalPapers) || 0;
    }
    return 0;
}
function buildRankedVenueMap(summaryLike) {
    const map = new Map();
    for (const info of summaryLike?.publicationRanks || []) {
        if (!isRankedResultInfo(info)) {
            continue;
        }
        const key = String(info.matchedVenue || info.dblpVenue || info.rank || 'Unknown Venue').trim();
        if (!key) {
            continue;
        }
        map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
}
function buildComparisonSummary(leftSummary, rightSummary) {
    const metrics = [
        { key: 'total', label: 'Tracked Papers' },
        { key: 'ranked', label: 'Ranked Papers' },
        { key: 'rankedShare', label: 'Ranked Share' },
        { key: 'aStarA', label: 'A*/A Mix' },
        { key: 'q1', label: 'Q1 Mix' },
        { key: 'review', label: 'Review Backlog' },
    ].map((metric) => {
        const leftValue = getSnapshotMetric(leftSummary, metric.key);
        const rightValue = getSnapshotMetric(rightSummary, metric.key);
        return {
            ...metric,
            leftValue,
            rightValue,
            delta: typeof leftValue === 'number' && typeof rightValue === 'number'
                ? rightValue - leftValue
                : 0,
        };
    });
    const leftVenues = buildRankedVenueMap(leftSummary);
    const rightVenues = buildRankedVenueMap(rightSummary);
    const venueDelta = [];
    const allVenueNames = new Set([...leftVenues.keys(), ...rightVenues.keys()]);
    for (const venue of allVenueNames) {
        const leftCount = leftVenues.get(venue) || 0;
        const rightCount = rightVenues.get(venue) || 0;
        const delta = rightCount - leftCount;
        if (delta !== 0) {
            venueDelta.push({ venue, leftCount, rightCount, delta });
        }
    }
    venueDelta.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.venue.localeCompare(right.venue));
    return {
        metrics,
        venueDelta: venueDelta.slice(0, 8),
    };
}
async function saveCurrentProfileSnapshot() {
    if (!currentSummaryState) {
        return null;
    }
    const nextSnapshot = buildSnapshotFromSummary(currentSummaryState);
    if (!nextSnapshot) {
        return null;
    }
    const existing = await loadFeatureState('profileSnapshots');
    const snapshots = Array.isArray(existing) ? existing.slice(0, 11) : [];
    snapshots.unshift(nextSnapshot);
    await saveFeatureState('profileSnapshots', snapshots);
    return nextSnapshot;
}
function sortReviewItems(items, sortBy) {
    const list = Array.isArray(items) ? items.slice() : [];
    const getConfidenceValue = (info) => {
        if (typeof info?.confidence === 'number') {
            return info.confidence;
        }
        if (typeof info?.venueMatchConfidence === 'number') {
            return info.venueMatchConfidence;
        }
        if (typeof info?.matchConfidence === 'number') {
            return info.matchConfidence;
        }
        return -1;
    };
    list.sort((left, right) => {
        if (sortBy === 'year-desc') {
            return (getPublicationYear(right) || -1) - (getPublicationYear(left) || -1)
                || getPaperTitle(left).localeCompare(getPaperTitle(right));
        }
        if (sortBy === 'title') {
            return getPaperTitle(left).localeCompare(getPaperTitle(right))
                || (getPublicationYear(right) || -1) - (getPublicationYear(left) || -1);
        }
        if (sortBy === 'confidence') {
            return getConfidenceValue(right) - getConfidenceValue(left)
                || getPaperTitle(left).localeCompare(getPaperTitle(right));
        }
        return getReviewReason(left).localeCompare(getReviewReason(right))
            || (getPublicationYear(right) || -1) - (getPublicationYear(left) || -1)
            || getPaperTitle(left).localeCompare(getPaperTitle(right));
    });
    return list;
}
function setActiveDateRangeMode(nextMode) {
    const normalized = normalizeDateRangeMode(nextMode);
    if (normalized === activeDateRangeMode) {
        return;
    }
    const previousSummaryState = currentSummaryState;
    activeDateRangeMode = normalized;
    if (!previousSummaryState) {
        return;
    }
    const allPublicationRanks = previousSummaryState.allPublicationRanks || previousSummaryState.publicationRanks || [];
    displaySummaryPanel(
        previousSummaryState.allCoreRankCounts || previousSummaryState.coreRankCounts || createEmptyCoreRankCounts(),
        previousSummaryState.allSjrRankCounts || previousSummaryState.sjrRankCounts || createEmptySjrRankCounts(),
        previousSummaryState.context?.userId || currentProfileContext.userId,
        allPublicationRanks,
        previousSummaryState.cacheTimestamp,
        previousSummaryState.context?.dblpAuthorPid || currentProfileContext.dblpAuthorPid,
        previousSummaryState.scanLifecycle || null,
        previousSummaryState.context || currentProfileContext
    );
}
function createDateRangeToggle(summaryState) {
    const range = summaryState?.timeline?.range || buildTimelineViewState([], activeDateRangeMode).range;
    const currentYear = summaryState?.timeline?.currentYear || getTimelineCurrentYear();
    const last10Start = currentYear - 9;
    const control = document.createElement('div');
    control.className = 'gsr-date-range-toggle';
    control.setAttribute('role', 'group');
    control.setAttribute('aria-label', 'Statistics date range');
    const options = [
        {
            mode: 'full',
            label: 'Full Timeline',
            title: 'Use the complete Scholar profile timeline for all statistics'
        },
        {
            mode: 'last10',
            label: 'Last 10 Years',
            title: `Use ${last10Start}-${currentYear} for all statistics`
        }
    ];
    for (const option of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gsr-date-range-toggle__button';
        button.dataset.gsrDateRangeMode = option.mode;
        button.textContent = option.label;
        button.title = option.title;
        const isActive = range.mode === option.mode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        button.addEventListener('click', () => setActiveDateRangeMode(option.mode));
        control.appendChild(button);
    }
    return control;
}
function getHistogramRankOrder() {
    return TIMELINE_STATS_API?.HISTOGRAM_RANKS || ['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4'];
}
function getTopCoreHistogramRankOrder() {
    return TIMELINE_STATS_API?.TOP_CORE_HISTOGRAM_RANKS || ['A*', 'A'];
}
function getQ1HistogramRankOrder() {
    return TIMELINE_STATS_API?.Q1_HISTOGRAM_RANKS || ['Q1'];
}
function buildFocusedTimelineHistogram(histogram, rankOrder) {
    const ranks = Array.isArray(rankOrder) ? rankOrder : [];
    return (Array.isArray(histogram) ? histogram : []).map((bucket) => {
        const focusedRanks = {};
        let total = 0;
        for (const rank of ranks) {
            const value = Number(bucket?.ranks?.[rank] || 0);
            focusedRanks[rank] = value;
            total += value;
        }
        return {
            year: bucket?.year,
            ranks: focusedRanks,
            total,
        };
    });
}
function buildFocusedTimelineHistograms(histogram) {
    if (TIMELINE_STATS_API?.buildFocusedHistograms) {
        return TIMELINE_STATS_API.buildFocusedHistograms(histogram);
    }
    return {
        topCoreHistogram: buildFocusedTimelineHistogram(histogram, getTopCoreHistogramRankOrder()),
        q1Histogram: buildFocusedTimelineHistogram(histogram, getQ1HistogramRankOrder()),
    };
}
function getTimelineFocusedHistograms(timelineState, scope = 'recent') {
    const normalizedScope = scope === 'full' ? 'full' : 'recent';
    const focused = timelineState?.focusedHistograms?.[normalizedScope];
    if (focused?.topCoreHistogram && focused?.q1Histogram) {
        return focused;
    }
    const histogram = normalizedScope === 'full'
        ? timelineState?.fullHistogram
        : timelineState?.recentHistogram;
    return buildFocusedTimelineHistograms(histogram || []);
}
function createTimelineHistogramSection(histogram, { titleText, subtitleText, rankOrder, variant } = {}) {
    const buckets = Array.isArray(histogram) ? histogram : [];
    const ranks = Array.isArray(rankOrder) && rankOrder.length ? rankOrder : getHistogramRankOrder();
    const section = document.createElement('div');
    section.className = `gsr-timeline-histogram${variant ? ` gsr-timeline-histogram--${variant}` : ''}`;
    const header = document.createElement('div');
    header.className = 'gsr-timeline-histogram__header';
    const title = document.createElement('div');
    title.className = 'gsr-timeline-histogram__title';
    title.textContent = titleText || 'Yearly Timeline';
    header.appendChild(title);
    if (subtitleText) {
        const subtitle = document.createElement('span');
        subtitle.className = 'gsr-timeline-histogram__subtitle';
        subtitle.textContent = subtitleText;
        header.appendChild(subtitle);
    }
    section.appendChild(header);
    const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket?.total) || 0));
    const chart = document.createElement('div');
    chart.className = 'gsr-timeline-histogram__chart';
    for (const bucket of buckets) {
        const column = document.createElement('div');
        column.className = 'gsr-timeline-histogram__column';
        const bar = document.createElement('div');
        bar.className = 'gsr-timeline-histogram__bar';
        bar.title = `${bucket.year}: ${Number(bucket.total || 0)} ranked paper${Number(bucket.total || 0) === 1 ? '' : 's'}`;
        const count = document.createElement('span');
        count.className = 'gsr-timeline-histogram__count';
        count.textContent = String(Number(bucket.total || 0));
        column.appendChild(count);
        for (const rank of ranks.slice().reverse()) {
            const value = Number(bucket?.ranks?.[rank] || 0);
            if (!value) {
                continue;
            }
            const segment = document.createElement('span');
            segment.className = 'gsr-timeline-histogram__segment';
            segment.dataset.gsrRank = normalizeRankKey(rank);
            segment.style.height = `${Math.max(4, (value / maxTotal) * 100)}%`;
            segment.title = `${bucket.year} ${rank}: ${value}`;
            bar.appendChild(segment);
        }
        if (!bar.children.length) {
            const empty = document.createElement('span');
            empty.className = 'gsr-timeline-histogram__empty';
            bar.appendChild(empty);
        }
        column.appendChild(bar);
        const yearLabel = document.createElement('span');
        yearLabel.className = 'gsr-timeline-histogram__year';
        yearLabel.textContent = String(bucket.year);
        column.appendChild(yearLabel);
        chart.appendChild(column);
    }
    section.appendChild(chart);
    const legend = document.createElement('div');
    legend.className = 'gsr-timeline-histogram__legend';
    for (const rank of ranks) {
        const item = document.createElement('span');
        item.className = 'gsr-timeline-histogram__legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'gsr-timeline-histogram__legend-swatch';
        swatch.dataset.gsrRank = normalizeRankKey(rank);
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(rank));
        legend.appendChild(item);
    }
    section.appendChild(legend);
    return section;
}
function groupReviewItems(items, groupBy) {
    const source = Array.isArray(items) ? items : [];
    if (groupBy !== 'reason') {
        return [{ label: 'All Review Items', items: source }];
    }
    const groups = new Map();
    for (const item of source) {
        const reason = getReviewReason(item);
        if (!groups.has(reason)) {
            groups.set(reason, []);
        }
        groups.get(reason).push(item);
    }
    return Array.from(groups.entries())
        .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
        .map(([label, entries]) => ({ label, items: entries }));
}
async function buildDataFreshnessState(summaryState) {
    const manifestVersion = chrome?.runtime?.getManifest?.().version || 'unknown';
    const coreYears = ORDERED_CORE_DATA_FILES.map((value) => getCoreDatasetYear(value)).filter((value) => Number.isFinite(value));
    let sjrStartYear = null;
    let sjrEndYear = null;
    try {
        const response = await gsvrFetch(chrome.runtime.getURL('data/sjr-index.json'));
        if (response.ok) {
            const json = await response.json();
            sjrStartYear = Number.isFinite(json?.startYear) ? json.startYear : null;
            sjrEndYear = Number.isFinite(json?.endYear) ? json.endYear : null;
        }
    }
    catch (error) {
        console.warn('GSR: Failed to load SJR freshness metadata.', error);
    }
    const freshness = {
        generatedAt: new Date().toISOString(),
        extensionVersion: manifestVersion,
        activePacks: currentRankingPacks.slice(),
        coreCoverageStart: coreYears.length ? Math.min(...coreYears) : null,
        coreCoverageEnd: coreYears.length ? Math.max(...coreYears) : null,
        coreCoverageYears: coreYears,
        sjrCoverageStart: sjrStartYear,
        sjrCoverageEnd: sjrEndYear,
        changelogNotes: CHANGELOG_NOTES.slice(),
        cacheTimestamp: summaryState?.cacheTimestamp ?? null,
        reviewReasons: (summaryState?.insights?.reviewReasons || []).map((entry) => ({ ...entry })),
        lastProfileRunAt: new Date().toISOString(),
        lastSeenVersion: manifestVersion,
        lastDataRefreshLabel: `CORE ${coreYears.length ? Math.max(...coreYears) : 'Unknown'} / SJR ${sjrEndYear || 'Unknown'}`,
        lastCoreDatasetYear: coreYears.length ? Math.max(...coreYears) : null,
        lastSjrDatasetYear: sjrEndYear || null,
        updatedAt: new Date().toISOString(),
        lastUserId: currentProfileContext.userId || null,
    };
    await saveFeatureState('dataFreshnessState', freshness);
    return freshness;
}
function getDialogFocusableElements(container) {
    return Array.from(container.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
}
function closeDialogOverlay(overlay, panel, { restoreFocus = true } = {}) {
    overlay.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    if (restoreFocus && gsrDialogLastFocusedEl instanceof HTMLElement) {
        gsrDialogLastFocusedEl.focus();
    }
}
function openDialogOverlay(overlay, panel, initialFocusSelector = '.gsr-icon-button, .gsr-button, button, a[href], input, select, textarea') {
    gsrDialogLastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => {
        const focusTarget = panel.querySelector(initialFocusSelector);
        if (focusTarget instanceof HTMLElement) {
            focusTarget.focus();
        }
    }, 0);
}
function createDialogOverlay({ overlayId, panelClass, titleId, titleText, descriptionId, descriptionText }) {
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    overlay.className = 'search-utility-overlay gsr-dialog-overlay';
    const panel = document.createElement('div');
    panel.className = `gsr-dialog-panel ${panelClass}`.trim();
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    panel.setAttribute('aria-describedby', descriptionId);
    panel.setAttribute('aria-hidden', 'true');
    const header = document.createElement('div');
    header.className = 'gsr-search-panel__header gsr-dialog-panel__header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'gsr-dialog-panel__title-group';
    const title = document.createElement('h3');
    title.className = 'gsr-dialog-panel__title';
    title.id = titleId;
    title.textContent = titleText;
    titleGroup.appendChild(title);
    const description = document.createElement('p');
    description.id = descriptionId;
    description.className = 'gsr-search-panel__description gsr-dialog-panel__description';
    description.textContent = descriptionText;
    titleGroup.appendChild(description);
    header.appendChild(titleGroup);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'gsr-icon-button gsr-dialog-panel__close';
    closeButton.setAttribute('aria-label', `Close ${titleText}`);
    closeButton.textContent = '×';
    header.appendChild(closeButton);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.className = 'gsr-dialog-panel__body';
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeDialogOverlay(overlay, panel);
        }
    });
    closeButton.addEventListener('click', () => closeDialogOverlay(overlay, panel));
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDialogOverlay(overlay, panel);
            return;
        }
        if (event.key === 'Tab') {
            const focusable = getDialogFocusableElements(panel);
            if (!focusable.length) {
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
    document.body.appendChild(overlay);
    return { overlay, panel, body, closeButton, title, description };
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
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
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
    if (pubYear >= 2014)
        return 'core/CORE_2014.json';
    if (pubYear >= 2013)
        return 'core/CORE_2013.json';
    // ERA 2010 list (hosted by the CORE portal as the 2010 snapshot).
    if (pubYear >= 2010)
        return 'core/CORE_2010.json';
    // CORE 2008 is the oldest bundled snapshot; pre-2008 papers use it with
    // limited historical coverage.
    return 'core/CORE_2008.json';
}
const ORDERED_CORE_DATA_FILES = [
    'core/CORE_2026.json',
    'core/CORE_2023.json',
    'core/CORE_2021.json',
    'core/CORE_2020.json',
    'core/CORE_2018.json',
    'core/CORE_2017.json',
    'core/CORE_2014.json',
    'core/CORE_2013.json',
    'core/CORE_2010.json',
    'core/CORE_2008.json',
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
            decisionEvidence: details.decisionEvidence ?? null,
            topCandidates: details.topCandidates ?? null
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
        decisionEvidence: ['no_core_match'],
        topCandidates: null
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
async function buildConferenceSearchHistory(venueQuery) {
    const history = [];
    for (const coreDataFile of ORDERED_CORE_DATA_FILES) {
        const outcome = await searchConferenceInCoreFile(venueQuery, coreDataFile);
        if (!outcome?.sourceYear) {
            continue;
        }
        history.push({
            sourceYear: outcome.sourceYear,
            rank: outcome.rank,
            status: outcome.status,
            matchedVenue: outcome.matchedVenue || null,
            rawRankLabel: outcome.rawRankLabel || null,
        });
    }
    return history
        .sort((left, right) => (right.sourceYear || 0) - (left.sourceYear || 0))
        .filter((entry, index, array) => array.findIndex((candidate) => candidate.sourceYear === entry.sourceYear) === index)
        .slice(0, 6);
}
async function buildJournalSearchHistory(journalName) {
    const history = [];
    for (let year = SJR_DATASET_END_YEAR; year >= SJR_DATASET_START_YEAR; year--) {
        const result = await resolveSjrQuartile(journalName, year);
        if (result.status === 'success' && result.quartile) {
            history.push({
                sourceYear: result.year || year,
                quartile: result.quartile,
                resolvedTitle: result.resolvedTitle || journalName,
            });
        }
    }
    return history
        .filter((entry, index, array) => array.findIndex((candidate) => candidate.sourceYear === entry.sourceYear) === index)
        .slice(0, 8);
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

// Journal-name normalization, variants, and SJR matching live in the shared
// core/journal_match.js module so the content script, the Node test mirror,
// and the index generator can never drift apart.
function normalizeJournalName(name) {
    return JOURNAL_MATCH_API.normalizeJournalName(name);
}
function generateJournalNormalizationVariants(name) {
    return JOURNAL_MATCH_API.generateJournalNormalizationVariants(name);
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
const SJR_DATASET_START_YEAR = 1999;
const SJR_DATASET_END_YEAR = 2024;
const sjrLookupCache = new Map();
let sjrDatasetPromise = null;
function buildSjrLookupCacheKey(normalizedQuery, queryIssns = []) {
    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
    if (typeof utils?.buildJournalLookupCacheKey === 'function') {
        return utils.buildJournalLookupCacheKey(normalizedQuery, queryIssns);
    }
    const base = String(normalizedQuery || '').trim().toLowerCase();
    const issnKey = normalizeIssnList(queryIssns).join(',');
    return issnKey ? `${base}::issn:${issnKey}` : base;
}
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
    return JOURNAL_MATCH_API.createTokenSet(normalizedTitle);
}
function createSjrTokenIndex(entries) {
    return JOURNAL_MATCH_API.createSjrTokenIndex(entries);
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
                // Distinct journals (sourceIds) can share a normalized-title key,
                // so byNormalized maps key -> ARRAY of entries. findBestSjrMatch
                // abstains on multi-journal buckets unless ISSN evidence resolves them.
                const registerKey = (key, entry) => {
                    if (!key)
                        return;
                    const bucket = byNormalized.get(key);
                    if (!bucket) {
                        byNormalized.set(key, [entry]);
                    }
                    else if (!bucket.includes(entry)) {
                        bucket.push(entry);
                    }
                };
                for (const item of payload.entries) {
                    if (!item?.n || !item?.t || !item?.q)
                        continue;
                    const entry = createSjrEntry(item.n, item.t, item.q, {
                        tokens: item.k,
                        issns: item.i,
                        sourceId: item.s,
                        coverage: item.c
                    });
                    registerKey(entry.normalizedTitle, entry);
                    // v3 payloads carry alias keys for journals whose titles changed across years.
                    if (Array.isArray(item.a)) {
                        for (const aliasKey of item.a) {
                            registerKey(String(aliasKey || '').trim(), entry);
                        }
                    }
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
        console.error('GSVR: Failed to load the compact SJR index; journal lookups are unavailable for this page load.', error);
    }
    // No raw-CSV fallback: the CSV corpus is no longer shipped in the package.
    // Callers see loadFailed and report "lookup unavailable" instead of "not found".
    return {
        version: 3,
        startYear: SJR_DATASET_START_YEAR,
        endYear: SJR_DATASET_END_YEAR,
        byNormalized: new Map(),
        byIssn: new Map(),
        entries: [],
        tokenIndex: { tokenToIndexes: new Map(), tokenFrequency: new Map() },
        loadFailed: true
    };
}
function ensureSjrDataset() {
    if (!sjrDatasetPromise) {
        sjrDatasetPromise = loadSjrDataset().then((dataset) => {
            if (dataset?.loadFailed) {
                // Allow a later scan (e.g. manual rescan) to retry the fetch.
                sjrDatasetPromise = null;
            }
            return dataset;
        });
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
        if (publicationYear < SJR_DATASET_START_YEAR) {
            return {
                quartile: null,
                year: null,
                sourceYearFallback: false,
                historicalCoverageUnavailable: true
            };
        }
        const targetYear = publicationYear;
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
function buildSjrQuartileSelectionResult(data, selection, extra = {}) {
    if (selection?.historicalCoverageUnavailable) {
        return {
            status: 'historical_coverage_unavailable',
            reason: 'sjr_historical_coverage_unavailable',
            quartile: null,
            year: null,
            resolvedTitle: data?.resolvedTitle ?? null,
            matchScore: extra.matchScore ?? null,
            matchedNormalizedTitle: extra.matchedNormalizedTitle ?? null,
            matchedSourceId: data?.sourceId ?? extra.matchedSourceId ?? null,
            sourceYearFallback: false
        };
    }
    return {
        status: 'success',
        quartile: selection?.quartile ?? null,
        year: selection?.year ?? null,
        resolvedTitle: data?.resolvedTitle ?? null,
        matchScore: extra.matchScore ?? null,
        matchedNormalizedTitle: extra.matchedNormalizedTitle ?? null,
        matchedSourceId: data?.sourceId ?? extra.matchedSourceId ?? null,
        sourceYearFallback: selection?.sourceYearFallback === true
    };
}
function selectSjrCandidateIndexes(queryTokens, dataset) {
    return JOURNAL_MATCH_API.selectSjrCandidateIndexes(queryTokens, dataset);
}
function findBestSjrMatch({ normalizedQuery, queryIssns, dataset, rawQuery = null }) {
    return JOURNAL_MATCH_API.findBestSjrMatch({ normalizedQuery, queryIssns, dataset, rawQuery });
}
async function resolveSjrQuartile(journalName, publicationYear, journalMeta = {}) {
    const variants = generateJournalNormalizationVariants(journalName);
    if (!variants.length)
        return { status: 'not_found' };
    const queryIssns = normalizeIssnList(journalMeta.issns);
    const hasScopedIssns = queryIssns.length > 0;

    // Try cache first across variants.
    let sawNotFound = false;
    for (const normalizedQuery of variants) {
        const scopedCacheKey = buildSjrLookupCacheKey(normalizedQuery, queryIssns);
        const genericCacheKey = buildSjrLookupCacheKey(normalizedQuery, []);
        const scopedEntry = sjrLookupCache.get(scopedCacheKey);
        if (scopedEntry?.kind === 'success') {
            const selection = selectQuartileForYear(scopedEntry.data, publicationYear ?? null);
            return buildSjrQuartileSelectionResult(scopedEntry.data, selection, {
                matchScore: scopedEntry.matchScore ?? null,
                matchedNormalizedTitle: scopedEntry.matchedNormalizedTitle ?? null
            });
        }
        const genericEntry = genericCacheKey !== scopedCacheKey ? sjrLookupCache.get(genericCacheKey) : null;
        if (genericEntry?.kind === 'success') {
            const selection = selectQuartileForYear(genericEntry.data, publicationYear ?? null);
            return buildSjrQuartileSelectionResult(genericEntry.data, selection, {
                matchScore: genericEntry.matchScore ?? null,
                matchedNormalizedTitle: genericEntry.matchedNormalizedTitle ?? null
            });
        }
        if (scopedEntry?.kind === 'not_found') {
            sawNotFound = true;
            continue;
        }
        if (!hasScopedIssns && genericEntry?.kind === 'not_found') {
            sawNotFound = true;
            continue;
        }
    }
    try {
        const dataset = await ensureSjrDataset();
        if (dataset?.loadFailed) {
            return { status: 'error', transient: true };
        }
        let sawAmbiguous = false;
        for (const normalizedQuery of variants) {
            const match = findBestSjrMatch({ normalizedQuery, queryIssns, dataset, rawQuery: journalName });
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
            const cacheKeys = (hasScopedIssns && match.matchedBy === 'issn')
                ? variants.map((variant) => buildSjrLookupCacheKey(variant, queryIssns))
                : variants.map((variant) => buildSjrLookupCacheKey(variant, []));
            // Cache the successful match for all equivalent variants. Exact ISSN hits stay scoped
            // so a title-only miss from fast scan cannot suppress a later ISSN-backed depth hit.
            for (const cacheKey of cacheKeys) {
                sjrLookupCache.set(cacheKey, {
                    kind: 'success',
                    data,
                    matchScore: match.score,
                    matchedNormalizedTitle: entry.normalizedTitle
                });
            }
            const selection = selectQuartileForYear(data, publicationYear ?? null);
            return buildSjrQuartileSelectionResult(data, selection, {
                matchScore: match.score,
                matchedNormalizedTitle: entry.normalizedTitle
            });
        }
        if (sawAmbiguous) {
            return { status: 'ambiguous' };
        }

        // Not found: cache negative result. ISSN-aware misses stay scoped to that ISSN set.
        if (!sawNotFound) {
            const missCacheKeys = hasScopedIssns
                ? variants.map((variant) => buildSjrLookupCacheKey(variant, queryIssns))
                : variants.map((variant) => buildSjrLookupCacheKey(variant, []));
            for (const cacheKey of missCacheKeys) {
                sjrLookupCache.set(cacheKey, { kind: 'not_found' });
            }
        }
        return { status: 'not_found' };
    }
    catch (error) {
        console.error('Error resolving SJR quartile from local dataset:', error);
        return { status: 'error', transient: false };
    }
}
// Text comparison cleanup (abbreviation expansion, diacritic folding) lives in
// the shared core/journal_match.js module. String similarity lives in
// rank_core.js. The former local copies drifted from the canonical versions.
function cleanTextForComparison(text, isGoogleScholarVenue = false) {
    return JOURNAL_MATCH_API.cleanTextForComparison(text, isGoogleScholarVenue);
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
                decisionEvidence: result.reason ? [result.reason] : null,
                topCandidates: Array.isArray(result.topCandidates) ? result.topCandidates : null
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
            items.push({ label: 'Ranking Snapshot Year', value: String(meta.sourceYear) });
        }
        if (meta.sourceYearFallback) {
            items.push({ label: 'Snapshot Mode', value: 'Latest available snapshot' });
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
    badge.removeAttribute('title');
    badge.setAttribute('aria-describedby', BADGE_POPOVER_ID);
    const show = () => showBadgePopover(badge, items);
    badge.addEventListener('mouseenter', show);
    badge.addEventListener('focus', show);
    badge.addEventListener('mouseleave', () => hideBadgePopover(false));
    badge.addEventListener('blur', () => hideBadgePopover(false));
    badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (meta) {
            openDetailDrawer(meta);
        }
    });
    badge.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && meta) {
            event.preventDefault();
            openDetailDrawer(meta);
        }
    });
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
    title.textContent = 'Venue Explorer';
    titleGroup.appendChild(title);
    const description = document.createElement('p');
    description.id = 'gsr-search-panel-description';
    description.className = 'gsr-search-panel__description';
    description.textContent = 'Search across the bundled CORE and SJR datasets, review historical snapshots, and inspect ambiguity or alias hints without leaving Google Scholar.';
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
    typeLabel.textContent = 'Scope:';
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

    rowType.appendChild(mkRadio('gsr-type-auto', 'auto', 'Auto', true));
    rowType.appendChild(mkRadio('gsr-type-conference', 'conference', 'Conference', false));
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
    for (let y = 2026; y >= SJR_DATASET_START_YEAR; y--) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        yearSelect.appendChild(opt);
    }
    row2.appendChild(yearSelect);
    panel.appendChild(row2);
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
    const result = document.createElement('div');
    result.className = 'gsr-search-result';
    result.id = 'gsr-venue-search-result';
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    result.textContent = 'Choose a scope, enter a venue and optionally a year, then press Search.';
    panel.appendChild(result);
    const getFocusableElements = () => Array.from(panel.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'));
    const closeOverlay = (clear = true) => {
        overlay.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        hideBadgePopover(true);
        if (clear) {
            venueInput.value = '';
            yearSelect.value = '';
            result.textContent = 'Choose a scope, enter a venue and optionally a year, then press Search.';
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
        result.textContent = 'Choose a scope, enter a venue and optionally a year, then press Search.';
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
        const selectedType = (panel.querySelector('input[name="gsr-venue-type"]:checked')?.value) || 'auto';
        result.textContent = 'Searching…';
        try {
            result.innerHTML = '';
            const addSection = (titleText) => {
                const section = document.createElement('section');
                section.className = 'gsr-venue-explorer__section';
                const heading = document.createElement('h4');
                heading.className = 'gsr-venue-explorer__title';
                heading.textContent = titleText;
                section.appendChild(heading);
                result.appendChild(section);
                return section;
            };
            const addItem = (label, value, host = result) => {
                const line = document.createElement('div');
                line.className = 'gsr-result-item';
                const l = document.createElement('span');
                l.className = 'gsr-result-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.textContent = value;
                line.appendChild(l);
                line.appendChild(v);
                host.appendChild(line);
            };
            const addNote = (text, host = result) => {
                const note = document.createElement('div');
                note.className = 'gsr-result-item gsr-result-item--note';
                note.textContent = text;
                host.appendChild(note);
            };
            if (selectedType === 'auto' || selectedType === 'conference') {
                const section = addSection('Conference / CORE');
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
                addItem(`Conference (CORE ${primaryYear || ''})`, primaryValue, section);
                if (primary.matchedVenue) {
                    addItem('Matched Venue', primary.matchedVenue, section);
                    if (primary.matchedVenue.toLowerCase() !== venueQuery.toLowerCase()) {
                        addItem('Alias / Rename Hint', `${venueQuery} resolved to ${primary.matchedVenue}`, section);
                    }
                }
                if (primary.status === DECISION_STATUS.UNRANKED && primary.rawRankLabel) {
                    addItem('Current CORE status', formatCoreStatusLabel(primary.rawRankLabel), section);
                }
                if (conferenceSearch.latestRankedSnapshot
                    && conferenceSearch.latestRankedSnapshot.sourceYear
                    && conferenceSearch.latestRankedSnapshot.sourceYear !== primary.sourceYear) {
                    addItem('Latest ranked snapshot', `CORE ${conferenceSearch.latestRankedSnapshot.sourceYear} · ${conferenceSearch.latestRankedSnapshot.rank}`, section);
                }
                const conferenceHistory = await buildConferenceSearchHistory(venueQuery);
                if (conferenceHistory.length) {
                    addItem('History', conferenceHistory
                        .map((entry) => `CORE ${entry.sourceYear}: ${entry.status === DECISION_STATUS.MATCHED ? entry.rank : (entry.status === DECISION_STATUS.UNRANKED ? 'Unranked' : humanizeIdentifier(entry.status))}`)
                        .join(' | '), section);
                }
                if (primary.status === DECISION_STATUS.AMBIGUOUS) {
                    addNote('Multiple CORE venues matched this query too closely. Please use a more specific venue title or inspect the candidate list below.', section);
                    const candidates = getTopCandidates(primary);
                    if (candidates.length) {
                        addItem('Candidates', candidates.map((candidate) => candidate.title || candidate.acronym || candidate.venue || 'Candidate').join(' | '), section);
                    }
                }
                else if (primary.status === DECISION_STATUS.UNRANKED) {
                    addNote(conferenceSearch.latestRankedSnapshot
                        ? 'This venue exists in the current CORE snapshot but is not currently ranked there. The latest ranked snapshot is shown above.'
                        : 'This venue exists in the current CORE snapshot but is currently unranked there.', section);
                }
                else if (primary.status !== DECISION_STATUS.MATCHED) {
                    addNote(conferenceSearch.latestRankedSnapshot
                        ? 'No ranked result was found in the selected CORE snapshot. The latest ranked snapshot is shown above.'
                        : 'No match was found in the bundled CORE snapshots for this query.', section);
                }
            }
            if (selectedType === 'auto' || selectedType === 'journal') {
                const section = addSection('Journal / SJR');
                const sjr = await resolveSjrQuartile(venueQuery, yearVal);
                const sjrQuartile = (sjr.status === 'success' && sjr.quartile) ? sjr.quartile : null;
                addItem('Journal / Transaction (SJR)', (sjrQuartile && SJR_QUARTILES.includes(sjrQuartile)) ? sjrQuartile : (sjr.status === 'ambiguous' ? 'Ambiguous' : 'Not found'), section);
                if (sjr.status === 'success' && sjr.resolvedTitle) {
                    addItem('Matched Journal', sjr.resolvedTitle, section);
                    if (sjr.resolvedTitle.toLowerCase() !== venueQuery.toLowerCase()) {
                        addItem('Alias / Rename Hint', `${venueQuery} resolved to ${sjr.resolvedTitle}`, section);
                    }
                }
                const journalHistory = await buildJournalSearchHistory(venueQuery);
                if (journalHistory.length) {
                    addItem('History', journalHistory.map((entry) => `${entry.sourceYear}: ${entry.quartile}`).join(' | '), section);
                }
                if (sjr.status === 'ambiguous') {
                    addNote('Multiple SJR journals matched this query too closely. Try a fuller journal title.', section);
                }
                else if (!(sjrQuartile && SJR_QUARTILES.includes(sjrQuartile))) {
                    addNote('No match in the local SJR dataset for this query.', section);
                }
            }
            if (!result.childNodes.length) {
                result.textContent = 'No result was found in the bundled ranking datasets.';
            }
            else if (selectedType === 'auto') {
                const intro = document.createElement('div');
                intro.className = 'gsr-result-item gsr-result-item--note';
                intro.textContent = 'Auto mode searched both conference and journal datasets from one surface.';
                result.prepend(intro);
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
function ensureManualDblpOverrideOverlay() {
    if (gsrManualDblpOverlayEl && document.body.contains(gsrManualDblpOverlayEl)) {
        return gsrManualDblpOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: MANUAL_DBLP_OVERLAY_ID,
        panelClass: 'gsr-manual-dblp-panel',
        titleId: 'gsr-manual-dblp-title',
        titleText: 'Set DBLP Profile Manually',
        descriptionId: 'gsr-manual-dblp-description',
        descriptionText: 'Paste a DBLP PID or profile URL for this Scholar profile. The override is stored locally in this browser.'
    });
    const { overlay, panel, body } = scaffold;
    const helper = document.createElement('p');
    helper.className = 'gsr-manual-dblp__helper';
    helper.textContent = 'Accepted examples: 64/4311 or https://dblp.org/pid/64/4311.html';
    body.appendChild(helper);
    const field = document.createElement('label');
    field.className = 'gsr-review-inbox__field gsr-manual-dblp__field';
    const label = document.createElement('span');
    label.textContent = 'DBLP PID or URL';
    field.appendChild(label);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gsr-manual-dblp__input';
    input.placeholder = '64/4311 or https://dblp.org/pid/64/4311.html';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('data-role', 'manual-dblp-input');
    field.appendChild(input);
    body.appendChild(field);
    const status = document.createElement('div');
    status.className = 'gsr-manual-dblp__status';
    status.setAttribute('data-role', 'manual-dblp-status');
    body.appendChild(status);
    const actions = document.createElement('div');
    actions.className = 'gsr-dialog-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'gsr-button gsr-button--ghost';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => closeDialogOverlay(overlay, panel));
    actions.appendChild(cancelButton);
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'gsr-button gsr-button--primary';
    saveButton.textContent = 'Save and Rescan';
    actions.appendChild(saveButton);
    body.appendChild(actions);
    const setStatusMessage = (message, tone = 'neutral') => {
        status.textContent = message || '';
        status.dataset.tone = tone;
    };
    const setPendingState = (pending) => {
        input.disabled = pending;
        cancelButton.disabled = pending;
        saveButton.disabled = pending;
        saveButton.textContent = pending ? 'Validating...' : 'Save and Rescan';
    };
    const submit = async () => {
        const currentUserId = currentProfileContext.userId || getScholarUserId();
        if (!currentUserId) {
            setStatusMessage('Could not determine the Scholar profile ID for this page.', 'error');
            return;
        }
        const normalizedPid = extractPidFromUrl(input.value);
        if (!normalizedPid) {
            setStatusMessage('Enter a valid DBLP PID or DBLP profile URL.', 'error');
            return;
        }
        setPendingState(true);
        setStatusMessage(`Checking DBLP profile ${normalizedPid}...`, 'neutral');
        try {
            const dblpPublications = await fetchDblpPubsForCheck(normalizedPid);
            if (!Array.isArray(dblpPublications) || dblpPublications.length === 0) {
                setStatusMessage('That DBLP profile could not be verified because no publications were found.', 'error');
                return;
            }
            await saveManualDblpPid(currentUserId, normalizedPid);
            closeDialogOverlay(overlay, panel);
            await rescanCurrentProfile();
        }
        catch (error) {
            if (error instanceof DblpRateLimitError || error instanceof DblpBusyError) {
                setStatusMessage('DBLP is rate limiting requests right now. Try again in a moment.', 'error');
            }
            else if (error instanceof DblpUnavailableError || error instanceof DblpTransientLookupError) {
                setStatusMessage('DBLP is temporarily unavailable, so the manual profile could not be verified.', 'error');
            }
            else {
                setStatusMessage('Could not verify that DBLP profile. Double-check the PID or URL and try again.', 'error');
            }
        }
        finally {
            setPendingState(false);
        }
    };
    saveButton.addEventListener('click', () => {
        submit().catch((error) => console.error('GSR: Failed to save manual DBLP override.', error));
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit().catch((error) => console.error('GSR: Failed to save manual DBLP override.', error));
        }
    });
    input.addEventListener('input', () => setStatusMessage('', 'neutral'));
    gsrManualDblpOverlayEl = overlay;
    return overlay;
}
async function openManualDblpOverrideOverlay() {
    const overlay = ensureManualDblpOverrideOverlay();
    const panel = overlay.querySelector('.gsr-manual-dblp-panel');
    const input = overlay.querySelector('[data-role="manual-dblp-input"]');
    const status = overlay.querySelector('[data-role="manual-dblp-status"]');
    if (!(panel instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !(status instanceof HTMLElement)) {
        return;
    }
    const currentUserId = currentProfileContext.userId || getScholarUserId();
    const storedManualPid = currentUserId ? await loadManualDblpPid(currentUserId) : null;
    input.value = storedManualPid || currentProfileContext.dblpAuthorPid || '';
    status.textContent = '';
    status.dataset.tone = 'neutral';
    openDialogOverlay(overlay, panel, '.gsr-manual-dblp__input');
}
function findPublicationInfoByUrl(url) {
    const normalized = normalizeUrlForCache(url || '');
    return (currentSummaryState?.publicationRanks || []).find((info) => normalizeUrlForCache(info?.url || '') === normalized) || null;
}
function buildReportPacketMarkdown(info) {
    const payload = buildReportPayload(info);
    const lines = [
        '# GSVR Report Packet',
        '',
        `- Created At: ${payload.createdAt}`,
        `- Author: ${payload.profile.authorName || 'Unknown'}`,
        `- Scholar User ID: ${payload.profile.scholarUserId || 'N/A'}`,
        `- DBLP PID: ${payload.profile.dblpAuthorPid || 'N/A'}`,
        `- Surface: ${payload.profile.surfaceMode || 'profile'}`,
    ];
    if (payload.paper) {
        lines.push(`- Paper: ${payload.paper.title || 'Unknown'}`);
        lines.push(`- Scholar URL: ${payload.paper.scholarUrl || 'N/A'}`);
        lines.push(`- Publication Year: ${payload.paper.publicationYear || 'N/A'}`);
        lines.push(`- DBLP Key: ${payload.paper.dblpKey || 'N/A'}`);
        lines.push(`- DBLP URL: ${payload.paper.dblpUrl || 'N/A'}`);
    }
    if (payload.decision) {
        lines.push(`- System: ${payload.decision.system}`);
        lines.push(`- Rank Outcome: ${payload.decision.rank}`);
        lines.push(`- Review Reason: ${payload.decision.reason || 'N/A'}`);
        lines.push(`- Decision Status: ${payload.decision.decisionStatus || 'N/A'}`);
        lines.push(`- Matched Venue: ${payload.decision.matchedVenue || 'N/A'}`);
        lines.push(`- DBLP Venue: ${payload.decision.dblpVenue || 'N/A'}`);
        lines.push(`- Ranking Snapshot Year: ${payload.decision.sourceYear || 'N/A'}`);
        lines.push(`- Confidence: ${typeof payload.decision.confidence === 'number' ? payload.decision.confidence : 'N/A'}`);
        lines.push(`- Evidence: ${(payload.decision.decisionEvidence || []).join(', ') || 'N/A'}`);
    }
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(payload, null, 2));
    lines.push('```');
    return lines.join('\n');
}
function ensureDetailDrawer() {
    if (gsrDetailDrawerEl && document.body.contains(gsrDetailDrawerEl)) {
        return gsrDetailDrawerEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: DETAIL_DRAWER_ID,
        panelClass: 'gsr-detail-drawer',
        titleId: 'gsr-detail-drawer-title',
        titleText: 'Ranking Decision Details',
        descriptionId: 'gsr-detail-drawer-description',
        descriptionText: 'Inspect the matched venue, confidence, ambiguity candidates, and decision evidence behind this result.',
    });
    scaffold.overlay.classList.add('gsr-dialog-overlay--drawer');
    scaffold.body.classList.add('gsr-detail-drawer__body');
    gsrDetailDrawerEl = scaffold.overlay;
    return scaffold.overlay;
}
function openDetailDrawer(info) {
    const overlay = ensureDetailDrawer();
    const panel = overlay.querySelector('.gsr-detail-drawer');
    const body = panel?.querySelector('.gsr-detail-drawer__body');
    const title = panel?.querySelector('#gsr-detail-drawer-title');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const resolvedInfo = info?.url ? (findPublicationInfoByUrl(info.url) || info) : info;
    body.innerHTML = '';
    if (title instanceof HTMLElement) {
        title.textContent = getPaperTitle(resolvedInfo) || 'Ranking Decision Details';
    }
    const headline = document.createElement('div');
    headline.className = 'gsr-detail-drawer__headline';
    const badge = createRankBadgeElement(resolvedInfo?.rank || 'N/A', resolvedInfo?.system || 'UNKNOWN', resolvedInfo?.reason || null, resolvedInfo || null);
    if (badge) {
        badge.classList.add('gsr-detail-drawer__badge');
        badge.removeAttribute('aria-describedby');
        headline.appendChild(badge);
    }
    const subtitle = document.createElement('div');
    subtitle.className = 'gsr-detail-drawer__subtitle';
    subtitle.textContent = `${resolvedInfo?.system || 'UNKNOWN'} decision · ${getReviewReason(resolvedInfo)}`;
    headline.appendChild(subtitle);
    body.appendChild(headline);
    const facts = [
        ['Publication Year', getPublicationYear(resolvedInfo) ?? 'N/A'],
        ['Author Count', resolvedInfo?.authorCount ?? 'N/A'],
        ['Ranking Snapshot Year', resolvedInfo?.sourceYear ?? 'N/A'],
        ['Decision Status', resolvedInfo?.decisionStatus || 'N/A'],
        ['Matched Venue', resolvedInfo?.matchedVenue || 'N/A'],
        ['DBLP Venue', resolvedInfo?.dblpVenue || 'N/A'],
        ['DBLP Key', resolvedInfo?.dblpKey || 'N/A'],
        ['Confidence', formatConfidencePercent(resolvedInfo?.confidence ?? resolvedInfo?.venueMatchConfidence ?? resolvedInfo?.matchConfidence)],
    ];
    const factGrid = document.createElement('dl');
    factGrid.className = 'gsr-detail-drawer__facts';
    for (const [labelText, valueText] of facts) {
        const term = document.createElement('dt');
        term.textContent = labelText;
        const description = document.createElement('dd');
        description.textContent = String(valueText);
        factGrid.appendChild(term);
        factGrid.appendChild(description);
    }
    body.appendChild(factGrid);
    const evidenceItems = buildEvidenceItems(resolvedInfo);
    const evidenceSection = document.createElement('section');
    evidenceSection.className = 'gsr-detail-drawer__section';
    const evidenceTitle = document.createElement('h4');
    evidenceTitle.textContent = 'Decision Evidence';
    evidenceSection.appendChild(evidenceTitle);
    if (evidenceItems.length) {
        const list = document.createElement('ul');
        list.className = 'gsr-detail-drawer__list';
        evidenceItems.forEach((item) => {
            const entry = document.createElement('li');
            entry.textContent = `${item.label} (${item.raw})`;
            list.appendChild(entry);
        });
        evidenceSection.appendChild(list);
    }
    else {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'No explicit evidence tokens were recorded for this item.';
        evidenceSection.appendChild(empty);
    }
    body.appendChild(evidenceSection);
    const candidates = getTopCandidates(resolvedInfo);
    if (candidates.length) {
        const candidateSection = document.createElement('section');
        candidateSection.className = 'gsr-detail-drawer__section';
        const candidateTitle = document.createElement('h4');
        candidateTitle.textContent = 'Ambiguity Candidates';
        candidateSection.appendChild(candidateTitle);
        const candidateList = document.createElement('div');
        candidateList.className = 'gsr-detail-drawer__candidate-list';
        candidates.forEach((candidate) => {
            const item = document.createElement('div');
            item.className = 'gsr-detail-drawer__candidate';
            const label = document.createElement('strong');
            label.textContent = String(candidate.title || candidate.acronym || candidate.venue || 'Candidate');
            item.appendChild(label);
            const meta = document.createElement('span');
            meta.textContent = [candidate.acronym, candidate.rank, candidate.year].filter(Boolean).join(' · ') || 'No extra metadata';
            item.appendChild(meta);
            candidateList.appendChild(item);
        });
        candidateSection.appendChild(candidateList);
        body.appendChild(candidateSection);
    }
    const actions = document.createElement('div');
    actions.className = 'gsr-dialog-actions';
    const scholarButton = document.createElement('button');
    scholarButton.type = 'button';
    scholarButton.className = 'gsr-button gsr-button--secondary';
    scholarButton.textContent = 'Open Scholar';
    scholarButton.disabled = !resolvedInfo?.url;
    scholarButton.addEventListener('click', () => {
        if (resolvedInfo?.url) {
            window.open(resolvedInfo.url, '_blank', 'noopener,noreferrer');
        }
    });
    actions.appendChild(scholarButton);
    const dblpButton = document.createElement('button');
    dblpButton.type = 'button';
    dblpButton.className = 'gsr-button gsr-button--secondary';
    dblpButton.textContent = 'Open DBLP';
    const dblpUrl = getDblpEntryUrl(resolvedInfo);
    dblpButton.disabled = !dblpUrl;
    dblpButton.addEventListener('click', () => {
        if (dblpUrl) {
            window.open(dblpUrl, '_blank', 'noopener,noreferrer');
        }
    });
    actions.appendChild(dblpButton);
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'gsr-button gsr-button--ghost';
    copyButton.textContent = 'Copy Evidence';
    copyButton.addEventListener('click', async () => {
        await copyTextToClipboard(JSON.stringify(buildReportPayload(resolvedInfo), null, 2));
        copyButton.textContent = 'Copied';
        window.setTimeout(() => {
            copyButton.textContent = 'Copy Evidence';
        }, 1200);
    });
    actions.appendChild(copyButton);
    const reportButton = document.createElement('button');
    reportButton.type = 'button';
    reportButton.className = 'gsr-button gsr-button--primary';
    reportButton.textContent = 'Open Report Packet';
    reportButton.addEventListener('click', () => openReportPacketOverlay(resolvedInfo));
    actions.appendChild(reportButton);
    body.appendChild(actions);
    openDialogOverlay(overlay, panel);
}
function ensureReportPacketOverlay() {
    if (gsrReportPacketOverlayEl && document.body.contains(gsrReportPacketOverlayEl)) {
        return gsrReportPacketOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: REPORT_PACKET_OVERLAY_ID,
        panelClass: 'gsr-report-packet',
        titleId: 'gsr-report-packet-title',
        titleText: 'Structured Report Packet',
        descriptionId: 'gsr-report-packet-description',
        descriptionText: 'Copy a fully structured packet with title, Scholar URL, DBLP identifiers, rank outcome, ranking snapshot year, and decision evidence.',
    });
    gsrReportPacketOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
async function openReportPacketOverlay(info = null) {
    const overlay = ensureReportPacketOverlay();
    const panel = overlay.querySelector('.gsr-report-packet');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const payload = buildReportPayload(info);
    await saveFeatureState('reportDraft', { createdAt: payload.createdAt, payload });
    const packetMarkdown = buildReportPacketMarkdown(info);
    body.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'gsr-report-packet__summary';
    const summaryLines = [
        ['Paper', payload.paper?.title || 'Profile-level report'],
        ['Scholar URL', payload.paper?.scholarUrl || 'N/A'],
        ['DBLP PID', payload.profile.dblpAuthorPid || 'N/A'],
        ['DBLP Key', payload.paper?.dblpKey || 'N/A'],
        ['Rank Outcome', payload.decision?.rank || 'N/A'],
        ['Ranking Snapshot Year', payload.decision?.sourceYear || 'N/A'],
    ];
    summaryLines.forEach(([labelText, valueText]) => {
        const line = document.createElement('div');
        line.className = 'gsr-report-packet__summary-line';
        const label = document.createElement('strong');
        label.textContent = `${labelText}: `;
        line.appendChild(label);
        line.appendChild(document.createTextNode(String(valueText)));
        summary.appendChild(line);
    });
    body.appendChild(summary);
    const textarea = document.createElement('textarea');
    textarea.className = 'gsr-report-packet__textarea';
    textarea.readOnly = true;
    textarea.value = packetMarkdown;
    body.appendChild(textarea);
    const actions = document.createElement('div');
    actions.className = 'gsr-dialog-actions';
    const copyJsonButton = document.createElement('button');
    copyJsonButton.type = 'button';
    copyJsonButton.className = 'gsr-button gsr-button--secondary';
    copyJsonButton.textContent = 'Copy JSON';
    copyJsonButton.addEventListener('click', async () => {
        await copyTextToClipboard(JSON.stringify(payload, null, 2));
        copyJsonButton.textContent = 'Copied';
        window.setTimeout(() => {
            copyJsonButton.textContent = 'Copy JSON';
        }, 1200);
    });
    actions.appendChild(copyJsonButton);
    const copyMarkdownButton = document.createElement('button');
    copyMarkdownButton.type = 'button';
    copyMarkdownButton.className = 'gsr-button gsr-button--secondary';
    copyMarkdownButton.textContent = 'Copy Packet';
    copyMarkdownButton.addEventListener('click', async () => {
        await copyTextToClipboard(packetMarkdown);
        copyMarkdownButton.textContent = 'Copied';
        window.setTimeout(() => {
            copyMarkdownButton.textContent = 'Copy Packet';
        }, 1200);
    });
    actions.appendChild(copyMarkdownButton);
    const openFormButton = document.createElement('button');
    openFormButton.type = 'button';
    openFormButton.className = 'gsr-button gsr-button--primary';
    openFormButton.textContent = 'Open Report Form';
    openFormButton.addEventListener('click', async () => {
        await copyTextToClipboard(packetMarkdown);
        window.open(REPORT_FORM_URL, '_blank', 'noopener,noreferrer');
    });
    actions.appendChild(openFormButton);
    body.appendChild(actions);
    openDialogOverlay(overlay, panel, '.gsr-report-packet__textarea');
}
function ensureExportOverlay() {
    if (gsrExportOverlayEl && document.body.contains(gsrExportOverlayEl)) {
        return gsrExportOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: EXPORT_OVERLAY_ID,
        panelClass: 'gsr-export-panel',
        titleId: 'gsr-export-title',
        titleText: 'Export report',
        descriptionId: 'gsr-export-description',
        descriptionText: 'Choose a reproducible record or a readable derived view.',
    });
    gsrExportOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
function openExportOverlay() {
    const overlay = ensureExportOverlay();
    const panel = overlay.querySelector('.gsr-export-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    body.innerHTML = '';
    const countSnapshot = buildSummaryCountSnapshot(currentSummaryState);
    const totalPapers = countSnapshot.totalPapers || 0;
    const rankedCount = countSnapshot.rankedCount || 0;
    const conferenceCount = countSnapshot.conferenceCount || 0;
    const journalCount = countSnapshot.journalCount || 0;
    const hero = document.createElement('section');
    hero.className = 'gsr-export-panel__hero';
    const heroCopy = document.createElement('div');
    heroCopy.className = 'gsr-export-panel__hero-copy';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'gsr-export-panel__eyebrow';
    eyebrow.textContent = 'Ready to export';
    heroCopy.appendChild(eyebrow);
    const headline = document.createElement('h4');
    headline.className = 'gsr-export-panel__hero-title';
    headline.textContent = `${totalPapers} paper${totalPapers === 1 ? '' : 's'}`;
    heroCopy.appendChild(headline);
    const summary = document.createElement('div');
    summary.className = 'gsr-export-panel__summary';
    summary.textContent = 'Canonical JSON is the reproducibility record. PDF, HTML, Markdown, and CSV are derived views for sharing and review.';
    heroCopy.appendChild(summary);
    hero.appendChild(heroCopy);
    const statRail = document.createElement('div');
    statRail.className = 'gsr-export-panel__stat-rail gsr-export-panel__ranked-summary';
    const rankedCard = document.createElement('div');
    rankedCard.className = 'gsr-export-panel__stat gsr-export-panel__stat--ranked';
    const rankedValue = document.createElement('strong');
    rankedValue.textContent = `${rankedCount}`;
    const rankedLabel = document.createElement('span');
    rankedLabel.textContent = 'Ranked papers';
    rankedCard.appendChild(rankedValue);
    rankedCard.appendChild(rankedLabel);
    statRail.appendChild(rankedCard);
    const splitPanel = document.createElement('div');
    splitPanel.className = 'gsr-export-panel__ranked-breakdown';
    const splitTotal = Math.max(1, rankedCount, conferenceCount + journalCount);
    const bar = document.createElement('div');
    bar.className = 'gsr-export-panel__ranked-bar';
    [
        ['conference', conferenceCount],
        ['journal', journalCount],
    ].forEach(([kind, value]) => {
        const segment = document.createElement('span');
        segment.className = `gsr-export-panel__ranked-bar-segment gsr-export-panel__ranked-bar-segment--${kind}`;
        segment.style.width = `${Math.max(0, Math.min(100, (Number(value) / splitTotal) * 100))}%`;
        segment.title = `${kind === 'conference' ? 'Conference' : 'Journal'}: ${value} of ${rankedCount || splitTotal}`;
        bar.appendChild(segment);
    });
    splitPanel.appendChild(bar);
    [
        ['Conference', conferenceCount, 'conference'],
        ['Journal', journalCount, 'journal'],
    ].forEach(([labelText, value, kind]) => {
        const item = document.createElement('div');
        item.className = `gsr-export-panel__ranked-split-item gsr-export-panel__ranked-split-item--${kind}`;
        const label = document.createElement('span');
        label.textContent = labelText;
        const count = document.createElement('strong');
        count.textContent = `${value} of ${rankedCount || splitTotal}`;
        item.appendChild(label);
        item.appendChild(count);
        splitPanel.appendChild(item);
    });
    statRail.appendChild(splitPanel);
    hero.appendChild(statRail);
    body.appendChild(hero);
    const formats = [
        {
            name: 'JSON',
            badge: 'JSON',
            eyebrow: 'Canonical record',
            description: 'Schema-versioned record with model metadata, evidence, and sensitivity variants.',
            points: ['Best for reproducibility', 'Includes every scored decision'],
            actions: [
                {
                    label: 'Download JSON',
                    preparingText: 'Preparing JSON...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.json`;
                        await triggerDownload(filename, 'application/json;charset=utf-8', buildJsonExport(currentSummaryState));
                    }
                }
            ]
        },
        {
            name: 'PDF',
            badge: 'PDF',
            eyebrow: 'Best for sharing',
            description: 'Shareable snapshot or full audit document.',
            points: ['Summary is compact', 'Full report includes evidence appendix'],
            actions: [
                {
                    label: 'Summary',
                    preparingText: 'Preparing Summary...',
                    successText: 'Summary Ready',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()} - Summary.pdf`;
                        const dataUrl = await buildPdfReportDataUrl(currentSummaryState, 'summary');
                        await triggerDataUrlDownload(filename, dataUrl);
                    }
                },
                {
                    label: 'Full Report',
                    preparingText: 'Preparing Full Report...',
                    successText: 'Full Report Ready',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()} - Full Report.pdf`;
                        const dataUrl = await buildPdfReportDataUrl(currentSummaryState, 'full');
                        await triggerDataUrlDownload(filename, dataUrl);
                    }
                }
            ]
        },
        {
            name: 'HTML',
            badge: 'HTML',
            eyebrow: 'Best for browser review',
            description: 'Standalone browser-readable report.',
            points: ['Keeps the formatted layout', 'Easy to inspect locally'],
            actions: [
                {
                    label: 'Download HTML',
                    preparingText: 'Preparing HTML...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.html`;
                        await triggerDownload(filename, 'text/html;charset=utf-8', await buildHtmlReport(currentSummaryState));
                    }
                }
            ]
        },
        {
            name: 'Markdown',
            badge: 'MD',
            eyebrow: 'Notes',
            description: 'Portable text report for review notes and issue threads.',
            points: ['Plain text', 'Includes model metadata'],
            actions: [
                {
                    label: 'Download Markdown',
                    preparingText: 'Preparing Markdown...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.md`;
                        await triggerDownload(filename, 'text/markdown;charset=utf-8', buildMarkdownExport(currentSummaryState));
                    }
                }
            ]
        },
        {
            name: 'CSV',
            badge: 'CSV',
            eyebrow: 'Best for analysis',
            description: 'Flat audit rows for spreadsheets and statistical checks.',
            points: ['One row per paper', 'Includes factors and reason codes'],
            actions: [
                {
                    label: 'Download CSV',
                    preparingText: 'Preparing CSV...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.csv`;
                        await triggerDownload(filename, 'text/csv;charset=utf-8', buildCsvExport(currentSummaryState));
                    }
                }
            ]
        },
    ];
    const actionGrid = document.createElement('div');
    actionGrid.className = 'gsr-export-panel__grid';
    formats.forEach((format) => {
        const card = document.createElement('article');
        card.className = 'gsr-export-panel__card';
        card.setAttribute('data-gsr-format', format.name.toLowerCase());
        const cardHead = document.createElement('div');
        cardHead.className = 'gsr-export-panel__card-head';
        const titleBlock = document.createElement('div');
        titleBlock.className = 'gsr-export-panel__card-title-block';
        const meta = document.createElement('span');
        meta.className = 'gsr-export-panel__meta';
        meta.textContent = format.eyebrow;
        titleBlock.appendChild(meta);
        const title = document.createElement('h4');
        title.className = 'gsr-export-panel__format';
        title.textContent = format.name;
        titleBlock.appendChild(title);
        cardHead.appendChild(titleBlock);
        const badge = document.createElement('span');
        badge.className = 'gsr-export-panel__badge';
        badge.textContent = format.badge || format.name;
        cardHead.appendChild(badge);
        card.appendChild(cardHead);
        const description = document.createElement('p');
        description.className = 'gsr-export-panel__card-copy';
        description.textContent = format.description;
        card.appendChild(description);
        const points = document.createElement('ul');
        points.className = 'gsr-export-panel__points';
        format.points.forEach((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            points.appendChild(item);
        });
        card.appendChild(points);
        const actionRow = document.createElement('div');
        actionRow.className = `gsr-export-panel__actions${Array.isArray(format.actions) && format.actions.length > 1 ? ' gsr-export-panel__actions--split' : ''}`;
        (Array.isArray(format.actions) ? format.actions : []).forEach((action) => {
            const downloadButton = document.createElement('button');
            downloadButton.type = 'button';
            downloadButton.className = 'gsr-button gsr-button--primary gsr-export-panel__action-button';
            downloadButton.setAttribute('data-gsr-export-action', sanitizeFilenamePart(action.label));
            downloadButton.setAttribute('data-gsr-export-format', format.name.toLowerCase());
            downloadButton.textContent = action.label;
            downloadButton.addEventListener('click', async () => {
                const originalText = downloadButton.textContent;
                downloadButton.disabled = true;
                downloadButton.textContent = action.preparingText || 'Preparing...';
                try {
                    await action.download();
                    downloadButton.textContent = action.successText || 'Downloaded';
                    window.setTimeout(() => {
                        downloadButton.textContent = originalText;
                        downloadButton.disabled = false;
                    }, 1200);
                }
                catch (error) {
                    console.error(`GSR: Failed to download ${format.name} report.`, error);
                    downloadButton.textContent = 'Try Again';
                    downloadButton.disabled = false;
                }
            });
            actionRow.appendChild(downloadButton);
        });
        card.appendChild(actionRow);
        actionGrid.appendChild(card);
    });
    body.appendChild(actionGrid);
    openDialogOverlay(overlay, panel);
}
function ensureCompareOverlay() {
    if (gsrCompareOverlayEl && document.body.contains(gsrCompareOverlayEl)) {
        return gsrCompareOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: COMPARE_OVERLAY_ID,
        panelClass: 'gsr-compare-panel',
        titleId: 'gsr-compare-title',
        titleText: 'Profile Snapshot Compare',
        descriptionId: 'gsr-compare-description',
        descriptionText: 'Compare the current profile or saved snapshots on ranked share, A*/A mix, Q1 mix, review backlog, and venue drift.',
    });
    gsrCompareOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
async function openCompareOverlay() {
    const overlay = ensureCompareOverlay();
    const panel = overlay.querySelector('.gsr-compare-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const snapshots = await loadFeatureState('profileSnapshots');
    const compareState = await loadFeatureState('savedCompareSet');
    body.innerHTML = '';
    const controls = document.createElement('div');
    controls.className = 'gsr-compare-panel__controls';
    const buildOptions = () => {
        const list = [{ id: '__current__', label: 'Current profile' }];
        for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
            list.push({ id: snapshot.id, label: buildSnapshotOptionLabel(snapshot) });
        }
        return list;
    };
    const options = buildOptions();
    const createSelect = (labelText, value) => {
        const wrap = document.createElement('label');
        wrap.className = 'gsr-compare-panel__field';
        const label = document.createElement('span');
        label.textContent = labelText;
        const select = document.createElement('select');
        options.forEach((optionValue) => {
            const option = document.createElement('option');
            option.value = optionValue.id;
            option.textContent = optionValue.label;
            option.selected = optionValue.id === value;
            select.appendChild(option);
        });
        wrap.appendChild(label);
        wrap.appendChild(select);
        controls.appendChild(wrap);
        return select;
    };
    const leftValue = compareState?.leftSnapshotId || '__current__';
    const rightDefault = compareState?.rightSnapshotId || (Array.isArray(snapshots) && snapshots[0] ? snapshots[0].id : '__current__');
    const leftSelect = createSelect('Left Side', leftValue);
    const rightSelect = createSelect('Right Side', rightDefault);
    body.appendChild(controls);
    const actionRow = document.createElement('div');
    actionRow.className = 'gsr-dialog-actions';
    const saveSnapshotButton = document.createElement('button');
    saveSnapshotButton.type = 'button';
    saveSnapshotButton.className = 'gsr-button gsr-button--secondary';
    saveSnapshotButton.textContent = 'Save Current Snapshot';
    saveSnapshotButton.addEventListener('click', async () => {
        const snapshot = await saveCurrentProfileSnapshot();
        if (snapshot) {
            await saveFeatureState('savedCompareSet', {
                ...compareState,
                rightSnapshotId: snapshot.id,
            });
            openCompareOverlay();
        }
    });
    actionRow.appendChild(saveSnapshotButton);
    body.appendChild(actionRow);
    const compareHost = document.createElement('div');
    compareHost.className = 'gsr-compare-panel__results';
    body.appendChild(compareHost);
    const getSummaryForValue = (value) => {
        if (value === '__current__') {
            return currentSummaryState;
        }
        return (Array.isArray(snapshots) ? snapshots : []).find((snapshot) => snapshot.id === value) || null;
    };
    const renderComparison = async () => {
        const nextState = {
            ...(compareState || {}),
            leftSnapshotId: leftSelect.value,
            rightSnapshotId: rightSelect.value,
        };
        await saveFeatureState('savedCompareSet', nextState);
        const leftSummary = getSummaryForValue(leftSelect.value);
        const rightSummary = getSummaryForValue(rightSelect.value);
        compareHost.innerHTML = '';
        if (!leftSummary || !rightSummary) {
            const empty = document.createElement('p');
            empty.className = 'gsr-detail-drawer__empty';
            empty.textContent = 'Save at least one snapshot to compare it against the current profile.';
            compareHost.appendChild(empty);
            return;
        }
        const comparison = buildComparisonSummary(leftSummary, rightSummary);
        const metricGrid = document.createElement('div');
        metricGrid.className = 'gsr-compare-panel__metric-grid';
        comparison.metrics.forEach((metric) => {
            const card = document.createElement('div');
            card.className = 'gsr-compare-panel__metric';
            const label = document.createElement('strong');
            label.textContent = metric.label;
            card.appendChild(label);
            const values = document.createElement('span');
            const leftValue = metric.key === 'rankedShare' ? formatConfidencePercent(metric.leftValue) : String(metric.leftValue);
            const rightValue = metric.key === 'rankedShare' ? formatConfidencePercent(metric.rightValue) : String(metric.rightValue);
            const deltaValue = metric.key === 'rankedShare'
                ? `${metric.delta > 0 ? '+' : (metric.delta < 0 ? '-' : '')}${formatConfidencePercent(Math.abs(metric.delta))}`
                : `${metric.delta > 0 ? '+' : ''}${metric.delta}`;
            values.textContent = `${leftValue} → ${rightValue} (${deltaValue})`;
            card.appendChild(values);
            metricGrid.appendChild(card);
        });
        compareHost.appendChild(metricGrid);
        const venueSection = document.createElement('section');
        venueSection.className = 'gsr-detail-drawer__section';
        const venueTitle = document.createElement('h4');
        venueTitle.textContent = 'Venue Drift';
        venueSection.appendChild(venueTitle);
        if (comparison.venueDelta.length) {
            const list = document.createElement('ul');
            list.className = 'gsr-detail-drawer__list';
            comparison.venueDelta.forEach((entry) => {
                const item = document.createElement('li');
                item.textContent = `${entry.venue}: ${entry.leftCount} → ${entry.rightCount} (${entry.delta > 0 ? '+' : ''}${entry.delta})`;
                list.appendChild(item);
            });
            venueSection.appendChild(list);
        }
        else {
            const none = document.createElement('p');
            none.className = 'gsr-detail-drawer__empty';
            none.textContent = 'No venue drift was detected between these two snapshots.';
            venueSection.appendChild(none);
        }
        compareHost.appendChild(venueSection);
    };
    leftSelect.addEventListener('change', renderComparison);
    rightSelect.addEventListener('change', renderComparison);
    await renderComparison();
    openDialogOverlay(overlay, panel);
}
function ensureReviewInboxOverlay() {
    if (gsrReviewInboxOverlayEl && document.body.contains(gsrReviewInboxOverlayEl)) {
        return gsrReviewInboxOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: REVIEW_INBOX_OVERLAY_ID,
        panelClass: 'gsr-review-inbox',
        titleId: 'gsr-review-inbox-title',
        titleText: 'Review Inbox',
        descriptionId: 'gsr-review-inbox-description',
        descriptionText: 'Inspect every DBLP-missing, ambiguous, short-paper, workshop, demo/poster, or unranked item from this profile.',
    });
    gsrReviewInboxOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
async function openReviewInboxOverlay() {
    const overlay = ensureReviewInboxOverlay();
    const panel = overlay.querySelector('.gsr-review-inbox');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const state = await loadFeatureState('reviewQueueState');
    const items = Array.isArray(currentSummaryState?.reviewItems) ? currentSummaryState.reviewItems.slice() : [];
    const sortedItems = sortReviewItems(items, state?.sortBy || 'needs-review-first');
    const groups = groupReviewItems(sortedItems, state?.groupBy || 'reason');
    body.innerHTML = '';
    const controls = document.createElement('div');
    controls.className = 'gsr-review-inbox__controls';
    const buildSelect = (labelText, values, selectedValue, onChange) => {
        const label = document.createElement('label');
        label.className = 'gsr-review-inbox__field';
        const span = document.createElement('span');
        span.textContent = labelText;
        const select = document.createElement('select');
        values.forEach((value) => {
            const option = document.createElement('option');
            option.value = value.value;
            option.textContent = value.label;
            option.selected = value.value === selectedValue;
            select.appendChild(option);
        });
        select.addEventListener('change', () => onChange(select.value));
        label.appendChild(span);
        label.appendChild(select);
        controls.appendChild(label);
    };
    buildSelect('Sort', [
        { value: 'needs-review-first', label: 'Reason' },
        { value: 'year-desc', label: 'Year' },
        { value: 'title', label: 'Title' },
        { value: 'confidence', label: 'Confidence' },
    ], state?.sortBy || 'needs-review-first', async (value) => {
        await saveFeatureState('reviewQueueState', { ...(state || {}), sortBy: value });
        openReviewInboxOverlay();
    });
    buildSelect('Group', [
        { value: 'reason', label: 'Reason' },
        { value: 'none', label: 'None' },
    ], state?.groupBy || 'reason', async (value) => {
        await saveFeatureState('reviewQueueState', { ...(state || {}), groupBy: value });
        openReviewInboxOverlay();
    });
    body.appendChild(controls);
    const summary = document.createElement('div');
    summary.className = 'gsr-review-inbox__summary';
    summary.textContent = `${items.length} review item${items.length === 1 ? '' : 's'} in the current queue.`;
    body.appendChild(summary);
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'No review items are waiting right now.';
        body.appendChild(empty);
        openDialogOverlay(overlay, panel);
        return;
    }
    groups.forEach((group) => {
        const section = document.createElement('section');
        section.className = 'gsr-review-inbox__group';
        const title = document.createElement('h4');
        title.textContent = `${group.label} (${group.items.length})`;
        section.appendChild(title);
        const list = document.createElement('div');
        list.className = 'gsr-review-inbox__list';
        group.items.forEach((item) => {
            const card = document.createElement('article');
            card.className = 'gsr-review-inbox__item';
            const heading = document.createElement('div');
            heading.className = 'gsr-review-inbox__item-head';
            const titleButton = document.createElement('button');
            titleButton.type = 'button';
            titleButton.className = 'gsr-review-inbox__title';
            titleButton.textContent = getPaperTitle(item) || 'Untitled paper';
            titleButton.addEventListener('click', () => openDetailDrawer(item));
            heading.appendChild(titleButton);
            const meta = document.createElement('span');
            meta.className = 'gsr-review-inbox__meta';
            meta.textContent = [getPublicationYear(item), item.system, getReviewReason(item)].filter(Boolean).join(' · ');
            heading.appendChild(meta);
            card.appendChild(heading);
            const actionRow = document.createElement('div');
            actionRow.className = 'gsr-review-inbox__actions';
            const actions = [
                ['Explain', () => openDetailDrawer(item)],
                ['Scholar', () => item.url && window.open(item.url, '_blank', 'noopener,noreferrer')],
                ['DBLP', () => {
                        const url = getDblpEntryUrl(item);
                        if (url) {
                            window.open(url, '_blank', 'noopener,noreferrer');
                        }
                    }],
                ['Copy Evidence', async () => copyTextToClipboard(JSON.stringify(buildReportPayload(item), null, 2))],
                ['Report', () => openReportPacketOverlay(item)],
            ];
            actions.forEach(([labelText, handler]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'gsr-button gsr-button--ghost';
                button.textContent = labelText;
                if (labelText === 'DBLP' && !getDblpEntryUrl(item)) {
                    button.disabled = true;
                }
                if (labelText === 'Scholar' && !item.url) {
                    button.disabled = true;
                }
                button.addEventListener('click', handler);
                actionRow.appendChild(button);
            });
            card.appendChild(actionRow);
            list.appendChild(card);
        });
        section.appendChild(list);
        body.appendChild(section);
    });
    openDialogOverlay(overlay, panel);
}
function getScholarSurfaceMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view_op') === 'view_citation') {
        return 'citation-detail';
    }
    if (params.has('q') && !params.has('user')) {
        return 'search-results';
    }
    return 'profile';
}
function teardownOffProfileSurfaceUi() {
    if (activeScanSessionId !== 0 && (isMainProcessing || activeForegroundScanSessionId !== 0 || currentSummaryState || activeCachedPublicationRanks)) {
        nextScanSessionId();
    }
    activeForegroundScanSessionId = 0;
    isMainProcessing = false;
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    currentSummaryState = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    disconnectPublicationTableObserver();
    hideBadgePopover(true);
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(SCORE_DETAILS_OVERLAY_ID)?.remove();
    document.getElementById(COMPLETENESS_OVERLAY_ID)?.remove();
    document.getElementById(DETAIL_DRAWER_ID)?.remove();
    document.getElementById(REVIEW_INBOX_OVERLAY_ID)?.remove();
    document.getElementById(REPORT_PACKET_OVERLAY_ID)?.remove();
    document.getElementById(EXPORT_OVERLAY_ID)?.remove();
    document.getElementById(COMPARE_OVERLAY_ID)?.remove();
    document.getElementById(MANUAL_DBLP_OVERLAY_ID)?.remove();
    document.getElementById('gsr-search-utility-overlay')?.remove();
    document.getElementById('gsr-about-overlay')?.remove();
    document.querySelectorAll('.gsr-citation-detail-badge').forEach((el) => el.remove());
    gsrSearchOverlayEl = null;
    gsrAboutOverlayEl = null;
    gsrScoreDetailsOverlayEl = null;
    gsrCompletenessOverlayEl = null;
    gsrDetailDrawerEl = null;
    gsrReviewInboxOverlayEl = null;
    gsrReportPacketOverlayEl = null;
    gsrExportOverlayEl = null;
    gsrCompareOverlayEl = null;
    gsrManualDblpOverlayEl = null;
}
function buildReviewReasonCounts(publicationRanks) {
    const counts = {};
    for (const info of publicationRanks || []) {
        if (isRankedResultInfo(info)) {
            continue;
        }
        const reason = getReviewReason(info);
        counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
}
function renderSummaryInsightsContent(container, summaryState) {
    container.innerHTML = '';
    const insights = summaryState?.insights;
    if (!insights) {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'Insights will appear after ranked results are available.';
        container.appendChild(empty);
        return;
    }
    const metricGrid = document.createElement('div');
    metricGrid.className = 'gsr-summary-insights__metrics';
    [
        ['Ranked Share', formatConfidencePercent(insights.rankedShare || 0)],
        ['Conference Mix', `${insights.conferenceCount || 0}`],
        ['Journal Mix', `${insights.journalCount || 0}`],
        ['Review Queue', `${insights.reviewCount || 0}`],
        ['A*/A', `${(Number(summaryState?.coreRankCounts?.['A*']) || 0) + (Number(summaryState?.coreRankCounts?.A) || 0)}`],
        ['Q1', `${Number(summaryState?.sjrRankCounts?.Q1) || 0}`],
    ].forEach(([labelText, valueText]) => {
        const card = document.createElement('div');
        card.className = 'gsr-summary-insights__metric';
        const label = document.createElement('strong');
        label.textContent = labelText;
        const value = document.createElement('span');
        value.textContent = valueText;
        card.appendChild(label);
        card.appendChild(value);
        metricGrid.appendChild(card);
    });
    container.appendChild(metricGrid);
    const sections = [
        {
            title: 'Top Venues',
            empty: 'No ranked venues yet.',
            entries: (insights.topRankedVenues || []).map((entry) => `${entry.venue} (${entry.count})`),
        },
        {
            title: 'Review Trend',
            empty: 'No review queue right now.',
            entries: (insights.reviewReasons || []).map((entry) => `${entry.reason} (${entry.count})`),
        },
        {
            title: 'Yearly Trend',
            empty: 'No yearly trend yet.',
            entries: (insights.yearlyTrend || []).slice(-6).map((entry) => `${entry.year}: ranked ${entry.ranked}, review ${entry.review}`),
        },
    ];
    sections.forEach((sectionInfo) => {
        const section = document.createElement('section');
        section.className = 'gsr-detail-drawer__section';
        const title = document.createElement('h4');
        title.textContent = sectionInfo.title;
        section.appendChild(title);
        if (sectionInfo.entries.length) {
            const list = document.createElement('ul');
            list.className = 'gsr-detail-drawer__list';
            sectionInfo.entries.forEach((text) => {
                const item = document.createElement('li');
                item.textContent = text;
                list.appendChild(item);
            });
            section.appendChild(list);
        }
        else {
            const empty = document.createElement('p');
            empty.className = 'gsr-detail-drawer__empty';
            empty.textContent = sectionInfo.empty;
            section.appendChild(empty);
        }
        container.appendChild(section);
    });
}
function renderSummaryFreshnessContent(container, freshnessState) {
    container.innerHTML = '';
    if (!freshnessState) {
        const loading = document.createElement('p');
        loading.className = 'gsr-detail-drawer__empty';
        loading.textContent = 'Loading freshness metadata...';
        container.appendChild(loading);
        return;
    }
    const facts = document.createElement('dl');
    facts.className = 'gsr-detail-drawer__facts';
    [
        ['Extension Version', freshnessState.extensionVersion || 'unknown'],
        ['CORE Coverage', freshnessState.coreCoverageStart && freshnessState.coreCoverageEnd
                ? `${freshnessState.coreCoverageStart}-${freshnessState.coreCoverageEnd}`
                : 'Unknown'],
        ['SJR Coverage', freshnessState.sjrCoverageStart && freshnessState.sjrCoverageEnd
                ? `${freshnessState.sjrCoverageStart}-${freshnessState.sjrCoverageEnd}`
                : 'Unknown'],
        ['Last Profile Run', formatTimestamp(freshnessState.lastProfileRunAt || freshnessState.generatedAt)],
        ['Cache Updated', formatTimestamp(freshnessState.cacheTimestamp)],
        ['Active Ranking Packs', (freshnessState.activePacks || []).map((value) => value.toUpperCase()).join(', ') || 'CORE, SJR'],
    ].forEach(([labelText, valueText]) => {
        const term = document.createElement('dt');
        term.textContent = labelText;
        const description = document.createElement('dd');
        description.textContent = String(valueText);
        facts.appendChild(term);
        facts.appendChild(description);
    });
    container.appendChild(facts);
    const explainer = document.createElement('section');
    explainer.className = 'gsr-detail-drawer__section';
    const title = document.createElement('h4');
    title.textContent = 'How to Read Missing Ranks';
    explainer.appendChild(title);
    const list = document.createElement('ul');
    list.className = 'gsr-detail-drawer__list';
    [
        'A missing rank can mean the venue is absent from the bundled dataset.',
        'It can also mean the venue exists but the extension abstained because the evidence was ambiguous or filtered.',
        'Cached results can lag behind a newly updated extension until the profile is rescanned.',
    ].forEach((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        list.appendChild(item);
    });
    explainer.appendChild(list);
    container.appendChild(explainer);
    const changelog = document.createElement('section');
    changelog.className = 'gsr-detail-drawer__section';
    const changelogTitle = document.createElement('h4');
    changelogTitle.textContent = 'What Changed';
    changelog.appendChild(changelogTitle);
    const changelogList = document.createElement('ul');
    changelogList.className = 'gsr-detail-drawer__list';
    (freshnessState.changelogNotes || CHANGELOG_NOTES).forEach((note) => {
        const item = document.createElement('li');
        item.textContent = note;
        changelogList.appendChild(item);
    });
    changelog.appendChild(changelogList);
    container.appendChild(changelog);
}
function ensureScoreDetailsOverlay() {
    if (gsrScoreDetailsOverlayEl && document.body.contains(gsrScoreDetailsOverlayEl)) {
        return gsrScoreDetailsOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: SCORE_DETAILS_OVERLAY_ID,
        panelClass: 'gsr-score-details-panel',
        titleId: 'gsr-score-details-title',
        titleText: 'Fractional Venue Score Model',
        descriptionId: 'gsr-score-details-description',
        descriptionText: 'Formula, venue values, eligibility rules, and publication-level evidence.'
    });
    gsrScoreDetailsOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
function openScoreDetailsOverlay() {
    const overlay = ensureScoreDetailsOverlay();
    const panel = overlay.querySelector('.gsr-score-details-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const facultyScore = currentSummaryState?.venueProfileIndex || currentSummaryState?.facultyScore || buildFacultyScoreState(currentSummaryState?.publicationRanks || []);
    const conferenceCredit = Number(facultyScore.coreContribution || 0);
    const journalCredit = Number(facultyScore.sjrContribution || 0);
    const diagnostics = facultyScore.diagnostics || facultyScore.coverage || {};
    const activeScoreConfig = DEFAULT_SCORE_CONFIG || {};
    const formatModelNumber = (value, digits = 3) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return '0';
        }
        return numeric.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
    };
    const formatNullableFactor = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? formatModelNumber(numeric, 3) : 'N/A';
    };
    const getScaleValue = (source, rank) => {
        const values = activeScoreConfig.venueValues || {};
        return Number(values?.[source]?.[rank] ?? VENUE_PROFILE_INDEX_WEIGHTS[rank] ?? 0);
    };
    const createMetricCard = (labelText, valueText, extraClass = '') => {
        const card = document.createElement('div');
        card.className = `gsr-score-details__metric${extraClass ? ` ${extraClass}` : ''}`;
        const label = document.createElement('span');
        label.className = 'gsr-score-details__metric-label';
        label.textContent = labelText;
        const value = document.createElement('strong');
        value.className = 'gsr-score-details__metric-value';
        value.textContent = valueText;
        card.appendChild(label);
        card.appendChild(value);
        return card;
    };
    const createStaticRankBadge = (rank, system) => {
        const badge = createRankBadgeElement(rank, system, null, null);
        if (badge) {
            badge.removeAttribute('tabindex');
            badge.removeAttribute('aria-describedby');
            badge.removeAttribute('title');
            badge.classList.add('gsr-score-details__weight-badge');
            return badge;
        }
        const fallback = document.createElement('span');
        fallback.className = 'gsr-rank-badge gsr-rank-badge--pill gsr-rank-badge--neutral gsr-score-details__weight-badge';
        fallback.textContent = rank;
        return fallback;
    };
    const appendMathSymbol = (parent, text, className = '') => {
        const element = document.createElement('span');
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    };
    body.innerHTML = '';
    const hero = document.createElement('section');
    hero.className = 'gsr-score-details__hero';
    const heroPrimary = document.createElement('div');
    heroPrimary.className = 'gsr-score-details__hero-primary';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'gsr-score-details__eyebrow';
    eyebrow.textContent = 'Current GSVR Score';
    heroPrimary.appendChild(eyebrow);
    const scoreValue = document.createElement('div');
    scoreValue.className = 'gsr-score-details__hero-score';
    scoreValue.textContent = Number(facultyScore.gsvrScore || 0).toFixed(4);
    heroPrimary.appendChild(scoreValue);
    const heroNote = document.createElement('p');
    heroNote.className = 'gsr-score-details__hero-note';
    heroNote.textContent = 'Fractional venue-ranked contribution from eligible DBLP-verified publications.';
    heroPrimary.appendChild(heroNote);
    hero.appendChild(heroPrimary);
    const heroStats = document.createElement('div');
    heroStats.className = 'gsr-score-details__hero-stats';
    heroStats.appendChild(createMetricCard('Eligible Ranked Publications', String(facultyScore.eligibleRankedPublications || 0), 'gsr-score-details__metric--compact'));
    heroStats.appendChild(createMetricCard('Fractional Publication Weight', Number(facultyScore.fractionalPublicationWeight || 0).toFixed(4), 'gsr-score-details__metric--compact'));
    heroStats.appendChild(createMetricCard('CORE Contribution', conferenceCredit.toFixed(4), 'gsr-score-details__metric--compact'));
    heroStats.appendChild(createMetricCard('SJR Contribution', journalCredit.toFixed(4), 'gsr-score-details__metric--compact'));
    hero.appendChild(heroStats);
    body.appendChild(hero);
    const methodSection = document.createElement('section');
    methodSection.className = 'gsr-score-details__section';
    const methodHead = document.createElement('div');
    methodHead.className = 'gsr-score-details__section-head';
    const methodTitle = document.createElement('h4');
    methodTitle.textContent = 'Score Model';
    methodHead.appendChild(methodTitle);
    const methodSubtitle = document.createElement('p');
    methodSubtitle.className = 'gsr-score-details__section-subtitle';
    methodSubtitle.textContent = 'Raw fractional venue score over eligible DBLP-verified ranked publications.';
    methodHead.appendChild(methodSubtitle);
    methodSection.appendChild(methodHead);
    const formulaBoard = document.createElement('div');
    formulaBoard.className = 'gsr-score-details__formula-board';
    const equationPanel = document.createElement('div');
    equationPanel.className = 'gsr-score-details__math-panel';
    const equationLabel = document.createElement('span');
    equationLabel.className = 'gsr-score-details__equation-label';
    equationLabel.textContent = 'Primary score formula';
    equationPanel.appendChild(equationLabel);
    const equationFlow = document.createElement('div');
    equationFlow.className = 'gsr-score-details__math';
    equationFlow.setAttribute('aria-label', 'GSVR equals the sum over eligible publications of venue value divided by author count.');
    appendMathSymbol(equationFlow, 'GSVR', 'gsr-score-details__math-name');
    appendMathSymbol(equationFlow, '=', 'gsr-score-details__math-op');
    const summation = document.createElement('span');
    summation.className = 'gsr-score-details__math-sum';
    const sigma = document.createElement('span');
    sigma.className = 'gsr-score-details__math-sigma';
    sigma.textContent = '\u03A3';
    const subscript = document.createElement('sub');
    subscript.textContent = 'i \u2208 E';
    summation.appendChild(sigma);
    summation.appendChild(subscript);
    equationFlow.appendChild(summation);
    const fraction = document.createElement('span');
    fraction.className = 'gsr-score-details__math-fraction';
    const numerator = document.createElement('span');
    numerator.className = 'gsr-score-details__math-numerator';
    numerator.appendChild(document.createTextNode('v'));
    const numeratorSub = document.createElement('sub');
    numeratorSub.textContent = 'i';
    numerator.appendChild(numeratorSub);
    const denominator = document.createElement('span');
    denominator.className = 'gsr-score-details__math-denominator';
    denominator.appendChild(document.createTextNode('a'));
    const denominatorSub = document.createElement('sub');
    denominatorSub.textContent = 'i';
    denominator.appendChild(denominatorSub);
    fraction.appendChild(numerator);
    fraction.appendChild(denominator);
    equationFlow.appendChild(fraction);
    equationPanel.appendChild(equationFlow);
    const equationCaption = document.createElement('p');
    equationCaption.className = 'gsr-score-details__math-caption';
    equationCaption.textContent = 'Each paper contributes its CORE/SJR venue value divided by the DBLP author count. The score is raw and unbounded.';
    equationPanel.appendChild(equationCaption);
    formulaBoard.appendChild(equationPanel);
    const modelNotes = document.createElement('div');
    modelNotes.className = 'gsr-score-details__model-notes';
    [
        ['Eligibility set E', 'DBLP verified, full publication type, ranked by CORE/SJR, and valid author count.'],
        ['Paper contribution', 'venueValue / authorCount. No match-confidence, temporal, coverage, or reliability multipliers are applied.'],
    ].forEach(([labelText, valueText]) => {
        const item = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = labelText;
        const text = document.createElement('p');
        text.textContent = valueText;
        item.appendChild(label);
        item.appendChild(text);
        modelNotes.appendChild(item);
    });
    formulaBoard.appendChild(modelNotes);
    methodSection.appendChild(formulaBoard);
    const methodGrid = document.createElement('div');
    methodGrid.className = 'gsr-score-details__factor-grid';
    [
        ['V_i', 'Venue value', 'CORE and SJR use separate rank-value scales.'],
        ['a_i', 'DBLP author count', 'Fractional credit is 1 divided by the number of authors on the DBLP record.'],
        ['E', 'Eligibility', 'Only eligible DBLP-verified ranked full papers with valid author counts are scored.'],
        ['S_i', 'Contribution', 'Each scored publication contributes venueValue / authorCount.'],
    ].forEach(([symbolText, labelText, valueText]) => {
        const item = document.createElement('div');
        item.className = 'gsr-score-details__factor-card';
        const symbol = document.createElement('span');
        symbol.className = 'gsr-score-details__factor-symbol';
        symbol.textContent = symbolText;
        const copy = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = labelText;
        const text = document.createElement('p');
        text.textContent = valueText;
        copy.appendChild(label);
        copy.appendChild(text);
        item.appendChild(symbol);
        item.appendChild(copy);
        methodGrid.appendChild(item);
    });
    methodSection.appendChild(methodGrid);
    body.appendChild(methodSection);
    const weightSection = document.createElement('section');
    weightSection.className = 'gsr-score-details__section';
    const weightHead = document.createElement('div');
    weightHead.className = 'gsr-score-details__section-head';
    const weightTitle = document.createElement('h4');
    weightTitle.textContent = 'Venue Values';
    weightHead.appendChild(weightTitle);
    const weightSubtitle = document.createElement('p');
    weightSubtitle.className = 'gsr-score-details__section-subtitle';
    weightSubtitle.textContent = 'Default values used by the raw fractional venue score.';
    weightHead.appendChild(weightSubtitle);
    weightSection.appendChild(weightHead);
    const weightRows = document.createElement('div');
    weightRows.className = 'gsr-score-details__weight-rows';
    [
        [
            ['A*', 'CORE'],
            ['A', 'CORE'],
            ['B', 'CORE'],
            ['C', 'CORE'],
        ],
        [
            ['Q1', 'SJR'],
            ['Q2', 'SJR'],
            ['Q3', 'SJR'],
            ['Q4', 'SJR'],
        ],
    ].forEach((rowItems) => {
        const weightGrid = document.createElement('div');
        weightGrid.className = 'gsr-score-details__weight-grid';
        rowItems.forEach(([rank, system]) => {
            const scaleValue = getScaleValue(system, rank);
            const card = document.createElement('div');
            card.className = 'gsr-score-details__weight-card';
            card.appendChild(createStaticRankBadge(rank, system));
            const value = document.createElement('strong');
            value.className = 'gsr-score-details__weight-value';
            value.textContent = formatModelNumber(scaleValue, 3);
            const note = document.createElement('span');
            note.className = 'gsr-score-details__weight-note';
            note.textContent = system;
            card.appendChild(value);
            card.appendChild(note);
            weightGrid.appendChild(card);
        });
        weightRows.appendChild(weightGrid);
    });
    weightSection.appendChild(weightRows);
    body.appendChild(weightSection);
    const breakdownSection = document.createElement('section');
    breakdownSection.className = 'gsr-score-details__section';
    const breakdownHead = document.createElement('div');
    breakdownHead.className = 'gsr-score-details__section-head';
    const breakdownTitle = document.createElement('h4');
    breakdownTitle.textContent = 'Contribution Breakdown';
    breakdownHead.appendChild(breakdownTitle);
    const breakdownSubtitle = document.createElement('p');
    breakdownSubtitle.className = 'gsr-score-details__section-subtitle';
    breakdownSubtitle.textContent = 'Where the current score is coming from.';
    breakdownHead.appendChild(breakdownSubtitle);
    breakdownSection.appendChild(breakdownHead);
    const breakdownGrid = document.createElement('div');
    breakdownGrid.className = 'gsr-score-details__metric-grid';
    [
        ['GSVR Score', Number(facultyScore.gsvrScore || 0).toFixed(4), 'gsr-score-details__metric--primary'],
        ['Eligible Ranked Publications', String(facultyScore.eligibleRankedPublications || 0), ''],
        ['Fractional Publication Weight', Number(facultyScore.fractionalPublicationWeight || 0).toFixed(4), ''],
        ['Average Venue Value', Number(facultyScore.averageVenueValue || 0).toFixed(4), ''],
        ['CORE Contribution', conferenceCredit.toFixed(4), ''],
        ['SJR Contribution', journalCredit.toFixed(4), ''],
        ['Excluded Short Papers', String(diagnostics.excludedShortPapers || 0), ''],
        ['Excluded Workshops', String(diagnostics.excludedWorkshops || 0), ''],
        ['Excluded Demos/Posters', String(diagnostics.excludedDemosPosters || 0), ''],
        ['Excluded Extended Abstracts', String(diagnostics.excludedExtendedAbstracts || 0), ''],
        ['Excluded Preprints', String(diagnostics.excludedPreprints || 0), ''],
        ['DBLP Missing', String(diagnostics.dblpMissing || 0), ''],
        ['Ambiguous Matches', String(diagnostics.ambiguousMatches || 0), ''],
        ['Unranked Venues', String(diagnostics.unrankedVenues || 0), ''],
        ['Missing Author Count', String(diagnostics.missingAuthorCount || 0), ''],
    ].forEach(([labelText, valueText, className]) => {
        breakdownGrid.appendChild(createMetricCard(labelText, valueText, className));
    });
    breakdownSection.appendChild(breakdownGrid);
    body.appendChild(breakdownSection);
    const countedSection = document.createElement('section');
    countedSection.className = 'gsr-score-details__section';
    const countedHead = document.createElement('div');
    countedHead.className = 'gsr-score-details__section-head';
    const countedTitle = document.createElement('h4');
    countedTitle.textContent = 'Counted Publications';
    countedHead.appendChild(countedTitle);
    const countedSubtitle = document.createElement('p');
    countedSubtitle.className = 'gsr-score-details__section-subtitle';
    countedSubtitle.textContent = `${facultyScore.countedPublications.length} ranked paper${facultyScore.countedPublications.length === 1 ? '' : 's'} contributing to the score.`;
    countedHead.appendChild(countedSubtitle);
    countedSection.appendChild(countedHead);
    if (facultyScore.countedPublications.length) {
        const countedList = document.createElement('ul');
        countedList.className = 'gsr-score-details__pub-list';
        facultyScore.countedPublications.forEach((entry) => {
            const item = document.createElement('li');
            item.className = 'gsr-score-details__pub-item';
            const head = document.createElement('div');
            head.className = 'gsr-score-details__pub-head';
            const titleWrap = document.createElement('div');
            titleWrap.className = 'gsr-score-details__pub-title-wrap';
            const title = document.createElement('h5');
            title.className = 'gsr-score-details__pub-title';
            title.textContent = entry.title;
            titleWrap.appendChild(title);
            const subtitle = document.createElement('p');
            subtitle.className = 'gsr-score-details__pub-subtitle';
            subtitle.textContent = `${entry.venue || 'Matched venue unavailable'}${entry.year ? ` • ${entry.year}` : ''}`;
            titleWrap.appendChild(subtitle);
            head.appendChild(titleWrap);
            head.appendChild(createStaticRankBadge(entry.rank, entry.system));
            item.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'gsr-score-details__pub-meta';
            [
                `venue value ${formatNullableFactor(entry.weight)}`,
                `fractional credit ${formatNullableFactor(entry.fractionalCredit)}`,
                entry.publicationType ? `type ${entry.publicationType}` : null,
                `contribution ${formatNullableFactor(entry.credit)}`,
                `${entry.authorCount} author${entry.authorCount === 1 ? '' : 's'}`,
                entry.rankingSnapshotYear ? `snapshot ${entry.rankingSnapshotYear}` : null,
                entry.system,
            ].filter(Boolean).forEach((text) => {
                const pill = document.createElement('span');
                pill.className = 'gsr-score-details__pill';
                pill.textContent = text;
                meta.appendChild(pill);
            });
            item.appendChild(meta);
            if (Array.isArray(entry.decisionEvidence) && entry.decisionEvidence.length) {
                const evidence = document.createElement('p');
                evidence.className = 'gsr-score-details__pub-evidence';
                evidence.textContent = `Evidence: ${entry.decisionEvidence.join(', ')}`;
                item.appendChild(evidence);
            }
            countedList.appendChild(item);
        });
        countedSection.appendChild(countedList);
    }
    else {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'No ranked conference or journal venues contributed to the score on this profile.';
        countedSection.appendChild(empty);
    }
    body.appendChild(countedSection);
    openDialogOverlay(overlay, panel);
}
function ensureCompletenessBreakdownOverlay() {
    if (gsrCompletenessOverlayEl && document.body.contains(gsrCompletenessOverlayEl)) {
        return gsrCompletenessOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: COMPLETENESS_OVERLAY_ID,
        panelClass: 'gsr-completeness-panel',
        titleId: 'gsr-completeness-title',
        titleText: 'Scoring Completeness',
        descriptionId: 'gsr-completeness-description',
        descriptionText: 'How much of this Scholar profile could be used in the GSVR Score.'
    });
    scaffold.overlay.classList.add('gsr-dialog-overlay--drawer');
    gsrCompletenessOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
function openCompletenessBreakdownOverlay() {
    const overlay = ensureCompletenessBreakdownOverlay();
    const panel = overlay.querySelector('.gsr-completeness-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const facultyScore = currentSummaryState?.venueProfileIndex || currentSummaryState?.facultyScore || buildFacultyScoreState(currentSummaryState?.publicationRanks || []);
    const completeness = normalizeScoringCompleteness(facultyScore.completeness, facultyScore.diagnostics || facultyScore.coverage, facultyScore.combinedIndex || facultyScore.rawProfileScore?.scores, currentSummaryState?.publicationRanks || []);
    body.innerHTML = '';
    const total = Math.max(0, Number(completeness.total) || 0);
    const scored = Math.max(0, Number(completeness.scored) || 0);
    const notScored = Math.max(0, total - scored);
    const details = [
        ['scored', 'Scored', completeness.scored, 'DBLP-verified, eligible, ranked, with author counts.'],
        ['dblpMissing', 'DBLP missing', completeness.dblpMissing, 'Scholar items not found in the matched DBLP profile.'],
        ['ambiguous', 'Ambiguous', completeness.ambiguous, 'Multiple plausible DBLP matches; not scored.'],
        ['rankNotFound', 'Venue unranked', completeness.rankNotFound, 'Verified items whose venue has no CORE/SJR rank.'],
        ['excludedType', 'Excluded type', completeness.excludedType, 'Policy exclusions such as workshops, demos, posters, preprints, or short papers.'],
        ['missingAuthorCount', 'Missing author count', completeness.missingAuthorCount, 'Verified/ranked items without usable DBLP author-count metadata.'],
        ['lookupUnavailable', 'Lookup unavailable', completeness.lookupUnavailable, 'Items skipped because DBLP lookup was unavailable or rate-limited.'],
    ];
    const hero = document.createElement('section');
    hero.className = 'gsr-completeness-panel__dashboard';
    const heroTop = document.createElement('div');
    heroTop.className = 'gsr-completeness-panel__topline';
    const primary = document.createElement('div');
    primary.className = 'gsr-completeness-panel__primary';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'gsr-completeness-panel__eyebrow';
    eyebrow.textContent = 'Scoring Completeness';
    const percent = document.createElement('strong');
    percent.className = 'gsr-completeness-panel__percent';
    percent.textContent = formatCompletenessPercent(completeness);
    const summary = document.createElement('p');
    summary.className = 'gsr-completeness-panel__summary';
    summary.textContent = `${scored} of ${total} Scholar publications were usable for GSVR scoring.`;
    primary.appendChild(eyebrow);
    primary.appendChild(percent);
    primary.appendChild(summary);
    heroTop.appendChild(primary);
    const totals = document.createElement('div');
    totals.className = 'gsr-completeness-panel__totals';
    [
        ['Scored', scored],
        ['Not scored', notScored],
        ['Total', total],
    ].forEach(([labelText, valueText]) => {
        const item = document.createElement('div');
        const value = document.createElement('strong');
        value.textContent = String(valueText);
        const label = document.createElement('span');
        label.textContent = labelText;
        item.appendChild(value);
        item.appendChild(label);
        totals.appendChild(item);
    });
    heroTop.appendChild(totals);
    hero.appendChild(heroTop);
    hero.appendChild(createScoringCompletenessBar(completeness, 'gsr-completeness-bar--large'));
    const legend = document.createElement('div');
    legend.className = 'gsr-completeness-panel__legend';
    details.filter(([key, , count]) => key === 'scored' || Number(count) > 0).forEach(([key, labelText, count]) => {
        const chip = document.createElement('span');
        chip.className = 'gsr-completeness-panel__legend-chip';
        const swatch = document.createElement('i');
        swatch.className = `gsr-completeness-panel__swatch gsr-completeness-panel__swatch--${key}`;
        swatch.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = `${labelText} ${count}`;
        chip.appendChild(swatch);
        chip.appendChild(text);
        legend.appendChild(chip);
    });
    hero.appendChild(legend);
    const note = document.createElement('p');
    note.className = 'gsr-completeness-panel__copy';
    note.textContent = 'This diagnostic is separate from the GSVR Score. Low completeness means the visible Scholar profile is only partially represented in the score.';
    hero.appendChild(note);
    body.appendChild(hero);

    const reasons = document.createElement('section');
    reasons.className = 'gsr-completeness-panel__section';
    const reasonsHead = document.createElement('div');
    reasonsHead.className = 'gsr-completeness-panel__section-head';
    const reasonsTitle = document.createElement('h4');
    reasonsTitle.textContent = 'Publication Status';
    const reasonsMeta = document.createElement('span');
    reasonsMeta.textContent = `${notScored} not scored`;
    reasonsHead.appendChild(reasonsTitle);
    reasonsHead.appendChild(reasonsMeta);
    reasons.appendChild(reasonsHead);
    const rows = document.createElement('div');
    rows.className = 'gsr-completeness-panel__rows';
    details.forEach(([key, labelText, count, copy]) => {
        const numericCount = Math.max(0, Number(count) || 0);
        const row = document.createElement('div');
        row.className = `gsr-completeness-panel__row${numericCount === 0 ? ' gsr-completeness-panel__row--empty' : ''}`;
        const marker = document.createElement('span');
        marker.className = `gsr-completeness-panel__marker gsr-completeness-panel__marker--${key}`;
        marker.setAttribute('aria-hidden', 'true');
        const copyWrap = document.createElement('div');
        copyWrap.className = 'gsr-completeness-panel__row-copy';
        const label = document.createElement('strong');
        label.textContent = labelText;
        const text = document.createElement('span');
        text.textContent = copy;
        copyWrap.appendChild(label);
        copyWrap.appendChild(text);
        const metric = document.createElement('div');
        metric.className = 'gsr-completeness-panel__row-metric';
        const value = document.createElement('strong');
        value.textContent = String(numericCount);
        const share = document.createElement('span');
        share.textContent = total > 0 ? `${Math.round((numericCount / total) * 100)}%` : '0%';
        metric.appendChild(value);
        metric.appendChild(share);
        row.appendChild(marker);
        row.appendChild(copyWrap);
        row.appendChild(metric);
        rows.appendChild(row);
    });
    reasons.appendChild(rows);
    body.appendChild(reasons);

    const formula = document.createElement('section');
    formula.className = 'gsr-completeness-panel__formula-strip';
    const formulaText = document.createElement('code');
    formulaText.textContent = 'Completeness = N_scored / N_total';
    const identity = document.createElement('p');
    identity.textContent = 'N_total = scored + DBLP missing + ambiguous + rank not found + excluded type + missing author count + lookup unavailable.';
    formula.appendChild(formulaText);
    formula.appendChild(identity);
    body.appendChild(formula);
    openDialogOverlay(overlay, panel);
}
function displayFacultyScorePanel(summaryState) {
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    if (!summaryState) {
        return;
    }
    const facultyScore = summaryState.venueProfileIndex || summaryState.facultyScore || buildFacultyScoreState(summaryState.publicationRanks || []);
    const panel = document.createElement('div');
    panel.id = FACULTY_SCORE_PANEL_ID;
    panel.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-faculty-score-card';
    const header = document.createElement('div');
    header.className = 'gsr-card__header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'gsr-card__title-group';
    const title = document.createElement('div');
    title.className = 'gsr-card__title';
    title.textContent = 'GSVR Score';
    titleGroup.appendChild(title);
    header.appendChild(titleGroup);
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.className = 'gsr-button gsr-button--secondary gsr-button--compact gsr-faculty-score-card__evidence';
    detailsButton.textContent = 'Evidence';
    detailsButton.title = 'View publication-level scoring evidence';
    detailsButton.addEventListener('click', () => openScoreDetailsOverlay());
    header.appendChild(detailsButton);
    panel.appendChild(header);
    const hero = document.createElement('div');
    hero.className = 'gsr-faculty-score-card__hero';
    const scoreValue = document.createElement('span');
    scoreValue.className = 'gsr-faculty-score-card__value';
    scoreValue.textContent = Number(facultyScore.gsvrScore || 0).toFixed(4);
    hero.appendChild(scoreValue);
    panel.appendChild(hero);
    const completeness = normalizeScoringCompleteness(facultyScore.completeness, facultyScore.diagnostics || facultyScore.coverage, facultyScore.combinedIndex || facultyScore.rawProfileScore?.scores, summaryState.publicationRanks || []);
    const completenessCard = document.createElement('div');
    completenessCard.setAttribute('role', 'button');
    completenessCard.tabIndex = 0;
    completenessCard.className = 'gsr-completeness-card';
    completenessCard.title = 'Scoring Completeness shows how much of this Scholar profile could be used in the GSVR Score. Publications may be unscored because they are missing from DBLP, ambiguous, unranked, excluded publication types, or missing author-count metadata.';
    completenessCard.setAttribute('aria-label', `Scoring Completeness ${formatCompletenessPercent(completeness)}. Open breakdown.`);
    const completenessHead = document.createElement('div');
    completenessHead.className = 'gsr-completeness-card__head';
    const completenessLabel = document.createElement('span');
    completenessLabel.className = 'gsr-completeness-card__label';
    completenessLabel.textContent = 'Scoring Completeness';
    const infoIcon = document.createElement('span');
    infoIcon.className = 'gsr-completeness-card__info';
    infoIcon.textContent = 'i';
    infoIcon.setAttribute('aria-hidden', 'true');
    completenessLabel.appendChild(infoIcon);
    const completenessPercent = document.createElement('strong');
    completenessPercent.className = 'gsr-completeness-card__percent';
    completenessPercent.textContent = formatCompletenessPercent(completeness);
    completenessHead.appendChild(completenessLabel);
    completenessHead.appendChild(completenessPercent);
    completenessCard.appendChild(completenessHead);
    completenessCard.appendChild(createScoringCompletenessBar(completeness));
    const completenessSummary = document.createElement('div');
    completenessSummary.className = 'gsr-completeness-card__summary';
    completenessSummary.textContent = `${completeness.scored}/${completeness.total} scored · ${formatCompletenessPercent(completeness)} completeness`;
    completenessCard.appendChild(completenessSummary);
    completenessCard.addEventListener('click', () => openCompletenessBreakdownOverlay());
    completenessCard.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCompletenessBreakdownOverlay();
        }
    });
    panel.appendChild(completenessCard);
    const summaryPanel = document.getElementById(SUMMARY_PANEL_ID);
    const gsBdy = document.getElementById('gs_bdy');
    const rightSidebarContainer = gsBdy?.querySelector('div.gsc_rsb');
    if (rightSidebarContainer) {
        if (summaryPanel) {
            rightSidebarContainer.insertBefore(panel, summaryPanel);
        }
        else {
            rightSidebarContainer.prepend(panel);
        }
    }
    else if (summaryPanel?.parentNode) {
        summaryPanel.parentNode.insertBefore(panel, summaryPanel);
    }
    else {
        document.body.prepend(panel);
    }
}
// --- END: Manual Rank/Quartile Search Utility (Phase 2) ---
function createStatusElement(initialMessage = "Initializing...") {
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    const container = document.createElement('div');
    container.id = STATUS_ELEMENT_ID;
    container.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-status-card';
    const titleRow = document.createElement('div');
    titleRow.className = 'gsr-status-card__title-row';
    const spinner = document.createElement('span');
    spinner.className = 'gsr-spinner gsr-spinner--status';
    spinner.setAttribute('aria-hidden', 'true');
    titleRow.appendChild(spinner);
    const title = document.createElement('div');
    title.className = 'gsr-card__title gsr-status-card__title-text';
    title.textContent = "Rank Processing";
    titleRow.appendChild(title);
    container.appendChild(titleRow);
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
function setStatusCardTitle(statusElement, titleText) {
    const title = statusElement?.querySelector('.gsr-status-card__title-text');
    if (title) {
        title.textContent = titleText;
    }
}
function setStatusCardSpinnerVisible(statusElement, visible) {
    const spinner = statusElement?.querySelector('.gsr-status-card__title-row .gsr-spinner');
    if (spinner instanceof HTMLElement) {
        spinner.style.display = visible ? '' : 'none';
    }
}
function updateStatusElement(statusContainer, processed, total, messagePrefix) {
    if (!statusContainer) {
        return;
    }
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
function displaySummaryPanel(coreRankCounts, sjrRankCounts, currentUserId, initialCachedPubRanks, cacheTimestamp, dblpAuthorPid, scanLifecycle = null, profileContextOverrides = null) {
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    disconnectPublicationTableObserver();
    hideBadgePopover(true);
    currentProfileContext = {
        userId: currentUserId || null,
        authorName: profileContextOverrides?.authorName || getScholarAuthorName(),
        dblpAuthorPid: dblpAuthorPid || null,
        dblpPidSource: profileContextOverrides?.dblpPidSource || null,
        surfaceMode: getScholarSurfaceMode(),
        scholarProfileUrl: window.location?.href || null,
    };
    currentSummaryState = buildSummaryState(coreRankCounts, sjrRankCounts, initialCachedPubRanks || [], cacheTimestamp, scanLifecycle);
    const countSnapshot = buildSummaryCountSnapshot(currentSummaryState);
    const totalConferencePapers = countSnapshot.conferenceCount;
    const totalJournalPapers = countSnapshot.journalCount;
    const totalReviewPapers = countSnapshot.reviewCount;
    const totalRankedPapers = countSnapshot.rankedCount;
    const totalProcessedPapers = countSnapshot.totalPapers;
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
    summaryTitle.textContent = 'Venue Profile Report';
    titleLine.appendChild(summaryTitle);
    const summaryCount = document.createElement('span');
    summaryCount.className = 'gsr-pill gsr-pill--accent gsr-summary-total';
    summaryCount.textContent = `${totalRankedPapers} ranked`;
    titleLine.appendChild(summaryCount);
    if (currentProfileContext.dblpPidSource === 'manual') {
        const sourceBadge = document.createElement('span');
        sourceBadge.className = 'gsr-pill gsr-pill--neutral gsr-summary-source-pill';
        sourceBadge.textContent = 'Manual DBLP';
        titleLine.appendChild(sourceBadge);
    }
    titleGroup.appendChild(titleLine);
    const summarySubtitle = document.createElement('span');
    summarySubtitle.className = 'gsr-card__subtitle';
    const activeRange = currentSummaryState.timeline?.range || { label: 'Full Timeline' };
    const rangeLabel = activeRange.mode === 'last10' && activeRange.startYear && activeRange.endYear
        ? `${activeRange.startYear}-${activeRange.endYear}`
        : activeRange.label;
    summarySubtitle.textContent = `${totalConferencePapers} CORE conference | ${totalJournalPapers} SJR journal | ${totalProcessedPapers} processed | ${rangeLabel}`;
    titleGroup.appendChild(summarySubtitle);
    headerDiv.appendChild(titleGroup);
    headerDiv.appendChild(createDateRangeToggle(currentSummaryState));
    if (currentUserId) {
        const headerActions = document.createElement('div');
        headerActions.className = 'gsr-summary-header__actions';
        const createHeaderActionButton = ({ label, ariaLabel = label, iconText, title, variant = 'neutral', onClick }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `gsr-summary-header__action gsr-summary-header__action--${variant}`;
            button.setAttribute('title', title);
            button.setAttribute('aria-label', ariaLabel);
            const icon = document.createElement('span');
            icon.className = 'gsr-summary-header__action-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconText;
            const actionLabel = document.createElement('span');
            actionLabel.className = 'gsr-summary-header__action-label';
            actionLabel.textContent = label;
            button.appendChild(icon);
            button.appendChild(actionLabel);
            if (typeof onClick === 'function') {
                button.addEventListener('click', onClick);
            }
            return button;
        };
        headerActions.appendChild(createHeaderActionButton({
            label: 'Rescan',
            iconText: '↻',
            title: 'Clear cached results and rescan this Scholar profile',
            variant: 'rescan',
            onClick: () => {
                rescanCurrentProfile().catch((error) => console.error('GSR: Failed to start rescan.', error));
            }
        }));
        if (currentProfileContext.dblpPidSource === 'manual') {
            headerActions.appendChild(createHeaderActionButton({
                label: 'Change DBLP',
                iconText: '✎',
                title: 'Update the manually selected DBLP profile for this Scholar page',
                variant: 'explore',
                onClick: () => {
                    openManualDblpOverrideOverlay().catch((error) => console.error('GSR: Failed to open manual DBLP overlay.', error));
                }
            }));
            headerActions.appendChild(createHeaderActionButton({
                label: 'Clear Manual DBLP',
                iconText: '×',
                title: 'Remove the local manual DBLP override and return to automatic matching',
                variant: 'neutral',
                onClick: () => {
                    clearManualDblpOverrideForCurrentProfile().catch((error) => console.error('GSR: Failed to clear manual DBLP override.', error));
                }
            }));
        }
        headerActions.appendChild(createHeaderActionButton({
            label: 'Explore Venues',
            iconText: '⌕',
            title: 'Open the Venue Explorer across the bundled CORE and SJR datasets',
            variant: 'explore',
            onClick: () => openSearchUtilityOverlay()
        }));
        headerActions.appendChild(createHeaderActionButton({
            label: 'Download Report',
            iconText: '⇩',
            title: 'Download the current DBLP-verified venue profile report',
            variant: 'download',
            onClick: () => openExportOverlay()
        }));
        headerDiv.appendChild(headerActions);
    }
    panel.appendChild(headerDiv);
    if (scanLifecycle?.message) {
        const lifecyclePresentation = getScanLifecyclePresentation(scanLifecycle);
        const lifecycleBanner = document.createElement('div');
        lifecycleBanner.className = `gsr-summary-lifecycle gsr-summary-lifecycle--${scanLifecycle.status || 'info'}`;
        const lifecycleBadge = document.createElement('span');
        lifecycleBadge.className = 'gsr-summary-lifecycle__badge';
        if (scanLifecycle.status === 'running') {
            const lifecycleSpinner = document.createElement('span');
            lifecycleSpinner.className = 'gsr-spinner gsr-spinner--inline';
            lifecycleSpinner.setAttribute('aria-hidden', 'true');
            lifecycleBadge.appendChild(lifecycleSpinner);
        }
        const lifecycleLabel = document.createElement('span');
        lifecycleLabel.textContent = lifecyclePresentation?.chip || 'STATUS';
        lifecycleBadge.appendChild(lifecycleLabel);
        const lifecycleBody = document.createElement('div');
        lifecycleBody.className = 'gsr-summary-lifecycle__body';
        const lifecycleTitle = document.createElement('div');
        lifecycleTitle.className = 'gsr-summary-lifecycle__title';
        lifecycleTitle.textContent = lifecyclePresentation?.title || 'Scan update';
        const lifecycleText = document.createElement('div');
        lifecycleText.className = 'gsr-summary-lifecycle__message';
        lifecycleText.textContent = lifecyclePresentation?.message || scanLifecycle.message;
        lifecycleBody.appendChild(lifecycleTitle);
        lifecycleBody.appendChild(lifecycleText);
        lifecycleBanner.appendChild(lifecycleBadge);
        lifecycleBanner.appendChild(lifecycleBody);
        if (scanLifecycle.status === 'completed') {
            const dismissButton = document.createElement('button');
            dismissButton.type = 'button';
            dismissButton.className = 'gsr-summary-lifecycle__dismiss';
            dismissButton.setAttribute('aria-label', 'Dismiss depth completion message');
            dismissButton.setAttribute('title', 'Dismiss this message');
            dismissButton.textContent = '×';
            dismissButton.addEventListener('click', () => {
                lifecycleBanner.remove();
                if (currentSummaryState?.scanLifecycle?.status === 'completed') {
                    currentSummaryState.scanLifecycle = null;
                }
                const currentUserIdForDismissal = currentSummaryState?.context?.userId || currentProfileContext.userId;
                void setCachedDepthCompletionDismissed(currentUserIdForDismissal, true);
            });
            lifecycleBanner.appendChild(dismissButton);
        }
        panel.appendChild(lifecycleBanner);
    }
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
        titleText: 'CORE Conference Profile',
        metaText: '',
        counts: currentSummaryState.coreRankCounts || createEmptyCoreRankCounts(),
        orderedRanks: ['A*', 'A', 'B', 'C'],
        system: 'CORE',
        getFilter: (rank) => ({ type: 'rank', system: 'core', rank: normalizeRankKey(rank) }),
        getLabel: (rank) => rank
    }));
    summarySectionsContainer.appendChild(createSummarySection({
        titleText: 'SJR Journal Profile',
        metaText: '',
        counts: currentSummaryState.sjrRankCounts || createEmptySjrRankCounts(),
        orderedRanks: ['Q1', 'Q2', 'Q3', 'Q4'],
        system: 'SJR',
        getFilter: (rank) => ({ type: 'rank', system: 'sjr', rank: normalizeRankKey(rank) }),
        getLabel: (rank) => rank
    }));
    panel.appendChild(summarySectionsContainer);
    const timelineYear = currentSummaryState.timeline?.currentYear || getTimelineCurrentYear();
    const recentFocusedHistograms = getTimelineFocusedHistograms(currentSummaryState.timeline, 'recent');
    panel.appendChild(createTimelineHistogramSection(recentFocusedHistograms.topCoreHistogram || [], {
        titleText: 'Top CORE Timeline',
        subtitleText: `A*/A papers, recent 8 years (${timelineYear - 7}-${timelineYear})`,
        rankOrder: getTopCoreHistogramRankOrder(),
        variant: 'top-core'
    }));
    panel.appendChild(createTimelineHistogramSection(recentFocusedHistograms.q1Histogram || [], {
        titleText: 'Q1 Journal Timeline',
        subtitleText: `Q1 papers, recent 8 years (${timelineYear - 7}-${timelineYear})`,
        rankOrder: getQ1HistogramRankOrder(),
        variant: 'q1'
    }));
    const finalFooterDiv = document.createElement('div');
    finalFooterDiv.className = 'gsr-card__footer gsr-summary-footer';
    const footerMeta = document.createElement('div');
    footerMeta.className = 'gsr-summary-footer__meta';
    if (currentProfileContext.dblpPidSource === 'manual') {
        const manualMeta = document.createElement('span');
        manualMeta.className = 'gsr-summary-footer__stamp gsr-summary-footer__stamp--manual';
        manualMeta.textContent = 'Using manually selected DBLP profile';
        footerMeta.appendChild(manualMeta);
    }
    if (dblpAuthorPid) {
        const dblpProfileLink = document.createElement('a');
        dblpProfileLink.href = `https://dblp.org/pid/${dblpAuthorPid}.html`;
        dblpProfileLink.target = '_blank';
        dblpProfileLink.rel = 'noopener noreferrer';
        dblpProfileLink.className = 'gsr-summary-meta__link gsr-summary-meta__link--profile';
        dblpProfileLink.setAttribute('title', 'Open your DBLP profile in a new tab');
        const dblpLogo = document.createElement('img');
        dblpLogo.className = 'gsr-summary-meta__logo';
        dblpLogo.src = chrome.runtime.getURL('icons/dblp-logo.png');
        dblpLogo.alt = '';
        dblpLogo.decoding = 'async';
        dblpLogo.setAttribute('aria-hidden', 'true');
        const dblpLabel = document.createElement('span');
        dblpLabel.className = 'gsr-summary-meta__label';
        dblpLabel.textContent = 'DBLP Profile';
        dblpProfileLink.appendChild(dblpLogo);
        dblpProfileLink.appendChild(dblpLabel);
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
        label: 'Report Issue',
        badgeText: '!',
        title: 'Open the issue report form in a new tab',
        variant: 'report',
        onClick: () => window.open(REPORT_FORM_URL, '_blank', 'noopener,noreferrer')
    }));
    footerActions.appendChild(createFooterAction({
        label: 'About',
        badgeText: 'i',
        title: 'About the extension, ranking sources, and editorial rules',
        variant: 'about',
        onClick: () => openAboutOverlay()
    }));
    if (footerActions.childNodes.length > 0) {
        finalFooterDiv.appendChild(footerActions);
    }
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
    displayFacultyScorePanel(currentSummaryState);
    if (initialCachedPubRanks && initialCachedPubRanks.length > 0) {
        activeCachedPublicationRanks = initialCachedPubRanks;
        rankMapForObserver = new Map();
        activeCachedPublicationRanks.forEach(pubRank => {
            if (pubRank.url && pubRank.rank) {
                rankMapForObserver.set(pubRank.url, {
                    paperTitle: pubRank.paperTitle ?? null,
                    publicationYear: pubRank.publicationYear ?? null,
                    authorCount: pubRank.authorCount ?? null,
                    rank: pubRank.rank,
                    system: pubRank.system,
                    reason: pubRank.reason ?? null,
                    matchConfidence: pubRank.matchConfidence ?? null,
                    matchedVenue: pubRank.matchedVenue ?? null,
                    venueMatchConfidence: pubRank.venueMatchConfidence ?? null,
                    dblpVenue: pubRank.dblpVenue ?? null,
                    sourceYear: pubRank.sourceYear ?? null,
                    sourceYearFallback: pubRank.sourceYearFallback === true,
                    decisionVersion: pubRank.decisionVersion ?? null,
                    decisionStatus: pubRank.decisionStatus ?? null,
                    confidence: pubRank.confidence ?? null,
                    matchedKey: pubRank.matchedKey ?? null,
                    matchedSourceId: pubRank.matchedSourceId ?? null,
                    dblpKey: pubRank.dblpKey ?? null,
                    decisionEvidence: pubRank.decisionEvidence ?? null,
                    topCandidates: pubRank.topCandidates ?? null,
                    url: pubRank.url,
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
    setStatusCardTitle(statusElement, "DBLP API Busy");
    setStatusCardSpinnerVisible(statusElement, false);
    const progressBar = statusElement.querySelector('.gsr-progress-bar-inner');
    if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#FFA500'; // Orange for warning
    }
    const statusText = statusElement.querySelector('.gsr-status-text');
    if (statusText) {
        statusText.textContent = "DBLP temporarily limited requests. Using cached/local data where possible. Try again shortly.";
        statusText.style.color = '#b45309';
    }
    appendStatusRescanControls(statusElement);
}

// Issue 4: Friendly message when DBLP is down/unreachable
function displayDblpUnavailableError(message = "DBLP is down/unreachable. Please try again later.") {
    const statusElement = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("DBLP Unavailable");
    setStatusCardTitle(statusElement, "DBLP Unavailable");
    setStatusCardSpinnerVisible(statusElement, false);
    statusElement.querySelector('.gsr-progress')?.remove();
    const statusText = statusElement.querySelector('.gsr-status-text');
    if (statusText) {
        statusText.textContent = `${message} Reload Scholar or try again in a few minutes.`;
        statusText.style.color = '#b91c1c';
    }
    appendStatusRescanControls(statusElement, { includeReload: true });
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
    const publicationRows = Array.from(document.querySelectorAll('tr.gsc_a_tr'));
    const entries = publicationRows.map((row) => {
        const linkEl = row.querySelector('td.gsc_a_t a.gsc_a_at');
        const yearEl = row.querySelector('td.gsc_a_y span.gsc_a_h');
        if (!(linkEl instanceof HTMLAnchorElement) || !linkEl.href || !linkEl.textContent) {
            return null;
        }
        const normalizedTitle = cleanTextForComparison(linkEl.textContent);
        if (!normalizedTitle) {
            return null;
        }
        let year = null;
        if (yearEl?.textContent && /^\d{4}$/.test(yearEl.textContent.trim())) {
            year = parseInt(yearEl.textContent.trim(), 10);
        }
        return {
            title: normalizedTitle,
            normalizedTitle,
            year,
            scholarUrl: linkEl.href
        };
    }).filter(Boolean);
    return buildScholarVerificationSampleEntries(entries, count).map((entry) => ({
        title: entry.title,
        year: entry.year ?? null,
        scholarUrl: entry.scholarUrl ?? null
    }));
}
function getScholarHeadSamplePublications(count = DBLP_PROFILE_MATCH_POLICY.cheapSampleCount) {
    const publicationRows = Array.from(document.querySelectorAll('tr.gsc_a_tr'));
    const samples = [];
    const seenTitles = new Set();
    for (const row of publicationRows) {
        const linkEl = row.querySelector('td.gsc_a_t a.gsc_a_at');
        const yearEl = row.querySelector('td.gsc_a_y span.gsc_a_h');
        if (!(linkEl instanceof HTMLAnchorElement) || !linkEl.href || !linkEl.textContent) {
            continue;
        }
        const normalizedTitle = cleanTextForComparison(linkEl.textContent);
        if (!normalizedTitle || seenTitles.has(normalizedTitle)) {
            continue;
        }
        seenTitles.add(normalizedTitle);
        let year = null;
        if (yearEl?.textContent && /^\d{4}$/.test(yearEl.textContent.trim())) {
            year = parseInt(yearEl.textContent.trim(), 10);
        }
        samples.push({
            title: normalizedTitle,
            year,
            scholarUrl: linkEl.href
        });
        if (samples.length >= Math.max(1, Number(count) || 1)) {
            break;
        }
    }
    return samples;
}
// --- NEW FAST DBLP IDENTIFICATION LOGIC ---
async function searchDblpForCandidates(authorName, options = {}) {
    const candidateLimit = Number.isFinite(Number(options?.candidateLimit))
        ? Math.max(1, Math.floor(Number(options.candidateLimit)))
        : Number.POSITIVE_INFINITY;
    const allowHubExpansion = options?.allowHubExpansion === true;
    const hubVariantLimit = Number.isFinite(Number(options?.hubVariantLimit))
        ? Math.max(0, Math.floor(Number(options.hubVariantLimit)))
        : DBLP_MAX_HUB_VARIANTS_TO_CHECK;
    const clampCandidates = (list) => {
        const entries = Array.isArray(list) ? list : [];
        return Number.isFinite(candidateLimit) ? entries.slice(0, candidateLimit) : entries;
    };
    const cacheKey = buildDblpAuthorSearchPersistentCacheKey(authorName);
    const memoryKey = String(cacheKey || authorName || '').trim().toLowerCase();
    if (memoryKey && dblpAuthorSearchCache.has(memoryKey)) {
        const cachedCandidates = await dblpAuthorSearchCache.get(memoryKey);
        return clampCandidates(cachedCandidates);
    }
    const url = new URL(DBLP_API_AUTHOR_SEARCH_URL);
    url.searchParams.set('q', authorName);
    url.searchParams.set('format', 'json');
    url.searchParams.set('h', '500'); // Fetch more results for better hub detection
    const loadPromise = (async () => {
        const cachedCandidates = await loadPersistentDblpCacheEntry(cacheKey, getPersistentCacheTtlMs('author-search'));
        if (Array.isArray(cachedCandidates)) {
            return cachedCandidates;
        }
        try {
            await waitForDblpProfileBackoffIfNeeded();
            const resp = await gsvrFetch(url.toString(), {
                timeoutMs: DBLP_FETCH_TIMEOUTS_MS.authorSearch,
                requestClass: 'author_search',
                waitBudgetMs: 8000,
                dedupeKey: url.toString()
            });
            if (resp.status === 429 || getDblpFailureKind(resp) === 'rate_limited') {
                noteDblpProfileCooldown(resp);
                throw new DblpRateLimitError("DBLP API rate limit hit during author search.");
            }
            if (!resp.ok) {
                console.error(`DBLP author search failed with status: ${resp.status}`);
                if (isDblpBusyResponse(resp)) {
                    throw new DblpBusyError("DBLP is busy during author search.");
                }
                if (isDblpUnavailableResponse(resp) || resp.status >= 500) {
                    throw new DblpUnavailableError("DBLP is down/unreachable");
                }
                return [];
            }
            const data = await resp.json();
            const hits = data.result?.hits?.hit;
            const initialCandidates = Array.isArray(hits) ? hits : hits ? [hits] : [];
            const candidatesToStore = initialCandidates.slice(0, Math.max(candidateLimit, 120));
            await savePersistentDblpCacheEntry(cacheKey, candidatesToStore);
            return candidatesToStore;
        }
        catch (error) {
            if (error instanceof DblpRateLimitError || error instanceof DblpBusyError) {
                throw error;
            }
            console.error("GSR: DBLP candidate search fetch failed:", error);
            if (error instanceof DblpUnavailableError) {
                throw error;
            }
            if (error instanceof TypeError) {
                throw new DblpBusyError("DBLP author search timed out or the network is saturated.");
            }
            throw new Error("DBLP connection failed during author search.");
        }
    })();
    if (memoryKey) {
        dblpAuthorSearchCache.set(memoryKey, loadPromise);
    }
    try {
        const dataHits = await loadPromise;
        const hits = Array.isArray(dataHits) ? dataHits : [];
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
        if (mostCommonBasePid && maxCount > 4 && allowHubExpansion && hubVariantLimit > 0) {
            console.log(`GSR: Detected likely DBLP hub with base PID "${mostCommonBasePid}". Generating up to ${hubVariantLimit} variants to test.`);
            const generatedCandidates = [];
            for (let i = 1; i <= hubVariantLimit; i++) {
                const newPid = `${mostCommonBasePid}-${i}`;
                generatedCandidates.push({
                    info: {
                        author: `${authorName} (Variant ${i})`,
                        url: `https://dblp.org/pid/${newPid}.html`
                    }
                });
            }
            return clampCandidates(generatedCandidates);
        }
        if (mostCommonBasePid && maxCount > 4 && !allowHubExpansion) {
            console.log(`GSR: Detected likely DBLP hub with base PID "${mostCommonBasePid}", but skipping synthetic expansion for this layer.`);
        }
        console.log("GSR: Proceeding with bounded DBLP author API results.");
        return clampCandidates(initialCandidates);
    }
    catch (error) {
        if (memoryKey) {
            dblpAuthorSearchCache.delete(memoryKey);
        }
        if (error instanceof DblpRateLimitError || error instanceof DblpBusyError)
            throw error;
        if (error instanceof DblpUnavailableError) {
            throw error;
        }
        throw error;
    }
}
async function fetchDblpPubsForCheckViaXml(pid) {
    try {
        const snapshot = await fetchDblpPersonSnapshot(pid, null);
        return Array.isArray(snapshot?.dblpPublications) ? snapshot.dblpPublications : [];
    }
    catch (error) {
        if (error instanceof DblpRateLimitError || error instanceof DblpBusyError || error instanceof DblpUnavailableError) {
            throw error;
        }
        throw new DblpTransientLookupError(`DBLP XML fallback temporarily unavailable for PID ${pid}.`);
    }
}
async function fetchDblpPubsForCheck(pid) {
    return fetchDblpPubsForCheckViaXml(pid);
}
function extractPidFromUrl(url) {
    const normalizedPid = extractDblpPidValue(url);
    if (normalizedPid) {
        return normalizedPid;
    }
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
async function fetchDblpPublicationsViaSparql(pid, options = {}) {
    const authorUri = `https://dblp.org/pid/${pid}`;
    const queryLimit = Number.isFinite(Number(options?.limit))
        ? Math.max(1, Math.floor(Number(options.limit)))
        : null;
    const query = `
        PREFIX dblp: <https://dblp.org/rdf/schema#> 
        SELECT ?title ?year 
        WHERE { 
            ?paper dblp:authoredBy <${authorUri}> . 
            ?paper dblp:title ?title . 
            OPTIONAL { ?paper dblp:yearOfPublication ?year . } 
        } 
        ORDER BY DESC(?year)${queryLimit ? ` LIMIT ${queryLimit}` : ''}`;
    const url = `${DBLP_SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&output=json`;
    const cacheKey = buildDblpCheapProfilePersistentCacheKey(pid);
    const memoryKey = `${String(pid || '').trim().toLowerCase()}::${queryLimit || 'all'}`;
    if (memoryKey && dblpCheapProfileCache.has(memoryKey)) {
        return dblpCheapProfileCache.get(memoryKey);
    }
    const loadPromise = (async () => {
        const cachedPublications = await loadPersistentDblpCacheEntry(cacheKey, getPersistentCacheTtlMs('cheap-profile'));
        if (Array.isArray(cachedPublications)) {
            return cachedPublications;
        }
        try {
            await waitForDblpProfileBackoffIfNeeded();
            const response = await gsvrFetch(url, {
                headers: { 'Accept': 'application/sparql-results+json' },
                timeoutMs: DBLP_FETCH_TIMEOUTS_MS.sparqlProfileCheck,
                requestClass: 'profile_verify_sparql',
                waitBudgetMs: 8000,
                dedupeKey: url
            });
            if (response.status === 429 || getDblpFailureKind(response) === 'rate_limited') {
                noteDblpProfileCooldown(response);
                throw new DblpRateLimitError("DBLP SPARQL endpoint rate limit hit.");
            }
            if (!response.ok) {
                console.error(`SPARQL query failed for PID ${pid} with status ${response.status}`);
                if (isDblpBusyResponse(response)) {
                    throw new DblpBusyError("DBLP SPARQL verification is currently busy.");
                }
                if (isDblpUnavailableResponse(response) || response.status >= 500) {
                    throw new DblpUnavailableError("DBLP is down/unreachable");
                }
                return [];
            }
            const json = await response.json();
            const publications = json.results.bindings.map((b) => ({ title: b.title.value, year: b.year ? b.year.value : null }));
            await savePersistentDblpCacheEntry(cacheKey, publications);
            return publications;
        }
        catch (error) {
            if (error instanceof DblpRateLimitError || error instanceof DblpBusyError || error instanceof DblpUnavailableError) {
                throw error;
            }
            console.error(`SPARQL query connection failed for PID ${pid}:`, error);
            if (error instanceof TypeError) {
                throw new DblpBusyError("DBLP SPARQL verification timed out or the network is saturated.");
            }
            throw new DblpTransientLookupError(`DBLP SPARQL verification temporarily unavailable for PID ${pid}.`);
        }
    })();
    if (memoryKey) {
        dblpCheapProfileCache.set(memoryKey, loadPromise);
    }
    try {
        return await loadPromise;
    }
    catch (error) {
        if (memoryKey) {
            dblpCheapProfileCache.delete(memoryKey);
        }
        if (error instanceof DblpRateLimitError || error instanceof DblpBusyError || error instanceof DblpUnavailableError)
            throw error;
        throw error;
    }
}
async function fetchDblpPubsForCheapCheck(pid) {
    return fetchDblpPublicationsViaSparql(pid, { limit: DBLP_PROFILE_MATCH_POLICY.cheapSparqlLimit });
}
function buildProfileVerificationEvaluation({
    pid,
    dblpName,
    nameSimilarity,
    profileUrls = [],
    matchedScholarUserId = null,
    matchedScholarProfileUrl = null,
    baseItems = [],
    dblpPublications = [],
    score = null,
    matchReason = 'publication_overlap'
}) {
    return {
        pid,
        dblpName,
        nameSimilarity,
        profileUrls,
        matchedScholarUserId,
        matchedScholarProfileUrl,
        baseItems,
        dblpPublications,
        score: score?.score ?? nameSimilarity,
        confidence: score?.confidence ?? nameSimilarity,
        overlapCount: score?.overlapCount ?? 0,
        status: score?.status ?? DECISION_STATUS.MISSING,
        reason: score?.reason ?? null,
        matchReason
    };
}
function finalizeProfileVerificationLayer(evaluations) {
    const list = Array.isArray(evaluations) ? evaluations.filter(Boolean) : [];
    const best = selectBestProfileVerificationCandidate(list);
    if (best) {
        return {
            status: 'matched',
            candidate: best
        };
    }
    const hasMatchedCandidate = list.some((entry) => entry?.status === DECISION_STATUS.MATCHED);
    return {
        status: hasMatchedCandidate ? 'ambiguous' : 'no_match',
        candidate: null
    };
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
async function findBestDblpProfileCheap(scholarName, scholarSamplePubs, options = {}) {
    const candidates = await searchDblpForCandidates(scholarName, {
        candidateLimit: DBLP_PROFILE_MATCH_POLICY.cheapCandidateLimit,
        allowHubExpansion: false,
        hubVariantLimit: DBLP_PROFILE_MATCH_POLICY.cheapHubVariantLimit
    });
    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
    const evaluations = [];
    for (const candidate of candidates) {
        const rawName = candidate?.info?.author || '';
        const dblpName = rawName.replace(/\s\d{4}$/, '').replace(/\s+\(Variant \d+\)$/, '').trim();
        const pid = extractPidFromUrl(candidate?.info?.url || '');
        if (!pid) {
            continue;
        }
        const nameSimilarity = utils.hybridSimilarity(utils.normalizeProfileName(scholarName), utils.normalizeProfileName(dblpName));
        if (nameSimilarity < HEURISTIC_MIN_NAME_SIMILARITY) {
            continue;
        }
        let dblpPublications = [];
        try {
            dblpPublications = await fetchDblpPubsForCheapCheck(pid);
        }
        catch (error) {
            if (error instanceof DblpRateLimitError) {
                return { status: 'rate_limited', error };
            }
            if (error instanceof DblpBusyError) {
                return { status: 'busy', error };
            }
            if (error instanceof DblpUnavailableError || error instanceof DblpTransientLookupError) {
                return { status: 'unavailable', error };
            }
            continue;
        }
        if (!dblpPublications.length) {
            continue;
        }
        const score = utils?.scoreDblpProfileCandidate
            ? utils.scoreDblpProfileCandidate({
                scholarName,
                scholarSamplePubs,
                candidateName: dblpName,
                dblpPublications
            })
            : null;
        if (!score) {
            continue;
        }
        evaluations.push(buildProfileVerificationEvaluation({
            pid,
            dblpName,
            nameSimilarity,
            dblpPublications,
            score,
            matchReason: 'publication_overlap'
        }));
    }
    return finalizeProfileVerificationLayer(evaluations);
}
async function findBestDblpProfileRescue(scholarName, scholarSamplePubs, options = {}) {
    const candidates = await searchDblpForCandidates(scholarName, {
        candidateLimit: DBLP_PROFILE_MATCH_POLICY.rescueCandidateLimit,
        allowHubExpansion: true,
        hubVariantLimit: DBLP_PROFILE_MATCH_POLICY.rescueHubVariantLimit
    });
    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
    const currentScholarUserId = options?.currentScholarUserId || getScholarUserId() || null;
    const currentScholarProfileUrl = options?.currentScholarProfileUrl || normalizeScholarProfileUrlValue(window.location?.href || '') || null;
    const evaluations = [];
    for (const candidate of candidates) {
        const rawName = candidate?.info?.author || '';
        const dblpName = rawName.replace(/\s\d{4}$/, '').replace(/\s+\(Variant \d+\)$/, '').trim();
        const pid = extractPidFromUrl(candidate?.info?.url || '');
        if (!pid) {
            continue;
        }
        const nameSimilarity = utils.hybridSimilarity(utils.normalizeProfileName(scholarName), utils.normalizeProfileName(dblpName));
        if (nameSimilarity < HEURISTIC_MIN_NAME_SIMILARITY) {
            continue;
        }
        let snapshot;
        try {
            snapshot = await fetchDblpPersonSnapshot(pid, null);
        }
        catch (error) {
            if (error instanceof DblpRateLimitError) {
                return { status: 'rate_limited', error };
            }
            if (error instanceof DblpBusyError) {
                return { status: 'busy', error };
            }
            if (error instanceof DblpUnavailableError || error instanceof DblpTransientLookupError) {
                return { status: 'unavailable', error };
            }
            continue;
        }
        const dblpPublications = Array.isArray(snapshot?.dblpPublications) ? snapshot.dblpPublications : [];
        const matchedScholarUserId = currentScholarUserId && snapshot?.scholarUserIds?.includes(currentScholarUserId) ? currentScholarUserId : null;
        const matchedScholarProfileUrl = !matchedScholarUserId && currentScholarProfileUrl && snapshot?.scholarProfileUrls?.includes(currentScholarProfileUrl)
            ? currentScholarProfileUrl
            : null;
        if (matchedScholarUserId || matchedScholarProfileUrl) {
            return {
                status: 'matched',
                candidate: buildProfileVerificationEvaluation({
                    pid,
                    dblpName,
                    nameSimilarity,
                    profileUrls: Array.isArray(snapshot?.profileUrls) ? snapshot.profileUrls : [],
                    matchedScholarUserId,
                    matchedScholarProfileUrl,
                    baseItems: Array.isArray(snapshot?.baseItems) ? snapshot.baseItems : [],
                    dblpPublications,
                    score: null,
                    matchReason: matchedScholarUserId ? 'scholar_user' : 'scholar_url'
                })
            };
        }
        if (!dblpPublications.length) {
            continue;
        }
        const score = utils?.scoreDblpProfileCandidate
            ? utils.scoreDblpProfileCandidate({
                scholarName,
                scholarSamplePubs,
                candidateName: dblpName,
                dblpPublications
            })
            : null;
        if (!score) {
            continue;
        }
        evaluations.push(buildProfileVerificationEvaluation({
            pid,
            dblpName,
            nameSimilarity,
            profileUrls: Array.isArray(snapshot?.profileUrls) ? snapshot.profileUrls : [],
            baseItems: Array.isArray(snapshot?.baseItems) ? snapshot.baseItems : [],
            dblpPublications,
            score,
            matchReason: 'publication_overlap'
        }));
    }
    return finalizeProfileVerificationLayer(evaluations);
}
async function findBestDblpProfile(scholarName, scholarSamplePubs, options = {}) {
    const cheapScholarSamplePubs = Array.isArray(options?.cheapScholarSamplePubs) && options.cheapScholarSamplePubs.length > 0
        ? options.cheapScholarSamplePubs
        : getScholarHeadSamplePublications(DBLP_PROFILE_MATCH_POLICY.cheapSampleCount);
    let cheapResult = { status: 'no_match', candidate: null };
    if (cheapScholarSamplePubs.length >= DBLP_HEURISTIC_MIN_OVERLAP_COUNT) {
        cheapResult = await findBestDblpProfileCheap(scholarName, cheapScholarSamplePubs, options);
    }
    if (cheapResult.status === 'matched' && cheapResult.candidate) {
        console.log(`GSR: DBLP cheap profile match success for "${scholarName}" -> PID ${cheapResult.candidate.pid} (score ${cheapResult.candidate.score.toFixed(2)}, overlap ${cheapResult.candidate.overlapCount}).`);
        return cheapResult.candidate;
    }
    if (cheapResult.status === 'rate_limited') {
        throw cheapResult.error || new DblpRateLimitError(`DBLP author verification is rate limited for "${scholarName}".`);
    }
    if (cheapResult.status === 'busy') {
        throw cheapResult.error || new DblpBusyError(`DBLP author verification is busy for "${scholarName}".`);
    }
    if (cheapResult.status === 'unavailable') {
        throw cheapResult.error || new DblpUnavailableError(`DBLP author verification is temporarily unavailable for "${scholarName}".`);
    }
    if (!shouldEscalateProfileVerificationStatus(cheapResult.status)) {
        return null;
    }
    if (Array.isArray(scholarSamplePubs) && scholarSamplePubs.length < DBLP_HEURISTIC_MIN_OVERLAP_COUNT) {
        return null;
    }
    const statusTextEl = options?.statusElement?.querySelector?.('.gsr-status-text');
    if (statusTextEl) {
        statusTextEl.textContent = `DBLP: Running deep verification for ${scholarName}...`;
    }
    const rescueResult = await findBestDblpProfileRescue(scholarName, scholarSamplePubs, options);
    if (rescueResult.status === 'matched' && rescueResult.candidate) {
        if (rescueResult.candidate.matchReason === 'scholar_user') {
            console.log(`GSR: DBLP rescue profile match success for "${scholarName}" -> PID ${rescueResult.candidate.pid} via exact Scholar user match.`);
        }
        else if (rescueResult.candidate.matchReason === 'scholar_url') {
            console.log(`GSR: DBLP rescue profile match success for "${scholarName}" -> PID ${rescueResult.candidate.pid} via exact Scholar profile URL match.`);
        }
        else {
            console.log(`GSR: DBLP rescue profile match success for "${scholarName}" -> PID ${rescueResult.candidate.pid} (score ${rescueResult.candidate.score.toFixed(2)}, overlap ${rescueResult.candidate.overlapCount}).`);
        }
        return rescueResult.candidate;
    }
    if (rescueResult.status === 'rate_limited') {
        throw rescueResult.error || new DblpRateLimitError(`DBLP author verification is rate limited for "${scholarName}".`);
    }
    if (rescueResult.status === 'busy') {
        throw rescueResult.error || new DblpBusyError(`DBLP author verification is busy for "${scholarName}".`);
    }
    if (rescueResult.status === 'unavailable') {
        throw rescueResult.error || new DblpUnavailableError(`DBLP author verification is temporarily unavailable for "${scholarName}".`);
    }
    console.log(`GSR: DBLP profile matching failed for "${scholarName}". Layered matcher returned ${rescueResult.status}.`);
    return null;
}
function getScanPhaseLabel(phase) {
    return phase === 'depth' ? 'depth scan' : 'fast scan';
}
function buildDblpStreamCandidates(dblpKey, pubUrl) {
    const streamCandidates = [];
    const addStreamCandidate = (streamType, streamId) => {
        if (!streamType || !streamId)
            return;
        const key = `${streamType}:${streamId}`.toLowerCase();
        if (!streamCandidates.some((candidate) => candidate.key === key)) {
            streamCandidates.push({ streamType, streamId, key });
        }
    };
    const keyMatch = String(dblpKey || '').match(/^(conf|journals)\/([^\/]+)\//i);
    if (keyMatch && keyMatch[2]) {
        addStreamCandidate(keyMatch[1].toLowerCase() === 'conf' ? 'conf' : 'journals', keyMatch[2]);
    }
    if (pubUrl) {
        let path = pubUrl;
        try {
            path = new URL(pubUrl).pathname;
        }
        catch (error) {
            path = pubUrl;
        }
        path = String(path || '').replace(/^\/+/, '');
        const journalMatch = path.match(/^(?:db|rec)\/journals\/([^\/]+)\//i);
        if (journalMatch && journalMatch[1])
            addStreamCandidate('journals', journalMatch[1]);
        const confMatch = path.match(/^(?:db|rec)\/conf\/([^\/]+)\//i);
        if (confMatch && confMatch[1])
            addStreamCandidate('conf', confMatch[1]);
        const confFileMatch = path.match(/^db\/conf\/[^\/]+\/([a-zA-Z][\w-]*?)(?:\d{4}.*)?\.html/i);
        if (confFileMatch && confFileMatch[1])
            addStreamCandidate('conf', confFileMatch[1]);
        const streamXmlMatch = path.match(/^streams\/(conf|journals)\/([^\/]+)(?:\.xml)?$/i);
        if (streamXmlMatch && streamXmlMatch[1] && streamXmlMatch[2]) {
            addStreamCandidate(streamXmlMatch[1].toLowerCase(), streamXmlMatch[2]);
        }
    }
    return streamCandidates;
}
function parseDblpPublicationBaseItem(item) {
    const dblpKey = item.getAttribute('key') || '';
    if (!dblpKey) {
        return null;
    }
    const title = (item.querySelector('title')?.textContent || '').replace(/\.$/, '');
    if (!title) {
        return null;
    }
    const year = item.querySelector('year')?.textContent || null;
    const pages = item.querySelector('pages')?.textContent || null;
    const booktitle = item.querySelector('booktitle')?.textContent?.trim() || null;
    const journal = item.querySelector('journal')?.textContent?.trim() || null;
    const series = item.querySelector('series')?.textContent?.trim() || null;
    const school = item.querySelector('school')?.textContent?.trim() || null;
    const rawVenue = booktitle || journal || series || school || null;
    const volume = item.querySelector('volume')?.textContent?.trim() || null;
    const number = item.querySelector('number')?.textContent?.trim() || null;
    const crossref = item.querySelector('crossref')?.textContent?.trim() || null;
    const dblpType = item.tagName ? item.tagName.toLowerCase() : null;
    const authorCount = Math.max(1, item.querySelectorAll('author').length || 1);
    const pubUrl = item.querySelector('url')?.textContent?.trim() || null;
    const numericYear = year ? parseInt(year, 10) : null;
    return {
        dblpKey,
        title,
        year,
        pages,
        booktitle,
        journal,
        series,
        school,
        rawVenue,
        volume,
        number,
        crossref,
        dblpType,
        authorCount,
        pubUrl,
        numericYear,
        streamCandidates: buildDblpStreamCandidates(dblpKey, pubUrl)
    };
}
function buildLightweightDblpPublications(baseItems) {
    return (Array.isArray(baseItems) ? baseItems : [])
        .map((item) => ({
        title: String(item?.title || '').trim(),
        year: item?.year || null
    }))
        .filter((item) => !!item.title);
}
async function fetchDblpPersonSnapshot(authorPidPath, statusElement) {
    const cacheKey = String(authorPidPath || '').trim();
    if (cacheKey && dblpPersonSnapshotCache.has(cacheKey)) {
        return dblpPersonSnapshotCache.get(cacheKey);
    }
    const statusTextEl = statusElement?.querySelector('.gsr-status-text');
    const progressBarInner = statusElement?.querySelector('.gsr-progress-bar-inner');
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
    const loadPromise = (async () => {
        setProgress(0, `DBLP: Fetching publications for PID ${authorPidPath} (downloading XML)...`);
        const xmlUrl = `${DBLP_API_PERSON_PUBS_URL_PREFIX}${authorPidPath}.xml`;
        try {
            await waitForDblpProfileBackoffIfNeeded();
            const response = await gsvrFetch(xmlUrl, {
                timeoutMs: DBLP_FETCH_TIMEOUTS_MS.authorXml,
                requestClass: 'author_xml',
                waitBudgetMs: 8000,
                dedupeKey: xmlUrl
            });
            if (response.status === 429 || getDblpFailureKind(response) === 'rate_limited') {
                noteDblpProfileCooldown(response);
                throw new DblpRateLimitError(`DBLP XML download rate limit hit for PID ${authorPidPath}.`);
            }
            if (!response.ok) {
                console.warn(`DBLP: Fetching publications XML failed for PID "${authorPidPath}": ${response.statusText} (${response.status})`);
                if (isDblpBusyResponse(response)) {
                    if (statusTextEl)
                        statusTextEl.textContent = 'DBLP is busy. Please try again shortly.';
                    throw new DblpBusyError('DBLP is busy while fetching author XML.');
                }
                if (isDblpUnavailableResponse(response) || response.status >= 500) {
                    if (statusTextEl)
                        statusTextEl.textContent = 'DBLP is down/unreachable. Please try again later.';
                    throw new DblpUnavailableError('DBLP is down/unreachable');
                }
                if (statusTextEl)
                    statusTextEl.textContent = 'DBLP: XML fetch failed.';
                return {
                    authorPidPath,
                    profileUrls: [],
                    scholarProfileUrls: [],
                    scholarUserIds: [],
                    baseItems: [],
                    dblpPublications: []
                };
            }
            const xmlText = await response.text();
            setProgress(0.05, `DBLP: Downloaded XML for PID ${authorPidPath}. Parsing publications...`);
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
            if (xmlDoc.querySelector('parsererror')) {
                console.error('DBLP: XML parse error for PID', authorPidPath);
                if (statusTextEl)
                    statusTextEl.textContent = 'DBLP: XML parse error.';
                return {
                    authorPidPath,
                    profileUrls: [],
                    scholarProfileUrls: [],
                    scholarUserIds: [],
                    baseItems: [],
                    dblpPublications: []
                };
            }
            const rawProfileUrls = extractDblpPersonUrlsFromXmlText(xmlText);
            const profileUrls = Array.from(new Set(rawProfileUrls
                .map((url) => normalizeScholarProfileUrlValue(url) || String(url || '').trim())
                .filter(Boolean)));
            const scholarProfileUrls = Array.from(new Set(rawProfileUrls
                .map((url) => normalizeScholarProfileUrlValue(url))
                .filter(Boolean)));
            const scholarUserIds = Array.from(new Set(rawProfileUrls
                .map((url) => extractScholarUserIdFromUrl(url))
                .filter(Boolean)));
            const baseItems = Array.from(xmlDoc.querySelectorAll('dblpperson > r > *'))
                .map((item) => parseDblpPublicationBaseItem(item))
                .filter(Boolean);
            return {
                authorPidPath,
                profileUrls,
                scholarProfileUrls,
                scholarUserIds,
                baseItems,
                dblpPublications: buildLightweightDblpPublications(baseItems)
            };
        }
        catch (err) {
            if (err instanceof DblpRateLimitError || err instanceof DblpBusyError || err instanceof DblpUnavailableError) {
                throw err;
            }
            console.error('DBLP: Error fetching/parsing XML:', err);
            if (err instanceof TypeError) {
                if (statusTextEl)
                    statusTextEl.textContent = 'DBLP is busy. Please try again shortly.';
                throw new DblpBusyError('DBLP author XML fetch timed out or the network is saturated.');
            }
            if (statusTextEl)
                statusTextEl.textContent = 'DBLP: Error fetching pubs.';
            throw err;
        }
    })();
    if (!cacheKey) {
        return loadPromise;
    }
    dblpPersonSnapshotCache.set(cacheKey, loadPromise);
    try {
        return await loadPromise;
    }
    catch (error) {
        dblpPersonSnapshotCache.delete(cacheKey);
        throw error;
    }
}
async function fetchDblpPublicationBaseItems(authorPidPath, statusElement) {
    const snapshot = await fetchDblpPersonSnapshot(authorPidPath, statusElement);
    return Array.isArray(snapshot?.baseItems) ? snapshot.baseItems : [];
}
async function enrichDblpPublicationBaseItems(baseItems, statusElement, { phase = 'fast', sessionId = null, diagnostics = null } = {}) {
    const statusTextEl = statusElement?.querySelector('.gsr-status-text');
    const progressBarInner = statusElement?.querySelector('.gsr-progress-bar-inner');
    const scanPhaseLabel = getScanPhaseLabel(phase);
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
    const publications = [];
    const totalItems = baseItems.length || 0;
    const streamKeysSeen = new Set();
    let streamFetchCount = 0;
    let deferredFastJournalCount = 0;
    let locallyResolvedDepthJournalCount = 0;
    let locallyResolvedVenueCount = 0;
    let lastUiUpdateMs = 0;
    const uiNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const maybeUpdateUi = (processed, extraDetail = '') => {
        const now = uiNow();
        if (processed === 0 || processed === totalItems || now - lastUiUpdateMs > 450) {
            const frac = totalItems > 0 ? (processed / totalItems) : 0;
            const detailParts = [`stream lookups: ${streamFetchCount}`];
            if (phase === 'fast' && deferredFastJournalCount > 0) {
                detailParts.push(`journal metadata deferred: ${deferredFastJournalCount}`);
            }
            if (phase === 'depth' && locallyResolvedDepthJournalCount > 0) {
                detailParts.push(`local journal matches: ${locallyResolvedDepthJournalCount}`);
            }
            if (locallyResolvedVenueCount > 0) {
                detailParts.push(`local-first matches: ${locallyResolvedVenueCount}`);
            }
            if (extraDetail) {
                detailParts.push(extraDetail);
            }
            setProgress(0.05 + 0.95 * frac, `DBLP: Processing ${processed} / ${totalItems} publications — ${scanPhaseLabel} (${detailParts.join(', ')})…`);
            lastUiUpdateMs = now;
        }
    };
    maybeUpdateUi(0);
    for (let i = 0; i < baseItems.length; i++) {
        throwIfStaleScanSession(sessionId);
        const entry = baseItems[i];
        const localResolution = await resolveLocalVenueBeforeStreamLookup(entry, phase);
        let acronym = localResolution?.acronym || null;
        let venue_full = localResolution?.venueFull || null;
        let journalIssns = Array.isArray(localResolution?.journalIssns) ? normalizeIssnList(localResolution.journalIssns) : [];
        let journalShortTitle = localResolution?.journalShortTitle || null;
        let streamMeta = null;
        const isJournalLike = String(entry.dblpKey || '').toLowerCase().startsWith('journals/')
            || String(entry.dblpType || '').toLowerCase() === 'article';
        let shouldLookupStreamMetadata = shouldResolveDblpStreamMetadata({
            dblpKey: entry.dblpKey,
            dblpType: entry.dblpType,
            rawVenue: entry.rawVenue,
            streamCandidates: entry.streamCandidates,
            localResolution
        }, phase);
        if (!shouldLookupStreamMetadata && (localResolution?.status === 'matched' || localResolution?.status === 'unranked')) {
            locallyResolvedVenueCount += 1;
            if (phase === 'depth' && isJournalLike) {
                locallyResolvedDepthJournalCount += 1;
                maybeUpdateUi(i, 'local journal match');
            }
        }
        if (!shouldLookupStreamMetadata && phase === 'fast' && isJournalLike) {
            deferredFastJournalCount += 1;
            maybeUpdateUi(i, 'local journal matching only');
        }
        if (shouldLookupStreamMetadata) {
            const streamTimeoutMs = phase === 'depth'
                ? DBLP_FETCH_TIMEOUTS_MS.streamDepth
                : DBLP_FETCH_TIMEOUTS_MS.streamFast;
            for (const candidate of entry.streamCandidates || []) {
                const cacheKey = (candidate.key || `${candidate.streamType}:${candidate.streamId}`).toLowerCase();
                if (!streamKeysSeen.has(cacheKey)) {
                    streamKeysSeen.add(cacheKey);
                    if (!streamMetaCache.has(cacheKey)) {
                        streamFetchCount += 1;
                        maybeUpdateUi(i, `fetching ${cacheKey}`);
                    }
                }
                if (candidate.streamType === 'conf') {
                    streamMeta = await resolveDblpStreamMetadata('conf', candidate.streamId, {
                        year: entry.numericYear,
                        timeoutMs: streamTimeoutMs,
                        transientRetries: phase === 'depth' ? DBLP_STREAM_RETRY_POLICY.maxDepthRetries : 0,
                        diagnostics
                    });
                }
                else {
                    streamMeta = await resolveDblpStreamMetadata('journals', candidate.streamId, {
                        timeoutMs: streamTimeoutMs,
                        transientRetries: phase === 'depth' ? DBLP_STREAM_RETRY_POLICY.maxDepthRetries : 0,
                        diagnostics
                    });
                }
                if (streamMeta && (streamMeta.acronym || streamMeta.title)) {
                    break;
                }
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
        if (!acronym && entry.rawVenue?.startsWith('Proc. ACM') && entry.number && /^[A-Za-z]{2,}$/.test(entry.number)) {
            acronym = entry.number;
        }
        publications.push({
            dblpKey: entry.dblpKey,
            title: entry.title,
            venue: entry.rawVenue,
            year: entry.year,
            pages: entry.pages,
            venue_full,
            acronym,
            volume: entry.volume,
            number: entry.number,
            crossref: entry.crossref,
            dblpType: entry.dblpType,
            journalIssns,
            journalShortTitle,
            authorCount: entry.authorCount
        });
        maybeUpdateUi(i + 1);
    }
    setProgress(1, `DBLP: Fetched ${publications.length} publications using ${scanPhaseLabel}.`);
    return publications;
}
async function fetchPublicationsFromDblp(authorPidPath, statusElement, { phase = 'fast', baseItems = null, sessionId = null, diagnostics = null } = {}) {
    const resolvedBaseItems = Array.isArray(baseItems) && baseItems.length > 0
        ? baseItems
        : await fetchDblpPublicationBaseItems(authorPidPath, statusElement);
    const publications = await enrichDblpPublicationBaseItems(resolvedBaseItems, statusElement, { phase, sessionId, diagnostics });
    return {
        baseItems: resolvedBaseItems,
        publications
    };
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
            authorCount: matched.authorCount ?? null,
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
            decisionEvidence: best.reason ? [best.reason] : null,
            topCandidates: Array.isArray(best.topCandidates) ? best.topCandidates : null
        });
        mappedCount++;
    }
    console.log(`GSR: DBLP Info Mapping: Matched ${mappedCount} of ${scholarPubLinkElements.length} Scholar publications to DBLP entries.`);
    if (statusTextEl && mappedCount > 0)
        statusTextEl.textContent = `DBLP: Mapped ${mappedCount} publication details.`;
}
function createPublicationRankInfo(result) {
    return {
        paperTitle: result.paperTitle ?? result.titleText,
        publicationYear: result.publicationYear ?? null,
        authorCount: result.authorCount ?? null,
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
        dblpKey: result.dblpKey ?? null,
        decisionEvidence: result.decisionEvidence ?? null,
        topCandidates: result.topCandidates ?? null
    };
}
async function evaluatePublicationRanks(publicationLinkElements, dblpPublications, statusElement, sessionId) {
    const determinedPublicationRanks = [];
    const persistentPublicationRanks = [];
    const coreRankCounts = createEmptyCoreRankCounts();
    const sjrRankCounts = createEmptySjrRankCounts();
    const scholarTitlesAlreadyRanked = new Set();
    const dblpKeysAlreadyUsedForRank = new Set();
    let processedCount = 0;
    dblpPubsForCurrentUser = Array.isArray(dblpPublications) ? dblpPublications : [];
    const processPublication = async (pubInfo, titlesAlreadyProcessedSet, dblpKeysUsedSet) => {
        throwIfStaleScanSession(sessionId);
        const defaultResult = {
            rank: "N/A",
            system: 'UNKNOWN',
            reason: null,
            rowElement: pubInfo.rowElement,
            paperTitle: pubInfo.paperTitle,
            titleText: pubInfo.titleText,
            publicationYear: pubInfo.yearFromProfile ?? null,
            authorCount: null,
            url: pubInfo.url,
            shouldPersist: true,
            matchConfidence: null,
            matchedVenue: null,
            venueMatchConfidence: null,
            dblpVenue: null,
            sourceYear: null,
            dblpKey: null,
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
        let resolvedPublicationYear = pubInfo.yearFromProfile ?? null;
        let authorCount = null;
        let topCandidates = null;
        let decisionMeta = createDecisionMeta();
        try {
            const dblpInfo = scholarUrlToDblpInfoMap.get(pubInfo.url);
            if (dblpInfo) {
                if (typeof dblpInfo.matchScore === 'number')
                    matchConfidence = dblpInfo.matchScore;
                authorCount = typeof dblpInfo.authorCount === 'number' ? dblpInfo.authorCount : authorCount;
                dblpVenue = (dblpInfo.venue_full || dblpInfo.venue || null);
                decisionMeta = mergeDecisionMeta(decisionMeta, {
                    decisionStatus: dblpInfo.decisionStatus ?? DECISION_STATUS.MATCHED,
                    confidence: dblpInfo.matchScore ?? null,
                    matchedKey: dblpInfo.dblpKey ?? null,
                    decisionEvidence: dblpInfo.decisionEvidence ?? null
                });
                topCandidates = Array.isArray(dblpInfo.topCandidates) ? dblpInfo.topCandidates : topCandidates;
            }
            if (dblpInfo && dblpInfo.venue && dblpInfo.dblpKey) {
                dblpKeyUsedForThisRanking = dblpInfo.dblpKey;
                if (dblpKeysUsedSet.has(dblpInfo.dblpKey)) {
                    return defaultResult;
                }
                let venueName = dblpInfo.venue;
                let pageCount = dblpInfo.pageCount;
                let publicationYear = pubInfo.yearFromProfile;
                const matchedDblpEntry = dblpPublications.find(dp => dp.dblpKey === dblpInfo.dblpKey);
                if (matchedDblpEntry && matchedDblpEntry.year) {
                    const dblpYearNum = parseInt(matchedDblpEntry.year, 10);
                    if (!isNaN(dblpYearNum)) {
                        publicationYear = dblpYearNum;
                    }
                }
                resolvedPublicationYear = publicationYear ?? resolvedPublicationYear;
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
                    let sawHistoricalSjrUnavailable = false;
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
                        if (sjrResult.status === 'historical_coverage_unavailable') {
                            sawHistoricalSjrUnavailable = true;
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
                    else if (sawHistoricalSjrUnavailable) {
                        naReason = 'SJR Historical Coverage Unavailable';
                        decisionMeta = mergeDecisionMeta(decisionMeta, {
                            decisionStatus: DECISION_STATUS.UNRANKED,
                            matchedKey: venueName ?? null,
                            decisionEvidence: ['sjr_historical_coverage_unavailable']
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
                    if (trackInfo.isExtendedAbstract || naReason === 'Extended Abstract') {
                        return {
                            rank: "N/A",
                            system: 'CORE',
                            reason: 'Extended Abstract',
                            rowElement: pubInfo.rowElement,
                            paperTitle: pubInfo.paperTitle,
                            titleText: pubInfo.titleText,
                            publicationYear: publicationYear ?? null,
                            authorCount,
                            url: pubInfo.url,
                            shouldPersist: true,
                            matchConfidence,
                            matchedVenue: null,
                            venueMatchConfidence: null,
                            dblpVenue,
                            sourceYear,
                            dblpKey: dblpInfo.dblpKey ?? null,
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
                            paperTitle: pubInfo.paperTitle,
                            titleText: pubInfo.titleText,
                            publicationYear: publicationYear ?? null,
                            authorCount,
                            url: pubInfo.url,
                            shouldPersist: true,
                            matchConfidence,
                            matchedVenue: null,
                            venueMatchConfidence: null,
                            dblpVenue,
                            sourceYear,
                            dblpKey: dblpInfo.dblpKey ?? null,
                            ...mergeDecisionMeta(decisionMeta, {
                                decisionStatus: DECISION_STATUS.UNRANKED,
                                decisionEvidence: trackInfo.signals ?? ['editorship']
                            })
                        };
                    }
                    if (trackInfo.isDemoPoster) {
                        return {
                            rank: "N/A",
                            system: 'CORE',
                            reason: naReason || 'Demo/Poster',
                            rowElement: pubInfo.rowElement,
                            paperTitle: pubInfo.paperTitle,
                            titleText: pubInfo.titleText,
                            publicationYear: publicationYear ?? null,
                            authorCount,
                            url: pubInfo.url,
                            shouldPersist: true,
                            matchConfidence,
                            matchedVenue: null,
                            venueMatchConfidence: null,
                            dblpVenue,
                            sourceYear,
                            dblpKey: dblpInfo.dblpKey ?? null,
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
                            expandVenue(csrCanonicalVenue, (trackInfo.isWorkshop && !inheritWorkshopParentRank) ? { includeAtParent: false } : undefined);
                        }
                        if (trackInfo.isWorkshop && !inheritWorkshopParentRank) {
                            if (trackInfo.resolvedVenue)
                                expandVenue(trackInfo.resolvedVenue, { includeAtParent: false });
                            if (trackInfo.seriesId && (!trackInfo.resolvedVenue || trackInfo.seriesId.toLowerCase() === trackInfo.resolvedVenue.toLowerCase()))
                                expandVenue(trackInfo.seriesId, { includeAtParent: false });
                            if (dblpInfo.acronym && (!trackInfo.parentVenue || dblpInfo.acronym.toLowerCase() !== trackInfo.parentVenue.toLowerCase())) {
                                expandVenue(dblpInfo.acronym, { includeAtParent: false });
                            }
                            if (fullVenueTitleForRanking)
                                expandVenue(fullVenueTitleForRanking, { includeAtParent: false });
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
                            topCandidates = Array.isArray(resolvedDetails.topCandidates) ? resolvedDetails.topCandidates : topCandidates;
                        }
                        if (currentRank === 'N/A' && trackInfo.isWorkshop) {
                            naReason = naReason || 'Workshop';
                        }
                        if (currentRank === 'N/A' && resolvedDetails?.decisionStatus === DECISION_STATUS.AMBIGUOUS) {
                            naReason = naReason || 'Ambiguous Venue Match';
                        }
                    }
                    if (pageCount !== null && pageCount < 6 && !trackInfo.isDemoPoster && !trackInfo.isWorkshop) {
                        currentRank = 'N/A';
                        naReason = 'Short-paper';
                        decisionMeta = mergeDecisionMeta(decisionMeta, {
                            decisionStatus: DECISION_STATUS.UNRANKED,
                            decisionEvidence: [...(trackInfo.signals || []), 'short_by_pages']
                        });
                    }
                }
            }
            else {
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
            if (error instanceof ScanSessionCancelledError) {
                throw error;
            }
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
        return { rank: currentRank, system: rankingSystem, reason: (currentRank === 'N/A' ? naReason : null), rowElement: pubInfo.rowElement, paperTitle: pubInfo.paperTitle, titleText: pubInfo.titleText, publicationYear: resolvedPublicationYear, authorCount, url: pubInfo.url, shouldPersist, matchConfidence, matchedVenue, venueMatchConfidence, dblpVenue, sourceYear, dblpKey: dblpKeyUsedForThisRanking, topCandidates, ...decisionMeta };
    };
    for (const pubInfo of publicationLinkElements) {
        throwIfStaleScanSession(sessionId);
        const result = await processPublication(pubInfo, scholarTitlesAlreadyRanked, dblpKeysAlreadyUsedForRank);
        if (result.system === 'CORE') {
            const coreKey = VALID_RANKS.includes(result.rank) ? result.rank : 'N/A';
            coreRankCounts[coreKey] += 1;
        }
        else if (result.system === 'SJR') {
            const sjrKey = SJR_QUARTILES.includes(result.rank) ? result.rank : 'N/A';
            sjrRankCounts[sjrKey] += 1;
        }
        const publicationRankInfo = createPublicationRankInfo(result);
        determinedPublicationRanks.push(publicationRankInfo);
        if (result.shouldPersist !== false) {
            persistentPublicationRanks.push(publicationRankInfo);
        }
        processedCount++;
        updateStatusElement(statusElement, processedCount, publicationLinkElements.length, "Ranking");
    }
    return {
        coreRankCounts,
        sjrRankCounts,
        determinedPublicationRanks,
        persistentPublicationRanks
    };
}
async function resolveVerifiedProfileContext({ sessionId, statusElement = null, reuseContext = null, forceFresh = false } = {}) {
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    const currentUserId = reuseContext?.currentUserId ?? getScholarUserId();
    const scholarAuthorName = reuseContext?.scholarAuthorName ?? getScholarAuthorName();
    const sanitizedName = reuseContext?.sanitizedName ?? (scholarAuthorName ? sanitizeAuthorName(scholarAuthorName) : null);
    let baseItems = Array.isArray(reuseContext?.baseItems) ? reuseContext.baseItems : null;
    let matchReason = typeof reuseContext?.matchReason === 'string' ? reuseContext.matchReason : null;
    if (reuseContext?.dblpAuthorPid) {
        return {
            ok: true,
            currentUserId,
            scholarAuthorName,
            sanitizedName,
            dblpAuthorPid: reuseContext.dblpAuthorPid,
            dblpPidSource: reuseContext?.dblpPidSource || null,
            baseItems,
            matchReason
        };
    }
    let dblpAuthorPid = null;
    let dblpPidSource = null;
    const manualDblpPid = currentUserId ? await loadManualDblpPid(currentUserId) : null;
    const cachedUserData = (!forceFresh && currentUserId) ? await loadCachedData(currentUserId) : null;
    const cachedProfileCandidate = (cachedUserData?.dblpAuthorPid && cachedUserData.dblpMatchTimestamp && (Date.now() - cachedUserData.dblpMatchTimestamp) < DBLP_CACHE_DURATION_MS)
        ? {
            pid: cachedUserData.dblpAuthorPid,
            source: cachedUserData?.dblpPidSource || 'cached',
            tag: 'profile-cache'
        }
        : null;
    const persistentDblpPid = (currentUserId && !forceFresh) ? await loadPersistentDblpPid(currentUserId) : null;
    const preferredStoredCandidate = SETTINGS_API.selectPreferredDblpPidCandidate([
        manualDblpPid ? { pid: manualDblpPid, source: 'manual', tag: 'manual' } : null,
        cachedProfileCandidate,
        persistentDblpPid ? { pid: persistentDblpPid, source: 'cached', tag: 'persistent-cache' } : null
    ]);
    dblpAuthorPid = preferredStoredCandidate.pid;
    dblpPidSource = preferredStoredCandidate.source;
    if (preferredStoredCandidate.tag === 'manual') {
        if (statusTextElement) {
            statusTextElement.textContent = `DBLP: Using manual profile ${dblpAuthorPid}...`;
        }
    }
    else if (preferredStoredCandidate.tag === 'profile-cache') {
        console.log("GSR INFO: Using cached DBLP PID:", dblpAuthorPid);
    }
    else if (preferredStoredCandidate.tag === 'persistent-cache') {
        console.log("GSR INFO: Using persistent DBLP PID cache:", dblpAuthorPid);
    }
    if (!dblpAuthorPid && !sanitizedName) {
        return {
            ok: false,
            reason: 'missing-author-name',
            currentUserId,
            scholarAuthorName,
            sanitizedName: null,
            dblpAuthorPid: null,
            dblpPidSource: null,
            baseItems: null,
            matchReason: null
        };
    }
    if (!dblpAuthorPid) {
        if (cachedUserData?.dblpAuthorPid)
            console.log("GSR INFO: Cached DBLP PID is stale or missing timestamp. Will attempt fresh DBLP author match.");
        else
            console.log("GSR INFO: No cached DBLP PID. Attempting DBLP author match for:", sanitizedName);
        if (statusTextElement)
            statusTextElement.textContent = `DBLP: Searching for ${sanitizedName}...`;
        const scholarSamplePubs = getScholarSamplePublications(getScholarSampleTargetCount());
        if (scholarSamplePubs.length >= DBLP_HEURISTIC_MIN_OVERLAP_COUNT) {
            const verifiedProfile = await findBestDblpProfile(sanitizedName, scholarSamplePubs, {
                currentScholarUserId: currentUserId,
                currentScholarProfileUrl: normalizeScholarProfileUrlValue(window.location?.href || ''),
                statusElement
            });
            if (verifiedProfile?.pid) {
                dblpAuthorPid = verifiedProfile.pid;
                dblpPidSource = 'search';
                baseItems = Array.isArray(verifiedProfile.baseItems) ? verifiedProfile.baseItems : null;
                matchReason = typeof verifiedProfile.matchReason === 'string' ? verifiedProfile.matchReason : null;
            }
        }
    }
    throwIfStaleScanSession(sessionId);
    return {
        ok: !!dblpAuthorPid,
        reason: dblpAuthorPid ? null : 'dblp-author-not-found',
        currentUserId,
        scholarAuthorName,
        sanitizedName,
        dblpAuthorPid,
        dblpPidSource,
        baseItems,
        matchReason
    };
}
async function runScanPass({ phase, sessionId, statusElement = null, context = {} }) {
    throwIfStaleScanSession(sessionId);
    const scanPhaseLabel = getScanPhaseLabel(phase);
    const dblpAuthorPid = context?.dblpAuthorPid ?? null;
    const diagnostics = { rateLimitDetected: false, rateLimitEvents: 0 };
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    if (!dblpAuthorPid) {
        return {
            ok: false,
            reason: 'missing-pid',
            phase,
            diagnostics,
            context: { ...context }
        };
    }
    if (statusTextElement) {
        statusTextElement.textContent = `DBLP: Fetching publications for PID ${dblpAuthorPid} (${scanPhaseLabel} scan)...`;
    }
    const dblpFetchResult = await fetchPublicationsFromDblp(dblpAuthorPid, statusElement, {
        phase,
        baseItems: context.baseItems ?? null,
        sessionId,
        diagnostics
    });
    throwIfStaleScanSession(sessionId);
    const dblpPublications = Array.isArray(dblpFetchResult?.publications) ? dblpFetchResult.publications : [];
    const baseItems = Array.isArray(dblpFetchResult?.baseItems) ? dblpFetchResult.baseItems : [];
    dblpPubsForCurrentUser = dblpPublications;
    if (dblpPublications.length === 0) {
        return {
            ok: false,
            reason: 'no-dblp-publications',
            phase,
            diagnostics,
            context: {
                ...context,
                dblpAuthorPid,
                baseItems,
                dblpPublications
            }
        };
    }
    let publicationLinkElements = Array.isArray(context.publicationLinkElements) && context.publicationLinkElements.length > 0
        ? context.publicationLinkElements
        : null;
    if (!publicationLinkElements) {
        if (statusTextElement)
            statusTextElement.textContent = "Expanding publications list...";
        await expandAllPublications(statusElement);
        throwIfStaleScanSession(sessionId);
        publicationLinkElements = collectPublicationLinkElements();
    }
    if (!publicationLinkElements.length) {
        return {
            ok: false,
            reason: 'no-publications',
            phase,
            diagnostics,
            context: {
                ...context,
                dblpAuthorPid,
                baseItems,
                dblpPublications,
                publicationLinkElements: []
            }
        };
    }
    scholarUrlToDblpInfoMap.clear();
    await buildDblpInfoMap(publicationLinkElements, dblpPublications, scholarUrlToDblpInfoMap, statusElement);
    throwIfStaleScanSession(sessionId);
    updateStatusElement(statusElement, 0, publicationLinkElements.length, `Ranking (${scanPhaseLabel})`);
    const rankingResult = await evaluatePublicationRanks(publicationLinkElements, dblpPublications, statusElement, sessionId);
    throwIfStaleScanSession(sessionId);
    return {
        ok: true,
        phase,
        diagnostics,
        ...rankingResult,
        context: {
            ...context,
            dblpAuthorPid,
            baseItems,
            dblpPublications,
            publicationLinkElements
        }
    };
}
async function persistScanPassResult({ userId, dblpAuthorPid, passResult, scanMetadata }) {
    if (!userId || !passResult) {
        return;
    }
    await saveCachedData(userId, passResult.coreRankCounts, passResult.sjrRankCounts, passResult.persistentPublicationRanks || [], dblpAuthorPid, {
        ...(scanMetadata || {}),
        dblpPidSource: passResult?.context?.dblpPidSource || scanMetadata?.dblpPidSource || null
    });
}
function getDepthRunningMessage() {
    return "Fast results are ready. Running a deeper check to improve accuracy and catch missed ranks.";
}
function getDepthCompletionMessage(improvementCount, options = {}) {
    const rateLimited = options?.rateLimited === true;
    if (rateLimited) {
        return improvementCount > 0
            ? "Found additional ranked venues, but DBLP rate-limited part of the depth check. Rescan after some time for the fullest result."
            : "DBLP rate-limited part of the depth check. No additional ranked venues were found this time; try rescanning after some time.";
    }
    return improvementCount > 0
        ? "Found additional ranked venues in the depth check."
        : "No additional ranked venues were found.";
}
function getDepthFailureMessage(options = {}) {
    return options?.rateLimited === true
        ? "DBLP is rate limiting requests right now. Fast results remain visible. Try rescanning after some time."
        : "Fast results remain visible.";
}
function getScanLifecyclePresentation(scanLifecycle) {
    if (!scanLifecycle) {
        return null;
    }
    if (scanLifecycle.status === 'running') {
        return {
            chip: 'UPGRADING',
            title: 'Improving your results',
            message: scanLifecycle.message || getDepthRunningMessage()
        };
    }
    if (scanLifecycle.status === 'completed') {
        const improved = Number(scanLifecycle.improvementCount) > 0;
        return {
            chip: improved ? 'UPDATED' : 'DONE',
            title: improved ? 'Results improved' : 'Depth check complete',
            message: scanLifecycle.message || getDepthCompletionMessage(scanLifecycle.improvementCount || 0)
        };
    }
    if (scanLifecycle.status === 'failed') {
        return {
            chip: 'DEPTH',
            title: 'Depth check paused',
            message: scanLifecycle.message || getDepthFailureMessage()
        };
    }
    return {
        chip: 'STATUS',
        title: 'Scan update',
        message: scanLifecycle.message || ''
    };
}
function displayProfileMismatchStatus(statusElement, sanitizedName) {
    setStatusCardTitle(statusElement, "DBLP Author Not Found");
    setStatusCardSpinnerVisible(statusElement, false);
    const progressBar = statusElement?.querySelector('.gsr-progress-bar-inner');
    if (progressBar?.parentElement) {
        progressBar.parentElement.style.display = 'none';
    }
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    if (statusTextElement) {
        statusTextElement.textContent = "DBLP Author Not Found";
        statusTextElement.setAttribute('title', `No verified DBLP PID for "${sanitizedName}".`);
        statusTextElement.style.color = '#64748b';
    }
    appendStatusRescanControls(statusElement, { includeManualEntry: true, rescanLabel: 'Rescan Me' });
}
function displayNoPublicationsStatus(statusElement, message) {
    setStatusCardSpinnerVisible(statusElement, false);
    const progressBar = statusElement?.querySelector('.gsr-progress-bar-inner');
    if (progressBar?.parentElement) {
        progressBar.parentElement.style.display = 'none';
    }
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    if (statusTextElement) {
        statusTextElement.textContent = message;
        statusTextElement.style.color = '#64748b';
    }
}
function releaseForegroundScanSession(sessionId) {
    if (activeForegroundScanSessionId === sessionId) {
        activeForegroundScanSessionId = 0;
    }
    isMainProcessing = false;
}
async function startBackgroundDepthUpgrade({ sessionId, fastPassResult, fastCompletedAt }) {
    if (!isCurrentScanSession(sessionId) || !fastPassResult?.context?.dblpAuthorPid) {
        return;
    }
    const depthAttemptedAt = Date.now();
    try {
        await persistScanPassResult({
            userId: fastPassResult.context.currentUserId,
            dblpAuthorPid: fastPassResult.context.dblpAuthorPid,
            passResult: fastPassResult,
            scanMetadata: {
                scanStage: 'fast',
                fastCompletedAt,
                depthCompletedAt: null,
                depthAttemptedAt,
                depthCompletionDismissed: false
            }
        });
        const depthPassResult = await runScanPass({
            phase: 'depth',
            sessionId,
            statusElement: null,
            context: fastPassResult.context
        });
        if (!depthPassResult.ok) {
            if (!isCurrentScanSession(sessionId)) {
                return;
            }
            displaySummaryPanel(fastPassResult.coreRankCounts, fastPassResult.sjrRankCounts, fastPassResult.context.currentUserId, fastPassResult.determinedPublicationRanks, fastCompletedAt, fastPassResult.context.dblpAuthorPid, buildScanLifecycleState('failed', getDepthFailureMessage({
                rateLimited: depthPassResult.diagnostics?.rateLimitDetected === true
            })), {
                authorName: fastPassResult.context.scholarAuthorName,
                dblpPidSource: fastPassResult.context.dblpPidSource || null
            });
            return;
        }
        throwIfStaleScanSession(sessionId);
        const depthCompletedAt = Date.now();
        const improvementCount = countAdditionalRanksFound(fastPassResult.determinedPublicationRanks, depthPassResult.determinedPublicationRanks);
        await persistScanPassResult({
            userId: depthPassResult.context.currentUserId,
            dblpAuthorPid: depthPassResult.context.dblpAuthorPid,
            passResult: depthPassResult,
            scanMetadata: {
                scanStage: 'depth',
                fastCompletedAt,
                depthCompletedAt,
                depthAttemptedAt,
                depthCompletionDismissed: false
            }
        });
        if (!isCurrentScanSession(sessionId)) {
            return;
        }
        displaySummaryPanel(depthPassResult.coreRankCounts, depthPassResult.sjrRankCounts, depthPassResult.context.currentUserId, depthPassResult.determinedPublicationRanks, depthCompletedAt, depthPassResult.context.dblpAuthorPid, buildScanLifecycleState('completed', getDepthCompletionMessage(improvementCount, {
            rateLimited: depthPassResult.diagnostics?.rateLimitDetected === true
        }), improvementCount), {
            authorName: depthPassResult.context.scholarAuthorName,
            dblpPidSource: depthPassResult.context.dblpPidSource || null
        });
    }
    catch (error) {
        if (error instanceof ScanSessionCancelledError || !isCurrentScanSession(sessionId)) {
            return;
        }
        console.warn('GSR: Background depth scan failed.', error);
        displaySummaryPanel(fastPassResult.coreRankCounts, fastPassResult.sjrRankCounts, fastPassResult.context.currentUserId, fastPassResult.determinedPublicationRanks, fastCompletedAt, fastPassResult.context.dblpAuthorPid, buildScanLifecycleState('failed', getDepthFailureMessage({
            rateLimited: error instanceof DblpRateLimitError || error instanceof DblpBusyError
        })), {
            authorName: fastPassResult.context.scholarAuthorName,
            dblpPidSource: fastPassResult.context.dblpPidSource || null
        });
    }
}
async function main(options = {}) {
    if (getScholarSurfaceMode() !== 'profile') {
        teardownOffProfileSurfaceUi();
        return;
    }
    if (isMainProcessing) {
        return;
    }
    const sessionId = typeof options.sessionId === 'number' ? options.sessionId : nextScanSessionId();
    activeForegroundScanSessionId = sessionId;
    isMainProcessing = true;
    let foregroundReleased = false;
    await loadSettingsIntoState();
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    dblpPubsForCurrentUser = [];
    scholarUrlToDblpInfoMap.clear();
    const statusElement = createStatusElement("Initializing Scholar Ranker...");
    try {
        const profileContext = await resolveVerifiedProfileContext({ sessionId, statusElement, forceFresh: options.forceFresh === true });
        if (!profileContext.ok) {
            if (profileContext.reason === 'missing-author-name') {
                const statusTextElement = statusElement.querySelector('.gsr-status-text');
                if (statusTextElement)
                    statusTextElement.textContent = "Could not determine Scholar author name from page.";
                return;
            }
            if (profileContext.reason === 'dblp-author-not-found') {
                displayProfileMismatchStatus(statusElement, profileContext.sanitizedName);
            }
            return;
        }
        const fastPassResult = await runScanPass({
            phase: 'fast',
            sessionId,
            statusElement,
            context: profileContext
        });
        if (!fastPassResult.ok) {
            if (fastPassResult.reason === 'no-dblp-publications') {
                setStatusCardTitle(statusElement, "DBLP Publications Unavailable");
                displayNoPublicationsStatus(statusElement, "Could not fetch the matched DBLP publication list.");
            }
            else if (fastPassResult.reason === 'no-publications') {
                displayNoPublicationsStatus(statusElement, "No publications found on profile.");
                setTimeout(() => document.getElementById(STATUS_ELEMENT_ID)?.remove(), 3000);
            }
            return;
        }
        throwIfStaleScanSession(sessionId);
        const fastCompletedAt = Date.now();
        await persistScanPassResult({
            userId: fastPassResult.context.currentUserId,
            dblpAuthorPid: fastPassResult.context.dblpAuthorPid,
            passResult: fastPassResult,
            scanMetadata: {
                scanStage: 'fast',
                fastCompletedAt,
                depthCompletedAt: null,
                depthAttemptedAt: null,
                depthCompletionDismissed: false
            }
        });
        displaySummaryPanel(fastPassResult.coreRankCounts, fastPassResult.sjrRankCounts, fastPassResult.context.currentUserId, fastPassResult.determinedPublicationRanks, fastCompletedAt, fastPassResult.context.dblpAuthorPid, buildScanLifecycleState('running', getDepthRunningMessage()), {
            authorName: fastPassResult.context.scholarAuthorName,
            dblpPidSource: fastPassResult.context.dblpPidSource || null
        });
        releaseForegroundScanSession(sessionId);
        foregroundReleased = true;
        Promise.resolve().then(() => startBackgroundDepthUpgrade({
            sessionId,
            fastPassResult,
            fastCompletedAt
        })).catch((error) => console.warn('GSR: Failed to queue background depth scan.', error));
    }
    catch (error) {
        if (error instanceof ScanSessionCancelledError) {
            return;
        }
        if (error instanceof DblpRateLimitError || error instanceof DblpBusyError) {
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
            appendStatusRescanControls(statusElem);
        }
    }
    finally {
        if (!foregroundReleased) {
            releaseForegroundScanSession(sessionId);
        }
    }
}
async function initialLoad() {
    if (isMainProcessing) {
        return;
    }
    await loadSettingsIntoState();
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    const surfaceMode = getScholarSurfaceMode();
    if (surfaceMode !== 'profile') {
        teardownOffProfileSurfaceUi();
        return;
    }
    const userId = getScholarUserId();
    if (userId) {
        const cached = await loadCachedData(userId);
        if (cached && cached.publicationRanks) {
            const pubRanksArr = unpackRanks(cached.publicationRanks);
            const cachedTimestamp = cached.depthCompletedAt ?? cached.fastCompletedAt ?? cached.timestamp;
            const shouldResumeDepth = cached.scanStage === 'fast' && !!cached.dblpAuthorPid;
            displaySummaryPanel(cached.coreRankCounts, cached.sjrRankCounts, userId, pubRanksArr, cachedTimestamp, cached.dblpAuthorPid, shouldResumeDepth ? buildScanLifecycleState('running', getDepthRunningMessage()) : null, {
                authorName: getScholarAuthorName(),
                dblpPidSource: cached.dblpPidSource || (cached.dblpAuthorPid ? 'cached' : null)
            });
            if (shouldResumeDepth) {
                const sessionId = nextScanSessionId();
                Promise.resolve().then(() => startBackgroundDepthUpgrade({
                    sessionId,
                    fastCompletedAt: cached.fastCompletedAt ?? cached.timestamp,
                    fastPassResult: {
                        coreRankCounts: cached.coreRankCounts,
                        sjrRankCounts: cached.sjrRankCounts,
                        determinedPublicationRanks: pubRanksArr,
                        persistentPublicationRanks: pubRanksArr,
                        context: {
                            currentUserId: userId,
                            dblpAuthorPid: cached.dblpAuthorPid,
                            dblpPidSource: cached.dblpPidSource || (cached.dblpAuthorPid ? 'cached' : null),
                            scholarAuthorName: getScholarAuthorName(),
                            sanitizedName: sanitizeAuthorName(getScholarAuthorName() || ''),
                            baseItems: null,
                            dblpPublications: null,
                            publicationLinkElements: null
                        }
                    }
                })).catch((error) => console.warn('GSR: Failed to resume background depth scan from cache.', error));
            }
            return;
        }
    }
    if (currentSettings.autoRun === false) {
        displayDormantStatus();
        return;
    }
    main().catch(error => {
        if (!(error instanceof DblpRateLimitError) && !(error instanceof DblpBusyError)) {
            console.error("GSR: Error during initial full analysis in main():", error);
            const statusElem = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("A critical error occurred.");
            const statusText = statusElem.querySelector('.gsr-status-text');
            if (statusText)
                statusText.textContent = "Critical Error. Check console.";
            const progressBar = statusElem.querySelector('.gsr-progress-bar-inner');
            if (progressBar)
                progressBar.style.backgroundColor = 'red';
            appendStatusRescanControls(statusElem);
        }
    });
}
function executeInitialLoad() {
    initialLoad();
}
let pageInitializationObserver = null;
if (chrome?.storage?.onChanged && SETTINGS_API?.SETTINGS_KEY) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        const settingsChanged = !!changes[SETTINGS_API.SETTINGS_KEY];
        const rankingPacksChanged = !!changes[FEATURE_STORAGE_KEYS.enabledRankingPacks];
        if (!settingsChanged && !rankingPacksChanged) {
            return;
        }
        await loadSettingsIntoState();
        if (getScholarSurfaceMode() !== 'profile') {
            teardownOffProfileSurfaceUi();
            return;
        }
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
function hasLiveRankingHydration() {
    return !!publicationTableObserver
        || !!(activeCachedPublicationRanks && activeCachedPublicationRanks.length > 0)
        || !!(rankMapForObserver && rankMapForObserver.size > 0)
        || !!document.querySelector('.gsr-rank-badge-inline');
}
function clearStaleInitializationMarkers() {
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    currentSummaryState = null;
}
function attemptPageInitialization() {
    if (getScholarSurfaceMode() !== 'profile') {
        teardownOffProfileSurfaceUi();
        return false;
    }
    const hasInitializationMarker = !!(document.getElementById(STATUS_ELEMENT_ID) || document.getElementById(SUMMARY_PANEL_ID));
    if (isMainProcessing && hasInitializationMarker) {
        return true;
    }
    if (hasInitializationMarker && hasLiveRankingHydration()) {
        return true;
    }
    if (hasInitializationMarker) {
        clearStaleInitializationMarkers();
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
