(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRTimelineStats = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RANGE_FULL = "full";
  const RANGE_LAST_10_YEARS = "last10";
  const CORE_RANKS = Object.freeze(["A*", "A", "B", "C"]);
  const SJR_RANKS = Object.freeze(["Q1", "Q2", "Q3", "Q4"]);
  const HISTOGRAM_RANKS = Object.freeze([...CORE_RANKS, ...SJR_RANKS]);
  const TOP_CORE_HISTOGRAM_RANKS = Object.freeze(["A*", "A"]);
  const Q1_HISTOGRAM_RANKS = Object.freeze(["Q1"]);

  function normalizeYear(value) {
    const year = Number(value);
    return Number.isFinite(year) && year >= 1800 && year <= 2200 ? Math.round(year) : null;
  }

  function getCurrentYear(options = {}) {
    const explicit = normalizeYear(options.currentYear);
    return explicit ?? new Date().getFullYear();
  }

  function getPublicationYear(info) {
    if (!info || typeof info !== "object") return null;
    return normalizeYear(info.publicationYear ?? info.year ?? info.scholar?.year);
  }

  function normalizeRangeMode(value) {
    return value === RANGE_LAST_10_YEARS ? RANGE_LAST_10_YEARS : RANGE_FULL;
  }

  function buildRange(mode = RANGE_FULL, options = {}) {
    const rangeMode = normalizeRangeMode(mode);
    if (rangeMode === RANGE_LAST_10_YEARS) {
      const endYear = getCurrentYear(options);
      const startYear = endYear - 9;
      return {
        mode: RANGE_LAST_10_YEARS,
        label: "Last 10 Years",
        startYear,
        endYear,
      };
    }
    return {
      mode: RANGE_FULL,
      label: "Full Timeline",
      startYear: null,
      endYear: null,
    };
  }

  function isInRange(info, range) {
    if (!range || range.mode !== RANGE_LAST_10_YEARS) return true;
    const year = getPublicationYear(info);
    return year != null && year >= range.startYear && year <= range.endYear;
  }

  function filterPublications(publications, options = {}) {
    const source = Array.isArray(publications) ? publications : [];
    const range = buildRange(options.rangeMode, options);
    return {
      range,
      publications: source.filter((info) => isInRange(info, range)),
    };
  }

  function createEmptyCoreRankCounts() {
    return { "A*": 0, A: 0, B: 0, C: 0, "N/A": 0 };
  }

  function createEmptySjrRankCounts() {
    return { Q1: 0, Q2: 0, Q3: 0, Q4: 0, "N/A": 0 };
  }

  function recomputeRankCounts(publications) {
    const coreRankCounts = createEmptyCoreRankCounts();
    const sjrRankCounts = createEmptySjrRankCounts();
    for (const info of publications || []) {
      const system = String(info?.system || "").toUpperCase();
      const rank = String(info?.rank || "N/A").toUpperCase();
      if (system === "CORE") {
        coreRankCounts[CORE_RANKS.includes(rank) ? rank : "N/A"] += 1;
      } else if (system === "SJR") {
        sjrRankCounts[SJR_RANKS.includes(rank) ? rank : "N/A"] += 1;
      }
    }
    return { coreRankCounts, sjrRankCounts };
  }

  function createEmptyHistogramRanks() {
    return HISTOGRAM_RANKS.reduce((acc, rank) => {
      acc[rank] = 0;
      return acc;
    }, {});
  }

  function createYearBucket(year) {
    return {
      year,
      ranks: createEmptyHistogramRanks(),
      conference: 0,
      journal: 0,
      total: 0,
    };
  }

  function addPublicationToBucket(bucket, info) {
    const system = String(info?.system || "").toUpperCase();
    const rank = String(info?.rank || "").toUpperCase();
    if (system === "CORE" && CORE_RANKS.includes(rank)) {
      bucket.ranks[rank] += 1;
      bucket.conference += 1;
      bucket.total += 1;
    } else if (system === "SJR" && SJR_RANKS.includes(rank)) {
      bucket.ranks[rank] += 1;
      bucket.journal += 1;
      bucket.total += 1;
    }
  }

  function buildYearRange(startYear, endYear) {
    const start = normalizeYear(startYear);
    const end = normalizeYear(endYear);
    if (start == null || end == null || start > end) return [];
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  function buildYearlyHistogram(publications, options = {}) {
    const years = buildYearRange(options.startYear, options.endYear);
    if (!years.length) return [];
    const byYear = new Map(years.map((year) => [year, createYearBucket(year)]));
    for (const info of publications || []) {
      const year = getPublicationYear(info);
      if (year == null || !byYear.has(year)) continue;
      addPublicationToBucket(byYear.get(year), info);
    }
    return years.map((year) => byYear.get(year));
  }

  function buildFixedWindowHistogram(publications, options = {}) {
    const length = Math.max(1, Math.round(Number(options.years) || 8));
    const endYear = getCurrentYear(options);
    return buildYearlyHistogram(publications, {
      startYear: endYear - length + 1,
      endYear,
    });
  }

  function buildFullTimelineHistogram(publications) {
    const knownYears = (publications || [])
      .map(getPublicationYear)
      .filter((year) => year != null);
    if (!knownYears.length) return [];
    return buildYearlyHistogram(publications, {
      startYear: Math.min(...knownYears),
      endYear: Math.max(...knownYears),
    });
  }

  function buildFocusedHistogram(histogram, ranks) {
    const rankSet = new Set(Array.isArray(ranks) ? ranks : []);
    return (Array.isArray(histogram) ? histogram : []).map((bucket) => {
      const focusedRanks = {};
      let total = 0;
      for (const rank of rankSet) {
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

  function buildFocusedHistograms(histogram) {
    return {
      topCoreHistogram: buildFocusedHistogram(histogram, TOP_CORE_HISTOGRAM_RANKS),
      q1Histogram: buildFocusedHistogram(histogram, Q1_HISTOGRAM_RANKS),
    };
  }

  function countUnknownYears(publications) {
    return (publications || []).reduce((total, info) => total + (getPublicationYear(info) == null ? 1 : 0), 0);
  }

  function buildTimelineStats(publications, options = {}) {
    const source = Array.isArray(publications) ? publications : [];
    const currentYear = getCurrentYear(options);
    const filtered = filterPublications(source, {
      rangeMode: options.rangeMode,
      currentYear,
    });
    const counts = recomputeRankCounts(filtered.publications);
    const recentHistogram = buildFixedWindowHistogram(filtered.publications, {
      currentYear,
      years: options.recentYears || 8,
    });
    const fullHistogram = buildFullTimelineHistogram(source);
    return {
      rangeMode: filtered.range.mode,
      range: filtered.range,
      currentYear,
      publications: filtered.publications,
      allPublications: source,
      coreRankCounts: counts.coreRankCounts,
      sjrRankCounts: counts.sjrRankCounts,
      recentHistogram,
      fullHistogram,
      focusedHistograms: {
        recent: buildFocusedHistograms(recentHistogram),
        full: buildFocusedHistograms(fullHistogram),
      },
      unknownYearCount: countUnknownYears(filtered.publications),
      allUnknownYearCount: countUnknownYears(source),
    };
  }

  // Stacking weight for sparse-profile chips on the Scholar citation graph:
  // chips render bottom-up in ascending weight, so the most prestigious rank
  // ends up on top of each year's stack.
  const SPARSE_CHIP_STACK_ORDER = Object.freeze({
    Q4: 1, Q3: 2, C: 3, Q2: 4, B: 5, Q1: 6, A: 7, "A*": 8,
  });

  // For profiles with only a handful of ranked papers, aggregate histograms
  // are nearly empty; per-year rank chips over Scholar's own citation chart
  // communicate more. This computes the data for that view: which ranked
  // papers fall inside the recent window, grouped by year.
  function buildSparseRankChips(publications, options = {}) {
    const currentYear = getCurrentYear(options);
    const windowYears = Number.isFinite(options.windowYears) && options.windowYears > 0
      ? Math.round(options.windowYears)
      : 8;
    const sparseLimit = Number.isFinite(options.sparseLimit) && options.sparseLimit > 0
      ? Math.round(options.sparseLimit)
      : 25;
    const startYear = currentYear - windowYears + 1;
    const chipsByYear = {};
    const allChipsByYear = {};
    let totalRanked = 0;
    let allRanked = 0;

    for (const info of Array.isArray(publications) ? publications : []) {
      const rank = String(info?.rank || "").trim().toUpperCase();
      if (!HISTOGRAM_RANKS.includes(rank)) continue;
      allRanked += 1;
      const year = getPublicationYear(info);
      if (year != null) {
        if (!allChipsByYear[year]) allChipsByYear[year] = [];
        allChipsByYear[year].push(rank);
      }
      if (year == null || year < startYear || year > currentYear) continue;
      totalRanked += 1;
      if (!chipsByYear[year]) chipsByYear[year] = [];
      chipsByYear[year].push(rank);
    }

    for (const bucket of [chipsByYear, allChipsByYear]) {
      for (const year of Object.keys(bucket)) {
        bucket[year].sort(
          (left, right) => (SPARSE_CHIP_STACK_ORDER[left] || 0) - (SPARSE_CHIP_STACK_ORDER[right] || 0)
        );
      }
    }

    return {
      isSparse: totalRanked > 0 && totalRanked < sparseLimit,
      totalRanked,
      allRanked,
      sparseLimit,
      startYear,
      endYear: currentYear,
      chipsByYear,
      allChipsByYear,
    };
  }

  return {
    RANGE_FULL,
    RANGE_LAST_10_YEARS,
    CORE_RANKS,
    SJR_RANKS,
    HISTOGRAM_RANKS,
    TOP_CORE_HISTOGRAM_RANKS,
    Q1_HISTOGRAM_RANKS,
    normalizeYear,
    getPublicationYear,
    normalizeRangeMode,
    buildRange,
    isInRange,
    filterPublications,
    createEmptyCoreRankCounts,
    createEmptySjrRankCounts,
    recomputeRankCounts,
    buildYearlyHistogram,
    buildFixedWindowHistogram,
    buildFullTimelineHistogram,
    buildFocusedHistogram,
    buildFocusedHistograms,
    buildTimelineStats,
    buildSparseRankChips,
  };
});
