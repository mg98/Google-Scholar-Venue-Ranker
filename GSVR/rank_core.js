/*
 * rank_core.js
 * Pure utilities shared by the content script and Node tests.
 *
 * UMD export:
 *   - Browser: window.GSVRUtils
 *   - Node: module.exports
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------
  // Text normalization
  // ---------------------------

  const TRACK_PREFIXES = [
    /^ph\.?d\.?\s+forum\s+abstract\s*:\s*/i,
    /^phd\s+forum\s+abstract\s*:\s*/i,
    /^ph\.?d\.?\s+forum\s*:\s*/i,
    /^doctoral\s+consortium\s*:\s*/i,
    /^doctoral\s+symposium\s*:\s*/i,
    /^poster\s*:\s*/i,
    /^demo\s*:\s*/i,
    /^demonstration\s*:\s*/i,
    /^short\s+paper\s*:\s*/i,
    /^work\s*-?\s*in\s*-?\s*progress\s*:\s*/i,
  ];

  function stripTrackPrefixes(title) {
    if (!title) return '';
    let t = String(title);
    for (const rx of TRACK_PREFIXES) {
      t = t.replace(rx, '');
    }
    return t;
  }

  function normalizeSpaces(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeForMatch(s) {
    const t = stripTrackPrefixes(s);
    return normalizeSpaces(
      t
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\+/g, ' and ')
        .replace(/[\.,\/#!$%\^&\*;:{}=\_`~?"“”\(\)\[\]]/g, ' ')
        .replace(/\s-\s/g, ' ')
    );
  }

  function normalizeVenueCandidate(venue) {
    // Remove common Scholar/DBLP suffixes like "(2)", "(Part 2)", "Vol. 2", etc.
    let v = normalizeForMatch(venue);
    // remove "(2)" style already converted to spaces; handle trailing numbers
    v = v.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ');
    v = v.replace(/\b\d{1,3}\b\s*$/g, '');
    return normalizeSpaces(v);
  }

  function expandVenueCandidates(rawVenue, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    // When analyzing workshop/track venues like "X@Y", callers may want to
    // *avoid* expanding the parent venue (Y) to prevent rank inheritance.
    const includeAtParent = options.includeAtParent !== false;
    const out = new Set();
    const v = String(rawVenue || '').trim();
    if (!v) return [];

    out.add(v);

    // If it has "X@Y" (co-located workshop), add X and (optionally) Y.
    const atMatch = v.match(/\b([A-Za-z][A-Za-z0-9\-]{1,20})\s*@\s*([A-Za-z][A-Za-z0-9\-]{1,20})\b/);
    if (atMatch) {
      out.add(atMatch[1]);
      if (includeAtParent) out.add(atMatch[2]);
    }

    // In workshop/track mode, try to strip explicit parent-conference mentions.
    if (!includeAtParent) {
      const coloc = v.match(/^(.*?)(?:\bco\s*-?located\s+with\b|\bcolocated\s+with\b|\bin\s+conjunction\s+with\b|\baffiliated\s+with\b|\bassociated\s+with\b)\s+.*$/i);
      if (coloc && coloc[1]) {
        const prefix = coloc[1].trim();
        if (prefix) out.add(prefix);
      }
    }

    // Add normalized removal of trailing "(2)" / "2" suffixes.
    const normalized = normalizeVenueCandidate(v);
    if (normalized && normalized !== normalizeForMatch(v)) {
      out.add(normalized);
    }

    // If the original ends with "(n)", also add without it.
    const parenNum = v.replace(/\s*\(\s*\d{1,3}\s*\)\s*$/g, '').trim();
    if (parenNum && parenNum !== v) out.add(parenNum);

    return Array.from(out);
  }

  // ---------------------------
  // Similarity (Jaro-Winkler)
  // ---------------------------

  function jaroWinkler(s1, s2) {
    if (!s1 || !s2) return 0;
    const a = String(s1);
    const b = String(s2);
    const bound = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const matchA = new Array(a.length).fill(false);
    const matchB = new Array(b.length).fill(false);
    let matches = 0;

    for (let i = 0; i < a.length; i++) {
      const lo = Math.max(0, i - bound);
      const hi = Math.min(i + bound + 1, b.length);
      for (let j = lo; j < hi; j++) {
        if (!matchB[j] && a[i] === b[j]) {
          matchA[i] = true;
          matchB[j] = true;
          matches++;
          break;
        }
      }
    }

    if (!matches) return 0;

    let k = 0;
    let transpositions = 0;
    for (let i = 0; i < a.length; i++) {
      if (matchA[i]) {
        while (!matchB[k]) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
      }
    }
    transpositions /= 2;
    const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

    let prefix = 0;
    for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
      if (a[i] === b[i]) prefix++;
      else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  // ---------------------------
  // Page count parsing
  // ---------------------------

  function getPageCountFromPagesString(pageStr) {
    if (!pageStr) return null;
    let s = String(pageStr).trim();
    if (!s) return null;

    // Ignore single "article 12", roman numerals, or a lone number without a range.
    if (/^(article\s+\d+|\d+$|[ivxlcdm]+$)/i.test(s) && !s.includes('-') && !s.includes(':')) {
      return null;
    }

    // Patterns like 123-128 or a:123-a:128
    let m = s.match(/^(?:[a-z\d]+:)?(\d+)\s*[-‑–—]\s*(?:[a-z\d]+:)?(\d+)$/i);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start) return end - start + 1;
    }

    // Patterns like 24:1-24:2
    m = s.match(/^(?:(\d+):)?(\d+)\s*[-‑–—]\s*(?:(\d+):)?(\d+)$/i);
    if (m) {
      const startPage = parseInt(m[2], 10);
      const endPage = parseInt(m[4], 10);
      if (!isNaN(startPage) && !isNaN(endPage) && endPage >= startPage) return endPage - startPage + 1;
    }
    return null;
  }

  // ---------------------------
  // Track classification
  // ---------------------------

  // NOTE: These are intentionally broad keyword detectors.
  // The main guard against rank "inheritance" is done by *candidate
  // construction* (avoid adding parent venues) and strict acronym matching.
  const WORKSHOP_RX = /(\bworkshop\b|\bws\b|\bworkshop\s+on\b|\bworkshop\s+proceedings\b|\bco\s*-?located\b|\bco\s*-?located\s+with\b|\bcolocated\b|\bsatellite\b|\bassociated\s+workshop\b|\baffiliated\s+workshop\b|\bworkshop\s+track\b|@|\bproceedings\s+of\s+the\s+[\s\S]*\bworkshop\b)/i;

  const DEMO_POSTER_RX = /(\bposter\b|\bposters\b|\bdemo\b|\bdemos\b|\bdemonstration\b|\bdemonstrations\b|\bcompanion\b|\badjunct\b|\bsupplement\b|\bshort\s+papers\b|\bshort\s+paper\b|\bextended\s+abstract\b|\bdoctoral\s+(consortium|symposium)\b|\bph\.?d\.?\s+forum\b|\bforum\s+abstract\b|\bstudent\s+research\b|\bwork\s*-?\s*in\s*-?\s*progress\b|\bwip\b|\bindustry\s+track\b|\btool\s+demonstration\b)/i;
  const EXTENDED_ABSTRACT_RX = /\bextended\s+abstract\b/i;

  function classifyVenueTrack({ title, venue, venue_full, acronym, dblpKey, scholarVenue, pageCount, dblpType, crossref }) {
    const signals = [];
    const t = String(title || '');
    const v1 = String(venue || '');
    const v2 = String(venue_full || '');
    const sv = String(scholarVenue || '');
    const dk = String(dblpKey || '');
    const cr = String(crossref || '');
    const dt = String(dblpType || '');

    const haystack = `${t} \n ${v1} \n ${v2} \n ${sv} \n ${dk} \n ${cr} \n ${dt}`;

    let resolvedVenue = null;
    let parentVenue = null;

    // X@Y workshop indicator
    const at = haystack.match(/\b([A-Za-z][A-Za-z0-9\-]{1,20})\s*@\s*([A-Za-z][A-Za-z0-9\-]{1,20})\b/);
    if (at) {
      resolvedVenue = at[1];
      parentVenue = at[2];
      signals.push('at_notation');
    }

    const isExtendedAbstract = EXTENDED_ABSTRACT_RX.test(haystack);
    if (isExtendedAbstract) signals.push('extended_abstract');

    const demoByKeyword = DEMO_POSTER_RX.test(haystack);
    const demoByPages = typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount <= 3;
    let isDemoPoster = demoByKeyword || demoByPages;
    if (demoByKeyword) signals.push('demo_poster_keyword');
    if (demoByPages) signals.push('demo_by_pages');

    if (demoByKeyword && typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount > 4) {
      isDemoPoster = false;
      signals.push('demo_overridden_by_pages');
    }

    const isWorkshop = WORKSHOP_RX.test(haystack);
    if (isWorkshop) signals.push('workshop_keyword');

    // Infer a "series" from dblpKey (conf/<series>/...)
    const seriesMatch = dk.match(/^(conf|journals)\/([^/]+)\//i);
    const seriesId = seriesMatch ? seriesMatch[2] : null;

    // Many workshop papers live under the *parent* series in DBLP (e.g., conf/sensys/*)
    // but the proceedings crossref often contains a track indicator like "2020ensSYS".
    let crossrefDerivedVenue = null;
    if (cr) {
      const last = cr.split('/').pop();
      if (last) {
        // Examples: "2020ensSYS" or "enssys2020"
        let m = last.match(/^(\d{4})([A-Za-z][A-Za-z0-9\-]{1,25})$/);
        if (m) {
          crossrefDerivedVenue = m[2];
        } else {
          m = last.match(/^([A-Za-z][A-Za-z0-9\-]{1,25})(\d{4})$/);
          if (m) crossrefDerivedVenue = m[1];
        }
        if (crossrefDerivedVenue) signals.push('crossref_track');
      }
    }
    if (!parentVenue && crossrefDerivedVenue && seriesId && seriesId.toLowerCase() !== crossrefDerivedVenue.toLowerCase()) {
      parentVenue = seriesId;
      signals.push('parent_from_series');
    }
    if (!resolvedVenue) {
      if (crossrefDerivedVenue) {
        resolvedVenue = crossrefDerivedVenue;
        signals.push('crossref_venue');
      }
      // Fall back to the DBLP series id only if we still don't have a better signal.
      if (!resolvedVenue && seriesId && seriesId.length >= 2) {
        resolvedVenue = seriesId;
        signals.push('dblp_series');
      } else if (!resolvedVenue && acronym) {
        resolvedVenue = acronym;
        signals.push('acronym');
      }
    }

    const isShortPaper = typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount < 6;
    if (isShortPaper) signals.push('short_by_pages');

    // Reason precedence: Extended Abstract > Demo/Poster > Workshop > Short-paper
    let reason = null;
    if (isExtendedAbstract) reason = 'Extended Abstract';
    else if (isDemoPoster) reason = 'Demo/Poster';
    else if (isWorkshop) reason = 'Workshop';
    else if (isShortPaper) reason = 'Short-paper';

    return {
      isWorkshop,
      isDemoPoster,
      isExtendedAbstract,
      isShortPaper,
      reason,
      resolvedVenue: resolvedVenue ? String(resolvedVenue) : null,
      parentVenue: parentVenue ? String(parentVenue) : null,
      seriesId,
      signals,
    };
  }

  // ---------------------------
  // Deterministic DBLP matching
  // ---------------------------

  function selectBestDblpMatch({ scholarTitle, scholarYear, dblpPublications, similarityThreshold = 0.88, maxYearDiff = 2 }) {
    const st = normalizeForMatch(scholarTitle);
    if (!st || !Array.isArray(dblpPublications) || dblpPublications.length === 0) return null;

    const sy = typeof scholarYear === 'number' ? scholarYear : null;

    let best = null;
    for (const pub of dblpPublications) {
      if (!pub || !pub.title || !pub.dblpKey) continue;
      const dt = normalizeForMatch(pub.title);
      const sim = jaroWinkler(st, dt);
      if (sim < similarityThreshold) continue;

      const dy = pub.year ? parseInt(pub.year, 10) : null;
      const yearDiff = (sy !== null && dy !== null && Number.isFinite(dy)) ? Math.abs(sy - dy) : 0;
      const ignoreYearDiff = sim >= 0.96;
      if (sy !== null && dy !== null && yearDiff > maxYearDiff && !ignoreYearDiff) continue;

      const key = String(pub.dblpKey);
      const hasPages = !!pub.pages;
      const candidate = { pub, sim, yearDiff, key, hasPages };

      if (!best) {
        best = candidate;
        continue;
      }

      // Deterministic ordering:
      // 1) Higher similarity
      // 2) Smaller year diff
      // 3) Prefer entries with pages (helps short-paper detection)
      // 4) Lexicographically smallest dblpKey
      if (
        candidate.sim > best.sim + 1e-12 ||
        (Math.abs(candidate.sim - best.sim) <= 1e-12 && candidate.yearDiff < best.yearDiff) ||
        (Math.abs(candidate.sim - best.sim) <= 1e-12 && candidate.yearDiff === best.yearDiff && candidate.hasPages && !best.hasPages) ||
        (Math.abs(candidate.sim - best.sim) <= 1e-12 && candidate.yearDiff === best.yearDiff && candidate.hasPages === best.hasPages && candidate.key < best.key)
      ) {
        best = candidate;
      }
    }

    return best ? { ...best.pub, matchConfidence: best.sim } : null;
  }

  return {
    normalizeForMatch,
    normalizeVenueCandidate,
    expandVenueCandidates,
    jaroWinkler,
    getPageCountFromPagesString,
    classifyVenueTrack,
    selectBestDblpMatch,
  };
});
