/*
 * journal_match.js
 * Single source of truth for SJR journal-name normalization and matching.
 *
 * Consumed by:
 *  - the content script (GSVR/content.js)
 *  - the Node benchmark/test mirror (GSVR/tests/accuracy_benchmark_lib.js)
 *  - the SJR index generator (scripts/generate_sjr_index.mjs)
 *  - the SJR smoke test (GSVR/tests/sjr_smoke_test.js)
 *
 * Identity model (index v3):
 *  - Journals are identified by SCImago sourceId; distinct sourceIds are NEVER
 *    merged. The normalized title is a lookup key, not an identity.
 *  - The exact-match key keeps discriminating words ("journal",
 *    "international") that the legacy normalizer dropped. The legacy
 *    normalizer collapsed 2,249 distinct journals onto 1,002 shared keys
 *    (883 of them with conflicting quartiles), silently inflating ranks via
 *    "best quartile wins" merging (e.g. "Journal of Diabetes" Q2 inherited Q1
 *    from "Diabetes").
 *  - When several sourceIds still share an exact key (e.g. "Cell" vs "Cells"
 *    after plural stemming), the match abstains unless ISSN evidence picks
 *    exactly one journal.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./text_normalize.js'),
      require('../rank_core.js')
    );
  } else {
    root.GSVRJournalMatch = factory(root.GSVRTextNormalize, root.GSVRUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (textNormalize, rankCore) {
  'use strict';

  const foldDiacritics = textNormalize && typeof textNormalize.foldDiacritics === 'function'
    ? textNormalize.foldDiacritics
    : (value) => String(value ?? '');

  const DECISION_STATUS = rankCore?.DECISION_STATUS || Object.freeze({
    MATCHED: 'matched',
    UNRANKED: 'unranked',
    AMBIGUOUS: 'ambiguous',
    MISSING: 'missing',
  });
  const RANKING_CONFIG = rankCore?.RANKING_CONFIG || {
    sjrFuzzyThreshold: 0.92,
    sjrAmbiguityGap: 0.015,
  };
  const hybridSimilarity = rankCore && typeof rankCore.hybridSimilarity === 'function'
    ? rankCore.hybridSimilarity
    : () => 0;

  const COMMON_ABBREVIATIONS = Object.freeze({
    "int'l": 'international',
    'intl': 'international',
    'int.': 'international',
    'int': 'international',
    'conf.': 'conference',
    'conf': 'conference',
    'proc.': 'proceedings',
    'proc': 'proceedings',
    'symp.': 'symposium',
    'symp': 'symposium',
    'j.': 'journal',
    'j': 'journal',
    'jour': 'journal',
    'trans.': 'transactions',
    'trans': 'transactions',
    'annu.': 'annual',
    'annu': 'annual',
    // NOTE: DBLP abbreviations use "Comput." overwhelmingly to mean "Computer".
    // Some venues expand to "Computing" (e.g., "ACM Computing Surveys"),
    // which we handle via lightweight normalization variants in journal matching.
    'comput.': 'computer',
    'comput': 'computer',
    'comp.': 'computer',
    'comp': 'computer',
    'commun.': 'communications',
    'commun': 'communications',
    'comm.': 'communications',
    'comm': 'communications',
    'rev.': 'review',
    'rev': 'review',
    'syst.': 'systems',
    'syst': 'systems',
    // Common DBLP journal abbreviations
    'manag.': 'management',
    'manag': 'management',
    'process.': 'processing',
    'process': 'processing',
    'sci.': 'science',
    'sci': 'science',
    'sens.': 'sensor',
    'sens': 'sensor',
    'netw.': 'networks',
    'netw': 'networks',
    'pers.': 'personal',
    'pers': 'personal',
    'embed.': 'embedded',
    'embed': 'embedded',
    'distr.': 'distributed',
    'distr': 'distributed',
    'archit.': 'architecture',
    'archit': 'architecture',
    'tech.': 'technical',
    'tech': 'technical',
    'technol': 'technology',
    'engin.': 'engineering',
    'engin': 'engineering',
    'res.': 'research',
    'res': 'research',
    'adv.': 'advances',
    'adv': 'advances',
    'appl.': 'applications',
    'appl': 'applications',
    'surv.': 'surveys',
    'surv': 'surveys',
    'wirel.': 'wireless',
    'wirel': 'wireless',
    'inf.': 'information',
    'inf': 'information',
    'lectures notes': 'lecture notes',
    'lect notes': 'lecture notes',
    'lncs': 'lecture notes in computer science',
  });

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Precompile abbreviation regexes once; cleanTextForComparison is hot.
  const ABBREVIATION_RULES = Object.entries(COMMON_ABBREVIATIONS).map(([abbr, expansion]) => ({
    regex: new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi'),
    expansion,
  }));

  function cleanTextForComparison(text, isScholarVenue = false) {
    if (!text) return '';
    let cleanedText = foldDiacritics(String(text)).toLowerCase();
    cleanedText = cleanedText.replace(/&/g, ' and ');
    cleanedText = cleanedText.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”()\[\]]/g, ' ');
    cleanedText = cleanedText.replace(/\s-\s/g, ' ');
    if (isScholarVenue) {
      cleanedText = cleanedText.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, '');
      cleanedText = cleanedText.replace(/,\s*\d{4}$/, '');
      cleanedText = cleanedText.replace(/\(\d{4}\)$/, '');
      // Scholar/DBLP often appends "(2)", "(Part 2)", etc. Strip trailing numeric/issue tokens.
      cleanedText = cleanedText.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ');
      cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, '');
    }
    // Also remove a trailing standalone number for non-Scholar venues (e.g., "MobiQuitous (2)")
    cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, '');
    cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

    // Expand abbreviations *after* punctuation is normalized to spaces.
    // This avoids false negatives for dotted abbreviations like "Commun." or "J.".
    for (const rule of ABBREVIATION_RULES) {
      cleanedText = cleanedText.replace(rule.regex, rule.expansion);
    }

    return cleanedText.replace(/\s+/g, ' ').trim();
  }

  // Connector words that vary freely between renderings of the SAME journal
  // ("Journal of Systems Architecture" vs "Journal Systems Architecture").
  // Deliberately does NOT include "journal" / "international": dropping those
  // merges distinct journals ("Diabetes" vs "Journal of Diabetes").
  const CONNECTOR_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'in', 'on', 'to', 'at']);

  function stemToken(token) {
    // Simple stemming sufficient for venue name matching.
    if (token.length <= 4) return token;
    if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`;
    if (token.endsWith('sses')) return token; // e.g., "processes" edge
    if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  }

  function normalizeJournalName(name) {
    if (!name) return '';
    let cleaned = cleanTextForComparison(name, true);
    if (!cleaned) return '';
    // Drop bare numeric tokens (years, volumes, issues, article numbers).
    cleaned = cleaned.replace(/\b\d{1,6}\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';

    return cleaned
      .split(' ')
      .map((token) => token.trim())
      .filter(Boolean)
      .map(stemToken)
      .filter((token) => token.length > 0 && !CONNECTOR_WORDS.has(token))
      .join(' ')
      .trim();
  }

  // Some abbreviations map ambiguously (e.g., "Comput." could be "Computer" or
  // "Computing"). To avoid lowering the global fuzzy threshold, try a handful
  // of deterministic variants.
  function generateJournalNormalizationVariants(name) {
    const base = normalizeJournalName(name);
    if (!base) return [];
    const variants = new Set([base]);
    if (/\bcomputer\b/.test(base)) {
      variants.add(base.replace(/\bcomputer\b/g, 'computing'));
    }
    if (/\bcomputing\b/.test(base)) {
      variants.add(base.replace(/\bcomputing\b/g, 'computer'));
    }
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

  // Token stop list for CANDIDATE SELECTION only (never identity): boilerplate
  // words index too many entries to be useful lookup tokens.
  const TOKEN_STOP_WORDS = new Set([
    'and', 'the', 'of', 'for', 'in', 'on',
    'journal', 'international', 'transaction', 'transactions', 'letter', 'letters',
  ]);

  function createTokenSet(normalizedTitle) {
    const tokens = String(normalizedTitle || '')
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token));
    return new Set(tokens);
  }

  function getEntryTokens(entry) {
    if (entry && entry.tokenSet instanceof Set) return entry.tokenSet;
    if (entry && Array.isArray(entry.keywordTokens) && entry.keywordTokens.length) {
      return new Set(entry.keywordTokens.map((token) => String(token || '').trim()).filter((token) => token.length >= 3));
    }
    return createTokenSet(entry?.normalizedTitle || '');
  }

  function createSjrTokenIndex(entries) {
    const tokenToIndexes = new Map();
    const tokenFrequency = new Map();
    (entries || []).forEach((entry, index) => {
      for (const token of getEntryTokens(entry)) {
        if (!tokenToIndexes.has(token)) tokenToIndexes.set(token, new Set());
        tokenToIndexes.get(token).add(index);
        tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
      }
    });
    return { tokenToIndexes, tokenFrequency };
  }

  function selectSjrCandidateIndexes(queryTokens, dataset) {
    if (!Array.isArray(queryTokens) || !queryTokens.length || !dataset?.tokenIndex) return null;
    const ranked = queryTokens
      .map((token) => ({
        token,
        count: dataset.tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY,
      }))
      .filter((entry) => Number.isFinite(entry.count))
      .sort((left, right) => left.count - right.count || left.token.localeCompare(right.token));

    if (!ranked.length) return null;

    let candidateSet = null;
    for (const entry of ranked.slice(0, 3)) {
      const indexes = dataset.tokenIndex.tokenToIndexes.get(entry.token);
      if (!indexes?.size) continue;
      candidateSet = candidateSet
        ? new Set([...candidateSet].filter((index) => indexes.has(index)))
        : new Set(indexes);
      if (candidateSet.size > 0 && candidateSet.size <= 48) break;
    }

    if (candidateSet?.size) return candidateSet;
    return dataset.tokenIndex.tokenToIndexes.get(ranked[0].token) || null;
  }

  function normalizeIssnValue(value) {
    const normalized = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    return normalized || null;
  }

  function normalizeIssnList(values) {
    const raw = Array.isArray(values) ? values : String(values || '').split(/[;,]/);
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const normalized = normalizeIssnValue(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  // byNormalized values may be a single entry (legacy v2 datasets) or an array
  // of entries (v3, where distinct sourceIds can share an exact key).
  function getExactBucket(dataset, normalizedQuery) {
    const bucket = dataset?.byNormalized?.get?.(normalizedQuery);
    if (!bucket) return [];
    return Array.isArray(bucket) ? bucket : [bucket];
  }

  function entrySortKey(entry) {
    return `${entry?.normalizedTitle || ''} ${entry?.sourceId || ''}`;
  }

  function summarizeEntries(entries) {
    return (entries || []).slice(0, 4).map((entry) => ({
      title: entry?.resolvedTitle || null,
      sourceId: entry?.sourceId || null,
    }));
  }

  // Light fold for raw-title equality: diacritics, case, and whitespace only.
  function foldRawTitle(value) {
    return foldDiacritics(String(value ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function findBestSjrMatch({ normalizedQuery, queryIssns, dataset, rawQuery = null }) {
    const normalizedIssns = normalizeIssnList(queryIssns);

    // Tier 1: ISSN identity (strongest evidence).
    const exactIssnMatches = [];
    for (const issn of normalizedIssns) {
      const matches = dataset.byIssn?.get?.(issn) || [];
      for (const match of matches) {
        if (!exactIssnMatches.includes(match)) exactIssnMatches.push(match);
      }
    }
    if (exactIssnMatches.length === 1) {
      return { status: DECISION_STATUS.MATCHED, entry: exactIssnMatches[0], score: 1, matchedBy: 'issn' };
    }
    if (exactIssnMatches.length > 1) {
      const exactTitleMatch = exactIssnMatches.find((entry) => entry.normalizedTitle === normalizedQuery);
      if (exactTitleMatch) {
        return { status: DECISION_STATUS.MATCHED, entry: exactTitleMatch, score: 1, matchedBy: 'issn' };
      }
      const sourceIds = new Set(exactIssnMatches.map((entry) => entry.sourceId).filter(Boolean));
      if (sourceIds.size === 1) {
        const latestSourceEntry = exactIssnMatches
          .slice()
          .sort((left, right) => {
            const rightYear = Math.max(0, ...Object.keys(right.quartilesByYear || {}).map((year) => Number(year)).filter(Number.isFinite));
            const leftYear = Math.max(0, ...Object.keys(left.quartilesByYear || {}).map((year) => Number(year)).filter(Number.isFinite));
            return rightYear - leftYear;
          })[0];
        if (latestSourceEntry) {
          return { status: DECISION_STATUS.MATCHED, entry: latestSourceEntry, score: 1, matchedBy: 'issn' };
        }
      }
      let bestIssnMatch = null;
      let secondIssnMatch = null;
      for (const entry of exactIssnMatches) {
        const score = hybridSimilarity(normalizedQuery, entry.normalizedTitle);
        const candidate = { entry, score };
        if (!bestIssnMatch || score > bestIssnMatch.score) {
          secondIssnMatch = bestIssnMatch;
          bestIssnMatch = candidate;
        } else if (!secondIssnMatch || score > secondIssnMatch.score) {
          secondIssnMatch = candidate;
        }
      }
      const issnGap = secondIssnMatch ? bestIssnMatch.score - secondIssnMatch.score : Number.POSITIVE_INFINITY;
      if (bestIssnMatch && (bestIssnMatch.score >= 0.97 || issnGap >= RANKING_CONFIG.sjrAmbiguityGap)) {
        return { status: DECISION_STATUS.MATCHED, entry: bestIssnMatch.entry, score: bestIssnMatch.score, matchedBy: 'issn' };
      }
      return { status: DECISION_STATUS.AMBIGUOUS, score: 1, matchedBy: 'issn' };
    }

    // Tier 2: exact normalized-title key. Distinct journals can legitimately
    // share a key (plural stemming: "Cell" vs "Cells"); the match abstains
    // unless ISSN evidence isolates exactly one of them.
    const directMatches = getExactBucket(dataset, normalizedQuery);
    if (directMatches.length === 1) {
      return { status: DECISION_STATUS.MATCHED, entry: directMatches[0], score: 1, matchedBy: 'title_exact' };
    }
    if (directMatches.length > 1) {
      if (normalizedIssns.length) {
        const issnSet = new Set(normalizedIssns);
        const issnFiltered = directMatches.filter((entry) => (entry.issns || []).some((issn) => issnSet.has(issn)));
        if (issnFiltered.length === 1) {
          return { status: DECISION_STATUS.MATCHED, entry: issnFiltered[0], score: 1, matchedBy: 'title_exact_issn' };
        }
      }
      // An exactly-equal raw title (modulo case/diacritics/whitespace) is
      // decisive: "Neuroscience" picks the journal titled "Neuroscience" even
      // though plural stemming ties it with "Neurosciences".
      if (rawQuery) {
        const foldedRaw = foldRawTitle(rawQuery);
        if (foldedRaw) {
          const rawTitleMatches = directMatches.filter((entry) => foldRawTitle(entry.resolvedTitle) === foldedRaw);
          if (rawTitleMatches.length === 1) {
            return { status: DECISION_STATUS.MATCHED, entry: rawTitleMatches[0], score: 1, matchedBy: 'title_exact_raw' };
          }
        }
      }
      const distinctSourceIds = new Set(directMatches.map((entry) => entry.sourceId).filter(Boolean));
      if (distinctSourceIds.size <= 1) {
        // Same journal registered under several aliases; any entry will do.
        const sorted = directMatches.slice().sort((a, b) => entrySortKey(a).localeCompare(entrySortKey(b)));
        return { status: DECISION_STATUS.MATCHED, entry: sorted[0], score: 1, matchedBy: 'title_exact' };
      }
      return {
        status: DECISION_STATUS.AMBIGUOUS,
        score: 1,
        matchedBy: 'title_exact',
        topCandidates: summarizeEntries(directMatches),
      };
    }

    // Tier 3: fuzzy title similarity over token-indexed candidates.
    const queryTokens = String(normalizedQuery || '')
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    const candidateIndexes = selectSjrCandidateIndexes(queryTokens, dataset)
      || new Set((dataset.entries || []).map((_, index) => index));

    let best = null;
    let second = null;
    for (const index of candidateIndexes) {
      const entry = dataset.entries[index];
      if (!entry) continue;
      const score = hybridSimilarity(normalizedQuery, entry.normalizedTitle);
      if (score < RANKING_CONFIG.sjrFuzzyThreshold) continue;
      const candidate = { entry, score };
      if (!best
        || score > best.score
        || (score === best.score && entrySortKey(entry).localeCompare(entrySortKey(best.entry)) < 0)) {
        second = best;
        best = candidate;
      } else if (!second
        || score > second.score
        || (score === second.score && entrySortKey(entry).localeCompare(entrySortKey(second.entry)) < 0)) {
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
    // Two distinct journals with identical normalized titles tie exactly; a
    // high score must not override that ambiguity.
    if (second
      && gap === 0
      && best.entry.normalizedTitle === second.entry.normalizedTitle
      && best.entry.sourceId !== second.entry.sourceId) {
      return {
        status: DECISION_STATUS.AMBIGUOUS,
        score: best.score,
        gap,
        matchedBy: 'title_fuzzy',
        topCandidates: summarizeEntries([best.entry, second.entry]),
      };
    }

    return { status: DECISION_STATUS.MATCHED, entry: best.entry, score: best.score, matchedBy: 'title_fuzzy' };
  }

  return {
    COMMON_ABBREVIATIONS,
    cleanTextForComparison,
    normalizeJournalName,
    generateJournalNormalizationVariants,
    createTokenSet,
    createSjrTokenIndex,
    selectSjrCandidateIndexes,
    normalizeIssnValue,
    normalizeIssnList,
    findBestSjrMatch,
  };
});
