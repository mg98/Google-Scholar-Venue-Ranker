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
        // Include '+' so titles like "LEAF + AIO" match "LEAF+AIO".
        .replace(/[\.,\/#!$%\^&\*;:{}=\_`~?"“”'’\(\)\[\]\+＋]/g, ' ')
        .replace(/[-\u2010-\u2015]/g, ' ')
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

    // Patterns like S1-S8, e123-e130, A12-A18
    let m = s.match(/^([a-z]+)\s*(\d+)\s*[-‑–—]\s*([a-z]+)\s*(\d+)$/i);
    if (m) {
      const start = parseInt(m[2], 10);
      const end = parseInt(m[4], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start) return end - start + 1;
    }

        // Patterns like 123-128 or a:123-a:128
    m = s.match(/^(?:[a-z\d]+:)?(\d+)\s*[-‑–—]\s*(?:[a-z\d]+:)?(\d+)$/i);
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

  const EXTENDED_ABSTRACT_RX = /(\bextended\s+abstracts?\b)/i;
  const DEMO_POSTER_RX = /(\bposter\b|\bposters\b|\bdemo\b|\bdemos\b|\bdemonstration\b|\bdemonstrations\b|\bcompanion\b|\badjunct\b|\bsupplement\b|\bdoctoral\s+(consortium|symposium)\b|\bph\.?d\.?\s+forum\b|\bforum\s+abstract\b|\bstudent\s+research\b|\bwork\s*-?\s*in\s*-?\s*progress\b|\bwip\b|\bindustry\s+track\b|\btool\s+demonstration\b)/i;

  function classifyVenueTrack({ title, venue, venue_full, acronym, dblpKey, scholarVenue, pageCount, dblpType, crossref }) {
    const signals = [];
    const t = String(title || '');
    const v1 = String(venue || '');
    const v2 = String(venue_full || '');
    const sv = String(scholarVenue || '');
    const dk = String(dblpKey || '');
    const cr = String(crossref || '');
    const dt = String(dblpType || '');

    // IMPORTANT: We avoid relying on Google Scholar metadata here. All track
    // classification should be grounded in DBLP fields (title/venue/key/crossref/type).
    // The scholarVenue input is retained for backwards compatibility but should
    // normally be null.
    const haystack = `${t} \n ${v1} \n ${v2} \n ${sv} \n ${dk} \n ${cr} \n ${dt}`;
    const venueHaystack = `${v1} \n ${v2} \n ${sv} \n ${dk} \n ${cr} \n ${dt}`;

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
    if (isExtendedAbstract) signals.push('extended_abstract_keyword');

    const hasTrackPrefix = stripTrackPrefixes(t) !== t;
    // Title-only occurrences of words like "demonstration" are often part of a normal full-paper title.
    // Treat demo/poster as a title signal only when it appears as an explicit track prefix (e.g., "Demo:")
    // or when the title contains strong track terms (poster/demo/WiP/etc.).
    const demoPosterInTitle = hasTrackPrefix || /\b(poster|demo|late\s+breaking|work\s+in\s+progress|doctoral\s+consortium|doctoral\s+symposium|adjunct|companion)\b/i.test(t);
    const demoPosterInVenue = DEMO_POSTER_RX.test(venueHaystack);
    let isDemoPoster = demoPosterInTitle || demoPosterInVenue;
    if (demoPosterInVenue) signals.push('demo_poster_venue_keyword');
    else if (demoPosterInTitle) signals.push('demo_poster_title_keyword');

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

    // Page-count override (Issue #1): titles may contain the word "demonstration"
    // as part of the research topic (e.g., "... by demonstration"), but the paper
    // can still be a full paper. Demo/poster papers are typically 2–3 pages.
    if (!isExtendedAbstract && isDemoPoster && typeof pageCount === 'number' && Number.isFinite(pageCount)) {
      // If the only demo signal is in the title and the paper is longer than a
      // typical demo/poster, treat it as a full paper.
      if (!demoPosterInVenue && pageCount >= 4) {
        isDemoPoster = false;
        signals.push('demo_overridden_by_pages_title_only');
      }
      // Even if venue suggests demo/poster, a very large page count is a strong
      // counter-signal unless it's explicitly an extended abstract.
      if (demoPosterInVenue && pageCount > 5 && !isExtendedAbstract) {
        // Keep true only if we have a very explicit signal (poster/demo/companion),
        // not just "demonstration".
        const explicitVenueDemo = /(\bposter\b|\bdemo\b|\bcompanion\b|\badjunct\b|\bsupplement\b|\bdoctoral\b|\bph\.?d\.?\b|\bforum\b|\bwip\b|\bindustry\s+track\b)/i.test(venueHaystack);
        if (!explicitVenueDemo) {
          isDemoPoster = false;
          signals.push('demo_overridden_by_pages_weak_venue');
        }
      }
    }

    // Short paper by pages: keep separate from demo/poster.
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

  function tokenJaccard(a, b) {
    const ta = new Set(String(a || '').split(' ').filter(x => x.length >= 2));
    const tb = new Set(String(b || '').split(' ').filter(x => x.length >= 2));
    if (ta.size === 0 || tb.size === 0) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union > 0 ? inter / union : 0;
  }

  function selectBestDblpMatch({ scholarTitle, scholarYear, dblpPublications, similarityThreshold = 0.88, maxYearDiff = 2 }) {
    const st = normalizeForMatch(scholarTitle);
    if (!st || !Array.isArray(dblpPublications) || dblpPublications.length === 0) return null;

    const sy = typeof scholarYear === 'number' ? scholarYear : null;

    let best = null;
    let second = null;
    for (const pub of dblpPublications) {
      if (!pub || !pub.title || !pub.dblpKey) continue;
      const dt = normalizeForMatch(pub.title);
      const jw = jaroWinkler(st, dt);
      const jac = tokenJaccard(st, dt);
      // Weighted hybrid similarity improves robustness to punctuation/spacing
      // differences (Issue #2) while keeping precision high.
      let sim = 0.7 * jw + 0.3 * jac;

      const dy = pub.year ? parseInt(pub.year, 10) : null;
      const yearDiff = (sy !== null && dy !== null && Number.isFinite(dy)) ? Math.abs(sy - dy) : 0;
      // Soft year penalty (journals often have online/print year discrepancies).
      if (sy !== null && dy !== null && yearDiff > maxYearDiff) {
        sim *= 0.92 ** Math.min(6, (yearDiff - maxYearDiff));
      }

      if (sim < similarityThreshold) continue;

      const key = String(pub.dblpKey);
      const hasPages = !!pub.pages;
      const candidate = { pub, sim, yearDiff, key, hasPages };

      if (!best) {
        best = candidate;
        continue;
      }

      // Track runner-up for ambiguity rejection.
      if (!second) second = best;

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
        // Maintain second-best.
        second = best;
        best = candidate;
      }
      else if (!second || candidate.sim > second.sim + 1e-12 || (Math.abs(candidate.sim - second.sim) <= 1e-12 && candidate.key < second.key)) {
        second = candidate;
      }
    }

    if (!best) return null;

    // If the match is ambiguous (very close top-2 scores) and not an almost-exact
    // match, prefer returning null to avoid false positives.
    if (second && best.sim < 0.93 && (best.sim - second.sim) < 0.02) {
      return null;
    }

    return { ...best.pub, matchScore: best.sim };
  }

  // ---------------------------
  // CSRankings-style venue overrides (top venues, proceedings-as-journals)
  // ---------------------------
  // CSRankings maintains a curated list of "top" venues and performs a few
  // deterministic remappings for proceedings published as journal special issues
  // (e.g., SIGGRAPH papers in ACM TOG). We adopt the same philosophy here:
  //  - Prefer deterministic normalization for known top venues.
  //  - Treat well-known "proceedings-as-journals" as conferences when we can
  //    unambiguously identify the conference issue.

  function stripParenNumberSuffix(s) {
    return String(s || '').replace(/\s*\(\s*\d+\s*\)\s*$/g, '').trim();
  }

  function normalizeKey(s) {
    return normalizeSpaces(String(s || '')).toLowerCase();
  }

  // Base venue names (with "(1)", "(2)", etc. removed) derived from CSRankings' areadict.
  // We keep this list intentionally limited to CSRankings' venue universe.
  const CSRANKINGS_TOP_VENUE_BASES = new Set(
    [
      "AAAI",
      "AAAI/IAAI",
      "ACL",
      "ACL/IJCNLP",
      "ACM Conference on Computer and Communications Security",
      "ACM Trans. Embed. Comput. Syst.",
      "ACM Trans. Embedded Comput. Syst.",
      "ACM Trans. Graph.",
      "ASE",
      "ASPLOS",
      "Bioinform.",
      "Bioinformatics",
      "Bioinformatics [ISMB/ECCB]",
      "CAV",
      "CCS",
      "CHI",
      "COLING-ACL",
      "Comput. Graph. Forum",
      "CRYPTO",
      "CSL-LICS",
      "CVPR",
      "DAC",
      "EC",
      "ECCV",
      "EMNLP",
      "EMNLP-CoNLL",
      "EMNLP-IJCNLP",
      "EMNLP/IJCNLP",
      "EMSOFT",
      "ESEC/SIGSOFT FSE",
      "EUROCRYPT",
      "EUROGRAPHICS",
      "FAST",
      "FOCS",
      "FSE",
      "HRI",
      "HPCA",
      "HLT-NAACL",
      "ICCAD",
      "ICCV",
      "ICDE",
      "ICFP",
      "ICML",
      "ICMLA",
      "ICRA",
      "ICSE",
      "ICST",
      "ICS",
      "IJCNN",
      "IJCAI",
      "INFOCOM",
      "IPSN",
      "ISCA",
      "ISMB",
      "ISMB (Supplement of Bioinformatics)",
      "ISMB/ECCB (Supplement of Bioinformatics)",
      "ISSTA",
      "KDD",
      "LICS",
      "MICRO",
      "MOBICOM",
      "MOBIHOC",
      "MobiSys",
      "NAACL",
      "NAACL-HLT",
      "NAACL (Long Papers)",
      "NDSS",
      "NeurIPS",
      "NIPS",
      "OSDI",
      "OOPSLA",
      "OOPSLA/ECOOP",
      "OOPSLA1",
      "OOPSLA2",
      "PACMPL",
      "PODS",
      "POPL",
      "PPoPP",
      "PPOPP",
      "PVLDB",
      "PLDI",
      "Proc. ACM Interact. Mob. Wearable Ubiquitous Technol.",
      "Proc. ACM Manag. Data",
      "Proc. ACM Meas. Anal. Comput. Syst.",
      "SIGMETRICS",
      "Proc. ACM Program. Lang.",
      "Proc. ACM Softw. Eng.",
      "Proc. VLDB Endow.",
      "RECOMB",
      "Robotics: Science and Systems",
      "RTAS",
      "RTSS",
      "S&P",
      "SOSP",
      "SIGCOMM",
      "SIGCSE",
      "SIGGRAPH",
      "SIGGRAPH Asia",
      "SIGMOD",
      "SIGMOD Conference",
      "SIGSOFT FSE",
      "SP",
      "SPLASH",
      "STOC",
      "TACAS",
      "TCC",
      "USENIX Annual Technical Conference",
      "USENIX Annual Technical Conference, General Track",
      "USENIX ATC",
      "USENIX Security",
      "USENIX Security Symposium",
      "UbiComp",
      "Ubicomp",
      "VLDB",
      "VR",
      "WINE",
      "WWW",
      "IEEE Trans. Vis. Comput. Graph.",
      "IEEE Visualization",
      "VIS",
    ].map((x) => normalizeKey(stripParenNumberSuffix(x)))
  );

  // Deterministic aliasing for common DBLP/CSRankings venue variants.
  // Keys are normalized (lowercase) and apply after stripping "(n)" suffixes.
  const CSRANKINGS_VENUE_ALIASES = new Map(
    Object.entries({
      // Variants / branding
      'nips': 'NeurIPS',
      'neurips': 'NeurIPS',
      'mobicom': 'MobiCom',
      'ubicomp': 'UbiComp',
      'sigmod conference': 'SIGMOD',
      's&p': 'S&P',
      'sp': 'S&P',
      'usenix security symposium': 'USENIX Security',
      'usenix annual technical conference': 'USENIX ATC',
      'usenix annual technical conference, general track': 'USENIX ATC',
      'acm conference on computer and communications security': 'CCS',
      'ieee visualization': 'VIS',

      // Proceedings-as-journals (handled below) still benefit from canonical names.
      'pvldb': 'VLDB',
      'proc. vldb endow.': 'VLDB',
      'proc. acm softw. eng.': 'FSE',
      'sigsoft fse': 'FSE',
      'esec/sigsoft fse': 'FSE',
      'oopsla1': 'OOPSLA',
      'oopsla2': 'OOPSLA',
      'proc. acm meas. anal. comput. syst.': 'SIGMETRICS',
      'pomacs': 'SIGMETRICS',
      'proc. acm interact. mob. wearable ubiquitous technol.': 'UbiComp',
    })
  );

  function isCsrankingsTopVenue(venue) {
    const base = normalizeKey(stripParenNumberSuffix(venue));
    if (!base) return false;
    return CSRANKINGS_TOP_VENUE_BASES.has(base);
  }

  function canonicalizeCsrankingsVenueName(venue) {
    const raw = normalizeSpaces(String(venue || '')).trim();
    if (!raw) return null;
    const stripped = stripParenNumberSuffix(raw);
    const key = normalizeKey(stripped);
    const alias = CSRANKINGS_VENUE_ALIASES.get(key);
    return alias || stripped;
  }

  // ---- Proceedings-as-journals mappings (ported from CSRankings regenerate_data.py) ----
  // The goal is not to be comprehensive for all possible venues, but to be
  // *precise* for well-known top conferences whose papers appear as journal
  // issues in DBLP.

  // Bioinformatics special issues (ISMB proceedings).
  const ISMB_BIOINFORMATICS = {
    2024: { volume: '40', number: 'Supplement_1' },
    2023: { volume: '39', number: 'Supplement-1' },
    2022: { volume: '38', number: 'Supplement_1' },
    2021: { volume: '37', number: 'Supplement' },
    2020: { volume: '36', number: 'Supplement-1' },
    2019: { volume: '35', number: '14' },
    2018: { volume: '34', number: '13' },
    2017: { volume: '33', number: '14' },
    2016: { volume: '32', number: '12' },
    2015: { volume: '31', number: '12' },
    2014: { volume: '30', number: '12' },
    2013: { volume: '29', number: '13' },
    2012: { volume: '28', number: '12' },
    2011: { volume: '27', number: '13' },
    2010: { volume: '26', number: '12' },
    2009: { volume: '25', number: '12' },
    2008: { volume: '24', number: '13' },
    2007: { volume: '23', number: '13' },
  };

  // ACM Transactions on Graphics special issues (SIGGRAPH / SIGGRAPH Asia proceedings).
  const TOG_SIGGRAPH_VOLUME = {
    2024: { volume: '43', number: '4' },
    2023: { volume: '42', number: '4' },
    2022: { volume: '41', number: '4' },
    2021: { volume: '40', number: '4' },
    2020: { volume: '39', number: '4' },
    2019: { volume: '38', number: '4' },
    2018: { volume: '37', number: '4' },
    2017: { volume: '36', number: '4' },
    2016: { volume: '35', number: '4' },
    2015: { volume: '34', number: '4' },
    2014: { volume: '33', number: '4' },
    2013: { volume: '32', number: '4' },
    2012: { volume: '31', number: '4' },
    2011: { volume: '30', number: '4' },
    2010: { volume: '29', number: '4' },
    2009: { volume: '28', number: '3' },
    2008: { volume: '27', number: '3' },
    2007: { volume: '26', number: '3' },
    2006: { volume: '25', number: '3' },
    2005: { volume: '24', number: '3' },
    2004: { volume: '23', number: '3' },
    2003: { volume: '22', number: '3' },
    2002: { volume: '21', number: '3' },
  };

  const TOG_SIGGRAPH_ASIA_VOLUME = {
    2024: { volume: '43', number: '6' },
    2023: { volume: '42', number: '6' },
    2022: { volume: '41', number: '6' },
    2021: { volume: '40', number: '6' },
    2020: { volume: '39', number: '6' },
    2019: { volume: '38', number: '6' },
    2018: { volume: '37', number: '6' },
    2017: { volume: '36', number: '6' },
    2016: { volume: '35', number: '6' },
    2015: { volume: '34', number: '6' },
    2014: { volume: '33', number: '6' },
    2013: { volume: '32', number: '6' },
    2012: { volume: '31', number: '6' },
    2011: { volume: '30', number: '6' },
    2010: { volume: '29', number: '6' },
    2009: { volume: '28', number: '5' },
    2008: { volume: '27', number: '5' },
  };

  // Computer Graphics Forum special issues (EUROGRAPHICS proceedings).
  const CGF_EUROGRAPHICS_VOLUME = {
    2024: { volume: '43', number: '2' },
    2023: { volume: '42', number: '2' },
    2022: { volume: '41', number: '2' },
    2021: { volume: '40', number: '2' },
    2020: { volume: '39', number: '2' },
    2019: { volume: '38', number: '2' },
    2018: { volume: '37', number: '2' },
    2017: { volume: '36', number: '2' },
    2016: { volume: '35', number: '2' },
    2015: { volume: '34', number: '2' },
    2014: { volume: '33', number: '2' },
    2013: { volume: '32', number: '2' },
    2012: { volume: '31', number: '2' },
    2011: { volume: '30', number: '2' },
    2010: { volume: '29', number: '2' },
    2009: { volume: '28', number: '2' },
    2008: { volume: '27', number: '2' },
    2007: { volume: '26', number: '3' },
    2006: { volume: '25', number: '3' },
    2005: { volume: '24', number: '3' },
    2004: { volume: '23', number: '3' },
    2003: { volume: '22', number: '3' },
    2002: { volume: '21', number: '3' },
    2001: { volume: '20', number: '3' },
    2000: { volume: '19', number: '3' },
    1999: { volume: '18', number: '3' },
    1998: { volume: '17', number: '3' },
    1997: { volume: '16', number: '3' },
    1996: { volume: '15', number: '3' },
    1995: { volume: '14', number: '3' },
    1994: { volume: '13', number: '3' },
    1993: { volume: '12', number: '3' },
    1992: { volume: '11', number: '3' },
  };

  // TVCG special issues (VIS / VR proceedings).
  const TVCG_VIS_VOLUME = {
    2025: { volume: '31', number: '1' },
    2024: { volume: '30', number: '1' },
    2023: { volume: '29', number: '1' },
    2022: { volume: '28', number: '1' },
    2021: { volume: '27', number: '2' },
    2020: { volume: '26', number: '1' },
    2019: { volume: '25', number: '1' },
    2018: { volume: '24', number: '1' },
    2017: { volume: '23', number: '1' },
    2016: { volume: '22', number: '1' },
    2014: { volume: '20', number: '12' },
    2013: { volume: '19', number: '12' },
    2012: { volume: '18', number: '12' },
    2011: { volume: '17', number: '12' },
    2010: { volume: '16', number: '6' },
    2009: { volume: '15', number: '6' },
    2008: { volume: '14', number: '6' },
    2007: { volume: '13', number: '6' },
    2006: { volume: '12', number: '5' },
  };

  const TVCG_VR_VOLUME = {
    2025: { volume: '31', number: '5' },
    2024: { volume: '30', number: '5' },
    2023: { volume: '29', number: '5' },
    2022: { volume: '28', number: '5' },
    2021: { volume: '27', number: '5' },
    2020: { volume: '26', number: '5' },
    2019: { volume: '25', number: '5' },
    2018: { volume: '24', number: '4' },
    2017: { volume: '23', number: '4' },
    2016: { volume: '22', number: '4' },
    2015: { volume: '21', number: '4' },
    2014: { volume: '20', number: '4' },
    2013: { volume: '19', number: '4' },
    2012: { volume: '18', number: '4' },
  };

  function volumeIssueMatch(expected, volume, number) {
    if (!expected || !volume || !number) return false;
    return String(volume).trim() === String(expected.volume).trim() && String(number).trim() === String(expected.number).trim();
  }

  // Primary entry point: map DBLP (venue, year, volume/number) to a better canonical
  // venue name and ranking system hint.
  function resolveCsrankingsVenueOverride({ dblpKey, venue, year, volume, number, dblpType }) {
    const vRaw = normalizeSpaces(String(venue || '')).trim();
    if (!vRaw) return null;

    const keyLower = String(dblpKey || '').toLowerCase();
    const isJournalish = keyLower.startsWith('journals/') || String(dblpType || '').toLowerCase() === 'article';

    const vCanon = canonicalizeCsrankingsVenueName(vRaw) || vRaw;
    const vCanonKey = normalizeKey(vCanon);
    const y = typeof year === 'number' && Number.isFinite(year) ? year : (year ? parseInt(String(year), 10) : null);
    const vol = volume ? String(volume).trim() : null;
    const num = number ? String(number).trim() : null;

    // 1) Proceedings-as-journals (only apply if this looks like a journal entry)
    if (isJournalish) {
      // PACMPL: Proc. ACM Program. Lang. (number encodes conference like POPL/OOPSLA/ICFP)
      if (vCanonKey === 'proc. acm program. lang.' || vCanonKey === 'pacmpl') {
        if (num && /^[A-Za-z][A-Za-z0-9\-]{1,12}$/.test(num)) {
          const conf = canonicalizeCsrankingsVenueName(num) || num;
          return { system: 'CORE', canonicalVenue: conf, year: y ?? null, reason: 'PACMPL_number' };
        }
      }

      // PACMMOD: Proc. ACM Manag. Data (SIGMOD/PODS mapping)
      if (vCanonKey === 'proc. acm manag. data') {
        if (y && num) {
          const n = parseInt(num, 10);
          if (!isNaN(n)) {
            // Port of CSRankings map_pacmmod_to_conference
            if (y === 2023 && (n === 3 || n === 4)) {
              return { system: 'CORE', canonicalVenue: 'SIGMOD', year: 2024, reason: 'PACMMOD_2023_issue34' };
            }
            if (y === 2023 && (n === 1 || n === 2)) {
              return { system: 'CORE', canonicalVenue: 'SIGMOD', year: 2023, reason: 'PACMMOD_2023_issue12' };
            }
            if (n === 2) {
              return { system: 'CORE', canonicalVenue: 'PODS', year: y, reason: 'PACMMOD_issue2' };
            }
            return { system: 'CORE', canonicalVenue: 'SIGMOD', year: y, reason: 'PACMMOD_default' };
          }
        }
      }

      // VLDB: PVLDB / Proc. VLDB Endow.
      if (vCanonKey === 'proc. vldb endow.' || vCanonKey === 'pvldb') {
        return { system: 'CORE', canonicalVenue: 'VLDB', year: y ?? null, reason: 'PVLDB' };
      }

      // FSE proceedings: Proc. ACM Softw. Eng.
      if (vCanonKey === 'proc. acm softw. eng.') {
        return { system: 'CORE', canonicalVenue: 'FSE', year: y ?? null, reason: 'PSE' };
      }

      // SIGMETRICS proceedings: POMACS
      if (vCanonKey === 'proc. acm meas. anal. comput. syst.' || vCanonKey === 'pomacs') {
        return { system: 'CORE', canonicalVenue: 'SIGMETRICS', year: y ?? null, reason: 'POMACS' };
      }

      // UbiComp proceedings: IMWUT
      if (vCanonKey === 'proc. acm interact. mob. wearable ubiquitous technol.') {
        return { system: 'CORE', canonicalVenue: 'UbiComp', year: y ?? null, reason: 'IMWUT' };
      }

      // SIGGRAPH / SIGGRAPH Asia (TOG special issues)
      if (vCanonKey === 'acm trans. graph.' && y && vol && num) {
        if (volumeIssueMatch(TOG_SIGGRAPH_VOLUME[y], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'SIGGRAPH', year: y, reason: 'TOG_SIGGRAPH' };
        }
        if (volumeIssueMatch(TOG_SIGGRAPH_ASIA_VOLUME[y], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'SIGGRAPH Asia', year: y, reason: 'TOG_SIGGRAPH_ASIA' };
        }
      }

      // EUROGRAPHICS (CGF special issues)
      if (vCanonKey === 'comput. graph. forum' && y && vol && num) {
        if (volumeIssueMatch(CGF_EUROGRAPHICS_VOLUME[y], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'EUROGRAPHICS', year: y, reason: 'CGF_EG' };
        }
      }

      // VIS / VR (TVCG special issues)
      if (vCanonKey === 'ieee trans. vis. comput. graph.' && y && vol && num) {
        if (volumeIssueMatch(TVCG_VIS_VOLUME[y], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'VIS', year: y, reason: 'TVCG_VIS' };
        }
        if (volumeIssueMatch(TVCG_VR_VOLUME[y], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'VR', year: y, reason: 'TVCG_VR' };
        }
      }

      // ISMB (Bioinformatics proceedings)
      if ((vCanonKey === 'bioinformatics' || vCanonKey === 'bioinform.') && y && vol && num) {
        if (volumeIssueMatch(ISMB_BIOINFORMATICS[y], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'ISMB', year: y, reason: 'ISMB_BIOINFORMATICS' };
        }
      }
    }

    // 2) If this is a CSRankings top venue, canonicalize common variants.
    if (isCsrankingsTopVenue(vCanon)) {
      return { system: null, canonicalVenue: vCanon, year: y ?? null, reason: 'TOP_VENUE' };
    }

    return null;
  }

  return {
    normalizeForMatch,
    normalizeVenueCandidate,
    expandVenueCandidates,
    jaroWinkler,
    getPageCountFromPagesString,
    classifyVenueTrack,
    selectBestDblpMatch,
    isCsrankingsTopVenue,
    canonicalizeCsrankingsVenueName,
    resolveCsrankingsVenueOverride,
  };
});
