(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRTemporalAlignment = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function normalizeYear(value) {
    const year = Number(value);
    return Number.isFinite(year) && year >= 1800 && year <= 2200 ? Math.round(year) : null;
  }

  function normalizeSnapshotYears(availableSnapshots) {
    return Array.isArray(availableSnapshots)
      ? availableSnapshots.map(normalizeYear).filter((year) => year != null).sort((a, b) => a - b)
      : [];
  }

  function selectRankingSnapshot(publicationYear, availableSnapshots, sourceLabel = null) {
    const pubYear = normalizeYear(publicationYear);
    const years = normalizeSnapshotYears(availableSnapshots);
    if (!years.length) {
      return {
        snapshotYear: null,
        snapshotLabel: null,
        limitedHistoricalCoverage: false,
      };
    }

    let snapshotYear = years[years.length - 1];
    let limitedHistoricalCoverage = false;
    if (pubYear != null) {
      const notAfter = years.filter((year) => year <= pubYear);
      if (notAfter.length) {
        snapshotYear = notAfter[notAfter.length - 1];
      } else {
        snapshotYear = years[0];
        limitedHistoricalCoverage = true;
      }
    }

    const prefix = sourceLabel ? `${String(sourceLabel).trim()} ` : "";
    return {
      snapshotYear,
      snapshotLabel: `${prefix}${snapshotYear}`,
      limitedHistoricalCoverage,
    };
  }

  function selectTemporalSourceYear(publicationYear, rankingSourceYears) {
    const selected = selectRankingSnapshot(publicationYear, rankingSourceYears);
    return {
      sourceYear: selected.snapshotYear,
      snapshotYear: selected.snapshotYear,
      snapshotLabel: selected.snapshotLabel,
      limitedHistoricalCoverage: selected.limitedHistoricalCoverage,
    };
  }

  function classifyTemporalAlignment() {
    return "snapshot_metadata_only";
  }

  return {
    normalizeYear,
    selectRankingSnapshot,
    selectTemporalSourceYear,
    classifyTemporalAlignment,
  };
});
