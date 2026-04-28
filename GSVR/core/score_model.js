(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./score_config.js"),
      require("./publication_type.js"),
      require("./authorship.js"),
      require("./coverage.js")
    );
  } else {
    root.GSVRScoreModel = factory(
      root.GSVRScoreConfig,
      root.GSVRPublicationType,
      root.GSVRAuthorship,
      root.GSVRCoverage
    );
  }
})(typeof self !== "undefined" ? self : this, function (scoreConfig, publicationType, authorship, coverage) {
  "use strict";

  const DEFAULT_SCORE_CONFIG = scoreConfig.DEFAULT_SCORE_CONFIG;

  function normalizeSource(source) {
    return String(source || "").trim().toUpperCase();
  }

  function normalizeRank(rank) {
    return String(rank || "").trim().toUpperCase();
  }

  function normalizeStatus(status) {
    return String(status || "").trim().toLowerCase();
  }

  function getEvidence(decision) {
    return Array.isArray(decision?.decisionEvidence)
      ? decision.decisionEvidence.map((value) => String(value || "").trim()).filter(Boolean)
      : Array.isArray(decision?.match?.evidence)
        ? decision.match.evidence.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
  }

  function getRankSource(decision) {
    return normalizeSource(decision?.ranking?.source || decision?.system || decision?.rankSource || decision?.source);
  }

  function getRank(decision) {
    return normalizeRank(decision?.ranking?.rank || decision?.rank);
  }

  function getRankingSnapshotYear(decision) {
    const year = Number(
      decision?.ranking?.snapshotYear
        ?? decision?.ranking?.rankingSnapshotYear
        ?? decision?.rankingSnapshotYear
        ?? decision?.ranking?.sourceYear
        ?? decision?.sourceYear
    );
    return Number.isFinite(year) ? Math.round(year) : null;
  }

  function getVenueValue(rankSource, rank, config = DEFAULT_SCORE_CONFIG) {
    return scoreConfig.getVenueValue(rankSource, rank, config);
  }

  function getPublicationYear(decision) {
    const year = Number(decision?.publicationYear ?? decision?.year ?? decision?.scholar?.year ?? decision?.dblp?.year);
    return Number.isFinite(year) ? Math.round(year) : null;
  }

  function getAuthorCount(decision) {
    const authorCount = decision?.dblp?.authorCount
      ?? decision?.authorCount
      ?? decision?.score?.authorCount
      ?? (Array.isArray(decision?.dblp?.authors) ? decision.dblp.authors.length : null)
      ?? (Array.isArray(decision?.authors) ? decision.authors.length : null);
    return authorship.normalizeAuthorCount(authorCount);
  }

  function getMatchStatus(decision) {
    return normalizeStatus(decision?.match?.status || decision?.decisionStatus || decision?.dblp?.status || decision?.status);
  }

  function getDblpKey(decision) {
    return String(decision?.dblp?.key || decision?.dblpKey || "").trim();
  }

  function getDblpVerificationFailure(decision) {
    const status = getMatchStatus(decision);
    const evidence = getEvidence(decision);
    const rank = String(decision?.rank || decision?.ranking?.rank || "").trim();
    const system = normalizeSource(decision?.system || decision?.ranking?.source);

    if (evidence.includes("rate_limited") || status === "rate_limited") {
      return "source_rate_limited";
    }
    if (evidence.includes("source_unavailable") || ["unavailable", "failed", "error"].includes(status)) {
      return "source_unavailable";
    }
    if (evidence.includes("dblp_entry_missing") || ["missing", "no_match", "not_found"].includes(status)) {
      return "dblp_missing";
    }
    if (system === "DBLP" && /dblp entry missing/i.test(rank)) {
      return "dblp_missing";
    }
    if (status === "ambiguous" || evidence.includes("publication_ambiguous")) {
      return "ambiguous_match";
    }
    return null;
  }

  function isDblpVerified(decision) {
    if (getDblpVerificationFailure(decision)) {
      return false;
    }
    const status = getMatchStatus(decision);
    if (["verified", "matched", "match", "ok"].includes(status)) {
      return true;
    }
    if (status === "unranked" && getDblpKey(decision)) {
      return true;
    }
    if (["verified", "matched"].includes(normalizeStatus(decision?.dblp?.status))) {
      return true;
    }
    return !!getDblpKey(decision);
  }

  function getScoreEligibility(decision, configInput = DEFAULT_SCORE_CONFIG) {
    const config = scoreConfig.createScoreConfig(configInput);
    const verificationFailure = getDblpVerificationFailure(decision);
    if (verificationFailure) {
      return { eligible: false, reason: verificationFailure };
    }
    if (!isDblpVerified(decision)) {
      return { eligible: false, reason: "dblp_missing" };
    }

    const classification = publicationType.classifyPublicationType(decision, config);
    if (!classification.scoreEligibleByType) {
      return { eligible: false, reason: classification.typeExclusionReason || classification.publicationType || "unknown" };
    }

    const rankSource = getRankSource(decision);
    const rank = getRank(decision);
    const venueValue = getVenueValue(rankSource, rank, config);
    if (venueValue == null) {
      return { eligible: false, reason: "rank_not_found" };
    }

    const authorCount = getAuthorCount(decision);
    if (authorCount == null) {
      return { eligible: false, reason: "missing_author_count" };
    }

    return {
      eligible: true,
      reason: null,
      classification,
      venueValue,
      authorCount,
      rankSource,
      rank,
    };
  }

  function isScoreEligible(publicationDecision, configInput = DEFAULT_SCORE_CONFIG) {
    return getScoreEligibility(publicationDecision, configInput).eligible;
  }

  function getExclusionReason(publicationDecision, configInput = DEFAULT_SCORE_CONFIG) {
    const eligibility = getScoreEligibility(publicationDecision, configInput);
    return eligibility.eligible ? null : eligibility.reason;
  }

  function computePublicationContribution(decision, configInput = DEFAULT_SCORE_CONFIG) {
    const config = scoreConfig.createScoreConfig(configInput);
    const classification = publicationType.classifyPublicationType(decision, config);
    const eligibility = getScoreEligibility(decision, config);

    if (!eligibility.eligible) {
      return {
        eligible: false,
        contribution: 0,
        exclusionReason: eligibility.reason,
      };
    }

    const fractionalCredit = authorship.getFractionalCredit(eligibility.authorCount);
    const contribution = eligibility.venueValue / eligibility.authorCount;
    return {
      eligible: true,
      venueValue: eligibility.venueValue,
      authorCount: eligibility.authorCount,
      fractionalCredit,
      contribution,
      rankSource: eligibility.rankSource,
      rank: eligibility.rank,
      rankingSnapshotYear: getRankingSnapshotYear(decision),
      publicationType: classification.publicationType,
    };
  }

  function computePublicationScore(decision, configInput = DEFAULT_SCORE_CONFIG) {
    const config = scoreConfig.createScoreConfig(configInput);
    const rankSource = getRankSource(decision);
    const rank = getRank(decision);
    const classification = publicationType.classifyPublicationType(decision, config);
    const score = computePublicationContribution(decision, config);
    const status = score.eligible ? "verified_ranked" : score.exclusionReason;
    const venueValue = getVenueValue(rankSource, rank, config);

    return {
      raw: decision,
      status,
      ranking: {
        source: rankSource || null,
        rank: rank || null,
        venueValue: venueValue ?? null,
        rankingSnapshotYear: getRankingSnapshotYear(decision),
      },
      classification,
      evidence: {
        matchStatus: getMatchStatus(decision) || null,
        matchProbability: decision?.match?.probability ?? decision?.matchProbability ?? decision?.matchConfidence ?? decision?.confidence ?? null,
        decisionEvidence: getEvidence(decision),
      },
      score,
    };
  }

  function summarizeSource(scoredPublications, sourceName) {
    const source = normalizeSource(sourceName);
    const items = scoredPublications.filter((item) => item.score.eligible && item.score.rankSource === source);
    const contribution = items.reduce((total, item) => total + item.score.contribution, 0);
    const fractionalPublicationWeight = items.reduce((total, item) => total + item.score.fractionalCredit, 0);
    return {
      source,
      contribution,
      fractionalPublicationWeight,
      eligibleRankedPublications: items.length,
    };
  }

  function getCompletenessCategory(scoredPublication) {
    if (scoredPublication?.score?.eligible === true) {
      return "scored";
    }
    const reason = String(scoredPublication?.score?.exclusionReason || scoredPublication?.status || "").trim().toLowerCase();
    switch (reason) {
      case "dblp_missing":
        return "dblpMissing";
      case "ambiguous_match":
      case "match_ambiguous":
        return "ambiguous";
      case "rank_not_found":
      case "verified_unranked":
      case "verified_but_source_missing":
      case "venue_unranked":
        return "rankNotFound";
      case "missing_author_count":
        return "missingAuthorCount";
      case "source_rate_limited":
      case "source_unavailable":
      case "lookup_unavailable":
      case "failed_dblp_lookup":
      case "rate_limited":
      case "unavailable":
        return "lookupUnavailable";
      case "short_paper":
      case "workshop":
      case "demo":
      case "poster":
      case "extended_abstract":
      case "preprint":
      case "book_chapter":
      case "unknown":
      case "excluded_type":
        return "excludedType";
      default:
        return "lookupUnavailable";
    }
  }

  function computeCompleteness(publicationDecisions, configInput = DEFAULT_SCORE_CONFIG, preScoredPublications = null) {
    const config = scoreConfig.createScoreConfig(configInput);
    const source = Array.isArray(publicationDecisions) ? publicationDecisions : [];
    const scored = Array.isArray(preScoredPublications)
      ? preScoredPublications
      : source.map((decision) => computePublicationScore(decision, config));
    const counts = {
      total: source.length,
      scored: 0,
      dblpMissing: 0,
      ambiguous: 0,
      rankNotFound: 0,
      excludedType: 0,
      missingAuthorCount: 0,
      lookupUnavailable: 0,
    };

    for (const item of scored) {
      const category = getCompletenessCategory(item);
      counts[category] = (counts[category] || 0) + 1;
    }

    const total = counts.total;
    const completeness = total > 0 ? counts.scored / total : 0;
    const segmentDefinitions = [
      ["scored", "Scored"],
      ["dblpMissing", "DBLP missing"],
      ["ambiguous", "Ambiguous match"],
      ["rankNotFound", "Venue unranked"],
      ["excludedType", "Excluded type"],
      ["missingAuthorCount", "Missing author count"],
      ["lookupUnavailable", "Lookup unavailable"],
    ];
    return {
      ...counts,
      completeness,
      formula: "N_scored / N_total",
      segments: segmentDefinitions.map(([key, label]) => ({
        key,
        label,
        count: counts[key],
        ratio: total > 0 ? counts[key] / total : 0,
      })),
    };
  }

  function computeProfileScore(publicationDecisions, configInput = DEFAULT_SCORE_CONFIG) {
    const config = scoreConfig.createScoreConfig(configInput);
    const source = Array.isArray(publicationDecisions) ? publicationDecisions : [];
    const scoredPublications = source
      .map((decision) => computePublicationScore(decision, config))
      .map((item) => {
        if (
          item.score.eligible
          && (config.sourceFilter === "CORE" || config.sourceFilter === "SJR")
          && item.score.rankSource !== config.sourceFilter
        ) {
          return {
            ...item,
            status: "source_filter",
            score: {
              eligible: false,
              contribution: 0,
              exclusionReason: "source_filter",
            },
          };
        }
        return item;
      })
      .map((item) => {
        const recentYears = Number(config.recentYears);
        if (!Number.isFinite(recentYears) || recentYears <= 0 || !item.score.eligible) {
          return item;
        }
        const publicationYear = getPublicationYear(item.raw);
        const maxYear = Math.max(...source.map(getPublicationYear).filter((year) => year != null));
        const cutoff = Number.isFinite(maxYear) ? maxYear - recentYears + 1 : null;
        if (cutoff != null && (publicationYear == null || publicationYear < cutoff)) {
          return {
            ...item,
            status: "outside_recent_window",
            score: {
              eligible: false,
              contribution: 0,
              exclusionReason: "outside_recent_window",
            },
          };
        }
        return item;
      });

    const eligibleItems = scoredPublications.filter((item) => item.score.eligible);
    const gsvrScore = eligibleItems.reduce((total, item) => total + item.score.contribution, 0);
    const fractionalPublicationWeight = eligibleItems.reduce((total, item) => total + item.score.fractionalCredit, 0);
    const coreSummary = summarizeSource(eligibleItems, "CORE");
    const sjrSummary = summarizeSource(eligibleItems, "SJR");
    const diagnostics = coverage.summarizeCoverage(source, scoredPublications);
    const completeness = computeCompleteness(source, config, scoredPublications);
    const scores = {
      gsvrScore,
      coreContribution: coreSummary.contribution,
      sjrContribution: sjrSummary.contribution,
      eligibleRankedPublications: eligibleItems.length,
      fractionalPublicationWeight,
      averageVenueValue: fractionalPublicationWeight > 0 ? gsvrScore / fractionalPublicationWeight : 0,
    };

    return {
      schemaVersion: "gsvr-profile-score-v2",
      scoreModelVersion: config.scoreModelVersion,
      scoringPolicy: scoreConfig.getScoringPolicy(config),
      scores,
      diagnostics,
      completeness,
      coreContribution: scores.coreContribution,
      sjrContribution: scores.sjrContribution,
      gsvrScore,
      fractionalPublicationWeight,
      eligibleRankedPublications: eligibleItems.length,
      averageVenueValue: scores.averageVenueValue,
      coreIndex: coreSummary,
      sjrIndex: sjrSummary,
      publications: scoredPublications,
    };
  }

  return {
    getVenueValue,
    isScoreEligible,
    getScoreEligibility,
    getExclusionReason,
    computePublicationContribution,
    computePublicationScore,
    computeCompleteness,
    computeProfileScore,
  };
});
