"use strict";
// scholar-ranker/content.ts
// --- NEW: Custom Error for specific DBLP API failures ---
class DblpRateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DblpRateLimitError';
    }
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
    for (const { url, rank, system, reason } of arr) {
        obj[url] = { rank, system, reason: reason ?? null };
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
// Cache schema bumped for v1.8.2 (adds reason tags per publication)
const CACHE_VERSION = 3;
const CACHE_PREFIX = `scholarRanker_profile_v${CACHE_VERSION}_`;
const CACHE_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const DBLP_CACHE_DURATION_MS = Number.POSITIVE_INFINITY; // never expires
console.log("Google Scholar Ranker: Content script loaded (v1.8.2).");
const coreDataCache = {};
let isMainProcessing = false;
let activeCachedPublicationRanks = null;
let publicationTableObserver = null;
let rankMapForObserver = null; // Maps URL to rank & system
// --- START: DBLP Constants & Globals (UPDATED with new logic) ---
const DBLP_API_AUTHOR_SEARCH_URL = "https://dblp.org/search/author/api";
const DBLP_API_PERSON_PUBS_URL_PREFIX = "https://dblp.org/pid/";
const DBLP_SPARQL_ENDPOINT = "https://sparql.dblp.org/sparql";
const DBLP_HEURISTIC_MIN_OVERLAP_COUNT = 2;
const DBLP_MAX_HUB_VARIANTS_TO_CHECK = 150; // New constant
const HEURISTIC_SCORE_THRESHOLD = 2.5;
const HEURISTIC_MIN_NAME_SIMILARITY = 0.65;
// ---
let dblpPubsForCurrentUser = [];
let scholarUrlToDblpVenueMap = new Map();
let scholarUrlToDblpInfoMap = new Map();
/** --------  STREAM-XML memo cache  -------- */
const streamMetaCache = new Map();
function parseYearFromText(value) {
    if (!value)
        return null;
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
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
                const resp = await fetch(streamXmlUrl);
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
                            const discontinuedYear = parseYearFromText(node.querySelector("disc")?.textContent?.trim());
                            const successorRefs = Array.from(node.querySelectorAll("successor"))
                                .map(extractStreamRef)
                                .filter((ref) => Boolean(ref));
                            if (title || acronym || successorRefs.length || discontinuedYear !== null) {
                                return {
                                    streamType,
                                    streamId,
                                    acronym,
                                    title,
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
                    const indexResp = await fetch(indexUrl);
                    if (indexResp.ok) {
                        const indexXml = await indexResp.text();
                        const indexDoc = new DOMParser().parseFromString(indexXml, "application/xml");
                        if (!indexDoc.querySelector("parsererror")) {
                            const titleAttr = indexDoc.querySelector("bht")?.getAttribute("title")?.trim();
                            const h1Title = indexDoc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
                            const title = titleAttr || h1Title || null;
                            if (title) {
                                return {
                                    streamType,
                                    streamId,
                                    acronym: null,
                                    title,
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
                        const htmlResp = await fetch(htmlUrl);
                        if (!htmlResp.ok)
                            continue;
                        const html = await htmlResp.text();
                        const htmlDoc = new DOMParser().parseFromString(html, 'text/html');
                        const h1 = htmlDoc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
                        const bht = htmlDoc.querySelector('.bht')?.getAttribute('title')?.trim();
                        const title = bht || h1 || null;
                        if (title) {
                            return {
                                streamType,
                                streamId,
                                acronym: null,
                                title,
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
    try {
        await chrome.storage.local.clear();
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
        dblpPubsForCurrentUser = [];
        scholarUrlToDblpVenueMap.clear();
        console.log("GSR INFO: Cleared all cached data from chrome.storage.local for", userId);
        if (chrome.runtime.lastError) {
            //console.error("DEBUG: clearCachedData - chrome.runtime.lastError:", chrome.runtime.lastError.message);
        }
    }
    catch (error) {
        //console.error("DEBUG: clearCachedData - Error:", error);
    }
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
    if (pubYear === null) {
        return 'core/CORE_2023.json';
    } // Default for unknown
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
    } // Or a specific older one if you have it
    return 'core/CORE_2023.json'; // Fallback
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
async function loadCoreDataForFile(coreDataFile) {
    if (coreDataCache[coreDataFile]) {
        return coreDataCache[coreDataFile];
    }
    try {
        const url = chrome.runtime.getURL(coreDataFile);
        const response = await fetch(url);
        if (!response.ok)
            throw new Error(`Failed to fetch ${coreDataFile}: ${response.statusText} (URL: ${url})`);
        const jsonData = await response.json();
        if (!Array.isArray(jsonData)) {
            console.error(`CORE data from ${coreDataFile} is not an array.`, jsonData);
            return [];
        }
        const parsedData = jsonData.map((rawEntry) => {
            const entry = { title: "", acronym: "", rank: "N/A" };
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
                const uRank = fRank.toUpperCase().trim();
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
        const response = await fetch(publicationUrl);
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
        const resp = await fetch(pdfUrl, {
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
async function loadSjrDataset() {
    const byNormalized = new Map();
    const entries = [];
    for (let year = SJR_DATASET_START_YEAR; year <= SJR_DATASET_END_YEAR; year++) {
        const datasetPath = `sjr/scimagojr ${year}.csv`;
        try {
            const url = chrome.runtime.getURL(datasetPath);
            const response = await fetch(url);
            if (!response.ok) {
                console.error(`Failed to fetch ${datasetPath}: ${response.status} ${response.statusText}`);
                continue;
            }
            const text = await response.text();
            const rows = parseSjrCsv(text);
            if (rows.length === 0)
                continue;
            const header = rows[0].map(cell => cell.trim().toLowerCase());
            const titleIndex = header.findIndex(cell => cell === 'title');
            const quartileIndex = header.findIndex(cell => cell === 'sjr best quartile');
            const typeIndex = header.findIndex(cell => cell === 'type');
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
                if (!title)
                    continue;
                const normalizedTitle = normalizeJournalName(title);
                if (!normalizedTitle)
                    continue;
                const quartile = quartileRaw && /^Q[1-4]$/i.test(quartileRaw) ? quartileRaw.toUpperCase() : undefined;
                let entry = byNormalized.get(normalizedTitle);
                if (!entry) {
                    entry = {
                        normalizedTitle,
                        resolvedTitle: title,
                        quartilesByYear: {},
                        tokenSet: createTokenSet(normalizedTitle)
                    };
                    byNormalized.set(normalizedTitle, entry);
                    entries.push(entry);
                }
                else if (title.length > entry.resolvedTitle.length) {
                    entry.resolvedTitle = title;
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
    return { byNormalized, entries };
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
            return { quartile: matchingYear.quartile, year: matchingYear.year };
        }
        const previousYear = entries.find(entry => entry.year < targetYear);
        if (previousYear) {
            return { quartile: previousYear.quartile, year: previousYear.year };
        }
    }
    const latestEntry = entries[0];
    return { quartile: latestEntry.quartile, year: latestEntry.year };
}
function findBestSjrMatch(normalizedQuery, dataset) {
    const directMatch = dataset.byNormalized.get(normalizedQuery);
    if (directMatch) {
        return directMatch;
    }
    const queryTokens = normalizedQuery
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length >= 3);
    const queryTokenSet = new Set(queryTokens);
    const candidates = [];
    for (const entry of dataset.entries) {
        let sharesToken = queryTokens.length === 0;
        if (!sharesToken) {
            for (const token of queryTokenSet) {
                if (entry.tokenSet.has(token)) {
                    sharesToken = true;
                    break;
                }
            }
        }
        if (!sharesToken) {
            continue;
        }
        const score = jaroWinkler(normalizedQuery, entry.normalizedTitle);
        if (score >= 0.98) {
            return entry;
        }
        if (score >= 0.88) {
            candidates.push({ score, entry });
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return best.score >= FUZZY_THRESHOLD ? best.entry : null;
}
async function resolveSjrQuartile(journalName, publicationYear) {
    const variants = generateJournalNormalizationVariants(journalName);
    if (!variants.length)
        return { status: 'not_found' };

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
            const { quartile, year } = selectQuartileForYear(cachedEntry.data, publicationYear ?? null);
            return { status: 'success', quartile, year, resolvedTitle: cachedEntry.data.resolvedTitle };
        }
    }
    try {
        const dataset = await ensureSjrDataset();
        for (const normalizedQuery of variants) {
            const entry = findBestSjrMatch(normalizedQuery, dataset);
            if (!entry)
                continue;
            const data = {
                resolvedTitle: entry.resolvedTitle,
                quartilesByYear: { ...entry.quartilesByYear }
            };
            // Cache the successful match for all variants to avoid repeated fuzzy scans.
            for (const v of variants) {
                sjrLookupCache.set(v, { kind: 'success', data });
            }
            const { quartile, year } = selectQuartileForYear(data, publicationYear ?? null);
            return { status: 'success', quartile, year, resolvedTitle: data.resolvedTitle };
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
function findRankForVenue(venueKey, coreData, fullVenueTitle = undefined) {
    const trimmedVenueKey = venueKey?.trim();
    const keyLower = trimmedVenueKey ? trimmedVenueKey.toLowerCase() : "";
    const isAcronymLike = (cleaned) => {
        if (!cleaned)
            return false;
        const s = String(cleaned);
        if (s.includes(' '))
            return false;
        // Keep this conservative: short single-token venues are almost always acronyms.
        return s.length >= 2 && s.length <= 10 && /^[a-z0-9\-]+$/i.test(s);
    };
    /* ---------- 1. exact-acronym match ---------- */
    if (trimmedVenueKey) {
        const acronymMatches = coreData.filter(e => e.acronym && e.acronym.toLowerCase() === keyLower);
        /* 1-a  single hit → done */
        if (acronymMatches.length === 1) {
            const rank = acronymMatches[0].rank;
            return VALID_RANKS.includes(rank) ? rank : "N/A";
        }
        /* 1-b  ambiguous acronym → log & try title disambiguation */
        if (acronymMatches.length > 1) {
            console.log(`[Rank] Acronym '${venueKey}' matched ${acronymMatches.length} CORE rows.`, acronymMatches.map(e => ({ title: e.title, rank: e.rank })));
            if (fullVenueTitle) {
                const cleanedFull = cleanTextForComparison(fullVenueTitle, false);
                let bestScore = 0;
                let bestEntry = null;
                for (const entry of acronymMatches) {
                    if (!entry.title)
                        continue;
                    const score = jaroWinkler(cleanedFull, cleanTextForComparison(entry.title, false));
                    console.log(`  ↳ JW score vs "${entry.title}": ${score.toFixed(3)}`);
                    if (score > bestScore) {
                        bestScore = score;
                        bestEntry = entry;
                    }
                    if (score === 1)
                        break; // perfect match
                }
                if (bestEntry &&
                    bestScore >= 0.85 &&
                    VALID_RANKS.includes(bestEntry.rank)) {
                    console.log(`[Rank]   ► Disambiguated by title → "${bestEntry.title}" (${bestEntry.rank})`);
                    return bestEntry.rank;
                }
                console.log(`[Rank]   ► Title disambiguation failed (best score ${bestScore.toFixed(3)}). Returning N/A.`);
            }
            else {
                console.log(`[Rank]   ► No fullVenueTitle provided – cannot disambiguate. Returning N/A.`);
            }
            return "N/A"; // ← new behaviour
        }
    }
    const candidates = [];
    if (trimmedVenueKey) {
        candidates.push({ raw: keyLower, isScholar: true });
    }
    if (fullVenueTitle && fullVenueTitle.trim().length > 0) {
        candidates.push({ raw: fullVenueTitle.toLowerCase(), isScholar: false });
    }
    if (candidates.length === 0) {
        return "N/A";
    }
    const trySubstringMatch = (gsCleaned) => {
        // Avoid substring matching for short acronyms and track strings (e.g., ENSsys@SenSys).
        if (isAcronymLike(gsCleaned) || gsCleaned.includes('@'))
            return null;
        let bestSubRank = null;
        let longestLen = 0;
        for (const entry of coreData) {
            if (!entry.title)
                continue;
            const cleanedTitle = stripOrgPrefixes(cleanTextForComparison(entry.title, false));
            const titleVariants = generateCoreTitleVariants(cleanedTitle);
            if (titleVariants.length === 0)
                continue;
            for (const variant of titleVariants) {
                if (!variant)
                    continue;
                if (gsCleaned.includes(variant) && variant.length > longestLen) {
                    longestLen = variant.length;
                    bestSubRank = VALID_RANKS.includes(entry.rank) ? entry.rank : null;
                }
            }
        }
        return bestSubRank;
    };
    const tryFuzzyMatch = (gsCleaned) => {
        // Avoid fuzzy matching for short acronyms and track strings (high false-positive risk).
        if (isAcronymLike(gsCleaned) || gsCleaned.includes('@'))
            return null;
        let bestFuzzy = 0;
        let fuzzyRank = null;
        for (const entry of coreData) {
            if (!entry.title)
                continue;
            const cleanedTitle = stripOrgPrefixes(cleanTextForComparison(entry.title, false));
            const titleVariants = generateCoreTitleVariants(cleanedTitle);
            if (titleVariants.length === 0)
                continue;
            for (const variant of titleVariants) {
                if (!variant || variant.length < 6 || gsCleaned.length < 6)
                    continue;
                const score = jaroWinkler(gsCleaned, variant);
                if (score >= FUZZY_THRESHOLD && score > bestFuzzy) {
                    bestFuzzy = score;
                    fuzzyRank = VALID_RANKS.includes(entry.rank) ? entry.rank : null;
                    if (score === 1)
                        break;
                }
            }
            if (bestFuzzy === 1)
                break;
        }
        return fuzzyRank;
    };
    const seenCleaned = new Set();
    for (const candidate of candidates) {
        const cleaned = cleanTextForComparison(candidate.raw, candidate.isScholar);
        if (!cleaned || seenCleaned.has(cleaned))
            continue;
        seenCleaned.add(cleaned);
        const subRank = trySubstringMatch(cleaned);
        if (subRank)
            return subRank;
        const fuzzyRank = tryFuzzyMatch(cleaned);
        if (fuzzyRank)
            return fuzzyRank;
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

function createRankBadgeElement(rank, system, reason = null) {
    const badge = document.createElement('span');
    badge.textContent = (rank === 'N/A' && system === 'CORE' && reason) ? `N/A → (${reason})` : rank;
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.marginLeft = '10px';
    badge.style.fontSize = '0.9em';
    badge.style.fontWeight = 'bold';
    badge.style.color = '#000000';
    badge.style.verticalAlign = 'middle';
    const applyNeutralStyle = () => {
        badge.style.backgroundColor = '#f0f0f0';
        badge.style.borderColor = '#bdbdbd';
        badge.style.color = '#555';
    };
    if (system === 'SJR' && SJR_QUARTILES.includes(rank)) {
        badge.style.border = '2px solid #ccc';
        badge.style.borderRadius = '50%';
        badge.style.minWidth = '24px';
        badge.style.height = '24px';
        badge.style.fontSize = '0.8em';
        switch (rank) {
            case 'Q1':
                badge.style.backgroundColor = '#FFD700';
                badge.style.borderColor = '#B8860B';
                break;
            case 'Q2':
                badge.style.backgroundColor = '#90EE90';
                badge.style.borderColor = '#3CB371';
                break;
            case 'Q3':
                badge.style.backgroundColor = '#ADFF2F';
                badge.style.borderColor = '#7FFF00';
                break;
            case 'Q4':
                badge.style.backgroundColor = '#FFA07A';
                badge.style.borderColor = '#FA8072';
                break;
        }
        return badge;
    }
    if (system === 'CORE' && VALID_RANKS.includes(rank)) {
        badge.style.border = '1px solid #ccc';
        badge.style.borderRadius = '3px';
        badge.style.padding = '2px 6px';
        badge.style.minWidth = '30px';
        badge.style.textAlign = 'center';
        switch (rank) {
            case "A*":
                badge.style.backgroundColor = '#FFD700';
                badge.style.borderColor = '#B8860B';
                break;
            case "A":
                badge.style.backgroundColor = '#90EE90';
                badge.style.borderColor = '#3CB371';
                break;
            case "B":
                badge.style.backgroundColor = '#ADFF2F';
                badge.style.borderColor = '#7FFF00';
                break;
            case "C":
                badge.style.backgroundColor = '#FFA07A';
                badge.style.borderColor = '#FA8072';
                break;
        }
        return badge;
    }
    if (rank === 'N/A') {
        badge.style.border = system === 'SJR' ? '2px solid #ccc' : '1px solid #ccc';
        // If we have a reason tag, keep it as a pill (not a tiny square/circle) for readability.
        const usePill = system === 'CORE' && !!reason;
        badge.style.borderRadius = (system === 'SJR' && !usePill) ? '50%' : '10px';
        badge.style.padding = system === 'SJR' ? '0' : '2px 6px';
        badge.style.minWidth = system === 'SJR' ? '24px' : (usePill ? 'auto' : '30px');
        badge.style.height = system === 'SJR' ? '24px' : '';
        if (system === 'SJR') {
            badge.style.fontSize = '0.8em';
        }
        badge.style.textAlign = system === 'SJR' ? 'center' : 'center';
        applyNeutralStyle();
        return badge;
    }
    return null;
}
function displayRankBadgeAfterTitle(rowElement, rank, system, reason = null) {
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
    const badge = createRankBadgeElement(rank, system, reason); // This can return N/A badge or null
    if (badge) {
        badge.classList.add('gsr-rank-badge-inline');
        badge.style.marginLeft = '8px';
        titleLinkElement.insertAdjacentElement('afterend', badge);
    }
}
function createStatusElement(initialMessage = "Initializing...") {
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    const container = document.createElement('div');
    container.id = STATUS_ELEMENT_ID;
    container.classList.add('gsc_rsb_s', 'gsc_prf_pnl');
    container.style.padding = '10px';
    container.style.marginBottom = '15px';
    const title = document.createElement('div');
    title.textContent = "Rank Processing";
    title.style.fontSize = '14px';
    title.style.fontWeight = 'bold';
    title.style.color = '#777';
    title.style.marginBottom = '8px';
    container.appendChild(title);
    const progressBarOuter = document.createElement('div');
    progressBarOuter.style.width = '100%';
    progressBarOuter.style.backgroundColor = '#e0e0e0';
    progressBarOuter.style.borderRadius = '4px';
    progressBarOuter.style.height = '10px';
    progressBarOuter.style.overflow = 'hidden';
    container.appendChild(progressBarOuter);
    const progressBarInner = document.createElement('div');
    progressBarInner.classList.add('gsr-progress-bar-inner');
    progressBarInner.style.width = '0%';
    progressBarInner.style.height = '100%';
    progressBarInner.style.backgroundColor = '#76C7C0';
    progressBarInner.style.transition = 'width 0.2s ease-out';
    progressBarOuter.appendChild(progressBarInner);
    const statusText = document.createElement('div');
    statusText.classList.add('gsr-status-text');
    statusText.textContent = initialMessage;
    statusText.style.marginTop = '5px';
    statusText.style.fontSize = '12px';
    statusText.style.color = '#555';
    statusText.style.textAlign = 'center';
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
        statusText.textContent = `${prefix}Processing ${processed} / ${total}...`;
}
function displaySummaryPanel(coreRankCounts, sjrRankCounts, currentUserId, initialCachedPubRanks, cacheTimestamp, dblpAuthorPid // New parameter for DBLP PID
) {
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    disconnectPublicationTableObserver();
    const panel = document.createElement('div');
    panel.id = SUMMARY_PANEL_ID;
    panel.classList.add('gsc_rsb_s', 'gsc_prf_pnl');
    panel.style.padding = '10px';
    panel.style.marginBottom = '15px';
    const headerDiv = document.createElement('div');
    headerDiv.style.display = 'flex';
    headerDiv.style.alignItems = 'center';
    headerDiv.style.justifyContent = 'space-between';
    headerDiv.style.fontSize = '14px';
    headerDiv.style.fontWeight = 'bold';
    headerDiv.style.color = '#777';
    headerDiv.style.marginBottom = '10px';
    headerDiv.style.paddingBottom = '5px';
    headerDiv.style.borderBottom = '1px solid #e0e0e0';
    const summaryTitle = document.createElement('span');
    summaryTitle.textContent = 'Ranking Summary';
    headerDiv.appendChild(summaryTitle);
    if (currentUserId) {
        const refreshButton = document.createElement('button');
        refreshButton.textContent = 'Refresh Ranks';
        refreshButton.style.marginLeft = 'auto';
        refreshButton.style.padding = '2px 8px';
        refreshButton.style.fontSize = '0.7em';
        refreshButton.style.fontWeight = '600';
        refreshButton.style.color = '#006400';
        refreshButton.style.backgroundColor = '#90EE90';
        refreshButton.style.border = '1px solid #77dd77';
        refreshButton.style.borderRadius = '10px';
        refreshButton.style.lineHeight = '1.4';
        refreshButton.style.height = 'fit-content';
        refreshButton.style.display = 'inline-flex';
        refreshButton.style.alignItems = 'center';
        refreshButton.style.cursor = 'pointer';
        refreshButton.setAttribute('title', 'Recalculate rankings');
        refreshButton.onmouseenter = () => { refreshButton.style.backgroundColor = '#7CFC00'; refreshButton.style.borderColor = '#006400'; };
        refreshButton.onmouseleave = () => { refreshButton.style.backgroundColor = '#90EE90'; refreshButton.style.borderColor = '#77dd77'; };
        refreshButton.onclick = async () => {
            if (isMainProcessing)
                return;
            // Clear existing UI elements or states immediately
            disconnectPublicationTableObserver();
            activeCachedPublicationRanks = null;
            rankMapForObserver = null;
            // Remove status/summary panels to prepare for fresh UI from main()
            document.getElementById(STATUS_ELEMENT_ID)?.remove();
            document.getElementById(SUMMARY_PANEL_ID)?.remove();
            console.log("GSR: Refresh Ranks clicked. Clearing cached data for user:", currentUserId);
            if (currentUserId) { // Ensure currentUserId is still valid before clearing
                await clearCachedData(currentUserId); // Clear Chrome storage for this user
                console.log("GSR: Cached data cleared for user:", currentUserId);
            }
            else {
                console.warn("GSR: currentUserId not available, cannot clear cached data specifically.");
            }
            console.log("GSR: Proceeding to run main() for fresh ranking.");
            main().catch(error => {
                console.error("DEBUG: Error during refresh after cache clear:", error);
                // createStatusElement will be called by main(), but if main itself fails early,
                // we might need a fallback or ensure createStatusElement is robust.
                // For now, main()'s error handling should create the error UI.
                // If main() fails very early (before it can create its own status element), this might be needed:
                const statusElemCheck = document.getElementById(STATUS_ELEMENT_ID);
                if (!statusElemCheck) {
                    const statusElem = createStatusElement("Error during refresh. Check console.");
                    if (statusElem.querySelector('.gsr-progress-bar-inner'))
                        statusElem.querySelector('.gsr-progress-bar-inner').style.backgroundColor = 'red';
                }
            });
        };
        // --- END OF MODIFIED onClick HANDLER ---
        headerDiv.appendChild(refreshButton);
    }
    panel.appendChild(headerDiv);
    const summarySectionsContainer = document.createElement('div');
    summarySectionsContainer.style.display = 'flex';
    summarySectionsContainer.style.flexDirection = 'column';
    summarySectionsContainer.style.gap = '16px';
    summarySectionsContainer.style.marginTop = '8px';
    const createSummarySection = (titleText, counts, orderedRanks, system) => {
        const sectionWrapper = document.createElement('div');
        const sectionTitle = document.createElement('div');
        sectionTitle.textContent = titleText;
        sectionTitle.style.fontSize = '13px';
        sectionTitle.style.fontWeight = '600';
        sectionTitle.style.color = '#555';
        sectionTitle.style.marginBottom = '6px';
        sectionWrapper.appendChild(sectionTitle);
        const list = document.createElement('ul');
        list.style.listStyle = 'none';
        list.style.padding = '0';
        list.style.margin = '0';
        const displayRanks = orderedRanks.filter(rank => rank !== 'N/A');
        let maxCountForScale = Math.max(10, ...displayRanks.map(rank => counts[rank] || 0));
        if (!Number.isFinite(maxCountForScale) || maxCountForScale <= 0)
            maxCountForScale = 10;
        for (const rank of displayRanks) {
            const count = counts[rank] || 0;
            const listItem = document.createElement('li');
            listItem.style.display = 'flex';
            listItem.style.alignItems = 'center';
            listItem.style.fontSize = '13px';
            listItem.style.marginBottom = '6px';
            const badge = createRankBadgeElement(rank, system);
            if (badge) {
                badge.style.marginLeft = '0';
                badge.style.marginRight = '8px';
                badge.style.fontSize = '0.85em';
                listItem.appendChild(badge);
            }
            else {
                const rankLabel = document.createElement('span');
                rankLabel.textContent = `${rank}:`;
                rankLabel.style.fontWeight = 'bold';
                rankLabel.style.marginRight = '8px';
                listItem.appendChild(rankLabel);
            }
            const barContainer = document.createElement('div');
            barContainer.style.flexGrow = '1';
            barContainer.style.backgroundColor = '#f0f0f0';
            barContainer.style.height = '16px';
            barContainer.style.borderRadius = '2px';
            barContainer.style.marginRight = '8px';
            const barFill = document.createElement('div');
            const badgeColor = badge?.style.backgroundColor || (system === 'SJR' ? '#9d8df1' : '#76C7C0');
            const percentageWidth = maxCountForScale > 0 ? (count / maxCountForScale) * 100 : 0;
            barFill.style.width = `${Math.min(percentageWidth, 100)}%`;
            barFill.style.height = '100%';
            barFill.style.backgroundColor = badgeColor;
            barFill.style.borderRadius = '2px';
            barFill.style.transition = 'width 0.5s ease-out';
            barContainer.appendChild(barFill);
            listItem.appendChild(barContainer);
            const countTextSpan = document.createElement('span');
            countTextSpan.textContent = `${count} paper${count === 1 ? '' : 's'}`;
            countTextSpan.style.minWidth = '60px';
            countTextSpan.style.textAlign = 'right';
            listItem.appendChild(countTextSpan);
            list.appendChild(listItem);
        }
        sectionWrapper.appendChild(list);
        return sectionWrapper;
    };
    summarySectionsContainer.appendChild(createSummarySection('Conference Ranking (CORE)', coreRankCounts, ['A*', 'A', 'B', 'C', 'N/A'], 'CORE'));
    summarySectionsContainer.appendChild(createSummarySection('Journal Ranking (SJR)', sjrRankCounts, ['Q1', 'Q2', 'Q3', 'Q4', 'N/A'], 'SJR'));
    panel.appendChild(summarySectionsContainer);
    // --- START: DBLP Link and Timestamp section ---
    if (dblpAuthorPid || cacheTimestamp) {
        const middleBarContainer = document.createElement('div');
        const greyLineTop = document.createElement('div');
        greyLineTop.style.borderTop = '1px solid #e0e0e0';
        greyLineTop.style.marginTop = '12px'; // Space from list
        greyLineTop.style.marginBottom = '6px'; // Space before dblp/timestamp text
        middleBarContainer.appendChild(greyLineTop);
        const dblpTimestampTextRow = document.createElement('div');
        dblpTimestampTextRow.style.display = 'flex';
        dblpTimestampTextRow.style.justifyContent = 'space-between';
        dblpTimestampTextRow.style.alignItems = 'center';
        dblpTimestampTextRow.style.fontSize = '11px';
        dblpTimestampTextRow.style.color = '#6c757d';
        dblpTimestampTextRow.style.marginBottom = '10px'; // Space before checker section's border/padding
        if (dblpAuthorPid) {
            const dblpProfileLink = document.createElement('a');
            // Construct DBLP profile URL. Standard DBLP person pages are /pid/{pid}.html
            // or /pers/hd/{initial}/{full_pid_path} but /pid/ is more canonical for linking.
            dblpProfileLink.href = `https://dblp.org/pid/${dblpAuthorPid}.html`;
            dblpProfileLink.target = "_blank";
            dblpProfileLink.textContent = "DBLP Profile";
            dblpProfileLink.style.textDecoration = 'none';
            dblpProfileLink.style.color = '#007bff'; // Standard hyperlink blue
            dblpTimestampTextRow.appendChild(dblpProfileLink);
        }
        else {
            // Add an empty div on the left if no DBLP link, to keep timestamp on the right
            dblpTimestampTextRow.appendChild(document.createElement('div'));
        }
        if (cacheTimestamp) {
            const timestampTextElement = document.createElement('div');
            const lastRankingTime = new Date(cacheTimestamp);
            const formattedDate = lastRankingTime.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            const formattedTime = lastRankingTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
            timestampTextElement.textContent = `Ranks last updated: ${formattedDate} ${formattedTime}`;
            dblpTimestampTextRow.appendChild(timestampTextElement);
        }
        else {
            // Add an empty div on the right if DBLP link exists but no timestamp, to balance flexbox
            if (dblpAuthorPid) {
                dblpTimestampTextRow.appendChild(document.createElement('div'));
            }
        }
        middleBarContainer.appendChild(dblpTimestampTextRow);
        panel.appendChild(middleBarContainer);
    }
    // --- END: DBLP Link and Timestamp section ---
    const finalFooterDiv = document.createElement('div');
    finalFooterDiv.style.display = 'flex';
    finalFooterDiv.style.justifyContent = 'flex-end';
    finalFooterDiv.style.alignItems = 'center';
    finalFooterDiv.style.marginTop = '15px';
    finalFooterDiv.style.paddingTop = '5px';
    finalFooterDiv.style.borderTop = '1px solid #e0e0e0';
    const betaLabel = document.createElement('span');
    betaLabel.textContent = 'BETA';
    betaLabel.style.padding = '1px 7px';
    betaLabel.style.fontSize = '0.7em';
    betaLabel.style.fontWeight = '600';
    betaLabel.style.color = '#fff';
    betaLabel.style.backgroundColor = '#6c757d';
    betaLabel.style.borderRadius = '10px';
    betaLabel.style.lineHeight = '1.4';
    betaLabel.style.height = 'fit-content';
    betaLabel.style.display = 'inline-flex';
    betaLabel.style.alignItems = 'center';
    betaLabel.style.marginRight = '10px';
    betaLabel.style.cursor = 'help';
    betaLabel.setAttribute('title', "Developed by Naveed Anwar Bhatti.\nIt is free and open source.\nIt uses historical CORE rankings (2014-2023) and SCImago journal quartiles for reliability.\nHelp us spot inconsistencies!\nFor any issues, please click on “Report Bug”.");
    finalFooterDiv.appendChild(betaLabel);
    const reportBugLink = document.createElement('a');
    reportBugLink.href = "https://forms.office.com/r/PbSzWaQmpJ";
    reportBugLink.target = "_blank";
    reportBugLink.style.textDecoration = 'none';
    reportBugLink.style.color = '#D32F2F';
    reportBugLink.style.fontSize = '0.8em';
    reportBugLink.innerHTML = '🐞 Report Bug';
    reportBugLink.setAttribute('title', 'Report a bug or inconsistency (opens new tab)');
    finalFooterDiv.appendChild(reportBugLink);
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
                rankMapForObserver.set(pubRank.url, { rank: pubRank.rank, system: pubRank.system, reason: pubRank.reason ?? null });
            }
        });
        restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks);
        setupPublicationTableObserver(); // Call the revised function directly
    }
    else {
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
    }
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
        statusText.innerHTML = `DBLP is overwhelmed (Too Many Requests).<br>Give it some time to recover!`;
        statusText.style.color = '#D2691E';
    }
    // Add a "Try Again" button to the status panel
    let tryAgainButton = statusElement.querySelector('.gsr-try-again-button');
    if (!tryAgainButton) {
        tryAgainButton = document.createElement('button');
        tryAgainButton.textContent = 'Try Again';
        tryAgainButton.className = 'gsr-try-again-button';
        tryAgainButton.style.marginTop = '10px';
        tryAgainButton.style.padding = '5px 10px';
        tryAgainButton.style.fontSize = '12px';
        tryAgainButton.style.cursor = 'pointer';
        tryAgainButton.style.border = '1px solid #ccc';
        tryAgainButton.style.borderRadius = '5px';
        tryAgainButton.onclick = () => {
            if (isMainProcessing)
                return;
            console.log("GSR: 'Try Again' clicked. Rerunning main process.");
            main().catch(error => console.error("GSR: Error during manual retry:", error));
        };
        statusElement.appendChild(tryAgainButton);
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
        if (reapplyDebounceTimeout) {
            clearTimeout(reapplyDebounceTimeout);
        }
        reapplyDebounceTimeout = window.setTimeout(() => {
            if (activeCachedPublicationRanks && rankMapForObserver && rankMapForObserver.size > 0) {
                restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks);
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
function restoreVisibleInlineBadgesFromCache(cachedRanks) {
    const allVisibleRows = document.querySelectorAll('tr.gsc_a_tr');
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
                displayRankBadgeAfterTitle(rowElement, cachedRank.rank, cachedRank.system, cachedRank.reason ?? null);
                badgesAppliedCount++;
            }
        }
    });
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
        const resp = await fetch(url.toString());
        if (resp.status === 429) {
            throw new DblpRateLimitError("DBLP API rate limit hit during author search.");
        }
        if (!resp.ok) {
            console.error(`DBLP author search failed with status: ${resp.status}`);
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
        throw new Error("DBLP connection failed during author search.");
    }
}
async function fetchDblpPubsForCheck(pid) {
    const authorUri = `https://dblp.org/pid/${pid}`;
    const query = `PREFIX dblp: <https://dblp.org/rdf/schema#> SELECT ?title ?year WHERE { ?paper dblp:authoredBy <${authorUri}> . ?paper dblp:title ?title . OPTIONAL { ?paper dblp:yearOfPublication ?year . } } LIMIT 200`;
    const url = `${DBLP_SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&output=json`;
    try {
        const response = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
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
        const response = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } });
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
// in content.ts
async function findBestDblpProfile(scholarName, scholarSamplePubs) {
    const candidates = await searchDblpForCandidates(scholarName);
    let bestPid = null;
    let highestScore = 0;
    const scholarTitles = scholarSamplePubs.map(p => p.title);
    for (const [index, candidate] of candidates.entries()) {
        const dblpName = candidate.info.author.replace(/\s\d{4}$/, '').replace(/\s+\(Variant \d+\)$/, '').trim();
        const pid = extractPidFromUrl(candidate.info.url);
        if (!pid)
            continue;
        const nameSimilarity = jaroWinkler(scholarName.toLowerCase(), dblpName.toLowerCase());
        if (nameSimilarity < HEURISTIC_MIN_NAME_SIMILARITY)
            continue;
        let dblpPublications;
        try {
            // This is the "check" part of "guess and check". It will throw an error if the PID does not exist.
            dblpPublications = await fetchDblpPubsForCheck(pid);
            if (dblpPublications.length === 0)
                continue; // Valid PID but no publications, skip.
        }
        catch (error) {
            // This PID is invalid or fetch failed. This is expected. We just continue to the next guess.
            continue;
        }
        let currentScore = nameSimilarity * 2.0;
        let overlapCount = 0;
        for (const scholarTitle of scholarTitles) {
            for (const dblpPub of dblpPublications) {
                if (jaroWinkler(normalizeText(scholarTitle), normalizeText(dblpPub.title)) > 0.85) {
                    overlapCount++;
                    currentScore += 1.0;
                    break;
                }
            }
        }
        const qualifies = overlapCount >= DBLP_HEURISTIC_MIN_OVERLAP_COUNT;
        const eps = 1e-9;
        if (qualifies) {
            const better =
                (currentScore > highestScore + eps) ||
                    (Math.abs(currentScore - highestScore) <= eps && bestPid !== null && pid < bestPid) ||
                    (Math.abs(currentScore - highestScore) <= eps && bestPid === null);
            if (better) {
                highestScore = currentScore;
                bestPid = pid;
                console.log(`GSR: New best DBLP candidate found! PID: ${pid}, Score: ${currentScore.toFixed(2)}, Overlap: ${overlapCount}`);
            }
        }
    }
    if (bestPid && highestScore >= HEURISTIC_SCORE_THRESHOLD) {
        console.log(`GSR: DBLP Heuristic Match SUCCESS for "${scholarName}" -> PID: ${bestPid}, Score: ${highestScore.toFixed(2)}`);
        return bestPid;
    }
    else {
        console.log(`GSR: DBLP heuristic matching failed for "${scholarName}". Best score ${highestScore.toFixed(2)}.`);
        return null;
    }
}
async function fetchPublicationsFromDblp(authorPidPath, statusElement) {
    const statusTextEl = statusElement?.querySelector(".gsr-status-text");
    if (statusTextEl) {
        statusTextEl.textContent = `DBLP: Fetching publications for PID ${authorPidPath}…`;
    }
    const xmlUrl = `${DBLP_API_PERSON_PUBS_URL_PREFIX}${authorPidPath}.xml`;
    const publications = [];
    try {
        const response = await fetch(xmlUrl);
        if (response.status === 429) {
            throw new DblpRateLimitError(`DBLP XML download rate limit hit for PID ${authorPidPath}.`);
        }
        if (!response.ok) {
            console.warn(`DBLP: Fetching publications XML failed for PID "${authorPidPath}": ${response.statusText} (${response.status})`);
            if (statusTextEl)
                statusTextEl.textContent = "DBLP: XML fetch failed.";
            return [];
        }
        const xmlText = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "application/xml");
        if (xmlDoc.querySelector("parsererror")) {
            console.error("DBLP: XML parse error for PID", authorPidPath);
            if (statusTextEl)
                statusTextEl.textContent = "DBLP: XML parse error.";
            return [];
        }
        const items = Array.from(xmlDoc.querySelectorAll("dblpperson > r > *"));
        for (const item of items) {
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
            const issue = item.querySelector('number')?.textContent?.trim();
            const crossref = item.querySelector("crossref")?.textContent?.trim() || null;
            const dblpType = item.tagName ? item.tagName.toLowerCase() : null;

            let acronym = null;
            let venue_full = null;

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
            }

            if (!acronym && rawVenue?.startsWith('Proc. ACM') && issue && /^[A-Za-z]{2,}$/.test(issue)) {
                acronym = issue;
            }
            publications.push({ dblpKey, title, venue: rawVenue, year, pages, venue_full, acronym, crossref, dblpType });
        }
        if (statusTextEl) {
            statusTextEl.textContent = `DBLP: Fetched ${publications.length} publications.`;
        }
    }
    catch (err) {
        if (err instanceof DblpRateLimitError)
            throw err;
        console.error("DBLP: Error fetching/parsing XML:", err);
        if (statusTextEl)
            statusTextEl.textContent = "DBLP: Error fetching pubs.";
        throw new DblpRateLimitError("DBLP connection failed during XML download.");
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
    let match = pageStr.match(/^(?:[a-z\d]+:)?(\d+)\s*[-‑–—]\s*(?:[a-z\d]+:)?(\d+)$/i);
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
        const best = utils?.selectBestDblpMatch
            ? utils.selectBestDblpMatch({
                scholarTitle: scholarPub.titleText,
                scholarYear: scholarPub.yearFromProfile,
                dblpPublications: sortedDblp,
                similarityThreshold: 0.88,
                maxYearDiff: 2
            })
            : null;
        if (!best || !best.dblpKey)
            continue;
        const pageCount = getPageCountFromDblpString(best.pages);
        mapToFill.set(scholarPub.url, {
            venue: best.venue,
            pages: best.pages ?? null,
            pageCount: pageCount,
            dblpKey: best.dblpKey,
            venue_full: best.venue_full,
            acronym: best.acronym,
            dblpType: best.dblpType ?? null,
            crossref: best.crossref ?? null
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
        if (currentUserId) {
            const scholarAuthorName = getScholarAuthorName();
            const sanitizedName = scholarAuthorName ? sanitizeAuthorName(scholarAuthorName) : null;
            if (sanitizedName) {
                const cachedUserData = await loadCachedData(currentUserId);
                if (cachedUserData?.dblpAuthorPid && cachedUserData.dblpMatchTimestamp && (Date.now() - cachedUserData.dblpMatchTimestamp) < DBLP_CACHE_DURATION_MS) {
                    cachedDblpPidForSave = cachedUserData.dblpAuthorPid;
                    console.log("GSR INFO: Using valid cached DBLP PID:", cachedDblpPidForSave);
                }
                else {
                    if (cachedUserData?.dblpAuthorPid)
                        console.log("GSR INFO: Cached DBLP PID is stale or missing timestamp. Will attempt fresh DBLP author match.");
                    else
                        console.log("GSR INFO: No valid cached DBLP PID. Attempting fresh DBLP author match for:", sanitizedName);
                    if (statusTextElement)
                        statusTextElement.textContent = `DBLP: Searching for ${sanitizedName}...`;
                    const scholarSamplePubs = getScholarSamplePublications(7);
                    if (scholarSamplePubs.length >= DBLP_HEURISTIC_MIN_OVERLAP_COUNT) {
                        cachedDblpPidForSave = await findBestDblpProfile(sanitizedName, scholarSamplePubs);
                    }
                    else {
                        if (statusTextElement)
                            statusTextElement.textContent = "DBLP: Not enough unique Scholar publications for match attempt.";
                    }
                }
                if (cachedDblpPidForSave) {
                    if (statusTextElement && dblpPubsForCurrentUser.length === 0)
                        statusTextElement.textContent = `DBLP: Fetching publications for PID ${cachedDblpPidForSave}...`;
                    dblpPubsForCurrentUser = await fetchPublicationsFromDblp(cachedDblpPidForSave, statusElement);
                }
                else {
                    // --- START: MODIFIED BLOCK ---
                    // This block now halts execution if no DBLP profile is found.
                    if (statusTextElement && sanitizedName) {
                        // 1. Update the status panel to reflect a final state.
                        const title = statusElement.querySelector('div:first-child');
                        if (title) {
                            title.textContent = "DBLP Author Not Found";
                        }
                        const progressBar = statusElement.querySelector('.gsr-progress-bar-inner');
                        if (progressBar && progressBar.parentElement) {
                            progressBar.parentElement.style.display = 'none'; // Hide progress bar
                        }
                        // 2. Display the clear, user-friendly message.
                        statusTextElement.innerHTML = `Apologies, we could not find a matching author profile on DBLP for "<b>${sanitizedName}</b>".`;
                        statusTextElement.style.color = '#D2691E';
                    }
                    // 3. Halt all further processing. The 'finally' block will still execute.
                    return;
                    // --- END: MODIFIED BLOCK ---
                }
            }
            else {
                if (statusTextElement)
                    statusTextElement.textContent = "Could not determine Scholar author name from page.";
            }
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
            const defaultResult = { rank: "N/A", system: 'UNKNOWN', reason: null, rowElement: pubInfo.rowElement, titleText: pubInfo.titleText, url: pubInfo.url, shouldPersist: true };
            if (titlesAlreadyProcessedSet.has(pubInfo.titleText)) {
                return defaultResult;
            }
            let currentRank = "N/A";
            let rankingSystem = 'UNKNOWN';
            let naReason = null;
            let dblpKeyUsedForThisRanking = null;
            let shouldPersist = true;
            try {
                const dblpInfo = scholarUrlToDblpInfoMap.get(pubInfo.url);
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
                    const isJournal = dblpKeyLower.startsWith('journals/');
                    if (isJournal) {
                        if (isArxivLikeVenue(dblpInfo)) {
                            return defaultResult;
                        }
                        rankingSystem = 'SJR';
                        const candidateNames = Array.from(new Set([dblpInfo.venue_full, venueName, dblpInfo.acronym].filter((name) => !!name && name.trim().length > 0)));
                        let sjrLookupTransientFailure = false;
                        for (const candidate of candidateNames) {
                            const sjrResult = await resolveSjrQuartile(candidate, publicationYear ?? null);
                            if (sjrResult.status === 'success' && sjrResult.quartile && SJR_QUARTILES.includes(sjrResult.quartile)) {
                                currentRank = sjrResult.quartile;
                                sjrLookupTransientFailure = false;
                                break;
                            }
                            if (sjrResult.status === 'error' && sjrResult.transient) {
                                sjrLookupTransientFailure = true;
                            }
                        }
                        if (currentRank === 'N/A' && sjrLookupTransientFailure) {
                            shouldPersist = false;
                        }
                    }
                    else {
                        rankingSystem = 'CORE';
                        const effectiveYear = publicationYear;
                        const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
                        const trackInfo = utils?.classifyVenueTrack
                            ? utils.classifyVenueTrack({
                                title: pubInfo.titleText,
                                venue: dblpInfo.venue,
                                venue_full: dblpInfo.venue_full,
                                acronym: dblpInfo.acronym,
                                dblpKey: dblpInfo.dblpKey,
                                dblpType: dblpInfo.dblpType,
                                crossref: dblpInfo.crossref,
                                scholarVenue: null,
                                pageCount: pageCount
                            })
                            : { isWorkshop: false, isDemoPoster: false, isShortPaper: false, reason: null, resolvedVenue: null, parentVenue: null, seriesId: null, signals: [] };
                        naReason = trackInfo.reason;
                        // Demo/Poster tracks should not inherit the parent conference rank.
                        if (trackInfo.isDemoPoster) {
                            return { rank: "N/A", system: 'CORE', reason: naReason || 'Demo/Poster', rowElement: pubInfo.rowElement, titleText: pubInfo.titleText, url: pubInfo.url, shouldPersist: true };
                        }
                        const coreDataFile = getCoreDataFileForYear(effectiveYear);
                        const yearSpecificCoreData = await loadCoreDataForFile(coreDataFile);
                        if (yearSpecificCoreData.length > 0) {
                                const fullVenueTitleForRanking = dblpInfo.venue_full ?? null;
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
                                for (const candidate of rankingCandidates) {
                                    const attempt = findRankForVenue(candidate, yearSpecificCoreData, fullVenueTitleForRanking);
                                    if (VALID_RANKS.includes(attempt)) {
                                        resolvedRank = attempt;
                                        break;
                                    }
                                    if (resolvedRank === null && attempt !== "N/A") {
                                        resolvedRank = attempt;
                                    }
                                }
                                currentRank = resolvedRank ?? "N/A";
                                // If this is a workshop and we didn't find a CORE rank for the workshop itself, mark as N/A (Workshop)
                                if (currentRank === 'N/A' && trackInfo.isWorkshop) {
                                    naReason = naReason || 'Workshop';
                                }
                        }
                        // Page-length override (strictly < 6 pages) unless already classified as Demo/Poster or Workshop.
                        if (pageCount !== null && pageCount < 6 && !trackInfo.isDemoPoster && !trackInfo.isWorkshop) {
                            currentRank = 'N/A';
                            naReason = 'Short-paper';
                        }
                    }
                } else {

                    // Fallback: Scholar metadata parsing when DBLP is missing.
                    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
                    const scholarMeta = await fetchVenueAndYear(pubInfo.url);
                    const scholarVenue = scholarMeta.venueName;
                    if (scholarVenue) {
                        const venueLabel = (scholarMeta.venueLabel || '').toLowerCase();
                        let publicationYear = scholarMeta.publicationYear ?? pubInfo.yearFromProfile;

                        // Page count best-effort (preferred: PDF on scholar.googleusercontent.com).
                        const pdfPageCount = await tryGetPdfPageCount(scholarMeta.pdfUrl);
                        const pageCount = (pdfPageCount !== null && Number.isFinite(pdfPageCount)) ? pdfPageCount : null;

                        const trackInfo = utils?.classifyVenueTrack
                            ? utils.classifyVenueTrack({
                                title: pubInfo.titleText,
                                venue: null,
                                venue_full: null,
                                acronym: null,
                                dblpKey: '',
                                scholarVenue: scholarVenue,
                                pageCount: pageCount
                            })
                            : { isWorkshop: false, isDemoPoster: false, isShortPaper: false, reason: null, resolvedVenue: null, parentVenue: null, seriesId: null, signals: [] };

                        naReason = trackInfo.reason;

                        // Demo/Poster tracks should be N/A and should not inherit parent conference rank.
                        if (trackInfo.isDemoPoster) {
                            rankingSystem = 'CORE';
                            currentRank = 'N/A';
                            naReason = naReason || 'Demo/Poster';
                        } else {
                            const looksLikeJournal = venueLabel === 'journal' ||
                                /\b(journal|transactions)\b/i.test(scholarVenue) ||
                                venueLabel === 'source';

                            if (looksLikeJournal) {
                                // Journal ranking via SJR (local dataset).
                                const normalized = normalizeJournalName(scholarVenue);
                                const padded = ` ${normalized} `;
                                const arxivLike =
                                    ARXIV_NORMALIZED_VALUES.has(normalized) ||
                                    ARXIV_PLAIN_KEYWORDS.some(k => padded.includes(k));
                                if (arxivLike) {
                                    return defaultResult;
                                }

                                rankingSystem = 'SJR';
                                const sjrResult = await resolveSjrQuartile(scholarVenue, publicationYear ?? null);
                                if (sjrResult.status === 'success' && sjrResult.quartile && SJR_QUARTILES.includes(sjrResult.quartile)) {
                                    currentRank = sjrResult.quartile;
                                } else {
                                    currentRank = 'N/A';
                                    if (sjrResult.status === 'error' && sjrResult.transient) {
                                        shouldPersist = false;
                                    }
                                }
                            } else {
                                // Conference/workshop ranking via CORE.
                                rankingSystem = 'CORE';
                                const coreDataFile = getCoreDataFileForYear(publicationYear);
                                const yearSpecificCoreData = await loadCoreDataForFile(coreDataFile);

                                if (yearSpecificCoreData.length > 0) {
                                    const fullVenueTitleForRanking = null;
                                    const rankingCandidates = [];
                                    const pushCandidate = (candidate) => {
                                        if (!candidate) return;
                                        const trimmed = candidate.trim();
                                        if (!trimmed) return;
                                        const lower = trimmed.toLowerCase();
                                        if (!rankingCandidates.some(existing => existing.toLowerCase() === lower)) {
                                            rankingCandidates.push(trimmed);
                                        }
                                    };
                                    const expandVenue = (candidate, opts) => {
                                        if (!candidate) return;
                                        const variants = utils?.expandVenueCandidates ? utils.expandVenueCandidates(candidate, opts) : [candidate];
                                        for (const v of variants) pushCandidate(v);
                                    };

                                    const inheritWorkshopParentRank = INHERIT_PARENT_CONFERENCE_RANK_FOR_WORKSHOPS;

                                    if (trackInfo.isWorkshop && !inheritWorkshopParentRank) {
                                        if (trackInfo.resolvedVenue) expandVenue(trackInfo.resolvedVenue, { includeAtParent: false });
                                        if (trackInfo.seriesId && (!trackInfo.resolvedVenue || trackInfo.seriesId.toLowerCase() === trackInfo.resolvedVenue.toLowerCase())) {
                                            expandVenue(trackInfo.seriesId, { includeAtParent: false });
                                        }
                                        // Add the raw scholar venue only if it doesn't explicitly include "@Parent".
                                        if (scholarVenue && !(trackInfo.parentVenue && scholarVenue.toLowerCase().includes(`@${trackInfo.parentVenue.toLowerCase()}`))) {
                                            expandVenue(scholarVenue, { includeAtParent: false });
                                        }
                                    } else {
                                        expandVenue(scholarVenue);
                                        if (trackInfo.resolvedVenue) expandVenue(trackInfo.resolvedVenue);
                                        if (inheritWorkshopParentRank && trackInfo.parentVenue) expandVenue(trackInfo.parentVenue);
                                    }

                                    // Add acronym candidates extracted from the Scholar venue string.
                                    for (const acro of getPossibleAcronymsFromVenue(scholarVenue)) {
                                        expandVenue(acro);
                                    }

                                    let resolvedRank = null;
                                    for (const candidate of rankingCandidates) {
                                        const attempt = findRankForVenue(candidate, yearSpecificCoreData, fullVenueTitleForRanking);
                                        if (VALID_RANKS.includes(attempt)) {
                                            resolvedRank = attempt;
                                            break;
                                        }
                                        if (resolvedRank === null && attempt !== "N/A") {
                                            resolvedRank = attempt;
                                        }
                                    }
                                    currentRank = resolvedRank ?? "N/A";
                                } else {
                                    currentRank = 'N/A';
                                }

                                if (currentRank === 'N/A' && trackInfo.isWorkshop) {
                                    naReason = naReason || 'Workshop';
                                }

                                // Page-length override (strictly < 6 pages) unless already classified as Demo/Poster or Workshop.
                                if (pageCount !== null && pageCount < 6 && !trackInfo.isWorkshop && !trackInfo.isDemoPoster) {
                                    currentRank = 'N/A';
                                    naReason = 'Short-paper';
                                }
                            }
                        }
                    }
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
            return { rank: currentRank, system: rankingSystem, reason: (currentRank === 'N/A' ? naReason : null), rowElement: pubInfo.rowElement, titleText: pubInfo.titleText, url: pubInfo.url, shouldPersist };
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
            displayRankBadgeAfterTitle(result.rowElement, result.rank, result.system, result.reason);
            const publicationRankInfo = {
                titleText: result.titleText,
                rank: result.rank,
                system: result.system,
                reason: result.reason,
                url: result.url
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
    const userId = getScholarUserId();
    if (userId) {
        const cached = await loadCachedData(userId);
        if (cached && cached.publicationRanks) {
            const pubRanksArr = unpackRanks(cached.publicationRanks);
            displaySummaryPanel(cached.coreRankCounts, cached.sjrRankCounts, userId, pubRanksArr, cached.timestamp, cached.dblpAuthorPid);
            return;
        }
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
