(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./score_config.js"));
  } else {
    root.GSVRCoverage = factory(root.GSVRScoreConfig);
  }
})(typeof self !== "undefined" ? self : this, function (scoreConfig) {
  "use strict";

  const COVERAGE_STATUSES = Object.freeze([
    "verified_ranked",
    "verified_unranked",
    "dblp_missing",
    "match_ambiguous",
    "excluded_type",
    "rank_not_found",
    "missing_author_count",
    "source_rate_limited",
    "source_unavailable",
    "unknown",
  ]);

  function normalizeStatus(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getEvidence(publication) {
    return Array.isArray(publication?.decisionEvidence)
      ? publication.decisionEvidence.map((value) => String(value || "").trim()).filter(Boolean)
      : Array.isArray(publication?.match?.evidence)
        ? publication.match.evidence.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
  }

  function isRanked(publication) {
    const source = String(publication?.system || publication?.ranking?.source || publication?.score?.rankSource || "").trim().toUpperCase();
    const rank = String(publication?.rank || publication?.ranking?.rank || publication?.score?.rank || "").trim().toUpperCase();
    return scoreConfig.getVenueValue(source, rank) != null;
  }

  function getPublicationStatus(publication) {
    const evidence = getEvidence(publication);
    const decisionStatus = normalizeStatus(publication?.decisionStatus || publication?.match?.status || publication?.dblp?.status);
    const rank = String(publication?.rank || publication?.ranking?.rank || "").trim();
    const system = String(publication?.system || publication?.ranking?.source || "").trim().toUpperCase();
    const reason = normalizeStatus(publication?.reason || publication?.score?.exclusionReason || "");

    if (evidence.includes("rate_limited") || decisionStatus === "rate_limited") {
      return "source_rate_limited";
    }
    if (evidence.includes("source_unavailable") || ["unavailable", "failed", "error"].includes(decisionStatus)) {
      return "source_unavailable";
    }
    if (system === "DBLP" && /dblp entry missing/i.test(rank)) {
      return "dblp_missing";
    }
    if (evidence.includes("dblp_entry_missing") || ["missing", "no_match", "not_found"].includes(decisionStatus)) {
      return "dblp_missing";
    }
    if (decisionStatus === "ambiguous" || evidence.includes("publication_ambiguous") || reason.includes("ambiguous")) {
      return "match_ambiguous";
    }
    if (publication?.classification?.scoreEligibleByType === false || publication?.score?.exclusionReason === "excluded_type") {
      return "excluded_type";
    }
    if (publication?.score?.exclusionReason === "missing_author_count") {
      return "missing_author_count";
    }
    if (isRanked(publication)) {
      return "verified_ranked";
    }
    if (rank && rank.toUpperCase() === "N/A") {
      return "rank_not_found";
    }
    if (system === "CORE" || system === "SJR") {
      return "verified_unranked";
    }
    return "unknown";
  }

  function createDiagnosticCounters(totalScholarItems = 0) {
    return {
      totalScholarItems,
      eligibleRankedPublications: 0,
      excludedShortPapers: 0,
      excludedWorkshops: 0,
      excludedDemosPosters: 0,
      excludedExtendedAbstracts: 0,
      excludedPreprints: 0,
      excludedBookChapters: 0,
      excludedUnknown: 0,
      dblpMissing: 0,
      ambiguousMatches: 0,
      unrankedVenues: 0,
      missingAuthorCount: 0,
      sourceRateLimited: 0,
      sourceUnavailable: 0,
      excludedPublications: 0,
      notScored: 0,
      byReasonCode: {},
    };
  }

  function incrementReason(summary, reason) {
    const key = reason || "unknown";
    summary.byReasonCode[key] = (summary.byReasonCode[key] || 0) + 1;
    switch (key) {
      case "short_paper":
        summary.excludedShortPapers += 1;
        break;
      case "workshop":
        summary.excludedWorkshops += 1;
        break;
      case "demo":
      case "poster":
        summary.excludedDemosPosters += 1;
        break;
      case "extended_abstract":
        summary.excludedExtendedAbstracts += 1;
        break;
      case "preprint":
        summary.excludedPreprints += 1;
        break;
      case "book_chapter":
        summary.excludedBookChapters += 1;
        break;
      case "unknown":
        summary.excludedUnknown += 1;
        break;
      case "dblp_missing":
        summary.dblpMissing += 1;
        break;
      case "ambiguous_match":
      case "match_ambiguous":
        summary.ambiguousMatches += 1;
        break;
      case "rank_not_found":
      case "verified_unranked":
      case "verified_but_source_missing":
        summary.unrankedVenues += 1;
        break;
      case "missing_author_count":
        summary.missingAuthorCount += 1;
        break;
      case "source_rate_limited":
        summary.sourceRateLimited += 1;
        break;
      case "source_unavailable":
      case "failed_dblp_lookup":
        summary.sourceUnavailable += 1;
        break;
      default:
        break;
    }
  }

  function summarizeCoverage(publications, scoredPublications = []) {
    const source = Array.isArray(publications) ? publications : [];
    const scored = Array.isArray(scoredPublications) ? scoredPublications : [];
    const summary = createDiagnosticCounters(source.length);

    source.forEach((publication, index) => {
      const scoredItem = scored[index] || null;
      if (scoredItem?.score?.eligible === true) {
        summary.eligibleRankedPublications += 1;
        return;
      }
      summary.notScored += 1;
      const reason = scoredItem?.score?.exclusionReason || getPublicationStatus(publication);
      incrementReason(summary, reason);
      if (["short_paper", "workshop", "demo", "poster", "extended_abstract", "preprint", "book_chapter", "unknown"].includes(reason)) {
        summary.excludedPublications += 1;
      }
    });

    return summary;
  }

  return {
    COVERAGE_STATUSES,
    getPublicationStatus,
    summarizeCoverage,
    isRanked,
  };
});
